import { createFormatSchema } from "@freestyle/validations";
import { zodResolver } from "@hookform/resolvers/zod";
import { getClient } from "@renderer/lib/api";
import { cn } from "@renderer/lib/utils";
import { FileText, Pencil, Plus, RotateCcw, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useForm } from "react-hook-form";

interface FormatRule {
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

interface FormatFormValues {
  label: string;
  app_pattern: string;
  instructions: string;
  llm_provider?: string;
  llm_model_id?: string;
  max_output_tokens?: number;
  system_prompt_override?: string;
  shortcut?: string;
}

export default function FormatsPage(): React.JSX.Element {
  const [rules, setRules] = useState<FormatRule[]>([]);
  const [loading, setLoading] = useState(true);

  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const form = useForm<FormatFormValues>({
    resolver: zodResolver(createFormatSchema),
    defaultValues: { label: "", app_pattern: "", instructions: "" },
  });

  const loadData = useCallback(async () => {
    try {
      const res = await getClient().api.formats.$get({
        query: { limit: "200" },
      });
      if (res.ok) {
        const data = await res.json();
        setRules(data.items ?? data);
      }
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const resetForm = useCallback(() => {
    setShowForm(false);
    setEditingId(null);
    setFormError(null);
    form.reset({
      label: "",
      app_pattern: "",
      instructions: "",
      llm_provider: "",
      llm_model_id: "",
      max_output_tokens: undefined,
      system_prompt_override: "",
      shortcut: "",
    });
  }, [form]);

  const startEdit = useCallback(
    (rule: FormatRule) => {
      setEditingId(rule.id);
      form.reset({
        label: rule.label,
        app_pattern: rule.app_pattern,
        instructions: rule.instructions,
        llm_provider: rule.llm_provider ?? "",
        llm_model_id: rule.llm_model_id ?? "",
        max_output_tokens: rule.max_output_tokens ?? undefined,
        system_prompt_override: rule.system_prompt_override ?? "",
        shortcut: rule.shortcut ?? "",
      });
      setFormError(null);
      setShowForm(true);
    },
    [form],
  );

  const saveRule = useCallback(
    async (data: FormatFormValues) => {
      setFormError(null);

      try {
        const client = getClient();
        let res: Response;
        if (editingId) {
          res = await client.api.formats[":id"].$put({
            param: { id: String(editingId) },
            json: {
              label: data.label,
              app_pattern: data.app_pattern,
              instructions: data.instructions,
              llm_provider: data.llm_provider?.trim() || null,
              llm_model_id: data.llm_model_id?.trim() || null,
              max_output_tokens: data.max_output_tokens || null,
              system_prompt_override:
                data.system_prompt_override?.trim() || null,
              shortcut: data.shortcut?.trim() || null,
            },
          });
        } else {
          res = await client.api.formats.$post({
            json: {
              label: data.label,
              app_pattern: data.app_pattern,
              instructions: data.instructions,
              ...(data.llm_provider?.trim()
                ? { llm_provider: data.llm_provider.trim() }
                : {}),
              ...(data.llm_model_id?.trim()
                ? { llm_model_id: data.llm_model_id.trim() }
                : {}),
              ...(data.max_output_tokens
                ? { max_output_tokens: data.max_output_tokens }
                : {}),
              ...(data.system_prompt_override?.trim()
                ? { system_prompt_override: data.system_prompt_override.trim() }
                : {}),
              ...(data.shortcut?.trim()
                ? { shortcut: data.shortcut.trim() }
                : {}),
            },
          });
        }

        if (!res.ok) {
          const text = await res.text().catch(() => "");
          setFormError(text || `HTTP ${res.status}`);
          return;
        }

        resetForm();
        loadData();
        window.api?.notifyFormatsChanged();
      } catch {
        setFormError("Failed to save.");
      }
    },
    [editingId, resetForm, loadData],
  );

  const deleteRule = useCallback(
    async (id: number) => {
      await getClient().api.formats[":id"].$delete({
        param: { id: String(id) },
      });
      loadData();
      window.api?.notifyFormatsChanged();
    },
    [loadData],
  );

  const resetDefaults = useCallback(async () => {
    await getClient().api.formats.reset.$post();
    loadData();
    window.api?.notifyFormatsChanged();
  }, [loadData]);

  const defaultRules = rules.filter((r) => r.is_default === 1);
  const customRules = rules.filter((r) => r.is_default === 0);

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-muted-foreground text-sm">Loading formats…</p>
      </div>
    );
  }

  return (
    <div
      className="flex h-full min-h-0 flex-col"
      style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
    >
      <div className="h-9 shrink-0" />
      <div
        className="responsive-page-scroll flex-1 overflow-auto"
        style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
      >
        <PageHeader title="Formats" />

        {/* Action bar */}
        <div className="mb-5 flex items-center justify-between">
          <button
            type="button"
            onClick={() => {
              form.reset({
                label: "",
                app_pattern: "",
                instructions: "",
                llm_provider: "",
                llm_model_id: "",
                max_output_tokens: undefined,
                system_prompt_override: "",
              });
              setEditingId(null);
              setFormError(null);
              setShowForm(true);
            }}
            className="bg-primary text-primary-foreground hover:bg-primary/90 flex cursor-pointer items-center gap-1.5 rounded-md px-3 py-2 text-[12.5px] font-medium"
          >
            <Plus size={13} />
            Add format
          </button>
          {customRules.length > 0 && (
            <button
              type="button"
              onClick={resetDefaults}
              className="border-border text-secondary-foreground/80 hover:text-foreground flex cursor-pointer items-center gap-1.5 rounded-md border px-3 py-2 text-[12.5px] font-medium"
            >
              <RotateCcw size={12} />
              Reset to defaults
            </button>
          )}
        </div>

        {/* Add/Edit form */}
        {showForm && (
          <form
            onSubmit={form.handleSubmit(saveRule)}
            className="border-border bg-card mb-6 rounded-[12px] border px-[18px] py-4"
          >
            <div className="mb-3 flex items-center justify-between">
              <span className="mono text-muted-foreground text-[10px] uppercase tracking-[0.16em]">
                {editingId ? "Edit format" : "New format"}
              </span>
              <button
                type="button"
                onClick={resetForm}
                className="text-muted-foreground hover:text-foreground cursor-pointer"
              >
                <X size={14} />
              </button>
            </div>
            <div className="space-y-3.5">
              <FormField
                label="Label"
                error={form.formState.errors.label?.message}
              >
                <input
                  type="text"
                  {...form.register("label")}
                  placeholder='e.g. "Email" or "Slack"'
                  className={cn(
                    "border-border bg-background w-full rounded-[7px] border px-[11px] py-2 text-[13px] outline-none",
                    form.formState.errors.label && "border-destructive",
                  )}
                />
              </FormField>
              <FormField
                label="App pattern · pipe-separated"
                error={form.formState.errors.app_pattern?.message}
                hint="Matched against the app name, URL, and page title. Case-insensitive."
              >
                <input
                  type="text"
                  {...form.register("app_pattern")}
                  placeholder="e.g. mail.google.com | outlook | Spark"
                  className={cn(
                    "border-border bg-background mono w-full rounded-[7px] border px-[11px] py-2 text-[13px] outline-none",
                    form.formState.errors.app_pattern && "border-destructive",
                  )}
                />
              </FormField>
              <FormField
                label="Instructions · sent to the LLM"
                error={form.formState.errors.instructions?.message}
              >
                <textarea
                  {...form.register("instructions")}
                  placeholder="Tell the LLM how to format the text…"
                  rows={3}
                  className={cn(
                    "border-border bg-background w-full resize-none rounded-[7px] border px-[11px] py-2 text-[13px] leading-[1.5] outline-none",
                    form.formState.errors.instructions && "border-destructive",
                  )}
                />
              </FormField>

              {/* Advanced overrides */}
              <div className="border-border mt-1 border-t pt-3.5">
                <div className="mono text-muted-foreground mb-3 text-[10px] uppercase tracking-[0.16em]">
                  Advanced · optional overrides
                </div>
                <div className="grid grid-cols-1 gap-3.5 min-[560px]:grid-cols-2">
                  <FormField
                    label="Override model · provider"
                    hint="e.g. openai, anthropic, local-llm"
                  >
                    <input
                      type="text"
                      {...form.register("llm_provider")}
                      placeholder="Default model"
                      className="border-border bg-background mono w-full rounded-[7px] border px-[11px] py-2 text-[13px] outline-none"
                    />
                  </FormField>
                  <FormField
                    label="Override model · model ID"
                    hint="e.g. openai/gpt-4o, local-llm/gemma-3-12b"
                  >
                    <input
                      type="text"
                      {...form.register("llm_model_id")}
                      placeholder="Default model"
                      className="border-border bg-background mono w-full rounded-[7px] border px-[11px] py-2 text-[13px] outline-none"
                    />
                  </FormField>
                </div>
                <div className="mt-3.5">
                  <FormField
                    label="Max output tokens · override"
                    hint="Leave empty for auto-scaling. Clamped by context length if set."
                  >
                    <input
                      type="number"
                      {...form.register("max_output_tokens", {
                        setValueAs: (v) =>
                          v === "" || v === null || v === undefined
                            ? undefined
                            : Number(v),
                      })}
                      placeholder="Auto"
                      className="border-border bg-background mono w-full rounded-[7px] border px-[11px] py-2 text-[13px] outline-none"
                    />
                  </FormField>
                </div>
                <div className="mt-3.5">
                  <FormField
                    label="System prompt override · replaces base prompt entirely"
                    hint="When set, this replaces the transcript cleanup system prompt. The instructions above are appended as a direct context hint. Use this to change the task entirely (e.g. code generation)."
                  >
                    <textarea
                      {...form.register("system_prompt_override")}
                      placeholder="Leave empty for default transcript cleanup behavior…"
                      rows={5}
                      className={cn(
                        "border-border bg-background w-full resize-y rounded-[7px] border px-[11px] py-2 text-[13px] leading-[1.5] outline-none",
                      )}
                    />
                  </FormField>
                </div>
                <div className="mt-3.5">
                  <FormField
                    label="Shortcut · global accelerator"
                    hint="Electron accelerator (e.g. CommandOrControl+Shift+1). Pressing it activates this format for the next dictation. Press again to deactivate."
                  >
                    <input
                      type="text"
                      {...form.register("shortcut")}
                      placeholder="e.g. CommandOrControl+Shift+1"
                      className="border-border bg-background mono w-full rounded-[7px] border px-[11px] py-2 text-[13px] outline-none"
                    />
                  </FormField>
                </div>
              </div>
              {formError && (
                <p className="text-destructive text-xs">{formError}</p>
              )}
              <div className="flex justify-end gap-2 pt-1">
                <button
                  type="button"
                  onClick={resetForm}
                  className="border-border text-secondary-foreground/80 hover:text-foreground cursor-pointer rounded-md border px-3 py-1.5 text-[12.5px] font-medium"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="bg-primary text-primary-foreground hover:bg-primary/90 cursor-pointer rounded-md px-3 py-1.5 text-[12.5px] font-medium"
                >
                  {editingId ? "Update" : "Add format"}
                </button>
              </div>
            </div>
          </form>
        )}

        {/* Custom section */}
        {customRules.length > 0 && (
          <Section label="Custom">
            {customRules.map((rule) => (
              <FormatCard
                key={rule.id}
                rule={rule}
                custom
                onEdit={startEdit}
                onDelete={deleteRule}
              />
            ))}
          </Section>
        )}

        {/* Defaults section */}
        {defaultRules.length > 0 && (
          <Section label="Defaults">
            {defaultRules.map((rule) => (
              <FormatCard
                key={rule.id}
                rule={rule}
                onEdit={startEdit}
                onDelete={deleteRule}
              />
            ))}
          </Section>
        )}

        {rules.length === 0 && !showForm && (
          <div className="text-muted-foreground py-10 text-center">
            <span className="serif-italic text-[20px]">
              no formats yet — add one above.
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Subcomponents
// ---------------------------------------------------------------------------

function PageHeader({
  title,
  subtitle,
}: {
  title: string;
  subtitle?: string;
}): React.JSX.Element {
  return (
    <div className="mb-7">
      <h1 className="serif text-foreground m-0 text-[48px] font-normal leading-[0.95] tracking-[-0.025em]">
        <span className="serif-italic text-primary">{title}</span>
        <span>. </span>
      </h1>
      {subtitle && (
        <p className="text-muted-foreground mt-2.5 max-w-[580px] text-[14px] leading-[1.5]">
          {subtitle}
        </p>
      )}
    </div>
  );
}

function FormField({
  label,
  error,
  hint,
  children,
}: {
  label: string;
  error?: string;
  hint?: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div>
      <div className="mono text-muted-foreground mb-1.5 text-[10px] uppercase tracking-[0.16em]">
        {label}
      </div>
      {children}
      {error ? (
        <p className="text-destructive mt-1 text-xs">{error}</p>
      ) : hint ? (
        <p className="text-muted-foreground mt-1.5 text-[11px] leading-snug">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

function Section({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="mb-7">
      <div className="mono text-muted-foreground mb-3 text-[10px] uppercase tracking-[0.18em]">
        {label}
      </div>
      <div className="flex flex-col gap-2.5">{children}</div>
    </div>
  );
}

function FormatCard({
  rule,
  custom,
  onEdit,
  onDelete,
}: {
  rule: FormatRule;
  custom?: boolean;
  onEdit: (rule: FormatRule) => void;
  onDelete: (id: number) => void;
}): React.JSX.Element {
  return (
    <div
      className={cn(
        "group bg-card flex gap-4 rounded-[12px] border px-[18px] py-4",
        custom ? "border-primary/60" : "border-border",
      )}
    >
      <div
        className={cn(
          "mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border",
          custom
            ? "border-primary/30 bg-accent text-primary"
            : "border-border bg-background text-muted-foreground",
        )}
      >
        <FileText size={16} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="mb-1 flex flex-wrap items-center gap-2">
          <span className="text-foreground text-[14px] font-medium">
            {rule.label}
          </span>
          {custom && (
            <span className="mono bg-primary text-primary-foreground rounded-full px-1.5 py-[2px] text-[9px] tracking-[0.14em]">
              CUSTOM
            </span>
          )}
          <span
            className="mono border-border bg-background text-secondary-foreground/90 rounded border px-[7px] py-[2px] text-[10px]"
            title={rule.app_pattern}
          >
            {rule.app_pattern}
          </span>
          {rule.llm_provider && rule.llm_model_id && (
            <span
              className="mono bg-accent text-accent-foreground rounded-full px-1.5 py-[2px] text-[9px] tracking-[0.14em]"
              title={`${rule.llm_provider}/${rule.llm_model_id}`}
            >
              {rule.llm_model_id}
            </span>
          )}
          {rule.max_output_tokens && (
            <span className="mono border-border bg-background text-muted-foreground rounded border px-[7px] py-[2px] text-[10px]">
              {rule.max_output_tokens} tok
            </span>
          )}
          {rule.system_prompt_override && (
            <span className="mono bg-destructive/10 text-destructive rounded-full px-1.5 py-[2px] text-[9px] tracking-[0.14em]">
              CUSTOM PROMPT
            </span>
          )}
          {rule.shortcut && (
            <span className="mono border-border bg-background text-muted-foreground rounded border px-[7px] py-[2px] text-[10px]">
              {rule.shortcut}
            </span>
          )}
        </div>
        <p
          className="text-secondary-foreground m-0 max-w-[720px] text-[16px] leading-[1.55]"
          style={{ textWrap: "pretty" as never }}
        >
          “{rule.instructions}”
        </p>
      </div>
      <div className="flex shrink-0 gap-0.5 self-start opacity-0 transition-opacity group-hover:opacity-100">
        <button
          type="button"
          onClick={() => onEdit(rule)}
          className="text-muted-foreground hover:text-foreground cursor-pointer rounded p-1"
          title="Edit"
        >
          <Pencil size={13} />
        </button>
        {custom && (
          <button
            type="button"
            onClick={() => onDelete(rule.id)}
            className="text-muted-foreground hover:text-destructive cursor-pointer rounded p-1"
            title="Delete"
          >
            <Trash2 size={13} />
          </button>
        )}
      </div>
    </div>
  );
}
