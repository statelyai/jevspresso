/**
 * Seeded randomness: the same seed, the same rolls, so a day replays exactly.
 */

/** One step of mulberry32: a roll in [0, 1) and the generator's next state. */
export function nextRandom(state: number): [roll: number, next: number] {
  const next = (state + 0x6d2b79f5) | 0;
  let t = Math.imul(next ^ (next >>> 15), next | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return [((t ^ (t >>> 14)) >>> 0) / 4294967296, next];
}

/** A generator from a seed: each call, the next roll in [0, 1). */
export function seeded(seed: number): () => number {
  let state = seed;
  return () => {
    const [roll, next] = nextRandom(state);
    state = next;
    return roll;
  };
}
