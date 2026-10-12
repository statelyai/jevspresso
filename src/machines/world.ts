/**
 * Parallel universes: one café per decision model, all fed by one world. Each
 * café gets the same orders at the same world time, and the same mayhem
 * (parts breaking, ingredients running out) at the same instant. What differs
 * is only the model deciding in it. The world's clock (`WorldClock`) is the
 * system clock of every café, and it stands still while any café is asking
 * the customer to confirm an order.
 */
import { createActor, setup, types, type ActorRefFrom } from 'xstate';
import { CHAOS_LEVELS, DEVICES, INGREDIENTS } from '../lib/legal';
import type { ModelId } from '../lib/models';
import type { Device, Ingredient } from '../lib/types';
import { WorldClock } from '../lib/worldClock';
import { modelCafe, type CafeLogic } from './cafe';

/** How often mayhem rolls its dice. */
export const MAYHEM_TICK_MS = 1000;

/**
 * One step of mulberry32: a roll in [0, 1) and the generator's next state.
 * Pure, so a day replays from its seed.
 */
export function nextRandom(state: number): [roll: number, next: number] {
  const next = (state + 0x6d2b79f5) | 0;
  let t = Math.imul(next ^ (next >>> 15), next | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return [((t ^ (t >>> 14)) >>> 0) / 4294967296, next];
}

export interface Mayhem {
  breaks: Device[];
  empties: Ingredient | null;
}

/** One tick of mayhem: which parts break and what runs out, and the generator after. */
export function rollMayhem(
  rng: number,
  breakProb: Record<Device, number>,
  emptyProb: number,
): { mayhem: Mayhem; rng: number } {
  const roll = () => {
    const [r, next] = nextRandom(rng);
    rng = next;
    return r;
  };
  // Always five rolls, whatever the levels, so changing one does not reshuffle the rest of the day.
  const breaks = DEVICES.filter((d) => roll() < breakProb[d]);
  const empty = roll() < emptyProb;
  const which = INGREDIENTS[Math.floor(roll() * INGREDIENTS.length)];
  return { mayhem: { breaks, empties: empty ? which : null }, rng };
}

/** Where an order stands with a café: ready for one, one sent but not yet taken up, or one in hand. */
type Intake = 'ready' | 'sent' | 'busy';

export interface Clarification {
  model: ModelId;
  /** World time it was asked. */
  at: number;
  /** What the customer said. */
  text: string;
}

export interface WorldContext {
  clock: WorldClock;
  seed: number;
  rng: number;
  breakProb: Record<Device, number>;
  emptyProb: number;
  cafes: Record<string, ActorRefFrom<CafeLogic>>;
  /** Orders each café has yet to take, oldest first, with when they were placed. */
  queues: Record<string, { text: string; at: number }[]>;
  intake: Record<string, Intake>;
  /** The cafés asking the customer to confirm an order right now: while any are, the world stands still. */
  clarifying: ModelId[];
  /** Every time a café asked, in order. */
  clarifications: Clarification[];
  /** When each café served each drink, in world time: the bar itself holds no time. */
  servedAt: Record<string, Record<string, number>>;
}

export interface WorldInput {
  models: ModelId[];
  seed: number;
  clock: WorldClock;
  /** The café a model runs: the real one by default; tests give their own. */
  cafe?: (model: ModelId) => CafeLogic;
}

type CafeRef = ActorRefFrom<CafeLogic>;
const isIdle = (cafe: CafeRef) => cafe.getSnapshot().matches({ intake: 'idle' });
const isClarifying = (cafe: CafeRef) => cafe.getSnapshot().matches({ intake: 'clarifying' });

/** Each ready café's next order, if it has one waiting: the orders to hand over, and the queues after. */
function flush(context: Pick<WorldContext, 'cafes' | 'queues' | 'intake'>) {
  const queues = { ...context.queues };
  const intake = { ...context.intake };
  const handed: [CafeRef, { text: string; at: number }][] = [];
  for (const [model, cafe] of Object.entries(context.cafes)) {
    const [next, ...rest] = queues[model];
    if (intake[model] !== 'ready' || !next) continue;
    handed.push([cafe, next]);
    queues[model] = rest;
    intake[model] = 'sent';
  }
  return { handed, queues, intake };
}

export const worldMachine = setup({
  schemas: { context: types<WorldContext>() },
  delays: { tick: MAYHEM_TICK_MS },
}).createMachine({
  id: 'world',
  schemas: {
    input: types<WorldInput>(),
    events: {
      /** A customer's order, for every café. */
      'order.submit': types<{ text: string }>(),
      /** The customer's answer to one café asking them to confirm. */
      'order.reply': types<{ model: ModelId; text: string }>(),
      /** A café changed (the world's own subscription). */
      'cafe.changed': types<{ model: ModelId }>(),
      SET_BREAK_PROB: types<{ device: Device; prob: number }>(),
      SET_EMPTY_PROB: types<{ prob: number }>(),
      /** Set an ingredient in every café, from the panel. */
      SET_STOCK: types<{ ingredient: Ingredient; amount: number }>(),
      SET_SPEED: types<{ speed: number }>(),
      /** Break a part in every café, by hand. */
      BREAK: types<{ device: Device }>(),
      /** Every café back to how it opened, and the day back to its start. */
      RESET: types<void>(),
    },
  },
  context: ({ input, spawn }) => {
    const make = input.cafe ?? ((model: ModelId) => modelCafe(model, input.clock));
    return {
      clock: input.clock,
      seed: input.seed,
      rng: input.seed,
      breakProb: { grinder: CHAOS_LEVELS.low, groupHead: CHAOS_LEVELS.low, steamWand: CHAOS_LEVELS.low },
      emptyProb: CHAOS_LEVELS.low,
      cafes: Object.fromEntries(input.models.map((model) => [model, spawn(make(model), { id: model })])),
      queues: Object.fromEntries(input.models.map((model) => [model, []])),
      intake: Object.fromEntries(input.models.map((model) => [model, 'ready' as Intake])),
      clarifying: [],
      clarifications: [],
      servedAt: Object.fromEntries(input.models.map((model) => [model, {}])),
    };
  },
  entry: ({ context }, enq) => {
    for (const [model, cafe] of Object.entries(context.cafes)) {
      enq.subscribeTo(cafe, () => ({ type: 'cafe.changed', model: model as ModelId }));
    }
  },
  on: {
    'order.submit': ({ context, event }, enq) => {
      const at = context.clock.now();
      const { handed, queues, intake } = flush({
        ...context,
        queues: Object.fromEntries(Object.entries(context.queues).map(([m, q]) => [m, [...q, { text: event.text, at }]])),
      });
      for (const [cafe, order] of handed) enq.sendTo(cafe, { type: 'order.submit', ...order });
      return { context: { queues, intake } };
    },
    'order.reply': ({ context, event }, enq) => {
      enq.sendTo(context.cafes[event.model], { type: 'order.reply', text: event.text });
    },
    'cafe.changed': ({ context, event }, enq) => {
      const cafe = context.cafes[event.model];
      // A café is ready for its next order once it has taken up the last one and finished with it.
      const was = context.intake[event.model];
      const now: Intake = isIdle(cafe) ? (was === 'sent' ? 'sent' : 'ready') : 'busy';
      const { handed, queues, intake } = flush({ ...context, intake: { ...context.intake, [event.model]: now } });
      for (const [next, order] of handed) enq.sendTo(next, { type: 'order.submit', ...order });

      const asking = isClarifying(cafe);
      const had = context.clarifying.includes(event.model);
      const clarifying = asking === had ? context.clarifying : asking ? [...context.clarifying, event.model] : context.clarifying.filter((m) => m !== event.model);
      const clarifications =
        asking && !had
          ? [...context.clarifications, { model: event.model, at: context.clock.now(), text: cafe.getSnapshot().context.pendingOrder?.text ?? '' }]
          : context.clarifications;
      if (clarifying.length && !context.clarifying.length) enq(() => context.clock.pause());
      if (!clarifying.length && context.clarifying.length) enq(() => context.clock.resume());

      const served = cafe.getSnapshot().context.drinks.filter((d) => d.status === 'served' && !(d.id in context.servedAt[event.model]));
      const servedAt = served.length
        ? { ...context.servedAt, [event.model]: { ...context.servedAt[event.model], ...Object.fromEntries(served.map((d) => [d.id, context.clock.now()])) } }
        : context.servedAt;

      return { context: { queues, intake, clarifying, clarifications, servedAt } };
    },
    SET_BREAK_PROB: ({ context, event }) => ({ context: { breakProb: { ...context.breakProb, [event.device]: event.prob } } }),
    SET_EMPTY_PROB: ({ event }) => ({ context: { emptyProb: event.prob } }),
    SET_STOCK: ({ context, event }, enq) => {
      for (const cafe of Object.values(context.cafes)) enq.sendTo(cafe, event);
    },
    SET_SPEED: ({ context, event }, enq) => {
      for (const cafe of Object.values(context.cafes)) enq.sendTo(cafe, event);
    },
    BREAK: ({ context, event }, enq) => {
      for (const cafe of Object.values(context.cafes)) enq.sendTo(cafe, event);
    },
    RESET: ({ context }, enq) => {
      for (const cafe of Object.values(context.cafes)) enq.sendTo(cafe, { type: 'RESET' });
      if (context.clarifying.length) enq(() => context.clock.resume());
      const each = <T>(value: () => T) => Object.fromEntries(Object.keys(context.cafes).map((model) => [model, value()]));
      return {
        target: '.mayhem',
        reenter: true,
        context: {
          rng: context.seed,
          queues: each(() => []),
          intake: each(() => 'ready' as Intake),
          clarifying: [],
          clarifications: [],
          servedAt: each(() => ({})),
        },
      };
    },
  },
  initial: 'mayhem',
  states: {
    mayhem: {
      description: 'Rolling for mayhem every tick, and sending what comes up to every café at once',
      after: {
        tick: ({ context }, enq) => {
          const { mayhem, rng } = rollMayhem(context.rng, context.breakProb, context.emptyProb);
          for (const cafe of Object.values(context.cafes)) {
            for (const device of mayhem.breaks) enq.sendTo(cafe, { type: 'BREAK', device });
            if (mayhem.empties) enq.sendTo(cafe, { type: 'SET_STOCK', ingredient: mayhem.empties, amount: 0 });
          }
          return { target: 'mayhem', reenter: true, context: { rng } };
        },
      },
    },
  },
});

/** A world of cafés, one per model, on its own clock. */
export function createWorld(input: Omit<WorldInput, 'clock'>) {
  const clock = new WorldClock();
  const actor = createActor(worldMachine, { input: { ...input, clock }, clock });
  return { actor, clock };
}
