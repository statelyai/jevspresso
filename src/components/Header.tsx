import { MODELS, modelInfo, type ModelId } from '../lib/models';
import { useSlidingPill } from './motion';

/** Which model runs the bar, from those this page can reach. */
export interface ModelPick {
  value: ModelId;
  /** Can the model run now: the server has a key for it, or one of yours reaches it. */
  ready: (model: ModelId) => boolean;
  onChange: (model: ModelId) => void;
}

/** A day under way: its seed, how many of its customers have come in, and what you can do with it. */
export interface DayBadge {
  seed: number;
  arrived: number;
  customers: number;
  onLeave: () => void;
}

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
  model?: ModelPick;
  /** Start a day, from a new seed. */
  onPlayDay?: () => void;
  /** The day under way: the order box is the customers', not yours. */
  day?: DayBadge;
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
export function ForgetKeyIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="5" cy="8.5" r="2.75" />
      <path d="M7.75 8.5H12.5M10.5 8.5v2M12.5 8.5v1.5" />
      <path d="M11 2l3 3M14 2l-3 3" />
    </svg>
  );
}

function ModelOption({ id }: { id: ModelId }) {
  const { label, by } = modelInfo(id);
  return (
    <option value={id}>
      {label} ({by})
    </option>
  );
}

export function Header(props: HeaderProps) {
  const { text, onText, onSubmit, onRush, replying, speed, onSpeed, onReset, inspectorOpen, onInspector, onForgetKey, onDownloadLog, model, onPlayDay, day } = props;
  const { barRef, pillRef } = useSlidingPill(Math.max(0, SPEEDS.indexOf(speed)));

  return (
    <header className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-3 border-b border-[#2a2a28] px-6 py-3.5 @6xl:h-[72px] @6xl:flex-nowrap">
      <h1 className="shrink-0 text-xl font-semibold tracking-[-0.01em]">Jevspresso</h1>

      {model ? (
        <label className="flex shrink-0 items-center gap-2 text-[13px] text-[#a8a49c]">
          <span className="sr-only">Model</span>
          <select
            value={model.value}
            onChange={(e) => model.onChange(e.target.value as ModelId)}
            title={`${modelInfo(model.value).label}, by ${modelInfo(model.value).by}, makes every decision at this bar`}
            className="h-9 max-w-[15rem] rounded-lg border border-[#3a3936] bg-[#1d1d1b] px-2.5 text-[13px] text-[#faf9f5] field-sizing-content"
          >
            {/* Grouped, not labelled: the closed picker shows the model's name and nothing cut short after it. */}
            {MODELS.every((m) => model.ready(m.id))
              ? MODELS.map((m) => <ModelOption key={m.id} id={m.id} />)
              : (['Ready', 'Needs a key'] as const).map((group) => (
                  <optgroup key={group} label={group}>
                    {MODELS.filter((m) => model.ready(m.id) === (group === 'Ready')).map((m) => (
                      <ModelOption key={m.id} id={m.id} />
                    ))}
                  </optgroup>
                ))}
          </select>
        </label>
      ) : null}

      {day ? (
        <div className="order-last flex min-w-0 basis-full items-center gap-3 @6xl:order-none @6xl:basis-auto @6xl:grow">
          <div className="flex h-11 min-w-0 grow items-center gap-3 rounded-lg border border-[#3a3936] bg-[#1d1d1b] px-3.5 text-[14px]">
            <span className="shrink-0 font-medium">Day #{day.seed}</span>
            <span className="tnum min-w-0 truncate text-[#a8a49c]">
              {day.arrived < day.customers ? `${day.arrived} of ${day.customers} customers in` : `All ${day.customers} customers in · closing`}
            </span>
          </div>
          <button type="button" onClick={day.onLeave} className={`${QUIET} h-11`}>
            Leave day
          </button>
        </div>
      ) : (
      <form
        className="order-last flex min-w-0 basis-full gap-2 @6xl:order-none @6xl:basis-auto @6xl:grow"
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
      )}

      <div className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-3 @6xl:ml-0 @6xl:shrink-0 @6xl:flex-nowrap">
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
        {onPlayDay ? (
          <button
            type="button"
            onClick={onPlayDay}
            title="Twelve customers and a few mishaps, the same each time for the same day: try it with another model"
            className={QUIET}
          >
            Play a day
          </button>
        ) : null}
        <button type="button" onClick={onReset} className={QUIET}>
          {day ? 'Restart day' : 'Reset'}
        </button>
        {onDownloadLog ? (
          <button type="button" onClick={onDownloadLog} className={ICON} aria-label="Download Jev's log" title="Download Jev's requests and responses (JSON)">
            <DownloadIcon />
          </button>
        ) : null}
        {onForgetKey ? (
          <button type="button" onClick={onForgetKey} className={ICON} aria-label="Forget your keys" title="Remove the keys you gave from this browser">
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
