import { useEffect, useState } from 'react';
import { forgetKey, loadKey, saveKey } from '../lib/key';

const REPO = 'https://github.com/statelyai/jevspresso';

/**
 * The Jev key in use: the server's, or your own from this browser. `key` is
 * `undefined` until the page is in the browser, `null` when there is none.
 */
export function useJevKey(serverHasKey: boolean) {
  const [key, setKey] = useState<string | null | undefined>(undefined);
  useEffect(() => setKey(loadKey()), []);
  return {
    /** Show the "needs a key" note over the page. */
    missing: !serverHasKey && key === null,
    /** Take your own key out of this browser, when it is yours in use. */
    forget: !serverHasKey && key ? () => (forgetKey(), setKey(null)) : undefined,
    save: (k: string) => (saveKey(k), setKey(k)),
  };
}

/** No Jev key on the server or in this browser: run it yourself, or bring your own key. */
export function NeedsKey({ onKey }: { onKey: (key: string) => void }) {
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
