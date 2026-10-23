/**
 * The low-end tier (the owner, 23 Oct: "accessible by even low end devices"): `html.mf-lowend` on a
 * device that can't afford the interface's decoration, so lowend.css drops it there: no backdrop blur
 * (Frost glass becomes the kit's solid fills), no idle loops behind the menus, no blur in entrances.
 * The game's own picture is the graphics governor's business (Renderer3D's Auto tier); this is the UI.
 *
 * A device is low-end when any of these says so:
 *   - what the browser tells: 2 cores or fewer, 2 GB or less, or 4 cores with 3 GB or less; or the
 *     data saver;
 *   - the frames: the menus' first ~90 frames run slow (the median past 24 ms: under ~42 fps);
 *   - the graphics: Auto settles on Low (the governor), or the player picks Low (html.gfx-low, which
 *     lowend.css treats the same way).
 * `?lowend` forces it (checks and screenshots), `?lowend=0` keeps it off. Once on, it stays on for the
 * page: flipping back and forth would cost more than it saves.
 */

export interface LowEndHints {
  /** navigator.hardwareConcurrency */
  cores?: number | undefined;
  /** navigator.deviceMemory, GB (Chromium only) */
  memory?: number | undefined;
  /** the data saver (navigator.connection.saveData) */
  saveData?: boolean | undefined;
}

/** What the browser tells is enough to call it low-end. */
export function lowEndByHints(h: LowEndHints): boolean {
  const cores = h.cores ?? 8;
  const memory = h.memory ?? 8;
  return cores <= 2 || memory <= 2 || (cores <= 4 && memory <= 3) || h.saveData === true;
}

/** The frames a device must hold for the interface's decoration: under 24 ms at the median. */
export const SLOW_FRAME_MS = 24;
/** How many frames the judge looks at. */
export const JUDGE_FRAMES = 90;

/** Judges the menus' frame times: slow() once the median of a full window is past SLOW_FRAME_MS. */
export class FrameJudge {
  private readonly times: number[] = [];
  /** Adds one frame's length (ms); true once the window is full and slow. Gaps (a hidden tab) don't count. */
  push(dtMs: number): boolean {
    if (!(dtMs > 0) || dtMs > 250) return false;
    this.times.push(dtMs);
    if (this.times.length > JUDGE_FRAMES) this.times.shift();
    return this.slow();
  }
  slow(): boolean {
    if (this.times.length < JUDGE_FRAMES) return false;
    const sorted = [...this.times].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)]! > SLOW_FRAME_MS;
  }
  get count(): number {
    return this.times.length;
  }
}

const CLASS = 'mf-lowend';

export function isLowEnd(doc: Document = document): boolean {
  return doc.documentElement.classList.contains(CLASS);
}

function mark(reason: string): void {
  const html = document.documentElement;
  if (html.classList.contains(CLASS)) return;
  html.classList.add(CLASS);
  html.dataset.lowend = reason;
}

let started = false;

/**
 * Starts the tier once (main.ts, before the first screen): the hints now, then the frames for a few
 * seconds while the page is visible. Returns noteTier(), for the graphics governor's tier changes.
 */
export function startLowEnd(search: string = location.search): { noteTier(tier: string): void } {
  const noteTier = (tier: string) => {
    if (tier === 'low') mark('graphics');
  };
  if (started) return { noteTier };
  started = true;
  const forced = new URLSearchParams(search).get('lowend');
  if (forced !== null) {
    if (forced !== '0') mark('forced');
    return { noteTier: forced === '0' ? () => {} : noteTier };
  }
  const nav = navigator as Navigator & { deviceMemory?: number; connection?: { saveData?: boolean } };
  if (lowEndByHints({ cores: nav.hardwareConcurrency, memory: nav.deviceMemory, saveData: nav.connection?.saveData })) {
    mark('device');
    return { noteTier };
  }
  // the frames: from 1.5 s in (past the first screen's own work), for at most ~8 s, then never again
  const judge = new FrameJudge();
  let last = 0;
  let frames = 0;
  const tick = (now: number) => {
    if (last && document.visibilityState === 'visible' && judge.push(now - last)) {
      mark('frames');
      return;
    }
    last = now;
    if (++frames < 480) requestAnimationFrame(tick);
  };
  setTimeout(() => requestAnimationFrame(tick), 1500);
  return { noteTier };
}
