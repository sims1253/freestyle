/**
 * Supervisor for Starling's Python ASR sidecar. One process holds one model in
 * VRAM, so lifecycle work is serialized and a model change restarts the
 * process. The sidecar reports load phase and queue depth through /health;
 * batch overflow (503) is retried briefly because it means its GPU queue is
 * full, not that the model is unavailable.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createAppLogger } from "@freestyle-voice/utils";
import { getStarlingModel, STARLING_SERVER_MODULE } from "./constants.js";
import {
  getStarlingBaseUrl,
  getStarlingHost,
  getStarlingKeepAliveMinutes,
  getStarlingKeepLoaded,
  getStarlingPartialIntervalSeconds,
  getStarlingPort,
  getStarlingProfile,
  getStarlingPythonPath,
  getStarlingSourcePath,
  getStarlingUseWsl,
  getStarlingWslDistro,
} from "./settings.js";

const log = createAppLogger("starling");
const HTTP_START_TIMEOUT_MS = 45_000;
const MODEL_LOAD_TIMEOUT_MS = 30 * 60_000;
const TRANSCRIBE_TIMEOUT_MS = 300_000;
const LOAD_PING_INTERVAL_MS = 30_000;
const STDERR_RING_SIZE = 20;
const WSL_PORT_RELEASE_TIMEOUT_MS = 15_000;
const PORT_RELEASE_POLL_INTERVAL_MS = 250;
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
let processUsesWsl = false;
let processWslDistro: string | undefined;

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

export function findStarlingPython(): string | null {
  const configured = getStarlingPythonPath();
  if (getStarlingUseWsl())
    return (
      configured ??
      process.env.FREESTYLE_STARLING_PYTHON ??
      process.env.PYTHON ??
      null
    );
  for (const candidate of [
    configured,
    process.env.FREESTYLE_STARLING_PYTHON,
    process.env.PYTHON,
    "python",
    "python3",
    "py",
  ]) {
    if (!candidate) continue;
    if (!candidate.includes("/") && !candidate.includes("\\")) return candidate;
    if (existsSync(candidate)) return candidate;
  }
  return null;
}
export function describeStarlingSetupBlocker(): string | null {
  if (!findStarlingPython())
    return "Starling needs a Python executable. Set the Python path to an environment with starling installed.";
  const source = getStarlingSourcePath();
  return source && !getStarlingUseWsl() && !existsSync(source)
    ? `Starling source path does not exist: ${source}`
    : null;
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

async function isStarlingServerResponding(): Promise<boolean> {
  try {
    await fetch(`${getStarlingBaseUrl()}/health`, {
      signal: AbortSignal.timeout(2_000),
    });
    return true;
  } catch {
    return false;
  }
}

async function waitForStarlingPortRelease(): Promise<void> {
  const deadline = Date.now() + WSL_PORT_RELEASE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (!(await isStarlingServerResponding())) return;
    await new Promise((resolve) =>
      setTimeout(resolve, PORT_RELEASE_POLL_INTERVAL_MS),
    );
  }
  throw new Error(
    "Starling server did not release its port within 15 seconds.",
  );
}

async function stopWslStarlingProcesses(
  wslDistro: string | undefined,
): Promise<void> {
  try {
    const cleanup = spawn(
      "wsl.exe",
      [
        ...(wslDistro ? ["-d", wslDistro] : []),
        "-e",
        "pkill",
        "-f",
        "starling.server",
      ],
      { stdio: "ignore" },
    );
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(resolve, 5_000);
      cleanup.once("close", () => {
        clearTimeout(timeout);
        resolve();
      });
      cleanup.once("error", () => {
        clearTimeout(timeout);
        resolve();
      });
    });
  } catch {
    // Best effort: killing wsl.exe does not always end its Linux child.
  }
}

/**
 * `--no-eager-load` binds the HTTP server before model weights are ready, but
 * Starling only starts loading on a transcription request. A short silent WAV
 * is enough to trigger that lazy path without adding an audio dependency.
 */
function createSilentLoadWav(): ArrayBuffer {
  const sampleRate = 16_000;
  const sampleCount = Math.round(sampleRate * 0.3);
  const dataSize = sampleCount * 2;
  const wav = new ArrayBuffer(44 + dataSize);
  const view = new DataView(wav);
  writeWavString(view, 0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeWavString(view, 8, "WAVE");
  writeWavString(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeWavString(view, 36, "data");
  view.setUint32(40, dataSize, true);
  return wav;
}

function writeWavString(view: DataView, offset: number, value: string): void {
  for (let index = 0; index < value.length; index++) {
    view.setUint8(offset + index, value.charCodeAt(index));
  }
}

async function triggerModelLoad(): Promise<void> {
  try {
    const response = await fetch(`${getStarlingBaseUrl()}/transcribe`, {
      method: "POST",
      headers: { "Content-Type": "audio/wav" },
      body: createSilentLoadWav(),
    });
    if (!response.ok) {
      log.debug(`Starling load ping returned HTTP ${response.status}.`);
    }
  } catch (error) {
    // A first-download request can time out at Starling's own deadline. Health
    // polling remains authoritative and will schedule a later retry if needed.
    log.debug(`Starling load ping ended: ${String(error)}`);
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

  // An already-bound server may have been started outside Freestyle (notably
  // inside WSL). WSL mode declares that Freestyle manages this lifecycle, so
  // it may take over a mismatched external server before starting the request.
  const health = await fetchHealth(getStarlingBaseUrl());
  if (health?.status === "ok") {
    if (health.model === model.slug) {
      const ownsProcess = processHandle !== null;
      external = !ownsProcess;
      if (!ownsProcess) {
        processUsesWsl = false;
        processWslDistro = undefined;
      }
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
      if (!getStarlingUseWsl()) {
        throw new Error(
          `Starling server is already running model "${health.model ?? "unknown"}", but Freestyle requested "${model.slug}". Stop or reconfigure the external server before switching models, or enable Run via WSL in Starling settings to let Freestyle manage and restart it automatically.`,
        );
      }
      log.info(
        `Taking over external Starling server running model "${health.model ?? "unknown"}" to switch to "${model.slug}".`,
      );
      await stopWslStarlingProcesses(getStarlingWslDistro());
      await waitForStarlingPortRelease();
      external = false;
    }
  }
  // An external process may have stopped since its last successful health
  // check. It is now safe to clear our adoption state and spawn a replacement.
  if (external) external = false;
  await stopUnlocked();
  const python = findStarlingPython();
  if (!python)
    throw new Error(
      describeStarlingSetupBlocker() ??
        "No Python executable configured for Starling.",
    );
  failed = false;
  startError = null;
  currentModelId = modelId;
  const serverArgs = [
    "-m",
    STARLING_SERVER_MODULE,
    "--model",
    model.slug,
    "--host",
    getStarlingHost(),
    "--port",
    String(getStarlingPort()),
    "--profile",
    getStarlingProfile(),
    "--partial-interval-seconds",
    String(getStarlingPartialIntervalSeconds()),
    // Bind HTTP before the model/weights finish loading. This keeps status and
    // streaming clients responsive while transformers downloads a first-use
    // model, rather than making a healthy long load look like a dead process.
    "--no-eager-load",
    // After lazy loading, capture the runtime warmup work before the user's
    // first dictation rather than making that request pay the cold-start cost.
    "--warmup",
  ];
  const useWsl = getStarlingUseWsl();
  const sourcePath = getStarlingSourcePath();
  const wslDistro = getStarlingWslDistro();
  const args = useWsl
    ? [
        ...(wslDistro ? ["-d", wslDistro] : []),
        ...(sourcePath ? ["--cd", sourcePath] : []),
        "-e",
        python,
        ...serverArgs,
      ]
    : serverArgs;
  const child = spawn(useWsl ? "wsl.exe" : python, args, {
    ...(useWsl ? {} : { cwd: sourcePath }),
    env: { ...process.env, PYTHONUNBUFFERED: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  processHandle = child;
  processUsesWsl = useWsl;
  processWslDistro = useWsl ? wslDistro : undefined;
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
      fail(child, `Starling exited (code ${code ?? "unknown"}).`);
  });
  let httpAvailable = false;
  let loadPing: Promise<void> | null = null;
  let lastLoadPingAt = 0;
  const httpDeadline = Date.now() + HTTP_START_TIMEOUT_MS;
  const modelLoadDeadline = Date.now() + MODEL_LOAD_TIMEOUT_MS;
  while (Date.now() < (httpAvailable ? modelLoadDeadline : httpDeadline)) {
    if (processHandle !== child)
      throw new Error(startError ?? "Starling server stopped during startup.");
    const health = await fetchHealth(getStarlingBaseUrl());
    if (health) {
      httpAvailable = true;
      phase = health.phase ?? phase;
      queueDepth = health.queueDepth ?? queueDepth;
      if (
        !health.loaded &&
        !loadPing &&
        Date.now() - lastLoadPingAt >= LOAD_PING_INTERVAL_MS
      ) {
        lastLoadPingAt = Date.now();
        loadPing = triggerModelLoad().finally(() => {
          loadPing = null;
        });
      }
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
      ? "Starling model did not finish loading within 30 minutes."
      : "Starling server did not expose HTTP within 45 seconds.",
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
  processUsesWsl = false;
  processWslDistro = undefined;
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
  const usesWsl = processUsesWsl;
  const wslDistro = processWslDistro;
  processHandle = null;
  processUsesWsl = false;
  processWslDistro = undefined;
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
  if (usesWsl) {
    await stopWslStarlingProcesses(wslDistro);
    await waitForStarlingPortRelease();
  }
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
