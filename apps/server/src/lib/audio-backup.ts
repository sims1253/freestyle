import {
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { getDb, readSetting } from "./db.js";

const DEFAULT_RETENTION_DAYS = 7;

function getBackupDir(): string {
  const dbPath = process.env.FREESTYLE_DB_PATH;
  if (!dbPath)
    throw new Error("FREESTYLE_DB_PATH is required for audio backups.");
  const directory = join(dirname(dbPath), "audio-backups");
  if (!existsSync(directory)) mkdirSync(directory, { recursive: true });
  return directory;
}

export function saveAudioBackup(historyId: number, wav: Uint8Array): string {
  const path = join(getBackupDir(), `${historyId}.wav`);
  writeFileSync(path, wav);
  getDb()
    .prepare(
      "UPDATE transcription_history SET audio_file_path = ? WHERE id = ?",
    )
    .run(path, historyId);
  return path;
}

/** Wrap stream PCM16 mono frames in a WAV container before saving. */
export function savePcm16AudioBackup(
  historyId: number,
  chunks: ArrayBuffer[],
): string | null {
  const bytes = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  if (!bytes) return null;
  const wav = new Uint8Array(44 + bytes);
  const view = new DataView(wav.buffer);
  const write = (offset: number, text: string): void => {
    for (let index = 0; index < text.length; index++)
      view.setUint8(offset + index, text.charCodeAt(index));
  };
  write(0, "RIFF");
  view.setUint32(4, 36 + bytes, true);
  write(8, "WAVE");
  write(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 16_000, true);
  view.setUint32(28, 32_000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  write(36, "data");
  view.setUint32(40, bytes, true);
  let offset = 44;
  for (const chunk of chunks) {
    wav.set(new Uint8Array(chunk), offset);
    offset += chunk.byteLength;
  }
  return saveAudioBackup(historyId, wav);
}

export function deleteAudioBackup(path: string): void {
  try {
    rmSync(path, { force: true });
  } catch {}
}

export function cleanupOldAudioBackups(): number {
  const days = Math.max(
    0,
    Number(readSetting("audio_backup_retention_days")) ||
      DEFAULT_RETENTION_DAYS,
  );
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT id, audio_file_path FROM transcription_history
       WHERE audio_file_path IS NOT NULL
       AND created_at < datetime('now', ?)`,
    )
    .all(`-${days} days`) as { id: number; audio_file_path: string }[];
  for (const row of rows) deleteAudioBackup(row.audio_file_path);
  if (rows.length) {
    db.prepare(
      `UPDATE transcription_history SET audio_file_path = NULL
       WHERE audio_file_path IS NOT NULL AND created_at < datetime('now', ?)`,
    ).run(`-${days} days`);
  }
  try {
    for (const file of readdirSync(getBackupDir())) {
      if (file.startsWith("tmp-"))
        rmSync(join(getBackupDir(), file), { force: true });
    }
  } catch {}
  return rows.length;
}
