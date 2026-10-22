/**
 * Keys you paste in, for models the server has none for: a gateway's (one
 * key, every model it carries), or a maker's own (TypeSafe's for Jev, a
 * Cloudflare account and token for Clef). Each is kept in this browser only
 * (localStorage), and sent along with the requests it can serve, which use it
 * for that one call and keep nothing (see `lib/jev.ts`).
 */
import { modelInfo, type KeyHolder, type ModelId } from './models';

export interface Credentials {
  /** A TypeSafe or gateway API key. */
  key?: string;
  /** Cloudflare's account ID and API token. */
  account?: string;
  token?: string;
}

export type PageKeys = Partial<Record<KeyHolder, Credentials>>;

const STORAGE: Record<KeyHolder, string> = {
  typesafe: 'jevspresso:typesafe-key',
  cloudflare: 'jevspresso:cloudflare',
  openrouter: 'jevspresso:openrouter-key',
  vercel: 'jevspresso:vercel-key',
};
/** Kept as the key itself; the rest as JSON. */
const PLAIN: readonly KeyHolder[] = ['typesafe', 'openrouter', 'vercel'];
const HOLDERS = Object.keys(STORAGE) as KeyHolder[];

let current: PageKeys = {};

/** Your keys that can reach this model, to send with its requests. */
export function keysFor(model: ModelId): PageKeys {
  const info = modelInfo(model);
  return Object.fromEntries(Object.entries(current).filter(([h]) => h === info.provider || h in info.gateways));
}

/** Read every key back from this browser, if any were saved here. */
export function loadKeys(): PageKeys {
  const keys: PageKeys = {};
  for (const holder of HOLDERS) {
    try {
      const saved = localStorage.getItem(STORAGE[holder]);
      if (saved) keys[holder] = PLAIN.includes(holder) ? { key: saved } : (JSON.parse(saved) as Credentials);
    } catch {
      // Storage blocked, or a value from elsewhere: as if none.
    }
  }
  return (current = keys);
}

export function saveKey(holder: KeyHolder, credentials: Credentials): PageKeys {
  current = { ...current, [holder]: credentials };
  try {
    localStorage.setItem(STORAGE[holder], PLAIN.includes(holder) ? (credentials.key ?? '') : JSON.stringify(credentials));
  } catch {
    // Storage blocked: the key still works until the page closes.
  }
  return current;
}

/** Take every key you gave out of this browser. */
export function forgetKeys(): PageKeys {
  for (const holder of HOLDERS) {
    try {
      localStorage.removeItem(STORAGE[holder]);
    } catch {
      // Nothing saved to forget.
    }
  }
  return (current = {});
}
