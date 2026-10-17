/**
 * Seeded, deterministic random numbers. The sim never calls Math.random (docs/02 §15):
 * the same seed must give the same sequence on every JS engine, so client prediction
 * and the authoritative server agree on things like weapon spread.
 */

/** splitmix32: expands one 32-bit seed into a stream of well-mixed 32-bit values. */
export function splitmix32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x9e3779b9) >>> 0;
    let z = state;
    z = Math.imul(z ^ (z >>> 16), 0x85ebca6b);
    z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35);
    return (z ^ (z >>> 16)) >>> 0;
  };
}

function rotl(x: number, k: number): number {
  return ((x << k) | (x >>> (32 - k))) >>> 0;
}

/** xoshiro128** — small, fast, good statistical quality, 32-bit integer only. */
export class Xoshiro128 {
  private a = 0;
  private b = 0;
  private c = 0;
  private d = 0;

  constructor(seed: number) {
    this.seed(seed);
  }

  seed(seed: number): void {
    const next = splitmix32(seed);
    this.a = next();
    this.b = next();
    this.c = next();
    this.d = next();
    if ((this.a | this.b | this.c | this.d) === 0) this.a = 1; // all-zero state is a fixed point
  }

  nextU32(): number {
    const result = Math.imul(rotl(Math.imul(this.b, 5) >>> 0, 7), 9) >>> 0;
    const t = (this.b << 9) >>> 0;
    this.c = (this.c ^ this.a) >>> 0;
    this.d = (this.d ^ this.b) >>> 0;
    this.b = (this.b ^ this.c) >>> 0;
    this.a = (this.a ^ this.d) >>> 0;
    this.c = (this.c ^ t) >>> 0;
    this.d = rotl(this.d, 11);
    return result;
  }

  /** Uniform float in [0, 1). */
  nextFloat(): number {
    return this.nextU32() / 4294967296;
  }

  /** Uniform float in [min, max). */
  range(min: number, max: number): number {
    return min + (max - min) * this.nextFloat();
  }

  /** Uniform integer in [0, maxExclusive). */
  int(maxExclusive: number): number {
    return Math.floor(this.nextFloat() * maxExclusive);
  }

  getState(): [number, number, number, number] {
    return [this.a, this.b, this.c, this.d];
  }

  setState(state: readonly [number, number, number, number]): void {
    [this.a, this.b, this.c, this.d] = state.map((v) => v >>> 0) as [number, number, number, number];
  }
}

/** murmur3-style mixing step. */
export function mix32(hash: number, value: number): number {
  let k = Math.imul(value | 0, 0xcc9e2d51);
  k = (k << 15) | (k >>> 17);
  k = Math.imul(k, 0x1b873593);
  let h = hash ^ k;
  h = (h << 13) | (h >>> 19);
  return (Math.imul(h, 5) + 0xe6546b64) | 0;
}

/** murmur3 finaliser: avalanches all bits. */
export function fmix32(hash: number): number {
  let h = hash;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/**
 * Stateless hash of four integers, e.g. (roomSeed, tick, shooterId, shotIndex) for weapon
 * spread. Stateless means a client re-simulating a past tick gets the identical value.
 */
export function hash4(a: number, b: number, c: number, d: number): number {
  let h = 0x9747b28c;
  h = mix32(h, a);
  h = mix32(h, b);
  h = mix32(h, c);
  h = mix32(h, d);
  return fmix32(h ^ 16);
}

/** Maps a 32-bit hash to [0, 1). */
export function hashToUnit(hash: number): number {
  return (hash >>> 0) / 4294967296;
}
