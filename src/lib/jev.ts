/**
 * Server-side decision models: TanStack Start server functions, and every
 * model is only called inside them. A model is reached directly, with its
 * maker's key, or through a gateway (OpenRouter, Vercel AI Gateway), where one
 * key reaches every model the gateway carries. Keys come from the environment
 * (see `.env.template`), in development too, and then never reach the browser.
 * Without them, you can give your own: they stay in your browser
 * (`lib/key.ts`) and come along with the requests they can serve, used for
 * that one call and never kept here.
 */
import { createServerFn } from '@tanstack/react-start';
import { TypeSafeClient } from '@typesafe-ai/sdk';
import type { JevClient, JevRequest, JevResponse } from '@xstate/jev';
import { baristaQuestions } from './barista';
import { answersToParsedOrder, buildParseQuestions, type Answers } from './jev-core';
import { keysFor, type PageKeys } from './key';
import { logged } from './jevLog';
import { GATEWAYS, isModelId, JEV_MODEL, MODELS, modelInfo, type ModelId, type ModelInfo } from './models';
import type { BarSnapshot, ParsedOrder } from './types';

/** One way to a model: who answers it, with what key. */
type Route =
  | { via: 'typesafe'; key: string }
  | { via: 'kev'; baseURL: string; key?: string }
  | { via: 'cloudflare'; account: string; token: string }
  | { via: 'openrouter'; key: string; model: string }
  | { via: 'vercel'; key: string; model: string };

/**
 * How a request reaches a model: the server's keys before yours, and of each,
 * the maker's own before a gateway's.
 */
export function routeFor(info: ModelInfo, keys: PageKeys = {}): Route | null {
  const env = process.env;
  const routes = (k: {
    typesafe?: string;
    kev?: string;
    account?: string;
    token?: string;
    openrouter?: string;
    vercel?: string;
  }): (Route | null)[] => [
    info.id === 'jev' && k.typesafe ? { via: 'typesafe', key: k.typesafe } : null,
    info.id === 'kev' && k.kev ? { via: 'kev', baseURL: k.kev, key: env.KEV_API_KEY } : null,
    info.provider === 'cloudflare' && k.account && k.token ? { via: 'cloudflare', account: k.account, token: k.token } : null,
    info.gateways.openrouter && k.openrouter ? { via: 'openrouter', key: k.openrouter, model: info.gateways.openrouter } : null,
    info.gateways.vercel && k.vercel ? { via: 'vercel', key: k.vercel, model: info.gateways.vercel } : null,
  ];
  return (
    [
      ...routes({
        typesafe: env.TYPESAFE_API_KEY,
        kev: env.KEV_BASE_URL,
        account: env.CLOUDFLARE_ACCOUNT_ID,
        token: env.CLOUDFLARE_API_TOKEN,
        openrouter: env.OPENROUTER_API_KEY,
        vercel: env.AI_GATEWAY_API_KEY,
      }),
      ...routes({
        typesafe: keys.typesafe?.key,
        account: keys.cloudflare?.account,
        token: keys.cloudflare?.token,
        openrouter: keys.openrouter?.key,
        vercel: keys.vercel?.key,
      }),
    ].find((r) => r !== null) ?? null
  );
}

interface ClefPayload {
  result?: { response?: { answers?: Answers }; answers?: Answers };
  answers?: Answers;
  errors?: { message?: string }[];
}

export function clefAnswers(payload: ClefPayload): Answers | undefined {
  return payload.result?.response?.answers ?? payload.result?.answers ?? payload.answers;
}

// The SDK's question types are structurally identical to what we build here;
// the casts keep the dynamic (per-request) criteria maps out of the generics.
async function systemOne(client: TypeSafeClient, model: string, state: unknown, questions: Record<string, unknown>): Promise<Answers> {
  const result = await client.systemOne({ model, state: state as never, questions: questions as never });
  return result.answers as unknown as Answers;
}

/** One request, one way. Everyone takes Jev's request shape; only the envelopes differ. */
async function askVia(route: Route, info: ModelInfo, state: unknown, questions: Record<string, unknown>): Promise<Answers> {
  switch (route.via) {
    case 'typesafe':
      return systemOne(new TypeSafeClient({ apiKey: route.key, timeout: 30_000 }), JEV_MODEL, state, questions);
    // Kev serves TypeSafe's API (`POST /v1/systemone`), and Vercel's gateway a TypeSafe-compatible one: the SDK talks to both as is.
    case 'kev':
      return systemOne(new TypeSafeClient({ baseURL: route.baseURL, apiKey: route.key || 'kev', timeout: 30_000, compression: false }), 'kev', state, questions);
    case 'vercel':
      return systemOne(
        new TypeSafeClient({ baseURL: 'https://ai-gateway.vercel.sh/typesafe', apiKey: route.key, timeout: 30_000, compression: false }),
        route.model,
        state,
        questions,
      );
    case 'openrouter': {
      // The Decisions API, which every decision model on OpenRouter answers.
      const response = await fetch('https://openrouter.ai/api/alpha/decisions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${route.key}`, 'Content-Type': 'application/json', 'X-Title': 'Jevspresso' },
        body: JSON.stringify({ model: route.model, state, questions }),
        signal: AbortSignal.timeout(30_000),
      });
      const payload = (await response.json()) as { answers?: Answers; error?: { message?: string } };
      if (!response.ok) throw new Error(payload.error?.message || `OpenRouter returned ${response.status}`);
      if (!payload.answers) throw new Error('OpenRouter returned no answers');
      return payload.answers;
    }
    case 'cloudflare': {
      // It goes into the URL: an account ID, and nothing else.
      if (!/^[0-9a-f]{32}$/i.test(route.account)) throw new Error('That is not a Cloudflare account ID (32 hex characters).');
      const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${route.account}/ai/run/@cf/cloudflare/${info.id}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${route.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: info.id, state, questions }),
        signal: AbortSignal.timeout(30_000),
      });
      // The REST API wraps what the model returns in `result`; taken either way.
      const payload = (await response.json()) as ClefPayload;
      if (!response.ok) throw new Error(payload.errors?.[0]?.message || `Clef returned ${response.status}`);
      const got = clefAnswers(payload);
      if (!got) throw new Error('Clef returned no answers');
      return got;
    }
  }
}

/** What to set, or give, for a model nothing can reach yet. */
function needs(info: ModelInfo): string {
  const own =
    info.id === 'jev' ? 'TYPESAFE_API_KEY' : info.id === 'kev' ? 'KEV_BASE_URL' : info.provider === 'cloudflare' ? 'CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN' : null;
  const gateways = (Object.keys(info.gateways) as (keyof typeof GATEWAYS)[]).map((g) => (g === 'openrouter' ? 'OPENROUTER_API_KEY' : 'AI_GATEWAY_API_KEY'));
  return `No key for ${info.label}: set ${[own, ...gateways].filter(Boolean).join(' or ')}, or give one on the page.`;
}

/**
 * Ask a model, the way it can be reached. A request with more questions than
 * the model takes (an order's parse has 81; Clef takes 64) goes as several at
 * once, over the same state, and their answers are put back together.
 */
export async function ask(model: ModelId, state: unknown, questions: Record<string, unknown>, keys?: PageKeys): Promise<Answers> {
  const info = modelInfo(model);
  const route = routeFor(info, keys);
  if (!route) throw new Error(needs(info));
  const entries = Object.entries(questions);
  const size = info.maxQuestions ?? entries.length;
  const chunks = Array.from({ length: Math.ceil(entries.length / size) }, (_, i) => Object.fromEntries(entries.slice(i * size, (i + 1) * size)));
  return Object.assign({}, ...(await Promise.all(chunks.map((chunk) => askVia(route, info, state, chunk)))));
}

interface AskModelInput {
  model: ModelId;
  request: JevRequest;
  keys?: PageKeys;
}

export function validateAskModelInput(input: AskModelInput): AskModelInput {
  if (!isModelId(input.model)) {
    throw new Error(`Unknown model: ${String(input.model)}`);
  }
  return input;
}

/** Which models this server can reach with its own keys. Any of them can also take yours, from the page. */
export const modelsAvailable = createServerFn({ method: 'GET' }).handler(
  async (): Promise<Record<ModelId, boolean>> => Object.fromEntries(MODELS.map((m) => [m.id, routeFor(m) !== null])) as Record<ModelId, boolean>,
);

const askModel = createServerFn({ method: 'POST' })
  .validator(validateAskModelInput)
  .handler(async ({ data: { model, request, keys } }): Promise<JevResponse> => {
    return { answers: (await ask(model, request.state, request.questions, keys)) as JevResponse['answers'] };
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
  // Logged as sent, extra questions included (see `jevLog`); keys travel beside the request, never in it.
  const send = logged(kind, (request) => askModel({ data: { model, request, keys: keysFor(model) } }), model);
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
