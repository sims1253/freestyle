import { Button } from "@renderer/components/ui/button";
import { getApiBase } from "@renderer/lib/api";
import { useEffect, useState } from "react";

export function StarlingSettingsDialog({
  onClose,
}: {
  onClose: () => void;
}): React.JSX.Element {
  const [values, setValues] = useState<Record<string, string>>({
    starling_binary_path: "",
    starling_gguf_dir: "",
    starling_quant: "q8_0",
    starling_host: "127.0.0.1",
    starling_port: "8181",
    starling_keep_alive_minutes: "10",
    starling_keep_loaded: "true",
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [runtimeError, setRuntimeError] = useState<string | null>(null);
  const [external, setExternal] = useState(false);
  useEffect(() => {
    void fetch(`${getApiBase()}/api/settings`)
      .then((response) => response.json())
      .then((saved: Record<string, string>) =>
        setValues((current) => ({ ...current, ...saved })),
      )
      .catch(() => setError("Could not load Starling settings."));
    void fetch(`${getApiBase()}/api/starling/status`)
      .then((response) => response.json())
      .then(
        (status: {
          blockedReason?: string | null;
          startError?: string | null;
          external?: boolean;
        }) => {
          setRuntimeError(status.blockedReason ?? status.startError ?? null);
          setExternal(status.external === true);
        },
      )
      .catch(() => {});
  }, []);
  const save = async (): Promise<void> => {
    setSaving(true);
    setError(null);
    try {
      await Promise.all(
        Object.entries(values).map(async ([key, value]) => {
          const response = await fetch(`${getApiBase()}/api/settings/${key}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ value }),
          });
          if (!response.ok) throw new Error();
        }),
      );
      onClose();
    } catch {
      setError("Could not save Starling settings.");
    } finally {
      setSaving(false);
    }
  };
  const input = (
    key: string,
    label: string,
    placeholder: string,
  ): React.JSX.Element => (
    <label className="grid gap-1.5 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <input
        value={values[key] ?? ""}
        placeholder={placeholder}
        onChange={(event) =>
          setValues((current) => ({ ...current, [key]: event.target.value }))
        }
        className="border-border bg-background rounded-md border px-3 py-2"
      />
    </label>
  );
  const keepLoaded = values.starling_keep_loaded !== "false";
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <section
        role="dialog"
        aria-modal="true"
        aria-label="Starling settings"
        className="border-border bg-card w-full max-w-lg rounded-[14px] border p-6 shadow-2xl"
      >
        <p className="mono text-muted-foreground text-[10px] tracking-[0.16em] uppercase">
          Local Starling
        </p>
        <h2 className="mt-2 text-lg font-semibold">Starling runtime</h2>
        <p className="text-muted-foreground mt-1 text-sm">
          Configure the native <code>starling-serve</code> binary and model
          files. Leave paths empty for automatic management.
        </p>
        <div className="mt-5 grid gap-3">
          {input(
            "starling_binary_path",
            "starling-serve binary (optional)",
            "Auto-managed",
          )}
          {input(
            "starling_gguf_dir",
            "GGUF model directory (optional)",
            "Auto-managed",
          )}
          <label className="grid gap-1.5 text-sm">
            <span className="text-muted-foreground">Quantization</span>
            <select
              value={values.starling_quant ?? "q8_0"}
              onChange={(event) =>
                setValues((current) => ({
                  ...current,
                  starling_quant: event.target.value,
                }))
              }
              className="border-border bg-background rounded-md border px-3 py-2"
            >
              <option value="q8_0">q8_0 (smaller, recommended)</option>
              <option value="bf16-exact">bf16-exact (highest accuracy)</option>
            </select>
          </label>
          {input("starling_host", "Host", "127.0.0.1")}
          {input("starling_port", "Port", "8181")}
          <label className="flex items-center justify-between gap-3 text-sm">
            <span>
              <span className="text-muted-foreground block">
                Keep model loaded in VRAM
              </span>
              <span className="text-muted-foreground/75 block text-xs">
                Avoids cold starts between dictations.
              </span>
            </span>
            <input
              type="checkbox"
              checked={keepLoaded}
              onChange={(event) =>
                setValues((current) => ({
                  ...current,
                  starling_keep_loaded: String(event.target.checked),
                }))
              }
            />
          </label>
          {!keepLoaded &&
            input("starling_keep_alive_minutes", "Keep alive (minutes)", "10")}
        </div>
        {runtimeError && (
          <p className="border-destructive/30 bg-destructive/10 mt-4 rounded-md border px-3 py-2 text-sm text-destructive">
            {runtimeError}
          </p>
        )}
        {external && (
          <p className="border-border bg-muted mt-4 rounded-md border px-3 py-2 text-sm">
            Using externally started server
          </p>
        )}
        {error && <p className="mt-3 text-sm text-destructive">{error}</p>}
        <div className="mt-6 flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => void save()} disabled={saving}>
            {saving ? "Saving…" : "Save settings"}
          </Button>
        </div>
      </section>
    </div>
  );
}
