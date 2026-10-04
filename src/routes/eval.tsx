import { createFileRoute } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import { ABLATIONS, ablated } from '../eval/ablations';
import { runScenario, SCENARIOS, type RunResult } from '../eval/scenarios';
import { logClient, type JevClient, type JevLogEntry } from '@xstate/jev';
import { jevClient } from '../lib/jev';
import { downloadLog } from '../lib/jevLog';
import { loadKey } from '../lib/key';

/**
 * The scenarios (`src/eval/scenarios.ts`), run with real Jev, with your key if
 * you gave one on the bar's page: each scenario several times, as shipped and
 * with parts of what Jev is shown taken out (`src/eval/ablations.ts`), on a
 * clock that waits for Jev or runs on while it thinks.
 */
export const Route = createFileRoute('/eval')({ component: Eval });

/** Results by ablation, then scenario. */
type Results = Record<string, Record<string, RunResult[]>>;

const mean = (xs: number[]) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10 : 0);
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

function Eval() {
  // One run each by default: Jev answers alike from run to run, and every run costs requests.
  const [times, setTimes] = useState(1);
  const [clock, setClock] = useState<'paused' | 'live'>('paused');
  const [chosen, setChosen] = useState<Set<string>>(() => new Set(['all']));
  const [results, setResults] = useState<Results>({});
  const [running, setRunning] = useState(false);
  const [open, setOpen] = useState<{ ablation: string; scenario: string } | null>(null);
  // Every request of the last run, with what came back, for a download.
  const log = useRef<Array<JevLogEntry & { ablation: string; scenario: string; run: number }>>([]);
  useEffect(() => void loadKey(), []);

  const run = async () => {
    setRunning(true);
    setResults({});
    log.current = [];
    const client = jevClient('barista');
    for (const ablation of ABLATIONS.filter((a) => chosen.has(a.id))) {
      // Every scenario's runs side by side; the ablations one after another.
      const runs = await Promise.all(
        SCENARIOS.map(
          async (s) =>
            [
              s.id,
              await Promise.all(
                Array.from({ length: times }, async (_, i) => {
                  // Count and log what is sent, after the ablation took its part out.
                  const sent = { requests: 0, chars: 0 };
                  const counting: JevClient = logClient(
                    (request) => {
                      sent.requests++;
                      sent.chars += JSON.stringify(request).length;
                      return client(request);
                    },
                    (entry) => log.current.push({ ablation: ablation.id, scenario: s.id, run: i + 1, ...entry }),
                  );
                  return { ...(await runScenario(s, ablated(counting, ablation), { clock, agent: ablation.agent })), ...sent };
                }),
              ),
            ] as const,
        ),
      );
      setResults((prev) => ({ ...prev, [ablation.id]: Object.fromEntries(runs) }));
    }
    setRunning(false);
  };

  const shown = open && results[open.ablation]?.[open.scenario];
  const done = Object.values(results).flatMap((r) => Object.values(r).flat());
  const tokens = (chars: number) => `${Math.round(chars / 4000)}k`;
  // What a run will cost, from the last one when there is one (else as measured: about 26 requests of 24k characters per scenario run).
  const perRun = done.length ? sum(done.map((x) => x.chars)) / done.length : 26 * 24_000;
  const planned = chosen.size * SCENARIOS.length * times;
  const firstError = done.find((x) => x.error)?.error;

  return (
    <main className="min-h-screen bg-[#141413] p-6 text-[#faf9f5]">
      <div className="mx-auto flex max-w-6xl flex-col gap-4">
        <header className="flex flex-wrap items-center gap-3">
          <h1 className="text-xl font-semibold">Barista scenarios</h1>
          <label className="ml-auto flex items-center gap-2 text-sm text-[#a8a49c]">
            Clock
            <select
              value={clock}
              onChange={(e) => setClock(e.target.value as 'paused' | 'live')}
              className="rounded border border-[#3d3d3a] bg-[#1f1e1d] px-2 py-1 text-[#faf9f5]"
            >
              <option value="paused">waits for Jev</option>
              <option value="live">runs on while Jev thinks (10×)</option>
            </select>
          </label>
          <label className="flex items-center gap-2 text-sm text-[#a8a49c]">
            Runs each
            <input
              type="number"
              min={1}
              max={10}
              value={times}
              onChange={(e) => setTimes(Math.max(1, Math.min(10, Number(e.target.value) || 1)))}
              className="w-16 rounded border border-[#3d3d3a] bg-[#1f1e1d] px-2 py-1 text-[#faf9f5]"
            />
          </label>
          <span className="text-xs text-[#6b6862]" data-estimate>
            {planned} runs · about {tokens(planned * perRun)} tokens
          </span>
          <button
            type="button"
            onClick={run}
            disabled={running || chosen.size === 0}
            className="rounded bg-[#d97757] px-4 py-1.5 text-sm font-semibold text-[#141413] disabled:opacity-50"
          >
            {running ? 'Running…' : 'Run'}
          </button>
        </header>
        <fieldset className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-[#a8a49c]">
          {ABLATIONS.map((a) => (
            <label key={a.id} className="flex items-center gap-1.5">
              <input
                type="checkbox"
                checked={chosen.has(a.id)}
                onChange={() =>
                  setChosen((prev) => {
                    const next = new Set(prev);
                    if (next.has(a.id)) next.delete(a.id);
                    else next.add(a.id);
                    return next;
                  })
                }
              />
              {a.label}
            </label>
          ))}
        </fieldset>
        {firstError ? (
          <p className="rounded border border-[#f0565f] px-3 py-2 text-sm text-[#ff9aa0]" data-error>
            {done.filter((x) => x.error).length} of {done.length} runs failed: {firstError}
          </p>
        ) : null}
        {done.length ? (
          <p className="flex items-center gap-3 text-xs text-[#a8a49c]" data-spent>
            Spent: {sum(done.map((x) => x.requests))} requests, about {tokens(sum(done.map((x) => x.chars)))} tokens
            <button
              type="button"
              onClick={() => downloadLog(log.current, 'jev-eval-log')}
              className="rounded border border-[#3d3d3a] px-2 py-0.5 text-[#cfcbc3]"
            >
              Download log
            </button>
          </p>
        ) : null}
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="text-[#a8a49c]">
              <tr>
                <th className="py-2 pr-3 font-normal">What Jev is shown</th>
                <th className="pr-3 font-normal">Right</th>
                {SCENARIOS.map((s) => (
                  <th key={s.id} className="pr-2 font-normal" title={s.label}>
                    {s.id}
                  </th>
                ))}
                <th className="pr-2 font-normal">Moves</th>
                <th className="pr-2 font-normal">Bar time</th>
                <th className="pr-2 font-normal">Wrong</th>
                <th className="pr-2 font-normal">Wasted shots</th>
                <th className="pr-2 font-normal">Poured away</th>
                <th className="pr-2 font-normal">Loops</th>
                <th className="pr-2 font-normal">Tokens/run</th>
                <th className="font-normal">Stalled</th>
              </tr>
            </thead>
            <tbody>
              {ABLATIONS.filter((a) => chosen.has(a.id)).map((a) => {
                const byScenario = results[a.id];
                const all = byScenario ? Object.values(byScenario).flat() : [];
                return (
                  <tr key={a.id} data-ablation={a.id} className="border-t border-[#3d3d3a]">
                    <td className="py-2 pr-3">{a.label}</td>
                    {byScenario ? (
                      <>
                        <td className="pr-3 font-semibold" data-total>
                          {all.filter((x) => x.ok).length}/{all.length}
                        </td>
                        {SCENARIOS.map((s) => {
                          const r = byScenario[s.id] ?? [];
                          const right = r.filter((x) => x.ok).length;
                          return (
                            <td
                              key={s.id}
                              data-cell={`${a.id}:${s.id}`}
                              onClick={() => setOpen({ ablation: a.id, scenario: s.id })}
                              className={`cursor-pointer pr-2 ${right === r.length ? 'text-[#8fd18f]' : 'text-[#ff9aa0]'}`}
                            >
                              {right}/{r.length}
                            </td>
                          );
                        })}
                        <td className="pr-2">{mean(all.map((x) => x.decisions))}</td>
                        <td className="pr-2">{mean(all.map((x) => x.seconds))}s</td>
                        <td className="pr-2">{sum(all.map((x) => x.wrong))}</td>
                        <td className="pr-2">{sum(all.map((x) => x.wastedShots))}</td>
                        <td className="pr-2">{sum(all.map((x) => x.dumped))}</td>
                        <td className="pr-2">{all.filter((x) => x.loops.length).length}</td>
                        <td className="pr-2">{tokens(mean(all.map((x) => x.chars)))}</td>
                        <td>{all.filter((x) => x.stalled).length}</td>
                      </>
                    ) : (
                      <td colSpan={SCENARIOS.length + 9} className="text-[#6b6862]">
                        {running ? '…' : ''}
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {shown ? (
          <section className="flex flex-col gap-1 text-xs text-[#a8a49c]" data-moves>
            <h2 className="text-sm text-[#faf9f5]">
              {ABLATIONS.find((a) => a.id === open.ablation)?.label} · {SCENARIOS.find((s) => s.id === open.scenario)?.label}
            </h2>
            {shown.map((x, i) => (
              <p key={i}>
                {x.ok ? '✓' : '✗'} {x.moves.map((m) => m.replace('barista.', '')).join(' → ')}
                {x.error ? ` (${x.error})` : ''}
              </p>
            ))}
          </section>
        ) : null}
        <p className="text-xs text-[#6b6862]">
          Right: runs where every order was served exactly right. Moves and bar time are averages; the rest are totals over all runs. Loops:
          runs where Jev looped (it is told, as on the page). Click a cell for each run's moves; a sabotage shows as !.
        </p>
      </div>
    </main>
  );
}
