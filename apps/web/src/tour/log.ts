/**
 * The onboarding event log (docs/design/onboarding-research.md §6.1): what the tour, the hints and the
 * Next orders cards did, kept on this device as a ring buffer of at most 50 KB (`mf.log.v1`). Storage
 * that fails (private mode, full, blocked) is ignored: the log then lives for the session only.
 *
 * Nothing leaves the device. An upload to our own API is the owner's opt-in decision (§8.2), so it
 * stays off behind UPLOAD_ENABLED with no endpoint, and there is no holdout.
 */

export type Persona = 'recruit' | 'veteran' | 'invited' | 'unknown';
export type Device = 'touch' | 'keyboard' | 'pad';
export type StepStatus = 'shown' | 'done' | 'skipped' | 'timeout-offered' | 'abandoned';
export type DeathCause = 'gas' | 'fall' | 'grenade' | 'self' | 'melee' | 'mine' | 'gun';
export type Move = 'dash' | 'grenade' | 'take' | 'melee' | 'swap' | 'shield' | 'zoom' | 'aimed-throw';

/** Every event in §6.1, by its name (`t`). */
export type TourLogEvent =
  | { t: 'tour.step'; tour: string; step: string; persona: Persona; device: Device; status: StepStatus; ms: number }
  | { t: 'tour.end'; tour: string; result: 'finished' | 'skipped-all' | 'abandoned'; ms: number }
  | { t: 'briefing.answer'; answer: 'recruit' | 'veteran' | 'skipped'; device: Device; changed: boolean }
  | { t: 'promotion' | 'help.offered' | 'help.accepted'; reason: string }
  | { t: 'hint.shown'; hint: string }
  | { t: 'hint.acted'; hint: string; secs: number }
  | { t: 'card.shown' | 'card.tapped' | 'card.dismissed'; card: string; rank: number; score: number }
  | { t: 'first.kill'; sinceTitle: number | null; sinceMatch: number }
  | { t: 'match.end'; online: boolean; bots: string | null; kills: number; deaths: Partial<Record<DeathCause, number>>; moves: Move[] }
  | { t: 'session.start'; days: number };

export type Logged = TourLogEvent & { at: number };

export const LOG_KEY = 'mf.log.v1';
export const LOG_MAX_BYTES = 50_000;

/** The owner hasn't opted in to sending onboarding events to our API (§8.2): nothing is uploaded. */
export const UPLOAD_ENABLED = false;

type KeyValue = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export class EventLog {
  private items: Logged[] = [];

  constructor(
    private readonly storage: KeyValue | null,
    private readonly now: () => number = Date.now,
    private readonly maxBytes = LOG_MAX_BYTES,
  ) {
    try {
      const raw = storage?.getItem(LOG_KEY);
      const saved = raw ? (JSON.parse(raw) as unknown) : null;
      if (Array.isArray(saved)) this.items = saved.filter((e): e is Logged => typeof e === 'object' && e !== null && typeof (e as Logged).t === 'string');
    } catch {
      this.items = [];
    }
  }

  record(e: TourLogEvent): void {
    this.items.push({ ...e, at: this.now() } as Logged);
    let json = JSON.stringify(this.items);
    // drop the oldest until it fits (a tenth at a time: a full buffer doesn't re-serialise per event)
    while (json.length > this.maxBytes && this.items.length > 1) {
      this.items.splice(0, Math.max(1, Math.floor(this.items.length / 10)));
      json = JSON.stringify(this.items);
    }
    try {
      this.storage?.setItem(LOG_KEY, json);
    } catch {
      /* private mode or full: the session keeps it */
    }
  }

  entries(): readonly Logged[] {
    return this.items;
  }

  /** what the buffer takes in storage */
  bytes(): number {
    return JSON.stringify(this.items).length;
  }

  clear(): void {
    this.items = [];
    try {
      this.storage?.removeItem(LOG_KEY);
    } catch {
      /* fine */
    }
  }
}

export interface FunnelRow {
  step: string;
  shown: number;
  done: number;
  skipped: number;
  timeout: number;
  abandoned: number;
  /** median ms from shown to done, null when none was done */
  medianMs: number | null;
}

/** Per-step counts for one tour, in the order the steps were first shown (§6.2). */
export function funnel(entries: readonly Logged[], tour: string): FunnelRow[] {
  const rows = new Map<string, FunnelRow & { times: number[] }>();
  for (const e of entries) {
    if (e.t !== 'tour.step' || e.tour !== tour) continue;
    let r = rows.get(e.step);
    if (!r) rows.set(e.step, (r = { step: e.step, shown: 0, done: 0, skipped: 0, timeout: 0, abandoned: 0, medianMs: null, times: [] }));
    if (e.status === 'shown') r.shown++;
    else if (e.status === 'done') {
      r.done++;
      r.times.push(e.ms);
    } else if (e.status === 'skipped') r.skipped++;
    else if (e.status === 'timeout-offered') r.timeout++;
    else r.abandoned++;
  }
  return [...rows.values()].map(({ times, ...r }) => {
    const sorted = [...times].sort((a, b) => a - b);
    return { ...r, medianMs: sorted.length ? sorted[Math.floor((sorted.length - 1) / 2)]! : null };
  });
}
