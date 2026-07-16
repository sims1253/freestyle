import { getApiBase, getClient } from "@renderer/lib/api";
import type {
  AvailableModel,
  StarlingStatus,
  VoiceItem,
  WhisperStatus,
} from "@renderer/lib/models";
import { SETTINGS_QUERY_KEY, settingsQueryOptions } from "@renderer/lib/query";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SETTINGS_KEYS } from "../../../../shared/settings-keys";
import { DEFAULT_MLX_KEEP_ALIVE_MINUTES } from "./constants";
import type { ApiKeyEntry, ConfiguredModel } from "./types";
import {
  buildSettingsVoiceItems,
  clampMlxKeepAliveMinutes,
  groupByProvider,
} from "./utils";

// Query keys for the models page. `["models", ...]` is a family so a single
// invalidate refreshes both available + configured.
const MODELS_KEYS = {
  available: ["models", "available"] as const,
  configured: ["models", "configured"] as const,
  keys: ["api-keys"] as const,
  settings: SETTINGS_QUERY_KEY,
  whisper: ["whisper-status"] as const,
  mlx: ["mlx-status"] as const,
  starling: ["starling-status"] as const,
};

// Stable empty fallbacks so derived useMemo deps don't change identity while a
// query is still loading.
const EMPTY_AVAILABLE: AvailableModel[] = [];
const EMPTY_CONFIGURED: ConfiguredModel[] = [];
const EMPTY_KEYS: ApiKeyEntry[] = [];

export interface LocalLlmState {
  url: string;
  setUrl: (v: string) => void;
  apiKey: string;
  setApiKey: (v: string) => void;
  testing: boolean;
  connected: boolean | null;
  error: string | null;
  models: string[];
  test: () => Promise<void>;
  clearStatus: () => void;
}

export interface UseModels {
  loading: boolean;
  available: AvailableModel[];
  configured: ConfiguredModel[];
  apiKeys: ApiKeyEntry[];
  whisperStatus: WhisperStatus | null;
  mlxStatus: null;
  starlingStatus: StarlingStatus | null;
  llmCleanup: boolean;
  /** True once the editable form state has been seeded from persisted settings. */
  settingsSeeded: boolean;
  mlxKeepAliveMinutes: number;

  /** Local models with an in-flight delete, keyed `${engine ?? "whisper"}:${defId}`. */
  deletingKeys: Set<string>;
  /** Providers with an in-flight key/model delete. */
  deletingProviders: Set<string>;

  // Derived
  keyProviders: Set<string>;
  defaultVoice: ConfiguredModel | undefined;
  defaultLlm: ConfiguredModel | undefined;
  voiceItems: VoiceItem[];
  llmModelsByProvider: Map<
    string,
    { providerName: string; models: AvailableModel[] }
  >;

  localLlm: LocalLlmState;

  // Actions — each refetches as needed
  configureModel: (
    model: AvailableModel,
    type: "voice" | "llm",
  ) => Promise<void>;
  saveKey: (provider: string, key: string) => Promise<string | null>;
  selectLocalVoice: (
    defId: string,
    name: string,
    engine?: "whisper" | "mlx",
  ) => Promise<void>;
  retryLocalMlx: (defId: string) => Promise<void>;
  downloadLocal: (defId: string, engine?: "whisper" | "mlx") => void;
  downloadStarling: (modelId: string) => void;
  cancelLocal: (defId: string, engine?: "whisper" | "mlx") => void;
  deleteLocal: (defId: string, engine?: "whisper" | "mlx") => Promise<void>;
  selectLocalLlmModel: (modelName: string) => Promise<void>;
  setCleanup: (next: boolean) => void;
  saveMlxKeepAliveMinutes: (minutes: number) => void;
  deleteProvider: (provider: string) => Promise<void>;
  reload: () => Promise<void>;
}

export function useModels(): UseModels {
  const queryClient = useQueryClient();

  // -------------------------------------------------------------------------
  // Server data (React Query)
  // -------------------------------------------------------------------------

  const availableQuery = useQuery({
    queryKey: MODELS_KEYS.available,
    queryFn: async () => {
      const res = await getClient().api.models.available.$get();
      if (!res.ok) throw new Error("Failed to load available models");
      return (await res.json()) as AvailableModel[];
    },
  });

  const configuredQuery = useQuery({
    queryKey: MODELS_KEYS.configured,
    queryFn: async () => {
      const res = await getClient().api.models.configured.$get();
      if (!res.ok) throw new Error("Failed to load configured models");
      return (await res.json()) as ConfiguredModel[];
    },
  });

  const keysQuery = useQuery({
    queryKey: MODELS_KEYS.keys,
    queryFn: async () => {
      const res = await getClient().api.keys.$get();
      if (!res.ok) throw new Error("Failed to load API keys");
      return (await res.json()) as ApiKeyEntry[];
    },
  });

  const settingsQuery = useQuery(settingsQueryOptions());

  const whisperQuery = useQuery({
    queryKey: MODELS_KEYS.whisper,
    enabled: false,
    queryFn: async (): Promise<WhisperStatus | null> => null,
  });
  const starlingQuery = useQuery({
    queryKey: MODELS_KEYS.starling,
    queryFn: async (): Promise<StarlingStatus> => {
      const response = await fetch(`${getApiBase()}/api/starling/status`);
      if (!response.ok) throw new Error("Failed to load Starling status");
      return response.json() as Promise<StarlingStatus>;
    },
    refetchInterval: (query) =>
      Object.values(query.state.data?.modelDownloads ?? {}).some(
        (model) => model.downloading,
      )
        ? 1_000
        : false,
  });

  const available = availableQuery.data ?? EMPTY_AVAILABLE;
  const configured = configuredQuery.data ?? EMPTY_CONFIGURED;
  const apiKeys = keysQuery.data ?? EMPTY_KEYS;
  const whisperStatus = whisperQuery.data ?? null;
  const mlxStatus = null;
  const starlingStatus = starlingQuery.data ?? null;
  const loading =
    availableQuery.isLoading ||
    configuredQuery.isLoading ||
    keysQuery.isLoading ||
    settingsQuery.isLoading;

  // -------------------------------------------------------------------------
  // Editable form state (seeded from persisted settings)
  // -------------------------------------------------------------------------

  const [llmCleanup, setLlmCleanup] = useState(false);
  const [mlxKeepAliveMinutes, setMlxKeepAliveMinutes] = useState(
    DEFAULT_MLX_KEEP_ALIVE_MINUTES,
  );

  // In-flight deletes — drive spinners on the delete buttons since deletion has
  // no server-reported status the way downloads do.
  const [deletingKeys] = useState<Set<string>>(new Set());
  const [deletingProviders, setDeletingProviders] = useState<Set<string>>(
    new Set(),
  );

  // Local LLM (Ollama / LM Studio) connection — simplified inline form state.
  const [localUrl, setLocalUrl] = useState("http://localhost:11434");
  const [localApiKey, setLocalApiKey] = useState("");
  const [localTesting, setLocalTesting] = useState(false);
  const [localConnected, setLocalConnected] = useState<boolean | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [localModels, setLocalModels] = useState<string[]>([]);

  // Seed editable state from persisted settings once, when the settings query
  // first resolves. Mutations update this local state directly, so we don't
  // re-seed on later invalidations (which would clobber in-progress edits).
  // keepAlive falls back to the MLX status report when the setting is unset.
  // `settingsSeeded` is state (not a ref) so consumers can wait for the seed
  // before acting on `llmCleanup` — reading it too early sees the initial
  // `false` and can trigger spurious re-configuration.
  const [settingsSeeded, setSettingsSeeded] = useState(false);
  const seededRef = useRef({ keepAlive: false });
  useEffect(() => {
    const s = settingsQuery.data;
    if (!s || settingsSeeded) return;
    setSettingsSeeded(true);
    const cleanup = s[SETTINGS_KEYS.llmCleanup];
    if (cleanup) setLlmCleanup(cleanup === "true");
    const url = s[SETTINGS_KEYS.localLlmUrl];
    if (url) setLocalUrl(url);
    const key = s[SETTINGS_KEYS.localLlmApiKey];
    if (key) setLocalApiKey(key);
    const rawMinutes = s[SETTINGS_KEYS.mlxAsrKeepAliveMinutes];
    if (rawMinutes) {
      const minutes = Number(rawMinutes);
      if (Number.isFinite(minutes)) {
        seededRef.current.keepAlive = true;
        setMlxKeepAliveMinutes(clampMlxKeepAliveMinutes(minutes));
      }
    }
  }, [settingsQuery.data, settingsSeeded]);

  // -------------------------------------------------------------------------
  // Reloaders (invalidate the relevant queries; polling is driven by
  // refetchInterval on the whisper/mlx queries above)
  // -------------------------------------------------------------------------

  const reload = useCallback(async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["models"] }),
      queryClient.invalidateQueries({ queryKey: MODELS_KEYS.keys }),
      queryClient.invalidateQueries({ queryKey: MODELS_KEYS.settings }),
      queryClient.invalidateQueries({ queryKey: MODELS_KEYS.starling }),
    ]);
  }, [queryClient]);
  const loadData = reload;

  // When an active download/verify transitions to done, refresh the model
  // lists (a freshly downloaded local model becomes selectable).
  // -------------------------------------------------------------------------
  // Derived state
  // -------------------------------------------------------------------------

  const keyProviders = useMemo(
    () => new Set(apiKeys.map((k) => k.provider)),
    [apiKeys],
  );
  const defaultVoice = useMemo(
    () => configured.find((m) => m.type === "voice" && m.is_default === 1),
    [configured],
  );
  const defaultLlm = useMemo(
    () => configured.find((m) => m.type === "llm" && m.is_default === 1),
    [configured],
  );
  const llmModelsByProvider = useMemo(
    () => groupByProvider(available, "llm"),
    [available],
  );
  const voiceItems = useMemo(
    () =>
      buildSettingsVoiceItems(available, whisperStatus, mlxStatus, {
        defaultVoice,
        keyProviders,
      }),
    [available, whisperStatus, defaultVoice, keyProviders],
  );

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  const configureModel = useCallback(
    async (model: AvailableModel, type: "voice" | "llm") => {
      await getClient().api.models.configured.$post({
        json: {
          provider: model.provider_id,
          model_id: model.model_id,
          model_name: model.model_name,
          type,
          is_default: true,
        },
      });
      await loadData();
    },
    [loadData],
  );

  // Validate, then persist. Returns an error string, or null on success.
  const saveKey = useCallback(
    async (provider: string, key: string): Promise<string | null> => {
      try {
        const client = getClient();
        const valRes = await client.api.keys.validate.$post({
          json: { provider, key },
        });
        if (valRes.ok) {
          const body = await valRes.json();
          if ("valid" in body && body.valid === false) {
            return (
              ("error" in body && typeof body.error === "string"
                ? body.error
                : null) ?? "API key is not valid."
            );
          }
        }
        await client.api.keys.$post({ json: { provider, key } });
        await loadData();
        return null;
      } catch {
        return "Failed to validate key. Please try again.";
      }
    },
    [loadData],
  );

  const selectLocalVoice = useCallback(
    async (defId: string, name: string, engine?: "whisper" | "mlx") => {
      void engine;
      const provider = "local-starling";
      await getClient().api.models.configured.$post({
        json: {
          provider,
          model_id: `${provider}/${defId}`,
          model_name: name,
          type: "voice",
          is_default: true,
        },
      });
      getClient()
        .api.starling.server.start.$post({ json: { modelId: defId } })
        .catch(() => {});
      await loadData();
    },
    [loadData],
  );

  const downloadLocal = useCallback(
    (defId: string, engine?: "whisper" | "mlx") => {
      void defId;
      void engine;
    },
    [],
  );

  const downloadStarling = useCallback(
    (defId: string) => {
      void fetch(`${getApiBase()}/api/starling/models/${defId}/download`, {
        method: "POST",
      }).then(() =>
        queryClient.invalidateQueries({ queryKey: MODELS_KEYS.starling }),
      );
    },
    [queryClient],
  );

  const cancelLocal = useCallback(
    (defId: string, engine?: "whisper" | "mlx") => {
      void defId;
      void engine;
    },
    [],
  );

  const deleteLocal = useCallback(
    async (defId: string, engine?: "whisper" | "mlx") => {
      void defId;
      void engine;
    },
    [],
  );

  const retryLocalMlx = useCallback(async (defId: string) => {
    void defId;
  }, []);

  const selectLocalLlmModel = useCallback(
    async (modelName: string) => {
      await getClient().api.models.configured.$post({
        json: {
          provider: "local-llm",
          model_id: `local-llm/${modelName}`,
          model_name: modelName,
          type: "llm",
          is_default: true,
        },
      });
      await loadData();
    },
    [loadData],
  );

  const setCleanup = useCallback((next: boolean) => {
    setLlmCleanup(next);
    getClient()
      .api.settings[":key"].$put({
        param: { key: SETTINGS_KEYS.llmCleanup },
        json: { value: String(next) },
      })
      .catch((err) => console.error("Failed to save LLM cleanup:", err));
  }, []);

  // Persist the MLX keep-alive window. At 0 ("cold start") also stop the
  // running server so the model unloads immediately.
  const saveMlxKeepAliveMinutes = useCallback((minutes: number) => {
    const next = clampMlxKeepAliveMinutes(minutes);
    setMlxKeepAliveMinutes(next);
    getClient()
      .api.settings[":key"].$put({
        param: { key: SETTINGS_KEYS.mlxAsrKeepAliveMinutes },
        json: { value: String(next) },
      })
      .catch((err) => console.error("Failed to save MLX ASR keep-alive:", err));
  }, []);

  const deleteProvider = useCallback(
    async (provider: string) => {
      setDeletingProviders((prev) => new Set(prev).add(provider));
      try {
        const client = getClient();
        await client.api.keys[":provider"].$delete({ param: { provider } });
        const providerModels = configured.filter(
          (m) => m.provider === provider,
        );
        await Promise.all(
          providerModels.map((m) =>
            client.api.models.configured[":id"].$delete({
              param: { id: String(m.id) },
            }),
          ),
        );
        await loadData();
      } finally {
        setDeletingProviders((prev) => {
          const next = new Set(prev);
          next.delete(provider);
          return next;
        });
      }
    },
    [configured, loadData],
  );

  // -------------------------------------------------------------------------
  // Local LLM connection test
  // -------------------------------------------------------------------------

  const clearLocalStatus = useCallback(() => {
    setLocalConnected(null);
    setLocalError(null);
  }, []);

  const testLocalLlm = useCallback(async () => {
    setLocalTesting(true);
    setLocalConnected(null);
    setLocalError(null);
    try {
      const url = localUrl.replace(/\/+$/, "");
      const key = localApiKey.trim();
      const client = getClient();
      await Promise.all([
        client.api.settings[":key"].$put({
          param: { key: SETTINGS_KEYS.localLlmUrl },
          json: { value: url },
        }),
        key
          ? client.api.settings[":key"].$put({
              param: { key: SETTINGS_KEYS.localLlmApiKey },
              json: { value: key },
            })
          : client.api.settings[":key"].$delete({
              param: { key: SETTINGS_KEYS.localLlmApiKey },
            }),
      ]);

      const res = await client.api.settings["local-llm"].test.$post({
        json: { url, api_key: key || undefined },
      });

      if (res.ok) {
        const result = await res.json();
        if ("ok" in result && result.ok) {
          setLocalConnected(true);
          setLocalModels(result.models ?? []);
          await loadData();
          return;
        }
        setLocalConnected(false);
        setLocalError(
          "error" in result && typeof result.error === "string"
            ? result.error
            : "Connection failed",
        );
        return;
      }
      setLocalConnected(false);
      setLocalError(`HTTP ${res.status}`);
    } catch (err) {
      setLocalConnected(false);
      setLocalError(err instanceof Error ? err.message : "Connection failed");
    } finally {
      setLocalTesting(false);
    }
  }, [localUrl, localApiKey, loadData]);

  return {
    loading,
    available,
    configured,
    apiKeys,
    whisperStatus,
    mlxStatus,
    starlingStatus,
    llmCleanup,
    settingsSeeded,
    mlxKeepAliveMinutes,
    deletingKeys,
    deletingProviders,
    keyProviders,
    defaultVoice,
    defaultLlm,
    voiceItems,
    llmModelsByProvider,
    localLlm: {
      url: localUrl,
      setUrl: setLocalUrl,
      apiKey: localApiKey,
      setApiKey: setLocalApiKey,
      testing: localTesting,
      connected: localConnected,
      error: localError,
      models: localModels,
      test: testLocalLlm,
      clearStatus: clearLocalStatus,
    },
    configureModel,
    saveKey,
    selectLocalVoice,
    retryLocalMlx,
    downloadLocal,
    downloadStarling,
    cancelLocal,
    deleteLocal,
    selectLocalLlmModel,
    setCleanup,
    saveMlxKeepAliveMinutes,
    deleteProvider,
    reload: loadData,
  };
}
