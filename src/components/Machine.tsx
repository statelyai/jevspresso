import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { HANDS_ON_MS, INITIAL_INVENTORY, LAYER_COLORS, TEXTURE } from '../lib/recipes';
import type { ActiveStep, Addition, Bar, BaristaMove, CupSpot, Device, Drink, MilkTexture, Pitcher, PitcherState, StepId } from '../lib/types';
import { assignCups, cupIn, DEVICES, freeSlot } from '../lib/legal';
import { cupToken, DEVICE_LABEL, DEVICE_NOUN, drinkTag, FRONT_SPOTS, INGREDIENT_LABEL, spotAction, type BarSpot, type FrontSpot, type HandsView, type SpotAction, type ViewBar } from '../lib/view';
import { useLingering } from './motion';
import { Mug } from './Mug';

/**
 * What a part of the bar shows. The barista's hands outrank a machine running
 * on its own. `ready`: the pointer is on it, and a click would do something.
 */
type PartState = 'idle' | 'ready' | 'running' | 'hands' | 'yours' | 'broken' | 'repairing';

const INK = '#0a0a09';
const DARK = '#1b1b1a';
const GRINDER = '#34332f';
const GRINDER_DK = '#282725';
/* Stainless: a flat tone, a lighter highlight stripe, a darker tone for shade. */
const SILVER = '#c3c7cc';
const SILVER_LT = '#dfe2e6';
const SILVER_DK = '#9197a0';
const CHROME = '#e6e8eb';
/** The espresso machine's body: La Marzocco red, so chrome, glass cups and every state colour read against it. */
const BODY_M = '#b3202b';
const BODY_LT = '#cf4b54';

/** Reference artwork pixels to view units: `view = ref * S + T`. */
const S = 0.6;
const TX = -9;
const TY = -60;

/**
 * A jug in one outline: rim, the side down to a rounded base, and up the
 * other side into the lip of the spout.
 */
const JUG = 'M1162 664 H1318 L1328 856 Q1329 878 1307 878 H1170 Q1148 878 1149 856 L1156 716 Q1148 684 1124 654 Q1144 658 1162 664 Z';

/** Shapes shared by a part and its traced outline. */
const GRINDER_BODY = 'M190 452 H384 Q398 452 400 468 L424 764 Q425 780 409 780 H165 Q149 780 150 764 L174 468 Q176 452 190 452 Z';
const BASKET = 'M704 518 H852 L846 546 Q838 566 812 566 H744 Q718 566 710 546 Z';
const HANDLE = 'M704 536 L596 528 Q552 526 552 553 Q552 580 596 578 L704 562 Z';
const JUG_HANDLE = 'M1318 684 H1370 Q1386 684 1386 700 V786 Q1386 802 1370 802 H1326';

/**
 * Where a cup stands, in view units: on the drip tray under the spouts, and at
 * the front of the counter (nearer, so larger, its foot lower).
 */
const CUP_AT = {
  tray: { x: 409.8, y: 310.2, w: 108 },
  /** Under the hot-water spout, at the drip tray's right. */
  water: { x: 519, y: 310.2, w: 108 },
  front: { x: 519, y: 382.1, w: 126 },
};

/** The places on the counter at the front, from the one nearest the jug leftward. */
const FRONT_AT = [0, 1, 2].map((slot) => ({ ...CUP_AT.front, x: CUP_AT.front.x - slot * 132 }));
const frontAt = (slot: number | undefined) => FRONT_AT[slot ?? 0] ?? FRONT_AT[0];

/**
 * A squeeze bottle of chocolate sauce, tipped over a cup with a thin stream
 * into it. Laid over the drawing like the cups, placed from the cup's spot
 * (view units): its nozzle sits over the cup's middle.
 */
function ChocolateBottle({ at, leaving }: { at: { x: number; y: number; w: number }; leaving: boolean }) {
  const w = at.w * 0.9;
  const unit = w / 150;
  const cupMiddle = at.x + (at.w * 48) / 108;
  const rim = at.y + (at.w * 12) / 108;
  return (
    <div
      className={`${leaving ? 'm-bottle-out' : 'm-bottle-in'} pointer-events-none absolute`}
      style={{
        left: `${((cupMiddle - 40 * unit) / 900) * 100}%`,
        top: `${((rim - 200 * unit) / 545) * 100}%`,
        width: `${(w / 900) * 100}%`,
        aspectRatio: '150 / 200',
      }}
    >
      <svg viewBox="0 0 150 200" width="100%" height="100%" overflow="visible" aria-hidden="true">
        {leaving ? null : <Stream x={40} y1={114} y2={202} color="#6e3d23" width={6} />}
        {/* nozzle at the tip, body up and to the right */}
        <g transform="translate(40 110) rotate(45)" stroke="#0a0a09" strokeWidth="4" strokeLinejoin="round">
          <path d="M-4 0 H4 L6 -14 H-6 Z" fill="#e9e4da" />
          <rect x="-13" y="-34" width="26" height="22" rx="4" fill="#b3202b" />
          <rect x="-22" y="-134" width="44" height="102" rx="12" fill="#5a2e1a" />
          <rect x="-22" y="-98" width="44" height="30" fill="#efe3c8" />
        </g>
      </svg>
    </div>
  );
}

/** The jug's cutaway window, in reference pixels: its inside, seen through a cut in the steel. */
const JUG_WINDOW = { x: 1176, y: 700, w: 130, h: 158 };
/** The middle of that window, in view units, where the jug says what it holds. */
const JUG_MIDDLE = { x: (JUG_WINDOW.x + JUG_WINDOW.w / 2) * S + TX, y: (JUG_WINDOW.y + JUG_WINDOW.h / 2) * S + TY };
/** The jug's height, in the cup's band units: a full jug of foamed milk stands about three quarters up. */
const JUG_UNITS = 70;
/** How much of the window `ml` of milk fills, by texture, from the same bands as a cup. */
const jugFill = (t: MilkTexture, ml: number) => ({ milk: (TEXTURE[t].milk * ml) / JUG_UNITS, foam: (TEXTURE[t].foam * ml) / JUG_UNITS });
/** Cold milk, before the steam: no foam, and a little less of it (steam swells it). */
const cold = (ml: number) => ({ milk: (0.16 * ml) / JUG_UNITS, foam: 0 });
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const between = (a: { milk: number; foam: number }, b: { milk: number; foam: number }, t: number) => ({
  milk: lerp(a.milk, b.milk, t),
  foam: lerp(a.foam, b.foam, t),
});

/**
 * What the jug holds, as fractions of its height: milk, and foam on top. It
 * swells while steaming, rises into foam while foaming, and drains while it
 * pours (by the pour's amount) or is poured away, all at the step's progress.
 */
function jugLevel(state: PitcherState, pitcher: Pitcher, poured: number, p: number): { milk: number; foam: number } {
  if (!pitcher) return { milk: 0, foam: 0 };
  const { texture, ml } = pitcher;
  switch (state) {
    case 'steaming':
      return between(cold(ml), jugFill('steamed', ml), p);
    case 'foaming':
      return between(cold(ml), jugFill('foamed', ml), p);
    case 'pouring':
      // It flows out only while the jug is held tipped (see `tipOf`).
      return jugFill(texture, ml - poured * Math.max(0, Math.min(1, (p - TIP_IN) / (1 - TIP_IN - TIP_OUT))));
    case 'dumping':
      return jugFill(texture, ml * (1 - p));
    default:
      return jugFill(texture, ml);
  }
}

/** Bubbles across the whole window, as [x, y] (0 to 1): the foam shows the ones inside it. */
const BUBBLES = Array.from({ length: 36 }, (_, i) => [((i * 0.618) % 1) * 0.9 + 0.05, ((i * 0.382 + 0.13) % 1) * 0.9 + 0.05]);

type Pt = { x: number; y: number };
const dot = (a: Pt, b: Pt) => a.x * b.x + a.y * b.y;

/** The part of a convex polygon where `n · p >= c`: the side `n` points to. */
function clipHalf(poly: Pt[], n: Pt, c: number): Pt[] {
  const out: Pt[] = [];
  poly.forEach((a, i) => {
    const b = poly[(i + 1) % poly.length];
    const da = dot(n, a) - c;
    const db = dot(n, b) - c;
    if (da >= 0) out.push(a);
    if (da >= 0 !== db >= 0) {
      const t = da / (da - db);
      out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
    }
  });
  return out;
}

function area(poly: Pt[]): number {
  return Math.abs(poly.reduce((s, a, i) => s + a.x * poly[(i + 1) % poly.length].y - poly[(i + 1) % poly.length].x * a.y, 0)) / 2;
}

/** Where the surface is, along `down`, when `fraction` of the window is full: what lies below it fills that much. */
function surfaceAt(window: Pt[], down: Pt, fraction: number): number {
  const total = area(window);
  const f = Math.max(0, Math.min(1, fraction));
  let lo = Math.min(...window.map((p) => dot(down, p)));
  let hi = Math.max(...window.map((p) => dot(down, p)));
  for (let i = 0; i < 30; i++) {
    const mid = (lo + hi) / 2;
    // Deeper surface (larger along `down`) holds less.
    if (area(clipHalf(window, down, mid)) > f * total) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

const points = (poly: Pt[]) => poly.map((p) => `${p.x},${p.y}`).join(' ');

/**
 * The jug cut away: its steel inside, the milk in it, and the foam floating on
 * the milk (a thin skin when steamed, a thick cap when foamed), in the same
 * colours as a cup's bands. The jug is drawn `angle` degrees tipped; the
 * milk's surface stays level with the ground, holding its volume, so it runs
 * toward the spout as the jug tips.
 */
function JugCutaway({ uid, level, angle }: { uid: string; level: { milk: number; foam: number }; angle: number }) {
  const { x, y, w, h } = JUG_WINDOW;
  const window: Pt[] = [
    { x, y },
    { x: x + w, y },
    { x: x + w, y: y + h },
    { x, y: y + h },
  ];
  // Straight down, as the tipped jug sees it.
  const a = (angle * Math.PI) / 180;
  const down = { x: Math.sin(a), y: Math.cos(a) };
  const milk = level.milk > 0 ? clipHalf(window, down, surfaceAt(window, down, level.milk)) : [];
  const foam = level.foam > 0 ? clipHalf(window, down, surfaceAt(window, down, level.milk + level.foam)) : [];
  return (
    <g>
      <clipPath id={`${uid}-window`}>
        <rect x={x} y={y} width={w} height={h} rx={14} />
      </clipPath>
      {foam.length > 2 ? (
        <clipPath id={`${uid}-foam`}>
          <polygon points={points(foam)} />
        </clipPath>
      ) : null}
      <g clipPath={`url(#${uid}-window)`}>
        <rect x={x} y={y} width={w} height={h} fill="#3a3d42" />
        {/* the far wall's shine, through the cut */}
        <rect x={x + w - 26} y={y} width={12} height={h} fill="#4b4f55" />
        {foam.length > 2 ? (
          <>
            <polygon points={points(foam)} fill={LAYER_COLORS.foam} />
            {/* bubbles, where the foam is thick enough to hold them */}
            {level.foam * h > 18 ? (
              <g clipPath={`url(#${uid}-foam)`}>
                {BUBBLES.map(([bx, by], i) => (
                  <circle key={i} cx={x + bx * w} cy={y + by * h} r={i % 3 === 0 ? 4.5 : 3} fill="none" stroke="#e2d9c6" strokeWidth="2" />
                ))}
              </g>
            ) : null}
          </>
        ) : null}
        {milk.length > 2 ? <polygon points={points(milk)} fill={LAYER_COLORS.milk} /> : null}
      </g>
      <rect x={x} y={y} width={w} height={h} rx={14} fill="none" stroke={INK} strokeWidth="5" />
    </g>
  );
}

/**
 * The jug tips about the foot of its spout side, as far as `tipOf` says, drawn
 * every animation frame while it pours (`useFrameNow`), so the milk inside
 * keeps level with it.
 */
const TILT = { transformBox: 'fill-box', transformOrigin: 'left bottom' } as const;

/** The time, every animation frame while `active`; `fallback` otherwise. */
function useFrameNow(active: boolean, fallback: number): number {
  const [now, setNow] = useState(fallback);
  useEffect(() => {
    if (!active) return;
    let id = requestAnimationFrame(function tick() {
      setNow(Date.now());
      id = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(id);
  }, [active]);
  return active ? now : fallback;
}

/** Of a pour's time: tipping the jug over the cup, and setting it back down. Milk flows in between. */
const TIP_IN = 0.2;
const TIP_OUT = 0.15;
/** How far the jug is tipped, 0 to 1, at a pour's progress `p`: up, held, and back down, eased. */
function tipOf(p: number): number {
  const t = Math.max(0, Math.min(1, p / TIP_IN, (1 - p) / TIP_OUT));
  return t * t * (3 - 2 * t);
}

/** Rotate a group about the centre of its own box (a clear circle sets the box). */
const PIVOT = { transformBox: 'fill-box', transformOrigin: 'center' } as const;

/** The grinder's glass bowl: straight sides curving in to the neck. */
const BOWL = 'M150 194 H428 V300 C428 362 398 404 356 410 H220 C178 404 150 362 150 300 Z';

/**
 * Beans filling the whole bowl, small and many: [x, y, rotation, shade]. A
 * fixed pseudo-random scatter, so the pile looks the same on every render. How
 * much of it shows is set by a mask at the stock level.
 */
const BEAN_SHADES = ['#8a5a34', '#7a4a2a', '#9c6a3e'];
const BEANS: [number, number, number, string][] = (() => {
  const out: [number, number, number, string][] = [];
  let seed = 7;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let row = 0; row * 11 < 224; row++) {
    for (let col = 0; col * 17 < 300; col++) {
      const x = 144 + col * 17 + (row % 2 ? 8 : 0) + (rand() - 0.5) * 6;
      const y = 196 + row * 11 + (rand() - 0.5) * 5;
      out.push([Math.round(x), Math.round(y), Math.round((rand() - 0.5) * 120), BEAN_SHADES[Math.floor(rand() * 3)]]);
    }
  }
  return out;
})();

/** The bowl's inside runs from here (full) down to its base (empty). */
const BOWL_TOP = 196;
const BOWL_BASE = 410;

const TONE: Record<Exclude<PartState, 'idle'>, { stroke: string; pulse?: boolean; chip: string; text: string; bg: string }> = {
  running: { stroke: '#5aa9ff', pulse: true, chip: '#5aa9ff', text: '#9fd0ff', bg: '#0f1f30' },
  /** Jev's hands, and yours: two baristas at one bar. */
  hands: { stroke: '#faf9f5', chip: '#faf9f5', text: '#faf9f5', bg: '#1d1d1b' },
  yours: { stroke: '#e8845f', chip: '#e8845f', text: '#f5b69c', bg: '#2a1a12' },
  broken: { stroke: '#f0565f', chip: '#f0565f', text: '#ff9aa0', bg: '#2a1416' },
  repairing: { stroke: '#f4a261', pulse: true, chip: '#f4a261', text: '#ffc48a', bg: '#2a1d10' },
  ready: { stroke: '#8a8780', chip: '#8a8780', text: '#cfcbc3', bg: '#1d1d1b' },
};

function secs(n: number) {
  return `${n.toFixed(1)}s`;
}

function progress(step: ActiveStep, now: number): number {
  const span = step.endsAt - step.startedAt;
  return span <= 0 ? 1 : Math.min(1, Math.max(0, (now - step.startedAt) / span));
}

/** Clockwise arc from 12 o'clock, for the progress ring. */
function arc(r: number, fraction: number): string {
  const f = Math.min(0.9999, Math.max(0.0001, fraction));
  const a = f * Math.PI * 2;
  return `M0 ${-r} A${r} ${r} 0 ${f > 0.5 ? 1 : 0} 1 ${(Math.sin(a) * r).toFixed(2)} ${(-Math.cos(a) * r).toFixed(2)}`;
}

/* ------------------------------------------------------------ icons --- */

export function HandIcon({ size = 16, color = 'currentColor' }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M18 11V6a2 2 0 0 0-4 0" />
      <path d="M14 10V4a2 2 0 0 0-4 0v2" />
      <path d="M10 10.5V6a2 2 0 0 0-4 0v8" />
      <path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-6-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15" />
    </svg>
  );
}

function StateIcon({ state, color }: { state: PartState; color: string }) {
  if (state === 'hands' || state === 'yours') return <HandIcon size={15} color={color} />;
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      {state === 'broken' ? (
        <>
          <circle cx="8" cy="8" r="7" fill={color} />
          <path d="M8 4.5 V9 M8 11.2 V11.5" stroke="#141413" strokeWidth="2" strokeLinecap="round" />
        </>
      ) : state === 'running' ? (
        <>
          <circle cx="8" cy="8" r="6.5" stroke={color} strokeWidth="1.5" opacity="0.35" />
          <path d="M8 1.5 A6.5 6.5 0 0 1 14.5 8" stroke={color} strokeWidth="1.5" strokeLinecap="round" />
        </>
      ) : state === 'repairing' ? (
        <path d="M10 2.5a3.2 3.2 0 0 0-3.4 4.2L2.5 10.8l2.7 2.7 4.1-4.1A3.2 3.2 0 0 0 13.5 6l-2 2-1.8-.5-.5-1.8Z" stroke={color} strokeWidth="1.4" strokeLinejoin="round" />
      ) : (
        <circle cx="8" cy="8" r="3" fill={color} />
      )}
    </svg>
  );
}

/** The badge in a part's corner: ✕ broken, wrench repairing, hand for the barista. */
function Badge({ x, y, state, repaired = 0 }: { x: number; y: number; state: PartState; repaired?: number }) {
  if (state === 'idle' || state === 'running' || state === 'ready') return null;
  const fill = TONE[state].stroke;
  return (
    <g transform={`translate(${x} ${y})`}>
      {state === 'repairing' ? (
        <>
          <circle r="23" stroke="#3a2a17" strokeWidth="4" fill="none" />
          <path d={arc(23, repaired)} stroke={fill} strokeWidth="4" strokeLinecap="round" fill="none" />
        </>
      ) : null}
      <circle r="17" fill={fill} stroke="#141413" strokeWidth="3" />
      {state === 'broken' ? (
        <path d="M-6 -6 L6 6 M6 -6 L-6 6" stroke="#141413" strokeWidth="3" strokeLinecap="round" />
      ) : state === 'repairing' ? (
        <g className="m-wrench">
          <g transform="translate(-8 -8)">
            <path d="M10 2.5a3.2 3.2 0 0 0-3.4 4.2L2.5 10.8l2.7 2.7 4.1-4.1A3.2 3.2 0 0 0 13.5 6l-2 2-1.8-.5-.5-1.8Z" stroke="#141413" strokeWidth="1.8" strokeLinejoin="round" fill="none" />
          </g>
        </g>
      ) : (
        <g transform="translate(-9.5 -9.5) scale(0.8)">
          <HandIcon size={24} color="#141413" />
        </g>
      )}
    </g>
  );
}

/**
 * A pour: one continuous stream that draws down from the spout when it
 * starts, sways a little, and carries a faint highlight flowing down it.
 */
function Stream({ x, y1, y2, color, width }: { x: number; y1: number; y2: number; color: string; width: number }) {
  const dy = y2 - y1;
  const d = `M${x} ${y1} C${x + 1.5} ${y1 + dy * 0.35}, ${x - 1.5} ${y1 + dy * 0.7}, ${x} ${y2}`;
  return (
    <g className="m-sway">
      <path className="m-pour" d={d} pathLength={1} stroke={color} strokeWidth={width} strokeLinecap="round" fill="none" />
      <path className="m-flow" d={d} stroke="#faf9f5" strokeOpacity="0.4" strokeWidth={Math.max(1.5, width / 3)} strokeLinecap="round" strokeDasharray="5 16" fill="none" />
    </g>
  );
}

/** Smoke curling off a broken part, and sparks flickering at the crack (reference pixels). */
function Trouble({ x, y, sparks, soft }: { x: number; y: number; sparks: [number, number]; soft: string }) {
  return (
    <>
      <g filter={soft} fill="#b8b3aa">
        {[0, 1, 2, 3].map((i) => (
          <circle key={i} className="m-steam m-smoke" data-i={i} cx={x + (i - 1.5) * 22} cy={y} r="22" />
        ))}
      </g>
      <g stroke="#ffd166" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" fill="none">
        <path className="m-spark" data-i="0" d={`M${sparks[0]} ${sparks[1]} l10 -8 l-4 10 l12 -6`} />
        <path className="m-spark" data-i="1" d={`M${sparks[0] - 16} ${sparks[1] + 14} l-10 6 l6 -12 l-12 4`} />
      </g>
    </>
  );
}

/** Wider than the part's own ink outline, so a ring of the state's colour shows around its edge. */
const HALO = 18;

/**
 * The outline traced around a part: its silhouette (`children`, drawn in the
 * scene's reference pixels) stroked wide beneath it, in the state's colour and
 * line style. Idle draws nothing.
 */
function Halo({ state, keyline, children }: { state: PartState; keyline: string; children: ReactNode }) {
  if (state === 'idle') return null;
  const t = TONE[state];
  return (
    <g
      // A dark keyline around the ring keeps it legible on any colour, the red body included.
      filter={keyline}
      stroke={t.stroke}
      fill="none"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={t.pulse ? 'm-breathe' : undefined}
    >
      {children}
    </g>
  );
}

function Ring({ x, y, fraction }: { x: number; y: number; fraction: number }) {
  return (
    <g transform={`translate(${x} ${y})`}>
      <circle r="17" fill="#0f1f30" stroke="#5aa9ff" strokeWidth="2" />
      <circle r="11" stroke="#1d3a5c" strokeWidth="4" fill="none" />
      <path d={arc(11, fraction)} stroke="#5aa9ff" strokeWidth="4" strokeLinecap="round" fill="none" />
    </g>
  );
}

/**
 * What the spot under the pointer does, over the spot: its main action (what a
 * click on the part does) and everything else possible there, amber when it
 * spoils a cup, wastes something or serves the wrong drink; or, greyed, why
 * nothing would happen (it shakes when the part is clicked anyway).
 */
function SpotLabel({
  action,
  box,
  below,
  shake,
  onAct,
  onBreak,
  onEnter,
  onLeave,
  barRef: ref,
}: {
  action: SpotAction;
  box: Box;
  below: boolean;
  barRef: RefObject<HTMLDivElement | null>;
  shake: boolean;
  onAct: (move: BaristaMove) => void;
  onBreak: (device: Device) => void;
  onEnter: () => void;
  onLeave: () => void;
}) {
  // Centred on the part, then nudged back inside the drawing where it would
  // run off an edge (a part at the far left or right, near the top or bottom).
  const [nudge, setNudge] = useState({ x: 0, y: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    const frame = el?.offsetParent?.getBoundingClientRect();
    if (!el || !frame) return;
    const r = el.getBoundingClientRect();
    // Where it would be without the nudge.
    const left = r.left - nudge.x;
    const right = r.right - nudge.x;
    const top = r.top - nudge.y;
    const bottom = r.bottom - nudge.y;
    const pad = 4;
    const x = left < frame.left + pad ? frame.left + pad - left : right > frame.right - pad ? frame.right - pad - right : 0;
    const y = top < frame.top + pad ? frame.top + pad - top : bottom > frame.bottom - pad ? frame.bottom - pad - bottom : 0;
    if (Math.abs(x - nudge.x) > 0.5 || Math.abs(y - nudge.y) > 0.5) setNudge({ x, y });
  });
  const tone = 'border-[#6b6862] bg-[#1d1d1b] text-[#faf9f5] hover:bg-[#2a2a28]';
  const pill = 'flex items-center gap-1.5 whitespace-nowrap rounded-full border px-3 py-1 text-[13px] shadow-[0_6px_18px_rgba(0,0,0,0.45)]';
  // Each run of one-word variants is one row, after the move it varies.
  const rows = action.others.reduce<Array<(typeof action.others)[number][]>>((out, o) => {
    const last = out.at(-1);
    if (o.short && last?.[0].short) last.push(o);
    else out.push([o]);
    return out;
  }, []);
  const option = (o: (typeof action.others)[number]) => (
    <button
      key={o.label}
      type="button"
      className={`${pill} py-0.5 text-[12px] opacity-85 ${o.short ? 'px-2' : ''} ${tone}`}
      onClick={() => onAct(o.event)}
    >
      {o.label}
    </button>
  );
  return (
    // A column over the part (under it, near the top or `below`), touching it (the gap is
    // padding inside), so the pointer goes straight up onto it. The main
    // action is nearest the part; the rest stack away from it, "Break it" last.
    <div
      ref={ref}
      className={`absolute z-10 flex w-max items-center gap-1.5 ${below ? 'flex-col pt-2' : 'flex-col-reverse pb-2'}`}
      style={{
        left: `${((box.x + box.w / 2) / 900) * 100}%`,
        top: `${(box.y / 545) * 100}%`,
        transform: `translate(calc(-50% + ${nudge.x}px), calc(${below ? '0%' : '-100%'} + ${nudge.y}px))`,
      }}
      onPointerEnter={onEnter}
      onPointerLeave={onLeave}
    >
      {action.event ? (
        <button type="button" className={`${pill} ${tone}`} onClick={() => onAct(action.event!)}>
          <span className="font-medium">{action.label}</span>
        </button>
      ) : action.label ? (
        <div role="status" className={`${pill} border-[#3a3936] bg-[#1d1d1b] text-[#a8a49c] ${shake ? 'm-shake' : ''}`}>
          {action.label}
        </div>
      ) : null}
      {/* Everything else possible here, quieter. */}
      {rows.map((row, i) =>
        row[0].short ? (
          // Rows of chips can read alike (oat, almond… steamed, and foamed): keyed by place.
          <div key={`row-${i}`} className="flex gap-1">
            {row.map(option)}
          </div>
        ) : (
          option(row[0])
        ),
      )}
      {/* For you alone: Jev never breaks anything on purpose. */}
      {action.breaks ? (
        <button
          type="button"
          className={`${pill} py-0.5 text-[12px] border-[#f0565f] bg-[#2a1416] text-[#ff9aa0] hover:bg-[#3a1a1d]`}
          onClick={() => onBreak(action.breaks!)}
        >
          Break it
        </button>
      ) : null}
    </div>
  );
}

/** The status chip under a part: icon, a few words, and time left. */
function Chip({ x, w, state, label, time, warn }: { x: number; w: number; state: PartState; label: string; time?: string; warn?: string }) {
  const t = state === 'idle' ? null : TONE[state];
  return (
    <foreignObject x={x} y={498} width={w} height={40}>
      <div className="flex h-full min-w-0 items-center justify-center">
        <div
          className="flex min-w-0 max-w-full items-center gap-2 rounded-full border px-3.5 py-1.5 text-[13px]"
          style={{
            borderColor: t ? t.chip : '#3a3936',
            background: t ? t.bg : 'transparent',
            color: t ? t.text : '#a8a49c',
          }}
        >
          {t ? <StateIcon state={state} color={t.chip} /> : null}
          <span className="min-w-0 truncate font-medium">{label}</span>
          {time ? (
            <span className="shrink-0 opacity-80">
              · <span className="secs">{time}</span>
            </span>
          ) : null}
          {warn ? <span className="shrink-0 text-[#ffc48a]">· {warn}</span> : null}
        </div>
      </div>
    </foreignObject>
  );
}

export interface MachineProps {
  ctx: ViewBar;
  /** Both baristas' busy hands (`allHands`): Jev's and yours. */
  hands: HandsView[];
  /** Served drinks whose cup has reached its order card; the rest are still on the machine. */
  landed: ReadonlySet<string>;
  /**
   * Working the bar by hand: which events the bar accepts, how to send one, and
   * the order a new step goes to first. Without it the bar is only drawn.
   */
  interact?: {
    can: (move: BaristaMove) => boolean;
    act: (move: BaristaMove) => void;
    selected: string | null;
    /** Break a machine: yours alone to do, never Jev's. */
    breakIt: (device: Device) => void;
  };
}

/** Where each spot can be clicked, in view units. */
type Box = { x: number; y: number; w: number; h: number };
const cupBox = (at: { x: number; y: number; w: number }): Box => ({ x: at.x, y: at.y, w: at.w, h: (at.w * 80) / 108 });
const SPOT_BOX: Record<Exclude<BarSpot, 'portafilter' | 'tray' | FrontSpot>, Box> = {
  grinder: { x: 75, y: 30, w: 176, h: 320 },
  brew: { x: 330, y: 146, w: 48, h: 48 },
  steam: { x: 534, y: 146, w: 48, h: 48 },
  // The jug itself, not the wand above it: its action bar opens right over it.
  jug: { x: 663, y: 330, w: 162, h: 138 },
  water: { x: 548, y: 218, w: 38, h: 66 },
  chocolate: { x: 842, y: 334, w: 40, h: 96 },
};
/** The portafilter, locked in the group or under the grinder's chute. */
const PF_BOX = { group: { x: 322, y: 246, w: 182, h: 56 }, grinder: { x: 8, y: 350, w: 204, h: 64 } };

/**
 * More of a part that clicks as that part: the machine's whole body (under
 * everything on it), and each device's chip under the counter and its badge.
 * A broken part is fixed wherever it is clicked.
 */
const BODY_BOX: Box = { x: 285, y: 116, w: 347, h: 334 };
/** The steam wand, down to the jug: it steams, like the right knob. */
const WAND_BOX: Box = { x: 626, y: 196, w: 96, h: 134 };

/** How far off a part (CSS pixels) the pointer can stray and still be on it: no other part's actions open there. */
const NEAR = 16;

/**
 * Where a spot's action bar opens: over the part hovered, except that milk is
 * steamed over the jug, and a cup on the drip tray opens under it (over it is
 * the portafilter, which must stay in reach).
 */
const barBox = (spot: BarSpot, box: Box): Box =>
  spot === 'steam' ? SPOT_BOX.jug : spot === 'tray' ? { ...box, y: box.y + box.h, h: 0 } : box;
/** A bar opens downward from its box near the top of the drawing, and under a tray cup. */
const opensBelow = (spot: BarSpot, box: Box) => spot === 'tray' || box.y < 40;

const CHIP_BOX: Record<Device, Box> = {
  grinder: { x: 83, y: 500, w: 160, h: 36 },
  groupHead: { x: 378, y: 500, w: 160, h: 36 },
  steamWand: { x: 670, y: 500, w: 160, h: 36 },
};
const BADGE_BOX: Record<Device, Box> = {
  grinder: { x: 234, y: 10, w: 40, h: 40 },
  groupHead: { x: 490, y: 202, w: 40, h: 40 },
  steamWand: { x: 772, y: 304, w: 40, h: 40 },
};
const DEVICE_SPOT: Record<Device, BarSpot> = { grinder: 'grinder', groupHead: 'brew', steamWand: 'steam' };

/**
 * The bar: grinder, espresso machine, steam wand. Every outline, badge,
 * stream, level and chip is derived from the bar's state; nothing moves
 * unless that state is live.
 */
export function Machine({ ctx, hands, landed, interact }: MachineProps) {
  const uid = `m${useId().replace(/:/g, '')}`;
  // The spot under the pointer (or keyboard focus), and which box it is over,
  // so the action bar opens where the pointer is.
  // The element hovered, too: how near the pointer still is to it.
  const [hovering, setHovering] = useState<{ spot: BarSpot; box: Box; el?: HTMLElement } | null>(null);
  const hover = hovering?.spot ?? null;
  const leaveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const barRef = useRef<HTMLDivElement>(null);
  const close = () => {
    setHovering(null);
    setNudge(null);
  };
  /**
   * Is the pointer just off the part whose actions are open (within `NEAR`
   * of it, not on it), or on or near its column? Then it is still that part's:
   * another part under it (the machine's body, behind everything) does not
   * take over until the pointer is clearly on it.
   */
  const stillOn = (p: { clientX: number; clientY: number }) => {
    const on = (r: DOMRect | undefined, m: number) =>
      !!r && p.clientX >= r.left - m && p.clientX <= r.right + m && p.clientY >= r.top - m && p.clientY <= r.bottom + m;
    const part = hovering?.el?.getBoundingClientRect();
    return (on(part, NEAR) && !on(part, 0)) || on(barRef.current?.getBoundingClientRect(), NEAR);
  };
  const enter = (spot: BarSpot, box: Box, e?: { clientX: number; clientY: number; currentTarget: EventTarget }) => {
    clearTimeout(leaveTimer.current);
    if (e && hovering && spot !== hovering.spot && stillOn(e)) return;
    setHovering({ spot, box, el: e?.currentTarget instanceof HTMLElement ? e.currentTarget : undefined });
  };
  const stay = () => clearTimeout(leaveTimer.current);
  /** Off a part or the bar, or focus gone: close a moment later (long enough to step from a part onto its bar). */
  const leave = () => {
    clearTimeout(leaveTimer.current);
    leaveTimer.current = setTimeout(close, 160);
  };
  const [nudge, setNudge] = useState<{ spot: BarSpot; n: number } | null>(null);
  const actionAt = (spot: BarSpot) => (interact ? spotAction(spot, ctx, interact.can, interact.selected) : null);
  const hovered = hover ? actionAt(hover) : null;
  /** A part lights up, softly, while the pointer is on a spot of it that would do something. */
  const lit = (state: PartState, ...spots: BarSpot[]): PartState =>
    state === 'idle' && hover && spots.includes(hover) && hovered?.event ? 'ready' : state;
  const { equipment, activeSteps, drinks, inventory, now } = ctx;
  const step = (d: Device) => activeSteps.find((a) => a.resource === d);
  const running = (id: StepId) => activeSteps.find((a) => a.stepId === id);
  // Cups belong to no order until served; this is the order each is on its way to.
  const assigned = assignCups(ctx);
  const drinkOf = (a?: ActiveStep): Drink | undefined => (a?.cupId ? drinks.find((d) => d.id === assigned.get(a.cupId!)) : undefined);

  /** Jev's hands are white, yours the accent. */
  const handsState = (h: HandsView): PartState => (h.who === 'you' ? 'yours' : 'hands');
  const pfHands = hands.find((h) => h.part === 'portafilter');
  const stateOf = (d: Device): PartState => {
    if (equipment[d] === 'broken') return 'broken';
    if (equipment[d] === 'repairing') return 'repairing';
    const on = hands.find((h) => h.part === d);
    if (on) return handsState(on);
    return step(d) ? 'running' : 'idle';
  };
  const grinder = stateOf('grinder');
  const head = stateOf('groupHead');
  const wand = stateOf('steamWand');

  const grindStep = step('grinder');
  const headStep = step('groupHead');
  const grinding = grindStep?.stepId === 'grind_beans' && grinder !== 'broken';
  const extracting = headStep?.stepId === 'extract';
  const steaming = ['steam_milk', 'foam_milk'].includes(step('steamWand')?.stepId ?? '');
  // What is in the jug, and how far along what is happening to it.
  // The pour tips the jug onto the lip of the cup it goes into, wherever that stands at the front.
  const pourStep = activeSteps.find((a) => a.stepId === 'pour_milk');
  const pourShift = (frontAt(ctx.cups.find((c) => c.id === pourStep?.cupId)?.slot).x - CUP_AT.front.x) / S;
  // While it pours, the jug and its milk move every animation frame, together.
  const jugNow = useFrameNow(Boolean(pourStep), now);
  const tip = pourStep ? tipOf(progress(pourStep, jugNow)) : 0;
  const jugStep = activeSteps.find((a) => a.state.startsWith('pitcher.'));
  const jug = jugLevel(ctx.pitcherState, ctx.pitcher, ctx.pour?.ml ?? 0, jugStep ? progress(jugStep, jugNow) : 1);
  const pouring = tip > 0;

  // The portafilter: under the grinder's chute from the grind until it is
  // locked in (tamped there too), in the group head otherwise.
  const pf = ctx.portafilter;
  const tampStep = running('tamp');
  const lockStep = running('lock_in');
  // The knock: the portafilter comes out, tips over a knock box that slides in
  // from the left, drops its puck (or its grounds), and the box slides back out.
  const knockStep = running('knock_out');
  const pfAtGrinder = ['grinding', 'grounds', 'tamping', 'tamped'].includes(pf);
  const grounds = pf === 'grinding' && grindStep ? progress(grindStep, now) : ['grounds', 'tamping', 'tamped'].includes(pf) ? 1 : 0;
  // Tamping: the tamper comes down onto the grounds a little past halfway through the step, and they are flat from then on.
  const tamped = pf === 'tamped';
  const knockBox = useLingering(Boolean(knockStep), 380);
  // The knock is timed to its step: the portafilter gets over the box in the
  // first 40%, the puck drops in the rest.
  const knockMs = knockStep ? Math.max(300, knockStep.endsAt - knockStep.startedAt) : 700;
  const knockMove = knockStep ? Math.round(knockMs * 0.4) : 700;
  // Locked in, the handle points out at the viewer (foreshortened, angled);
  // before that it is parallel to the machine's front, at full length.
  const pfLocked = !knockStep && !lockStep && !pfAtGrinder;
  const pfState: PartState =
    pfHands ? handsState(pfHands) : pfAtGrinder ? (grinding ? 'running' : 'idle') : extracting ? 'running' : 'idle';
  /** The device the portafilter is at, whose chip speaks for the hands on it. */
  const pfDevice: Device = pfAtGrinder ? 'grinder' : 'groupHead';

  // The cups stand where they were put: under the spouts, or at the front for
  // the milk. A served cup stays where it stood until it has flown to its
  // order card (see `landed`), so the view transition has somewhere to fly it from.
  const cups = [
    ...ctx.cups.map((c) => ({ ...c, leaving: false })),
    ...drinks
      .filter((d) => d.served && !landed.has(cupToken(d)))
      .map((d) => ({ id: d.served!.cupId, spot: d.served!.spot, slot: d.served!.slot, contents: d.served!.contents, leaving: true })),
  ];
  // A cup is lit while the barista's hands are on it (pouring included), or while a shot pulls into it.
  const cupState = (c: (typeof cups)[number]): PartState =>
    c.leaving
      ? 'idle'
      : hands.some((h) => h.cupId === c.id)
        ? handsState(hands.find((h) => h.cupId === c.id)!)
        : extracting && headStep?.cupId === c.id
          ? 'running'
          : 'idle';
  // A cup on the tray moves under the hot-water spout for water, and waits there.
  const atWater = (c: { id: string; spot: CupSpot; contents: Addition[] }) =>
    c.spot === 'tray' && (c.contents.some((a) => a.kind === 'water') || activeSteps.some((a) => a.stepId === 'add_water' && a.cupId === c.id));
  const waterStep = running('add_water');
  // The chocolate bottle: over the cup while chocolate goes in, gone otherwise.
  const chocoStep = running('add_chocolate');
  const bottle = useLingering(Boolean(chocoStep), 320);
  const bottleAt = useRef<(typeof CUP_AT)[keyof typeof CUP_AT]>(CUP_AT.tray);
  if (chocoStep) {
    const under = ctx.cups.find((c) => c.id === chocoStep.cupId);
    bottleAt.current = under?.spot === 'front' ? frontAt(under.slot) : CUP_AT.tray;
  }
  // How far along a repair is, for the ring around the wrench.
  const repaired = (d: Device) => {
    const h = hands.find((x) => x.doing === 'barista.repair' && x.part === d);
    return h ? 1 - (h.secondsLeft * 1000 * (ctx.speed || 1)) / HANDS_ON_MS['barista.repair'] : 0;
  };
  /** What is going into a cup right now, and how far along. */
  const cupPour = (cupId: string): { addition: Addition; progress: number } | undefined => {
    const a = activeSteps.find((s) => s.cupId === cupId && ['extract', 'add_water', 'add_chocolate', 'pour_milk'].includes(s.stepId));
    if (!a) return undefined;
    const addition: Addition | undefined =
      a.stepId === 'extract'
        ? { kind: 'shot' }
        : a.stepId === 'add_water'
          ? { kind: 'water' }
          : a.stepId === 'add_chocolate'
            ? { kind: 'chocolate' }
            : ctx.pitcher && ctx.pour
              ? { kind: 'milk', ...ctx.pitcher, ml: ctx.pour.ml }
              : undefined;
    return addition && { addition, progress: progress(a, now) };
  };
  const dumping = (cupId: string) => activeSteps.some((a) => a.stepId === 'dump_cup' && a.cupId === cupId);

  // Full strength for the parts being worked on; the rest step back, unless
  // nothing is being worked on at all.
  const working = (s: PartState) => s === 'running' || s === 'hands' || s === 'yours' || s === 'repairing';
  const anyWorking = [grinder, head, wand, pfState, ...cups.map(cupState)].some(working);
  // Dimmed rather than made transparent, so the counter never shows through a part.
  const fade = (s: PartState) => ({
    filter: !anyWorking || working(s) || s === 'ready' ? 'none' : 'brightness(0.5) saturate(0.6)',
    transition: 'filter var(--duration-slow) var(--ease-smooth-out)',
  });

  const beans = Math.max(0, Math.min(1, inventory.beans / INITIAL_INVENTORY.beans));
  const beansLow = inventory.beans < 36;

  const tag = (d?: Drink) => (d ? ` · ${drinkTag(d.id, drinks)}` : '');

  /** The hands a device's chip speaks for: on the device, or on the portafilter at it. */
  const handsAt = (d: Device) => hands.find((h) => h.part === d) ?? (pfDevice === d ? pfHands : undefined);
  const chipState = (d: Device, state: PartState): PartState => {
    const h = handsAt(d);
    return h && state === 'idle' ? handsState(h) : state;
  };
  const chip = (d: Device, state: PartState): { label: string; time?: string } => {
    const s = step(d);
    const h = handsAt(d);
    const handsTime = h ? secs(h.secondsLeft) : undefined;
    const who = h?.who === 'you' ? 'You: ' : '';
    switch (chipState(d, state)) {
      case 'broken':
        return { label: `${DEVICE_NOUN[d][0].toUpperCase()}${DEVICE_NOUN[d].slice(1)} broken` };
      case 'repairing':
        return { label: `${who}Repairing ${DEVICE_NOUN[d]}`, time: handsTime };
      case 'hands':
      case 'yours':
        return {
          label: `${who}${h!.label}${h!.doing === 'barista.steamMilk' && ctx.pitcher ? ` ${ctx.pitcher.milk}` : ''}${tag(h!.drink)}`,
          time: handsTime,
        };
      case 'running':
        return {
          label: `${d === 'grinder' ? 'Grinding' : s?.stepId === 'extract' ? 'Pulling shot' : 'Busy'}${tag(drinkOf(s))}`,
          time: s ? secs(Math.max(0, (s.endsAt - now) / 1000)) : undefined,
        };
      default:
        return { label: DEVICE_LABEL[d] };
    }
  };

  const label = [
    `Grinder ${grinder}`,
    `espresso machine ${head}`,
    `steam wand ${wand}`,
    ...hands.map((h) => `${h.who === 'you' ? 'you' : 'jev'}: ${h.label.toLowerCase()}`),
  ].join(', ');

  /** Where a spot is clicked: the portafilter and the tray's cup move. */
  const trayCup = cupIn(ctx, 'tray');
  const boxOf = (spot: BarSpot): Box =>
    spot === 'portafilter'
      ? pfAtGrinder ? PF_BOX.grinder : PF_BOX.group
      : spot === 'tray'
        ? cupBox(trayCup && atWater(trayCup) ? CUP_AT.water : CUP_AT.tray)
        : spot.startsWith('front')
          ? cupBox(FRONT_AT[FRONT_SPOTS.indexOf(spot as FrontSpot)])
          : SPOT_BOX[spot as keyof typeof SPOT_BOX];

  const keyline = `url(#${uid}-keyline)`;
  const soft = `url(#${uid}-soft)`;

  // The scene is drawn in its reference artwork's pixels (a 1448-wide
  // illustration of the counter) and scaled into place in one transform;
  // outlines, badges, rings and chips are laid over it in view units.
  return (
    // Sized to the drawing's own aspect ratio (container units of the stage), so
    // the cups laid over it in percentages line up at any size.
    <div
      className="relative"
      style={{ width: 'min(100cqw, calc(100cqh * 900 / 545), 1000px)', aspectRatio: '900 / 545' }}
    >
    <svg viewBox="0 0 900 545" fill="none" role="img" aria-label={label} className="absolute inset-0 h-full w-full">
      <defs>
        <clipPath id={`${uid}-bowl`}>
          <path d={BOWL} />
        </clipPath>
        {/* the bean level: a mask whose top slides to the stock */}
        <clipPath id={`${uid}-level`}>
          <rect
            className="m-level"
            x="140"
            y={BOWL_TOP}
            width="300"
            height={BOWL_BASE - BOWL_TOP + 10}
            style={{ transform: `translateY(${(1 - beans) * (BOWL_BASE - BOWL_TOP)}px)` }}
          />
        </clipPath>
        <clipPath id={`${uid}-jug`}>
          <path d={JUG} />
        </clipPath>
        <filter id={`${uid}-soft`} x="-100%" y="-100%" width="300%" height="300%">
          <feGaussianBlur stdDeviation="7" />
        </filter>
        {/* the whole scene as the filter region (reference pixels), so no outline is ever cut off */}
        <filter id={`${uid}-keyline`} filterUnits="userSpaceOnUse" x="-200" y="-200" width="1900" height="1400">
          {/* grow the outline's shape by a few pixels with round corners: blur its alpha, then harden it */}
          <feGaussianBlur in="SourceAlpha" stdDeviation="3.5" result="blurred" />
          <feComponentTransfer in="blurred" result="grown">
            <feFuncA type="linear" slope="10" />
          </feComponentTransfer>
          <feFlood floodColor={INK} />
          <feComposite in2="grown" operator="in" />
          <feMerge>
            <feMergeNode />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>

      {/* the counter everything stands on */}
      <rect x="0" y="429" width="900" height="45" fill="#4a2f1d" />
      <rect x="0" y="429" width="900" height="3" fill="#5e3d27" />
      <rect x="0" y="474" width="900" height="16" fill="#35211a" />

      <g transform={`translate(${TX} ${TY}) scale(${S})`} strokeLinejoin="round">
        {/* ============================ GRINDER ============================ */}
        {/* A bowl hopper under a wide lid, a neck, a body that widens toward
            the base, the dial and the chute. */}
        <g style={fade(lit(grinder, 'grinder'))} className={grinder === 'broken' ? 'm-jolt' : undefined}>
          <Halo keyline={keyline} state={lit(grinder, 'grinder')}>
            <g strokeWidth={6 + HALO}>
              <rect x="140" y="776" width="294" height="80" rx="14" />
              <path d={GRINDER_BODY} />
              <rect x="212" y="404" width="150" height="50" />
              <path d={BOWL} />
              <rect x="142" y="150" width="292" height="44" rx="16" />
            </g>
          </Halo>
          <rect x="162" y="850" width="44" height="18" rx="4" fill={INK} />
          <rect x="368" y="850" width="44" height="18" rx="4" fill={INK} />
          <rect x="140" y="776" width="294" height="80" rx="14" fill={GRINDER_DK} stroke={INK} strokeWidth="6" />
          <path d={GRINDER_BODY} fill={GRINDER} stroke={INK} strokeWidth="6" />
          {/* the dial; its mark shivers while the burrs turn */}
          <circle cx="287" cy="552" r="50" fill={GRINDER_DK} stroke={INK} strokeWidth="6" />
          {/* the circle makes the group's box the dial, so it turns about the dial's centre */}
          <g className={grinding ? 'm-jitter' : undefined} style={PIVOT}>
            <circle cx="287" cy="552" r="50" fill="none" />
            <rect x="282" y="524" width="10" height="36" rx="5" fill="#faf9f5" />
          </g>
          {/* chute */}
          <path d="M258 626 H316 L312 676 H262 Z" fill="#55554f" stroke={INK} strokeWidth="6" />
          {/* neck, then the glass bowl with the beans; they sink as they are used */}
          <rect x="212" y="404" width="150" height="50" fill={GRINDER_DK} stroke={INK} strokeWidth="6" />
          <path d={BOWL} fill="#1d1c1a" />
          {/* the beans show from the base up to the stock level */}
          <g clipPath={`url(#${uid}-bowl)`}>
            <g clipPath={`url(#${uid}-level)`}>
              <rect x="140" y={BOWL_TOP} width="300" height={BOWL_BASE - BOWL_TOP + 10} fill="#3b1f14" />
              <g stroke={INK} strokeWidth="1.8">
                {BEANS.map(([cx, cy, rot, shade]) => (
                  <ellipse key={`${cx}-${cy}`} cx={cx} cy={cy} rx="8.5" ry="5.5" fill={shade} transform={`rotate(${rot} ${cx} ${cy})`} />
                ))}
              </g>
            </g>
          </g>
          <path d="M168 206 V300 C168 352 186 386 214 396" stroke="#faf9f5" strokeWidth="8" strokeLinecap="round" opacity="0.18" />
          <path d={BOWL} stroke="#d9d6cf" strokeWidth="5" />
          <rect x="142" y="150" width="292" height="44" rx="16" fill="#3a3a37" stroke={INK} strokeWidth="6" />
          {grinder === 'broken' ? (
            <path className="m-crack" d="M254 500 L292 552 L266 558 L318 618" stroke="#f0565f" strokeWidth="7" strokeLinecap="round" />
          ) : null}
          {grinder === 'broken' ? <Trouble x={287} y={620} sparks={[312, 560]} soft={soft} /> : null}
        </g>

        {/* ======================== ESPRESSO MACHINE ======================= */}
        {/* A box on a plinth: cup tray on top, a wide head with the gauge
            between two knobs, the narrower body under it with the group head,
            and the drip tray set into the plinth. */}
        <g style={fade(lit(head, 'brew'))}>
          <rect x="522" y="270" width="512" height="28" rx="9" fill={CHROME} stroke={INK} strokeWidth="6" />
          <rect x="536" y="278" width="484" height="12" rx="4" fill={DARK} />
          {/* plinth, feet and drip tray */}
          <rect x="518" y="846" width="64" height="20" rx="5" fill={INK} />
          <rect x="976" y="846" width="64" height="20" rx="5" fill={INK} />
          <rect x="484" y="734" width="588" height="116" rx="16" fill={BODY_M} stroke={INK} strokeWidth="6" />
          <rect x="506" y="736" width="544" height="34" rx="8" fill={DARK} stroke={INK} strokeWidth="5" />
          <g stroke="#4a4a47" strokeWidth="5" strokeLinecap="round">
            <line x1="530" y1="752" x2="700" y2="752" />
            <line x1="858" y1="752" x2="1026" y2="752" />
          </g>
          {/* body under the head */}
          <rect x="530" y="462" width="496" height="276" fill={BODY_M} stroke={INK} strokeWidth="6" />
          <rect x="552" y="480" width="14" height="236" rx="4" fill={BODY_LT} />
          {/* the head: gauge between two knobs */}
          <rect x="490" y="294" width="576" height="174" rx="24" fill={BODY_M} stroke={INK} strokeWidth="6" />
          <rect x="512" y="312" width="16" height="138" rx="5" fill={BODY_LT} />
          <rect x="530" y="466" width="496" height="10" fill={INK} />
          {/* brew knob (left) and steam knob (right) glow while in use */}
          {[
            { cx: 605, on: extracting },
            { cx: 945, on: steaming },
          ].map(({ cx, on }) => (
            <g key={cx}>
              {on ? <circle className="m-glow" cx={cx} cy="384" r="46" fill="#f4a261" opacity="0.3" /> : null}
              <circle cx={cx} cy="384" r="30" fill={DARK} stroke={INK} strokeWidth="6" />
              <circle cx={cx} cy="384" r="18" fill={on ? '#5a3312' : '#141413'} stroke={on ? '#ffb45e' : '#c98a2e'} strokeWidth="6" />
            </g>
          ))}
          <circle cx="773" cy="384" r="62" fill={DARK} stroke={INK} strokeWidth="6" />
          <circle cx="773" cy="384" r="50" fill="#f4f1ea" />
          <g stroke="#3a3936" strokeWidth="4" strokeLinecap="round">
            {[0, 45, 90, 135, 180, 225, 270, 315].map((a) => {
              const r = (a * Math.PI) / 180;
              return (
                <line key={a} x1={773 + Math.sin(r) * 36} y1={384 - Math.cos(r) * 36} x2={773 + Math.sin(r) * 44} y2={384 - Math.cos(r) * 44} />
              );
            })}
          </g>
          {/* the needle swings up to pressure and trembles only while a shot pulls */}
          <g style={{ ...PIVOT, transform: `rotate(${extracting ? 45 : -135}deg)`, transition: 'transform var(--duration-slow) var(--ease-smooth-out)' }}>
            <g className={extracting ? 'm-needle' : undefined} style={PIVOT}>
              <circle cx="773" cy="384" r="50" fill="none" />
              <line x1="773" y1="384" x2="773" y2="344" stroke="#d83a2f" strokeWidth="6" strokeLinecap="round" />
            </g>
          </g>
          <circle cx="773" cy="384" r="7" fill="#d83a2f" />
        </g>

        {/* ========================== PORTAFILTER ========================== */}
        {/* One portafilter. It slides under the grinder's chute to fill, is tamped
            there, and slides back into the group head to lock in; the handle
            drops about 12° from the basket's neck. */}
        {/* the knock box: in from the left for the knock, out to the left after */}
        {knockBox ? (
          <g className={knockBox === 'in' ? 'm-from-left' : 'm-to-left'}>
            <rect x="458" y="816" width="144" height="70" rx="6" fill="#141413" />
            {/* the spent puck: out of the upturned basket once it is over the box, down into it */}
            {knockStep ? (
              <ellipse
                key={knockStep.startedAt}
                className="m-puck"
                cx="530"
                cy="806"
                rx="40"
                ry="13"
                fill="#2e1a10"
                stroke={INK}
                strokeWidth="4"
                style={{ animationDuration: `${knockMs}ms` }}
              />
            ) : null}
            <path d="M456 830 H604 L598 886 Q597 894 589 894 H471 Q463 894 462 886 Z" fill="#2b2b29" stroke={INK} strokeWidth="5" />
            <rect x="446" y="810" width="168" height="16" rx="7" fill="#3a3a37" stroke={INK} strokeWidth="5" />
          </g>
        ) : null}
        <g
          style={{
            transform: knockStep ? 'translate(-248px, 226px)' : pfAtGrinder ? 'translate(-491px, 184px)' : 'translate(0px, -12px)',
            transition: `transform ${knockMove}ms var(--ease-smooth-out)`,
          }}
        >
          {/* for the knock it turns over about the basket's middle (the clear circle
              centres the group's box there), the basket upside down over the box */}
          <g style={{ ...PIVOT, transform: knockStep ? 'rotate(150deg)' : 'none', transition: `transform ${knockMove}ms var(--ease-smooth-out)` }}>
          <circle cx="778" cy="542" r="270" fill="none" />
          <g style={fade(lit(pfState, 'portafilter'))}>
            <Halo keyline={keyline} state={lit(pfState, 'portafilter')}>
              <g strokeWidth={6 + HALO}>
                <path d={BASKET} />
                <path d="M743 566 H813 L807 588 H749 Z" />
              </g>
            </Halo>
            {/* grounds: a mound rising as it grinds, flat once tamped (hidden in the group) */}
            {/* The cone grows with the grind (scaled from its foot, eased between
                ticks); under the tamper it squashes down and becomes the flat puck. */}
            {pfAtGrinder && grounds > 0 && !tamped ? (
              <path
                key={tampStep ? `tamp-${tampStep.startedAt}` : 'cone'}
                className={tampStep ? 'm-flatten' : undefined}
                d="M714 520 L772 458 Q778 454 784 458 L842 520 Z"
                fill="#6b3f24"
                stroke={INK}
                strokeWidth="4"
                strokeLinejoin="round"
                style={{
                  transformBox: 'fill-box',
                  transformOrigin: 'bottom',
                  transform: tampStep ? undefined : `scaleY(${grounds})`,
                  transition: 'transform 260ms linear',
                  animationDuration: tampStep ? `${Math.max(200, tampStep.endsAt - tampStep.startedAt)}ms` : undefined,
                }}
              />
            ) : null}
            {pfAtGrinder && (tamped || tampStep) ? (
              <rect
                key={tampStep ? `puck-${tampStep.startedAt}` : 'puck'}
                className={tampStep ? 'm-pressed' : undefined}
                x="716"
                y="506"
                width="124"
                height="14"
                rx="4"
                fill="#5a331c"
                stroke={INK}
                strokeWidth="4"
                style={{ animationDuration: tampStep ? `${Math.max(200, tampStep.endsAt - tampStep.startedAt)}ms` : undefined }}
              />
            ) : null}
            {/* The handle, pseudo-3D: parallel to the machine and full length until
                it locks, then twisted out toward the viewer, foreshortened and
                angled down about 12°. It turns about the basket's neck. */}
            <g
              style={{
                transformBox: 'fill-box',
                transformOrigin: '93% 41%',
                transform: pfLocked ? 'rotate(-12deg) scaleX(1)' : 'rotate(1deg) scaleX(1.24)',
                transition: 'transform 420ms var(--ease-smooth-out)',
              }}
            >
              <Halo keyline={keyline} state={lit(pfState, 'portafilter')}>
                <path d={HANDLE} strokeWidth={6 + HALO} />
              </Halo>
              <path d={HANDLE} fill={DARK} stroke={INK} strokeWidth="6" />
              <circle cx="574" cy="553" r="8" fill="#3a3a37" />
              <rect x="694" y="538" width="34" height="22" rx="4" fill={CHROME} stroke={INK} strokeWidth="6" />
            </g>
            <path d={BASKET} fill={CHROME} stroke={INK} strokeWidth="6" />
            <rect x="770" y="522" width="16" height="40" rx="5" fill="#faf9f5" opacity="0.6" />
            <path d="M743 566 H813 L807 588 H749 Z" fill="#2a2a28" stroke={INK} strokeWidth="5" />
            <rect x="757" y="586" width="12" height="14" rx="3" fill="#2a2a28" stroke={INK} strokeWidth="4" />
            <rect x="787" y="586" width="12" height="14" rx="3" fill="#2a2a28" stroke={INK} strokeWidth="4" />
            {/* the tamper: fades in above the basket, presses the grounds flat, lifts and fades out, over the tamp's own time */}
            {tampStep ? (
              <g
                key={tampStep.startedAt}
                className="m-tamp"
                style={{ animationDuration: `${Math.max(200, tampStep.endsAt - tampStep.startedAt)}ms` }}
              >
                <rect x="750" y="404" width="56" height="58" rx="24" fill="#3a2a1f" stroke={INK} strokeWidth="5" />
                <rect x="766" y="458" width="24" height="42" fill={CHROME} stroke={INK} strokeWidth="5" />
                <rect x="718" y="496" width="120" height="24" rx="5" fill={CHROME} stroke={INK} strokeWidth="5" />
                <rect x="728" y="502" width="40" height="6" rx="3" fill="#faf9f5" opacity="0.7" />
              </g>
            ) : null}
          </g>
          </g>
        </g>
        {grinding && pfAtGrinder ? (
          <path className="m-stream" d="M287 680 V700" stroke="#6b3f24" strokeWidth="8" strokeLinecap="round" strokeDasharray="4 8" />
        ) : null}

        {/* hot-water spout, under the head's right end, over the drip tray; lit with its
            stream while water goes into a cup (not dimmed with the machine) */}
        <g style={fade(waterStep ? 'running' : lit(head, 'water'))}>
          <Halo keyline={keyline} state={lit('idle', 'water')}>
            <g strokeWidth={5 + HALO}>
              <rect x="950" y="470" width="20" height="78" rx="4" />
              <path d="M944 546 H976 L970 566 H950 Z" />
            </g>
          </Halo>
          <rect x="950" y="470" width="20" height="78" rx="4" fill={CHROME} stroke={INK} strokeWidth="5" />
          <path d="M944 546 H976 L970 566 H950 Z" fill={CHROME} stroke={INK} strokeWidth="5" strokeLinejoin="round" />
          {waterStep ? (
            <Stream x={960} y1={570} y2={652} color="#9fd3e6" width={7} />
          ) : null}
        </g>

        {/* group head: the chrome collar, drawn over the portafilter so the basket locks up into it */}
        <g style={fade(lit(head, 'brew'))} className={head === 'broken' ? 'm-jolt' : undefined}>
          <Halo keyline={keyline} state={lit(head, 'brew')}>
            <rect x="696" y="474" width="164" height="46" rx="8" strokeWidth={6 + HALO} />
          </Halo>
          <rect x="696" y="474" width="164" height="46" rx="8" fill={CHROME} stroke={INK} strokeWidth="6" />
          <rect x="740" y="474" width="76" height="46" fill="#2a2a28" />
          <rect x="706" y="482" width="12" height="30" rx="4" fill="#faf9f5" opacity="0.7" />
          {head === 'broken' ? (
            <path className="m-crack" d="M720 480 L752 512 L732 520 L770 552" stroke="#f0565f" strokeWidth="7" strokeLinecap="round" />
          ) : null}
          {head === 'broken' ? <Trouble x={778} y={452} sparks={[800, 500]} soft={soft} /> : null}
          {/* the purge: a short spray from the group before the portafilter locks in */}
          {lockStep ? (
            <g key={lockStep.startedAt} className="m-purge" stroke="#9fd3e6" strokeWidth="5" strokeLinecap="round">
              {[730, 750, 770, 790, 810, 830].map((x, i) => (
                <path key={x} d={`M${x} 524 l${(i - 2.5) * 3} ${22 + (i % 2) * 10}`} />
              ))}
            </g>
          ) : null}
          {/* the shot, from both spouts into the cup */}
          {extracting ? (
            <>
              <Stream x={763} y1={594} y2={652} color="#b8742a" width={5} />
              <Stream x={793} y1={594} y2={652} color="#b8742a" width={5} />
            </>
          ) : null}
        </g>

        {/* ============================ STEAM WAND ========================== */}
        {/* A stub and elbow out of the head's side, a rubber grip at ~54°, then a
            steep tube at ~71° into a straight-sided jug with a lip spout and a
            squared handle. */}
        <g style={fade(lit(wand, 'steam', 'jug'))} className={wand === 'broken' ? 'm-jolt' : undefined}>
          <Halo keyline={keyline} state={lit(wand, 'steam', 'jug')}>
            <path d="M1074 428 H1090 Q1112 428 1114 450 L1118 478" strokeWidth={22 + HALO} />
            <path d="M1120 484 L1160 542" strokeWidth={38 + HALO} />
            <path d="M1162 546 L1204 666" strokeWidth={18 + HALO} />
          </Halo>
          <path d="M1062 428 H1090 Q1112 428 1114 450 L1118 478" stroke={INK} strokeWidth="22" strokeLinecap="round" />
          <path d="M1062 428 H1090 Q1112 428 1114 450 L1118 478" stroke={CHROME} strokeWidth="12" strokeLinecap="round" />
          <path d="M1162 546 L1214 694" stroke={INK} strokeWidth="18" strokeLinecap="round" />
          <path d="M1162 546 L1214 694" stroke={CHROME} strokeWidth="9" strokeLinecap="round" />
          <path d="M1120 484 L1160 542" stroke={INK} strokeWidth="38" strokeLinecap="round" />
          <path d="M1120 484 L1160 542" stroke={DARK} strokeWidth="28" strokeLinecap="round" />
          {/* steam: soft puffs off the jug that rise, swell and thin out */}
          {steaming && wand !== 'broken' ? (
            <g filter={soft} fill="#faf9f5">
              {[0, 1, 2, 3, 4].map((i) => (
                <circle key={i} className="m-steam" data-i={i} cx={1196 + i * 26} cy={650} r="20" />
              ))}
            </g>
          ) : null}
          {wand === 'broken' ? <Trouble x={1150} y={470} sparks={[1140, 510]} soft={soft} /> : null}
          {/* the jug; while pouring it lifts off the wand and tips onto the front cup's lip */}
          <g style={{ ...TILT, transform: `translate(${tip * (82 + pourShift)}px, ${tip * -94}px) rotate(${tip * -80}deg)` }}>
            <Halo keyline={keyline} state={lit(wand, 'steam', 'jug')}>
              <path d={JUG_HANDLE} strokeWidth={22 + HALO} />
              <path d={JUG} strokeWidth={6 + HALO} />
            </Halo>
            <path d={JUG_HANDLE} stroke={INK} strokeWidth="22" strokeLinecap="round" />
            <path d={JUG_HANDLE} stroke={SILVER} strokeWidth="11" strokeLinecap="round" />
            <path d={JUG} fill={SILVER} />
            <g clipPath={`url(#${uid}-jug)`}>
              <path d="M1186 660 L1182 880" stroke={SILVER_LT} strokeWidth="18" />
              <path d="M1286 660 L1292 880" stroke={SILVER_DK} strokeWidth="20" />
            </g>
            <JugCutaway uid={uid} level={jug} angle={tip * -80} />
            <path d={JUG} stroke={INK} strokeWidth="6" />
          </g>
          {wand === 'broken' ? (
            <path className="m-crack" d="M1122 470 L1146 496 L1130 506 L1160 538" stroke="#f0565f" strokeWidth="7" strokeLinecap="round" />
          ) : null}
        </g>

      </g>

      {/* the state of each part, laid over the scene */}
      {grinder === 'running' && grindStep ? <Ring x={276} y={360} fraction={progress(grindStep, now)} /> : null}
      <Badge x={254} y={30} state={grinder} repaired={repaired('grinder')} />
      {head === 'running' && headStep ? <Ring x={567} y={322} fraction={progress(headStep, now)} /> : null}
      <Badge x={510} y={222} state={head} repaired={repaired('groupHead')} />
      <Badge x={pouring ? 740 + pourShift * S : 792} y={pouring ? 282 : 324} state={wand} repaired={repaired('steamWand')} />

      <Chip x={43} w={240} state={chipState('grinder', grinder)} {...chip('grinder', grinder)} warn={grinder === 'idle' && beansLow ? 'beans low' : undefined} />
      <Chip x={298} w={320} state={chipState('groupHead', head)} {...chip('groupHead', head)} />
      <Chip x={630} w={240} state={wand} {...chip('steamWand', wand)} />

      {/* the chocolate sauce, standing at the end of the counter; picked up (gone from here) while it pours */}
      {bottle ? null : (
        <g transform="translate(862 429) scale(0.65)" style={fade(lit('idle', 'chocolate'))}>
          <Halo keyline={keyline} state={lit('idle', 'chocolate')}>
            <g strokeWidth={4 + HALO}>
              <rect x="-22" y="-102" width="44" height="102" rx="12" />
              <rect x="-13" y="-124" width="26" height="22" rx="4" />
            </g>
          </Halo>
          <g stroke="#0a0a09" strokeWidth="4" strokeLinejoin="round">
            <path d="M-6 -124 L-4 -138 H4 L6 -124 Z" fill="#e9e4da" />
            <rect x="-13" y="-124" width="26" height="22" rx="4" fill="#b3202b" />
            <rect x="-22" y="-102" width="44" height="102" rx="12" fill="#5a2e1a" />
            <rect x="-22" y="-66" width="44" height="30" fill="#efe3c8" />
          </g>
        </g>
      )}
    </svg>

      {/* ============================== CUPS ============================= */}
      {/* Glass cups, the same as in the orders, laid over the drawing as their
          own elements: each slides in under the spouts, slides forward (nearer,
          so larger) for the milk, and, once served, flies to its order card in
          a view transition (it carries the cup's view-transition-name until it
          lands). */}
      {/* the chocolate bottle, tipped over the cup while chocolate goes in */}
      {bottle ? <ChocolateBottle at={bottleAt.current} leaving={bottle === 'out'} /> : null}
      {/* an empty spot a click would put a cup in: a dashed cup, where it would stand */}
      {(['tray', ...FRONT_SPOTS] as const).map((spot, i) => {
        const at = spot === 'tray' ? CUP_AT.tray : FRONT_AT[i - 1];
        const empty = spot === 'tray' ? !cupIn(ctx, 'tray') : !ctx.cups.some((c) => c.spot === 'front' && c.slot === i - 1);
        return hover === spot && hovered?.event && empty ? (
          <div
            key={spot}
            className="pointer-events-none absolute"
            style={{
              left: `${(at.x / 900) * 100}%`,
              top: `${(at.y / 545) * 100}%`,
              width: `${(at.w / 900) * 100}%`,
              aspectRatio: '108 / 80',
            }}
          >
            <Mug width="100%" height="100%" dashed />
          </div>
        ) : null;
      })}
      {cups.map((c) => {
        const state = c.leaving ? cupState(c) : lit(cupState(c), c.spot === 'front' ? FRONT_SPOTS[c.slot ?? 0] : 'tray');
        const at = c.spot === 'front' ? frontAt(c.slot) : atWater(c) ? CUP_AT.water : CUP_AT.tray;
        return (
          <div
            key={c.id}
            // A cup poured away shakes and fades where it stood.
            className={`${dumping(c.id) ? 'm-decline' : 'm-cup-in'} pointer-events-none absolute`}
            style={{
              left: `${(at.x / 900) * 100}%`,
              top: `${(at.y / 545) * 100}%`,
              width: `${(at.w / 900) * 100}%`,
              aspectRatio: '108 / 80',
              viewTransitionName: `cup-${c.id}`,
              filter: fade(state).filter,
              transition: ['left', 'top', 'width'].map((p) => `${p} 650ms var(--ease-smooth-out)`).concat(fade(state).transition).join(', '),
            }}
          >
            <Mug
              contents={c.contents}
              pouring={c.leaving ? undefined : cupPour(c.id)}
              width="100%"
              height="100%"
              halo={state === 'idle' ? undefined : TONE[state].stroke}
            />
          </div>
        );
      })}

      {/* Working the bar by hand: each spot is a button over its part, doing
          what Jev could do there. The part lights up under the pointer; a
          label says what a click does, or why it would do nothing. */}
      {interact
        ? [
            { spot: 'brew' as BarSpot, box: BODY_BOX, key: 'body' },
            { spot: 'steam' as BarSpot, box: WAND_BOX, key: 'wand' },
            ...(Object.keys(SPOT_BOX) as BarSpot[]).concat('portafilter', 'tray').map((spot) => ({ spot, box: boxOf(spot), key: spot })),
            // A place at the front with a cup, or the next free one.
            ...FRONT_SPOTS.filter((_, slot) => ctx.cups.some((c) => c.spot === 'front' && c.slot === slot) || slot === freeSlot(ctx)).map(
              (spot) => ({ spot, box: boxOf(spot), key: spot }),
            ),
            ...DEVICES.map((d) => ({ spot: DEVICE_SPOT[d], box: CHIP_BOX[d], key: `chip-${d}` })),
            ...DEVICES.filter((d) => equipment[d] !== 'ok').map((d) => ({ spot: DEVICE_SPOT[d], box: BADGE_BOX[d], key: `badge-${d}` })),
          ].map(({ spot, box, key }) => {
            const action = actionAt(spot)!;
            return (
              <button
                key={key}
                type="button"
                aria-label={action.label}
                aria-disabled={!action.event}
                onPointerEnter={(e) => enter(spot, box, e)}
                // Past the edge of the part that was open: this one takes over.
                onPointerMove={(e) => (hover !== spot ? enter(spot, box, e) : undefined)}
                onPointerLeave={() => leave()}
                onFocus={() => enter(spot, box)}
                onBlur={() => leave()}
                // A click just off the part whose actions are open (by the pointer, not a key) is still that part's.
                onClick={(e) => {
                  const at = hover && hover !== spot && e.detail > 0 && stillOn(e) ? hover : spot;
                  const open = actionAt(at)!;
                  if (open.event) interact.act(open.event);
                  else setNudge((n) => ({ spot: at, n: n?.spot === at ? n.n + 1 : 1 }));
                }}
                className={`absolute rounded-xl outline-offset-2 focus-visible:outline-2 focus-visible:outline-[#faf9f5] ${
                  action.event ? 'cursor-pointer' : 'cursor-not-allowed'
                }`}
                style={{
                  left: `${(box.x / 900) * 100}%`,
                  top: `${(box.y / 545) * 100}%`,
                  width: `${(box.w / 900) * 100}%`,
                  height: `${(box.h / 545) * 100}%`,
                }}
              />
            );
          })
        : null}
      {/* Hovering the jug: what is in it and how much, on the jug itself. */}
      {interact && (hover === 'jug' || hover === 'steam') ? (
        <div
          className="pointer-events-none absolute flex -translate-x-1/2 -translate-y-1/2 flex-col items-center text-center leading-tight text-[#141413]"
          style={{ left: `${(JUG_MIDDLE.x / 900) * 100}%`, top: `${(JUG_MIDDLE.y / 545) * 100}%` }}
        >
          {ctx.pitcher ? (
            <>
              <span className="rounded-md bg-[#faf9f5]/90 px-1.5 text-[11px] font-medium whitespace-nowrap">
                {INGREDIENT_LABEL[ctx.pitcher.milk]}
              </span>
              <span className="tnum mt-0.5 rounded-md bg-[#faf9f5]/90 px-1.5 text-[11px]">{Math.round(ctx.pitcher.ml)}ml</span>
            </>
          ) : (
            <span className="rounded-md bg-[#faf9f5]/90 px-1.5 text-[11px]">empty</span>
          )}
        </div>
      ) : null}
      {interact && hovering && hovered ? (
        <SpotLabel
          key={`${hovering.spot}-${nudge?.spot === hover ? nudge.n : 0}`}
          action={hovered}
          box={barBox(hovering.spot, hovering.box)}
          below={opensBelow(hovering.spot, barBox(hovering.spot, hovering.box))}
          barRef={barRef}
          shake={nudge?.spot === hover}
          onAct={interact.act}
          onBreak={interact.breakIt}
          onEnter={stay}
          onLeave={() => leave()}
        />
      ) : null}
    </div>
  );
}