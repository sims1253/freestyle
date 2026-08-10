/**
 * Native binary + GGUF model file management for Starling.
 *
 * The starling-serve binary is downloaded once from GitHub releases. GGUF model
 * files are downloaded on demand from HuggingFace. Both are stored in a
 * well-known directory and tracked by this module.
 */

import { execFile } from "node:child_process";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  renameSync,
} from "node:fs";
import { homedir, platform } from "node:os";
import { join, resolve } from "node:path";
import { createAppLogger } from "@freestyle-voice/utils";
import {
  getStarlingModel,
  ggufFilename,
  ggufRepoId,
  STARLING_MIN_ABI_VERSION,
  STARLING_MODELS,
  STARLING_SERVE_REPO,
  STARLING_SERVE_VERSION,
} from "./constants.js";
import { getStarlingGgufDir } from "./settings.js";

const log = createAppLogger("starling-downloads");

// ---- paths ----------------------------------------------------------------

/** Root directory for all starling-serve artifacts. */
export function getStarlingDataDir(): string {
  const base = process.env.FREESTYLE_STARLING_DATA_DIR;
  if (base) return resolve(base);
  return join(homedir(), ".freestyle", "starling-serve");
}

export function getBinaryDir(): string {
  return join(getStarlingDataDir(), "bin");
}

export function getDefaultBinaryPath(): string {
  const name =
    platform() === "win32" ? "starling-serve.exe" : "starling-serve";
  return join(getBinaryDir(), name);
}

export function getGgufDir(): string {
  return getStarlingGgufDir() ?? join(getStarlingDataDir(), "models");
}

export function getGgufPath(modelId: string): string | null {
  const model = getStarlingModel(modelId);
  if (!model) return null;
  // Check both quant levels; prefer the configured one but fall back to
  // whichever exists on disk.
  const dir = getGgufDir();
  const quants = ["q8_0", "bf16-exact"] as const;
  for (const q of quants) {
    const path = join(dir, ggufFilename(model.slug, q));
    if (existsSync(path)) return path;
  }
  return null;
}

// ---- download state tracking ----------------------------------------------

export interface StarlingModelDownloadState {
  downloaded: boolean;
  downloading: boolean;
  progress: number;
  error: string | null;
}

export interface StarlingBinaryState {
  downloaded: boolean;
  downloading: boolean;
  progress: number;
  error: string | null;
  version: string | null;
}

let binaryState: StarlingBinaryState = {
  downloaded: false,
  downloading: false,
  progress: 0,
  error: null,
  version: null,
};

let activeGgufModelId: string | null = null;
const ggufStates = new Map<string, StarlingModelDownloadState>();

function ggufStateFor(modelId: string): StarlingModelDownloadState {
  const existing = ggufStates.get(modelId);
  if (existing) return existing;
  const state: StarlingModelDownloadState = {
    downloaded: false,
    downloading: false,
    progress: 0,
    error: null,
  };
  ggufStates.set(modelId, state);
  return state;
}

// ---- binary discovery + version check ------------------------------------

/**
 * Check if the binary exists at the default path and verify its ABI version.
 */
async function checkBinary(): Promise<void> {
  const path = getDefaultBinaryPath();
  if (!existsSync(path)) {
    binaryState.downloaded = false;
    binaryState.version = null;
    return;
  }
  try {
    const version = await getBinaryVersion(path);
    binaryState.downloaded = true;
    binaryState.version = version.version;
    if (version.abiVersion < STARLING_MIN_ABI_VERSION) {
      binaryState.error = `Binary ABI version ${version.abiVersion} is too old (need >= ${STARLING_MIN_ABI_VERSION}). Please update.`;
    }
  } catch (error) {
    binaryState.downloaded = true;
    binaryState.version = null;
    binaryState.error = `Could not verify binary: ${error instanceof Error ? error.message : String(error)}`;
  }
}

async function getBinaryVersion(
  path: string,
): Promise<{ version: string; abiVersion: number }> {
  return new Promise((resolve, reject) => {
    execFile(path, ["--version"], { timeout: 5_000 }, (err, stdout) => {
      if (err) return reject(err);
      const lines = stdout.trim().split("\n");
      const version = (lines[0] ?? "").replace("starling-serve ", "").trim();
      const abiLine = lines.find((l) => l.startsWith("abi-version:"));
      const abiVersion = Number(abiLine?.split(":")[1]?.trim() ?? 0);
      resolve({ version, abiVersion });
    });
  });
}

export async function getStarlingBinaryState(): Promise<StarlingBinaryState> {
  if (!binaryState.downloaded && !binaryState.downloading) {
    await checkBinary();
  }
  return { ...binaryState };
}

// ---- binary download ------------------------------------------------------

/** Determine the correct asset name for this platform. */
function binaryAssetName(): string {
  const p = platform();
  if (p === "win32") return "starling-serve-windows-vulkan.exe";
  if (p === "darwin") return "starling-serve-macos-metal";
  return "starling-serve-linux-vulkan";
}

export async function startBinaryDownload(): Promise<void> {
  if (binaryState.downloading) return;
  binaryState.downloading = true;
  binaryState.progress = 0;
  binaryState.error = null;

  try {
    const asset = binaryAssetName();
    const url = `https://github.com/${STARLING_SERVE_REPO}/releases/download/${STARLING_SERVE_VERSION}/${asset}`;
    const destDir = getBinaryDir();
    mkdirSync(destDir, { recursive: true });
    const tmpPath = join(destDir, `${asset}.tmp`);
    const finalPath = getDefaultBinaryPath();

    await downloadWithProgress(url, tmpPath, (pct) => {
      binaryState.progress = pct;
    });

    // Move to final name and chmod +x on Unix.
    renameSync(tmpPath, finalPath);
    if (platform() !== "win32") {
      const { chmodSync } = await import("node:fs");
      chmodSync(finalPath, 0o755);
    }

    await checkBinary();
    binaryState.progress = 100;
  } catch (error) {
    binaryState.error = error instanceof Error ? error.message : String(error);
    log.error(`Binary download failed: ${binaryState.error}`);
  } finally {
    binaryState.downloading = false;
  }
}

// ---- GGUF model downloads -------------------------------------------------

function ensureGgufDir(): void {
  mkdirSync(getGgufDir(), { recursive: true });
}

export async function getStarlingModelDownloadStates(): Promise<
  Record<string, StarlingModelDownloadState>
> {
  const result: Record<string, StarlingModelDownloadState> = {};
  for (const model of STARLING_MODELS) {
    const state = ggufStateFor(model.id);
    const gguf = getGgufPath(model.id);
    state.downloaded = gguf !== null;
    result[model.id] = { ...state };
  }
  return result;
}

export function startStarlingModelDownload(
  modelId: string,
): { ok: true } | { ok: false; error: string; status: 400 | 409 } {
  const model = getStarlingModel(modelId);
  if (!model)
    return { ok: false, error: "Unknown Starling model.", status: 400 };
  if (activeGgufModelId) {
    return {
      ok: false,
      error: "Another Starling model download is in progress.",
      status: 409,
    };
  }
  const state = ggufStateFor(modelId);
  if (state.downloading) return { ok: true };

  const quant = "q8_0"; // Default quantization
  const filename = ggufFilename(model.slug, quant);
  const repo = ggufRepoId(model);
  const url = `https://huggingface.co/${repo}/resolve/main/${filename}`;
  const destDir = getGgufDir();
  ensureGgufDir();
  const tmpPath = join(destDir, `${filename}.tmp`);
  const finalPath = join(destDir, filename);

  activeGgufModelId = modelId;
  state.downloading = true;
  state.progress = 0;
  state.error = null;

  downloadWithProgress(url, tmpPath, (pct) => {
    state.progress = pct;
  })
    .then(() => {
      renameSync(tmpPath, finalPath);
      state.progress = 100;
      state.downloaded = true;
      state.downloading = false;
      if (activeGgufModelId === modelId) activeGgufModelId = null;
      log.info(`Downloaded GGUF for ${model.id}`);
    })
    .catch((error) => {
      state.downloading = false;
      state.error = error instanceof Error ? error.message : String(error);
      if (activeGgufModelId === modelId) activeGgufModelId = null;
      log.error(`GGUF download failed for ${model.id}: ${state.error}`);
    });

  return { ok: true };
}

// ---- shared download helper ----------------------------------------------

function downloadWithProgress(
  url: string,
  destPath: string,
  onProgress: (pct: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const file = createWriteStream(destPath);
    let received = 0;
    let total = 0;
    let lastPct = 0;

    const req = fetch(url);
    req
      .then((response) => {
        if (!response.ok) {
          reject(new Error(`HTTP ${response.status}: ${response.statusText}`));
          return;
        }
        total = Number(response.headers.get("content-length") ?? 0);
        if (!response.body) {
          reject(new Error("No response body"));
          return;
        }
        const reader = response.body.getReader();
        const pump = (): Promise<void> =>
          reader.read().then(({ done, value }) => {
            if (done) {
              file.close();
              onProgress(100);
              resolve();
              return;
            }
            received += value.byteLength;
            if (total > 0) {
              const pct = Math.min(100, Math.round((received / total) * 100));
              if (pct > lastPct) {
                lastPct = pct;
                onProgress(pct);
              }
            }
            file.write(value);
            return pump();
          });
        pump().catch((error) => {
          file.close();
          reject(error);
        });
      })
      .catch((error) => {
        file.close();
        reject(error);
      });
  });
}
