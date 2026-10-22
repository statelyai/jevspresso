/**
 * A day at the bar: one café, run by one model, through a day made from a
 * seed (`generateDay`). The day sends the bar its customers and its mayhem at
 * their times, in bar time; plays each customer, who answers "did you mean…?"
 * by what they meant; and keeps the record a scorecard is made from. The
 * day's clock (`WorldClock`) is the bar's too, and it stands still while the
 * bar asks a customer about their order, so that conversation costs no time.
 */
import { createActor, setup, types, type ActorRefFrom } from 'xstate';
import { generateDay, readRight, type DayEvent, type DayOrder } from '../lib/day';
import type { ModelId } from '../lib/models';
import type { BarContext, ParsedOrder } from '../lib/types';
import { WorldClock } from '../lib/worldClock';
import { modelCafe, type CafeLogic } from './cafe';

/** How many times a customer says their order before giving up on it. */
export const TRIES = 2;
/** How many times a customer answers one "did you mean…?" before giving up on it. */
export const REPLIES = 2;
/** After the last customer comes in, how much bar time the bar has to finish. */
export const CLOSING_MS = 120_000;

export const YES = "yes, that's right";
export const NO = "no, that's not what I said";

export interface DayRead {
  parsed: ParsedOrder;
  right: boolean;
  /** The bar was unsure, and asked. */
  asked: boolean;
}

export interface CustomerRecord {
  order: DayOrder;
  /** When they ordered: day-clock time (what the bar is told), and bar time. */
  at: number;
  barAt: number;
  /** How many times they have said it. */
  tries: number;
  /** Each time the bar read it. */
  reads: DayRead[];
  status: 'waiting' | 'in' | 'walked';
}

export interface DayContext {
  clock: WorldClock;
  seed: number;
  model: ModelId;
  timeline: DayEvent[];
  /** The next event in the timeline. */
  next: number;
  /** The bar's speed, and the bar and clock times when it was last set: bar time runs from there. */
  speed: number;
  speedSetBarAt: number;
  speedSetAt: number;
  cafe: ActorRefFrom<CafeLogic>;
  customers: CustomerRecord[];
  /** The bar's last read, to tell a new one. */
  lastParse: ParsedOrder | null;
  /** The customer the bar is asking about, if it is: whether they have answered this time, and how often in all. */
  asking: { order: string; replied: boolean; replies: number } | null;
  /** When each drink was served, in bar time. */
  servedAt: Record<string, number>;
  /** When the day started, on the wall clock: which of the model's requests are this day's. */
  startedWall: number;
}

export interface DayInput {
  model: ModelId;
  seed: number;
  clock: WorldClock;
  /** The café the model runs: the real one by default; tests give their own. */
  cafe?: CafeLogic;
}

/** Bar time now: from the last speed change, at the speed set then. */
export function barTime(context: Pick<DayContext, 'clock' | 'speed' | 'speedSetBarAt' | 'speedSetAt'>): number {
  return context.speedSetBarAt + (context.clock.now() - context.speedSetAt) * context.speed;
}

/** A customer's drinks are in when the bar has them queued: same words, same time. */
function drinksOf(bar: BarContext, customer: CustomerRecord) {
  return bar.drinks.filter((d) => d.orderedAt === customer.at && d.orderText === customer.order.text);
}

type Enq = { sendTo: (to: ActorRefFrom<CafeLogic>, event: never) => void };

/** Say it again, at the time they first ordered (so the wait counts from then); or walk out. */
function retry(customer: CustomerRecord, cafe: ActorRefFrom<CafeLogic>, enq: Enq): CustomerRecord {
  if (customer.tries >= TRIES) return { ...customer, status: 'walked' };
  enq.sendTo(cafe, { type: 'order.submit', text: customer.order.text, at: customer.at } as never);
  return { ...customer, tries: customer.tries + 1 };
}

/** Is everyone seen to: in and every drink finished, or gone? */
function allDone(context: DayContext): boolean {
  const bar = context.cafe.getSnapshot();
  if (!bar.matches({ intake: 'idle' }) || bar.context.orderQueue.length) return false;
  return context.customers.every(
    (c) => c.status === 'walked' || (c.status === 'in' && drinksOf(bar.context, c).every((d) => d.status === 'served' || d.status === 'declined')),
  );
}

export const dayMachine = setup({
  schemas: { context: types<DayContext>() },
  delays: {
    // v6 delay sources see the machine context untyped at `setup()` time.
    next: ({ context }) => {
      const c = context as DayContext;
      return Math.max(0, (c.timeline[c.next].at - barTime(c)) / c.speed);
    },
    closing: ({ context }) => CLOSING_MS / (context as DayContext).speed,
  },
}).createMachine({
  id: 'day',
  schemas: {
    input: types<DayInput>(),
    events: {
      /** The bar changed (the day's own subscription). */
      'cafe.changed': types<void>(),
      SET_SPEED: types<{ speed: number }>(),
    },
  },
  context: ({ input, spawn }) => ({
    clock: input.clock,
    seed: input.seed,
    model: input.model,
    timeline: generateDay(input.seed),
    next: 0,
    speed: 1,
    speedSetBarAt: 0,
    speedSetAt: input.clock.now(),
    cafe: spawn(input.cafe ?? modelCafe(input.model, input.clock), { id: 'cafe' }),
    customers: [],
    lastParse: null,
    asking: null,
    servedAt: {},
    startedWall: Date.now(),
  }),
  entry: ({ context }, enq) => {
    enq.subscribeTo(context.cafe, () => ({ type: 'cafe.changed' }));
  },
  on: {
    SET_SPEED: ({ context, event }, enq) => {
      enq.sendTo(context.cafe, event);
      return { context: { speed: event.speed, speedSetBarAt: barTime(context), speedSetAt: context.clock.now() } };
    },
    'cafe.changed': ({ context }, enq) => {
      const bar = context.cafe.getSnapshot();
      // Read before any `matches`: its type predicates narrow `bar` past use.
      const drinks = bar.context.drinks;
      let customers = context.customers;
      const update = (id: string, f: (c: CustomerRecord) => CustomerRecord) => {
        customers = customers.map((c) => (c.order.id === id ? f(c) : c));
      };
      const waiting = (text: string | undefined) => customers.find((c) => c.status === 'waiting' && c.order.text === text);

      // A new read: what the bar made of what a customer said.
      const parsed = bar.context.lastParse;
      if (parsed && parsed !== context.lastParse) {
        const customer = waiting(parsed.text);
        if (customer) {
          const dropped = parsed.intent !== 'order' || parsed.items.length === 0;
          const read = { parsed, right: readRight(parsed, customer.order), asked: !dropped && parsed.confidence < 0.5 };
          update(customer.order.id, (c) => ({ ...c, reads: [...c.reads, read] }));
          // Not taken as an order at all: they say it again.
          if (dropped) update(customer.order.id, (c) => retry(c, context.cafe, enq));
        }
      }

      // Their drinks are on the bar's list.
      for (const c of customers) if (c.status === 'waiting' && drinksOf(bar.context, c).length) update(c.order.id, (x) => ({ ...x, status: 'in' }));

      // "Did you mean…?": the customer answers by what they meant; the router hears it.
      let asking = context.asking;
      if (bar.matches({ intake: { clarifying: 'asking' } })) {
        const customer = waiting(bar.context.pendingOrder?.text);
        if (customer && !(asking?.order === customer.order.id && asking.replied)) {
          const replies = asking?.order === customer.order.id ? asking.replies : 0;
          if (replies >= REPLIES) enq.sendTo(context.cafe, { type: 'order.cancel' });
          else enq.sendTo(context.cafe, { type: 'order.reply', text: readRight(bar.context.pendingOrder!, customer.order) ? YES : NO });
          asking = { order: customer.order.id, replied: true, replies: replies + 1 };
        }
      } else if (bar.matches({ intake: { clarifying: 'routing' } })) {
        if (asking) asking = { ...asking, replied: false };
      } else if (asking) {
        // Done asking: if the order did not go in, they say it again.
        const customer = customers.find((c) => c.order.id === asking!.order);
        if (customer?.status === 'waiting') update(customer.order.id, (c) => retry(c, context.cafe, enq));
        asking = null;
      }

      // The day stands still while the bar is asking.
      const clarifying = bar.matches({ intake: 'clarifying' });
      if (clarifying && !context.clock.paused) enq(() => context.clock.pause());
      if (!clarifying && context.clock.paused) enq(() => context.clock.resume());

      const now = barTime(context);
      const served = drinks.filter((d) => d.status === 'served' && !(d.id in context.servedAt));
      const servedAt = served.length ? { ...context.servedAt, ...Object.fromEntries(served.map((d) => [d.id, now])) } : context.servedAt;

      return { context: { customers, lastParse: parsed, asking, servedAt } };
    },
  },
  initial: 'open',
  states: {
    open: {
      description: 'Customers coming in, and things going wrong, each at its time',
      on: {
        // A change of speed changes when the next event is due: wait for it again.
        SET_SPEED: ({ context, event }, enq) => {
          enq.sendTo(context.cafe, event);
          return { target: 'open', reenter: true, context: { speed: event.speed, speedSetBarAt: barTime(context), speedSetAt: context.clock.now() } };
        },
      },
      after: {
        next: ({ context }, enq) => {
          const event = context.timeline[context.next];
          let customers = context.customers;
          if (event.type === 'order') {
            const at = context.clock.now();
            enq.sendTo(context.cafe, { type: 'order.submit', text: event.order.text, at });
            customers = [...customers, { order: event.order, at, barAt: barTime(context), tries: 1, reads: [], status: 'waiting' }];
          } else if (event.type === 'break') {
            enq.sendTo(context.cafe, { type: 'BREAK', device: event.device });
          } else {
            enq.sendTo(context.cafe, { type: 'SET_STOCK', ingredient: event.ingredient, amount: 0 });
          }
          const next = context.next + 1;
          return { target: next < context.timeline.length ? 'open' : 'closing', reenter: true, context: { next, customers } };
        },
      },
    },
    closing: {
      description: 'Everyone has come in: the bar finishes what it has, or runs out of time',
      always: ({ context }) => (allDone(context) ? { target: 'closed' } : undefined),
      after: { closing: { target: 'closed' } },
    },
    closed: {
      description: 'The day is over: its record is the scorecard',
      // The bar stops with it (no more requests); its last snapshot stays to be read.
      entry: ({ context }, enq) => {
        if (context.clock.paused) enq(() => context.clock.resume());
        enq.stop(context.cafe);
      },
    },
  },
});

/** A day, on its own clock. */
export function createDay(input: Omit<DayInput, 'clock'>) {
  const clock = new WorldClock();
  const actor = createActor(dayMachine, { input: { ...input, clock }, clock });
  return { actor, clock };
}

