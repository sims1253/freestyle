import { createAppLogger } from "@freestyle/utils";
import { Hono } from "hono";
import { isBinaryAvailable } from "../lib/parakeet/binary.js";
import {
  getModelsDir,
  PARAKEET_PROVIDER_ID,
} from "../lib/parakeet/constants.js";
import {
  cancelDownload,
  clearDownloadError,
  deleteModel,
  downloadModel,
  getAllModelStatuses,
  getCatalogModels,
  getModelStatus,
  isBinaryDownloading,
} from "../lib/parakeet/models.js";
import { capture } from "../lib/posthog.js";
import { getDefaultModels } from "../lib/providers.js";
import { stripProviderPrefix } from "../lib/streaming/types.js";

const log = createAppLogger("parakeet");

const parakeet = new Hono()
  .get("/status", (c) => {
    return c.json({
      binaryAvailable: isBinaryAvailable(),
      binaryDownloading: isBinaryDownloading(),
      // Kept for renderer compatibility — parakeet uses parakeet-cli per
      // request, so there is no persistent server. These fields mirror
      // isBinaryAvailable so the UI treats "binary present" as "ready".
      serverBinaryAvailable: isBinaryAvailable(),
      serverRunning: false,
      serverFailed: false,
      modelsDir: getModelsDir(),
      models: getAllModelStatuses(),
      modelDefinitions: getCatalogModels().map((m) => ({
        id: m.id,
        displayName: m.displayName,
        sizeBytes: m.sizeBytes,
        ramRequired: m.ramRequired,
        speed: m.speed,
        quality: m.quality,
        quantized: m.quantized,
      })),
    });
  })
  .post("/models/:model/download", async (c) => {
    const modelId = c.req.param("model");

    const status = getModelStatus(modelId);
    if (!status) {
      return c.json({ error: `Unknown model: ${modelId}` }, 400);
    }

    if (status.status === "ready") {
      return c.json({ ok: true, message: "Model already downloaded" });
    }

    if (status.status === "downloading") {
      return c.json({ ok: true, message: "Download already in progress" });
    }

    clearDownloadError(modelId);

    downloadModel(modelId).catch(() => {});

    capture("parakeet model download started", { model_id: modelId });

    return c.json({ ok: true, message: "Download started" });
  })
  .post("/models/:model/cancel", (c) => {
    const modelId = c.req.param("model");
    const cancelled = cancelDownload(modelId);
    return c.json({ ok: cancelled });
  })
  .delete("/models/:model", (c) => {
    const modelId = c.req.param("model");
    const deleted = deleteModel(modelId);

    if (deleted) {
      capture("parakeet model deleted", { model_id: modelId });
    }

    return c.json({ ok: deleted });
  })
  .post("/server/start", async (c) => {
    // parakeet-cli is invoked per-request; no persistent server to start.
    return c.json({ ok: true });
  })
  .post("/server/stop", async (c) => {
    // parakeet-cli is invoked per-request; no persistent server to stop.
    return c.json({ ok: true });
  });

export default parakeet;

export function autoStartParakeetServer(): void {
  // parakeet-cli is invoked per-request; nothing to pre-start.
}
