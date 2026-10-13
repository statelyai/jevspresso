import { useEffect, useRef, useState } from 'react';
import { forgetCredentials, loadCredentials, saveCredentials, type Credentials } from '../lib/key';
import { modelInfo, type ModelId } from '../lib/models';

const REPO = 'https://github.com/statelyai/jevspresso';

/**
 * The keys a model runs on: the server's, or your own from this browser.
 * Yours are `undefined` until the page is in the browser, `null` when there
 * are none.
 */
export function useModelKey(model: ModelId, serverHasKey: boolean) {
  const provider = modelInfo(model).provider;
  const [credentials, setCredentials] = useState<Credentials | null | undefined>(undefined);
  useEffect(() => setCredentials(provider ? loadCredentials(provider) : null), [provider]);
  return {
    /** Show the "needs a key" note over the page. */
    missing: !serverHasKey && credentials === null,
    /** Take your own keys out of this browser, when they are yours in use. */
    forget: !serverHasKey && provider && credentials ? () => (forgetCredentials(provider), setCredentials(null)) : undefined,
    save: (c: Credentials) => {
      if (provider) saveCredentials(provider, c);
      setCredentials(c);
    },
  };
}

/** Jev's key: the server's, or yours. */
export function useJevKey(serverHasKey: boolean) {
  return useModelKey('jev', serverHasKey);
}

const FIELD = 'h-11 min-w-0 grow rounded-lg border border-[#3a3936] bg-[#141413] px-3.5 text-[15px] text-[#faf9f5]';

/**
 * No key for the model on the server or in this browser: run it yourself, or
 * bring your own. `onCancel` offers a way back to a model that has one.
 */
export function NeedsKey({ model = 'jev', onKey, onCancel }: { model?: ModelId; onKey: (credentials: Credentials) => void; onCancel?: () => void }) {
  const info = modelInfo(model);
  const [key, setKey] = useState('');
  const [account, setAccount] = useState('');
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (ref.current && !ref.current.open) ref.current.showModal();
  }, []);
  const credentials: Credentials | null =
    info.provider === 'typesafe' ? (key.trim() ? { key: key.trim() } : null)
    : info.provider === 'cloudflare' ? (key.trim() && account.trim() ? { account: account.trim(), token: key.trim() } : null)
    : null;
  return (
    // A native modal dialog: focus moves into it, and the page behind is inert.
    // Escape does not close it: there is nothing to do here without a key.
    <dialog
      ref={ref}
      aria-labelledby="needs-key"
      onCancel={(e) => e.preventDefault()}
      className="m-auto w-[calc(100%-3rem)] max-w-md rounded-2xl border border-[#3a3936] bg-[#1d1d1b] p-6 text-[#faf9f5] shadow-[0_24px_64px_rgba(0,0,0,0.5)] backdrop:bg-[#141413]/70 backdrop:backdrop-blur-sm"
    >
      <div className="flex flex-col gap-5">
        <div className="flex flex-col gap-2">
          <h2 id="needs-key" className="text-lg font-semibold">
            {info.label} needs a key
          </h2>
          <p className="text-[14px] text-[#a8a49c]">
            {info.label} makes every move behind this bar, and asks a model each time. Run Jevspresso yourself with your own key
            {info.provider === 'typesafe'
              ? ', or use your TypeSafe key here.'
              : info.provider === 'cloudflare'
                ? ', or use your Cloudflare account ID and a Workers AI token here.'
                : `: ${info.label} is only reachable from the server.`}
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
        {info.provider ? (
          <form
            className="flex flex-col gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (credentials) onKey(credentials);
            }}
          >
            <label htmlFor="model-key" className="text-[13px] text-[#a8a49c]">
              Or use your own {info.provider === 'cloudflare' ? 'account' : 'key'}
            </label>
            {info.provider === 'cloudflare' ? (
              <input
                aria-label="Cloudflare account ID"
                autoComplete="off"
                spellCheck={false}
                value={account}
                onChange={(e) => setAccount(e.target.value)}
                placeholder="Your Cloudflare account ID"
                className={FIELD}
              />
            ) : null}
            <div className="flex min-w-0 gap-2">
              <input
                id="model-key"
                type="password"
                autoComplete="off"
                spellCheck={false}
                value={key}
                onChange={(e) => setKey(e.target.value)}
                placeholder={info.provider === 'cloudflare' ? 'A Workers AI API token' : 'Your TypeSafe key'}
                className={FIELD}
              />
              <button
                type="submit"
                disabled={!credentials}
                className="h-11 shrink-0 rounded-lg bg-[#d97757] px-5 text-sm font-semibold text-[#141413] disabled:opacity-50"
              >
                Open the bar
              </button>
            </div>
            <p className="text-[12px] text-[#6b6862]">
              Saved in this browser only. It goes along with each {info.label} request through this app&apos;s server, which uses it
              for that call and keeps nothing. Forget it any time from the header.
            </p>
          </form>
        ) : null}
        {onCancel ? (
          <button type="button" onClick={onCancel} className="self-start text-[13px] text-[#a8a49c] underline-offset-2 hover:underline">
            Use Jev instead
          </button>
        ) : null}
      </div>
    </dialog>
  );
}
