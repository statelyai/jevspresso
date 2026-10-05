/**
 * Order parsing: question construction and answer -> typed order mapping.
 * Nothing here touches the network or `process.env`, so it is directly
 * unit-testable.
 *
 * The order is split into phrases first ("a cap with almond milk", "an
 * espresso"), and every question is about one phrase, named by its path in
 * the state (`phrases.p1`). Asked about the whole order, "which milk should
 * the cappuccino have?" cannot tell two cappuccinos apart, and an "almond"
 * meant for one drink leaks into every other drink's answer.
 *
 * A phrase may also only add a detail to drinks ordered before it: "two caps,
 * one almond and one whole", "a latte and a mocha, both large". Each phrase
 * after the first is asked whether it does; if so, its milk, size, decaf and
 * iced go to as many of the cups before it as it covers, instead of making a
 * new drink.
 */
import { DRINK_ALIASES, DRINK_IDS, RECIPES } from './recipes';
import type {
  Answers,
  AnyAnswer,
  ChoiceAnswer,
  DrinkId,
  Intent,
  MilkType,
  ParsedOrder,
  ParsedOrderItem,
  Size,
} from './types';

export const MILK_OPTIONS: MilkType[] = ['whole', 'oat', 'almond', 'soy', 'half', 'none'];
export const SIZE_OPTIONS: Size[] = ['small', 'regular', 'large'];
export const QTY_OPTIONS = ['1', '2', '3'] as const;
export const INTENTS: Intent[] = ['order', 'cancel', 'question', 'other'];

/** What the customer can order, as Jev reads it in the state. */
export const MENU = 'espresso, americano, latte, cappuccino, flat white, cortado, macchiato, café breve, mocha, hot chocolate';

/** The most phrases one order is split into; the rest is dropped. */
export const MAX_PHRASES = 8;

/** The answer for a phrase that orders no drink. */
export const NO_DRINK = 'none';

/** Answer shapes live in `types.ts`; re-exported here for convenience. */
export type { AnyAnswer, Answers, ChoiceAnswer, NoulAnswer, ScoreAnswer } from './types';

/**
 * A noul has no `confidence` field; the cookbook convention is to read its
 * distance from the coin flip, so 0.5 -> 0 and 0/1 -> 1.
 */
export function noulConfidence(p: number): number {
  return Math.abs(2 * p - 1);
}

/**
 * The phrases an order may name one drink each in: split on commas,
 * semicolons, "&", "and", "plus" and "also". Naive on purpose: "two caps, one
 * almond and one whole" becomes three phrases, and only the first names a
 * drink.
 */
export function splitPhrases(text: string): string[] {
  const parts = text
    .split(/\s*(?:[,;&]|\band\b|\bplus\b|\balso\b)\s*/i)
    .map((p) => p.trim())
    .filter(Boolean);
  return (parts.length ? parts : [text.trim()]).slice(0, MAX_PHRASES);
}

/** The key of the i-th phrase (0-based) in the state: `p1`, `p2`, … */
export const phraseKey = (i: number) => `p${i + 1}`;

/** A phrase as questions name it: a backticked path into the state. */
const at = (i: number) => `\`phrases.${phraseKey(i)}\``;

export const qId = {
  drink: (i: number) => `${phraseKey(i)}_drink`,
  qty: (i: number) => `${phraseKey(i)}_qty`,
  milk: (i: number) => `${phraseKey(i)}_milk`,
  milkStated: (i: number) => `${phraseKey(i)}_milk_stated`,
  size: (i: number) => `${phraseKey(i)}_size`,
  sizeStated: (i: number) => `${phraseKey(i)}_size_stated`,
  decaf: (i: number) => `${phraseKey(i)}_decaf`,
  iced: (i: number) => `${phraseKey(i)}_iced`,
  /** Asked of every phrase but the first: does it only add a detail to an earlier drink? */
  detail: (i: number) => `${phraseKey(i)}_detail`,
  intent: 'intent',
};

/** One option per drink on the menu, described with its other names, plus "no drink". */
function drinkCriteria(): Record<string, string> {
  const criteria: Record<string, string> = {};
  for (const drink of DRINK_IDS) {
    criteria[drink] = `${RECIPES[drink].label} (also: ${DRINK_ALIASES[drink].join(', ')})`;
  }
  criteria[NO_DRINK] = 'No drink: it only adds a detail to another drink, or it is not an order at all';
  return criteria;
}

/**
 * One Jev call, function-calling-cookbook style: per phrase, which drink it
 * orders and every argument of that drink as a closed-set question. All of
 * them are answered in parallel over the same state.
 */
export function buildParseQuestions(phraseCount: number): Record<string, unknown> {
  const questions: Record<string, unknown> = {
    [qId.intent]: {
      type: 'choice',
      instructions: 'What is the customer trying to do in `customer_said`?',
      criteria: {
        order: 'Asking for one or more drinks to be made',
        cancel: 'Withdrawing or changing an order they already placed',
        question: 'Asking a question rather than ordering (hours, prices, wifi)',
        other: 'Small talk or anything else',
      },
    },
  };
  const drinks = drinkCriteria();
  for (let i = 0; i < phraseCount; i++) {
    questions[qId.drink(i)] = {
      type: 'choice',
      instructions: `Which drink from the menu does ${at(i)} order?`,
      criteria: drinks,
    };
    questions[qId.qty(i)] = {
      type: 'choice',
      instructions: `How many of that drink does ${at(i)} order?`,
      criteria: { '1': 'One', '2': 'Two', '3': 'Three or more' },
    };
    questions[qId.milk(i)] = {
      type: 'choice',
      instructions: `Which milk does ${at(i)} ask for?`,
      criteria: {
        whole: 'Whole or regular dairy milk ("whole" on its own counts), or no milk preference stated',
        oat: 'Oat milk',
        almond: 'Almond milk',
        soy: 'Soy or soya milk',
        half: 'Half-and-half, or breve',
        none: 'Explicitly no milk at all, black',
      },
    };
    questions[qId.milkStated(i)] = {
      type: 'noul',
      instructions: `Does ${at(i)} name a milk: whole, oat, almond, soy or half-and-half? A milk named on its own, without the word "milk", counts.`,
    };
    questions[qId.size(i)] = {
      type: 'choice',
      instructions: `What size does ${at(i)} ask for?`,
      criteria: { small: 'Small, short, piccolo', regular: 'Regular or unstated', large: 'Large, big, grande' },
    };
    questions[qId.sizeStated(i)] = {
      type: 'noul',
      instructions: `Does ${at(i)} name a cup size, such as small, regular or large?`,
    };
    questions[qId.decaf(i)] = {
      type: 'noul',
      instructions: `Does ${at(i)} ask for decaf?`,
    };
    questions[qId.iced(i)] = {
      type: 'noul',
      instructions: `Does ${at(i)} ask for it iced?`,
    };
    if (i > 0) {
      questions[qId.detail(i)] = {
        type: 'noul',
        instructions: `Does ${at(i)} only add a detail (a milk, a size, decaf or iced) to a drink ordered in an earlier phrase, rather than order a drink of its own?`,
        criteria: {
          true: 'It names no drink of its own and describes some of a drink ordered before it, as in "one with oat milk" or "make it large"',
          false: 'It orders a drink of its own, or is not about a drink at all',
        },
      };
    }
  }
  return questions;
}

/** The whole parse request for what the customer said: its phrases, what Jev sees, and the questions. */
export function parseRequest(text: string): {
  phrases: string[];
  state: { customer_said: string; phrases: Record<string, string>; menu: string };
  questions: Record<string, unknown>;
} {
  const phrases = splitPhrases(text);
  return {
    phrases,
    state: {
      customer_said: text,
      phrases: Object.fromEntries(phrases.map((p, i) => [phraseKey(i), p])),
      menu: MENU,
    },
    questions: buildParseQuestions(phrases.length),
  };
}

function asNoul(a: AnyAnswer | undefined): number {
  return a && a.type === 'noul' ? a.noul : 0;
}
function asChoice(a: AnyAnswer | undefined): ChoiceAnswer | undefined {
  return a && a.type === 'choice' ? a : undefined;
}

/** What a phrase says about its drink, modifiers only. */
type Mods = Pick<ParsedOrderItem, 'milk' | 'size' | 'decaf' | 'iced'>;

/** One cup of the order: the phrase that ordered it, and `detailed` once a detail phrase has been applied to it. */
interface Cup {
  drink: DrinkId;
  mods: Mods;
  phrase: number;
  detailed: boolean;
}

/** Does a phrase state any modifier at all? */
const statesSomething = (m: Mods) => m.milk !== undefined || m.size !== undefined || m.decaf || m.iced;

/**
 * Compose the typed order from the flat answer map. Each phrase that orders a
 * drink adds its cups; each detail phrase after it changes the cups before it
 * ("two caps, one almond and one whole" is one cap with almond and one with
 * whole; "a latte and a mocha, both large" makes both large).
 *
 * Confidence is the minimum over every judgment we actually relied on — a
 * single shaky answer makes the whole order shaky, which is what routes it to
 * the clarify state. A detail that covers more cups than there are before it
 * makes the order unsure, so it is read back rather than guessed.
 */
export function answersToParsedOrder(
  answers: Answers,
  phraseCount: number,
  opts: { latencyMs: number },
): ParsedOrder {
  const used: number[] = [];
  const intentAnswer = asChoice(answers[qId.intent]);
  const intent = (intentAnswer?.choice ?? 'order') as Intent;
  if (intentAnswer) used.push(intentAnswer.confidence);

  /** Modifiers a phrase states; unstated milk and size stay undefined. */
  const modsOf = (i: number): Mods => {
    const mods: Mods = {
      milk: undefined,
      size: undefined,
      decaf: asNoul(answers[qId.decaf(i)]) > 0.5,
      iced: asNoul(answers[qId.iced(i)]) > 0.5,
    };
    const milkAnswer = asChoice(answers[qId.milk(i)]);
    if (asNoul(answers[qId.milkStated(i)]) > 0.5 && milkAnswer) {
      mods.milk = milkAnswer.choice as MilkType;
      used.push(milkAnswer.confidence);
    }
    const sizeAnswer = asChoice(answers[qId.size(i)]);
    if (asNoul(answers[qId.sizeStated(i)]) > 0.5 && sizeAnswer) {
      mods.size = sizeAnswer.choice as Size;
      used.push(sizeAnswer.confidence);
    }
    return mods;
  };
  const qtyOf = (i: number): number => {
    const qtyAnswer = asChoice(answers[qId.qty(i)]);
    if (qtyAnswer) used.push(qtyAnswer.confidence);
    return Math.min(3, Math.max(1, Number(qtyAnswer?.choice ?? '1') || 1));
  };

  const cups: Cup[] = [];
  for (let i = 0; i < phraseCount; i++) {
    const drinkAnswer = asChoice(answers[qId.drink(i)]);
    const drink = drinkAnswer?.choice;
    const isDrink = !!drink && (DRINK_IDS as string[]).includes(drink);

    if (i > 0) {
      // A detail: Jev says so, or the phrase names no drink but does state a modifier ("one whole").
      const detail = asNoul(answers[qId.detail(i)]);
      const mods = modsOf(i);
      const byJev = detail > 0.5;
      const byShape = !isDrink && statesSomething(mods);
      if (byJev || byShape) {
        used.push(byJev ? noulConfidence(detail) : (drinkAnswer?.confidence ?? 0));
        // The cups it can cover: those no detail has covered yet, the latest drink's first, each drink's in order.
        const open = cups
          .filter((cup) => !cup.detailed)
          .sort((a, b) => b.phrase - a.phrase || cups.indexOf(a) - cups.indexOf(b));
        // How many it covers ("one almond", "both large") matters only when it could cover more than one.
        let left = open.length > 1 ? qtyOf(i) : 1;
        for (const cup of open) {
          if (left === 0) break;
          cup.mods = {
            milk: mods.milk ?? cup.mods.milk,
            size: mods.size ?? cup.mods.size,
            decaf: mods.decaf || cup.mods.decaf,
            iced: mods.iced || cup.mods.iced,
          };
          cup.detailed = true;
          left--;
        }
        if (left > 0) used.push(0); // it covers more cups than were ordered: ask
        continue;
      }
    }

    if (drinkAnswer) used.push(drinkAnswer.confidence);
    if (!isDrink) continue;
    const qty = qtyOf(i);
    const mods = modsOf(i);
    for (let n = 0; n < qty; n++) cups.push({ drink: drink as DrinkId, mods: { ...mods }, phrase: i, detailed: false });
  }

  // Identical cups next to each other become one item with a quantity.
  const items: ParsedOrderItem[] = [];
  for (const cup of cups) {
    const last = items.at(-1);
    const same =
      last &&
      last.drink === cup.drink &&
      last.milk === cup.mods.milk &&
      last.size === cup.mods.size &&
      last.decaf === cup.mods.decaf &&
      last.iced === cup.mods.iced;
    if (same) last.qty++;
    else items.push({ drink: cup.drink, qty: 1, ...cup.mods });
  }

  const confidence = used.length ? Math.min(...used) : 0;
  return {
    items,
    intent,
    confidence: Number(confidence.toFixed(3)),
    latencyMs: opts.latencyMs,
    raw: answers,
  };
}
