import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { createAppLogger } from "@freestyle/utils";
import { getDb } from "./db.js";

const log = createAppLogger("audio-backup");

const SAMPLE_RATE = 16000;
const NUM_CHANNELS = 1;
const BITS_PER_SAMPLE = 16;
const WAV_HEADER_SIZE = 44;
const DEFAULT_RETENTION_DAYS = 7;

export function getAudioBackupDir(): string {
  const dbPath = process.env.FREESTYLE_DB_PATH;
  if (!dbPath) throw new Error("FREESTYLE_DB_PATH not set");
  const dir = join(dirname(dbPath), "audio-backups");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function writeWavHeader(fd: number, dataSize: number): void {
  const header = Buffer.alloc(WAV_HEADER_SIZE);
  const byteRate = SAMPLE_RATE * NUM_CHANNELS * (BITS_PER_SAMPLE / 8);
  const blockAlign = NUM_CHANNELS * (BITS_PER_SAMPLE / 8);

  header.write("RIFF", 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16); // PCM subchunk size
  header.writeUInt16LE(1, 20); // PCM format
  header.writeUInt16LE(NUM_CHANNELS, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(BITS_PER_SAMPLE, 34);
  header.write("data", 36);
  header.writeUInt32LE(dataSize, 40);

  writeSync(fd, header, 0, WAV_HEADER_SIZE, 0);
}

export class AudioWriter {
  private fd: number;
  private dataBytes = 0;
  private aborted = false;
  readonly tempPath: string;

  constructor() {
    const dir = getAudioBackupDir();
    this.tempPath = join(dir, `tmp-${randomUUID()}.wav`);
    this.fd = openSync(this.tempPath, "w");
    // Write placeholder header — will be patched on finalize
    writeWavHeader(this.fd, 0);
  }

  write(chunk: ArrayBuffer): void {
    if (this.aborted) return;
    const buf = Buffer.from(chunk);
    writeSync(this.fd, buf, 0, buf.length);
    this.dataBytes += buf.length;
  }

  finalize(rowId: number | bigint): string {
    if (this.aborted) return this.tempPath;
    // Patch WAV header with actual data size
    writeWavHeader(this.fd, this.dataBytes);
    closeSync(this.fd);

    const dir = getAudioBackupDir();
    const finalPath = join(dir, `${Number(rowId)}.wav`);
    renameSync(this.tempPath, finalPath);
    return finalPath;
  }

  abort(): void {
    if (this.aborted) return;
    this.aborted = true;
    try {
      closeSync(this.fd);
    } catch {}
    try {
      unlinkSync(this.tempPath);
    } catch {}
  }
}

export function deleteAudioFile(filePath: string): void {
  try {
    if (existsSync(filePath)) unlinkSync(filePath);
  } catch (err) {
    log.error(`Failed to delete audio file ${filePath}: ${err}`);
  }
}

export function cleanupOldAudioFiles(): number {
  const db = getDb();
  let retentionDays = DEFAULT_RETENTION_DAYS;
  try {
    const row = db
      .prepare("SELECT value FROM settings WHERE key = 'audio_retention_days'")
      .get() as { value: string } | undefined;
    if (row) {
      const parsed = Number.parseInt(row.value, 10);
      if (parsed >= 0) retentionDays = parsed;
    }
  } catch {}

  const rows = db
    .prepare(
      `SELECT id, audio_file_path FROM transcription_history
       WHERE audio_file_path IS NOT NULL
         AND datetime(created_at) < datetime('now', '-' || ? || ' days')`,
    )
    .all(retentionDays) as Array<{ id: number; audio_file_path: string }>;

  if (rows.length === 0) return 0;

  for (const row of rows) {
    deleteAudioFile(row.audio_file_path);
  }

  db.prepare(
    `UPDATE transcription_history SET audio_file_path = NULL
     WHERE audio_file_path IS NOT NULL
       AND datetime(created_at) < datetime('now', '-' || ? || ' days')`,
  ).run(retentionDays);

  // Also clean up any orphaned temp files
  try {
    const dir = getAudioBackupDir();
    for (const entry of readdirSync(dir)) {
      if (entry.startsWith("tmp-")) {
        try {
          unlinkSync(join(dir, entry));
        } catch {}
      }
    }
  } catch {}

  log.info(
    `Cleaned up ${rows.length} audio backups older than ${retentionDays} days`,
  );
  return rows.length;
}
