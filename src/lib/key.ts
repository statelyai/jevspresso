/**
 * A Jev key you paste in, when the server has none of its own. It is kept in
 * this browser only (localStorage), and sent along with each Jev request, which
 * uses it for that one call and keeps nothing (see `lib/jev.ts`).
 */
const STORAGE = 'jevspresso:key';

export type UserKey = { key: string; provider: 'typesafe' | 'openrouter' };
let current: UserKey | null = null;

/** The key in use, if you gave one. */
export function userKey(): UserKey | null {
  return current;
}

/** Read it back from this browser, if it was saved here. */
export function loadKey(): UserKey | null {
  try {
    const saved = localStorage.getItem(STORAGE);
    current = saved ? JSON.parse(saved) : null;
  } catch {
    current = null;
  }
  return current;
}

export function saveKey(key: UserKey): void {
  current = key;
  try {
    localStorage.setItem(STORAGE, JSON.stringify(key));
  } catch {
    // Storage blocked: the key still works until the page closes.
  }
}

export function forgetKey(): void {
  current = null;
  try {
    localStorage.removeItem(STORAGE);
  } catch {
    // Nothing saved to forget.
  }
}
