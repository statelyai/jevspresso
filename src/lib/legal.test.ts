import { createJevLogic, decide, getOptions, machineMap, mockAnswers, NOOP_ID, type JevAgentContext, type JevClient, type JevSnapshot, type MockScorer } from '@xstate/jev';
import { createActor, createAsyncLogic, createCallbackLogic, SimulatedClock, transition, type StateValue } from 'xstate';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBaristaAgent } from '../machines';
import { espressoBarMachine } from '../machines/espressoBar';
import { barista, orderRouter, PACE_SETTLE } from './barista';
import { barOf, runningSteps, serializeBar } from './legal';
import { DOSE, INITIAL_INVENTORY } from './recipes';
import { blockedBy, spotAction } from './view';
import { baristaMock } from '../eval/mock';
import type { Addition, Bar, BarContext, MilkTexture, PourMl, BarEvent, BaristaEvent, BarSnapshot, Cup, Drink, ParsedOrder } from './types';

/* ------------------------------------------------------------- fake Jev ---- */
// The tests' stand-in for jev: `mockAnswers` from @xstate/jev, scored by these
// (the barista's is shared with the scenarios: `baristaMock`).

const routerMockScore: MockScorer = ({ option, state }) => {
  const reply = String((state as { reply?: unknown }).reply ?? '').toLowerCase();
  if (option === 'order.confirm') return /\b(yes|yep|yeah|right|correct|sure|perfect|exactly)\b/.test(reply) ? 4 : 0;
  if (option === 'order.cancel') return /\b(no|nope|wrong|cancel|not|retype)\b/.test(reply) ? 4 : 0;
  return 1.5;
};

const NOW = 1_000_000;

/** A bar as the helpers read it: context, plus its regions' states (`portafilter`, `pitcherState`, `equipment`). */
function ctx(over: Partial<Omit<Bar, 'activeSteps'>> = {}): Bar {
  const b: Omit<Bar, 'activeSteps'> = {
    drinks: [],
    cups: [],
    portafilter: 'empty',
    pitcherState: 'empty',
    pitcher: null,
    nextCupNo: 1,
    shotCup: null,
    pour: null,
    hands: { jev: null, you: null },
    inventory: structuredClone(INITIAL_INVENTORY),
    equipment: { grinder: 'ok', groupHead: 'ok', steamWand: 'ok' },
    pendingOrder: null,
    pendingText: '',
    lastParse: null,
    speed: 1,
    breakProb: { grinder: 0, groupHead: 0, steamWand: 0 },
    pendingAt: 0,
    nextDrinkNo: 1,
    error: null,
    ...over,
  };
  // What is running is read off the states, as the machine's own view does.
  return { ...b, activeSteps: runningSteps(b) };
}

function order(over: Partial<Drink> = {}): Drink {
  return {
    id: 'd1',
    customerLabel: '#1',
    drink: 'latte',
    mods: { milk: 'whole', size: 'regular', decaf: false, iced: false },
    status: 'queued',
    orderedAt: NOW - 5000,
    ...over,
  };
}

const espresso = (over: Partial<Drink> = {}) =>
  order({ drink: 'espresso', mods: { milk: 'none', size: 'regular', decaf: false, iced: false }, ...over });

const SHOT: Addition = { kind: 'shot' };
const milkOf = (texture: MilkTexture, ml: PourMl = 180, milk: 'whole' | 'oat' = 'whole'): Addition => ({ kind: 'milk', milk, texture, ml });
const cup = (id: string, spot: Cup['spot'], contents: Addition[] = []): Cup => ({ id, spot, contents });

const silent = createCallbackLogic<{ type: 'noop' }, undefined>(() => () => {});

const running: Array<{ stop: () => void }> = [];

/** Intake idle, each device region in the state its context says. */
/** The machine's context: the bar without its regions' states. */
function contextOf({ portafilter: _pf, pitcherState: _pitcher, equipment: _eq, activeSteps: _steps, ...context }: Bar): BarContext {
  return context;
}

/** The state value for a bar: intake idle, and each region in the state the bar says. */
const valueOf = (b: Bar): StateValue => ({
  intake: 'idle',
  equipment: { ...b.equipment },
  portafilter: b.portafilter,
  pitcher: b.pitcherState,
  hands: { jev: b.hands.jev ? 'busy' : 'free', you: b.hands.you ? 'busy' : 'free' },
});

/** Each test bar's clock: simulated, so time passes when a test says so. */
const clocks = new WeakMap<object, SimulatedClock>();

/**
 * A real running actor, seeded with `context`, on a simulated clock, with
 * chaos stubbed out. Restored snapshots do not start root invocations, so
 * there is no barista (and no router): legality checks see a bar nobody touches.
 */
function bar(b: Bar) {
  const machine = espressoBarMachine.provide({ actors: { chaos: silent } });
  const clock = new SimulatedClock();
  const actor = createActor(machine, {
    snapshot: espressoBarMachine.resolveState({ value: valueOf(b), context: contextOf(b) }) as never,
    clock,
  });
  clocks.set(actor, clock);
  actor.start();
  running.push(actor);
  return actor;
}

type BarActor = ReturnType<typeof bar>;

/** Let the simulated clock run while `until` says so, in short steps (at most a minute). */
function runClock(actor: BarActor, busy: () => boolean) {
  const clock = clocks.get(actor)!;
  for (let t = 0; t < 60_000 && busy(); t += 50) clock.increment(50);
}

/** Let time pass until every running step is done and both pairs of hands are free. */
function finish(actor: BarActor) {
  runClock(actor, () => {
    const b = barOf(actor.getSnapshot());
    return b.activeSteps.length > 0 || b.hands.jev !== null || b.hands.you !== null;
  });
}

/** Let only the hands-on time pass: machines keep running. */
function finishHands(actor: BarActor) {
  runClock(actor, () => actor.getSnapshot().context.hands.jev !== null || actor.getSnapshot().context.hands.you !== null);
}

/** Do it, and wait it out. */
function doIt(actor: BarActor, event: BaristaEvent) {
  expect(actor.getSnapshot().can(event as never), event.type).toBe(true);
  actor.send(event as never);
  finish(actor);
}

/**
 * A freshly started bar (so the barista is invoked), seeded with `context`,
 * on the real clock: its timed states take their real (sped-up) time.
 */
function openBar(b: Bar, baristaClient: JevClient) {
  const machine = espressoBarMachine.provide({
    actors: { chaos: silent, barista: createBaristaAgent(baristaClient) },
  });
  // Its regions start where a new bar's do; only the context is seeded.
  const actor = createActor(machine, { input: contextOf(b) }).start();
  running.push(actor);
  return actor;
}

const snap = (b: Bar) => bar(b).getSnapshot() as unknown as JevSnapshot<BarContext>;

/** Legality asked of the real machine: every candidate goes through `can()`. */
function legalIds(b: Bar): string[] {
  return getOptions(snap(b), { ...barista, lookahead: false }).map((a) => a.id);
}

afterEach(() => {
  while (running.length) running.pop()!.stop();
});

describe('physics, not recipes', () => {
  it('offers what is physically possible even with no orders: Jev is not told what is wise', () => {
    const ids = legalIds(ctx());
    expect(ids).toEqual(expect.arrayContaining(['barista.grindBeans', 'barista.placeCup:tray', 'noop']));
    // Every milk, steamed or foamed, from the schema's enum.
    expect(ids).toContain('barista.steamMilk:oat');
    expect(ids.filter((id) => id.startsWith('barista.steamMilk:'))).toHaveLength(5);
    expect(ids.filter((id) => id.startsWith('barista.foamMilk:'))).toHaveLength(5);
  });

  it('offers whatever is physically possible, recipe or not', () => {
    const ids = legalIds(ctx({ drinks: [espresso()] }));
    expect(ids).toEqual(expect.arrayContaining(['barista.grindBeans', 'barista.placeCup:tray', 'barista.placeCup:front', 'noop']));
    // Nothing to tamp, lock or pull yet: the portafilter is empty.
    expect(ids).not.toContain('barista.tamp');
    expect(ids).not.toContain('barista.extract');
  });

  it('takes the portafilter from empty through a shot and back', () => {
    const actor = bar(ctx({ drinks: [espresso()] }));
    const pf = () => barOf(actor.getSnapshot()).portafilter;
    doIt(actor, { type: 'barista.grindBeans', by: 'jev' });
    expect(pf()).toBe('grounds');
    expect(actor.getSnapshot().context.inventory.beans).toBe(INITIAL_INVENTORY.beans - 18);
    doIt(actor, { type: 'barista.tamp', by: 'jev' });
    expect(pf()).toBe('tamped');
    doIt(actor, { type: 'barista.lockIn', by: 'jev' });
    expect(pf()).toBe('locked');
    doIt(actor, { type: 'barista.extract', by: 'jev' });
    expect(pf()).toBe('spent');
    // One portafilter: no grinding until the puck is out.
    expect(actor.getSnapshot().can({ type: 'barista.grindBeans', by: 'jev' })).toBe(false);
    doIt(actor, { type: 'barista.knockOut', by: 'jev' });
    expect(pf()).toBe('empty');
  });

  it('pulls the shot into whatever cup is under the spouts, or down the drain', () => {
    const noCup = bar(ctx({ portafilter: 'locked' }));
    doIt(noCup, { type: 'barista.extract', by: 'jev' });
    expect(noCup.getSnapshot().context.cups).toEqual([]);
    const withCup = bar(ctx({ portafilter: 'locked', cups: [cup('c1', 'tray')] }));
    doIt(withCup, { type: 'barista.extract', by: 'jev' });
    expect(withCup.getSnapshot().context.cups[0].contents).toEqual([SHOT]);
  });

  it("makes an espresso's cup into #3's cappuccino, and serves it to #3", () => {
    const drinks = [espresso(), order({ id: 'd2', customerLabel: '#2', drink: 'latte', orderedAt: NOW - 4000 }), order({ id: 'd3', customerLabel: '#3', drink: 'cappuccino', orderedAt: NOW - 3000 })];
    const actor = bar(ctx({ drinks, cups: [cup('c1', 'tray', [SHOT])] }));
    doIt(actor, { type: 'barista.foamMilk', milk: 'whole', by: 'jev' });
    doIt(actor, { type: 'barista.presentCup', cupId: 'c1', by: 'jev' });
    doIt(actor, { type: 'barista.pourMilk', cupId: 'c1', ml: 180, by: 'jev' });
    expect(actor.getSnapshot().context.cups[0].contents).toEqual([SHOT, milkOf('foamed')]);
    doIt(actor, { type: 'barista.serve', cupId: 'c1', by: 'jev' });
    const after = actor.getSnapshot().context;
    expect(after.drinks.find((d) => d.id === 'd3')).toMatchObject({ status: 'served', served: { correct: true, cupId: 'c1' } });
    expect(after.drinks.find((d) => d.id === 'd1')!.status).toBe('queued');
    expect(after.cups).toEqual([]);
  });

  it('serves a cup that is no order to the order it was on its way to, flagged wrong', () => {
    // Hot water in a latte's shot: no order is that.
    const actor = bar(ctx({ drinks: [order()], cups: [cup('c1', 'tray', [SHOT, { kind: 'water' }])] }));
    doIt(actor, { type: 'barista.serve', cupId: 'c1', by: 'jev' });
    expect(actor.getSnapshot().context.drinks[0]).toMatchObject({ status: 'served', served: { correct: false } });
    expect(serializeBar(barOf(actor.getSnapshot())).wrongServed[0]).toMatch(/#1 ordered a latte/);
  });

  it('holds one cup on the drip tray and three at the front; the spouts only reach the drip tray', () => {
    const c = ctx({ drinks: [order()], cups: [cup('c1', 'tray'), { ...cup('c2', 'front'), slot: 0 }], portafilter: 'locked' });
    const s = snap(c);
    expect(s.can({ type: 'barista.placeCup', spot: 'tray', by: 'jev' })).toBe(false);
    expect(s.can({ type: 'barista.addWater', cupId: 'c1', by: 'jev' })).toBe(true);
    expect(s.can({ type: 'barista.addWater', cupId: 'c2', by: 'jev' })).toBe(false);
    expect(s.can({ type: 'barista.presentCup', cupId: 'c1', by: 'jev' })).toBe(true); // room beside c2
    expect(s.can({ type: 'barista.addChocolate', cupId: 'c2', by: 'jev' })).toBe(true); // anywhere
    // It goes to the next place along; with three there, the front is full.
    const actor = bar(c);
    doIt(actor, { type: 'barista.presentCup', cupId: 'c1', by: 'jev' });
    expect(actor.getSnapshot().context.cups.find((x) => x.id === 'c1')).toMatchObject({ spot: 'front', slot: 1 });
    doIt(actor, { type: 'barista.placeCup', spot: 'front', by: 'jev' });
    expect(actor.getSnapshot().can({ type: 'barista.placeCup', spot: 'front', by: 'jev' })).toBe(false);
  });

  it('never gridlocks a milk drink behind a hot chocolate at the front', () => {
    // The shot waits on the tray, the hot chocolate at the front, the latte's milk in the pitcher.
    const c = ctx({
      drinks: [order(), order({ id: 'd2', customerLabel: '#2', drink: 'hot_chocolate', orderedAt: NOW - 4000 })],
      cups: [cup('c1', 'tray', [SHOT]), { ...cup('c2', 'front', [{ kind: 'chocolate' }]), slot: 0 }],
      pitcherState: 'steamed',
      pitcher: { milk: 'whole', texture: 'steamed', ml: 240 },
    });
    const actor = bar(c);
    doIt(actor, { type: 'barista.presentCup', cupId: 'c1', by: 'jev' });
    doIt(actor, { type: 'barista.pourMilk', cupId: 'c1', ml: 180, by: 'jev' });
    doIt(actor, { type: 'barista.serve', cupId: 'c1', by: 'jev' });
    expect(actor.getSnapshot().context.drinks[0]).toMatchObject({ status: 'served', served: { correct: true } });
  });

  it('steams any milk, one pitcher at a time, and pours it into the cup at the front', () => {
    const actor = bar(ctx({ drinks: [order()], cups: [cup('c1', 'front', [SHOT])] }));
    expect(actor.getSnapshot().can({ type: 'barista.steamMilk', milk: 'oat', by: 'jev' })).toBe(true);
    doIt(actor, { type: 'barista.steamMilk', milk: 'oat', by: 'jev' });
    expect(actor.getSnapshot().can({ type: 'barista.steamMilk', milk: 'whole', by: 'jev' })).toBe(false);
    expect(actor.getSnapshot().context.inventory.milk.oat).toBe(INITIAL_INVENTORY.milk.oat - DOSE.milk);
    doIt(actor, { type: 'barista.dumpPitcher', by: 'jev' });
    expect(actor.getSnapshot().context.pitcher).toBeNull();
  });

  it('pours an amount, and keeps what is left: a cortado and a flat white from one jug, neither a latte', () => {
    const drinks = [order({ drink: 'cortado' }), order({ id: 'd2', customerLabel: '#2', drink: 'flat_white', orderedAt: NOW - 4000 })];
    const front = (id: string, slot: number) => ({ ...cup(id, 'front', [SHOT]), slot });
    const actor = bar(ctx({ drinks, cups: [front('c1', 0), front('c2', 1)] }));
    doIt(actor, { type: 'barista.steamMilk', milk: 'whole', by: 'jev' });
    doIt(actor, { type: 'barista.pourMilk', cupId: 'c1', ml: 60, by: 'jev' });
    // 180ml left: still steamed milk, enough for a latte, more than a flat white's.
    expect(actor.getSnapshot().value).toMatchObject({ pitcher: 'steamed' });
    expect(actor.getSnapshot().context.pitcher).toEqual({ milk: 'whole', texture: 'steamed', ml: 180 });
    expect(actor.getSnapshot().can({ type: 'barista.pourMilk', cupId: 'c2', ml: 120, by: 'jev' })).toBe(true);
    doIt(actor, { type: 'barista.pourMilk', cupId: 'c2', ml: 120, by: 'jev' });
    // 60ml left: too little for another flat white.
    expect(actor.getSnapshot().context.pitcher?.ml).toBe(60);
    expect(actor.getSnapshot().can({ type: 'barista.pourMilk', cupId: 'c2', ml: 120, by: 'jev' })).toBe(false);
    doIt(actor, { type: 'barista.serve', cupId: 'c1', by: 'jev' });
    doIt(actor, { type: 'barista.serve', cupId: 'c2', by: 'jev' });
    expect(actor.getSnapshot().context.drinks.map((d) => [d.drink, d.served?.correct])).toEqual([
      ['cortado', true],
      ['flat_white', true],
    ]);
    // A latte's 180ml in a flat white's cup is no flat white.
    const latteCup = snap(ctx({ drinks: [order({ drink: 'flat_white' })], cups: [front('c1', 0)] }));
    expect(serializeBar(barOf(latteCup)).queue[0].recipe).toEqual(['espresso', '120ml whole milk, steamed']);
  });

  it('steams or foams milk into the empty pitcher: which, is decided as it is made', () => {
    const actor = bar(ctx({ drinks: [order({ drink: 'cappuccino' })], cups: [cup('c1', 'front', [SHOT])] }));
    doIt(actor, { type: 'barista.foamMilk', milk: 'whole', by: 'jev' });
    expect(actor.getSnapshot().value).toMatchObject({ pitcher: 'foamed' });
    expect(actor.getSnapshot().context.pitcher).toEqual({ milk: 'whole', texture: 'foamed', ml: 240 });
    expect(serializeBar(barOf(actor.getSnapshot())).pitcher).toBe('whole milk (foamed), 240ml');
    // Milk in the pitcher is neither steamed nor foamed again.
    expect(actor.getSnapshot().can({ type: 'barista.foamMilk', milk: 'whole', by: 'jev' })).toBe(false);
    expect(actor.getSnapshot().can({ type: 'barista.steamMilk', milk: 'whole', by: 'jev' })).toBe(false);
    const steamed = bar(ctx({ pitcherState: 'steamed', pitcher: { milk: 'whole', texture: 'steamed', ml: 240 } }));
    expect(steamed.getSnapshot().can({ type: 'barista.foamMilk', milk: 'whole', by: 'jev' })).toBe(false);
    // Steamed milk for a cappuccino is no cappuccino: the order still wants it foamed.
    expect(serializeBar(barOf(snap(ctx({ drinks: [order({ drink: 'cappuccino' })], cups: [cup('c1', 'front', [SHOT, milkOf('steamed')])] })))).queue[0]
      .recipe).toEqual(['espresso', '180ml whole milk, foamed']);
  });

  it("keeps the barista's hands busy for a step's hands-on time, and nothing else hands-on starts", () => {
    const actor = bar(ctx({ drinks: [order()] }));
    actor.send({ type: 'barista.grindBeans', by: 'jev' });
    const { hands } = actor.getSnapshot().context;
    expect(hands).toMatchObject({ jev: { doing: 'barista.grindBeans' }, you: null });
    expect(actor.getSnapshot().can({ type: 'barista.placeCup', spot: 'tray', by: 'jev' })).toBe(false);
    expect(legalIds(barOf(actor.getSnapshot()))).toEqual(['noop']);
  });

  it('frees the hands once their time is up; the grinder runs on', () => {
    const actor = bar(ctx({ drinks: [order()] }));
    actor.send({ type: 'barista.grindBeans', by: 'jev' });
    clocks.get(actor)!.increment(499);
    expect(actor.getSnapshot().context.hands.jev).not.toBeNull();
    clocks.get(actor)!.increment(1);
    const after = barOf(actor.getSnapshot());
    expect(after.hands.jev).toBeNull();
    expect(after.activeSteps.map((a) => a.stepId)).toEqual(['grind_beans']);
    expect(barOf(actor.getSnapshot()).portafilter).toBe('grinding'); // still grinding into it
    expect(actor.getSnapshot().can({ type: 'barista.placeCup', spot: 'tray', by: 'jev' })).toBe(true);
  });

  it('loses a shot being pulled when the machine breaks; the portafilter stays locked', () => {
    const actor = bar(ctx({ portafilter: 'locked', cups: [cup('c1', 'tray')] }));
    actor.send({ type: 'barista.extract', by: 'jev' });
    actor.send({ type: 'BREAK', device: 'groupHead' });
    finish(actor);
    expect(barOf(actor.getSnapshot())).toMatchObject({ portafilter: 'locked', cups: [cup('c1', 'tray')] });
  });

  it('offers a milk swap when the ordered milk runs out, and a decline when nothing would do', () => {
    const inventory = structuredClone(INITIAL_INVENTORY);
    inventory.milk.whole = 10;
    const ids = legalIds(ctx({ drinks: [order()], inventory }));
    expect(ids).toContain('barista.substituteMilk:d1:oat');
    expect(ids).not.toContain('barista.decline:d1');
    const none = structuredClone(INITIAL_INVENTORY);
    for (const m of Object.keys(none.milk) as Array<keyof typeof none.milk>) none.milk[m] = 0;
    expect(legalIds(ctx({ drinks: [order()], inventory: none }))).toContain('barista.decline:d1');
  });

  it("restocks an ingredient running low back to full, with the barista's hands", () => {
    const inventory = structuredClone(INITIAL_INVENTORY);
    inventory.milk.almond = 50;
    const actor = bar(ctx({ inventory }));
    expect(actor.getSnapshot().can({ type: 'barista.restock', ingredient: 'whole', by: 'jev' })).toBe(false);
    actor.send({ type: 'barista.restock', ingredient: 'almond', by: 'jev' });
    expect(actor.getSnapshot().context.inventory.milk.almond).toBe(INITIAL_INVENTORY.milk.almond);
    expect(actor.getSnapshot().context.hands.jev).toMatchObject({ doing: 'barista.restock', ingredient: 'almond' });
  });

  it('resets the regions with the context: a broken machine, a locked portafilter, steamed milk', () => {
    const actor = bar(
      ctx({
        drinks: [order()],
        portafilter: 'locked',
        pitcherState: 'steamed',
        pitcher: { milk: 'oat', texture: 'steamed', ml: 240 },
        equipment: { grinder: 'broken', groupHead: 'ok', steamWand: 'ok' },
      }),
    );
    actor.send({ type: 'RESET' });
    expect(barOf(actor.getSnapshot())).toMatchObject({
      drinks: [],
      portafilter: 'empty',
      pitcherState: 'empty',
      pitcher: null,
      equipment: { grinder: 'ok', groupHead: 'ok', steamWand: 'ok' },
    });
  });

  it('repairs a broken device through the equipment region', () => {
    const c = ctx({ equipment: { grinder: 'broken', groupHead: 'ok', steamWand: 'ok' } });
    const actor = bar(c);
    actor.send({ type: 'barista.repair', device: 'grinder', by: 'jev' });
    expect(barOf(actor.getSnapshot()).equipment.grinder).toBe('repairing');
  });
});

describe('a pure machine', () => {
  // Every move, then the clock to when it is done: a drink from start to finish, a repair on the way.
  const moves: BarEvent[] = [
    { type: 'BREAK', device: 'grinder' },
    { type: 'barista.repair', device: 'grinder', by: 'jev' },
    { type: 'barista.placeCup', spot: 'tray', by: 'you' },
    { type: 'barista.grindBeans', by: 'jev' },
    { type: 'barista.tamp', by: 'jev' },
    { type: 'barista.lockIn', by: 'jev' },
    { type: 'barista.extract', by: 'jev' },
    { type: 'barista.serve', cupId: 'c1', by: 'jev' },
  ];
  const delays = espressoBarMachine.sources.delays as Record<string, (args: { context: BarContext }) => number>;
  /** The delayed transitions waiting in a snapshot: each state's `after`, with how long it waits. */
  const waiting = (snapshot: ReturnType<typeof espressoBarMachine.resolveState>) =>
    snapshot.nodes.flatMap((node) =>
      (node.after as unknown as Array<{ delay: string; matches: { delay: string; stateId: string } }>).map((t) => ({
        ms: delays[t.delay]({ context: snapshot.context }),
        event: { type: 'xstate.after', ...t.matches },
      })),
    );
  // Only `transition()`: each move, then each waiting delay in turn, shortest
  // first, as `xstate.after` events. No clock, no actor.
  const play = () => {
    let snapshot = espressoBarMachine.resolveState({ value: valueOf(ctx()), context: contextOf(ctx({ drinks: [espresso()] })) });
    const step = (event: unknown) => {
      snapshot = transition(espressoBarMachine, snapshot, event as never)[0] as typeof snapshot;
    };
    for (const m of moves) {
      step(m);
      for (let next = waiting(snapshot); next.length; next = waiting(snapshot)) step(next.sort((x, y) => x.ms - y.ms)[0].event);
    }
    return barOf(snapshot);
  };

  it('is a function of its state and the events it gets, time included: the same moves, the same bar', async () => {
    const first = play();
    await new Promise((r) => setTimeout(r, 30)); // the wall clock moves on; the bar does not care
    expect(play()).toEqual(first);
    expect(first.drinks[0]).toMatchObject({ status: 'served', served: { correct: true } });
    expect(first.equipment.grinder).toBe('ok'); // repaired: its delay, sent as an event
  });
});

describe('two baristas: Jev and you', () => {
  it('each has their own hands: you grind while Jev steams', () => {
    const actor = bar(ctx({ drinks: [order()] }));
    actor.send({ type: 'barista.steamMilk', milk: 'whole', by: 'jev' });
    expect(actor.getSnapshot().can({ type: 'barista.grindBeans', by: 'jev' })).toBe(false); // Jev's hands are on the pitcher
    expect(actor.getSnapshot().can({ type: 'barista.grindBeans', by: 'you' })).toBe(true);
    actor.send({ type: 'barista.grindBeans', by: 'you' });
    expect(actor.getSnapshot().context.hands).toMatchObject({ jev: { doing: 'barista.steamMilk' }, you: { doing: 'barista.grindBeans' } });
    // One pair of hands does one thing at a time.
    expect(actor.getSnapshot().can({ type: 'barista.placeCup', spot: 'tray', by: 'you' })).toBe(false);
  });

  it('shares the equipment: you cannot take the portafilter out while Jev pulls a shot', () => {
    const actor = bar(ctx({ portafilter: 'locked', cups: [cup('c1', 'tray')] }));
    actor.send({ type: 'barista.extract', by: 'jev' });
    finishHands(actor);
    const s = actor.getSnapshot();
    expect(s.can({ type: 'barista.knockOut', by: 'you' })).toBe(false);
    expect(s.can({ type: 'barista.presentCup', cupId: 'c1', by: 'you' })).toBe(false); // the shot is going into it
    expect(s.can({ type: 'barista.placeCup', spot: 'front', by: 'you' })).toBe(true);
  });

  it("tells Jev what the other barista's hands are on", () => {
    const actor = bar(ctx({ drinks: [order()] }));
    actor.send({ type: 'barista.placeCup', spot: 'tray', by: 'you' });
    expect(serializeBar(barOf(actor.getSnapshot())).otherBarista).toBe('placeCup (cup c1)');
    expect(actor.getSnapshot().context.hands.jev).toBeNull();
  });
});

describe('a cup in the way', () => {
  // A mocha on the drip tray, ready for its milk; someone filled the front with empty cups.
  const staged = () =>
    ctx({
      drinks: [order({ drink: 'mocha' }), espresso({ id: 'd2', customerLabel: '#2', orderedAt: NOW - 4000 })],
      cups: [cup('c1', 'tray', [{ kind: 'chocolate' }, SHOT]), ...['c2', 'c3', 'c4'].map((id, slot) => ({ ...cup(id, 'front'), slot }))],
      pitcherState: 'steamed',
      pitcher: { milk: 'whole', texture: 'steamed', ml: 240 },
    });

  it('tells Jev what stands in the way, as a fact', () => {
    expect(serializeBar(staged()).queue[0].blockedBy).toBe(
      'the front of the counter is full: ' +
        ['c2', 'c3', 'c4'].map((id) => `cup ${id} (nothing), which no open order could become`).join('; '),
    );
  });

  it('tells Jev what the machine refuses right now: nothing reaches the front, and no new cup fits', async () => {
    const client = vi.fn<JevClient>(async () => ({ answers: {} }));
    await decide(snap(staged()), { ...barista, client });
    const { questions } = client.mock.calls[0][0];
    const q = (questions.action ?? questions.event_type) as { instructions: string };
    const refused = q.instructions.split('Not possible right now')[1];
    expect(refused).toMatch(/barista\.presentCup[,.]/);
    expect(refused).toMatch(/barista\.placeCup[,.]/);
  });

  it('says what serving an unfinished cup comes to', () => {
    const serve = getOptions(snap(staged()), barista).find((o) => o.id === 'barista.serve:c1');
    expect(serve?.kind === 'event' && serve.lookahead).toMatch(
      /Once done \(after 1\.0s\): queue\[0\]: \{"drinkId":"d1".*\} → \(none\); cups\[0\]: \{"cupId":"c1".*\} → \(none\); wrongServed\[0\]: \(none\) → "#1 ordered a mocha, got chocolate \+ espresso"; servedCount: 0 → 1$/,
    );
  });

  it('can put the empty cup away, or slide a cup back to a free tray', () => {
    const ids = legalIds(staged());
    expect(ids).toContain('barista.putAwayCup:c2');
    expect(ids).not.toContain('barista.dumpCup:c2'); // nothing in it to pour away
    expect(ids).not.toContain('barista.putAwayCup:c1'); // it has something in it: pour it away instead
    expect(ids).not.toContain('barista.returnCup:c2'); // the tray is taken
    const actor = bar(ctx({ drinks: [order()], cups: [cup('c2', 'front', [SHOT])] }));
    doIt(actor, { type: 'barista.returnCup', cupId: 'c2', by: 'you' });
    expect(actor.getSnapshot().context.cups).toEqual([cup('c2', 'tray', [SHOT])]);
  });
});

describe('broken machines behind a busy tray', () => {
  // The grinder and the steam wand are broken; an empty cup waits on the tray for the americano.
  const stuck = () =>
    ctx({
      drinks: [
        order({ drink: 'americano', mods: { milk: 'none', size: 'regular', decaf: true, iced: false } }),
        order({ id: 'd2', customerLabel: '#2', drink: 'latte', orderedAt: NOW - 4000 }),
      ],
      cups: [cup('c1', 'tray')],
      equipment: { grinder: 'broken', groupHead: 'ok', steamWand: 'broken' },
    });

  it('tells Jev every obstacle, the broken machines first; an earlier order on the tray is just its turn', () => {
    expect(serializeBar(stuck()).queue[1].blockedBy).toBe('the grinder is broken; the steam wand is broken');
    expect(serializeBar(stuck()).queue[0].blockedBy).toBe('the grinder is broken');
  });

  it('shows each order what blocks it on screen, the broken machine first', () => {
    const c = stuck();
    expect(c.drinks.map((d) => blockedBy(d, c))).toEqual(['Grinder broken', 'Grinder broken']);
    const fixed = { ...c, equipment: { grinder: 'ok', groupHead: 'ok', steamWand: 'ok' } } as Bar;
    expect(fixed.drinks.map((d) => blockedBy(d, fixed))).toEqual([null, null]);
  });

  it("counts a later order's cup on the tray as in the way", () => {
    const later = ctx({
      drinks: [
        order(),
        order({ id: 'd2', customerLabel: '#2', drink: 'americano', mods: { milk: 'none', size: 'regular', decaf: false, iced: false }, orderedAt: NOW - 4000 }),
      ],
      cups: [cup('c1', 'tray', [SHOT, { kind: 'water' }])],
    });
    expect(serializeBar(later).queue[0].blockedBy).toBe(
      "the drip tray is full: cup c1 (espresso + hot water), which is on its way to #2's americano",
    );
    expect(blockedBy(later.drinks[0], later)).toBe('Tray taken');
  });

});

describe('Jev as the barista', () => {
  it("reads each option in the machine's own words, and what it comes to once done", () => {
    const lookahead = (o: ReturnType<typeof getOptions>[number] | undefined) => (o?.kind === 'event' ? o.lookahead : undefined);
    const options = getOptions(snap(ctx({ drinks: [order()] })), barista);
    const grind = options.find((o) => o.id === 'barista.grindBeans');
    // The event schema's description; the hands and the grinder, then the grounds.
    expect(grind?.description).toMatch(/^grind beans into the empty portafilter: the first step of every shot/);
    expect(lookahead(grind)).toMatch(/yourHands: null → "grindBeans"/);
    expect(lookahead(grind)).toMatch(/\{"stepId":"grind_beans","resource":"grinder"\}/);
    // Its delays, sent as `xstate.after` events: the hands come free, then the grounds are in.
    expect(lookahead(grind)).toMatch(/Once done \(after 2\.5s\): portafilter: "empty" → "grounds"; inventory\.beans: 400 → 382$/);
    const pour = getOptions(
      snap(ctx({ drinks: [order()], cups: [cup('c1', 'front', [SHOT])], pitcher: { milk: 'oat', texture: 'steamed', ml: 240 }, pitcherState: 'steamed' })),
      barista,
    ).find((o) => o.id === 'barista.pourMilk:c1:180');
    // Oat milk into a whole-milk latte: once poured, the cup is no order's drink.
    expect(lookahead(pour)).toMatch(/cups\[0\]\.onTrackFor: "d1" → null/);
    // A transition's own description wins over the event's.
    const knock = getOptions(snap(ctx({ drinks: [order()], portafilter: 'tamped' })), barista).find((o) => o.id === 'barista.knockOut');
    expect(knock?.description).toMatch(/unpulled grounds .* wasted/);
    expect(options.at(-1)).toMatchObject({ kind: 'noop', id: 'noop' });
  });

  it('shows Jev the whole shot and the whole pitcher in the machine map, and what each step sets, read from the transitions', () => {
    const map = machineMap(snap(ctx()));
    for (const line of [
      'on barista.grindBeans → grinding (conditional); sets hands, inventory',
      'after grind (2.5s) → grounds',
      'on barista.tamp → tamping (conditional); sets hands',
      'after tamp (1.2s) → tamped',
      'on barista.lockIn → lockingIn (conditional); sets hands',
      'after lockIn (0.8s) → locked',
      'on barista.extract → pulling (conditional); sets hands, shotCup',
      'after pull (5.3s) → spent; sets cups, shotCup',
      'on barista.knockOut → knocking (conditional); sets hands',
      'after knockOut (1.2s) → empty',
      'on barista.steamMilk → steaming (conditional); sets hands, inventory, pitcher',
      'after steam (4.0s) → steamed',
      'on barista.foamMilk → foaming (conditional); sets hands, inventory, pitcher',
      'after foam (5.0s) → foamed',
      'on barista.pourMilk → pouring (conditional); sets hands, pour',
      // What is left in the pitcher decides where it goes.
      'after pour (1.5s) → foamed, steamed, empty (conditional); sets cups, pitcher, pour',
      // Moves on cups, stock and orders change context only, and say which.
      'on barista.placeCup → (stays); sets hands, cups, nextCupNo',
      'on barista.restock → (stays); sets hands, inventory',
    ]) {
      expect(map).toContain(line);
    }
  });

  it('serves what the orders ask for, at 10×: a cappuccino', async () => {
    const actor = openBar(ctx({ speed: 10, drinks: [order({ drink: 'cappuccino' })] }), baristaMock);
    await vi.waitFor(() => expect(actor.getSnapshot().context.drinks[0].status).toBe('served'), { timeout: 8000, interval: 50 });
    expect(actor.getSnapshot().context.drinks[0].served?.correct).toBe(true);
  }, 10_000);

  it('serves what the orders ask for, at 10×: an americano and a hot chocolate at once', async () => {
    const drinks = [
      order({ drink: 'americano', mods: { milk: 'none', size: 'regular', decaf: false, iced: false } }),
      order({ id: 'd2', customerLabel: '#2', drink: 'hot_chocolate', orderedAt: NOW - 4000 }),
    ];
    const actor = openBar(ctx({ speed: 10, drinks }), baristaMock);
    await vi.waitFor(() => expect(actor.getSnapshot().context.drinks.every((d) => d.status === 'served')).toBe(true), {
      timeout: 12_000,
      interval: 50,
    });
    expect(actor.getSnapshot().context.drinks.map((d) => d.served?.correct)).toEqual([true, true]);
  }, 14_000);

  const mockClient = baristaMock;

  /**
   * Mock answers, except the action: the first option whose id starts with
   * `prefix`. Asked flat, that is the `action` answer; asked hierarchically,
   * its type, and its variant when the type has several.
   */
  const choosing =
    (prefix: string): JevClient =>
    async (req) => {
      const res = await baristaMock(req);
      const pick = (questionId: string) => {
        const q = req.questions[questionId];
        const choice = q?.type === 'choice' ? Object.keys(q.criteria).find((k) => k.startsWith(prefix)) : undefined;
        if (choice) res.answers[questionId] = { type: 'choice', choice, confidence: 0.9, probabilities: { [choice]: 0.9 } };
        return choice;
      };
      pick('action');
      const type = pick('event_type');
      if (type) pick(`variant:${type}`);
      return res;
    };

  /** The barista's Jev agent, invoked at the top of the bar: its own state and decisions. */
  const baristaOf = (actor: ReturnType<typeof openBar>) =>
    actor.getSnapshot().children.barista!.getSnapshot() as unknown as {
      value: 'watching' | 'deciding' | 'paused';
      context: JevAgentContext<BarEvent>;
    };

  it('watches the bar, asks Jev, acts on the bar and logs the decision', async () => {
    const actor = openBar(ctx({ drinks: [order()] }), mockClient);
    await vi.waitFor(() => expect(baristaOf(actor).context.decisions).toHaveLength(1));
    const [decision] = baristaOf(actor).context.decisions;
    expect(decision).toMatchObject({ mock: true, sent: true });
    expect(decision.event?.type).toMatch(/^barista\./);
    expect(actor.getSnapshot().context.hands.jev).not.toBeNull();
  });

  it('is busy for the length of a hands-on step, then looks up again', async () => {
    const askedAt: number[] = [];
    const placing = choosing('barista.placeCup');
    const client = vi.fn<JevClient>((req) => (askedAt.push(Date.now()), placing(req)));
    // At 10x putting out a cup takes 60ms.
    const actor = openBar(ctx({ speed: 10, drinks: [order()] }), client);
    // What the barista is doing is the bar's: its hands.
    await vi.waitFor(() => expect(actor.getSnapshot().context.hands.jev?.doing).toBe('barista.placeCup'));
    expect(baristaOf(actor).context.decisions[0].option?.id).toMatch(/^barista\.placeCup/);
    expect(client).toHaveBeenCalledTimes(1); // no thinking while putting out a cup
    await vi.waitFor(() => expect(askedAt.length).toBeGreaterThanOrEqual(2));
    expect(askedAt[1] - askedAt[0]).toBeGreaterThanOrEqual(60 - 5);
  });

  it('at half pace, waits a real 2s after its hands are free, however fast the bar runs', async () => {
    const askedAt: number[] = [];
    const placing = choosing('barista.placeCup');
    const client = vi.fn<JevClient>((req) => (askedAt.push(Date.now()), placing(req)));
    const actor = openBar(ctx({ speed: 10, drinks: [order()] }), client);
    actor.getSnapshot().children.barista!.send({ type: 'jev.settle', ms: PACE_SETTLE[0.5] });
    await vi.waitFor(() => expect(askedAt.length).toBeGreaterThanOrEqual(2), { timeout: 4000 });
    // A 60ms cup at 10x, then the 2s window for a person.
    expect(askedAt[1] - askedAt[0]).toBeGreaterThanOrEqual(2000 - 5);
  }, 6000);

  it('is busy only while starting the grinder; the grinder runs on without them', async () => {
    const client = vi.fn(choosing('barista.grindBeans'));
    // At 2x: 250ms to start the grinder, then 1s of grinding on its own.
    const actor = openBar(ctx({ speed: 2, drinks: [order()] }), client);
    await vi.waitFor(() => expect(baristaOf(actor).context.decisions.length).toBeGreaterThanOrEqual(2), {
      timeout: 3000,
    });
    const [next, started] = baristaOf(actor).context.decisions; // newest first
    expect(started.option?.id).toBe('barista.grindBeans');
    // The next decision came once their hands were free, while the grinder still ran.
    expect(next.at - started.at).toBeGreaterThanOrEqual(250 - 5);
    expect(barOf(actor.getSnapshot()).portafilter).toBe('grinding');
  });

  it('after deciding to wait, does not ask Jev again until something Jev would see changes', async () => {
    const client = vi.fn(choosing('noop'));
    const actor = openBar(ctx({ speed: 10 }), client);
    actor.send({ type: 'BREAK', device: 'grinder' }); // a choice: repair it, or wait
    await vi.waitFor(() => expect(baristaOf(actor).context.decisions).toHaveLength(1));
    expect(baristaOf(actor).context.decisions[0].option?.id).toBe('noop');
    expect(client).toHaveBeenCalledTimes(1);
    await new Promise((r) => setTimeout(r, 700)); // time passes; the bar does not change
    expect(client).toHaveBeenCalledTimes(1);
    actor.send({ type: 'BREAK', device: 'steamWand' }); // a new option
    await vi.waitFor(() => expect(client).toHaveBeenCalledTimes(2));
  });

  it('flags an idle loop: Jev keeps being asked, and keeps saying wait', async () => {
    const client = vi.fn(choosing('noop'));
    const actor = openBar(ctx({ speed: 10, drinks: [order()] }), client);
    // Each speed change rewrites the hands-on times Jev reads, so every
    // request is new and none is skipped; every answer is still "wait".
    for (const [i, speed] of [5, 3, 2, 1.5].entries()) {
      await vi.waitFor(() => expect(client).toHaveBeenCalledTimes(i + 1));
      await vi.waitFor(() => expect(baristaOf(actor).value).toBe('watching'));
      expect(baristaOf(actor).context.loop).toBeNull();
      actor.send({ type: 'SET_SPEED', speed });
    }
    await vi.waitFor(() => expect(baristaOf(actor).context.loop).toMatchObject({ kind: 'idle', count: 5 }));
  });

  it("does not ask Jev while there is nothing it could do: the barista's hands are busy", async () => {
    const client = vi.fn(mockClient);
    const actor = openBar(ctx({ drinks: [order()], hands: { jev: { doing: 'barista.restock', ms: 100_000 }, you: null } }), client);
    await new Promise((r) => setTimeout(r, 450)); // time passes; only waiting is possible
    expect(client).not.toHaveBeenCalled();
    expect(baristaOf(actor).value).toBe('watching');
  });

  it('chooses in one question: even a busy bar has few enough moves', async () => {
    const client = vi.fn<JevClient>(baristaMock);
    const actor = openBar(ctx({ drinks: [order()] }), client);
    await vi.waitFor(() => expect(baristaOf(actor).context.decisions).toHaveLength(1));
    const [decision] = baristaOf(actor).context.decisions;
    expect(decision.strategy).toBe('flat');
    expect(['barista.grindBeans', 'barista.placeCup:tray', 'barista.steamMilk:whole']).toContain(decision.option?.id);
    // A cup on the tray and three at the front, each with a shot.
    const busy = ctx({
      drinks: [order(), order({ id: 'd2', customerLabel: '#2', drink: 'cappuccino', orderedAt: NOW - 4000 })],
      cups: [cup('c1', 'tray', [SHOT]), ...['c2', 'c3', 'c4'].map((id, slot) => ({ ...cup(id, 'front', [SHOT]), slot }))],
    });
    expect(legalIds(busy).length).toBeLessThanOrEqual(32);
  });

  it('starts over with the bar on RESET', async () => {
    const actor = openBar(ctx({ drinks: [order()] }), mockClient);
    await vi.waitFor(() => expect(baristaOf(actor).context.decisions).toHaveLength(1));
    actor.send({ type: 'RESET' });
    expect(baristaOf(actor).context.decisions).toHaveLength(0);
  });

  it('stops asking Jev while paused, and starts again on resume', async () => {
    const client = vi.fn<JevClient>(baristaMock);
    const actor = openBar(ctx({ drinks: [order()] }), client);
    const b = actor.getSnapshot().children.barista!;
    b.send({ type: 'jev.pause' });
    await new Promise((r) => setTimeout(r, 400));
    expect(client).not.toHaveBeenCalled();
    expect((b.getSnapshot() as { value: unknown }).value).toBe('paused');
    b.send({ type: 'jev.resume' });
    await vi.waitFor(() => expect(client).toHaveBeenCalledTimes(1));
  });
});

describe('working the bar by hand', () => {
  const at = (spot: Parameters<typeof spotAction>[0], c: Bar, selected?: string) => {
    const s = snap(c);
    return spotAction(spot, c, (e) => s.can({ ...e, by: 'you' }), selected);
  };

  it('does what the cup there needs next for its order, and offers everything else possible there', () => {
    const tray = at('tray', ctx({ drinks: [order()], cups: [cup('c1', 'tray', [SHOT])] }));
    expect(tray.event).toEqual({ type: 'barista.presentCup', cupId: 'c1' });
    // Serving it now is possible too (a wrong drink, which is not said).
    expect(tray.others).toContainEqual({ event: { type: 'barista.serve', cupId: 'c1' }, label: 'Serve · #1 Latte' });
    expect(at('portafilter', ctx({ drinks: [order()], portafilter: 'grounds' })).event).toEqual({ type: 'barista.tamp' });
  });

  it('lets you, and only you, break a working machine', () => {
    expect(at('grinder', ctx()).breaks).toBe('grinder');
    expect(at('jug', ctx()).breaks).toBe('steamWand');
    expect(at('grinder', ctx({ equipment: { grinder: 'broken', groupHead: 'ok', steamWand: 'ok' } })).breaks).toBeUndefined();
    expect(at('tray', ctx()).breaks).toBeUndefined();
    // Not a barista's move: Jev is never offered it.
    expect(legalIds(ctx({ drinks: [order()] })).some((id) => id.startsWith('BREAK'))).toBe(false);
  });

  it('steams for the picked order first', () => {
    const drinks = [order(), order({ id: 'd2', customerLabel: '#2', drink: 'cortado', mods: { milk: 'oat', size: 'regular', decaf: false, iced: false } })];
    expect(at('steam', ctx({ drinks }), 'd2').event).toEqual({ type: 'barista.steamMilk', milk: 'oat' });
    // With no orders, the wand still steams: any milk, whole by default.
    const idleSteam = at('steam', ctx());
    expect(idleSteam.event).toEqual({ type: 'barista.steamMilk', milk: 'whole' });
    // A cappuccino's milk is foamed: that is the click.
    expect(at('steam', ctx({ drinks: [order({ drink: 'cappuccino' })] })).event).toEqual({ type: 'barista.foamMilk', milk: 'whole' });
    // Other milks are one word each.
    expect(idleSteam.others).toContainEqual(expect.objectContaining({ label: 'oat', short: true }));
  });

  it('says why nothing happens, unless all there is to do is break it', () => {
    // A working steam wand with milk in the pitcher it cannot use: only "Break it".
    expect(at('water', ctx({ drinks: [order()] }))).toMatchObject({ event: null, label: 'Nothing to do' });
    expect(at('brew', ctx({ drinks: [order()] }))).toMatchObject({ event: null, label: '', breaks: 'groupHead' });
    expect(at('grinder', ctx({ drinks: [order()], hands: { jev: null, you: { doing: 'barista.tamp', ms: 5000 } } }))).toMatchObject({
      event: null,
      label: 'Hands busy',
    });
    const broken = ctx({ drinks: [order()], equipment: { grinder: 'ok', groupHead: 'broken', steamWand: 'ok' } });
    expect(at('brew', broken).event).toEqual({ type: 'barista.repair', device: 'groupHead' });
    expect(at('portafilter', broken).event).toEqual({ type: 'barista.grindBeans' });
    expect(at('portafilter', { ...broken, drinks: [] }).event).toEqual({ type: 'barista.grindBeans' });
  });
});

describe('Jev as the order router', () => {
  const pendingOrder: ParsedOrder = {
    items: [{ drink: 'latte', qty: 1, milk: 'oat', decaf: false, iced: false }],
    intent: 'order',
    confidence: 0.4,
    latencyMs: 1,
    raw: {},
  };

  /**
   * A freshly started bar (so the router is invoked, with Jev's mock called
   * in-process) that read an order back and waits for the customer's reply.
   */
  async function clarifyingBar() {
    const machine = espressoBarMachine.provide({
      actors: {
        chaos: silent,
        barista: silent,
        parseOrderActor: createAsyncLogic<ParsedOrder, { text: string }>({ run: async () => pendingOrder }),
        orderRouterAgent: createJevLogic<BarEvent, BarContext>({
          ...orderRouter,
          client: async (req) => mockAnswers(req, routerMockScore),
        }),
      },
    });
    const actor = createActor(machine, { input: ctx() }).start();
    running.push(actor);
    actor.send({ type: 'order.submit', text: 'an oat latte, maybe', at: 0 });
    await vi.waitFor(() => expect(actor.getSnapshot().matches({ intake: { clarifying: 'asking' } })).toBe(true));
    return actor;
  }

  it('routes a yes to order.confirm', async () => {
    const actor = await clarifyingBar();
    actor.send({ type: 'order.reply', text: 'yes, that is right' });
    await vi.waitFor(() => expect(actor.getSnapshot().matches({ intake: 'idle' })).toBe(true));
    expect(actor.getSnapshot().context.drinks.map((d) => d.drink)).toEqual(['latte']);
  });

  it('routes a no to order.cancel', async () => {
    const actor = await clarifyingBar();
    actor.send({ type: 'order.reply', text: 'no, wrong drink' });
    await vi.waitFor(() => expect(actor.getSnapshot().matches({ intake: 'idle' })).toBe(true));
    expect(actor.getSnapshot().context.drinks).toHaveLength(0);
  });

  it('asks again when the reply answers neither way', async () => {
    const actor = await clarifyingBar();
    actor.send({ type: 'order.reply', text: 'what is the wifi password' });
    await vi.waitFor(() =>
      expect(actor.getSnapshot().matches({ intake: { clarifying: 'asking' } })).toBe(true),
    );
    expect(actor.getSnapshot().context.error).toBeTruthy();
  });
});
