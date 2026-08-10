import { sanitizeTranscriptText } from "@freestyle-voice/stt";
import { createAppLogger } from "@freestyle-voice/utils";
import { Hono } from "hono";
import { saveAudioBackup } from "../lib/audio-backup.js";
import {
  FreestyleCloudAuthError,
  FreestyleCloudUsageError,
} from "../lib/freestyle-cloud.js";
import {
  getLastHistoryId,
  saveProcessedHistory,
} from "../lib/history-store.js";
import { getLanguagesSetting } from "../lib/language.js";
import { postProcess } from "../lib/post-process.js";
import { capture } from "../lib/posthog.js";
import { getDefaultModels } from "../lib/providers.js";
import { STARLING_PROVIDER_ID } from "../lib/starling/constants.js";
import { transcribeWithStarling } from "../lib/starling/server.js";
import { stripProviderPrefix } from "../lib/streaming/types.js";

const log = createAppLogger("transcribe-file");

/**
 * Batch transcription for user-selected audio files. The renderer decodes and
 * resamples every supported container to PCM WAV before posting here, keeping
 * codec dependencies out of the server. Unlike dictation, this route has no
 * focused-app context, paste behavior, or dictation plugin hooks.
 */
const transcribeFile = new Hono().post("/", async (c) => {
  const start = Date.now();
  const audio = new Uint8Array(await c.req.arrayBuffer());
  if (audio.length === 0) return c.json({ error: "Empty audio data" }, 400);

  const defaults = getDefaultModels();
  if (defaults.voice?.provider !== STARLING_PROVIDER_ID) {
    return c.json(
      { error: "A Local Starling voice model must be configured." },
      400,
    );
  }

  const voiceModel = stripProviderPrefix(defaults.voice.model_id);
  const audioDurationMs =
    audio.length > 44 ? Math.round((audio.length - 44) / 32) : 0;

  let raw: string;
  try {
    const result = await transcribeWithStarling({
      modelId: voiceModel,
      audio,
      requestId: c.req.header("x-request-id"),
    });
    raw = sanitizeTranscriptText(result.text);
  } catch (error) {
    log.error(`Starling file transcription failed: ${String(error)}`);
    return c.json(
      {
        error: "Transcription failed",
        detail: error instanceof Error ? error.message : String(error),
      },
      500,
    );
  }

  let processed: Awaited<ReturnType<typeof postProcess>>;
  try {
    processed = await postProcess(raw, null, {
      languages: getLanguagesSetting(),
      source: "batch",
    });
  } catch (error) {
    if (error instanceof FreestyleCloudAuthError) {
      return c.json({ error: "cloud_auth_required" }, 401);
    }
    if (error instanceof FreestyleCloudUsageError) {
      return c.json({ error: "usage_exceeded", resetsAt: error.resetsAt }, 429);
    }
    log.error(
      `File cleanup failed; delivering raw transcript: ${String(error)}`,
    );
    const historyId = saveProcessedHistory({
      rawText: raw,
      cleanedText: null,
      voiceProvider: STARLING_PROVIDER_ID,
      voiceModel,
      durationMs: Date.now() - start,
      audioDurationMs,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
    });
    if (historyId) saveAudioBackup(getLastHistoryId(), audio);
    return c.json({
      raw,
      cleaned: raw,
      cleanupFailed: true,
      cleanupError: error instanceof Error ? error.message : String(error),
    });
  }

  const durationMs = Date.now() - start;
  try {
    const historyId = saveProcessedHistory({
      rawText: raw,
      cleanedText: processed.cleaned !== raw ? processed.cleaned : null,
      voiceProvider: STARLING_PROVIDER_ID,
      voiceModel,
      llmProvider: processed.llmProvider,
      llmModel: processed.llmModel,
      durationMs,
      audioDurationMs,
      inputTokens: processed.inputTokens,
      outputTokens: processed.outputTokens,
      costUsd: processed.costUsd,
    });
    if (historyId) saveAudioBackup(getLastHistoryId(), audio);
  } catch (error) {
    log.error(`Failed to save file transcription history: ${String(error)}`);
  }

  capture("file transcription completed", {
    provider: STARLING_PROVIDER_ID,
    model: voiceModel,
    duration_ms: durationMs,
    audio_duration_ms: audioDurationMs,
    post_processed: true,
  });

  return c.json({
    raw,
    cleaned: processed.cleaned,
    durationMs,
    audioDurationMs,
    llmModel: processed.llmModel,
    inputTokens: processed.inputTokens,
    outputTokens: processed.outputTokens,
    costUsd: processed.costUsd,
  });
});

export default transcribeFile;
