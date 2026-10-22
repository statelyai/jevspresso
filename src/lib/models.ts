/**
 * The decision models the bar can be run by. All of them answer Jev's request
 * shape (state plus typed questions); `lib/jev.ts` says how each is reached:
 * directly, with its maker's key, or through a gateway, where one key reaches
 * every model the gateway carries.
 */
export type ModelId =
  | 'jev'
  | 'kev'
  | 'clef'
  | 'clef-flash'
  | 'clef-omni'
  | 'openai'
  | 'microsoft'
  | 'perplexity'
  | 'liquid';

/** Whose own key a model takes on the page. */
export type Provider = 'typesafe' | 'cloudflare';

/** A gateway: one key, many models. */
export type Gateway = 'openrouter' | 'vercel';

/** Anyone whose key you can give on the page. */
export type KeyHolder = Provider | Gateway;

export interface ModelInfo {
  id: ModelId;
  label: string;
  /** Who makes it. */
  by: string;
  /** Whose own key it takes on the page; none for a model only a server or a gateway reaches. */
  provider?: Provider;
  /** Its name on each gateway that carries it. */
  gateways: Partial<Record<Gateway, string>>;
  /** At most this many questions in one request: more go as several at once. */
  maxQuestions?: number;
}

/** Jev's version, pinned: confidence thresholds are tuned to it. */
export const JEV_MODEL = 'jev-1.14.0';

export const MODELS: ModelInfo[] = [
  { id: 'jev', label: 'Jev', by: 'TypeSafe', provider: 'typesafe', gateways: { openrouter: 'typesafe/jev-1.14', vercel: 'typesafe-ai/jev-1.14.0' } },
  { id: 'kev', label: 'Kev', by: 'Jared Palmer', gateways: { openrouter: 'jaredpalmer/kev-4b' } },
  { id: 'clef', label: 'Clef', by: 'Cloudflare', provider: 'cloudflare', gateways: { openrouter: 'cloudflare/clef' }, maxQuestions: 64 },
  { id: 'clef-flash', label: 'Clef Flash', by: 'Cloudflare', provider: 'cloudflare', gateways: { openrouter: 'cloudflare/clef-flash' }, maxQuestions: 64 },
  { id: 'clef-omni', label: 'Clef Omni', by: 'Cloudflare', provider: 'cloudflare', gateways: { openrouter: 'cloudflare/clef-omni' }, maxQuestions: 64 },
  {
    id: 'openai',
    label: 'GPT-6 Luna Decisions',
    by: 'OpenAI',
    gateways: { openrouter: 'openai/gpt-6-luna-decisions', vercel: 'openai/gpt-6-luna-decisions' },
  },
  {
    id: 'microsoft',
    label: 'Decision-1',
    by: 'Microsoft',
    gateways: { openrouter: 'microsoft/microsoft-decision-1', vercel: 'microsoft/microsoft-decision-1' },
  },
  {
    id: 'perplexity',
    label: 'Decider V1.2',
    by: 'Perplexity',
    gateways: { openrouter: 'perplexity/pplx-decider-v1.2', vercel: 'perplexity/pplx-decider-v1.2' },
  },
  { id: 'liquid', label: 'd1', by: 'Liquid AI', gateways: { openrouter: 'liquid/d1', vercel: 'liquid/d1' } },
];

export const GATEWAYS: Record<Gateway, { label: string; keyName: string }> = {
  openrouter: { label: 'OpenRouter', keyName: 'OpenRouter API key' },
  vercel: { label: 'Vercel AI Gateway', keyName: 'AI Gateway API key' },
};

export function modelInfo(model: ModelId): ModelInfo {
  return MODELS.find((m) => m.id === model)!;
}

export function isModelId(value: unknown): value is ModelId {
  return MODELS.some((m) => m.id === value);
}

/** The gateways that carry a model. */
export function gatewaysFor(model: ModelId): Gateway[] {
  return Object.keys(modelInfo(model).gateways) as Gateway[];
}

/** Can keys from these holders reach the model: its own maker's, or a gateway that carries it? */
export function reaches(model: ModelId, holders: readonly KeyHolder[]): boolean {
  const info = modelInfo(model);
  return holders.some((h) => h === info.provider || h in info.gateways);
}
