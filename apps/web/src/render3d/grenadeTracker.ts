/**
 * Per-grenade visual state behind the 3D frags (grenades.ts): which sample is which grenade from
 * frame to frame, its velocity, the tumble while it flies, rolling and settling on the ground, and
 * the fuse light's blink. Pure logic on the Frame's grenade samples and the collision world.
 *
 * Identity: the sample's id when it has one (snapshots do). Without one, the tick it will blow up
 * on (tick + fuse ticks left) is constant for a grenade's whole life, which tells grenades apart
 * exactly in local mode; the nearest position settles ties (two thrown on the same tick).
 */
import { FRAG } from '@military-forge/content';
import { DT, SegFlag, createRayHit, type CollisionWorld } from '@military-forge/sim';

/** the sim's collision radius (m) */
export const SIM_RADIUS = FRAG.radius;
/** the full fuse, in ticks and seconds */
export const FUSE_TICKS = Math.round(FRAG.fuse / DT);
export const FUSE_SECONDS = FUSE_TICKS * DT;

// ---------- the fuse light ----------

/** blink rate at the throw, Hz (the Forge's fuseLight: 2 → 10 Hz) */
export const FUSE_MIN_HZ = 2;
/**
 * blink rate at detonation, Hz; Reduce motion and Reduce flashes cap it at 3 (docs/11 §5: no
 * flashes > 3 per second), starting from half that so no second ever holds a fourth
 */
export const FUSE_MAX_HZ = 10;
export const FUSE_REDUCED_HZ = 3;

/** the rate at the throw for a `maxHz` cap */
const startHz = (maxHz: number): number => Math.min(FUSE_MIN_HZ, maxHz / 2);
/** the light stays solid for the last moment before the blast */
export const FUSE_SOLID = 0.12;

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Blink rate after `t` s of a `fuse` s fuse: rises with the square of the burnt share. */
export function fuseBlinkHz(t: number, fuse: number, maxHz: number): number {
  const u = clamp01(t / fuse);
  const min = startHz(maxHz);
  return min + (maxHz - min) * u * u;
}

/** Blinks completed after `t` s: the integral of fuseBlinkHz, so the phase never jumps as the rate rises. */
export function fuseBlinkPhase(t: number, fuse: number, maxHz: number): number {
  const c = Math.min(Math.max(t, 0), fuse);
  const min = startHz(maxHz);
  return min * c + ((maxHz - min) * c * c * c) / (3 * fuse * fuse) + Math.max(0, t - fuse) * maxHz;
}

/**
 * Fuse light level 0…1: a dim ember with a pulse at the start of every blink (a raised cosine over
 * the first 40 % of the cycle), solid for the last FUSE_SOLID s.
 */
export function fuseLight(t: number, fuse: number, maxHz: number): number {
  if (t >= fuse - FUSE_SOLID) return 1;
  const f = fuseBlinkPhase(t, fuse, maxHz) % 1;
  const pulse = f < 0.4 ? 0.5 - 0.5 * Math.cos((2 * Math.PI * f) / 0.4) : 0;
  return 0.22 + 0.78 * pulse;
}

// ---------- tracking ----------

export interface GrenadeSample {
  /** stable id (snapshots); local frames may leave it out */
  id?: number;
  x: number;
  y: number;
  /** m/s, when the source knows it */
  vx?: number;
  vy?: number;
  /** ticks left */
  fuse: number;
  /**
   * The grenade type (arsenal-b: 0 frag, 1 smoke, 2 gas, 3 flashbang, 4 mine, 5 EMP). This tracker
   * and grenades.ts draw frags only (type absent or 0); render3d/clouds.ts draws the others.
   */
  type?: number;
}

/** Frags are this module's; every other grenade type is drawn by arsenal-b's clouds.ts. */
export const isFrag = (s: GrenadeSample): boolean => !s.type;

export class GrenadeTrack {
  /** detonation tick (tick + fuse) when matched without ids */
  key = 0;
  id = -1;
  x = 0;
  y = 0;
  vx = 0;
  vy = 0;
  /** frame tick of the last position change */
  tick = 0;
  fuse = 0;
  /** seconds since the last position change (the fuse light runs smoothly between ticks) */
  sinceTick = 0;
  /** tumble angle about the view axis, and its rate */
  angle = 0;
  omega = 0;
  /** touching a floor (or a ceiling, in reversed gravity), and that surface's normal (pointing at the grenade) */
  grounded = false;
  nx = 0;
  ny = 1;
  /** 0 flying … 1 in contact with the ground (eased) */
  contact = 0;
  /** 0 moving … 1 settled upright at rest (eased) */
  rest = 0;
  /** trail emission: where the last puff went, and distance owed to the next */
  trailX = 0;
  trailY = 0;
  trailCarry = 0;
  /** resting wisp timer */
  wisp = 0;
  seed = 0;
  seen = false;

  /** seconds of fuse burnt */
  get fuseT(): number {
    return Math.min(FUSE_SECONDS, (FUSE_TICKS - this.fuse) * DT + Math.min(this.sinceTick, DT));
  }

  get speed(): number {
    return Math.sqrt(this.vx * this.vx + this.vy * this.vy);
  }
}

/** below this the grenade has settled */
const REST_SPEED = 0.35;
/** contact probe below the centre: the radius plus slack for slopes and the 1/1024 m quantisation */
const PROBE = SIM_RADIUS + 0.07;
/** visual roll radius (m, before the readability scale): the frag model's body (W8's old frag, until a model says) */
export const ROLL_RADIUS = 0.046;

const hit = createRayHit();

export class GrenadeTracker {
  readonly tracks: GrenadeTrack[] = [];
  private readonly spare: GrenadeTrack[] = [];
  private nextSeed = 1;

  /** the map's collision (ground contact); `setWorld` on a map change */
  constructor(private world: CollisionWorld) {}

  /** A new map: its collision, and no grenades carried over. */
  setWorld(world: CollisionWorld): void {
    this.world = world;
    for (const t of this.tracks) this.spare.push(t);
    this.tracks.length = 0;
  }

  /**
   * Matches this frame's samples to tracks, then advances each track's motion state by `dt`.
   * `scale` is the drawn size over the model size (the roll rate follows the drawn radius).
   */
  /** the frag model's body radius (m, before the readability scale): the roll keeps pace with it (GrenadeRenderer.setModel) */
  rollRadius = ROLL_RADIUS;

  update(tick: number, samples: readonly GrenadeSample[], dt: number, scale = 1): void {
    for (const t of this.tracks) t.seen = false;
    for (const s of samples) {
      if (!isFrag(s)) continue;
      let t = this.match(tick, s);
      if (!t) {
        t = this.spare.pop() ?? new GrenadeTrack();
        this.start(t, tick, s);
        this.tracks.push(t);
      } else this.advance(t, tick, s);
      t.seen = true;
    }
    for (let i = this.tracks.length - 1; i >= 0; i--) {
      const t = this.tracks[i]!;
      if (t.seen) continue;
      // gone: blown up, or out of view
      this.tracks[i] = this.tracks[this.tracks.length - 1]!;
      this.tracks.pop();
      this.spare.push(t);
    }
    for (const t of this.tracks) this.animate(t, dt, scale);
  }

  private match(tick: number, s: GrenadeSample): GrenadeTrack | null {
    if (s.id !== undefined) {
      // an id comes back for a new grenade once the old one is gone: a fuse that went up is a new one
      for (const t of this.tracks) if (!t.seen && t.id === s.id && s.fuse <= t.fuse) return t;
      return null;
    }
    const key = tick + s.fuse;
    let best: GrenadeTrack | null = null;
    let bestD = 9; // 3 m
    for (const t of this.tracks) {
      if (t.seen || t.id >= 0 || Math.abs(t.key - key) > 6) continue;
      const d = (t.x - s.x) ** 2 + (t.y - s.y) ** 2;
      if (d < bestD) {
        bestD = d;
        best = t;
      }
    }
    return best;
  }

  private start(t: GrenadeTrack, tick: number, s: GrenadeSample): void {
    t.key = tick + s.fuse;
    t.id = s.id ?? -1;
    t.x = t.trailX = s.x;
    t.y = t.trailY = s.y;
    t.vx = s.vx ?? 0;
    t.vy = s.vy ?? 0;
    t.tick = tick;
    t.fuse = s.fuse;
    t.sinceTick = 0;
    t.seed = this.nextSeed++;
    t.angle = (t.seed * 2.399) % (Math.PI * 2); // golden-angle spread: two frags never tumble in step
    t.omega = 0;
    t.grounded = false;
    t.contact = t.rest = 0;
    t.trailCarry = 0;
    t.wisp = 0;
  }

  private advance(t: GrenadeTrack, tick: number, s: GrenadeSample): void {
    if (s.x === t.x && s.y === t.y && s.fuse === t.fuse) return; // nothing new (no tick, or a 30 Hz source)
    let vx = s.vx;
    let vy = s.vy;
    if (vx === undefined || vy === undefined) {
      // average velocity since the last sample: the fuse counts the sim ticks between them exactly
      const span = Math.max(1, t.fuse > s.fuse ? t.fuse - s.fuse : tick - t.tick) * DT;
      vx = (s.x - t.x) / span;
      vy = (s.y - t.y) / span;
    }
    // a bounce flips the tumble and loses some of it (with a little per-grenade variety)
    const before = Math.sqrt(t.vx * t.vx + t.vy * t.vy);
    const after = Math.sqrt(vx * vx + vy * vy);
    if (before > 1.5 && after > 0.5 && (t.vx * vx + t.vy * vy) / (before * after) < 0.85) {
      t.omega = -t.omega * (0.45 + 0.2 * ((t.seed * 0.618) % 1));
    }
    t.vx = vx;
    t.vy = vy;
    t.x = s.x;
    t.y = s.y;
    t.fuse = s.fuse;
    t.key = tick + s.fuse;
    t.tick = tick;
    t.sinceTick = 0;
  }

  private animate(t: GrenadeTrack, dt: number, scale: number): void {
    t.sinceTick += dt;
    const w = this.world;
    // a floor below, or a ceiling above (a frag that came to rest under one in reversed gravity;
    // one-way platforms only catch from above)
    t.grounded = (w.raycast(t.x, t.y, 0, -1, PROBE, 0, hit) && w.ny[hit.seg]! > 0.6) || (w.raycast(t.x, t.y, 0, 1, PROBE, SegFlag.OneWay, hit) && w.ny[hit.seg]! < -0.6);
    if (t.grounded) {
      t.nx = w.nx[hit.seg]!;
      t.ny = w.ny[hit.seg]!;
    }
    const speed = t.speed;
    const resting = t.grounded && speed < REST_SPEED;
    if (!t.grounded) {
      // airborne: tumble end over end in the direction of travel, set by the first real speed
      if (t.omega === 0 && speed > 1) t.omega = -Math.sign(t.vx || 1) * (7 + 0.5 * speed);
    } else if (!resting) {
      // rolling: the drawn body's rim keeps pace with the ground
      const along = t.vx * t.ny - t.vy * t.nx;
      const target = -along / (this.rollRadius * scale);
      t.omega += (target - t.omega) * (1 - Math.exp(-12 * dt));
    } else t.omega *= Math.exp(-8 * dt);
    t.angle = (t.angle + t.omega * dt) % (Math.PI * 2);
    const k = 1 - Math.exp(-dt / 0.06);
    t.contact += ((t.grounded ? 1 : 0) - t.contact) * k;
    t.rest += ((resting ? 1 : 0) - t.rest) * (1 - Math.exp(-dt / 0.12));
  }
}
