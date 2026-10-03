import { createFileRoute } from '@tanstack/react-router';
import { useMachine, useSelector } from '@xstate/react';
import { useEffect, useState } from 'react';
import { flushSync } from 'react-dom';
import type { JevLoop } from '@xstate/jev';
import type { ActorRefFrom, AnyActor, EventFromLogic } from 'xstate';
import { DecisionCard, DecisionHistory } from '../components/DecisionCard';
import { Header } from '../components/Header';
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
import { jevAvailable } from '../lib/jev';
import { downloadLog, jevLog } from '../lib/jevLog';
import { forgetKey, loadKey, saveKey } from '../lib/key';
import { barMachine, type BaristaAgent } from '../machines';
import { PACE_SETTLE, toBarDecision, type JevPace } from '../lib/barista';

// The bar needs Jev's key: from the environment, or your own, kept in this
// browser. Without one the bar still shows, under a note that it needs one.
export const Route = createFileRoute('/')({
  loader: () => jevAvailable(),
  component: Page,
});

const REPO = 'https://github.com/statelyai/jevspresso';

function Page() {
  const serverHasKey = Route.useLoaderData();
  // Your own key, read from this browser once the page is in it (`undefined` until then).
  const [key, setKey] = useState<string | null | undefined>(undefined);
  useEffect(() => setKey(loadKey()), []);
  return (
    <>
      <Bar onForgetKey={!serverHasKey && key ? () => (forgetKey(), setKey(null)) : undefined} />
      {!serverHasKey && key === null ? <NeedsKey onKey={(k) => (saveKey(k), setKey(k))} /> : null}
    </>
  );
}

/** No Jev key on the server or in this browser: run it yourself, or bring your own key. */
function NeedsKey({ onKey }: { onKey: (key: string) => void }) {
  const [value, setValue] = useState('');
  return (
    <div role="dialog" aria-modal="true" aria-labelledby="needs-key" className="fixed inset-0 z-50 flex items-center justify-center bg-[#141413]/70 p-6 backdrop-blur-sm">
      <div className="flex w-full max-w-md flex-col gap-5 rounded-2xl border border-[#3a3936] bg-[#1d1d1b] p-6 text-[#faf9f5] shadow-[0_24px_64px_rgba(0,0,0,0.5)]">
        <div className="flex flex-col gap-2">
          <h2 id="needs-key" className="text-lg font-semibold">
            Jev needs a key
          </h2>
          <p className="text-[14px] text-[#a8a49c]">
            Jev makes every move behind this bar, and asks a model each time. Run Jevspresso yourself with your own key, or use
            your TypeSafe key here.
          </p>
        </div>
        <a
          href={REPO}
          target="_blank"
          rel="noreferrer"
          className="flex h-11 items-center justify-center gap-2 rounded-lg border border-[#3a3936] text-sm text-[#faf9f5] hover:border-[#6b6862]"
        >
          Run it locally
          <span className="text-[#a8a49c]">github.com/statelyai/jevspresso</span>
        </a>
        <form
          className="flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (value.trim()) onKey(value.trim());
          }}
        >
          <label htmlFor="jev-key" className="text-[13px] text-[#a8a49c]">
            Or use your own key
          </label>
          <div className="flex min-w-0 gap-2">
            <input
              id="jev-key"
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder="Your TypeSafe key"
              className="h-11 min-w-0 grow rounded-lg border border-[#3a3936] bg-[#141413] px-3.5 text-[15px] text-[#faf9f5]"
            />
            <button
              type="submit"
              disabled={!value.trim()}
              className="h-11 shrink-0 rounded-lg bg-[#d97757] px-5 text-sm font-semibold text-[#141413] disabled:opacity-50"
            >
              Open the bar
            </button>
          </div>
          <p className="text-[12px] text-[#6b6862]">
            Saved in this browser only. It goes along with each Jev request through this app&apos;s server, which uses it for that
            call and keeps nothing. Forget it any time from the header.
          </p>
        </form>
      </div>
    </div>
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
      <div className="flex min-w-0 items-center gap-2 rounded-full bg-[#faf9f5] px-3.5 py-1.5 text-[13px] font-medium text-[#141413]">
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
    <div className="flex min-w-0 items-center gap-2 rounded-full border border-[#3a3936] px-3.5 py-1.5 text-[13px] text-[#a8a49c]">
      {state === 'thinking' ? (
        <JevMark size={11} className="animate-pulse" />
      ) : (
        <span className="h-2 w-2 shrink-0 rounded-full bg-[#6b6862]" aria-hidden="true" />
      )}
      {state === 'thinking' ? 'Thinking…' : state === 'paused' ? 'Your turn' : 'Watching'}
      {state === 'watching' && nextMoveAt && nextMoveAt > ctx.now ? (
        <span className="shrink-0 text-[#ffc48a]">
          · next move in <span className="secs">{((nextMoveAt - ctx.now) / 1000).toFixed(1)}s</span>
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
      className={`flex shrink-0 items-center gap-2 rounded-full border px-3.5 py-1.5 text-[13px] ${
        paused ? 'border-[#34d399] text-[#8ee6b4] hover:bg-[#0f2a1e]' : 'border-[#3a3936] text-[#cfcbc3] hover:border-[#6b6862]'
      }`}
    >
      <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true">
        {paused ? <path d="M3 1.5 L10.5 6 L3 10.5 Z" /> : <path d="M2.5 1.5 H5 V10.5 H2.5 Z M7 1.5 H9.5 V10.5 H7 Z" />}
      </svg>
      {paused ? 'Resume Jev' : 'Pause Jev'}
    </button>
  );
}

function Bar({ onForgetKey }: { onForgetKey?: () => void }) {
  const [snapshot, send, actorRef] = useMachine(barMachine);
  // The barista: a Jev agent invoked at the top of the bar. Its own snapshot
  // says whether it is deciding or paused, with its decisions; what its
  // hands are doing is the bar's.
  const agentRef = snapshot.children.barista as ActorRefFrom<BaristaAgent> | undefined;
  const agent = useSelector(agentRef, (s) => s);
  const ctx = barOf(snapshot);
  const state: BaristaState =
    agent?.value === 'paused' ? 'paused' : agent?.value === 'deciding' ? 'thinking' : ctx.hands.jev ? 'working' : 'watching';
  return (
    <BarView
      can={(move) => snapshot.can({ ...move, by: 'you' })}
      onPause={(paused) => agentRef?.send({ type: paused ? 'jev.pause' : 'jev.resume' })}
      onPace={(pace) => agentRef?.send({ type: 'jev.settle', ms: PACE_SETTLE[pace] })}
      // The context plus its regions' states: the portafilter, the pitcher, the equipment.
      ctx={ctx}
      intake={{
        clarifying: snapshot.matches({ intake: 'clarifying' }),
        routing: snapshot.matches({ intake: { clarifying: 'routing' } }),
        parsing: snapshot.matches({ intake: 'parsing' }),
      }}
      barista={{
        state,
        decisions: (agent?.context.decisions ?? []).map(toBarDecision),
        loop: agent?.context.loop ?? null,
        error: agent?.context.error ?? null,
        pace: agent?.context.settle ? 0.5 : 1,
        nextDecisionAt: agent?.context.nextAt ?? 0,
      }}
      send={send}
      inspect={actorRef}
      // When each running delay started and is due, from the actor system.
      timers={() => actorRef.system.getSnapshot()._scheduledTimers}
      onForgetKey={onForgetKey}
    />
  );
}

type BaristaState = 'watching' | 'thinking' | 'working' | 'paused';

const SIDE_TABS = ['History', 'Ingredients', 'Chaos'] as const;
type SideTab = (typeof SIDE_TABS)[number];

/** Under Jev's decision: its history, the ingredients, and chaos, one at a time. */
function SideTabs({ tab, onTab, historyCount }: { tab: SideTab; onTab: (tab: SideTab) => void; historyCount: number }) {
  const { barRef, pillRef } = useSlidingPill(SIDE_TABS.indexOf(tab));
  return (
    <div ref={barRef} className="t-tabs self-start text-xs" role="tablist" aria-label="Bar details">
      <span ref={pillRef} className="t-tabs-pill" aria-hidden="true" />
      {SIDE_TABS.map((t) => (
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
}

/** The whole screen, from the bar's state. */
export function BarView({ ctx: bar, intake, barista, send, inspect, timers, can, onPause, onPace, onForgetKey }: BarViewProps) {
  // The bar with the page's clock: when each running step started and is due.
  const ctx = useOnScreen(bar, timers);
  const [text, setText] = useState('a cap with almond milk and an espresso');
  const [tab, setTab] = useState<SideTab>('Ingredients');
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
              <div className="ml-auto flex gap-2">
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
              </div>
            </div>
          ) : null}
          <main className="grid min-h-[420px] min-w-0 grid-rows-[2.25rem_minmax(0,1fr)] gap-2 px-6 pt-4">
            <div className="flex h-9 min-w-0 items-center justify-between gap-4">
              <div className="flex min-w-0 items-center gap-2">
                <BaristaStatus state={state} hands={jevHands} ctx={ctx} nextMoveAt={barista.pace && barista.pace < 1 ? barista.nextDecisionAt : undefined} />
                {onPause ? <PauseButton paused={state === 'paused'} onToggle={() => onPause(state !== 'paused')} /> : null}
                {onPace ? <PaceControl pace={barista.pace ?? 1} onPace={onPace} /> : null}
                {/* Your hands, apart from Jev's: the second barista. */}
                {yourHands ? (
                  <div className="flex min-w-0 items-center gap-2 rounded-full bg-[#e8845f] px-3.5 py-1.5 text-[13px] font-medium text-[#1f0f08]">
                    <HandIcon size={15} />
                    <span className="min-w-0 truncate">
                      You: {yourHands.label}
                      {yourHands.drink ? ` · ${drinkTag(yourHands.drink.id, ctx.drinks)}` : ''}
                    </span>
                    <span className="secs shrink-0 font-normal opacity-70">{yourHands.secondsLeft.toFixed(1)}s</span>
                  </div>
                ) : null}
              </div>
              <p className={`min-w-0 truncate text-[13px] ${error && !parsing && !routing ? 'text-[#ff9aa0]' : 'text-[#a8a49c]'}`}>
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
              <SideTabs tab={tab} onTab={setTab} historyCount={Math.max(0, decisions.length - 1)} />
              {tab === 'History' ? (
                <DecisionHistory decisions={decisions} drinks={ctx.drinks} />
              ) : tab === 'Ingredients' ? (
                <Ingredients
                  inventory={ctx.inventory}
                  restocking={hands.find((h) => h.ingredient)?.ingredient}
                  onStock={(ingredient, amount) => send({ type: 'SET_STOCK', ingredient, amount })}
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
