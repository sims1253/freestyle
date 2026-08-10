/**
 * The Starling model catalog. Each id maps to a server CLI slug, and only one
 * of those slugs can be resident in the supervised Python process at a time.
 */

export const STARLING_PROVIDER_ID = "local-starling";
export const STARLING_PROVIDER_NAME = "Local Starling";
export const STARLING_DEFAULT_HOST = "127.0.0.1";
export const STARLING_DEFAULT_PORT = 8181;
export const STARLING_SERVER_MODULE = "starling.server";

export interface StarlingModelDef {
  id: string;
  slug: string;
  displayName: string;
  family: string;
  speed: string;
  quality: string;
  vramRequired: string;
  /** Hugging Face repository Starling loads for this model. */
  hfRepoId: string;
}

export const STARLING_MODELS: StarlingModelDef[] = [
  {
    id: "granite",
    slug: "granite",
    displayName: "Granite Speech 4.1 (2B)",
    family: "granite-speech",
    speed: "Medium",
    quality: "High",
    vramRequired: "~10 GB",
    hfRepoId: "ibm-granite/granite-speech-4.1-2b",
  },
  {
    id: "parakeet",
    slug: "parakeet",
    displayName: "Parakeet TDT 0.6B v3",
    family: "parakeet",
    speed: "Fastest",
    quality: "High",
    vramRequired: "~2 GB",
    hfRepoId: "nvidia/parakeet-tdt-0.6b-v3",
  },
  {
    id: "parakeet_unified",
    slug: "parakeet_unified",
    displayName: "Parakeet Unified",
    family: "parakeet",
    speed: "Fast",
    quality: "High",
    vramRequired: "~3 GB",
    hfRepoId: "nvidia/parakeet-unified-en-0.6b",
  },
  {
    id: "moss",
    slug: "moss",
    displayName: "Moss Transcribe (2B)",
    family: "moss",
    speed: "Medium",
    quality: "High",
    vramRequired: "~9 GB",
    hfRepoId: "OpenMOSS-Team/MOSS-Transcribe-preview-2B",
  },
  {
    id: "qwen3",
    slug: "qwen3",
    displayName: "Qwen3 ASR (1.7B)",
    family: "qwen3",
    speed: "Fast",
    quality: "Best",
    vramRequired: "~7 GB",
    hfRepoId: "Qwen/Qwen3-ASR-1.7B-hf",
  },
  {
    id: "ark",
    slug: "ark",
    displayName: "Ark ASR",
    family: "ark",
    speed: "Fast",
    quality: "High",
    vramRequired: "~4 GB",
    hfRepoId: "AutoArk-AI/ARK-ASR-3B",
  },
  {
    id: "cohere",
    slug: "cohere",
    displayName: "Cohere ASR",
    family: "cohere",
    speed: "Medium",
    quality: "High",
    vramRequired: "~8 GB",
    hfRepoId: "CohereLabs/cohere-transcribe-03-2026",
  },
  {
    id: "higgs",
    slug: "higgs",
    displayName: "Higgs Audio Transcription",
    family: "higgs",
    speed: "Medium",
    quality: "High",
    vramRequired: "~8 GB",
    hfRepoId: "bosonai/higgs-audio-v3-stt",
  },
  {
    id: "audex",
    slug: "audex",
    displayName: "Audex ASR",
    family: "audex",
    speed: "Fast",
    quality: "High",
    vramRequired: "~5 GB",
    hfRepoId: "nvidia/Nemotron-Labs-Audex-2B",
  },
];

export const LEGACY_STARLING_MODELS: StarlingModelDef[] = [
  {
    id: "granite-speech",
    slug: "granite",
    displayName: "Granite Speech 4.1 (2B)",
    family: "granite-speech",
    speed: "Medium",
    quality: "High",
    vramRequired: "~10 GB",
    hfRepoId: "ibm-granite/granite-speech-4.1-2b",
  },
];

export function getStarlingModel(id: string): StarlingModelDef | undefined {
  return [...STARLING_MODELS, ...LEGACY_STARLING_MODELS].find(
    (model) => model.id === id,
  );
}
