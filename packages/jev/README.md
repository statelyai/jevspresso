# @xstate/jev

`@xstate/jev` lets Jev, TypeSafe's System One model, choose the next event for an XState v6 actor. The machine decides what is legal; Jev picks one legal event.

A decision is an async function of a snapshot: `decide(snapshot, options)`. Each decision runs these steps:

1. Collect the event types that match `events` and that an active state node handles (`getNextTransitions`).
2. Build each event from `payloads`, fill the remaining required fields from the event's schema, and drop payloads the schema rejects.
3. Keep only the events that `snapshot.can(event)` accepts.
4. Ask Jev one parallel request over those options.
5. Return the decision. `createJevLogic` also delivers the chosen event, if the actor still accepts it, and decides again whenever the actor changes.

## Requires runtime event schemas (Zod)

Jev chooses from a closed set of concrete events; it never writes a payload. The library reads each event's shape from the machine's `schemas.events`, so every event Jev may choose needs a **runtime schema**: a [Standard Schema](https://standardschema.dev) that also implements Standard JSON Schema, such as Zod 4.2+.

```ts
import { z } from 'zod';

const bar = createMachine({
  schemas: {
    events: {
      'barista.tamp': z.object({ drinkId: z.string() }),
      'barista.repair': z.object({ device: z.enum(['grinder', 'groupHead', 'steamWand']) }),
      // Not chosen by Jev: types<T>() is fine here.
      BREAK: types<{ device: string }>(),
    },
  },
  // ...
});
```

The schema is used three ways:

- **Filling fields.** A required field missing from a payload is filled with every value the schema allows, when that set is finite (`enum`, `const`, `boolean`, or a union of those). `barista.repair` needs no payload at all: Jev is offered one option per device.
- **Checking payloads.** Each payload is validated against the schema. One that fails is dropped, with a warning, instead of being offered to Jev.
- **Refusing guesses.** `types<T>()` is type-only; at runtime it has no shape. An event Jev may choose that is declared with it throws: `@xstate/jev: event "X" needs a runtime schema such as Zod`. Without the schema, a missing field could not be detected, and Jev could be offered, and send, an incomplete event.

An event whose required field has no finite set of values and no payload is dropped, with a one-time warning.

## Options

Options are a plain object. Type them from the machine:

```ts
import type { JevOptionsFor } from '@xstate/jev';

export const baristaJev: JevOptionsFor<typeof bar> = {
  events: 'barista.*',
  instructions: 'You are the barista. Serve the longest-waiting customer first.',
  noop: 'wait',
  payloads: ({ context }) => {
    const open = context.drinks.filter((d) => d.status !== 'served').map((d) => ({ drinkId: d.id }));
    return { 'barista.tamp': open, 'barista.substituteMilk': open };
  },
};
```

| Option | Type | Description |
| --- | --- | --- |
| `events` | `string \| string[]` | Event types Jev may choose. Exact types or wildcards such as `'agent.*'`. |
| `instructions` | `string \| (snapshot, input) => string` | The task Jev is performing. |
| `payloads` | `(snapshot) => { [type]?: payload[] }` | Concrete payloads per event type, without `type`. Partial payloads are allowed; the schema fills finite fields. An event type left out is tried with `{}`. |
| `fixed` | `Record<string, unknown>` | Fields every option carries at one value: who the agent is when several can act (`{ player: 'O' }`). Jev is never asked to choose them, and option ids leave them out. |
| `state` | `(snapshot, input) => unknown` | What Jev sees. Default: `{ value, context }`, plus `input` when given. |
| `describe` | `(event, snapshot) => string` | Criterion text per option. Default: the machine's own words, the transition's `description`, else the event schema's (Zod `.describe()`), followed by the payload with each field's description; else the option id. |
| `lookahead` | `boolean \| (next, snapshot, event) => string \| undefined` | Describes the state each option leads to, computed with the pure `transition()`. `true` lists what changes in what Jev sees (`state`, or the state value and context), `path: before → after` per changed field. When the move enters timed states (`after`), it adds `Once done (after 3.0s): …`: their `xstate.after` events sent in turn, and what the move comes to against how things were before it. The noop option gets one too: what waiting comes to, the timed states already running ended in turn, or `nothing changes on its own` when none is. |
| `map` | `boolean` | Shows Jev the machine itself beside the state (`machine`): every state with its description (`*` marks the current ones), each event and where it leads, each delay (`after`) with how long it is now, each `always`. A transition written as a function shows the targets its source names, `→ tamping (conditional)` (it may not be taken), `(stays)` when its source has no `target`, or `→ ?` when it names none it can resolve. Each transition also says what it sets in context (`sets cups, hands`): a declarative `context`'s keys, or the keys of each `context: { … }` in a function's source; a spread or a call shows as `…` with its name (`…initialContext()`). Off by default; `machineMap(snapshot)` returns the same text. |
| `noop` | `string \| (snapshot, input) => string` | Adds a do-nothing option with this description. |
| `strategy` | `'flat' \| 'hierarchical' \| 'auto'` | See [Strategies](#strategies). |
| `maxFlatOptions` | `number` | Threshold for `'auto'`. Default `32`. |
| `minConfidence` | `number` | Below this confidence, nothing is chosen and `reason` is `'low-confidence'`. |
| `client` | `(request) => Promise<JevResponse>` | Sends the request to Jev. See [Client](#client). |

## `createJevLogic`

`createJevLogic(options)` returns actor logic for a Jev agent. Invoke it at the top of the machine it decides for. The machine needs no states for it (no "thinking", no "working"): the agent watches its parent, and whenever the machine changes and there is a question worth a request, it asks Jev and sends the chosen event if the machine still accepts it.

```ts
import { createJevLogic } from '@xstate/jev';

const bar = setup({
  actors: { barista: createJevLogic({ ...baristaJev, client }) },
}).createMachine({
  // Jev decides on this machine (its parent) whenever it changes.
  invoke: { src: 'barista', id: 'barista' },
  // ...the bar itself: only the world, and what the barista's hands are doing.
});
```

A question is not worth a request when the only option is the noop (nothing else is possible: the barista's hands are busy, say), or when it is the same request whose answer was to do nothing. The agent subscribes to the machine; nothing polls.

Its own lifecycle is its snapshot, for a UI to read (`snapshot.children.barista.getSnapshot()`):

| | |
| --- | --- |
| `value` | `'watching'` (until there is something to decide, and `interval` and `settle` have passed), `'deciding'` (a request on its way), or `'paused'`. |
| `context.decisions` | The decisions, newest first (up to `keep`, default 50). |
| `context.loop` | The loop the latest decisions are in, if any (see [Loops](#loops)). |
| `context.error` | Why the last request failed, until one succeeds. A failed request is retried after a second. |
| `context.nextAt` | When it may decide next. |

Options beyond `decide()`'s:

| Option | Default | Meaning |
| --- | --- | --- |
| `auto` | `true` | Decide by itself. `false`: only on `jev.ask`. |
| `interval` | `0` | Ms to hold off after a decision: a number, or `({ decision, loop, snapshot }) => ms` (slow down while Jev keeps waiting, say). |
| `settle` | `0` | Ms the machine must stay unchanged before a decision: a window for a person to step in. |
| `keep` | `50` | Decisions kept in the snapshot. |
| `deliver` | `'parent'` | Where the chosen event goes (see below). |

Events it takes:

| Event | Meaning |
| --- | --- |
| `jev.pause` / `jev.resume` | Stop deciding (an answer on its way is dropped), and start again. |
| `{ type: 'jev.settle', ms }` | Change `settle`. |
| `jev.reset` | Forget the decisions, the loop, and what it waited on. |
| `jev.ask` | Decide once, now or on the first change that makes a new question, and answer the parent: `jev.thinking`, then `jev.decided` (`{ decision, loop }`) or `jev.failed` (`{ error }`). |
| `{ type: 'jev.ask', input }` | Decide once on this input, right away (see [Routing input](#routing-input)). Use `auto: false` for an agent that only answers. |
| `jev.cancel` | Forget a pending `jev.ask`; an answer on its way is dropped, and nothing is delivered or reported. |

The agent can also watch another actor than its parent: `input: { actor }`.

### `deliver`

Where the chosen event goes when Jev answers, if the watched machine still accepts it (`snapshot.can(event)`); a move the actor outgrew while Jev was answering is never delivered.

| `deliver` | The chosen event goes to | Use it when |
| --- | --- | --- |
| `'parent'` (default) | The agent's parent, as the event itself (`barista.tamp`). | Invoked at the top of the machine it decides for: the machine itself. Or a parent that passes it on as it sees fit. |
| `'actor'` | The watched actor (`input.actor`), directly. | The agent watches another actor than its parent. |
| `'none'` | Nowhere. | You want the decision as data: read it in `context.decisions`, or on `jev.decided`. |

Also accepts `cache` (see [Caching](#caching)) and `loops` (see [Loops](#loops)).

## Driving an actor from outside

Outside an actor system there is no runtime to import: a few lines on top of `decide` do it.

```ts
import { decide } from '@xstate/jev';

let busy = false;
actor.subscribe(async (snapshot) => {
  if (busy || snapshot.status !== 'active') return;
  busy = true;
  const { event } = await decide(snapshot, { ...options, client });
  busy = false;
  // The actor may have moved on while Jev was answering.
  if (event && actor.getSnapshot().can(event)) actor.send(event);
});
```

Add what your case needs: a pause between decisions, `requestKey` to skip a request identical to the last one, `memoizeClient`, `detectLoop`.

## Routing input

Pass external input, such as a customer's reply, to route it to an event. The input is added to the state Jev sees and passed to `instructions`, `state` and `noop`.

```ts
const orderRouter = createJevLogic({
  events: ['order.confirm', 'order.cancel'],
  instructions: 'Given the customer reply, what should happen to the order?',
  noop: 'the reply neither confirms nor rejects the order',
  minConfidence: 0.5,
  // Only when asked, with the reply.
  auto: false,
  client,
});

// The machine invokes it on itself, and asks it once per reply.
invoke: { src: 'orderRouter', id: 'router', input: ({ self }) => ({ actor: self }) },
// ...
'order.reply': ({ event }, enq) => {
  enq.sendTo('router', { type: 'jev.ask', input: event.text });
  return { target: 'routing' };
},
```

With `input`, the ask is decided right away, even when the same reply was answered before (from the cache). The events Jev may choose must be accepted in the state that asks; declare them on a parent state node.

With `decide()`, pass the input as the third argument: `decide(snapshot, options, reply)`.

## Sharing event schemas

A machine that receives the same events as another, such as a barista that receives the bar's `barista.*` events from its Jev agent, reads their schemas from that machine instead of declaring them again:

```ts
import { pickEvents } from '@xstate/jev';

schemas: {
  events: {
    ...pickEvents(bar, 'barista.*'),
    'jev.decided': types<{ decision: JevDecision<BarEvent> }>(),
  },
},
```

The result is typed from the machine's own events.

## Extra questions belong in the client

A decision asks only what it needs to choose the event. Other questions about the same state, such as "how busy is the bar?", do not take part in the decision. Add them in the client, where they ride along in the same request; their answers are in `decision.answers`:

```ts
const client: JevClient = (request) =>
  askJev({ ...request, questions: { ...request.questions, ...extraQuestions(request.state) } });
```

## Options and decisions

Options offered to Jev are a tagged union:

```ts
type JevOption<TEvent> =
  | { kind: 'event'; id: string; event: TEvent; description: string; lookahead?: string }
  | { kind: 'noop'; id: string; description: string; lookahead?: string };
```

`id` is readable and stable: `type:value:value`, such as `barista.tamp:d1`. `getOptions(snapshot, options, input?)` returns them without making a request.

Jev is also told what it cannot do: the events a current state handles whose transition is not taken right now (`can()` is false), by option id, or by event type alone when every variant is refused. They follow the instructions as "Not possible right now (the machine refuses these in its current state): …". The machine does not say why; Jev reads that from the state.

| Decision property | Description |
| --- | --- |
| `options` | Every option offered. |
| `option` | The chosen option, or `null` for `'low-confidence'` and `'no-options'`. |
| `event` | The chosen event, or `null` (noop, low confidence, no options). |
| `probabilities` | Probability per option id. |
| `confidence` | Confidence of the decision. |
| `reason` | `'chosen'`, `'noop'`, `'low-confidence'`, or `'no-options'`. `'no-options'` means no request was made. |
| `strategy` | `'flat'`, `'hierarchical'`, or `'none'`. |
| `key` | Fingerprint of the request, or `null` when no request was made. |
| `size` | How big the request was, in characters of JSON: `{ state, questions, total }` (roughly 4 characters a token), or `null` when no request was made. |
| `sent` | `true` once `createJevLogic` delivered the event. Always `false` from `decide()`. |
| `cached` | `true` when the response was reused from an identical earlier request. No tokens were spent. |
| `answers`, `latencyMs`, `mock` | Raw answers, request latency, and whether the client answered with a mock. |

## Strategies

| `strategy` | Questions | When |
| --- | --- | --- |
| `'flat'` | One choice over every option. | Few options. |
| `'hierarchical'` | One choice over event types, plus one choice per event type over its payloads. All are sent in one parallel request. | Many options. |
| `'auto'` (default) | `flat` up to `maxFlatOptions` (default 32), `hierarchical` above. | |

In a `hierarchical` request, a type with several variants is one criterion that names every variant with what it comes to (`agent.lamp (set the lamp), one of 2: dim → …; bright → …`), so a type is judged by all of its variants, not a few examples. A `hierarchical` decision picks the most likely event type, then that type's most likely payload. Its confidence is the lower of the two confidences. `decision.probabilities` holds the joint probability of each option.

## Caching

`memoizeClient(client, { max })` wraps a client so an identical request (same state, same questions) gets the response it got before, without calling Jev. The reused response is marked `cached: true`, and so is the decision. Identical requests in flight at the same time share one call. Failed requests are not remembered. `max` (default 100) is how many distinct requests are kept; the least recently used goes first.

`createJevLogic` memoizes its client by default, with one cache shared by every actor created from the logic. Pass `cache: { max }` to size it or `cache: false` to turn it off. `decide()` uses the client as given.

A loop through the same states then costs nothing after its first lap, but it would also go on forever: the same state gets the same answer. See [Loops](#loops) for how the agent breaks it.

## Loops

An agent can keep going without getting anywhere. `detectLoop(recentDecisions, settings)` looks for three patterns in recent decisions, newest first:

| Kind | Pattern | Default |
| --- | --- | --- |
| `cycle` | The same request (`decision.key`) comes back `repeats` times within the last `window` decisions. The actor keeps returning to the same state. | 3 within 20 |
| `idle` | `idleStreak` decisions in a row sent nothing: a noop, low confidence, or an event the actor no longer accepts. | 5 |
| `repeat` | The same run of 2 to `maxRun` moves, by event type (pouring away cup 13, then cup 14, is the same move), was sent `repeats` times in a row, though the state moved on each lap. | 3 laps, runs up to 8 |

A `cycle` counts every decision that had a request, cached or not: answered from the cache, a cycle is free but endless. An `idle` streak counts only decisions that cost a request; it is the case where the request keeps changing (a clock in the state, for example) and the answer keeps being to wait.

`createJevLogic` runs this after each decision and keeps the loop in its snapshot (`context.loop`, and on `jev.decided` for an ask). Each new loop is also passed to `loops.onLoop`, which defaults to `console.warn`. `loops: false` turns detection off.

While the agent is in a `cycle` or a `repeat`, Jev is told, in what it sees: its state gains a `loop` note naming the moves that keep bringing the actor back, or that keep repeating. A `repeat` may be fine (three espressos are three laps of the same moves), so the note asks Jev to check each lap still gets somewhere rather than to stop. That makes the request new, so it is not answered from the cache, and Jev can choose something else. The note names each move once, so it stays the same lap after lap: a Jev that loops anyway is back on the cache, not paying per lap. `loops: { tell: false }` keeps Jev out of it. A driver of your own around `decide()` gets the same with `tellLoop(options, loop)`.

```ts
createJevLogic({ ...options, loops: { repeats: 3, idleStreak: 5, onLoop: (loop) => report(loop) } });
```

## Client

The client receives `{ state, questions }` and returns `{ answers }`, the same shape as the TypeSafe SDK's `systemOne()` call. Keep the API key on a server:

```ts
// server
const typesafe = new TypeSafeClient();
const answers = (await typesafe.systemOne({ state, questions })).answers;
```

`mockAnswers(request, score?)` returns answers in the same shape without calling Jev. `score` returns a logit per choice option, a probability per noul, or a level per score question. The noop option's id is `NOOP_ID` (`'noop'`), for scorers.

## Logging

`logClient(client, onEntry)` wraps a client and hands every request to `onEntry` once it settles: `{ at, request, response?, error?, ms }`. Keep them to look at what Jev was asked and what it answered, or to download them. Each decision's `size` says how big its request was.

## Exports

- `decide(snapshot, options, input?)`: one decision. Delivers nothing.
- `createJevLogic(options)`: see [`createJevLogic`](#createjevlogic).
- `getOptions(snapshot, options, input?)`: the options Jev would be offered, without a request.
- `pickEvents(machine, descriptors)`: see [Sharing event schemas](#sharing-event-schemas).
- `requestKey(snapshot, options, input?)`: the fingerprint of the request `decide` would send now, or `null` when there is nothing to choose. Makes no request.
- `memoizeClient(client, { max }?)`: see [Caching](#caching).
- `logClient(client, onEntry)`: see [Logging](#logging).
- `machineMap(snapshot)`: the machine as `map: true` shows it to Jev. See [Options](#options).
- `tellLoop(options, loop)`: options that tell Jev about a loop, for a driver of your own. See [Loops](#loops).
- `detectLoop(recentDecisions, settings?)`: a `JevLoop` (`kind`, `count`, `chosen`, `message`) or `null`. See [Loops](#loops).
- `mockAnswers(request, score?)`: see [Client](#client).
- Types: `JevOptions`, `JevOptionsFor`, `JevOption`, `JevDecision`, `JevClient`, `JevRequest`, `JevResponse`, `JevLogicEvent`, `JevLogicReply`, …
