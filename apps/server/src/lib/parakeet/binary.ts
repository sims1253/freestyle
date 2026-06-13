import { execFileSync } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { dirname, join } from "node:path";
import {
  getBinaryName,
  getBinDir,
  getResourcesDir,
  getServerBinaryName,
} from "./constants.js";

const EXEC_CHECK =
  process.platform === "win32" ? constants.F_OK : constants.X_OK;

function findInPath(name: string): string | null {
  try {
    const cmd = process.platform === "win32" ? "where" : "which";
    const result = execFileSync(cmd, [name], {
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 3000,
    });
    const path = result.toString().trim().split("\n")[0];
    if (path) return path;
  } catch {}
  return null;
}

function findExecutable(name: string | null): string | null {
  if (!name) return null;

  const localPath = join(getBinDir(), name);
  try {
    accessSync(localPath, EXEC_CHECK);
    return localPath;
  } catch {}

  const resourcesDir = getResourcesDir();
  const bundledPath = join(resourcesDir, name);
  try {
    accessSync(bundledPath, EXEC_CHECK);
    return bundledPath;
  } catch {}

  return findInPath(name);
}

let cachedBinary: string | null | undefined;
let cachedServer: string | null | undefined;

export function resetBinaryCache(): void {
  cachedBinary = undefined;
  cachedServer = undefined;
}

export function findParakeetBinary(): string | null {
  if (cachedBinary === undefined) {
    cachedBinary = findExecutable(getBinaryName());
  }
  return cachedBinary;
}

export function findParakeetServer(): string | null {
  // parakeet.cpp ships only parakeet-cli; reuse the same lookup.
  if (cachedServer === undefined) {
    cachedServer = findExecutable(getBinaryName());
  }
  return cachedServer;
}

export function isBinaryAvailable(): boolean {
  return findParakeetBinary() !== null;
}

export function isServerBinaryAvailable(): boolean {
  return isBinaryAvailable();
}

export const WIN_DLL_NOT_FOUND_EXIT = 3221225781;

export const WIN_DLL_NOT_FOUND_MESSAGE =
  "a required system library is missing. " +
  "Please install the Visual C++ Redistributable from " +
  "https://aka.ms/vs/17/release/vc_redist.x64.exe " +
  "and ensure CUDA runtime DLLs are present next to parakeet-cli.exe " +
  "(re-run the download script to fetch them).";

export function parakeetSpawnEnv(binaryPath: string): {
  cwd: string;
  env: NodeJS.ProcessEnv;
} {
  const binDir = dirname(binaryPath);
  return {
    cwd: binDir,
    env: {
      ...process.env,
      PATH: `${binDir}${process.platform === "win32" ? ";" : ":"}${process.env.PATH ?? ""}`,
    },
  };
}
