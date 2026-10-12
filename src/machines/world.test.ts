import { mockAnswers, NOOP_ID, type JevClient, type JevRequest } from '@xstate/jev';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DRINK_IDS } from '../lib/recipes';
import { stockOf } from '../lib/legal';
import type { ModelId } from '../lib/models';
import { WorldClock } from '../lib/worldClock';
import { createCafe, onClock } from './cafe';
import { createWorld, rollMayhem } from './world';

/* ------------------------------------------------------------ fake models -- */

/** A parse that finds every drink named in what the customer said, as sure as `sure` (0.5–1). */
function parser(sure = 0.99, delayMs = 0): JevClient {
  return async (request: JevRequest) => {
    if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
    const said = String((request.state as { customer_said: string }).customer_said);
    const answers: Record<string, unknown> = { intent: { type: 'choice', choice: 'order', confidence: 0.99, probabilities: {} } };
    for (const d of DRINK_IDS) {
      answers[`${d}_present`] = { type: 'noul', noul: said.includes(d) ? sure : 0.01 };
      answers[`${d}_qty`] = { type: 'choice', choice: '1', confidence: 0.99, probabilities: {} };
      for (const q of ['milk_stated', 'size_stated', 'decaf', 'iced']) answers[`${d}_${q}`] = { type: 'noul', noul: 0.01 };
    }
    return { answers } as never;
  };
}

/** A barista that always waits: nothing it does gets in the way of what is being tested. */
const idle: JevClient = async (request) => mockAnswers(request, ({ option }) => (option === NOOP_ID ? 50 : 0));

/** A router that confirms on "yes". */
const router: JevClient = async (request) =>
  mockAnswers(request, ({ option, state }) => {
    const reply = String((state as { reply?: unknown }).reply ?? '');
    return option === 'order.confirm' ? (/yes/.test(reply) ? 50 : 0) : 0;
  });

function world(parsers: Partial<Record<ModelId, JevClient>>, seed = 1) {
  const models = Object.keys(parsers) as ModelId[];
  const w = createWorld({
    models,
    seed,
    cafe: (model) => createCafe((kind) => (kind === 'parse' ? parsers[model]! : kind === 'router' ? router : idle)),
  });
  w.actor.start();
  // No mayhem unless a test asks for it.
  for (const device of ['grinder', 'groupHead', 'steamWand'] as const) w.actor.send({ type: 'SET_BREAK_PROB', device, prob: 0 });
  w.actor.send({ type: 'SET_EMPTY_PROB', prob: 0 });
  const cafe = (model: ModelId) => w.actor.getSnapshot().context.cafes[model].getSnapshot();
  return { ...w, cafe };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

/* ------------------------------------------------------------------ tests -- */

describe('mayhem', () => {
  const levels = { grinder: 0.3, groupHead: 0.3, steamWand: 0.3 };
  const day = (seed: number) => {
    let rng = seed;
    return Array.from({ length: 200 }, () => {
      const rolled = rollMayhem(rng, levels, 0.3);
      rng = rolled.rng;
      return rolled.mayhem;
    });
  };

  it('replays the same day from the same seed', () => {
    expect(day(42)).toEqual(day(42));
    expect(day(42)).not.toEqual(day(43));
  });

  it('breaks the same part in every café at the same instant', async () => {
    const w = world({ jev: parser(), kev: parser() });
    w.actor.send({ type: 'SET_BREAK_PROB', device: 'grinder', prob: 1 });
    await vi.advanceTimersByTimeAsync(999);
    expect(w.cafe('jev').value).toMatchObject({ equipment: { grinder: 'ok' } });
    await vi.advanceTimersByTimeAsync(1);
    expect(w.cafe('jev').value).toMatchObject({ equipment: { grinder: 'broken' } });
    expect(w.cafe('kev').value).toMatchObject({ equipment: { grinder: 'broken' } });
  });

  it('empties the same ingredient in every café, even an empty one', async () => {
    const w = world({ jev: parser(), kev: parser() });
    w.actor.send({ type: 'SET_EMPTY_PROB', prob: 1 });
    await vi.advanceTimersByTimeAsync(3000);
    const emptied = (model: ModelId) => {
      const { inventory } = w.cafe(model).context;
      return ['beans', 'water', 'chocolate', 'whole', 'oat', 'almond', 'soy', 'half'].filter((i) => stockOf(inventory, i as never) === 0);
    };
    expect(emptied('jev').length).toBeGreaterThan(0);
    expect(emptied('kev')).toEqual(emptied('jev'));
  });
});

describe('orders', () => {
  it('reach every café, each parsing them with its own model, timed from when they were placed', async () => {
    const w = world({ jev: parser(), kev: parser(0.99, 2000) });
    await vi.advanceTimersByTimeAsync(500);
    const placed = w.clock.now();
    w.actor.send({ type: 'order.submit', text: 'a latte' });
    w.actor.send({ type: 'order.submit', text: 'a mocha' });
    await vi.advanceTimersByTimeAsync(100);
    expect(w.cafe('jev').context.drinks.map((d) => d.drink)).toEqual(['latte', 'mocha']);
    // The slow parser has not got to either yet; it takes them one after the other.
    expect(w.cafe('kev').context.drinks).toEqual([]);
    await vi.advanceTimersByTimeAsync(2000);
    expect(w.cafe('kev').context.drinks.map((d) => d.drink)).toEqual(['latte']);
    await vi.advanceTimersByTimeAsync(2000);
    const drinks = (model: ModelId) => w.cafe(model).context.drinks.map(({ drink, orderedAt, orderText }) => ({ drink, orderedAt, orderText }));
    expect(drinks('kev')).toEqual(drinks('jev'));
    expect(drinks('jev')).toEqual([
      { drink: 'latte', orderedAt: placed, orderText: 'a latte' },
      { drink: 'mocha', orderedAt: placed, orderText: 'a mocha' },
    ]);
  });

  it('stops the world while any café asks the customer to confirm, and records that it asked', async () => {
    const w = world({ jev: parser(), kev: parser(0.6) });
    w.actor.send({ type: 'order.submit', text: 'a latte' });
    await vi.advanceTimersByTimeAsync(10);
    expect(w.cafe('kev').matches({ intake: 'clarifying' })).toBe(true);
    expect(w.clock.paused).toBe(true);
    expect(w.actor.getSnapshot().context.clarifications).toEqual([{ model: 'kev', at: expect.any(Number), text: 'a latte' }]);

    // Mayhem stands still with everything else.
    w.actor.send({ type: 'SET_BREAK_PROB', device: 'grinder', prob: 1 });
    const frozen = w.clock.now();
    await vi.advanceTimersByTimeAsync(5000);
    expect(w.clock.now()).toBe(frozen);
    expect(w.cafe('jev').value).toMatchObject({ equipment: { grinder: 'ok' } });

    w.actor.send({ type: 'order.reply', model: 'kev', text: 'yes' });
    await vi.advanceTimersByTimeAsync(10);
    expect(w.clock.paused).toBe(false);
    expect(w.cafe('kev').context.drinks.map((d) => d.drink)).toEqual(['latte']);
    await vi.advanceTimersByTimeAsync(1000);
    expect(w.cafe('jev').value).toMatchObject({ equipment: { grinder: 'broken' } });
  });
});

describe('onClock', () => {
  it('lands an answer as long after asking as it took, in world time', async () => {
    const clock = new WorldClock();
    const slow: JevClient = () => new Promise((resolve) => setTimeout(() => resolve({ answers: {} }), 500));
    let landed = false;
    void onClock(slow, clock)({ state: {}, questions: {} }).then(() => (landed = true));
    await vi.advanceTimersByTimeAsync(100);
    clock.pause();
    // The answer comes back during the pause: it waits out the 400ms it still had to go once the world moves.
    await vi.advanceTimersByTimeAsync(5000);
    expect(landed).toBe(false);
    clock.resume();
    await vi.advanceTimersByTimeAsync(399);
    expect(landed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(landed).toBe(true);
  });
});
