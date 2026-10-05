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
import { answersToParsedOrder, parseRequest, type Answers } from './jev-core';
import { userKey } from './key';
import { logged } from './jevLog';
import type { BarSnapshot, ParsedOrder } from './types';

/** Is Jev configured? The page checks before opening the bar. */
export const jevAvailable = createServerFn({ method: 'GET' }).handler(async () => Boolean(process.env.TYPESAFE_API_KEY));

let envClient: TypeSafeClient | null = null;

/** The server's own key if it has one; otherwise the key that came with the request, for this call only. */
function clientFor(apiKey: string | undefined): TypeSafeClient {
  if (process.env.TYPESAFE_API_KEY) return (envClient ??= new TypeSafeClient({ timeout: 30_000 }));
  if (!apiKey) throw new Error('No Jev key: set TYPESAFE_API_KEY, or give one on the page.');
  return new TypeSafeClient({ apiKey, timeout: 30_000 });
}

async function ask(apiKey: string | undefined, state: unknown, questions: Record<string, unknown>): Promise<Answers> {
  // The SDK's question types are structurally identical to what we build here;
  // the cast keeps the dynamic (per-request) criteria maps out of the generics.
  const result = await clientFor(apiKey).systemOne({
    state: state as never,
    questions: questions as never,
  });
  return result.answers as unknown as Answers;
}

/**
 * Parse what the customer said into an order, with your key if you gave one.
 * The request is built here and sent through `askJev` like the agents' are,
 * so it is logged with them (see `jevLog`).
 */
export async function parseOrder(text: string): Promise<ParsedOrder> {
  const { phrases, state, questions } = parseRequest(text);
  const started = Date.now();
  const { answers } = await sendParse({ state, questions: questions as JevRequest['questions'] });
  return answersToParsedOrder(answers as unknown as Answers, phrases.length, { latencyMs: Date.now() - started });
}

const sendParse = logged('parser', (request) => askJev({ data: { request, apiKey: userKey() ?? undefined } }));

/** Which agent is asking: the barista's requests carry extra questions. */
type AgentKind = 'barista' | 'router' | 'light';

const askJev = createServerFn({ method: 'POST' })
  .validator((input: { request: JevRequest; apiKey?: string }) => input)
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
