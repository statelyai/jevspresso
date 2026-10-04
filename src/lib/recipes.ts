import type { Addition, CupLayer, Device, Drink, DrinkId, Inventory, MilkTexture, MilkType, PourMl, Recipe, StepId } from './types';

/**
 * Recipes are data: what a customer's cup should hold, in order. They are not
 * rules. The bar lets anything physically possible happen (see
 * `machines/espressoBar.ts`): a shot without a cup, water in a latte, the
 * wrong milk. A served cup goes to the order it matches and is checked against
 * that order's recipe.
 *
 * Durations are "demo time" — a real 25s extraction runs in 5s at 1x.
 */
export const RECIPES: Record<DrinkId, Recipe> = {
  espresso: { id: 'espresso', label: 'espresso', usesMilk: false, additions: ['shot'] },
  americano: { id: 'americano', label: 'americano', usesMilk: false, additions: ['shot', 'water'] },
  latte: { id: 'latte', label: 'latte', usesMilk: true, additions: ['shot', 'milk'], milk: { texture: 'steamed', ml: 180 } },
  cappuccino: { id: 'cappuccino', label: 'cappuccino', usesMilk: true, additions: ['shot', 'milk'], milk: { texture: 'foamed', ml: 180 } },
  flat_white: { id: 'flat_white', label: 'flat white', usesMilk: true, additions: ['shot', 'milk'], milk: { texture: 'steamed', ml: 120 } },
  cortado: { id: 'cortado', label: 'cortado', usesMilk: true, additions: ['shot', 'milk'], milk: { texture: 'steamed', ml: 60 } },
  // The shot goes onto the chocolate.
  mocha: { id: 'mocha', label: 'mocha', usesMilk: true, additions: ['chocolate', 'shot', 'milk'], milk: { texture: 'steamed', ml: 180 } },
  // An espresso "marked" with a dab of milk foam.
  macchiato: { id: 'macchiato', label: 'macchiato', usesMilk: true, additions: ['shot', 'milk'], milk: { texture: 'foamed', ml: 30 } },
  // Espresso with steamed half-and-half instead of milk.
  cafe_breve: { id: 'cafe_breve', label: 'café breve', usesMilk: true, defaultMilk: 'half', additions: ['shot', 'milk'], milk: { texture: 'steamed', ml: 180 } },
  hot_chocolate: { id: 'hot_chocolate', label: 'hot chocolate', usesMilk: true, additions: ['chocolate', 'milk'], milk: { texture: 'steamed', ml: 180 } },
};

export const DRINK_IDS = Object.keys(RECIPES) as DrinkId[];

/** What each ingredient costs when it goes in: milk is taken from stock when it is steamed, a jug (`milk` ml) at a time. */
export const DOSE = { beans: 18, water: 120, chocolate: 20, milk: 240 } as const;

/** How much a pour of milk can be, in ml. */
export const POURS: PourMl[] = [30, 60, 120, 180];

/**
 * How milk stands, by texture: the height of milk and of foam per ml (band
 * heights in the cup glyph, and in the jug's cutaway). Foam is mostly air.
 */
export const TEXTURE: Record<MilkTexture, { milk: number; foam: number }> = {
  steamed: { milk: 0.18, foam: 0.03 },
  foamed: { milk: 0.09, foam: 0.13 },
};

/**
 * Every timed thing the barista does, by what it is, not by drink: hands-on
 * time (ms at 1x, never zero), then time the equipment runs on its own, and
 * the equipment it holds meanwhile.
 */
export const STEPS: Record<StepId, { label: string; handsOn: number; unattended?: number; resource?: Device }> = {
  grind_beans: { label: `grind ${DOSE.beans}g into the portafilter`, handsOn: 500, unattended: 2000, resource: 'grinder' },
  tamp: { label: 'distribute and tamp the grounds', handsOn: 1200 },
  lock_in: { label: 'purge the group and lock in the portafilter', handsOn: 800, resource: 'groupHead' },
  // Pressing the button is quick; the shot then pulls on its own, into whatever cup is under the spouts.
  extract: { label: 'pull the shot', handsOn: 300, unattended: 5000, resource: 'groupHead' },
  knock_out: { label: 'knock the portafilter out', handsOn: 1200 },
  place_cup: { label: 'put out a cup', handsOn: 600 },
  present_cup: { label: 'bring the cup to the front', handsOn: 600 },
  return_cup: { label: 'slide the cup back onto the drip tray', handsOn: 600 },
  put_away_cup: { label: 'put the empty cup back on the shelf', handsOn: 500 },
  // Attended: the barista holds the pitcher for the whole steam.
  steam_milk: { label: 'steam milk', handsOn: 4000, resource: 'steamWand' },
  // Steamed with the tip at the surface, drawing air in: longer, and it doubles into foam.
  foam_milk: { label: 'foam milk', handsOn: 5000, resource: 'steamWand' },
  pour_milk: { label: 'pour milk into the cup', handsOn: 1500 },
  add_water: { label: `add ${DOSE.water}ml hot water`, handsOn: 1500 },
  add_chocolate: { label: 'add chocolate', handsOn: 1500 },
  serve: { label: 'hand the cup over', handsOn: 1000 },
  dump_cup: { label: 'pour the cup away', handsOn: 800 },
  dump_pitcher: { label: 'pour the milk away', handsOn: 800 },
  // The machine being repaired is the step's resource, set when it starts.
  repair: { label: 'repair a machine', handsOn: 8000 },
};

/** How long a step runs, all told (ms at 1x): hands-on, then on its own. */
export function stepMs(stepId: StepId): number {
  return STEPS[stepId].handsOn + (STEPS[stepId].unattended ?? 0);
}

/** The step a barista action is, when it is one (`barista.addWater` is `add_water`). */
export function stepOf(action: string): StepId | undefined {
  const id = action.replace(/^barista\./, '').replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
  return id in STEPS ? (id as StepId) : undefined;
}

/** Cup layer colours: one per ingredient. */
export const LAYER_COLORS = {
  espresso: '#a3642f',
  chocolate: '#6e3d23',
  milk: '#eadbc0',
  foam: '#fdfaf3',
  water: '#9fd3e6',
} as const;

/** The bands an addition puts in a cup, bottom to top. */
export function layersOf(addition: Addition): CupLayer[] {
  const L = LAYER_COLORS;
  switch (addition.kind) {
    case 'shot':
      return [{ color: L.espresso, h: 20 }];
    case 'water':
      return [{ color: L.water, h: 28 }];
    case 'chocolate':
      return [{ color: L.chocolate, h: 14 }];
    case 'milk': {
      const s = TEXTURE[addition.texture];
      return [
        { color: L.milk, h: s.milk * addition.ml },
        { color: L.foam, h: s.foam * addition.ml },
      ];
    }
  }
}

/** What an order's cup should hold, in order, with its milk. */
export function targetOf(drink: Pick<Drink, 'drink' | 'mods'>): Addition[] {
  return recipeFor(drink.drink).additions.map((kind) =>
    kind === 'milk'
      ? {
          kind,
          milk: (drink.mods.milk === 'none' ? 'whole' : drink.mods.milk) as Exclude<MilkType, 'none'>,
          ...(recipeFor(drink.drink).milk ?? { texture: 'steamed', ml: 180 }),
        }
      : { kind },
  );
}

/** Two additions are the same thing: the same kind, and for milk the same milk, texture and amount. */
export function sameAddition(a: Addition, b: Addition): boolean {
  if (a.kind !== b.kind) return false;
  return a.kind !== 'milk' || (b.kind === 'milk' && a.milk === b.milk && a.texture === b.texture && a.ml === b.ml);
}

/** "whole milk", "half & half". */
export function milkName(milk: Exclude<MilkType, 'none'>): string {
  return milk === 'half' ? 'half & half' : `${milk} milk`;
}

/** "espresso", "180ml oat milk, foamed". */
export function additionLabel(a: Addition): string {
  switch (a.kind) {
    case 'shot':
      return 'espresso';
    case 'water':
      return 'hot water';
    case 'chocolate':
      return 'chocolate';
    case 'milk':
      return `${a.ml}ml ${milkName(a.milk)}, ${a.texture}`;
  }
}

/** Human-readable synonyms, used by the mock parser and by Jev's criteria. */
export const DRINK_ALIASES: Record<DrinkId, string[]> = {
  espresso: ['espresso', 'shot', 'doppio', 'ristretto'],
  americano: ['americano', 'long black'],
  latte: ['latte', 'caffe latte'],
  cappuccino: ['cappuccino', 'cap', 'cappa'],
  flat_white: ['flat white', 'flatwhite'],
  cortado: ['cortado', 'gibraltar'],
  mocha: ['mocha', 'mochaccino'],
  hot_chocolate: ['hot chocolate', 'cocoa', 'hot cocoa'],
  macchiato: ['macchiato', 'espresso macchiato', 'caffe macchiato'],
  cafe_breve: ['breve', 'cafe breve', 'caffe breve'],
};

export const INITIAL_INVENTORY: Inventory = {
  beans: 400,
  water: 2000,
  chocolate: 150,
  milk: { whole: 1200, oat: 900, almond: 400, soy: 600, half: 500 },
};

export function recipeFor(drink: DrinkId): Recipe {
  return RECIPES[drink];
}

/**
 * Recipe steps and machine events are the same vocabulary in two cases: step
 * `grind_beans` is driven by the `barista.grindBeans` event. This is the single
 * mapping between the two.
 */
export function stepEvent(stepId: StepId): `barista.${string}` {
  return `barista.${stepId.replace(/_(\w)/g, (_, c: string) => c.toUpperCase())}`;
}

/**
 * Hands-on time (ms at 1x) of the barista actions that are not timed steps.
 * The repair matches the equipment region's `repairTime`.
 */
export const HANDS_ON_MS = {
  'barista.repair': 8000,
  'barista.substituteMilk': 1000,
  'barista.decline': 1500,
  'barista.restock': 3000,
} as const;
