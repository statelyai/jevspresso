/**
 * Server-side decision models: TanStack Start server functions, and every
 * provider is only called inside them. Keys come from the environment
 * (`TYPESAFE_API_KEY` for Jev, and see `PROVIDERS` for the rest), in
 * development too, and then never reach the browser. Without Jev's, the bar
 * is closed (`jevAvailable`), unless you give a key of your own: it stays in
 * your browser (`lib/key.ts`) and comes along with each Jev request, used for
 * that one call and never kept here.
 */
import { createServerFn } from '@tanstack/react-start';
import { TypeSafeClient } from '@typesafe-ai/sdk';
import type { JevClient, JevRequest, JevResponse } from '@xstate/jev';
import { baristaQuestions } from './barista';
import { answersToParsedOrder, buildParseQuestions, type Answers } from './jev-core';
import { userKey } from './key';
import { logged } from './jevLog';
import type { ModelId } from './models';
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

type Ask = (state: unknown, questions: Record<string, unknown>, apiKey?: string) => Promise<Answers>;

// The SDK's question types are structurally identical to what we build here;
// the casts keep the dynamic (per-request) criteria maps out of the generics.
async function systemOne(client: TypeSafeClient, state: unknown, questions: Record<string, unknown>): Promise<Answers> {
  const result = await client.systemOne({ state: state as never, questions: questions as never });
  return result.answers as unknown as Answers;
}

let kevClient: TypeSafeClient | null = null;

type ClefModel = 'clef' | 'clef-flash' | 'clef-omni';

/** Clef takes at most this many questions in one request. */
const CLEF_MAX_QUESTIONS = 64;

/**
 * Clef on Workers AI: Jev's request and answers. A request with more questions
 * than Clef takes (an order's parse has 81) goes as several at once, over the
 * same state, and their answers are put back together.
 */
async function askClef(model: ClefModel, state: unknown, questions: Record<string, unknown>): Promise<Answers> {
  const { CLOUDFLARE_ACCOUNT_ID: account, CLOUDFLARE_API_TOKEN: token } = process.env;
  if (!account || !token) throw new Error('No Clef key: set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN.');
  const entries = Object.entries(questions);
  const chunks = Array.from({ length: Math.ceil(entries.length / CLEF_MAX_QUESTIONS) }, (_, i) =>
    Object.fromEntries(entries.slice(i * CLEF_MAX_QUESTIONS, (i + 1) * CLEF_MAX_QUESTIONS)),
  );
  const answers = await Promise.all(
    chunks.map(async (chunk) => {
      const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/ai/run/@cf/cloudflare/${model}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, state, questions: chunk }),
        signal: AbortSignal.timeout(30_000),
      });
      // The REST API wraps what the model returns in `result`; taken either way.
      const payload = (await response.json()) as { result?: { answers?: Answers }; answers?: Answers; errors?: { message?: string }[] };
      if (!response.ok) throw new Error(payload.errors?.[0]?.message || `Clef returned ${response.status}`);
      const got = payload.result?.answers ?? payload.answers;
      if (!got) throw new Error('Clef returned no answers');
      return got;
    }),
  );
  return Object.assign({}, ...answers);
}

/** How each model is reached. All of them take Jev's request shape. */
const PROVIDERS: Record<ModelId, Ask> = {
  jev: (state, questions, apiKey) => systemOne(clientFor(apiKey), state, questions),
  // Kev serves TypeSafe's API (`POST /v1/systemone`), so the SDK talks to it as is.
  kev: (state, questions) => {
    if (!process.env.KEV_BASE_URL) throw new Error('No Kev server: set KEV_BASE_URL.');
    kevClient ??= new TypeSafeClient({ baseURL: process.env.KEV_BASE_URL, apiKey: process.env.KEV_API_KEY || 'kev', timeout: 30_000 });
    return systemOne(kevClient, state, questions);
  },
  clef: (state, questions) => askClef('clef', state, questions),
  'clef-flash': (state, questions) => askClef('clef-flash', state, questions),
  'clef-omni': (state, questions) => askClef('clef-omni', state, questions),
  // In limited preview, and its request format is not published yet.
  openai: async () => {
    throw new Error('The OpenAI Decisions API is not available yet.');
  },
};

/** Which models this server can reach. Jev also counts as reachable with a key given on the page. */
export const modelsAvailable = createServerFn({ method: 'GET' }).handler(
  async (): Promise<Record<ModelId, boolean>> => ({
    jev: Boolean(process.env.TYPESAFE_API_KEY),
    kev: Boolean(process.env.KEV_BASE_URL),
    clef: Boolean(process.env.CLOUDFLARE_ACCOUNT_ID && process.env.CLOUDFLARE_API_TOKEN),
    'clef-flash': Boolean(process.env.CLOUDFLARE_ACCOUNT_ID && process.env.CLOUDFLARE_API_TOKEN),
    'clef-omni': Boolean(process.env.CLOUDFLARE_ACCOUNT_ID && process.env.CLOUDFLARE_API_TOKEN),
    openai: false,
  }),
);

const askModel = createServerFn({ method: 'POST' })
  .validator((input: { model: ModelId; request: JevRequest; apiKey?: string }) => input)
  .handler(async ({ data: { model, request, apiKey } }): Promise<JevResponse> => {
    return { answers: (await PROVIDERS[model](request.state, request.questions, apiKey)) as JevResponse['answers'] };
  });

/** Which agent is asking: the barista's requests carry extra questions. */
type AgentKind = 'barista' | 'router' | 'light' | 'parse';

/**
 * The `@xstate/jev` client (the adapter) for one model: every request goes
 * through the server function. The barista's adapter also adds its extra
 * questions to each request; they ride along in the same call and do not
 * affect the decision.
 */
export function decisionClient(kind: AgentKind, model: ModelId = 'jev'): JevClient {
  // Logged as sent, extra questions included (see `jevLog`); the key travels beside the request, never in it.
  const send = logged(kind, (request) => askModel({ data: { model, request, apiKey: userKey() ?? undefined } }), model);
  return (request) =>
    send(
      kind === 'barista'
        ? { ...request, questions: { ...request.questions, ...baristaQuestions(request.state as BarSnapshot) } }
        : request,
    );
}

/** Parse what the customer said into an order, by a model (Jev unless told otherwise). */
export async function parseOrder(text: string, client: JevClient = decisionClient('parse')): Promise<ParsedOrder> {
  const started = Date.now();
  const { answers } = await client({
    state: { customer_said: text, menu: 'espresso, americano, latte, cappuccino, flat white, cortado, macchiato, café breve, mocha, hot chocolate' },
    questions: buildParseQuestions() as JevRequest['questions'],
  });
  return { ...answersToParsedOrder(answers as unknown as Answers, { latencyMs: Date.now() - started }), text };
}
