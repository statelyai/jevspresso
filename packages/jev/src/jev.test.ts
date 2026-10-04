import { createActor, createMachine, setup, types, type AnyActorRef } from 'xstate';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { buildQuestions, readAnswers } from './decide';
import {
  createJevLogic,
  decide,
  detectLoop,
  getOptions,
  memoizeClient,
  mockAnswers,
  pickEvents,
  requestKey,
  type JevAgentContext,
  type JevClient,
  type JevDecision,
  type JevLogicOptions,
  type JevLoop,
  type JevOptions,
  type JevLogEntry,
  logClient,
  machineMap,
} from './index';

interface Ctx {
  room: string;
  rooms: string[];
  lamp: 'off' | 'dim' | 'bright';
  tired: boolean;
}

type Ev =
  | { type: 'agent.move'; to: string }
  | { type: 'agent.lamp'; level: 'off' | 'dim' | 'bright' }
  | { type: 'agent.rest' }
  | { type: 'agent.say'; text: string }
  | { type: 'user.poke' };

const houseContext = (): Ctx => ({ room: 'hall', rooms: ['hall', 'kitchen', 'study'], lamp: 'off', tired: false });

const house = createMachine({
  schemas: {
    context: types<Ctx>(),
    events: {
      'agent.move': z.object({ to: z.string() }),
      'agent.lamp': z
        .object({ level: z.enum(['off', 'dim', 'bright']).describe('how bright it ends up') })
        .describe('set the lamp'),
      'agent.rest': z.object({}),
      'agent.say': z.object({ text: z.string() }),
      'user.poke': types<void>(),
    },
  },
  context: houseContext(),
  initial: 'awake',
  states: {
    awake: {
      on: {
        'agent.move': ({ context, event }) => {
          if (event.to === context.room) return;
          return { context: { room: event.to } };
        },
        'agent.lamp': ({ context, event }) => {
          if (event.level === context.lamp) return;
          return { context: { lamp: event.level } };
        },
        'agent.rest': {
          description: 'lie down for the night',
          to: ({ context }) => (context.room === 'study' ? { target: 'asleep' } : undefined),
        },
        'agent.say': () => ({}),
        'user.poke': () => ({ context: { tired: true } }),
      },
    },
    asleep: { type: 'final' },
  },
});

const base: JevOptions<Ev, Ctx> = {
  events: 'agent.*',
  instructions: 'Get to bed.',
  payloads: ({ context }) => ({ 'agent.move': context.rooms.map((to) => ({ to })) }),
};

const start = () => createActor(house).start();

/** A client that answers every choice question with `pick`'s key (the first key by default). */
function scripted(pick: (questionId: string, keys: string[]) => string | undefined): JevClient {
  return async ({ questions }) => {
    const answers: Record<string, any> = {};
    for (const [id, q] of Object.entries(questions)) {
      if (q.type !== 'choice') continue;
      const keys = Object.keys(q.criteria);
      const choice = pick(id, keys) ?? keys[0];
      const rest = keys.length > 1 ? 0.1 / (keys.length - 1) : 0;
      answers[id] = {
        type: 'choice',
        choice,
        confidence: 0.9,
        probabilities: Object.fromEntries(keys.map((k) => [k, k === choice ? 0.9 : rest])),
      };
    }
    return { answers };
  };
}

const ids = (options: { id: string }[]) => options.map((o) => o.id);

describe('getOptions', () => {
  it('lists the matching events the machine accepts, from payloads and finite schema values', () => {
    expect(ids(getOptions(start().getSnapshot(), base))).toEqual([
      'agent.move:kitchen',
      'agent.move:study',
      'agent.lamp:dim',
      'agent.lamp:bright',
    ]);
  });

  it('uses the transition description by default, and `describe` when given', () => {
    const actor = start();
    actor.send({ type: 'agent.move', to: 'study' });
    const snap = actor.getSnapshot();
    expect(getOptions(snap, base).find((o) => o.id === 'agent.rest')?.description).toBe('lie down for the night');
    expect(getOptions(snap, { ...base, describe: (e) => `do ${e.type}` })[0].description).toBe('do agent.move');
  });

  it("falls back to the event schema's description, with the payload and its fields' descriptions", () => {
    const lamp = getOptions(start().getSnapshot(), base).find((o) => o.id === 'agent.lamp:dim');
    expect(lamp?.description).toBe('set the lamp (level: dim — how bright it ends up)');
    expect(getOptions(start().getSnapshot(), base)[0].description).toBe('agent.move:kitchen');
  });

  it('by default, the lookahead lists what changes in what Jev sees', () => {
    const lookahead = (o: { id: string }[], id: string) => (o.find((x) => x.id === id) as { lookahead?: string }).lookahead;
    const raw = getOptions(start().getSnapshot(), { ...base, lookahead: true });
    expect(lookahead(raw, 'agent.lamp:dim')).toBe('context.lamp: "off" → "dim"');
    const seen = getOptions(start().getSnapshot(), {
      ...base,
      lookahead: true,
      state: ({ context }) => ({ where: context.room, light: context.lamp !== 'off' }),
    });
    expect(lookahead(seen, 'agent.move:study')).toBe('where: "hall" → "study"');
    expect(lookahead(seen, 'agent.lamp:dim')).toBe('light: false → true');
    expect(lookahead(seen, 'agent.lamp:bright')).toBe('light: false → true');
    // A list lines up item by item: rooms dropped from the front are those rooms gone, not the rest renamed.
    const rooms = getOptions(start().getSnapshot(), {
      ...base,
      lookahead: true,
      state: ({ context }) => ({ ahead: context.rooms.slice(context.rooms.indexOf(context.room)) }),
    });
    expect(lookahead(rooms, 'agent.move:study')).toBe('ahead[0]: "hall" → (none); ahead[1]: "kitchen" → (none)');
  });

  it('follows the timed states a move enters, or waiting leaves running: what they come to once their delays are up', () => {
    const kettle = setup({
      schemas: { context: types<{ watts: number; cups: number }>() },
      delays: { boil: ({ context }) => 6_000_000 / context.watts },
    }).createMachine({
      schemas: { events: { 'agent.boil': z.object({}) } },
      context: { watts: 2000, cups: 0 },
      initial: 'cold',
      states: {
        cold: { on: { 'agent.boil': { target: 'heating' } } },
        heating: { after: { boil: { target: 'hot', context: ({ context }) => ({ cups: context.cups + 1 }) } } },
        hot: {},
      },
    });
    const tea = { events: 'agent.*', instructions: 'Tea.', lookahead: true, noop: 'wait' } as const;
    const actor = createActor(kettle).start();
    const [boil, wait] = getOptions(actor.getSnapshot(), tea);
    expect(boil).toMatchObject({
      id: 'agent.boil',
      lookahead: 'value: "cold" → "heating". Once done (after 3.0s): value: "cold" → "hot"; context.cups: 0 → 1',
    });
    // Only what it comes to, on request: the smaller lookahead.
    const [compact] = getOptions(actor.getSnapshot(), { ...tea, lookahead: { show: 'done' } });
    expect(compact).toMatchObject({ lookahead: 'Once done (after 3.0s): value: "cold" → "hot"; context.cups: 0 → 1' });
    // Waiting says what it comes to as well: here, nothing.
    expect(wait).toMatchObject({ kind: 'noop', lookahead: 'nothing changes on its own: no timed state is running' });
    actor.send({ type: 'agent.boil' });
    expect(getOptions(actor.getSnapshot(), tea).at(-1)).toMatchObject({
      kind: 'noop',
      lookahead: 'Once what is running is done (within 3.0s): value: "heating" → "hot"; context.cups: 0 → 1',
    });
  });

  it('shows Jev the machine itself, on request: states, where events lead, delays', async () => {
    const client = vi.fn(scripted(() => undefined));
    await decide(start().getSnapshot(), { ...base, map: true, client });
    const { state } = client.mock.calls[0][0] as { state: { machine: string } };
    expect(state.machine).toBe(
      [
        '(machine) (one at a time)',
        '  * awake',
        '      on agent.move → (stays); sets room',
        '      on agent.lamp → (stays); sets lamp',
        '      on agent.rest → asleep (conditional) — lie down for the night',
        '      on agent.say → (stays)',
        '      on user.poke → (stays); sets tired',
        '  asleep',
      ].join('\n'),
    );
  });

  it("reads where a transition function can go, and what it sets, from its source; only what is computed stays unread", () => {
    const somewhere = (where: string) => ({ where: `${where}!` });
    const door = createMachine({
      schemas: {
        context: types<{ locked: boolean; where: string }>(),
        events: {
          open: types<void>(),
          knock: types<{ loud: boolean }>(),
          enter: types<void>(),
          go: types<void>(),
          wander: types<void>(),
          lock: types<void>(),
        },
      },
      context: { locked: false, where: 'hall' },
      initial: 'closed',
      states: {
        closed: {
          on: {
            // A literal target, when the guard allows it, and what it sets.
            open: ({ context }) => (context.locked ? undefined : { target: 'opened', context: { where: 'doorway' } }),
            // A ternary: either one.
            knock: ({ event }) => ({ target: event.loud ? 'opened' : 'closed' }),
            // A child of this state.
            enter: () => ({ target: '.inside' }),
            // A name no state has: dropped.
            go: () => ({ target: 'nowhere' }),
            // Computed: nothing to read, neither where it goes nor what it sets.
            wander: ({ context }) => ({ target: context.where as 'closed', context: somewhere(context.where) }),
            // Declarative: no state change, and what it sets.
            lock: { context: { locked: true } },
          },
          initial: 'outside',
          states: { outside: {}, inside: {} },
        },
        opened: {},
      },
    });
    const map = machineMap(createActor(door).start().getSnapshot());
    expect(map).toContain('on open → opened (conditional); sets where');
    expect(map).toContain('on knock → opened, closed (conditional)');
    expect(map).toContain('on enter → closed.inside (conditional)');
    expect(map).toContain('on go → ?');
    expect(map).toContain('on wander → ?; sets …somewhere()');
    expect(map).toContain('on lock → (stays); sets locked');
  });

  it('adds a noop option, and lookahead text from the pure transition', () => {
    const options = getOptions(start().getSnapshot(), {
      ...base,
      noop: 'stay put',
      lookahead: (next) => `in ${next.context.room}, lamp ${next.context.lamp}`,
    });
    expect(options.at(-1)).toMatchObject({ kind: 'noop', description: 'stay put' });
    expect(options[0]).toMatchObject({ kind: 'event', lookahead: 'in kitchen, lamp off' });
  });

  it('drops an event whose required field has no finite values and no payload', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(ids(getOptions(start().getSnapshot(), base)).some((id) => id.startsWith('agent.say'))).toBe(false);
    const said = getOptions(start().getSnapshot(), {
      ...base,
      payloads: (s) => ({ ...base.payloads!(s), 'agent.say': [{ text: 'goodnight' }] }),
    });
    expect(ids(said)).toContain('agent.say:goodnight');
    warn.mockRestore();
  });

  it('drops a payload that does not match the event schema', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const options = getOptions(start().getSnapshot(), {
      ...base,
      payloads: () => ({ 'agent.move': [{ to: 'kitchen' }, { to: 42 as unknown as string }] }),
    });
    expect(ids(options).filter((id) => id.startsWith('agent.move'))).toEqual(['agent.move:kitchen']);
    warn.mockRestore();
  });

  it('sets `fixed` fields on every option, and leaves them out of option ids', () => {
    // Two players take turns; Jev plays O.
    const game = createMachine({
      schemas: {
        context: types<{ turn: 'X' | 'O' }>(),
        events: { move: z.object({ player: z.enum(['X', 'O']), cell: z.enum(['a', 'b']) }) },
      },
      context: { turn: 'O' as 'X' | 'O' },
      on: {
        move: ({ context, event }) => {
          if (event.player !== context.turn) return;
          return { context: { turn: event.player === 'X' ? ('O' as const) : ('X' as const) } };
        },
      },
    });
    const snapshot = createActor(game).getSnapshot();
    const asO = getOptions(snapshot, { events: 'move', instructions: 'play', fixed: { player: 'O' } });
    expect(asO.map((o) => o.id)).toEqual(['move:a', 'move:b']);
    expect(asO.map((o) => o.kind === 'event' && o.event)).toEqual([
      { player: 'O', cell: 'a', type: 'move' },
      { player: 'O', cell: 'b', type: 'move' },
    ]);
    // Without it, the player is one more thing to choose.
    expect(getOptions(snapshot, { events: 'move', instructions: 'play' }).map((o) => o.id)).toEqual(['move:O:a', 'move:O:b']);
  });

  it('refuses an event Jev may choose without a runtime schema', () => {
    const typesOnly = createMachine({
      schemas: { events: { 'agent.go': types<{ to: string }>() } },
      on: { 'agent.go': () => ({}) },
    });
    expect(() =>
      getOptions(createActor(typesOnly).start().getSnapshot(), { events: 'agent.*', instructions: '' }),
    ).toThrow(/needs a runtime schema such as Zod/);
  });
});

describe('strategies', () => {
  const options = getOptions(start().getSnapshot(), { ...base, noop: 'wait' });

  it('flat asks one choice over every option', () => {
    const q = buildQuestions(options, 'flat', 'go');
    expect(Object.keys(q)).toEqual(['action']);
    expect(Object.keys((q.action as { criteria: object }).criteria)).toHaveLength(5);
  });

  it('hierarchical asks for the type plus one premise question per multi-variant type', () => {
    const q = buildQuestions(options, 'hierarchical', 'go');
    expect(Object.keys(q).sort()).toEqual(['event_type', 'variant:agent.lamp', 'variant:agent.move']);
  });

  it('hierarchical descends greedily, with joint probabilities and the weakest confidence', () => {
    const read = readAnswers(options, 'hierarchical', {
      event_type: {
        type: 'choice',
        choice: 'agent.move',
        confidence: 0.8,
        probabilities: { 'agent.move': 0.6, 'agent.lamp': 0.3, noop: 0.1 },
      },
      'variant:agent.move': {
        type: 'choice',
        choice: 'agent.move:study',
        confidence: 0.4,
        probabilities: { 'agent.move:kitchen': 0.25, 'agent.move:study': 0.75 },
      },
    });
    expect(read).toMatchObject({ chosen: 'agent.move:study', confidence: 0.4 });
    expect(read.probabilities['agent.move:study']).toBeCloseTo(0.45);
  });

  it('auto switches to hierarchical above maxFlatOptions', async () => {
    const client = scripted(() => undefined);
    const snap = start().getSnapshot();
    expect((await decide(snap, { ...base, client, maxFlatOptions: 10 })).strategy).toBe('flat');
    expect((await decide(snap, { ...base, client, maxFlatOptions: 3 })).strategy).toBe('hierarchical');
  });
});

describe('decide', () => {
  it('asked hierarchically, shows every variant of a type with what it comes to, not a few examples', async () => {
    const client = vi.fn(scripted(() => undefined));
    await decide(start().getSnapshot(), { ...base, lookahead: true, maxFlatOptions: 3, client });
    const { questions } = client.mock.calls[0][0] as { questions: Record<string, { criteria: Record<string, string> }> };
    expect(questions.event_type.criteria['agent.lamp']).toBe(
      'agent.lamp (set the lamp), one of 2: dim → context.lamp: "off" → "dim"; bright → context.lamp: "off" → "bright"',
    );
    // The variant question says what they share once; each variant is its payload and what it comes to.
    const variants = questions['variant:agent.lamp'] as unknown as { instructions: string; criteria: Record<string, string> };
    expect(variants.instructions).toMatch(/Assume the action taken is `agent\.lamp`: set the lamp \(level — how bright it ends up\)\./);
    expect(variants.criteria['agent.lamp:dim']).toBe('level: dim (afterwards: context.lamp: "off" → "dim")');
  });

  it('tells Jev what the machine refuses right now, which the options alone do not say', async () => {
    const client = vi.fn(scripted(() => undefined));
    await decide(start().getSnapshot(), { ...base, client });
    const { instructions } = client.mock.calls[0][0].questions.action as { instructions: string };
    // Resting is handled while awake, but only from the study; the hall and the lamp's own level are no move.
    expect(instructions).toBe(
      'Get to bed.\n\nNot possible right now (the machine refuses these in its current state): agent.move:hall, agent.lamp:off, agent.rest.',
    );
  });

  it('says how big each request was', async () => {
    const d = await decide(start().getSnapshot(), { ...base, client: scripted(() => undefined) });
    expect(d.size!.state).toBeGreaterThan(0);
    expect(d.size!.questions).toBeGreaterThan(0);
    expect(d.size!.total).toBeGreaterThan(d.size!.state + d.size!.questions);
    const none = await decide(start().getSnapshot(), { ...base, events: 'nothing.*', noop: 'wait', client: scripted(() => undefined) });
    expect(none.size).toBeNull();
  });

  it('makes no request when there is nothing to choose', async () => {
    const client = vi.fn(scripted(() => undefined));
    const d = await decide(start().getSnapshot(), { ...base, events: 'nothing.*', noop: 'wait', client });
    expect(client).not.toHaveBeenCalled();
    expect(d).toMatchObject({ reason: 'no-options', option: null, event: null, key: null });
  });

  it('returns the chosen option, or the noop, as a tagged option', async () => {
    const snap = start().getSnapshot();
    const moved = await decide(snap, { ...base, client: scripted(() => 'agent.move:study') });
    expect(moved).toMatchObject({
      reason: 'chosen',
      option: { kind: 'event' },
      event: { type: 'agent.move', to: 'study' },
    });
    const waited = await decide(snap, { ...base, noop: 'wait', client: scripted((_, keys) => keys.at(-1)) });
    expect(waited).toMatchObject({ reason: 'noop', option: { kind: 'noop' }, event: null });
  });

  it('chooses nothing below minConfidence', async () => {
    const d = await decide(start().getSnapshot(), {
      ...base,
      client: scripted(() => 'agent.move:study'),
      minConfidence: 0.95,
    });
    expect(d).toMatchObject({ reason: 'low-confidence', option: null, event: null });
  });

  it('puts the input into the state Jev sees', async () => {
    const client = vi.fn(scripted((_, keys) => keys.find((k) => k.endsWith('kitchen'))));
    const d = await decide(start().getSnapshot(), { ...base, client }, 'I am hungry');
    expect(client.mock.calls[0][0].state).toMatchObject({ input: 'I am hungry' });
    expect(d.event).toEqual({ type: 'agent.move', to: 'kitchen' });
  });

  it('keeps answers to questions the client added, and marks cached responses', async () => {
    const extra: JevClient = async (req) =>
      mockAnswers({ ...req, questions: { ...req.questions, mood: { type: 'noul', instructions: 'Sleepy?' } } });
    const client = memoizeClient(extra);
    const snap = start().getSnapshot();
    const first = await decide(snap, { ...base, client });
    expect(first.answers.mood).toMatchObject({ type: 'noul' });
    expect(first.cached).toBe(false);
    expect((await decide(snap, { ...base, client })).cached).toBe(true);
  });
});

describe('requestKey', () => {
  it('is stable for the same request, changes with it, and is null with nothing to ask', () => {
    const actor = start();
    const a = requestKey(actor.getSnapshot(), base);
    expect(requestKey(actor.getSnapshot(), base)).toBe(a);
    actor.send({ type: 'agent.move', to: 'kitchen' });
    expect(requestKey(actor.getSnapshot(), base)).not.toBe(a);
    expect(requestKey(actor.getSnapshot(), { ...base, events: 'nothing.*' })).toBeNull();
  });
});

describe('pickEvents', () => {
  it("returns the machine's event schemas matching the descriptors", () => {
    expect(Object.keys(pickEvents(house, 'agent.*')).sort()).toEqual([
      'agent.lamp',
      'agent.move',
      'agent.rest',
      'agent.say',
    ]);
    expect(Object.keys(pickEvents(house, ['user.poke']))).toEqual(['user.poke']);
  });
});

describe('memoizeClient', () => {
  const request = (n: number) => ({ state: { n }, questions: {} });

  it('answers an identical request from memory, marked cached', async () => {
    const client = vi.fn(async () => ({ answers: {} }));
    const memo = memoizeClient(client);
    expect(await memo(request(1))).toEqual({ answers: {} });
    expect(await memo(request(1))).toEqual({ answers: {}, cached: true });
    await memo(request(2));
    expect(client).toHaveBeenCalledTimes(2);
  });

  it('shares one call between identical requests in flight', async () => {
    const client = vi.fn(async () => ({ answers: {} }));
    const memo = memoizeClient(client);
    await Promise.all([memo(request(1)), memo(request(1))]);
    expect(client).toHaveBeenCalledTimes(1);
  });

  it('forgets failures, and the least recently used beyond `max`', async () => {
    let fail = true;
    const client = vi.fn(async () => {
      if (fail) throw new Error('down');
      return { answers: {} };
    });
    const memo = memoizeClient(client, { max: 1 });
    await expect(memo(request(1))).rejects.toThrow('down');
    fail = false;
    await memo(request(1));
    await memo(request(2));
    await memo(request(1));
    expect(client).toHaveBeenCalledTimes(4);
  });
});

describe('logClient', () => {
  it('hands over every request with its response or error, and how long it took', async () => {
    const entries: JevLogEntry[] = [];
    const answered = logClient(scripted(() => undefined), (e) => entries.push(e));
    await decide(start().getSnapshot(), { ...base, client: answered });
    expect(entries).toHaveLength(1);
    expect(entries[0].request.questions).toHaveProperty('action');
    expect(entries[0].response?.answers).toHaveProperty('action');
    const failing = logClient(async () => Promise.reject(new Error('402 no credits')), (e) => entries.push(e));
    await expect(decide(start().getSnapshot(), { ...base, client: failing })).rejects.toThrow('402');
    expect(entries[1]).toMatchObject({ error: 'Error: 402 no credits' });
    expect(entries[1].ms).toBeGreaterThanOrEqual(0);
  });
});

describe('detectLoop', () => {
  const d = (key: string | null, id: string, sent: boolean, cached = false) =>
    ({ key, option: { kind: 'event', id }, event: { type: id.split(':')[0] }, sent, cached }) as unknown as JevDecision<Ev>;

  it('flags a cycle: the same request coming back', () => {
    const loop = detectLoop([
      d('a', 'x', true),
      d('b', 'y', true),
      d('a', 'x', true),
      d('b', 'y', true),
      d('a', 'x', true),
    ]);
    expect(loop).toMatchObject({ kind: 'cycle' });
  });

  it('flags an idle streak: asking, but sending nothing', () => {
    const waits = ['a', 'b', 'c', 'd', 'e'].map((k) => d(k, 'noop', false));
    expect(detectLoop(waits)).toMatchObject({ kind: 'idle', count: 5 });
    expect(detectLoop(waits.slice(0, 4))).toBeNull();
  });

  it('flags a run of moves sent again and again, though every request is new', () => {
    // Newest first: grind, tamp, pull, three times over, each lap a new state (a fuller cup).
    const laps = ['pull', 'tamp', 'grind', 'pull', 'tamp', 'grind', 'pull', 'tamp', 'grind'].map((id, i) => d(`k${i}`, id, true));
    expect(detectLoop(laps)).toMatchObject({ kind: 'repeat', count: 3, chosen: ['grind', 'tamp', 'pull'] });
    // Twice is not yet a pattern; nor is one move over and over (cups put out for three orders).
    expect(detectLoop(laps.slice(0, 6))).toBeNull();
    expect(detectLoop(['a', 'b', 'c'].map((k) => d(k, 'placeCup', true)))).toBeNull();
  });

  it('counts laps by what each move does, whichever cup: seven moves, a new cup each lap', () => {
    const lap = (n: number) => ['pull', 'lockIn', 'tamp', 'grind', 'placeCup:tray', `dumpCup:c${n}`, 'knockOut'];
    const laps = [...lap(15), ...lap(14), ...lap(13)].map((id, i) => d(`k${i}`, id, true));
    expect(detectLoop(laps)).toMatchObject({
      kind: 'repeat',
      chosen: ['knockOut', 'dumpCup', 'placeCup', 'grind', 'tamp', 'lockIn', 'pull'],
    });
  });

  it('ignores decisions that made no request; a cycle answered from the cache is still a cycle', () => {
    expect(detectLoop([d(null, 'x', false), d(null, 'x', false), d(null, 'x', false)])).toBeNull();
    expect(detectLoop(['a', 'b', 'a', 'b', 'a'].map((k) => d(k, 'x', true, true)))).toMatchObject({ kind: 'cycle' });
    // Waiting from the cache costs nothing: no idle streak.
    expect(detectLoop(['a', 'b', 'c', 'd', 'e'].map((k) => d(k, 'noop', false, true)))).toBeNull();
  });
});

describe('createJevLogic', () => {
  type Extra = Partial<JevLogicOptions<Ev, Ctx>>;

  /**
   * A machine that owns the agent: it spawns it once, asks it explicitly
   * (`auto: false`), logs what it hears back, and passes each `agent.move` it
   * is handed on to the target.
   */
  function owner(target: AnyActorRef, client: JevClient, extra: Extra = {}, askAgainOnDecided = false) {
    const agent = createJevLogic<Ev, Ctx>({ ...base, noop: 'wait', client, auto: false, ...extra });
    const machine = createMachine({
      schemas: {
        context: types<{ log: string[] }>(),
        events: {
          ask: types<{ input?: unknown }>(),
          cancel: types<void>(),
          'jev.thinking': types<void>(),
          'jev.decided': types<{ decision: JevDecision<Ev>; loop: JevLoop | null }>(),
          'jev.failed': types<{ error: string }>(),
          ...pickEvents(house, 'agent.move'),
        },
      },
      context: { log: [] as string[] },
      entry: (_, enq) => {
        enq.spawn(agent, { id: 'jev', input: { actor: target } });
      },
      on: {
        ask: ({ event }, enq) => {
          enq.sendTo('jev', { type: 'jev.ask', input: event.input });
          return {};
        },
        cancel: (_, enq) => {
          enq.sendTo('jev', { type: 'jev.cancel' });
          return {};
        },
        'jev.thinking': ({ context }) => ({ context: { log: [...context.log, 'thinking'] } }),
        'agent.move': ({ context, event }, enq) => {
          enq.sendTo(target, event);
          return { context: { log: [...context.log, `got ${event.to}`] } };
        },
        'jev.decided': ({ context, event }, enq) => {
          if (askAgainOnDecided) enq.sendTo('jev', { type: 'jev.ask' });
          const { option, sent } = event.decision;
          return { context: { log: [...context.log, `${option?.id ?? '-'} sent=${sent}`] } };
        },
      },
    });
    const actor = createActor(machine).start();
    return { actor, log: () => actor.getSnapshot().context.log };
  }

  const tick = () => new Promise((r) => setTimeout(r, 20));
  const toStudy = () => scripted((_, keys) => keys.find((k) => k.endsWith('study')));

  it('on `jev.ask`, hands the chosen event to its parent, then reports the decision', async () => {
    const target = start();
    const { actor, log } = owner(target, toStudy());
    actor.send({ type: 'ask' });
    await vi.waitFor(() => expect(log()).toEqual(['thinking', 'got study', 'agent.move:study sent=true']));
    expect(target.getSnapshot().context.room).toBe('study'); // passed on by the parent
    target.send({ type: 'agent.move', to: 'kitchen' }); // a change, but nobody asked
    await tick();
    expect(log()).toHaveLength(3);
  });

  it("`deliver: 'actor'` sends to the actor; `'none'` sends nothing", async () => {
    const direct = start();
    const a = owner(direct, toStudy(), { deliver: 'actor' });
    a.actor.send({ type: 'ask' });
    await vi.waitFor(() => expect(a.log()).toEqual(['thinking', 'agent.move:study sent=true']));
    expect(direct.getSnapshot().context.room).toBe('study');

    const untouched = start();
    const b = owner(untouched, toStudy(), { deliver: 'none' });
    b.actor.send({ type: 'ask' });
    await vi.waitFor(() => expect(b.log()).toEqual(['thinking', 'agent.move:study sent=false']));
    expect(untouched.getSnapshot().context.room).toBe('hall');
  });

  it('holds an ask until there is a question, and does not repeat one answered with a wait', async () => {
    const target = createActor(sleepyHouse()).start();
    const client = vi.fn(scripted((_, keys) => keys.at(-1)));
    const { actor, log } = owner(target, client);
    actor.send({ type: 'ask' }); // asleep: nothing to choose, so no request
    await tick();
    expect(log()).toEqual([]);
    target.send({ type: 'wake' }); // now there is a question
    await vi.waitFor(() => expect(log()).toEqual(['thinking', 'noop sent=false']));
    actor.send({ type: 'ask' }); // the same question: that answer stands
    await tick();
    expect(client).toHaveBeenCalledTimes(1);
    expect(log()).toHaveLength(2);
  });

  it('answers an ask with input right away', async () => {
    const client = vi.fn(scripted((_, keys) => keys.at(-1)));
    const { actor, log } = owner(start(), client);
    actor.send({ type: 'ask', input: 'hello' });
    await vi.waitFor(() => expect(log()).toEqual(['thinking', 'noop sent=false']));
    actor.send({ type: 'ask', input: 'hello' }); // asked again: answered again, from the cache
    await vi.waitFor(() => expect(log()).toHaveLength(4));
    expect(client).toHaveBeenCalledTimes(1);
  });

  it('`jev.cancel` drops an answer on its way: nothing is delivered or reported', async () => {
    const target = start();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const client: JevClient = async (req) => {
      await gate;
      return toStudy()(req);
    };
    const { actor, log } = owner(target, client);
    actor.send({ type: 'ask' });
    await vi.waitFor(() => expect(log()).toEqual(['thinking']));
    actor.send({ type: 'cancel' });
    release();
    await tick();
    expect(log()).toEqual(['thinking']);
    expect(target.getSnapshot().context.room).toBe('hall');
  });

  it('reports a ping-pong loop, with the cache or without, and tells Jev it is going in circles', async () => {
    // Always the first move: hall -> kitchen -> hall -> ...
    const pingPong = () => scripted((_, keys) => keys.find((k) => k.startsWith('agent.move')));
    const loops: JevLoop[] = [];
    const uncached = owner(start(), pingPong(), { cache: false, loops: { onLoop: (l) => loops.push(l) } }, true);
    uncached.actor.send({ type: 'ask' });
    await vi.waitFor(() => expect(loops).toHaveLength(1));
    expect(loops[0]).toMatchObject({ kind: 'cycle' });
    uncached.actor.stop();

    // With the cache every lap after the first is free, but it is still a loop:
    // Jev is told (in what it sees), which makes a fresh request once per state.
    const client = vi.fn(pingPong());
    const onLoop = vi.fn();
    const cached = owner(start(), client, { loops: { onLoop } }, true);
    cached.actor.send({ type: 'ask' });
    await vi.waitFor(() => expect(cached.log().length).toBeGreaterThanOrEqual(20));
    cached.actor.stop();
    expect(onLoop).toHaveBeenCalledWith(expect.objectContaining({ kind: 'cycle' }));
    const told = client.mock.calls.map(([req]) => (req.state as { loop?: string }).loop).filter(Boolean);
    expect(told[0]).toMatch(/^going in circles: these moves keep bringing it back to the same state \(agent\.move/);
    // This client never changes its mind: once told, the loop is cached again, not paid for lap after lap.
    expect(client.mock.calls.length).toBeLessThanOrEqual(4);
  });
});

describe('an agent invoked at the top of the machine it decides for', () => {
  /** The house, with Jev invoked at its top: no states of its own for Jev. */
  function agentHouse(client: JevClient, extra: Partial<JevLogicOptions<Ev, Ctx>> = {}) {
    const agent = createJevLogic<Ev, Ctx>({ ...base, noop: 'wait', client, ...extra });
    return setup({ actors: { jev: agent } }).createMachine({
      ...(house.config as object),
      invoke: { src: 'jev', id: 'jev' },
    } as never);
  }
  type AgentSnapshot = { value: string; context: JevAgentContext<Ev> };
  const agentOf = (jev: AnyActorRef) => jev.getSnapshot() as AgentSnapshot;

  it('decides by itself whenever the machine changes, and keeps its decisions in its snapshot', async () => {
    // To the study first, then to rest: two decisions, nobody asking.
    const client = vi.fn(scripted((_, keys) => keys.find((k) => k === 'agent.rest') ?? keys.find((k) => k.endsWith('study'))));
    const actor = createActor(agentHouse(client)).start();
    // Held on to: once the house is asleep (final), its children stop.
    const jev = actor.getSnapshot().children.jev!;
    await vi.waitFor(() => expect(actor.getSnapshot().value).toBe('asleep'));
    expect(agentOf(jev).context.decisions.map((d) => d.option?.id)).toEqual(['agent.rest', 'agent.move:study']);
    expect(agentOf(jev).context.decisions.every((d) => d.sent)).toBe(true);
    expect(client).toHaveBeenCalledTimes(2);
  });

  it('pauses and resumes; settles for a while before deciding; waits out `interval` between decisions', async () => {
    const client = vi.fn(scripted((_, keys) => keys.find((k) => k.endsWith('kitchen')) ?? keys.find((k) => k.endsWith('hall'))));
    const actor = createActor(agentHouse(client, { settle: 150, interval: 100 })).start();
    const jev = actor.getSnapshot().children.jev!;
    jev.send({ type: 'jev.pause' });
    await new Promise((r) => setTimeout(r, 250));
    expect(client).not.toHaveBeenCalled();
    expect(agentOf(jev).value).toBe('paused');
    const resumedAt = Date.now();
    jev.send({ type: 'jev.resume' });
    await vi.waitFor(() => expect(agentOf(jev).context.decisions).toHaveLength(1));
    expect(agentOf(jev).context.decisions[0].at - resumedAt).toBeGreaterThanOrEqual(150 - 5); // settled first
    await vi.waitFor(() => expect(agentOf(jev).context.decisions).toHaveLength(2));
    const [second, first] = agentOf(jev).context.decisions;
    expect(second.at - first.at).toBeGreaterThanOrEqual(100 - 5);
    jev.send({ type: 'jev.reset' });
    expect(agentOf(jev).context.decisions).toEqual([]);
    actor.stop();
  });
});

describe('driving an actor from outside (the README example)', () => {
  it('takes a few lines on top of decide', async () => {
    const actor = start();
    const agent = {
      ...base,
      client: scripted((_, keys) => keys.find((k) => k === 'agent.rest') ?? keys.find((k) => k.endsWith('study'))),
    };
    let busy = false;
    actor.subscribe(async (snapshot) => {
      if (busy || snapshot.status !== 'active') return;
      busy = true;
      const { event } = await decide(snapshot, agent);
      busy = false;
      if (event && actor.getSnapshot().can(event)) actor.send(event);
    });
    actor.send({ type: 'user.poke' }); // any change starts it
    await vi.waitFor(() => expect(actor.getSnapshot().status).toBe('done'));
    expect(actor.getSnapshot().context.room).toBe('study');
  });
});

/** Like the house, but asleep until `wake`: no `agent.*` event is accepted before then. */
function sleepyHouse() {
  return createMachine({
    schemas: {
      context: types<Ctx>(),
      events: { 'agent.move': z.object({ to: z.string() }), wake: types<void>() },
    },
    context: houseContext(),
    initial: 'asleep',
    states: {
      asleep: { on: { wake: { target: 'awake' } } },
      awake: {
        on: {
          'agent.move': ({ context, event }) =>
            event.to === context.room ? undefined : { context: { ...context, room: event.to } },
        },
      },
    },
  });
}
