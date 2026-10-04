import type { EventObject, MachineContext } from 'xstate';
import { machineMap } from './map';
import { collectOptions } from './options';
import {
  NOOP_ID,
  type ChoiceAnswer,
  type JevAnswer,
  type JevDecideOptions,
  type JevDecision,
  type JevOption,
  type JevOptions,
  type JevQuestion,
  type JevRequest,
  type JevSnapshot,
} from './types';

export const ACTION_Q = 'action';
export const TYPE_Q = 'event_type';
export const variantQ = (type: string) => `variant:${type}`;

function criterion(option: JevOption): string {
  return option.lookahead ? `${option.description} (afterwards: ${option.lookahead})` : option.description;
}

function typeOf(option: JevOption): string {
  return option.kind === 'event' ? option.event.type : NOOP_ID;
}

function groupByType<TEvent extends EventObject>(options: JevOption<TEvent>[]) {
  const groups = new Map<string, JevOption<TEvent>[]>();
  for (const o of options) groups.set(typeOf(o), [...(groups.get(typeOf(o)) ?? []), o]);
  return groups;
}

/** What the variants of a type share: the start of their descriptions, before the payload. */
function shared(group: JevOption[]): string {
  const [first, ...rest] = group.map((o) => o.description);
  let n = first.length;
  for (const d of rest) while (n > 0 && d.slice(0, n) !== first.slice(0, n)) n--;
  const prefix = first.slice(0, n);
  const cut = prefix.lastIndexOf(' (');
  return (cut > 0 ? prefix.slice(0, cut) : prefix).trim();
}

/**
 * A type with several variants, as one criterion: what they share, then every
 * variant by what tells it apart (its id after the type) and what it comes to
 * (its lookahead, from `Once done` when it has one). All of them: a type is
 * only as good as its best variant, and which that is is Jev's call.
 */
function typeCriterion(type: string, group: JevOption[]): string {
  const what = sharedParts(group)?.what ?? shared(group);
  const variants = group.map((o) => {
    const name = o.id.startsWith(`${type}:`) ? o.id.slice(type.length + 1) : o.id;
    const outcome = o.lookahead?.match(/Once done.*$/)?.[0] ?? o.lookahead;
    return outcome ? `${name} → ${outcome}` : name;
  });
  return `${type}${what ? ` (${what})` : ''}, one of ${group.length}: ${variants.join('; ')}`;
}

/** What every variant of a type shares, when each came from the machine and they agree: said once, in the premise. */
function sharedParts(group: JevOption[]): { what: string; notes: string } | undefined {
  const parts = group.map((o) => (o.kind === 'event' ? o.parts : undefined));
  const [first] = parts;
  if (!first || parts.some((p) => !p || p.what !== first.what || p.notes !== first.notes)) return undefined;
  return { what: first.what, notes: first.notes };
}

export function resolveStrategy(opts: JevOptions<any, any>, optionCount: number): 'flat' | 'hierarchical' {
  const strategy = opts.strategy ?? 'auto';
  if (strategy !== 'auto') return strategy;
  return optionCount <= (opts.maxFlatOptions ?? 32) ? 'flat' : 'hierarchical';
}

/**
 * `flat`: one choice over every option. `hierarchical`: one choice over event
 * types, plus one choice per multi-variant type that states its premise ("if
 * the action is X, which one?"). All of them go out in one parallel request;
 * only the chosen type's variant answer is read.
 */
export function buildQuestions(
  options: JevOption[],
  strategy: 'flat' | 'hierarchical',
  instructions: string,
): Record<string, JevQuestion> {
  if (strategy === 'flat') {
    return {
      [ACTION_Q]: {
        type: 'choice',
        instructions,
        criteria: Object.fromEntries(options.map((o) => [o.id, criterion(o)])),
      },
    };
  }

  const questions: Record<string, JevQuestion> = {};
  const typeCriteria: Record<string, string> = {};
  for (const [type, group] of groupByType(options)) {
    if (group.length === 1) {
      typeCriteria[type] = criterion(group[0]);
      continue;
    }
    typeCriteria[type] = typeCriterion(type, group);
    // What the variants share is said once, in the premise; each variant is then its payload and what it comes to.
    const common = sharedParts(group);
    const premise = common ? `: ${common.what}${common.notes ? ` (${common.notes})` : ''}` : '';
    questions[variantQ(type)] = {
      type: 'choice',
      instructions: `${instructions}\n\nAssume the action taken is \`${type}\`${premise}. Which variant of it is best?`,
      criteria: Object.fromEntries(
        group.map((o) => {
          const values = common && o.kind === 'event' ? o.parts?.values : undefined;
          return [o.id, values ? (o.lookahead ? `${values} (afterwards: ${o.lookahead})` : values) : criterion(o)];
        }),
      ),
    };
  }
  questions[TYPE_Q] = { type: 'choice', instructions, criteria: typeCriteria };
  return questions;
}

function asChoice(answer: JevAnswer | undefined): ChoiceAnswer | undefined {
  return answer?.type === 'choice' ? answer : undefined;
}

/** Map answers back to an option id, a distribution over options and a confidence. */
export function readAnswers(
  options: JevOption[],
  strategy: 'flat' | 'hierarchical',
  answers: Record<string, JevAnswer>,
): { chosen: string | undefined; probabilities: Record<string, number>; confidence: number } {
  if (strategy === 'flat') {
    const a = asChoice(answers[ACTION_Q]);
    return {
      chosen: options.some((o) => o.id === a?.choice) ? a!.choice : undefined,
      probabilities: a?.probabilities ?? {},
      confidence: a?.confidence ?? 0,
    };
  }

  const typeAnswer = asChoice(answers[TYPE_Q]);
  const groups = groupByType(options);
  const probabilities: Record<string, number> = {};
  for (const [type, group] of groups) {
    const pType = typeAnswer?.probabilities[type] ?? 0;
    const variants = asChoice(answers[variantQ(type)]);
    for (const o of group) {
      probabilities[o.id] = group.length === 1 ? pType : pType * (variants?.probabilities[o.id] ?? 0);
    }
  }

  // Greedy descent: the most likely type, then its most likely variant. The
  // least certain judgment used is the confidence of the whole decision.
  const group = typeAnswer && groups.get(typeAnswer.choice);
  if (!group) return { chosen: undefined, probabilities, confidence: 0 };
  if (group.length === 1) {
    return { chosen: group[0].id, probabilities, confidence: typeAnswer.confidence };
  }
  const variant = asChoice(answers[variantQ(typeAnswer.choice)]);
  return {
    chosen: group.some((o) => o.id === variant?.choice) ? variant!.choice : undefined,
    probabilities,
    confidence: Math.min(typeAnswer.confidence, variant?.confidence ?? 0),
  };
}

/** How big a request is, in characters of JSON. */
function sizeOf(request: JevRequest): { state: number; questions: number; total: number } {
  const state = JSON.stringify(request.state ?? null).length;
  const questions = JSON.stringify(request.questions).length;
  return { state, questions, total: JSON.stringify(request).length };
}

/** FNV-1a over the request's JSON: a short, stable fingerprint. */
function fingerprint(value: unknown): string {
  const text = JSON.stringify(value);
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

/** The options, and the exact request `decide` would send for them. */
/** What Jev sees: `opts.state`, or `{ value, context }` (plus `input` when there is one). */
export function stateOf<TEvent extends EventObject, TContext extends MachineContext>(
  snapshot: JevSnapshot<TContext, TEvent>,
  opts: JevOptions<TEvent, TContext>,
  input: unknown,
): unknown {
  return opts.state
    ? opts.state(snapshot, input)
    : { ...(input === undefined ? {} : { input }), value: snapshot.value, context: snapshot.context };
}

/** What Jev sees, with the machine's map beside it (`machine`). */
function withMap(state: unknown, map: string): unknown {
  return state && typeof state === 'object' && !Array.isArray(state) ? { ...state, machine: map } : { state, machine: map };
}

function prepare<TEvent extends EventObject, TContext extends MachineContext>(
  snapshot: JevSnapshot<TContext, TEvent>,
  opts: JevOptions<TEvent, TContext>,
  input: unknown,
) {
  const { options, refused } = collectOptions(snapshot, opts, input);
  if (!options.some((o) => o.kind === 'event')) return { options, request: null, strategy: 'none' as const };
  const strategy = resolveStrategy(opts, options.length);
  const asked = typeof opts.instructions === 'function' ? opts.instructions(snapshot, input) : opts.instructions;
  const instructions = refused.length
    ? `${asked}\n\nNot possible right now (the machine refuses these in its current state): ${refused.join(', ')}.`
    : asked;
  const seen = stateOf(snapshot, opts, input);
  const state = opts.map ? withMap(seen, machineMap(snapshot)) : seen;
  const questions = buildQuestions(options, strategy, instructions);
  return { options, request: { state, questions }, strategy };
}

/**
 * Fingerprint of the request `decide` would send right now, or `null` when
 * there is nothing to choose. Equal keys mean an identical request, so the
 * earlier decision still stands: an agent that chose not to act need not ask
 * again until the key changes. Makes no request.
 */
export function requestKey<TEvent extends EventObject, TContext extends MachineContext>(
  snapshot: JevSnapshot<TContext, TEvent>,
  opts: JevOptions<TEvent, TContext>,
  input?: unknown,
): string | null {
  const { request } = prepare(snapshot, opts, input);
  return request && fingerprint(request);
}

/**
 * Ask Jev which event to send next. Pass `input` to route external input
 * (a message, a reply) to an event instead of acting on the state alone.
 * Nothing is sent: `decision.event` is for the caller to deliver.
 */
export async function decide<TEvent extends EventObject, TContext extends MachineContext>(
  snapshot: JevSnapshot<TContext, TEvent>,
  opts: JevDecideOptions<TEvent, TContext>,
  input?: unknown,
): Promise<JevDecision<TEvent>> {
  const at = Date.now();
  const { options, request, strategy } = prepare(snapshot, opts, input);
  const base = { at, options, answers: {}, latencyMs: 0, mock: false, cached: false, sent: false };
  if (!request) {
    return {
      ...base,
      key: null,
      size: null,
      probabilities: {},
      option: null,
      event: null,
      confidence: 1,
      reason: 'no-options',
      strategy: 'none',
    };
  }

  const started = Date.now();
  const response = await opts.client(request);
  const latencyMs = Date.now() - started;

  const read = readAnswers(options, strategy, response.answers);
  const picked = options.find((o) => o.id === read.chosen);
  const confident = read.confidence >= (opts.minConfidence ?? 0);
  const option = confident && picked ? picked : null;
  return {
    ...base,
    key: fingerprint(request),
    size: sizeOf(request),
    answers: response.answers,
    latencyMs,
    mock: Boolean(response.mock),
    cached: Boolean(response.cached),
    probabilities: read.probabilities,
    strategy,
    confidence: read.confidence,
    option,
    event: option?.kind === 'event' ? option.event : null,
    reason: !confident ? 'low-confidence' : option?.kind === 'event' ? 'chosen' : 'noop',
  };
}
