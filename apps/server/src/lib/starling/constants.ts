/**
 * The Starling model catalog for the native starling-serve binary. Each model
 * has a GGML C++ engine and a pre-converted GGUF file on HuggingFace.
 * One model can be resident in the native process at a time.
 */

export const STARLING_PROVIDER_ID = "local-starling";
export const STARLING_PROVIDER_NAME = "Local Starling";
export const STARLING_DEFAULT_HOST = "127.0.0.1";
export const STARLING_DEFAULT_PORT = 8181;

/** Minimum ABI version the starling-serve binary must report. */
export const STARLING_MIN_ABI_VERSION = 3;

/**
 * Default quantization. q8_0 halves VRAM with negligible WER delta; bf16-exact
 * is the opt-in for byte-exact parity with the Python reference.
 */
export const STARLING_DEFAULT_QUANT = "q8_0" as const;

/** GitHub release tag the binary is downloaded from. */
export const STARLING_SERVE_REPO = "sims1253/starling";
export const STARLING_SERVE_VERSION = "v0.1.0";

/** HuggingFace org hosting the pre-converted GGUF files. */
export const STARLING_GGUF_HF_ORG = "sims1253";

export type StarlingQuant = "q8_0" | "bf16-exact";

export interface StarlingModelDef {
  id: string;
  slug: string;
  displayName: string;
  family: string;
  speed: string;
  quality: string;
  vramRequired: string;
  /** Approximate GGUF file size in GB (q8_0 unless noted). */
  ggufSizeGb: number;
  /** Hugging Face repo name for the GGUF files. */
  ggufRepoId: string;
  /** Original Hugging Face repo (for reference / linking). */
  hfRepoId: string;
}

/**
 * Models with GGML C++ engines supported by starling-serve.
 * Granite, qwen3, cohere, and audex are NOT available natively.
 */
export const STARLING_MODELS: StarlingModelDef[] = [
  {
    id: "parakeet",
    slug: "parakeet",
    displayName: "Parakeet TDT 0.6B v3",
    family: "parakeet",
    speed: "Fastest",
    quality: "High",
    vramRequired: "~2 GB",
    ggufSizeGb: 0.8,
    ggufRepoId: "parakeet-tdt-0.6b-v3-gguf",
    hfRepoId: "nvidia/parakeet-tdt-0.6b-v3",
  },
  {
    id: "ark",
    slug: "ark",
    displayName: "Ark ASR",
    family: "ark",
    speed: "Fast",
    quality: "High",
    vramRequired: "~4 GB",
    ggufSizeGb: 4.6,
    ggufRepoId: "ark-asr-3b-gguf",
    hfRepoId: "AutoArk-AI/ARK-ASR-3B",
  },
  {
    id: "moss",
    slug: "moss",
    displayName: "Moss Transcribe (2B)",
    family: "moss",
    speed: "Medium",
    quality: "High",
    vramRequired: "~9 GB",
    ggufSizeGb: 4.9,
    ggufRepoId: "moss-transcribe-preview-2b-gguf",
    hfRepoId: "OpenMOSS-Team/MOSS-Transcribe-preview-2B",
  },
  {
    id: "higgs",
    slug: "higgs",
    displayName: "Higgs Audio Transcription",
    family: "higgs",
    speed: "Medium",
    quality: "High",
    vramRequired: "~8 GB",
    ggufSizeGb: 5.4,
    ggufRepoId: "higgs-audio-v3-stt-gguf",
    hfRepoId: "bosonai/higgs-audio-v3-stt",
  },
  {
    id: "hojo",
    slug: "hojo",
    displayName: "Hojo ASR V1",
    family: "hojo",
    speed: "Medium",
    quality: "High",
    vramRequired: "~12 GB",
    ggufSizeGb: 12.0,
    ggufRepoId: "hojo-asr-v1-gguf",
    hfRepoId: "HojoAI/Hojo-ASR-V1",
  },
];

/** Legacy model IDs that may appear in existing DB rows (mapped at migration). */
export const LEGACY_STARLING_MODELS: Record<string, string> = {
  "granite": "parakeet",
  "granite-speech": "parakeet",
  "parakeet_unified": "parakeet",
  "qwen3": "parakeet",
  "cohere": "parakeet",
  "audex": "parakeet",
};

export function getStarlingModel(id: string): StarlingModelDef | undefined {
  // Resolve legacy model IDs to their native replacement.
  const resolved = LEGACY_STARLING_MODELS[id] ?? id;
  return STARLING_MODELS.find((model) => model.id === resolved);
}

/** Build the GGUF filename for a model + quantization. */
export function ggufFilename(slug: string, quant: StarlingQuant): string {
  return `${slug}-${quant}.gguf`;
}

/** Build the full HuggingFace repo id for GGUF files. */
export function ggufRepoId(model: StarlingModelDef): string {
  return `${STARLING_GGUF_HF_ORG}/${model.ggufRepoId}`;
}

/** Expected GGUF download size in bytes (approximate, for progress display). */
export function ggufExpectedBytes(model: StarlingModelDef): number {
  return Math.round(model.ggufSizeGb * 1024 * 1024 * 1024);
}
