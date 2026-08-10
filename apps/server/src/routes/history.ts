import { readFileSync } from "node:fs";
import { sanitizeTranscriptText } from "@freestyle-voice/stt";
import { historyQuerySchema } from "@freestyle-voice/validations";
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { deleteAudioBackup } from "../lib/audio-backup.js";
import { getDb } from "../lib/db.js";
import { getLanguagesSetting } from "../lib/language.js";
import { postProcess } from "../lib/post-process.js";
import { capture } from "../lib/posthog.js";
import { getDefaultModels } from "../lib/providers.js";
import { transcribeWithStarling } from "../lib/starling/server.js";
import { stripProviderPrefix } from "../lib/streaming/types.js";

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
  fixes_count: number;
  created_at: string;
  audio_file_path: string | null;
}

// Space-count heuristic for words in the final text, mirrored in /stats and
// /daily so both aggregates agree.
const WORDS_SQL = `
  CASE
    WHEN length(trim(COALESCE(cleaned_text, raw_text))) = 0 THEN 0
    ELSE length(trim(COALESCE(cleaned_text, raw_text)))
      - length(replace(trim(COALESCE(cleaned_text, raw_text)), ' ', ''))
      + 1
  END`;

/** Days of per-day history returned by /daily — enough for the usage heatmap. */
const DAILY_WINDOW_DAYS = 140;

const ALLOWED_ORDER_COLUMNS = new Set([
  "created_at",
  "duration_ms",
  "cost_usd",
]);

const history = new Hono()
  .get("/", zValidator("query", historyQuerySchema), (c) => {
    const db = getDb();
    const {
      limit,
      offset,
      search: rawSearch,
      orderBy,
      start_date = null,
      end_date = null,
    } = c.req.valid("query");
    const search = rawSearch?.trim() || "";

    const orderColumn =
      orderBy && ALLOWED_ORDER_COLUMNS.has(orderBy.column)
        ? orderBy.column
        : "created_at";
    // Default ordering (no orderBy param) is newest-first.
    const orderDir = orderBy
      ? orderBy.order === "desc"
        ? "DESC"
        : "ASC"
      : "DESC";

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
  .get("/stats", zValidator("query", historyQuerySchema), (c) => {
    const db = getDb();

    const { start_date: startDate = null, end_date: endDate = null } =
      c.req.valid("query");

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
          COALESCE(SUM(audio_duration_ms), 0) as total_audio_ms,
          COALESCE(SUM(fixes_count), 0) as total_fixes,
          COALESCE(SUM(${WORDS_SQL}), 0) as total_words
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
      total_audio_ms: number;
      total_fixes: number;
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
  // Per-local-day usage series for the stats sidebar's heatmap. Fixed lookback
  // window, independent of the list filters. Registered before "/:id" so
  // "daily" isn't swallowed by the id matcher.
  .get("/daily", (c) => {
    const db = getDb();
    const rows = db
      .prepare(
        `SELECT
           date(created_at, 'localtime') as day,
           COUNT(*) as sessions,
           COALESCE(SUM(${WORDS_SQL}), 0) as words
         FROM transcription_history
         WHERE created_at >= datetime('now', ?)
         GROUP BY day
         ORDER BY day ASC`,
      )
      .all(`-${DAILY_WINDOW_DAYS} days`) as {
      day: string;
      sessions: number;
      words: number;
    }[];

    return c.json({ days: rows });
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
    if (row?.audio_file_path) deleteAudioBackup(row.audio_file_path);
    db.prepare("DELETE FROM transcription_history WHERE id = ?").run(id);
    return c.json({ ok: true });
  })
  .delete("/", (c) => {
    const db = getDb();
    const audioRows = db
      .prepare(
        "SELECT audio_file_path FROM transcription_history WHERE audio_file_path IS NOT NULL",
      )
      .all() as { audio_file_path: string }[];
    for (const row of audioRows) deleteAudioBackup(row.audio_file_path);
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
    if (!row.audio_file_path)
      return c.json({ error: "No audio backup available" }, 400);

    let audio: Uint8Array;
    try {
      audio = new Uint8Array(readFileSync(row.audio_file_path));
    } catch {
      return c.json({ error: "Audio backup not found" }, 404);
    }
    const voice = getDefaultModels().voice;
    if (!voice || voice.provider !== "local-starling") {
      return c.json({ error: "No Local Starling voice model configured" }, 400);
    }
    try {
      const result = await transcribeWithStarling({
        modelId: stripProviderPrefix(voice.model_id),
        audio,
      });
      const raw = sanitizeTranscriptText(result.text);
      const processed = await postProcess(raw, null, {
        languages: getLanguagesSetting(),
        source: "batch",
      });
      db.prepare(
        `UPDATE transcription_history SET raw_text = ?, cleaned_text = ?,
         voice_provider = ?, voice_model = ?, llm_provider = ?, llm_model = ?,
         input_tokens = ?, output_tokens = ?, cost_usd = ? WHERE id = ?`,
      ).run(
        raw,
        processed.cleaned !== raw ? processed.cleaned : null,
        voice.provider,
        voice.model_id,
        processed.llmProvider,
        processed.llmModel,
        processed.inputTokens,
        processed.outputTokens,
        processed.costUsd,
        id,
      );
      return c.json({ raw, cleaned: processed.cleaned });
    } catch (error) {
      return c.json(
        {
          error: "Reprocessing failed",
          detail: error instanceof Error ? error.message : String(error),
        },
        500,
      );
    }
  });

export default history;
