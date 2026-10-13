/**
 * A day's clock: wall time that can stand still. It is the day actor's
 * system clock, so the bar's timed steps (`after`) and the day's timeline run
 * on it, and pausing it pauses them all at the same instant. Its time is wall
 * time minus every pause so far.
 */
interface Timer {
  fn: () => void;
  /** When it fires, in world time. */
  due: number;
  /** The wall-clock timeout counting down to it, while running. */
  handle?: ReturnType<typeof setTimeout>;
}

export class WorldClock {
  private timers = new Map<number, Timer>();
  private nextId = 1;
  private pausedFor = 0;
  private pausedAt: number | null = null;

  /** World time: frozen while paused. */
  now(): number {
    return (this.pausedAt ?? Date.now()) - this.pausedFor;
  }

  get paused(): boolean {
    return this.pausedAt !== null;
  }

  setTimeout(fn: (...args: any[]) => void, timeout: number): number {
    const id = this.nextId++;
    const timer: Timer = { fn, due: this.now() + timeout };
    this.timers.set(id, timer);
    if (!this.paused) this.arm(id, timer);
    return id;
  }

  clearTimeout(id: number): void {
    clearTimeout(this.timers.get(id)?.handle);
    this.timers.delete(id);
  }

  pause(): void {
    if (this.paused) return;
    this.pausedAt = Date.now();
    for (const timer of this.timers.values()) clearTimeout(timer.handle);
  }

  resume(): void {
    if (this.pausedAt === null) return;
    this.pausedFor += Date.now() - this.pausedAt;
    this.pausedAt = null;
    for (const [id, timer] of this.timers) this.arm(id, timer);
  }

  /** Resolves once world time reaches `at`: straight away if it already has. */
  until(at: number): Promise<void> {
    return new Promise((resolve) => (this.now() >= at ? resolve() : this.setTimeout(resolve, at - this.now())));
  }

  private arm(id: number, timer: Timer): void {
    timer.handle = setTimeout(() => {
      this.timers.delete(id);
      timer.fn();
    }, Math.max(0, timer.due - this.now()));
  }
}
