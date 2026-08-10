/**
 * Supervisor for the native starling-serve binary. One process holds one model
 * in VRAM, so lifecycle work is serialized and a model change restarts the
 * process. The binary reports load phase and queue depth through /health;
 * batch overflow (503) is retried briefly because it means its GPU queue is
 * full, not that the model is unavailable.
 *
 * This replaces the former Python sidecar supervisor. The HTTP/WebSocket API
 * contract is identical, so the streaming provider and batch transcribe path
 * work unchanged.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createAppLogger } from "@freestyle-voice/utils";
import { getStarlingModel } from "./constants.js";
import {
  getStarlingBaseUrl,
  getStarlingBinaryPath,
  getStarlingHost,
  getStarlingKeepAliveMinutes,
  getStarlingKeepLoaded,
  getStarlingPartialIntervalSeconds,
  getStarlingPort,
} from "./settings.js";
import { getGgufPath } from "./downloads.js";

const log = createAppLogger("starling");
const HTTP_START_TIMEOUT_MS = 45_000;
const MODEL_LOAD_TIMEOUT_MS = 30 * 60_000;
const TRANSCRIBE_TIMEOUT_MS = 300_000;
const STDERR_RING_SIZE = 20;
let processHandle: ChildProcess | null = null;
let currentModelId: string | null = null;
let ready = false;
let failed = false;
let startError: string | null = null;
let phase: string | null = null;
let queueDepth: number | null = null;
let runningModelSlug: string | null = null;
let lifecycle: Promise<void> = Promise.resolve();
let unloadTimer: ReturnType<typeof setTimeout> | null = null;
let recentStderr: string[] = [];
let external = false;

export interface StarlingHealth {
  status?: string;
  model?: string;
  loaded?: boolean;
  busy?: boolean;
  phase?: string;
  queueDepth?: number;
}
export interface StarlingTranscribeResult {
  text: string;
  segments?: Array<{ text: string; startSecond: number; endSecond: number }>;
  durationInSeconds?: number;
  requestId?: string;
}

export function describeStarlingSetupBlocker(): string | null {
  const binary = getStarlingBinaryPath();
  if (!binary || !existsSync(binary)) {
    return "Starling binary not found. Download it from the Models page or set the binary path in Starling settings.";
  }
  const model = currentModelId ? getStarlingModel(currentModelId) : null;
  if (model) {
    const gguf = getGgufPath(model.id);
    if (!gguf || !existsSync(gguf)) {
      return `Starling GGUF file not found for model "${model.displayName}". Download it from the Models page.`;
    }
  }
  return null;
}
export function canRunStarling(): boolean {
  return describeStarlingSetupBlocker() === null;
}

export function isStarlingServerRunning(): boolean {
  return (processHandle !== null || external) && ready;
}
export function isStarlingServerExternal(): boolean {
  return external;
}
export function isStarlingServerFailed(): boolean {
  return failed;
}
export function getStarlingStartError(): string | null {
  return startError;
}
export function getStarlingPhase(): string | null {
  return phase;
}
export function getStarlingQueueDepth(): number | null {
  return queueDepth;
}
export function getStarlingRunningModelSlug(): string | null {
  return runningModelSlug;
}
export function getStarlingServerBaseUrl(): string {
  return getStarlingBaseUrl();
}
export function getStarlingPartialInterval(): number {
  return getStarlingPartialIntervalSeconds();
}

export async function probeStarlingHealth(): Promise<StarlingHealth | null> {
  return fetchHealth(getStarlingBaseUrl());
}
async function fetchHealth(url: string): Promise<StarlingHealth | null> {
  try {
    const response = await fetch(`${url}/health`, {
      signal: AbortSignal.timeout(2_000),
    });
    if (!response.ok) return null;
    const data = (await response.json()) as Record<string, unknown>;
    return {
      status: typeof data.status === "string" ? data.status : undefined,
      model: typeof data.model === "string" ? data.model : undefined,
      loaded: typeof data.loaded === "boolean" ? data.loaded : undefined,
      busy: typeof data.busy === "boolean" ? data.busy : undefined,
      phase: typeof data.phase === "string" ? data.phase : undefined,
      queueDepth:
        typeof data.queue_depth === "number" ? data.queue_depth : undefined,
    };
  } catch {
    return null;
  }
}

export function ensureStarlingServerRunning(modelId: string): Promise<void> {
  const run = lifecycle.then(() => ensureLocked(modelId));
  lifecycle = run.catch(() => undefined);
  return run;
}

async function ensureLocked(modelId: string): Promise<void> {
  clearUnloadTimer();
  if (ready && currentModelId === modelId && !external) return;
  const model = getStarlingModel(modelId);
  if (!model) throw new Error(`Unknown Starling model: ${modelId}`);

  // Adopt an already-running server if it's serving the right model.
  const health = await fetchHealth(getStarlingBaseUrl());
  if (health?.status === "ok") {
    if (health.model === model.slug) {
      const ownsProcess = processHandle !== null;
      external = !ownsProcess;
      ready = true;
      failed = false;
      startError = null;
      currentModelId = modelId;
      runningModelSlug = health.model;
      phase = health.phase ?? "ready";
      queueDepth = health.queueDepth ?? null;
      return;
    }
    if (!processHandle) {
      throw new Error(
        `Starling server is already running model "${health.model ?? "unknown"}", but Freestyle requested "${model.slug}". Stop the external server before switching models.`,
      );
    }
  }

  await stopUnlocked();

  const binary = getStarlingBinaryPath();
  if (!binary || !existsSync(binary)) {
    throw new Error(
      "Starling binary not found. Download it from the Models page or set the binary path in Starling settings.",
    );
  }

  const gguf = getGgufPath(model.id);
  if (!gguf || !existsSync(gguf)) {
    throw new Error(
      `Starling GGUF file not found for model "${model.displayName}". Download it from the Models page.`,
    );
  }

  failed = false;
  startError = null;
  currentModelId = modelId;

  const args = [
    "--model",
    model.slug,
    "--gguf",
    gguf,
    "--host",
    getStarlingHost(),
    "--port",
    String(getStarlingPort()),
    "--partial-interval-seconds",
    String(getStarlingPartialIntervalSeconds()),
    // Bind HTTP before the model/weights finish loading.
    "--no-eager-load",
    // Warm up after lazy loading.
    "--warmup",
  ];

  const child = spawn(binary, args, {
    env: { ...process.env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  processHandle = child;
  external = false;
  ready = false;
  recentStderr = [];

  child.stdout?.on("data", (data: Buffer) =>
    log.debug(data.toString().trimEnd()),
  );
  child.stderr?.on("data", (data: Buffer) => {
    const output = data.toString().trimEnd();
    if (!output) return;
    log.warn(output);
    for (const line of output.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed) recentStderr.push(trimmed);
    }
    if (recentStderr.length > STDERR_RING_SIZE) {
      recentStderr = recentStderr.slice(-STDERR_RING_SIZE);
    }
  });
  child.on("error", (error) => fail(child, error.message));
  child.on("close", (code) => {
    if (processHandle === child)
      fail(child, `starling-serve exited (code ${code ?? "unknown"}).`);
  });

  // Poll health until ready.
  const httpDeadline = Date.now() + HTTP_START_TIMEOUT_MS;
  const modelLoadDeadline = Date.now() + MODEL_LOAD_TIMEOUT_MS;
  let httpAvailable = false;
  while (Date.now() < (httpAvailable ? modelLoadDeadline : httpDeadline)) {
    if (processHandle !== child)
      throw new Error(startError ?? "starling-serve stopped during startup.");
    const health = await fetchHealth(getStarlingBaseUrl());
    if (health) {
      httpAvailable = true;
      phase = health.phase ?? phase;
      queueDepth = health.queueDepth ?? queueDepth;
    }
    if (health?.status === "ok" && health.loaded) {
      ready = true;
      runningModelSlug = health.model ?? model.slug;
      phase = health.phase ?? "ready";
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  await stopUnlocked();
  throw new Error(
    httpAvailable
      ? "starling-serve model did not finish loading within 30 minutes."
      : "starling-serve did not expose HTTP within 45 seconds.",
  );
}

function fail(child: ChildProcess, message: string): void {
  if (processHandle !== child) return;
  const stderr = recentStderr.at(-1);
  const failureMessage =
    stderr && !message.includes(stderr) ? `${message} ${stderr}` : message;
  log.error(failureMessage);
  processHandle = null;
  ready = false;
  failed = true;
  startError = failureMessage;
  currentModelId = null;
  runningModelSlug = null;
  phase = null;
  queueDepth = null;
  recentStderr = [];
}

export function startStarlingInBackground(modelId: string): void {
  void ensureStarlingServerRunning(modelId).catch((error: Error) =>
    log.error(error.message),
  );
}

export function applyStarlingRetentionPolicy(): void {
  scheduleUnload();
}

function clearUnloadTimer(): void {
  if (unloadTimer) clearTimeout(unloadTimer);
  unloadTimer = null;
}

function scheduleUnload(): void {
  clearUnloadTimer();
  if (getStarlingKeepLoaded()) return;
  if (external) return;
  if (!processHandle) return;
  const delay = getStarlingKeepAliveMinutes() * 60_000;
  if (!delay) {
    void stopStarlingServer();
    return;
  }
  unloadTimer = setTimeout(() => void stopStarlingServer(), delay);
  unloadTimer.unref?.();
}

export function stopStarlingServer(): Promise<void> {
  const run = lifecycle.then(stopUnlocked);
  lifecycle = run.catch(() => undefined);
  return run;
}

async function stopUnlocked(): Promise<void> {
  clearUnloadTimer();
  if (external) return;
  const child = processHandle;
  processHandle = null;
  ready = false;
  failed = false;
  startError = null;
  currentModelId = null;
  runningModelSlug = null;
  phase = null;
  queueDepth = null;
  if (!child) return;
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(resolve, 5_000);
    child.once("close", () => {
      clearTimeout(timeout);
      resolve();
    });
    try {
      child.kill();
    } catch {
      clearTimeout(timeout);
      resolve();
    }
  });
}

export async function transcribeWithStarling(opts: {
  modelId: string;
  audio: Uint8Array;
  requestId?: string;
}): Promise<StarlingTranscribeResult> {
  await ensureStarlingServerRunning(opts.modelId);
  clearUnloadTimer();
  try {
    let lastError: unknown;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const response = await fetch(`${getStarlingBaseUrl()}/transcribe`, {
          method: "POST",
          headers: {
            "Content-Type": "audio/wav",
            ...(opts.requestId ? { "X-Request-Id": opts.requestId } : {}),
          },
          body: Buffer.from(opts.audio),
          signal: AbortSignal.timeout(TRANSCRIBE_TIMEOUT_MS),
        });
        if (response.status === 503) {
          lastError = new Error("Starling server queue is full.");
          await new Promise((resolve) => setTimeout(resolve, 200));
          continue;
        }
        if (!response.ok)
          throw new Error(
            `Starling transcription failed: HTTP ${response.status} ${await response.text()}`,
          );
        const data = (await response.json()) as {
          text?: string;
          segments?: Array<{ text?: string; start_s?: number; end_s?: number }>;
          duration_s?: number;
          request_id?: string;
        };
        return {
          text: data.text ?? "",
          segments: data.segments?.map((segment) => ({
            text: segment.text ?? "",
            startSecond: segment.start_s ?? 0,
            endSecond: segment.end_s ?? 0,
          })),
          durationInSeconds: data.duration_s,
          requestId: data.request_id ?? opts.requestId,
        };
      } catch (error) {
        lastError = error;
        break;
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error("Starling transcription failed.");
  } finally {
    scheduleUnload();
  }
}

export async function abortInference(requestId: string): Promise<void> {
  try {
    await fetch(
      `${getStarlingBaseUrl()}/inference/${encodeURIComponent(requestId)}`,
      { method: "DELETE", signal: AbortSignal.timeout(5_000) },
    );
  } catch {}
}
