/**
 * Persistent HTTP sidecar lifecycle for the starling provider.
 *
 * Starling runs as a local HTTP/WebSocket server (`python -m
 * starling.granite.server`) that keeps the ASR model resident in VRAM. We
 * spawn and supervise that process here, then talk to it over HTTP for both
 * batch transcription and the streaming session's overlapping-window calls.
 *
 * Structure mirrors the MLX ASR worker lifecycle (`mlx-asr/server.ts`):
 * serialized start via `lifecyclePromise`, keep-alive idle unload, retention
 * policy, generation-agnostic stop. The transport differs (HTTP vs stdio
 * JSON), and starling serializes GPU work with a single worker that returns
 * HTTP 503 when busy, which we handle with short backoff.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createAppLogger } from "@freestyle/utils";
import { getStarlingModel } from "./constants.js";
import {
  getStarlingBaseUrl,
  getStarlingHost,
  getStarlingKeepAliveMinutes,
  getStarlingPartialIntervalMs,
  getStarlingPort,
  getStarlingPythonPath,
  getStarlingSegmentAdvanceMs,
  getStarlingSourcePath,
} from "./settings.js";

const log = createAppLogger("starling");

const START_TIMEOUT_MS = 180_000; // model load + CUDA-graph warmup is slow
const HEALTH_POLL_INTERVAL_MS = 1_000;
const TRANSCRIBE_TIMEOUT_MS = 300_000;
const BUSY_RETRY_MS = 150;
const BUSY_MAX_RETRIES = 40; // ~6s of "server busy" before giving up on a chunk

let serverProcess: ChildProcess | null = null;
let currentModelId: string | null = null;
let serverReady = false;
let serverFailed = false;
let startPromise: Promise<void> | null = null;
let unloadTimer: ReturnType<typeof setTimeout> | null = null;
let lifecyclePromise: Promise<void> = Promise.resolve();

export function isStarlingServerRunning(): boolean {
  return serverProcess !== null && serverReady;
}

export function isStarlingServerFailed(): boolean {
  return serverFailed;
}

export function getStarlingServerBaseUrl(): string {
  return getStarlingBaseUrl();
}

export function getStarlingPartialInterval(): number {
  return getStarlingPartialIntervalMs();
}

export function getStarlingSegmentAdvance(): number {
  return getStarlingSegmentAdvanceMs();
}

/**
 * Resolve the python executable for starling. Prefers the configured setting,
 * then env vars, then a PATH lookup of common names. Returns null if nothing
 * usable is found.
 */
export function findStarlingPython(): string | null {
  const configured = getStarlingPythonPath();
  const candidates = [
    configured,
    process.env.FREESTYLE_STARLING_PYTHON,
    process.env.PYTHON,
    "python",
    "python3",
  ];
  for (const c of candidates) {
    if (!c) continue;
    if (c.includes("/") || c.includes("\\")) {
      if (existsSync(c)) return c;
    } else {
      return c; // bare name — let spawn resolve via PATH
    }
  }
  return null;
}

/**
 * Human-readable reason starling can't run on this install, or null if it can.
 * Used by the status route to render a setup hint in the UI.
 */
export function describeStarlingSetupBlocker(): string | null {
  const python = findStarlingPython();
  if (!python) {
    return "Starling needs a Python executable. Set the Python path in Starling settings (a venv that has starling installed).";
  }
  const source = getStarlingSourcePath();
  if (source && !existsSync(source)) {
    return `Starling source path does not exist: ${source}`;
  }
  return null;
}

export function canRunStarling(): boolean {
  return describeStarlingSetupBlocker() === null;
}

export function startStarlingInBackground(modelId: string): void {
  if (getStarlingKeepAliveMinutes() === 0) return;
  if (serverProcess && currentModelId === modelId && serverReady) return;
  if (startPromise && currentModelId === modelId) return;

  serverFailed = false;
  ensureStarlingServerRunning(modelId)
    .then(() => {
      log.info("Server ready");
    })
    .catch((err: Error) => {
      log.error(`Background server start failed: ${err.message}`);
    });
}

export function applyStarlingRetentionPolicy(): void {
  if (!serverProcess) return;
  scheduleUnload();
}

export function ensureStarlingServerRunning(modelId: string): Promise<void> {
  const run = lifecyclePromise.then(() =>
    ensureStarlingServerRunningLocked(modelId),
  );
  lifecyclePromise = run.catch(() => undefined);
  return run;
}

async function ensureStarlingServerRunningLocked(
  modelId: string,
): Promise<void> {
  clearUnloadTimer();
  if (serverProcess && currentModelId === modelId && serverReady) return;
  if (startPromise && currentModelId === modelId) return startPromise;

  // If a different model is loaded (or none), stop and restart.
  await stopStarlingServer();
  serverFailed = false;
  currentModelId = modelId;

  const promise = startServer(modelId);
  startPromise = promise;
  try {
    await promise;
  } finally {
    if (startPromise === promise) startPromise = null;
  }
}

interface StarlingHealth {
  status?: string;
  model?: string;
  loaded?: boolean;
  busy?: boolean;
}

async function fetchHealth(
  baseUrl: string,
  signal?: AbortSignal,
): Promise<StarlingHealth | null> {
  try {
    const res = await fetch(`${baseUrl}/health`, { signal });
    if (!res.ok) return null;
    return (await res.json()) as StarlingHealth;
  } catch {
    return null;
  }
}

/**
 * Is an externally-started (or already-running) starling server reachable and
 * loaded? Used by the status/catalog path without forcing a spawn.
 */
export async function probeStarlingHealth(): Promise<StarlingHealth | null> {
  return fetchHealth(getStarlingBaseUrl());
}

async function startServer(modelId: string): Promise<void> {
  const def = getStarlingModel(modelId);
  if (!def) throw new Error(`Unknown Starling model: ${modelId}`);

  const python = findStarlingPython();
  if (!python) {
    throw new Error(
      describeStarlingSetupBlocker() ??
        "No Python executable configured for Starling.",
    );
  }

  const port = getStarlingPort();
  const host = getStarlingHost();
  const args = ["-m", def.serverModule, "--host", host, "--port", String(port)];
  if (def.modelArg) args.push("--model", def.modelArg);

  const source = getStarlingSourcePath();
  log.info(
    `starting ${python} ${args.join(" ")}${source ? ` (cwd ${source})` : ""}`,
  );

  const proc = spawn(python, args, {
    stdio: ["ignore", "pipe", "pipe"],
    cwd: source ?? undefined,
    env: { ...process.env, PYTHONUNBUFFERED: "1" },
  });
  serverProcess = proc;
  serverReady = false;

  proc.stdout?.on("data", (data: Buffer) => {
    const text = data.toString().trimEnd();
    if (text) log.debug(text);
  });
  proc.stderr?.on("data", (data: Buffer) => {
    const text = data.toString().trimEnd();
    if (text) log.warn(text);
  });
  proc.on("error", (err) => {
    if (serverProcess !== proc) return;
    failServer(new Error(`Failed to start starling: ${err.message}`));
  });
  proc.on("close", (code) => {
    if (serverProcess !== proc) return;
    failServer(new Error(`starling exited unexpectedly: exit code ${code}`));
  });

  // Poll /health until the model reports loaded. Starling accepts connections
  // quickly but isn't ready to transcribe until the weights + CUDA graphs are
  // built, which can take well over a minute on a cold start.
  const baseUrl = `http://${host}:${port}`;
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (!serverProcess || serverProcess !== proc) {
      // Process died during startup — error already surfaced via failServer.
      throw new Error(
        serverFailed
          ? "starling server process exited during startup"
          : "starling server start cancelled",
      );
    }
    const health = await fetchHealth(baseUrl).catch(() => null);
    if (health?.status === "ok" && health.loaded) {
      serverReady = true;
      serverFailed = false;
      log.info(`starling ready: model=${health.model ?? def.id}`);
      return;
    }
    await new Promise((r) => setTimeout(r, HEALTH_POLL_INTERVAL_MS));
  }

  await stopStarlingServer();
  throw new Error(
    `starling server did not become ready within ${START_TIMEOUT_MS / 1000}s`,
  );
}

/** POST a WAV body to /inference, returning the transcript text. */
async function postInference(
  body: ArrayBuffer,
  signal: AbortSignal,
): Promise<string> {
  const baseUrl = getStarlingBaseUrl();
  const res = await fetch(`${baseUrl}/inference`, {
    method: "POST",
    headers: { "Content-Type": "audio/wav" },
    body,
    signal,
  });

  if (res.status === 503) {
    // Single worker busy — callers retry via transcribePcmWithStarling's loop.
    throw new StarlingBusyError("starling server busy");
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(
      `starling /inference failed: ${res.status} ${res.statusText}${detail ? ` — ${detail}` : ""}`,
    );
  }
  const data = (await res.json()) as { text?: string };
  return (data.text ?? "").trim();
}

class StarlingBusyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StarlingBusyError";
  }
}

function isBusy(err: unknown): boolean {
  return err instanceof StarlingBusyError;
}

/**
 * Transcribe raw 16 kHz mono Int16 PCM by wrapping it in a WAV header and
 * POSTing to /inference. Retries on 503 (single-worker busy) with backoff.
 */
export async function transcribePcmWithStarling(opts: {
  modelId: string;
  pcm: Uint8Array;
  sampleRate: number;
  deferUnload?: boolean;
}): Promise<string> {
  await ensureStarlingServerRunning(opts.modelId);
  clearUnloadTimer();

  const wav = encodeWavFromInt16Pcm(opts.pcm, opts.sampleRate);
  const signal = AbortSignal.timeout(TRANSCRIBE_TIMEOUT_MS);

  let lastErr: unknown = null;
  for (let attempt = 0; attempt < BUSY_MAX_RETRIES; attempt++) {
    try {
      const text = await postInference(wav.buffer, signal);
      if (!opts.deferUnload) scheduleUnload();
      return text;
    } catch (err) {
      lastErr = err;
      if (signal.aborted) break;
      if (isBusy(err)) {
        await new Promise((r) => setTimeout(r, BUSY_RETRY_MS));
        continue;
      }
      break; // non-retryable
    }
  }
  if (!opts.deferUnload) scheduleUnload();
  throw lastErr instanceof Error
    ? lastErr
    : new Error("starling transcription failed");
}

/** Batch path: transcribe a complete WAV (Uint8Array) from the REST route. */
export async function transcribeWithStarling(opts: {
  modelId: string;
  audio: Uint8Array;
}): Promise<string> {
  return transcribePcmWithStarling({
    modelId: opts.modelId,
    // The REST route already delivers a WAV; hand it through unchanged.
    pcm: opts.audio,
    sampleRate: 16_000,
  });
}

function failServer(err: Error): void {
  clearUnloadTimer();
  log.error(err.message);
  serverProcess = null;
  currentModelId = null;
  serverReady = false;
  startPromise = null;
  serverFailed = true;
}

function clearUnloadTimer(): void {
  if (!unloadTimer) return;
  clearTimeout(unloadTimer);
  unloadTimer = null;
}

function scheduleUnload(): void {
  clearUnloadTimer();
  if (!serverProcess) return;
  const minutes = getStarlingKeepAliveMinutes();
  const delayMs = minutes * 60_000;

  if (delayMs <= 0) {
    void stopStarlingServer().catch((err: Error) =>
      log.error(`Failed to unload starling: ${err.message}`),
    );
    return;
  }

  unloadTimer = setTimeout(() => {
    void stopStarlingServer().catch((err: Error) =>
      log.error(`Failed to unload idle starling: ${err.message}`),
    );
  }, delayMs);
  unloadTimer.unref?.();
}

export async function stopStarlingServer(): Promise<void> {
  if (!serverProcess) return;
  clearUnloadTimer();

  const proc = serverProcess;
  serverProcess = null;
  currentModelId = null;
  serverReady = false;
  startPromise = null;
  serverFailed = false;

  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve();
    };
    const killTimeout = setTimeout(() => {
      try {
        proc.kill(process.platform === "win32" ? undefined : "SIGKILL");
      } catch {
        // ignore
      }
      finish();
    }, 5_000);
    proc.once("close", () => {
      clearTimeout(killTimeout);
      finish();
    });
    try {
      proc.kill(process.platform === "win32" ? undefined : "SIGTERM");
    } catch {
      clearTimeout(killTimeout);
      finish();
    }
  });
}

// ---------------------------------------------------------------------------
// Minimal WAV encoder for raw 16-bit PCM. Mirrors the renderer-side
// encodeWavFromInt16 in apps/electron/src/renderer/src/lib/wav.ts so the
// streaming session can feed starling's /inference endpoint directly.
// ---------------------------------------------------------------------------

function encodeWavFromInt16Pcm(
  pcm: Uint8Array,
  sampleRate: number,
): Uint8Array<ArrayBuffer> {
  const byteLength = pcm.byteLength;
  const buffer = new ArrayBuffer(44 + byteLength);
  const view = new DataView(buffer);

  const writeString = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  };

  writeString(0, "RIFF");
  view.setUint32(4, 36 + byteLength, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // PCM format
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeString(36, "data");
  view.setUint32(40, byteLength, true);
  new Uint8Array(buffer, 44).set(pcm);
  return new Uint8Array(buffer);
}
