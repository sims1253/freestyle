import { createFormatSchema, updateFormatSchema } from "@freestyle/validations";
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { getDb } from "../lib/db.js";

interface FormatRow {
  id: number;
  app_pattern: string;
  label: string;
  instructions: string;
  is_default: number;
  llm_provider: string | null;
  llm_model_id: string | null;
  max_output_tokens: number | null;
  system_prompt_override: string | null;
  shortcut: string | null;
  created_at: string;
  updated_at: string;
}

const formats = new Hono()
  .get("/", (c) => {
    const db = getDb();
    const limit = Math.min(Number(c.req.query("limit") || 50), 200);
    const offset = Number(c.req.query("offset") || 0);
    const search = c.req.query("search")?.trim() || "";

    let rows: FormatRow[];
    let countRow: { count: number };

    if (search) {
      const pattern = `%${search}%`;
      rows = db
        .prepare(
          "SELECT * FROM format_rules WHERE label LIKE ? OR app_pattern LIKE ? OR instructions LIKE ? ORDER BY is_default ASC, label ASC LIMIT ? OFFSET ?",
        )
        .all(
          pattern,
          pattern,
          pattern,
          limit,
          offset,
        ) as unknown as FormatRow[];
      countRow = db
        .prepare(
          "SELECT COUNT(*) as count FROM format_rules WHERE label LIKE ? OR app_pattern LIKE ? OR instructions LIKE ?",
        )
        .get(pattern, pattern, pattern) as unknown as { count: number };
    } else {
      rows = db
        .prepare(
          "SELECT * FROM format_rules ORDER BY is_default ASC, label ASC LIMIT ? OFFSET ?",
        )
        .all(limit, offset) as unknown as FormatRow[];
      countRow = db
        .prepare("SELECT COUNT(*) as count FROM format_rules")
        .get() as unknown as { count: number };
    }

    return c.json({
      items: rows,
      total: countRow.count,
      limit,
      offset,
    });
  })
  .get("/:id{[0-9]+}", (c) => {
    const db = getDb();
    const id = Number(c.req.param("id"));
    const row = db.prepare("SELECT * FROM format_rules WHERE id = ?").get(id) as
      | FormatRow
      | undefined;

    if (!row) return c.json({ error: "Not found" }, 404);
    return c.json(row);
  })
  .get("/match", (c) => {
    const db = getDb();
    const context = c.req.query("context") ?? "";
    if (!context) return c.json(null);

    const rows = db
      .prepare("SELECT * FROM format_rules ORDER BY is_default ASC, id DESC")
      .all() as unknown as FormatRow[];

    // User rules (is_default=0) take priority over defaults (is_default=1)
    for (const row of rows) {
      const patterns = row.app_pattern.split("|").map((p) => p.trim());
      for (const pattern of patterns) {
        if (pattern && context.toLowerCase().includes(pattern.toLowerCase())) {
          return c.json(row);
        }
      }
    }

    return c.json(null);
  })
  .post("/", zValidator("json", createFormatSchema), async (c) => {
    const db = getDb();
    const body = c.req.valid("json");

    const result = db
      .prepare(
        "INSERT INTO format_rules (app_pattern, label, instructions, is_default, llm_provider, llm_model_id, max_output_tokens, system_prompt_override, shortcut) VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?)",
      )
      .run(
        body.app_pattern,
        body.label,
        body.instructions,
        body.llm_provider ?? null,
        body.llm_model_id ?? null,
        body.max_output_tokens ?? null,
        body.system_prompt_override ?? null,
        body.shortcut ?? null,
      );

    return c.json({ id: result.lastInsertRowid, ...body }, 201);
  })
  .put("/:id", zValidator("json", updateFormatSchema), async (c) => {
    const db = getDb();
    const id = Number(c.req.param("id"));
    const body = c.req.valid("json");

    const existing = db
      .prepare("SELECT * FROM format_rules WHERE id = ?")
      .get(id) as FormatRow | undefined;
    if (!existing) return c.json({ error: "Not found" }, 404);

    db.prepare(
      "UPDATE format_rules SET app_pattern = ?, label = ?, instructions = ?, llm_provider = ?, llm_model_id = ?, max_output_tokens = ?, system_prompt_override = ?, shortcut = ?, updated_at = datetime('now') WHERE id = ?",
    ).run(
      body.app_pattern ?? existing.app_pattern,
      body.label ?? existing.label,
      body.instructions ?? existing.instructions,
      body.llm_provider !== undefined
        ? body.llm_provider
        : existing.llm_provider,
      body.llm_model_id !== undefined
        ? body.llm_model_id
        : existing.llm_model_id,
      body.max_output_tokens !== undefined
        ? body.max_output_tokens
        : existing.max_output_tokens,
      body.system_prompt_override !== undefined
        ? body.system_prompt_override
        : existing.system_prompt_override,
      body.shortcut !== undefined ? body.shortcut : existing.shortcut,
      id,
    );

    return c.json({ ok: true });
  })
  .delete("/:id", (c) => {
    const db = getDb();
    const id = Number(c.req.param("id"));
    db.prepare("DELETE FROM format_rules WHERE id = ?").run(id);
    return c.json({ ok: true });
  })
  .post("/reset", (c) => {
    const db = getDb();
    db.exec("DELETE FROM format_rules WHERE is_default = 0");
    return c.json({ ok: true });
  });

export default formats;
