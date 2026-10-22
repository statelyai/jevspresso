import { useEffect, useRef, useState } from 'react';
import { MODELS, modelInfo, type ModelId } from '../lib/models';
import type { DayScore } from '../lib/score';

export interface ScorecardProps {
  model: ModelId;
  seed: number;
  score: DayScore;
  /** Can a model run now (to offer the same day with it). */
  ready: (model: ModelId) => boolean;
  /** The same day, with this model. */
  onDay: (model: ModelId) => void;
  onNewDay: () => void;
  onLeave: () => void;
}

const QUIET = 'h-10 shrink-0 rounded-lg border border-[#3a3936] px-3.5 text-[13px] text-[#cfcbc3] hover:border-[#6b6862]';

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <dt className="text-[12px] tracking-wide text-[#6b6862] uppercase">{label}</dt>
      <dd className="tnum text-[14px] text-[#cfcbc3]">{children}</dd>
    </div>
  );
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The day is over: how the model did, and the same day with another. */
export function Scorecard({ model, seed, score: s, ready, onDay, onNewDay, onLeave }: ScorecardProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const others = MODELS.filter((m) => m.id !== model && ready(m.id));
  const [other, setOther] = useState<ModelId | undefined>(others[0]?.id);
  useEffect(() => {
    if (ref.current && !ref.current.open) ref.current.showModal();
  }, []);
  return (
    <dialog
      ref={ref}
      aria-labelledby="scorecard"
      onCancel={(e) => (e.preventDefault(), onLeave())}
      className="m-auto w-[calc(100%-3rem)] max-w-lg rounded-2xl border border-[#3a3936] bg-[#1d1d1b] p-6 text-[#faf9f5] shadow-[0_24px_64px_rgba(0,0,0,0.5)] backdrop:bg-[#141413]/70 backdrop:backdrop-blur-sm"
    >
      <div className="flex flex-col gap-5">
        <div className="flex flex-col gap-1">
          <h2 id="scorecard" className="text-lg font-semibold">
            Day #{seed} with {modelInfo(model).label}
          </h2>
          <p className="text-[13px] text-[#a8a49c]">The same customers and the same mishaps, at the same moments, whichever model runs it.</p>
        </div>
        <dl className="flex flex-col gap-4">
          <Row label="Taking orders">
            {s.readRightFirst} of {s.customers} read right first time · {plural(s.asks, 'ask')}
            {s.asks ? ` (${s.asksWhenRight} when it was right)` : ''} · {s.takenWrong} taken wrong · {s.walkedOut} walked out
            {s.neverTaken ? ` · ${s.neverTaken} never taken` : ''}
          </Row>
          <Row label="Making them">
            {s.served} served{s.servedWrong ? ` (${s.servedWrong} wrong cup)` : ''} · {s.declined} turned away · {s.unserved} never made
            {s.avgWaitS === null ? '' : ` · ${s.avgWaitS.toFixed(0)}s average wait`}
          </Row>
          <Row label="The model">
            {plural(s.calls, 'request')}
            {s.medianMs === null ? '' : ` · ${s.medianMs}ms median`}
            {s.failed ? ` · ${s.failed} failed` : ''}
          </Row>
        </dl>
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          {other ? (
            <div className="flex min-w-0 items-center gap-2">
              <button type="button" onClick={() => onDay(other)} className="h-10 shrink-0 rounded-lg bg-[#d97757] px-4 text-[13px] font-semibold text-[#141413]">
                Same day with
              </button>
              <select
                aria-label="Model for the same day"
                value={other}
                onChange={(e) => setOther(e.target.value as ModelId)}
                className="h-10 rounded-lg border border-[#3a3936] bg-[#141413] px-2.5 text-[13px] text-[#faf9f5]"
              >
                {others.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </select>
            </div>
          ) : null}
          <button type="button" onClick={() => onDay(model)} className={QUIET}>
            Again
          </button>
          <button type="button" onClick={onNewDay} className={QUIET}>
            New day
          </button>
          <button type="button" onClick={onLeave} className={`${QUIET} ml-auto`}>
            Back to the bar
          </button>
        </div>
      </div>
    </dialog>
  );
}
