import type { JevLoop } from '@xstate/jev';
import type { Decision, Drink } from '../lib/types';
import { optionLabel } from '../lib/view';
import { JevMark } from './JevMark';

function pct(n: number) {
  return `${Math.round(n * 100)}%`;
}

function ago(at: number, now: number) {
  const s = Math.max(0, Math.round((now - at) / 1000));
  return s < 60 ? `${s}s ago` : `${Math.floor(s / 60)}m ago`;
}

/** What happened to the pick, when it was not simply sent. */
function flag(d: Decision): { text: string; tone: string } | null {
  if (d.reason === 'low-confidence') return { text: 'Unsure, did nothing', tone: 'text-[#ffc48a]' };
  if (d.event && !d.sent) return { text: 'Too late, bar moved on', tone: 'text-[#ffc48a]' };
  return null;
}

function ranked(d: Decision) {
  return [...d.options].sort((a, b) => (d.probabilities[b.id] ?? 0) - (d.probabilities[a.id] ?? 0));
}

export interface DecisionCardProps {
  decisions: Decision[];
  drinks: Drink[];
  now: number;
  thinking: boolean;
  loop?: JevLoop | null;
  /** Jev is not being asked: a person is working the bar. */
  paused?: boolean;
}

/**
 * Jev's latest pick and the options it weighed. Every slot is always drawn
 * (three runner-ups, the details and the status line) so the card keeps one
 * size as decisions come and go.
 */
export function DecisionCard({ decisions, drinks, now, thinking, loop, paused }: DecisionCardProps) {
  const latest = decisions[0];
  const pick = latest?.option ?? null;
  const p = (id: string) => latest?.probabilities[id] ?? 0;
  const others = latest ? ranked(latest).filter((o) => o.id !== pick?.id).slice(0, 3) : [];
  const f = latest ? flag(latest) : null;
  // An idle loop means the barista is backing off (asking less often): say so, with a clock.
  const status = paused
    ? { text: 'Paused', tone: 'text-[#a8a49c]', title: undefined, clock: false }
    : loop
    ? loop.kind === 'idle'
      ? { text: 'Asking less often · nothing changes', tone: 'text-[#ffc48a]', title: loop.message, clock: true }
      : { text: `Possible loop · ${loop.chosen.slice(-4).join(' → ')}`, tone: 'text-[#ffc48a]', title: loop.message, clock: false }
    : f
      ? { ...f, title: undefined, clock: false }
      : null;

  return (
    <section aria-label="Jev" aria-live="polite" className="flex min-w-0 flex-col gap-3 rounded-xl border border-[#2a2a28] bg-[#1d1d1b] p-4">
        <div className="flex h-7 min-w-0 items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2">
            <JevMark size={12} color={thinking || !latest ? '#a8a49c' : '#34d399'} className={thinking ? 'animate-pulse' : undefined} />
            <span className={`min-w-0 truncate ${latest ? 'text-lg font-semibold' : 'text-[15px] text-[#a8a49c]'}`} title={pick?.description}>
              {latest ? (pick ? optionLabel(pick, drinks) : 'Nothing') : thinking ? 'Thinking…' : 'No decisions yet'}
            </span>
          </div>
          {pick ? <span className="tnum shrink-0 text-lg font-semibold text-[#8ee6b4]">{pct(p(pick.id))}</span> : null}
        </div>
        <div className="h-1.5 rounded-full bg-[#2a2a28]">
          <div className="m-bar h-1.5 rounded-full bg-[#34d399]" style={{ width: pct(pick ? p(pick.id) : 0) }} />
        </div>
        {[0, 1, 2].map((i) => {
          const o = others[i];
          return (
            <div key={i} className={`flex min-w-0 flex-col gap-1 ${o ? '' : 'invisible'}`} title={o?.description} aria-hidden={!o}>
              <div className="flex min-w-0 justify-between gap-2 text-[13px] text-[#a8a49c]">
                <span className="min-w-0 truncate">{o ? optionLabel(o, drinks) : '\u00a0'}</span>
                <span className="tnum shrink-0">{o ? pct(p(o.id)) : ''}</span>
              </div>
              <div className="h-1 rounded-full bg-[#2a2a28]">
                <div className="m-bar h-1 rounded-full bg-[#6b6862]" style={{ width: pct(o ? p(o.id) : 0) }} />
              </div>
            </div>
          );
        })}
        <div className="tnum flex h-4 min-w-0 gap-x-2 overflow-hidden text-xs whitespace-nowrap text-[#6b6862]">
          {latest ? (
            <>
              <span>{pct(latest.confidence)} sure</span>
              <span>·</span>
              <span>{latest.cached ? <span className="text-[#8ee6b4]">cached</span> : `${latest.latencyMs}ms`}</span>
              <span>·</span>
              <span>{ago(latest.at, now)}</span>
            </>
          ) : null}
        </div>
        <p role="status" className={`flex h-4 min-w-0 items-center gap-1.5 text-xs ${status?.tone ?? ''}`} title={status?.title}>
          {status?.clock ? (
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true" className="shrink-0">
              <circle cx="8" cy="8" r="6.5" />
              <path d="M8 4.5V8l2.5 1.5" />
            </svg>
          ) : null}
          <span className="min-w-0 truncate">{status?.text ?? ''}</span>
        </p>
    </section>
  );
}

/** Jev's decisions before the latest, newest first. */
export function DecisionHistory({ decisions, drinks }: { decisions: Decision[]; drinks: Drink[] }) {
  return (
    <ol aria-label="History" className="flex min-w-0 flex-col gap-2 text-[13px]">
      {decisions.length < 2 ? <li className="text-[#6b6862]">Nothing yet</li> : null}
      {decisions.slice(1, 41).map((d, i) => (
        <li key={`${d.at}-${i}`} className="flex min-w-0 justify-between gap-2">
          <span className="min-w-0 truncate">{d.option ? optionLabel(d.option, drinks) : 'Nothing'}</span>
          <span className="tnum shrink-0 text-[#a8a49c]">
            {d.option ? pct(d.probabilities[d.option.id] ?? 0) : '—'}
            {d.cached ? ' · cached' : ''}
          </span>
        </li>
      ))}
    </ol>
  );
}
