import { createJevLogic, type JevClient, type JevOptions, type JevSnapshot } from '@xstate/jev';
import { setup, types } from 'xstate';
import { z } from 'zod';

/**
 * jev's "Hello World": a lamp, and a person asking for things. A request is
 * only context (`requests`); jev, invoked at the top, sees it change and does
 * what the lamp allows to satisfy it.
 *
 * The lamp is two things, as a real one is: its switch (on or off) and its
 * bulb (ok or broken). The room is lit when the switch is on and the bulb is
 * ok. The bulb can break (you break it); a switch left on stays on, so a new
 * bulb lights the room again. jev is not told any of this: it reads it off
 * what each move comes to.
 */
export interface LightContext {
  /** What has been asked for, oldest first. */
  requests: Array<{ text: string; at: number }>;
}

export type LightEvent =
  | { type: 'user.request'; text: string; at: number }
  | { type: 'BREAK' }
  | { type: 'lamp.switchOn' }
  | { type: 'lamp.switchOff' }
  | { type: 'lamp.replaceBulb' };

/** The lamp's regions, as its state value says them. */
export type LampValue = { switch: 'on' | 'off'; bulb: 'ok' | 'broken' };

/** Is the room lit: the switch on, and a bulb that works? */
export function isLit(value: LampValue): boolean {
  return value.switch === 'on' && value.bulb === 'ok';
}

/** What jev is told: the goal, what waiting means, and what it sees. Everything else comes from the machine. */
export const lightJev: Omit<JevOptions<LightEvent, LightContext>, 'client'> = {
  events: 'lamp.*',
  instructions: 'Do what the latest of the `requests` asks, if the room is not like that already; otherwise wait.',
  noop: 'leave the lamp as it is',
  // The switch, the bulb, whether the room is lit (computed, so each move says what it comes to), and the requests.
  state: (snapshot: JevSnapshot<LightContext, LightEvent>) => {
    const value = snapshot.value as LampValue;
    return { switch: value.switch, bulb: value.bulb, lit: isLit(value), requests: snapshot.context.requests.map((r) => r.text) };
  },
  lookahead: true,
};

export function createLightMachine(client: JevClient) {
  return setup({
    actors: { jev: createJevLogic<LightEvent, LightContext>({ ...lightJev, client }) },
  }).createMachine({
    id: 'light',
    schemas: {
      context: types<LightContext>(),
      events: {
        'user.request': types<{ text: string; at: number }>(),
        BREAK: types<void>(),
        // jev's moves: runtime schemas, and what each does.
        'lamp.switchOn': z.object({}).describe('flip the lamp’s switch on'),
        'lamp.switchOff': z.object({}).describe('flip the lamp’s switch off'),
        'lamp.replaceBulb': z.object({}).describe('screw in a new bulb'),
      },
    },
    context: { requests: [] },
    // jev decides on the lamp whenever it changes: no states of its own.
    invoke: { src: 'jev', id: 'jev' },
    on: {
      // A request is just context: jev sees it, and acts on it.
      'user.request': ({ context, event }) => ({
        context: { requests: [...context.requests, { text: event.text, at: event.at }].slice(-20) },
      }),
    },
    type: 'parallel',
    states: {
      switch: {
        initial: 'off',
        states: {
          off: { on: { 'lamp.switchOn': { target: 'on' } } },
          on: { on: { 'lamp.switchOff': { target: 'off' } } },
        },
      },
      bulb: {
        initial: 'ok',
        states: {
          ok: { description: 'A working bulb', on: { BREAK: { target: 'broken' } } },
          broken: { description: 'A broken bulb: it gives no light', on: { 'lamp.replaceBulb': { target: 'ok' } } },
        },
      },
    },
  });
}

export type LightMachine = ReturnType<typeof createLightMachine>;
