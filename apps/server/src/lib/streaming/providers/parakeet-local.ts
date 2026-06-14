import { createAppLogger } from "@freestyle/utils";
import { isBinaryAvailable } from "../../parakeet/binary.js";
import { PARAKEET_PROVIDER_ID } from "../../parakeet/constants.js";
import { ensureBinariesDownloaded } from "../../parakeet/models.js";
import {
  readParakeetBackendSetting,
  transcribeViaCli,
} from "../../parakeet/server.js";
import type {
  TranscribeOptions,
  TranscribeResult,
  TranscriptionProvider,
} from "../types.js";
import { stripProviderPrefix } from "../types.js";

const log = createAppLogger("parakeet");

export class ParakeetLocalTranscriptionProvider
  implements TranscriptionProvider
{
  readonly providerId = PARAKEET_PROVIDER_ID;

  async transcribe(opts: TranscribeOptions): Promise<TranscribeResult> {
    const modelId = stripProviderPrefix(opts.model);

    if (!isBinaryAvailable()) {
      try {
        // Respect the user's backend setting for the first download.
        await ensureBinariesDownloaded(readParakeetBackendSetting() ?? "auto");
      } catch (err) {
        throw new Error(
          `parakeet-cli binary not found and automatic setup failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    const t0 = Date.now();
    const result = await transcribeViaCli({
      model: modelId,
      audio: opts.audio,
      language: opts.language,
    });
    log.debug(`cli inference took ${Date.now() - t0}ms`);
    return result;
  }

  supportsStreaming(_modelId: string): boolean {
    return false;
  }
}
