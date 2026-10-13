/**
 * The decision models the bar can be run by. All of them answer Jev's request
 * shape (state plus typed questions); `lib/jev.ts` says how each is reached.
 */
export type ModelId = 'jev' | 'kev' | 'clef' | 'clef-flash' | 'clef-omni' | 'openai';

/** Whose key a model needs, when you can give one on the page. */
export type Provider = 'typesafe' | 'cloudflare';

export interface ModelInfo {
  id: ModelId;
  label: string;
  /** Who makes it. */
  by: string;
  /** Whose key it takes on the page; none for a model only the server can reach. */
  provider?: Provider;
}

export const MODELS: ModelInfo[] = [
  { id: 'jev', label: 'Jev', by: 'TypeSafe', provider: 'typesafe' },
  { id: 'kev', label: 'Kev', by: 'self-hosted' },
  { id: 'clef', label: 'Clef', by: 'Cloudflare', provider: 'cloudflare' },
  { id: 'clef-flash', label: 'Clef Flash', by: 'Cloudflare', provider: 'cloudflare' },
  { id: 'clef-omni', label: 'Clef Omni', by: 'Cloudflare', provider: 'cloudflare' },
  { id: 'openai', label: 'OpenAI Decisions', by: 'OpenAI' },
];

export function modelInfo(model: ModelId): ModelInfo {
  return MODELS.find((m) => m.id === model)!;
}

export function isModelId(value: unknown): value is ModelId {
  return MODELS.some((m) => m.id === value);
}
