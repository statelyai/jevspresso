/**
 * How a café is doing, from what can be measured so far: what it served and
 * how long people waited, how often it asked, and what its model cost in
 * calls and time. Not a single score yet: the parts, side by side.
 */
import type { BarLogEntry } from './jevLog';
import type { Drink } from './types';

export interface CafeScore {
  served: number;
  /** Served, but not what was ordered. */
  wrong: number;
  declined: number;
  open: number;
  /** Mean wait of the drinks served, in seconds of world time. */
  avgWaitS: number | null;
  /** Times it asked the customer to confirm an order. */
  asks: number;
  calls: number;
  /** Median time a request to the model took. */
  medianMs: number | null;
  failed: number;
}

export function cafeScore(drinks: Drink[], servedAt: Record<string, number>, asks: number, log: readonly BarLogEntry[]): CafeScore {
  const served = drinks.filter((d) => d.status === 'served');
  const waits = served.flatMap((d) => (d.id in servedAt ? [(servedAt[d.id] - d.orderedAt) / 1000] : []));
  const ms = log.filter((e) => !e.error).map((e) => e.ms).sort((a, b) => a - b);
  return {
    served: served.length,
    wrong: served.filter((d) => !d.served?.correct).length,
    declined: drinks.filter((d) => d.status === 'declined').length,
    open: drinks.filter((d) => d.status === 'queued').length,
    avgWaitS: waits.length ? waits.reduce((a, b) => a + b, 0) / waits.length : null,
    asks,
    calls: log.length,
    medianMs: ms.length ? ms[Math.floor(ms.length / 2)] : null,
    failed: log.filter((e) => e.error).length,
  };
}
