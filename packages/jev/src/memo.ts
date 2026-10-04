import type { JevClient, JevResponse } from './types';

export interface MemoizeOptions {
  /** How many distinct requests to remember, most recent first. Default 100. */
  max?: number;
}

/**
 * Wrap a client so an identical request (same state, same questions) gets the
 * response it got before, marked `cached: true`, without calling Jev again.
 * Identical requests in flight at the same time share one call. Failed
 * requests are not remembered.
 */
export function memoizeClient(client: JevClient, { max = 100 }: MemoizeOptions = {}): JevClient {
  // Keyed by the full request JSON, not a hash: a collision would serve the
  // wrong answer. Map order doubles as recency for eviction.
  const responses = new Map<string, Promise<JevResponse>>();

  return (request) => {
    const key = JSON.stringify(request);
    const hit = responses.get(key);
    if (hit) {
      responses.delete(key);
      responses.set(key, hit);
      return hit.then((response) => ({ ...response, cached: true }));
    }
    const pending = client(request);
    responses.set(key, pending);
    pending.catch(() => responses.delete(key));
    while (responses.size > max) responses.delete(responses.keys().next().value!);
    return pending;
  };
}
