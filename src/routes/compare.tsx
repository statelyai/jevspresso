import { createFileRoute } from '@tanstack/react-router';
import { useActorRef, useSelector } from '@xstate/react';
import { useEffect, useState } from 'react';
import type { ActorRefFrom, AnyActor, EventFromLogic } from 'xstate';
import { NeedsKey, useJevKey } from '../components/NeedsKey';
import type { Timer } from '../components/useOnScreen';
import { modelsAvailable } from '../lib/jev';
import { jevLog } from '../lib/jevLog';
import { barOf } from '../lib/legal';
import { MODELS, type ModelId } from '../lib/models';
import { cafeScore } from '../lib/score';
import { WorldClock } from '../lib/worldClock';
import type { barMachine, BaristaAgent } from '../machines';
import { worldMachine } from '../machines/world';
import { BarView, baristaOf, intakeOf } from './index';

// One café per decision model, side by side in time: the same orders, the
// same mayhem, each run by its own model. The tabs pick which café you watch;
// all of them keep running.
// A day is its seed: `?seed=` replays one. Picked in the loader, so the
// server's render and the page's agree on it.
export const Route = createFileRoute('/compare')({
  validateSearch: (search: Record<string, unknown>): { seed?: number } =>
    Number.isInteger(Number(search.seed)) && search.seed !== undefined ? { seed: Number(search.seed) } : {},
  loaderDeps: ({ search }) => ({ seed: search.seed }),
  loader: async ({ deps }) => ({ available: await modelsAvailable(), seed: deps.seed ?? Math.floor(Math.random() * 2 ** 31) }),
  component: Page,
});

/** What a model needs before it can run a café, for the tabs it cannot. */
const NEEDS: Record<ModelId, string> = {
  jev: 'TYPESAFE_API_KEY, or a key on the page',
  kev: 'KEV_BASE_URL',
  clef: 'CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN',
  'clef-flash': 'CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN',
  'clef-omni': 'CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN',
  openai: 'access to the Decisions API (limited preview)',
};

function Page() {
  const { available, seed } = Route.useLoaderData();
  const key = useJevKey(available.jev);
  // Jev always has a café: with the server's key, or yours.
  const models = MODELS.filter((m) => m.id === 'jev' || available[m.id]).map((m) => m.id);
  return (
    <>
      <World key={`${models.join()}@${seed}`} models={models} seed={seed} onForgetKey={key.forget} />
      {key.missing ? <NeedsKey onKey={key.save} /> : null}
    </>
  );
}

type WorldRef = ActorRefFrom<typeof worldMachine>;
type CafeRef = ActorRefFrom<typeof barMachine>;

function World({ models, seed, onForgetKey }: { models: ModelId[]; seed: number; onForgetKey?: () => void }) {
  const [clock] = useState(() => new WorldClock());
  const world = useActorRef(worldMachine, { input: { models, seed, clock }, clock });
  const [tab, setTab] = useState<ModelId>(models[0]);
  return (
    <div className="flex h-screen min-h-screen flex-col overflow-hidden bg-[#141413] text-[#faf9f5]">
      <CafeTabs world={world} models={models} tab={tab} onTab={setTab} seed={seed} />
      <div
        key={tab}
        id={`cafe-panel-${tab}`}
        role="tabpanel"
        aria-labelledby={`cafe-tab-${tab}`}
        className="flex min-h-0 flex-1"
      >
        <Cafe model={tab} world={world} clock={clock} onForgetKey={onForgetKey} />
      </div>
    </div>
  );
}

/** One tab per model: each café's numbers, live, so you see them pull apart without switching. */
function CafeTabs({ world, models, tab, onTab, seed }: { world: WorldRef; models: ModelId[]; tab: ModelId; onTab: (m: ModelId) => void; seed: number }) {
  // The request log is not reactive: read it again every second.
  const [, tick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, []);
  const clarifying = useSelector(world, (s) => s.context.clarifying);
  const asker = MODELS.find((m) => m.id === clarifying[0]);
  return (
    <div className="flex min-w-0 shrink-0 flex-col border-b border-[#2a2a28]">
      <div role="tablist" aria-label="Cafés" className="flex min-w-0 gap-1 overflow-x-auto px-4 pt-3">
        {MODELS.map((m) =>
          models.includes(m.id) ? (
            <CafeTab key={m.id} world={world} model={m.id} selected={tab === m.id} onSelect={() => onTab(m.id)} />
          ) : (
            <button
              key={m.id}
              type="button"
              role="tab"
              aria-selected={false}
              disabled
              title={`Needs ${NEEDS[m.id]}`}
              className="flex shrink-0 flex-col items-start rounded-t-lg px-3.5 py-2 text-left text-[#6b6862]"
            >
              <span className="text-[13px] font-medium">{m.label}</span>
              <span className="text-[11px]">not set up</span>
            </button>
          ),
        )}
      </div>
      <div className="flex min-w-0 items-center justify-between gap-3 px-6 py-1.5 text-[12px] text-[#a8a49c]">
        {asker ? (
          <button type="button" onClick={() => onTab(asker.id)} className="truncate text-[#ffc48a] hover:underline">
            Time stands still: {asker.label} is asking the customer about their order
            {clarifying.length > 1 ? ` (and ${clarifying.length - 1} more)` : ''}
          </button>
        ) : (
          <span>Same orders, same mayhem, at the same moments, in every café</span>
        )}
        <a href={`?seed=${seed}`} title="This day again: the same mayhem at the same moments" className="tnum shrink-0 hover:text-[#faf9f5]">
          Day #{seed}
        </a>
      </div>
    </div>
  );
}

function CafeTab({ world, model, selected, onSelect }: { world: WorldRef; model: ModelId; selected: boolean; onSelect: () => void }) {
  const info = MODELS.find((m) => m.id === model)!;
  const cafe = useSelector(world, (s) => s.context.cafes[model]) as CafeRef;
  const drinks = useSelector(cafe, (s) => s.context.drinks);
  const servedAt = useSelector(world, (s) => s.context.servedAt[model]);
  const asks = useSelector(world, (s) => s.context.clarifications.filter((c) => c.model === model).length);
  const asking = useSelector(world, (s) => s.context.clarifying.includes(model));
  const score = cafeScore(drinks, servedAt, asks, jevLog().filter((e) => e.model === model));
  return (
    <button
      type="button"
      role="tab"
      id={`cafe-tab-${model}`}
      aria-selected={selected}
      aria-controls={`cafe-panel-${model}`}
      onClick={onSelect}
      className={`flex shrink-0 flex-col items-start gap-0.5 rounded-t-lg border-b-2 px-3.5 py-2 text-left ${
        selected ? 'border-[#d97757] bg-[#1d1d1b]' : 'border-transparent hover:bg-[#1a1a18]'
      }`}
    >
      <span className="flex items-center gap-2 text-[13px] font-medium">
        {info.label}
        <span className="text-[11px] font-normal text-[#6b6862]">{info.by}</span>
        {asking ? <span className="rounded-full bg-[#2a1d10] px-1.5 text-[11px] text-[#ffc48a]">asking</span> : null}
      </span>
      <span className="tnum flex gap-2 text-[11px] text-[#a8a49c]">
        <span title="Served right">✓ {score.served - score.wrong}</span>
        <span title="Served wrong" className={score.wrong ? 'text-[#ff9aa0]' : ''}>✗ {score.wrong}</span>
        <span title="Turned away">⊘ {score.declined}</span>
        <span title="Mean wait of drinks served">{score.avgWaitS === null ? '–' : `${score.avgWaitS.toFixed(0)}s`} wait</span>
        <span title="Times it asked the customer to confirm an order">{score.asks} asked</span>
        <span title={`Requests to the model${score.failed ? `, ${score.failed} failed` : ''}; median time`}>
          {score.calls} calls{score.medianMs === null ? '' : ` · ${score.medianMs}ms`}
        </span>
      </span>
    </button>
  );
}

/**
 * The café you are watching, as the single bar's page shows it, with your
 * hands off it: what you do goes to the world, which does it in every café.
 * Only a reply to a café's question is for that café alone.
 */
function Cafe({ model, world, clock, onForgetKey }: { model: ModelId; world: WorldRef; clock: WorldClock; onForgetKey?: () => void }) {
  const cafe = useSelector(world, (s) => s.context.cafes[model]) as CafeRef;
  const snapshot = useSelector(cafe, (s) => s);
  const breakProb = useSelector(world, (s) => s.context.breakProb);
  const agent = useSelector(snapshot.children.barista as ActorRefFrom<BaristaAgent> | undefined, (s) => s);
  const ctx = { ...barOf(snapshot), breakProb };
  // Spawned cafés are full actors; their refs are typed as the narrower contract.
  const actor = cafe as unknown as AnyActor;
  const send = (event: EventFromLogic<typeof barMachine>) => {
    switch (event.type) {
      case 'order.submit':
        return world.send({ type: 'order.submit', text: event.text });
      case 'order.reply':
        return world.send({ type: 'order.reply', model, text: event.text });
      case 'SET_STOCK':
      case 'SET_SPEED':
      case 'SET_BREAK_PROB':
      case 'BREAK':
      case 'RESET':
        return world.send(event);
      default:
        return cafe.send(event);
    }
  };
  return (
    <BarView
      embedded
      ctx={ctx}
      intake={intakeOf(snapshot)}
      barista={baristaOf(agent, ctx)}
      send={send}
      inspect={actor}
      // Every café shares the world's actor system: only this café's delays.
      timers={() => Object.fromEntries(Object.entries(actor.system.getSnapshot()._scheduledTimers as Record<string, Timer & { source: unknown }>).filter(([, t]) => t.source === actor))}
      now={() => clock.now()}
      onForgetKey={onForgetKey}
    />
  );
}
