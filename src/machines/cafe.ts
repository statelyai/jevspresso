import { createJevLogic, type JevClient } from '@xstate/jev';
import { createAsyncLogic, createCallbackLogic } from 'xstate';
import { orderRouter } from '../lib/barista';
import { decisionClient, parseOrder } from '../lib/jev';
import type { ModelId } from '../lib/models';
import type { BarContext, BarEvent, ParsedOrder } from '../lib/types';
import type { WorldClock } from '../lib/worldClock';
import { espressoBarMachine } from './espressoBar';
import { createBaristaAgent } from './index';

/** The client each of a café's agents asks: one model behind all of them. */
export type CafeClients = (kind: 'barista' | 'router' | 'parse') => JevClient;

/**
 * A bar where one model does all the deciding: parsing orders, routing the
 * customer's replies, and the barista's moves. It has no chaos of its own;
 * the world sends every café the same mayhem.
 */
export function createCafe(clients: CafeClients) {
  return espressoBarMachine.provide({
    actors: {
      barista: createBaristaAgent(clients('barista')),
      orderRouterAgent: createJevLogic<BarEvent, BarContext>({ ...orderRouter, client: clients('router'), auto: false }),
      parseOrderActor: createAsyncLogic<ParsedOrder, { text: string }>({ run: ({ input }) => parseOrder(input.text, clients('parse')) }),
      chaos: createCallbackLogic(() => {}),
    },
  });
}

export type CafeLogic = ReturnType<typeof createCafe>;

/**
 * A client whose answers land when they would on the world clock: as long
 * after asking as they took, with any pause in between not counted. An answer
 * that comes back while the world stands still waits for it to move again.
 */
export function onClock(client: JevClient, clock: WorldClock): JevClient {
  return async (request) => {
    const asked = clock.now();
    const started = Date.now();
    const response = await client(request);
    await clock.until(asked + (Date.now() - started));
    return response;
  };
}

/**
 * The café `model` runs, its answers on the world clock. The router's are
 * not: it is asked while the world stands still, waiting on the customer.
 */
export function modelCafe(model: ModelId, clock: WorldClock): CafeLogic {
  return createCafe((kind) => (kind === 'router' ? decisionClient('router', model) : onClock(decisionClient(kind, model), clock)));
}
