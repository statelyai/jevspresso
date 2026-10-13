/**
 * Keys you paste in, for a model the server has none for: a TypeSafe key for
 * Jev, a Cloudflare account and token for Clef. Each is kept in this browser
 * only (localStorage), and sent along with that model's requests, which use
 * it for that one call and keep nothing (see `lib/jev.ts`).
 */
import type { Provider } from './models';

export interface Credentials {
  /** TypeSafe's key. */
  key?: string;
  /** Cloudflare's account ID and API token. */
  account?: string;
  token?: string;
}

const STORAGE: Record<Provider, string> = {
  typesafe: 'jevspresso:typesafe-key',
  cloudflare: 'jevspresso:cloudflare',
};

const current: Partial<Record<Provider, Credentials>> = {};

/** The keys in use for a provider, if you gave them. */
export function userCredentials(provider: Provider | undefined): Credentials | null {
  return (provider && current[provider]) || null;
}

/** Read them back from this browser, if they were saved here. */
export function loadCredentials(provider: Provider): Credentials | null {
  try {
    const saved = localStorage.getItem(STORAGE[provider]);
    // TypeSafe's key has always been kept as it is; the rest as JSON.
    current[provider] = saved ? (provider === 'typesafe' ? { key: saved } : (JSON.parse(saved) as Credentials)) : undefined;
  } catch {
    current[provider] = undefined;
  }
  return current[provider] ?? null;
}

export function saveCredentials(provider: Provider, credentials: Credentials): void {
  current[provider] = credentials;
  try {
    localStorage.setItem(STORAGE[provider], provider === 'typesafe' ? (credentials.key ?? '') : JSON.stringify(credentials));
  } catch {
    // Storage blocked: the keys still work until the page closes.
  }
}

export function forgetCredentials(provider: Provider): void {
  current[provider] = undefined;
  try {
    localStorage.removeItem(STORAGE[provider]);
  } catch {
    // Nothing saved to forget.
  }
}
