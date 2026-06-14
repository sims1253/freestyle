/**
 * parakeet.cpp compute backend catalog.
 *
 * parakeet.cpp publishes one `parakeet-cli` binary per backend (cpu / vulkan /
 * cuda / metal). Every build also contains the CPU backend, so a GPU build
 * auto-accelerates when a device is present and silently falls back to CPU
 * otherwise — one binary works everywhere. CPU can additionally be forced at
 * runtime via the `PARAKEET_DEVICE=cpu` env var, with no re-download.
 *
 * This module is the single source of truth for which backends exist per
 * platform, which one is the platform default, and which release asset each
 * backend maps to. It is shared by the runtime auto-download path
 * (models.ts), the invocation layer (server.ts) and the CI/packaging script.
 *
 * Release: https://github.com/mudler/parakeet.cpp/releases
 */

export const PARAKEET_RELEASE_TAG = "v0.2.0";
const RELEASE_BASE = `https://github.com/mudler/parakeet.cpp/releases/download/${PARAKEET_RELEASE_TAG}`;

/** A compute backend, including the "pick the best one for me" sentinel. */
export type ParakeetBackend = "auto" | "cpu" | "vulkan" | "cuda" | "metal";

/** Concrete backends that map to a distinct release binary. */
export type ResolvedBackend = "cpu" | "vulkan" | "cuda" | "metal";

const VALID_BACKENDS: ReadonlySet<ParakeetBackend> = new Set([
  "auto",
  "cpu",
  "vulkan",
  "cuda",
  "metal",
]);

type PlatformKey = `${string}-${string}`; // `${process.platform}-${process.arch}`

/**
 * The default backend for each supported platform. GPU acceleration where it is
 * broadly available (Metal on Apple Silicon, Vulkan on x64 Win/Linux), CPU
 * everywhere else. darwin-x64 and linux-arm64 have no GPU release, so they
 * fall back to the CPU-only binary.
 */
const PLATFORM_DEFAULT_BACKEND: ReadonlyMap<PlatformKey, ResolvedBackend> =
  new Map<PlatformKey, ResolvedBackend>([
    ["darwin-arm64", "metal"],
    ["darwin-x64", "cpu"],
    ["linux-x64", "vulkan"],
    ["linux-arm64", "cpu"],
    ["win32-x64", "vulkan"],
  ]);

/** Backends a user may explicitly select on each platform. */
const PLATFORM_BACKENDS: ReadonlyMap<PlatformKey, ResolvedBackend[]> = new Map<
  PlatformKey,
  ResolvedBackend[]
>([
  ["darwin-arm64", ["metal", "cpu"]],
  ["darwin-x64", ["cpu"]],
  ["linux-x64", ["vulkan", "cuda", "cpu"]],
  ["linux-arm64", ["cpu"]],
  ["win32-x64", ["vulkan", "cuda", "cpu"]],
]);

function platformKey(): PlatformKey {
  return `${process.platform}-${process.arch}`;
}

/** The concrete backend a binary provides, for each platform. */
export function getPlatformDefaultBackend(): ResolvedBackend {
  return PLATFORM_DEFAULT_BACKEND.get(platformKey()) ?? "cpu";
}

/**
 * Backends exposed to the UI for the current platform, always led by `auto`.
 * Returns `["auto"]` on CPU-only platforms so the gear stays hidden there
 * (length === 1). On win-x64: `["auto", "vulkan", "cuda", "cpu"]`.
 */
export function getAvailableBackends(): ParakeetBackend[] {
  const concrete = PLATFORM_BACKENDS.get(platformKey());
  if (!concrete || concrete.length <= 1) return ["auto"];
  return ["auto", ...concrete];
}

/**
 * Resolves a stored preference to a concrete backend, validating it against
 * platform support. `auto` and unknown/unsupported values fall back to the
 * platform default.
 */
export function resolveBackend(
  preference: string | null | undefined,
): ResolvedBackend {
  if (!preference || !VALID_BACKENDS.has(preference as ParakeetBackend)) {
    return getPlatformDefaultBackend();
  }
  if (preference === "auto") {
    return getPlatformDefaultBackend();
  }
  const concrete = preference as ResolvedBackend;
  const supported = PLATFORM_BACKENDS.get(platformKey()) ?? [];
  return supported.includes(concrete) ? concrete : getPlatformDefaultBackend();
}

export interface ReleaseAsset {
  url: string;
  archiveName: string;
  /** CUDA builds on Windows/Linux need the cudart bundle too (if present). */
  cudartUrl?: string;
  cudartArchiveName?: string;
  /** Approximate download size in bytes, for UI hints. */
  approxBytes?: number;
}

interface BackendAssetSpec {
  path: string; // platform/os-specific path segment, e.g. "win-vulkan-x64"
  archiveExt: ".zip" | ".tar.gz";
  approxBytes?: number;
}

const APPROX_SIZES: Partial<Record<ResolvedBackend, number>> = {
  cpu: 1_000_000,
  metal: 1_000_000,
  vulkan: 18_000_000,
  cuda: 160_000_000,
};

/**
 * Release asset for a concrete backend on the current platform, or `null` if
 * the platform has no release for that backend.
 */
export function getReleaseAsset(backend: ResolvedBackend): ReleaseAsset | null {
  const platform = process.platform;
  const arch = process.arch;
  const v = PARAKEET_RELEASE_TAG;

  // Per-platform path templates. Each maps a backend → asset path segment.
  const specs: Record<
    PlatformKey,
    Partial<Record<ResolvedBackend, BackendAssetSpec>>
  > = {
    "darwin-arm64": {
      metal: { path: "macos-metal-arm64", archiveExt: ".tar.gz" },
      cpu: { path: "macos-cpu-arm64", archiveExt: ".tar.gz" }, // not published
    },
    "darwin-x64": {
      cpu: { path: "macos-cpu-x64", archiveExt: ".tar.gz" },
    },
    "linux-x64": {
      vulkan: { path: "linux-vulkan-x64", archiveExt: ".tar.gz" },
      cuda: { path: "linux-cuda-x64", archiveExt: ".tar.gz" },
      cpu: { path: "linux-cpu-x64", archiveExt: ".tar.gz" },
    },
    "linux-arm64": {
      cpu: { path: "linux-cpu-arm64", archiveExt: ".tar.gz" },
    },
    "win32-x64": {
      vulkan: { path: "win-vulkan-x64", archiveExt: ".zip" },
      cuda: { path: "win-cuda-x64", archiveExt: ".zip" },
      cpu: { path: "win-cpu-x64", archiveExt: ".zip" },
    },
  };

  const spec = specs[platformKey()]?.[backend];
  if (!spec) return null;

  const archiveName = `parakeet-${v}-bin-${spec.path}${spec.archiveExt}`;
  const asset: ReleaseAsset = {
    url: `${RELEASE_BASE}/${archiveName}`,
    archiveName: `parakeet-${backend}-${platform}-${arch}${spec.archiveExt}`,
    approxBytes: spec.approxBytes ?? APPROX_SIZES[backend],
  };

  // CUDA builds on Windows need the cudart DLL bundle; Linux bundles it inline.
  if (backend === "cuda" && platform === "win32" && arch === "x64") {
    const cudartName = `cudart-parakeet-bin-win-cuda-x64.zip`;
    asset.cudartUrl = `${RELEASE_BASE}/${cudartName}`;
    asset.cudartArchiveName = cudartName;
    if (asset.approxBytes) asset.approxBytes += 580_000_000;
  } else if (backend === "cuda" && platform === "linux" && arch === "x64") {
    if (asset.approxBytes) asset.approxBytes = 563_000_000;
  }

  return asset;
}

/**
 * `PARAKEET_DEVICE` value to set at runtime for a resolved backend.
 * Only `cpu` pins the device; GPU backends let parakeet auto-select.
 * See https://github.com/mudler/parakeet.cpp — "Use PARAKEET_DEVICE to override".
 */
export function getDeviceOverride(
  backend: ResolvedBackend,
): string | undefined {
  return backend === "cpu" ? "cpu" : undefined;
}

/** Backend label for display. */
export function backendLabel(backend: ParakeetBackend): string {
  switch (backend) {
    case "auto":
      return "Automatic";
    case "cpu":
      return "CPU";
    case "vulkan":
      return "Vulkan";
    case "cuda":
      return "CUDA";
    case "metal":
      return "Metal";
  }
}

/** Human-readable description for the backend picker UI. */
export function backendDescription(backend: ParakeetBackend): string {
  switch (backend) {
    case "auto":
      return "Best for your system. GPU acceleration when available, CPU otherwise.";
    case "cpu":
      return "Force CPU. Slowest but most compatible. No extra download.";
    case "vulkan":
      return "Use the Vulkan GPU backend (broad vendor support). ~18 MB download.";
    case "cuda":
      return "Use the NVIDIA CUDA backend. Best GPU perf, NVIDIA-only. ~160–580 MB download.";
    case "metal":
      return "Use the Apple Metal backend. Fastest on Apple Silicon.";
  }
}
