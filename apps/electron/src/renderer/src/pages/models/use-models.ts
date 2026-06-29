import { getClient } from "@renderer/lib/api";
import type {
  AvailableModel,
  MlxAsrStatus,
  ParakeetStatus,
  StarlingStatus,
  VoiceItem,
  WhisperStatus,
} from "@renderer/lib/models";
import { useCallback, useEffect, useState } from "react";

import { DEFAULT_MLX_KEEP_ALIVE_MINUTES } from "./constants";
import type { ApiKeyEntry, ConfiguredModel } from "./types";
import {
  buildSettingsVoiceItems,
  clampMlxKeepAliveMinutes,
  groupByProvider,
} from "./utils";

const IS_MAC =
  typeof navigator !== "undefined" && navigator.userAgent.includes("Mac");

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
  mlxStatus: MlxAsrStatus | null;
  parakeetStatus: ParakeetStatus | null;
  starlingStatus: StarlingStatus | null;
  llmCleanup: boolean;
  mlxKeepAliveMinutes: number;

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

  loadData: () => Promise<void>;

  // Actions — each refetches as needed
  configureModel: (
    model: AvailableModel,
    type: "voice" | "llm",
  ) => Promise<void>;
  saveKey: (provider: string, key: string) => Promise<string | null>;
  selectLocalVoice: (
    defId: string,
    name: string,
    engine?: "whisper" | "mlx" | "parakeet" | "starling",
  ) => Promise<void>;
  retryLocalMlx: (defId: string) => Promise<void>;
  downloadLocal: (
    defId: string,
    engine?: "whisper" | "mlx" | "parakeet" | "starling",
  ) => void;
  cancelLocal: (
    defId: string,
    engine?: "whisper" | "mlx" | "parakeet" | "starling",
  ) => void;
  deleteLocal: (
    defId: string,
    engine?: "whisper" | "mlx" | "parakeet" | "starling",
  ) => Promise<void>;
  selectLocalLlmModel: (modelName: string) => Promise<void>;
  setCleanup: (next: boolean) => void;
  saveMlxKeepAliveMinutes: (minutes: number) => void;
  saveParakeetBackend: (backend: string) => void;
  saveStarlingSetting: (key: string, value: string) => void;
  deleteProvider: (provider: string) => Promise<void>;
}

export function useModels(): UseModels {
  const [available, setAvailable] = useState<AvailableModel[]>([]);
  const [configured, setConfigured] = useState<ConfiguredModel[]>([]);
  const [apiKeys, setApiKeys] = useState<ApiKeyEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [llmCleanup, setLlmCleanup] = useState(false);

  const [whisperStatus, setWhisperStatus] = useState<WhisperStatus | null>(
    null,
  );
  const [mlxStatus, setMlxStatus] = useState<MlxAsrStatus | null>(null);
  const [parakeetStatus, setParakeetStatus] = useState<ParakeetStatus | null>(
    null,
  );
  const [starlingStatus, setStarlingStatus] = useState<StarlingStatus | null>(
    null,
  );
  const [mlxKeepAliveMinutes, setMlxKeepAliveMinutes] = useState(
    DEFAULT_MLX_KEEP_ALIVE_MINUTES,
  );

  // Local LLM (Ollama / LM Studio) connection — simplified inline form state.
  const [localUrl, setLocalUrl] = useState("http://localhost:11434");
  const [localApiKey, setLocalApiKey] = useState("");
  const [localTesting, setLocalTesting] = useState(false);
  const [localConnected, setLocalConnected] = useState<boolean | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [localModels, setLocalModels] = useState<string[]>([]);

  // -------------------------------------------------------------------------
  // Loaders
  // -------------------------------------------------------------------------

  const loadData = useCallback(async () => {
    try {
      const client = getClient();
      const [
        availRes,
        configRes,
        keysRes,
        cleanupRes,
        localUrlRes,
        localKeyRes,
        mlxKeepAliveRes,
      ] = await Promise.all([
        client.api.models.available.$get(),
        client.api.models.configured.$get(),
        client.api.keys.$get(),
        client.api.settings[":key"].$get({ param: { key: "llm_cleanup" } }),
        client.api.settings[":key"].$get({ param: { key: "local_llm_url" } }),
        client.api.settings[":key"].$get({
          param: { key: "local_llm_api_key" },
        }),
        client.api.settings[":key"].$get({
          param: { key: "mlx_asr_keep_alive_minutes" },
        }),
      ]);
      if (availRes.ok) setAvailable(await availRes.json());
      if (configRes.ok) setConfigured(await configRes.json());
      if (keysRes.ok) setApiKeys((await keysRes.json()) as ApiKeyEntry[]);
      if (cleanupRes.ok) {
        const data = await cleanupRes.json();
        if ("value" in data && data.value) setLlmCleanup(data.value === "true");
      }
      if (localUrlRes.ok) {
        const data = await localUrlRes.json();
        if ("value" in data && data.value) setLocalUrl(data.value);
      }
      if (localKeyRes.ok) {
        const data = await localKeyRes.json();
        if ("value" in data && data.value) setLocalApiKey(data.value);
      }
      if (mlxKeepAliveRes.ok) {
        const data = await mlxKeepAliveRes.json();
        const minutes = "value" in data ? Number(data.value) : Number.NaN;
        if (Number.isFinite(minutes)) {
          setMlxKeepAliveMinutes(clampMlxKeepAliveMinutes(minutes));
        }
      }
    } catch (err) {
      console.error("Failed to load models data:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  const loadWhisperStatus = useCallback(async () => {
    try {
      const res = await getClient().api.whisper.status.$get();
      if (res.ok) {
        const data: WhisperStatus = await res.json();
        setWhisperStatus(data);
        return data;
      }
    } catch (err) {
      console.error("Failed to load whisper status:", err);
    }
    return null;
  }, []);

  const loadMlxStatus = useCallback(async (refresh = false) => {
    try {
      const res = refresh
        ? await getClient().api["mlx-asr"].status.$get({
            query: { refresh: "1" },
          })
        : await getClient().api["mlx-asr"].status.$get();
      if (res.ok) {
        const data: MlxAsrStatus = await res.json();
        setMlxStatus(data);
        if (Number.isFinite(data.keepAliveMinutes)) {
          setMlxKeepAliveMinutes(
            clampMlxKeepAliveMinutes(data.keepAliveMinutes),
          );
        }
        return data;
      }
    } catch (err) {
      console.error("Failed to load MLX ASR status:", err);
    }
    return null;
  }, []);

  const loadParakeetStatus = useCallback(async () => {
    try {
      const res = await getClient().api.parakeet.status.$get();
      if (res.ok) {
        const data: ParakeetStatus = await res.json();
        setParakeetStatus(data);
        return data;
      }
    } catch (err) {
      console.error("Failed to load parakeet status:", err);
    }
    return null;
  }, []);

  const loadStarlingStatus = useCallback(async () => {
    try {
      const res = await getClient().api.starling.status.$get();
      if (res.ok) {
        const data: StarlingStatus = await res.json();
        setStarlingStatus(data);
        return data;
      }
    } catch (err) {
      console.error("Failed to load starling status:", err);
    }
    return null;
  }, []);

  useEffect(() => {
    loadData();
    loadWhisperStatus();
    loadParakeetStatus();
    loadStarlingStatus();
    if (IS_MAC) loadMlxStatus();
  }, [
    loadData,
    loadWhisperStatus,
    loadParakeetStatus,
    loadStarlingStatus,
    loadMlxStatus,
  ]);

  // Poll whisper status while a download is active.
  useEffect(() => {
    const active =
      whisperStatus?.binaryDownloading ||
      whisperStatus?.models.some(
        (m) => m.status === "downloading" || m.status === "verifying",
      );
    if (!active) return;
    const interval = setInterval(() => {
      loadWhisperStatus().then((data) => {
        if (
          data &&
          !data.binaryDownloading &&
          !data.models.some(
            (m) => m.status === "downloading" || m.status === "verifying",
          )
        ) {
          loadData();
        }
      });
    }, 500);
    return () => clearInterval(interval);
  }, [whisperStatus, loadWhisperStatus, loadData]);

  // Poll MLX status while a download is active.
  useEffect(() => {
    const active = mlxStatus?.models?.some(
      (m) => m.status === "downloading" || m.status === "verifying",
    );
    if (!active) return;
    const interval = setInterval(() => {
      loadMlxStatus().then((data) => {
        if (
          data &&
          !data.models?.some(
            (m) => m.status === "downloading" || m.status === "verifying",
          )
        ) {
          loadData();
        }
      });
    }, 500);
    return () => clearInterval(interval);
  }, [mlxStatus, loadMlxStatus, loadData]);

  // Poll parakeet status while a download is active.
  useEffect(() => {
    const active =
      parakeetStatus?.binaryDownloading ||
      parakeetStatus?.models?.some(
        (m) => m.status === "downloading" || m.status === "verifying",
      );
    if (!active) return;
    const interval = setInterval(() => {
      loadParakeetStatus().then((data) => {
        if (
          data &&
          !data.binaryDownloading &&
          !data.models?.some(
            (m) => m.status === "downloading" || m.status === "verifying",
          )
        ) {
          loadData();
        }
      });
    }, 500);
    return () => clearInterval(interval);
  }, [parakeetStatus, loadParakeetStatus, loadData]);

  // -------------------------------------------------------------------------
  // Derived state
  // -------------------------------------------------------------------------

  const keyProviders = new Set(apiKeys.map((k) => k.provider));
  const defaultVoice = configured.find(
    (m) => m.type === "voice" && m.is_default === 1,
  );
  const defaultLlm = configured.find(
    (m) => m.type === "llm" && m.is_default === 1,
  );
  const llmModelsByProvider = groupByProvider(available, "llm");
  const voiceItems = buildSettingsVoiceItems(
    available,
    whisperStatus,
    mlxStatus,
    parakeetStatus,
    starlingStatus,
    {
      defaultVoice,
      keyProviders,
    },
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
    async (
      defId: string,
      name: string,
      engine?: "whisper" | "mlx" | "parakeet" | "starling",
    ) => {
      const provider =
        engine === "mlx"
          ? "local-mlx"
          : engine === "parakeet"
            ? "local-parakeet"
            : engine === "starling"
              ? "local-starling"
              : "local-whisper";
      await getClient().api.models.configured.$post({
        json: {
          provider,
          model_id: `${provider}/${defId}`,
          model_name: name,
          type: "voice",
          is_default: true,
        },
      });
      if (engine === "mlx") {
        getClient()
          .api["mlx-asr"].server.start.$post({ json: { modelId: defId } })
          .catch(() => {});
      } else if (engine === "parakeet") {
        getClient()
          .api.parakeet.server.start.$post({ json: { modelId: defId } })
          .catch(() => {});
      } else if (engine === "starling") {
        getClient()
          .api.starling.server.start.$post({ json: { modelId: defId } })
          .catch(() => {});
      } else {
        getClient()
          .api.whisper.server.start.$post({ json: { modelId: defId } })
          .catch(() => {});
      }
      await loadData();
    },
    [loadData],
  );

  const downloadLocal = useCallback(
    (defId: string, engine?: "whisper" | "mlx" | "parakeet" | "starling") => {
      if (engine === "mlx") {
        void getClient()
          .api["mlx-asr"].models[":model"].download.$post({
            param: { model: defId },
          })
          .then(() => loadMlxStatus());
      } else if (engine === "parakeet") {
        void getClient()
          .api.parakeet.models[":model"].download.$post({
            param: { model: defId },
          })
          .then(() => loadParakeetStatus());
      } else if (engine === "starling") {
        // Starling has no weights download — "download" starts/loads the server.
        void getClient()
          .api.starling.models[":model"].download.$post({
            param: { model: defId },
          })
          .then(() => loadStarlingStatus());
      } else {
        void getClient()
          .api.whisper.models[":model"].download.$post({
            param: { model: defId },
          })
          .then(() => loadWhisperStatus());
      }
    },
    [loadMlxStatus, loadWhisperStatus, loadParakeetStatus, loadStarlingStatus],
  );

  const cancelLocal = useCallback(
    (defId: string, engine?: "whisper" | "mlx" | "parakeet" | "starling") => {
      if (engine === "mlx") {
        void getClient()
          .api["mlx-asr"].models[":model"].cancel.$post({
            param: { model: defId },
          })
          .then(() => loadMlxStatus());
      } else if (engine === "parakeet") {
        void getClient()
          .api.parakeet.models[":model"].cancel.$post({
            param: { model: defId },
          })
          .then(() => loadParakeetStatus());
      } else if (engine === "starling") {
        void getClient()
          .api.starling.models[":model"].cancel.$post({
            param: { model: defId },
          })
          .then(() => loadStarlingStatus());
      } else {
        void getClient()
          .api.whisper.models[":model"].cancel.$post({
            param: { model: defId },
          })
          .then(() => loadWhisperStatus());
      }
    },
    [loadMlxStatus, loadWhisperStatus, loadParakeetStatus, loadStarlingStatus],
  );

  const deleteLocal = useCallback(
    async (
      defId: string,
      engine?: "whisper" | "mlx" | "parakeet" | "starling",
    ) => {
      if (engine === "mlx") {
        await getClient().api["mlx-asr"].models[":model"].$delete({
          param: { model: defId },
        });
        await loadMlxStatus();
      } else if (engine === "parakeet") {
        await getClient().api.parakeet.models[":model"].$delete({
          param: { model: defId },
        });
        await loadParakeetStatus();
      } else if (engine === "starling") {
        await getClient().api.starling.models[":model"].$delete({
          param: { model: defId },
        });
        await loadStarlingStatus();
      } else {
        await getClient().api.whisper.models[":model"].$delete({
          param: { model: defId },
        });
        await loadWhisperStatus();
      }
      await loadData();
    },
    [
      loadMlxStatus,
      loadWhisperStatus,
      loadParakeetStatus,
      loadStarlingStatus,
      loadData,
    ],
  );

  const retryLocalMlx = useCallback(
    async (defId: string) => {
      const data = await loadMlxStatus(true);
      if (!data?.canRun) return;
      const status = data.models?.find((m) => m.model === defId);
      if (status?.status !== "ready") {
        downloadLocal(defId, "mlx");
        return;
      }
      const name =
        data.modelDefinitions.find((m) => m.id === defId)?.displayName ?? defId;
      await selectLocalVoice(defId, name, "mlx");
    },
    [loadMlxStatus, downloadLocal, selectLocalVoice],
  );

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
        param: { key: "llm_cleanup" },
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
        param: { key: "mlx_asr_keep_alive_minutes" },
        json: { value: String(next) },
      })
      .then(() => {
        if (next !== 0) return;
        return getClient().api["mlx-asr"].server.stop.$post();
      })
      .catch((err) => console.error("Failed to save MLX ASR keep-alive:", err));
  }, []);

  // Persist the parakeet compute backend. CPU is a runtime device override
  // against the existing binary (no download); other GPU backends trigger a
  // binary download when the installed backend doesn't already match.
  const saveParakeetBackend = useCallback(
    (backend: string) => {
      const client = getClient();
      client.api.settings[":key"]
        .$put({
          param: { key: "parakeet_compute_backend" },
          json: { value: backend },
        })
        .then(() => {
          // Optimistically refresh status so the picker reflects the new value.
          loadParakeetStatus();
          if (backend === "cpu" || backend === "auto") return;
          const installed = parakeetStatus?.installedBackend;
          if (installed && installed === backend) return;
          // Fire-and-forget: progress is surfaced via status polling.
          client.api.parakeet.binary.download
            .$post({ json: { backend } })
            .then(() => loadParakeetStatus())
            .catch((err) =>
              console.error("Failed to download parakeet backend:", err),
            );
        })
        .catch((err) => console.error("Failed to save parakeet backend:", err));
    },
    [loadParakeetStatus, parakeetStatus],
  );

  // Persist an arbitrary starling setting key (python path, source path,
  // host, port, keep-alive, streaming tunables) via the generic settings route.
  const saveStarlingSetting = useCallback(
    (key: string, value: string) => {
      getClient()
        .api.settings[":key"].$put({
          param: { key },
          json: { value },
        })
        .then(() => loadStarlingStatus())
        .catch((err) => console.error("Failed to save starling setting:", err));
    },
    [loadStarlingStatus],
  );

  const deleteProvider = useCallback(
    async (provider: string) => {
      const client = getClient();
      await client.api.keys[":provider"].$delete({ param: { provider } });
      const providerModels = configured.filter((m) => m.provider === provider);
      await Promise.all(
        providerModels.map((m) =>
          client.api.models.configured[":id"].$delete({
            param: { id: String(m.id) },
          }),
        ),
      );
      await loadData();
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
          param: { key: "local_llm_url" },
          json: { value: url },
        }),
        key
          ? client.api.settings[":key"].$put({
              param: { key: "local_llm_api_key" },
              json: { value: key },
            })
          : client.api.settings[":key"].$delete({
              param: { key: "local_llm_api_key" },
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
    parakeetStatus,
    starlingStatus,
    llmCleanup,
    mlxKeepAliveMinutes,
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
    loadData,
    configureModel,
    saveKey,
    selectLocalVoice,
    retryLocalMlx,
    downloadLocal,
    cancelLocal,
    deleteLocal,
    selectLocalLlmModel,
    setCleanup,
    saveMlxKeepAliveMinutes,
    saveParakeetBackend,
    saveStarlingSetting,
    deleteProvider,
  };
}
