/**
 * Order parsing: question construction and answer -> typed order mapping.
 * Nothing here touches the network or `process.env`, so it is directly
 * unit-testable.
 */
import { DRINK_ALIASES, DRINK_IDS } from './recipes';
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

/** Answer shapes live in `types.ts`; re-exported here for convenience. */
export type { AnyAnswer, Answers, ChoiceAnswer, NoulAnswer, ScoreAnswer } from './types';

/**
 * A noul has no `confidence` field; the cookbook convention is to read its
 * distance from the coin flip, so 0.5 -> 0 and 0/1 -> 1.
 */
export function noulConfidence(p: number): number {
  return Math.abs(2 * p - 1);
}

export const qId = {
  present: (d: DrinkId) => `${d}_present`,
  qty: (d: DrinkId) => `${d}_qty`,
  milk: (d: DrinkId) => `${d}_milk`,
  milkStated: (d: DrinkId) => `${d}_milk_stated`,
  size: (d: DrinkId) => `${d}_size`,
  sizeStated: (d: DrinkId) => `${d}_size_stated`,
  decaf: (d: DrinkId) => `${d}_decaf`,
  iced: (d: DrinkId) => `${d}_iced`,
  intent: 'intent',
};

/**
 * One Jev call, function-calling-cookbook style: the drink menu becomes a
 * yes/no per drink, and every argument of the "order" call becomes a closed-set
 * question. All of them are answered in parallel over the same state.
 */
export function buildParseQuestions(): Record<string, unknown> {
  const questions: Record<string, unknown> = {
    [qId.intent]: {
      type: 'choice',
      instructions: 'What is the customer trying to do?',
      criteria: {
        order: 'Asking for one or more drinks to be made',
        cancel: 'Withdrawing or changing an order they already placed',
        question: 'Asking a question rather than ordering (hours, prices, wifi)',
        other: 'Small talk or anything else',
      },
    },
  };
  for (const drink of DRINK_IDS) {
    const names = DRINK_ALIASES[drink].join(', ');
    questions[qId.present(drink)] = {
      type: 'noul',
      instructions: `Does the order include a ${drink.replace('_', ' ')}? Also counts: ${names}.`,
      criteria: {
        true: `The customer asks for at least one ${drink.replace('_', ' ')}`,
        false: 'This drink is not part of the order',
      },
    };
    questions[qId.qty(drink)] = {
      type: 'choice',
      instructions: `How many ${drink.replace('_', ' ')}s are being ordered?`,
      criteria: { '1': 'One', '2': 'Two', '3': 'Three or more' },
    };
    questions[qId.milk(drink)] = {
      type: 'choice',
      instructions: `Which milk should the ${drink.replace('_', ' ')} be made with?`,
      criteria: {
        whole: 'Regular dairy milk, or no milk preference stated',
        oat: 'Oat milk',
        almond: 'Almond milk',
        soy: 'Soy or soya milk',
        half: 'Half-and-half, or breve',
        none: 'Explicitly no milk at all, black',
      },
    };
    questions[qId.milkStated(drink)] = {
      type: 'noul',
      instructions: `Does the customer actually say which milk the ${drink.replace('_', ' ')} should have?`,
    };
    questions[qId.size(drink)] = {
      type: 'choice',
      instructions: `What size is the ${drink.replace('_', ' ')}?`,
      criteria: { small: 'Small, short, piccolo', regular: 'Regular or unstated', large: 'Large, big, grande' },
    };
    questions[qId.sizeStated(drink)] = {
      type: 'noul',
      instructions: `Does the customer state a size for the ${drink.replace('_', ' ')}?`,
    };
    questions[qId.decaf(drink)] = {
      type: 'noul',
      instructions: `Should the ${drink.replace('_', ' ')} be decaf?`,
    };
    questions[qId.iced(drink)] = {
      type: 'noul',
      instructions: `Should the ${drink.replace('_', ' ')} be iced?`,
    };
  }
  return questions;
}

function asNoul(a: AnyAnswer | undefined): number {
  return a && a.type === 'noul' ? a.noul : 0;
}
function asChoice(a: AnyAnswer | undefined): ChoiceAnswer | undefined {
  return a && a.type === 'choice' ? a : undefined;
}

/**
 * Compose the typed order from the flat answer map. Confidence is the minimum
 * over every judgment we actually relied on — a single shaky answer makes the
 * whole order shaky, which is what routes it to the clarify state.
 */
export function answersToParsedOrder(
  answers: Answers,
  opts: { latencyMs: number },
): ParsedOrder {
  const used: number[] = [];
  const intentAnswer = asChoice(answers[qId.intent]);
  const intent = (intentAnswer?.choice ?? 'order') as Intent;
  if (intentAnswer) used.push(intentAnswer.confidence);

  const items: ParsedOrderItem[] = [];
  for (const drink of DRINK_IDS) {
    const present = asNoul(answers[qId.present(drink)]);
    used.push(noulConfidence(present));
    if (present <= 0.5) continue;

    const qtyAnswer = asChoice(answers[qId.qty(drink)]);
    const qty = Number(qtyAnswer?.choice ?? '1') || 1;
    if (qtyAnswer) used.push(qtyAnswer.confidence);

    const milkStated = asNoul(answers[qId.milkStated(drink)]);
    const milkAnswer = asChoice(answers[qId.milk(drink)]);
    let milk: MilkType | undefined;
    if (milkStated > 0.5 && milkAnswer) {
      milk = milkAnswer.choice as MilkType;
      used.push(milkAnswer.confidence);
    }

    const sizeStated = asNoul(answers[qId.sizeStated(drink)]);
    const sizeAnswer = asChoice(answers[qId.size(drink)]);
    let size: Size | undefined;
    if (sizeStated > 0.5 && sizeAnswer) {
      size = sizeAnswer.choice as Size;
      used.push(sizeAnswer.confidence);
    }

    const decaf = asNoul(answers[qId.decaf(drink)]) > 0.5;
    const iced = asNoul(answers[qId.iced(drink)]) > 0.5;

    items.push({ drink, qty: Math.min(3, Math.max(1, qty)), milk, size, decaf, iced });
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
