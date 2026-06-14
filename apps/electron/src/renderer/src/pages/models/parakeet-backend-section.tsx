import type { ParakeetBackend, ParakeetStatus } from "@renderer/lib/models";
import { Cpu } from "lucide-react";

// ---------------------------------------------------------------------------
// Backend metadata — mirrors apps/server/src/lib/parakeet/backends.ts
// ---------------------------------------------------------------------------

const BACKEND_LABEL: Record<ParakeetBackend, string> = {
  auto: "Automatic",
  cpu: "CPU",
  vulkan: "Vulkan",
  cuda: "CUDA",
  metal: "Metal",
};

function backendDescription(backend: ParakeetBackend): string {
  switch (backend) {
    case "auto":
      return "Best for your system. GPU acceleration when available, CPU otherwise.";
    case "cpu":
      return "Force CPU. Slowest but most compatible. No extra download.";
    case "vulkan":
      return "Use the Vulkan GPU backend (broad vendor support). ~18 MB download.";
    case "cuda":
      return "Use the NVIDIA CUDA backend. Best GPU perf, NVIDIA-only. ~160–580 MB download.";
    case "metal":
      return "Use the Apple Metal backend. Fastest on Apple Silicon.";
  }
}

// ---------------------------------------------------------------------------
// ParakeetBackendDialog — pick the parakeet.cpp compute backend
// ---------------------------------------------------------------------------

export function ParakeetBackendDialog({
  status,
  onChange,
  onClose,
}: {
  status: ParakeetStatus;
  onChange: (backend: string) => void;
  onClose: () => void;
}): React.JSX.Element {
  const selected = status.computeBackend ?? "auto";
  const installed = status.installedBackend;

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
        aria-label="Parakeet compute backend"
        className="border-border bg-card w-full max-w-md rounded-[14px] border p-7 shadow-[0_24px_60px_-16px_rgba(20,12,4,0.4)]"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
      >
        <div className="flex min-w-0 items-center gap-2.5">
          <Cpu className="text-primary h-4 w-4 shrink-0" />
          <h3 className="text-foreground m-0 text-[17px] font-semibold">
            Compute backend
          </h3>
        </div>

        <p className="text-muted-foreground mt-3 text-[12.5px] leading-relaxed">
          Choose how parakeet.cpp runs inference. GPU backends download a
          separate binary on first use; CPU forces the device on the installed
          binary with no download.
        </p>

        <div className="mt-4 space-y-1.5">
          {status.availableBackends.map((backend) => {
            const active = backend === selected;
            const isInstalled = installed === backend;
            return (
              <button
                key={backend}
                type="button"
                onClick={() => onChange(backend)}
                className={`flex w-full items-start gap-3 rounded-lg border p-3 text-left transition-colors ${
                  active
                    ? "border-primary bg-primary/5"
                    : "border-border hover:bg-muted/40"
                }`}
              >
                <span
                  className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${
                    active ? "border-primary" : "border-muted-foreground/40"
                  }`}
                >
                  {active && (
                    <span className="bg-primary h-2 w-2 rounded-full" />
                  )}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2">
                    <span className="text-foreground text-[13px] font-medium">
                      {BACKEND_LABEL[backend]}
                    </span>
                    {isInstalled && (
                      <span className="text-muted-foreground rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide">
                        installed
                      </span>
                    )}
                    {status.binaryDownloading &&
                      backend !== "cpu" &&
                      backend !== "auto" &&
                      !isInstalled && (
                        <span className="text-primary text-[10px] font-medium uppercase tracking-wide">
                          downloading…
                        </span>
                      )}
                  </span>
                  <span className="text-muted-foreground mt-0.5 block text-[11.5px] leading-relaxed">
                    {backendDescription(backend)}
                  </span>
                </span>
              </button>
            );
          })}
        </div>

        {status.binaryDownloading && (
          <p className="text-muted-foreground mt-3 text-[11.5px] leading-relaxed">
            Downloading the parakeet binary — this happens once per backend.
          </p>
        )}

        <div className="mt-5 flex justify-end">
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
  );
}
