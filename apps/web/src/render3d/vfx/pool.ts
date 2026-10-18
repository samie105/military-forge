/**
 * Fixed-capacity particle storage (docs/11 §3: particle pools, no per-frame allocation).
 *
 * One Float32Array, STRIDE floats per particle. Live particles are packed in [0, count): a spawn
 * appends, and an expired particle is replaced by the last live one (swap-remove), so updating and
 * uploading walk one dense range. A full pool refuses new particles (`dropped` counts them): the
 * capacity is the live-particle budget. Long-lived marks (decals) recycle the oldest instead.
 * A tagged pool keeps an integer per particle that moves with it (gunfire: which gun a muzzle
 * flash rides).
 */

/** Field offsets inside a particle's STRIDE floats. */
export const F = {
  x: 0,
  y: 1,
  z: 2,
  vx: 3,
  vy: 4,
  vz: 5,
  age: 6,
  life: 7,
  /** quad width at birth and at death (m); the height is width × aspect */
  size0: 8,
  size1: 9,
  rot: 10,
  spin: 11,
  /** velocity damping, 1/s */
  drag: 12,
  /** downward acceleration, m/s² */
  grav: 13,
  /** colour ramp (ramps.ts) */
  ramp: 14,
  /** peak alpha */
  alpha: 15,
  /** streaks: the quad stretches along the velocity by speed × stretch (s) */
  stretch: 16,
  /** atlas cell; a flipbook adds the frame */
  cell: 17,
  /** 0: in the camera plane (XY); 1: lying on a surface whose normal is (nx, ny) */
  orient: 18,
  nx: 19,
  ny: 20,
  aspect: 21,
  /** share of the life spent fading in */
  fadeIn: 22,
  /** size easing exponent: 1 linear, < 1 grows fast then slows */
  ease: 23,
  /** 1: drawn after the rest of its layer (solid debris in front of smoke) */
  front: 24,
  /** colour multiplier on the ramp (Forge style tints, tracer and flash styles, cosmetic tints) */
  tr: 25,
  tg: 26,
  tb: 27,
} as const;
export const STRIDE = 28;

/** A reusable description of one particle: fill it in, then `emit` it (no allocation per spawn). */
export type ParticleSpec = Record<keyof typeof F, number>;

export function particleSpec(): ParticleSpec {
  return {
    x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, age: 0, life: 1, size0: 1, size1: 1, rot: 0, spin: 0, drag: 0,
    grav: 0, ramp: 0, alpha: 1, stretch: 0, cell: 0, orient: 0, nx: 0, ny: 1, aspect: 1, fadeIn: 0, ease: 1, front: 0,
    tr: 1, tg: 1, tb: 1,
  };
}

export class ParticlePool {
  readonly data: Float32Array;
  /** per-particle tags, kept with their particles through swap-removes (null: an untagged pool) */
  readonly tags: Int32Array | null;
  count = 0;
  /** spawns refused because the pool was full */
  dropped = 0;
  /** live-particle budget (graphics preset), at most `capacity` */
  limit: number;

  constructor(
    readonly capacity: number,
    tagged = false,
  ) {
    this.data = new Float32Array(capacity * STRIDE);
    this.tags = tagged ? new Int32Array(capacity) : null;
    this.limit = capacity;
  }

  /** Adds a particle (with `tag`, in a tagged pool); false when the budget is used up. */
  emit(spec: ParticleSpec, tag = 0): boolean {
    if (this.count >= Math.min(this.limit, this.capacity)) {
      this.dropped++;
      return false;
    }
    if (this.tags) this.tags[this.count] = tag;
    this.write(this.count++ * STRIDE, spec);
    return true;
  }

  /** Adds a particle, overwriting the one nearest the end of its life when full (decals). */
  emitRecycling(spec: ParticleSpec): void {
    if (this.count < Math.min(this.limit, this.capacity)) {
      if (this.tags) this.tags[this.count] = 0;
      this.write(this.count++ * STRIDE, spec);
      return;
    }
    const d = this.data;
    let oldest = 0;
    let most = -Infinity;
    for (let i = 0; i < this.count; i++) {
      const o = i * STRIDE;
      const used = d[o + F.age]! / d[o + F.life]!;
      if (used > most) {
        most = used;
        oldest = i;
      }
    }
    if (this.tags) this.tags[oldest] = 0;
    this.write(oldest * STRIDE, spec);
  }

  /** Explicit stores, not a loop over the keys: this runs for every particle spawned. */
  private write(o: number, s: ParticleSpec): void {
    const d = this.data;
    d[o] = s.x;
    d[o + 1] = s.y;
    d[o + 2] = s.z;
    d[o + 3] = s.vx;
    d[o + 4] = s.vy;
    d[o + 5] = s.vz;
    d[o + 6] = s.age;
    d[o + 7] = s.life;
    d[o + 8] = s.size0;
    d[o + 9] = s.size1;
    d[o + 10] = s.rot;
    d[o + 11] = s.spin;
    d[o + 12] = s.drag;
    d[o + 13] = s.grav;
    d[o + 14] = s.ramp;
    d[o + 15] = s.alpha;
    d[o + 16] = s.stretch;
    d[o + 17] = s.cell;
    d[o + 18] = s.orient;
    d[o + 19] = s.nx;
    d[o + 20] = s.ny;
    d[o + 21] = s.aspect;
    d[o + 22] = s.fadeIn;
    d[o + 23] = s.ease;
    d[o + 24] = s.front;
    d[o + 25] = s.tr;
    d[o + 26] = s.tg;
    d[o + 27] = s.tb;
  }

  /** Ages, moves and expires particles. */
  update(dt: number): void {
    const d = this.data;
    for (let i = 0; i < this.count; ) {
      const o = i * STRIDE;
      const age = d[o + F.age]! + dt;
      if (age >= d[o + F.life]!) {
        this.remove(i);
        continue; // the swapped-in particle is updated at this index
      }
      d[o + F.age] = age;
      const drag = d[o + F.drag]!;
      if (drag > 0) {
        const k = Math.exp(-drag * dt);
        d[o + F.vx]! *= k;
        d[o + F.vy]! *= k;
        d[o + F.vz]! *= k;
      }
      d[o + F.vy]! -= d[o + F.grav]! * dt;
      d[o + F.x]! += d[o + F.vx]! * dt;
      d[o + F.y]! += d[o + F.vy]! * dt;
      d[o + F.z]! += d[o + F.vz]! * dt;
      d[o + F.rot]! += d[o + F.spin]! * dt;
      i++;
    }
  }

  /** Swap-remove: the last live particle takes slot i. */
  remove(i: number): void {
    const last = --this.count;
    if (i === last) return;
    this.data.copyWithin(i * STRIDE, last * STRIDE, last * STRIDE + STRIDE);
    if (this.tags) this.tags[i] = this.tags[last]!;
  }

  clear(): void {
    this.count = 0;
  }
}
