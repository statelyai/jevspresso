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
 * A phrase may order a drink of its own, or only add a detail to drinks from
 * earlier phrases: "two caps, one almond and one whole", "a latte and a mocha,
 * both large", "the latte iced". Which it does, and to which drinks, Jev
 * chooses from options the code lists: a new drink, each earlier phrase, all
 * of them, or none. It is the bar's idea again: code lists what is possible,
 * Jev picks. So the split may cut a drink in two, as long as the piece comes
 * after the drink ("a cap, with almond milk"): Jev puts it back. A piece that
 * comes first is lost ("a large, iced latte"), and two drinks in one phrase
 * are one drink.
 *
 * Jev's answer to what a phrase does is a ranking, not only a pick. The code
 * takes the best reading that agrees with Jev's other answers about the
 * phrase: "a large latte" is not a detail of "a small latte" (the sizes
 * differ), so it is one more drink. When that is not Jev's first pick, the
 * order is read back.
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

/** What a phrase is about, besides an earlier phrase (`p1`, `p2`, …): a drink of its own, every drink before it, or none. */
export const ABOUT = { new: 'new', all: 'all', none: 'none' } as const;

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
 * semicolons, "&", "and", "plus", "also" and "then". Naive on purpose: "two
 * caps, one almond and one whole" becomes three phrases, and only the first
 * names a drink.
 */
export function splitPhrases(text: string): string[] {
  const parts = text
    .split(/\s*(?:[,;&]|\band\b|\bplus\b|\balso\b|\bthen\b)\s*/i)
    .map((p) => p.trim())
    .filter(Boolean);
  return (parts.length ? parts : [text.trim()]).slice(0, MAX_PHRASES);
}

/** The key of the i-th phrase (0-based) in the state: `p1`, `p2`, … */
export const phraseKey = (i: number) => `p${i + 1}`;

/** A phrase as questions name it: a backticked path into the state. */
const at = (i: number) => `\`phrases.${phraseKey(i)}\``;

export const qId = {
  /** Asked of every phrase but the first: a drink of its own, or which earlier drinks it adds a detail to. */
  about: (i: number) => `${phraseKey(i)}_about`,
  drink: (i: number) => `${phraseKey(i)}_drink`,
  qty: (i: number) => `${phraseKey(i)}_qty`,
  milk: (i: number) => `${phraseKey(i)}_milk`,
  milkStated: (i: number) => `${phraseKey(i)}_milk_stated`,
  size: (i: number) => `${phraseKey(i)}_size`,
  sizeStated: (i: number) => `${phraseKey(i)}_size_stated`,
  decaf: (i: number) => `${phraseKey(i)}_decaf`,
  iced: (i: number) => `${phraseKey(i)}_iced`,
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

/** What the i-th phrase may do: order one more drink, add a detail to an earlier phrase's drinks or to every drink before it, or neither. */
function aboutCriteria(i: number): Record<string, string> {
  const criteria: Record<string, string> = {
    [ABOUT.new]:
      'Orders one more drink, as in "a mocha" or "another flat white", even when an earlier phrase ordered the same kind of drink',
  };
  for (let k = 0; k < i; k++) criteria[phraseKey(k)] = `Only adds a detail to the drinks ordered in ${at(k)}`;
  // After one phrase, "every drink before it" is the same answer as `p1`, and would split Jev's vote.
  if (i > 1) criteria[ABOUT.all] = 'Only adds a detail to every drink ordered before it, as in "both decaf" or "all of them small"';
  criteria[ABOUT.none] = 'Neither: it is not part of the order, as in "thanks" or "to go"';
  return criteria;
}

/**
 * One Jev call, function-calling-cookbook style: per phrase, what it is
 * about, which drink it orders, and every argument of that drink as a
 * closed-set question. All of them are answered in parallel over the same
 * state.
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
    if (i > 0) {
      questions[qId.about(i)] = {
        type: 'choice',
        instructions: `What does ${at(i)} do? It may order one more drink, or only add a detail (a milk, a size, decaf or iced) to drinks an earlier phrase ordered, as in "the second one decaf", "make it small" or "the mocha with oat milk".`,
        criteria: aboutCriteria(i),
      };
    }
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
const isDrink = (choice: string | undefined): choice is DrinkId => !!choice && (DRINK_IDS as string[]).includes(choice);

/** What a phrase says about its drink, modifiers only. */
type Mods = Pick<ParsedOrderItem, 'milk' | 'size' | 'decaf' | 'iced'>;

/** One cup of the order, and whether a detail has picked it out from the others of its phrase yet. */
interface Cup {
  drink: DrinkId;
  mods: Mods;
  detailed: boolean;
}

/** Both are stated, and they differ: "almond", then "whole" for the same cup. */
const clash = <T>(a: T | undefined, b: T | undefined) => a !== undefined && b !== undefined && a !== b;

/** Does a phrase state any modifier at all? */
const statesSomething = (m: Mods) => m.milk !== undefined || m.size !== undefined || m.decaf || m.iced;

/** One way to read a phrase: the cups it orders or the cups it changes, and the confidences it relies on. */
interface Reading {
  make?: Cup[];
  change?: Cup[];
  mods: Mods;
  /** It changes some of its drink's cups, not all ("one almond"): they are picked out from the rest. */
  picksOut: boolean;
  used: number[];
}

/**
 * Compose the typed order from the flat answer map. A phrase that orders a
 * drink makes its cups. A phrase that adds a detail applies it to the cups of
 * the phrase it is about, the ones no detail has picked out yet first ("two
 * caps, one almond and one whole" is one cap with almond and one with whole),
 * or to every cup so far ("both large").
 *
 * What a phrase does is Jev's best-ranked reading that agrees with its other
 * answers about the phrase (see `read`). Confidence is the minimum over every
 * judgment we actually relied on — a single shaky answer makes the whole
 * order shaky, which is what routes it to the clarify state. A reading that
 * is not Jev's first pick, or a phrase no reading fits, makes the order
 * unsure, so it is read back rather than guessed.
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

  /** Modifiers a phrase states, and the confidences behind them; unstated milk and size stay undefined. */
  const modsOf = (i: number): [Mods, number[]] => {
    const confidences: number[] = [];
    const stated = <T>(id: string, statedId: string): T | undefined => {
      const answer = asChoice(answers[id]);
      if (!answer || asNoul(answers[statedId]) <= 0.5) return undefined;
      confidences.push(answer.confidence);
      return answer.choice as T;
    };
    const mods: Mods = {
      milk: stated<MilkType>(qId.milk(i), qId.milkStated(i)),
      size: stated<Size>(qId.size(i), qId.sizeStated(i)),
      decaf: asNoul(answers[qId.decaf(i)]) > 0.5,
      iced: asNoul(answers[qId.iced(i)]) > 0.5,
    };
    return [mods, confidences];
  };
  /** How many drinks a phrase gives, and the confidence behind it. */
  const qtyOf = (i: number): [number, number[]] => {
    const answer = asChoice(answers[qId.qty(i)]);
    return [Math.min(3, Math.max(1, Number(answer?.choice ?? '1') || 1)), answer ? [answer.confidence] : []];
  };

  /** Every cup, in the order the phrases made them. */
  const cups: Cup[] = [];
  /** The cups each phrase is about: the ones it ordered, or the ones it added a detail to. */
  const cupsOf: Cup[][] = [];

  /** What phrase i may do, Jev's pick first and the rest by probability. The first phrase has no "about" question: its drink answer decides. */
  const rankingOf = (i: number): { about: string; confidence?: number }[] => {
    const answer = i > 0 ? asChoice(answers[qId.about(i)]) : undefined;
    if (!answer) return [{ about: isDrink(asChoice(answers[qId.drink(i)])?.choice) ? ABOUT.new : ABOUT.none }];
    const rest = Object.entries(answer.probabilities)
      .filter(([about]) => about !== answer.choice)
      .sort((a, b) => b[1] - a[1]);
    return [{ about: answer.choice, confidence: answer.confidence }, ...rest.map(([about]) => ({ about }))];
  };

  /** Phrase i read as `about`, or undefined if that reading disagrees with Jev's other answers about the phrase. */
  const read = (i: number, about: string): Reading | undefined => {
    const drinkAnswer = asChoice(answers[qId.drink(i)]);
    const drink = drinkAnswer?.choice;
    const [mods, modsUsed] = modsOf(i);
    const [qty, qtyUsed] = qtyOf(i);

    if (about === ABOUT.new) {
      if (!isDrink(drink)) return undefined; // no drink to order
      const make = Array.from({ length: qty }, () => ({ drink, mods: { ...mods }, detailed: false }));
      return { make, mods, picksOut: false, used: [drinkAnswer!.confidence, ...qtyUsed, ...modsUsed] };
    }
    if (about === ABOUT.none) {
      if (isDrink(drink) || statesSomething(mods)) return undefined; // it orders or asks for something after all
      return { make: [], mods, picksOut: false, used: drinkAnswer ? [drinkAnswer.confidence] : [] };
    }

    // A detail: on every cup so far, or on the cups of the earlier phrase it is about.
    const k = /^p\d+$/.test(about) ? Number(about.slice(1)) - 1 : -1;
    const target = about === ABOUT.all ? cups : k >= 0 && k < i ? cupsOf[k] : [];
    if (target.length === 0 || !statesSomething(mods)) return undefined; // nothing to add it to, or nothing to add
    if (isDrink(drink) && !target.some((cup) => cup.drink === drink)) return undefined; // it names another drink
    // How many it covers ("one almond", "two of them") matters only when it could cover more than one.
    const counted = about !== ABOUT.all && target.length > 1;
    const covers = counted ? qty : target.length;
    if (covers > target.length) return undefined; // more cups than there are
    // Cups no detail has picked out yet go first, so "one almond and one whole" lands on two cups.
    const change = [...target.filter((cup) => !cup.detailed), ...target.filter((cup) => cup.detailed)].slice(0, covers);
    if (change.some((cup) => clash(mods.milk, cup.mods.milk) || clash(mods.size, cup.mods.size))) return undefined; // it contradicts a cup
    return { change, mods, picksOut: covers < target.length, used: [...(counted ? qtyUsed : []), ...modsUsed] };
  };

  for (let i = 0; i < phraseCount; i++) {
    cupsOf[i] = [];
    let reading: Reading | undefined;
    for (const [rank, option] of rankingOf(i).entries()) {
      reading = read(i, option.about);
      if (!reading) continue;
      // Jev's own pick counts at its confidence; a later one means the pick disagreed with Jev's other answers: ask.
      if (rank > 0) used.push(0);
      else if (option.confidence !== undefined) used.push(option.confidence);
      break;
    }
    if (!reading) {
      used.push(0); // no reading fits all of Jev's answers about this phrase: ask
      continue;
    }
    used.push(...reading.used);
    if (reading.make) {
      cupsOf[i] = reading.make;
      cups.push(...reading.make);
    }
    for (const cup of reading.change ?? []) {
      const { mods } = reading;
      cup.mods = {
        milk: mods.milk ?? cup.mods.milk,
        size: mods.size ?? cup.mods.size,
        decaf: mods.decaf || cup.mods.decaf,
        iced: mods.iced || cup.mods.iced,
      };
      if (reading.picksOut) cup.detailed = true;
      cupsOf[i].push(cup);
    }
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
