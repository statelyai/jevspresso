/**
 * The decision models a café can be run by. All of them answer Jev's request
 * shape (state plus typed questions); `lib/jev.ts` says how each is reached.
 */
export type ModelId = 'jev' | 'kev' | 'clef' | 'clef-flash' | 'clef-omni' | 'openai';

export interface ModelInfo {
  id: ModelId;
  label: string;
  /** Who makes it, for the tab. */
  by: string;
}

export const MODELS: ModelInfo[] = [
  { id: 'jev', label: 'Jev', by: 'TypeSafe' },
  { id: 'kev', label: 'Kev', by: 'self-hosted' },
  { id: 'clef', label: 'Clef', by: 'Cloudflare' },
  { id: 'clef-flash', label: 'Clef Flash', by: 'Cloudflare' },
  { id: 'clef-omni', label: 'Clef Omni', by: 'Cloudflare' },
  { id: 'openai', label: 'OpenAI Decisions', by: 'OpenAI' },
];
