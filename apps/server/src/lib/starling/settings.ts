/**
 * Settings readers for the starling provider.
 *
 * Starling is configured entirely through the generic `settings` key/value
 * table (read with raw SQL, the same pattern parakeet uses for
 * `parakeet_compute_backend`). Keys:
 *
 *   starling_python_path      — python executable that can run starling
 *   starling_source_path      — checkout/source dir (empty = installed pkg)
 *   starling_host             — bind/host (default 127.0.0.1)
 *   starling_port             — HTTP port (default 8181)
 *   starling_keep_alive_minutes — idle unload delay (default 10, max 10)
 *   starling_partial_interval_ms — partial timer for the streaming session
 *   starling_segment_advance_ms  — live-window length before a chunk commits
 */

import { getDb } from "../db.js";
import { STARLING_DEFAULT_HOST, STARLING_DEFAULT_PORT } from "./constants.js";

function readSetting(key: string): string | undefined {
  try {
    const row = getDb()
      .prepare("SELECT value FROM settings WHERE key = ?")
      .get(key) as { value: string } | undefined;
    return row?.value;
  } catch {
    // DB may be unavailable early in boot.
    return undefined;
  }
}

/** Python executable path, or undefined to fall back to PATH lookup. */
export function getStarlingPythonPath(): string | undefined {
  const value = readSetting("starling_python_path");
  return value?.trim() ? value.trim() : undefined;
}

/** Starling source/checkout directory (cwd for the server), or undefined. */
export function getStarlingSourcePath(): string | undefined {
  const value = readSetting("starling_source_path");
  return value?.trim() ? value.trim() : undefined;
}

export function getStarlingHost(): string {
  return readSetting("starling_host") ?? STARLING_DEFAULT_HOST;
}

export function getStarlingPort(): number {
  const raw = readSetting("starling_port");
  const parsed = raw ? Number(raw) : NaN;
  return Number.isInteger(parsed) && parsed > 0 && parsed < 65536
    ? parsed
    : STARLING_DEFAULT_PORT;
}

export function getStarlingBaseUrl(): string {
  return `http://${getStarlingHost()}:${getStarlingPort()}`;
}

const DEFAULT_KEEP_ALIVE_MINUTES = 10;
const MAX_KEEP_ALIVE_MINUTES = 10;

export function getStarlingKeepAliveMinutes(): number {
  const raw = readSetting("starling_keep_alive_minutes");
  const parsed = raw ? Number(raw) : NaN;
  if (!Number.isFinite(parsed)) return DEFAULT_KEEP_ALIVE_MINUTES;
  return Math.min(Math.max(Math.round(parsed), 0), MAX_KEEP_ALIVE_MINUTES);
}

const DEFAULT_PARTIAL_INTERVAL_MS = 1_500;
const DEFAULT_SEGMENT_ADVANCE_MS = 10_000;

/** How often the streaming session re-transcribes the live window. */
export function getStarlingPartialIntervalMs(): number {
  const raw = readSetting("starling_partial_interval_ms");
  const parsed = raw ? Number(raw) : NaN;
  if (!Number.isFinite(parsed) || parsed < 300)
    return DEFAULT_PARTIAL_INTERVAL_MS;
  return Math.round(parsed);
}

/**
 * Live-window length before a chunk is committed to `accumulated`. Keeping the
 * live window from growing unbounded is what bounds per-partial inference cost
 * regardless of total recording length.
 */
export function getStarlingSegmentAdvanceMs(): number {
  const raw = readSetting("starling_segment_advance_ms");
  const parsed = raw ? Number(raw) : NaN;
  if (!Number.isFinite(parsed) || parsed < 1000)
    return DEFAULT_SEGMENT_ADVANCE_MS;
  return Math.round(parsed);
}
