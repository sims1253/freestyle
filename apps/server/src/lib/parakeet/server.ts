import { type ChildProcess, execFile } from "node:child_process";
import { createWriteStream, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { createAppLogger } from "@freestyle/utils";
import {
  findParakeetBinary,
  parakeetSpawnEnv,
  WIN_DLL_NOT_FOUND_EXIT,
  WIN_DLL_NOT_FOUND_MESSAGE,
} from "./binary.js";
import { getDownloadedModelPath } from "./models.js";

const log = createAppLogger("parakeet");
const execFileAsync = promisify(execFile);

// parakeet.cpp has no server binary. We invoke parakeet-cli transcribe
// directly per request. The model loads fresh each time, but inference
// is fast enough (110M-1.1B models on CPU/GPU) that this is acceptable
// for a desktop dictation app where requests are user-initiated.

export interface ParakeetTranscribeOptions {
  model: string;
  audio: Uint8Array;
  language?: string;
}

export interface ParakeetTranscribeResult {
  text: string;
}

export async function transcribeViaCli(
  opts: ParakeetTranscribeOptions,
): Promise<ParakeetTranscribeResult> {
  const binary = findParakeetBinary();
  if (!binary) {
    throw new Error("parakeet-cli binary not found");
  }

  const modelPath = getDownloadedModelPath(opts.model);
  if (!modelPath) {
    throw new Error(`Parakeet model "${opts.model}" not downloaded`);
  }

  // Write audio to a temp file (parakeet-cli reads from a path)
  const tempDir = mkdtempSync(join(tmpdir(), "parakeet-"));
  const audioPath = join(tempDir, "audio.wav");
  const videoStream = await import("node:fs").then(() => undefined);
  await new Promise<void>((resolve, reject) => {
    const ws = createWriteStream(audioPath);
    ws.on("finish", () => resolve());
    ws.on("error", reject);
    ws.write(Buffer.from(opts.audio));
    ws.end();
  });

  try {
    const args = [
      "transcribe",
      "--model",
      modelPath,
      "--input",
      audioPath,
      "--json",
    ];
    if (opts.language && opts.language !== "auto") {
      args.push("--lang", opts.language);
    }

    log.debug(`invoking parakeet-cli with model ${opts.model}`);

    const { stdout } = await execFileAsync(binary, args, {
      timeout: 120_000,
      maxBuffer: 10 * 1024 * 1024,
      ...parakeetSpawnEnv(binary),
    });

    const data = JSON.parse(stdout) as { text?: string };
    return { text: data.text?.trim() ?? "" };
  } catch (err: unknown) {
    const error = err as { code?: number; stderr?: string; message?: string };
    if (error.code === WIN_DLL_NOT_FOUND_EXIT) {
      throw new Error(`parakeet-cli failed: ${WIN_DLL_NOT_FOUND_MESSAGE}`);
    }
    const detail = error.stderr?.trim() || error.message || String(err);
    throw new Error(`parakeet-cli transcription failed: ${detail}`);
  } finally {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  }
}

// --- Server lifecycle stubs (for compatibility with existing routes) ---
// parakeet.cpp has no persistent server, so these are no-ops.

export function isServerRunning(): boolean {
  return false;
}

export function isServerFailed(): boolean {
  return false;
}

export function startInBackground(_modelId: string): void {
  // No-op: parakeet-cli is invoked per-request, no server to start.
  log.debug("startInBackground is a no-op (parakeet-cli invoked per-request)");
}

export async function ensureServerRunning(_modelId: string): Promise<void> {
  // No-op: parakeet-cli is invoked per-request.
}

export async function stopServer(): Promise<void> {
  // No-op: no persistent server process.
}

export function getServerPort(): number {
  return 0; // No HTTP server
}
