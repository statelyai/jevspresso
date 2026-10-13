/**
 * A day at the bar, from a seed: who orders what and when, and what breaks
 * or runs out when. The same seed is the same day, whichever model runs the
 * bar, so two runs can be compared. Every order is made from a known drink
 * and worded one of several ways, so whether it was read right is known too.
 * Times are bar time from the start of the day: at 10× they pass 10× faster.
 */
import { DEVICES, INGREDIENTS } from './legal';
import { seeded } from './random';
import { recipeFor } from './recipes';
import type { Device, DrinkId, Ingredient, MilkType, ParsedOrder, Size } from './types';

export interface DayItem {
  drink: DrinkId;
  qty: number;
  /** Only when the customer says it. */
  milk?: MilkType;
  /** Only when the customer says it. */
  size?: Size;
}

export interface DayOrder {
  id: string;
  /** What the customer says. */
  text: string;
  /** What they mean. */
  items: DayItem[];
}

export type DayEvent =
  | { at: number; type: 'order'; order: DayOrder }
  | { at: number; type: 'break'; device: Device }
  | { at: number; type: 'runOut'; ingredient: Ingredient };

export const DAY = {
  orders: 12,
  /** The first customer comes in at once; the last by then. */
  lastOrderAt: 150_000,
  breaks: 4,
  runOuts: 3,
};

/** What customers call each drink. */
const NAMES: Record<DrinkId, string[]> = {
  espresso: ['espresso'],
  americano: ['americano', 'long black'],
  latte: ['latte'],
  cappuccino: ['cappuccino', 'cap'],
  flat_white: ['flat white'],
  cortado: ['cortado'],
  mocha: ['mocha'],
  hot_chocolate: ['hot chocolate', 'hot cocoa'],
  macchiato: ['macchiato'],
  cafe_breve: ['café breve', 'breve'],
};
const DRINKS = Object.keys(NAMES) as DrinkId[];
const MILKS: Exclude<MilkType, 'none' | 'half'>[] = ['oat', 'almond', 'soy', 'whole'];
const TEMPLATES = ['{list}', 'can I get {list}', '{list} please', "I'll have {list}", 'could I grab {list}?', 'hi! {list}, thanks'];

export function generateDay(seed: number): DayEvent[] {
  const roll = seeded(seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(roll() * xs.length)];
  const chance = (p: number) => roll() < p;

  const item = (drink: DrinkId): { item: DayItem; words: string } => {
    const recipe = recipeFor(drink);
    const qty = chance(0.15) ? 2 : 1;
    // Café breve is made with half & half: nobody names a milk for it.
    const milk = recipe.usesMilk && drink !== 'cafe_breve' && chance(0.5) ? pick(MILKS) : undefined;
    const size: Size | undefined = chance(0.25) ? pick(['small', 'large'] as const) : undefined;
    const name = pick(NAMES[drink]) + (qty > 1 ? 's' : '');
    const words = milk
      ? chance(0.5)
        ? [size, milk === 'whole' ? 'whole milk' : milk, name]
        : [size, name, `with ${milk} milk`]
      : [size, name];
    const phrase = words.filter(Boolean).join(' ');
    const count = qty > 1 ? 'two' : /^[aeiou]/.test(phrase) ? 'an' : 'a';
    return { item: { drink, qty, ...(milk ? { milk } : {}), ...(size ? { size } : {}) }, words: `${count} ${phrase}` };
  };

  const said = new Set<string>();
  const order = (n: number): DayOrder => {
    // A few tries for wording nobody else used today: each order is told apart by what was said.
    for (let tries = 0; ; tries++) {
      const first = pick(DRINKS);
      const second = chance(0.3) ? pick(DRINKS.filter((d) => d !== first)) : null;
      const parts = [item(first), ...(second ? [item(second)] : [])];
      const text = pick(TEMPLATES).replace('{list}', parts.map((p) => p.words).join(' and '));
      if (!said.has(text) || tries >= 5) {
        said.add(text);
        return { id: `o${n}`, text, items: parts.map((p) => p.item) };
      }
    }
  };

  // Customers: the first at once, then spread out, each gap its own length.
  const gaps = Array.from({ length: DAY.orders - 1 }, () => 0.3 + roll());
  const total = gaps.reduce((a, b) => a + b, 0);
  let at = 2000;
  const events: DayEvent[] = [];
  for (let n = 1; n <= DAY.orders; n++) {
    events.push({ at: Math.round(at), type: 'order', order: order(n) });
    at += (gaps[n - 1] / total) * (DAY.lastOrderAt - 2000);
  }
  for (let i = 0; i < DAY.breaks; i++) events.push({ at: Math.round(15_000 + roll() * 150_000), type: 'break', device: pick(DEVICES) });
  for (let i = 0; i < DAY.runOuts; i++) events.push({ at: Math.round(20_000 + roll() * 150_000), type: 'runOut', ingredient: pick(INGREDIENTS) });
  return events.sort((a, b) => a.at - b.at);
}

/** An item as the bar would make it: unsaid milk and size filled in. */
function made(item: { drink: DrinkId; qty: number; milk?: MilkType; size?: Size }): string {
  const recipe = recipeFor(item.drink);
  const milk = recipe.usesMilk ? (item.milk && item.milk !== 'none' ? item.milk : (recipe.defaultMilk ?? 'whole')) : 'none';
  return `${item.qty}× ${item.drink} ${milk} ${item.size ?? 'regular'}`;
}

/** Was the order read right: the same drinks, as the bar would make them? */
export function readRight(parsed: Pick<ParsedOrder, 'intent' | 'items'>, order: DayOrder): boolean {
  const key = (items: DayItem[]) => items.map(made).sort().join(' + ');
  return parsed.intent === 'order' && key(parsed.items) === key(order.items);
}
