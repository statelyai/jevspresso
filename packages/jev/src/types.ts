import type {
  AnyStateMachine,
  ContextFrom,
  EventFromLogic,
  EventObject,
  MachineContext,
  MachineSnapshot,
} from 'xstate';

/* ---------------------------------------------------------- wire shapes --- */

/** Instructions and criteria may be plain strings or structured JSON. */
export type JevText = string | Record<string, unknown> | unknown[];

export type JevQuestion =
  | { type: 'choice'; instructions: JevText; criteria: Record<string, JevText> }
  | { type: 'noul'; instructions: JevText; criteria?: { true: JevText; false: JevText } }
  | { type: 'score'; instructions: JevText; criteria: JevText[] };

export interface ChoiceAnswer {
  type: 'choice';
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
}
export interface NoulAnswer {
  type: 'noul';
  noul: number;
}
export interface ScoreAnswer {
  type: 'score';
  score: number;
  confidence: number;
  legend: Record<string, string>;
  probabilities: Record<string, number>;
}
export type JevAnswer = ChoiceAnswer | NoulAnswer | ScoreAnswer;

export interface JevRequest {
  state: unknown;
  questions: Record<string, JevQuestion>;
}
export interface JevResponse {
  answers: Record<string, JevAnswer>;
  /** Set by clients that answered without calling Jev. */
  mock?: boolean;
  /** Set by `memoizeClient` when an identical earlier request's response was reused. */
  cached?: boolean;
}

/**
 * How requests reach Jev. Keeps the API key wherever the caller keeps it: pass
 * `(req) => typesafe.systemOne(req)` on a server, or a fetch to your own
 * endpoint in a browser.
 */
export type JevClient = (request: JevRequest) => Promise<JevResponse>;

/* -------------------------------------------------------------- options --- */

/** A machine snapshot with its context and event types. */
export type JevSnapshot<TContext extends MachineContext = any, TEvent extends EventObject = any> = MachineSnapshot<
  TContext,
  TEvent,
  any,
  any,
  any,
  any,
  any,
  any
>;

/** Payload of the event(s) with this type; also matches events typed with a union of types. */
export type EventPayload<TEvent extends EventObject, TType extends string> = TEvent extends EventObject
  ? TType extends TEvent['type']
    ? Omit<TEvent, 'type'>
    : never
  : never;

/**
 * - `flat`: one choice over every legal event.
 * - `hierarchical`: one choice over event types, plus one choice per type
 *   over its payloads, all asked in the same parallel request.
 * - `auto`: `flat` up to `maxFlatOptions` legal events, then `hierarchical`.
 */
export type JevStrategy = 'flat' | 'hierarchical' | 'auto';

/**
 * What Jev decides and how it is asked. Every event Jev may choose must be
 * declared in the machine's `schemas.events` with a runtime schema such as
 * Zod; `types<T>()` has no runtime shape and is rejected.
 */
export interface JevOptions<TEvent extends EventObject = EventObject, TContext extends MachineContext = any> {
  /** Event types Jev may choose from. Exact types or wildcards like `'agent.*'`. */
  events: string | readonly string[];
  /** What Jev is trying to do. Receives the `jev.ask` input, if any. */
  instructions: string | ((snapshot: JevSnapshot<TContext, TEvent>, input: unknown) => string);
  /** What Jev sees. Defaults to `{ value, context }` (plus `input` when there is one). */
  state?: (snapshot: JevSnapshot<TContext, TEvent>, input: unknown) => unknown;
  /**
   * The payloads to offer right now, per event type, usually drawn from
   * context. Each is checked against the event's schema. Required fields left
   * out are filled from the schema when it lists a finite set of values
   * (enums, literals, booleans). Event types left out get only what their
   * schema allows on its own.
   */
  payloads?: (snapshot: JevSnapshot<TContext, TEvent>) => {
    [K in TEvent['type']]?: ReadonlyArray<Partial<EventPayload<TEvent, K>>>;
  };
  /**
   * Fields every event this agent sends carries, at one value: who the agent
   * is, when several can act (`{ player: 'O' }`, `{ by: 'jev' }`). They are
   * set on every option, so Jev is never asked to choose them, and they are
   * left out of option ids, which they would not tell apart.
   */
  fixed?: Record<string, unknown>;
  /**
   * Text Jev reads for each option. Defaults to the machine's own words: the
   * transition's `description`, else the event schema's (Zod `.describe()`),
   * followed by the payload with each field's description.
   */
  describe?: (event: TEvent, snapshot: JevSnapshot<TContext, TEvent>) => string;
  /**
   * Describe the state each option leads to, computed with the pure
   * `transition()`. `true` lists what changes in what Jev sees (`state`, or
   * the state value and context): `path: before → after` per changed field;
   * and when the move enters timed states (`after`), what it comes to once
   * they have run, their `xstate.after` events sent in turn.
   */
  lookahead?:
    | boolean
    /**
     * The default lookahead, showing `now` (what changes at once), `done`
     * (what it comes to once its timed states have run, the smaller), or
     * `both` (what `true` shows).
     */
    | { show?: 'now' | 'done' | 'both' }
    | ((
        next: JevSnapshot<TContext, TEvent>,
        snapshot: JevSnapshot<TContext, TEvent>,
        event: TEvent,
      ) => string | undefined);
  /**
   * Show Jev the machine itself beside the state (`machine`): every state
   * with its description (`*` marks the current ones), and what leaves it:
   * each event and where it goes and what it sets in context, each delay and
   * how long it is. A transition written as a function shows the targets and
   * context keys its source names. Off by default: it is long.
   */
  map?: boolean;
  /** Offer "do nothing" as an option, described by this text. */
  noop?: string | ((snapshot: JevSnapshot<TContext, TEvent>, input: unknown) => string);
  strategy?: JevStrategy;
  /** Threshold for `strategy: 'auto'`. Default 32. */
  maxFlatOptions?: number;
  /** Below this confidence nothing is chosen. */
  minConfidence?: number;
}

/** `JevOptions` typed from a machine: `const agent = { … } satisfies JevOptionsFor<typeof machine>`. */
export type JevOptionsFor<TMachine extends AnyStateMachine> = JevOptions<
  EventFromLogic<TMachine>,
  ContextFrom<TMachine>
>;

export interface JevDecideOptions<TEvent extends EventObject = EventObject, TContext extends MachineContext = any>
  extends JevOptions<TEvent, TContext> {
  client: JevClient;
}

/* ------------------------------------------------------------- results --- */

/**
 * The request key of the noop option. Only code that reads raw requests or
 * answers needs it, such as a mock client; decisions use `option.kind`.
 */
export const NOOP_ID = 'noop';

/**
 * How an option's description is put together when it comes from the machine:
 * what the event does (`what`), its payload (`values`, `milk: oat; size:
 * large`), and what its fields mean (`notes`). Variants of a type share `what`
 * and `notes`, so a hierarchical request says those once per type.
 */
export interface JevOptionParts {
  what: string;
  values: string;
  notes: string;
}

export type JevOption<TEvent extends EventObject = EventObject> =
  | { kind: 'event'; id: string; event: TEvent; description: string; lookahead?: string; parts?: JevOptionParts }
  | { kind: 'noop'; id: string; description: string; lookahead?: string };

export interface JevDecision<TEvent extends EventObject = EventObject> {
  at: number;
  options: JevOption<TEvent>[];
  /** The chosen option, or `null` when none was (nothing to choose, or below `minConfidence`). */
  option: JevOption<TEvent> | null;
  /** The chosen event, or `null` for the noop or no choice. */
  event: TEvent | null;
  /** Probability per option id (joint probability under `hierarchical`). */
  probabilities: Record<string, number>;
  confidence: number;
  reason: 'chosen' | 'noop' | 'low-confidence' | 'no-options';
  strategy: 'flat' | 'hierarchical' | 'none';
  /**
   * Fingerprint of the request that produced this decision (see
   * `requestKey`), or `null` when no request was made.
   */
  key: string | null;
  /**
   * How big the request was, in characters of JSON: what Jev saw (`state`),
   * the questions, and both. Roughly 4 characters make a token. `null` when no
   * request was made. Questions a client adds on its way out are not counted.
   */
  size: { state: number; questions: number; total: number } | null;
  /** Every raw answer, including any questions a client added to the request. */
  answers: Record<string, JevAnswer>;
  latencyMs: number;
  mock: boolean;
  /** The response was reused from an identical earlier request (see `memoizeClient`): no tokens spent. */
  cached: boolean;
  /** Set by `createJevLogic()` once it delivered the event. */
  sent: boolean;
}
