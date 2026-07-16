/** Runtime settings for the externally-installed Starling Python sidecar. */

import { getDb } from "../db.js";
import { STARLING_DEFAULT_HOST, STARLING_DEFAULT_PORT } from "./constants.js";

function readSetting(key: string): string | undefined {
  try {
    return (
      getDb().prepare("SELECT value FROM settings WHERE key = ?").get(key) as
        | { value?: string }
        | undefined
    )?.value;
  } catch {
    return undefined;
  }
}

export function getStarlingPythonPath(): string | undefined {
  return readSetting("starling_python_path")?.trim() || undefined;
}
export function getStarlingSourcePath(): string | undefined {
  return readSetting("starling_source_path")?.trim() || undefined;
}
export function getStarlingUseWsl(): boolean {
  return readSetting("starling_use_wsl") === "true";
}
export function getStarlingWslDistro(): string | undefined {
  return readSetting("starling_wsl_distro")?.trim() || undefined;
}
export function getStarlingHost(): string {
  return readSetting("starling_host")?.trim() || STARLING_DEFAULT_HOST;
}
export function getStarlingPort(): number {
  const n = Number(readSetting("starling_port"));
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : STARLING_DEFAULT_PORT;
}
export function getStarlingBaseUrl(): string {
  return `http://${getStarlingHost()}:${getStarlingPort()}`;
}
export function getStarlingKeepAliveMinutes(): number {
  const n = Number(readSetting("starling_keep_alive_minutes"));
  return Number.isFinite(n) ? Math.max(0, Math.min(60, Math.round(n))) : 10;
}
export function getStarlingProfile(): string {
  return readSetting("starling_profile")?.trim() || "realtime";
}
export function getStarlingPartialIntervalSeconds(): number {
  const n = Number(readSetting("starling_partial_interval_seconds"));
  return Number.isFinite(n) && n > 0 ? n : 1.5;
}
