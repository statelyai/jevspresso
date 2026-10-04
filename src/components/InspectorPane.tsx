import { useEffect, useState } from 'react';
import type { AnyActor } from 'xstate';

type Status = 'connecting' | 'connected' | 'error';

/** Machine contexts, minus the barista's decision log, which the DecisionCard already shows. */
function serializeSnapshot(snapshot: { value: unknown; status: unknown; context?: unknown; tags?: Iterable<string> }) {
  const context = snapshot.context;
  return {
    value: snapshot.value,
    status: snapshot.status,
    tags: snapshot.tags ? [...snapshot.tags] : [],
    ...(context && typeof context === 'object' ? { context: { ...context, decisions: undefined } } : {}),
  };
}

type MachineSources = Record<string, string>;

/**
 * What the viewer draws for each actor. Our machines are sent as their source
 * text, keyed by machine id: a config only carries transition functions as
 * opaque values, so their targets (`{ target: 'thinking' }`) would be missing.
 * Anything else falls back to its config, minus `actors` (a registered
 * `StateMachine` does not serialize to JSON).
 */
function machineExtractor(sources: MachineSources) {
  return (actor: { logic?: { config?: unknown } }) => {
    const config = actor.logic?.config as { id?: string; actors?: unknown } | undefined;
    const source = config?.id ? sources[config.id] : undefined;
    if (source) return source;
    return config && typeof config === 'object' && 'actors' in config ? { ...config, actors: undefined } : config;
  };
}

/** The SDK plus the authored source of each machine, loaded in the browser only. */
async function loadInspection() {
  const [{ createInspector }, bar, jev] = await Promise.all([
    import('@statelyai/sdk/inspect'),
    import('../machines/espressoBar.ts?raw'),
    import('../../packages/jev/src/runtime.ts?raw'),
  ]);
  // The barista and the order router are Jev agents: one machine, `jev`.
  const sources: MachineSources = { espressoBar: bar.default, jev: jev.default };
  return { createInspector, sources };
}

/**
 * The live actor system, streamed to the hosted Stately inspector and shown in
 * an iframe. Created in the browser only, after mount, so the server render
 * never opens a relay connection.
 */
export function InspectorPane({ actor }: { actor: AnyActor }) {
  const [url, setUrl] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>('connecting');

  useEffect(() => {
    let cancelled = false;
    let cleanup = () => {};
    void loadInspection().then(({ createInspector, sources }) => {
      if (cancelled) return;
      const inspector = createInspector({
        name: 'Jevspresso',
        theme: 'dark',
        selectedSessionId: actor.sessionId,
        serializeSnapshot,
        extractMachine: machineExtractor(sources),
        // The Stately editor's inspect page, which draws each machine from
        // its source text.
        inspectorBaseUrl: 'https://editor.stately.ai/inspect',
      });
      const subscription = inspector.attach(actor);
      cleanup = () => {
        subscription.unsubscribe();
        inspector.destroy();
      };
      setUrl(inspector.inspectorUrl);
      inspector.ready.then(
        () => !cancelled && setStatus('connected'),
        () => !cancelled && setStatus('error'),
      );
    });
    return () => {
      cancelled = true;
      cleanup();
    };
  }, [actor]);

  return (
    <section
      aria-label="Stately inspector"
      className="flex h-[55vh] min-w-0 shrink-0 flex-col border-t border-[#2a2a28] lg:h-auto lg:w-[40%] lg:min-w-[420px] lg:border-t-0 lg:border-l"
    >
      <div className="flex min-w-0 items-center justify-between gap-2 border-b border-[#2a2a28] px-4 py-2.5">
        <h2 className="min-w-0 truncate text-[11px] uppercase tracking-[0.12em] text-[#a8a49c]">
          Stately inspector
        </h2>
        <div className="flex shrink-0 items-center gap-3 text-xs text-[#a8a49c]">
          <span className={status === 'error' ? 'text-[#f0565f]' : status === 'connected' ? 'text-[#8ee6b4]' : ''}>
            {status}
          </span>
          {url ? (
            <a href={url} target="_blank" rel="noreferrer" className="underline hover:text-[#faf9f5]">
              open in new tab
            </a>
          ) : null}
        </div>
      </div>
      {url ? (
        <iframe title="Stately inspector" src={url} className="min-h-0 w-full grow border-0 bg-[#141413]" />
      ) : (
        <p className="p-4 text-[13px] text-[#a8a49c]">starting the inspector…</p>
      )}
    </section>
  );
}
