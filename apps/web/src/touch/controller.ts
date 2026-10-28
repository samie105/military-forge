/**
 * The touch HUD (loaded only where it's used): two floating thumb dials and the buttons, drawn as a
 * DOM layer over the game (under the shell's screens), turned into an `Input` once per sim tick. The
 * controls wear the owner's round-two kit (skin.ts: the HP/fuel dial, the ammo dial, the dial
 * buttons, the swap pill, the take button) and move by its motion system (fx.ts, the shared tokens).
 *
 * - Touch and pen only: a mouse (a tablet with a keyboard and mouse) keeps working on the canvas.
 *   Every touch on the game is claimed here, so none turns into mouse clicks or browser gestures.
 * - A thumb anywhere on its half of the screen grabs that stick there (big hit areas); the buttons
 *   sit above the halves.
 * - The HUD editor (the layout bay, editor/bay.ts) drags (snapping to guides) and pinches each control
 *   here; its bar, cards, tray and bases are the bay's. The layout is saved on this device as fractions
 *   of the safe box, and no target is under 48 px.
 */
import { angleToU16 } from '@military-forge/shared';
import { Btn, type Input, type SimEvent } from '@military-forge/sim';
import type { Camera } from '../camera';
import { TAP_MS, type ThrowLatch } from '../input';
import { NO_WEAPON, weapons, type MapDef } from '@military-forge/content';
import type { Frame } from '../view';
import { enterLandscape, logicalPoint, logicalRect, type Box } from '../ui/landscape';
import { BackToPause, WakeLockKeeper, canVibrate, inEdgeBand } from './platform';
import { cross, drawIn, glideHome, growIn, settleNow, shrinkOut, stamp } from './fx';
import { GESTURE, beltAfter, beltOf, beltSteps, cyclePresses, dashButtons, isQuickSwipe, radialAngles, radialPickOnPage, radialSpots, type Vec } from './gestures';
import { TouchOverlays, type RadialItem } from './overlays';
import { CHAIN_MS, Drill, drillControl, loadSeen, markDrillSeen, possibleHints, saveSeen, type TouchAction } from './teach';
import {
  CONTEXT_BY_PRESET,
  SOMETIMES,
  offHud,
  PILLS,
  PINNABLE,
  SHIELD_BIT,
  availableControls,
  placementFor,
  saveLayout,
  sizePx,
  snapPlacement,
  withPinned,
  withPlacement,
  withoutMoves,
  type ControlDef,
  type ControlId,
  type Placement,
  type TouchLayout,
} from './layout';
import { autoView, PRESET_SETTINGS, VIEW_LIMITS, type FireMode, type KeyValueStore as Store, type PresetId, type TouchSettings } from './settings';
import { AutoTrigger, FIRE_FIXED, LAND_ARM, TOUCH_PULL_MIN, assistPush, autoRange, createTouchState, dashStrength, desiredAim, effectiveFire, flickRate, grenadeStrength, landSettled, pullFires, touchButtons, updateMove } from './mapping';
import { AimAssist, onTarget as onAutoTarget, type AssistLevel, type AssistTarget } from '../input/assist';
import { Sight, sightPoints } from '../input/sight';
import { EquipClock, SKIN_BASE, TouchSkin, controlValues, localView, phoneTokens, skinHtml, type LocalView } from './skin';
import { iconHref, weaponIcon } from '../ui/icons';
import { AIM_FIXED, AIM_STICK, FIXED_GRAB, FLICK, GRENADE_STICK, MOVE_FIXED, MOVE_STICK, followOrigin, isFixedFlick, isFlick, knobOffset, moveButtons, shapeStick, zeroStick, type StickVector } from './stick';
import { FadeClock, cueLit, nearControls, type FadeControl } from './fade';
import { diag } from '../diag/log';
import { LayoutBay, type BayHost } from './editor/bay';
import './touch.css';

/** Where the reticle (and the camera's look-ahead) sits along the touch aim, in metres. */
const RETICLE_M = 7;
/** The first-run "How do you want to shoot?" card (§4.10.1): off; Auto is the default. */
const FIRST_RUN_CHOOSER = false;
/**
 * On touch, how far the view runs past the map's edge (shares of the half view; Camera.edgeOverrun):
 * enough that a soldier at the very edge stands left of the aim dial's column (it spans 74–90 % of a
 * phone's width) or right of the move dial's, never under a thumb (the mobile audit, P0-2: its 30 %
 * still left him in the dial's column). Past the edge there's nothing the server would have to send.
 */
export const TOUCH_EDGE_OVERRUN = { x: 0.55, down: 0.25 } as const;
/** The grenade button's drag reaches full strength this many button radii out. */
const GRENADE_REACH = 2.4;
/** Without a HUD feeding values (the dev client), the controls draw what they read from the frame alone. */
const HUD_STALE_MS = 250;
/**
 * A grab whose finger has gone quiet this long, after its events lost their way (the element it
 * started on left the page, or the browser took its capture), is let go: WebKit can drop a pointerup
 * then, and the stick would push forever (QA, 23 Oct: qa-bullets-lag-touch.md §3 M). A new thumb on
 * a stick that quiet takes it over. (A thumb resting still sends nothing either, so quiet alone never
 * lets go.)
 */
const STALE_MS = 1000;
/**
 * Keep aiming after a button (§4.6): the right thumb lifted off the aim stick this recently, and
 * pressed a button since, lands back with the same aim and push (and in Pull, still firing).
 */
const RESUME_MS = 700;
/** The dash button with the move stick idle decides this soon (or at a swipe's 22 px), not at the lift (§4.6). */
const DASH_DECIDE_MS = 90;
/**
 * DASH by the left thumb (Classic, 25 Oct): the thumb hops off the move stick to tap it, so a tap within
 * `ms` of the stick letting go dashes the way the stick read `lookBackMs` before the lift (the hop's own
 * wobble doesn't count), not the way the soldier faces.
 */
const DASH_CARRY = { ms: 300, lookBackMs: 60 } as const;
/** A second finger on a stick's side pinches the camera only this far from the first (20 mm), with the first still in its dead zone (§4.6). */
const PINCH_MIN_PX = 120;
/** Controls only in play some of the time: the take button near a crate, zoom with a gun that zooms. */
/** Melee comes into the context slot with an enemy this close (m; spec §4.2). */
const MELEE_REACH = 2.5;
/** Reload comes into the context slot with the magazine this low (its share; spec §4.2). */
const RELOAD_SHOWS_AT = 0.4;
/** The aim stick's "Aim to shoot" tag was learned (the first real aim) this visit: it stays off across matches. */
let aimTagLearned = false;

type Grab =
  // a stick: (cx, cy) is its origin. Follow thumb: exactly where the thumb landed (§4.3; it follows a
  // thumb past 1.2 radii), the base drawn there, clamped inside the safe box. Fixed (`fixed`, the
  // default): the base stays where it's drawn; a thumb landing within FIXED_GRAB radii reads from its
  // drawn centre (`centred`), one further out from where it landed. For the flick test: the peak push,
  // when it was reached and from when (the last moment under 0.3), where the thumb landed (x0, y0),
  // whether it has moved off that point, and its last few points. For a fixed aim stick's landing
  // (LAND_ARM): when it landed and last moved, on the page's clock (apply() runs between events)
  | { kind: 'stick'; id: 'move' | 'aim'; cx: number; cy: number; radius: number; fixed: boolean; centred: boolean; x0: number; y0: number; ox: number; oy: number; moved: boolean; landedAt: number; movedAt: number; startAt: number; peak: number; peakDir: number; peakAt: number; lowAt: number; riseFrom: number; lastMag: number; lastAt: number; trail: { t: number; x: number; y: number }[]; dx: number; dy: number }
  | { kind: 'grenade'; cx: number; cy: number; radius: number; downAt: number; x0: number; y0: number; mode: 'pending' | 'aim' | 'cycle'; steps: number; moving?: boolean }
  | { kind: 'button'; def: ControlDef }
  // Fire button mode's FIRE (§4.4): the trigger held while it's down; on the right one, a drag from it
  // aims too (a floating stick from where the thumb landed), unless a thumb is already on the aim stick
  | { kind: 'fire'; def: ControlDef; aim: { cx: number; cy: number; radius: number } | null; tap?: boolean }
  // v3 gestures (gestures.ts): the gun pill (tap/swipe: swap, hold: the radial), the dash button (a
  // swipe picks the way), the shield (hold: raised while held)
  | { kind: 'swap'; downAt: number; x0: number; y0: number; done: boolean; radial: boolean; pick: number; items: RadialItem[]; spots: Vec[]; dead: number }
  | { kind: 'dash'; downAt: number; x0: number; y0: number; fired: boolean }
  | { kind: 'shield'; downAt: number; raised: boolean }
  // two fingers on one side of the screen: the camera (pinch: zoom, a double two-finger tap: recentre)
  | { kind: 'camera'; other: number; startDist: number; startView: number; pinched: boolean; downAt: number; moved: boolean; starts: [Vec, Vec] }
  | { kind: 'edit'; id: ControlId; dx: number; dy: number }
  | { kind: 'pinch'; id: ControlId; startDist: number; startSize: number; other: number };

/** What the controller needs from the game: the keyboard sampler's fields it shares and the camera. */
export interface TouchHost {
  /** the sampler's screen-space pointer: the reticle and the camera's look-ahead read it */
  mouseX: number;
  mouseY: number;
  readonly camera: Camera;
  /** the sampler's grenade throw latch (input.ts), shared with the G key; null on a sampler without one */
  readonly throwLatch: ThrowLatch | null;
  /** menus are open (the shell blocks input): the controls hide and leave touches to the menus */
  blocked(): boolean;
  /** the room's tuning dashFlickFull (a full-strength flick, deflections a second; docs/02 §21) */
  dashFlickFull(): number;
  /** the map being played (Auto fire's line of sight, input/sight.ts) */
  map?(): MapDef | null;
  /** a game is running (the app's title, home and other screens without one: false); absent: always */
  inGame?(): boolean;
}

/** The part of a frame the controls read (render's frame: view.ts Frame). */
export type TouchFrame = Pick<Frame, 'localId' | 'players' | 'pickups' | 'clouds'>;

export class TouchController {
  readonly root: HTMLDivElement;
  private readonly safe: HTMLDivElement;
  /** the HUD editor's panels (editor/bay.ts): this controller keeps the drag, snap and pinch */
  private readonly bay: LayoutBay;
  private readonly guides: { x: HTMLDivElement; y: HTMLDivElement };
  private readonly els = new Map<ControlId, HTMLDivElement>();
  private readonly knobs = new Map<'move' | 'aim', HTMLElement>();
  /** each control's size on screen (px) and its skin's zoom, from the last place() */
  private readonly sizes = new Map<ControlId, { px: number; k: number }>();
  private readonly grabs = new Map<number, Grab>();
  /** Auto-fade (fade.ts): when each control was last woken, and the classes as last set */
  private readonly fade = new FadeClock<ControlId>();
  private readonly awake = new Set<ControlId>();
  private beltTotal = -1;
  /** the context slot's inputs (onFrame): an enemy within MELEE_REACH, the magazine at RELOAD_SHOWS_AT or less */
  private enemyNear = false;
  private lowMag = false;
  /** the safe box's size (px), from the last place(): the mm anchors are laid out in it */
  private box = { w: 724, h: 344 };
  /** each grab's finger: when it last sent anything, the element it started on, whether its capture was lost */
  private readonly grabSeen = new Map<number, { at: number; from: Element | null; lost: boolean }>();
  /** fingers down in the editor (a second one on the screen pinches the control the first drags) */
  private readonly pointers = new Map<number, { x: number; y: number }>();
  /**
   * Thumbs that landed on the game while the controls stood aside (the death cam: spectate.css), where
   * they are now. The hidden layout can't say which stick a thumb means, so it waits; when the controls
   * come back (the respawn) a thumb still down takes its stick from there (the owner, 27 Oct: "I can't
   * hold the joystick up to fly": a thumb put down on the death cam was read as the aim stick, and stayed
   * it after the respawn until it was lifted).
   *
   * A thumb on a screen over the game (the results, the lobby between rounds) waits too, its touch the
   * screen's meanwhile (a tap, a scroll); once the screen has gone from under it and play is on, it
   * takes its stick (the owner, 27 Oct: "fix the lobby one too": a thumb held from the results was
   * nobody's after the next GO). `client`: where it is on the page, for what lies under it now.
   */
  private readonly waiting = new Map<number, { x: number; y: number; client?: { x: number; y: number } }>();
  /** a thumb that landed on a screen: its touchmove listener there (that screen's node may leave the page) */
  private readonly screenHolds = new Map<number, () => void>();
  private readonly state = createTouchState();
  /** the local player is alive (the frame's; the hints possible now need it) */
  private aliveNow = false;
  /** enemies in sight (no wall, no smoke between: input/sight.ts), for Auto fire and the aim assist */
  private readonly visible: AssistTarget[] = [];
  /** the shared aim assist core (input/assist.ts; the pad has its own): its sticky target and Strong's lock */
  private readonly aimAssist = new AimAssist();
  private readonly sight = new Sight();
  private readonly autoTrigger = new AutoTrigger();
  /** the gun in hand (its class, fire mode and range decide the fire mode it uses: effectiveFire) */
  private weaponDef: (typeof weapons)[number] | undefined;
  /** the fire mode this moment: the player's, or Release for a precision gun (effectiveFire) */
  private fireNow: FireMode = 'auto';
  /** where the last sample aimed from (the shoulder, world m): the dev hook's, for the checks */
  private readonly shoulder = { x: 0, y: 0 };
  private readonly skin: TouchSkin;
  private readonly equip = new EquipClock();
  private local: LocalView = { values: {}, tokens: [] };
  private localExtra = { equip: 1, slung: false };
  /** a swap between the two guns began this frame: the swap pill's guns cross */
  private swapping = false;
  private hudValues: Readonly<Record<string, string>> = {};
  private hudTokens: readonly string[] = [];
  private hudAt = -Infinity;
  private tokensBefore = new Set<string>();
  /** context controls on screen now (take, zoom), and those waiting for a thumb to lift before leaving */
  private readonly shown = new Set<ControlId>();
  private readonly leaveOnLift = new Set<ControlId>();
  private aimAngle = 0;
  private touchOwnsAim = true;
  private active = false;
  private hiddenForMenus = false;
  /** a game is running under the controls (host.inGame): the page's zoom lock needs one */
  private inGame = true;
  private editing = false;
  private selected: ControlId | null = null;
  private zoomSteps = 0;
  private zoomBefore: number | null = null;
  private lastBuzz = 0;
  /** the screen kept on while playing (asked for from a tap) */
  private readonly wake = new WakeLockKeeper();
  /** Android's back gesture opens the pause menu while playing (CloseWatcher) */
  private readonly back = new BackToPause(() => this.openPause());
  /** full screen was left during play: the next tap in play goes back to it */
  private refullscreen = false;
  /** when a finger last touched: mouse events right after are the browser's emulation, not a mouse */
  private lastTouchAt = -Infinity;
  private raf = 0;
  private savedViewport: string | null = null;
  private readonly cleanups: (() => void)[] = [];
  // ---- v3: gestures, teaching, the camera (touch-controls-v3.md) ----
  private readonly overlays: TouchOverlays;
  /** the controls' nominal centres in the safe box (place()): the fan, the radial and the hints sit by them */
  private readonly centres = new Map<ControlId, Vec>();
  /** the grenade belt: the types carried (the sim's cycle order), where the one in hand sits, the counts */
  private belt: { types: number[]; at: number; counts: readonly number[] } = { types: [], at: 0, counts: [] };
  private shieldNow: 'front' | 'back' | 'raising' | undefined;
  private guns = { held: NO_WEAPON as number, slung: NO_WEAPON as number, alive: false };
  /** CycleGrenade presses still to send: one every other sample (the sim cycles on each press's edge) */
  private cycleQueue = 0;
  private cycleGap = false;
  private lastDashAt = -Infinity;
  private lastTwoTapAt = -Infinity;
  /** first-time hints already shown on this phone (teach.ts) */
  private readonly seen: Set<string>;
  private drill: Drill | null = null;
  private drillWanted = false;
  private teachTarget: ControlId | null = null;
  /** listeners for what the player does (dev builds' checks; the drill and hints use it inside) */
  private readonly actionListeners = new Set<(a: TouchAction) => void>();

  constructor(
    private readonly host: TouchHost,
    private settings: TouchSettings,
    private layout: TouchLayout,
    private readonly store: Store | null,
    private readonly onSettingsEdited: (patch: Partial<TouchSettings>) => void,
    editButton: boolean,
  ) {
    this.root = div('mf kit-v2 mf-touch', document.body);
    this.root.hidden = true;
    this.safe = div('mf-touch-safe', this.root);
    this.guides = { x: div('mf-guide mf-guide--x', this.safe), y: div('mf-guide mf-guide--y', this.safe) };
    for (const def of availableControls()) this.build(def);
    if (editButton) {
      const edit = div('mf-ctl mf-touch-edit', this.safe);
      edit.innerHTML = `<span class="mf-skin dial-btn dial-btn--sm"><svg class="ic ic--sm" aria-hidden="true"><use href="#icon-edit"/></svg></span>`;
      edit.title = 'Edit the touch controls';
      edit.setAttribute('role', 'button');
      edit.setAttribute('aria-label', 'Edit the touch controls');
      edit.dataset.mfEdit = '';
    }
    this.skin = new TouchSkin(this.root);
    this.bay = new LayoutBay(this.bayHost());
    this.overlays = new TouchOverlays(
      this.safe,
      () => this.drillSkip(),
      () => this.drillClose(),
    );
    this.seen = loadSeen(store);
    // a phone with few cores or little memory: the solid fill from the start (watchGlass catches the rest)
    const nav = navigator as Navigator & { deviceMemory?: number };
    if ((nav.hardwareConcurrency ?? 8) <= 2 || (nav.deviceMemory ?? 8) <= 2) document.documentElement.classList.add('mf-glass-off');

    const on = <K extends keyof WindowEventMap>(type: K, fn: (e: WindowEventMap[K]) => void, opts?: AddEventListenerOptions) => {
      window.addEventListener(type, fn, opts);
      this.cleanups.push(() => window.removeEventListener(type, fn, opts));
    };
    on(
      'pointerdown',
      (e) => {
        this.onDown(e);
        if (this.grabs.has(e.pointerId)) this.grabSeen.set(e.pointerId, { at: e.timeStamp, from: e.target as Element | null, lost: false });
        this.wakeNear(e);
      },
      { capture: true, passive: false },
    );
    on(
      'pointermove',
      (e) => {
        const seen = this.grabSeen.get(e.pointerId);
        if (seen) {
          seen.at = e.timeStamp;
          seen.lost = false;
        }
        this.onMove(e);
      },
      { capture: true, passive: false },
    );
    on('pointerup', (e) => this.onUp(e), { capture: true });
    on('pointercancel', (e) => this.onUp(e), { capture: true });
    // the browser took a grab's capture without a pointerup (its element left the page): the watchdog
    // in frame() lets it go once it has been quiet for STALE_MS
    on('lostpointercapture', (e) => {
      const seen = this.grabSeen.get(e.pointerId);
      if (seen && this.grabs.has(e.pointerId)) seen.lost = true;
    }, { capture: true });
    // a real mouse takes the aim back (tablets with a mouse); emulated mouse events from a touch don't
    on('mousemove', (e) => {
      const emulated = (e as MouseEvent & { sourceCapabilities?: { firesTouchEvents?: boolean } }).sourceCapabilities?.firesTouchEvents;
      if (!emulated && e.timeStamp - this.lastTouchAt > 800) this.touchOwnsAim = false;
    });
    on('resize', () => {
      this.place();
      // turned, or a new window size: the auto view follows
      if (this.active) this.host.camera.viewScale = this.viewNow();
    });
    on('blur', () => this.releaseAll());
    // no pinch zoom, long-press menu or rubber-band scrolling while playing
    const stop = (e: Event) => {
      if (this.playing || this.editing) e.preventDefault();
    };
    for (const type of ['gesturestart', 'gesturechange', 'contextmenu', 'dblclick'] as const) on(type as keyof WindowEventMap, stop, { passive: false });
    // a drag that started on a screen over the game (the lobby, its match rules, the results) scrolls it
    // (the owner, 27 Oct: "you can't scroll down… for every other section too")
    on('touchmove', (e) => {
      if (this.editing || (this.playing && !onScreenOverGame(e.target))) e.preventDefault();
    }, { passive: false });
    // iOS edge swipes (back and forward) start within 24 px of a physical side edge: not while playing
    // (§4.9.1). Pointer events still arrive; only the browser's own gesture (and synthetic clicks) go
    on('touchstart', (e) => {
      if (this.playing && [...(e as TouchEvent).changedTouches].some((t) => inEdgeBand(t.clientX, innerWidth))) e.preventDefault();
    }, { passive: false });
    // full screen left during play (a swipe from the edge, the back gesture): pause; the next tap in
    // play goes back to full screen
    const fs = () => {
      if (document.fullscreenElement || !this.playing || !this.inGame) return;
      this.refullscreen = true;
      this.openPause();
    };
    document.addEventListener('fullscreenchange', fs);
    this.cleanups.push(() => document.removeEventListener('fullscreenchange', fs));
    const vis = () => {
      if (document.hidden) this.releaseAll();
      else this.wake.visible();
    };
    document.addEventListener('visibilitychange', vis);
    this.cleanups.push(() => document.removeEventListener('visibilitychange', vis));
  }

  /** Controls on screen and in play (not hidden behind the menus or the editor). */
  private get playing(): boolean {
    return this.active && !this.hiddenForMenus && !this.editing && !this.choosing;
  }

  /** The first-run fire chooser is up (the controls wait under it). */
  private choosing = false;
  /** when the log last said the stick asked to fly while the controls weren't playing */
  private idleJetAt = -Infinity;
  /** A match's countdown or clock runs: no card may open over it (mobile audit P0-3) */
  private matchLive = false;

  get isChoosing(): boolean {
    return this.choosing;
  }

  /**
   * The countdown or the clock runs (main.ts, from the match phase). The first-run chooser never opens
   * then, and one already up steps away unanswered: it asks again in the warm-up, the range or the lobby.
   */
  setMatchLive(live: boolean): void {
    if (live === this.matchLive) return;
    this.matchLive = live;
    if (live && this.choosing) {
      this.choosing = false;
      this.overlays.hideChooser();
      this.syncPlaying();
    }
  }

  /** Once, before the first play on this device (or after a reset): "How do you want to shoot?" (§4.10.1). */
  private maybeChoose(): void {
    // no first-run card (the owner, 23 Oct: a stranger shouldn't have to understand fire modes before
    // playing): Auto it is; the choice lives in Settings → Touch and the HUD editor
    if (!FIRST_RUN_CHOOSER) return;
    if (this.matchLive || !this.inGame || this.choosing || this.settings.fireChosen || !this.active || this.hiddenForMenus || this.editing) return;
    this.choosing = true;
    this.releaseAll();
    this.syncPlaying();
    this.overlays.showChooser(this.settings.fire, (fire) => {
      this.choosing = false;
      this.onSettingsEdited({ fire, fireChosen: true });
      this.syncPlaying();
    });
  }

  setActive(on: boolean): void {
    if (on === this.active) return;
    this.active = on;
    this.root.hidden = !on;
    document.documentElement.toggleAttribute('data-touch-controls', on);
    this.syncPlaying();
    if (on) {
      this.touchOwnsAim = true;
      this.host.camera.lookAhead = this.settings.lookAhead ? 1 : 0;
      this.host.camera.viewScale = this.viewNow();
      // the soldier never slides under a thumb at the map's edge (the mobile audit, P0-2)
      this.host.camera.edgeOverrun = { x: TOUCH_EDGE_OVERRUN.x, down: TOUCH_EDGE_OVERRUN.down };
      // the controls come up lit, then fade once left alone
      this.fade.wakeAll(this.els.keys(), performance.now());
      this.place();
      this.raf = requestAnimationFrame(this.frame);
    } else {
      cancelAnimationFrame(this.raf);
      this.releaseAll();
      this.setEditing(false);
      this.host.camera.lookAhead = 1;
      this.host.camera.viewScale = 1;
      this.host.camera.edgeOverrun = { x: 0, down: 0 };
      this.host.camera.soldierBand = null;
      this.overlays.clear();
      document.documentElement.removeAttribute('data-touch-crate');
    }
  }

  get isActive(): boolean {
    return this.active;
  }

  applySettings(settings: TouchSettings, layout?: TouchLayout): void {
    this.settings = settings;
    // the fire mode was picked elsewhere (Settings) while the first-run card was up: it goes
    if (this.choosing && settings.fireChosen) {
      this.choosing = false;
      this.overlays.hideChooser();
      this.syncPlaying();
    }
    if (this.active) {
      this.host.camera.lookAhead = settings.lookAhead ? 1 : 0;
      this.host.camera.viewScale = this.viewNow();
    }
    if (layout) this.layout = layout;
    // a preset changes what's on the HUD (Classic's reload and JET, Claw's dash)
    this.refreshContext(this.tokensBefore);
    this.place();
    this.syncEditor();
  }

  // ---------- once per sim tick ----------

  /** Adds this tick's touch input to what the keyboard and mouse sampled. */
  apply(out: Input, sx: number, sy: number): void {
    if (!this.playing) return;
    const s = this.state;
    // a scrub on the grenade belt: the sim cycles one type per press, so one press every other sample
    if (this.cycleQueue > 0) {
      if (!this.cycleGap) {
        s.pulses |= Btn.CycleGrenade;
        this.cycleQueue--;
      }
      this.cycleGap = !this.cycleGap;
    }
    this.shoulder.x = sx;
    this.shoulder.y = sy;
    // the fire mode for the gun in hand; Auto's trigger; Release's charged guns (held while aiming)
    this.fireNow = effectiveFire(this.settings.fire, this.weaponDef, this.settings.precisionRelease);
    s.autoFiring = this.fireNow === 'auto' && this.touchOwnsAim && this.autoTrigger.step(onAutoTarget(this.aimAngle, sx, sy, this.visible, autoRange(this.weaponDef)), performance.now());
    if (this.fireNow !== 'auto') this.autoTrigger.reset();
    s.chargeHold = this.fireNow === 'release' && this.weaponDef?.fireMode === 'charge' && s.aimActive && s.aim.mag > 0;
    // a fixed aim stick that landed past its fire line fires once the landing has settled (LAND_ARM)
    if (!s.aimArmed) {
      const g = this.aimGrab();
      const now = performance.now();
      if (!g || landSettled(now - g.landedAt, inSpeed(g, now))) this.setArmed(true);
    }
    this.modeClass();
    const buttons = touchButtons(s, this.fireNow);
    out.buttons |= buttons;
    // a dash from the stick goes as hard as the stick was pushed (the keyboard's is always full)
    if (s.pulses & Btn.Dash) out.dashStrength = s.dashStrength;
    // what the player did, for the drill and the hints (reported once per sample, not per frame)
    if (s.moveActive && Math.abs(s.move.x) >= 0.5) this.act('move');
    if (buttons & Btn.Jet) this.act('jet');
    if (buttons & Btn.Fire) this.act('fire');
    const want = desiredAim(s);
    if (want !== null && s.grenadeActive) {
      // a grenade's arc goes exactly where its stick points: no assist on throws
      this.aimAngle = want;
      this.touchOwnsAim = true;
    } else if (want === null && this.touchOwnsAim && this.settings.preset === 'oneThumb') {
      // One-thumb assist: the aim finds the nearest enemy in sight and range by itself (Strong's lock,
      // acquiring), else it follows the way you move; a drag on the right takes over (the branch below)
      const aim = this.aimAssist.step({ level: 'strong', current: this.aimAngle, desired: this.aimAngle, stick: 0, pullMinPush: TOUCH_PULL_MIN, sx, sy, range: this.weaponDef?.range ?? 0, targets: this.visible, autoAcquire: true });
      this.aimAngle = this.aimAssist.target === null && s.moveActive && Math.abs(s.move.x) >= 0.3 ? (s.move.x > 0 ? 0 : Math.PI) : aim;
    } else if (want !== null || this.touchOwnsAim) {
      // the assist level (§4.5): friction while the stick turns the aim, magnetism while it's pushed
      // (or while Auto fires), Strong's lock with it let go. The mouse never gets any of it.
      this.aimAngle = this.aimAssist.step({
        level: this.settings.assist,
        current: this.aimAngle,
        desired: want ?? this.aimAngle,
        stick: assistPush(s),
        pullMinPush: TOUCH_PULL_MIN,
        sx,
        sy,
        range: this.weaponDef?.range ?? 0,
        targets: this.visible,
      });
      if (want !== null) this.touchOwnsAim = true;
    }
    if (this.touchOwnsAim) {
      out.aim = angleToU16(this.aimAngle);
      // the reticle and the camera's look-ahead follow the touch aim
      const cam = this.host.camera;
      this.host.mouseX = cam.toScreenX(sx + Math.cos(this.aimAngle) * RETICLE_M);
      this.host.mouseY = cam.toScreenY(sy + Math.sin(this.aimAngle) * RETICLE_M);
    }
    // a held grenade button aims with the right stick (or its own drag): its push is the strength
    if (s.grenadeActive) this.host.throwLatch?.aimWith(grenadeStrength(s), performance.now());
    s.pulses = 0;
    s.dashDir = 0;
    s.dashStrength = 7;
  }

  /** Zoom-button presses since the last call, as wheel steps (the last level wraps back to none). */
  takeZoom(): number {
    const z = this.zoomSteps;
    this.zoomSteps = 0;
    return z;
  }

  /** The frame being drawn: the aim assist's targets, and what the controls show from it (the grenade, the crate, the equip clock). */
  onFrame(frame: TouchFrame): void {
    if (!this.active) return;
    this.local = localView(frame);
    const me = frame.players.find((p) => p.id === frame.localId);
    const def = me?.weapons[me.active]?.def ?? -1;
    // the context slot: an enemy in melee reach, a magazine running low
    this.enemyNear = !!me?.alive && frame.players.some((p) => p.alive && p.id !== frame.localId && Math.hypot(p.x - me.x, p.y - me.y) <= MELEE_REACH);
    const held = me?.weapons[me.active];
    const magSize = def >= 0 ? (weapons[def]?.mag ?? 0) : 0;
    this.lowMag = !!me?.alive && magSize > 0 && held !== undefined && held.mag / magSize <= RELOAD_SHOWS_AT;
    this.weaponDef = def >= 0 ? weapons[def] : undefined;
    // Auto fire's and the aim assist's targets: enemies the player can see from his eyes (the sim's sight rule)
    if (me?.alive && (this.settings.fire === 'auto' || this.settings.assist !== 'off')) {
      this.sight.setMap(this.host.map?.());
      this.sight.targets(frame.players, frame.localId, me.x, me.y + sightPoints(me.crouched).head, frame.clouds, this.visible);
    } else this.visible.length = 0;
    const other = me?.weapons.find((_, i) => i !== me.active);
    this.localExtra = {
      equip: me?.alive ? this.equip.update(me.active, def, performance.now()) : 1,
      slung: !!other && other.def !== NO_WEAPON && !me?.dual,
    };
    if (this.equip.swapped) this.swapping = true;
    // v3: the belt (the grenade fan), the shield (its hold), the guns (the radial), the hints
    const counts = me?.grenadeCounts ?? [];
    this.belt = { ...beltOf(counts, me?.grenadeType ?? 0), counts };
    // a grenade became ready (picked up, or the belt refilled): the button lights up (Auto-fade)
    const total = counts.reduce((a, b) => a + b, 0);
    if (this.beltTotal >= 0 && total > this.beltTotal) this.fade.wake('grenade', performance.now());
    this.beltTotal = total;
    this.shieldNow = me?.shield;
    this.guns = { held: def, slung: other?.def ?? NO_WEAPON, alive: !!me?.alive };
    this.teachTick(me?.alive ?? false);
    // no HUD feeding values (the dev client): draw from the frame alone
    if (performance.now() - this.hudAt > HUD_STALE_MS) this.draw();
  }

  /** The HUD's values and state tokens for this frame (hud.ts → feedTouchHud). */
  feed(values: Readonly<Record<string, string>>, tokens: readonly string[]): void {
    this.hudValues = values;
    this.hudTokens = tokens;
    this.hudAt = performance.now();
    if (this.active) this.draw();
  }

  /** The sim's events: a chained dash (the drill), and a buzz when we're hit or killed (if wanted and allowed). */
  onEvents(events: readonly SimEvent[], localId: number): void {
    // the sim says when a dash chained onto the last (v14's chain window): the drill's "Chain" goal
    if (this.active)
      for (const e of events) {
        if (e.type === 'dash' && e.player === localId && (e.chain ?? 0) > 0) this.act('chain');
        // our riot shield broke: a stamp by its button (the button and its HP ring go with it)
        if (e.type === 'shieldBreak' && e.owner === localId) {
          const c = this.centres.get('shield') ?? this.centres.get('melee');
          if (c) this.overlays.showCue('Shield broken', '#icon-shield', c, (this.sizes.get('shield')?.px ?? 52) / 2);
          this.buzz(40);
        }
      }
    if (!this.active || !this.settings.vibrate || !('vibrate' in navigator)) return;
    let ms = 0;
    for (const e of events) {
      if (e.type === 'hit' && e.target === localId && e.attacker !== localId) ms = Math.max(ms, 22);
      else if (e.type === 'death' && e.victim === localId) ms = 90;
    }
    const now = performance.now();
    if (ms && now - this.lastBuzz > 70) {
      this.lastBuzz = now;
      navigator.vibrate(ms);
    }
  }

  // ---------- drawing ----------

  /** Values and states into the skins; the moments that move (ready ticks, the take button, the dials drawing in). */
  private draw(): void {
    const aim = this.host.throwLatch?.aim ?? -1;
    const values = controlValues(this.hudValues, this.local, { throwAim: aim, equip: this.localExtra.equip });
    // the editor shows the take button where it will be, before any crate offers a gun
    if (this.editing && values['touch.take.verb'] === undefined) Object.assign(values, { 'touch.take.verb': 'Take', 'touch.take.name': 'a gun', 'touch.take.icon': '#icon-crate' });
    const heldIcon = (values['player.slot.0.icon'] ?? '') !== '';
    const slungIcon = (values['player.slot.1.icon'] ?? '') !== '';
    const tokens = phoneTokens(this.hudTokens, this.local.tokens, { equip: this.localExtra.equip, aiming: aim >= 0, heldIcon, slungIcon, slung: this.localExtra.slung });
    // a swap: the two guns' boxes before the icons change, so they can cross to their new places
    const guns = this.swapping ? this.swapGuns() : null;
    this.swapping = false;
    const was = guns?.map((g) => logicalRect(g));
    this.skin.update(values, tokens);
    // (the pill stays put under a tapping thumb; only the guns inside it move)
    if (guns && was) cross(guns[0], guns[1], was[0]!, was[1]!, this.equip.ms);
    this.moments(new Set(tokens));
  }

  /** The swap pill's held and slung gun icons (null when it shows only one). */
  private swapGuns(): [Element, Element] | null {
    const pill = this.els.get('swap');
    const held = pill?.querySelector('.pt-swap__held .mf-gun');
    const back = pill?.querySelector('.pt-swap__back .mf-gun');
    return held && back && !back.closest('[hidden]') ? [held, back] : null;
  }

  /** What happens on a token's edge: P7 ticks when the dash or a reload is ready, the dials' draw-in, context controls. */
  private moments(now: Set<string>): void {
    const was = this.tokensBefore;
    const fell = (t: string) => was.has(t) && !now.has(t);
    const rose = (t: string) => !was.has(t) && now.has(t);
    const skinOf = (id: ControlId) => this.els.get(id)?.querySelector<HTMLElement>('.mf-skin') ?? null;
    if (fell('dash-cooldown')) this.tick(skinOf('dash'));
    if (fell('reloading') && now.has('alive')) this.tick(skinOf('reload'));
    if (rose('match') || (rose('alive') && now.has('match'))) drawIn(this.root);
    this.refreshContext(now);
    // the phone HUD's pickup line steps aside while the take button offers the crate's gun (hud/phone.css)
    document.documentElement.toggleAttribute('data-touch-crate', now.has('near-crate'));
    this.tokensBefore = now;
  }

  /** A P7 tick on a button: not under a thumb that's holding it (it would be hidden anyway). */
  private tick(el: HTMLElement | null): void {
    if (el && !el.closest('.mf-down')) stamp(el, 1.12);
  }

  /** A control that's only in play sometimes comes in (grows) and goes (shrinks); in the editor it always shows. */
  /**
   * The context slot (spec §4.2): one control at a time, the most urgent in play (CONTEXT_PRIORITY):
   * Take with a gun underfoot, melee with an enemy within 2.5 m, the shield while one's carried,
   * reload with the magazine at 40 % or less, zoom with a scoped gun. A control the player pinned to
   * the HUD (the editor) has its own place instead, and next grenade only shows pinned. In the editor
   * the slot shows Take, where it will be.
   */
  private refreshContext(tokens: ReadonlySet<string>): void {
    const pinned = new Set(this.layout.pinned ?? []);
    const inPlay: Partial<Record<ControlId, boolean>> = {
      take: tokens.has('near-crate'),
      melee: this.enemyNear,
      shield: this.canShield(),
      reload: this.lowMag,
      zoom: tokens.has('zoomable'),
      cycleGrenade: true,
      dash: true,
    };
    const preset = this.settings.preset;
    const slot = this.editing ? 'take' : (CONTEXT_BY_PRESET[preset].find((id) => !pinned.has(id) && inPlay[id]) ?? null);
    const comes = offHud(preset);
    for (const id of SOMETIMES) {
      // on this preset's HUD all the time (Classic's reload, Claw's dash)
      if (!comes.has(id)) {
        this.context(id, true, false);
        continue;
      }
      const want = pinned.has(id) ? this.editing || (id === 'zoom' || id === 'shield' ? !!inPlay[id] : true) : slot === id;
      this.context(id, want, false);
    }
  }

  private context(id: ControlId, on: boolean, editAll = true): void {
    const el = this.els.get(id);
    if (!el) return;
    const want = on || (editAll && this.editing);
    if (want === this.shown.has(id)) {
      if (want) this.leaveOnLift.delete(id);
      return;
    }
    if (want) {
      this.shown.add(id);
      this.leaveOnLift.delete(id);
      el.classList.remove('mf-off');
      if (!this.editing) growIn(el);
      return;
    }
    // nothing animates under a thumb that holds the control: it goes once the thumb lifts
    if (el.classList.contains('mf-down')) {
      this.leaveOnLift.add(id);
      return;
    }
    this.shown.delete(id);
    shrinkOut(el, () => {
      if (!this.shown.has(id)) el.classList.add('mf-off');
    });
  }

  // ---------- pointers ----------

  private readonly frame = () => {
    const game = this.host.inGame?.() ?? true;
    if (game !== this.inGame) {
      this.inGame = game;
      this.syncPlaying();
    }
    const hide = this.host.blocked();
    if (hide !== this.hiddenForMenus) {
      this.hiddenForMenus = hide;
      this.root.classList.toggle('mf-touch-menus', hide);
      if (hide) this.releaseAll();
      this.syncPlaying();
    }
    // the chooser belongs to play: out of a game or under the menus it steps away, unanswered
    if (this.choosing && (!this.inGame || this.hiddenForMenus)) {
      this.choosing = false;
      this.overlays.hideChooser();
      this.syncPlaying();
    }
    this.maybeChoose();
    if (this.waiting.size && this.playing && this.onScreen()) this.takeWaiting();
    // the stick asks to fly while the controls don't play (under the menus, the editor…): the log says so
    if (!this.playing && this.state.moveBits & Btn.Jet && this.moveGrab() && performance.now() - this.idleJetAt > 10_000) {
      this.idleJetAt = performance.now();
      diag('input', `touch: the stick asks to fly but the controls aren't playing: ${this.snapshot()}`);
    }
    this.reapStale(performance.now());
    this.fadeTick(performance.now());
    // large text (Settings → Accessibility, 125 % and up): the pills drop their extra words (touch.css)
    const scale = Number(document.documentElement.style.getPropertyValue('--text-scale')) || 1;
    if (scale >= 1.25 !== this.root.classList.contains('mf-text-lg')) this.root.classList.toggle('mf-text-lg', scale >= 1.25);
    this.watchGlass();
    this.raf = requestAnimationFrame(this.frame);
  };

  /**
   * The page's touch-action follows play at once (html[data-touch-playing]: touch.css), not a frame
   * later: a finger landing in between, or a phone turning with a thumb down, would otherwise start a
   * browser scroll that takes the touch from the stick (QA, 23 Oct: §3 L).
   */
  private syncPlaying(): void {
    document.documentElement.toggleAttribute('data-touch-playing', this.playing);
    // outside a match (the menus, Home) the controls are neither reachable nor read out: inert and
    // hidden from screen readers (audit 28 Oct); the HUD editor works on them anywhere
    const exposed = this.editing || (this.active && this.inGame && !this.hiddenForMenus);
    this.root.inert = !exposed;
    if (exposed) this.root.removeAttribute('aria-hidden');
    else this.root.setAttribute('aria-hidden', 'true');
    // no pinch zoom only over a game (the editor and the first-run card included): the title and every
    // menu keep the browser's zoom (WCAG 1.4.4; the web-quality audit, 23 Oct)
    this.setViewport(this.active && this.inGame && !this.hiddenForMenus);
    // out of play: the back gesture and the screen are the browser's again (in play, a tap claims them: onDown)
    if (!(this.playing && this.inGame)) {
      this.back.arm(false);
      this.wake.want(false);
    }
  }

  /** The pause menu, as the menu button opens it (the Escape key). */
  private openPause(): void {
    // what the controls held the moment the player paused (a report sent from this menu carries it:
    // the owner, 24 Oct, "flying doesn't work until someone pauses and unpauses")
    diag('input', `touch at pause: ${this.snapshot()}`);
    this.releaseAll();
    key('keydown', 'Escape');
    key('keyup', 'Escape');
  }

  /** A touch in play: the screen stays on, a back gesture pauses, and full screen comes back if it was left (§4.9). */
  private claimPlatform(): void {
    if (!this.playing || !this.inGame) return;
    this.wake.want(true);
    this.back.arm(true);
    if (this.refullscreen) {
      this.refullscreen = false;
      void enterLandscape();
    }
  }

  /** Lets a grab go as if its finger had been dragged off (no tap, no throw, no release-to-fire). */
  private letGo(pointerId: number, at: number): void {
    const g = this.grabs.get(pointerId);
    this.grabSeen.delete(pointerId);
    this.pointers.delete(pointerId);
    if (!g) return;
    if (g.kind === 'camera') {
      this.endCamera(pointerId, g, at);
      return;
    }
    this.grabs.delete(pointerId);
    this.release(g, at, false);
  }

  /** The watchdog: a grab whose events lost their way and that has been quiet for STALE_MS goes. */
  private reapStale(now: number): void {
    for (const [id, seen] of this.grabSeen) {
      if (!this.grabs.has(id)) {
        this.grabSeen.delete(id);
        continue;
      }
      const lostWay = seen.lost || (seen.from !== null && !seen.from.isConnected);
      if (lostWay && now - seen.at >= STALE_MS) this.letGo(id, now);
    }
  }

  /**
   * Auto-fade: a touch lights up the controls under it and near it (a thumb heading there), and the
   * stick it grabbed. Not while the controls are behind the menus or in the editor.
   */
  private wakeNear(e: PointerEvent): void {
    if (!this.playing || !this.settings.autoFade) return;
    const now = performance.now();
    const at = logicalPoint(e);
    const rect = logicalRect(this.safe);
    const controls = new Map<ControlId, FadeControl>();
    for (const [id, c] of this.centres) {
      if (this.els.get(id)?.classList.contains('mf-off')) continue;
      controls.set(id, { x: rect.left + c.x, y: rect.top + c.y, r: (this.sizes.get(id)?.px ?? 52) / 2 });
    }
    for (const id of nearControls(at.x, at.y, controls)) this.fade.wake(id, now);
    const g = this.grabs.get(e.pointerId);
    if (g?.kind === 'stick') this.fade.wake(g.id, now);
  }

  /**
   * Auto-fade, once a frame: a control is lit while a thumb holds it, for AUTO_FADE_MS after it was
   * woken, or while a critical cue says so (fade.ts cueLit); the rest sit at the Button fade level.
   * One class per control, set only when it changes (touch.css does the fading: opacity, no layout).
   */
  private fadeTick(now: number): void {
    const on = this.settings.autoFade && this.active;
    if (on !== this.root.classList.contains('mf-autofade')) this.root.classList.toggle('mf-autofade', on);
    if (!on) return;
    for (const [id, el] of this.els) {
      const lit = this.editing || el.classList.contains('mf-down') || this.fade.lit(id, now) || cueLit(id, this.tokensBefore);
      if (lit === this.awake.has(id)) continue;
      if (lit) this.awake.add(id);
      else this.awake.delete(id);
      el.classList.toggle('mf-awake', lit);
    }
  }

  private glassAt = 0;
  private slowFrames = 0;

  /**
   * Frosted glass costs a blur per control each frame: a phone that can't keep up (frames past 24 ms,
   * held for about two seconds of play) gets the solid fill instead, for the session (html.mf-glass-off).
   */
  private watchGlass(): void {
    const html = document.documentElement;
    const now = performance.now();
    const dt = now - this.glassAt;
    this.glassAt = now;
    if (!this.playing || html.classList.contains('mf-glass-off') || dt > 250) return;
    this.slowFrames = dt > 24 ? this.slowFrames + 1 : Math.max(0, this.slowFrames - 1);
    if (this.slowFrames > 90) html.classList.add('mf-glass-off');
  }

  private onDown(e: PointerEvent): void {
    // the editor opens over the menus too (Settings on Home): its touches count there
    if (!this.active || (this.hiddenForMenus && !this.editing)) return;
    const target = e.target as Element | null;
    // a mouse only uses the on-screen buttons; on the game it keeps aiming and firing as usual
    if (e.pointerType === 'mouse' && !target?.closest('[data-mf-control], [data-mf-edit], .mf-bay-ui, .mf-bay-back')) return;
    if (e.pointerType !== 'mouse') {
      this.lastTouchAt = e.timeStamp;
      this.claimPlatform();
    }
    if (this.editing) {
      if (!target?.closest('.mf-bay-ui')) this.editDown(e, target);
      return;
    }
    const ctl = target?.closest<HTMLElement>('[data-mf-control]');
    if (target?.closest('[data-mf-edit]')) {
      e.preventDefault();
      this.setEditing(true);
      return;
    }
    if (ctl && !ctl.classList.contains('mf-off')) {
      e.preventDefault();
      this.pressControl(e, ctl.dataset.mfControl as ControlId, ctl);
      return;
    }
    // a screen over the game (the results, the lobby): its touch; a thumb held there waits for the game
    if (e.pointerType === 'touch' && onScreenOverGame(target) && !target!.closest('input, textarea, select, [contenteditable]')) {
      this.holdOnScreen(e, target!);
      return;
    }
    // a button over the game (the drill's Skip and Close): a tap for it, not a stick
    if (target?.closest('button, a[href], [role="button"]')) return;
    // the game itself (either canvas, or nothing but the page): a stick for that half of the screen
    if (!onGame(target)) return;
    e.preventDefault(); // no mouse emulation, no scrolling, no text selection
    // the controls stand aside (the death cam): the world takes the drag, and the thumb waits for its stick
    if (!this.onScreen()) {
      this.waiting.set(e.pointerId, logicalPoint(e));
      return;
    }
    this.grabStick(e.pointerId, logicalPoint(e), e.timeStamp, e);
  }

  /**
   * A thumb landed on a screen over the game: it waits (takeWaiting), and once that screen has left the
   * page under it the browser never scrolls it (its touchmoves go to the node that left, not the window).
   */
  private holdOnScreen(e: PointerEvent, target: Element): void {
    this.waiting.set(e.pointerId, { ...logicalPoint(e), client: { x: e.clientX, y: e.clientY } });
    const block = (t: Event) => {
      if (!target.isConnected && this.playing) t.preventDefault();
    };
    target.addEventListener('touchmove', block, { passive: false });
    this.screenHolds.get(e.pointerId)?.();
    this.screenHolds.set(e.pointerId, () => target.removeEventListener('touchmove', block));
  }

  /** The controls are on screen (not stood aside for the death cam: their safe box has a size). */
  private onScreen(): boolean {
    return this.safe.getClientRects().length > 0;
  }

  /**
   * The controls are back (the respawn), or a screen left (the results, the lobby): each thumb that
   * waited and is still down takes its stick where it is now, a thumb on a screen once the game is under it.
   */
  private takeWaiting(): void {
    const now = performance.now();
    for (const [id, at] of this.waiting) {
      if (at.client && !onGame(document.elementFromPoint(at.client.x, at.client.y))) continue;
      this.waiting.delete(id);
      this.grabStick(id, at, now, null);
      if (this.grabs.has(id)) this.grabSeen.set(id, { at: now, from: null, lost: false });
    }
  }

  /**
   * A thumb on the game (`at`: the page's own coordinates, ui/landscape.ts: an upright phone plays
   * turned onto its side) takes the stick for its half of the screen. `e`: the touch's pointerdown, or
   * null for a thumb that waited (takeWaiting: it never fires Claw's tap or starts a pinch).
   */
  private grabStick(pointerId: number, at: { x: number; y: number }, timeStamp: number, e: PointerEvent | null): void {
    const rect = logicalRect(this.safe);
    const leftHalf = at.x < rect.left + rect.width / 2;
    const id = leftHalf === (this.settings.handed === 'right') ? 'move' : 'aim';
    const same = [...this.grabs.entries()].find(([, g]) => g.kind === 'stick' && g.id === id) as [number, Extract<Grab, { kind: 'stick' }>] | undefined;
    if (same && e && id === 'aim' && this.settings.tapFire) {
      // Claw: an extra finger on empty aim-side space fires while it's down ("tap anywhere to fire";
      // no pinch on this side then: a still thumb plus a finger is how claw players shoot)
      const fire = availableControls().find((c) => c.id === 'fire');
      if (fire) {
        this.pressFire(e, fire, true);
        return;
      }
    }
    if (same) {
      if (!e) return;
      // a second finger on the same side: the camera (pinch to zoom, two-finger taps) only when it lands
      // soon, well apart (20 mm), and the first thumb hasn't moved; otherwise a stray finger (a claw
      // grip's) never takes a thumb's stick away (§4.6). A fixed stick's thumb is pushing from the
      // landing on, so "still" there is not having moved off where it landed
      const first = this.pointers.get(same[0]);
      const still = same[1].fixed ? !same[1].moved : same[1].peak === 0;
      if (this.settings.pinchZoom && still && timeStamp - same[1].startAt <= GESTURE.pinchMs && (!first || Math.hypot(at.x - first.x, at.y - first.y) >= PINCH_MIN_PX)) {
        this.startCamera(same[0], same[1], pointerId, at, timeStamp);
        return;
      }
      // one thumb per stick, unless the old grab's finger has gone quiet: its lift may never come
      // (WebKit), and a new thumb on the dial means the old one is gone
      if (timeStamp - (this.grabSeen.get(same[0])?.at ?? timeStamp) < STALE_MS) return;
      this.letGo(same[0], timeStamp);
    }
    const el = this.els.get(id)!;
    const radius = (this.sizes.get(id)?.px ?? 96) / 2;
    // Follow thumb: the origin is exactly where the thumb landed, never clamped: a thumb near an edge
    // starts at rest (§4.3, problem 1). Fixed: the drawn centre, for a thumb landing on or near the dial
    // (FIXED_GRAB), so the landing already pushes; a thumb that missed by more reads from where it
    // landed, by its drag, and the dial still stays put. Back on the aim stick soon after a button, it
    // carries on where it left off (a fixed stick from its centre: the thumb's place is the aim).
    const fixed = this.stickFixed(id);
    const home = this.centres.get(id);
    const centred = fixed && !!home && Math.hypot(at.x - (rect.left + home.x), at.y - (rect.top + home.y)) <= FIXED_GRAB * radius;
    let cx = centred ? rect.left + home!.x : at.x;
    let cy = centred ? rect.top + home!.y : at.y;
    const back = id === 'aim' ? this.resumeAim(timeStamp) : null;
    if (back) {
      if (!centred) {
        cx = at.x - back.dx;
        cy = at.y - back.dy;
      }
      this.state.aimFire = back.firing;
    }
    settleNow(el);
    if (!fixed) this.drawBase(el, cx, cy, radius, rect);
    el.classList.add('mf-down');
    const grab: Grab = { kind: 'stick', id, cx, cy, radius, fixed, centred, x0: at.x, y0: at.y, ox: at.x, oy: at.y, moved: false, landedAt: performance.now(), movedAt: performance.now(), startAt: timeStamp, peak: 0, peakDir: 0, peakAt: timeStamp, lowAt: timeStamp, riseFrom: timeStamp, lastMag: 0, lastAt: timeStamp, trail: [{ t: timeStamp, x: at.x, y: at.y }], dx: 0, dy: 0 };
    this.grabs.set(pointerId, grab);
    this.pointers.set(pointerId, at);
    // a fixed aim stick landing past the fire line aims at once, and fires once the landing settles
    // (LAND_ARM; apply()); one that lands inside it fires as soon as a drag takes it past
    if (id === 'aim') this.state.aimArmed = true;
    this.moveStick(id, at.x - cx, at.y - cy, grab, timeStamp);
    if (id === 'aim' && centred && !back && this.state.aim.mag >= FIRE_FIXED.on) this.setArmed(false);
  }

  /**
   * Does this stick stay where it's drawn (settings.sticks 'fixed')? The aim stick only where its dial
   * is drawn at rest: not One-thumb's (it comes up under a drag) nor Fire button mode's (FIRE sits on
   * its rest and the dial hides there), which keep following the thumb.
   */
  private stickFixed(id: 'move' | 'aim'): boolean {
    if (this.settings.sticks !== 'fixed') return false;
    return id === 'move' || (this.settings.preset !== 'oneThumb' && this.settings.fire !== 'button');
  }

  /** The aim stick may fire (or not, while a fixed stick's landing settles): the dial's fire ring follows. */
  private setArmed(on: boolean): void {
    const s = this.state;
    s.aimArmed = on;
    this.els.get('aim')?.classList.toggle('mf-fire', this.fireNow === 'pull' && s.aimFire && on && !s.grenadeActive);
  }

  /** The aim stick's grab, while a thumb is on it. */
  private aimGrab(): Extract<Grab, { kind: 'stick' }> | null {
    for (const g of this.grabs.values()) if (g.kind === 'stick' && g.id === 'aim') return g;
    return null;
  }

  /** The dial's base, drawn at the origin but kept inside the safe box (the knob shows the true push). */
  private drawBase(el: HTMLElement, cx: number, cy: number, radius: number, rect = logicalRect(this.safe)): void {
    el.style.left = `${clamp(cx, rect.left + radius, rect.right - radius) - rect.left}px`;
    el.style.top = `${clamp(cy, rect.top + radius, rect.bottom - radius) - rect.top}px`;
  }

  /** The left thumb's last lift from the move stick, and the way the stick was going then (DASH_CARRY). */
  private moveLift: { at: number; bits: number } | null = null;

  /** The way a dash tapped now goes without a swipe: the move stick's, if it let go just now (DASH_CARRY), else none (the way you face). */
  private carriedDash(now: number): number {
    const l = this.moveLift;
    return l && now - l.at <= DASH_CARRY.ms ? l.bits : 0;
  }

  /** The right thumb's last lift from the aim stick: the offset and fire it carries back (§4.6). */
  private aimLift: { at: number; dx: number; dy: number; firing: boolean; button: boolean } | null = null;

  /** Coming back to aim soon after a button: the aim's last offset and fire, or null for a fresh start. */
  private resumeAim(now: number): { dx: number; dy: number; firing: boolean } | null {
    const l = this.aimLift;
    this.aimLift = null;
    if (!l || !l.button || !this.settings.keepAim || this.fireNow === 'release' || now - l.at > RESUME_MS) return null;
    return { dx: l.dx, dy: l.dy, firing: this.fireNow === 'pull' && l.firing };
  }

  private pressControl(e: PointerEvent, id: ControlId, el: HTMLElement): void {
    const def = availableControls().find((c) => c.id === id);
    if (!def) return;
    // a hop from the aim stick to a button: the next landing on aim carries on (resumeAim)
    if (this.aimLift && e.timeStamp - this.aimLift.at <= RESUME_MS) this.aimLift.button = true;
    el.classList.add('mf-down'); // P8: pressed in this frame
    const s = this.state;
    if (def.kind === 'drag') {
      const r = logicalRect(el);
      s.grenadeActive = true;
      // tap: a quick throw on release; hold: the arc, thrown on release (the throw latch)
      if (this.host.throwLatch) this.host.throwLatch.press(performance.now());
      else s.pulses |= def.bit;
      Object.assign(s.grenade, zeroStick());
      const at = logicalPoint(e);
      // v3: a quick swipe ↑/↓ changes the type instead (onMove decides within GESTURE.swipeMs)
      this.grabs.set(e.pointerId, { kind: 'grenade', cx: r.left + r.width / 2, cy: r.top + r.height / 2, radius: (r.width / 2) * GRENADE_REACH, downAt: e.timeStamp, x0: at.x, y0: at.y, mode: this.settings.gestures ? 'pending' : 'aim', steps: 0 });
      return;
    }
    if (this.settings.gestures && this.pressGesture(e, def, el)) return;
    if (def.id === 'fire' || def.id === 'fireLeft') {
      this.pressFire(e, def);
      return;
    }
    this.grabs.set(e.pointerId, { kind: 'button', def });
    if (def.bit) {
      s.held |= def.bit;
      s.pulses |= def.bit;
      if (def.bit === Btn.Dash) {
        s.dashDir = s.moveActive ? moveButtons(s.move) : this.carriedDash(e.timeStamp);
        const stick = this.moveGrab();
        s.dashStrength = s.moveActive && stick ? dashStrength(s.move.mag, flickRate(stick.peak, stick.startAt, stick.peakAt), this.host.dashFlickFull()) : 7;
        this.dashed(false);
      }
    }
    this.pressAction(def.id);
    if (def.id === 'zoom') {
      // +1 a level; when the last press changed nothing (the deepest zoom), back to none
      const z = this.host.camera.zoom;
      this.zoomSteps += this.zoomBefore === z ? -z : 1;
      this.zoomBefore = this.zoomBefore === z ? null : z;
    }
    if (def.key) key('keydown', def.key);
    if (def.key === 'Escape') key('keyup', def.key); // a tap opens the menu; the scoreboard is held
  }

  private onMove(e: PointerEvent): void {
    if (e.pointerType !== 'mouse') this.lastTouchAt = e.timeStamp;
    const waiting = this.waiting.get(e.pointerId);
    if (waiting) {
      Object.assign(waiting, logicalPoint(e));
      if (waiting.client) waiting.client = { x: e.clientX, y: e.clientY };
      return;
    }
    const g = this.grabs.get(e.pointerId);
    if (!g) {
      // a pinch's second finger moves without a grab of its own (the editor's, the camera's)
      for (const [first, p] of this.grabs) {
        if (p.kind === 'pinch' && p.other === e.pointerId) this.pinchMove(p, e);
        else if (p.kind === 'camera' && p.other === e.pointerId) this.cameraMove(first, p, e.pointerId, logicalPoint(e));
      }
      return;
    }
    e.preventDefault();
    const at = logicalPoint(e);
    if (g.kind === 'stick') {
      this.pointers.set(e.pointerId, at);
      this.followStick(g, at, e.timeStamp);
      this.moveStick(g.id, at.x - g.cx, at.y - g.cy, g, e.timeStamp);
    } else if (g.kind === 'grenade') this.grenadeMove(g, at, e.timeStamp);
    else if (g.kind === 'swap') this.swapMove(g, at, e.timeStamp);
    else if (g.kind === 'dash') this.dashMove(g, at, e.timeStamp);
    else if (g.kind === 'fire') this.fireMove(g, at);
    else if (g.kind === 'camera') this.cameraMove(e.pointerId, g, e.pointerId, at);
    else if (g.kind === 'edit') this.editMove(g, e);
    else if (g.kind === 'pinch') this.pinchMove(g, e);
  }

  private onUp(e: PointerEvent): void {
    this.waiting.delete(e.pointerId);
    this.screenHolds.get(e.pointerId)?.();
    this.screenHolds.delete(e.pointerId);
    const g = this.grabs.get(e.pointerId);
    this.pointers.delete(e.pointerId);
    this.grabSeen.delete(e.pointerId);
    if (!g) {
      // the second finger of a pinch lifted: the first one drags again (the camera's: it ends)
      for (const [id, p] of this.grabs) {
        if (p.kind === 'pinch' && p.other === e.pointerId) this.endPinch(id, p);
        else if (p.kind === 'camera' && p.other === e.pointerId) this.endCamera(id, p, e.timeStamp);
      }
      return;
    }
    if (g.kind === 'camera') {
      this.endCamera(e.pointerId, g, e.timeStamp);
      return;
    }
    // the lift's own point counts for a flick's speed
    if (g.kind === 'stick' && e.type === 'pointerup') {
      const at = logicalPoint(e);
      this.followStick(g, at, e.timeStamp);
    }
    this.grabs.delete(e.pointerId);
    this.release(g, e.timeStamp, e.type === 'pointerup');
  }

  private release(g: Grab, at: number, lifted: boolean): void {
    const s = this.state;
    if (g.kind === 'stick') {
      const el = this.els.get(g.id)!;
      el.classList.remove('mf-down', 'mf-fire');
      // the knob springs home (touch.css: its transition, on --ease-settle, runs once the thumb is off)
      this.knobs.get(g.id)!.style.transform = '';
      this.stickValue(g.id, null);
      if (g.id === 'move') {
        // a flick dashes: on a fixed stick measured from where the thumb landed, and the way it swiped
        // (stick.ts FIXED_FLICK); following the thumb, the stick's own push (FLICK)
        const flick = !lifted || !this.settings.swipeDash ? null : g.fixed ? fixedFlick(g, at) : isFlick({ durationMs: at - g.startAt, peak: g.peak, riseMs: g.peakAt - g.riseFrom, outSpeed: outSpeed(g) }) ? { dir: g.peakDir, rate: flickRate(g.peak, g.startAt, g.peakAt), peak: g.peak } : null;
        if (flick) {
          s.pulses |= Btn.Dash;
          s.dashDir = flick.dir;
          s.dashStrength = dashStrength('peak' in flick ? flick.peak : 1, flick.rate, this.host.dashFlickFull());
          this.dashed(false, at); // on the events' clock, as the dash button's swipe
        }
        // the left thumb may be hopping to DASH: a tap soon after dashes the way the stick was going
        this.moveLift = lifted ? { at, bits: carriedBits(g, at) } : null;
        s.moveActive = false;
        s.moveBits = 0;
        s.moveDragOn = false;
        Object.assign(s.move, zeroStick());
      } else {
        // remembered for a quick hop to a button and back (§4.6: resumeAim)
        this.aimLift = lifted ? { at, dx: g.dx, dy: g.dy, firing: s.aimFire, button: false } : null;
        // release-to-fire: lifting a pushed stick fires once (back to the centre first = no shot),
        // unless it was aiming a grenade
        // (a fixed stick: only after LAND_ARM.ms down; a brush of the dial isn't a shot)
        if (lifted && this.fireNow === 'release' && this.weaponDef?.fireMode !== 'charge' && s.aim.mag > 0 && !s.grenadeActive && (!g.centred || at - g.startAt >= LAND_ARM.ms)) s.pulses |= Btn.Fire;
        s.chargeHold = false;
        s.aimActive = false;
        s.aimFire = false;
        s.aimArmed = true;
        Object.assign(s.aim, zeroStick());
      }
      // the dial glides home from where the thumb took it
      const from = logicalRect(el);
      this.place();
      const to = logicalRect(el);
      glideHome(el, from.left - to.left, from.top - to.top);
    } else if (g.kind === 'grenade') {
      if (g.mode === 'cycle') {
        // a swipe on the belt: the type changes, nothing is thrown (the latch was cancelled)
        if (lifted) {
          this.cycleQueue += cyclePresses(g.steps, this.belt.types.length);
          this.act('cycle');
        }
        this.overlays.hideFan(700);
      } else if (lifted) {
        // lifted: it throws (a tap: a quick throw); dragged off or cancelled: no throw
        this.host.throwLatch?.release(performance.now());
        if (at - g.downAt < TAP_MS) {
          this.quickStamp();
          this.act('throw');
        } else this.act('aimed-throw');
        this.buzz(18);
      } else this.host.throwLatch?.cancel();
      s.grenadeActive = false;
      this.lifted('grenade');
    } else if (g.kind === 'swap') {
      if (g.radial) {
        // the radial: the other gun, or melee; the gun in hand (or the centre) changes nothing
        const pick = lifted ? g.pick : -1;
        if (pick === 0 && this.guns.slung !== NO_WEAPON) s.pulses |= Btn.Swap;
        if (pick === 1) s.pulses |= Btn.Melee;
        if (pick === 0 || pick === 1) {
          this.act('radial');
          this.buzz(12);
        }
        this.overlays.hideRadial();
      } else if (lifted && !g.done) {
        s.pulses |= Btn.Swap;
        this.act('swap');
        this.buzz(12);
      }
      this.lifted('swap');
    } else if (g.kind === 'dash') {
      // no swipe: a dash the way you face (the stick was idle), if the 90 ms decision hasn't sent it
      if (lifted && !g.fired) this.dashFaced(g, at);
      this.lifted('dash');
    } else if (g.kind === 'shield') {
      // held: it goes back on the sling when the thumb lifts (a tap leaves it as toggled)
      if (lifted && g.raised && at - g.downAt >= GESTURE.holdMs && SHIELD_BIT) s.pulses |= SHIELD_BIT;
      this.lifted('shield');
    } else if (g.kind === 'camera') {
      this.grabs.delete(g.other);
    } else if (g.kind === 'fire') {
      // FIRE and a Claw finger can both be down: the trigger lets go with the last of them
      if (![...this.grabs.values()].some((o) => o !== g && o.kind === 'fire')) s.held &= ~Btn.Fire;
      if (g.aim) {
        s.aimActive = false;
        Object.assign(s.aim, zeroStick());
      }
      if (!g.tap) this.lifted(g.def.id);
    } else if (g.kind === 'button') {
      if (g.def.bit) s.held &= ~g.def.bit;
      if (g.def.key && g.def.key !== 'Escape') key('keyup', g.def.key);
      this.lifted(g.def.id);
    } else if (g.kind === 'edit' || g.kind === 'pinch') {
      this.drop(g.id);
    }
  }

  // ---------- v3: gestures (gestures.ts), the camera, teaching (teach.ts) ----------

  /** The gesture buttons: the gun pill, the dash button, the shield. False: a plain press. */
  private pressGesture(e: PointerEvent, def: ControlDef, el: HTMLElement): boolean {
    const s = this.state;
    const at = logicalPoint(e);
    if (def.id === 'swap') {
      const g: Extract<Grab, { kind: 'swap' }> = { kind: 'swap', downAt: e.timeStamp, x0: at.x, y0: at.y, done: false, radial: false, pick: -1, items: [], spots: [], dead: GESTURE.radialDead };
      this.grabs.set(e.pointerId, g);
      // a hold opens the radial (unless the finger swiped the swap already)
      window.setTimeout(() => {
        if (this.grabs.get(e.pointerId) === g && !g.done) this.openRadial(g);
      }, GESTURE.holdMs);
      return true;
    }
    if (def.id === 'dash') {
      // the move stick pushed says where: dash at once; idle, a swipe on the button says where
      if (s.moveActive) return false;
      const g: Extract<Grab, { kind: 'dash' }> = { kind: 'dash', downAt: e.timeStamp, x0: at.x, y0: at.y, fired: false };
      this.grabs.set(e.pointerId, g);
      // no swipe within 90 ms: the way you face, now, not at the lift (§4.6)
      window.setTimeout(() => {
        if (this.grabs.get(e.pointerId) === g && !g.fired) this.dashFaced(g);
      }, DASH_DECIDE_MS);
      return true;
    }
    if (def.id === 'shield' && def.bit) {
      // a toggle (raise, or sling when it's up); held, it slings again on release
      s.pulses |= def.bit;
      this.grabs.set(e.pointerId, { kind: 'shield', downAt: e.timeStamp, raised: this.shieldNow !== 'front' });
      this.act('shield');
      return true;
    }
    void el;
    return false;
  }

  /** A plain press: what the drill and the hints hear about it. */
  private pressAction(id: ControlId): void {
    const a: Partial<Record<ControlId, TouchAction>> = { reload: 'reload', melee: 'melee', take: 'take', cycleGrenade: 'cycle', swap: 'swap', shield: 'shield', zoom: 'zoom', scores: 'scores' };
    const x = a[id];
    if (x) this.act(x);
  }

  /** A dash went (any way it was asked for): a second within CHAIN_MS is a chain. */
  private dashed(swipe: boolean, now = performance.now()): void {
    const chain = now - this.lastDashAt <= CHAIN_MS;
    this.lastDashAt = now;
    this.act('dash');
    if (chain) this.act('chain');
    if (swipe) this.buzz(15);
  }

  /** The grenade button: a quick swipe ↑/↓ scrubs the belt; anything else aims (as v2). */
  private grenadeMove(g: Extract<Grab, { kind: 'grenade' }>, at: Vec, t: number): void {
    const dx = at.x - g.x0;
    const dy = at.y - g.y0;
    if (g.mode === 'pending') {
      // a finger that rested first (a hold) aims; one that set off at once, mostly up or down, scrubs the belt
      const dist = Math.hypot(dx, dy);
      if (dist < GESTURE.stillPx) {
        if (t - g.downAt >= GESTURE.holdMs) g.mode = 'aim';
      } else if (t - g.downAt >= GESTURE.holdMs && !g.moving) g.mode = 'aim';
      else {
        g.moving = true;
        if (dist >= GESTURE.swipePx) {
          if (Math.abs(dy) > Math.abs(dx) * 1.2) {
            g.mode = 'cycle';
            this.host.throwLatch?.cancel();
            this.state.grenadeActive = false;
            Object.assign(this.state.grenade, zeroStick());
          } else g.mode = 'aim';
        }
      }
    }
    if (g.mode === 'cycle') {
      const steps = beltSteps(dy);
      if (steps !== g.steps) {
        g.steps = steps;
        this.buzz(8);
      }
      this.showFan(g.steps);
      return;
    }
    shapeStick(at.x - g.cx, at.y - g.cy, g.radius, GRENADE_STICK, this.state.grenade);
  }

  /** The belt fanned beside the grenade button, lined up on where `steps` will land. */
  private showFan(steps: number): void {
    const c = this.centres.get('grenade');
    if (!c) return;
    const { types, at, counts } = this.belt;
    const side = c.x > this.safe.clientWidth / 2 ? 'left' : 'right';
    this.overlays.showFan(c, (this.sizes.get('grenade')?.px ?? 58) / 2, types, counts, types[at] ?? -1, beltAfter(types, at, steps), side);
  }

  /** The gun pill: a quick swipe swaps at once; with the radial open, the finger picks. */
  private swapMove(g: Extract<Grab, { kind: 'swap' }>, at: Vec, t: number): void {
    const dx = at.x - g.x0;
    const dy = at.y - g.y0;
    if (g.radial) {
      const c = this.radialCentre();
      // the radial is drawn in the safe box; the finger is on the page (radialPickOnPage moves it in)
      const safe = logicalRect(this.safe);
      const pick = c ? radialPickOnPage(at, { x: safe.left, y: safe.top }, c, g.spots, g.dead) : -1;
      if (pick !== g.pick) {
        g.pick = pick;
        this.overlays.pickRadial(pick);
        if (pick >= 0) this.buzz(8);
      }
      return;
    }
    if (!g.done && isQuickSwipe(dx, dy, t - g.downAt)) {
      g.done = true;
      this.state.pulses |= Btn.Swap;
      this.act('swap');
      this.buzz(12);
    }
  }

  /** The radial: the other gun, melee, the gun in hand, fanned away from the pill's edge of the screen. */
  /** The gun pill's drawn centre (a pill hangs from its top edge: its nominal centre isn't its middle). */
  private radialCentre(): Vec | null {
    const el = this.els.get('swap')?.querySelector('.mf-skin');
    const safe = logicalRect(this.safe);
    if (!el) return null;
    const r = logicalRect(el);
    return { x: r.left + r.width / 2 - safe.left, y: r.top + r.height / 2 - safe.top };
  }

  private openRadial(g: Extract<Grab, { kind: 'swap' }>): void {
    const c = this.radialCentre();
    const el = this.els.get('swap')?.querySelector('.mf-skin');
    if (!c || !el) return;
    const box = logicalRect(el);
    const angles = radialAngles(c.x, c.y, this.safe.clientWidth, this.safe.clientHeight);
    const gun = (def: number) => {
      const w = weapons[def];
      const icon = w ? weaponIcon(w.id) : null;
      return { label: w?.name ?? '', icon: icon ? iconHref(icon) : '', wide: !!icon };
    };
    const slung = this.guns.slung !== NO_WEAPON ? gun(this.guns.slung) : { label: 'No 2nd gun', icon: iconHref('backpack'), wide: false };
    g.items = [
      { ...angles[0]!, ...slung },
      { ...angles[1]!, label: 'Melee', icon: iconHref('melee') },
      { ...angles[2]!, ...gun(this.guns.held), label: 'In hand' },
    ];
    g.spots = radialSpots(c, g.items, box.width / 2, box.height / 2);
    g.dead = Math.max(GESTURE.radialDead, box.height / 2);
    g.radial = true;
    this.overlays.showRadial(c, g.items, g.spots, -1);
    this.buzz(8);
  }

  /**
   * FIRE (Fire button mode, §4.4): fires on pointerdown, held while down. The right one is also a
   * floating stick from where the thumb landed, so one touch fires and steers; not when a thumb is
   * already on the aim stick (then it only fires), and never the left one (an index finger).
   */
  private pressFire(e: PointerEvent, def: ControlDef, tap = false): void {
    const s = this.state;
    s.held |= Btn.Fire;
    s.pulses |= Btn.Fire;
    if (tap) {
      // Claw's extra finger: fire only; the thumb keeps the aim
      this.grabs.set(e.pointerId, { kind: 'fire', def, aim: null, tap: true });
      this.act('fire');
      return;
    }
    const aimHeld = [...this.grabs.values()].some((g) => (g.kind === 'stick' && g.id === 'aim') || (g.kind === 'fire' && g.aim));
    const at = logicalPoint(e);
    const radius = (this.sizes.get('aim')?.px ?? 136) / 2;
    this.grabs.set(e.pointerId, { kind: 'fire', def, aim: def.id === 'fire' && !aimHeld ? { cx: at.x, cy: at.y, radius } : null });
  }

  /** A drag from FIRE aims (the aim stick's shape, from the landing point; the knob isn't drawn: the reticle shows it). */
  private fireMove(g: Extract<Grab, { kind: 'fire' }>, at: Vec): void {
    if (!g.aim) return;
    const o = followOrigin(g.aim.cx, g.aim.cy, at.x, at.y, g.aim.radius);
    g.aim.cx = o.x;
    g.aim.cy = o.y;
    shapeStick(at.x - o.x, at.y - o.y, g.aim.radius, AIM_STICK, this.state.aim);
    this.state.aimActive = this.state.aim.mag > 0;
  }

  /** The aim stick has been used: its "Aim to shoot" tag fades (touch.css .mf-aimed), for the rest of the visit. */
  private aimLearned(): void {
    aimTagLearned = true;
    this.els.get('aim')?.classList.add('mf-aimed');
  }

  /** FIRE shows in Fire button mode (the left one if asked for); the aim dial wears the mode (touch.css: AUTO, Pull's ring, Release's cancel ring). */
  private modeClass(): void {
    const aim = this.els.get('aim');
    if (aim && aim.dataset.fire !== this.fireNow) aim.dataset.fire = this.fireNow;
    this.context('fire', this.settings.fire === 'button');
    this.context('fireLeft', this.settings.fire === 'button' && this.settings.leftFire);
    // JET: Classic's arc and Claw's left index finger; One-thumb's only when its stick doesn't jet
    this.context('jet', this.settings.preset !== 'oneThumb' || !this.settings.stickJet);
  }

  /** The preset on the root (touch.css: One-thumb's aim dial shows only under a finger; no jet hint on a stick that doesn't jet). */
  private presetClass(): void {
    if (this.root.dataset.preset !== this.settings.preset) this.root.dataset.preset = this.settings.preset;
    // fixed sticks draw Pull's fire line further out (touch.css; mapping.ts FIRE_FIXED)
    if (this.root.dataset.sticks !== this.settings.sticks) this.root.dataset.sticks = this.settings.sticks;
    this.root.classList.toggle('mf-nostickjet', !this.settings.stickJet);
  }

  /** A preset picked (the editor's first row; Settings goes through index.ts): its places, and the settings it implies. */
  private pickPreset(preset: PresetId): void {
    this.layout = withoutMoves(this.layout);
    saveLayout(this.store, this.layout);
    this.onSettingsEdited({ preset, ...PRESET_SETTINGS[preset] });
    this.refreshContext(this.tokensBefore);
    this.place();
    this.syncEditor();
  }

  /** Another preset was picked in Settings: the moves made on the old one's places go (the pins stay). */
  dropMoves(): void {
    this.layout = withoutMoves(this.layout);
    saveLayout(this.store, this.layout);
  }

  /**
   * The dash button's tap: a full dash, once, the way the move stick was going if the thumb just hopped
   * off it (DASH_CARRY), else the way you face (the keyboard's).
   */
  private dashFaced(g: Extract<Grab, { kind: 'dash' }>, at = performance.now()): void {
    g.fired = true;
    const s = this.state;
    s.pulses |= Btn.Dash;
    s.dashDir = this.carriedDash(g.downAt);
    s.dashStrength = 7;
    this.dashed(false, at);
  }

  /** A stick's thumb moved: its trail (for the flick test) and the origin following it past 1.2 radii (§4.3). */
  private followStick(g: Extract<Grab, { kind: 'stick' }>, at: Vec, t: number): void {
    g.trail.push({ t, x: at.x, y: at.y });
    g.movedAt = performance.now();
    // a short history is enough: the flick looks back FLICK.windowMs and more
    while (g.trail.length > 2 && t - g.trail[1]!.t >= FLICK.windowMs * 3) g.trail.shift();
    if (!g.moved && Math.hypot(at.x - g.x0, at.y - g.y0) > GESTURE.stillPx) g.moved = true;
    // read from the drawn centre: the origin never moves (the drag's own origin, which jets, follows the thumb past 1.2 radii as Follow thumb's does)
    if (g.centred) {
      const d = followOrigin(g.ox, g.oy, at.x, at.y, g.radius);
      g.ox = d.x;
      g.oy = d.y;
      return;
    }
    const o = followOrigin(g.cx, g.cy, at.x, at.y, g.radius);
    if (o.x === g.cx && o.y === g.cy) return;
    g.cx = o.x;
    g.cy = o.y;
    // a fixed dial stays drawn where it is (a thumb that missed it still reads by its drag)
    if (!g.fixed) this.drawBase(this.els.get(g.id)!, o.x, o.y, g.radius);
  }

  /** The dash button: the first swipe dashes that way (8 directions). */
  private dashMove(g: Extract<Grab, { kind: 'dash' }>, at: Vec, t: number): void {
    if (g.fired) return;
    const dx = at.x - g.x0;
    const dy = at.y - g.y0;
    if (Math.hypot(dx, dy) < GESTURE.swipePx) return;
    g.fired = true;
    this.state.pulses |= Btn.Dash;
    this.state.dashDir = dashButtons(dx, dy);
    // its strength: a full push, as quick as the swipe was (v14: like a flick of the move stick)
    this.state.dashStrength = dashStrength(1, flickRate(1, g.downAt, t), this.host.dashFlickFull());
    this.dashed(true, t);
  }

  /** Two fingers on one side: the first finger's stick lets go and the pair works the camera. */
  private startCamera(first: number, stick: Extract<Grab, { kind: 'stick' }>, second: number, at: Vec, t: number): void {
    const a = this.pointers.get(first) ?? at;
    this.grabs.delete(first);
    this.release(stick, t, false);
    this.pointers.set(first, a);
    this.pointers.set(second, at);
    this.grabs.set(first, { kind: 'camera', other: second, startDist: Math.max(1, Math.hypot(at.x - a.x, at.y - a.y)), startView: this.host.camera.viewScale, pinched: false, downAt: t, moved: false, starts: [a, at] });
  }

  private cameraMove(first: number, g: Extract<Grab, { kind: 'camera' }>, id: number, at: Vec): void {
    this.pointers.set(id, at);
    const a = this.pointers.get(first);
    const b = this.pointers.get(g.other);
    if (!a || !b) return;
    if (Math.hypot(a.x - g.starts[0].x, a.y - g.starts[0].y) > GESTURE.tapPx || Math.hypot(b.x - g.starts[1].x, b.y - g.starts[1].y) > GESTURE.tapPx) g.moved = true;
    // fingers apart: closer in; together: wider, as far as the game's own view (VIEW_LIMITS)
    const ratio = Math.hypot(a.x - b.x, a.y - b.y) / g.startDist;
    this.host.camera.viewScale = Math.max(VIEW_LIMITS.min, Math.min(VIEW_LIMITS.max, g.startView / Math.max(0.2, ratio)));
    if (!g.pinched && Math.abs(ratio - 1) >= 0.15) {
      g.pinched = true;
      this.buzz(6);
      this.act('pinch');
    }
  }

  /** The view now: the player's, or sized to the play area (autoView: as wide as readable soldiers allow). */
  private viewNow(): number {
    if (!this.settings.viewAuto) return this.settings.view;
    const r = logicalRect(this.root);
    return autoView(Math.max(r.width, r.height) > 0 ? r.width : Math.max(innerWidth, innerHeight));
  }

  /** The camera's fingers lifted: a short still two-finger tap, twice, recentres (and resets the zoom). */
  private endCamera(first: number, g: Extract<Grab, { kind: 'camera' }>, t: number): void {
    this.grabs.delete(first);
    this.pointers.delete(first);
    this.pointers.delete(g.other);
    // a pinch's view is kept (Settings → Touch → View)
    if (g.pinched) this.onSettingsEdited({ view: Math.round(this.host.camera.viewScale * 100) / 100, viewAuto: false });
    if (g.moved || t - g.downAt > GESTURE.twoTapMs) return;
    if (t - this.lastTwoTapAt <= GESTURE.doubleTapMs) {
      this.lastTwoTapAt = -Infinity;
      this.host.camera.recentre();
      this.zoomSteps -= this.host.camera.zoom;
      // and the view back to the phone's default distance
      this.onSettingsEdited({ viewAuto: true });
      this.act('recentre');
      this.buzz(10);
    } else this.lastTwoTapAt = t;
  }

  /** A short buzz for a committed gesture (Settings → Button haptics; phones that can). */
  private buzz(ms: number): void {
    if (!this.settings.haptics || !canVibrate()) return;
    // at most one buzz per 70 ms (as the hit's); never under 12 ms: 6–8 may not register (§4.8, [S28])
    const now = performance.now();
    if (now - this.lastBuzz <= 70) return;
    this.lastBuzz = now;
    try {
      navigator.vibrate(Math.max(12, ms));
    } catch {
      /* not allowed here */
    }
  }

  /** What the player did: the drill ticks, a hint it answers goes. */
  private act(a: TouchAction): void {
    if (this.drill && !this.drill.finished && this.drill.act(a, this.can())) {
      this.buzz(10);
      this.renderDrill();
    }
    for (const fn of this.actionListeners) fn(a);
  }

  private canShield(): boolean {
    return this.els.has('shield') && this.shieldNow !== undefined;
  }

  /** What the drill's conditional steps need: a shield carried, a gun that zooms. */
  private can(): { shield: boolean; zoom: boolean } {
    return { shield: this.canShield(), zoom: this.tokensBefore.has('zoomable') };
  }

  /** Listens to what the player does (dev builds' checks). Returns an unsubscribe. */
  /** A control's box on screen (the page's coordinates), or null when it's not shown (index.ts touchControlRect). */
  controlRect(id: ControlId): Box | null {
    const el = this.els.get(id);
    if (!this.active || !el || el.classList.contains('mf-off') || this.root.hidden) return null;
    return logicalRect(el);
  }

  onAction(fn: (a: TouchAction) => void): () => void {
    this.actionListeners.add(fn);
    return () => this.actionListeners.delete(fn);
  }

  /** Once a frame: the drill starts when asked and the player is alive. */
  private teachTick(alive: boolean): void {
    if (!this.playing) return; // (the fire chooser first: playing is false while it's up)
    this.aliveNow = alive;
    if (this.drillWanted && alive) {
      this.drillWanted = false;
      this.drill = new Drill();
      this.drill.autoSkip(this.can());
      this.renderDrill();
    }
  }

  /**
   * The gesture hints possible now, in their order (teach.ts HINTS): the onboarding's hint engine
   * (tour/hints.ts) shows them, one at a time with every other tip, under its rules. None while the
   * drill runs or out of play; with gestures off, only Take (a tap) is left to teach.
   */
  hintsPossible(): string[] {
    if (!this.playing || this.drill || this.drillWanted) return [];
    const guns = (this.guns.held !== NO_WEAPON ? 1 : 0) + (this.guns.slung !== NO_WEAPON ? 1 : 0);
    const state = { alive: this.aliveNow, grenadeTypes: this.belt.types.length, guns, nearCrate: this.tokensBefore.has('near-crate'), shield: this.canShield() };
    return possibleHints(state)
      .filter((h) => this.settings.gestures || h.id === 'take')
      .filter((h) => !this.els.get(h.control)?.classList.contains('mf-off'))
      .map((h) => h.id);
  }

  /** Starts "Learn the controls" (Settings, the controls card, Training's first time): once playing and alive. */
  startDrill(): void {
    if (!this.drill) this.drillWanted = true;
  }

  get drillRunning(): boolean {
    return !!this.drill || this.drillWanted;
  }

  /** The hints show again (Settings → Touch → Show hints again): the old list too (index.ts tells the engine). */
  resetHints(): void {
    this.seen.clear();
    saveSeen(this.store, this.seen);
  }

  private renderDrill(): void {
    const d = this.drill;
    if (!d) return;
    this.overlays.showDrill(d, this.settings);
    // the step's control for this layout (FIRE in Fire button mode, JET when the stick doesn't jet)
    this.teach(d.step ? drillControl(d.step, this.settings) : null);
    if (d.justTicked) {
      const was = d.justTicked;
      window.setTimeout(() => {
        if (this.drill === d && d.justTicked === was) {
          d.justTicked = null;
          this.renderDrill();
        }
      }, 1200);
    }
    if (d.finished) {
      markDrillSeen(this.store);
      window.setTimeout(() => {
        if (this.drill === d) this.drillClose();
      }, 3500);
    }
  }

  private drillSkip(): void {
    this.drill?.skip(this.can());
    this.renderDrill();
  }

  private drillClose(): void {
    markDrillSeen(this.store);
    this.drill = null;
    this.drillWanted = false;
    this.overlays.hideDrill();
    this.teach(null);
  }

  /** The control the drill is about pulses (touch.css .mf-teach). */
  private teach(id: ControlId | null): void {
    if (this.teachTarget === id) return;
    if (this.teachTarget) this.els.get(this.teachTarget)?.classList.remove('mf-teach');
    this.teachTarget = id;
    if (id) this.els.get(id)?.classList.add('mf-teach');
  }

  /** A thumb came off a button: it springs back (P8), and a context control waiting to leave goes now. */
  private lifted(id: ControlId): void {
    this.els.get(id)?.classList.remove('mf-down');
    if (this.leaveOnLift.delete(id)) this.context(id, false);
  }

  /** A tap on the grenade button: the kit's "quick" stamp on it. */
  private quickStamp(): void {
    const q = this.els.get('grenade')?.querySelector<HTMLElement>('.mf-quick');
    if (!q) return;
    q.classList.add('is-on');
    const a = stamp(q);
    const off = () => q.classList.remove('is-on');
    if (a) a.onfinish = () => window.setTimeout(off, 120);
    else window.setTimeout(off, 280);
  }

  /** The move stick's grab, while a thumb is on it. */
  private moveGrab(): Extract<Grab, { kind: 'stick' }> | null {
    for (const g of this.grabs.values()) if (g.kind === 'stick' && g.id === 'move') return g;
    return null;
  }

  private moveStick(id: 'move' | 'aim', dx: number, dy: number, g?: Extract<Grab, { kind: 'stick' }>, at = 0): void {
    const radius = (this.sizes.get(id)?.px ?? 96) / 2;
    const k = this.sizes.get(id)?.k ?? 1;
    const off = knobOffset(dx, dy, radius);
    // the knob lives in the zoomed skin: its offset in skin pixels; raw under the thumb (no transition)
    this.knobs.get(id)!.style.transform = `translate(${(off.x / k).toFixed(1)}px, ${(off.y / k).toFixed(1)}px)`;
    const s = this.state;
    const v: StickVector = id === 'move' ? s.move : s.aim;
    // a stick read from its drawn centre has the fixed shapes (stick.ts: wider dead zones)
    shapeStick(dx, dy, radius, id === 'move' ? (g?.centred ? MOVE_FIXED : MOVE_STICK) : g?.centred ? AIM_FIXED : AIM_STICK, v);
    this.stickValue(id, v);
    if (g) {
      // when the push left 0.3 (a flick's rise starts there): between two readings, where the line
      // was crossed, so a phone's sparse moves don't make a quick flick look slow
      if (v.mag < 0.3) g.lowAt = at;
      else if (g.lastMag < 0.3 && at > g.lastAt) g.lowAt = g.lastAt + ((0.3 - g.lastMag) / (v.mag - g.lastMag)) * (at - g.lastAt);
      g.lastMag = v.mag;
      g.lastAt = at;
      g.dx = dx;
      g.dy = dy;
    }
    if (id === 'move') {
      s.moveActive = true;
      // a fixed stick also reads the drag from where the thumb landed: a push up from there jets (mapping.ts stickMoveButtons)
      s.moveDragOn = !!g?.centred;
      if (g?.centred) shapeStick(g.cx + dx - g.ox, g.cy + dy - g.oy, radius, MOVE_STICK, s.moveDrag);
      updateMove(s, this.settings.stickJet);
      if (g && v.mag >= g.peak) {
        // the flick's rise is timed to the first moment it reached its peak (a stick held at the rim
        // stays at 1: later moments don't make the rise slower)
        if (v.mag > g.peak) {
          g.peakAt = at;
          g.riseFrom = g.lowAt;
        }
        g.peak = v.mag;
        g.peakDir = moveButtons(v);
      }
    } else {
      s.aimActive = true;
      s.aimFire = pullFires(v.mag, s.aimFire, g?.centred ? FIRE_FIXED : undefined);
      // the first real aim (a push past half) has taught the "Aim to shoot" tag: it fades for this visit
      if (v.mag >= 0.5 && !aimTagLearned) this.aimLearned();
      this.els.get(id)!.classList.toggle('mf-fire', this.fireNow === 'pull' && s.aimFire && s.aimArmed && !s.grenadeActive); // aiming a throw: no fire
    }
  }

  /** The controls' state in one line, for the device's event log (diag/log.ts). */
  snapshot(): string {
    const s = this.state;
    const grabs = [...this.grabs.values()].map((g) => (g.kind === 'stick' ? `${g.id} stick` : g.kind === 'button' ? `${g.def.id} button` : g.kind)).join(', ') || 'none';
    const flags = [this.active ? '' : 'inactive', this.hiddenForMenus ? 'under menus' : '', this.editing ? 'editing' : '', this.choosing ? 'choosing' : '', this.inGame ? '' : 'no game'].filter(Boolean).join(', ');
    return `grabs ${grabs}; held ${s.held}; move ${s.moveActive ? `${s.move.x.toFixed(2)},${s.move.y.toFixed(2)} bits ${s.moveBits}` : 'off'}; grenade ${s.grenadeActive ? 'held' : 'no'}; ${flags || 'playing'}`;
  }

  /**
   * A match's countdown begins, or GO (main.ts): the controls start clean. Whatever no finger holds
   * any more (a held bit, the move or aim stick, a grenade latch, left over from the lobby, the VS
   * poster or warm-up) lets go; a thumb still down keeps its stick. The layout is measured again (the
   * lobby and the poster came and went; Safari's bars may have moved) and the controls light up.
   */
  rearm(why: string): void {
    const before = this.snapshot();
    const s = this.state;
    let backed = 0;
    let move = false;
    let aim = false;
    let grenade = false;
    for (const g of this.grabs.values()) {
      if (g.kind === 'button' && g.def.bit) backed |= g.def.bit;
      if (g.kind === 'fire') backed |= Btn.Fire;
      if (g.kind === 'stick' && g.id === 'move') move = true;
      if (g.kind === 'stick' && g.id === 'aim') aim = true;
      if (g.kind === 'grenade') grenade = true;
    }
    s.held &= backed;
    if (!move) {
      s.moveActive = false;
      s.moveBits = 0;
      s.moveDragOn = false;
      Object.assign(s.move, zeroStick());
    }
    if (!aim) {
      s.aimActive = false;
      s.aimFire = false;
      s.aimArmed = true;
      Object.assign(s.aim, zeroStick());
    }
    if (!grenade && s.grenadeActive) {
      s.grenadeActive = false;
      this.host.throwLatch?.cancel();
    }
    if (this.active) {
      this.place();
      this.fade.wakeAll(this.els.keys(), performance.now());
    }
    this.syncPlaying();
    diag('input', `touch ${why}: ${before}${before === this.snapshot() ? '' : ` → ${this.snapshot()}`}`);
  }

  releaseAll(): void {
    for (const [id, g] of this.grabs) {
      this.grabs.delete(id);
      this.release(g, 0, false);
    }
    this.pointers.clear();
    this.grabSeen.clear();
    this.waiting.clear();
    for (const off of this.screenHolds.values()) off();
    this.screenHolds.clear();
    this.overlays?.hideRadial();
    this.overlays?.hideFan();
    const s = this.state;
    s.held = 0;
    s.pulses = 0;
    s.grenadeActive = false;
  }

  // ---------- layout ----------

  private build(def: ControlDef): void {
    const el = div(`mf-ctl mf-ctl-${def.id}${def.kind === 'stick' ? ' mf-stick' : ''}${PILLS.has(def.id) ? ' mf-pill' : ''}`, this.safe);
    el.dataset.mfControl = def.id;
    el.title = def.title;
    el.setAttribute('aria-label', def.title);
    // a button, or (the sticks) a slider whose value is the push (stickValue); pointer-only, so not in
    // the tab order: the keyboard and pads have their own bindings
    if (def.kind === 'stick') {
      el.setAttribute('role', 'slider');
      el.setAttribute('aria-valuemin', '0');
      el.setAttribute('aria-valuemax', '100');
      el.setAttribute('aria-valuenow', '0');
      el.setAttribute('aria-valuetext', 'At rest');
    } else el.setAttribute('role', 'button');
    el.innerHTML = skinHtml(def.id);
    if (def.kind === 'stick') {
      // sticks are grabbed through their half of the screen, not their circle (except in the editor)
      delete el.dataset.mfControl;
      el.dataset.mfStick = def.id;
      this.knobs.set(def.id as 'move' | 'aim', el.querySelector<HTMLElement>('.mf-knob')!);
      if (def.id === 'aim' && aimTagLearned) el.classList.add('mf-aimed');
    }
    if (SOMETIMES.has(def.id) || def.id === 'fire' || def.id === 'fireLeft' || def.id === 'jet') el.classList.add('mf-off');
    this.els.set(def.id, el);
  }

  /** A control's placement in the current safe box (layout.ts placementFor: the mm anchors laid out at this size). */
  private at(id: ControlId): Placement {
    return placementFor(this.layout, id, this.settings.handed, this.box, this.settings.preset);
  }

  /** Puts every control at its place (its centre) for the current size, handedness and opacity. */
  private place(): void {
    this.presetClass();
    if (!this.active) return;
    const w = this.safe.clientWidth;
    const h = this.safe.clientHeight;
    if (w > 0 && h > 0) this.box = { w, h };
    const unit = Math.min(w, h);
    for (const [id, el] of this.els) {
      const p = this.at(id);
      const px = sizePx(p, unit);
      const k = px / SKIN_BASE[id];
      this.sizes.set(id, { px, k });
      this.centres.set(id, { x: p.x * w, y: p.y * h });
      el.style.setProperty('--k', k.toFixed(4));
      el.style.setProperty('--o', String(Math.min(1, p.opacity * this.settings.opacity * (this.editing && this.selected === id ? 1.6 : 1))));
      // lit (Auto-fade): the control's own opacity, without the Button fade
      el.style.setProperty('--o-awake', String(Math.min(1, p.opacity * (this.editing && this.selected === id ? 1.6 : 1))));
      const grab = [...this.grabs.values()].find((g): g is Extract<Grab, { kind: 'stick' }> => g.kind === 'stick' && g.id === id);
      // a fixed stick under a thumb (the phone turned, the window resized): the dial keeps its place,
      // and a thumb reading from its centre reads from the new one
      if (grab?.centred) {
        const rect = logicalRect(this.safe);
        grab.cx = rect.left + p.x * w;
        grab.cy = rect.top + p.y * h;
      }
      if (!grab || grab.fixed) {
        el.style.left = `${(p.x * w).toFixed(1)}px`;
        // a pill grows with its text (a gun's name, large text): it hangs from its top edge in the upper
        // half and stands on its bottom edge in the lower, so it grows away from the screen's edge
        const pill = PILLS.has(id);
        const anchor = pill ? (p.y < 0.5 ? 'top' : 'bottom') : '';
        if (el.dataset.anchor !== anchor) el.dataset.anchor = anchor;
        el.style.top = `${(p.y * h + (anchor === 'top' ? -px / 2 : anchor === 'bottom' ? px / 2 : 0)).toFixed(1)}px`;
      }
      el.classList.toggle('mf-selected', this.editing && this.selected === id);
    }
    if (this.editing) this.bay.sync();
    this.host.camera.soldierBand = this.soldierBand(w, h);
  }

  /**
   * Where on the screen (shares of its width) the soldier can stand without a thumb's controls over it:
   * between the controls of the lower half on the left (the move stick) and those on the right (the
   * arc, the aim stick). The soldier stands at about 70 % of the height, so only controls reaching that
   * low count. null when there's no clear stretch (an edited layout that fills the middle).
   */
  private soldierBand(w: number, h: number): { left: number; right: number } | null {
    const rect = this.safe.getBoundingClientRect();
    const screenW = window.innerWidth;
    if (!(screenW > 0) || !(w > 0)) return null;
    const MARGIN = 14; // px: half a soldier and a little air
    let left = 0;
    let right = screenW;
    for (const [id, el] of this.els) {
      if (el.classList.contains('mf-off') || (id === 'aim' && this.settings.preset === 'oneThumb')) continue;
      const c = this.centres.get(id);
      const z = this.sizes.get(id);
      if (!c || !z) continue;
      const r = z.px / 2;
      // only what reaches the soldier's row (the lower part of the screen)
      if (c.y + r < h * 0.5) continue;
      const x = rect.left + c.x;
      if (c.x < w / 2) left = Math.max(left, x + r + MARGIN);
      else right = Math.min(right, x - r - MARGIN);
    }
    return right - left > screenW * 0.12 ? { left: left / screenW, right: right / screenW } : null;
  }

  // ---------- editor ----------

  openEditor(): void {
    this.setEditing(true);
  }

  private setEditing(on: boolean): void {
    if (on === this.editing) return;
    if (on) {
      this.releaseAll();
      this.overlays.clear();
    }
    this.editing = on;
    this.syncPlaying();
    this.selected = null;
    this.root.classList.toggle('mf-touch-editing', on);
    // tips and coach cards wait while the HUD is being set (editor.css)
    document.documentElement.toggleAttribute('data-touch-editing', on);
    if (!on) {
      saveLayout(this.store, this.layout);
      this.bay.hide();
    }
    // while it's being placed: the context slot (shown by Take) and the pinned controls
    this.refreshContext(this.tokensBefore);
    this.place();
    if (on) this.bay.show();
  }

  private editDown(e: PointerEvent, target: Element | null): void {
    e.preventDefault();
    const p = logicalPoint(e);
    this.pointers.set(e.pointerId, p);
    // a second finger while one drags: pinch that control's size
    const dragging = [...this.grabs.entries()].find(([, g]) => g.kind === 'edit');
    if (dragging) {
      const [first, g] = dragging as [number, Extract<Grab, { kind: 'edit' }>];
      const a = this.pointers.get(first);
      if (a) {
        const cur = this.at(g.id);
        this.grabs.set(first, { kind: 'pinch', id: g.id, startDist: Math.max(1, Math.hypot(p.x - a.x, p.y - a.y)), startSize: cur.size, other: e.pointerId });
        this.showGuides([]);
      }
      return;
    }
    const el = target?.closest<HTMLElement>('[data-mf-control], [data-mf-stick]');
    if (!el) {
      this.selected = null;
      this.syncEditor();
      this.place();
      return;
    }
    const id = (el.dataset.mfControl ?? el.dataset.mfStick) as ControlId;
    this.selected = id;
    // one undo step per drag (none if it only picked the control)
    this.bay.willChange();
    // the finger's offset from the control's place (its centre; a pill's nominal centre)
    const box = logicalRect(this.safe);
    const at = this.at(id);
    this.grabs.set(e.pointerId, { kind: 'edit', id, dx: p.x - (box.left + at.x * box.width), dy: p.y - (box.top + at.y * box.height) });
    // the control lifts and follows the finger raw
    settleNow(el);
    el.classList.add('mf-lifted');
    this.bay.dragging(true);
    this.syncEditor();
    this.place();
  }

  private editMove(g: Extract<Grab, { kind: 'edit' }>, e: PointerEvent): void {
    const p = logicalPoint(e);
    this.pointers.set(e.pointerId, p);
    const rect = logicalRect(this.safe);
    const cur = this.at(g.id);
    const raw = { x: (p.x - g.dx - rect.left) / rect.width, y: (p.y - g.dy - rect.top) / rect.height };
    const others = [...this.els.keys()].filter((id) => id !== g.id).map((id) => this.at(id));
    const snap = snapPlacement(raw, others, rect.width, rect.height);
    this.showGuides(snap.guides);
    this.layout = withPlacement(this.layout, g.id, { ...cur, x: snap.x, y: snap.y }, this.settings.handed);
    this.place();
  }

  private pinchMove(g: Extract<Grab, { kind: 'pinch' }>, e: PointerEvent): void {
    this.pointers.set(e.pointerId, logicalPoint(e));
    const ids = [...this.grabs.entries()].find(([, v]) => v === g)?.[0];
    const a = ids === undefined ? undefined : this.pointers.get(ids);
    const b = this.pointers.get(g.other);
    if (!a || !b) return;
    const cur = this.at(g.id);
    this.layout = withPlacement(this.layout, g.id, { ...cur, size: g.startSize * (Math.hypot(a.x - b.x, a.y - b.y) / g.startDist) }, this.settings.handed);
    this.place();
  }

  private endPinch(first: number, g: Extract<Grab, { kind: 'pinch' }>): void {
    const a = this.pointers.get(first);
    if (!a) return;
    // back to a drag with the finger that's still down
    const box = logicalRect(this.safe);
    const at = this.at(g.id);
    this.grabs.set(first, { kind: 'edit', id: g.id, dx: a.x - (box.left + at.x * box.width), dy: a.y - (box.top + at.y * box.height) });
    saveLayout(this.store, this.layout);
    this.syncEditor();
  }

  /** The finger lifted: the control settles back down (--ease-settle) where it snapped. */
  private drop(id: ControlId): void {
    this.els.get(id)?.classList.remove('mf-lifted');
    this.bay.dragging(false);
    this.showGuides([]);
    saveLayout(this.store, this.layout);
    this.bay.changed();
    this.syncEditor();
  }

  private showGuides(guides: readonly { axis: 'x' | 'y'; at: number }[]): void {
    for (const axis of ['x', 'y'] as const) {
      const g = guides.find((v) => v.axis === axis);
      const el = this.guides[axis];
      el.classList.toggle('is-on', !!g);
      if (g) el.style.setProperty('--at', `${(g.at * 100).toFixed(2)}%`);
    }
  }

  /** The bay redraws (its card follows the picked control, the tray its free stretch, red for overlaps). */
  private syncEditor(): void {
    this.bay.sync();
  }

  /** What the layout bay (editor/bay.ts) reads and changes here. */
  private bayHost(): BayHost {
    const settingsOf = (s: TouchSettings) => ({ fire: s.fire, fireChosen: s.fireChosen, stickJet: s.stickJet, tapFire: s.tapFire, leftFire: s.leftFire });
    return {
      root: this.root,
      safe: this.safe,
      snapshot: () => ({ layout: this.layout, preset: this.settings.preset, handed: this.settings.handed, settings: settingsOf(this.settings) }),
      restore: (s) => {
        this.layout = s.layout;
        saveLayout(this.store, this.layout);
        this.onSettingsEdited({ preset: s.preset, handed: s.handed, ...s.settings });
        this.refreshContext(this.tokensBefore);
        this.place();
      },
      pickPreset: (p) => this.pickPreset(p),
      setHanded: (handed) => this.onSettingsEdited({ handed }),
      selected: () => this.selected,
      select: (id) => {
        this.selected = id;
        this.place();
      },
      placement: (id) => this.at(id),
      baseSize: (id) => placementFor({ placements: {}, pinned: this.layout.pinned ?? [] }, id, this.settings.handed, this.box, this.settings.preset).size,
      setPlacement: (id, p) => {
        this.layout = withPlacement(this.layout, id, p, this.settings.handed);
        saveLayout(this.store, this.layout);
        this.place();
      },
      reset: () => {
        this.layout = withoutMoves(this.layout);
        saveLayout(this.store, this.layout);
        this.selected = null;
        this.refreshContext(this.tokensBefore);
        this.place();
      },
      setPinned: (id, on) => {
        this.layout = withPinned(this.layout, id, on);
        saveLayout(this.store, this.layout);
        this.refreshContext(this.tokensBefore);
        this.place();
      },
      tray: () => {
        const off = offHud(this.settings.preset);
        const pinned = this.layout.pinned ?? [];
        return PINNABLE.filter((id) => off.has(id) && !pinned.includes(id) && this.els.has(id));
      },
      pinned: () => (this.layout.pinned ?? []).filter((id) => offHud(this.settings.preset).has(id)),
      discs: () => {
        const out: { id: ControlId; x: number; y: number; r: number }[] = [];
        for (const [id, el] of this.els) {
          if (el.classList.contains('mf-off') || el.hidden) continue;
          // a context control on its way out (the slot changed: it shrinks away) is no longer in its place
          if (SOMETIMES.has(id) && !this.shown.has(id)) continue;
          // One-thumb's aim floats: it comes up under a drag on empty space, so it has no place to clash with
          if (id === 'aim' && this.settings.preset === 'oneThumb') continue;
          const c = this.centres.get(id);
          const z = this.sizes.get(id);
          if (c && z) out.push({ id, x: c.x, y: c.y, r: z.px / 2 });
        }
        return out;
      },
      leave: () => this.setEditing(false),
      inGame: () => this.inGame,
      matchLive: () => this.matchLive,
    };
  }

  // ---------- page ----------

  /**
   * A stick's state for assistive tech (role="slider"): its push in 10 % steps and which way, set only
   * when that changes (a thumb sends a move a frame; the attributes change a few times a push).
   */
  private stickValue(id: 'move' | 'aim', v: StickVector | null): void {
    const el = this.els.get(id);
    if (!el) return;
    const pct = v ? Math.round(Math.min(1, v.mag) * 10) * 10 : 0;
    const deg = v ? (Math.atan2(v.y, v.x) * 180) / Math.PI : 0;
    const way = pct === 0 ? '' : ['right', 'up and right', 'up', 'up and left', 'left', 'down and left', 'down', 'down and right'][((Math.round(deg / 45) % 8) + 8) % 8];
    const text = pct === 0 ? 'At rest' : `Pushed ${pct} %, ${way}`;
    if (el.getAttribute('aria-valuetext') === text) return;
    el.setAttribute('aria-valuenow', String(pct));
    el.setAttribute('aria-valuetext', text);
  }

  /** No pinch zoom, and the safe areas reported (viewport-fit=cover), while a game is up under the controls (syncPlaying). */
  private setViewport(on: boolean): void {
    const meta = document.querySelector<HTMLMetaElement>('meta[name="viewport"]');
    if (!meta) return;
    if (on) {
      this.savedViewport ??= meta.content;
      meta.content = 'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover';
    } else if (this.savedViewport !== null) {
      meta.content = this.savedViewport;
      this.savedViewport = null;
    }
  }

  /** The sticks right now (dev builds' automated checks: the dials' input on a turned phone). */
  debugState(): { move: StickVector; aim: StickVector; moveActive: boolean; aimActive: boolean; aimFire: boolean; aimArmed: boolean; sticks: TouchSettings['sticks']; resume: { at: number; button: boolean } | null; fire: FireMode; visible: number; range: number; shoulder: { x: number; y: number }; targets: { x: number; y: number }[]; preset: PresetId; assist: AssistLevel; locked: number | null; enemyNear: boolean; lowMag: boolean } {
    const s = this.state;
    return { move: { ...s.move }, aim: { ...s.aim }, moveActive: s.moveActive, aimActive: s.aimActive, aimFire: s.aimFire, aimArmed: s.aimArmed, sticks: this.settings.sticks, resume: this.aimLift && { at: this.aimLift.at, button: this.aimLift.button }, fire: this.fireNow, visible: this.visible.length, range: this.weaponDef?.range ?? 0, shoulder: { ...this.shoulder }, targets: this.visible.map((t) => ({ x: t.x, y: t.y })), preset: this.settings.preset, assist: this.settings.assist, locked: this.aimAssist.target, enemyNear: this.enemyNear, lowMag: this.lowMag };
  }

  /** The skins' bound keys (tests). */
  get boundKeys(): string[] {
    return this.skin.keys;
  }

  destroy(): void {
    this.setActive(false);
    this.bay.destroy();
    for (const c of this.cleanups) c();
    this.root.remove();
  }
}

/** The game itself under a touch: either canvas, the controls' layer, or nothing but the page. */
function onGame(target: EventTarget | null): boolean {
  return target === document.documentElement || target === document.body || target instanceof HTMLCanvasElement || (target instanceof Element && !!target.closest('.mf-touch'));
}

/** A screen over the game under a touch (the lobby, the results, a sheet): an element on the page that isn't the game. */
function onScreenOverGame(target: EventTarget | null): target is Element {
  return target instanceof Element && target.isConnected && !onGame(target);
}

function div(className: string, parent: HTMLElement): HTMLDivElement {
  const el = document.createElement('div');
  el.className = className;
  parent.append(el);
  return el;
}

function clamp(v: number, lo: number, hi: number): number {
  return hi < lo ? (lo + hi) / 2 : Math.min(hi, Math.max(lo, v));
}

/** Stands in for a key the rest of the app listens to (the shell's Escape menu, the Tab scoreboard). */
function key(type: 'keydown' | 'keyup', code: string): void {
  window.dispatchEvent(new KeyboardEvent(type, { code, key: code, bubbles: true }));
}

/**
 * How fast the thumb was moving away from the stick's origin (or from (ox, oy): where a fixed stick's
 * thumb landed) at its last point (px/ms): that point against the latest one at least FLICK.windowMs
 * earlier (or the landing, for a shorter stroke), along the line from the origin.
 */
function outSpeed(g: Extract<Grab, { kind: 'stick' }>, ox = g.cx, oy = g.cy): number {
  const last = g.trail[g.trail.length - 1];
  if (!last) return 0;
  let then = g.trail[0]!;
  for (const p of g.trail) if (last.t - p.t >= FLICK.windowMs) then = p;
  const dt = last.t - then.t;
  const ux = last.x - ox;
  const uy = last.y - oy;
  const len = Math.hypot(ux, uy);
  if (dt <= 0 || len === 0) return 0;
  return ((last.x - then.x) * ux + (last.y - then.y) * uy) / len / dt;
}

/**
 * How fast a stick's thumb is heading in toward its centre now (px/ms; 0 for a thumb that has sent
 * nothing for 40 ms: a still thumb sends no moves). A fixed aim stick's landing settles once this drops.
 */
function inSpeed(g: Extract<Grab, { kind: 'stick' }>, now: number): number {
  if (now - g.movedAt > 40) return 0;
  return Math.max(0, -outSpeed(g));
}

/** A fixed move stick's flick (stick.ts isFixedFlick), measured from where the thumb landed to its lift. */
function fixedFlick(g: Extract<Grab, { kind: 'stick' }>, at: number): { dir: number; rate: number } | null {
  const last = g.trail[g.trail.length - 1];
  if (!last) return null;
  const dx = last.x - g.x0;
  const dy = last.y - g.y0;
  const travel = Math.hypot(dx, dy) / Math.max(1, g.radius);
  if (!isFixedFlick({ durationMs: at - g.startAt, travel, outSpeed: outSpeed(g, g.x0, g.y0) })) return null;
  // a full flick (FIXED_FLICK.minTravel or more), as quick as the stroke was
  return { dir: dashButtons(dx, dy), rate: flickRate(1, g.startAt, at) };
}

/** The way a move stick read DASH_CARRY.lookBackMs before its lift (its last point that long before, else its landing). */
function carriedBits(g: Extract<Grab, { kind: 'stick' }>, at: number): number {
  let p = g.trail[0];
  for (const q of g.trail) if (q.t <= at - DASH_CARRY.lookBackMs) p = q;
  if (!p) return 0;
  return moveButtons(shapeStick(p.x - g.cx, p.y - g.cy, g.radius, g.centred ? MOVE_FIXED : MOVE_STICK));
}
