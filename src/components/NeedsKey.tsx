import { useEffect, useRef, useState } from 'react';
import { forgetKeys, loadKeys, saveKey, type Credentials, type PageKeys } from '../lib/key';
import { GATEWAYS, gatewaysFor, modelInfo, reaches, type Gateway, type KeyHolder, type ModelId } from '../lib/models';

const REPO = 'https://github.com/statelyai/jevspresso';

/** The keys you gave in this browser: `undefined` until the page is in the browser. */
export function usePageKeys() {
  const [keys, setKeys] = useState<PageKeys | undefined>(undefined);
  // Counts your changes (not the first read): what the bar was doing with the old keys is moot.
  const [changes, setChanges] = useState(0);
  useEffect(() => setKeys(loadKeys()), []);
  return {
    keys,
    changes,
    /** Whose keys you gave. */
    holders: Object.keys(keys ?? {}) as KeyHolder[],
    save: (holder: KeyHolder, credentials: Credentials) => {
      setKeys(saveKey(holder, credentials));
      setChanges((n) => n + 1);
    },
    forget: () => {
      setKeys(forgetKeys());
      setChanges((n) => n + 1);
    },
  };
}

/** A model's keys: the server's, or yours from this browser (a gateway's, or its maker's). */
export function useModelKey(model: ModelId, serverHasKey: boolean) {
  const page = usePageKeys();
  return {
    ...page,
    /** Show the "needs a key" note over the page. */
    missing: !serverHasKey && page.keys !== undefined && !reaches(model, page.holders),
    /** Take your keys out of this browser, when you gave any. */
    forget: page.holders.length ? page.forget : undefined,
  };
}

/** Jev's key: the server's, or yours. */
export function useJevKey(serverHasKey: boolean) {
  return useModelKey('jev', serverHasKey);
}

const FIELD = 'h-11 min-w-0 grow rounded-lg border border-[#3a3936] bg-[#141413] px-3.5 text-[15px] text-[#faf9f5]';
const SUBMIT = 'h-11 shrink-0 rounded-lg bg-[#d97757] px-5 text-sm font-semibold text-[#141413] disabled:opacity-50';
const NOTE = 'text-[12px] text-[#6b6862]';

/**
 * No key for the model on the server or in this browser: run it yourself, or
 * bring your own key: a gateway's, which reaches every model it carries, or
 * the model's maker's. `onCancel` offers a way back to Jev.
 */
export function NeedsKey({
  model = 'jev',
  onKey,
  onCancel,
}: {
  model?: ModelId;
  onKey: (holder: KeyHolder, credentials: Credentials) => void;
  onCancel?: () => void;
}) {
  const info = modelInfo(model);
  const gateways = gatewaysFor(model);
  const [gateway, setGateway] = useState<Gateway | undefined>(gateways[0]);
  const [gatewayKey, setGatewayKey] = useState('');
  const [key, setKey] = useState('');
  const [account, setAccount] = useState('');
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (ref.current && !ref.current.open) ref.current.showModal();
  }, []);
  const own: Credentials | null =
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
            {info.label} makes every move behind this bar, and asks a model each time. Run Jevspresso yourself with your own keys, or
            give one here{gateways.length ? ': a gateway key reaches every model the gateway carries, so you can switch between them' : ''}.
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
        {gateway ? (
          <form
            className="flex flex-col gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (gatewayKey.trim()) onKey(gateway, { key: gatewayKey.trim() });
            }}
          >
            <div className="flex items-center justify-between gap-2">
              <label htmlFor="gateway-key" className="text-[13px] text-[#a8a49c]">
                One key for every model
              </label>
              {gateways.length > 1 ? (
                <select
                  aria-label="Gateway"
                  value={gateway}
                  onChange={(e) => setGateway(e.target.value as Gateway)}
                  className="h-8 rounded-lg border border-[#3a3936] bg-[#141413] px-2 text-[13px] text-[#faf9f5]"
                >
                  {gateways.map((g) => (
                    <option key={g} value={g}>
                      {GATEWAYS[g].label}
                    </option>
                  ))}
                </select>
              ) : (
                <span className="text-[13px] text-[#a8a49c]">{GATEWAYS[gateway].label}</span>
              )}
            </div>
            <div className="flex min-w-0 gap-2">
              <input
                id="gateway-key"
                type="password"
                autoComplete="off"
                spellCheck={false}
                value={gatewayKey}
                onChange={(e) => setGatewayKey(e.target.value)}
                placeholder={`Your ${GATEWAYS[gateway].keyName}`}
                className={FIELD}
              />
              <button type="submit" disabled={!gatewayKey.trim()} className={SUBMIT}>
                Open the bar
              </button>
            </div>
          </form>
        ) : null}
        {info.provider ? (
          <form
            className="flex flex-col gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (own && info.provider) onKey(info.provider, own);
            }}
          >
            <label htmlFor="model-key" className="text-[13px] text-[#a8a49c]">
              {gateway ? 'Or ' : ''}
              {info.provider === 'cloudflare' ? 'your Cloudflare account' : 'your TypeSafe key'}, for {info.label} only
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
              <button type="submit" disabled={!own} className={SUBMIT}>
                Open the bar
              </button>
            </div>
          </form>
        ) : null}
        <p className={NOTE}>
          Saved in this browser only. A key goes along with the requests it can serve, through this app&apos;s server, which uses it
          for that call and keeps nothing. Forget your keys any time from the header.
        </p>
        {onCancel ? (
          <button type="button" onClick={onCancel} className="self-start text-[13px] text-[#a8a49c] underline-offset-2 hover:underline">
            Use Jev instead
          </button>
        ) : null}
      </div>
    </dialog>
  );
}
