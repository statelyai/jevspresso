/**
 * What each part of what Jev is shown is worth: run the scenarios with one
 * part taken out of every request, and compare. Each ablation rewrites the
 * request on its way to Jev, so nothing in the library or the bar changes.
 */
import type { JevClient, JevOptions, JevRequest } from '@xstate/jev';
import { barista } from '../lib/barista';
import type { BarContext, BarEvent } from '../lib/types';

export interface Ablation {
  id: string;
  label: string;
  /** The request as Jev would see it without this part. */
  strip?: (request: JevRequest) => JevRequest;
  /** Or the barista's agent asked differently: its own settings, through the library. */
  agent?: Partial<JevOptions<BarEvent, BarContext>>;
}

type Criteria = Record<string, string>;
type Question = { instructions?: string; criteria?: Criteria };

/** Every question, rewritten. */
function eachQuestion(request: JevRequest, edit: (id: string, q: Question) => Question): JevRequest {
  const questions = Object.fromEntries(
    Object.entries(request.questions).map(([id, q]) => [id, edit(id, q as Question)]),
  ) as JevRequest['questions'];
  return { ...request, questions };
}

/** Every criterion of every choice question, rewritten. */
function eachCriterion(request: JevRequest, edit: (text: string, option: string, questionId: string) => string): JevRequest {
  return eachQuestion(request, (id, q) =>
    q.criteria ? { ...q, criteria: Object.fromEntries(Object.entries(q.criteria).map(([k, v]) => [k, edit(String(v), k, id)])) } : q,
  );
}

const AFTERWARDS = / \(afterwards: [\s\S]*\)$/;
/** The refused moves, one line in each question's instructions (variant questions go on after it). */
const REFUSED = /\n\nNot possible right now[^\n]*/;

/**
 * The goal, for a request without the extras: what a barista knows, said
 * once, in words, instead of shown per option.
 */
export const PLAIN_GOAL = [
  'Goal: serve every open order exactly what it ordered, as fast as you can, the longest-waiting first. With no order open, wait, or tidy up (knock out a spent puck, put away or pour away cups no order needs); do not start drinks nobody ordered.',
  "How the bar works: an order's recipe lists what goes into its cup, in order. A cup that gets a shot or hot water starts on the drip tray: the spouts and the hot water reach only the tray. Milk is poured at the front, so a milk drink's cup is brought forward once everything from the tray is in. A shot is grind, tamp, lock in, then pull, into whatever cup is on the tray; knock out the spent puck before the next grind. Steam the milk an order asks for, then pour it into that order's cup at the front. Serve a cup only when it holds exactly an order's recipe.",
  "A cup's `onTrackFor` is the order it can still become, and `matches` the order it already is. If an ingredient runs out, restock it; if a machine is broken, repair it. While a machine runs on its own, wait or do something else. A second barista (a person) may work the bar too, and leave cups no order could become: pour those away or put them away.",
].join('\n\n');

/** Only what an option comes to once done, from its lookahead; nothing for one without a `Once done` (waiting). */
function outcomeOnly(text: string): string {
  const look = AFTERWARDS.exec(text)?.[0];
  if (!look) return text;
  const done = /Once done \(after [\d.]+s\): ([\s\S]*)\)$/.exec(look)?.[1];
  return text.replace(AFTERWARDS, done ? ` (once done: ${done})` : '');
}

/**
 * The request with options, their descriptions, the state and a fuller goal
 * only: no refused moves, no `next` or `blockedBy`, and each option's
 * lookahead cut to `keep` (nothing, or only what it comes to once done).
 */
function plain(r: JevRequest, keep: 'nothing' | 'outcome'): JevRequest {
  const state = withoutQueueField(withoutQueueField(r, 'next'), 'blockedBy').state;
  const trimmed = eachQuestion({ ...r, state }, (_, q) =>
    q.instructions ? { ...q, instructions: q.instructions.replace(REFUSED, '').replace(String(barista.instructions), PLAIN_GOAL) } : q,
  );
  const cut = (text: string) => {
    const t = text.replace(dropLines(String.raw`queue\[\d+\]\.(?:next|blockedBy)`), '');
    return keep === 'outcome' ? outcomeOnly(t) : t.replace(AFTERWARDS, '');
  };
  return eachCriterion(trimmed, (text, option, questionId) => {
    const variants = (r.questions[`variant:${option}`] as Question | undefined)?.criteria;
    if (questionId !== 'event_type' || !variants) return cut(text);
    // A type with several variants, rebuilt from its variants as cut: each by name, and (with `outcome`) what it comes to.
    const head = text.slice(0, text.indexOf(', one of'));
    const listed = Object.entries(variants).map(([id, v]) => {
      const name = id.startsWith(`${option}:`) ? id.slice(option.length + 1) : id;
      const done = / \(once done: ([\s\S]*)\)$/.exec(cut(v))?.[1];
      return done ? `${name} → ${done}` : name;
    });
    return `${head}, one of ${listed.length}: ${listed.join('; ')}`;
  });
}

/** A JSON value in a diff line: a string, `null`, a number or `(none)`. */
const VALUE = String.raw`(?:"(?:[^"\\]|\\.)*"|null|-?[\d.]+|\(none\))`;
/** Take every `path: before → after` line whose path matches out of a lookahead. */
const dropLines = (path: string) => new RegExp(String.raw`${path}: ${VALUE} → ${VALUE}(?:; )?`, 'g');

/** The queue in Jev's view, without a field. */
function withoutQueueField(request: JevRequest, field: string): JevRequest {
  const state = request.state as { queue?: Array<Record<string, unknown>> };
  if (!state?.queue) return request;
  return { ...request, state: { ...state, queue: state.queue.map(({ [field]: _, ...rest }) => rest) } };
}

export const ABLATIONS: Ablation[] = [
  { id: 'all', label: 'Everything (as shipped)' },
  { id: 'compact', label: 'Lookahead: only what each option comes to', agent: { lookahead: { show: 'done' } } },
  { id: 'hierarchical', label: 'Two questions: the kind of move, then which', agent: { strategy: 'hierarchical' } },
  {
    id: 'no-refused',
    label: 'No list of refused moves',
    strip: (r) => eachQuestion(r, (_, q) => (q.instructions ? { ...q, instructions: q.instructions.replace(REFUSED, '') } : q)),
  },
  {
    id: 'no-next',
    label: "No order's next step",
    strip: (r) => eachCriterion(withoutQueueField(r, 'next'), (text) => text.replace(dropLines(String.raw`queue\[\d+\]\.next`), '')),
  },
  {
    id: 'no-blocked',
    label: 'No blockedBy',
    strip: (r) => eachCriterion(withoutQueueField(r, 'blockedBy'), (text) => text.replace(dropLines(String.raw`queue\[\d+\]\.blockedBy`), '')),
  },
  {
    id: 'no-wait-lookahead',
    label: 'Waiting says nothing of what it comes to',
    strip: (r) => eachCriterion(r, (text, option) => (option === 'noop' ? text.replace(AFTERWARDS, '') : text)),
  },
  {
    id: 'plain',
    label: 'Plain: options, descriptions, state and a fuller goal',
    strip: (r) => plain(r, 'nothing'),
  },
  {
    id: 'plain-outcome',
    label: 'Plain, plus what each option comes to once done',
    strip: (r) => plain(r, 'outcome'),
  },
  {
    id: 'no-lookahead',
    label: 'No lookahead at all',
    strip: (r) => eachCriterion(r, (text) => text.replace(AFTERWARDS, '')),
  },
];

/** A client that sends Jev the request without the ablated part. */
export function ablated(client: JevClient, ablation: Ablation): JevClient {
  return ablation.strip ? (request) => client(ablation.strip!(request)) : client;
}
