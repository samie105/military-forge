/**
 * Home's three stops (docs/design/onboarding-research.md §3.5): the first time on Home after a match
 * (or the first Home for a veteran), one blocking spotlight pass: Create room, Join with code, the
 * Locker. Each has Next (the last, Done), Skip, and Escape skips the pass; pressing the target itself
 * does what it says and ends the pass. Once per device (`tours['home-stops']`), every stop logged.
 * Targets are Home's `data-tour` hooks; a stop whose target isn't there (offline: Create room is off)
 * is left out, and with none there (the phone Home, until it has the hooks) the pass waits.
 */
import { Spotlight, type SpotStep } from '../ui/spotlight';
import type { Facts } from './facts';
import type { TourMemory } from './index';
import type { Device, Persona } from './log';

export const HOME_STOPS = 'home-stops';

interface Stop {
  id: 'create' | 'join' | 'locker';
  title: string;
  body: string;
}

export const STOPS: readonly Stop[] = [
  { id: 'create', title: 'Play with friends.', body: 'Share the code.' },
  { id: 'join', title: 'Got a code?', body: 'In here.' },
  { id: 'locker', title: 'Your kit.', body: 'Change it any time.' },
];

/** The pass is due: never run here, and a match played (or a veteran's first Home). */
export function homeStopsWanted(f: Facts): boolean {
  return !f.tours[HOME_STOPS] && (f.experience === 'veteran' || f.matches.local + f.matches.online >= 1);
}

/** Home must sit idle this long (no tap, key or pad press) before the pass may start. */
export const HOME_IDLE_MS = 6000;

/**
 * When the pass may start (P1-5: let the player breathe): on a Home visit that didn't come straight
 * from a match, after HOME_IDLE_MS without input. Pure: main.ts feeds the times.
 */
export function homeStopsDue(cameFromMatch: boolean, lastInputAt: number, now: number): boolean {
  return !cameFromMatch && now - lastInputAt >= HOME_IDLE_MS;
}

const target = (id: Stop['id']): HTMLElement | null => {
  const el = document.querySelector<HTMLElement>(`[data-tour="${id}"]`);
  return el && !(el as HTMLButtonElement).disabled && el.getClientRects().length > 0 ? el : null;
};

/** Runs the pass now if any stop's target is on screen; returns a stop function (or null: nothing to show). */
export function runHomeStops(memory: TourMemory, device: () => Device, spotlight?: Spotlight): (() => void) | null {
  const stops = STOPS.filter((s) => target(s.id));
  if (!stops.length) return null;
  const spot = spotlight ?? new Spotlight({ phone: () => document.documentElement.classList.contains('mf-phone') });
  const persona = (): Persona => memory.facts.get().experience ?? (memory.facts.get().invited ? 'invited' : 'unknown');
  let i = 0;
  let shownAt = performance.now();
  let over = false;
  const log = (step: string, status: 'shown' | 'done' | 'skipped' | 'abandoned') =>
    memory.record({ t: 'tour.step', tour: HOME_STOPS, step, persona: persona(), device: device(), status, ms: Math.round(performance.now() - shownAt) });
  const end = (result: 'finished' | 'skipped-all' | 'abandoned') => {
    if (over) return;
    over = true;
    memory.record({ t: 'tour.end', tour: HOME_STOPS, result, ms: 0 });
    memory.fact({ k: 'tour', tour: HOME_STOPS, ...(result === 'finished' ? { finished: true } : { skipped: true }) });
    document.removeEventListener('click', onTargetClick, true);
    void spot.hide().then(() => !spotlight && spot.dispose());
  };
  const show = () => {
    const s = stops[i]!;
    shownAt = performance.now();
    const step: SpotStep = {
      id: `${HOME_STOPS}:${s.id}`,
      target: { kind: 'element', el: () => target(s.id) },
      // never blocking (mobile audit P1-5): the dim shows the way but every tap reaches the screen
      block: 'none',
      dim: 0.5,
      eyebrow: `Orders · ${i + 1}/${stops.length}`,
      progress: [i, stops.length],
      title: s.title,
      body: s.body,
      primary: { label: i === stops.length - 1 ? 'Done' : 'Next' },
      announce: `Stop ${i + 1} of ${stops.length}. ${s.title} ${s.body}`,
    };
    spot.show(step);
    log(s.id, 'shown');
  };
  const next = (status: 'done' | 'skipped') => {
    log(stops[i]!.id, status);
    i++;
    if (i < stops.length) show();
    else end('finished');
  };
  // a tap on the screen itself (not the callout) does what it says and ends the pass: on the ringed
  // control that's this stop done, anywhere else the pass is left (P1-5: a tap is never eaten as Next)
  const onTargetClick = (e: MouseEvent) => {
    if (over || !(e.target instanceof Node) || spotEl()?.contains(e.target)) return;
    const el = target(stops[i]!.id);
    const hit = !!el && el.contains(e.target);
    log(stops[i]!.id, hit ? 'done' : 'abandoned');
    end(hit ? 'finished' : 'abandoned');
  };
  const spotEl = () => document.querySelector('.mf-spot');
  document.addEventListener('click', onTargetClick, true);
  spot.onPrimary = () => next('done');
  spot.onSkip = (_id, all) => {
    if (!all) return next('skipped');
    log(stops[i]!.id, 'skipped');
    end('skipped-all');
  };
  show();
  return () => {
    if (over) return;
    log(stops[i]!.id, 'abandoned');
    end('abandoned');
  };
}
