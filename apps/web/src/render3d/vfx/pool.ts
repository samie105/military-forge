/**
 * Fixed-capacity particle storage (docs/11 §3: particle pools, no per-frame allocation).
 *
 * One Float32Array, STRIDE floats per particle. Live particles are packed in [0, count): a spawn
 * appends, and an expired particle is replaced by the last live one (swap-remove), so updating and
 * uploading walk one dense range. A full pool refuses new particles (`dropped` counts them): the
 * capacity is the live-particle budget. Long-lived marks (decals) recycle the oldest instead.
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
  /** colour multiplier on the ramp (Forge style tints, cosmetic tints) */
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

const KEYS = Object.keys(F) as (keyof typeof F)[];

export class ParticlePool {
  readonly data: Float32Array;
  count = 0;
  /** spawns refused because the pool was full */
  dropped = 0;
  /** live-particle budget (graphics preset), at most `capacity` */
  limit: number;

  constructor(readonly capacity: number) {
    this.data = new Float32Array(capacity * STRIDE);
    this.limit = capacity;
  }

  /** Adds a particle; false when the budget is used up. */
  emit(spec: ParticleSpec): boolean {
    if (this.count >= Math.min(this.limit, this.capacity)) {
      this.dropped++;
      return false;
    }
    this.write(this.count++ * STRIDE, spec);
    return true;
  }

  /** Adds a particle, overwriting the one nearest the end of its life when full (decals). */
  emitRecycling(spec: ParticleSpec): void {
    if (this.count < Math.min(this.limit, this.capacity)) {
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
    this.write(oldest * STRIDE, spec);
  }

  private write(o: number, spec: ParticleSpec): void {
    const d = this.data;
    for (const k of KEYS) d[o + F[k]] = spec[k];
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
    if (i !== last) this.data.copyWithin(i * STRIDE, last * STRIDE, last * STRIDE + STRIDE);
  }

  clear(): void {
    this.count = 0;
  }
}
