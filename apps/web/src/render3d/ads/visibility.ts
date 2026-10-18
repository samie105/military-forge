/**
 * Readability (docs/14 §1.3 rule 3): at most two ad surfaces show a creative on screen at once, at
 * every zoom. The map's layout already keeps it to two at 1× (W8's compile_map lint 4); at wider
 * zooms a third or fourth surface can come into view, and this limiter dims the extra ones to a
 * switched-off screen until one of the lit two leaves. The lit ones are those taking the most of
 * the view, with a little hysteresis so a pair at equal size doesn't flicker; changes fade over
 * 0.5 s like the rotation.
 */
import type { PlanePose } from '../planeCamera';
import { viewAtDepth, type Rect3 } from '../environment/backdrop';
import type { AdSlot } from './manifest';

export const MAX_LIT = 2;
/** a surface counts as on screen once this much of it is in view */
export const ON_SCREEN = 0.05;
/** score bonus for staying lit */
const HYSTERESIS = 1.25;
/** lit fade time, s */
const FADE_S = 0.5;

const view: Rect3 = { x: 0, y: 0, width: 0, height: 0 };

/** How much of `slot` is in view (0…1) and how much of the view it takes (0…1). */
export function slotInView(slot: AdSlot, pose: PlanePose): { visible: number; share: number } {
  viewAtDepth(pose, slot.pos[2], view);
  const [w, h] = slot.size;
  const ox = Math.max(0, Math.min(slot.pos[0] + w / 2, view.x + view.width / 2) - Math.max(slot.pos[0] - w / 2, view.x - view.width / 2));
  const oy = Math.max(0, Math.min(slot.pos[1] + h / 2, view.y + view.height / 2) - Math.max(slot.pos[1] - h / 2, view.y - view.height / 2));
  const area = ox * oy;
  return { visible: area / (w * h), share: area / (view.width * view.height) };
}

export class LitLimiter {
  /** per slot: lit amount 0 (switched off) … 1 (showing its creative) */
  readonly lit: Float32Array;
  private readonly wanted: Uint8Array;
  private readonly score: Float32Array;
  private readonly order: number[];
  private first = true;

  constructor(private readonly slots: readonly AdSlot[]) {
    this.lit = new Float32Array(slots.length);
    this.wanted = new Uint8Array(slots.length);
    this.score = new Float32Array(slots.length);
    this.order = slots.map((_, i) => i);
  }

  /**
   * The surfaces that should be lit now: of those with any part in view, the MAX_LIT taking the
   * most of the view (the ones already lit get a bonus). Surfaces out of view are dark: they light
   * (fading in at the edge) only if there's room when they come in.
   */
  choose(pose: PlanePose): Uint8Array {
    for (let i = 0; i < this.slots.length; i++) {
      const { visible, share } = slotInView(this.slots[i]!, pose);
      this.score[i] = visible > 0 ? share * (this.wanted[i] ? HYSTERESIS : 1) : -1;
    }
    this.order.sort((a, b) => this.score[b]! - this.score[a]!);
    let lit = 0;
    for (const i of this.order) this.wanted[i] = this.score[i]! >= 0 && lit++ < MAX_LIT ? 1 : 0;
    return this.wanted;
  }

  update(pose: PlanePose, dt: number): Float32Array {
    this.choose(pose);
    const step = this.first ? 1 : Math.min(1, dt / FADE_S);
    this.first = false;
    for (let i = 0; i < this.lit.length; i++) {
      const target = this.wanted[i]!;
      // out of view there is nothing to fade
      if (this.score[i]! < 0) this.lit[i] = target;
      else this.lit[i] = target > this.lit[i]! ? Math.min(target, this.lit[i]! + step) : Math.max(target, this.lit[i]! - step);
    }
    return this.lit;
  }

  /** Surfaces on screen (≥ ON_SCREEN in view) and lit (> half) right now: never more than MAX_LIT. */
  litOnScreen(pose: PlanePose): number {
    let n = 0;
    for (let i = 0; i < this.slots.length; i++) if (this.lit[i]! > 0.5 && slotInView(this.slots[i]!, pose).visible >= ON_SCREEN) n++;
    return n;
  }
}
