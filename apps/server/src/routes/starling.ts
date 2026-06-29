import { createAppLogger } from "@freestyle/utils";
import { Hono } from "hono";
import { getDefaultModels } from "../lib/providers.js";
import {
  STARLING_PROVIDER_ID,
  STARLING_PROVIDER_NAME,
} from "../lib/starling/constants.js";
import {
  getAllStarlingModelStatuses,
  getStarlingCatalogModels,
} from "../lib/starling/models.js";
import {
  canRunStarling,
  describeStarlingSetupBlocker,
  findStarlingPython,
  getStarlingServerBaseUrl,
  isStarlingServerFailed,
  isStarlingServerRunning,
  startStarlingInBackground,
  stopStarlingServer,
} from "../lib/starling/server.js";
import {
  getStarlingHost,
  getStarlingKeepAliveMinutes,
  getStarlingPartialIntervalMs,
  getStarlingPort,
  getStarlingPythonPath,
  getStarlingSegmentAdvanceMs,
  getStarlingSourcePath,
} from "../lib/starling/settings.js";
import { stripProviderPrefix } from "../lib/streaming/types.js";

const log = createAppLogger("starling");

const starling = new Hono()
  .get("/status", async (c) => {
    const python = findStarlingPython();
    const source = getStarlingSourcePath();
    const configuredPython = getStarlingPythonPath();
    const blockedReason = describeStarlingSetupBlocker();

    return c.json({
      providerId: STARLING_PROVIDER_ID,
      providerName: STARLING_PROVIDER_NAME,
      canRun: canRunStarling(),
      blockedReason,
      pythonPath: python,
      configuredPythonPath: configuredPython ?? null,
      sourcePath: source ?? null,
      host: getStarlingHost(),
      port: getStarlingPort(),
      baseUrl: getStarlingServerBaseUrl(),
      serverRunning: isStarlingServerRunning(),
      serverFailed: isStarlingServerFailed(),
      keepAliveMinutes: getStarlingKeepAliveMinutes(),
      partialIntervalMs: getStarlingPartialIntervalMs(),
      segmentAdvanceMs: getStarlingSegmentAdvanceMs(),
      models: await getAllStarlingModelStatuses(),
      modelDefinitions: getStarlingCatalogModels().map((m) => ({
        id: m.id,
        serverModule: m.serverModule,
        modelArg: m.modelArg ?? null,
        displayName: m.displayName,
        family: m.family,
        speed: m.speed,
        quality: m.quality,
        vramRequired: m.vramRequired,
      })),
      setupHint:
        blockedReason ??
        "Point Starling at a Python venv that has starling installed, then start the server.",
    });
  })
  .post("/models/:model/download", async (c) => {
    const modelId = c.req.param("model");
    // Starling bundles its own weights, so "download" = start/load server.
    if (!canRunStarling()) {
      return c.json(
        {
          error:
            describeStarlingSetupBlocker() ??
            "Starling is not configured. Set the Python path in Starling settings.",
        },
        400,
      );
    }
    startStarlingInBackground(modelId);
    return c.json({ ok: true, message: "Server start requested" });
  })
  .post("/models/:model/cancel", (c) => {
    // No download to cancel; no-op for API compatibility with the model card.
    return c.json({ ok: true });
  })
  .delete("/models/:model", (c) => {
    // No bundled weights to delete; stop the server instead.
    void stopStarlingServer().catch(() => undefined);
    return c.json({ ok: true });
  })
  .post("/server/start", async (c) => {
    const body = await c.req
      .json<{ modelId?: string }>()
      .catch(() => ({ modelId: undefined }));
    let modelId = body.modelId;

    if (!modelId) {
      const defaults = getDefaultModels();
      if (defaults.voice?.provider === STARLING_PROVIDER_ID) {
        modelId = stripProviderPrefix(defaults.voice.model_id);
      }
    }

    if (!modelId) {
      return c.json({ error: "No model specified" }, 400);
    }

    if (!canRunStarling()) {
      return c.json(
        {
          error:
            describeStarlingSetupBlocker() ??
            "Starling is not configured. Set the Python path in Starling settings.",
        },
        400,
      );
    }

    startStarlingInBackground(modelId);
    return c.json({ ok: true });
  })
  .post("/server/stop", async (c) => {
    await stopStarlingServer();
    return c.json({ ok: true });
  });

export default starling;

export function autoStartStarlingServer(): void {
  try {
    const defaults = getDefaultModels();
    if (defaults.voice?.provider !== STARLING_PROVIDER_ID) return;
    if (!canRunStarling()) {
      log.debug("Skipping auto-start — starling not configured");
      return;
    }
    const modelId = stripProviderPrefix(defaults.voice.model_id);
    log.debug(`Auto-starting server for model: ${modelId}`);
    startStarlingInBackground(modelId);
  } catch {
    // DB not ready — skip
  }
}
