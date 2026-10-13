import { mockAnswers, NOOP_ID, type JevClient, type JevRequest } from '@xstate/jev';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateDay, type DayItem } from '../lib/day';
import { DRINK_IDS } from '../lib/recipes';
import { WorldClock } from '../lib/worldClock';
import { createCafe, onClock } from './cafe';
import { CLOSING_MS, createDay, NO, TRIES, YES } from './day';

/* ------------------------------------------------------------ fake models -- */

const SEED = 7;
const day = generateDay(SEED);
const meant = new Map(day.flatMap((e) => (e.type === 'order' ? [[e.order.text, e.order.items] as const] : [])));
const firstOrder = day.find((e) => e.type === 'order')!;
const firstBreak = day.find((e) => e.type === 'break')!;

/** A parse that reads what the customer meant (or, `wrong`, the first drink as an espresso), as sure as `sure`. */
function parser({ sure = 0.99, wrong = false } = {}): JevClient {
  return async (request: JevRequest) => {
    const said = String((request.state as { customer_said: string }).customer_said);
    let items: DayItem[] = meant.get(said) ?? [];
    if (wrong) items = [{ ...items[0], drink: items[0].drink === 'espresso' ? 'americano' : 'espresso', milk: undefined }, ...items.slice(1)];
    const confidence = { type: 'choice', confidence: 0.99, probabilities: {} };
    const answers: Record<string, unknown> = { intent: { ...confidence, choice: 'order' } };
    for (const d of DRINK_IDS) {
      const item = items.find((i) => i.drink === d);
      answers[`${d}_present`] = { type: 'noul', noul: item ? sure : 0.01 };
      answers[`${d}_qty`] = { ...confidence, choice: String(item?.qty ?? 1) };
      answers[`${d}_milk_stated`] = { type: 'noul', noul: item?.milk ? 0.99 : 0.01 };
      answers[`${d}_milk`] = { ...confidence, choice: item?.milk ?? 'whole' };
      answers[`${d}_size_stated`] = { type: 'noul', noul: item?.size ? 0.99 : 0.01 };
      answers[`${d}_size`] = { ...confidence, choice: item?.size ?? 'regular' };
      answers[`${d}_decaf`] = { type: 'noul', noul: 0.01 };
      answers[`${d}_iced`] = { type: 'noul', noul: 0.01 };
    }
    return { answers } as never;
  };
}

/** A barista that always waits: nothing it does gets in the way of what is being tested. */
const idle: JevClient = async (request) => mockAnswers(request, ({ option }) => (option === NOOP_ID ? 50 : 0));

/** A router that confirms a yes and cancels a no. */
const router: JevClient = async (request) =>
  mockAnswers(request, ({ option, state }) => {
    const reply = String((state as { reply?: unknown }).reply ?? '');
    if (option === 'order.confirm') return reply === YES ? 50 : 0;
    if (option === 'order.cancel') return reply === NO ? 50 : 0;
    return 0;
  });

function run(parse: JevClient) {
  const d = createDay({ model: 'jev', seed: SEED, cafe: createCafe((kind) => (kind === 'parse' ? parse : kind === 'router' ? router : idle), { ownChaos: false }) });
  d.actor.start();
  const bar = () => d.actor.getSnapshot().context.cafe.getSnapshot();
  const customer = (n: number) => d.actor.getSnapshot().context.customers[n];
  return { ...d, bar, customer };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

/* ------------------------------------------------------------------ tests -- */

describe('the day', () => {
  it('sends each customer and each breakdown at its time', async () => {
    const d = run(parser());
    await vi.advanceTimersByTimeAsync(firstOrder.at - 1);
    expect(d.actor.getSnapshot().context.customers).toEqual([]);
    await vi.advanceTimersByTimeAsync(10);
    expect(d.bar().context.drinks.map((x) => x.orderText)).toContain(firstOrder.type === 'order' && firstOrder.order.text);
    expect(d.customer(0).status).toBe('in');

    await vi.advanceTimersByTimeAsync(firstBreak.at - firstOrder.at - 20);
    expect(d.bar().value).toMatchObject({ equipment: { [firstBreak.type === 'break' ? firstBreak.device : '']: 'ok' } });
    await vi.advanceTimersByTimeAsync(20);
    expect(d.bar().value).toMatchObject({ equipment: { [firstBreak.type === 'break' ? firstBreak.device : '']: 'broken' } });
  });

  it('runs on bar time: at 10× the same day comes 10× sooner', async () => {
    const d = run(parser());
    d.actor.send({ type: 'SET_SPEED', speed: 10 });
    await vi.advanceTimersByTimeAsync(firstBreak.at / 10 + 10);
    expect(d.bar().value).toMatchObject({ equipment: { [firstBreak.type === 'break' ? firstBreak.device : '']: 'broken' } });
    expect(d.bar().context.speed).toBe(10);
  });

  it('closes once everyone has come in and the bar has had its time', async () => {
    const d = run(parser());
    await vi.advanceTimersByTimeAsync(day[day.length - 1].at + CLOSING_MS + 10);
    expect(d.actor.getSnapshot().value).toBe('closed');
    expect(d.actor.getSnapshot().context.customers).toHaveLength(12);
  });
});

describe('the customer', () => {
  it('says yes when the bar asks about an order it read right, and the day stands still while it asks', async () => {
    const d = run(parser({ sure: 0.6 }));
    let paused = false;
    d.actor.getSnapshot().context.cafe.subscribe(() => (paused ||= d.clock.paused));
    await vi.advanceTimersByTimeAsync(firstOrder.at + 10);
    expect(paused).toBe(true);
    expect(d.clock.paused).toBe(false);
    expect(d.customer(0)).toMatchObject({ status: 'in', tries: 1 });
    expect(d.customer(0).reads.map(({ right, asked }) => ({ right, asked }))).toEqual([{ right: true, asked: true }]);
  });

  it('says no to a wrong read, says it again, and walks out after trying twice', async () => {
    const d = run(parser({ sure: 0.6, wrong: true }));
    await vi.advanceTimersByTimeAsync(firstOrder.at + 10);
    expect(d.customer(0)).toMatchObject({ status: 'walked', tries: TRIES });
    expect(d.customer(0).reads.map(({ right, asked }) => ({ right, asked }))).toEqual([
      { right: false, asked: true },
      { right: false, asked: true },
    ]);
    expect(d.bar().context.drinks).toEqual([]);
  });

  it('takes a wrong read the bar was sure of: it goes in, and the record says it was wrong', async () => {
    const d = run(parser({ wrong: true }));
    await vi.advanceTimersByTimeAsync(firstOrder.at + 10);
    expect(d.customer(0)).toMatchObject({ status: 'in', tries: 1 });
    expect(d.customer(0).reads.map(({ right, asked }) => ({ right, asked }))).toEqual([{ right: false, asked: false }]);
  });
});

describe('onClock', () => {
  it('lands an answer as long after asking as it took, in day time', async () => {
    const clock = new WorldClock();
    const slow: JevClient = () => new Promise((resolve) => setTimeout(() => resolve({ answers: {} }), 500));
    let landed = false;
    void onClock(slow, clock)({ state: {}, questions: {} }).then(() => (landed = true));
    await vi.advanceTimersByTimeAsync(100);
    clock.pause();
    // The answer comes back during the pause: it waits out the 400ms it still had to go once the day moves.
    await vi.advanceTimersByTimeAsync(5000);
    expect(landed).toBe(false);
    clock.resume();
    await vi.advanceTimersByTimeAsync(399);
    expect(landed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(landed).toBe(true);
  });
});
