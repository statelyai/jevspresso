/**
 * The order parser against real Jev, on the orders in `orders.ts`. Skipped
 * unless TYPESAFE_API_KEY is set (in the environment or in `.env`), so
 * `pnpm test` stays offline. Run it on its own:
 *
 *     pnpm vitest run orders.live
 *
 * Each case makes one Jev call, the same request `parseOrder` in
 * `lib/jev.ts` sends.
 */
import { TypeSafeClient } from '@typesafe-ai/sdk';
import { loadEnv } from 'vite';
import { describe, expect, it } from 'vitest';
import { answersToParsedOrder, parseRequest, qId, type Answers } from '../lib/jev-core';
import type { ParsedOrder } from '../lib/types';
import { ORDERS } from './orders';

const apiKey = process.env.TYPESAFE_API_KEY || loadEnv('test', process.cwd(), '').TYPESAFE_API_KEY;

/** The parse request `parseOrder` in `lib/jev.ts` sends, and its answers mapped to an order. */
async function parse(typesafe: TypeSafeClient, text: string): Promise<{ order: ParsedOrder; phrases: string[] }> {
  const { phrases, state, questions } = parseRequest(text);
  const started = Date.now();
  const result = await typesafe.systemOne({ state: state as never, questions: questions as never });
  const order = answersToParsedOrder(result.answers as unknown as Answers, phrases.length, { latencyMs: Date.now() - started });
  return { order, phrases };
}

/** What Jev answered for each phrase, one line each: shown when a case fails. */
function perPhrase(phrases: string[], answers: Answers): string {
  const p = (id: string) => {
    const a = answers[id];
    if (!a) return '-';
    if (a.type === 'noul') return a.noul.toFixed(2);
    if (a.type === 'choice') return `${a.choice} ${(a.probabilities[a.choice] ?? 0).toFixed(2)} (conf ${a.confidence.toFixed(2)})`;
    return String(a.score);
  };
  return phrases
    .map(
      (text, i) =>
        `  p${i + 1} "${text}": drink ${p(qId.drink(i))}; detail ${i > 0 ? p(qId.detail(i)) : 'n/a'}; qty ${p(qId.qty(i))}; ` +
        `milk ${p(qId.milk(i))}, stated ${p(qId.milkStated(i))}; size ${p(qId.size(i))}, stated ${p(qId.sizeStated(i))}; ` +
        `decaf ${p(qId.decaf(i))}; iced ${p(qId.iced(i))}`,
    )
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

  it.each(ORDERS.map((o) => [o.text, o] as const))('%s', async (_, o) => {
    const { order, phrases } = await parse(typesafe(), o.text);
    const got = cups(order);
    const why =
      `got [${got.join(', ')}], intent ${order.intent}, confidence ${order.confidence}${o.note ? ` (${o.note})` : ''}\n` +
      perPhrase(phrases, order.raw);
    if (o.intent) expect(order.intent, why).toBe(o.intent);
    expect(got, why).toEqual([...o.cups].sort());
  }, 60_000);
});
