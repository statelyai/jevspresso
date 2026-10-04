import { createAsyncLogic, setup, types, type AnyActorRef, type EventObject, type MachineContext } from 'xstate';
import { decide, requestKey, stateOf } from './decide';
import { detectLoop, type JevLoop, type JevLoopSettings } from './loops';
import { memoizeClient, type MemoizeOptions } from './memo';
import type { JevDecideOptions, JevDecision, JevOptions, JevSnapshot } from './types';

export interface JevLogicOptions<TEvent extends EventObject, TContext extends MachineContext>
  extends JevDecideOptions<TEvent, TContext> {
  /**
   * Where the chosen event goes, if the watched actor still accepts it when Jev answers:
   * - `'parent'` (default): to the agent's parent, which acts on it. Invoked
   *   at the top of the machine it decides for, that is the machine itself.
   * - `'actor'`: to the watched actor directly.
   * - `'none'`: nowhere; the decision is only recorded.
   */
  deliver?: 'parent' | 'actor' | 'none';
  /**
   * Decide on its own (default): whenever the watched actor changes and there
   * is a question worth a request. `false`: only on `jev.ask`.
   */
  auto?: boolean;
  /**
   * How long to hold off after a decision before the next, in ms (default 0):
   * a number, or from the decision, the loop it is in, and the snapshot it was
   * made on (to slow down while Jev keeps choosing to wait, say).
   */
  interval?:
    | number
    | ((last: { decision: JevDecision<TEvent>; loop: JevLoop | null; snapshot: JevSnapshot<TContext, TEvent> }) => number);
  /**
   * How long the watched actor must stay unchanged before Jev decides, in ms
   * (default 0): a window for a person to step in. `jev.settle` changes it.
   */
  settle?: number;
  /** How many decisions the agent keeps in its snapshot, newest first (default 50). */
  keep?: number;
  /**
   * Reuse the response to an identical request without calling Jev (see
   * `memoizeClient`). On by default; `false` turns it off.
   */
  cache?: false | MemoizeOptions;
  /**
   * Watch for decision loops (see `detectLoop`). On by default: a loop is in
   * the agent's snapshot (`context.loop`), and each new one is passed to
   * `onLoop`, which defaults to `console.warn`. `false` turns detection off.
   */
  loops?:
    | false
    | (JevLoopSettings & {
        onLoop?: (loop: JevLoop) => void;
        /** Tell Jev it is going in circles, in what it sees, so it can break the cycle. Default true. */
        tell?: boolean;
      });
}

export interface JevLogicInput {
  /**
   * The actor whose snapshot the agent decides on. Defaults to the agent's
   * parent: invoke it at the top of the machine it decides for.
   */
  actor?: AnyActorRef;
}

/** Events the agent accepts. */
export type JevLogicEvent =
  /**
   * Decide once, and answer the parent (`jev.thinking`, then `jev.decided` or
   * `jev.failed`). With `input`, right away. Without, as soon as there is a
   * question worth a request: now, or on a later change of the actor. A
   * question is not worth a request when the only option is the noop, or when
   * it is the same request whose answer was to do nothing.
   */
  | { type: 'jev.ask'; input?: unknown }
  /** Forget a pending `jev.ask`; an answer already on its way is dropped and nothing is delivered. */
  | { type: 'jev.cancel' }
  /** Stop deciding (an answer on its way is dropped), and start again. */
  | { type: 'jev.pause' }
  | { type: 'jev.resume' }
  /** Forget everything decided so far: the log, the loop, and what was waited on. */
  | { type: 'jev.reset' }
  /** How long the watched actor must stay unchanged before Jev decides, in ms. */
  | { type: 'jev.settle'; ms: number };

/** Events the agent sends its parent: the chosen event, and the answer to a `jev.ask`. */
export type JevLogicReply<TEvent extends EventObject = EventObject> =
  /** A request to Jev went out, for a `jev.ask`. */
  | { type: 'jev.thinking' }
  /** The chosen event itself, with `deliver: 'parent'`. */
  | TEvent
  /** Jev answered a `jev.ask`; `decision.sent` says whether the chosen event was delivered. */
  | { type: 'jev.decided'; decision: JevDecision<TEvent>; loop: JevLoop | null }
  | { type: 'jev.failed'; error: string };

/** What the agent knows, in its snapshot's `context`. */
export interface JevAgentContext<TEvent extends EventObject = EventObject> {
  /** Decisions, newest first (up to `keep`). */
  decisions: JevDecision<TEvent>[];
  /** The loop the latest decisions are in, if any (see `detectLoop`). */
  loop: JevLoop | null;
  /** Why the last request failed, until one succeeds. */
  error: string | null;
  /** When the agent may decide next (ms since epoch): after `interval`, and after the actor has settled. */
  nextAt: number;
  /** How long the actor must stay unchanged before a decision, in ms. */
  settle: number;
  /** @internal The watched actor, when not the parent. */
  actor: AnyActorRef | null;
  /** @internal A `jev.ask` not yet answered, with its input. */
  asked: { input: unknown } | null;
  /** @internal Whether the decision in progress answers a `jev.ask`. */
  replying: boolean;
  /** @internal The snapshot the decision in progress is made on, and its input. */
  pending: { snapshot: unknown; input: unknown } | null;
  /** @internal The key of the last request with nothing to act on: not asked again until it changes. */
  waitingOn: string | null;
  /** @internal No decision before this, after the last one (`interval`). */
  until: number;
  /** @internal When the watched actor last changed. */
  changedAt: number;
}

/** How long the agent waits after a failed request before trying again, in ms. */
const RETRY_MS = 1000;

const warnLoop = (loop: JevLoop) => console.warn(`[@xstate/jev] possible loop: ${loop.message}`, loop.chosen);

/**
 * While the agent is going in circles, or sending the same run of moves lap
 * after lap, Jev is told so, in what it sees: the moves that keep bringing
 * the actor back, or that keep repeating. The request differs from the ones
 * that looped, so it is not answered from the cache, and Jev can choose
 * differently. The note names each move once, so it stays the same lap after
 * lap: if Jev loops anyway, the cache takes over again. `createJevLogic` does
 * this itself; a driver of its own around `decide()` can do the same.
 */
export function tellLoop<TEvent extends EventObject, TContext extends MachineContext, O extends JevOptions<TEvent, TContext>>(
  opts: O,
  loop: JevLoop | null,
): O {
  if (loop?.kind !== 'cycle' && loop?.kind !== 'repeat') return opts;
  const note =
    loop.kind === 'cycle'
      ? `going in circles: these moves keep bringing it back to the same state (${[...new Set(loop.chosen)].join(', ')}); choose something that changes it`
      : `these moves keep repeating (${loop.chosen.join(' → ')}, ${loop.count} times in a row): check each lap still gets somewhere, or do something else`;
  return {
    ...opts,
    state: (snapshot: JevSnapshot<TContext, TEvent>, input: unknown) => {
      const base = stateOf(snapshot, opts, input);
      return base && typeof base === 'object' && !Array.isArray(base) ? { ...base, loop: note } : { state: base, loop: note };
    },
  };
}

/** Would the actor still accept the decided event? It may have moved on while Jev was answering. */
function accepts(actor: AnyActorRef | undefined, decision: JevDecision<EventObject>): boolean {
  if (!decision.event || !actor) return false;
  const snapshot = actor.getSnapshot() as JevSnapshot;
  return snapshot.status === 'active' && snapshot.can(decision.event);
}

/**
 * A Jev agent as actor logic: invoke it at the top of the machine it decides
 * for (or spawn it beside one, with `input.actor`), and it decides by itself.
 * The machine needs no states of its own for it: whenever the machine
 * changes and there is a question worth a request, the agent asks Jev, and
 * sends the chosen event if the machine still accepts it. Its own lifecycle
 * is its snapshot: `watching` (until there is something to decide, and the
 * `interval` and `settle` times have passed), `deciding` (a request on its
 * way), or `paused`; and in `context`, the decisions, any loop, and the last
 * error (`JevAgentContext`).
 *
 * Identical requests are answered from the cache, a request whose answer was
 * to do nothing is not made again until it changes, and loops are detected,
 * reported and told to Jev (`tellLoop`). `jev.ask` decides once on request,
 * with input (a reply to route, say), and answers the parent.
 */
export function createJevLogic<TEvent extends EventObject, TContext extends MachineContext = any>(
  options: JevLogicOptions<TEvent, TContext>,
) {
  // One cache per logic, shared by every actor created from it.
  const opts =
    options.cache === false ? options : { ...options, client: memoizeClient(options.client, options.cache) };
  const loops = opts.loops;
  const deliver = opts.deliver ?? 'parent';
  const auto = opts.auto ?? true;
  const keep = Math.max(opts.keep ?? 50, loops ? (loops.window ?? 20) : 0);
  /** What Jev is asked with: told about a cycle it is in. */
  const asking = (loop: JevLoop | null) =>
    loops === false || loops?.tell === false ? opts : tellLoop<TEvent, TContext, typeof opts>(opts, loop);
  type Ctx = JevAgentContext<TEvent>;
  type Snap = JevSnapshot<TContext, TEvent>;
  const watched = (context: Ctx, parent: AnyActorRef | undefined) => (context.actor ?? parent) as AnyActorRef | undefined;
  const snapshotOf = (actor: AnyActorRef | undefined) => {
    const s = actor?.getSnapshot() as Snap | undefined;
    return s?.status === 'active' ? s : undefined;
  };
  /** Is there a question worth a request now: one not already answered with a wait? */
  const worthAsking = (context: Ctx, snapshot: Snap) => {
    const key = requestKey(snapshot, asking(context.loop));
    return key !== null && key !== context.waitingOn;
  };
  const intervalAfter = (last: { decision: JevDecision<TEvent>; loop: JevLoop | null; snapshot: Snap }) =>
    typeof opts.interval === 'function' ? opts.interval(last) : (opts.interval ?? 0);
  const nextAt = (c: Pick<Ctx, 'until' | 'changedAt' | 'settle'>) => Math.max(c.until, c.changedAt + c.settle);

  type Asked = { snapshot: Snap; loop: JevLoop | null; input: unknown };
  type Answer = { decision: JevDecision<TEvent>; plainKey: string | null; snapshot: Snap };

  return setup({
    schemas: {
      context: types<Ctx>(),
      input: types<JevLogicInput | undefined>(),
      events: {
        'jev.ask': types<{ input?: unknown }>(),
        'jev.cancel': types<void>(),
        'jev.pause': types<void>(),
        'jev.resume': types<void>(),
        'jev.reset': types<void>(),
        'jev.settle': types<{ ms: number }>(),
        /** The watched actor changed (the agent's own subscription). */
        'jev.changed': types<void>(),
      },
    },
    actors: {
      decide: createAsyncLogic<Answer, Asked>({
        run: async ({ input }) => {
          // Loops are found on the request as it would be without the note
          // about them, so telling Jev does not hide the very loop it is told about.
          const plainKey = input.loop ? requestKey(input.snapshot, opts, input.input) : null;
          const decision = await decide(input.snapshot, asking(input.loop), input.input);
          // Settle on a later task: with an instant client (a cache, a mock), a
          // machine that changes on every answer would otherwise starve timers
          // and rendering with microtasks.
          await new Promise((resolve) => setTimeout(resolve, 0));
          return { decision, plainKey, snapshot: input.snapshot };
        },
      }),
    },
    delays: {
      // v6 delay sources see the machine context untyped at `setup()` time.
      next: ({ context }) => Math.max(0, nextAt(context as Ctx) - Date.now()),
    },
  }).createMachine({
    id: 'jev',
    context: ({ input }) => ({
      decisions: [],
      loop: null,
      error: null,
      nextAt: 0,
      settle: opts.settle ?? 0,
      actor: input?.actor ?? null,
      asked: null,
      replying: false,
      pending: null,
      waitingOn: null,
      until: 0,
      changedAt: 0,
    }),
    // For the life of the agent: a subscription to the watched actor. No polling.
    entry: ({ context, parent }, enq) => {
      const actor = watched(context, parent);
      if (actor) enq.subscribeTo(actor, () => ({ type: 'jev.changed' }));
    },
    on: {
      'jev.ask': ({ context, event, parent }) => {
        const asked = { input: event.input };
        const snapshot = snapshotOf(watched(context, parent));
        // With input, right away; without, once there is a question worth a request.
        if (snapshot && (event.input !== undefined || worthAsking(context, snapshot))) {
          return { target: '.deciding', context: { asked, replying: true, pending: { snapshot, input: event.input } } };
        }
        return { context: { asked } };
      },
      'jev.cancel': () => ({ target: '.watching', reenter: true, context: { asked: null, replying: false } }),
      'jev.pause': () => ({ target: '.paused', context: { asked: null, replying: false } }),
      'jev.reset': () => ({
        target: '.watching',
        reenter: true,
        context: { decisions: [], loop: null, error: null, asked: null, replying: false, waitingOn: null, until: 0, nextAt: 0 },
      }),
      'jev.settle': ({ context, event }) => ({ context: { settle: event.ms, nextAt: nextAt({ ...context, settle: event.ms }) } }),
    },
    initial: 'watching',
    states: {
      watching: {
        description: 'Watching the actor until there is a question worth a request',
        on: {
          // Every change restarts the wait: the actor has to settle.
          'jev.changed': ({ context }) => {
            const changed = { changedAt: Date.now() };
            return { target: 'watching', reenter: true, context: { ...changed, nextAt: nextAt({ ...context, ...changed }) } };
          },
        },
        after: {
          next: ({ context, parent }) => {
            if (!auto && !context.asked) return;
            const snapshot = snapshotOf(watched(context, parent));
            if (snapshot && worthAsking(context, snapshot)) {
              return { target: 'deciding', context: { replying: !!context.asked, pending: { snapshot, input: context.asked?.input } } };
            }
          },
        },
      },
      deciding: {
        description: 'A request to Jev on its way',
        entry: ({ context, parent }, enq) => {
          if (context.replying && parent) enq.sendTo(parent, { type: 'jev.thinking' });
        },
        invoke: {
          src: 'decide',
          input: ({ context }: { context: Ctx }) => ({
            snapshot: context.pending!.snapshot as Snap,
            loop: context.loop,
            input: context.pending!.input,
          }),
          onDone: ({ context, event, parent }, enq) => {
            const { decision, plainKey, snapshot } = event.output as Answer;
            const actor = watched(context, parent);
            const actionable = accepts(actor, decision);
            if (actionable && deliver === 'parent' && parent) enq.sendTo(parent, decision.event!);
            if (actionable && deliver === 'actor' && actor) enq.sendTo(actor, decision.event!);
            const result: JevDecision<TEvent> = { ...decision, sent: actionable && deliver !== 'none' };
            const decisions = [result, ...context.decisions].slice(0, keep);
            const loop = loops === false ? null : findLoop(decisions, plainKey, loops ?? {});
            if (loop && loop.kind !== context.loop?.kind) enq(loops ? (loops.onLoop ?? warnLoop) : warnLoop, loop);
            if (context.replying && parent) enq.sendTo(parent, { type: 'jev.decided', decision: result, loop });
            const until = Date.now() + intervalAfter({ decision: result, loop, snapshot });
            return {
              target: 'watching',
              context: {
                decisions,
                loop,
                error: null,
                asked: null,
                replying: false,
                pending: null,
                waitingOn: actionable ? null : result.key,
                until,
                nextAt: nextAt({ ...context, until }),
              },
            };
          },
          onError: ({ context, event, parent }, enq) => {
            const error = String(event.error);
            if (context.replying && parent) enq.sendTo(parent, { type: 'jev.failed', error });
            // Not straight back: a failing request would otherwise be retried at once, again and again.
            const until = Date.now() + RETRY_MS;
            return { target: 'watching', context: { error, asked: null, replying: false, pending: null, until, nextAt: nextAt({ ...context, until }) } };
          },
        },
      },
      paused: {
        description: 'Not deciding until resumed',
        on: {
          'jev.resume': ({ context }) => ({ target: 'watching', context: { changedAt: Date.now(), nextAt: nextAt({ ...context, changedAt: Date.now() }) } }),
        },
      },
    },
  });
}

/**
 * The loop the latest decisions are in, newest first. The newest is looked
 * up by `plainKey` when Jev was told about a loop (its own key carries the
 * note), so telling Jev does not hide the loop.
 */
function findLoop<TEvent extends EventObject>(
  decisions: JevDecision<TEvent>[],
  plainKey: string | null,
  settings: JevLoopSettings,
): JevLoop | null {
  const [newest, ...rest] = decisions;
  if (!newest || newest.key === null) return null;
  const window = settings.window ?? 20;
  return detectLoop([plainKey ? { ...newest, key: plainKey } : newest, ...rest].slice(0, window), settings);
}
