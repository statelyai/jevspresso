import { mockAnswers, NOOP_ID, type JevClient, type MockScorer } from '@xstate/jev';
import type { BarSnapshot } from '../lib/types';

/**
 * Mock barista: a standalone heuristic over what Jev itself reads, the bar and
 * each option's text with its lookahead ("Once done (after 2.5s): …"). It moves cups toward
 * the orders they are on track for, gets a shot or milk going when an order
 * still needs one, and clears away what no order wants. It never makes a
 * mistake on purpose: anything that takes a cup off its order, or serves a
 * wrong drink, scores 0.
 */
function baristaScore(bar: BarSnapshot, option: string, text: string): number {
  const [type, arg] = option.split(':');
  const done = text.split(/Once done \(after [\d.]+s\): /)[1] ?? '';
  const cupOf = (id: string) => bar.cups.find((c) => c.cupId === id);
  // Recipe steps an order's cup does not have yet.
  const still = bar.queue.flatMap((q) => q.recipe.slice(q.cupId ? (cupOf(q.cupId)?.contents.length ?? 0) : 0));
  // The pitcher's milk as a recipe step: "whole milk (steamed), 240ml" holds "180ml whole milk, steamed".
  const [, inPitcher, texture, left] = /^(.*) \((\w+)\), (\d+)ml$/.exec(bar.pitcher) ?? [];
  const wants = (t: string) =>
    still.some((r) => {
      const [, ml, rest] = /^(\d+)ml (.*)$/.exec(r) ?? [];
      return rest === `${inPitcher}, ${t}` && Number(ml) <= Number(left);
    });
  const pitcherWanted = !!inPitcher && wants(texture);
  if (/onTrackFor: "[^"]+" → null|wrongServed\[/.test(done)) return 0;
  switch (type) {
    case 'barista.repair':
      return 6;
    case 'barista.substituteMilk':
      return 5;
    case 'barista.restock':
      return 3.5;
    case 'barista.decline':
      return 2.5;
    case 'barista.serve':
      return /servedCount/.test(done) ? 9 : 0;
    case 'barista.grindBeans':
    case 'barista.tamp':
    case 'barista.lockIn':
      return still.includes('espresso') ? 5 : 0;
    case 'barista.knockOut':
      return /wasted/.test(text) ? 0 : 5;
    case 'barista.extract':
    case 'barista.addWater':
    case 'barista.addChocolate':
    case 'barista.pourMilk':
      return /matches: null → "/.test(done) ? 7 : /contents\[\d+\]: \(none\)/.test(done) ? 6 : 0;
    case 'barista.placeCup':
      return /"onTrackFor":"[^"]+"/.test(done) ? 5.5 : 0;
    case 'barista.presentCup':
      return still.some((r) => /, (steamed|foamed)$/.test(r)) ? 5 : 0;
    case 'barista.steamMilk':
    case 'barista.foamMilk': {
      // Into the empty pitcher: milk some order still wants, steamed or foamed as it comes out.
      const [, milk, made] = /pitcher: "empty" → "(.*) \((steamed|foamed)\)/.exec(done) ?? [];
      return milk && still.some((r) => r.endsWith(` ${milk}, ${made}`)) && !pitcherWanted ? 5 : 0;
    }
    case 'barista.dumpCup':
    case 'barista.putAwayCup':
      return cupOf(arg)?.onTrackFor === null ? 4 : 0;
    case 'barista.dumpPitcher':
      return pitcherWanted ? 0 : 4;
    default:
      return 0;
  }
}

/**
 * The mock Jev client for the barista. Asked hierarchically, an event type
 * scores as its best variant (from that type's own question).
 */
export const baristaMock: JevClient = async (req) => {
  const bar = req.state as BarSnapshot;
  const oldest = bar.queue?.[0];
  const text = (questionId: string, option: string) => {
    const q = req.questions[questionId];
    return q?.type === 'choice' ? String(q.criteria[option] ?? '') : '';
  };
  const score: MockScorer = ({ questionId, option, criterion }) => {
    if (questionId === 'backlog_pressure') return Math.min(2, bar.queue.length / 2);
    if (questionId === 'should_batch_shots') return Math.min(0.95, bar.queue.length / 4);
    if (questionId === 'target_drink') return option === oldest?.drinkId ? 3 : 1;
    if (!option) return undefined;
    if (option === NOOP_ID) return bar.queue.length === 0 ? 8 : 2;
    const variants = req.questions[`variant:${option}`];
    if (questionId === 'event_type' && variants?.type === 'choice') {
      return Math.max(...Object.keys(variants.criteria).map((id) => baristaScore(bar, id, text(`variant:${option}`, id))));
    }
    return baristaScore(bar, option, String(criterion ?? ''));
  };
  return mockAnswers(req, score);
};

