/**
 * Server-side Jev wrapper: TanStack Start server functions, and the SDK
 * client is only constructed inside them. The key comes from the environment
 * (`TYPESAFE_API_KEY`), in development too, and then never reaches the
 * browser. Without it the bar is closed (`jevAvailable`), unless you give a
 * key of your own: it stays in your browser (`lib/key.ts`) and comes along
 * with each request, used for that one call and never kept here.
 */
import { createServerFn } from '@tanstack/react-start';
import { TypeSafeClient } from '@typesafe-ai/sdk';
import type { JevClient, JevRequest, JevResponse } from '@xstate/jev';
import { baristaQuestions } from './barista';
import { answersToParsedOrder, buildParseQuestions, type Answers } from './jev-core';
import { userKey, type UserKey } from './key';
import { logged } from './jevLog';
import type { BarSnapshot, ParsedOrder } from './types';

/** Is Jev configured? The page checks before opening the bar. */
export const jevAvailable = createServerFn({ method: 'GET' }).handler(async () =>
  Boolean(process.env.TYPESAFE_API_KEY || process.env.OPENROUTER_API_KEY),
);

let envClient: TypeSafeClient | null = null;

/** Send Jev's native decision request through OpenRouter. */
export async function askOpenRouter(state: unknown, questions: Record<string, unknown>, apiKey = process.env.OPENROUTER_API_KEY): Promise<Answers> {
  const response = await fetch('https://openrouter.ai/api/alpha/decisions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'X-Title': 'Jevspresso',
    },
    body: JSON.stringify({ model: process.env.JEV_MODEL || '~typesafe/jev-latest', state, questions }),
    signal: AbortSignal.timeout(30_000),
  });
  const payload = (await response.json()) as { answers?: Answers; error?: { message?: string } };
  if (!response.ok) throw new Error(payload.error?.message || `OpenRouter returned ${response.status}`);
  if (!payload.answers) throw new Error('OpenRouter returned no Jev answers');
  return payload.answers;
}

/** The server's TypeSafe key takes precedence; OpenRouter is an optional server-side fallback. */
async function ask(apiKey: UserKey | undefined, state: unknown, questions: Record<string, unknown>): Promise<Answers> {
  if (!process.env.TYPESAFE_API_KEY && (process.env.OPENROUTER_API_KEY || apiKey?.provider === 'openrouter')) {
    return askOpenRouter(state, questions, process.env.OPENROUTER_API_KEY || apiKey?.key);
  }
  const client = process.env.TYPESAFE_API_KEY
    ? (envClient ??= new TypeSafeClient({ timeout: 30_000 }))
    : apiKey?.provider === 'typesafe'
      ? new TypeSafeClient({ apiKey: apiKey.key, timeout: 30_000 })
      : null;
  if (!client) throw new Error('No Jev key: set TYPESAFE_API_KEY or OPENROUTER_API_KEY, or give one on the page.');
  // The SDK's question types are structurally identical to what we build here;
  // the cast keeps the dynamic (per-request) criteria maps out of the generics.
  const result = await client.systemOne({ state: state as never, questions: questions as never });
  return result.answers as unknown as Answers;
}

const parseOrderFn = createServerFn({ method: 'POST' })
  .validator((input: { text: string; apiKey?: UserKey }) => input)
  .handler(async ({ data: { text, apiKey } }): Promise<ParsedOrder> => {
    const started = Date.now();
    const answers = await ask(
      apiKey,
      { customer_said: text, menu: 'espresso, americano, latte, cappuccino, flat white, cortado, macchiato, café breve, mocha, hot chocolate' },
      buildParseQuestions(),
    );
    return answersToParsedOrder(answers, { latencyMs: Date.now() - started });
  });

/** Parse what the customer said into an order, with your key if you gave one. */
export function parseOrder(text: string): Promise<ParsedOrder> {
  return parseOrderFn({ data: { text, apiKey: userKey() ?? undefined } });
}

/** Which agent is asking: the barista's requests carry extra questions. */
type AgentKind = 'barista' | 'router';

const askJev = createServerFn({ method: 'POST' })
  .validator((input: { request: JevRequest; apiKey?: UserKey }) => input)
  .handler(async ({ data: { request, apiKey } }): Promise<JevResponse> => {
    return { answers: (await ask(apiKey, request.state, request.questions)) as JevResponse['answers'] };
  });

/**
 * The `@xstate/jev` client (the adapter): every request goes through the
 * server function. The barista's adapter also adds its extra questions to
 * each request; they ride along in the same call and do not affect the
 * decision.
 */
export function jevClient(kind: AgentKind): JevClient {
  // Logged as sent, extra questions included (see `jevLog`); the key travels beside the request, never in it.
  const send = logged(kind, (request) => askJev({ data: { request, apiKey: userKey() ?? undefined } }));
  return (request) =>
    send(
      kind === 'barista'
        ? { ...request, questions: { ...request.questions, ...baristaQuestions(request.state as BarSnapshot) } }
        : request,
    );
}
