/** Runtime settings for the native starling-serve binary. */

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

/** Path to the starling-serve binary (auto-managed if unset). */
export function getStarlingBinaryPath(): string | undefined {
  return readSetting("starling_binary_path")?.trim() || undefined;
}

/** Directory where GGUF model files are stored. */
export function getStarlingGgufDir(): string | undefined {
  return readSetting("starling_gguf_dir")?.trim() || undefined;
}

/** Preferred quantization level. */
export function getStarlingQuant(): "q8_0" | "bf16-exact" {
  const v = readSetting("starling_quant")?.trim();
  return v === "bf16-exact" ? "bf16-exact" : "q8_0";
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
/** Dedicated GPUs benefit from retaining the already-warmed model in VRAM. */
export function getStarlingKeepLoaded(): boolean {
  return readSetting("starling_keep_loaded") !== "false";
}
export function getStarlingPartialIntervalSeconds(): number {
  const n = Number(readSetting("starling_partial_interval_seconds"));
  return Number.isFinite(n) && n > 0 ? n : 1.5;
}
