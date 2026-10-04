/**
 * What Jev is told about the bar: which events it may pick, and what it sees.
 * The rest comes from the machine: `can()` says what is physically possible,
 * each option reads as its transition's or its event schema's description, and
 * its lookahead is what changes in what Jev sees, once the move is done.
 * Whether an action makes the right drink is Jev's call.
 */
import {
  type JevDecision,
  type JevLoop,
  type JevLoopSettings,
  type JevOptions,
  type JevQuestion,
} from '@xstate/jev';
import { barOf, isOpen, serializeBar } from './legal';
import type { BarContext, BarEvent, BarSnapshot, Decision, SideAnswer } from './types';

export const BACKLOG_LEVELS = ['calm', 'busy', 'slammed'] as const;

/**
 * Extra judgments the barista's Jev adapter adds to every request (see
 * `jevClient` in `lib/jev.ts`). They do not take part in the decision: Jev
 * answers each question on its own. The decision card shows them.
 */
export function baristaQuestions(bar: BarSnapshot): Record<string, JevQuestion> {
  const questions: Record<string, JevQuestion> = {
    backlog_pressure: {
      type: 'score',
      instructions: 'How much pressure is the bar under right now?',
      criteria: [
        'Calm: nothing queued or one easy drink',
        'Busy: a few drinks in flight, everything still under control',
        'Slammed: long queue, customers waiting a long time, or broken equipment',
      ],
    },
    should_batch_shots: {
      type: 'noul',
      instructions: 'Would it pay off to pull shots for several drinks back to back before steaming any milk?',
    },
  };
  if (bar.queue.length > 1) {
    questions.target_drink = {
      type: 'choice',
      instructions: 'Which drink deserves attention next?',
      criteria: Object.fromEntries(bar.queue.map((d) => [d.drinkId, `Drink ${d.drinkId} — the one to push forward next`])),
    };
  }
  return questions;
}

/** The barista agent, minus the client (the machine and the UI add or skip it). */
export const barista: JevOptions<BarEvent, BarContext> = {
  events: 'barista.*',
  instructions:
    "Goal: serve every open order exactly what it ordered, as fast as you can, the longest-waiting first. With no order open there is nothing to make: wait, or tidy up (knock out a spent puck, put away or pour away cups no order needs); do not start drinks nobody ordered. Which of these actions best moves toward that right now? Each option says what changes, and what it comes to once done: a cup's `onTrackFor` is the order it can still become, and `matches` the order it already is; an order's `next` is what it needs next (a cup, then each ingredient in order), and `blockedBy` what stands in its way. A served cup goes to the order it is exactly; anything else is a wrong drink. A second barista (a person, `otherBarista`) works the same bar with their own hands, and may leave cups no order could become.",
  state: (snapshot) => serializeBar(barOf(snapshot)),
  // Jev is one of two baristas: every move it makes is its own.
  fixed: { by: 'jev' },
  // Only what the schemas cannot say: which ids exist. A `cupId` or `drinkId`
  // is any string, so the cups on the bar and the orders are listed; every enum
  // (`spot`, `milk`, `device`, `ingredient`) is enumerated from the
  // schemas, and `can()` decides what is possible. Nothing is left out as
  // unwise: that is Jev's call.
  payloads: ({ context }) => {
    const cups = context.cups.map((c) => ({ cupId: c.id }));
    const orders = context.drinks.map((d) => ({ drinkId: d.id }));
    return {
      'barista.presentCup': cups,
      'barista.returnCup': cups,
      'barista.putAwayCup': cups,
      'barista.addWater': cups,
      'barista.addChocolate': cups,
      'barista.pourMilk': cups,
      'barista.serve': cups,
      'barista.dumpCup': cups,
      'barista.substituteMilk': orders,
      'barista.decline': orders,
    };
  },
  lookahead: true,
  noop: (snapshot) =>
    snapshot.context.drinks.some(isOpen)
      ? 'hold off for a moment rather than starting anything new'
      : 'wipe the counter — nothing is queued',
};

/**
 * When the barista's decisions count as a possible loop: the same request 3
 * times in the last 20 decisions, or 5 decisions in a row that did nothing.
 */
export const baristaLoops: JevLoopSettings = { repeats: 3, window: 20, idleStreak: 5 };

/** Pause between decisions at 1x, so the log stays readable. */
const PACE_MS = 700;

/**
 * The fail-safe for an idle loop (Jev keeps being asked, keeps choosing to do
 * nothing): the pause stretches this many times, so the barista stops paying
 * for requests that change nothing until Jev acts again.
 */
const IDLE_BACKOFF = 8;

/** How long after a decision Jev decides again: a pause, at the bar's speed, stretched while it keeps waiting. */
export function baristaInterval({ loop, snapshot }: { loop: JevLoop | null; snapshot: { context: BarContext } }): number {
  return (PACE_MS * (loop?.kind === 'idle' ? IDLE_BACKOFF : 1)) / (snapshot.context.speed || 1);
}

/** How fast Jev plays: 1 is as fast as the bar allows; ½ leaves a person a window after every change to step in. */
export type JevPace = 1 | 0.5;

/**
 * At a slower pace, how long the bar must stay unchanged before Jev decides
 * (the agent's `settle`), in real time: the bar's speed does not shorten it,
 * since it is for a person to step in.
 */
export const PACE_SETTLE: Record<JevPace, number> = { 1: 0, 0.5: 2000 };

/** Router mode: map the customer's free-text reply to confirm / cancel. */
export const orderRouter: JevOptions<BarEvent, BarContext> = {
  events: ['order.confirm', 'order.cancel'],
  instructions:
    'The customer was read back their order because it was unclear. Given their reply, what should happen?',
  state: (snapshot, input) => ({
    reply: input,
    orderAsReadBack: snapshot.context.pendingOrder?.items.map(
      (i) => `${i.qty}x ${i.drink.replace('_', ' ')}${i.milk ? ` (${i.milk})` : ''}`,
    ),
  }),
  noop: 'the reply neither confirms nor rejects the order',
  minConfidence: 0.5,
};

function asChoice(d: JevDecision<BarEvent>, id: string) {
  const a = d.answers[id];
  return a?.type === 'choice' ? a : undefined;
}

/** A Jev decision plus the adapter's extra answers, as the decision log keeps it. */
export function toBarDecision(d: JevDecision<BarEvent>): Decision {
  const alsoAnswers: SideAnswer[] = [];
  const target = asChoice(d, 'target_drink');
  if (target) {
    alsoAnswers.push({ id: 'target_drink', label: 'drink to push', choice: target.choice, probabilities: target.probabilities });
  }
  const score = d.answers.backlog_pressure?.type === 'score' ? d.answers.backlog_pressure : undefined;
  const batch = d.answers.should_batch_shots;
  const level = Math.round(score?.score ?? 0);
  return {
    ...d,
    also: alsoAnswers,
    extras: {
      backlogPressure: score?.score ?? 0,
      backlogLabel: BACKLOG_LEVELS[Math.min(2, Math.max(0, level))],
      shouldBatchShots: batch?.type === 'noul' ? batch.noul : 0,
    },
  };
}
