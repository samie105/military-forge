/**
 * Spectating's controls (director.ts SpectateActions), on every device:
 * - **Keyboard and mouse:** Q / E prev / next, F free camera, Enter (or J) join; WASD or the arrows
 *   pan the free camera, the wheel zooms, a drag pans, a click on a soldier follows it.
 * - **Touch:** one finger drags the free camera, two pinch to zoom, a tap on a soldier follows it;
 *   the spectator bar's buttons do the rest (the touch controls step aside while watching).
 * - **Controller:** LB / RB prev / next, Y free camera, A join, the left stick pans, LT / RT zoom.
 * The HUD's bar buttons (`[data-spec]`) work with a click or a tap anywhere.
 * Listening only while `active` (main.ts sets it each frame), so play is never touched.
 */
import type { Camera } from '../camera';
import type { InputSampler } from '../input';
import { NO_ACTIONS, type SpectateActions } from './director';

/** pixels a press may move and still be a click or tap */
const CLICK_SLOP_PX = 8;
/** pinch: this much change in finger distance (ratio) is one zoom step */
const PINCH_STEP = 1.18;
/** stick dead zone, and the triggers' zoom repeat */
const DEAD_ZONE = 0.22;
const TRIGGER_REPEAT_MS = 260;

/** The standard gamepad mapping's buttons. */
const PAD = { a: 0, y: 3, lb: 4, rb: 5, lt: 6, rt: 7 } as const;

export class SpectateInput {
  /** listening (spectating or the death cam): set by main.ts every frame */
  active = false;
  /** the free camera is on (a drag pans only then) */
  free = false;
  private readonly bar = { prev: false, next: false, free: false, join: false };
  private dragPx = { x: 0, y: 0 };
  private clickAt: { x: number; y: number } | null = null;
  private zoomSteps = 0;
  /** a picker row clicked: follow that player */
  private followPick = -1;
  /** pointers down on the world: id → where it is now and where it started */
  private readonly pointers = new Map<number, { x: number; y: number; sx: number; sy: number }>();
  private pinchFrom = 0;
  private padPrev = new Set<number>();
  private triggerAt = 0;

  constructor(
    private readonly sampler: InputSampler,
    private readonly world: HTMLElement,
  ) {
    // the HUD's bar buttons (hud template: data-spec="prev|next|free|join")
    document.addEventListener('click', (e) => {
      const pick = (e.target as Element | null)?.closest?.('[data-spec-follow]');
      if (pick && this.active) {
        this.followPick = Number(pick.getAttribute('data-spec-follow'));
        e.preventDefault();
        return;
      }
      const el = (e.target as Element | null)?.closest?.('[data-spec]');
      if (!el || !this.active) return;
      const what = el.getAttribute('data-spec') as keyof SpectateInput['bar'];
      if (what in this.bar) this.bar[what] = true;
      e.preventDefault();
    });
    world.addEventListener('pointerdown', (e) => this.down(e));
    window.addEventListener('pointermove', (e) => this.move(e));
    window.addEventListener('pointerup', (e) => this.up(e));
    window.addEventListener('pointercancel', (e) => this.pointers.delete(e.pointerId));
  }

  private down(e: PointerEvent): void {
    if (!this.active || (e.pointerType === 'mouse' && e.button !== 0)) return;
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY });
    if (this.pointers.size === 2) this.pinchFrom = this.spread();
  }

  private move(e: PointerEvent): void {
    const p = this.pointers.get(e.pointerId);
    if (!p || !this.active) return;
    const dx = e.clientX - p.x;
    const dy = e.clientY - p.y;
    p.x = e.clientX;
    p.y = e.clientY;
    if (this.pointers.size >= 2) {
      const d = this.spread();
      if (this.pinchFrom > 0 && d > 0) {
        // fingers apart: closer in (a step down); together: wider
        while (d > this.pinchFrom * PINCH_STEP) {
          this.zoomSteps--;
          this.pinchFrom *= PINCH_STEP;
        }
        while (d < this.pinchFrom / PINCH_STEP) {
          this.zoomSteps++;
          this.pinchFrom /= PINCH_STEP;
        }
      }
      return;
    }
    if (this.free) {
      this.dragPx.x += dx;
      this.dragPx.y += dy;
    }
  }

  private up(e: PointerEvent): void {
    const p = this.pointers.get(e.pointerId);
    if (!p) return;
    this.pointers.delete(e.pointerId);
    if (this.pointers.size < 2) this.pinchFrom = 0;
    if (this.active && Math.hypot(p.x - p.sx, p.y - p.sy) < CLICK_SLOP_PX && this.pointers.size === 0) {
      const r = this.world.getBoundingClientRect();
      this.clickAt = { x: p.x - r.left, y: p.y - r.top };
    }
  }

  private spread(): number {
    const [a, b] = [...this.pointers.values()];
    return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
  }

  /**
   * This frame's actions; call before the sampler's presses are cleared. Keys are read only while
   * no menu has them (`sampler.blocked`).
   */
  poll(camera: Camera, now = performance.now()): SpectateActions {
    if (!this.active) {
      this.reset();
      return NO_ACTIONS;
    }
    const s = this.sampler;
    const keys = !s.blocked;
    const press = (...codes: string[]) => keys && codes.some((c) => s.consumePress(c));
    const held = (...codes: string[]) => keys && codes.some((c) => s.isDown(c));
    const act: SpectateActions = {
      prev: press('KeyQ') || this.bar.prev,
      next: press('KeyE') || this.bar.next,
      toggleFree: press('KeyF') || this.bar.free,
      join: press('Enter', 'NumpadEnter', 'KeyJ') || this.bar.join,
      panX: (held('KeyD', 'ArrowRight') ? 1 : 0) - (held('KeyA', 'ArrowLeft') ? 1 : 0),
      panY: (held('KeyW', 'ArrowUp') ? 1 : 0) - (held('KeyS', 'ArrowDown') ? 1 : 0),
      dragX: -this.dragPx.x / camera.ppm,
      dragY: this.dragPx.y / camera.ppm,
      zoom: s.consumeWheel() + this.zoomSteps,
      pick: this.clickAt ? { x: camera.toWorldX(this.clickAt.x), y: camera.toWorldY(this.clickAt.y) } : null,
      followId: this.followPick,
    };
    this.pollPad(act, now);
    this.reset();
    return act;
  }

  /** The first connected pad with the standard mapping: edges for its buttons, the stick and triggers held. */
  private pollPad(act: SpectateActions, now: number): void {
    const pads = typeof navigator !== 'undefined' && navigator.getGamepads ? navigator.getGamepads() : [];
    const pad = [...pads].find((p) => p && p.connected && p.mapping === 'standard');
    if (!pad) return;
    const down = new Set<number>();
    pad.buttons.forEach((b, i) => b.pressed && down.add(i));
    const edge = (i: number) => down.has(i) && !this.padPrev.has(i);
    if (!this.sampler.blocked) {
      act.prev ||= edge(PAD.lb);
      act.next ||= edge(PAD.rb);
      act.toggleFree ||= edge(PAD.y);
      act.join ||= edge(PAD.a);
      const [x = 0, y = 0] = pad.axes;
      if (Math.abs(x) > DEAD_ZONE) act.panX += x;
      if (Math.abs(y) > DEAD_ZONE) act.panY -= y;
      const zoom = (down.has(PAD.lt) ? 1 : 0) - (down.has(PAD.rt) ? 1 : 0);
      if (zoom !== 0 && now - this.triggerAt >= TRIGGER_REPEAT_MS) {
        act.zoom += zoom;
        this.triggerAt = now;
      }
    }
    this.padPrev = down;
  }

  private reset(): void {
    this.bar.prev = this.bar.next = this.bar.free = this.bar.join = false;
    this.dragPx = { x: 0, y: 0 };
    this.clickAt = null;
    this.zoomSteps = 0;
    this.followPick = -1;
  }
}
