/**
 * The hints at play (tour/hints.ts is the engine): fed the sim's events and the local player each frame
 * in a match, it shows a hint the engine allows as a non-blocking spotlight (no dim; a ring on the HUD
 * plate it's about) for 7 s, or until the player does the thing. "Don't show tips" turns them off for
 * good. Quiet while First flight runs, under menus, and outside a match. Logs hint.shown and hint.acted.
 */
import { MatchPhase, type SimEvent } from '@military-forge/sim';
import type { ActionId, Bindings } from '../shell/controls';
import type { ShellStore } from '../shell/store';
import { Spotlight } from '../ui/spotlight';
import type { Box } from '../ui/landscape';
import { HINT_SHOW_MS, HintEngine, TOUCH_HINTS, loadHintMemory, saveHintMemory, type HintDef, type HintId, type TouchHintId } from './hints';
import type { TourMemory } from './index';
import { deathCause } from './track';

type KeyValue = Pick<Storage, 'getItem' | 'setItem'>;

export interface HintDeps {
  memory: TourMemory;
  storage: KeyValue | null;
  store: ShellStore;
  bindings(): Bindings;
  cap(code: string): string;
  /** First flight runs, or a menu covers play: no hints */
  quiet(): boolean;
  clock?: () => number;
  spotlight?: Spotlight;
  /**
   * The touch controls (on phones): which gesture hints are possible now, and a control's box to ring
   * (touch/index.ts). Absent or null: no touch hints.
   */
  touch?: {
    possible(): readonly TouchHintId[];
    rect(control: string): Box | null;
    /** the touch controls are what the player plays with now: no key caps, the touch words */
    active?(): boolean;
  } | null;
}

export class HintRunner {
  readonly engine: HintEngine;
  private readonly spot: Spotlight;
  private readonly clock: () => number;
  private showing: { def: HintDef; at: number } | null = null;
  private alive = false;
  private outOfFuel = false;
  private phase: number | undefined;

  constructor(private readonly d: HintDeps) {
    this.clock = d.clock ?? (() => performance.now());
    this.engine = new HintEngine(loadHintMemory(d.storage));
    this.spot = d.spotlight ?? new Spotlight({ phone: () => document.documentElement.classList.contains('mf-phone') });
    this.spot.onSkip = () => {
      // "Don't show tips"
      this.engine.memory.off = true;
      saveHintMemory(this.d.storage, this.engine.memory);
      this.hide();
    };
  }

  /** A move was done (a sim event here, or a touch gesture: main.ts relays them): its hint goes. */
  done(id: HintId): void {
    this.did(id);
  }

  /**
   * Hints learnt before they lived here (the touch controls' own "seen" list) count as shown; and
   * "Show hints again" (Settings → Touch) clears the touch ones.
   */
  seenBefore(ids: readonly string[]): void {
    let changed = false;
    for (const id of TOUCH_HINTS)
      if (ids.includes(id) && this.engine.memory.counts[id] === undefined) {
        this.engine.memory.counts[id] = 1;
        changed = true;
      }
    if (changed) saveHintMemory(this.d.storage, this.engine.memory);
  }

  resetTouch(): void {
    for (const id of TOUCH_HINTS) delete this.engine.memory.counts[id];
    saveHintMemory(this.d.storage, this.engine.memory);
  }

  private t(): number {
    return this.clock() / 1000;
  }

  onEvents(events: readonly SimEvent[], me: number): void {
    for (const e of events) {
      if (e.type === 'hit' && (e.target === me || e.attacker === me) && e.attacker !== e.target) this.engine.damage(this.t());
      else if (e.type === 'death' && e.victim === me) this.engine.death(deathCause(e));
      else if (e.type === 'dash' && e.player === me) this.did('dash');
      else if (e.type === 'throw' && e.owner === me) {
        this.did('grenade');
        this.did('own-grenade');
      }
    }
  }

  /** Each frame: the local player now (null: none), after the sim stepped. */
  frame(me: { alive: boolean; grounded: boolean; fuel: number } | null): void {
    this.watchMatch();
    const t = this.t();
    if (me?.alive && !this.alive) this.engine.spawn(t);
    this.alive = !!me?.alive;
    const out = !!me && me.alive && !me.grounded && me.fuel <= 0;
    if (out && !this.outOfFuel) this.engine.fuelOut();
    this.outOfFuel = out;
    if (this.showing) {
      if (this.clock() - this.showing.at > HINT_SHOW_MS || this.d.quiet()) this.hide();
      else this.spot.update();
      return;
    }
    if (this.d.quiet() || this.phase !== MatchPhase.InProgress) return;
    this.engine.offer(this.d.touch?.possible() ?? []);
    const def = this.engine.next(t);
    if (def) this.show(def);
  }

  dispose(): void {
    this.spot.dispose();
  }

  private watchMatch(): void {
    const phase = this.d.store.getState().match?.phase;
    if (phase === this.phase) return;
    if (phase === MatchPhase.InProgress) {
      this.engine.matchStart(this.d.memory.facts.get());
      // GO counts as a spawn: no tip over the first 5 s of the fight (the GO banner, the first moves)
      if (this.alive) this.engine.spawn(this.t());
    }
    this.engine.setCountdown(phase === MatchPhase.Countdown);
    this.phase = phase;
  }

  private did(id: HintId): void {
    this.engine.used(id);
    if (this.showing?.def.id === id) {
      this.d.memory.record({ t: 'hint.acted', hint: id, secs: Math.round((this.clock() - this.showing.at) / 100) / 10 });
      this.hide();
    }
  }

  private show(def: HintDef): void {
    saveHintMemory(this.d.storage, this.engine.memory);
    this.showing = { def, at: this.clock() };
    this.d.memory.record({ t: 'hint.shown', hint: def.id });
    const b = this.d.bindings();
    const touch = this.d.touch;
    const onTouch = !!touch?.active?.();
    // on touch: no key caps (a phone has no Shift), and the words for the dials (#259: a flick dashes)
    const keys = onTouch ? [] : def.keys.flatMap((a: ActionId) => (b[a][0] ? [this.d.cap(b[a][0])] : []));
    const body = onTouch ? (TOUCH_BODY[def.id] ?? def.body) : def.body;
    const control = def.control ?? (onTouch ? TOUCH_RING[def.id] : undefined);
    this.spot.show({
      id: `hint:${def.id}`,
      // a touch hint rings its control (as First flight does); the rest, their HUD plate
      target: control && touch ? { kind: 'rect', rect: () => touch.rect(control), shape: 'circle' } : def.hud ? { kind: 'selector', selector: `[data-tour="${def.hud}"]` } : [],
      eyebrow: 'Tip',
      title: def.title,
      body,
      keys,
      block: 'none',
      dim: 0,
      place: 'top-centre',
      anchor: 'none',
      skipLabel: "Don't show tips",
      variant: 'strip',
    });
  }

  private hide(): void {
    this.showing = null;
    void this.spot.hide();
  }
}

/** The keyboard hints' words on touch (the dials have no keys to show). */
const TOUCH_BODY: Partial<Record<HintId, string>> = {
  dash: 'Flick the move stick. Dodges fire.',
  grenade: 'Tap the grenade button. Hold it to aim.',
  'own-grenade': 'Hold the grenade button: the arc shows where it lands.',
};
/** …and the control they ring there */
const TOUCH_RING: Partial<Record<HintId, string>> = { dash: 'move', grenade: 'grenade', 'own-grenade': 'grenade' };
