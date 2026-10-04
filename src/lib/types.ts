/** Domain types shared by the machine, the Jev wrapper and the UI. */
import type { JevDecision, JevOption } from '@xstate/jev';


export type Device = 'grinder' | 'groupHead' | 'steamWand';
/**
 * Where a cup stands while it is made: on the drip tray (under the spouts and
 * the hot water), one cup; or on the counter at the front, where milk is
 * poured, room for a few (`FRONT_SLOTS`).
 */
export type CupSpot = 'tray' | 'front';
export type DeviceStatus = 'ok' | 'broken' | 'repairing';

/** `half` is half-and-half: what a café breve is made with. */
export type MilkType = 'whole' | 'oat' | 'almond' | 'soy' | 'half' | 'none';
/** Everything the barista can run out of, and restock. */
export type Ingredient = 'beans' | 'water' | 'chocolate' | Exclude<MilkType, 'none'>;
export type Size = 'small' | 'regular' | 'large';

export type DrinkId =
  | 'espresso'
  | 'americano'
  | 'latte'
  | 'cappuccino'
  | 'flat_white'
  | 'cortado'
  | 'mocha'
  | 'hot_chocolate'
  | 'macchiato'
  | 'cafe_breve';

/**
 * How milk comes off the steam wand: `steamed` (hot, silky, a thin layer of
 * microfoam: a latte's), or `foamed` (steamed with air drawn in, into a thick
 * cap of foam: a cappuccino's). Which it is, is decided when it is steamed.
 */
export type MilkTexture = 'steamed' | 'foamed';

/** How much milk a pour puts in a cup, in ml: a macchiato's dab of foam up to a latte's worth. */
export type PourMl = 30 | 60 | 120 | 180;

/**
 * What can go into a cup: a shot, hot water, chocolate, or a pour of milk off
 * the steam wand, with its type, texture and amount.
 */
export type Addition =
  | { kind: 'shot' }
  | { kind: 'water' }
  | { kind: 'chocolate' }
  | { kind: 'milk'; milk: Exclude<MilkType, 'none'>; texture: MilkTexture; ml: PourMl };

/** A cup on the bar: where it stands and what has gone into it, in order. It belongs to no order until it is served. */
export interface Cup {
  id: string;
  spot: CupSpot;
  /** Which place on the counter, at the front (0 nearest the jug). */
  slot?: number;
  contents: Addition[];
}

/** The one portafilter, from empty through a shot and back: `spent` holds the puck. */
/**
 * The one portafilter's state: a region of the bar machine. Resting states
 * hold what is in it; the `-ing` states are timed steps in progress on it.
 */
export type PortafilterState =
  | 'empty'
  | 'grinding'
  | 'grounds'
  | 'tamping'
  | 'tamped'
  | 'lockingIn'
  | 'locked'
  | 'pulling'
  | 'spent'
  | 'knocking';

/** The one milk pitcher's state: a region of the bar machine. */
export type PitcherState = 'empty' | 'steaming' | 'steamed' | 'foaming' | 'foamed' | 'pouring' | 'dumping';

/** What is in the milk pitcher, while its state is not `empty`: the milk, the texture it is (or is becoming), and how much is left. */
export type Pitcher = { milk: Exclude<MilkType, 'none'>; texture: MilkTexture; ml: number } | null;

/**
 * A recipe is data, not rules: what should end up in the cup, in order. The
 * bar lets anything physically possible happen; a served cup is checked
 * against its order's recipe.
 */
export interface Recipe {
  id: DrinkId;
  label: string;
  /** Whether the drink uses milk (and therefore honours the milk modifier). */
  usesMilk: boolean;
  /** The milk it is made with when the customer does not say; whole by default. */
  defaultMilk?: Exclude<MilkType, 'none'>;
  /** What goes into the cup, in order. */
  additions: Array<Addition['kind']>;
  /** Its milk, if it has milk: the texture, and how much is poured. */
  milk?: { texture: MilkTexture; ml: PourMl };
}

/** One horizontal band of the mug glyph, listed bottom-to-top. */
export interface CupLayer {
  /** Fill colour from the mug artboard palette. */
  color: string;
  /** Band height in the 100x80 mug viewBox. */
  h: number;
}

export interface Inventory {
  beans: number; // grams
  water: number; // ml
  chocolate: number; // grams
  milk: Record<Exclude<MilkType, 'none'>, number>; // ml per type
}

export interface OrderMods {
  milk: MilkType;
  size: Size;
  decaf: boolean;
  iced: boolean;
}

export type DrinkStatus = 'queued' | 'served' | 'declined';

/** An order for one drink: what a customer wants, and, once served, what they got. */
export interface Drink {
  id: string;
  /** Display label like "#3 latte (almond)". */
  customerLabel: string;
  drink: DrinkId;
  mods: OrderMods;
  status: DrinkStatus;
  /** When it was ordered: the time the order came with (`order.submit`'s `at`). */
  orderedAt: number;
  /** The cup they were handed: what was in it, and whether it was what they ordered. */
  served?: { cupId: string; contents: Addition[]; spot: CupSpot; slot?: number; correct: boolean };
  note?: string;
}

/** A barista action that takes time: what it is, what it runs on, and until when. */
export type StepId =
  | 'grind_beans'
  | 'tamp'
  | 'lock_in'
  | 'extract'
  | 'knock_out'
  | 'place_cup'
  | 'present_cup'
  | 'return_cup'
  | 'put_away_cup'
  | 'steam_milk'
  | 'foam_milk'
  | 'pour_milk'
  | 'add_water'
  | 'add_chocolate'
  | 'serve'
  | 'dump_cup'
  | 'dump_pitcher'
  | 'repair';

/**
 * A step running right now, read off the bar's states (see `runningSteps`):
 * the portafilter grinding, the pitcher pouring into a cup, a barista's hands
 * on a cup. Several may run at once, on different things. How long it takes
 * (`ms`, at this speed) is the delay its state waits for.
 */
export interface RunningStep {
  stepId: StepId;
  /** The state that waits it out (`portafilter.grinding`, `hands.jev.busy`): its timer says when it started and ends. */
  state: string;
  /** The cup it works on, if any. */
  cupId?: string;
  resource?: Device;
  ms: number;
}

/** A running step on screen: when its state's timer started, and when it is due. */
export interface ActiveStep extends RunningStep {
  startedAt: number;
  endsAt: number;
}

export interface ParsedOrderItem {
  drink: DrinkId;
  qty: number;
  milk?: MilkType;
  size?: Size;
  decaf: boolean;
  iced: boolean;
}

export type Intent = 'order' | 'cancel' | 'question' | 'other';

/** Answer shapes as they come back from Jev (mirrors the SDK response types). */
export interface NoulAnswer {
  type: 'noul';
  noul: number;
}
export interface ChoiceAnswer {
  type: 'choice';
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
}
export interface ScoreAnswer {
  type: 'score';
  score: number;
  confidence: number;
  legend: Record<string, string>;
  probabilities: Record<string, number>;
}
export type AnyAnswer = NoulAnswer | ChoiceAnswer | ScoreAnswer;
export type Answers = Record<string, AnyAnswer>;

export interface ParsedOrder {
  items: ParsedOrderItem[];
  intent: Intent;
  confidence: number;
  latencyMs: number;
  /** Raw Jev answers, kept for the decision log. */
  raw: Answers;
}

/** A barista action Jev may choose: a fully-instantiated event, or the noop. */
export type BaristaOption = JevOption<BarEvent>;

/** A sibling question Jev answered alongside the action, shown for display only. */
export interface SideAnswer {
  id: string;
  label: string;
  choice: string;
  probabilities: Record<string, number>;
}

/** One barista decision as logged: Jev's decision plus the display-only siblings. */
export interface Decision extends JevDecision<BarEvent> {
  /** Parallel answers Jev gave for display; never used for control. */
  also: SideAnswer[];
  extras: {
    backlogPressure: number;
    backlogLabel: string;
    shouldBatchShots: number;
  };
}

/** How a cup (or the pitcher) reads to jev: what is in it, and which order it is on its way to becoming. */
export interface CupView {
  cupId: string;
  spot: CupSpot;
  contents: string[];
  /** The order this cup is on track for (its contents so far are that drink's start), if any. */
  onTrackFor: string | null;
  /** The order it already is, exactly, if any: ready to serve. */
  matches: string | null;
  busy: boolean;
}

/** Everything Jev sees when deciding the next barista action. */
export interface BarSnapshot {
  /** The open orders, longest waiting first. */
  queue: Array<{
    drinkId: string;
    drink: DrinkId;
    mods: OrderMods;
    /** What its cup should hold, in order. */
    recipe: string[];
    /** The cup on its way to being this drink, if any. */
    cupId: string | null;
    /** What it needs next, by the recipe: a cup, while it has none, then what its cup gets next; `null` once it is all in. */
    next: string | null;
    /** What stands in the way of its next step right now, if anything. */
    blockedBy: string | null;
  }>;
  cups: CupView[];
  portafilter: PortafilterState;
  pitcher: string;
  activeSteps: Array<{ stepId: string; cupId?: string; resource?: Device }>;
  equipment: Record<Device, DeviceStatus>;
  inventory: Inventory;
  /** What Jev's own hands are on. */
  yourHands: string | null;
  /** What the other barista (a person) has their hands on. */
  otherBarista: string | null;
  /** Served drinks that were not what the customer ordered. */
  wrongServed: string[];
  servedCount: number;
}

/**
 * The two baristas at the bar: Jev, and you. Each has their own hands; the
 * equipment, the portafilter, the pitcher and the cups are shared.
 */
export type Barista = 'jev' | 'you';

/**
 * A barista action, before saying who does it: what a click on the bar offers. Sent to the bar, it says who (`BaristaEvent`).
 */
export type BaristaMove =
  // The portafilter: one of it, so these need no target.
  | { type: 'barista.grindBeans' }
  | { type: 'barista.tamp' }
  | { type: 'barista.lockIn' }
  | { type: 'barista.extract' }
  | { type: 'barista.knockOut' }
  // Cups.
  | { type: 'barista.placeCup'; spot: CupSpot }
  | { type: 'barista.presentCup'; cupId: string }
  | { type: 'barista.returnCup'; cupId: string }
  | { type: 'barista.putAwayCup'; cupId: string }
  | { type: 'barista.addWater'; cupId: string }
  | { type: 'barista.addChocolate'; cupId: string }
  | { type: 'barista.pourMilk'; cupId: string; ml: PourMl }
  | { type: 'barista.serve'; cupId: string }
  | { type: 'barista.dumpCup'; cupId: string }
  // The pitcher.
  | { type: 'barista.steamMilk'; milk: Exclude<MilkType, 'none'> }
  | { type: 'barista.foamMilk'; milk: Exclude<MilkType, 'none'> }
  | { type: 'barista.dumpPitcher' }
  // Orders, equipment and stock.
  | { type: 'barista.substituteMilk'; drinkId: string; milk: Exclude<MilkType, 'none'> }
  | { type: 'barista.decline'; drinkId: string }
  | { type: 'barista.repair'; device: Device }
  | { type: 'barista.restock'; ingredient: Ingredient };

/** A barista action as the bar takes it: the move, and who makes it. */
export type BaristaEvent = BaristaMove extends infer M ? (M extends BaristaMove ? M & { by: Barista } : never) : never;

export type BarEvent =
  | { type: 'order.submit'; text: string; at: number }
  | { type: 'order.reply'; text: string }
  | { type: 'order.confirm' }
  | { type: 'order.cancel' }
  | BaristaEvent
  | { type: 'BREAK'; device: Device }
  | { type: 'SET_STOCK'; ingredient: Ingredient; amount: number }
  | { type: 'CHAOS_ROLL'; rolls: Record<Device, number> }
  | { type: 'SET_SPEED'; speed: number }
  | { type: 'SET_BREAK_PROB'; device: Device; prob: number }
  | { type: 'RESET' };

/** A barista action: the events Jev may choose for the bar. */
export type BaristaAction = Extract<BarEvent, { type: `barista.${string}` }>['type'];

/**
 * The barista's hands, a resource of the bar like the grinder: every barista
 * action occupies them for its hands-on time (`ms`, at 1x), which their
 * region (`hands.jev`, `hands.you`) waits out. `null` when free.
 */
export interface Hands {
  doing: BaristaAction;
  ms: number;
  /** What the hands are on: a cup, an order, or an ingredient being restocked. */
  cupId?: string;
  drinkId?: string;
  ingredient?: Ingredient;
  /** The device being repaired. */
  device?: Device;
}

/**
 * The espresso bar machine's context: the data its finite states do not hold.
 * The portafilter, the pitcher and the equipment are regions of the machine;
 * `Bar` puts them together with this for the pure helpers.
 */
export interface BarContext {
  /** The orders, open and done. */
  drinks: Drink[];
  /** A collection that grows and shrinks, so data rather than states. */
  cups: Cup[];
  /** The pitcher's milk while the `pitcher` region is not `empty`. */
  pitcher: Pitcher;
  /** For naming new cups: c1, c2, … */
  nextCupNo: number;
  /** The cup under the spouts when the shot started pulling, while it pulls. */
  shotCup: string | null;
  /** The cup the milk is being poured into, and how much, while it pours. */
  pour: { cupId: string; ml: PourMl } | null;
  /** Each barista's hands: whoever did something holds it for its hands-on time. */
  hands: Record<Barista, Hands | null>;
  inventory: Inventory;
  pendingOrder: ParsedOrder | null;
  pendingText: string;
  lastParse: ParsedOrder | null;
  speed: number;
  breakProb: Record<Device, number>;
  /** When the order being read or clarified came in. */
  pendingAt: number;
  nextDrinkNo: number;
  error: string | null;
}

/**
 * The bar as the helpers and the UI read it: the machine's context plus the
 * states of its regions (see `barOf` in `legal.ts`). Derived, never stored.
 */
export interface Bar extends BarContext {
  portafilter: PortafilterState;
  pitcherState: PitcherState;
  equipment: Record<Device, DeviceStatus>;
  /** What is running right now, read off the states (see `runningSteps`). */
  activeSteps: RunningStep[];
}
