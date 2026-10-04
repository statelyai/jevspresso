/**
 * Every request the page's Jev clients sent, and what came back: the latest
 * ones, kept in memory for a download (see `logClient` in `@xstate/jev`).
 * Your key is never part of a request.
 */
import { logClient, type JevClient, type JevLogEntry } from '@xstate/jev';

/** How many requests are kept: the most recent. */
const MAX = 500;

export type BarLogEntry = JevLogEntry & { agent: string };

const entries: BarLogEntry[] = [];

/** A client whose requests go in the log, as `agent`'s. */
export function logged(agent: string, client: JevClient): JevClient {
  return logClient(client, (entry) => {
    entries.push({ agent, ...entry });
    if (entries.length > MAX) entries.shift();
  });
}

/** The log so far, oldest first. */
export function jevLog(): readonly BarLogEntry[] {
  return entries;
}

/** Save entries as a JSON file. */
export function downloadLog(log: readonly unknown[], name = 'jev-log'): void {
  const url = URL.createObjectURL(new Blob([JSON.stringify(log, null, 2)], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `${name}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  a.click();
  // Freed after the browser has started saving it: revoked at once, some browsers cancel the download.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
