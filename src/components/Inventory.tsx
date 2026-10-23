import { useRef, useState } from 'react';
import { CHAOS_LEVELS, type ChaosLevel } from '../lib/legal';
import { INITIAL_INVENTORY } from '../lib/recipes';
import type { Device, Ingredient, Inventory as InventoryType } from '../lib/types';
import { DEVICE_LABEL } from '../lib/view';
import { HandIcon } from './Machine';
import { PopNumber } from './Transitions';

function amount(n: number, unit: 'g' | 'ml') {
  return unit === 'ml' && n >= 1000 ? `${(n / 1000).toFixed(1)}L` : `${Math.round(n)}${unit}`;
}

const LEVELS = Object.keys(CHAOS_LEVELS) as ChaosLevel[];

/** The level a probability is set to (the nearest one). */
function levelOf(prob: number): ChaosLevel {
  return LEVELS.reduce((a, b) => (Math.abs(CHAOS_LEVELS[b] - prob) < Math.abs(CHAOS_LEVELS[a] - prob) ? b : a));
}

const DEVICES: Device[] = ['grinder', 'groupHead', 'steamWand'];

export interface IngredientsProps {
  inventory: InventoryType;
  /** The ingredient the barista is refilling: it stays lit, the rest step back. */
  restocking?: Ingredient;
  /** Set how much of an ingredient there is: none (all the way left) up to full. Without it, the levels are only shown. */
  onStock?: (ingredient: Ingredient, amount: number) => void;
}

/**
 * How much there is of one ingredient, as a slider you can drag: to the left
 * to throw it out, part way to leave it low, to the right to refill it. It is
 * set when you let go, not on every step of the drag.
 */
function StockSlider({
  label,
  value,
  max,
  color,
  onSet,
}: {
  label: string;
  value: number;
  max: number;
  color: string;
  onSet?: (amount: number) => void;
}) {
  const [draft, setDraft] = useState<number | null>(null);
  // The value being dragged to, for the release, whatever React has rendered by then.
  const pending = useRef<number | null>(null);
  const shown = draft ?? value;
  const commit = () => {
    if (pending.current === null) return;
    onSet?.(pending.current);
    pending.current = null;
    setDraft(null);
  };
  const ratio = max > 0 ? Math.max(0, Math.min(1, shown / max)) : 0;
  return (
    <input
      type="range"
      min={0}
      max={max}
      step={max / 100}
      value={shown}
      aria-label={`${label} in stock`}
      disabled={!onSet}
      onChange={(e) => {
        pending.current = Number(e.target.value);
        setDraft(pending.current);
      }}
      onPointerUp={commit}
      onKeyUp={commit}
      onBlur={commit}
      className="m-range"
      style={{ '--fill': `${ratio * 100}%`, '--fill-color': color } as React.CSSProperties}
    />
  );
}

/** Every ingredient by its full name, how much is left, and a slider to set it. */
export function Ingredients({ inventory, restocking, onStock }: IngredientsProps) {
  const init = INITIAL_INVENTORY;
  const rows = [
    { key: 'beans', label: 'Beans', value: inventory.beans, max: init.beans, unit: 'g' as const, color: '#b5824c' },
    { key: 'water', label: 'Water', value: inventory.water, max: init.water, unit: 'ml' as const, color: '#9fd3e6' },
    { key: 'chocolate', label: 'Chocolate', value: inventory.chocolate, max: init.chocolate, unit: 'g' as const, color: '#7a4a2a' },
    ...(['whole', 'oat', 'almond', 'soy', 'half'] as const).map((m) => ({
      key: m,
      label: m === 'half' ? 'Half & half' : `${m[0].toUpperCase()}${m.slice(1)} milk`,
      // A bar opened before this milk existed has no stock of it: that is none.
      value: inventory.milk[m] ?? 0,
      max: init.milk[m],
      unit: 'ml' as const,
      color: '#f1e3c8',
    })),
  ];

  return (
    <ul aria-label="Ingredients" className="grid min-w-0 grid-cols-2 gap-x-4 gap-y-2.5 text-[13px]">
      {rows.map(({ key, label, value, max, unit, color }) => {
        const ratio = max > 0 ? Math.max(0, Math.min(1, value / max)) : 0;
        const out = value <= 0;
        const low = !out && ratio <= 0.15;
        const tone = out ? '#ff9aa0' : low ? '#ffc48a' : undefined;
        const refilling = restocking === key;
        return (
          <li key={key} className={`flex min-w-0 flex-col gap-0.5 transition-opacity duration-300 ${restocking && !refilling ? 'opacity-35' : ''}`}>
            <div className="flex min-w-0 items-center justify-between gap-2" style={{ color: refilling ? '#faf9f5' : tone }}>
              <span className="flex items-center gap-1.5 whitespace-nowrap">
                {refilling ? <HandIcon size={13} /> : null}
                {label}
              </span>
              <span className="shrink-0">{out ? 'out' : <PopNumber value={amount(value, unit)} />}</span>
            </div>
            <StockSlider
              label={label}
              value={value}
              max={max}
              color={out ? '#f0565f' : low ? '#f4a261' : color}
              onSet={onStock ? (n) => onStock(key as Ingredient, n) : undefined}
            />
          </li>
        );
      })}
    </ul>
  );
}

export interface ChaosProps {
  breakProb: Record<Device, number>;
  onBreakProb: (device: Device, prob: number) => void;
  onBreak: (device: Device) => void;
}

/** How often each machine breaks on its own, and a button to break it now. */
export function Chaos({ breakProb, onBreakProb, onBreak }: ChaosProps) {
  return (
    <div className="flex min-w-0 flex-col gap-3">
      {DEVICES.map((device) => {
        const level = levelOf(breakProb[device]);
        return (
          <div key={device} className="flex min-w-0 items-center gap-2 text-[13px]">
            <span className="w-[74px] shrink-0 truncate text-[#a8a49c]">{DEVICE_LABEL[device]}</span>
            <div role="radiogroup" aria-label={`${DEVICE_LABEL[device]} chaos`} className="flex min-w-0 grow rounded-md border border-[#3a3936] p-0.5">
              {LEVELS.map((l) => (
                <button
                  key={l}
                  type="button"
                  role="radio"
                  aria-checked={l === level}
                  onClick={() => onBreakProb(device, CHAOS_LEVELS[l])}
                  className={`min-w-0 grow rounded px-1 py-1 text-xs capitalize ${
                    l === level ? 'bg-[#faf9f5] text-[#141413]' : 'text-[#a8a49c] hover:text-[#faf9f5]'
                  }`}
                >
                  {l === 'medium' ? 'Med' : l}
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={() => onBreak(device)}
              className="shrink-0 rounded-md border border-[#f0565f] px-2 py-1 text-xs text-[#ff9aa0] hover:bg-[#2a1416]"
            >
              Break
            </button>
          </div>
        );
      })}
    </div>
  );
}
