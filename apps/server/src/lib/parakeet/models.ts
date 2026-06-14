import { Buffer } from "node:buffer";
import { execFile as execFileCallback } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { createAppLogger } from "@freestyle/utils";
import { progressFetch } from "../hf/progress.js";
import {
  getReleaseAsset,
  type ParakeetBackend,
  type ReleaseAsset,
  type ResolvedBackend,
  resolveBackend,
} from "./backends.js";
import {
  getBinDir,
  getModelPath,
  getModelsDir,
  getParakeetModel,
  PARAKEET_MODELS,
  type ParakeetModelDef,
} from "./constants.js";

const log = createAppLogger("parakeet");
const execFile = promisify(execFileCallback);

export type DownloadStatus =
  | "not_downloaded"
  | "downloading"
  | "verifying"
  | "ready"
  | "error";

export type DownloadPhase = "building_binary" | "downloading_model";

export interface ModelDownloadState {
  model: string;
  fileName: string;
  sizeBytes: number;
  displayName: string;
  status: DownloadStatus;
  phase?: DownloadPhase;
  downloadProgress?: {
    bytesDownloaded: number;
    bytesTotal: number;
    percent: number;
    speedBps: number;
  };
  error?: string;
}

interface ActiveDownload {
  controller: AbortController;
  phase: DownloadPhase;
  bytesDownloaded: number;
  bytesTotal: number;
  speedBps: number;
  startedAt: number;
  lastUpdate: number;
  lastBytes: number;
  error?: string;
}

const activeDownloads = new Map<string, ActiveDownload>();

function ensureModelsDir(): void {
  const dir = getModelsDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function isModelDownloaded(model: ParakeetModelDef): boolean {
  const path = getModelPath(model);
  if (!existsSync(path)) return false;
  const stat = statSync(path);
  return stat.size >= model.sizeBytes * 0.95;
}

function baseModelState(
  modelId: string,
  model: ParakeetModelDef,
): Pick<
  ModelDownloadState,
  "model" | "fileName" | "sizeBytes" | "displayName"
> {
  return {
    model: modelId,
    fileName: model.fileName,
    sizeBytes: model.sizeBytes,
    displayName: model.displayName,
  };
}

export function getModelStatus(modelId: string): ModelDownloadState | null {
  const model = getParakeetModel(modelId);
  if (!model) return null;

  const active = activeDownloads.get(modelId);

  if (active?.error) {
    return {
      ...baseModelState(modelId, model),
      status: "error",
      error: active.error,
    };
  }

  if (active) {
    return {
      ...baseModelState(modelId, model),
      status: "downloading",
      phase: active.phase,
      downloadProgress: {
        bytesDownloaded: active.bytesDownloaded,
        bytesTotal: active.bytesTotal,
        percent:
          active.bytesTotal > 0
            ? Math.round((active.bytesDownloaded / active.bytesTotal) * 100)
            : 0,
        speedBps: active.speedBps,
      },
    };
  }

  if (isModelDownloaded(model)) {
    return { ...baseModelState(modelId, model), status: "ready" };
  }

  return { ...baseModelState(modelId, model), status: "not_downloaded" };
}

export function getCatalogModels(): ParakeetModelDef[] {
  return [...PARAKEET_MODELS];
}

export function getAllModelStatuses(): ModelDownloadState[] {
  return getCatalogModels().map((m) => getModelStatus(m.id)!);
}

export async function downloadModel(modelId: string): Promise<void> {
  const model = getParakeetModel(modelId);
  if (!model) throw new Error(`Unknown parakeet model: ${modelId}`);

  const existing = activeDownloads.get(modelId);
  if (existing && !existing.error) {
    throw new Error(`Model ${modelId} is already downloading`);
  }
  if (existing?.error) {
    activeDownloads.delete(modelId);
  }

  if (isModelDownloaded(model)) return;

  const { isServerBinaryAvailable } = await import("./binary.js");
  const needsBinary = !isServerBinaryAvailable();

  const controller = new AbortController();
  const active: ActiveDownload = {
    controller,
    phase: needsBinary ? "building_binary" : "downloading_model",
    bytesDownloaded: 0,
    bytesTotal: needsBinary ? 0 : model.sizeBytes,
    speedBps: 0,
    startedAt: Date.now(),
    lastUpdate: Date.now(),
    lastBytes: 0,
  };
  activeDownloads.set(modelId, active);

  if (needsBinary) {
    try {
      await ensureBinariesDownloaded();
    } catch (err) {
      active.error = err instanceof Error ? err.message : String(err);
      throw err;
    }

    active.phase = "downloading_model";
    active.bytesTotal = model.sizeBytes;
    active.bytesDownloaded = 0;
    active.speedBps = 0;
    active.lastUpdate = Date.now();
    active.lastBytes = 0;
  }

  ensureModelsDir();

  const destPath = getModelPath(model);
  const tempPath = `${destPath}.downloading`;

  try {
    const url = `https://huggingface.co/${model.hfRepo}/resolve/main/${model.fileName}`;
    const res = await progressFetch(active, controller.signal)(url);
    if (!res.ok || !res.body) {
      throw new Error(`Model download failed: HTTP ${res.status}`);
    }
    const total = Number(res.headers.get("content-length"));
    if (total > 0) active.bytesTotal = total;
    await pipeline(webBodyToReadable(res.body), createWriteStream(tempPath));
    renameSync(tempPath, destPath);
    activeDownloads.delete(modelId);
  } catch (err) {
    try {
      if (existsSync(tempPath)) unlinkSync(tempPath);
    } catch {}

    if (controller.signal.aborted) {
      activeDownloads.delete(modelId);
      return;
    }

    active.error = err instanceof Error ? err.message : String(err);
    throw err;
  }
}

export function cancelDownload(modelId: string): boolean {
  const active = activeDownloads.get(modelId);
  if (!active) return false;
  active.controller.abort();
  activeDownloads.delete(modelId);
  return true;
}

export function deleteModel(modelId: string): boolean {
  const model = getParakeetModel(modelId);
  if (!model) return false;

  cancelDownload(modelId);

  const path = getModelPath(model);
  try {
    if (existsSync(path)) {
      unlinkSync(path);
      return true;
    }
  } catch {}
  return false;
}

export function clearDownloadError(modelId: string): void {
  const active = activeDownloads.get(modelId);
  if (active?.error) {
    activeDownloads.delete(modelId);
  }
}

export function getDownloadedModelPath(modelId: string): string | null {
  const model = getParakeetModel(modelId);
  if (!model) return null;
  if (!isModelDownloaded(model)) return null;
  return getModelPath(model);
}

// ---------------------------------------------------------------------------
// Binary acquisition
// ---------------------------------------------------------------------------

let binaryDownloadPromise: Promise<void> | null = null;

export function isBinaryDownloading(): boolean {
  return binaryDownloadPromise !== null;
}

/** Marker file written next to the binary recording which backend it ships. */
const BACKEND_MARKER = ".installed-backend";

/**
 * Read the backend recorded for the currently installed binary, or `null` if
 * no marker exists (e.g. installed before backend tracking, or not installed).
 */
export function getInstalledBackend(): ResolvedBackend | null {
  const markerPath = join(getBinDir(), BACKEND_MARKER);
  try {
    const raw = readFileSync(markerPath, "utf8").trim() as ResolvedBackend;
    if (
      raw === "cpu" ||
      raw === "vulkan" ||
      raw === "cuda" ||
      raw === "metal"
    ) {
      return raw;
    }
  } catch {}
  return null;
}

function writeBackendMarker(binDir: string, backend: ResolvedBackend): void {
  try {
    writeFileSync(join(binDir, BACKEND_MARKER), backend, "utf8");
  } catch {}
}

/**
 * Ensure the binary for the requested backend is installed.
 *
 * `cpu` never triggers a download: CPU is compiled into every build, so when
 * the user picks CPU we simply set `PARAKEET_DEVICE=cpu` at invocation time
 * against whatever binary is present. If no binary is present at all, we fall
 * back to the platform default.
 *
 * For GPU backends, we skip the download when the marker already matches, and
 * re-download only when switching (e.g. vulkan → cuda).
 */
export async function ensureBinariesDownloaded(
  preference: ParakeetBackend = "auto",
): Promise<void> {
  const { isServerBinaryAvailable, resetBinaryCache } = await import(
    "./binary.js"
  );

  const resolved = resolveBackend(preference);
  const installed = getInstalledBackend();

  // Already have a binary for the exact requested backend — done.
  if (isServerBinaryAvailable() && installed === resolved) return;

  // CPU only requires a binary to exist; it works against any backend build.
  if (resolved === "cpu" && isServerBinaryAvailable()) return;

  if (binaryDownloadPromise) return binaryDownloadPromise;
  binaryDownloadPromise = downloadPrebuiltBinaries(resolved).finally(() => {
    binaryDownloadPromise = null;
    resetBinaryCache();
  });
  return binaryDownloadPromise;
}

async function downloadPrebuiltBinaries(
  backend: ResolvedBackend,
): Promise<void> {
  const binDir = getBinDir();
  if (!existsSync(binDir)) mkdirSync(binDir, { recursive: true });

  const asset = getReleaseAsset(backend);
  if (!asset) {
    throw new Error(
      `No pre-built parakeet.cpp binary for backend=${backend} on platform=${process.platform} arch=${process.arch}.`,
    );
  }

  try {
    await downloadAndExtract(asset, binDir);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to download parakeet.cpp (${backend}): ${msg}`);
  }

  // CUDA on Windows needs the cudart DLL bundle alongside the binary.
  if (asset.cudartUrl && asset.cudartArchiveName) {
    try {
      await downloadAndExtract(
        {
          url: asset.cudartUrl,
          archiveName: asset.cudartArchiveName,
        },
        binDir,
      );
    } catch (err) {
      log.warn(
        `parakeet CUDA runtime download failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  const { isServerBinaryAvailable, resetBinaryCache } = await import(
    "./binary.js"
  );
  resetBinaryCache();
  if (isServerBinaryAvailable()) {
    writeBackendMarker(binDir, backend);
    log.info(`parakeet.cpp ${backend} binaries installed`);
    return;
  }

  throw new Error(
    `parakeet-cli not found after extracting ${asset.archiveName}`,
  );
}

async function downloadAndExtract(
  asset: ReleaseAsset,
  binDir: string,
): Promise<void> {
  const archivePath = join(binDir, asset.archiveName);
  const extractDir = join(binDir, "parakeet-extract");

  log.info(`Downloading parakeet.cpp from ${asset.url}...`);
  const res = await fetch(asset.url, {
    redirect: "follow",
    signal: AbortSignal.timeout(600_000),
  });
  if (!res.ok || !res.body) {
    throw new Error(`HTTP ${res.status} for ${asset.url}`);
  }

  const totalSize = Number(res.headers.get("content-length") ?? 0);
  let downloaded = 0;
  const _progressStream = new Readable({
    read() {},
  });
  const fileStream = createWriteStream(archivePath);
  const reader = res.body.getReader();
  const downloadReadable = new Readable({
    async read() {
      try {
        const { done, value } = await reader.read();
        if (done) {
          this.push(null);
          return;
        }
        downloaded += value.byteLength;
        if (totalSize > 0) {
          log.debug(
            `parakeet binary download: ${Math.round((downloaded / totalSize) * 100)}%`,
          );
        }
        this.push(Buffer.from(value));
      } catch (err) {
        this.destroy(err instanceof Error ? err : new Error(String(err)));
      }
    },
  });
  await pipeline(downloadReadable, fileStream);

  if (existsSync(extractDir)) {
    rmSync(extractDir, { recursive: true, force: true });
  }
  mkdirSync(extractDir, { recursive: true });

  log.info(`Extracting ${asset.archiveName}...`);

  if (asset.archiveName.endsWith(".zip")) {
    // On Windows, use the built-in tar (bsdtar) which handles .zip
    await execFile(
      process.platform === "win32" ? "tar" : "tar",
      ["xf", archivePath, "-C", extractDir],
      { timeout: 120_000 },
    );
  } else {
    await execFile(
      "tar",
      ["xzf", archivePath, "-C", extractDir, "--strip-components=1"],
      { timeout: 120_000 },
    );
  }

  // Copy all binaries and shared libraries from the extraction directory
  const serverName =
    process.platform === "win32" ? "parakeet-server.exe" : "parakeet-server";
  const cliName =
    process.platform === "win32" ? "parakeet-cli.exe" : "parakeet-cli";

  // The archive may have files at root or under a subdirectory
  const files = collectFiles(extractDir);
  for (const file of files) {
    const baseName = file.split(/[\\/]/).pop()!;
    const destPath = join(binDir, baseName);
    try {
      copyFileSync(join(extractDir, ...file.split(/[\\/]/)), destPath);
      if (
        baseName === serverName ||
        baseName === cliName ||
        baseName.endsWith(".exe") ||
        baseName.endsWith(".dll") ||
        baseName.endsWith(".dylib") ||
        /\.so(\.\d+)*$/.test(baseName) ||
        baseName.endsWith(".metal")
      ) {
        if (process.platform !== "win32") {
          chmodSync(destPath, 0o755);
        }
      }
    } catch {}
  }

  // macOS: add rpath so binaries find bundled dylibs
  if (process.platform === "darwin") {
    for (const name of [cliName, serverName]) {
      const binPath = join(binDir, name);
      if (!existsSync(binPath)) continue;
      try {
        await execFile("install_name_tool", ["-add_rpath", binDir, binPath], {
          timeout: 10_000,
        });
      } catch {}
    }
  }

  // Cleanup
  try {
    unlinkSync(archivePath);
    rmSync(extractDir, { recursive: true, force: true });
  } catch {}
}

function collectFiles(dir: string): string[] {
  const results: string[] = [];
  function walk(d: string, prefix: string[]): void {
    for (const entry of readdirSync(d)) {
      const fullPath = join(d, entry);
      const stat = statSync(fullPath);
      if (stat.isDirectory()) {
        walk(fullPath, [...prefix, entry]);
      } else {
        results.push([...prefix, entry].join("/"));
      }
    }
  }
  walk(dir, []);
  return results;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function webBodyToReadable(body: ReadableStream<Uint8Array>): Readable {
  const reader = body.getReader();
  return new Readable({
    async read() {
      try {
        const { done, value } = await reader.read();
        if (done) {
          this.push(null);
          return;
        }
        this.push(Buffer.from(value));
      } catch (err) {
        this.destroy(err instanceof Error ? err : new Error(String(err)));
      }
    },
  });
}
