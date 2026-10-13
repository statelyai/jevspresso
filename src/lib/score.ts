/**
 * A day's scorecard: what can be measured, side by side, not yet one number.
 * Taking orders (read right first time, asked, got it wrong without asking),
 * serving them (right, wrong, turned away, still waiting, and how long people
 * waited), and what the model cost in requests and time.
 */
import type { CustomerRecord } from '../machines/day';
import type { BarLogEntry } from './jevLog';
import type { Drink } from './types';

export interface DayScore {
  customers: number;
  /** Read right the first time the bar heard it. */
  readRightFirst: number;
  /** Went in as they meant it, asked about or not. */
  takenRight: number;
  /** Went in wrong: read wrong, and the bar was sure enough not to ask. */
  takenWrong: number;
  /** Gave up on saying it. */
  walkedOut: number;
  /** Never read at all by the end of the day (the model failed, or the bar was still busy). */
  neverTaken: number;
  /** Times the bar asked "did you mean…?", and how many of those reads were in fact right. */
  asks: number;
  asksWhenRight: number;
  served: number;
  /** Served a cup that was not the drink it was for. */
  servedWrong: number;
  declined: number;
  unserved: number;
  /** Mean wait of the drinks served, in seconds of bar time, from when the customer first ordered. */
  avgWaitS: number | null;
  calls: number;
  medianMs: number | null;
  failed: number;
}

export function dayScore(
  customers: CustomerRecord[],
  drinks: Drink[],
  servedAt: Record<string, number>,
  log: readonly BarLogEntry[],
): DayScore {
  const reads = customers.flatMap((c) => c.reads);
  const customerOf = (d: Drink) => customers.find((c) => c.at === d.orderedAt && c.order.text === d.orderText);
  const waits = drinks.flatMap((d) => {
    const c = customerOf(d);
    return d.id in servedAt && c ? [(servedAt[d.id] - c.barAt) / 1000] : [];
  });
  const ms = log.filter((e) => !e.error).map((e) => e.ms).sort((a, b) => a - b);
  // The read that put an order in is its last.
  const tookRight = (c: CustomerRecord) => c.reads.at(-1)?.right === true;
  return {
    customers: customers.length,
    readRightFirst: customers.filter((c) => c.reads[0]?.right).length,
    takenRight: customers.filter((c) => c.status === 'in' && tookRight(c)).length,
    takenWrong: customers.filter((c) => c.status === 'in' && !tookRight(c)).length,
    walkedOut: customers.filter((c) => c.status === 'walked').length,
    neverTaken: customers.filter((c) => c.status === 'waiting').length,
    asks: reads.filter((r) => r.asked).length,
    asksWhenRight: reads.filter((r) => r.asked && r.right).length,
    served: drinks.filter((d) => d.status === 'served').length,
    servedWrong: drinks.filter((d) => d.status === 'served' && !d.served?.correct).length,
    declined: drinks.filter((d) => d.status === 'declined').length,
    unserved: drinks.filter((d) => d.status === 'queued').length,
    avgWaitS: waits.length ? waits.reduce((a, b) => a + b, 0) / waits.length : null,
    calls: log.length,
    medianMs: ms.length ? ms[Math.floor(ms.length / 2)] : null,
    failed: log.filter((e) => e.error).length,
  };
}
