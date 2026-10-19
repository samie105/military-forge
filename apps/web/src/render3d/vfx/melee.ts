/**
 * Melee in 3D (docs/02 §12), which drew nothing before (the owner, 19 Oct: "I've not seen the
 * machete"):
 * - the swing's trail: while a soldier's strike sweeps (swing.ts), a smear of warm-white streaks
 *   fills the space the weapon passes through, from the hand out to the tip, and is gone in a
 *   blink;
 * - a melee hit (`hit` with DamageSource.Melee): a flash and sparks thrown along the swing at the
 *   target's chest, or blood when it's on. The flinch is motion.ts's, the attacker's swing for a
 *   remote player Avatar.struck's.
 */
import { DamageSource, type CollisionWorld, type SimEvent } from '@military-forge/sim';
import type { Frame, PlayerView } from '../../view';
import { Cell } from './atlas';
import { bloodHit } from './blood';
import { particleSpec, type ParticlePool, type ParticleSpec } from './pool';
import { Ramp } from './ramps';

/** where a soldier's weapon is mid-strike (world): the hand and the tip; false while it isn't striking */
export type SwingLookup = (player: number, out: SwingSegment) => boolean;
export interface SwingSegment {
  hx: number;
  hy: number;
  tx: number;
  ty: number;
}

/** points from the hand out to the tip that the smear follows (shares of the weapon's length) */
const ALONG = [0.45, 0.7, 0.88, 1] as const;
const TRAIL_TINT = [1, 0.96, 0.86] as const;
/** a melee hit lands about this high on the target */
const CHEST_Y = 0.95;
/** the melee hit's damage for blood when the event's own is all there is */
const MACHETE_BLOOD = 45;

const spec: ParticleSpec = particleSpec();
const base = particleSpec();
const reset = (): ParticleSpec => Object.assign(spec, base);

export interface MeleeTargets {
  glow: ParticlePool;
  smoke: ParticlePool;
  decals: ParticlePool;
}

export class MeleeFx {
  /** blood on hits (Vfx.setBlood) */
  blood = false;
  private readonly last = new Map<number, SwingSegment>();
  private readonly live = new Set<number>();
  private players: readonly PlayerView[] = [];
  private seed = 0x51a5;
  private readonly seg: SwingSegment = { hx: 0, hy: 0, tx: 0, ty: 0 };

  constructor(private readonly swings: SwingLookup) {}

  /** The strikes under way this frame: their smear, from where each weapon was last frame to where it is. */
  update(frame: Frame, fx: MeleeTargets, detail: number, reducedMotion: boolean): void {
    this.players = frame.players;
    this.live.clear();
    for (const p of frame.players) {
      if (!p.alive || !this.swings(p.id, this.seg)) continue;
      this.live.add(p.id);
      const prev = this.last.get(p.id);
      if (prev) this.smear(prev, this.seg, fx.glow, detail, reducedMotion);
      const keep = prev ?? { hx: 0, hy: 0, tx: 0, ty: 0 };
      Object.assign(keep, this.seg);
      if (!prev) this.last.set(p.id, keep);
    }
    for (const id of this.last.keys()) if (!this.live.has(id)) this.last.delete(id);
  }

  /** Melee hits: a flash and sparks at the target's chest along the swing (blood when it's on). */
  onEvents(events: readonly SimEvent[], fx: MeleeTargets, world: CollisionWorld, detail: number): void {
    for (const e of events) {
      if (e.type !== 'hit' || e.source !== DamageSource.Melee) continue;
      const target = this.players.find((p) => p.id === e.target);
      if (!target) continue;
      const attacker = this.players.find((p) => p.id === e.attacker);
      const x = target.x;
      const y = target.y + (target.crouched ? CHEST_Y * 0.7 : CHEST_Y);
      let ux = attacker ? x - attacker.x : 1;
      let uy = attacker ? y - (attacker.y + CHEST_Y) : 0;
      const d = Math.sqrt(ux * ux + uy * uy) || 1;
      ux /= d;
      uy /= d;
      if (this.blood) {
        bloodHit(fx, world, x, y, ux, uy, Math.max(e.damage, MACHETE_BLOOD), false, detail, () => this.rand());
        continue;
      }
      this.impact(fx.glow, x - ux * 0.15, y - uy * 0.15, ux, uy, detail);
    }
  }

  /** a flash where it struck, and sparks fanning on along the swing */
  private impact(glow: ParticlePool, x: number, y: number, ux: number, uy: number, detail: number): void {
    let p = reset();
    p.x = x;
    p.y = y;
    p.z = 0.45;
    p.life = 0.09;
    p.size0 = 0.75;
    p.size1 = 0.4;
    p.rot = this.rand() * Math.PI;
    p.ramp = Ramp.Flash;
    p.cell = Cell.Star;
    glow.emit(p);
    const along = Math.atan2(uy, ux);
    for (let i = 0, n = Math.max(3, Math.round(9 * detail)); i < n; i++) {
      const a = along + (this.rand() * 2 - 1) * 0.9;
      const v = 3 + this.rand() * 6;
      p = reset();
      p.x = x;
      p.y = y;
      p.z = 0.45;
      p.vx = Math.cos(a) * v;
      p.vy = Math.sin(a) * v + 1;
      p.grav = 12;
      p.drag = 2.5;
      p.life = 0.14 + this.rand() * 0.16;
      p.size0 = 0.12;
      p.size1 = 0.05;
      p.aspect = 0.35;
      p.stretch = 0.03;
      p.ramp = Ramp.Spark;
      p.cell = Cell.Streak;
      glow.emit(p);
    }
  }

  /** The swept sector between two frames' weapon positions, as short streaks along the motion. */
  private smear(a: SwingSegment, b: SwingSegment, glow: ParticlePool, detail: number, reducedMotion: boolean): void {
    const steps = Math.max(1, Math.round((reducedMotion ? 2 : 4) * detail));
    for (let k = 0; k < steps; k++) {
      const u = (k + 0.5) / steps;
      for (const s of ALONG) {
        // the point `s` of the way out the weapon, `u` of the way from last frame's pose to this one's
        const ax = a.hx + (a.tx - a.hx) * s;
        const ay = a.hy + (a.ty - a.hy) * s;
        const bx = b.hx + (b.tx - b.hx) * s;
        const by = b.hy + (b.ty - b.hy) * s;
        const p = reset();
        p.x = ax + (bx - ax) * u;
        p.y = ay + (by - ay) * u;
        p.z = 0.35;
        // a streak along the motion: its velocity sets the stretch; drag stops it at once
        p.vx = (bx - ax) * 6;
        p.vy = (by - ay) * 6;
        p.drag = 30;
        p.life = 0.1 + 0.05 * s;
        p.size0 = 0.07 + 0.07 * s;
        p.size1 = 0.02;
        p.aspect = 0.5;
        p.stretch = 0.05;
        p.alpha = 0.45 + 0.45 * s;
        p.ramp = Ramp.Spark;
        p.cell = Cell.Streak;
        [p.tr, p.tg, p.tb] = TRAIL_TINT;
        glow.emit(p);
      }
    }
  }

  private rand(): number {
    this.seed = (Math.imul(this.seed, 1664525) + 1013904223) >>> 0;
    return this.seed / 4294967296;
  }
}
