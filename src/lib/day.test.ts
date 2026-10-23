import { describe, expect, it } from 'vitest';
import { DAY, generateDay, readRight, type DayOrder } from './day';

const ordersOf = (seed: number) => generateDay(seed).flatMap((e) => (e.type === 'order' ? [e.order] : []));

describe('a day', () => {
  it('is the same day from the same seed, and another from another', () => {
    expect(generateDay(42)).toEqual(generateDay(42));
    expect(generateDay(42)).not.toEqual(generateDay(43));
  });

  it('has its customers, breakdowns and run-outs, in time order, within the day', () => {
    for (const seed of [1, 2, 3, 99, 12345]) {
      const day = generateDay(seed);
      expect(day.filter((e) => e.type === 'order')).toHaveLength(DAY.orders);
      expect(day.filter((e) => e.type === 'break')).toHaveLength(DAY.breaks);
      expect(day.filter((e) => e.type === 'runOut')).toHaveLength(DAY.runOuts);
      expect(day.map((e) => e.at)).toEqual([...day.map((e) => e.at)].sort((a, b) => a - b));
      expect(Math.max(...day.filter((e) => e.type === 'order').map((e) => e.at))).toBeLessThanOrEqual(DAY.lastOrderAt);
    }
  });

  it('words every order differently', () => {
    for (const seed of [1, 2, 3]) {
      const texts = ordersOf(seed).map((o) => o.text);
      expect(new Set(texts).size).toBe(texts.length);
    }
  });

  it('prints what it reads like', () => {
    // Not an assertion: a look at the wording, kept honest by snapshot.
    expect(ordersOf(7).map((o) => o.text)).toMatchSnapshot();
  });
});

describe('readRight', () => {
  const order: DayOrder = { id: 'o1', text: 'a large oat latte and an espresso', items: [{ drink: 'latte', qty: 1, milk: 'oat', size: 'large' }, { drink: 'espresso', qty: 1 }] };
  const item = { decaf: false, iced: false };

  it('takes the same drinks, in any order, with unsaid milk and size as the bar would make them', () => {
    expect(readRight({ intent: 'order', items: [{ drink: 'espresso', qty: 1, ...item }, { drink: 'latte', qty: 1, milk: 'oat', size: 'large', ...item }] }, order)).toBe(true);
    const plain: DayOrder = { id: 'o2', text: 'a latte', items: [{ drink: 'latte', qty: 1 }] };
    expect(readRight({ intent: 'order', items: [{ drink: 'latte', qty: 1, milk: 'whole', size: 'regular', ...item }] }, plain)).toBe(true);
  });

  it('refuses a wrong milk, size, count, drink, or something that is not an order', () => {
    const latte = { drink: 'latte' as const, qty: 1, milk: 'oat' as const, size: 'large' as const, ...item };
    const espresso = { drink: 'espresso' as const, qty: 1, ...item };
    expect(readRight({ intent: 'order', items: [{ ...latte, milk: 'soy' }, espresso] }, order)).toBe(false);
    expect(readRight({ intent: 'order', items: [{ ...latte, size: undefined }, espresso] }, order)).toBe(false);
    expect(readRight({ intent: 'order', items: [{ ...latte, qty: 2 }, espresso] }, order)).toBe(false);
    expect(readRight({ intent: 'order', items: [latte] }, order)).toBe(false);
    expect(readRight({ intent: 'question', items: [latte, espresso] }, order)).toBe(false);
  });
});
