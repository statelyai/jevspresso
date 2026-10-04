import type { EventObject } from 'xstate';
import type { JevDecision } from './types';

export interface JevLoopSettings {
  /** Flag a cycle when one request key comes back this many times within `window`. Default 3. */
  repeats?: number;
  /** How many recent decisions (that made a request) to look at. Default 20. */
  window?: number;
  /** Flag this many decisions in a row that sent nothing. Default 5. */
  idleStreak?: number;
  /** The longest run of moves that counts as repeating (`repeat`), sent `repeats` times in a row. Default 8. */
  maxRun?: number;
}

export interface JevLoop {
  /**
   * - `cycle`: the same request keeps coming back; the actor returns to the
   *   same state again and again, and every lap is another request.
   * - `idle`: Jev keeps being asked, but nothing it chooses is sent.
   * - `repeat`: the same run of moves (by event type) is sent again and
   *   again, though the state moves on each time (a shot pulled into the
   *   same cup, lap after lap). It may be fine (three espressos are three laps), so it is news
   *   for Jev, not a stop.
   */
  kind: 'cycle' | 'idle' | 'repeat';
  /** Occurrences of the repeated request (`cycle`) or run (`repeat`), or length of the streak (`idle`). */
  count: number;
  /** The ids of the chosen options involved, oldest first. */
  chosen: string[];
  message: string;
}

const chosenId = (d: JevDecision<EventObject>) => d.option?.id ?? '(none)';
/** A move by what it does, not what to: its event type (`dumpCup`, whichever cup). */
const chosenType = (d: JevDecision<EventObject>) => d.event?.type ?? chosenId(d);

/**
 * Look for a loop in recent decisions, newest first. Decisions that made no
 * request (`key: null`) or reused a cached response (`cached`) are ignored:
 * they spend nothing. `idle` relies on `sent`, so pass decisions from an
 * agent that delivers them (`createJevLogic`, or your own code setting
 * `sent`), not raw `decide()` results.
 */
export function detectLoop(
  recent: ReadonlyArray<JevDecision<EventObject>>,
  settings: JevLoopSettings = {},
): JevLoop | null {
  const { repeats = 3, window = 20, idleStreak = 5, maxRun = 8 } = settings;
  // A cycle is behaviour: the actor keeps coming back to the same state,
  // whether each lap was a fresh request or answered from the cache (which
  // would otherwise repeat the same answer, and the lap, forever).
  const keyed = recent.filter((d) => d.key !== null).slice(0, window);
  const latest = keyed[0];
  if (!latest) return null;

  const same = keyed.filter((d) => d.key === latest.key);
  if (same.length >= repeats) {
    const span = keyed.slice(0, keyed.indexOf(same[same.length - 1]) + 1).reverse();
    return {
      kind: 'cycle',
      count: same.length,
      chosen: span.map(chosenId),
      message: `the same request came back ${same.length} times in the last ${span.length} decisions: the actor keeps returning to the same state`,
    };
  }

  // The same run of moves, by type, sent `repeats` times in a row, newest
  // last: pouring away cup 13, then cup 14, is the same lap.
  const sent = recent.filter((d) => d.sent).map(chosenType);
  for (let run = 2; run <= maxRun && run * repeats <= sent.length; run++) {
    const lap = sent.slice(0, run);
    if (new Set(lap).size < 2) continue;
    if (sent.slice(0, run * repeats).every((id, i) => id === lap[i % run])) {
      const moves = [...lap].reverse();
      return {
        kind: 'repeat',
        count: repeats,
        chosen: moves,
        message: `the same ${run} moves were sent ${repeats} times in a row (${moves.join(' → ')})`,
      };
    }
  }

  // Waiting only counts when it cost a request.
  const asked = keyed.filter((d) => !d.cached);
  let streak = 0;
  while (streak < asked.length && !asked[streak].sent) streak++;
  if (streak >= idleStreak) {
    return {
      kind: 'idle',
      count: streak,
      chosen: asked.slice(0, streak).reverse().map(chosenId),
      message: `${streak} decision${streak === 1 ? '' : 's'} in a row sent nothing: Jev keeps being asked, but nothing it chooses changes the actor`,
    };
  }
  return null;
}
