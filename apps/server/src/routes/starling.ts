import { Hono } from "hono";
import { getDefaultModels } from "../lib/providers.js";
import {
  STARLING_MODELS,
  STARLING_PROVIDER_ID,
  STARLING_PROVIDER_NAME,
  STARLING_SERVE_VERSION,
} from "../lib/starling/constants.js";
import {
  getStarlingBinaryState,
  getStarlingModelDownloadStates,
  startBinaryDownload,
  startStarlingModelDownload,
} from "../lib/starling/downloads.js";
import {
  canRunStarling,
  describeStarlingSetupBlocker,
  getStarlingPhase,
  getStarlingQueueDepth,
  getStarlingRunningModelSlug,
  getStarlingServerBaseUrl,
  getStarlingStartError,
  isStarlingServerExternal,
  isStarlingServerFailed,
  isStarlingServerRunning,
  probeStarlingHealth,
  startStarlingInBackground,
  stopStarlingServer,
} from "../lib/starling/server.js";
import {
  getStarlingBinaryPath,
  getStarlingGgufDir,
  getStarlingHost,
  getStarlingKeepAliveMinutes,
  getStarlingKeepLoaded,
  getStarlingPort,
  getStarlingQuant,
} from "../lib/starling/settings.js";
import { stripProviderPrefix } from "../lib/streaming/types.js";

const starling = new Hono()
  .get("/status", async (c) => {
    const health = await probeStarlingHealth();
    return c.json({
      providerId: STARLING_PROVIDER_ID,
      providerName: STARLING_PROVIDER_NAME,
      canRun: canRunStarling(),
      blockedReason: describeStarlingSetupBlocker(),
      binaryPath: getStarlingBinaryPath() ?? null,
      ggufDir: getStarlingGgufDir() ?? null,
      quant: getStarlingQuant(),
      serveVersion: STARLING_SERVE_VERSION,
      host: getStarlingHost(),
      port: getStarlingPort(),
      baseUrl: getStarlingServerBaseUrl(),
      serverRunning: isStarlingServerRunning(),
      external: isStarlingServerExternal(),
      serverFailed: isStarlingServerFailed(),
      startError: getStarlingStartError(),
      runningModelSlug: getStarlingRunningModelSlug() ?? health?.model ?? null,
      phase: health?.phase ?? getStarlingPhase(),
      queueDepth: health?.queueDepth ?? getStarlingQueueDepth(),
      keepAliveMinutes: getStarlingKeepAliveMinutes(),
      keepLoaded: getStarlingKeepLoaded(),
      modelDefinitions: STARLING_MODELS,
      modelDownloads: await getStarlingModelDownloadStates(),
      binaryState: await getStarlingBinaryState(),
    });
  })
  .post("/server/start", async (c) => {
    const body = await c.req
      .json<{ modelId?: string }>()
      .catch(() => ({}) as { modelId?: string });
    const modelId =
      body.modelId ??
      (getDefaultModels().voice?.provider === STARLING_PROVIDER_ID
        ? stripProviderPrefix(getDefaultModels().voice!.model_id)
        : undefined);
    if (!modelId) return c.json({ error: "No Starling model specified" }, 400);
    if (!canRunStarling())
      return c.json({ error: describeStarlingSetupBlocker() }, 400);
    startStarlingInBackground(modelId);
    return c.json({ ok: true });
  })
  .post("/server/stop", async (c) => {
    await stopStarlingServer();
    return c.json({ ok: true });
  })
  .post("/models/:id/download", (c) => {
    const result = startStarlingModelDownload(c.req.param("id"));
    if (!result.ok) return c.json({ error: result.error }, result.status);
    return c.json({ ok: true });
  })
  .post("/binary/download", async (c) => {
    await startBinaryDownload();
    return c.json({ ok: true });
  });

export default starling;
