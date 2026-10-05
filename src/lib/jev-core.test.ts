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
    if (i > 0) a[qId.about(i)] = choice('none', { none: 0.9, new: 0.1 }, 0.88);
    a[qId.drink(i)] = choice('none', { none: 0.95, latte: 0.05 }, 0.94);
    a[qId.qty(i)] = choice('1', { '1': 0.9, '2': 0.07, '3': 0.03 }, 0.85);
    a[qId.milk(i)] = choice('whole', { whole: 0.8, oat: 0.1, almond: 0.05, soy: 0.03, none: 0.02 }, 0.75);
    a[qId.milkStated(i)] = noul(0.05);
    a[qId.size(i)] = choice('regular', { small: 0.1, regular: 0.85, large: 0.05 }, 0.8);
    a[qId.sizeStated(i)] = noul(0.05);
    a[qId.decaf(i)] = noul(0.03);
    a[qId.iced(i)] = noul(0.03);
  }
  return a;
}

/** Phrase i orders `drink`, `qty` of them. */
function orders(a: Answers, i: number, drink: string, qty = '1'): void {
  if (i > 0) a[qId.about(i)] = choice('new', { new: 0.9, none: 0.1 }, 0.88);
  a[qId.drink(i)] = choice(drink, { [drink]: 0.95, none: 0.05 }, 0.94);
  a[qId.qty(i)] = choice(qty, { [qty]: 0.9 }, 0.86);
}

/** Phrase i only adds a detail to the drinks of `about` (`p1`, `p2`, …, or `all`). */
function detail(a: Answers, i: number, about: string): void {
  a[qId.about(i)] = choice(about, { [about]: 0.9, new: 0.1 }, 0.88);
}

const milk = (a: Answers, i: number, m: string) => {
  a[qId.milkStated(i)] = noul(0.9);
  a[qId.milk(i)] = choice(m, { [m]: 0.9, oat: 0.1 }, 0.85);
};
const size = (a: Answers, i: number, s: string) => {
  a[qId.sizeStated(i)] = noul(0.9);
  a[qId.size(i)] = choice(s, { [s]: 0.9, regular: 0.1 }, 0.86);
};

describe('splitPhrases', () => {
  it('splits on commas, "and", "plus" and "also"', () => {
    expect(splitPhrases('a cap with almond milk and an espresso, plus a cap with whole milk')).toEqual([
      'a cap with almond milk',
      'an espresso',
      'a cap with whole milk',
    ]);
  });

  it('splits on "then", so two drinks are not left in one phrase', () => {
    expect(splitPhrases('a latte then a mocha')).toEqual(['a latte', 'a mocha']);
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

  it('offers each phrase the earlier phrases to be about, and "every drink" from the third on', () => {
    const { questions } = parseRequest('two caps, one almond and one whole');
    const options = (i: number) => Object.keys((questions[qId.about(i)] as { criteria: object }).criteria);
    expect(questions[qId.about(0)]).toBeUndefined();
    expect(options(1)).toEqual(['new', 'p1', 'none']);
    expect(options(2)).toEqual(['new', 'p1', 'p2', 'all', 'none']);
  });
});

describe('answersToParsedOrder', () => {
  it('maps answers to one item per phrase and only keeps stated modifiers', () => {
    const a = blank(3);
    orders(a, 0, 'cappuccino');
    milk(a, 0, 'almond');
    orders(a, 1, 'espresso', '2');
    orders(a, 2, 'cappuccino');
    milk(a, 2, 'whole');

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

  it('counts what each phrase is about toward the confidence', () => {
    const a = blank(2);
    orders(a, 0, 'latte');
    orders(a, 1, 'mocha');
    a[qId.about(1)] = choice('new', { new: 0.55, p1: 0.45 }, 0.3);
    expect(answersToParsedOrder(a, 2, { latencyMs: 1 }).confidence).toBe(0.3);
  });

  it('drops phrases that order no drink', () => {
    expect(answersToParsedOrder(blank(2), 2, { latencyMs: 1 }).items).toEqual([]);
  });

  it('builds one question per phrase modifier, an "about" question per later phrase, and the intent', () => {
    expect(Object.keys(buildParseQuestions(3))).toHaveLength(3 * 8 + 2 + 1);
  });
});

describe('detail phrases', () => {
  /** "two caps, one almond and one whole": phrase 1 orders, phrases 2 and 3 add details to it. */
  function twoCaps(): Answers {
    const a = blank(3);
    orders(a, 0, 'cappuccino', '2');
    for (const [i, m] of [[1, 'almond'], [2, 'whole']] as const) {
      detail(a, i, 'p1');
      a[qId.drink(i)] = choice('cappuccino', { cappuccino: 0.6, none: 0.4 }, 0.3); // ignored: it is a detail
      milk(a, i, m);
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
    orders(a, 0, 'americano');
    detail(a, 1, 'p1');
    a[qId.qty(1)] = choice('3', { '1': 0.3, '2': 0.3, '3': 0.4 }, 0.1); // not read
    size(a, 1, 'large');
    const parsed = answersToParsedOrder(a, 2, { latencyMs: 1 });
    expect(parsed.items).toEqual([{ drink: 'americano', qty: 1, milk: undefined, size: 'large', decaf: false, iced: false }]);
    expect(parsed.confidence).toBeGreaterThanOrEqual(0.5);
  });

  it('is unsure when a detail contradicts what a cup already has ("a cap, one almond and one whole")', () => {
    const a = twoCaps();
    orders(a, 0, 'cappuccino', '1');
    expect(answersToParsedOrder(a, 3, { latencyMs: 1 }).confidence).toBe(0);
  });

  it('is unsure when a detail covers more cups than its drink has', () => {
    const a = blank(2);
    orders(a, 0, 'latte', '2');
    detail(a, 1, 'p1');
    a[qId.qty(1)] = choice('3', { '3': 0.9 }, 0.86);
    a[qId.iced(1)] = noul(0.9);
    expect(answersToParsedOrder(a, 2, { latencyMs: 1 }).confidence).toBe(0);
  });

  it('puts a detail on the drink it is about, not the latest one ("a latte and a mocha, the latte iced")', () => {
    const a = blank(3);
    orders(a, 0, 'latte');
    orders(a, 1, 'mocha');
    detail(a, 2, 'p1');
    a[qId.drink(2)] = choice('latte', { latte: 0.9, none: 0.1 }, 0.88);
    a[qId.iced(2)] = noul(0.95);
    const parsed = answersToParsedOrder(a, 3, { latencyMs: 1 });
    expect(parsed.items.map((i) => [i.drink, i.iced])).toEqual([
      ['latte', true],
      ['mocha', false],
    ]);
  });

  it('covers every cup so far when it is about all of them ("two lattes and two mochas, all iced")', () => {
    const a = blank(3);
    orders(a, 0, 'latte', '2');
    orders(a, 1, 'mocha', '2');
    detail(a, 2, 'all');
    a[qId.qty(2)] = choice('3', { '3': 0.9 }, 0.88); // "all": not read
    a[qId.iced(2)] = noul(0.95);
    const parsed = answersToParsedOrder(a, 3, { latencyMs: 1 });
    expect(parsed.items.map((i) => [i.drink, i.qty, i.iced])).toEqual([
      ['latte', 2, true],
      ['mocha', 2, true],
    ]);
    expect(parsed.confidence).toBeGreaterThanOrEqual(0.5);
  });

  it('puts a detail about a detail on the cups that detail reached', () => {
    // "two lattes, one with oat, and that one large"
    const a = blank(3);
    orders(a, 0, 'latte', '2');
    detail(a, 1, 'p1');
    milk(a, 1, 'oat');
    detail(a, 2, 'p2');
    size(a, 2, 'large');
    const parsed = answersToParsedOrder(a, 3, { latencyMs: 1 });
    expect(parsed.items.map((i) => [i.milk, i.size])).toEqual([
      ['oat', 'large'],
      [undefined, undefined],
    ]);
  });

  it('when Jev says "a drink of its own" but names no drink, takes its best other answer and reads it back', () => {
    const a = twoCaps();
    // "one whole": just over the midpoint for "a drink of its own", with no drink named.
    a[qId.about(2)] = choice('new', { new: 0.51, p1: 0.45, p2: 0.03, none: 0.01 }, 0.49);
    a[qId.drink(2)] = choice('none', { none: 0.55, cappuccino: 0.45 }, 0.49);
    const parsed = answersToParsedOrder(a, 3, { latencyMs: 1 });
    expect(parsed.items.map((i) => i.milk)).toEqual(['almond', 'whole']);
    expect(parsed.confidence).toBe(0); // read back: two answers disagree
  });

  it('keeps splitting cups after a detail on all of them ("two lattes, both oat, one iced and one decaf")', () => {
    const a = blank(4);
    orders(a, 0, 'latte', '2');
    detail(a, 1, 'p1');
    a[qId.qty(1)] = choice('2', { '2': 0.9 }, 0.88);
    milk(a, 1, 'oat');
    detail(a, 2, 'p1');
    a[qId.iced(2)] = noul(0.95);
    detail(a, 3, 'p1');
    a[qId.decaf(3)] = noul(0.95);
    const parsed = answersToParsedOrder(a, 4, { latencyMs: 1 });
    expect(parsed.items.map((i) => [i.milk, i.iced, i.decaf])).toEqual([
      ['oat', true, false],
      ['oat', false, true],
    ]);
    expect(parsed.confidence).toBeGreaterThanOrEqual(0.5);
  });

  it('reads back a detail that names a drink it is not about', () => {
    // "a latte and a mocha, the latte iced", with Jev pointing it at the mocha
    const a = blank(3);
    orders(a, 0, 'latte');
    orders(a, 1, 'mocha');
    detail(a, 2, 'p2');
    a[qId.drink(2)] = choice('latte', { latte: 0.9, none: 0.1 }, 0.88);
    a[qId.iced(2)] = noul(0.95);
    expect(answersToParsedOrder(a, 3, { latencyMs: 1 }).confidence).toBe(0);
  });

  it('reads back a modifier that reaches no cup, rather than dropping it', () => {
    // "a latte, oat": Jev says the second phrase is not part of the order, yet it names a milk
    const a = blank(2);
    orders(a, 0, 'latte');
    detail(a, 1, 'none');
    milk(a, 1, 'oat');
    expect(answersToParsedOrder(a, 2, { latencyMs: 1 }).confidence).toBe(0);
  });

  it('reads a phrase that disagrees with being a detail as one more drink ("a small latte and a large latte")', () => {
    // Jev's answers from a live run: "a large latte" ranked as a detail of "a small latte" first.
    const a = blank(2);
    orders(a, 0, 'latte');
    size(a, 0, 'small');
    orders(a, 1, 'latte');
    a[qId.about(1)] = choice('p1', { p1: 0.61, new: 0.38, none: 0.01 }, 0.41);
    size(a, 1, 'large');
    const parsed = answersToParsedOrder(a, 2, { latencyMs: 1 });
    expect(parsed.items.map((i) => [i.drink, i.size])).toEqual([
      ['latte', 'small'],
      ['latte', 'large'],
    ]);
    expect(parsed.confidence).toBe(0); // read back: Jev's first pick disagreed with its other answers
  });

  it('reads a "detail" that adds nothing as one more drink ("a small latte and a latte")', () => {
    const a = blank(2);
    orders(a, 0, 'latte');
    size(a, 0, 'small');
    orders(a, 1, 'latte');
    a[qId.about(1)] = choice('p1', { p1: 0.6, new: 0.4 }, 0.3);
    expect(answersToParsedOrder(a, 2, { latencyMs: 1 }).items.map((i) => [i.drink, i.size])).toEqual([
      ['latte', 'small'],
      ['latte', undefined],
    ]);
  });

  it('drops a detail with no drink before it, and reads the order back', () => {
    const a = blank(2);
    detail(a, 1, 'p1');
    milk(a, 1, 'oat');
    const parsed = answersToParsedOrder(a, 2, { latencyMs: 1 });
    expect(parsed.items).toEqual([]);
    expect(parsed.confidence).toBe(0);
  });

  it('drops a phrase that is not part of the order ("a latte, please")', () => {
    const a = blank(2);
    orders(a, 0, 'latte');
    detail(a, 1, 'none');
    const parsed = answersToParsedOrder(a, 2, { latencyMs: 1 });
    expect(parsed.items).toEqual([{ drink: 'latte', qty: 1, milk: undefined, size: undefined, decaf: false, iced: false }]);
    expect(parsed.confidence).toBeGreaterThanOrEqual(0.5);
  });
});
