/**
 * Starling local STT provider constants.
 *
 * Starling is an external Python inference engine (CUDA-graph kernels for
 * speech recognition, tuned for a single RTX 5090) that ships as a package
 * exposing `starling.granite.server` — a local HTTP/WebSocket sidecar that
 * keeps the model resident in VRAM. See https://github.com/sims1253/starling.
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

export interface StarlingModelDef {
  /** Catalog id used in model_configs (after the `local-starling/` prefix). */
  id: string;
  /**
   * Server module + (optional) `--model` argument passed to the starling
   * server. The granite entry launches `starling.granite.server`, which loads
   * its bundled model automatically. Reserved for future parakeet-via-starling
   * server entry points.
   */
  serverModule: string;
  modelArg?: string;
  displayName: string;
  family: string;
  speed: string;
  quality: string;
  vramRequired: string;
}

/**
 * Curated catalog of starling server entry points. Only `granite` is exposed
 * today since that is the server module starling ships; parakeet is listed as
 * a future/legacy placeholder the user may have wired locally.
 */
export const STARLING_MODELS: StarlingModelDef[] = [
  {
    id: "granite-speech",
    serverModule: "starling.granite.server",
    displayName: "Granite Speech 4.1 (2B)",
    family: "granite-speech",
    speed: "Medium",
    quality: "High",
    vramRequired: "~9.7 GB",
  },
];

/**
 * Removed-from-catalog entries kept resolvable so existing installs that
 * selected one keep working; surfaced in pickers only when "downloaded"
 * (here: when the server is reachable with that entry point).
 */
export const LEGACY_STARLING_MODELS: StarlingModelDef[] = [];

export function getStarlingModel(id: string): StarlingModelDef | undefined {
  return (
    STARLING_MODELS.find((m) => m.id === id) ??
    LEGACY_STARLING_MODELS.find((m) => m.id === id)
  );
}
