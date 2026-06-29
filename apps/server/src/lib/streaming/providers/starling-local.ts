/**
 * Starling local STT provider.
 *
 * Batch path delegates to the starling HTTP sidecar via
 * `transcribeWithStarling`. Streaming path runs the **semi-online**
 * overlapping-window engine (`StarlingStreamingSession`): audio arriving over
 * the WS is accumulated in a local ring buffer and re-transcribed on a timer
 * over a rolling live window, emitting partials as it goes. When the live
 * window crosses `segmentAdvanceMs`, it is committed into `accumulated` and the
 * window resets — so per-partial cost stays bounded no matter how long the
 * recording runs, and at `commit()` only the final tail needs processing.
 *
 * This realizes "overlapping chunks while still recording": the live window is
 * re-transcribed each tick (self-overlapping, which gives the model right-
 * context and stabilizes the tail), and committed chunks stitch cleanly via
 * `mergeFinalSegment` since each begins exactly at the prior boundary.
 *
 * Structured to mirror `MlxLocalStreamingSession` (generation counter,
 * inFlight/dirty dedup, waitUntilReady buffering, emitPartial equality-dedup);
 * see `mlx-local.ts` for the reference pattern.
 */

import { createAppLogger } from "@freestyle/utils";
import {
  STARLING_PROVIDER_ID,
  STARLING_SAMPLE_RATE,
} from "../../starling/constants.js";
import {
  applyStarlingRetentionPolicy,
  ensureStarlingServerRunning,
  getStarlingPartialInterval,
  getStarlingSegmentAdvance,
  isStarlingServerFailed,
  transcribePcmWithStarling,
  transcribeWithStarling,
} from "../../starling/server.js";
import { mergeFinalSegment, previewText } from "../segments.js";
import type {
  StreamCallbacks,
  StreamingSessionOptions,
  StreamSession,
  TranscribeOptions,
  TranscribeResult,
  TranscriptionProvider,
} from "../types.js";
import { stripProviderPrefix } from "../types.js";

const log = createAppLogger("starling");

const MIN_PARTIAL_AUDIO_MS = 800;
/** Hard cap on buffered samples to bound memory for very long recordings. */
const MAX_BUFFERED_MS = 120_000;

export class StarlingLocalTranscriptionProvider
  implements TranscriptionProvider
{
  readonly providerId = STARLING_PROVIDER_ID;

  async transcribe(opts: TranscribeOptions): Promise<TranscribeResult> {
    const modelId = stripProviderPrefix(opts.model);
    const t0 = Date.now();
    const text = await transcribeWithStarling({
      modelId,
      audio: opts.audio,
    });
    log.debug(`inference took ${Date.now() - t0}ms`);
    return { text };
  }

  supportsStreaming(_modelId: string): boolean {
    return true;
  }

  openStreamingSession(opts: StreamingSessionOptions): StreamSession {
    const modelId = stripProviderPrefix(opts.model);
    return new StarlingStreamingSession({
      modelId,
      callbacks: opts.callbacks,
    });
  }
}

interface StarlingSessionOpts {
  modelId: string;
  callbacks: StreamCallbacks;
}

class StarlingStreamingSession implements StreamSession {
  private closed = false;
  private canceled = false;
  private inFlight = false;
  private dirty = false;
  private commitRequested = false;
  private generation = 0;

  /** All audio since recording start (used for the final pass fallback). */
  private allChunks: Buffer[] = [];
  private allSampleCount = 0;

  /**
   * Audio in the current live window — starts at the last commit boundary.
   * Re-transcribed each partial tick; cleared on advancement.
   */
  private liveChunks: Buffer[] = [];
  private liveSampleCount = 0;

  /** Locked-in transcript text from committed chunks. */
  private accumulated = "";
  /** Latest text from the live window (for preview composition). */
  private liveText = "";

  private partialTimer: ReturnType<typeof setTimeout> | null = null;
  private serverReadyPromise: Promise<void>;
  private readonly partialIntervalMs: number;
  private readonly segmentAdvanceMs: number;

  constructor(private readonly opts: StarlingSessionOpts) {
    this.partialIntervalMs = getStarlingPartialInterval();
    this.segmentAdvanceMs = getStarlingSegmentAdvance();
    this.serverReadyPromise = this.startServerLoad();
  }

  sendAudio(chunk: ArrayBuffer): void {
    if (this.closed || this.canceled) return;
    const buf = Buffer.from(chunk);
    const samples = Math.floor(buf.byteLength / 2);
    this.allChunks.push(buf);
    this.allSampleCount += samples;
    this.liveChunks.push(buf);
    this.liveSampleCount += samples;

    // Bound memory: if the full buffer is enormous, drop from the head of the
    // global buffer. The live window + accumulated text already preserve the
    // transcript; this only trims audio we won't re-transcribe except on the
    // final fallback pass.
    this.trimGlobalBuffer();

    if (this.liveDurationMs() < MIN_PARTIAL_AUDIO_MS) return;
    this.schedulePartial();
  }

  reset(): void {
    this.clearTimer();
    // If a final inference is in flight, resolve it with whatever we have so
    // the caller's commit promise doesn't hang.
    if (this.inFlight && this.commitRequested) {
      this.opts.callbacks.onFinal(this.composeFinal());
    }
    this.allChunks = [];
    this.allSampleCount = 0;
    this.liveChunks = [];
    this.liveSampleCount = 0;
    this.accumulated = "";
    this.liveText = "";
    this.canceled = false;
    this.inFlight = false;
    this.dirty = false;
    this.commitRequested = false;
    this.generation++;
    this.serverReadyPromise = this.startServerLoad();
  }

  waitUntilReady(): Promise<void> {
    return this.serverReadyPromise;
  }

  commit(): void {
    this.clearTimer();
    this.commitRequested = true;
    if (this.inFlight) {
      // runInference's finally handler will pick up commitRequested and run
      // the final pass.
      return;
    }
    this.runFinalPass();
  }

  cancel(): void {
    this.canceled = true;
    this.clearTimer();
    this.allChunks = [];
    this.allSampleCount = 0;
    this.liveChunks = [];
    this.liveSampleCount = 0;
    this.accumulated = "";
    this.liveText = "";
    this.dirty = false;
    this.commitRequested = false;
    this.generation++;
    applyStarlingRetentionPolicy();
  }

  close(): void {
    this.closed = true;
    this.cancel();
    applyStarlingRetentionPolicy();
  }

  // --- server load ---------------------------------------------------------

  private startServerLoad(): Promise<void> {
    const generation = this.generation;
    const promise = ensureStarlingServerRunning(this.opts.modelId).then(() => {
      if (this.closed || this.canceled || generation !== this.generation) {
        return;
      }
      this.opts.callbacks.onReady(this.opts.modelId);
      this.maybeRunReadyPreview(generation);
    });
    promise.catch((err: Error) => {
      if (this.closed || generation !== this.generation) return;
      this.opts.callbacks.onError(err.message);
    });
    return promise.catch(() => undefined);
  }

  private maybeRunReadyPreview(generation: number): void {
    if (
      this.closed ||
      this.canceled ||
      this.inFlight ||
      this.liveText ||
      this.accumulated ||
      generation !== this.generation ||
      this.liveDurationMs() < MIN_PARTIAL_AUDIO_MS
    ) {
      return;
    }
    this.clearTimer();
    this.runPartial(generation);
  }

  // --- partial scheduling --------------------------------------------------

  private schedulePartial(): void {
    if (this.closed || this.canceled || this.commitRequested) return;
    if (this.partialTimer) return;
    this.partialTimer = setTimeout(() => {
      this.partialTimer = null;
      const generation = this.generation;
      this.runPartial(generation);
    }, this.partialIntervalMs);
  }

  /** Transcribe the current live window, emit a partial, maybe advance. */
  private runPartial(generation: number): void {
    if (this.closed || this.canceled || this.inFlight) return;
    if (generation !== this.generation) return;
    if (this.liveSampleCount === 0) return;

    this.runInference(this.snapshotLive(), generation, false);
  }

  /** Final pass over the remaining live window, then emit onFinal. */
  private runFinalPass(): void {
    if (this.closed || this.canceled) return;
    const generation = this.generation;

    if (this.liveSampleCount === 0) {
      // Everything was already committed during recording.
      this.opts.callbacks.onFinal(this.accumulated.trim());
      applyStarlingRetentionPolicy();
      return;
    }

    this.runInference(this.snapshotLive(), generation, true);
  }

  // --- inference core ------------------------------------------------------

  private runInference(
    audio: Buffer,
    generation: number,
    final: boolean,
  ): void {
    if (this.closed || this.canceled) return;
    if (this.inFlight) {
      this.dirty = true;
      if (final) this.commitRequested = true;
      return;
    }
    if (audio.length === 0) {
      if (final) {
        this.opts.callbacks.onFinal(this.composeFinal());
        applyStarlingRetentionPolicy();
      }
      return;
    }

    this.inFlight = true;
    this.dirty = false;

    void this.serverReadyPromise
      .then(() => {
        if (this.closed || this.canceled || generation !== this.generation) {
          return null;
        }
        return transcribePcmWithStarling({
          modelId: this.opts.modelId,
          pcm: new Uint8Array(audio),
          sampleRate: STARLING_SAMPLE_RATE,
          deferUnload: true,
        });
      })
      .then((text) => {
        if (text === null) return;
        if (this.closed || this.canceled || generation !== this.generation) {
          return;
        }
        const clean = text.trim();
        if (final) {
          this.handleFinalResult(clean);
          return;
        }
        this.handlePartialResult(clean);
      })
      .catch((err: Error) => {
        if (this.closed || generation !== this.generation) return;
        if (final && this.commitRequested) {
          // On commit, salvage with whatever we already have rather than
          // failing the whole recording on a single chunk error.
          log.warn(`final chunk failed, salvaging: ${err.message}`);
          this.opts.callbacks.onFinal(this.composeFinal());
          applyStarlingRetentionPolicy();
          return;
        }
        this.opts.callbacks.onError(err.message);
      })
      .finally(() => {
        if (this.closed || this.canceled || generation !== this.generation) {
          if (this.closed || this.canceled) applyStarlingRetentionPolicy();
          return;
        }
        this.inFlight = false;
        if (this.commitRequested) {
          this.commitRequested = false;
          this.runFinalPass();
          return;
        }
        if (this.dirty) {
          this.schedulePartial();
        }
      });
  }

  private handlePartialResult(text: string): void {
    this.liveText = text;
    const preview = previewText(this.accumulated, this.liveText);
    this.opts.callbacks.onPartial(preview);

    // Advance a committed chunk when the live window gets long enough, so
    // per-partial inference cost stays bounded over long recordings.
    if (this.liveDurationMs() >= this.segmentAdvanceMs) {
      this.advanceChunk();
    }
  }

  private handleFinalResult(liveText: string): void {
    this.liveText = liveText;
    const finalText = mergeFinalSegment(this.accumulated, this.liveText);
    this.opts.callbacks.onFinal(finalText.trim());
    applyStarlingRetentionPolicy();
  }

  /**
   * Lock the current live text into `accumulated` and reset the live window.
   * Subsequent partials transcribe only the audio after this boundary.
   */
  private advanceChunk(): void {
    this.accumulated = mergeFinalSegment(this.accumulated, this.liveText);
    this.liveChunks = [];
    this.liveSampleCount = 0;
    this.liveText = "";
  }

  private composeFinal(): string {
    return mergeFinalSegment(this.accumulated, this.liveText).trim();
  }

  // --- helpers -------------------------------------------------------------

  private snapshotLive(): Buffer {
    return Buffer.concat(this.liveChunks);
  }

  private liveDurationMs(): number {
    return Math.round((this.liveSampleCount / STARLING_SAMPLE_RATE) * 1000);
  }

  private trimGlobalBuffer(): void {
    const maxSamples = Math.round(
      (MAX_BUFFERED_MS / 1000) * STARLING_SAMPLE_RATE,
    );
    if (this.allSampleCount <= maxSamples) return;
    // Drop oldest chunks until under the cap. This only affects the final
    // fallback path (which re-transcribes everything); committed text is safe.
    while (this.allSampleCount > maxSamples && this.allChunks.length > 1) {
      const dropped = this.allChunks.shift();
      if (!dropped) break;
      this.allSampleCount -= Math.floor(dropped.byteLength / 2);
    }
  }

  private clearTimer(): void {
    if (!this.partialTimer) return;
    clearTimeout(this.partialTimer);
    this.partialTimer = null;
  }
}

/** Re-exported so callers can check the server flag without a second import. */
export { isStarlingServerFailed };
