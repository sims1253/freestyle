/**
 * Explicit Hugging Face cache management for Starling. The sidecar retains its
 * own lazy-download behaviour; this is an optional, observable prefetch so a
 * user can prepare a model before recording.
 */

import { spawn } from "node:child_process";
import { createAppLogger } from "@freestyle-voice/utils";
import { getStarlingModel, STARLING_MODELS } from "./constants.js";
import { findStarlingPython } from "./server.js";
import {
  getStarlingSourcePath,
  getStarlingUseWsl,
  getStarlingWslDistro,
} from "./settings.js";

const log = createAppLogger("starling-downloads");

export interface StarlingModelDownloadState {
  downloaded: boolean;
  downloading: boolean;
  progress: number;
  error: string | null;
}

let downloadedCache: Record<string, boolean> | null = null;
let cacheRefresh: Promise<Record<string, boolean>> | null = null;
let activeModelId: string | null = null;
const states = new Map<string, StarlingModelDownloadState>();

function stateFor(modelId: string): StarlingModelDownloadState {
  const state = states.get(modelId);
  if (state) return state;
  const next = {
    downloaded: downloadedCache?.[modelId] ?? false,
    downloading: false,
    progress: 0,
    error: null,
  };
  states.set(modelId, next);
  return next;
}

function spawnPython(args: string[]) {
  const python = findStarlingPython();
  if (!python) throw new Error("No Python executable configured for Starling.");
  const useWsl = getStarlingUseWsl();
  const sourcePath = getStarlingSourcePath();
  const distro = getStarlingWslDistro();
  return spawn(
    useWsl ? "wsl.exe" : python,
    useWsl
      ? [
          ...(distro ? ["-d", distro] : []),
          ...(sourcePath ? ["--cd", sourcePath] : []),
          "-e",
          python,
          ...args,
        ]
      : args,
    {
      ...(useWsl ? {} : { cwd: sourcePath }),
      env: { ...process.env, PYTHONUNBUFFERED: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
}

async function runCacheCheck(): Promise<Record<string, boolean>> {
  const repos = Object.fromEntries(
    STARLING_MODELS.map((model) => [model.id, model.hfRepoId]),
  );
  const script = [
    "import json",
    "from huggingface_hub import snapshot_download",
    `repos = json.loads(${JSON.stringify(JSON.stringify(repos))})`,
    "result = {}",
    "for model_id, repo_id in repos.items():",
    "    try:",
    "        snapshot_download(repo_id, local_files_only=True)",
    "        result[model_id] = True",
    "    except Exception:",
    "        result[model_id] = False",
    "print(json.dumps(result))",
  ].join("\n");
  const child = spawnPython(["-c", script]);
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (data: Buffer) => (stdout += data.toString()));
  child.stderr?.on("data", (data: Buffer) => (stderr += data.toString()));
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  if (code !== 0)
    throw new Error(stderr.trim() || "Could not inspect model cache.");
  const line = stdout.trim().split(/\r?\n/).at(-1);
  if (!line) throw new Error("Model cache check returned no result.");
  return JSON.parse(line) as Record<string, boolean>;
}

async function refreshDownloadedCache(): Promise<Record<string, boolean>> {
  if (cacheRefresh) return cacheRefresh;
  cacheRefresh = runCacheCheck()
    .then((result) => {
      downloadedCache = result;
      for (const model of STARLING_MODELS) {
        stateFor(model.id).downloaded = result[model.id] === true;
      }
      return result;
    })
    .finally(() => {
      cacheRefresh = null;
    });
  return cacheRefresh;
}

export async function getStarlingModelDownloadStates(): Promise<
  Record<string, StarlingModelDownloadState>
> {
  if (!downloadedCache) {
    try {
      await refreshDownloadedCache();
    } catch (error) {
      log.warn(`Could not inspect Starling model cache: ${String(error)}`);
    }
  }
  return Object.fromEntries(
    STARLING_MODELS.map((model) => [model.id, { ...stateFor(model.id) }]),
  );
}

export function startStarlingModelDownload(
  modelId: string,
): { ok: true } | { ok: false; error: string; status: 400 | 409 } {
  const model = getStarlingModel(modelId);
  if (!model)
    return { ok: false, error: "Unknown Starling model.", status: 400 };
  if (activeModelId) {
    return {
      ok: false,
      error: "Another Starling model download is in progress.",
      status: 409,
    };
  }
  const state = stateFor(modelId);
  if (state.downloading) return { ok: true };

  let child: ReturnType<typeof spawnPython>;
  try {
    child = spawnPython([
      "-c",
      `from huggingface_hub import snapshot_download\nsnapshot_download(${JSON.stringify(model.hfRepoId)})`,
    ]);
  } catch (error) {
    state.error = error instanceof Error ? error.message : String(error);
    return { ok: false, error: state.error, status: 400 };
  }

  activeModelId = modelId;
  state.downloading = true;
  state.progress = 0;
  state.error = null;
  let stderr = "";
  child.stderr?.on("data", (data: Buffer) => {
    const output = data.toString();
    stderr += output;
    // huggingface_hub emits tqdm updates to stderr. A chunk can contain
    // several redraws, so retain the final NN%| match as the current progress.
    const matches = [...output.matchAll(/(\d{1,3})%\|/g)];
    const last = matches.at(-1)?.[1];
    if (last) state.progress = Math.min(100, Number(last));
  });
  child.once("error", (error) =>
    finishDownload(modelId, state, false, error.message),
  );
  child.once("close", (code) => {
    if (code === 0) {
      state.progress = 100;
      finishDownload(modelId, state, true);
      void refreshDownloadedCache().catch((error) =>
        log.warn(`Could not refresh Starling model cache: ${String(error)}`),
      );
    } else {
      finishDownload(
        modelId,
        state,
        false,
        stderr.trim().split(/\r?\n/).filter(Boolean).at(-1) ??
          `Download exited with code ${code}.`,
      );
    }
  });
  return { ok: true };
}

function finishDownload(
  modelId: string,
  state: StarlingModelDownloadState,
  downloaded: boolean,
  error: string | null = null,
): void {
  if (activeModelId !== modelId) return;
  activeModelId = null;
  state.downloading = false;
  state.downloaded = downloaded;
  state.error = error;
  if (downloadedCache) downloadedCache[modelId] = downloaded;
}
