import { describe, expect, it } from 'vitest';
import {
  answersToParsedOrder,
  buildParseQuestions,
  parseRequest,
  qId,
  splitPhrases,
  type Answers,
} from './jev-core';

const noul = (n: number) => ({ type: 'noul' as const, noul: n });
const choice = (c: string, probabilities: Record<string, number>, confidence: number) => ({
  type: 'choice' as const,
  choice: c,
  probabilities,
  confidence,
});

/** `count` phrases that order no drink, every modifier unstated — a blank slate to layer on. */
function blank(count: number): Answers {
  const a: Answers = {
    [qId.intent]: choice('order', { order: 0.95, cancel: 0.02, question: 0.02, other: 0.01 }, 0.93),
  };
  for (let i = 0; i < count; i++) {
    a[qId.drink(i)] = choice('none', { none: 0.95, latte: 0.05 }, 0.94);
    a[qId.qty(i)] = choice('1', { '1': 0.9, '2': 0.07, '3': 0.03 }, 0.85);
    a[qId.milk(i)] = choice('whole', { whole: 0.8, oat: 0.1, almond: 0.05, soy: 0.03, none: 0.02 }, 0.75);
    a[qId.milkStated(i)] = noul(0.05);
    a[qId.size(i)] = choice('regular', { small: 0.1, regular: 0.85, large: 0.05 }, 0.8);
    a[qId.sizeStated(i)] = noul(0.05);
    a[qId.decaf(i)] = noul(0.03);
    a[qId.iced(i)] = noul(0.03);
    if (i > 0) a[qId.detail(i)] = noul(0.03);
  }
  return a;
}

describe('splitPhrases', () => {
  it('splits on commas, "and", "plus" and "also"', () => {
    expect(splitPhrases('a cap with almond milk and an espresso, plus a cap with whole milk')).toEqual([
      'a cap with almond milk',
      'an espresso',
      'a cap with whole milk',
    ]);
  });

  it('keeps an order with nothing to split on as one phrase', () => {
    expect(splitPhrases('a large oat latte')).toEqual(['a large oat latte']);
  });

  it('does not split inside words ("candy", "brand")', () => {
    expect(splitPhrases('a brandy-free latte')).toEqual(['a brandy-free latte']);
  });
});

describe('parseRequest', () => {
  it('puts the phrases in the state and asks about each by its path', () => {
    const { phrases, state, questions } = parseRequest('a cap with almond milk and an espresso');
    expect(phrases).toHaveLength(2);
    expect(state.phrases).toEqual({ p1: 'a cap with almond milk', p2: 'an espresso' });
    expect((questions[qId.milk(1)] as { instructions: string }).instructions).toContain('`phrases.p2`');
  });
});

describe('answersToParsedOrder', () => {
  it('maps answers to one item per phrase and only keeps stated modifiers', () => {
    const a = blank(3);
    a[qId.drink(0)] = choice('cappuccino', { cappuccino: 0.9, none: 0.1 }, 0.88);
    a[qId.milkStated(0)] = noul(0.92);
    a[qId.milk(0)] = choice('almond', { whole: 0.05, oat: 0.05, almond: 0.85, soy: 0.03, none: 0.02 }, 0.82);
    a[qId.drink(1)] = choice('espresso', { espresso: 0.9, none: 0.1 }, 0.88);
    a[qId.qty(1)] = choice('2', { '1': 0.15, '2': 0.8, '3': 0.05 }, 0.76);
    a[qId.drink(2)] = choice('cappuccino', { cappuccino: 0.9, none: 0.1 }, 0.88);
    a[qId.milkStated(2)] = noul(0.9);
    a[qId.milk(2)] = choice('whole', { whole: 0.9, oat: 0.05, almond: 0.03, soy: 0.01, none: 0.01 }, 0.86);

    const parsed = answersToParsedOrder(a, 3, { latencyMs: 42 });
    expect(parsed.intent).toBe('order');
    expect(parsed.items).toEqual([
      { drink: 'cappuccino', qty: 1, milk: 'almond', size: undefined, decaf: false, iced: false },
      { drink: 'espresso', qty: 2, milk: undefined, size: undefined, decaf: false, iced: false },
      { drink: 'cappuccino', qty: 1, milk: 'whole', size: undefined, decaf: false, iced: false },
    ]);
    expect(parsed.latencyMs).toBe(42);
  });

  it('takes confidence as the minimum over the judgments it used', () => {
    const a = blank(1);
    a[qId.drink(0)] = choice('latte', { latte: 0.95, none: 0.05 }, 0.9);
    a[qId.qty(0)] = choice('1', { '1': 0.6, '2': 0.3, '3': 0.1 }, 0.41); // the weak link
    const parsed = answersToParsedOrder(a, 1, { latencyMs: 1 });
    expect(parsed.confidence).toBe(0.41);
    expect(parsed.confidence).toBeLessThan(0.5); // -> routes to the clarify state
  });

  it('drops phrases that order no drink', () => {
    expect(answersToParsedOrder(blank(2), 2, { latencyMs: 1 }).items).toEqual([]);
  });

  it('builds one question per phrase modifier, a detail question per later phrase, and the intent', () => {
    expect(Object.keys(buildParseQuestions(3))).toHaveLength(3 * 8 + 2 + 1);
  });
});

describe('detail phrases', () => {
  /** "two caps, one almond and one whole": phrase 1 orders, phrases 2 and 3 add details. */
  function twoCaps(): Answers {
    const a = blank(3);
    a[qId.drink(0)] = choice('cappuccino', { cappuccino: 0.9, none: 0.1 }, 0.88);
    a[qId.qty(0)] = choice('2', { '1': 0.05, '2': 0.9, '3': 0.05 }, 0.86);
    for (const [i, milk] of [[1, 'almond'], [2, 'whole']] as const) {
      a[qId.detail(i)] = noul(0.9);
      a[qId.drink(i)] = choice('cappuccino', { cappuccino: 0.6, none: 0.4 }, 0.3); // ignored: it is a detail
      a[qId.milkStated(i)] = noul(0.9);
      a[qId.milk(i)] = choice(milk, { [milk]: 0.9, oat: 0.1 }, 0.85);
    }
    return a;
  }

  it('splits the earlier drink into one cup per detail', () => {
    const parsed = answersToParsedOrder(twoCaps(), 3, { latencyMs: 1 });
    expect(parsed.items).toEqual([
      { drink: 'cappuccino', qty: 1, milk: 'almond', size: undefined, decaf: false, iced: false },
      { drink: 'cappuccino', qty: 1, milk: 'whole', size: undefined, decaf: false, iced: false },
    ]);
    expect(parsed.confidence).toBeGreaterThanOrEqual(0.5);
  });

  it('keeps the cups no detail covers as the drink was ordered', () => {
    const a = twoCaps();
    a[qId.qty(0)] = choice('3', { '1': 0.05, '2': 0.05, '3': 0.9 }, 0.86);
    const parsed = answersToParsedOrder(a, 3, { latencyMs: 1 });
    expect(parsed.items.map((i) => [i.qty, i.milk])).toEqual([
      [1, 'almond'],
      [1, 'whole'],
      [1, undefined],
    ]);
  });

  it('adds a detail to a single drink without asking how many it covers', () => {
    const a = blank(2);
    a[qId.drink(0)] = choice('americano', { americano: 0.9, none: 0.1 }, 0.88);
    a[qId.detail(1)] = noul(0.9);
    a[qId.qty(1)] = choice('3', { '1': 0.3, '2': 0.3, '3': 0.4 }, 0.1); // not read
    a[qId.sizeStated(1)] = noul(0.9);
    a[qId.size(1)] = choice('large', { small: 0.05, regular: 0.05, large: 0.9 }, 0.86);
    const parsed = answersToParsedOrder(a, 2, { latencyMs: 1 });
    expect(parsed.items).toEqual([{ drink: 'americano', qty: 1, milk: undefined, size: 'large', decaf: false, iced: false }]);
    expect(parsed.confidence).toBeGreaterThanOrEqual(0.5);
  });

  it('is unsure when details describe more cups than were ordered', () => {
    const a = twoCaps();
    a[qId.qty(0)] = choice('1', { '1': 0.9, '2': 0.05, '3': 0.05 }, 0.86);
    expect(answersToParsedOrder(a, 3, { latencyMs: 1 }).confidence).toBe(0);
  });

  it('covers cups of earlier drinks too when it covers more than one ("both large")', () => {
    const a = blank(3);
    a[qId.drink(0)] = choice('latte', { latte: 0.95, none: 0.05 }, 0.94);
    a[qId.drink(1)] = choice('mocha', { mocha: 0.95, none: 0.05 }, 0.94);
    a[qId.detail(2)] = noul(0.95);
    a[qId.qty(2)] = choice('2', { '1': 0.02, '2': 0.97, '3': 0.01 }, 0.96);
    a[qId.sizeStated(2)] = noul(0.95);
    a[qId.size(2)] = choice('large', { small: 0.01, regular: 0.01, large: 0.98 }, 0.97);
    const parsed = answersToParsedOrder(a, 3, { latencyMs: 1 });
    expect(parsed.items.map((i) => [i.drink, i.size])).toEqual([
      ['latte', 'large'],
      ['mocha', 'large'],
    ]);
  });

  it('takes a phrase with no drink that states a modifier as a detail, even if Jev is unsure it is one', () => {
    const a = twoCaps();
    a[qId.detail(2)] = noul(0.45); // "one whole": just under the midpoint
    a[qId.drink(2)] = choice('none', { none: 0.55, cappuccino: 0.45 }, 0.49);
    const parsed = answersToParsedOrder(a, 3, { latencyMs: 1 });
    expect(parsed.items.map((i) => i.milk)).toEqual(['almond', 'whole']);
    expect(parsed.confidence).toBe(0.49); // read back: Jev was unsure
  });

  it('drops a detail with no drink before it', () => {
    const a = blank(2);
    a[qId.detail(1)] = noul(0.9);
    expect(answersToParsedOrder(a, 2, { latencyMs: 1 }).items).toEqual([]);
  });
});
