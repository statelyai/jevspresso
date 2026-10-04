import {
  getNextTransitions,
  transition,
  type AnyStateMachine,
  type EventFromLogic,
  type EventObject,
  type MachineContext,
  type StandardSchemaV1,
} from 'xstate';
import { NOOP_ID, type JevOption, type JevOptionParts, type JevOptions, type JevSnapshot } from './types';

/** `'a.b'` matches `'a.b'`, `'a.*'` and `'*'`. */
export function matchesDescriptor(type: string, descriptor: string): boolean {
  if (descriptor === type || descriptor === '*') return true;
  if (!descriptor.endsWith('.*')) return false;
  return type.startsWith(descriptor.slice(0, -1));
}

function matchesAny(type: string, descriptors: string | readonly string[]): boolean {
  return (typeof descriptors === 'string' ? [descriptors] : descriptors).some((d) =>
    matchesDescriptor(type, d),
  );
}

type JsonSchema = {
  type?: string | string[];
  const?: unknown;
  enum?: unknown[];
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  description?: string;
};

type StandardSchema = {
  '~standard': {
    vendor: string;
    validate: (value: unknown) => unknown;
    jsonSchema?: { input?: (options: { target: string }) => unknown };
  };
};

/** The event schemas of a machine, keyed by event type. */
function eventSchemas(machine: AnyStateMachine): Record<string, StandardSchema> {
  return (machine.schemas?.events ?? {}) as Record<string, StandardSchema>;
}

/**
 * The runtime schema of an event Jev may choose. Throws for an event without
 * one: `types<T>()` has no runtime shape, so a missing field could not be
 * detected and an incomplete event could be sent.
 */
function runtimeSchema(machine: AnyStateMachine, type: string): StandardSchema {
  const schema = eventSchemas(machine)[type];
  if (!schema || schema['~standard'].vendor === 'xstate.types') {
    throw new Error(
      `@xstate/jev: event "${type}" needs a runtime schema such as Zod in the machine's schemas.events; types<T>() has no runtime shape.`,
    );
  }
  return schema;
}

function jsonSchema(schema: StandardSchema): JsonSchema | undefined {
  try {
    return schema['~standard'].jsonSchema?.input?.({ target: 'draft-2020-12' }) as JsonSchema | undefined;
  } catch {
    return undefined;
  }
}

/** Every value a schema allows, when that set is finite. */
function finiteValues(schema: JsonSchema): unknown[] | undefined {
  if ('const' in schema) return [schema.const];
  if (schema.enum) return schema.enum;
  if (schema.type === 'boolean') return [true, false];
  const union = schema.anyOf ?? schema.oneOf;
  if (union) {
    const parts = union.map(finiteValues);
    if (parts.every(Boolean)) return [...new Set(parts.flat())];
  }
  return undefined;
}

const warned = new Set<string>();
function warnOnce(message: string) {
  if (warned.has(message)) return;
  warned.add(message);
  console.warn(`[@xstate/jev] ${message}`);
}

/** Fill required fields the payload left out, one payload per allowed value. */
function expand(type: string, payload: Record<string, unknown>, schema: JsonSchema | undefined) {
  let out = [payload];
  for (const key of schema?.required ?? []) {
    if (key in payload) continue;
    const values = schema?.properties?.[key] && finiteValues(schema.properties[key]);
    if (!values) {
      warnOnce(`"${type}" needs "${key}", which has no finite set of values: give it in payloads.`);
      return [];
    }
    out = out.flatMap((p) => values.map((v) => ({ ...p, [key]: v })));
  }
  return out;
}

/** Does the payload pass the event's schema? Async schemas are not waited for. */
function valid(type: string, schema: StandardSchema, payload: Record<string, unknown>): boolean {
  const result = schema['~standard'].validate(payload) as { issues?: unknown[] } | PromiseLike<unknown>;
  if (!result || 'then' in result) return true;
  if (!result.issues?.length) return true;
  warnOnce(`a payload for "${type}" does not match its schema and was dropped: ${JSON.stringify(payload)}`);
  return false;
}

/** Event types Jev may send that some active state node could handle. */
function eventTypes(snapshot: JevSnapshot, descriptors: string | readonly string[]): string[] {
  const machine = snapshot.machine;
  const declared = new Set([...Object.keys(eventSchemas(machine)), ...machine.events]);
  const handled = getNextTransitions(snapshot).map((t) => t.eventType as string);
  return [...declared].filter(
    (type) =>
      !type.includes('*') &&
      matchesAny(type, descriptors) &&
      handled.some((descriptor) => matchesDescriptor(type, descriptor)),
  );
}

function transitionDescription(snapshot: JevSnapshot, type: string): string | undefined {
  return getNextTransitions(snapshot).find(
    (t) => t.description && matchesDescriptor(type, t.eventType as string),
  )?.description;
}

/** A readable, stable id for an event option: `type:value:value`. */
export function optionId(event: EventObject): string {
  const values = Object.entries(event)
    .filter(([k]) => k !== 'type')
    .map(([, v]) => (typeof v === 'object' ? JSON.stringify(v) : String(v)));
  return [event.type, ...values].join(':');
}

/** The event without the agent's fixed fields: what tells one option from another. */
function withoutFixed(event: EventObject, fixed: Record<string, unknown> | undefined): EventObject {
  if (!fixed) return event;
  return Object.fromEntries(Object.entries(event).filter(([k]) => !(k in fixed))) as EventObject;
}

function safeCan(snapshot: JevSnapshot, event: EventObject): boolean {
  try {
    return snapshot.can(event);
  } catch {
    return false;
  }
}

/**
 * An option's text from the machine: the transition's description, else the
 * event schema's, then the payload, each value with its field's description
 * when there is one (`steam milk (milk: oat — the milk to steam)`). Fixed
 * fields are left out.
 */
function machineDescription(
  snapshot: JevSnapshot,
  shape: JsonSchema | undefined,
  event: EventObject,
  fixed: Record<string, unknown> | undefined,
): JevOptionParts | undefined {
  const what = transitionDescription(snapshot, event.type) ?? shape?.description;
  if (!what) return undefined;
  const fields = Object.entries(withoutFixed(event, fixed)).filter(([k]) => k !== 'type');
  return {
    what,
    values: fields.map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`).join('; '),
    notes: fields
      .map(([k]) => [k, shape?.properties?.[k]?.description] as const)
      .filter(([, about]) => about)
      .map(([k, about]) => `${k} — ${about}`)
      .join('; '),
  };
}

/** The description the parts make: `what (field: value — note; …)`. */
function describeParts({ what }: JevOptionParts, event: EventObject, fixed: Record<string, unknown> | undefined, shape: JsonSchema | undefined): string {
  const fields = Object.entries(withoutFixed(event, fixed))
    .filter(([k]) => k !== 'type')
    .map(([k, v]) => {
      const about = shape?.properties?.[k]?.description;
      return `${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}${about ? ` — ${about}` : ''}`;
    });
  return fields.length ? `${what} (${fields.join('; ')})` : what;
}

const show = (v: unknown) => (v === undefined ? '(none)' : JSON.stringify(v));

/**
 * Line two arrays up item by item: items equal on both sides are the same
 * item (a longest common subsequence), so one taken out of the middle is that
 * one gone, not every later one changed. Between those, items pair up in
 * order; any left over were added or removed. Each pair: [index before, index after].
 */
function align(a: unknown[], b: unknown[]): Array<[number | null, number | null]> {
  const x = a.map((v) => JSON.stringify(v));
  const y = b.map((v) => JSON.stringify(v));
  const lcs = Array.from({ length: x.length + 1 }, () => new Array<number>(y.length + 1).fill(0));
  for (let i = x.length - 1; i >= 0; i--) {
    for (let j = y.length - 1; j >= 0; j--) lcs[i][j] = x[i] === y[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  }
  const pairs: Array<[number | null, number | null]> = [];
  let i = 0;
  let j = 0;
  let gapA: number[] = [];
  let gapB: number[] = [];
  const flush = () => {
    for (let k = 0; k < Math.max(gapA.length, gapB.length); k++) pairs.push([gapA[k] ?? null, gapB[k] ?? null]);
    gapA = [];
    gapB = [];
  };
  while (i < x.length || j < y.length) {
    if (i < x.length && j < y.length && x[i] === y[j]) {
      flush();
      pairs.push([i++, j++]);
    } else if (j >= y.length || (i < x.length && lcs[i + 1][j] >= lcs[i][j + 1])) gapA.push(i++);
    else gapB.push(j++);
  }
  flush();
  return pairs;
}

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Every leaf that differs between two JSON values, as `path: before → after`. */
function diff(before: unknown, after: unknown, path: string, out: string[]): void {
  if (JSON.stringify(before) === JSON.stringify(after)) return;
  if (Array.isArray(before) && Array.isArray(after)) {
    for (const [i, j] of align(before, after)) {
      diff(i === null ? undefined : before[i], j === null ? undefined : after[j], `${path}[${i ?? j}]`, out);
    }
    return;
  }
  if (isObject(before) && isObject(after)) {
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
      diff(before[key], after[key], path ? `${path}.${key}` : key, out);
    }
    return;
  }
  out.push(`${path || 'state'}: ${show(before)} → ${show(after)}`);
}

function changes(seen: (s: JevSnapshot) => unknown, before: JevSnapshot, after: JevSnapshot): string {
  const out: string[] = [];
  diff(seen(before), seen(after), '', out);
  return out.length ? out.join('; ') : 'nothing changes';
}

/** A delayed transition waiting to fire: when (ms after the move), in which state, and its event. */
type Pending = { at: number; stateId: string; event: EventObject };

type DelayedDefinition = { delay: unknown; matches?: Record<string, unknown> };
type DelaySource = number | ((args: { context: unknown; event: EventObject; stateNode: unknown }) => number);

/** The delayed transitions (`after`) of the states `after` is in that `before` was not (all of them, without one), `from` ms on. */
function delayed(before: JevSnapshot | null, after: JevSnapshot, from: number): Pending[] {
  const was = new Set(before?.nodes ?? []);
  const sources = ((after.machine as { sources?: { delays?: Record<string, DelaySource> } }).sources?.delays ?? {});
  return after.nodes
    .filter((node) => !was.has(node))
    .flatMap((node) =>
      ((node.after ?? []) as unknown as DelayedDefinition[]).map((t) => {
        const source = typeof t.delay === 'string' ? sources[t.delay] : (t.delay as DelaySource);
        const ms = typeof source === 'function' ? source({ context: after.context, event: { type: 'xstate.init' }, stateNode: node }) : Number(source);
        return { at: from + ms, stateId: node.id, event: { type: 'xstate.after', ...t.matches } };
      }),
    );
}

/**
 * Where a move ends up once the timed states it entered have run their
 * course: each delayed transition fired in turn (`xstate.after` events, sent
 * with the pure `transition()`), and so on for the states those enter. `null`
 * when the move enters no timed state. With no move (`snapshot` null), the
 * timed states `next` is already in: what waiting comes to.
 */
function settled(snapshot: JevSnapshot | null, next: JevSnapshot): { snapshot: JevSnapshot; ms: number } | null {
  let pending = delayed(snapshot, next, 0);
  if (!pending.length) return null;
  let current = next;
  let ms = 0;
  for (let i = 0; i < 20 && pending.length; i++) {
    pending.sort((a, b) => a.at - b.at);
    const [first, ...rest] = pending;
    const [after] = transition(current.machine, current, first.event);
    const entered = delayed(current, after as JevSnapshot, first.at);
    current = after as JevSnapshot;
    ms = first.at;
    pending = [...rest.filter((p) => current.nodes.some((n) => n.id === p.stateId)), ...entered];
  }
  return { snapshot: current, ms };
}

/**
 * What changes, in what Jev sees (`state`, or the state value and context):
 * every changed field, `path: before → after`. When the move starts timed
 * states (`after`), then what it comes to once they have run, against how
 * things were before it.
 */
function defaultLookahead(
  seen: (s: JevSnapshot) => unknown,
  next: JevSnapshot,
  snapshot: JevSnapshot,
  show: 'now' | 'done' | 'both',
): string {
  const now = changes(seen, snapshot, next);
  const done = show === 'now' ? null : settled(snapshot, next);
  if (!done) return now;
  const outcome = `Once done (after ${(done.ms / 1000).toFixed(1)}s): ${changes(seen, snapshot, done.snapshot)}`;
  return show === 'done' ? outcome : `${now}. ${outcome}`;
}

/**
 * What doing nothing comes to: the timed states already running end in turn
 * (they may be partway through, so it is within their delays). With none,
 * nothing changes on its own: only an outside event can move the actor.
 */
function waitingLookahead(seen: (s: JevSnapshot) => unknown, snapshot: JevSnapshot): string {
  const done = settled(null, snapshot);
  if (!done) return 'nothing changes on its own: no timed state is running';
  return `Once what is running is done (within ${(done.ms / 1000).toFixed(1)}s): ${changes(seen, snapshot, done.snapshot)}`;
}

/**
 * Every event Jev may choose right now, fully instantiated and accepted by
 * `snapshot.can()`, plus the noop option when configured. Synchronous, and
 * no Jev call is made.
 */
export function getOptions<TEvent extends EventObject, TContext extends MachineContext>(
  snapshot: JevSnapshot<TContext, TEvent>,
  opts: JevOptions<TEvent, TContext>,
  input?: unknown,
): JevOption<TEvent>[] {
  return collectOptions(snapshot, opts, input).options;
}

/**
 * The options, and the moves the machine refuses right now: events a current
 * state handles, whose transition is not taken (`can()` is false). They are
 * what Jev cannot do, which the options alone do not say. Option ids, an
 * event type alone when every one of its variants is refused.
 */
export function collectOptions<TEvent extends EventObject, TContext extends MachineContext>(
  snapshot: JevSnapshot<TContext, TEvent>,
  opts: JevOptions<TEvent, TContext>,
  input?: unknown,
): { options: JevOption<TEvent>[]; refused: string[] } {
  const options: JevOption<TEvent>[] = [];
  const refused: string[] = [];
  const given = (opts.payloads?.(snapshot) ?? {}) as Record<string, ReadonlyArray<Record<string, unknown>>>;
  const seen = (s: JevSnapshot) =>
    opts.state ? opts.state(s as JevSnapshot<TContext, TEvent>, input) : { value: s.value, context: s.context };

  for (const type of eventTypes(snapshot, opts.events)) {
    const schema = runtimeSchema(snapshot.machine, type);
    const shape = jsonSchema(schema);
    const payloads = (given[type] ?? [{}]).flatMap((p) => expand(type, { ...p, ...opts.fixed }, shape));
    const refusedHere: string[] = [];
    let allowed = 0;
    for (const payload of payloads) {
      if (!valid(type, schema, payload)) continue;
      const event = { ...payload, type } as unknown as TEvent;
      const id = optionId(withoutFixed(event, opts.fixed));
      if (!safeCan(snapshot, event)) {
        refusedHere.push(id);
        continue;
      }
      allowed++;
      const parts = opts.describe ? undefined : machineDescription(snapshot, shape, event, opts.fixed);
      const option: JevOption<TEvent> = {
        kind: 'event',
        id,
        event,
        description: opts.describe?.(event, snapshot) ?? (parts ? describeParts(parts, event, opts.fixed, shape) : optionId(event)),
        ...(parts ? { parts } : {}),
      };
      if (opts.lookahead) {
        const [next] = transition(snapshot.machine, snapshot, event);
        option.lookahead =
          typeof opts.lookahead === 'function'
            ? opts.lookahead(next as JevSnapshot<TContext, TEvent>, snapshot, event)
            : defaultLookahead(seen, next as JevSnapshot, snapshot, opts.lookahead === true ? 'both' : (opts.lookahead.show ?? 'both'));
      }
      options.push(option);
    }
    refused.push(...(allowed === 0 && refusedHere.length > 1 ? [type] : refusedHere));
  }

  if (opts.noop !== undefined) {
    options.push({
      kind: 'noop',
      id: NOOP_ID,
      description: typeof opts.noop === 'function' ? opts.noop(snapshot, input) : opts.noop,
      // Waiting is a choice like any other: it says what it comes to.
      ...(opts.lookahead && typeof opts.lookahead !== 'function' ? { lookahead: waitingLookahead(seen, snapshot as JevSnapshot) } : {}),
    });
  }
  return { options, refused };
}

type MatchingKeys<K, D extends string> = D extends `${infer P}.*` ? Extract<K, `${P}.${string}`> : Extract<K, D>;

/** Event schemas keyed by type, typed from the machine's own events (its `schemas` are typed loosely). */
type PickedEvents<TEvent extends EventObject, D extends string> = {
  [K in MatchingKeys<TEvent['type'], D>]: StandardSchemaV1<Omit<Extract<TEvent, { type: K }>, 'type'>>;
};

/**
 * The event schemas of `machine` whose types match `descriptors`, for another
 * machine that receives the same events: `schemas: { events: { ...pickEvents(bar, 'barista.*') } }`.
 */
export function pickEvents<TMachine extends AnyStateMachine, const D extends string>(
  machine: TMachine,
  descriptors: D | readonly D[],
): PickedEvents<EventFromLogic<TMachine>, D> {
  const all = eventSchemas(machine);
  return Object.fromEntries(
    Object.entries(all).filter(([type]) => matchesAny(type, descriptors as string | readonly string[])),
  ) as never;
}
