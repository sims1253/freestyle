/**
 * Starling local STT provider constants.
 *
 * Starling is an external Python inference engine (CUDA-graph kernels for
 * speech recognition, tuned for a single RTX 5090) that ships as a package
 * exposing `starling.server` — a unified local HTTP/WebSocket sidecar that
 * keeps one model resident in VRAM, selected by `--model`. See
 * https://github.com/sims1253/starling.
 *
 * Unlike the bundled whisper/parakeet binaries or the MLX stdio worker,
 * starling is *not* downloaded or built by freestyle: the user provides a
 * Python executable (and optionally a checkout/source path) via settings, and
 * freestyle spawns and supervises the HTTP server process.
 */

export const STARLING_PROVIDER_ID = "local-starling";

export const STARLING_PROVIDER_NAME = "Local Starling";

/**
 * Default HTTP port for the starling sidecar. Matches starling's own default
 * (8181); sits next to whisper-server (8178), mlx (8179), parakeet (8180).
 * Overridable via the `starling_port` setting.
 */
export const STARLING_DEFAULT_PORT = 8181;

export const STARLING_DEFAULT_HOST = "127.0.0.1";

/** PCM rate starling's server consumes for raw streaming input. */
export const STARLING_SAMPLE_RATE = 16_000;

/** Unified server module (replaces the former starling.granite.server). */
export const STARLING_SERVER_MODULE = "starling.server";

export interface StarlingModelDef {
  /** Catalog id used in model_configs (after the `local-starling/` prefix). */
  id: string;
  /**
   * `--model` slug passed to `python -m starling.server`. One starling process
   * serves exactly one model; switching the selected catalog entry restarts
   * the sidecar with a different slug. Must match starling's MODEL_SLUGS.
   */
  slug: string;
  displayName: string;
  family: string;
  speed: string;
  quality: string;
  vramRequired: string;
}

/**
 * Curated catalog of starling models. Mirrors starling's own MODEL_SLUGS
 * (granite/parakeet/moss/qwen3). Each entry spawns the unified
 * `starling.server` with its `--model <slug>`; one process serves one model.
 */
export const STARLING_MODELS: StarlingModelDef[] = [
  {
    id: "granite",
    slug: "granite",
    displayName: "Granite Speech 4.1 (2B)",
    family: "granite-speech",
    speed: "Medium",
    quality: "High",
    vramRequired: "~9.7 GB",
  },
  {
    id: "parakeet",
    slug: "parakeet",
    displayName: "Parakeet TDT 0.6B v3",
    family: "parakeet",
    speed: "Fastest",
    quality: "High",
    vramRequired: "~2 GB",
  },
  {
    id: "moss",
    slug: "moss",
    displayName: "Moss Transcribe (2B)",
    family: "moss",
    speed: "Medium",
    quality: "High",
    vramRequired: "~9 GB",
  },
  {
    id: "qwen3",
    slug: "qwen3",
    displayName: "Qwen3 ASR (1.7B)",
    family: "qwen3",
    speed: "Fast",
    quality: "Best",
    vramRequired: "~7 GB",
  },
];

/**
 * Removed-from-catalog entries kept resolvable so existing installs that
 * selected one keep working; surfaced in pickers only when "downloaded"
 * (here: when the server is reachable with that model slug).
 *
 * The old `granite-speech` id (pre-multi-model) maps to the granite slug.
 */
export const LEGACY_STARLING_MODELS: StarlingModelDef[] = [
  {
    id: "granite-speech",
    slug: "granite",
    displayName: "Granite Speech 4.1 (2B)",
    family: "granite-speech",
    speed: "Medium",
    quality: "High",
    vramRequired: "~9.7 GB",
  },
];

export function getStarlingModel(id: string): StarlingModelDef | undefined {
  return (
    STARLING_MODELS.find((m) => m.id === id) ??
    LEGACY_STARLING_MODELS.find((m) => m.id === id)
  );
}
