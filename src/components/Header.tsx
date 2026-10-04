import { useSlidingPill } from './motion';

export interface HeaderProps {
  text: string;
  onText: (text: string) => void;
  onSubmit: () => void;
  onRush: () => void;
  /** While Jev asks "did you mean…?", the box takes a reply instead of an order. */
  replying: boolean;
  speed: number;
  onSpeed: (speed: number) => void;
  onReset: () => void;
  inspectorOpen: boolean;
  onInspector: () => void;
  /** When the Jev key in use is yours, from this browser: take it out. */
  onForgetKey?: () => void;
  /** Save Jev's requests and responses so far. */
  onDownloadLog?: () => void;
}

const SPEEDS = [1, 5, 10];
const QUIET = 'shrink-0 rounded-lg border border-[#3a3936] px-3.5 py-2 text-[13px] text-[#cfcbc3] hover:border-[#6b6862]';
/** A button that is only an icon: square, the same height as the others. */
const ICON = 'flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-lg border border-[#3a3936] text-[#cfcbc3] hover:border-[#6b6862]';

function DownloadIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M8 2v8M4.5 6.5 8 10l3.5-3.5M2.5 13.5h11" />
    </svg>
  );
}

/** A key, struck out with an x: take your key out of this browser. */
function ForgetKeyIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="5" cy="8.5" r="2.75" />
      <path d="M7.75 8.5H12.5M10.5 8.5v2M12.5 8.5v1.5" />
      <path d="M11 2l3 3M14 2l-3 3" />
    </svg>
  );
}

export function Header(props: HeaderProps) {
  const { text, onText, onSubmit, onRush, replying, speed, onSpeed, onReset, inspectorOpen, onInspector, onForgetKey, onDownloadLog } = props;
  const { barRef, pillRef } = useSlidingPill(Math.max(0, SPEEDS.indexOf(speed)));

  return (
    <header className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-3 border-b border-[#2a2a28] px-6 py-3.5 @4xl:h-[72px] @4xl:flex-nowrap">
      <h1 className="shrink-0 text-xl font-semibold tracking-[-0.01em]">Jevspresso</h1>

      <form
        className="order-last flex min-w-0 basis-full gap-2 @4xl:order-none @4xl:basis-auto @4xl:grow"
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit();
        }}
      >
        <label htmlFor="order" className="sr-only">
          {replying ? 'Reply' : 'Order'}
        </label>
        <input
          id="order"
          value={text}
          onChange={(e) => onText(e.target.value)}
          placeholder={replying ? 'yes, that’s right / no, start over' : 'a cap with almond milk'}
          className={`h-11 min-w-0 grow rounded-lg border bg-[#1d1d1b] px-3.5 text-[15px] text-[#faf9f5] ${
            replying ? 'border-[#f4a261]' : 'border-[#3a3936]'
          }`}
        />
        <button type="submit" className="h-11 shrink-0 rounded-lg bg-[#d97757] px-5 text-sm font-semibold text-[#141413]">
          {replying ? 'Reply' : 'Order'}
        </button>
        <button type="button" onClick={onRush} className={`${QUIET} h-11`}>
          Rush
        </button>
      </form>

      <div className="ml-auto flex shrink-0 items-center gap-3 @4xl:ml-0">
        {/* The pill glides between 1× / 5× / 10×. */}
        <div ref={barRef} className="t-tabs shrink-0 text-xs" role="tablist" aria-label="Simulation speed">
          <span ref={pillRef} className="t-tabs-pill" aria-hidden="true" />
          {SPEEDS.map((s) => (
            <button
              key={s}
              type="button"
              className="t-tab tnum"
              role="tab"
              aria-selected={speed === s}
              aria-label={`${s} times speed`}
              onClick={() => onSpeed(s)}
            >
              {s}×
            </button>
          ))}
        </div>
        <button type="button" onClick={onReset} className={QUIET}>
          Reset
        </button>
        {onDownloadLog ? (
          <button type="button" onClick={onDownloadLog} className={ICON} aria-label="Download Jev's log" title="Download Jev's requests and responses (JSON)">
            <DownloadIcon />
          </button>
        ) : null}
        {onForgetKey ? (
          <button type="button" onClick={onForgetKey} className={ICON} aria-label="Forget key" title="Remove your Jev key from this browser">
            <ForgetKeyIcon />
          </button>
        ) : null}
        <button
          type="button"
          onClick={onInspector}
          aria-pressed={inspectorOpen}
          className={`${QUIET} flex items-center gap-2 ${inspectorOpen ? 'border-[#6b6862] bg-[#1d1d1b] text-[#faf9f5]' : ''}`}
        >
          <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
            <rect x="1.5" y="2.5" width="13" height="11" rx="2" />
            <path d="M10 2.5v11" />
          </svg>
          Inspector
        </button>
      </div>
    </header>
  );
}
