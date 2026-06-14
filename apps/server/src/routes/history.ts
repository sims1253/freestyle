import { readFileSync } from "node:fs";
import { createAppLogger } from "@freestyle/utils";
import { Hono } from "hono";
import { deleteAudioFile, getAudioBackupDir } from "../lib/audio-backup.js";
import { getDb } from "../lib/db.js";
import { sanitizeTranscriptText } from "../lib/editor/model-hints.js";
import { getLanguageSetting } from "../lib/language.js";
import { postProcess } from "../lib/post-process.js";
import { capture } from "../lib/posthog.js";
import { getDefaultModels } from "../lib/providers.js";
import { getProvider } from "../lib/streaming/registry.js";
import { getApiKeyForProvider } from "../lib/streaming-stt.js";
import { resolveAsrVocabularyBias } from "../lib/vocabulary-bias.js";

const log = createAppLogger("history");

interface HistoryRow {
  id: number;
  raw_text: string;
  cleaned_text: string | null;
  voice_provider: string;
  voice_model: string;
  llm_provider: string | null;
  llm_model: string | null;
  duration_ms: number;
  audio_duration_ms: number;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  created_at: string;
  audio_file_path: string | null;
}

const ALLOWED_ORDER_COLUMNS = new Set([
  "created_at",
  "duration_ms",
  "cost_usd",
]);

const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

const history = new Hono()
  .get("/", (c) => {
    const db = getDb();
    const limit = Math.min(Number(c.req.query("limit") || 50), 200);
    const offset = Number(c.req.query("offset") || 0);
    const search = c.req.query("search")?.trim() || "";
    const start_date_param = c.req.query("start_date");
    const end_date_param = c.req.query("end_date");
    const start_date =
      start_date_param && DATE_REGEX.test(start_date_param)
        ? start_date_param
        : null;
    const end_date =
      end_date_param && DATE_REGEX.test(end_date_param) ? end_date_param : null;
    const orderByParam = c.req.query("orderBy") || "-created_at";

    // Parse orderBy: "-created_at" means DESC, "created_at" means ASC
    const desc = orderByParam.startsWith("-");
    const column = desc ? orderByParam.slice(1) : orderByParam;
    const orderColumn = ALLOWED_ORDER_COLUMNS.has(column)
      ? column
      : "created_at";
    const orderDir = desc ? "DESC" : "ASC";

    // Dynamically build WHERE conditions
    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (search) {
      const pattern = `%${search}%`;
      conditions.push(
        "(raw_text LIKE ? OR cleaned_text LIKE ? OR voice_model LIKE ?)",
      );
      params.push(pattern, pattern, pattern);
    }

    if (start_date) {
      conditions.push("date(created_at,'localtime') >= ? ");
      params.push(start_date);
    }

    if (end_date) {
      conditions.push("date(created_at,'localtime') <= ? ");
      params.push(end_date);
    }

    const whereClause =
      conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    // Query rows
    const rowsQuery = `SELECT * FROM transcription_history ${whereClause} ORDER BY ${orderColumn} ${orderDir} LIMIT ? OFFSET ?`;
    const rows = db
      .prepare(rowsQuery)
      .all(...params, limit, offset) as unknown as HistoryRow[];

    // Query total count
    const countQuery = `SELECT COUNT(*) as count FROM transcription_history ${whereClause}`;
    const countRow = db.prepare(countQuery).get(...params) as { count: number };

    return c.json({
      items: rows,
      total: countRow.count,
      limit,
      offset,
    });
  })
  .get("/stats", (c) => {
    const db = getDb();

    const startDateParam = c.req.query("start_date");
    const endDateParam = c.req.query("end_date");
    const startDate =
      startDateParam && DATE_REGEX.test(startDateParam) ? startDateParam : null;
    const endDate =
      endDateParam && DATE_REGEX.test(endDateParam) ? endDateParam : null;

    const conditions: string[] = [];
    const params: string[] = [];

    if (startDate) {
      conditions.push("date(created_at, 'localtime') >= ?");
      params.push(startDate);
    }
    if (endDate) {
      conditions.push("date(created_at, 'localtime') <= ?");
      params.push(endDate);
    }

    const whereClause =
      conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const statsQuery = `
        SELECT
          COUNT(*) as total_sessions,
          COALESCE(SUM(duration_ms), 0) as total_duration_ms,
          COALESCE(SUM(input_tokens), 0) as total_input_tokens,
          COALESCE(SUM(output_tokens), 0) as total_output_tokens,
          COALESCE(SUM(cost_usd), 0) as total_cost_usd,
          COALESCE(AVG(duration_ms), 0) as avg_duration_ms,
          COALESCE(SUM(
            CASE
              WHEN length(trim(COALESCE(cleaned_text, raw_text))) = 0 THEN 0
              ELSE length(trim(COALESCE(cleaned_text, raw_text)))
                - length(replace(trim(COALESCE(cleaned_text, raw_text)), ' ', ''))
                + 1
            END
          ), 0) as total_words
        FROM transcription_history
        ${whereClause}
        `;

    const stats = db.prepare(statsQuery).get(...params) as {
      total_sessions: number;
      total_duration_ms: number;
      total_input_tokens: number;
      total_output_tokens: number;
      total_cost_usd: number;
      avg_duration_ms: number;
      total_words: number;
    };

    const unfilteredCount = db
      .prepare("SELECT COUNT(*) as count FROM transcription_history")
      .get() as { count: number };

    // Use localtime to match the user's timezone for "today" boundary
    const today = db
      .prepare(
        `SELECT COUNT(*) as sessions, COALESCE(SUM(cost_usd), 0) as cost
         FROM transcription_history
         WHERE date(created_at, 'localtime') = date('now', 'localtime')`,
      )
      .get() as { sessions: number; cost: number };

    return c.json({
      ...stats,
      today_sessions: today.sessions,
      today_cost: today.cost,
      unfiltered_total_sessions: unfilteredCount.count,
    });
  })
  .get("/audio-backup-dir", (c) => {
    try {
      return c.json({ path: getAudioBackupDir() });
    } catch {
      return c.json({ path: null });
    }
  })
  .get("/:id", (c) => {
    const db = getDb();
    const id = Number(c.req.param("id"));
    const row = db
      .prepare("SELECT * FROM transcription_history WHERE id = ?")
      .get(id) as HistoryRow | undefined;

    if (!row) return c.json({ error: "Not found" }, 404);
    return c.json(row);
  })
  .delete("/:id", (c) => {
    const db = getDb();
    const id = Number(c.req.param("id"));
    const row = db
      .prepare("SELECT audio_file_path FROM transcription_history WHERE id = ?")
      .get(id) as { audio_file_path: string | null } | undefined;
    if (row?.audio_file_path) deleteAudioFile(row.audio_file_path);
    db.prepare("DELETE FROM transcription_history WHERE id = ?").run(id);
    return c.json({ ok: true });
  })
  .delete("/", (c) => {
    const db = getDb();
    const rows = db
      .prepare(
        "SELECT audio_file_path FROM transcription_history WHERE audio_file_path IS NOT NULL",
      )
      .all() as Array<{ audio_file_path: string }>;
    for (const row of rows) deleteAudioFile(row.audio_file_path);
    const countRow = db
      .prepare("SELECT COUNT(*) as count FROM transcription_history")
      .get() as { count: number };
    db.exec("DELETE FROM transcription_history");
    capture("history cleared", { deleted_count: countRow.count });
    return c.json({ ok: true });
  })
  .post("/:id/reprocess", async (c) => {
    const db = getDb();
    const id = Number(c.req.param("id"));
    const row = db
      .prepare("SELECT * FROM transcription_history WHERE id = ?")
      .get(id) as HistoryRow | undefined;

    if (!row) return c.json({ error: "Not found" }, 404);
    if (!row.audio_file_path) {
      return c.json({ error: "No audio backup available for this entry" }, 400);
    }

    let audioData: Uint8Array;
    try {
      audioData = new Uint8Array(readFileSync(row.audio_file_path));
    } catch {
      return c.json({ error: "Audio file not found on disk" }, 404);
    }

    const defaults = getDefaultModels();
    if (!defaults.voice) {
      return c.json({ error: "No voice model configured" }, 400);
    }

    const provider = getProvider(defaults.voice.provider);
    if (!provider) {
      return c.json(
        { error: `Unsupported provider: ${defaults.voice.provider}` },
        400,
      );
    }

    const apiKey = getApiKeyForProvider(defaults.voice.provider);
    if (!apiKey) {
      return c.json(
        { error: `No API key for provider: ${defaults.voice.provider}` },
        400,
      );
    }

    try {
      const language = getLanguageSetting();
      const bias = resolveAsrVocabularyBias(
        defaults.voice.provider,
        defaults.voice.model_id,
      );

      const result = await provider.transcribe({
        audio: audioData,
        model: defaults.voice.model_id,
        apiKey,
        ...(language ? { language } : {}),
        bias,
      });

      const rawText = sanitizeTranscriptText(result.text);
      const pp = await postProcess(rawText, null, {
        language,
        source: "batch",
      });

      db.prepare(
        `UPDATE transcription_history SET
           raw_text = ?, cleaned_text = ?,
           voice_provider = ?, voice_model = ?,
           llm_provider = ?, llm_model = ?,
           input_tokens = ?, output_tokens = ?, cost_usd = ?
         WHERE id = ?`,
      ).run(
        rawText,
        pp.cleaned !== rawText ? pp.cleaned : null,
        defaults.voice.provider,
        defaults.voice.model_id,
        pp.llmProvider,
        pp.llmModel,
        pp.inputTokens,
        pp.outputTokens,
        pp.costUsd,
        id,
      );

      return c.json({
        raw: rawText,
        cleaned: pp.cleaned,
        model: defaults.voice.model_id,
      });
    } catch (err) {
      log.error(`Reprocess failed for entry ${id}: ${err}`);
      return c.json(
        {
          error: "Reprocessing failed",
          detail: err instanceof Error ? err.message : String(err),
        },
        500,
      );
    }
  });

export default history;
