import { Buffer } from "node:buffer";
import { execFile as execFileCallback } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { createAppLogger } from "@freestyle/utils";
import { progressFetch } from "../hf/progress.js";
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

export async function ensureBinariesDownloaded(): Promise<void> {
  const { isServerBinaryAvailable, resetBinaryCache } = await import(
    "./binary.js"
  );
  if (isServerBinaryAvailable()) return;

  if (binaryDownloadPromise) return binaryDownloadPromise;
  binaryDownloadPromise = downloadPrebuiltBinaries().finally(() => {
    binaryDownloadPromise = null;
    resetBinaryCache();
  });
  return binaryDownloadPromise;
}

const PARAKEET_RELEASE_TAG = "v0.2.0";
const PARAKEET_RELEASE_BASE = `https://github.com/mudler/parakeet.cpp/releases/download/${PARAKEET_RELEASE_TAG}`;

interface ReleaseAsset {
  url: string;
  archiveName: string;
}

function getReleaseAssetCandidates(): ReleaseAsset[] {
  const platform = process.platform;
  const arch = process.arch;
  const candidates: ReleaseAsset[] = [];

  if (platform === "win32" && arch === "x64") {
    // Try CUDA first (includes cudart), then Vulkan, then plain CPU
    candidates.push(
      {
        url: `${PARAKEET_RELEASE_BASE}/parakeet-${PARAKEET_RELEASE_TAG}-bin-win-cuda-x64.zip`,
        archiveName: `parakeet-win-cuda-x64.zip`,
      },
      {
        url: `${PARAKEET_RELEASE_BASE}/parakeet-${PARAKEET_RELEASE_TAG}-bin-win-vulkan-x64.zip`,
        archiveName: `parakeet-win-vulkan-x64.zip`,
      },
      {
        url: `${PARAKEET_RELEASE_BASE}/parakeet-${PARAKEET_RELEASE_TAG}-bin-win-cpu-x64.zip`,
        archiveName: `parakeet-win-cpu-x64.zip`,
      },
    );
  } else if (platform === "darwin" && arch === "arm64") {
    candidates.push({
      url: `${PARAKEET_RELEASE_BASE}/parakeet-${PARAKEET_RELEASE_TAG}-bin-macos-metal-arm64.tar.gz`,
      archiveName: `parakeet-macos-metal-arm64.tar.gz`,
    });
  } else if (platform === "darwin" && arch === "x64") {
    candidates.push({
      url: `${PARAKEET_RELEASE_BASE}/parakeet-${PARAKEET_RELEASE_TAG}-bin-macos-cpu-x64.tar.gz`,
      archiveName: `parakeet-macos-cpu-x64.tar.gz`,
    });
  } else if (platform === "linux" && arch === "x64") {
    candidates.push(
      {
        url: `${PARAKEET_RELEASE_BASE}/parakeet-${PARAKEET_RELEASE_TAG}-bin-linux-cuda-x64.tar.gz`,
        archiveName: `parakeet-linux-cuda-x64.tar.gz`,
      },
      {
        url: `${PARAKEET_RELEASE_BASE}/parakeet-${PARAKEET_RELEASE_TAG}-bin-linux-vulkan-x64.tar.gz`,
        archiveName: `parakeet-linux-vulkan-x64.tar.gz`,
      },
      {
        url: `${PARAKEET_RELEASE_BASE}/parakeet-${PARAKEET_RELEASE_TAG}-bin-linux-cpu-x64.tar.gz`,
        archiveName: `parakeet-linux-cpu-x64.tar.gz`,
      },
    );
  } else if (platform === "linux" && arch === "arm64") {
    candidates.push({
      url: `${PARAKEET_RELEASE_BASE}/parakeet-${PARAKEET_RELEASE_TAG}-bin-linux-cpu-arm64.tar.gz`,
      archiveName: `parakeet-linux-cpu-arm64.tar.gz`,
    });
  }

  return candidates;
}

async function downloadPrebuiltBinaries(): Promise<void> {
  const binDir = getBinDir();
  if (!existsSync(binDir)) mkdirSync(binDir, { recursive: true });

  const candidates = getReleaseAssetCandidates();
  if (candidates.length === 0) {
    throw new Error(
      `No pre-built parakeet.cpp binaries for platform=${process.platform} arch=${process.arch}. Building from source is required.`,
    );
  }

  let lastError: Error | null = null;
  for (const candidate of candidates) {
    try {
      await downloadAndExtract(candidate, binDir);
      const { isServerBinaryAvailable, resetBinaryCache } = await import(
        "./binary.js"
      );
      resetBinaryCache();
      if (isServerBinaryAvailable()) {
        log.info(
          `parakeet.cpp binaries installed from ${candidate.archiveName}`,
        );
        return;
      }
      log.warn(
        `Downloaded ${candidate.archiveName} but parakeet-server not found, trying next candidate`,
      );
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      log.warn(
        `Failed to download ${candidate.archiveName}: ${lastError.message}, trying next candidate`,
      );
    }
  }

  throw new Error(
    `Failed to download parakeet.cpp binaries from any source.${
      lastError ? ` Last error: ${lastError.message}` : ""
    }`,
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
  const progressStream = new Readable({
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
