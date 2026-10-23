/**
 * A tour as data (docs/design/onboarding-research.md §4.3), like touch/teach.ts's Drill: its steps,
 * what ticks each one, and its progress, saved per step so a reload resumes at the next unticked one
 * (`mf.tour.v1`). Pure: the runner (tour/firstFlight.ts) feeds it events and shows its step through
 * the spotlight. Nothing here advances by itself: only an event that is one of the step's, or a skip.
 */

/** What ticks a step: something the player did in play, or a shell action (ui:*). */
export type TourEvent = 'move' | 'reach' | 'hit-dummy' | 'dash' | 'throw' | 'ui:create' | 'ui:join' | 'ui:locker' | 'ui:ready';

export interface TourStepDef<C = unknown> {
  id: string;
  /** what ticks it (any one) */
  done: readonly TourEvent[];
  /** how many of those it takes (3 hits); default 1 */
  count?: number;
  /** skipped by itself when it can't be done here (no grenades on the belt) */
  needs?: (ctx: C) => boolean;
}

export interface TourProgress {
  id: string;
  done: string[];
  skipped: string[];
  /** the whole tour was skipped ("Skip training") */
  skippedAll: boolean;
  /** it was running when last seen: a reload goes straight back in (leaving from the menu clears it) */
  open: boolean;
}

export class Tour<C = unknown, S extends TourStepDef<C> = TourStepDef<C>> {
  private readonly progress: TourProgress;
  /** events of the current step's kind so far (its `count`) */
  private tallied = 0;

  constructor(
    readonly id: string,
    readonly steps: readonly S[],
    saved: TourProgress | null = null,
  ) {
    const ids = new Set(steps.map((s) => s.id));
    const keep = (list: unknown) => (Array.isArray(list) ? list.filter((s): s is string => typeof s === 'string' && ids.has(s)) : []);
    this.progress =
      saved && saved.id === id
        ? { id, done: keep(saved.done), skipped: keep(saved.skipped), skippedAll: saved.skippedAll === true, open: saved.open === true }
        : { id, done: [], skipped: [], skippedAll: false, open: false };
  }

  /** the first step neither done nor skipped; null when the tour is over */
  get step(): S | null {
    if (this.progress.skippedAll) return null;
    return this.steps.find((s) => !this.progress.done.includes(s.id) && !this.progress.skipped.includes(s.id)) ?? null;
  }

  /** the current step's index (the count when over), and how many steps there are */
  get position(): readonly [number, number] {
    const s = this.step;
    return [s ? this.steps.indexOf(s) : this.steps.length, this.steps.length];
  }

  get finished(): boolean {
    return this.step === null;
  }

  get skippedAll(): boolean {
    return this.progress.skippedAll;
  }

  /** the current step's events so far, of its `count` */
  get tally(): number {
    return this.tallied;
  }

  isDone(id: string): boolean {
    return this.progress.done.includes(id);
  }

  setOpen(open: boolean): void {
    this.progress.open = open;
  }

  /** Counts `e` toward the current step and ticks it when it has its `count`. True when a step ticked. */
  act(e: TourEvent, ctx: C): boolean {
    this.skipImpossible(ctx);
    const s = this.step;
    if (!s || !s.done.includes(e)) return false;
    this.tallied++;
    if (this.tallied < (s.count ?? 1)) return false;
    this.progress.done.push(s.id);
    this.tallied = 0;
    this.skipImpossible(ctx);
    return true;
  }

  /** Steps whose `needs` says no can't be done here: skip them. True when one was. */
  skipImpossible(ctx: C): boolean {
    let any = false;
    for (let s = this.step; s?.needs && !s.needs(ctx); s = this.step) {
      this.progress.skipped.push(s.id);
      this.tallied = 0;
      any = true;
    }
    return any;
  }

  /** Skip this step, or the whole tour. */
  skip(all = false): void {
    this.tallied = 0;
    if (all) {
      this.progress.skippedAll = true;
      this.progress.open = false;
      return;
    }
    const s = this.step;
    if (s) this.progress.skipped.push(s.id);
  }

  /** From the first step again (Restart First flight). */
  restart(): void {
    this.progress.done = [];
    this.progress.skipped = [];
    this.progress.skippedAll = false;
    this.tallied = 0;
  }

  toJSON(): TourProgress {
    return { ...this.progress, done: [...this.progress.done], skipped: [...this.progress.skipped] };
  }
}

export const TOUR_KEY = 'mf.tour.v1';

type KeyValue = Pick<Storage, 'getItem' | 'setItem'>;

/** Every tour's saved progress on this device (anything unreadable is an empty record). */
export function loadTours(storage: KeyValue | null): Record<string, TourProgress> {
  try {
    const raw = storage?.getItem(TOUR_KEY);
    const v = raw ? (JSON.parse(raw) as unknown) : null;
    return typeof v === 'object' && v && !Array.isArray(v) ? (v as Record<string, TourProgress>) : {};
  } catch {
    return {};
  }
}

export function loadTour(storage: KeyValue | null, id: string): TourProgress | null {
  const t = loadTours(storage)[id];
  return typeof t === 'object' && t ? t : null;
}

/** Saves one tour's progress (writes that fail, in private mode, leave it to the session). */
export function saveTour(storage: KeyValue | null, progress: TourProgress): void {
  try {
    const all = loadTours(storage);
    all[progress.id] = progress;
    storage?.setItem(TOUR_KEY, JSON.stringify(all));
  } catch {
    /* private mode or full */
  }
}
