import type { JevClient, JevRequest, JevResponse } from './types';

/** One request to Jev, as `logClient` saw it: what went out, what came back (or the error), and how long it took. */
export interface JevLogEntry {
  at: number;
  request: JevRequest;
  response?: JevResponse;
  error?: string;
  ms: number;
}

/**
 * Wrap a client so every request and its response (or error) is handed to
 * `onEntry` once it settles: to keep, show, or download. The request is
 * what this client was given, after any wrapping inside it took effect.
 */
export function logClient(client: JevClient, onEntry: (entry: JevLogEntry) => void): JevClient {
  return async (request) => {
    const at = Date.now();
    try {
      const response = await client(request);
      onEntry({ at, request, response, ms: Date.now() - at });
      return response;
    } catch (e) {
      onEntry({ at, request, error: String(e), ms: Date.now() - at });
      throw e;
    }
  };
}
