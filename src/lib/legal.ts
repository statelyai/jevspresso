import type { StateValue } from 'xstate';
import { additionLabel, DOSE, INITIAL_INVENTORY, milkName, recipeFor, sameAddition, STEPS, stepMs, stepOf, targetOf } from './recipes';
import type {
  Addition,
  Bar,
  BarContext,
  BaristaAction,
  BarSnapshot,
  Cup,
  CupSpot,
  CupView,
  Device,
  Drink,
  Hands,
  Ingredient,
  Inventory,
  MilkType,
  PitcherState,
  PortafilterState,
  RunningStep,
  StepId,
} from './types';

export const DEVICES: Device[] = ['grinder', 'groupHead', 'steamWand'];

/** Chaos levels: each second a machine is in use, the chance it breaks. */
export const CHAOS_LEVELS = { off: 0, low: 0.02, medium: 0.05, high: 0.12 } as const;
export type ChaosLevel = keyof typeof CHAOS_LEVELS;

export const MILK_TYPES: Exclude<MilkType, 'none'>[] = ['whole', 'oat', 'almond', 'soy', 'half'];

export const INGREDIENTS: Ingredient[] = ['beans', 'water', 'chocolate', 'whole', 'oat', 'almond', 'soy', 'half'];

/** How much of an ingredient is left: grams or millilitres. */
export function stockOf(inventory: Inventory, ingredient: Ingredient): number {
  return ingredient in inventory.milk ? inventory.milk[ingredient as keyof Inventory['milk']] : inventory[ingredient as 'beans' | 'water' | 'chocolate'];
}

/** An ingredient worth restocking: under half of a full stock. */
export function restockable(inventory: Inventory, ingredient: Ingredient): boolean {
  return stockOf(inventory, ingredient) < stockOf(INITIAL_INVENTORY, ingredient) / 2;
}

/** The inventory with one ingredient set to `amount`. */
export function withStock(inventory: Inventory, ingredient: Ingredient, amount: number): Inventory {
  return ingredient in inventory.milk
    ? { ...inventory, milk: { ...inventory.milk, [ingredient]: amount } }
    : { ...inventory, [ingredient]: amount };
}

/** The inventory with one ingredient back to full. */
export function restock(inventory: Inventory, ingredient: Ingredient): Inventory {
  return withStock(inventory, ingredient, stockOf(INITIAL_INVENTORY, ingredient));
}

/** An order still waiting for its drink. */
export function isOpen(drink: Drink): boolean {
  return drink.status === 'queued';
}

/** Open orders, longest waiting first. */
export function openOrders(ctx: BarContext): Drink[] {
  return ctx.drinks.filter(isOpen).sort((a, b) => a.orderedAt - b.orderedAt);
}

/* -------------------------------------------------------------- things --- */

export function cupById(ctx: BarContext, cupId: string): Cup | undefined {
  return ctx.cups.find((c) => c.id === cupId);
}

/** How many cups fit on the counter at the front; the drip tray takes one. */
export const FRONT_SLOTS = 3;

/** The cup on the drip tray (or the first at the front), if any. */
export function cupIn(ctx: BarContext, spot: CupSpot): Cup | undefined {
  return ctx.cups.find((c) => c.spot === spot);
}

/** The cups standing in `spot`. */
export function cupsIn(ctx: BarContext, spot: CupSpot): Cup[] {
  return ctx.cups.filter((c) => c.spot === spot);
}

/** No room for another cup there. */
export function spotFull(ctx: BarContext, spot: CupSpot): boolean {
  return cupsIn(ctx, spot).length >= (spot === 'tray' ? 1 : FRONT_SLOTS);
}

/** The first free place at the front, nearest the jug. */
export function freeSlot(ctx: BarContext): number {
  const used = new Set(cupsIn(ctx, 'front').map((c) => c.slot));
  let slot = 0;
  while (used.has(slot)) slot++;
  return slot;
}

/** Something is being done to this cup right now: a barista's hands on it, a shot or milk going in. */
export function cupBusy(ctx: BarContext, cupId: string): boolean {
  return ctx.hands.jev?.cupId === cupId || ctx.hands.you?.cupId === cupId || ctx.shotCup === cupId || ctx.pour?.cupId === cupId;
}

/** The portafilter's timed states: something is being done with it right now. */
const PORTAFILTER_BUSY: PortafilterState[] = ['grinding', 'tamping', 'lockingIn', 'pulling', 'knocking'];
const PITCHER_BUSY: PitcherState[] = ['steaming', 'foaming', 'pouring', 'dumping'];

export function portafilterBusy(ctx: Bar): boolean {
  return PORTAFILTER_BUSY.includes(ctx.portafilter);
}

export function pitcherBusy(ctx: Bar): boolean {
  return PITCHER_BUSY.includes(ctx.pitcherState);
}

/**
 * The bar as the helpers read it: the machine's context, plus the states of
 * its portafilter, pitcher and equipment regions, from the state value.
 */
export function barOf({ context, value }: { context: BarContext; value: StateValue }): Bar {
  const v = value as { portafilter?: PortafilterState; pitcher?: PitcherState; equipment?: Record<Device, Bar['equipment'][Device]> };
  const bar = {
    ...context,
    portafilter: v.portafilter ?? 'empty',
    pitcherState: v.pitcher ?? 'empty',
    equipment: { grinder: 'ok' as const, groupHead: 'ok' as const, steamWand: 'ok' as const, ...v.equipment },
  };
  return { ...bar, activeSteps: runningSteps(bar) };
}

/** The portafilter's and the pitcher's timed states, as the steps they are. */
const PORTAFILTER_STEP: Partial<Record<PortafilterState, StepId>> = {
  grinding: 'grind_beans',
  tamping: 'tamp',
  lockingIn: 'lock_in',
  pulling: 'extract',
  knocking: 'knock_out',
};
const PITCHER_STEP: Partial<Record<PitcherState, StepId>> = {
  steaming: 'steam_milk',
  foaming: 'foam_milk',
  pouring: 'pour_milk',
  dumping: 'dump_pitcher',
};

/**
 * What is running right now, read off the states: the portafilter's or the
 * pitcher's timed state, a machine being repaired, and a barista's hands on a
 * cup. Each takes as long as its state waits (at this speed).
 */
export function runningSteps(bar: Omit<Bar, 'activeSteps'>): RunningStep[] {
  const ms = (stepId: StepId) => stepMs(stepId) / (bar.speed || 1);
  const steps: RunningStep[] = [];
  const pf = PORTAFILTER_STEP[bar.portafilter];
  if (pf) {
    steps.push({
      stepId: pf,
      state: `portafilter.${bar.portafilter}`,
      resource: STEPS[pf].resource,
      cupId: pf === 'extract' ? (bar.shotCup ?? undefined) : undefined,
      ms: ms(pf),
    });
  }
  const pitcher = PITCHER_STEP[bar.pitcherState];
  if (pitcher) {
    steps.push({
      stepId: pitcher,
      state: `pitcher.${bar.pitcherState}`,
      resource: STEPS[pitcher].resource,
      cupId: pitcher === 'pour_milk' ? bar.pour?.cupId : undefined,
      ms: ms(pitcher),
    });
  }
  for (const device of DEVICES) {
    if (bar.equipment[device] === 'repairing') steps.push({ stepId: 'repair', state: `equipment.${device}.repairing`, resource: device, ms: ms('repair') });
  }
  // A barista's hands on a cup: the steps that are their hands alone.
  for (const who of ['jev', 'you'] as const) {
    const h = bar.hands[who];
    const stepId = h && stepOf(h.doing);
    if (h?.cupId && stepId && !steps.some((s) => s.stepId === stepId)) {
      steps.push({ stepId, state: `hands.${who}.busy`, cupId: h.cupId, ms: h.ms / (bar.speed || 1) });
    }
  }
  return steps;
}

/** Which devices are occupied right now (by a running step or by a fault), whoever started it. */
export function busyResources(ctx: Bar): Set<Device> {
  const busy = new Set<Device>();
  for (const a of ctx.activeSteps) if (a.resource) busy.add(a.resource);
  for (const d of DEVICES) if (ctx.equipment[d] !== 'ok') busy.add(d);
  return busy;
}

/** The barista's hands on `doing` for `ms` of hands-on time (at 1x), on a cup, an order or an ingredient. */
export function occupyHands(
  doing: BaristaAction,
  ms: number,
  on: { cupId?: string; drinkId?: string; ingredient?: Ingredient; device?: Device } = {},
): Hands {
  return { doing, ms, ...on };
}

/* ------------------------------------------------------ cups and orders --- */

/** The cup holds exactly what the order's recipe says, in order. */
export function isExactly(contents: Addition[], target: Addition[]): boolean {
  return contents.length === target.length && contents.every((a, i) => sameAddition(a, target[i]));
}

/**
 * The cup could still become this drink: what is in it is how the drink
 * starts, and what is left can still go in where the cup stands (a shot or
 * water only goes into a cup under the spouts, and a cup at the front stays there).
 */
export function onTrack(cup: Cup, target: Addition[]): boolean {
  if (cup.contents.length > target.length) return false;
  if (!cup.contents.every((a, i) => sameAddition(a, target[i]))) return false;
  const rest = target.slice(cup.contents.length);
  return cup.spot === 'tray' || !rest.some((a) => a.kind === 'shot' || a.kind === 'water');
}

/**
 * Which order each cup is on its way to becoming: cups in the order they were
 * put out, each to the longest-waiting open order it is on track for that no
 * earlier cup took. A cup belongs to no order until it is served; this is only
 * how the bar reads.
 */
export function assignCups(ctx: BarContext): Map<string, string> {
  const taken = new Set<string>();
  const out = new Map<string, string>();
  const open = openOrders(ctx);
  // A cup that already is some order's drink goes to that order first.
  const cups = [...ctx.cups].sort((a, b) => cupNo(a) - cupNo(b));
  for (const cup of cups) {
    const exact = open.find((d) => !taken.has(d.id) && isExactly(cup.contents, targetOf(d)));
    const order = exact ?? open.find((d) => !taken.has(d.id) && onTrack(cup, targetOf(d)));
    if (order) {
      taken.add(order.id);
      out.set(cup.id, order.id);
    }
  }
  return out;
}

function cupNo(cup: Cup): number {
  return Number(cup.id.slice(1)) || 0;
}

/** The cup on its way to being this order, if any. */
export function cupFor(ctx: BarContext, drinkId: string, assigned = assignCups(ctx)): Cup | undefined {
  for (const [cupId, id] of assigned) if (id === drinkId) return cupById(ctx, cupId);
  return undefined;
}

/**
 * Who gets a served cup: the longest-waiting order it is exactly, else the
 * order it was on its way to, else whoever has waited longest. Only an exact
 * match is what they ordered.
 */
export function serveTo(ctx: BarContext, cup: Cup): { drink: Drink; correct: boolean } | undefined {
  const open = openOrders(ctx);
  const exact = open.find((d) => isExactly(cup.contents, targetOf(d)));
  if (exact) return { drink: exact, correct: true };
  const onItsWay = assignCups(ctx).get(cup.id);
  const drink = open.find((d) => d.id === onItsWay) ?? open[0];
  return drink ? { drink, correct: false } : undefined;
}

/** How far along an order is: additions of its recipe already in its cup. */
export function progressOf(ctx: BarContext, drink: Drink, assigned = assignCups(ctx)): number {
  return cupFor(ctx, drink.id, assigned)?.contents.length ?? 0;
}

/** Does the pitcher hold enough of this milk with this texture, ready or on its way? */
function pitcherHas(ctx: Bar, a: Addition): boolean {
  const p = ctx.pitcher;
  return a.kind === 'milk' && !!p && p.milk === a.milk && p.texture === a.texture && p.ml >= a.ml;
}

/**
 * The ingredient an order still needs that the bar is out of, if any: beans for
 * a shot not yet in the portafilter, water, chocolate, or its milk (unless it is
 * already in the pitcher).
 */
export function shortOf(ctx: Bar, drink: Drink, assigned = assignCups(ctx)): Ingredient | null {
  const inv = ctx.inventory;
  const rest = targetOf(drink).slice(progressOf(ctx, drink, assigned));
  for (const a of rest) {
    if (a.kind === 'shot' && ['empty', 'spent', 'knocking'].includes(ctx.portafilter) && inv.beans < DOSE.beans) return 'beans';
    if (a.kind === 'water' && inv.water < DOSE.water) return 'water';
    if (a.kind === 'chocolate' && inv.chocolate < DOSE.chocolate) return 'chocolate';
    if (a.kind === 'milk' && !pitcherHas(ctx, a) && inv.milk[a.milk] < DOSE.milk) return a.milk;
  }
  return null;
}

/**
 * What stands in the way of an order's next step, as a fact: something it
 * needs is out, a machine it needs is down, or the spot its cup has to go to
 * is taken by a cup that is not an earlier order's (one that is, is just that
 * order's turn). `null` when nothing does (it may still be waiting
 * on a step in progress).
 */
export type Obstacle =
  | { kind: 'short'; ingredient: Ingredient }
  | { kind: 'broken'; device: Device }
  | { kind: 'spot'; spot: CupSpot; cups: Cup[] };

/**
 * Everything standing in the way of an order, most fundamental first: an
 * ingredient it still needs is out; a machine its remaining steps need is down
 * (the grinder, for a shot when the portafilter holds no grounds; the group
 * head, for the shot; the steam wand, for milk not yet in the pitcher); the
 * spot its cup has to go to next is full, with a cup that is nobody's or a
 * later order's.
 */
export function obstaclesOf(ctx: Bar, drink: Drink, assigned = assignCups(ctx)): Obstacle[] {
  const out: Obstacle[] = [];
  const short = shortOf(ctx, drink, assigned);
  if (short) out.push({ kind: 'short', ingredient: short });
  const cup = cupFor(ctx, drink.id, assigned);
  const rest = targetOf(drink).slice(cup?.contents.length ?? 0);
  const next = rest[0];
  if (!next) return out;
  const needed = new Set<Device>();
  if (rest.some((a) => a.kind === 'shot')) {
    if (['empty', 'spent', 'knocking'].includes(ctx.portafilter)) needed.add('grinder');
    needed.add('groupHead');
  }
  if (rest.some((a) => a.kind === 'milk' && !pitcherHas(ctx, a))) needed.add('steamWand');
  for (const device of needed) if (ctx.equipment[device] !== 'ok') out.push({ kind: 'broken', device });
  // Where its cup has to be next: a new cup where its first addition goes in, or, for the milk, the front.
  const needs: CupSpot | null = !cup
    ? rest.some((a) => a.kind === 'shot' || a.kind === 'water') ? 'tray' : 'front'
    : next.kind === 'milk' && cup.spot === 'tray' ? 'front' : null;
  if (needs && spotFull(ctx, needs)) {
    const open = openOrders(ctx);
    const ahead = new Set(open.slice(0, open.indexOf(drink)).map((d) => d.id));
    const inTheWay = cupsIn(ctx, needs).filter((c) => !ahead.has(assigned.get(c.id) ?? ''));
    if (inTheWay.length) out.push({ kind: 'spot', spot: needs, cups: inTheWay });
  }
  return out;
}

/** The most fundamental obstacle, if any. */
export function obstacleOf(ctx: Bar, drink: Drink, assigned = assignCups(ctx)): Obstacle | null {
  return obstaclesOf(ctx, drink, assigned)[0] ?? null;
}

/* ---------------------------------------------------------- what Jev sees --- */

const SPOT_NAME: Record<CupSpot, string> = { tray: 'the drip tray', front: 'the front of the counter' };
const DEVICE_NAME: Record<Device, string> = { grinder: 'grinder', groupHead: 'group head', steamWand: 'steam wand' };

/** An obstacle, as Jev reads it: the fact, not what to do about it. */
function obstacleText(ctx: Bar, o: Obstacle, assigned: Map<string, string>): string {
  if (o.kind === 'short') return `out of ${o.ingredient}`;
  if (o.kind === 'broken') return `the ${DEVICE_NAME[o.device]} is broken`;
  const cups = o.cups.map((c) => {
    const forOrder = ctx.drinks.find((d) => d.id === assigned.get(c.id));
    const holding = c.contents.length ? c.contents.map(additionLabel).join(' + ') : 'nothing';
    return `cup ${c.id} (${holding}), which ${
      forOrder ? `is on its way to ${forOrder.customerLabel}'s ${recipeFor(forOrder.drink).label}` : 'no open order could become'
    }`;
  });
  return `${SPOT_NAME[o.spot]} is full: ${cups.join('; ')}`;
}

function cupView(ctx: Bar, cup: Cup, assigned: Map<string, string>): CupView {
  const exact = openOrders(ctx).find((d) => isExactly(cup.contents, targetOf(d)));
  return {
    cupId: cup.id,
    spot: cup.spot,
    contents: cup.contents.map(additionLabel),
    onTrackFor: assigned.get(cup.id) ?? null,
    matches: exact?.id ?? null,
    busy: cupBusy(ctx, cup.id),
  };
}

/**
 * What an order needs next, by its recipe: a cup where its first addition
 * goes in, while it has none; then the first addition its cup does not have yet.
 */
function nextFor(ctx: Bar, drink: Drink, assigned: Map<string, string>): string | null {
  const cup = cupFor(ctx, drink.id, assigned);
  const target = targetOf(drink);
  if (!cup) return target.some((a) => a.kind === 'shot' || a.kind === 'water') ? 'a cup on the drip tray' : 'a cup at the front';
  const next = target[cup.contents.length];
  return next ? additionLabel(next) : null;
}

/**
 * The state Jev is asked to reason over. Compact, no functions, no ids it can't
 * use. The queue is longest waiting first. There is no time in it: the bar's
 * states say what is running, and a move's lookahead (which follows the
 * delays the move starts) says what it comes to once done.
 */
export function serializeBar(ctx: Bar): BarSnapshot {
  const assigned = assignCups(ctx);
  const hands = (h: Hands | null) =>
    h ? `${h.doing.replace('barista.', '')}${h.cupId ? ` (cup ${h.cupId})` : ''}${h.ingredient ? ` (${h.ingredient})` : ''}` : null;
  return {
    queue: openOrders(ctx).map((d) => ({
      drinkId: d.id,
      drink: d.drink,
      mods: d.mods,
      recipe: targetOf(d).map(additionLabel),
      cupId: cupFor(ctx, d.id, assigned)?.id ?? null,
      next: nextFor(ctx, d, assigned),
      blockedBy: obstaclesOf(ctx, d, assigned).map((o) => obstacleText(ctx, o, assigned)).join('; ') || null,
    })),
    cups: ctx.cups.map((c) => cupView(ctx, c, assigned)),
    portafilter: ctx.portafilter,
    pitcher: ctx.pitcher ? `${milkName(ctx.pitcher.milk)} (${ctx.pitcherState}), ${ctx.pitcher.ml}ml` : 'empty',
    activeSteps: ctx.activeSteps.map(({ stepId, cupId, resource }) => ({ stepId, cupId, resource })),
    equipment: ctx.equipment,
    inventory: ctx.inventory,
    yourHands: hands(ctx.hands.jev),
    otherBarista: hands(ctx.hands.you),
    wrongServed: ctx.drinks
      .filter((d) => d.served && !d.served.correct)
      .map((d) => `${d.customerLabel} ordered a ${recipeFor(d.drink).label}, got ${d.served!.contents.map(additionLabel).join(' + ') || 'an empty cup'}`),
    servedCount: ctx.drinks.filter((d) => d.status === 'served').length,
  };
}
