import { createFileRoute } from '@tanstack/react-router';
import { useActorRef, useMachine, useSelector } from '@xstate/react';
import { useEffect, useState } from 'react';
import { flushSync } from 'react-dom';
import type { JevLoop } from '@xstate/jev';
import type { ActorRefFrom, AnyActor, EventFromLogic, SnapshotFrom } from 'xstate';
import { DecisionCard, DecisionHistory } from '../components/DecisionCard';
import { Header, type DayBadge, type ModelPick } from '../components/Header';
import { InspectorPane } from '../components/InspectorPane';
import { Chaos, Ingredients } from '../components/Inventory';
import { JevMark } from '../components/JevMark';
import { HandIcon, Machine } from '../components/Machine';
import { OrderCard } from '../components/OrderCard';
import { TextSwap } from '../components/Transitions';
import { useSlidingPill } from '../components/motion';
import { useOnScreen, type Timer } from '../components/useOnScreen';
import { barOf } from '../lib/legal';
import type { Bar, BaristaMove, Decision, Device } from '../lib/types';
import { allHands, cupToken, drinkTag, handsView, type HandsView, type ViewBar } from '../lib/view';
import { modelsAvailable } from '../lib/jev';
import { downloadLog, jevLog } from '../lib/jevLog';
import { NeedsKey, useModelKey } from '../components/NeedsKey';
import { Scorecard } from '../components/Scorecard';
import { DAY } from '../lib/day';
import { isModelId, reaches, type ModelId } from '../lib/models';
import { dayScore } from '../lib/score';
import { WorldClock } from '../lib/worldClock';
import type { barMachine, BaristaAgent } from '../machines';
import { modelCafe } from '../machines/cafe';
import { dayMachine } from '../machines/day';
import { PACE_SETTLE, toBarDecision, type JevPace } from '../lib/barista';

// The bar, run by a model (`?model=`, Jev unless told otherwise): yours to
// play with, or a day's (`?day=`), the same day for the same seed. It needs
// the model's key: from the environment, or your own, kept in this browser.
// Without one the bar still shows, under a note that it needs one.
export const Route = createFileRoute('/')({
  validateSearch: (search: Record<string, unknown>): { model?: ModelId; day?: number } => ({
    ...(isModelId(search.model) && search.model !== 'jev' ? { model: search.model } : {}),
    ...(search.day !== undefined && search.day !== '' && Number.isInteger(Number(search.day)) ? { day: Number(search.day) } : {}),
  }),
  loader: () => modelsAvailable(),
  component: Page,
});

/** A new day's seed: short enough to read out. */
const newDay = () => Math.floor(Math.random() * 1_000_000);

function Page() {
  const available = Route.useLoaderData();
  const { model = 'jev', day } = Route.useSearch();
  const navigate = Route.useNavigate();
  const key = useModelKey(model, available[model]);
  // Bumped to play the same day again: the same URL, a fresh bar.
  const [run, setRun] = useState(0);
  const go = (search: { model: ModelId; day?: number }) =>
    navigate({ search: { ...(search.model === 'jev' ? {} : { model: search.model }), ...(search.day === undefined ? {} : { day: search.day }) } });
  const pick: ModelPick = {
    value: model,
    // Until your keys are read (the server's render), nothing is said to need one.
    ready: (m) => available[m] || key.keys === undefined || reaches(m, key.holders),
    onChange: (m) => go({ model: m, day }),
  };
  return (
    <>
      {day === undefined ? (
        <Bar key={model} model={model} pick={pick} onPlayDay={() => go({ model, day: newDay() })} onForgetKey={key.forget} />
      ) : (
        <DayBar
          key={`${model}@${day}#${run}`}
          model={model}
          seed={day}
          pick={pick}
          onRestart={() => setRun((n) => n + 1)}
          onDay={(m, seed) => (m === model && seed === day ? setRun((n) => n + 1) : go({ model: m, day: seed }))}
          onLeave={() => go({ model })}
          onForgetKey={key.forget}
        />
      )}
      {key.missing ? (
        <NeedsKey key={`needs:${model}`} model={model} onKey={key.save} onCancel={model === 'jev' ? undefined : () => go({ model: 'jev', day })} />
      ) : null}
    </>
  );
}

const RUSH_ORDERS = [
  'can I get a large oat latte and an espresso',
  'two cappuccinos with almond milk please',
  'a flat white and a hot chocolate',
  'americano, decaf, and a cortado',
  'a cap but with soy milk',
];

function pct(n: number) {
  return `${Math.round(n * 100)}%`;
}

/** What the barista is doing: watching the bar, asking Jev, or hands on something. */
function BaristaStatus({
  state,
  hands,
  ctx,
  nextMoveAt,
}: {
  state: BaristaState;
  hands: HandsView | null;
  ctx: ViewBar;
  /** When Jev decides next, while it holds back at a slower pace: the window to step in. */
  nextMoveAt?: number;
}) {
  if (hands) {
    return (
      <div className="flex items-center gap-2 rounded-full bg-[#faf9f5] px-3.5 py-1.5 text-[13px] font-medium text-[#141413]">
        <HandIcon size={15} />
        <span className="min-w-0 truncate">
          {hands.label}
          {hands.drink ? ` · ${drinkTag(hands.drink.id, ctx.drinks)}` : ''}
        </span>
        <span className="secs shrink-0 font-normal opacity-70">{hands.secondsLeft.toFixed(1)}s</span>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-2 rounded-full border border-[#3a3936] px-3.5 py-1.5 text-[13px] text-[#a8a49c]">
      {state === 'thinking' ? (
        <JevMark size={11} className="shrink-0 animate-pulse" />
      ) : (
        <span className="h-2 w-2 shrink-0 rounded-full bg-[#6b6862]" aria-hidden="true" />
      )}
      <span className="shrink-0">{state === 'thinking' ? 'Thinking…' : state === 'paused' ? 'Your turn' : 'Watching'}</span>
      {/* The countdown is what gives way when there is no room; shorter where the stage is narrow. */}
      {state === 'watching' && nextMoveAt && nextMoveAt > ctx.now ? (
        <span className="min-w-0 truncate text-[#ffc48a]">
          · <span className="hidden @2xl/stage:inline">next move in </span>
          <span className="secs">{((nextMoveAt - ctx.now) / 1000).toFixed(1)}s</span>
        </span>
      ) : null}
    </div>
  );
}

const PACES: Array<{ pace: JevPace; label: string; title: string }> = [
  { pace: 1, label: '1×', title: 'Jev moves as soon as it can' },
  { pace: 0.5, label: '½×', title: 'Jev waits 2s after each move, for you to step in' },
];

/** How fast Jev plays, apart from how fast the bar runs: slower leaves a window after each move to cause trouble in. */
function PaceControl({ pace, onPace }: { pace: JevPace; onPace: (pace: JevPace) => void }) {
  return (
    <div role="radiogroup" aria-label="Jev pace" className="flex shrink-0 items-center rounded-full border border-[#3a3936] p-0.5 text-[13px]">
      {PACES.map((p) => (
        <button
          key={p.pace}
          type="button"
          role="radio"
          aria-checked={pace === p.pace}
          title={p.title}
          onClick={() => onPace(p.pace)}
          className={`rounded-full px-2.5 py-1 ${pace === p.pace ? 'bg-[#faf9f5] text-[#141413]' : 'text-[#a8a49c] hover:text-[#faf9f5]'}`}
        >
          {p.label}
        </button>
      ))}
    </div>
  );
}

/** Stop Jev from being asked, so you can work the bar; or hand it back. Either way, you can click. */
function PauseButton({ paused, onToggle }: { paused: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={paused}
      aria-label={paused ? 'Resume Jev' : 'Pause Jev'}
      title={paused ? 'Resume Jev' : 'Pause Jev'}
      className={`flex shrink-0 items-center gap-2 rounded-full border px-3 py-1.5 text-[13px] @md/stage:px-3.5 ${
        paused ? 'border-[#34d399] text-[#8ee6b4] hover:bg-[#0f2a1e]' : 'border-[#3a3936] text-[#cfcbc3] hover:border-[#6b6862]'
      }`}
    >
      <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true">
        {paused ? <path d="M3 1.5 L10.5 6 L3 10.5 Z" /> : <path d="M2.5 1.5 H5 V10.5 H2.5 Z M7 1.5 H9.5 V10.5 H7 Z" />}
      </svg>
      <span className="hidden @md/stage:inline">{paused ? 'Resume Jev' : 'Pause Jev'}</span>
    </button>
  );
}

function Bar({ model, pick, onPlayDay, onForgetKey }: { model: ModelId; pick: ModelPick; onPlayDay: () => void; onForgetKey?: () => void }) {
  const [machine] = useState(() => modelCafe(model));
  const [snapshot, send, actorRef] = useMachine(machine);
  // The barista: a Jev agent invoked at the top of the bar. Its own snapshot
  // says whether it is deciding or paused, with its decisions; what its
  // hands are doing is the bar's.
  const agentRef = snapshot.children.barista as ActorRefFrom<BaristaAgent> | undefined;
  const agent = useSelector(agentRef, (s) => s);
  const ctx = barOf(snapshot);
  return (
    <BarView
      can={(move) => snapshot.can({ ...move, by: 'you' })}
      onPause={(paused) => agentRef?.send({ type: paused ? 'jev.pause' : 'jev.resume' })}
      onPace={(pace) => agentRef?.send({ type: 'jev.settle', ms: PACE_SETTLE[pace] })}
      // The context plus its regions' states: the portafilter, the pitcher, the equipment.
      ctx={ctx}
      intake={intakeOf(snapshot)}
      barista={baristaOf(agent, ctx)}
      send={send}
      inspect={actorRef}
      // When each running delay started and is due, from the actor system.
      timers={() => actorRef.system.getSnapshot()._scheduledTimers}
      model={pick}
      onPlayDay={onPlayDay}
      onForgetKey={onForgetKey}
    />
  );
}

/**
 * A day at the bar: the day sends the customers and the mishaps, and the
 * customers answer the bar's questions. You watch; you can change the speed,
 * which the day runs by, and start it over.
 */
function DayBar({
  model,
  seed,
  pick,
  onRestart,
  onDay,
  onLeave,
  onForgetKey,
}: {
  model: ModelId;
  seed: number;
  pick: ModelPick;
  onRestart: () => void;
  onDay: (model: ModelId, seed: number) => void;
  onLeave: () => void;
  onForgetKey?: () => void;
}) {
  const [clock] = useState(() => new WorldClock());
  const dayRef = useActorRef(dayMachine, { input: { model, seed, clock }, clock });
  const cafe = useSelector(dayRef, (s) => s.context.cafe);
  const snapshot = useSelector(cafe, (s) => s);
  const agent = useSelector(snapshot.children.barista as ActorRefFrom<BaristaAgent> | undefined, (s) => s);
  const arrived = useSelector(dayRef, (s) => s.context.customers.length);
  const closed = useSelector(dayRef, (s) => s.matches('closed'));
  const ctx = barOf(snapshot);
  // The day's bar is a full actor; its ref is typed as the narrower contract.
  const actor = cafe as unknown as AnyActor;
  // The bar is the day's: of what you can do, only the speed and starting over.
  const send = (event: EventFromLogic<typeof barMachine>) => {
    if (event.type === 'SET_SPEED') dayRef.send(event);
    if (event.type === 'RESET') onRestart();
  };
  const score = () => {
    const { customers, servedAt, startedWall } = dayRef.getSnapshot().context;
    return dayScore(customers, ctx.drinks, servedAt, jevLog().filter((e) => e.model === model && e.at >= startedWall));
  };
  return (
    <>
      <BarView
        ctx={ctx}
        intake={intakeOf(snapshot)}
        barista={baristaOf(agent, ctx)}
        send={send}
        inspect={actor}
        // Only the bar's delays, not the day's own.
        timers={() =>
          Object.fromEntries(
            Object.entries(actor.system.getSnapshot()._scheduledTimers as Record<string, Timer & { source: unknown }>).filter(([, t]) => t.source === actor),
          )
        }
        now={() => clock.now()}
        model={pick}
        day={{ seed, arrived, customers: DAY.orders, onLeave }}
        onForgetKey={onForgetKey}
      />
      {closed ? (
        <Scorecard
          model={model}
          seed={seed}
          score={score()}
          ready={pick.ready}
          onDay={(m) => onDay(m, seed)}
          onNewDay={() => onDay(model, newDay())}
          onLeave={onLeave}
        />
      ) : null}
    </>
  );
}

type BaristaState = 'watching' | 'thinking' | 'working' | 'paused';

/** Where the bar is with an order: reading it, asking the customer about it, or routing their reply. */
function intakeOf(snapshot: { matches(...args: any[]): boolean }): BarViewProps['intake'] {
  return {
    clarifying: snapshot.matches({ intake: 'clarifying' }),
    routing: snapshot.matches({ intake: { clarifying: 'routing' } }),
    parsing: snapshot.matches({ intake: 'parsing' }),
  };
}

/** The barista as the page shows it, from its agent's snapshot and the bar. */
function baristaOf(agent: SnapshotFrom<BaristaAgent> | undefined, ctx: Bar): BarViewProps['barista'] {
  return {
    state: agent?.value === 'paused' ? 'paused' : agent?.value === 'deciding' ? 'thinking' : ctx.hands.jev ? 'working' : 'watching',
    decisions: (agent?.context.decisions ?? []).map(toBarDecision),
    loop: agent?.context.loop ?? null,
    error: agent?.context.error ?? null,
    pace: agent?.context.settle ? 0.5 : 1,
    nextDecisionAt: agent?.context.nextAt ?? 0,
  };
}

const SIDE_TABS = ['History', 'Ingredients', 'Chaos'] as const;
type SideTab = (typeof SIDE_TABS)[number];

/** Under Jev's decision: its history, the ingredients, and chaos, one at a time. */
function SideTabs({ tabs, tab, onTab, historyCount }: { tabs: readonly SideTab[]; tab: SideTab; onTab: (tab: SideTab) => void; historyCount: number }) {
  const { barRef, pillRef } = useSlidingPill(tabs.indexOf(tab));
  return (
    <div ref={barRef} className="t-tabs self-start text-xs" role="tablist" aria-label="Bar details">
      <span ref={pillRef} className="t-tabs-pill" aria-hidden="true" />
      {tabs.map((t) => (
        <button key={t} type="button" className="t-tab" role="tab" aria-selected={tab === t} onClick={() => onTab(t)}>
          {t}
          {t === 'History' && historyCount ? <span className="tnum opacity-60"> {historyCount}</span> : null}
        </button>
      ))}
    </div>
  );
}

export interface BarViewProps {
  ctx: Bar;
  intake: { clarifying: boolean; routing: boolean; parsing: boolean };
  barista: {
    state: BaristaState;
    decisions: Decision[];
    loop: JevLoop | null;
    error: string | null;
    pace?: JevPace;
    nextDecisionAt?: number;
  };
  send: (event: EventFromLogic<typeof barMachine>) => void;
  /** Would the bar take this move from you now? What a click is checked against, as Jev's picks are. */
  can?: (move: BaristaMove) => boolean;
  /** Stop or start asking Jev. */
  onPause?: (paused: boolean) => void;
  /** How fast Jev plays. */
  onPace?: (pace: JevPace) => void;
  /** Take your own Jev key out of this browser (shown only when it is yours in use). */
  onForgetKey?: () => void;
  /** The actor the inspector attaches to. */
  inspect?: AnyActor;
  /** The delays the bar's actor system is running (see `useOnScreen`). */
  timers?: () => Record<string, Timer>;
  /** The bar's clock: the wall clock, or the world's when comparing. */
  now?: () => number;
  /** Which model runs the bar, to pick another. */
  model?: ModelPick;
  /** Start a day. */
  onPlayDay?: () => void;
  /** A day under way: the bar is the day's, and only watched. */
  day?: DayBadge;
}

/** The whole screen, from the bar's state. */
export function BarView({ ctx: bar, intake, barista, send, inspect, timers, now, model, onPlayDay, day, can, onPause, onPace, onForgetKey }: BarViewProps) {
  // The bar with the page's clock: when each running step started and is due.
  const ctx = useOnScreen(bar, timers, now);
  const [text, setText] = useState('a cap with almond milk and an espresso');
  const sideTabs: readonly SideTab[] = day ? SIDE_TABS.filter((t) => t !== 'Chaos') : SIDE_TABS;
  const [chosenTab, setTab] = useState<SideTab>('Ingredients');
  const tab = sideTabs.includes(chosenTab) ? chosenTab : 'Ingredients';
  // The inspector mounts on first open and stays mounted, so its session survives hiding it.
  const [inspector, setInspector] = useState<'never' | 'open' | 'hidden'>('never');

  const open = ctx.drinks.filter((d) => d.status === 'queued');
  // The order a drink started by hand goes to first; none once it is done.
  const [pick, setPick] = useState<string | null>(null);
  const selected = open.some((d) => d.id === pick) ? pick : null;
  // Working the bar by hand: the same events Jev sends, checked the same way.
  // By you: your own hands, the bar's shared equipment.
  const act = (move: BaristaMove) => send({ ...move, by: 'you' });
  const interact = can ? { can, act, selected, breakIt: (device: Device) => send({ type: 'BREAK', device }) } : undefined;
  const finished = ctx.drinks.filter((d) => d.status === 'served' || d.status === 'declined');
  const served = finished.filter((d) => d.status === 'served').length;
  const cards = [...open, ...finished.slice(-4).reverse()];


  const submit = (value: string) => {
    if (!value.trim()) return;
    send(clarifying ? { type: 'order.reply', text: value.trim() } : { type: 'order.submit', text: value.trim(), at: Date.now() });
  };
  const rush = () => {
    const picks = [...RUSH_ORDERS].sort(() => Math.random() - 0.5).slice(0, 3);
    picks.forEach((order, i) => setTimeout(() => submit(order), i * 900));
  };

  const { clarifying, routing, parsing } = intake;
  const { state, decisions } = barista;
  // Two baristas: Jev's hands, and yours.
  const jevHands = handsView(ctx, 'jev');
  const yourHands = handsView(ctx, 'you');
  const hands = allHands(ctx);

  // A served cup flies from the machine to its order card. The machine keeps a
  // served cup until it has `landed`; the card shows it once it has. Landing
  // happens inside a view transition, which animates the cup (the same
  // view-transition-name in both places) from one to the other.
  const servedCups = ctx.drinks.filter((d) => d.status === 'served').map(cupToken);
  const [landed, setLanded] = useState<ReadonlySet<string>>(() => new Set(servedCups));
  const arriving = servedCups.filter((t) => !landed.has(t)).join(' ');
  useEffect(() => {
    if (!arriving) return;
    const land = () => setLanded((prev) => new Set([...prev, ...arriving.split(' ')]));
    // A hidden page gets no transition (the browser would skip it); one the
    // browser skips anyway still lands the cup, so its rejection is expected.
    if (document.visibilityState === 'visible' && typeof document.startViewTransition === 'function') {
      document.startViewTransition(() => flushSync(land)).ready.catch(() => {});
    } else land();
  }, [arriving]);
  const error = ctx.error ?? barista.error ?? null;

  const feedback = parsing
    ? 'Reading order…'
    : routing
      ? 'Routing reply…'
      : error
        ? error
        : ctx.lastParse
          ? `${
              ctx.lastParse.items
                .map((i) => `${i.qty > 1 ? `${i.qty}× ` : ''}${i.drink.replace('_', ' ')}${i.milk && i.milk !== 'none' ? ` (${i.milk})` : ''}`)
                .join(', ') || 'nothing'
            } · ${pct(ctx.lastParse.confidence)} · ${ctx.lastParse.latencyMs}ms`
          : '';

  return (
    <div className="flex h-screen min-h-screen flex-col overflow-hidden bg-[#141413] text-[#faf9f5] lg:flex-row">
      {/* A fixed grid: header, stage, orders. Nothing that happens inside a row changes another row's size. */}
      <div className="@container grid min-h-0 min-w-0 flex-1 grid-cols-[minmax(0,1fr)] grid-rows-[auto_minmax(0,1fr)_auto]">
        <Header
          text={text}
          onText={setText}
          onSubmit={() => submit(text)}
          onRush={rush}
          replying={clarifying}
          speed={ctx.speed}
          onSpeed={(speed) => send({ type: 'SET_SPEED', speed })}
          onReset={() => send({ type: 'RESET' })}
          onForgetKey={onForgetKey}
          onDownloadLog={() => downloadLog(jevLog())}
          inspectorOpen={inspector === 'open'}
          onInspector={() => setInspector((v) => (v === 'open' ? 'hidden' : 'open'))}
          model={model}
          onPlayDay={onPlayDay}
          day={day}
        />

        <div className="relative grid min-h-0 grid-cols-1 overflow-y-auto @4xl:grid-cols-[minmax(0,1fr)_340px] @4xl:overflow-hidden">
          {/* The read-back overlays the stage rather than pushing it down. */}
          {clarifying && ctx.pendingOrder ? (
            <div role="status" className="absolute inset-x-0 top-0 z-10 flex min-w-0 flex-wrap items-center gap-3 border-b border-[#f4a261] bg-[#2a1d10] px-6 py-2.5 text-sm shadow-[0_8px_24px_rgba(0,0,0,0.4)]">
              <span className="min-w-0 text-[#ffc48a]">
                Did you mean{' '}
                <strong className="font-semibold">
                  {ctx.pendingOrder.items
                    .map((i) => `${i.qty}× ${i.drink.replace('_', ' ')}${i.milk && i.milk !== 'none' ? ` (${i.milk})` : ''}`)
                    .join(', ') || 'nothing'}
                </strong>
                ?
              </span>
              <span className="tnum text-[#a8a49c]">{pct(ctx.pendingOrder.confidence)} sure</span>
              {/* On a day, the customer answers. */}
              {day ? null : <div className="ml-auto flex gap-2">
                <button
                  type="button"
                  onClick={() => send({ type: 'order.confirm' })}
                  className="rounded-md bg-[#d97757] px-3 py-1.5 text-[13px] font-semibold text-[#141413]"
                >
                  Yes
                </button>
                <button
                  type="button"
                  onClick={() => send({ type: 'order.cancel' })}
                  className="rounded-md border border-[#3a3936] px-3 py-1.5 text-[13px] text-[#cfcbc3]"
                >
                  Retype
                </button>
              </div>}
            </div>
          ) : null}
          <main className="@container/stage grid min-h-[420px] min-w-0 grid-rows-[auto_minmax(0,1fr)] gap-2 px-6 pt-4">
            {/* By the stage's width, never by what is in it: the controls with the message under them, or, where all of it fits, one line with the message in what the controls leave. */}
            <div className="flex h-[4.25rem] min-w-0 flex-wrap content-center items-center justify-between gap-x-4 gap-y-1.5 @4xl/stage:h-9 @4xl/stage:flex-nowrap">
              <div className="flex min-w-0 items-center gap-2">
                <BaristaStatus state={state} hands={jevHands} ctx={ctx} nextMoveAt={barista.pace && barista.pace < 1 ? barista.nextDecisionAt : undefined} />
                {onPause ? <PauseButton paused={state === 'paused'} onToggle={() => onPause(state !== 'paused')} /> : null}
                {onPace ? <PaceControl pace={barista.pace ?? 1} onPace={onPace} /> : null}
                {/* Your hands, apart from Jev's: the second barista. Where the stage is narrow, the hand on the machine says it. */}
                {yourHands ? (
                  <div className="hidden items-center gap-2 rounded-full bg-[#e8845f] px-3.5 py-1.5 text-[13px] font-medium text-[#1f0f08] @xl/stage:flex">
                    <HandIcon size={15} />
                    <span className="min-w-0 truncate">
                      You: {yourHands.label}
                      {yourHands.drink ? ` · ${drinkTag(yourHands.drink.id, ctx.drinks)}` : ''}
                    </span>
                    <span className="secs shrink-0 font-normal opacity-70">{yourHands.secondsLeft.toFixed(1)}s</span>
                  </div>
                ) : null}
              </div>
              <p className={`min-w-0 basis-full truncate text-[13px] @4xl/stage:min-w-32 @4xl/stage:flex-1 @4xl/stage:basis-0 @4xl/stage:text-right ${error && !parsing && !routing ? 'text-[#ff9aa0]' : 'text-[#a8a49c]'}`}>
                <TextSwap text={feedback} className="max-w-full truncate" />
              </p>
            </div>
            <div className="flex min-h-0 items-center justify-center [container-type:size]">
              <Machine ctx={ctx} hands={hands} landed={landed} interact={interact} />
            </div>
          </main>
          <aside className="flex min-w-0 flex-col gap-6 border-t border-[#2a2a28] p-5 [scrollbar-gutter:stable] @4xl:overflow-y-auto @4xl:border-t-0 @4xl:border-l">
            <DecisionCard
              decisions={decisions}
              drinks={ctx.drinks}
              now={ctx.now}
              thinking={state === 'thinking'}
              loop={barista.loop}
              paused={state === 'paused'}
            />
            <div className="flex min-w-0 flex-col gap-4">
              {/* On a day, what breaks is the day's: no chaos to set. */}
              <SideTabs tabs={sideTabs} tab={tab} onTab={setTab} historyCount={Math.max(0, decisions.length - 1)} />
              {tab === 'History' ? (
                <DecisionHistory decisions={decisions} drinks={ctx.drinks} />
              ) : tab === 'Ingredients' ? (
                <Ingredients
                  inventory={ctx.inventory}
                  restocking={hands.find((h) => h.ingredient)?.ingredient}
                  onStock={day ? undefined : (ingredient, amount) => send({ type: 'SET_STOCK', ingredient, amount })}
                />
              ) : (
                <Chaos
                  breakProb={ctx.breakProb}
                  onBreakProb={(device, prob) => send({ type: 'SET_BREAK_PROB', device, prob })}
                  onBreak={(device) => send({ type: 'BREAK', device })}
                />
              )}
            </div>
          </aside>
        </div>

        {/* Orders scroll sideways; however many there are, the strip keeps its size. */}
        <section aria-label="Orders" className="min-w-0 border-t border-[#2a2a28]">
          <div className="flex min-w-0 items-baseline justify-between gap-3 px-6 pt-3">
            <h2 className="text-[15px] font-medium">Orders</h2>
            <span className="tnum text-[13px] text-[#a8a49c]">
              {open.length} open · {served} served
            </span>
          </div>
          {cards.length === 0 ? (
            <p className="flex h-[172px] items-center justify-center text-[13px] text-[#6b6862]">Nobody waiting</p>
          ) : (
            <ol className="flex h-[172px] w-full min-w-0 gap-2.5 overflow-x-auto overscroll-x-contain px-6 pt-2.5 pb-3">
              {cards.map((d) => (
                <OrderCard
                  key={d.id}
                  drink={d}
                  ctx={ctx}
                  hands={hands}
                  landed={landed.has(cupToken(d))}
                  interact={
                    interact
                      ? { can: interact.can, act, selected: selected === d.id, onSelect: () => setPick((p) => (p === d.id ? null : d.id)) }
                      : undefined
                  }
                />
              ))}
            </ol>
          )}
        </section>
      </div>

      {inspect && inspector !== 'never' ? (
        <div className={inspector === 'open' ? 'contents' : 'hidden'}>
          <InspectorPane actor={inspect} />
        </div>
      ) : null}
    </div>
  );
}
