import { Hono } from "hono";
import { getDefaultModels } from "../lib/providers.js";
import {
  STARLING_MODELS,
  STARLING_PROVIDER_ID,
  STARLING_PROVIDER_NAME,
} from "../lib/starling/constants.js";
import {
  canRunStarling,
  describeStarlingSetupBlocker,
  findStarlingPython,
  getStarlingPhase,
  getStarlingQueueDepth,
  getStarlingRunningModelSlug,
  getStarlingServerBaseUrl,
  getStarlingStartError,
  isStarlingServerFailed,
  isStarlingServerRunning,
  probeStarlingHealth,
  startStarlingInBackground,
  stopStarlingServer,
} from "../lib/starling/server.js";
import {
  getStarlingHost,
  getStarlingKeepAliveMinutes,
  getStarlingPort,
  getStarlingProfile,
  getStarlingPythonPath,
  getStarlingSourcePath,
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
      pythonPath: findStarlingPython(),
      configuredPythonPath: getStarlingPythonPath() ?? null,
      sourcePath: getStarlingSourcePath() ?? null,
      host: getStarlingHost(),
      port: getStarlingPort(),
      profile: getStarlingProfile(),
      baseUrl: getStarlingServerBaseUrl(),
      serverRunning: isStarlingServerRunning(),
      serverFailed: isStarlingServerFailed(),
      startError: getStarlingStartError(),
      runningModelSlug: getStarlingRunningModelSlug() ?? health?.model ?? null,
      phase: health?.phase ?? getStarlingPhase(),
      queueDepth: health?.queueDepth ?? getStarlingQueueDepth(),
      keepAliveMinutes: getStarlingKeepAliveMinutes(),
      modelDefinitions: STARLING_MODELS,
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
  });

export default starling;
