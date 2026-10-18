/**
 * The touch HUD (loaded only where it's used): two floating thumb-sticks and the buttons, drawn as a
 * DOM layer over the game (under the shell's screens), turned into an `Input` once per sim tick.
 *
 * - Touch and pen only: a mouse (a tablet with a keyboard and mouse) keeps working on the canvas.
 *   Every touch on the game is claimed here, so none turns into mouse clicks or browser gestures.
 * - A thumb anywhere on its half of the screen grabs that stick there (big hit areas); the buttons
 *   sit above the halves.
 * - The editor drags, resizes and fades each control; the layout is saved on this device.
 */
import { angleToU16 } from '@military-forge/shared';
import { Btn, type Input, type SimEvent } from '@military-forge/sim';
import type { Camera } from '../camera';
import {
  availableControls,
  placementFor,
  saveLayout,
  withPlacement,
  type ControlDef,
  type ControlId,
  type Placement,
  type TouchLayout,
} from './layout';
import type { KeyValueStore as Store, TouchSettings } from './settings';
import type { ThrowLatch } from '../input';
import { FIRE_AT, assistAim, createTouchState, desiredAim, grenadeStrength, touchButtons, type AimTarget } from './mapping';
import { AIM_STICK, GRENADE_STICK, MOVE_STICK, isSwipe, knobOffset, moveButtons, shapeStick, zeroStick, type StickVector } from './stick';
import './touch.css';

/** Where the reticle (and the camera's look-ahead) sits along the touch aim, in metres. */
const RETICLE_M = 7;
/** The grenade button's drag reaches full strength this many button radii out. */
const GRENADE_REACH = 2.4;

type Grab =
  | { kind: 'stick'; id: 'move' | 'aim'; cx: number; cy: number; radius: number; startAt: number; peak: number; peakDir: number }
  | { kind: 'grenade'; cx: number; cy: number; radius: number }
  | { kind: 'button'; def: ControlDef }
  | { kind: 'edit'; id: ControlId; dx: number; dy: number };

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
}

export class TouchController {
  readonly root: HTMLDivElement;
  private readonly safe: HTMLDivElement;
  private readonly rotate: HTMLDivElement;
  private readonly editor: HTMLDivElement;
  private readonly els = new Map<ControlId, HTMLDivElement>();
  private readonly knobs = new Map<'move' | 'aim', HTMLDivElement>();
  private readonly grabs = new Map<number, Grab>();
  private readonly state = createTouchState();
  private readonly targets: AimTarget[] = [];
  private aimAngle = 0;
  private touchOwnsAim = true;
  private active = false;
  private hiddenForMenus = false;
  private editing = false;
  private selected: ControlId | null = null;
  private zoomSteps = 0;
  private zoomBefore: number | null = null;
  private lastBuzz = 0;
  /** when a finger last touched: mouse events right after are the browser's emulation, not a mouse */
  private lastTouchAt = -Infinity;
  private raf = 0;
  private savedViewport: string | null = null;
  private readonly cleanups: (() => void)[] = [];

  constructor(
    private readonly host: TouchHost,
    private settings: TouchSettings,
    private layout: TouchLayout,
    private readonly store: Store | null,
    private readonly onSettingsEdited: (patch: Partial<TouchSettings>) => void,
    editButton: boolean,
  ) {
    this.root = div('mf-touch', document.body);
    this.root.hidden = true;
    this.safe = div('mf-touch-safe', this.root);
    for (const def of availableControls()) this.build(def);
    if (editButton) {
      const edit = div('mf-ctl mf-touch-edit', this.safe);
      edit.textContent = '✎';
      edit.title = 'Edit the touch controls';
      edit.dataset.mfEdit = '';
    }
    this.rotate = div('mf-touch-rotate', this.root);
    this.rotate.innerHTML = `<div><div class="mf-touch-rotate-icon">⟳</div><b>Turn your phone sideways</b><p>The game plays in landscape.</p></div>`;
    if (document.fullscreenEnabled) {
      const fs = document.createElement('button');
      fs.className = 'mf-touch-btn';
      fs.textContent = 'Play full screen';
      fs.addEventListener('click', () => void this.fullscreenLandscape());
      this.rotate.firstElementChild!.append(fs);
    }
    this.editor = this.buildEditor();

    const on = <K extends keyof WindowEventMap>(type: K, fn: (e: WindowEventMap[K]) => void, opts?: AddEventListenerOptions) => {
      window.addEventListener(type, fn, opts);
      this.cleanups.push(() => window.removeEventListener(type, fn, opts));
    };
    on('pointerdown', (e) => this.onDown(e), { capture: true, passive: false });
    on('pointermove', (e) => this.onMove(e), { capture: true, passive: false });
    on('pointerup', (e) => this.onUp(e), { capture: true });
    on('pointercancel', (e) => this.onUp(e), { capture: true });
    // a real mouse takes the aim back (tablets with a mouse); emulated mouse events from a touch don't
    on('mousemove', (e) => {
      const emulated = (e as MouseEvent & { sourceCapabilities?: { firesTouchEvents?: boolean } }).sourceCapabilities?.firesTouchEvents;
      if (!emulated && e.timeStamp - this.lastTouchAt > 800) this.touchOwnsAim = false;
    });
    on('resize', () => this.place());
    on('blur', () => this.releaseAll());
    // no pinch zoom, long-press menu or rubber-band scrolling while playing
    const stop = (e: Event) => {
      if (this.playing) e.preventDefault();
    };
    for (const type of ['gesturestart', 'gesturechange', 'contextmenu', 'dblclick'] as const) on(type as keyof WindowEventMap, stop, { passive: false });
    on('touchmove', stop, { passive: false });
    const vis = () => document.hidden && this.releaseAll();
    document.addEventListener('visibilitychange', vis);
    this.cleanups.push(() => document.removeEventListener('visibilitychange', vis));
  }

  /** Controls on screen and in play (not hidden behind the menus or the editor). */
  private get playing(): boolean {
    return this.active && !this.hiddenForMenus && !this.editing;
  }

  setActive(on: boolean): void {
    if (on === this.active) return;
    this.active = on;
    this.root.hidden = !on;
    document.documentElement.toggleAttribute('data-touch-controls', on);
    this.setViewport(on);
    if (on) {
      this.touchOwnsAim = true;
      this.place();
      this.raf = requestAnimationFrame(this.frame);
    } else {
      cancelAnimationFrame(this.raf);
      this.releaseAll();
      this.setEditing(false);
      document.documentElement.removeAttribute('data-touch-playing');
    }
  }

  get isActive(): boolean {
    return this.active;
  }

  applySettings(settings: TouchSettings, layout?: TouchLayout): void {
    this.settings = settings;
    if (layout) this.layout = layout;
    this.place();
    this.syncEditor();
  }

  // ---------- once per sim tick ----------

  /** Adds this tick's touch input to what the keyboard and mouse sampled. */
  apply(out: Input, sx: number, sy: number): void {
    if (!this.playing) return;
    const s = this.state;
    out.buttons |= touchButtons(s, this.settings.fire);
    const want = desiredAim(s);
    if (want !== null) {
      this.aimAngle = assistAim(this.aimAngle, want, sx, sy, this.targets, this.settings.aimAssist);
      this.touchOwnsAim = true;
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
  }

  /** Zoom-button presses since the last call, as wheel steps (the last level wraps back to none). */
  takeZoom(): number {
    const z = this.zoomSteps;
    this.zoomSteps = 0;
    return z;
  }

  /** The players drawn this frame: the aim assist's targets. */
  onFrame(players: readonly { id: number; alive: boolean; x: number; y: number }[], localId: number): void {
    this.targets.length = 0;
    for (const p of players) if (p.alive && p.id !== localId) this.targets.push({ x: p.x, y: p.y + 0.9 });
  }

  /** Buzz when we're hit (or killed), if the player wants it and the browser allows it. */
  onEvents(events: readonly SimEvent[], localId: number): void {
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

  // ---------- pointers ----------

  private readonly frame = () => {
    const hide = this.host.blocked();
    if (hide !== this.hiddenForMenus) {
      this.hiddenForMenus = hide;
      this.root.classList.toggle('mf-touch-menus', hide);
      if (hide) this.releaseAll();
    }
    document.documentElement.toggleAttribute('data-touch-playing', this.playing);
    this.rotate.hidden = !(this.active && !hide && innerHeight > innerWidth);
    this.raf = requestAnimationFrame(this.frame);
  };

  private onDown(e: PointerEvent): void {
    if (!this.active || this.hiddenForMenus) return;
    const target = e.target as Element | null;
    // a mouse only uses the on-screen buttons; on the game it keeps aiming and firing as usual
    if (e.pointerType === 'mouse' && !target?.closest('[data-mf-control], [data-mf-edit], .mf-touch-editor')) return;
    if (e.pointerType !== 'mouse') this.lastTouchAt = e.timeStamp;
    if (this.editing) {
      if (!target?.closest('.mf-touch-editor')) this.editDown(e, target);
      return;
    }
    if (target?.closest('.mf-touch-rotate')) return;
    const ctl = target?.closest<HTMLElement>('[data-mf-control]');
    if (target?.closest('[data-mf-edit]')) {
      e.preventDefault();
      this.setEditing(true);
      return;
    }
    if (ctl) {
      e.preventDefault();
      this.pressControl(e, ctl.dataset.mfControl as ControlId, ctl);
      return;
    }
    // the game itself (either canvas, or nothing but the page): a stick for that half of the screen
    if (!(target === document.documentElement || target === document.body || target instanceof HTMLCanvasElement || target?.closest('.mf-touch'))) return;
    e.preventDefault(); // no mouse emulation, no scrolling, no text selection
    const rect = this.safe.getBoundingClientRect();
    const leftHalf = e.clientX < rect.left + rect.width / 2;
    const id = leftHalf === (this.settings.handed === 'right') ? 'move' : 'aim';
    if ([...this.grabs.values()].some((g) => g.kind === 'stick' && g.id === id)) return; // one thumb per stick
    const el = this.els.get(id)!;
    const radius = el.offsetWidth / 2;
    // floating: the stick comes to the thumb (kept inside the safe area)
    const cx = clamp(e.clientX, rect.left + radius, rect.right - radius);
    const cy = clamp(e.clientY, rect.top + radius, rect.bottom - radius);
    el.style.left = `${cx - rect.left - radius}px`;
    el.style.top = `${cy - rect.top - radius}px`;
    el.classList.add('mf-down');
    this.grabs.set(e.pointerId, { kind: 'stick', id, cx, cy, radius, startAt: e.timeStamp, peak: 0, peakDir: 0 });
    this.moveStick(id, e.clientX - cx, e.clientY - cy);
  }

  private pressControl(e: PointerEvent, id: ControlId, el: HTMLElement): void {
    const def = availableControls().find((c) => c.id === id);
    if (!def) return;
    el.classList.add('mf-down');
    const s = this.state;
    if (def.kind === 'drag') {
      const r = el.getBoundingClientRect();
      s.grenadeActive = true;
      // tap: a quick throw on release; hold: the arc, thrown on release (the throw latch)
      if (this.host.throwLatch) this.host.throwLatch.press(performance.now());
      else s.pulses |= def.bit;
      Object.assign(s.grenade, zeroStick());
      this.grabs.set(e.pointerId, { kind: 'grenade', cx: r.left + r.width / 2, cy: r.top + r.height / 2, radius: (r.width / 2) * GRENADE_REACH });
      return;
    }
    this.grabs.set(e.pointerId, { kind: 'button', def });
    if (def.bit) {
      s.held |= def.bit;
      s.pulses |= def.bit;
      if (def.bit === Btn.Dash) s.dashDir = s.moveActive ? moveButtons(s.move) : 0;
    }
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
    const g = this.grabs.get(e.pointerId);
    if (!g) return;
    e.preventDefault();
    if (g.kind === 'stick') this.moveStick(g.id, e.clientX - g.cx, e.clientY - g.cy, g);
    else if (g.kind === 'grenade') shapeStick(e.clientX - g.cx, e.clientY - g.cy, g.radius, GRENADE_STICK, this.state.grenade);
    else if (g.kind === 'edit') this.editMove(g, e);
  }

  private onUp(e: PointerEvent): void {
    const g = this.grabs.get(e.pointerId);
    if (!g) return;
    this.grabs.delete(e.pointerId);
    this.release(g, e.timeStamp, e.type === 'pointerup');
  }

  private release(g: Grab, at: number, lifted: boolean): void {
    const s = this.state;
    if (g.kind === 'stick') {
      const el = this.els.get(g.id)!;
      el.classList.remove('mf-down', 'mf-fire');
      this.knobs.get(g.id)!.style.transform = '';
      if (g.id === 'move') {
        if (lifted && this.settings.swipeDash && isSwipe(at - g.startAt, g.peak)) {
          s.pulses |= Btn.Dash;
          s.dashDir = g.peakDir;
        }
        s.moveActive = false;
        Object.assign(s.move, zeroStick());
      } else {
        // release-to-fire: lifting a pushed stick fires once (back to the centre first = no shot),
        // unless it was aiming a grenade
        if (lifted && this.settings.fire === 'release' && s.aim.mag > 0 && !s.grenadeActive) s.pulses |= Btn.Fire;
        s.aimActive = false;
        Object.assign(s.aim, zeroStick());
      }
      this.place(); // home again
    } else if (g.kind === 'grenade') {
      // lifted: it throws (a tap: a quick throw); dragged off or cancelled: no throw
      if (lifted) this.host.throwLatch?.release(performance.now());
      else this.host.throwLatch?.cancel();
      s.grenadeActive = false;
      this.els.get('grenade')?.classList.remove('mf-down');
    } else if (g.kind === 'button') {
      if (g.def.bit) s.held &= ~g.def.bit;
      if (g.def.key && g.def.key !== 'Escape') key('keyup', g.def.key);
      this.els.get(g.def.id)?.classList.remove('mf-down');
    } else if (g.kind === 'edit') {
      this.editor.classList.remove('mf-touch-editor-dragging');
      saveLayout(this.store, this.layout);
    }
  }

  private moveStick(id: 'move' | 'aim', dx: number, dy: number, g?: Extract<Grab, { kind: 'stick' }>): void {
    const el = this.els.get(id)!;
    const radius = el.offsetWidth / 2;
    const k = knobOffset(dx, dy, radius);
    this.knobs.get(id)!.style.transform = `translate(${k.x}px, ${k.y}px)`;
    const s = this.state;
    const v: StickVector = id === 'move' ? s.move : s.aim;
    shapeStick(dx, dy, radius, id === 'move' ? MOVE_STICK : AIM_STICK, v);
    if (id === 'move') {
      s.moveActive = true;
      if (g && v.mag >= g.peak) {
        g.peak = v.mag;
        g.peakDir = moveButtons(v);
      }
    } else {
      s.aimActive = true;
      el.classList.toggle('mf-fire', this.settings.fire === 'hold' && v.mag >= FIRE_AT && !s.grenadeActive); // aiming a throw: no fire
    }
  }

  releaseAll(): void {
    for (const [id, g] of this.grabs) {
      this.grabs.delete(id);
      this.release(g, 0, false);
    }
    const s = this.state;
    s.held = 0;
    s.pulses = 0;
    s.grenadeActive = false;
  }

  // ---------- layout ----------

  private build(def: ControlDef): void {
    const el = div(`mf-ctl mf-ctl-${def.id} ${def.kind === 'stick' ? 'mf-stick' : ''}`, this.safe);
    el.dataset.mfControl = def.id;
    el.title = def.title;
    if (def.kind === 'stick') {
      // sticks are grabbed through their half of the screen, not their circle (except in the editor)
      delete el.dataset.mfControl;
      el.dataset.mfStick = def.id;
      this.knobs.set(def.id as 'move' | 'aim', div('mf-knob', el));
    } else {
      el.textContent = def.label;
    }
    this.els.set(def.id, el);
  }

  /** Puts every control at its place for the current size, handedness and opacity. */
  private place(): void {
    if (!this.active) return;
    const w = this.safe.clientWidth;
    const h = this.safe.clientHeight;
    const unit = Math.min(w, h);
    for (const [id, el] of this.els) {
      const p = placementFor(this.layout, id, this.settings.handed);
      const size = Math.round(p.size * unit);
      el.style.width = el.style.height = `${size}px`;
      el.style.fontSize = `${Math.max(10, Math.round(size * 0.3))}px`;
      el.style.opacity = String(Math.min(1, p.opacity * this.settings.opacity * (this.editing && this.selected === id ? 1.6 : 1)));
      const grabbed = [...this.grabs.values()].some((g) => g.kind === 'stick' && g.id === id);
      if (!grabbed) {
        el.style.left = `${p.x * w - size / 2}px`;
        el.style.top = `${p.y * h - size / 2}px`;
      }
      el.classList.toggle('mf-selected', this.editing && this.selected === id);
    }
  }

  // ---------- editor ----------

  openEditor(): void {
    this.setEditing(true);
  }

  private setEditing(on: boolean): void {
    if (on === this.editing) return;
    if (on) this.releaseAll();
    this.editing = on;
    this.selected = null;
    this.root.classList.toggle('mf-touch-editing', on);
    this.editor.hidden = !on;
    if (!on) saveLayout(this.store, this.layout);
    this.syncEditor();
    this.place();
  }

  private editDown(e: PointerEvent, target: Element | null): void {
    const el = target?.closest<HTMLElement>('[data-mf-control], [data-mf-stick]');
    e.preventDefault();
    if (!el) {
      this.selected = null;
      this.syncEditor();
      this.place();
      return;
    }
    const id = (el.dataset.mfControl ?? el.dataset.mfStick) as ControlId;
    this.selected = id;
    const r = el.getBoundingClientRect();
    this.grabs.set(e.pointerId, { kind: 'edit', id, dx: e.clientX - (r.left + r.width / 2), dy: e.clientY - (r.top + r.height / 2) });
    this.editor.classList.add('mf-touch-editor-dragging');
    this.syncEditor();
    this.place();
  }

  private editMove(g: Extract<Grab, { kind: 'edit' }>, e: PointerEvent): void {
    const rect = this.safe.getBoundingClientRect();
    const cur = placementFor(this.layout, g.id, this.settings.handed);
    this.layout = withPlacement(this.layout, g.id, { ...cur, x: (e.clientX - g.dx - rect.left) / rect.width, y: (e.clientY - g.dy - rect.top) / rect.height }, this.settings.handed);
    this.place();
  }

  private editSelected(change: (p: Placement) => Placement): void {
    if (!this.selected) return;
    const cur = placementFor(this.layout, this.selected, this.settings.handed);
    this.layout = withPlacement(this.layout, this.selected, change(cur), this.settings.handed);
    saveLayout(this.store, this.layout);
    this.place();
    this.syncEditor();
  }

  private buildEditor(): HTMLDivElement {
    const ed = div('mf-touch-editor', this.root);
    ed.hidden = true;
    // one compact row (it must not hide the controls it edits); the rest opens on demand
    ed.innerHTML = `
      <div class="mf-touch-editor-row">
        <b class="mf-touch-editor-title" data-ed="title"></b>
        <button class="mf-touch-btn" data-ed="options" aria-expanded="false">Options</button>
        <button class="mf-touch-btn" data-ed="dock" aria-label="Move this panel up or down">⇕</button>
        <button class="mf-touch-btn" data-ed="reset">Reset</button>
        <button class="mf-touch-btn mf-touch-btn-primary" data-ed="done">Done</button>
      </div>
      <div class="mf-touch-editor-row" data-ed="sel">
        <button class="mf-touch-btn" data-ed="smaller" aria-label="Smaller">−</button>
        <button class="mf-touch-btn" data-ed="bigger" aria-label="Bigger">+</button>
        <label>Opacity <input type="range" min="15" max="100" step="5" data-ed="opacity" /></label>
      </div>
      <div class="mf-touch-editor-row" data-ed="more" hidden>
        <label><input type="checkbox" data-ed="left" /> Left-handed</label>
        <label><input type="checkbox" data-ed="release" /> Fire on release</label>
        <label><input type="checkbox" data-ed="assist" /> Aim assist</label>
        <label><input type="checkbox" data-ed="vibrate" /> Vibrate</label>
        <label><input type="checkbox" data-ed="swipe" /> Swipe to dash</label>
        <label>All controls <input type="range" min="15" max="100" step="5" data-ed="all" /></label>
      </div>`;
    const q = <T extends HTMLElement>(name: string) => ed.querySelector<T>(`[data-ed="${name}"]`)!;
    q('smaller').addEventListener('click', () => this.editSelected((p) => ({ ...p, size: p.size / 1.12 })));
    q('bigger').addEventListener('click', () => this.editSelected((p) => ({ ...p, size: p.size * 1.12 })));
    q<HTMLInputElement>('opacity').addEventListener('input', (e) => this.editSelected((p) => ({ ...p, opacity: Number((e.target as HTMLInputElement).value) / 100 })));
    const toggle = (name: string, patch: (on: boolean) => Partial<TouchSettings>) =>
      q<HTMLInputElement>(name).addEventListener('change', (e) => this.onSettingsEdited(patch((e.target as HTMLInputElement).checked)));
    toggle('left', (on) => ({ handed: on ? 'left' : 'right' }));
    toggle('release', (on) => ({ fire: on ? 'release' : 'hold' }));
    toggle('assist', (on) => ({ aimAssist: on }));
    toggle('vibrate', (on) => ({ vibrate: on }));
    toggle('swipe', (on) => ({ swipeDash: on }));
    q<HTMLInputElement>('all').addEventListener('input', (e) => this.onSettingsEdited({ opacity: Number((e.target as HTMLInputElement).value) / 100 }));
    q('reset').addEventListener('click', () => {
      this.layout = { placements: {} };
      saveLayout(this.store, this.layout);
      this.place();
    });
    q('done').addEventListener('click', () => this.setEditing(false));
    q('options').addEventListener('click', () => {
      const more = q('more');
      more.hidden = !more.hidden;
      q('options').setAttribute('aria-expanded', String(!more.hidden));
    });
    q('dock').addEventListener('click', () => ed.classList.toggle('mf-touch-editor-bottom'));
    return ed;
  }

  private syncEditor(): void {
    const q = <T extends HTMLElement>(name: string) => this.editor.querySelector<T>(`[data-ed="${name}"]`)!;
    const def = this.selected ? availableControls().find((c) => c.id === this.selected) : null;
    q('title').textContent = def ? def.title : 'Drag to move · tap to resize or fade';
    q('sel').hidden = !def;
    if (this.selected) q<HTMLInputElement>('opacity').value = String(Math.round(placementFor(this.layout, this.selected, this.settings.handed).opacity * 100));
    q<HTMLInputElement>('left').checked = this.settings.handed === 'left';
    q<HTMLInputElement>('release').checked = this.settings.fire === 'release';
    q<HTMLInputElement>('assist').checked = this.settings.aimAssist;
    q<HTMLInputElement>('vibrate').checked = this.settings.vibrate;
    q<HTMLInputElement>('swipe').checked = this.settings.swipeDash;
    q<HTMLInputElement>('all').value = String(Math.round(this.settings.opacity * 100));
  }

  // ---------- page ----------

  /** No pinch zoom, and the safe areas reported (viewport-fit=cover), while the controls are up. */
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

  private async fullscreenLandscape(): Promise<void> {
    try {
      await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
      await (screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> }).lock?.('landscape');
    } catch {
      /* not allowed here (iPhone Safari): turning the phone works too */
    }
  }

  destroy(): void {
    this.setActive(false);
    for (const c of this.cleanups) c();
    this.root.remove();
  }
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
