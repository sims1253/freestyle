import { getApiBase, getClient } from "@renderer/lib/api";
import type { AvailableModel } from "@renderer/lib/models";
import { cn, ON_DEVICE_PHRASE } from "@renderer/lib/utils";
import {
  CheckCircle,
  ChevronDown,
  ChevronUp,
  Key,
  Laptop,
  Pencil,
  RotateCcw,
  Trash2,
  XCircle,
} from "lucide-react";
import { useCallback, useState } from "react";

import { MlxWarmingDialog } from "./mlx-memory-section";
import { ConfirmDialog, type ModalState, ModelModal } from "./model-modal";
import { Eyebrow, PageHeader, PageShell } from "./page-chrome";
import { PairCard } from "./pair-card";
import { ParakeetBackendDialog } from "./parakeet-backend-section";
import { StarlingSettingsDialog } from "./starling-settings-section";
import type { ApiKeyEntry, ConfiguredModel } from "./types";
import { useModels } from "./use-models";
import { displayName } from "./utils";

export default function ModelsPage(): React.JSX.Element {
  const m = useModels();

  const [modal, setModal] = useState<ModalState | null>(null);
  const [saving, setSaving] = useState(false);
  const [keyError, setKeyError] = useState<string | null>(null);

  const [pendingLocalDelete, setPendingLocalDelete] = useState<{
    defId: string;
    engine?: "whisper" | "mlx" | "parakeet" | "starling";
    name: string;
  } | null>(null);
  const [pendingProviderDelete, setPendingProviderDelete] = useState<
    string | null
  >(null);
  const [warmingOpen, setWarmingOpen] = useState(false);
  const [parakeetBackendOpen, setParakeetBackendOpen] = useState(false);
  const [starlingOpen, setStarlingOpen] = useState(false);

  // -------------------------------------------------------------------------
  // Modal flow
  // -------------------------------------------------------------------------

  const closeModal = (): void => {
    setModal(null);
    setKeyError(null);
    setSaving(false);
  };

  const openVoice = (): void => setModal({ kind: "list", type: "voice" });
  const openLlm = (): void => {
    m.setCleanup(true);
    setModal({ kind: "list", type: "llm" });
  };

  const onPickCloud = (model: AvailableModel): void => {
    if (modal?.kind !== "list") return;
    const needsKey =
      model.provider_id !== "local-llm" &&
      !m.keyProviders.has(model.provider_id);
    if (needsKey) {
      setKeyError(null);
      setModal({
        kind: "key",
        type: modal.type,
        provider: model.provider_id,
        modelName: model.model_name,
        pendingModel: model,
      });
      return;
    }
    void m.configureModel(model, modal.type).then(closeModal);
  };

  const onPickLocalVoice = (
    defId: string,
    name: string,
    engine?: "whisper" | "mlx" | "parakeet" | "starling",
  ): void => {
    void m.selectLocalVoice(defId, name, engine).then(closeModal);
  };

  const onRequestDeleteLocal = (
    defId: string,
    engine?: "whisper" | "mlx" | "parakeet" | "starling",
  ): void => {
    const item = m.voiceItems.find(
      (row) => row.defId === defId && row.localEngine === engine,
    );
    setPendingLocalDelete({ defId, engine, name: item?.name ?? defId });
  };

  const onBack = (): void => {
    if (modal?.kind !== "key") return;
    if (modal.type) setModal({ kind: "list", type: modal.type });
    else closeModal();
  };

  const onSaveKey = (key: string): void => {
    if (modal?.kind !== "key") return;
    const { provider, pendingModel, type } = modal;
    setSaving(true);
    setKeyError(null);
    void (async () => {
      const err = await m.saveKey(provider, key);
      if (err) {
        setKeyError(err);
        setSaving(false);
        return;
      }
      if (pendingModel && type) {
        await m.configureModel(pendingModel, type);
      }
      closeModal();
    })();
  };

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  if (m.loading) {
    return (
      <PageShell>
        <div className="flex items-center justify-center py-24">
          <p className="text-muted-foreground text-sm">Loading models…</p>
        </div>
      </PageShell>
    );
  }

  const hasLocalVoice = m.configured.some(
    (c) =>
      c.provider === "local-whisper" ||
      c.provider === "local-mlx" ||
      c.provider === "local-parakeet" ||
      c.provider === "local-starling",
  );

  // Show the MLX warming control when MLX is the active voice engine, or the
  // platform supports MLX and at least one MLX model is downloaded.
  const showMlxWarming =
    m.defaultVoice?.provider === "local-mlx" ||
    (!!m.mlxStatus?.platformSupported &&
      m.mlxStatus.models.some((model) => model.status === "ready"));

  // Show the parakeet compute-backend picker when parakeet is the active
  // voice engine and the platform offers more than one backend.
  const showParakeetBackend =
    m.defaultVoice?.provider === "local-parakeet" &&
    (m.parakeetStatus?.availableBackends?.length ?? 0) > 1;

  // Show the Starling settings link when starling is the active voice engine.
  const showStarlingSettings = m.defaultVoice?.provider === "local-starling";

  return (
    <PageShell>
      <PageHeader title="Models" />
      <div className="space-y-6">
        <PairCard
          voice={m.defaultVoice}
          llm={m.defaultLlm}
          llmCleanup={m.llmCleanup}
          onToggleCleanup={m.setCleanup}
          onChangeVoice={openVoice}
          onChangeLlm={openLlm}
          onConfigureWarming={
            showMlxWarming ? () => setWarmingOpen(true) : undefined
          }
          onConfigureParakeet={
            showParakeetBackend ? () => setParakeetBackendOpen(true) : undefined
          }
          onConfigureStarling={
            showStarlingSettings ? () => setStarlingOpen(true) : undefined
          }
        />

        {m.llmCleanup && m.defaultLlm && (
          <LlmTokenSettings llm={m.defaultLlm} onSaved={m.loadData} />
        )}

        {m.llmCleanup && <CleanupPromptEditor />}

        <KeysSection
          apiKeys={m.apiKeys}
          configured={m.configured}
          showLocal={hasLocalVoice}
          onEdit={(provider) =>
            setModal({
              kind: "key",
              type: null,
              provider,
              pendingModel: null,
            })
          }
          onDelete={setPendingProviderDelete}
        />
      </div>

      {warmingOpen && (
        <MlxWarmingDialog
          keepAliveMinutes={m.mlxKeepAliveMinutes}
          blockedReason={m.mlxStatus?.blockedReason ?? null}
          onChange={m.saveMlxKeepAliveMinutes}
          onClose={() => setWarmingOpen(false)}
        />
      )}

      {parakeetBackendOpen && m.parakeetStatus && (
        <ParakeetBackendDialog
          status={m.parakeetStatus}
          onChange={m.saveParakeetBackend}
          onClose={() => setParakeetBackendOpen(false)}
        />
      )}

      {starlingOpen && m.starlingStatus && (
        <StarlingSettingsDialog
          status={m.starlingStatus}
          onSaveSetting={m.saveStarlingSetting}
          onClose={() => setStarlingOpen(false)}
        />
      )}

      {modal && (
        <ModelModal
          modal={modal}
          m={m}
          saving={saving}
          keyError={keyError}
          onClose={closeModal}
          onPickCloud={onPickCloud}
          onPickLocalVoice={onPickLocalVoice}
          onRequestDeleteLocal={onRequestDeleteLocal}
          onBack={onBack}
          onSaveKey={onSaveKey}
        />
      )}

      {pendingLocalDelete && (
        <ConfirmDialog
          title="Delete local model?"
          message={
            <>
              Remove{" "}
              <span className="text-foreground/80 font-medium">
                {pendingLocalDelete.name}
              </span>{" "}
              from {ON_DEVICE_PHRASE}. The weights are deleted from your local
              cache; you can download them again later.
            </>
          }
          onCancel={() => setPendingLocalDelete(null)}
          onConfirm={() => {
            const { defId, engine } = pendingLocalDelete;
            setPendingLocalDelete(null);
            void m.deleteLocal(defId, engine);
          }}
        />
      )}

      {pendingProviderDelete && (
        <ConfirmDialog
          title="Delete provider"
          message={
            <>
              Delete the{" "}
              <span className="text-foreground/80 font-medium">
                {displayName(pendingProviderDelete)}
              </span>{" "}
              API key? This also removes all configured models for this provider
              {(m.defaultVoice?.provider === pendingProviderDelete ||
                m.defaultLlm?.provider === pendingProviderDelete) &&
                ", including a model you're currently using"}
              .
            </>
          }
          onCancel={() => setPendingProviderDelete(null)}
          onConfirm={() => {
            const provider = pendingProviderDelete;
            setPendingProviderDelete(null);
            void m.deleteProvider(provider);
          }}
        />
      )}
    </PageShell>
  );
}

// ---------------------------------------------------------------------------
// LlmTokenSettings â€” max output tokens + context length for the active LLM
// ---------------------------------------------------------------------------

function LlmTokenSettings({
  llm,
  onSaved,
}: {
  llm: ConfiguredModel;
  onSaved: () => Promise<void>;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [maxTokens, setMaxTokens] = useState(
    llm.max_output_tokens?.toString() ?? "",
  );
  const [contextLen, setContextLen] = useState(
    llm.context_length?.toString() ?? "",
  );
  const timerRef = useState<{
    current: ReturnType<typeof setTimeout> | null;
  }>({ current: null })[0];

  // Sync local state when the llm prop changes after reload
  const llmMaxKey = `${llm.id}:${llm.max_output_tokens ?? ""}`;
  const llmCtxKey = `${llm.id}:${llm.context_length ?? ""}`;
  const lastSyncRef = useState<{ current: string }>({ current: "" })[0];
  const syncKey = `${llmMaxKey}|${llmCtxKey}`;
  if (lastSyncRef.current !== syncKey) {
    lastSyncRef.current = syncKey;
    setMaxTokens(llm.max_output_tokens?.toString() ?? "");
    setContextLen(llm.context_length?.toString() ?? "");
  }

  const save = useCallback(
    (field: "max_output_tokens" | "context_length", value: string) => {
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        const numValue = value.trim()
          ? Number.parseInt(value.trim(), 10)
          : null;
        fetch(`${getApiBase()}/api/models/configured/${llm.id}/settings`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ [field]: numValue }),
        })
          .then(() => onSaved())
          .catch(() => {});
      }, 600);
    },
    [llm.id, timerRef, onSaved],
  );

  return (
    <section className="border-border bg-card rounded-[14px] border">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex w-full items-center justify-between px-6 py-4 cursor-pointer"
      >
        <div>
          <Eyebrow text="Token budget" mono={false} />
          <p className="text-muted-foreground mt-1 text-[13px]">
            Max output tokens and context length for{" "}
            <span className="text-foreground/80 font-medium">
              {llm.model_name}
            </span>
          </p>
        </div>
        {open ? (
          <ChevronUp className="text-muted-foreground h-4 w-4" />
        ) : (
          <ChevronDown className="text-muted-foreground h-4 w-4" />
        )}
      </button>
      {open && (
        <div className="border-border border-t px-6 pb-5 pt-4">
          <div className="grid grid-cols-1 gap-4 min-[460px]:grid-cols-2">
            <div>
              <div className="mono text-muted-foreground mb-1.5 text-[10px] uppercase tracking-[0.16em]">
                Max output tokens
              </div>
              <input
                type="number"
                value={maxTokens}
                onChange={(e) => {
                  setMaxTokens(e.target.value);
                  save("max_output_tokens", e.target.value);
                }}
                placeholder="Auto (1.5x input + 256)"
                className="border-border bg-background mono w-full rounded-[7px] border px-[11px] py-2 text-[13px] outline-none"
              />
              <p className="text-muted-foreground mt-1.5 text-[11px] leading-snug">
                Leave empty for auto-scaling. When set, overrides LM Studio
                defaults.
              </p>
            </div>
            <div>
              <div className="mono text-muted-foreground mb-1.5 text-[10px] uppercase tracking-[0.16em]">
                Context length
              </div>
              <input
                type="number"
                value={contextLen}
                onChange={(e) => {
                  setContextLen(e.target.value);
                  save("context_length", e.target.value);
                }}
                placeholder="No clamp"
                className="border-border bg-background mono w-full rounded-[7px] border px-[11px] py-2 text-[13px] outline-none"
              />
              <p className="text-muted-foreground mt-1.5 text-[11px] leading-snug">
                When set, max output tokens are clamped to this value.
              </p>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
// ---------------------------------------------------------------------------
// CleanupPromptEditor — editable default post-processing system prompt
// ---------------------------------------------------------------------------

function CleanupPromptEditor(): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState<string | null>(null);
  const [defaultPrompt, setDefaultPrompt] = useState<string | null>(null);
  const saveTimeoutRef = {
    current: null as ReturnType<typeof setTimeout> | null,
  };

  const loadPrompt = useCallback(async () => {
    if (value !== null) return; // already loaded
    const client = getClient();
    const [customRes, defaultRes] = await Promise.all([
      client.api.settings[":key"].$get({
        param: { key: "rewrite_system_prompt" },
      }),
      fetch(`${getApiBase()}/api/post-process/default-prompt`),
    ]);
    const custom = customRes.ok
      ? (((await customRes.json()) as { value?: string }).value ?? "")
      : "";
    let defText = "";
    if (defaultRes.ok) {
      const data = (await defaultRes.json()) as { prompt: string };
      defText = data.prompt;
      setDefaultPrompt(defText);
    }
    setValue(custom || defText);
  }, [value]);

  const handleToggle = useCallback(() => {
    const next = !open;
    setOpen(next);
    if (next) void loadPrompt();
  }, [open, loadPrompt]);

  const handleChange = useCallback(
    (newValue: string) => {
      setValue(newValue);
      if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
      const saveValue = newValue === defaultPrompt ? "" : newValue;
      saveTimeoutRef.current = setTimeout(() => {
        getClient()
          .api.settings[":key"].$put({
            param: { key: "rewrite_system_prompt" },
            json: { value: saveValue },
          })
          .catch(() => {});
      }, 600);
    },
    [defaultPrompt, saveTimeoutRef.current, saveTimeoutRef],
  );

  const handleReset = useCallback(() => {
    setValue(defaultPrompt ?? "");
    getClient()
      .api.settings[":key"].$put({
        param: { key: "rewrite_system_prompt" },
        json: { value: "" },
      })
      .catch(() => {});
  }, [defaultPrompt]);

  return (
    <section className="border-border bg-card rounded-[14px] border">
      <button
        type="button"
        onClick={handleToggle}
        className="flex w-full items-center justify-between px-6 py-4 cursor-pointer"
      >
        <div>
          <Eyebrow text="Cleanup system prompt" mono={false} />
          <p className="text-muted-foreground mt-1 text-[13px]">
            Customize the instructions sent to the LLM for transcript cleanup
          </p>
        </div>
        {open ? (
          <ChevronUp className="text-muted-foreground h-4 w-4" />
        ) : (
          <ChevronDown className="text-muted-foreground h-4 w-4" />
        )}
      </button>
      {open && (
        <div className="border-border border-t px-6 pb-5 pt-4">
          <textarea
            value={value ?? ""}
            onChange={(e) => handleChange(e.target.value)}
            rows={12}
            className="border-border bg-background text-foreground w-full rounded-md border p-3 text-[13px] leading-relaxed outline-none focus:border-primary resize-y font-mono"
          />
          <div className="mt-2 flex items-center justify-between">
            <p className="text-muted-foreground text-[11px]">
              {value && defaultPrompt && value !== defaultPrompt
                ? "Using custom prompt"
                : "Using default prompt"}
            </p>
            {value && defaultPrompt && value !== defaultPrompt && (
              <button
                type="button"
                onClick={handleReset}
                className="text-muted-foreground hover:text-foreground flex items-center gap-1 text-[11px] cursor-pointer"
              >
                <RotateCcw className="h-3 w-3" />
                Reset to default
              </button>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// KeysSection — compact list of stored provider keys (edit / remove)
// ---------------------------------------------------------------------------

function KeysSection({
  apiKeys,
  configured,
  showLocal,
  onEdit,
  onDelete,
}: {
  apiKeys: ApiKeyEntry[];
  configured: ConfiguredModel[];
  showLocal: boolean;
  onEdit: (provider: string) => void;
  onDelete: (provider: string) => void;
}): React.JSX.Element | null {
  if (apiKeys.length === 0 && !showLocal) {
    return (
      <p className="text-muted-foreground text-[13px]">
        No API keys yet — choose a cloud model above and you'll be prompted for
        a key.
      </p>
    );
  }

  return (
    <section>
      <div className="mb-3">
        <Eyebrow text="API keys" />
      </div>
      <div className="border-border bg-card overflow-hidden rounded-[12px] border">
        {apiKeys.map((entry, i) => (
          <KeyRow
            key={entry.provider}
            entry={entry}
            count={
              configured.filter((c) => c.provider === entry.provider).length
            }
            first={i === 0}
            onEdit={() => onEdit(entry.provider)}
            onDelete={() => onDelete(entry.provider)}
          />
        ))}
        {showLocal && (
          <div
            className={cn(
              "flex items-center gap-3 px-[18px] py-[13px]",
              apiKeys.length > 0 && "border-border border-t",
            )}
          >
            <Laptop className="text-primary h-[15px] w-[15px] shrink-0" />
            <div className="min-w-0 flex-1">
              <div className="text-foreground text-[13.5px] font-semibold">
                On-device
              </div>
              <div className="mono text-muted-foreground mt-0.5 text-[11px]">
                No key needed · runs locally
              </div>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

function KeyRow({
  entry,
  count,
  first,
  onEdit,
  onDelete,
}: {
  entry: ApiKeyEntry;
  count: number;
  first: boolean;
  onEdit: () => void;
  onDelete: () => void;
}): React.JSX.Element {
  const invalid = entry.status === "invalid";
  return (
    <div
      className={cn(
        "group flex items-center gap-3 px-[18px] py-[13px]",
        !first && "border-border border-t",
      )}
    >
      <Key className="text-muted-foreground h-[15px] w-[15px] shrink-0" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="text-foreground text-[13.5px] font-semibold">
            {displayName(entry.provider)}
          </span>
          {entry.status === "valid" && (
            <CheckCircle className="text-primary h-3.5 w-3.5 shrink-0" />
          )}
          {invalid && (
            <XCircle className="text-destructive h-3.5 w-3.5 shrink-0" />
          )}
        </div>
        <div className="mono text-muted-foreground mt-0.5 text-[11px]">
          {invalid ? (
            <span className="text-destructive">
              Key invalid — update or delete
            </span>
          ) : (
            `Key ${entry.hint ?? ""} stored in keychain`.replace("  ", " ")
          )}
        </div>
      </div>
      <span className="text-muted-foreground text-[11.5px]">
        {count} model{count === 1 ? "" : "s"}
      </span>
      <div
        className={cn(
          "flex shrink-0 items-center gap-0.5 transition-opacity",
          invalid ? "opacity-100" : "opacity-0 group-hover:opacity-100",
        )}
      >
        <button
          type="button"
          onClick={onEdit}
          className="text-muted-foreground hover:text-foreground hover:bg-secondary rounded p-1.5"
          title="Update API key"
        >
          <Pencil size={14} />
        </button>
        <button
          type="button"
          onClick={onDelete}
          className="text-muted-foreground hover:text-destructive hover:bg-secondary rounded p-1.5"
          title="Delete provider"
        >
          <Trash2 size={14} />
        </button>
      </div>
    </div>
  );
}
