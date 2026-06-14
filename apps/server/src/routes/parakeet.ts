import { createAppLogger } from "@freestyle/utils";
import { Hono } from "hono";
import {
  backendLabel,
  getAvailableBackends,
  getPlatformDefaultBackend,
  type ParakeetBackend,
} from "../lib/parakeet/backends.js";
import { isBinaryAvailable } from "../lib/parakeet/binary.js";
import { getModelsDir } from "../lib/parakeet/constants.js";
import {
  cancelDownload,
  clearDownloadError,
  deleteModel,
  downloadModel,
  ensureBinariesDownloaded,
  getAllModelStatuses,
  getCatalogModels,
  getInstalledBackend,
  getModelStatus,
  isBinaryDownloading,
} from "../lib/parakeet/models.js";
import {
  getCurrentBackend,
  readParakeetBackendSetting,
} from "../lib/parakeet/server.js";
import { capture } from "../lib/posthog.js";

const log = createAppLogger("parakeet");

const VALID_BACKENDS = new Set<ParakeetBackend>([
  "auto",
  "cpu",
  "vulkan",
  "cuda",
  "metal",
]);

const parakeet = new Hono()
  .get("/status", (c) => {
    const preference = readParakeetBackendSetting();
    const installed = getInstalledBackend();
    const available = getAvailableBackends();
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
      // Compute backend selection
      computeBackend: preference ?? "auto",
      availableBackends: available,
      platformDefaultBackend: getPlatformDefaultBackend(),
      installedBackend: installed,
      activeBackend: getCurrentBackend(),
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
  })
  .post("/binary/download", async (c) => {
    // Trigger (or no-op) the binary download for the requested backend. Used
    // when the user switches GPU backends in the picker. CPU is a no-op since
    // it forces the device on the existing binary rather than re-downloading.
    const body = (await c.req.json().catch(() => ({}))) as {
      backend?: string;
    };
    const backend = (body.backend ?? "auto") as ParakeetBackend;
    if (!VALID_BACKENDS.has(backend)) {
      return c.json({ error: `Unknown backend: ${body.backend}` }, 400);
    }

    try {
      await ensureBinariesDownloaded(backend);
      capture("parakeet backend downloaded", {
        backend: backendLabel(backend),
      });
      return c.json({ ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn(`parakeet binary download failed: ${message}`);
      return c.json({ error: message }, 500);
    }
  });

export default parakeet;

export function autoStartParakeetServer(): void {
  // parakeet-cli is invoked per-request; nothing to pre-start.
}
