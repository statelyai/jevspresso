import { createJevLogic, type JevClient } from '@xstate/jev';
import { barista, baristaInterval, baristaLoops } from '../lib/barista';
import { jevClient } from '../lib/jev';
import type { BarContext, BarEvent } from '../lib/types';
import { espressoBarMachine } from './espressoBar';

/** The barista's Jev agent: decides on the bar whenever it changes, at a readable pace. */
export function createBaristaAgent(client: JevClient) {
  return createJevLogic<BarEvent, BarContext>({ ...barista, client, loops: baristaLoops, interval: baristaInterval, keep: 60 });
}

export const baristaAgent = createBaristaAgent(jevClient('barista'));

/**
 * The bar with its barista. Wired here, not in `espressoBar.ts`: the barista's
 * settings read the bar's event schemas, so the bar cannot import them.
 */
export const barMachine = espressoBarMachine.provide({ actors: { barista: baristaAgent } });

export type BaristaAgent = typeof baristaAgent;
