/**
 * Scenarios to measure the barista's Jev against, run without the page: the
 * bar on a simulated clock, Jev deciding every move (`decide`), and time
 * jumping to the moment Jev could act again. Every run reports whether the
 * orders came out right, and what it cost on the way.
 */
import { decide, detectLoop, tellLoop, type JevClient, type JevDecision, type JevLoop, type JevOptions } from '@xstate/jev';
import { createActor, createCallbackLogic, SimulatedClock } from 'xstate';
import { barista, baristaLoops } from '../lib/barista';
import { isOpen } from '../lib/legal';
import { INITIAL_INVENTORY } from '../lib/recipes';
import { barOf } from '../lib/legal';
import type { Bar, BarContext, BarEvent, Cup, Drink, DrinkId, MilkType } from '../lib/types';
import { espressoBarMachine } from '../machines/espressoBar';

export interface Scenario {
  id: string;
  label: string;
  /** The orders, longest waiting first. */
  orders: Array<{ drink: DrinkId; milk?: MilkType }>;
  /** Anything else on the bar when it starts: cups left out, stock running low. */
  bar?: Partial<BarContext>;
  /**
   * Sabotage: what happens to the bar from outside (a machine breaking, you
   * working against Jev), once, the first time `when` holds before one of
   * Jev's decisions. A move of yours waits until the bar takes it.
   */
  meanwhile?: Array<{ when: (bar: Bar) => boolean; event: BarEvent }>;
}

const MILK_DRINKS: DrinkId[] = ['latte', 'cappuccino', 'flat_white', 'cortado', 'mocha', 'macchiato', 'cafe_breve', 'hot_chocolate'];

function drinks(orders: Scenario['orders']): Drink[] {
  return orders.map((o, i) => ({
    id: `d${i + 1}`,
    customerLabel: `#${i + 1}`,
    drink: o.drink,
    mods: { milk: o.milk ?? (MILK_DRINKS.includes(o.drink) ? 'whole' : 'none'), size: 'regular', decaf: false, iced: false },
    status: 'queued',
    orderedAt: i,
  }));
}

const emptyCup = (id: string, slot: number): Cup => ({ id, spot: 'front', slot, contents: [] });

/** The cup on the drip tray once a shot is in it, if any. */
const shotOnTray = (bar: Bar) => bar.cups.find((c) => c.spot === 'tray' && c.contents.some((a) => a.kind === 'shot'));

export const SCENARIOS: Scenario[] = [
  { id: 'plain', label: 'A latte and an americano', orders: [{ drink: 'latte' }, { drink: 'americano' }] },
  {
    id: 'cups-in-the-way',
    label: 'The front full of empty cups; a mocha and an espresso',
    orders: [{ drink: 'mocha' }, { drink: 'espresso' }],
    bar: { cups: [emptyCup('c1', 0), emptyCup('c2', 1), emptyCup('c3', 2)], nextCupNo: 4 },
  },
  {
    id: 'breaks-midway',
    label: 'A cappuccino; the group head breaks along the way',
    orders: [{ drink: 'cappuccino' }],
    meanwhile: [{ when: (bar) => bar.portafilter === 'tamped', event: { type: 'BREAK', device: 'groupHead' } }],
  },
  {
    id: 'out-of-oat',
    label: 'An oat latte with too little oat milk left',
    orders: [{ drink: 'latte', milk: 'oat' }],
    bar: { inventory: { ...INITIAL_INVENTORY, milk: { ...INITIAL_INVENTORY.milk, oat: 100 } } },
  },
  // Sabotage: you, or the bar itself, working against Jev mid-drink.
  {
    id: 'sabotage-shot',
    label: 'A latte; the group head breaks while the shot pulls',
    orders: [{ drink: 'latte' }],
    meanwhile: [{ when: (bar) => bar.portafilter === 'pulling', event: { type: 'BREAK', device: 'groupHead' } }],
  },
  {
    id: 'sabotage-moved-cup',
    label: 'An americano; you carry its cup to the front right after the shot',
    orders: [{ drink: 'americano' }],
    meanwhile: [{ when: (bar) => shotOnTray(bar) !== undefined, event: { type: 'barista.presentCup', cupId: 'c1', by: 'you' } }],
  },
  {
    id: 'sabotage-chocolate',
    label: 'A cappuccino; you add chocolate to its cup right after the shot',
    orders: [{ drink: 'cappuccino' }],
    meanwhile: [{ when: (bar) => shotOnTray(bar) !== undefined, event: { type: 'barista.addChocolate', cupId: 'c1', by: 'you' } }],
  },
  {
    id: 'sabotage-milk',
    label: 'A latte; you pour away the milk as soon as it is steamed',
    orders: [{ drink: 'latte' }],
    meanwhile: [{ when: (bar) => bar.pitcherState === 'steamed', event: { type: 'barista.dumpPitcher', by: 'you' } }],
  },
  {
    id: 'sabotage-beans',
    label: 'An espresso; you throw out all the beans first',
    orders: [{ drink: 'espresso' }],
    meanwhile: [{ when: () => true, event: { type: 'SET_STOCK', ingredient: 'beans', amount: 0 } }],
  },
  {
    id: 'rush',
    label: 'Four at once: espresso, cappuccino, hot chocolate, americano',
    orders: [{ drink: 'espresso' }, { drink: 'cappuccino' }, { drink: 'hot_chocolate' }, { drink: 'americano' }],
  },
];

export interface RunResult {
  scenario: string;
  /** Every order served, exactly right: a declined order is a customer sent away. */
  ok: boolean;
  served: number;
  wrong: number;
  declined: number;
  open: number;
  decisions: number;
  waits: number;
  /** Shots pulled beyond what the served drinks hold. */
  wastedShots: number;
  /** Cups poured away. */
  dumped: number;
  /** Loops seen along the way (`detectLoop`, with the barista's settings). */
  loops: JevLoop['kind'][];
  /** Jev chose to wait with nothing running: nothing would ever change. */
  stalled: boolean;
  /** Bar time it took, in seconds. */
  seconds: number;
  /** Jev requests made, and their size in characters of JSON (about 4 a token). */
  requests: number;
  chars: number;
  /** Jev's moves, in order, with the sabotage where it struck (`!` before it). */
  moves: string[];
  error?: string;
}

const idle = createCallbackLogic(() => () => {});

/** Every running delay of the bar, by when it is due. */
function dueTimes(actor: { system: { getSnapshot: () => { _scheduledTimers: Record<string, { dueAt: number }> } } }): number[] {
  return Object.values(actor.system.getSnapshot()._scheduledTimers)
    .map((t) => t.dueAt)
    .sort((a, b) => a - b);
}

export interface RunOptions {
  maxDecisions?: number;
  /**
   * - `paused` (default): the bar waits while Jev thinks, as if Jev were instant.
   * - `live`: as on the page, the bar runs on while Jev thinks, for as long as
   *   Jev takes to answer, at `speed`; a move the bar has outgrown by then is
   *   not taken.
   */
  clock?: 'paused' | 'live';
  /** The bar's speed (how fast its steps run). Default 1, or 10 with a live clock, as the demo plays. */
  speed?: number;
  /** The barista's agent with some settings of its own (`strategy`, `lookahead`, …). */
  agent?: Partial<JevOptions<BarEvent, BarContext>>;
}

/**
 * Run one scenario to the end: until every order is done, nothing more can
 * happen, or `maxDecisions`. Jev is told about its own loops, as on the page
 * (`tellLoop`).
 */
export async function runScenario(scenario: Scenario, client: JevClient, options: RunOptions = {}): Promise<RunResult> {
  const { maxDecisions = 60, clock: mode = 'paused' } = options;
  const speed = options.speed ?? (mode === 'live' ? 10 : 1);
  const clock = new SimulatedClock();
  const machine = espressoBarMachine.provide({ actors: { chaos: idle as never, barista: idle as never, orderRouterAgent: idle as never } });
  const actor = createActor(machine, { input: { ...scenario.bar, speed, drinks: drinks(scenario.orders) }, clock }).start();
  const history: JevDecision<BarEvent>[] = [];
  const loops = new Set<JevLoop['kind']>();
  const moves: string[] = [];
  let requests = 0;
  let chars = 0;
  const pending = new Set(scenario.meanwhile ?? []);
  let stalled = false;
  let error: string | undefined;

  // Let bar time pass to the next delay that is up; false when nothing is running.
  const next = () => {
    const [due] = dueTimes(actor);
    if (due === undefined) return false;
    clock.increment(Math.max(0, due - clock.now()));
    return true;
  };

  try {
    for (let n = 0; n < maxDecisions && actor.getSnapshot().context.drinks.some(isOpen); n++) {
      for (const m of pending) {
        const now = actor.getSnapshot();
        if (!m.when(barOf(now)) || !now.can(m.event as never)) continue;
        actor.send(m.event as never);
        moves.push(`!${m.event.type.replace('barista.', '')}`);
        pending.delete(m);
      }
      const snapshot = actor.getSnapshot();
      const asked = Date.now();
      const told = tellLoop<BarEvent, BarContext, typeof barista>(
        { ...barista, ...options.agent },
        history.length ? detectLoop(history, baristaLoops) : null,
      );
      const decision = await decide(snapshot, { ...told, client });
      // Live, the bar ran on while Jev was thinking: the move may no longer be possible.
      if (mode === 'live') clock.increment(Date.now() - asked);
      if (decision.size) (requests++, (chars += decision.size.total));
      const sent = !!decision.event && actor.getSnapshot().can(decision.event);
      if (sent) actor.send(decision.event as never);
      moves.push(decision.option?.id ?? '(none)');
      history.unshift({ ...decision, sent });
      const loop = detectLoop(history, baristaLoops);
      if (loop) loops.add(loop.kind);
      // Time passes: a move until Jev's hands are free; a wait until the next thing running is done
      // (nothing running, and nothing changed since Jev looked: stalled).
      if (sent) {
        while (actor.getSnapshot().context.hands.jev && next());
      } else if (actor.getSnapshot() !== snapshot) {
        // Live, the bar moved on while Jev was deciding to wait: ask again about the bar as it is now.
        continue;
      } else if (!next()) {
        stalled = true;
        break;
      }
    }
  } catch (e) {
    error = String(e);
  }

  const { context } = actor.getSnapshot();
  actor.stop();
  const served = context.drinks.filter((d) => d.status === 'served');
  const wrong = served.filter((d) => !d.served?.correct).length;
  const shotsHeld = served.flatMap((d) => d.served?.contents ?? []).filter((a) => a.kind === 'shot').length;
  const shotsPulled = moves.filter((m) => m === 'barista.extract').length;
  const declined = context.drinks.filter((d) => d.status === 'declined').length;
  const open = context.drinks.filter(isOpen).length;
  return {
    scenario: scenario.id,
    ok: !error && open === 0 && wrong === 0 && declined === 0,
    served: served.length,
    wrong,
    declined,
    open,
    decisions: moves.filter((m) => !m.startsWith('!')).length,
    waits: moves.filter((m) => m === 'noop').length,
    wastedShots: Math.max(0, Math.round(shotsPulled - shotsHeld)),
    dumped: moves.filter((m) => m.startsWith('barista.dumpCup')).length,
    loops: [...loops],
    stalled,
    seconds: Math.round(clock.now() / 100) / 10,
    requests,
    chars,
    moves,
    error,
  };
}
