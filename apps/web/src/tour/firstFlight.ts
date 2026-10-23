/**
 * First flight's runner (docs/design/onboarding-research.md §3.4): the goals of tour/flight.ts in the
 * range, shown through the spotlight (ui/spotlight.ts) without blocking play: a ring on the HUD plate
 * or touch control the goal uses, a ring on a world marker (the spot ahead, the height to reach, the
 * nearest target), one line with the player's own keys. Each goal ticks by doing it and stamps
 * "Confirmed". Nothing moves on by itself: after 20 s the callout offers help and "Skip this".
 *
 * The tour waits while a menu covers play, re-reads the device (and its keys or glyphs) every frame,
 * saves its progress per goal (`mf.tour.v1`, a reload resumes at the next unticked goal) and logs every
 * step (tour.step, tour.end) and its facts through the onboarding memory (tour/index.ts).
 */
import type { SimEvent } from '@military-forge/sim';
import type { ActionId, Bindings } from '../shell/controls';
import type { Box } from '../ui/landscape';
import { Spotlight, type SpotStep, type SpotTarget } from '../ui/spotlight';
import { TOUR_COPY } from './copy';
import {
  CONFIRM_MS,
  FIRST_FLIGHT,
  FLIGHT_GOALS,
  FlightTracker,
  HELP_AFTER_MS,
  PROMOTE_UNDER_MS,
  goalView,
  markerPoint,
  nearest,
  type FlightContext,
  type FlightGoal,
  type FlightSample,
  type Marker,
  type TouchControl,
  type TouchWords,
} from './flight';
import type { TourMemory } from './index';
import type { Device, Persona, StepStatus } from './log';
import { Tour, loadTour, saveTour, type TourEvent } from './tour';

/** The range as the tour reads it. */
export interface FlightWorld {
  me: FlightSample & { id: number; grenades: number };
  /** the targets (the range's dummies) standing now */
  targets: readonly { id: number; x: number; y: number }[];
  isTarget(id: number): boolean;
}

type KeyValue = Pick<Storage, 'getItem' | 'setItem'>;

export interface FlightDeps {
  memory: TourMemory;
  storage: KeyValue | null;
  /** the range now (null while no range runs) */
  world(): FlightWorld | null;
  /** world metres → the page's logical px */
  toScreen(x: number, y: number): { x: number; y: number };
  /** the device the prompts are for now */
  device(): Device;
  /** the bindings shown for that device (a pad's codes while a pad plays) */
  bindings(): Bindings;
  /** a binding's key cap text */
  cap(code: string): string;
  touchWords(): TouchWords;
  /** where a touch control is (touch/index.ts touchControlRect), null when it isn't shown */
  touchRect(id: TouchControl): Box | null;
  /** a menu or a route covers play: the tour waits */
  covered(): boolean;
  /** "Live fire" on the finish card */
  liveFire(): void;
  /** "Later" on the finish card, or Skip training: back to Home */
  home(): void;
  clock?: () => number;
  spotlight?: Spotlight;
}

type State = 'goal' | 'confirm' | 'done' | 'over';

export class FirstFlight {
  private readonly tour: Tour<FlightContext, FlightGoal>;
  private readonly tracker = new FlightTracker();
  private readonly spot: Spotlight;
  private readonly clock: () => number;
  private state: State = 'goal';
  private started: number;
  /** the goal on screen, when it was first shown, whether its help was logged */
  private shown: { id: string; at: number; helped: boolean } | null = null;
  private confirmUntil = 0;
  /** the tracker measured from the current goal's start */
  private begun = false;
  private covered = false;
  /** the targets' side of the start (±1), for the markers */
  private toward = 1;
  /** what the callout was last drawn from (it redraws when this changes: the device, the tally) */
  private drawn = '';
  /** the whole flight's time, in seconds, for the finish card */
  private finishedIn = 0;

  constructor(private readonly d: FlightDeps) {
    this.clock = d.clock ?? (() => performance.now());
    this.spot = d.spotlight ?? new Spotlight({ phone: () => document.documentElement.classList.contains('mf-phone') });
    this.spot.onSkip = (id, all) => (id === DONE_ID ? this.leave('later') : this.skip(all));
    this.spot.onPrimary = (id) => id === DONE_ID && this.leave('live-fire');
    this.tour = new Tour(FIRST_FLIGHT, FLIGHT_GOALS, loadTour(d.storage, FIRST_FLIGHT));
    this.tour.setOpen(true);
    // a finished or skipped flight asked for again (Restart First flight, a replay) starts over
    if (this.tour.finished) this.tour.restart();
    this.save();
    this.started = this.clock();
  }

  /** where it is: the goal on screen, or 'done' (the finish card) or 'over' */
  get current(): string {
    return this.state === 'done' || this.state === 'over' ? this.state : (this.tour.step?.id ?? 'done');
  }

  /** Every frame, after the sim stepped and the camera moved. */
  frame(): void {
    if (this.state === 'over') return;
    const w = this.d.world();
    if (!w) return;
    const covered = this.d.covered();
    if (covered !== this.covered) {
      this.covered = covered;
      if (covered) void this.spot.hide();
      else this.drawn = ''; // redraw on the way back
    }
    if (covered) return;
    if (this.state === 'done') {
      if (!this.spot.current) this.showDone();
      return;
    }
    if (this.state === 'confirm') {
      if (this.clock() < this.confirmUntil) return void this.spot.update();
      this.state = 'goal';
      this.begun = false;
    }
    if (this.tour.skipImpossible(this.ctx(w))) this.save();
    if (this.tour.finished) return this.finish();
    if (!this.begun) {
      this.tracker.begin(w.me);
      const t = nearest(w.targets, w.me.x);
      this.toward = t && t.x < w.me.x ? -1 : 1;
      this.begun = true;
    }
    for (const e of this.tracker.frame(w.me)) if (this.state === 'goal') this.act(e, w);
    if (this.state === 'goal') this.draw();
    this.spot.update();
    this.offerHelp();
  }

  /** The sim's events of a frame (GameRenderer.onEvents). */
  onEvents(events: readonly SimEvent[], localId: number): void {
    if (this.state !== 'goal') return;
    const w = this.d.world();
    if (!w) return;
    for (const e of this.tracker.events(events, localId, (id) => w.isTarget(id))) if (this.state === 'goal') this.act(e, w);
  }

  /** Skip this goal, or the whole training (the callout's links, the pause menu's Skip training). */
  skip(all: boolean): void {
    if (this.state === 'over') return;
    if (this.state === 'done') return this.leave('later');
    const step = this.tour.step;
    if (step) this.logStep(step.id, 'skipped');
    if (all) {
      this.tour.skip(true);
      this.d.memory.record({ t: 'tour.end', tour: FIRST_FLIGHT, result: 'skipped-all', ms: Math.round(this.clock() - this.started) });
      this.d.memory.fact({ k: 'tour', tour: FIRST_FLIGHT, skipped: true });
      this.save();
      return this.leave('home');
    }
    this.tour.skip();
    this.save();
    this.state = 'goal';
    this.begun = false;
    this.shown = null;
    if (this.tour.finished) this.finish();
  }

  /** From the first goal again (the pause menu's Restart First flight). */
  restart(): void {
    if (this.state === 'over') return;
    this.tour.restart();
    this.tour.setOpen(true);
    this.d.memory.fact({ k: 'tour', tour: FIRST_FLIGHT, reset: true });
    this.save();
    this.state = 'goal';
    this.begun = false;
    this.shown = null;
    this.drawn = '';
    this.started = this.clock();
  }

  /** Training ended under it (the menu's Quit, a new mode): abandoned unless it was over. */
  dispose(): void {
    if (this.state === 'goal' || this.state === 'confirm') {
      const step = this.tour.step;
      if (step && this.shown?.id === step.id) this.logStep(step.id, 'abandoned');
      this.d.memory.record({ t: 'tour.end', tour: FIRST_FLIGHT, result: 'abandoned', ms: Math.round(this.clock() - this.started) });
      this.tour.setOpen(false);
      this.save();
    }
    this.state = 'over';
    if (this.d.spotlight) void this.spot.hide();
    else this.spot.dispose();
  }

  // ---- internals

  private ctx(w: FlightWorld): FlightContext {
    return { grenades: w.me.grenades };
  }

  private act(e: TourEvent, w: FlightWorld): void {
    const step = this.tour.step;
    if (!step) return;
    const before = this.tour.tally;
    if (!this.tour.act(e, this.ctx(w))) {
      if (this.tour.tally !== before) this.draw(); // 1/3, 2/3
      return;
    }
    this.logStep(step.id, 'done');
    this.d.memory.fact({ k: 'tour', tour: FIRST_FLIGHT, step: step.id });
    this.save();
    // the stamp, with the goal's pip filled; the next goal after CONFIRM_MS
    this.draw(step, true);
    this.spot.stamp(TOUR_COPY.confirmed);
    this.state = 'confirm';
    this.confirmUntil = this.clock() + CONFIRM_MS;
    this.shown = null;
  }

  private finish(): void {
    this.state = 'done';
    const ms = Math.round(this.clock() - this.started);
    this.d.memory.record({ t: 'tour.end', tour: FIRST_FLIGHT, result: 'finished', ms });
    this.d.memory.fact({ k: 'tour', tour: FIRST_FLIGHT, finished: true });
    this.tour.setOpen(false);
    this.save();
    // a quick flight (§3.3): recruit hints off, more on offer
    const facts = this.d.memory.facts.get();
    if (ms < PROMOTE_UNDER_MS && !this.tour.toJSON().skipped.length && !facts.promoted) {
      this.d.memory.fact({ k: 'promoted' });
      this.d.memory.record({ t: 'promotion', reason: 'first-flight-under-40s' });
    }
    this.finishedIn = Math.max(1, Math.round(ms / 1000));
    this.showDone();
  }

  private showDone(): void {
    const [, n] = this.tour.position;
    this.spot.show({
      id: DONE_ID,
      target: [],
      eyebrow: TOUR_COPY.orders(n, n),
      progress: [n, n],
      title: TOUR_COPY.complete,
      body: TOUR_COPY.completeBody(this.finishedIn),
      primary: { label: TOUR_COPY.liveFire },
      skipLabel: TOUR_COPY.later,
      variant: 'strip',
      place: 'top-centre',
      anchor: 'none',
      block: 'none',
      dim: 0,
    });
    this.spot.stamp(TOUR_COPY.confirmed);
  }

  private leave(how: 'live-fire' | 'later' | 'home'): void {
    if (this.state === 'over') return;
    this.state = 'over';
    void this.spot.hide();
    if (how === 'live-fire') this.d.liveFire();
    else this.d.home();
  }

  /** The current goal's callout and rings; redrawn only when what it shows changed. */
  private draw(step: FlightGoal | null = this.tour.step, ticked = false): void {
    if (!step) return;
    const device = this.d.device();
    const touch = this.d.touchWords();
    const v = goalView(step.id, device, touch);
    const b = this.d.bindings();
    const keys = v.keys.flatMap((a: ActionId) => (b[a][0] ? [this.d.cap(b[a][0])] : []));
    const count = step.count ?? 1;
    const tally = ticked ? count : this.tour.tally;
    const key = `${step.id}|${device}|${touch.moveSide}|${touch.fire}|${touch.jetButton}|${touch.dashButton}|${keys.join(' ')}|${tally}|${ticked}`;
    if (key === this.drawn) return;
    this.drawn = key;
    const [i, n] = this.tour.position;
    const at = ticked ? FLIGHT_GOALS.findIndex((g) => g.id === step.id) : i;
    const targets: SpotTarget[] = [];
    if (v.touch) {
      const control = v.touch;
      targets.push({ kind: 'rect', rect: () => this.d.touchRect(control), shape: 'circle' });
    }
    if (v.hud) targets.push({ kind: 'selector', selector: `[data-tour="${v.hud}"]` });
    if (v.marker) {
      const marker = v.marker;
      targets.push({ kind: 'world', point: () => this.markerOnScreen(marker), size: marker === 'target' ? 88 : 56 });
    }
    const body = count > 1 && tally > 0 ? `${v.body} ${TOUR_COPY.tally(tally, count)}` : v.body;
    const id = `${FIRST_FLIGHT}:${step.id}`;
    const fresh = this.shown?.id !== step.id && !ticked;
    const s: SpotStep = {
      id,
      target: targets,
      eyebrow: TOUR_COPY.orders(at + 1, n),
      progress: [ticked ? at + 1 : at, n],
      title: v.title,
      body,
      keys,
      help: v.help,
      timeoutMs: HELP_AFTER_MS,
      place: 'top-centre',
      anchor: 'none',
      block: 'none',
      variant: 'strip',
      skipAll: true,
      // the live region: the whole goal once, then only what changed (the tally)
      announce: fresh || !this.shown ? `Step ${at + 1} of ${n}. ${v.title} ${body}` : ticked ? TOUR_COPY.confirmed : TOUR_COPY.tally(tally, count),
    };
    this.spot.show(s);
    if (fresh) {
      this.shown = { id: step.id, at: this.clock(), helped: false };
      this.logStep(step.id, 'shown');
    }
  }

  private markerOnScreen(marker: Marker): { x: number; y: number } | null {
    const w = this.d.world();
    if (!w || !w.me.alive) return null;
    let p: { x: number; y: number };
    if (marker === 'target') {
      const t = nearest(w.targets, w.me.x);
      if (!t) return null;
      p = { x: t.x, y: t.y + 1 }; // the chest
    } else p = markerPoint(marker, this.tracker.origin, this.toward);
    const s = this.d.toScreen(p.x, p.y);
    return { x: s.x, y: s.y };
  }

  /** The 20 s help is the spotlight's to show; the log hears of it once. */
  private offerHelp(): void {
    const s = this.shown;
    if (!s || s.helped || this.clock() - s.at < HELP_AFTER_MS) return;
    s.helped = true;
    this.logStep(s.id, 'timeout-offered');
  }

  private logStep(step: string, status: StepStatus): void {
    const ms = this.shown?.id === step ? Math.round(this.clock() - this.shown.at) : 0;
    this.d.memory.record({ t: 'tour.step', tour: FIRST_FLIGHT, step, persona: personaOf(this.d.memory), device: this.d.device(), status, ms });
  }

  private save(): void {
    saveTour(this.d.storage, this.tour.toJSON());
  }
}

const DONE_ID = `${FIRST_FLIGHT}:done`;

function personaOf(memory: TourMemory): Persona {
  const f = memory.facts.get();
  return f.experience ?? (f.invited ? 'invited' : 'unknown');
}

/** A First flight left open by a reload (it was running when the page went): go straight back in. */
export function flightWasOpen(storage: KeyValue | null): boolean {
  const t = loadTour(storage, FIRST_FLIGHT);
  return !!t && t.open && !t.skippedAll;
}
