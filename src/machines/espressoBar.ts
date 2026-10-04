import { createJevLogic, type JevDecision, type JevLoop } from '@xstate/jev';
import { createAsyncLogic, createCallbackLogic, setup, types, type AnyActorLogic } from 'xstate';
import { z } from 'zod';
import { orderRouter } from '../lib/barista';
import { jevClient, parseOrder } from '../lib/jev';
import {
  CHAOS_LEVELS,
  DEVICES,
  INGREDIENTS,
  MILK_TYPES,
  barOf,
  busyResources,
  cupBusy,
  cupById,
  cupIn,
  freeSlot,
  isOpen,
  spotFull,
  occupyHands,
  restock,
  restockable,
  serveTo,
  shortOf,
  stockOf,
  withStock,
} from '../lib/legal';
import { DOSE, HANDS_ON_MS, INITIAL_INVENTORY, POURS, STEPS, recipeFor, stepEvent, stepMs } from '../lib/recipes';
import type { StateValue } from 'xstate';
import type {
  Addition,
  Bar,
  BarContext,
  Barista,
  BarEvent,
  BaristaAction,
  Cup,
  CupSpot,
  Device,
  Drink,
  Ingredient,
  Inventory,
  MilkType,
  PourMl,
  ParsedOrder,
  StepId,
} from '../lib/types';

/* ------------------------------------------------------------------ actors */

const parseOrderActor = createAsyncLogic<ParsedOrder, { text: string }>({
  run: async ({ input }) => parseOrder(input.text),
});

/**
 * The barista: a Jev agent invoked at the top of the bar, deciding on it (its
 * parent) whenever it changes. Provided in `machines/index.ts`, with the Jev
 * client. The bar has no states for it: what the barista is doing is the
 * `hands` region, like any other resource.
 */
const barista: AnyActorLogic = createCallbackLogic(() => {});

/**
 * The order router: a Jev agent the bar asks with the customer's reply (it
 * decides only when asked). It hands `order.confirm` / `order.cancel` straight
 * back to the bar.
 */
const orderRouterAgent = createJevLogic<BarEvent, BarContext>({ ...orderRouter, client: jevClient('router'), auto: false });

/**
 * Chaos does not know the current probabilities — it just rolls dice every
 * second and hands them to the machine, which compares them against the live
 * `breakProb` levels in context, and only for a machine in use. That keeps the
 * levels editable without restarting the actor.
 */
const chaos = createCallbackLogic<{ type: 'noop' }, undefined>(({ sendBack }) => {
  const id = setInterval(() => {
    sendBack({
      type: 'CHAOS_ROLL',
      rolls: { grinder: Math.random(), groupHead: Math.random(), steamWand: Math.random() },
    });
  }, 1000);
  return () => clearInterval(id);
});

/* ----------------------------------------------------------------- helpers */

export function initialContext(): BarContext {
  return {
    drinks: [],
    cups: [],
    pitcher: null,
    nextCupNo: 1,
    shotCup: null,
    pour: null,
    hands: { jev: null, you: null },
    inventory: structuredClone(INITIAL_INVENTORY),
    pendingOrder: null,
    pendingText: '',
    lastParse: null,
    speed: 1,
    breakProb: { grinder: CHAOS_LEVELS.low, groupHead: CHAOS_LEVELS.low, steamWand: CHAOS_LEVELS.low },
    pendingAt: 0,
    nextDrinkNo: 1,
    error: null,
  };
}

function drinksFromOrder(order: ParsedOrder, startNo: number, now: number): Drink[] {
  const drinks: Drink[] = [];
  let n = startNo;
  for (const item of order.items) {
    for (let i = 0; i < item.qty; i++) {
      const recipe = recipeFor(item.drink);
      const milk: MilkType = recipe.usesMilk ? (item.milk ?? recipe.defaultMilk ?? 'whole') : 'none';
      const mods = { milk, size: item.size ?? 'regular', decaf: item.decaf, iced: item.iced } as const;
      drinks.push({
        id: `d${n}`,
        customerLabel: `#${n}`,
        drink: item.drink,
        mods: { ...mods },
        status: 'queued',
        orderedAt: now,
      });
      n++;
    }
  }
  return drinks;
}

/**
 * The drinks with an order's drinks queued after them. Helpers return values,
 * not context: a transition says itself which keys it sets, so the machine map
 * (and anyone reading it) can see them.
 */
function queued(context: BarContext, order: ParsedOrder | null): Drink[] {
  return [...context.drinks, ...(order ? drinksFromOrder(order, context.nextDrinkNo, context.pendingAt) : [])];
}

/** How many drinks an order is. */
function drinkCount(order: ParsedOrder | null): number {
  return order ? order.items.reduce((n, item) => n + item.qty, 0) : 0;
}

/** What an action takes from stock, when it starts. */
type Spend = Partial<Omit<Inventory, 'milk'>> & { milk?: [Exclude<MilkType, 'none'>, number] };

function spend(inv: Inventory, cost: Spend): Inventory {
  const next: Inventory = { ...inv, milk: { ...inv.milk } };
  if (cost.beans) next.beans = Math.max(0, next.beans - cost.beans);
  if (cost.water) next.water = Math.max(0, next.water - cost.water);
  if (cost.chocolate) next.chocolate = Math.max(0, next.chocolate - cost.chocolate);
  if (cost.milk) next.milk[cost.milk[0]] = Math.max(0, next.milk[cost.milk[0]] - cost.milk[1]);
  return next;
}

/** Who is acting: every barista event says (`by`), Jev's own picks included (its agent's `fixed`). */
type By = { by: Barista };

/** This barista's hands are on something already. */
function handsBusy(ctx: BarContext, event: By): boolean {
  return ctx.hands[event.by] !== null;
}

/** Both baristas' hands, with this one's now on `doing` for its hands-on time. */
function hold(ctx: BarContext, event: By, doing: BaristaAction, ms: number, on: Parameters<typeof occupyHands>[2] = {}) {
  return { ...ctx.hands, [event.by]: occupyHands(doing, ms, on) };
}

/**
 * Both baristas' hands, with this one's on a step for its hands-on time. What
 * the step does to the portafilter or the pitcher happens when their state's
 * delay is up, and to a cup when the hands come free (`finishHands`).
 */
function handsOn(ctx: BarContext, event: By, stepId: StepId, on: Parameters<typeof occupyHands>[2] = {}) {
  return hold(ctx, event, stepEvent(stepId) as BaristaAction, STEPS[stepId].handsOn, on);
}

/** A cup with `a` poured into it, if it is still out. */
function pourInto(cups: Cup[], cupId: string | null | undefined, a: Addition): Cup[] {
  return cups.map((c) => (c.id === cupId ? { ...c, contents: [...c.contents, a] } : c));
}

/**
 * What a barista's hands leave behind when their time is up: free hands, and
 * the cup step they were on, done. The portafilter's and the pitcher's steps
 * finish in their regions.
 */
function finishHands(ctx: BarContext, who: Barista): Partial<BarContext> {
  const h = ctx.hands[who];
  const hands = { ...ctx.hands, [who]: null };
  const cup = h?.cupId ? cupById(ctx, h.cupId) : undefined;
  if (!h || !cup) return { hands };
  const without = ctx.cups.filter((c) => c.id !== cup.id);
  switch (h.doing) {
    case 'barista.addWater':
      return { hands, cups: pourInto(ctx.cups, cup.id, { kind: 'water' }) };
    case 'barista.addChocolate':
      return { hands, cups: pourInto(ctx.cups, cup.id, { kind: 'chocolate' }) };
    case 'barista.dumpCup':
    case 'barista.putAwayCup':
      return { hands, cups: without };
    // The cup goes to the order it is (see `serveTo`), checked against its recipe.
    case 'barista.serve': {
      const to = serveTo(ctx, cup);
      if (!to) return { hands, cups: without };
      return {
        hands,
        cups: without,
        drinks: ctx.drinks.map((d) =>
          d.id === to.drink.id
            ? {
                ...d,
                status: 'served' as const,
                served: { cupId: cup.id, contents: cup.contents, spot: cup.spot, slot: cup.slot, correct: to.correct },
              }
            : d,
        ),
      };
    }
    // Putting out a cup and moving it happen as they start.
    default:
      return { hands };
  }
}

/** How long a step's state waits, at the bar's speed: a delay of the machine. */
const stepDelay =
  (stepId: StepId) =>
  ({ context }: { context: Pick<BarContext, 'speed'> }) =>
    stepMs(stepId) / (context.speed || 1);

/** How long a barista's hands stay on what they are doing, at the bar's speed. */
const handsDelay =
  (who: Barista) =>
  ({ context }: { context: Pick<BarContext, 'speed' | 'hands'> }) =>
    (context.hands[who]?.ms ?? 0) / (context.speed || 1);

/* ------------------------------------------------------------------ guards */

/**
 * Every barista action is a real event, and every guard is just the body of
 * its transition function: return nothing and the transition is not taken,
 * which is exactly what `snapshot.can(event)` reports back to Jev and to the
 * UI. The guards are physics, not recipes. What state the portafilter or the
 * pitcher is in decides which of their events are handled at all (they are
 * handled only in their regions' states where they make sense); the functions
 * check the rest: this barista's hands free, the equipment working and free,
 * the cup free, the ingredient in stock. Whether it makes the right drink is
 * not their business.
 */

/** The transition arguments the guards read: the context, the event, and the state value (for the regions). */
type Args<E = object> = { context: BarContext; event: E & By; value: StateValue };

function openDrink(bar: Bar, drinkId: string): Drink | undefined {
  const drink = bar.drinks.find((d) => d.id === drinkId);
  return drink && isOpen(drink) ? drink : undefined;
}

/** A cup that can be worked on: it is out, and nothing else is being done to it. */
function freeCup(ctx: BarContext, cupId: string): Cup | undefined {
  const cup = cupById(ctx, cupId);
  return cup && !cupBusy(ctx, cup.id) ? cup : undefined;
}

/** A device this barista can use now: working, and not running something else. */
function deviceFree(bar: Bar, device: Device): boolean {
  return !busyResources(bar).has(device);
}

/** Is `milk` a usable replacement for what this order asked for? Only out of a shortage. */
function substitutable(bar: Bar, drink: Drink, milk: MilkType): boolean {
  if (milk === 'none' || milk === drink.mods.milk || drink.mods.milk === 'none') return false;
  if (shortOf(bar, drink) !== drink.mods.milk) return false;
  return bar.inventory.milk[milk] >= DOSE.milk;
}

/** An order is declinable when something it still needs is out, and no milk swap would rescue it. */
function declinable(bar: Bar, drink: Drink): boolean {
  if (!shortOf(bar, drink)) return false;
  return !MILK_TYPES.some((milk) => substitutable(bar, drink, milk));
}

/** Knocking out grounds before their shot is pulled: what Jev reads for it. */
const UNPULLED = 'knock the unpulled grounds out of the portafilter: they are wasted, and the next shot starts over with a new grind';

/** Knocking out whatever is in the portafilter, pulled or not: from any resting state but empty. */
const knockOut = ({ context, event }: Args) => {
  if (handsBusy(context, event)) return;
  return { target: 'knocking', context: { hands: handsOn(context, event, 'knock_out') } };
};

/** Can a jug of this milk go under the steam wand now: hands free, the wand free, enough in stock? */
function canSteam({ context, event, value }: Args<{ milk: Exclude<MilkType, 'none'> }>): boolean {
  return !handsBusy(context, event) && deviceFree(barOf({ context, value }), 'steamWand') && context.inventory.milk[event.milk] >= DOSE.milk;
}

/** Milk in the pitcher, steamed or foamed: poured into a cup at the front (where it reaches), or poured away. */
const pitcherReady = {
  'barista.pourMilk': ({ context, event }: Args<{ cupId: string; ml: PourMl }>) => {
    if (handsBusy(context, event) || freeCup(context, event.cupId)?.spot !== 'front' || (context.pitcher?.ml ?? 0) < event.ml) return;
    return { target: 'pouring', context: { hands: handsOn(context, event, 'pour_milk'), pour: { cupId: event.cupId, ml: event.ml } } };
  },
  'barista.dumpPitcher': ({ context, event }: Args) => {
    if (handsBusy(context, event)) return;
    return { target: 'dumping', context: { hands: handsOn(context, event, 'dump_pitcher') } };
  },
};

/**
 * The barista's actions on cups, orders and stock, at the root: a cup can be
 * worked on whatever the portafilter or the pitcher is doing.
 */
const baristaActions = {
  // One cup on the drip tray; a few at the front, each in its own place.
  'barista.placeCup': ({ context, event }: Args<{ spot: CupSpot }>) => {
    if (handsBusy(context, event) || spotFull(context, event.spot)) return;
    return {
      context: {
        hands: handsOn(context, event, 'place_cup', { cupId: `c${context.nextCupNo}` }),
        cups: [
          ...context.cups,
          { id: `c${context.nextCupNo}`, spot: event.spot, slot: event.spot === 'front' ? freeSlot(context) : undefined, contents: [] },
        ],
        nextCupNo: context.nextCupNo + 1,
      },
    };
  },
  'barista.presentCup': ({ context, event }: Args<{ cupId: string }>) => {
    if (handsBusy(context, event) || freeCup(context, event.cupId)?.spot !== 'tray' || spotFull(context, 'front')) return;
    return {
      context: {
        hands: handsOn(context, event, 'present_cup', { cupId: event.cupId }),
        cups: context.cups.map((c) => (c.id === event.cupId ? { ...c, spot: 'front' as const, slot: freeSlot(context) } : c)),
      },
    };
  },
  // Back from the front onto the drip tray, if it is free.
  'barista.returnCup': ({ context, event }: Args<{ cupId: string }>) => {
    if (handsBusy(context, event) || freeCup(context, event.cupId)?.spot !== 'front' || spotFull(context, 'tray')) return;
    return {
      context: {
        hands: handsOn(context, event, 'return_cup', { cupId: event.cupId }),
        cups: context.cups.map((c) => (c.id === event.cupId ? { ...c, spot: 'tray' as const, slot: undefined } : c)),
      },
    };
  },
  // An empty cup off the counter, back on the shelf; one with anything in it is poured away instead.
  'barista.putAwayCup': ({ context, event }: Args<{ cupId: string }>) => {
    if (handsBusy(context, event) || freeCup(context, event.cupId)?.contents.length !== 0) return;
    return { context: { hands: handsOn(context, event, 'put_away_cup', { cupId: event.cupId }) } };
  },
  // The hot-water spout is over the drip tray.
  'barista.addWater': ({ context, event }: Args<{ cupId: string }>) => {
    if (handsBusy(context, event) || freeCup(context, event.cupId)?.spot !== 'tray' || context.inventory.water < DOSE.water) return;
    return {
      context: {
        hands: handsOn(context, event, 'add_water', { cupId: event.cupId }),
        inventory: spend(context.inventory, { water: DOSE.water }),
      },
    };
  },
  'barista.addChocolate': ({ context, event }: Args<{ cupId: string }>) => {
    if (handsBusy(context, event) || !freeCup(context, event.cupId) || context.inventory.chocolate < DOSE.chocolate) return;
    return {
      context: {
        hands: handsOn(context, event, 'add_chocolate', { cupId: event.cupId }),
        inventory: spend(context.inventory, { chocolate: DOSE.chocolate }),
      },
    };
  },
  // Any cup with something in it goes to whoever it is for (see `serveTo`).
  'barista.serve': ({ context, event }: Args<{ cupId: string }>) => {
    if (handsBusy(context, event) || !freeCup(context, event.cupId)?.contents.length || !context.drinks.some(isOpen)) return;
    return { context: { hands: handsOn(context, event, 'serve', { cupId: event.cupId }) } };
  },
  // Something to pour away; an empty cup is put away instead.
  'barista.dumpCup': ({ context, event }: Args<{ cupId: string }>) => {
    if (handsBusy(context, event) || !freeCup(context, event.cupId)?.contents.length) return;
    return { context: { hands: handsOn(context, event, 'dump_cup', { cupId: event.cupId }) } };
  },
  // Refilling an ingredient takes the barista's hands for a while.
  'barista.restock': ({ context, event }: Args<{ ingredient: Ingredient }>) => {
    if (handsBusy(context, event) || !restockable(context.inventory, event.ingredient)) return;
    return {
      context: {
        hands: hold(context, event, 'barista.restock', HANDS_ON_MS['barista.restock'], { ingredient: event.ingredient }),
        inventory: restock(context.inventory, event.ingredient),
      },
    };
  },
  'barista.substituteMilk': ({ context, event, value }: Args<{ drinkId: string; milk: MilkType }>) => {
    const bar = barOf({ context, value });
    const drink = openDrink(bar, event.drinkId);
    if (!drink || handsBusy(context, event) || !substitutable(bar, drink, event.milk)) return;
    return {
      context: {
        hands: hold(context, event, 'barista.substituteMilk', HANDS_ON_MS['barista.substituteMilk'], { drinkId: drink.id }),
        drinks: context.drinks.map((d) =>
          d.id === drink.id
            ? { ...d, mods: { ...d.mods, milk: event.milk }, note: `milk swapped to ${event.milk}` }
            : d,
        ),
      },
    };
  },
  'barista.decline': ({ context, event, value }: Args<{ drinkId: string }>) => {
    const bar = barOf({ context, value });
    const drink = openDrink(bar, event.drinkId);
    if (!drink || handsBusy(context, event) || !declinable(bar, drink)) return;
    return {
      context: {
        hands: hold(context, event, 'barista.decline', HANDS_ON_MS['barista.decline'], { drinkId: drink.id }),
        drinks: context.drinks.map((d) =>
          d.id === drink.id ? { ...d, status: 'declined' as const, note: 'out of ingredients' } : d,
        ),
      },
    };
  },
};

/* ----------------------------------------------------------------- machine */

/** The two baristas: every barista event says which of them makes it. */
const by = z.enum(['jev', 'you']);

export const espressoBarMachine = setup({
  schemas: { context: types<BarContext>() },
  actors: { parseOrderActor, barista, orderRouterAgent, chaos },
  // Every timed step is a state that waits out its delay; these say how long,
  // at the bar's speed. Time is events like any other (`xstate.after`): the
  // clock that sends them is the actor's, or a simulated one in tests.
  delays: {
    grind: stepDelay('grind_beans'),
    tamp: stepDelay('tamp'),
    lockIn: stepDelay('lock_in'),
    pull: stepDelay('extract'),
    knockOut: stepDelay('knock_out'),
    steam: stepDelay('steam_milk'),
    foam: stepDelay('foam_milk'),
    pour: stepDelay('pour_milk'),
    dumpPitcher: stepDelay('dump_pitcher'),
    repair: stepDelay('repair'),
    jevHands: handsDelay('jev'),
    yourHands: handsDelay('you'),
  },
}).createMachine({
  id: 'espressoBar',
  schemas: {
    /** Overrides for the opening context; tests use it to seed a bar. */
    input: types<Partial<BarContext> | undefined>(),
    events: {
      /** An order as typed, and when (`at`): the time it waits from. */
      'order.submit': types<{ text: string; at: number }>(),
      'order.reply': types<{ text: string }>(),
      // Events Jev may choose need runtime schemas (Zod): @xstate/jev reads
      // them to build and check each option.
      'order.confirm': z.object({}),
      'order.cancel': z.object({}),
      BREAK: types<{ device: Device }>(),
      /** From the ingredients panel: set how much of an ingredient there is, from nothing up to full. */
      SET_STOCK: types<{ ingredient: Ingredient; amount: number }>(),
      // The baristas' vocabulary. Jev picks one of these, fully instantiated,
      // and the machine's own transitions decide whether it lands. Every one
      // says who makes it (`by`): Jev, or you. Ids come from the barista's
      // payloads; the enums are read from the schema. The descriptions are
      // what Jev reads for each option: what the move is, and where it fits
      // in making a drink. They are knowledge, not rules: nothing here stops
      // a move the bar allows.
      'barista.repair': z
        .object({ device: z.enum(DEVICES as [Device, ...Device[]]).describe('the broken machine'), by })
        .describe('repair a broken machine: it takes your hands for a while, and nothing that needs it can happen until it works'),
      'barista.grindBeans': z
        .object({ by })
        .describe('grind beans into the empty portafilter: the first step of every shot (grind, tamp, lock in, pull)'),
      'barista.tamp': z.object({ by }).describe('tamp the grounds in the portafilter: the second step of a shot'),
      'barista.lockIn': z
        .object({ by })
        .describe('lock the tamped portafilter into the group head: the third step of a shot, then it is ready to pull'),
      'barista.extract': z
        .object({ by })
        .describe(
          'pull the shot into whatever cup is on the drip tray (with none, it goes down the drain); the group head then runs on its own',
        ),
      'barista.knockOut': z.object({ by }).describe('knock out whatever is in the portafilter, emptying it'),
      'barista.placeCup': z
        .object({
          spot: z
            .enum(['tray', 'front'])
            .describe('the drip tray (under the spouts and the hot water: for a shot or water) or the front (where milk is poured)'),
          by,
        })
        .describe("put out an empty cup, where the drink's first ingredient goes in"),
      'barista.presentCup': z
        .object({ cupId: z.string(), by })
        .describe('bring a cup from the drip tray to the front, where milk is poured; no shot or water reaches it there'),
      'barista.returnCup': z
        .object({ cupId: z.string(), by })
        .describe('slide a cup from the front back onto the drip tray, under the spouts and the hot water'),
      'barista.putAwayCup': z.object({ cupId: z.string(), by }).describe('put an empty cup back on the shelf, freeing its place'),
      'barista.addWater': z.object({ cupId: z.string(), by }).describe('add hot water to the cup on the drip tray'),
      'barista.addChocolate': z.object({ cupId: z.string(), by }).describe('add chocolate to a cup'),
      'barista.pourMilk': z
        .object({
          cupId: z.string(),
          ml: z
            .union(POURS.map((ml) => z.literal(ml)) as unknown as [z.ZodLiteral<PourMl>, z.ZodLiteral<PourMl>, ...z.ZodLiteral<PourMl>[]])
            .describe('how much, in ml; what is left stays in the pitcher'),
          by,
        })
        .describe('pour milk from the pitcher, as it is, into a cup at the front'),
      'barista.serve': z
        .object({ cupId: z.string(), by })
        .describe(
          'hand a cup over: it goes to the order it is exactly; anything else goes to an order as the wrong drink',
        ),
      'barista.dumpCup': z.object({ cupId: z.string(), by }).describe('pour a cup away, with what is in it'),
      'barista.steamMilk': z
        .object({
          milk: z.enum(MILK_TYPES as [Exclude<MilkType, 'none'>, ...Exclude<MilkType, 'none'>[]]).describe('the milk'),
          by,
        })
        .describe(`steam ${DOSE.milk}ml of milk in the empty pitcher: steamed milk, hot and silky; it takes your hands for the whole steam`),
      'barista.foamMilk': z
        .object({
          milk: z.enum(MILK_TYPES as [Exclude<MilkType, 'none'>, ...Exclude<MilkType, 'none'>[]]).describe('the milk'),
          by,
        })
        .describe(`steam ${DOSE.milk}ml of milk in the empty pitcher with air drawn in: foamed milk, a thick cap of foam; it takes your hands for the whole steam`),
      'barista.dumpPitcher': z.object({ by }).describe('pour away the milk in the pitcher: it is empty again, so milk can be steamed or foamed in it'),
      'barista.substituteMilk': z
        .object({
          drinkId: z.string(),
          milk: z.enum(MILK_TYPES as [Exclude<MilkType, 'none'>, ...Exclude<MilkType, 'none'>[]]).describe('the milk it gets instead'),
          by,
        })
        .describe("swap an order's milk for another, when its own has run out"),
      'barista.decline': z
        .object({ drinkId: z.string(), by })
        .describe('apologise and turn an order away: that customer gets nothing'),
      'barista.restock': z
        .object({ ingredient: z.enum(INGREDIENTS as [Ingredient, ...Ingredient[]]), by })
        .describe('refill an ingredient to full, from the stockroom; it takes your hands for a while'),
      // Replies from the order router.
      'jev.thinking': types<void>(),
      'jev.decided': types<{ decision: JevDecision<BarEvent>; loop: JevLoop | null }>(),
      'jev.failed': types<{ error: string }>(),
      CHAOS_ROLL: types<{ rolls: Record<Device, number> }>(),
      SET_SPEED: types<{ speed: number }>(),
      SET_BREAK_PROB: types<{ device: Device; prob: number }>(),
      RESET: types<void>(),
      /** Raised by RESET: the regions go back to where they started. */
      'bar.reset': types<void>(),
    },
  },
  context: ({ input }) => ({ ...initialContext(), ...input }),
  invoke: [
    { src: 'chaos', id: 'chaos' },
    { src: 'barista', id: 'barista' },
    { src: 'orderRouterAgent', id: 'router', input: ({ self }) => ({ actor: self }) },
  ],
  on: {
    // The barista's actions on cups, orders and stock; each transition is its
    // own guard (see `baristaActions`). The portafilter's and the pitcher's are
    // in their regions.
    ...baristaActions,
    // A machine only breaks while it is in use; an idle bar never breaks.
    CHAOS_ROLL: ({ context, event, value }, enq) => {
      for (const device of ['grinder', 'groupHead', 'steamWand'] as Device[]) {
        if (
          barOf({ context, value }).equipment[device] === 'ok' &&
          barOf({ context, value }).activeSteps.some((a) => a.resource === device) &&
          event.rolls[device] < context.breakProb[device]
        ) {
          enq.raise({ type: 'BREAK', device });
        }
      }
    },
    SET_STOCK: ({ context, event }) => ({
      context: {
        inventory: withStock(context.inventory, event.ingredient, Math.max(0, Math.min(event.amount, stockOf(INITIAL_INVENTORY, event.ingredient)))),
      },
    }),
    SET_SPEED: ({ event }) => ({ context: { speed: event.speed } }),
    SET_BREAK_PROB: ({ context, event }) => ({
      context: { breakProb: { ...context.breakProb, [event.device]: event.prob } },
    }),
    // Everything back to how the bar opened: the context here, and the
    // portafilter, pitcher and equipment regions (on `bar.reset`) back to
    // their initial states.
    RESET: (_, enq) => {
      enq.sendTo('barista', { type: 'jev.reset' });
      enq.sendTo('router', { type: 'jev.cancel' });
      enq.raise({ type: 'bar.reset' });
      return { context: initialContext() };
    },
  },
  type: 'parallel',
  states: {
    /* ---------------------------------------------------------- intake --- */
    intake: {
      initial: 'idle',
      states: {
        idle: {
          on: {
            'order.submit': ({ event }) => ({
              target: 'parsing',
              context: { pendingText: event.text, pendingAt: event.at, error: null },
            }),
          },
        },
        parsing: {
          invoke: {
            id: 'parseOrder',
            src: 'parseOrderActor',
            input: ({ context }: { context: BarContext }) => ({ text: context.pendingText }),
            onDone: ({ context, event }) => {
              const parsed = event.output as ParsedOrder;
              if (parsed.intent !== 'order' || parsed.items.length === 0) {
                return {
                  target: 'idle',
                  context: {
                    lastParse: parsed,
                    pendingOrder: null,
                    error:
                      parsed.items.length === 0
                        ? 'No drinks recognised in that order.'
                        : `That read as "${parsed.intent}", not an order.`,
                  },
                };
              }
              // Low confidence is a first-class outcome: ask, do not guess.
              if (parsed.confidence < 0.5) {
                return { target: 'clarifying', context: { lastParse: parsed, pendingOrder: parsed } };
              }
              return {
                target: 'idle',
                context: { lastParse: parsed, pendingOrder: null, drinks: queued(context, parsed), nextDrinkNo: context.nextDrinkNo + drinkCount(parsed) },
              };
            },
            onError: ({ event }) => ({
              target: 'idle',
              context: { error: `Jev parse failed: ${String((event as { error?: unknown }).error)}` },
            }),
          },
        },
        clarifying: {
          initial: 'asking',
          // On the parent so they stay accepted while the router is deciding.
          on: {
            'order.confirm': {
              description: 'the customer confirms the order as it was read back',
              to: ({ context }: { context: BarContext }) => ({
                target: 'idle',
                context: {
                  pendingOrder: null,
                  error: null,
                  drinks: queued(context, context.pendingOrder),
                  nextDrinkNo: context.nextDrinkNo + drinkCount(context.pendingOrder),
                },
              }),
            },
            'order.cancel': {
              description: 'the customer says the order is wrong, or wants to start over',
              to: () => ({ target: 'idle', context: { pendingOrder: null, error: null } }),
            },
          },
          states: {
            asking: {
              on: {
                'order.reply': ({ event }, enq) => {
                  enq.sendTo('router', { type: 'jev.ask', input: event.text });
                  return { target: 'routing', context: { pendingText: event.text, error: null } };
                },
              },
            },
            routing: {
              on: {
                // Only reached when nothing was handed over: `order.confirm` /
                // `order.cancel` from the router leave `clarifying` first.
                'jev.decided': ({ event }) => ({
                  target: 'asking',
                  context: {
                    error:
                      event.decision.reason === 'low-confidence'
                        ? `Jev was only ${Math.round(event.decision.confidence * 100)}% sure what you meant — is the order right?`
                        : 'That did not answer the question — is the order right?',
                  },
                }),
                'jev.failed': ({ event }) => ({
                  target: 'asking',
                  context: { error: `Jev routing failed: ${event.error}` },
                }),
              },
            },
          },
        },
      },
    },

    /* ----------------------------------------------------- portafilter --- */
    // The one portafilter. Resting states say what is in it; the `-ing`
    // states are a step on it in progress, which ends when its delay is up
    // (`after`). Only the events that make sense in a state are handled
    // there: grounds can be tamped, a tamped basket locked in, a locked one
    // pulled, and anything in it knocked out.
    portafilter: {
      initial: 'empty',
      on: { 'bar.reset': { target: '.empty', reenter: true } },
      states: {
        empty: {
          description: 'Nothing in it: grinding into it starts a shot',
          on: {
            'barista.grindBeans': ({ context, event, value }) => {
              if (handsBusy(context, event) || !deviceFree(barOf({ context, value }), 'grinder') || context.inventory.beans < DOSE.beans) return;
              return {
                target: 'grinding',
                context: { hands: handsOn(context, event, 'grind_beans'), inventory: spend(context.inventory, { beans: DOSE.beans }) },
              };
            },
          },
        },
        grinding: {
          description: 'The grinder grinds into it, on its own once started',
          after: { grind: { target: 'grounds' } },
          on: {
            // Grounds half ground are lost with the grinder.
            BREAK: { matches: { device: 'grinder' }, target: 'empty' },
          },
        },
        grounds: {
          description: 'Ground coffee, to tamp',
          on: {
            'barista.tamp': ({ context, event }) => {
              if (handsBusy(context, event)) return;
              return { target: 'tamping', context: { hands: handsOn(context, event, 'tamp') } };
            },
            'barista.knockOut': { description: UNPULLED, to: knockOut },
          },
        },
        tamping: { after: { tamp: { target: 'tamped' } } },
        tamped: {
          description: 'Tamped, to lock into the group head',
          on: {
            'barista.lockIn': ({ context, event, value }) => {
              if (handsBusy(context, event) || !deviceFree(barOf({ context, value }), 'groupHead')) return;
              return { target: 'lockingIn', context: { hands: handsOn(context, event, 'lock_in') } };
            },
            'barista.knockOut': { description: UNPULLED, to: knockOut },
          },
        },
        lockingIn: {
          after: { lockIn: { target: 'locked' } },
          on: { BREAK: { matches: { device: 'groupHead' }, target: 'tamped' } },
        },
        locked: {
          description: 'Locked into the group head, ready to pull a shot',
          on: {
            // Into whatever cup stands under the spouts; with none, the shot goes down the drain.
            'barista.extract': ({ context, event, value }) => {
              if (handsBusy(context, event) || !deviceFree(barOf({ context, value }), 'groupHead')) return;
              return {
                target: 'pulling',
                context: {
                  hands: handsOn(context, event, 'extract'),
                  shotCup: freeCup(context, cupIn(context, 'tray')?.id ?? '')?.id ?? null,
                },
              };
            },
            'barista.knockOut': { description: UNPULLED, to: knockOut },
          },
        },
        pulling: {
          description: 'The shot pulls on its own once started',
          after: {
            pull: {
              target: 'spent',
              context: ({ context }) => ({ cups: pourInto(context.cups, context.shotCup, { kind: 'shot' }), shotCup: null }),
            },
          },
          on: {
            // A shot cut short is lost; the grounds are still in there.
            BREAK: { matches: { device: 'groupHead' }, target: 'locked', context: { shotCup: null } },
          },
        },
        spent: {
          description: 'A spent puck, to knock out before the next grind',
          on: {
            'barista.knockOut': {
              description: 'knock the spent puck out of the portafilter, emptying it for the next grind',
              to: knockOut,
            },
          },
        },
        knocking: { after: { knockOut: { target: 'empty' } } },
      },
    },

    /* --------------------------------------------------------- pitcher --- */
    // The one milk pitcher: any milk, steamed or foamed, then poured into
    // cups at the front (where it reaches), or poured away. Its milk is data (`context.pitcher`); what is happening to
    // it, and what texture it has reached, is this region.
    pitcher: {
      initial: 'empty',
      on: { 'bar.reset': { target: '.empty', reenter: true } },
      states: {
        empty: {
          description: 'Clean and empty: any milk can be steamed or foamed in it',
          on: {
            'barista.steamMilk': ({ context, event, value }) => {
              if (!canSteam({ context, event, value })) return;
              return {
                target: 'steaming',
                context: {
                  hands: handsOn(context, event, 'steam_milk'),
                  inventory: spend(context.inventory, { milk: [event.milk, DOSE.milk] }),
                  pitcher: { milk: event.milk, texture: 'steamed', ml: DOSE.milk },
                },
              };
            },
            'barista.foamMilk': ({ context, event, value }) => {
              if (!canSteam({ context, event, value })) return;
              return {
                target: 'foaming',
                context: {
                  hands: handsOn(context, event, 'foam_milk'),
                  inventory: spend(context.inventory, { milk: [event.milk, DOSE.milk] }),
                  pitcher: { milk: event.milk, texture: 'foamed', ml: DOSE.milk },
                },
              };
            },
          },
        },
        steaming: {
          description: 'Held under the steam wand for the whole steam',
          after: { steam: { target: 'steamed' } },
          on: {
            // Milk half steamed is poured away.
            BREAK: { matches: { device: 'steamWand' }, target: 'empty', context: { pitcher: null } },
          },
        },
        steamed: {
          description: 'Steamed milk: to pour into cups at the front, or pour away',
          on: pitcherReady,
        },
        foaming: {
          description: 'Held under the steam wand for the whole steam, drawing air in',
          after: { foam: { target: 'foamed' } },
          on: {
            // Milk half foamed is poured away.
            BREAK: { matches: { device: 'steamWand' }, target: 'empty', context: { pitcher: null } },
          },
        },
        foamed: {
          description: 'Foamed milk: to pour into cups at the front, or pour away',
          on: pitcherReady,
        },
        pouring: {
          after: {
            // The pour goes into its cup; what is left stays in the pitcher, as it was.
            pour: ({ context }) => {
              const left = (context.pitcher?.ml ?? 0) - (context.pour?.ml ?? 0);
              const poured = context.pitcher && context.pour ? { kind: 'milk' as const, ...context.pitcher, ml: context.pour.ml } : null;
              return {
                target: left > 0 ? (context.pitcher?.texture === 'foamed' ? 'foamed' : 'steamed') : 'empty',
                context: {
                  cups: poured ? pourInto(context.cups, context.pour?.cupId, poured) : context.cups,
                  pitcher: left > 0 && context.pitcher ? { ...context.pitcher, ml: left } : null,
                  pour: null,
                },
              };
            },
          },
        },
        dumping: { after: { dumpPitcher: { target: 'empty', context: { pitcher: null } } } },
      },
    },

    /* ----------------------------------------------------------- hands --- */
    // Each barista's hands: free, or busy for the hands-on time of what they
    // are doing (`context.hands`). Any transition that takes them sets that;
    // the region follows (`always`), waits it out, and lets go, finishing the
    // cup step they were on (`finishHands`). Written out per barista, like
    // the equipment, so the inspector reads them from source.
    hands: {
      type: 'parallel',
      states: {
        jev: {
          initial: 'free',
          on: { 'bar.reset': { target: '.free', reenter: true } },
          states: {
            free: { always: { target: 'busy', guard: ({ context }: { context: BarContext }) => context.hands.jev !== null } },
            busy: { after: { jevHands: { target: 'free', context: ({ context }) => finishHands(context, 'jev') } } },
          },
        },
        you: {
          initial: 'free',
          on: { 'bar.reset': { target: '.free', reenter: true } },
          states: {
            free: { always: { target: 'busy', guard: ({ context }: { context: BarContext }) => context.hands.you !== null } },
            busy: { after: { yourHands: { target: 'free', context: ({ context }) => finishHands(context, 'you') } } },
          },
        },
      },
    },

    /* ------------------------------------------------------- equipment --- */
    equipment: {
      type: 'parallel',
      states: {
        // Each device is its own region: ok -> broken -> repairing -> ok. The
        // three are written out rather than built by a helper, so the inspector
        // can read their states and targets from this file's source.
        grinder: {
          initial: 'ok',
          on: { 'bar.reset': { target: '.ok', reenter: true } },
          states: {
            ok: { on: { BREAK: { matches: { device: 'grinder' }, target: 'broken' } } },
            broken: {
              on: {
                'barista.repair': {
                  matches: { device: 'grinder' },
                  guard: ({ context, event }: { context: BarContext; event: By }) => !handsBusy(context, event),
                  target: 'repairing',
                  context: ({ context, event }) => ({
                    hands: hold(context, event, 'barista.repair', HANDS_ON_MS['barista.repair'], { device: event.device }),
                  }),
                },
              },
            },
            repairing: { after: { repair: { target: 'ok' } } },
          },
        },
        groupHead: {
          initial: 'ok',
          on: { 'bar.reset': { target: '.ok', reenter: true } },
          states: {
            ok: { on: { BREAK: { matches: { device: 'groupHead' }, target: 'broken' } } },
            broken: {
              on: {
                'barista.repair': {
                  matches: { device: 'groupHead' },
                  guard: ({ context, event }: { context: BarContext; event: By }) => !handsBusy(context, event),
                  target: 'repairing',
                  context: ({ context, event }) => ({
                    hands: hold(context, event, 'barista.repair', HANDS_ON_MS['barista.repair'], { device: event.device }),
                  }),
                },
              },
            },
            repairing: { after: { repair: { target: 'ok' } } },
          },
        },
        steamWand: {
          initial: 'ok',
          on: { 'bar.reset': { target: '.ok', reenter: true } },
          states: {
            ok: { on: { BREAK: { matches: { device: 'steamWand' }, target: 'broken' } } },
            broken: {
              on: {
                'barista.repair': {
                  matches: { device: 'steamWand' },
                  guard: ({ context, event }: { context: BarContext; event: By }) => !handsBusy(context, event),
                  target: 'repairing',
                  context: ({ context, event }) => ({
                    hands: hold(context, event, 'barista.repair', HANDS_ON_MS['barista.repair'], { device: event.device }),
                  }),
                },
              },
            },
            repairing: { after: { repair: { target: 'ok' } } },
          },
        },
      },
    },
  },
});
