import { createFileRoute, Link } from '@tanstack/react-router';
import { useMachine, useSelector } from '@xstate/react';
import { useState } from 'react';
import type { JevAgentContext, JevDecision } from '@xstate/jev';
import type { AnyActorRef } from 'xstate';
import { JevMark } from '../components/JevMark';
import { ForgetKeyIcon } from '../components/Header';
import { NeedsKey, useJevKey } from '../components/NeedsKey';
import { jevAvailable, jevClient } from '../lib/jev';
import { createLightMachine, isLit, type LampValue, type LightEvent } from '../machines/light';

/**
 * Jev's "Hello World", live: a lamp, your requests, and a bulb you can break.
 * The machine is in `src/machines/light.ts`; Jev is invoked at its top.
 */
export const Route = createFileRoute('/light')({
  loader: () => jevAvailable(),
  component: LightPage,
});

const lightMachine = createLightMachine(jevClient('light'));

const SUGGESTIONS = ['It’s getting dark in here', 'Too bright, I have a headache', 'I want to read', 'Lights out, time to sleep'];

const LABEL: Record<string, string> = {
  'lamp.switchOn': 'Switch on',
  'lamp.switchOff': 'Switch off',
  'lamp.replaceBulb': 'Replace bulb',
  noop: 'Wait',
};

const pct = (n: number) => `${Math.round(n * 100)}%`;

/** The bulb: lit and glowing, dark, or cracked with its filament snapped. */
function Bulb({ lit, broken }: { lit: boolean; broken: boolean }) {
  const on = lit;
  return (
    <svg viewBox="0 0 200 260" width="200" height="260" aria-hidden="true" className="overflow-visible">
      <defs>
        <radialGradient id="glow" cx="50%" cy="42%" r="60%">
          <stop offset="0%" stopColor="#fff6cf" />
          <stop offset="55%" stopColor="#ffd86b" />
          <stop offset="100%" stopColor="#f4a261" />
        </radialGradient>
        <filter id="halo" x="-100%" y="-100%" width="300%" height="300%">
          <feGaussianBlur stdDeviation="22" />
        </filter>
      </defs>
      {/* the light it throws */}
      <circle
        cx="100"
        cy="96"
        r="78"
        fill="#ffd86b"
        filter="url(#halo)"
        style={{ opacity: on ? 0.55 : 0, transition: 'opacity 400ms ease-out' }}
      />
      {/* glass */}
      <path
        d="M100 18 C55 18 30 52 30 92 C30 122 48 140 62 156 C70 166 72 176 72 186 L128 186 C128 176 130 166 138 156 C152 140 170 122 170 92 C170 52 145 18 100 18 Z"
        fill={on ? 'url(#glow)' : '#262624'}
        stroke={on ? '#ffe9a3' : broken ? '#6b6862' : '#4a4945'}
        strokeWidth="5"
        strokeDasharray={broken ? '210 14 60 10 400' : undefined}
        style={{ transition: 'fill 300ms ease-out' }}
      />
      {/* filament: whole, or snapped */}
      {broken ? (
        <g stroke="#6b6862" strokeWidth="4" strokeLinecap="round" fill="none">
          <path d="M84 186 L84 132 Q84 112 96 108" />
          <path d="M116 186 L116 132 Q116 116 108 112" />
        </g>
      ) : (
        <path
          d="M84 186 L84 132 Q84 104 100 104 Q116 104 116 132 L116 186"
          stroke={on ? '#fff6cf' : '#5a5955'}
          strokeWidth="4"
          strokeLinecap="round"
          fill="none"
        />
      )}
      {/* a crack, and a shard on the table */}
      {broken ? (
        <>
          <path d="M70 46 L88 70 L76 82 L96 104" stroke="#f0565f" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" fill="none" />
          <path d="M150 238 L166 230 L172 244 Z" fill="#3a3936" stroke="#6b6862" strokeWidth="3" strokeLinejoin="round" />
        </>
      ) : null}
      {/* screw base */}
      <rect x="70" y="186" width="60" height="44" rx="6" fill="#9197a0" />
      {[198, 210, 222].map((y) => (
        <path key={y} d={`M70 ${y} H130`} stroke="#6b707a" strokeWidth="4" />
      ))}
      <path d="M84 230 H116 L108 246 H92 Z" fill="#6b707a" />
    </svg>
  );
}

function LightPage() {
  const key = useJevKey(Route.useLoaderData());
  const [snapshot, send] = useMachine(lightMachine);
  const agentRef = snapshot.children.jev as AnyActorRef | undefined;
  const agent = useSelector(agentRef, (s) => s as { value: 'watching' | 'deciding' | 'paused'; context: JevAgentContext<LightEvent> } | undefined);
  const [text, setText] = useState('');
  const value = snapshot.value as LampValue;
  const lit = isLit(value);
  const broken = value.bulb === 'broken';
  const decisions = agent?.context.decisions ?? [];
  const latest: JevDecision<LightEvent> | undefined = decisions[0];
  const ask = (t: string) => {
    if (!t.trim()) return;
    send({ type: 'user.request', text: t.trim(), at: Date.now() });
    setText('');
  };
  const requests = [...snapshot.context.requests].reverse();

  return (
    <main className="min-h-screen bg-[#141413] text-[#faf9f5]">
      <header className="flex items-center gap-4 border-b border-[#2a2a28] px-6 py-4">
        <h1 className="text-xl font-semibold tracking-[-0.01em]">
          Jevspresso <span className="text-[#6b6862]">/ light</span>
        </h1>
        <span className="hidden text-[13px] text-[#a8a49c] sm:inline">Jev’s Hello World: a lamp, your requests, and a bulb that breaks</span>
        {key.forget ? (
          <button
            type="button"
            onClick={key.forget}
            aria-label="Forget key"
            title="Remove your Jev key from this browser"
            className="ml-auto flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-lg border border-[#3a3936] text-[#cfcbc3] hover:border-[#6b6862]"
          >
            <ForgetKeyIcon />
          </button>
        ) : null}
        <Link
          to="/"
          className={`${key.forget ? '' : 'ml-auto '}rounded-lg border border-[#3a3936] px-3.5 py-2 text-[13px] text-[#cfcbc3] hover:border-[#6b6862]`}
        >
          Espresso bar →
        </Link>
      </header>

      <div className="mx-auto grid max-w-5xl gap-8 px-6 py-8 md:grid-cols-[minmax(0,1fr)_320px]">
        <section aria-label="Lamp" className="flex min-w-0 flex-col items-center gap-6">
          <div className="flex h-[300px] items-center justify-center">
            <Bulb lit={lit} broken={broken} />
          </div>
          <div className="flex items-center gap-3">
            <span
              className={`rounded-full px-3 py-1 text-[13px] font-medium ${lit ? 'bg-[#ffd86b] text-[#141413]' : 'bg-[#1d1d1b] text-[#a8a49c]'}`}
            >
              {lit ? 'Lit' : 'Dark'}
            </span>
            <span className="text-[13px] text-[#a8a49c]">
              Switch {value.switch} · bulb {broken ? <span className="text-[#ff9aa0]">broken</span> : 'ok'}
            </span>
            <button
              type="button"
              onClick={() => send({ type: 'BREAK' })}
              disabled={broken}
              className="rounded-full border border-[#f0565f] px-3 py-1 text-[13px] text-[#ff9aa0] hover:bg-[#2a1416] disabled:opacity-40"
            >
              Break the bulb
            </button>
          </div>

          <form
            className="flex w-full max-w-md gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              ask(text);
            }}
          >
            <label htmlFor="request" className="sr-only">
              Ask for something
            </label>
            <input
              id="request"
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Ask for something…"
              className="h-11 min-w-0 grow rounded-lg border border-[#3a3936] bg-[#1d1d1b] px-3.5 text-[15px]"
            />
            <button type="submit" className="h-11 shrink-0 rounded-lg bg-[#d97757] px-5 text-sm font-semibold text-[#141413]">
              Ask
            </button>
          </form>
          <div className="flex max-w-md flex-wrap justify-center gap-2">
            {SUGGESTIONS.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => ask(s)}
                className="rounded-full border border-[#3a3936] px-3 py-1 text-[13px] text-[#cfcbc3] hover:border-[#6b6862]"
              >
                {s}
              </button>
            ))}
          </div>

          <ol aria-label="Requests" className="flex w-full max-w-md flex-col gap-1.5 text-[13px]">
            {requests.length === 0 ? <li className="text-center text-[#6b6862]">No requests yet: Jev has nothing to do.</li> : null}
            {requests.map((r, i) => (
              <li key={r.id} className={`flex justify-between gap-3 ${i === 0 ? 'text-[#faf9f5]' : 'text-[#6b6862]'}`}>
                <span className="min-w-0 truncate">“{r.text}”</span>
                {i === 0 ? <span className="shrink-0 text-[#a8a49c]">latest</span> : null}
              </li>
            ))}
          </ol>
        </section>

        <aside aria-label="Jev" className="flex min-w-0 flex-col gap-4">
          <div className="flex flex-col gap-3 rounded-xl border border-[#2a2a28] bg-[#1d1d1b] p-4">
            <div className="flex items-center justify-between gap-3">
              <span className="flex items-center gap-2 text-[13px] text-[#a8a49c]">
                <JevMark size={11} className={agent?.value === 'deciding' ? 'animate-pulse' : undefined} />
                {agent?.value === 'deciding' ? 'Deciding…' : agent?.value === 'paused' ? 'Paused' : 'Watching the lamp'}
              </span>
              <button
                type="button"
                onClick={() => agentRef?.send({ type: agent?.value === 'paused' ? 'jev.resume' : 'jev.pause' })}
                className="rounded-full border border-[#3a3936] px-2.5 py-0.5 text-[12px] text-[#cfcbc3] hover:border-[#6b6862]"
              >
                {agent?.value === 'paused' ? 'Resume' : 'Pause'}
              </button>
            </div>
            {latest ? (
              <>
                <div className="flex items-baseline justify-between gap-3">
                  <span className="text-lg font-semibold">{LABEL[latest.option?.id ?? 'noop'] ?? latest.option?.id}</span>
                  {latest.option ? <span className="tnum text-lg font-semibold text-[#8ee6b4]">{pct(latest.probabilities[latest.option.id] ?? 0)}</span> : null}
                </div>
                <ul className="flex flex-col gap-1.5 text-[13px] text-[#a8a49c]">
                  {[...latest.options]
                    .sort((a, b) => (latest.probabilities[b.id] ?? 0) - (latest.probabilities[a.id] ?? 0))
                    .map((o) => (
                      <li key={o.id} className="flex flex-col gap-1" title={o.description}>
                        <span className="flex justify-between gap-2">
                          <span>{LABEL[o.id] ?? o.id}</span>
                          <span className="tnum">{pct(latest.probabilities[o.id] ?? 0)}</span>
                        </span>
                        <span className="h-1 rounded-full bg-[#2a2a28]">
                          <span
                            className="block h-1 rounded-full bg-[#6b6862]"
                            style={{ width: pct(latest.probabilities[o.id] ?? 0), background: o.id === latest.option?.id ? '#34d399' : undefined }}
                          />
                        </span>
                      </li>
                    ))}
                </ul>
                <p className="text-xs text-[#6b6862]">
                  Its options were only what the lamp accepted when it chose{agent?.value === 'deciding' ? ': it is looking again' : ''}.
                </p>
              </>
            ) : (
              <p className="text-[13px] text-[#6b6862]">No decisions yet.</p>
            )}
            {agent?.context.error ? <p className="text-xs text-[#ff9aa0]">{agent.context.error}</p> : null}
          </div>

          <section aria-label="History" className="flex flex-col gap-2 text-[13px]">
            <h2 className="text-[13px] text-[#a8a49c]">History</h2>
            <ol className="flex flex-col gap-1">
              {/* Keyed by place from the oldest kept: a row keeps its key as new decisions come in. */}
              {decisions.slice(1, 12).map((d, i) => (
                <li key={decisions.length - 1 - i} className="flex justify-between gap-2 text-[#cfcbc3]">
                  <span>{LABEL[d.option?.id ?? 'noop'] ?? d.option?.id}</span>
                  <span className="tnum text-[#6b6862]">{d.option ? pct(d.probabilities[d.option.id] ?? 0) : '—'}</span>
                </li>
              ))}
              {decisions.length < 2 ? <li className="text-[#6b6862]">Nothing yet</li> : null}
            </ol>
          </section>

          <section aria-label="How it works" className="rounded-xl border border-[#2a2a28] p-4 text-[13px] leading-relaxed text-[#a8a49c]">
            <h2 className="mb-1.5 text-[#faf9f5]">How it works</h2>
            Your request goes into the lamp’s context. Jev, invoked at the top of the lamp’s machine, sees it change and picks
            from what the lamp accepts right now: flip the switch, replace a broken bulb, or wait. It is never told how a lamp
            works: each option says what it comes to, down to whether the room is lit.
          </section>
        </aside>
      </div>
      {key.missing ? <NeedsKey onKey={key.save} /> : null}
    </main>
  );
}
