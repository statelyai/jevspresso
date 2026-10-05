/**
 * The order parser against real Jev, on the orders in `orders.ts`. It runs
 * only as `pnpm test:live` (vitest's `--mode live`), with TYPESAFE_API_KEY
 * set in the environment or in `.env`; `pnpm test` stays offline even with a
 * key in `.env`.
 *
 * Each case makes one Jev call, the same request `parseOrder` in
 * `lib/jev.ts` sends.
 */
import { TypeSafeClient } from '@typesafe-ai/sdk';
import { loadEnv } from 'vite';
import { afterAll, describe, expect, it } from 'vitest';
import { answersToParsedOrder, parseRequest, phraseKey, type Answers, type AnyAnswer } from '../lib/jev-core';
import type { ParsedOrder } from '../lib/types';
import { ORDERS } from './orders';

const live = import.meta.env.MODE === 'live';
const apiKey = live ? process.env.TYPESAFE_API_KEY || loadEnv('live', process.cwd(), '').TYPESAFE_API_KEY : undefined;

/** The parse request `parseOrder` in `lib/jev.ts` sends, and its answers mapped to an order. */
async function parse(typesafe: TypeSafeClient, text: string): Promise<{ order: ParsedOrder; phrases: string[] }> {
  const { phrases, state, questions } = parseRequest(text);
  const started = Date.now();
  const result = await typesafe.systemOne({ state: state as never, questions: questions as never });
  const order = answersToParsedOrder(result.answers as unknown as Answers, phrases.length, { latencyMs: Date.now() - started });
  return { order, phrases };
}

/**
 * What Jev answered for each phrase, one line each: shown when a case fails.
 * Every answer whose id starts with the phrase's key, so it follows the
 * questions in `jev-core` as they change.
 */
function perPhrase(phrases: string[], answers: Answers): string {
  const show = (a: AnyAnswer) => {
    if (a.type === 'noul') return a.noul.toFixed(2);
    if (a.type === 'choice') return `${a.choice} ${(a.probabilities[a.choice] ?? 0).toFixed(2)} (conf ${a.confidence.toFixed(2)})`;
    return String(a.score);
  };
  return phrases
    .map((text, i) => {
      const key = `${phraseKey(i)}_`;
      const said = Object.entries(answers)
        .filter(([id]) => id.startsWith(key))
        .map(([id, a]) => `${id.slice(key.length)} ${show(a)}`);
      return `  ${phraseKey(i)} "${text}": ${said.join('; ')}`;
    })
    .join('\n');
}

/** Every cup an order comes to, as `drink modifier…`, sorted. */
function cups(order: ParsedOrder): string[] {
  return order.items
    .flatMap((item) => {
      const mods = [
        item.milk && `milk=${item.milk}`,
        item.size && item.size !== 'regular' && `size=${item.size}`, // regular is what an unstated size becomes
        item.decaf && 'decaf',
        item.iced && 'iced',
      ].filter(Boolean);
      return Array.from({ length: item.qty }, () => [item.drink, ...mods].join(' '));
    })
    .sort();
}

describe.skipIf(!apiKey)('orders against real Jev', () => {
  // Made on first use: a skipped describe still runs its body, and the client
  // throws without a key.
  let client: TypeSafeClient | undefined;
  const typesafe = () => (client ??= new TypeSafeClient({ apiKey, timeout: 30_000 }));

  // The app reads an order back below 0.5 (`clarifying`), right or not: listed here, not failed.
  const readBack: string[] = [];
  afterAll(() => {
    if (readBack.length) console.log(`Read back (confidence < 0.5), ${readBack.length} of ${ORDERS.length}:\n${readBack.join('\n')}`);
  });

  it.each(ORDERS.map((o) => [o.text, o] as const))('%s', async (_, o) => {
    const { order, phrases } = await parse(typesafe(), o.text);
    const got = cups(order);
    if (order.intent === 'order' && order.confidence < 0.5) readBack.push(`  ${order.confidence.toFixed(2)}  ${o.text}`);
    const why =
      `got [${got.join(', ')}], intent ${order.intent}, confidence ${order.confidence}${o.note ? ` (${o.note})` : ''}\n` +
      perPhrase(phrases, order.raw);
    if (o.intent) expect(order.intent, why).toBe(o.intent);
    expect(got, why).toEqual([...o.cups].sort());
  }, 60_000);
});
