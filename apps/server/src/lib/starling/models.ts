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
import { isStarlingServerRunning, probeStarlingHealth } from "./server.js";

export type StarlingModelStatus = "ready" | "not_ready" | "error";

export interface StarlingModelDownloadState {
  model: string;
  displayName: string;
  status: StarlingModelStatus;
  /** Populated when status === "error"; explains why starling can't run. */
  error?: string;
}

/**
 * Whether the catalog entry is loadable right now. We treat the catalog model
 * as ready as soon as the server reports loaded; starling's server loads a
 * single bundled model, so any catalog entry resolves to the running server.
 */
async function resolveStatus(
  model: StarlingModelDef,
): Promise<StarlingModelDownloadState> {
  if (isStarlingServerRunning()) {
    return {
      model: model.id,
      displayName: model.displayName,
      status: "ready",
    };
  }
  // Probe in case an external starling server is running on the configured port.
  const health = await probeStarlingHealth();
  if (health?.status === "ok" && health.loaded) {
    return {
      model: model.id,
      displayName: model.displayName,
      status: "ready",
    };
  }
  return {
    model: model.id,
    displayName: model.displayName,
    status: "not_ready",
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
