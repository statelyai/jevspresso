import { useEffect, useRef, useState } from 'react';
import type { ViewBar } from '../lib/view';
import type { Bar } from '../lib/types';

/** How often the page's clock moves on screen: smooth progress, no faster. */
const FRAME_MS = 100;

/** A delay the actor system is running: when it was scheduled and when it is due. */
export interface Timer {
  id: string;
  scheduledAt: number;
  dueAt: number;
}

/**
 * The bar as the page shows it. The machine holds no time: its timed states
 * wait out their delays, and the actor system knows when each was scheduled
 * and is due (`timers`, keyed `xstate.after.<delay>.<state id>`). A running
 * step takes its times from its state's timer. Without one (a restored bar),
 * and for when an order was served, the page notes when it first saw it.
 * Times are the actor system's clock (`now`): the wall clock, or a world's.
 */
export function useOnScreen(bar: Bar, timers: () => Record<string, Timer> = () => ({}), now: () => number = Date.now): ViewBar {
  const [, frame] = useState(0);
  useEffect(() => {
    const id = setInterval(() => frame((n) => n + 1), FRAME_MS);
    return () => clearInterval(id);
  }, []);
  const seen = useRef(new Map<string, number>());
  const live = new Set<string>();
  const stamp = (key: string) => {
    live.add(key);
    if (!seen.current.has(key)) seen.current.set(key, now());
    return seen.current.get(key)!;
  };
  const running = Object.values(timers());
  const timerOf = (state: string) => running.find((t) => t.id.endsWith(`.${state}`));
  const activeSteps = bar.activeSteps.map((s) => {
    const timer = timerOf(s.state);
    const startedAt = timer?.scheduledAt ?? stamp(`step:${s.state}:${s.cupId ?? ''}`);
    return { ...s, startedAt, endsAt: timer?.dueAt ?? startedAt + s.ms };
  });
  const handsSince = {
    jev: bar.hands.jev ? (timerOf('hands.jev.busy')?.scheduledAt ?? stamp(`hands:jev:${bar.hands.jev.doing}`)) : null,
    you: bar.hands.you ? (timerOf('hands.you.busy')?.scheduledAt ?? stamp(`hands:you:${bar.hands.you.doing}`)) : null,
  };
  const servedAt = Object.fromEntries(bar.drinks.filter((d) => d.status === 'served').map((d) => [d.id, stamp(`served:${d.id}@${d.orderedAt}`)]));
  // A step seen again after it ended is a new one: forget what is no longer there.
  for (const key of seen.current.keys()) if (!live.has(key)) seen.current.delete(key);
  return { ...bar, activeSteps, now: now(), handsSince, servedAt };
}
