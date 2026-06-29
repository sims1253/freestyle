import { Cpu } from "lucide-react";
import { useState } from "react";

import type { StarlingStatus } from "../../lib/models";

const MAX_KEEP_ALIVE_MINUTES = 10;

function keepAliveDescription(minutes: number): string {
  if (minutes === 0) {
    return "Stop the starling server after each transcription. Saves VRAM, but the next dictation waits for a full model reload + CUDA-graph warmup.";
  }
  if (minutes === 1) {
    return "Keep the starling server alive for about 1 minute after dictation, so quick follow-ups stay fast.";
  }
  return `Keep the starling server alive for up to ${minutes} minutes after dictation. Faster repeat use, more VRAM while warm.`;
}

// ---------------------------------------------------------------------------
// StarlingSettingsDialog — configure python path, source path, host/port,
// keep-alive, and the semi-online chunking tunables.
// ---------------------------------------------------------------------------

export function StarlingSettingsDialog({
  status,
  onSaveSetting,
  onClose,
}: {
  status: StarlingStatus;
  onSaveSetting: (key: string, value: string) => void;
  onClose: () => void;
}): React.JSX.Element {
  const [pythonPath, setPythonPath] = useState(
    status.configuredPythonPath ?? "",
  );
  const [sourcePath, setSourcePath] = useState(status.sourcePath ?? "");
  const [host, setHost] = useState(status.host);
  const [port, setPort] = useState(String(status.port));
  const [keepAliveMinutes, setKeepAliveMinutes] = useState(
    status.keepAliveMinutes,
  );
  const [partialIntervalMs, setPartialIntervalMs] = useState(
    String(status.partialIntervalMs),
  );
  const [segmentAdvanceMs, setSegmentAdvanceMs] = useState(
    String(status.segmentAdvanceMs),
  );
  const [saved, setSaved] = useState(false);

  const dirty =
    pythonPath !== (status.configuredPythonPath ?? "") ||
    sourcePath !== (status.sourcePath ?? "") ||
    host !== status.host ||
    port !== String(status.port) ||
    keepAliveMinutes !== status.keepAliveMinutes ||
    partialIntervalMs !== String(status.partialIntervalMs) ||
    segmentAdvanceMs !== String(status.segmentAdvanceMs);

  const save = (): void => {
    onSaveSetting("starling_python_path", pythonPath.trim());
    onSaveSetting("starling_source_path", sourcePath.trim());
    onSaveSetting("starling_host", host.trim() || "127.0.0.1");
    const portNum = Number(port);
    if (Number.isInteger(portNum) && portNum > 0 && portNum < 65536) {
      onSaveSetting("starling_port", String(portNum));
    }
    onSaveSetting("starling_keep_alive_minutes", String(keepAliveMinutes));
    const piMs = Number(partialIntervalMs);
    if (Number.isFinite(piMs) && piMs >= 300) {
      onSaveSetting("starling_partial_interval_ms", String(Math.round(piMs)));
    }
    const saMs = Number(segmentAdvanceMs);
    if (Number.isFinite(saMs) && saMs >= 1000) {
      onSaveSetting("starling_segment_advance_ms", String(Math.round(saMs)));
    }
    setSaved(true);
    window.setTimeout(() => setSaved(false), 1500);
  };

  const fillPercent = (keepAliveMinutes / MAX_KEEP_ALIVE_MINUTES) * 100;
  const inputClass =
    "border-border bg-background text-foreground w-full rounded-md border px-2.5 py-1.5 text-[12.5px] outline-none focus:border-primary";

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: backdrop dismiss
    // biome-ignore lint/a11y/useKeyWithClickEvents: backdrop dismiss
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-[rgba(20,12,4,0.35)] p-6 backdrop-blur-[4px]"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Starling settings"
        className="border-border bg-card max-h-[88vh] w-full max-w-lg overflow-y-auto rounded-[14px] border p-7 shadow-[0_24px_60px_-16px_rgba(20,12,4,0.4)]"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
      >
        <div className="flex min-w-0 items-center gap-2.5">
          <Cpu className="text-primary h-4 w-4 shrink-0" />
          <h3 className="text-foreground m-0 text-[17px] font-semibold">
            Starling settings
          </h3>
        </div>

        <p className="text-muted-foreground mt-2 text-[12px] leading-relaxed">
          Starling runs your optimized CUDA kernels as a local server. Point it
          at a Python venv that has starling installed. Semi-online streaming
          transcribes overlapping chunks while you record for near-instant
          output on release.
        </p>

        {status.blockedReason && (
          <p className="text-destructive mt-3 text-[12px] leading-relaxed">
            {status.blockedReason}
          </p>
        )}

        <div className="mt-5 space-y-4">
          <label className="block">
            <span className="text-foreground text-[12.5px] font-medium">
              Python executable
            </span>
            <input
              type="text"
              className={`${inputClass} mt-1`}
              placeholder="e.g. C:\\starling\\.venv\\Scripts\\python.exe"
              value={pythonPath}
              onChange={(e) => setPythonPath(e.target.value)}
            />
            <span className="text-muted-foreground mt-1 block text-[11px]">
              Leave empty to auto-detect <code>python</code> on PATH. Resolved:{" "}
              <code>{status.pythonPath ?? "not found"}</code>
            </span>
          </label>

          <label className="block">
            <span className="text-foreground text-[12.5px] font-medium">
              Starling source directory{" "}
              <span className="text-muted-foreground font-normal">
                (optional)
              </span>
            </span>
            <input
              type="text"
              className={`${inputClass} mt-1`}
              placeholder="e.g. C:\\Users\\you\\starling"
              value={sourcePath}
              onChange={(e) => setSourcePath(e.target.value)}
            />
            <span className="text-muted-foreground mt-1 block text-[11px]">
              Set this if running from a checkout. Leave empty if starling is
              pip-installed into the venv above.
            </span>
          </label>

          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="text-foreground text-[12.5px] font-medium">
                Host
              </span>
              <input
                type="text"
                className={`${inputClass} mt-1`}
                value={host}
                onChange={(e) => setHost(e.target.value)}
              />
            </label>
            <label className="block">
              <span className="text-foreground text-[12.5px] font-medium">
                Port
              </span>
              <input
                type="number"
                min={1}
                max={65535}
                className={`${inputClass} mt-1`}
                value={port}
                onChange={(e) => setPort(e.target.value)}
              />
            </label>
          </div>

          <div>
            <span className="text-foreground text-[12.5px] font-medium">
              Keep-alive ({keepAliveMinutes} min)
            </span>
            <input
              type="range"
              min={0}
              max={MAX_KEEP_ALIVE_MINUTES}
              step={1}
              value={keepAliveMinutes}
              onChange={(event) =>
                setKeepAliveMinutes(Number(event.currentTarget.value))
              }
              style={{
                background: `linear-gradient(to right, var(--primary) ${fillPercent}%, var(--secondary) ${fillPercent}%)`,
              }}
              className="mt-2 h-2 w-full appearance-none rounded-full outline-none [&::-moz-range-thumb]:h-4 [&::-moz-range-thumb]:w-4 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:bg-primary [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-primary [&::-webkit-slider-thumb]:shadow-[0_0_0_4px_var(--card)]"
              aria-label="Starling keep-alive minutes"
            />
            <p className="text-muted-foreground mt-1.5 text-[11px] leading-relaxed">
              {keepAliveDescription(keepAliveMinutes)}
            </p>
          </div>

          <details className="border-border rounded-md border">
            <summary className="text-foreground cursor-pointer px-3 py-2 text-[12.5px] font-medium">
              Streaming tunables (advanced)
            </summary>
            <div className="space-y-3 p-3">
              <label className="block">
                <span className="text-foreground text-[12px] font-medium">
                  Partial interval (ms)
                </span>
                <input
                  type="number"
                  min={300}
                  className={`${inputClass} mt-1`}
                  value={partialIntervalMs}
                  onChange={(e) => setPartialIntervalMs(e.target.value)}
                />
                <span className="text-muted-foreground mt-1 block text-[11px]">
                  How often to re-transcribe the live window while recording.
                  Lower = faster partials, more GPU load.
                </span>
              </label>
              <label className="block">
                <span className="text-foreground text-[12px] font-medium">
                  Segment advance (ms)
                </span>
                <input
                  type="number"
                  min={1000}
                  className={`${inputClass} mt-1`}
                  value={segmentAdvanceMs}
                  onChange={(e) => setSegmentAdvanceMs(e.target.value)}
                />
                <span className="text-muted-foreground mt-1 block text-[11px]">
                  When the live window exceeds this length, lock it in and start
                  a new one. Bounds per-partial cost for long recordings.
                </span>
              </label>
            </div>
          </details>
        </div>

        <div className="mt-6 flex items-center justify-between">
          <span className="text-muted-foreground text-[11px]">
            Server:{" "}
            {status.serverRunning
              ? "running"
              : status.serverFailed
                ? "failed"
                : "stopped"}
            {" · "}
            <code>{status.baseUrl}</code>
          </span>
          <div className="flex items-center gap-2">
            {saved && (
              <span className="text-muted-foreground text-[11px]">Saved</span>
            )}
            <button
              type="button"
              onClick={save}
              disabled={!dirty}
              className="rounded-md border border-transparent px-3.5 py-1.5 text-[12.5px] font-medium disabled:opacity-40 bg-foreground text-background hover:bg-foreground/90"
            >
              Save
            </button>
            <button
              type="button"
              onClick={onClose}
              className="bg-foreground text-background hover:bg-foreground/90 rounded-md px-3.5 py-1.5 text-[12.5px] font-medium"
            >
              Done
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
