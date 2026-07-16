/**
 * Starling's local transcription transport. Batch audio is WAV; the stream
 * route sends the app's native PCM16/16 kHz frames directly to Starling's
 * server-side chunker. Audio and a pending commit are buffered while model
 * loading completes, so recording can start before the sidecar is ready.
 */

import { collapseAsrLineBreaks } from "@freestyle-voice/stt";
import { createAppLogger } from "@freestyle-voice/utils";
import WebSocket from "ws";
import { STARLING_PROVIDER_ID } from "../../starling/constants.js";
import {
  applyStarlingRetentionPolicy,
  ensureStarlingServerRunning,
  getStarlingServerBaseUrl,
  transcribeWithStarling,
} from "../../starling/server.js";
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

export class StarlingLocalTranscriptionProvider
  implements TranscriptionProvider
{
  readonly providerId = STARLING_PROVIDER_ID;
  supportsStreaming(): boolean {
    return true;
  }
  async transcribe(opts: TranscribeOptions): Promise<TranscribeResult> {
    const result = await transcribeWithStarling({
      modelId: stripProviderPrefix(opts.model),
      audio: opts.audio,
    });
    return {
      text: collapseAsrLineBreaks(result.text).trim(),
      segments: result.segments,
      durationInSeconds: result.durationInSeconds,
    };
  }
  openStreamingSession(opts: StreamingSessionOptions): StreamSession {
    return new StarlingStreamingSession(
      stripProviderPrefix(opts.model),
      opts.callbacks,
    );
  }
}

class StarlingStreamingSession implements StreamSession {
  private socket: WebSocket | null = null;
  private bufferedAudio: Buffer[] = [];
  private closed = false;
  private cancelled = false;
  private commitPending = false;
  private generation = 0;
  private readyPromise: Promise<void> = Promise.resolve();

  constructor(
    private readonly modelId: string,
    private readonly callbacks: StreamCallbacks,
  ) {
    this.start();
  }
  sendAudio(chunk: ArrayBuffer): void {
    if (this.closed || this.cancelled) return;
    const audio = Buffer.from(chunk);
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(audio);
    else this.bufferedAudio.push(audio);
  }
  reset(): void {
    this.bufferedAudio = [];
    this.cancelled = false;
    this.commitPending = false;

    // An open socket's event handlers captured the current generation. Keep
    // it when reusing the socket; otherwise its partial/final messages would
    // be discarded after every recording reset.
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify({ type: "reset" }));
    } else {
      this.generation++;
      this.start();
    }
  }
  waitUntilReady(): Promise<void> {
    return this.readyPromise;
  }
  commit(): void {
    if (this.closed || this.cancelled) return;
    if (this.socket?.readyState === WebSocket.OPEN) this.sendControl("commit");
    else this.commitPending = true;
  }
  cancel(): void {
    this.cancelled = true;
    this.commitPending = false;
    this.bufferedAudio = [];
    this.socket?.close();
    this.socket = null;
    applyStarlingRetentionPolicy();
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.cancel();
    this.callbacks.onClose();
  }
  private start(): void {
    const generation = this.generation;
    this.readyPromise = ensureStarlingServerRunning(this.modelId)
      .then(() => {
        if (this.closed || this.cancelled || generation !== this.generation)
          return;
        const wsUrl = `${getStarlingServerBaseUrl().replace(/^http/, "ws")}/stream`;
        const socket = new WebSocket(wsUrl);
        this.socket = socket;
        socket.on("open", () => {
          if (this.closed || this.cancelled || generation !== this.generation)
            return socket.close();
          for (const audio of this.bufferedAudio) socket.send(audio);
          this.bufferedAudio = [];
          this.callbacks.onReady(this.modelId);
          if (this.commitPending) {
            this.commitPending = false;
            this.sendControl("commit");
          }
        });
        socket.on("message", (raw) =>
          this.handleMessage(raw.toString(), generation),
        );
        socket.on("error", (error) => {
          if (!this.closed && generation === this.generation)
            this.callbacks.onError(error.message);
        });
        socket.on("close", () => {
          if (!this.closed && !this.cancelled && generation === this.generation)
            this.callbacks.onClose();
        });
      })
      .catch((error: Error) => {
        if (!this.closed && generation === this.generation)
          this.callbacks.onError(error.message);
      });
  }
  private sendControl(type: "commit" | "reset"): void {
    if (this.socket?.readyState === WebSocket.OPEN)
      this.socket.send(JSON.stringify({ type }));
  }
  private handleMessage(raw: string, generation: number): void {
    if (this.closed || this.cancelled || generation !== this.generation) return;
    try {
      const message = JSON.parse(raw) as {
        type?: string;
        text?: string;
        message?: string;
      };
      if (message.type === "partial")
        this.callbacks.onPartial(
          collapseAsrLineBreaks(message.text ?? "").trim(),
        );
      else if (message.type === "final") {
        this.callbacks.onFinal(
          collapseAsrLineBreaks(message.text ?? "").trim(),
        );
        applyStarlingRetentionPolicy();
      } else if (message.type === "error")
        this.callbacks.onError(message.message ?? "Starling streaming error");
    } catch {
      log.warn(`Ignoring malformed Starling stream message: ${raw}`);
    }
  }
}
