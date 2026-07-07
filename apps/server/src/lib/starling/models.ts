/**
 * Starling model catalog + status.
 *
 * Starling bundles its own weights in the user's Python environment/checkout,
 * so — unlike whisper/parakeet/mlx — there is no Hugging Face download to
 * manage. A model is "ready" when the starling server is reachable and reports
 * its model loaded. The "download" action in the UI therefore maps to
 * "start/load the server," not a network fetch.
 */

import {
  getStarlingModel,
  LEGACY_STARLING_MODELS,
  STARLING_MODELS,
  type StarlingModelDef,
} from "./constants.js";
import {
  getStarlingRunningModelSlug,
  isStarlingServerRunning,
  probeStarlingHealth,
} from "./server.js";

export type StarlingModelStatus = "ready" | "not_ready" | "error";

export interface StarlingModelDownloadState {
  model: string;
  displayName: string;
  status: StarlingModelStatus;
  /** Populated when status === "error"; explains why starling can't run. */
  error?: string;
}

/**
 * Whether a catalog entry is loadable right now. One starling process serves
 * exactly one model (its `--model` slug), so an entry is "ready" only when a
 * server is loaded AND its reported model slug matches this entry's slug.
 *
 * For an externally-started server (freestyle didn't spawn it), we probe
 * /health and match on the reported `model` field. A managed server's slug is
 * tracked directly via getStarlingRunningModelSlug.
 */
async function resolveStatus(
  model: StarlingModelDef,
): Promise<StarlingModelDownloadState> {
  const managedSlug = getStarlingRunningModelSlug();
  if (managedSlug) {
    return {
      model: model.id,
      displayName: model.displayName,
      status: managedSlug === model.slug ? "ready" : "not_ready",
    };
  }
  // Probe in case an external starling server is running on the configured port.
  const health = await probeStarlingHealth();
  const externalMatch =
    health?.status === "ok" && health.loaded && health.model === model.slug;
  return {
    model: model.id,
    displayName: model.displayName,
    status: externalMatch ? "ready" : "not_ready",
  };
}

export async function getStarlingModelStatus(
  modelId: string,
): Promise<StarlingModelDownloadState | null> {
  const model = getStarlingModel(modelId);
  if (!model) return null;
  return resolveStatus(model);
}

export function getStarlingCatalogModels(): StarlingModelDef[] {
  return [...STARLING_MODELS, ...LEGACY_STARLING_MODELS];
}

export async function getAllStarlingModelStatuses(): Promise<
  StarlingModelDownloadState[]
> {
  return Promise.all(getStarlingCatalogModels().map((m) => resolveStatus(m)));
}
