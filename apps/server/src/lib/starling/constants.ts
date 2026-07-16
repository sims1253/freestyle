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
  },
  {
    id: "parakeet",
    slug: "parakeet",
    displayName: "Parakeet TDT 0.6B v3",
    family: "parakeet",
    speed: "Fastest",
    quality: "High",
    vramRequired: "~2 GB",
  },
  {
    id: "parakeet_unified",
    slug: "parakeet_unified",
    displayName: "Parakeet Unified",
    family: "parakeet",
    speed: "Fast",
    quality: "High",
    vramRequired: "~3 GB",
  },
  {
    id: "moss",
    slug: "moss",
    displayName: "Moss Transcribe (2B)",
    family: "moss",
    speed: "Medium",
    quality: "High",
    vramRequired: "~9 GB",
  },
  {
    id: "qwen3",
    slug: "qwen3",
    displayName: "Qwen3 ASR (1.7B)",
    family: "qwen3",
    speed: "Fast",
    quality: "Best",
    vramRequired: "~7 GB",
  },
  {
    id: "ark",
    slug: "ark",
    displayName: "Ark ASR",
    family: "ark",
    speed: "Fast",
    quality: "High",
    vramRequired: "~4 GB",
  },
  {
    id: "cohere",
    slug: "cohere",
    displayName: "Cohere ASR",
    family: "cohere",
    speed: "Medium",
    quality: "High",
    vramRequired: "~8 GB",
  },
  {
    id: "higgs",
    slug: "higgs",
    displayName: "Higgs Audio Transcription",
    family: "higgs",
    speed: "Medium",
    quality: "High",
    vramRequired: "~8 GB",
  },
  {
    id: "audex",
    slug: "audex",
    displayName: "Audex ASR",
    family: "audex",
    speed: "Fast",
    quality: "High",
    vramRequired: "~5 GB",
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
  },
];

export function getStarlingModel(id: string): StarlingModelDef | undefined {
  return [...STARLING_MODELS, ...LEGACY_STARLING_MODELS].find(
    (model) => model.id === id,
  );
}
