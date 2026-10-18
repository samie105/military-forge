/**
 * The dash in 3D (docs/02 §21: the mechanics' 8-way jetpack burst):
 * - a jet kick where it starts: a hot flash at the nozzles, a ring of air punched out, and
 *   exhaust puffs blown back against the dash;
 * - speed lines streaming off the body while it lasts;
 * - afterimages of the character fading behind it (Medium and High, dashGhosts.ts, driven by
 *   Renderer3D from the final pose).
 * Your own dash is cool blue and others' warm orange, the 2D overlay's colours; its band stays for
 * the debug view (H) and ?render=2d.
 */
import { DASH_DX, DASH_DY, type SimEvent } from '@military-forge/sim';
import { Color } from 'three';
import type { Frame } from '../../view';
import { Cell } from './atlas';
import type { DashGhosts, GhostSource } from './dashGhosts';
import type { VfxContext, VfxModule } from './index';
import { particleSpec, type ParticleSpec } from './pool';
import { Ramp } from './ramps';

/** jetpack nozzles above the feet (m) */
const PACK_Y = 0.85;
/** speed lines per second off a dashing body (× the preset's detail) */
export const LINES_PER_S = 110;
/** linear-light tints: own dash, anyone else's */
export const DASH_TINT = { local: [0.45, 0.68, 1] as const, other: [1, 0.55, 0.25] as const };
const GHOST_TINT = { local: new Color().setRGB(...DASH_TINT.local), other: new Color().setRGB(...DASH_TINT.other) };

/** A character's meshes by player id (Renderer3D: the drawn avatars), for afterimages. */
export type BodyLookup = (player: number) => GhostSource | null;

const spec: ParticleSpec = particleSpec();
const base = particleSpec();
const reset = (): ParticleSpec => Object.assign(spec, base);

export class DashFx implements VfxModule {
  /** the local player (Vfx.update, from the drawn frame) */
  localId = -1;
  private seed = 7;
  /** per player: the fraction of a speed line owed (no allocation once each id has its slot) */
  private readonly owed = new Map<number, number>();
  /** per player: seconds since its last afterimage */
  private readonly sinceGhost = new Map<number, number>();

  constructor(
    private readonly ghosts: DashGhosts,
    private readonly bodies: BodyLookup = () => null,
  ) {}

  private rand(): number {
    this.seed = (Math.imul(this.seed, 1664525) + 1013904223) >>> 0;
    return this.seed / 4294967296;
  }

  onEvents(events: readonly SimEvent[], fx: VfxContext): void {
    for (const e of events) if (e.type === 'dash') this.burst(fx, e.x, e.y, DASH_DX[e.dir] ?? 1, DASH_DY[e.dir] ?? 0, e.player === this.localId);
  }

  /** Speed lines and afterimages for everyone dashing; call it after the avatars are posed. */
  update(frame: Frame, dt: number, fx: VfxContext): void {
    this.ghosts.update(dt);
    const every = this.ghosts.every;
    for (const p of frame.players) {
      const speed = Math.sqrt(p.vx * p.vx + p.vy * p.vy); // every player, every frame: no hypot (it allocates)
      if (!p.alive || !p.dashing || speed < 2) {
        if (this.owed.has(p.id)) this.owed.set(p.id, 0);
        if (this.sinceGhost.has(p.id)) this.sinceGhost.set(p.id, Infinity);
        continue;
      }
      let owed = (this.owed.get(p.id) ?? 0) + LINES_PER_S * fx.detail * dt;
      for (; owed >= 1; owed--) this.line(fx, p.x, p.y, p.vx / speed, p.vy / speed, p.isLocal);
      this.owed.set(p.id, owed);
      // an afterimage from the start of the dash, then every `every` s while it lasts
      if (this.ghosts.max <= 0) continue;
      const since = (this.sinceGhost.get(p.id) ?? Infinity) + dt;
      if (since < every) {
        this.sinceGhost.set(p.id, since);
        continue;
      }
      const body = this.bodies(p.id);
      if (body) this.ghosts.snap(body, p.isLocal ? GHOST_TINT.local : GHOST_TINT.other);
      // keep the cadence across frames (the first one of a dash starts it)
      this.sinceGhost.set(p.id, since === Infinity ? 0 : Math.min(since - every, every));
    }
  }

  /** The kick where a dash starts: (x, y) the feet, (ux, uy) its direction. */
  private burst(fx: VfxContext, x: number, y: number, ux: number, uy: number, local: boolean): void {
    const bx = x - ux * 0.2;
    const by = y + PACK_Y - uy * 0.2;
    const [tr, tg, tb] = local ? DASH_TINT.local : DASH_TINT.other;
    // a hot flash at the nozzles
    let p = reset();
    p.x = bx;
    p.y = by;
    p.z = 0.1;
    p.life = 0.12;
    p.size0 = 0.8;
    p.size1 = 1.3;
    p.ramp = Ramp.Fire;
    p.cell = Cell.Glow;
    fx.glow.emit(p);
    // a ring of air punched out where it starts, in the dasher's colour
    p = reset();
    p.x = x;
    p.y = y + 0.75;
    p.z = 0.05;
    p.life = 0.24;
    p.size0 = 0.6;
    p.size1 = 2.4;
    p.ease = 0.45;
    p.alpha = 0.75;
    p.ramp = Ramp.Haze;
    p.cell = Cell.Ring;
    p.tr = tr;
    p.tg = tg;
    p.tb = tb;
    fx.glow.emit(p);
    // exhaust blown back against the dash
    const n = Math.max(3, Math.round(7 * fx.detail));
    const back = Math.atan2(-uy, -ux);
    for (let i = 0; i < n; i++) {
      const a = back + (this.rand() - 0.5) * 1.3;
      const s = 2.5 + 3 * this.rand();
      p = reset();
      p.x = bx;
      p.y = by;
      p.z = (this.rand() - 0.5) * 0.6;
      p.vx = Math.cos(a) * s;
      p.vy = Math.sin(a) * s + 0.4;
      p.drag = 5;
      p.life = 0.45 + 0.35 * this.rand();
      p.size0 = 0.22;
      p.size1 = 0.75;
      p.ease = 0.6;
      p.rot = this.rand() * Math.PI * 2;
      p.spin = (this.rand() - 0.5) * 2;
      p.fadeIn = 0.1;
      p.ramp = Ramp.Trail;
      p.cell = Cell.Puff;
      fx.smoke.emit(p);
    }
  }

  /** A speed line off a dashing body at (x, y), moving along (ux, uy): left behind as it goes. */
  private line(fx: VfxContext, x: number, y: number, ux: number, uy: number, local: boolean): void {
    const [tr, tg, tb] = local ? DASH_TINT.local : DASH_TINT.other;
    const p = reset();
    // across the body (perpendicular to the dash), from a little ahead of the centre to behind it
    const across = (this.rand() - 0.5) * 1.1;
    const along = 0.3 - 0.6 * this.rand();
    p.x = x + ux * along - uy * across;
    p.y = y + 0.75 + uy * along + ux * across;
    p.z = -0.35 + 0.8 * this.rand();
    p.life = 0.16 + 0.1 * this.rand();
    p.size0 = 0.7 + 0.6 * this.rand();
    p.size1 = p.size0 * 1.5;
    p.aspect = 0.07;
    p.rot = Math.atan2(uy, ux);
    p.alpha = 1;
    p.ramp = Ramp.Haze;
    p.cell = Cell.Streak;
    p.tr = tr;
    p.tg = tg;
    p.tb = tb;
    fx.smoke.emit(p);
  }
}
