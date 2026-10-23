/**
 * The controller at run time: polls the Gamepad API, plays with it (the same `Input` the keyboard
 * and touch make, added in the sampler's sample like touch's), drives the menus with it (spatial
 * focus, press, back, tabs), rumbles, and listens for a button when Settings rebinds one.
 *
 * Polled once a frame (its own requestAnimationFrame) and again in every sample, so a press is seen
 * as soon as possible and a tap shorter than a tick still reaches the sim (pulses, as touch's).
 */
import { angleToU16 } from '@military-forge/shared';
import { Btn, type Input, type SimEvent } from '@military-forge/sim';
import type { Camera } from '../camera';
import { throwStrengthAt, type ThrowLatch } from '../input';
import { weapons, type MapDef } from '@military-forge/content';
import { AimAssist, onTarget, type AssistTarget } from '../input/assist';
import { Sight, sightPoints, type SightCloud } from '../input/sight';
import { wrapAngle } from '../touch/stick';
import { currentDevice, noteKeys, notePad, onInputDevice } from './device';
import { AIM_MIN_PUSH, MOVE_ZONES, createAimState, createMoveState, dashDirection, heldBits, moveStep, navRepeats, padDashStrength, padThrowStrength, reticleDistance, shapeAxes, stepAim, stickNavDirection, triggerHeld, type NavDir, type StickVector } from './mapping';
import { activate, findScroller, focusFirst, focusedIn, focusables, hasTabs, moveFocus, rememberFocus, restoreFocus, switchTab, type FocusAnchor } from './menus';
import { rumbleFor, scaleRumble, type Rumble } from './rumble';
import { DEFAULT_PAD_SETTINGS, HOLD_TAKE_MS, buttonMap, type ButtonMap, type PadSettings } from './settings';
import { AXIS, B, BUTTON_COUNT, isDualSense, padFamily } from './standard';

/** What the manager needs from the page. Only the members it uses (main.ts's sampler, or none on the Armory page). */
export interface PadHost {
  /** the keyboard sampler's pointer (the reticle and the camera's look-ahead) and its grenade latch */
  sampler?: { mouseX: number; mouseY: number; blocked?: boolean; throwLatch?: ThrowLatch } | null;
  camera?: Camera | null;
  /** the menus in front of the game (null: play) */
  menuScope(): Element | null;
  /** game screens with buttons over play (the warm-up's Ready…): a tap of Share / View reaches them */
  overlayScope?(): Element | null;
  /** Circle / B in a menu: back out (Escape in the app) */
  back(): void;
  /** Options / Menu: the in-match menu (Escape in the app) */
  pause(): void;
  /** the scoreboard button held or let go (the HUD's Tab) */
  scoreboard?(down: boolean): void;
  /** the scoreboard button double-tapped: the big map opens or closes (minimap/) */
  toggleMap?(): void;
  /** the map being played (aim assist's line of sight) */
  map?(): MapDef | null;
}

/** The frame being drawn, as far as the pad reads it (view.ts Frame). */
export interface PadFrame {
  localId: number;
  players: readonly { id: number; alive: boolean; x: number; y: number; crouched?: boolean; active?: number; weapons?: readonly { def: number }[] }[];
  clouds?: readonly SightCloud[];
}

/** Magnetism needs the aim stick pushed at least this far (raw; spec §5.4). */
export const PAD_PULL_MIN = 0.5;
/** Auto-fire (One-stick): the first shot after this long on target, and it keeps firing this long after (ms; spec §4.5). */
export const AUTO_FIRE = { dwell: 100, linger: 150 };

/** A Share / View press let go this soon is a tap (the overlay's buttons), not a look at the scoreboard. */
export const SELECT_TAP_MS = 250;
/** Two such taps this close together: the big map (minimap/). */
export const SELECT_DOUBLE_TAP_MS = 400;
/** Reticle reach smoothing per tick (the reticle glides as the stick's push changes). */
const RETICLE_EASE = 0.35;
/** Right-stick scrolling in menus: px per frame at full push. */
const SCROLL_PX = 22;
/** Stick motion older than this doesn't count toward a dash's flick (ms). */
const FLICK_WINDOW = 140;
/** Zoom-hold on the aim trigger: steps enough to reach any gun's deepest zoom (the camera clamps). */
const ZOOM_HOLD_STEPS = 8;
/** Firing rumbles this often at most (a minigun would buzz without a break). */
const SHOT_RUMBLE_GAP_MS = 70;

type Mode = 'play' | 'menu' | 'capture';

export class PadManager {
  settings: PadSettings = DEFAULT_PAD_SETTINGS;
  private reduceFlashes = false;
  private map: ButtonMap = buttonMap(DEFAULT_PAD_SETTINGS.bindings, DEFAULT_PAD_SETTINGS.holdTake);
  /** the pad that plays (the Gamepad's index), −1 none */
  private index = -1;
  private family = padFamily('');
  private dualSense = false;
  private readonly raw = new Array<number>(BUTTON_COUNT).fill(0);
  private readonly held = new Array<boolean>(BUTTON_COUNT).fill(false);
  private readonly prevHeld = new Array<boolean>(BUTTON_COUNT).fill(false);
  /** buttons still held from the menus (or the capture) when play resumed: they wait to be let go */
  private readonly suppressed = new Array<boolean>(BUTTON_COUNT).fill(false);
  private readonly downAt = new Array<number>(BUTTON_COUNT).fill(0);
  /** a held reload button already took the gun underfoot (hold to take) */
  private readonly tookOnHold = new Array<boolean>(BUTTON_COUNT).fill(false);
  private axes = [0, 0, 0, 0];
  /** the aim stick's raw push (its angle holds under AIM_MIN_PUSH) */
  private aimRaw = 0;
  private readonly moveState = createMoveState();
  private readonly aimState = createAimState();
  private readonly move: StickVector = { x: 0, y: 0, mag: 0 };
  private readonly aim: StickVector = { x: 0, y: 0, mag: 0 };
  private mode: Mode = 'play';
  /** presses since the last sample (bits): taps shorter than a tick still reach the sim */
  private pulses = 0;
  private dash: { dir: number; strength: number } | null = null;
  private wheel = 0;
  private aimAngle = 0;
  private reticle: number = reticleDistance(0.5);
  /** the pad aims (its stick moved since the mouse or a finger last did) */
  private ownsAim = false;
  /** the aim stick's last push (a held grenade with the stick resting throws by it) */
  private aimHeldMag = 0.5;
  private flick: { t: number; mag: number }[] = [];
  private nav: { dir: NavDir | null; downAt: number; lastAt: number } = { dir: null, downAt: 0, lastAt: 0 };
  /** a game overlay the pad was sent into with a Share / View tap */
  private overlay: Element | null = null;
  private scroller: { scope: Element; el: Element | null } | null = null;
  private menuFocus: FocusAnchor | null = null;
  private capture: ((button: number) => void) | null = null;
  private scoreboardDown = false;
  /** when View / Share was last tapped (a double tap opens the big map) */
  private selectTapAt = -Infinity;
  private zoomBefore: number | null = null;
  private targets: AssistTarget[] = [];
  private readonly sight = new Sight();
  private readonly assist = new AimAssist();
  /** the gun in hand's range (m; 0: none), for assist */
  private range = 0;
  /** the shoulder at the last sample (One-stick's lob reaches the target from here) */
  private shoulder: { x: number; y: number } | null = null;
  /** auto-fire: on target since (ms; null: off it), firing, and firing until (the linger) */
  private onTargetSince: number | null = null;
  private autoFiring = false;
  private lingerUntil = 0;
  /** Settings' controller check: the pad's input is only shown, not acted on, until Options ends it */
  private testing: (() => void) | null = null;
  private me: { x: number; y: number } | null = null;
  private lastShotRumble = -Infinity;
  private raf = 0;
  private readonly listeners = new Set<() => void>();
  private display: (() => void) | null = null;

  constructor(private readonly host: PadHost) {
    onInputDevice((d) => {
      if (d.kind !== 'pad') this.ownsAim = false;
      this.notify();
    });
  }

  /** Starts polling (once a pad has been seen: browsers only show pads after a button press). */
  start(): void {
    if (typeof window === 'undefined' || typeof navigator === 'undefined' || typeof navigator.getGamepads !== 'function') return;
    const loop = (now: number) => {
      this.poll(now);
      this.display?.();
      this.raf = requestAnimationFrame(loop);
    };
    const begin = () => {
      if (!this.raf) this.raf = requestAnimationFrame(loop);
    };
    window.addEventListener('gamepadconnected', begin);
    window.addEventListener('gamepaddisconnected', () => {
      this.poll(performance.now());
      this.notify();
    });
    if (this.pads().length) begin();
  }

  applySettings(settings: PadSettings, reduceFlashes: boolean): void {
    this.settings = settings;
    this.reduceFlashes = reduceFlashes;
    this.map = buttonMap(settings.bindings, settings.holdTake);
    if (!settings.enabled) {
      this.releaseAll();
      if (currentDevice().kind === 'pad') noteKeys();
    }
  }

  /** Something about the pads changed (connected, the device, a capture ended): the Settings panel re-reads. */
  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Visual controller display after polling, including on menu-only pages. */
  setDisplay(fn: () => void): void {
    this.display = fn;
  }

  private notify(): void {
    for (const fn of this.listeners) fn();
  }

  /** The connected pads (for Settings and the test page). */
  pads(): Gamepad[] {
    try {
      return Array.from(navigator.getGamepads?.() ?? []).filter((p): p is Gamepad => !!p && p.connected);
    } catch {
      return []; // a page whose permissions policy forbids gamepads
    }
  }

  /** The pad that plays now, if any. */
  get active(): Gamepad | null {
    return this.pads().find((p) => p.index === this.index) ?? null;
  }

  /** The next button pressed goes to `fn` (Settings → Controller → rebind); null cancels. */
  captureNext(fn: ((button: number) => void) | null): void {
    this.capture = fn;
    this.notify();
  }

  get capturing(): boolean {
    return this.capture !== null;
  }

  /**
   * Settings' controller check: while on, presses and sticks only show on the page (no menu moves, no
   * back); Options ends it and calls `onEnd`. Null ends it from the page.
   */
  testInput(onEnd: (() => void) | null): void {
    this.testing = onEnd;
    this.notify();
  }

  get testingInput(): boolean {
    return this.testing !== null;
  }

  // ------------------------------------------------------------------ polling

  private releaseAll(): void {
    this.held.fill(false);
    this.prevHeld.fill(false);
    this.suppressed.fill(false);
    this.pulses = 0;
    this.dash = null;
    this.move.mag = this.move.x = this.move.y = 0;
    this.aim.mag = this.aim.x = this.aim.y = 0;
    Object.assign(this.moveState, createMoveState());
    this.aimState.flipRate = 0;
    this.assist.reset();
    this.host.sampler?.throwLatch?.cancel();
    if (this.scoreboardDown) {
      this.scoreboardDown = false;
      this.host.scoreboard?.(false);
    }
  }

  /** Reads the pads (a sample right after the frame's poll finds the same state: edges fire once). */
  poll(now: number = performance.now()): void {
    if (!this.settings.enabled) return;
    const pads = this.pads();
    // the pad last used plays (two plugged in: whichever was touched)
    for (const p of pads) {
      if (p.index !== this.index && (p.buttons.some((b) => b.pressed) || p.axes.some((a) => Math.abs(a) > 0.6))) {
        this.index = p.index;
        this.family = padFamily(p.id);
        this.dualSense = isDualSense(p.id);
        this.held.fill(false);
        this.prevHeld.fill(false);
      }
    }
    let pad = pads.find((p) => p.index === this.index) ?? null;
    if (!pad && pads.length) {
      pad = pads[0]!;
      this.index = pad.index;
      this.family = padFamily(pad.id);
      this.dualSense = isDualSense(pad.id);
    }
    if (!pad) {
      if (this.index >= 0) {
        this.index = -1;
        this.releaseAll();
        if (currentDevice().kind === 'pad') noteKeys();
      }
      return;
    }
    this.read(pad);
    const s = this.settings;
    let active = false;
    for (let i = 0; i < BUTTON_COUNT; i++) {
      const b = pad.buttons[i];
      const value = b?.value ?? 0;
      const pressed = b?.pressed ?? false;
      const threshold = i === B.R2 ? s.fireThreshold : i === B.L2 ? s.aimThreshold : 0.5;
      this.held[i] = triggerHeld(value, pressed, this.held[i]!, threshold);
      if (this.held[i] && !this.prevHeld[i]) this.downAt[i] = now;
      active ||= this.held[i]!;
    }
    active ||= this.axes.some((a) => Math.abs(a) > 0.5);
    if (active) notePad(this.family, this.dualSense);

    // sticks (the left moves and the right aims, or swapped)
    const [mx, my, ax, ay] = s.swapSticks ? [this.axes[2]!, this.axes[3]!, this.axes[0]!, this.axes[1]!] : this.axes;
    shapeAxes(mx!, my!, s.moveDeadzone, 1, this.move, MOVE_ZONES.snapDeg);
    shapeAxes(ax!, s.invertY ? -ay! : ay!, s.aimDeadzone, s.aimCurve, this.aim);
    this.aimRaw = Math.hypot(ax!, ay!);
    this.flick.push({ t: now, mag: this.move.mag });
    while (this.flick.length > 1 && now - this.flick[0]!.t > FLICK_WINDOW) this.flick.shift();

    const scope = this.menuScope();
    const mode: Mode = this.capture ? 'capture' : scope ? 'menu' : 'play';
    if (mode !== this.mode) {
      // into play: what was held in the menus (the A that pressed Start) waits to be let go first
      if (mode === 'play') for (let i = 0; i < BUTTON_COUNT; i++) this.suppressed[i] = this.held[i]!;
      if (this.mode === 'play') this.leavePlay();
      this.mode = mode;
      this.nav.dir = null;
      if (mode !== 'menu') this.menuFocus = null;
      this.notify();
    }
    for (let i = 0; i < BUTTON_COUNT; i++) {
      // a held-over button let go: its release isn't a release in play (no throw, no zoom back)
      if (this.suppressed[i] && !this.held[i]) this.suppressed[i] = this.prevHeld[i] = false;
    }

    if (this.testing) {
      // the controller check: every button and stick is the player's to try; Options ends it
      if (this.pressed(B.Start)) {
        const done = this.testing;
        this.testing = null;
        this.suppressed[B.Start] = true;
        done();
        this.notify();
      }
    } else if (mode === 'capture') this.pollCapture();
    else if (mode === 'menu') this.pollMenu(scope!, now);
    else this.pollPlay(now);
    for (let i = 0; i < BUTTON_COUNT; i++) this.prevHeld[i] = this.held[i]!;
  }

  private read(pad: Gamepad): void {
    for (let i = 0; i < BUTTON_COUNT; i++) this.raw[i] = pad.buttons[i]?.value ?? 0;
    this.axes = [pad.axes[AXIS.LX] ?? 0, pad.axes[AXIS.LY] ?? 0, pad.axes[AXIS.RX] ?? 0, pad.axes[AXIS.RY] ?? 0];
  }

  private pressed(i: number): boolean {
    return this.held[i]! && !this.prevHeld[i]! && !this.suppressed[i]!;
  }

  private released(i: number): boolean {
    return !this.held[i]! && this.prevHeld[i]!;
  }

  private menuScope(): Element | null {
    if (this.overlay && (!this.overlay.isConnected || !focusables(this.overlay).length)) this.overlay = null;
    const scope = this.host.menuScope() ?? this.overlay;
    if (scope) return scope;
    // menus that block play without a screen of their own: the whole shell
    return this.host.sampler?.blocked ? (document.getElementById('shell') ?? document.body) : null;
  }

  // ------------------------------------------------------------------ capture (rebinding)

  private pollCapture(): void {
    for (let i = 0; i < BUTTON_COUNT; i++) {
      if (!this.pressed(i)) continue;
      const fn = this.capture!;
      this.capture = null;
      // the press that was bound must not also press the focused button when the menu gets the pad back
      this.suppressed[i] = true;
      fn(i);
      this.notify();
      return;
    }
  }

  // ------------------------------------------------------------------ menus

  private pollMenu(scope: Element, now: number): void {
    if (currentDevice().kind !== 'pad') {
      this.menuFocus = null;
      return;
    }
    if (!focusedIn(scope)) {
      const restored = restoreFocus(scope, this.menuFocus);
      if (!restored) focusFirst(scope);
    }
    this.menuFocus = rememberFocus(scope) ?? this.menuFocus;
    if (this.pressed(B.South)) activate(scope);
    if (this.pressed(B.East)) {
      if (this.overlay && scope === this.overlay) this.leaveOverlay();
      else this.host.back();
    }
    if (this.pressed(B.Start)) {
      if (this.overlay && scope === this.overlay) this.leaveOverlay();
      this.host.pause();
    }
    if (this.pressed(B.L1)) switchTab(scope, -1, (tab) => { this.menuFocus = rememberFocus(scope, tab); });
    if (this.pressed(B.R1)) switchTab(scope, 1, (tab) => { this.menuFocus = rememberFocus(scope, tab); });

    // the D-pad, or the left stick past half-way: focus moves (held: repeats)
    const dir: NavDir | null = this.held[B.Up] ? 'up' : this.held[B.Down] ? 'down' : this.held[B.Left] ? 'left' : this.held[B.Right] ? 'right' : stickNavDirection(this.axes[0]!, this.axes[1]!);
    if (!dir) this.nav.dir = null;
    else if (dir !== this.nav.dir) {
      this.nav = { dir, downAt: now, lastAt: now };
      moveFocus(scope, dir);
      this.menuFocus = rememberFocus(scope) ?? this.menuFocus;
    } else if (navRepeats(this.nav.downAt, this.nav.lastAt, now)) {
      this.nav.lastAt = now;
      moveFocus(scope, dir);
      this.menuFocus = rememberFocus(scope) ?? this.menuFocus;
    }

    // the right stick scrolls a long panel
    const ry = this.axes[3]!;
    if (Math.abs(ry) > 0.3) {
      if (!this.scroller || this.scroller.scope !== scope) this.scroller = { scope, el: findScroller(scope) };
      if (this.scroller.el) this.scroller.el.scrollTop += Math.sign(ry) * ((Math.abs(ry) - 0.3) / 0.7) * SCROLL_PX;
    } else this.scroller = null;
  }

  private leaveOverlay(): void {
    const el = this.overlay && focusedIn(this.overlay);
    el?.blur();
    this.overlay = null;
  }

  /** Play → menus: nothing stays held, no throw is left aimed. */
  private leavePlay(): void {
    this.pulses = 0;
    this.dash = null;
    this.host.sampler?.throwLatch?.cancel();
    if (this.scoreboardDown) {
      this.scoreboardDown = false;
      this.host.scoreboard?.(false);
    }
    // the aim trigger held into the menus: the view comes back in now (its release won't count)
    if ([...this.map.fire2].some((b) => this.held[b])) this.wheel -= ZOOM_HOLD_STEPS;
  }

  // ------------------------------------------------------------------ play

  private pollPlay(now: number): void {
    const m = this.map;
    for (let i = 0; i < BUTTON_COUNT; i++) {
      // hold to take: a reload button held HOLD_TAKE_MS takes the gun underfoot (its tap reloaded already)
      if (m.holdTake.has(i) && this.held[i] && !this.suppressed[i] && !this.tookOnHold[i] && now - this.downAt[i]! >= HOLD_TAKE_MS) {
        this.tookOnHold[i] = true;
        this.pulses |= Btn.Interact;
      }
      if (this.pressed(i)) {
        this.tookOnHold[i] = false;
        this.pulses |= m.bits[i]! & ~Btn.Grenade;
        if (m.grenade.has(i)) this.host.sampler?.throwLatch?.press(now);
        if (m.dash.has(i)) {
          const first = this.flick[0];
          const span = first ? (now - first.t) / 1000 : 0;
          const flick = span > 0 ? Math.abs(this.move.mag - first!.mag) / span : 0;
          this.dash = { dir: dashDirection(this.move), strength: padDashStrength(this.move.mag, flick) };
        }
        if (m.zoom.has(i)) this.stepZoom();
        if (m.fire2.has(i)) this.wheel += ZOOM_HOLD_STEPS;
        if (m.scoreboard.has(i) && !this.scoreboardDown) {
          this.scoreboardDown = true;
          this.host.scoreboard?.(true);
        }
        if (i === B.Start) this.host.pause();
      } else if (this.released(i)) {
        if (m.grenade.has(i)) {
          // the throw goes as hard as the aim stick says (the keyboard's sample aimed it by the mouse just before)
          const latch = this.host.sampler?.throwLatch;
          latch?.aimWith(this.throwStrength(), now);
          latch?.release(now);
        }
        if (m.fire2.has(i)) this.wheel -= ZOOM_HOLD_STEPS;
        if (m.scoreboard.has(i)) {
          if (this.scoreboardDown && ![...m.scoreboard].some((b) => this.held[b])) {
            this.scoreboardDown = false;
            this.host.scoreboard?.(false);
          }
          // a tap: the buttons on screen over play (the warm-up's Ready, the controls card's Got it);
          // a second tap soon after: the big map
          if (now - this.downAt[i]! < SELECT_TAP_MS) {
            if (now - this.selectTapAt < SELECT_DOUBLE_TAP_MS && this.host.toggleMap) {
              this.selectTapAt = -Infinity;
              this.host.toggleMap();
            } else {
              this.selectTapAt = now;
              this.enterOverlay();
            }
          }
        }
      }
    }
  }

  /** The zoom button: a level further out; when the last press changed nothing (the deepest level), back to none (as touch's). */
  private stepZoom(): void {
    const cam = this.host.camera;
    if (!cam) return;
    const z = cam.zoom;
    this.wheel += this.zoomBefore === z ? -z : 1;
    this.zoomBefore = this.zoomBefore === z ? null : z;
  }

  private enterOverlay(): void {
    const scope = this.host.overlayScope?.() ?? null;
    if (!scope) return;
    this.overlay = scope;
    focusFirst(scope);
  }

  /** A held grenade's strength: the aim stick's push, or its last push while it rests. */
  private throwStrength(): number {
    // One-stick: an auto-aimed lob, as far as the enemy the aim is on
    const t = this.settings.autoAim && this.aim.mag === 0 && this.assist.target !== null ? this.targets.find((x) => x.id === this.assist.target) : null;
    if (t && this.shoulder) return throwStrengthAt(Math.hypot(t.x - this.shoulder.x, t.y - this.shoulder.y));
    return padThrowStrength(this.aim.mag > 0 ? this.aim.mag : this.aimHeldMag);
  }

  /** Zoom steps since the last call (the zoom button and the aim trigger's hold), as wheel steps. */
  takeZoom(): number {
    const w = this.wheel;
    this.wheel = 0;
    return w;
  }

  /**
   * Adds this tick's pad input to what the keyboard, mouse and touch sampled: buttons, the aim
   * (while the pad owns it), the reticle's place, a held grenade's strength, a dash's direction and
   * strength. `(sx, sy)`: the shoulder the aim is measured from.
   */
  apply(out: Input, sx: number, sy: number, now: number = performance.now()): void {
    this.poll(now);
    if (this.index < 0 || this.mode !== 'play' || !this.settings.enabled) return;
    const s = this.settings;
    const held = this.held.map((h, i) => h && !this.suppressed[i]);
    let b = heldBits(held, this.map) | moveStep(this.moveState, this.move, s.stickJet) | this.pulses;
    if (this.dash) {
      const DIR = Btn.Left | Btn.Right | Btn.Jet | Btn.Down;
      b = (b & ~DIR) | this.dash.dir | Btn.Dash;
      // v14 (the dash agent): a dash's strength, where the Input carries it
      if ('dashStrength' in out) (out as Input & { dashStrength: number }).dashStrength = this.dash.strength;
      this.dash = null;
    }
    out.buttons |= b;
    this.pulses = 0;

    // the aim: toward the stick (only past AIM_MIN_PUSH of raw push: no wobble near the dead zone), at
    // its turn speed, a flip past 90° within 3 ticks, with the touch controls' light friction on a target
    this.shoulder = { x: sx, y: sy };
    const assist = { level: s.assist, pullMinPush: PAD_PULL_MIN, sx, sy, range: this.range, targets: this.targets };
    if (this.aim.mag > 0 && this.aimRaw >= AIM_MIN_PUSH) {
      const want = Math.atan2(this.aim.y, this.aim.x);
      if (!this.ownsAim) this.aimAngle = want;
      // a turnaround isn't slowed (or pulled back) by a target behind it
      const flipping = this.aimState.flipRate > 0 || Math.abs(wrapAngle(want - this.aimAngle)) > Math.PI / 2;
      const stepped = stepAim(this.aimAngle, want, s.aimSpeed, this.aimState);
      this.aimAngle = flipping ? stepped : this.assist.step({ ...assist, current: this.aimAngle, desired: stepped, stickAngle: want, stick: this.aimRaw });
      this.reticle += (reticleDistance(this.aim.mag) - this.reticle) * RETICLE_EASE;
      this.aimHeldMag = this.aim.mag;
      this.ownsAim = true;
    } else if (s.autoAim) {
      // One-stick: the nearest enemy in sight and range, otherwise the way the move stick points
      this.ownsAim = true;
      const aim = this.assist.step({ ...assist, level: 'strong', current: this.aimAngle, desired: this.aimAngle, stick: 0, autoAcquire: true });
      this.aimAngle = this.assist.target === null && this.move.mag > 0 ? stepAim(this.aimAngle, Math.atan2(this.move.y, this.move.x), s.aimSpeed, this.aimState) : aim;
    } else if (this.ownsAim) {
      // the stick let go: Strong holds the chosen target (the others leave the aim where it is)
      this.aimAngle = this.assist.step({ ...assist, current: this.aimAngle, desired: this.aimAngle, stick: 0 });
    }
    // auto-fire (One-stick): on an enemy for 100 ms, fire; keep firing 150 ms after he leaves the line
    if (s.autoFire && this.ownsAim && this.range > 0 && !this.host.sampler?.throwLatch?.holding) {
      if (onTarget(this.aimAngle, sx, sy, this.targets, this.range)) {
        this.onTargetSince ??= now;
        if (now - this.onTargetSince >= AUTO_FIRE.dwell) {
          this.autoFiring = true;
          this.lingerUntil = now + AUTO_FIRE.linger;
        }
      } else this.onTargetSince = null;
      if (this.autoFiring && now >= this.lingerUntil) this.autoFiring = false;
      if (this.autoFiring) out.buttons |= Btn.Fire;
    } else {
      this.onTargetSince = null;
      this.autoFiring = false;
    }
    if (this.ownsAim) {
      out.aim = angleToU16(this.aimAngle);
      const cam = this.host.camera;
      const sampler = this.host.sampler;
      if (cam && sampler) {
        sampler.mouseX = cam.toScreenX(sx + Math.cos(this.aimAngle) * this.reticle);
        sampler.mouseY = cam.toScreenY(sy + Math.sin(this.aimAngle) * this.reticle);
      }
    }
    // a held grenade: its arc follows the aim stick's push; a release throws in this very sample
    const latch = this.host.sampler?.throwLatch;
    if (latch) {
      if (latch.holding && [...this.map.grenade].some((g) => this.held[g])) latch.aimWith(this.throwStrength(), now);
      latch.take(out);
    }
  }

  // ------------------------------------------------------------------ the game's frames and events

  /** The frame drawn: the aim assist's targets and where the local player stands (blasts nearby). */
  onFrame(frame: PadFrame): void {
    this.me = null;
    this.range = 0;
    let eye: { x: number; y: number } | null = null;
    for (const p of frame.players) {
      if (p.id !== frame.localId) continue;
      this.me = { x: p.x, y: p.y };
      eye = { x: p.x, y: p.y + sightPoints(p.crouched).head };
      const def = p.weapons?.[p.active ?? 0]?.def;
      this.range = (def !== undefined && weapons[def]?.range) || 0;
    }
    // assist's targets: enemies the player can see from his eyes (no walls, no smoke between)
    this.sight.setMap(this.host.map?.());
    if (eye) this.sight.targets(frame.players, frame.localId, eye.x, eye.y, frame.clouds, this.targets);
    else this.targets.length = 0;
  }

  /** Rumble for what just happened to the local player, while a pad is the device. */
  onEvents(events: readonly SimEvent[], localId: number): void {
    if (this.index < 0 || currentDevice().kind !== 'pad' || !this.settings.vibration || this.reduceFlashes) return;
    let r = rumbleFor(events, localId, this.me);
    const now = performance.now();
    if (r?.kind === 'shot') {
      // a minigun: not more often than SHOT_RUMBLE_GAP_MS
      if (now - this.lastShotRumble < SHOT_RUMBLE_GAP_MS) r = null;
      else this.lastShotRumble = now;
    }
    this.rumble(scaleRumble(r, this.settings.vibrationStrength));
  }

  /** Plays a rumble on the active pad, where the browser can (Chrome, Edge: dual-rumble; Firefox: a pulse). */
  rumble(r: Rumble | null, pad: Gamepad | null = this.active): void {
    if (!r || !pad) return;
    const act = (pad as Gamepad & { vibrationActuator?: { playEffect?(type: string, p: object): Promise<unknown> } }).vibrationActuator;
    if (act?.playEffect) {
      act.playEffect('dual-rumble', { startDelay: 0, duration: r.ms, strongMagnitude: r.strong, weakMagnitude: r.weak }).catch(() => {});
      return;
    }
    const haptic = (pad as Gamepad & { hapticActuators?: { pulse?(v: number, ms: number): Promise<unknown> }[] }).hapticActuators?.[0];
    haptic?.pulse?.(Math.max(r.strong, r.weak), r.ms)?.catch(() => {});
  }

  /** The pad can rumble in this browser. */
  canRumble(pad: Gamepad | null = this.active): boolean {
    if (!pad) return false;
    const p = pad as Gamepad & { vibrationActuator?: unknown; hapticActuators?: unknown[] };
    return !!p.vibrationActuator || !!p.hapticActuators?.length;
  }

  /** For the Settings panel and the hint bar: in a menu now, and whether that menu has tabs. */
  get state(): { mode: Mode; tabs: boolean; overlay: boolean; family: string; connected: boolean } {
    const scope = this.mode === 'menu' ? this.menuScope() : null;
    return { mode: this.mode, tabs: !!scope && hasTabs(scope), overlay: !!this.host.overlayScope?.(), family: this.family, connected: this.index >= 0 };
  }

  /** Dev builds and the test page: the raw reading and what it maps to. */
  debugState(): { index: number; family: string; held: boolean[]; raw: number[]; axes: number[]; move: StickVector; aim: StickVector; mode: Mode; ownsAim: boolean } {
    return { index: this.index, family: this.family, held: [...this.held], raw: [...this.raw], axes: [...this.axes], move: { ...this.move }, aim: { ...this.aim }, mode: this.mode, ownsAim: this.ownsAim };
  }
}
