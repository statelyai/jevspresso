/** What the UI derives from the bar's state: where the hands are, what blocks an order, short labels, and what a click does. */
import { optionId } from '@xstate/jev';
import { assignCups, cupById, cupIn, cupsIn, freeSlot, isExactly, isOpen, MILK_TYPES, obstacleOf, onTrack, openOrders, serveTo } from './legal';
import { POURS, recipeFor, targetOf } from './recipes';
import type { ActiveStep, Addition, Bar, BarEvent, Barista, BaristaMove, BaristaAction, BaristaOption, Cup, Device, Drink, Ingredient, MilkTexture, MilkType } from './types';

/** Where the barista's hands are: on a machine, the portafilter, a cup, an order, or the pantry. */
export type HandsPart = Device | 'cup' | 'portafilter' | 'order' | 'pantry';

const ACTION: Record<BaristaAction, { label: string; part: HandsPart }> = {
  'barista.grindBeans': { label: 'Starting grinder', part: 'grinder' },
  'barista.tamp': { label: 'Tamping', part: 'portafilter' },
  'barista.lockIn': { label: 'Locking in', part: 'portafilter' },
  'barista.knockOut': { label: 'Knocking out', part: 'portafilter' },
  'barista.extract': { label: 'Starting shot', part: 'groupHead' },
  'barista.placeCup': { label: 'Placing cup', part: 'cup' },
  'barista.presentCup': { label: 'Bringing cup forward', part: 'cup' },
  'barista.returnCup': { label: 'Sliding cup back', part: 'cup' },
  'barista.putAwayCup': { label: 'Putting cup away', part: 'cup' },
  'barista.pourMilk': { label: 'Pouring milk', part: 'steamWand' },
  'barista.steamMilk': { label: 'Steaming', part: 'steamWand' },
  'barista.foamMilk': { label: 'Foaming', part: 'steamWand' },
  'barista.dumpPitcher': { label: 'Pouring milk away', part: 'steamWand' },
  'barista.addWater': { label: 'Adding water', part: 'cup' },
  'barista.addChocolate': { label: 'Adding chocolate', part: 'cup' },
  'barista.serve': { label: 'Serving', part: 'cup' },
  'barista.dumpCup': { label: 'Pouring cup away', part: 'cup' },
  'barista.substituteMilk': { label: 'Swapping milk', part: 'order' },
  'barista.decline': { label: 'Declining', part: 'order' },
  'barista.repair': { label: 'Repairing', part: 'grinder' },
  'barista.restock': { label: 'Restocking', part: 'pantry' },
};

export const INGREDIENT_LABEL: Record<Ingredient, string> = {
  beans: 'beans',
  water: 'water',
  chocolate: 'chocolate',
  whole: 'whole milk',
  oat: 'oat milk',
  almond: 'almond milk',
  soy: 'soy milk',
  half: 'half & half',
};

export const DEVICE_LABEL: Record<Device, string> = {
  grinder: 'Grinder',
  groupHead: 'Espresso',
  steamWand: 'Steam wand',
};

/** A device as the thing that breaks and gets repaired: the espresso machine, not "espresso". */
export const DEVICE_NOUN: Record<Device, string> = {
  grinder: 'grinder',
  groupHead: 'machine',
  steamWand: 'steam wand',
};

export interface HandsView {
  /** Whose hands: Jev's, or yours. */
  who: Barista;
  /** The action the hands are on. */
  doing: BaristaAction;
  part: HandsPart;
  label: string;
  /** The cup the hands are on, if any. */
  cupId?: string;
  /** The order the hands are working toward: the order itself, or the one their cup is on its way to. */
  drink?: Drink;
  /** The ingredient being restocked, when that is what the hands are on. */
  ingredient?: Ingredient;
  secondsLeft: number;
}

/**
 * The bar on screen (see `useOnScreen`): each running step with when the page
 * saw it start, when each barista's hands went on what they are doing, when
 * each order was served, and the page's clock. The machine itself holds no time.
 */
export interface ViewBar extends Bar {
  activeSteps: ActiveStep[];
  now: number;
  handsSince: Record<Barista, number | null>;
  servedAt: Record<string, number>;
}

/** One barista's hands, from the bar, which tracks each pair like any resource. */
export function handsView(ctx: ViewBar, who: Barista): HandsView | null {
  const hands = ctx.hands[who];
  if (!hands) return null;
  const { label, part } = ACTION[hands.doing];
  const { cupId, drinkId, ingredient, device } = hands;
  const secondsLeft = Math.max(0, ((ctx.handsSince[who] ?? ctx.now) + hands.ms / (ctx.speed || 1) - ctx.now) / 1000);
  const base = { who, doing: hands.doing, secondsLeft };
  if (ingredient) return { ...base, part, label: `Restocking ${INGREDIENT_LABEL[ingredient]}`, ingredient };
  if (device) return { ...base, part: device, label: `Repairing ${DEVICE_NOUN[device]}` };
  const forOrder = drinkId ?? (cupId ? assignCups(ctx).get(cupId) : undefined);
  return { ...base, part, label, cupId, drink: ctx.drinks.find((d) => d.id === forOrder) };
}

/** Both baristas' hands that are busy: Jev's first. */
export function allHands(ctx: ViewBar): HandsView[] {
  return (['jev', 'you'] as const).flatMap((who) => handsView(ctx, who) ?? []);
}

/** Why an open order can't move on, or `null` if it can: something it needs is out, a machine is down, or its spot is taken. */
export function blockedBy(drink: Drink, ctx: Bar): string | null {
  if (!isOpen(drink)) return null;
  const o = obstacleOf(ctx, drink);
  if (!o) return null;
  if (o.kind === 'short') return `Out of ${INGREDIENT_LABEL[o.ingredient]}`;
  if (o.kind === 'broken') return `${capitalize(DEVICE_NOUN[o.device])} ${ctx.equipment[o.device]}`;
  return o.spot === 'tray' ? 'Tray taken' : 'Front taken';
}

/** A served drink's cup, across resets that reuse ids. */
export function cupToken(drink: Drink): string {
  return `${drink.served?.cupId ?? drink.id}@${drink.orderedAt}`;
}

/** "#3" for a drink id. */
export function drinkTag(drinkId: string, drinks: Drink[]): string {
  return drinks.find((d) => d.id === drinkId)?.customerLabel.replace(/ .*/, '') ?? '';
}

/** "cup 2" for cup id c2. */
export function cupName(cupId: string): string {
  return `cup ${cupId.slice(1)}`;
}

const VERB: Record<BaristaAction, string> = {
  'barista.grindBeans': 'Grind',
  'barista.tamp': 'Tamp',
  'barista.lockIn': 'Lock in',
  'barista.knockOut': 'Knock out',
  'barista.extract': 'Pull shot',
  'barista.placeCup': 'Place cup',
  'barista.presentCup': 'Bring forward',
  'barista.returnCup': 'Slide back',
  'barista.putAwayCup': 'Put away',
  'barista.pourMilk': 'Pour milk',
  'barista.steamMilk': 'Steam',
  'barista.foamMilk': 'Foam milk',
  'barista.dumpPitcher': 'Pour milk away',
  'barista.addWater': 'Add hot water',
  'barista.addChocolate': 'Add chocolate',
  'barista.serve': 'Serve',
  'barista.dumpCup': 'Pour away',
  'barista.substituteMilk': 'Swap milk',
  'barista.decline': 'Decline',
  'barista.repair': 'Repair',
  'barista.restock': 'Restock',
};

/** A short label for an event: "Tamp", "Serve · cup 2", "Steam oat", "Repair grinder". */
export function eventLabel(e: BarEvent | BaristaMove, drinks: Drink[]): string {
  switch (e.type) {
    case 'barista.repair':
      return `Repair ${DEVICE_NOUN[e.device]}`;
    case 'barista.restock':
      return `Restock ${INGREDIENT_LABEL[e.ingredient]}`;
    case 'barista.substituteMilk':
      return `Swap to ${e.milk} · ${drinkTag(e.drinkId, drinks)}`;
    case 'barista.decline':
      return `Decline · ${drinkTag(e.drinkId, drinks)}`;
    case 'barista.steamMilk':
    case 'barista.foamMilk':
      return `${e.type === 'barista.foamMilk' ? 'Foam' : 'Steam'} ${e.milk === 'half' ? 'half & half' : e.milk}`;
    case 'barista.placeCup':
      return `Place cup · ${e.spot === 'tray' ? 'tray' : 'front'}`;
    case 'barista.pourMilk':
      return `Pour ${e.ml}ml · ${cupName(e.cupId)}`;
    default:
      if (!e.type.startsWith('barista.')) return e.type;
      return 'cupId' in e ? `${VERB[e.type as BaristaAction]} · ${cupName(e.cupId)}` : VERB[e.type as BaristaAction];
  }
}

/** A short label for an option: "Tamp", "Serve · cup 2", "Wait". */
export function optionLabel(option: BaristaOption, drinks: Drink[]): string {
  return option.kind === 'noop' ? 'Wait' : eventLabel(option.event, drinks);
}

export function drinkName(drink: Drink): string {
  const label = recipeFor(drink.drink).label;
  return label[0].toUpperCase() + label.slice(1);
}

function capitalize(s: string): string {
  return s[0].toUpperCase() + s.slice(1);
}

/* ------------------------------------------------------ working the bar --- */

/** The places on the bar a person can click. */
/** A place for a cup on the counter at the front, 0 nearest the jug. */
export type FrontSpot = 'front0' | 'front1' | 'front2';
export const FRONT_SPOTS: FrontSpot[] = ['front0', 'front1', 'front2'];

export type BarSpot = 'grinder' | 'portafilter' | 'brew' | 'steam' | 'jug' | 'tray' | FrontSpot | 'water' | 'chocolate';

/**
 * One thing a click can do: the event, and how it reads. What it comes to (a
 * wasted shot, a wrong drink) is not said: finding out is half the fun.
 */
export interface ClickAction {
  event: BaristaMove;
  /** "Pour milk · #3 Cappuccino". */
  label: string;
  /** A variant of the main action, told apart by one word ("oat"): drawn small. */
  short?: boolean;
}

/** What a spot does: its main action on a click, the others it offers, or why it does nothing. */
export interface SpotAction {
  event: BaristaMove | null;
  /** The main action's label, or why nothing happens ("Hands busy"); empty when there is only breaking it. */
  label: string;
  others: ClickAction[];
  /**
   * The machine here, when it is working: you (and only you, since `BREAK` is
   * no barista's move) can break it.
   */
  breaks?: Device;
}

const SPOT_DEVICE: Partial<Record<BarSpot, Device>> = {
  grinder: 'grinder',
  brew: 'groupHead',
  steam: 'steamWand',
  jug: 'steamWand',
};

/** " · #3 Cappuccino". */
function forOrder(d: Drink | undefined, drinks: Drink[]): string {
  return d ? ` · ${drinkTag(d.id, drinks)} ${drinkName(d)}` : '';
}

/** What a cup would be to the orders with `a` added: its order, if any. */
function pouring(ctx: Bar, cup: Cup, a: Addition): { tag: string } {
  const after = { ...cup, contents: [...cup.contents, a] };
  const open = openOrders(ctx);
  const d = open.find((o) => isExactly(after.contents, targetOf(o))) ?? open.find((o) => onTrack(after, targetOf(o)));
  return { tag: forOrder(d, ctx.drinks) };
}

/** How one event reads, as a click on the bar. */
function clickAction(ctx: Bar, event: BaristaMove): ClickAction {
  const verb = eventLabel(event, ctx.drinks).split(' · ')[0];
  const cup = 'cupId' in event ? cupById(ctx, event.cupId) : undefined;
  switch (event.type) {
    // On the cup's own action bar, the cup goes without saying.
    case 'barista.dumpCup':
    case 'barista.putAwayCup':
    case 'barista.returnCup':
      return { event, label: verb };
    case 'barista.repair':
    case 'barista.placeCup':
    case 'barista.dumpPitcher':
    case 'barista.grindBeans':
    case 'barista.tamp':
    case 'barista.lockIn':
      return { event, label: event.type === 'barista.placeCup' ? 'Place cup' : eventLabel(event, ctx.drinks) };
    case 'barista.knockOut':
      return { event, label: verb };
    case 'barista.extract': {
      const under = cupIn(ctx, 'tray');
      if (!under) return { event, label: verb };
      const p = pouring(ctx, under, { kind: 'shot' });
      return { event, label: `${verb}${p.tag}` };
    }
    case 'barista.steamMilk':
    case 'barista.foamMilk': {
      const texture = event.type === 'barista.foamMilk' ? 'foamed' : 'steamed';
      const wants = openOrders(ctx).find((d) => targetOf(d).some((a) => a.kind === 'milk' && a.milk === event.milk && a.texture === texture));
      return { event, label: `${eventLabel(event, ctx.drinks)}${wants ? ` · ${drinkTag(wants.id, ctx.drinks)}` : ''}` };
    }
    case 'barista.serve': {
      const to = cup && serveTo(ctx, cup);
      return { event, label: `${verb}${forOrder(to?.drink, ctx.drinks)}` };
    }
    case 'barista.pourMilk': {
      const a: Addition | undefined = ctx.pitcher ? { kind: 'milk', ...ctx.pitcher, ml: event.ml } : undefined;
      const p = cup && a ? pouring(ctx, cup, a) : { tag: '' };
      return { event, label: `Pour ${event.ml}ml${p.tag}` };
    }
    case 'barista.addWater':
    case 'barista.addChocolate': {
      const p = cup ? pouring(ctx, cup, { kind: event.type === 'barista.addWater' ? 'water' : 'chocolate' }) : { tag: '' };
      return { event, label: `${verb}${p.tag}` };
    }
    case 'barista.presentCup': {
      const d = cup ? ctx.drinks.find((o) => o.id === assignCups(ctx).get(cup.id)) : undefined;
      return { event, label: `${verb}${forOrder(d, ctx.drinks)}` };
    }
    default:
      return { event, label: eventLabel(event, ctx.drinks) };
  }
}

/**
 * The click a cup asks for, to be the button's default: serve it when it is an
 * order exactly, else the next thing its order's recipe puts in, else pour it
 * away (or put it away, empty) when it is nobody's.
 */
function cupNext(ctx: Bar, cup: Cup, assigned: Map<string, string>): BaristaMove | undefined {
  const on = { cupId: cup.id };
  if (openOrders(ctx).some((d) => isExactly(cup.contents, targetOf(d)))) return { type: 'barista.serve', ...on };
  const order = ctx.drinks.find((d) => d.id === assigned.get(cup.id));
  if (!order) return cup.contents.length ? { type: 'barista.dumpCup', ...on } : { type: 'barista.putAwayCup', ...on };
  switch (targetOf(order)[cup.contents.length]?.kind) {
    case 'water':
      return { type: 'barista.addWater', ...on };
    case 'chocolate':
      return { type: 'barista.addChocolate', ...on };
    case 'milk': {
      const milk = targetOf(order)[cup.contents.length];
      return cup.spot === 'tray'
        ? { type: 'barista.presentCup', ...on }
        : { type: 'barista.pourMilk', ...on, ml: milk.kind === 'milk' ? milk.ml : 180 };
    }
    default:
      return undefined;
  }
}

/**
 * Everything physically possible at a spot, as clicks: the same events Jev picks
 * from, checked the same way (`can`). A click does what a cup there needs next
 * for its order (see `cupNext`), else the first possible; the rest are offered
 * beside it. Milk is steamed for the `selected` order first.
 */
export function spotAction(
  spot: BarSpot,
  ctx: Bar,
  can: (move: BaristaMove) => boolean,
  selected?: string | null,
): SpotAction {
  const device = SPOT_DEVICE[spot];
  const breaks = device && ctx.equipment[device] === 'ok' ? device : undefined;
  const repair: BaristaMove[] = device && ctx.equipment[device] === 'broken' ? [{ type: 'barista.repair', device }] : [];
  const tray = cupIn(ctx, 'tray');
  const fronts = cupsIn(ctx, 'front');
  // A place at the front: the cup there, or, the first free place, a new cup.
  const frontAt = (slot: number): BaristaMove[] => {
    const cup = fronts.find((c) => c.slot === slot);
    if (cup) return cupActions(cup);
    return slot === freeSlot(ctx) ? [{ type: 'barista.placeCup', spot: 'front' }] : [];
  };
  const on = <T extends BaristaMove['type']>(type: T, cup: Cup | undefined) => (cup ? [{ type, cupId: cup.id } as BaristaMove] : []);
  // Every amount a pour can be, into a cup at the front.
  const pours = (cup: Cup): BaristaMove[] => POURS.map((ml) => ({ type: 'barista.pourMilk', cupId: cup.id, ml }));
  // Milk for the selected order first, then for every open order that has
  // milk, steamed or foamed as it wants; then any milk, either way.
  const orders = [...openOrders(ctx).filter((d) => d.id === selected), ...openOrders(ctx).filter((d) => d.id !== selected)];
  const wanted = orders.flatMap((d) => targetOf(d).flatMap((a) => (a.kind === 'milk' ? [a] : [])));
  const make = (texture: MilkTexture, milk: Exclude<MilkType, 'none'>) =>
    ({ type: texture === 'foamed' ? 'barista.foamMilk' : 'barista.steamMilk', milk }) as BaristaMove;
  const milks: BaristaMove[] = [
    ...wanted.map((a) => make(a.texture, a.milk)),
    ...MILK_TYPES.map((m) => make('steamed', m)),
    ...MILK_TYPES.map((m) => make('foamed', m)),
  ];
  const cupActions = (cup: Cup): BaristaMove[] => [
    ...on('barista.serve', cup),
    ...(cup.spot === 'tray' ? on('barista.presentCup', cup) : [...pours(cup), ...on('barista.returnCup', cup)]),
    ...(cup.spot === 'tray' ? on('barista.addWater', cup) : []),
    ...on('barista.addChocolate', cup),
    ...on('barista.putAwayCup', cup),
    ...on('barista.dumpCup', cup),
  ];
  // Locked in a broken group head, or under a broken grinder, the portafilter is a way in to repairing it.
  const pfRepair: BaristaMove[] =
    ctx.equipment.groupHead === 'broken' && ['empty', 'locked', 'spent'].includes(ctx.portafilter)
      ? [{ type: 'barista.repair', device: 'groupHead' }]
      : ctx.equipment.grinder === 'broken' && ['grounds', 'tamped'].includes(ctx.portafilter)
        ? [{ type: 'barista.repair', device: 'grinder' }]
        : [];

  const candidates: BaristaMove[] = {
    grinder: [...repair, { type: 'barista.grindBeans' } as BaristaMove],
    portafilter: [
      { type: 'barista.grindBeans' },
      { type: 'barista.tamp' },
      { type: 'barista.lockIn' },
      { type: 'barista.extract' },
      { type: 'barista.knockOut' },
      ...pfRepair,
    ] as BaristaMove[],
    brew: [...repair, { type: 'barista.extract' }, { type: 'barista.lockIn' }] as BaristaMove[],
    steam: [...repair, ...milks, { type: 'barista.dumpPitcher' } as BaristaMove],
    jug: [...repair, ...fronts.flatMap(pours), ...milks, { type: 'barista.dumpPitcher' } as BaristaMove],
    tray: tray ? cupActions(tray) : [{ type: 'barista.placeCup', spot: 'tray' } as BaristaMove],
    front0: frontAt(0),
    front1: frontAt(1),
    front2: frontAt(2),
    water: on('barista.addWater', tray),
    chocolate: [...on('barista.addChocolate', tray), ...fronts.flatMap((c) => on('barista.addChocolate', c))],
  }[spot];

  const seen = new Set<string>();
  const possible = candidates.filter((e) => {
    const id = optionId(e);
    if (seen.has(id) || !can(e)) return false;
    seen.add(id);
    return true;
  });
  const assigned = assignCups(ctx);
  const next = new Set(ctx.cups.flatMap((c) => cupNext(ctx, c, assigned) ?? []).map(optionId));
  const main = possible.find((e) => next.has(optionId(e))) ?? possible[0];
  if (!main) {
    const reason = ctx.hands.you
      ? 'Hands busy'
      : device && ctx.equipment[device] !== 'ok'
        ? `${capitalize(DEVICE_NOUN[device])} ${ctx.equipment[device]}`
        : // Nothing to do here, but break it: then that is all there is to say.
          breaks
          ? ''
          : 'Nothing to do';
    return { event: null, label: reason, others: [], breaks };
  }
  const primary = clickAction(ctx, main);
  // A move like one already offered is one word: another milk steamed (or
  // foamed) the same way, or another amount poured into the same cup.
  const others = possible.filter((e) => e !== main);
  const like = (a: BaristaMove, b: BaristaMove) =>
    a.type === b.type && (a.type !== 'barista.pourMilk' || (b.type === 'barista.pourMilk' && a.cupId === b.cupId));
  const variant = (e: BaristaMove, i: number): ClickAction => {
    if (![main, ...others.slice(0, i)].some((x) => like(x, e))) return clickAction(ctx, e);
    if (e.type === 'barista.steamMilk' || e.type === 'barista.foamMilk') {
      return { ...clickAction(ctx, e), label: e.milk === 'half' ? 'half & half' : e.milk, short: true };
    }
    if (e.type === 'barista.pourMilk') return { ...clickAction(ctx, e), label: `${e.ml}ml`, short: true };
    return clickAction(ctx, e);
  };
  return { ...primary, others: others.map(variant), breaks };
}
