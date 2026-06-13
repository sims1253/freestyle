import { homedir } from "node:os";
import { join } from "node:path";

export const PARAKEET_PROVIDER_ID = "local-parakeet";

export interface ParakeetModelDef {
  id: string;
  /** HuggingFace repo for the GGUF file. */
  hfRepo: string;
  /** File name within the repo. */
  fileName: string;
  displayName: string;
  sizeBytes: number;
  ramRequired: string;
  speed: string;
  quality: string;
  quantized: boolean;
}

/**
 * Curated catalog. parakeet.cpp consumes GGUF files from HuggingFace.
 * Files: https://huggingface.co/mudler/parakeet-cpp-gguf
 *
 * We surface the f16 variant of each model family as the default, plus
 * a handful of quantized options for the most popular sizes.
 */
export const PARAKEET_MODELS: ParakeetModelDef[] = [
  // --- 110M (smallest) ---
  {
    id: "tdt_ctc-110m-f16",
    hfRepo: "mudler/parakeet-cpp-gguf",
    fileName: "tdt_ctc-110m-f16.gguf",
    displayName: "Parakeet TDT+CTC 110M",
    sizeBytes: 225_000_000,
    ramRequired: "~600 MB",
    speed: "Fastest",
    quality: "Basic",
    quantized: false,
  },
  {
    id: "tdt_ctc-110m-q4_k",
    hfRepo: "mudler/parakeet-cpp-gguf",
    fileName: "tdt_ctc-110m-q4_k.gguf",
    displayName: "Parakeet TDT+CTC 110M (Q4)",
    sizeBytes: 70_000_000,
    ramRequired: "~350 MB",
    speed: "Fastest",
    quality: "Basic",
    quantized: true,
  },

  // --- 120M realtime ---
  {
    id: "realtime_eou_120m-v1-f16",
    hfRepo: "mudler/parakeet-cpp-gguf",
    fileName: "realtime_eou_120m-v1-f16.gguf",
    displayName: "Parakeet Realtime 120M",
    sizeBytes: 245_000_000,
    ramRequired: "~650 MB",
    speed: "Fastest",
    quality: "Basic",
    quantized: false,
  },

  // --- 0.6B CTC ---
  {
    id: "ctc-0.6b-f16",
    hfRepo: "mudler/parakeet-cpp-gguf",
    fileName: "ctc-0.6b-f16.gguf",
    displayName: "Parakeet CTC 0.6B",
    sizeBytes: 1_200_000_000,
    ramRequired: "~2.5 GB",
    speed: "Very Fast",
    quality: "High",
    quantized: false,
  },
  {
    id: "ctc-0.6b-q5_k",
    hfRepo: "mudler/parakeet-cpp-gguf",
    fileName: "ctc-0.6b-q5_k.gguf",
    displayName: "Parakeet CTC 0.6B (Q5)",
    sizeBytes: 450_000_000,
    ramRequired: "~1.5 GB",
    speed: "Very Fast",
    quality: "High",
    quantized: true,
  },

  // --- 0.6B RNN-T ---
  {
    id: "rnnt-0.6b-f16",
    hfRepo: "mudler/parakeet-cpp-gguf",
    fileName: "rnnt-0.6b-f16.gguf",
    displayName: "Parakeet RNN-T 0.6B",
    sizeBytes: 1_200_000_000,
    ramRequired: "~2.5 GB",
    speed: "Very Fast",
    quality: "High",
    quantized: false,
  },

  // --- 0.6B TDT v2 ---
  {
    id: "tdt-0.6b-v2-f16",
    hfRepo: "mudler/parakeet-cpp-gguf",
    fileName: "tdt-0.6b-v2-f16.gguf",
    displayName: "Parakeet TDT v2 0.6B",
    sizeBytes: 1_200_000_000,
    ramRequired: "~2.5 GB",
    speed: "Very Fast",
    quality: "High",
    quantized: false,
  },

  // --- 0.6B TDT v3 (best accuracy at small size) ---
  {
    id: "tdt-0.6b-v3-f16",
    hfRepo: "mudler/parakeet-cpp-gguf",
    fileName: "tdt-0.6b-v3-f16.gguf",
    displayName: "Parakeet TDT v3 0.6B",
    sizeBytes: 1_200_000_000,
    ramRequired: "~2.5 GB",
    speed: "Very Fast",
    quality: "Best",
    quantized: false,
  },
  {
    id: "tdt-0.6b-v3-q5_k",
    hfRepo: "mudler/parakeet-cpp-gguf",
    fileName: "tdt-0.6b-v3-q5_k.gguf",
    displayName: "Parakeet TDT v3 0.6B (Q5)",
    sizeBytes: 450_000_000,
    ramRequired: "~1.5 GB",
    speed: "Very Fast",
    quality: "High",
    quantized: true,
  },

  // --- 0.6B Nemotron (multilingual streaming) ---
  {
    id: "nemotron-3.5-asr-streaming-0.6b-f16",
    hfRepo: "mudler/parakeet-cpp-gguf",
    fileName: "nemotron-3.5-asr-streaming-0.6b-f16.gguf",
    displayName: "Nemotron Streaming 0.6B",
    sizeBytes: 1_200_000_000,
    ramRequired: "~2.5 GB",
    speed: "Very Fast",
    quality: "High",
    quantized: false,
  },

  // --- 1.1B CTC ---
  {
    id: "ctc-1.1b-f16",
    hfRepo: "mudler/parakeet-cpp-gguf",
    fileName: "ctc-1.1b-f16.gguf",
    displayName: "Parakeet CTC 1.1B",
    sizeBytes: 2_200_000_000,
    ramRequired: "~4.5 GB",
    speed: "Fast",
    quality: "Best",
    quantized: false,
  },

  // --- 1.1B RNN-T ---
  {
    id: "rnnt-1.1b-f16",
    hfRepo: "mudler/parakeet-cpp-gguf",
    fileName: "rnnt-1.1b-f16.gguf",
    displayName: "Parakeet RNN-T 1.1B",
    sizeBytes: 2_200_000_000,
    ramRequired: "~4.5 GB",
    speed: "Fast",
    quality: "Best",
    quantized: false,
  },

  // --- 1.1B TDT ---
  {
    id: "tdt-1.1b-f16",
    hfRepo: "mudler/parakeet-cpp-gguf",
    fileName: "tdt-1.1b-f16.gguf",
    displayName: "Parakeet TDT 1.1B",
    sizeBytes: 2_200_000_000,
    ramRequired: "~4.5 GB",
    speed: "Fast",
    quality: "Best",
    quantized: false,
  },

  // --- 1.1B TDT+CTC ---
  {
    id: "tdt_ctc-1.1b-f16",
    hfRepo: "mudler/parakeet-cpp-gguf",
    fileName: "tdt_ctc-1.1b-f16.gguf",
    displayName: "Parakeet TDT+CTC 1.1B",
    sizeBytes: 2_200_000_000,
    ramRequired: "~4.5 GB",
    speed: "Fast",
    quality: "Best",
    quantized: false,
  },
];

export function getParakeetModel(id: string): ParakeetModelDef | undefined {
  return PARAKEET_MODELS.find((m) => m.id === id);
}

export function getModelsDir(): string {
  return join(homedir(), ".cache", "freestyle", "parakeet-models");
}

export function getModelPath(model: ParakeetModelDef): string {
  return join(getModelsDir(), model.fileName);
}

const CLI_NAMES: Record<string, Record<string, string>> = {
  darwin: { arm64: "parakeet-cli", x64: "parakeet-cli" },
  linux: { x64: "parakeet-cli", arm64: "parakeet-cli" },
  win32: { x64: "parakeet-cli.exe" },
};

export function getBinaryName(): string | null {
  const platform = process.platform;
  const arch = process.arch;
  return CLI_NAMES[platform]?.[arch] ?? null;
}

/** @deprecated parakeet.cpp ships only parakeet-cli; use getBinaryName() */
export function getServerBinaryName(): string | null {
  return getBinaryName();
}

export function getResourcesDir(): string {
  const electronProcess = process as NodeJS.Process & {
    resourcesPath?: string;
  };
  if (electronProcess.resourcesPath) {
    return join(
      electronProcess.resourcesPath,
      "parakeet",
      `${process.platform}-${process.arch}`,
    );
  }
  return join(
    process.cwd(),
    "resources",
    "parakeet",
    `${process.platform}-${process.arch}`,
  );
}

export function getBinDir(): string {
  return join(homedir(), ".cache", "freestyle", "parakeet-bin");
}

export const PARAKEET_SERVER_PORT = 8180;
