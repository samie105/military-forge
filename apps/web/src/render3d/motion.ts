/**
 * Procedural body motion on top of the locomotion clips ("how he should bend"), applied after the mixer and
 * before the aim layer (animation-avatar-split.md):
 * - **Lean:** the body tilts with speed and acceleration in the gameplay plane: a fast run leans ~13° forward,
 *   a slow walk stays upright, braking or reversing leans back for a moment, turning around banks into the
 *   turn. In the air it leans with the velocity, and a little more into the horizontal jet direction. Split
 *   between the whole body (about the feet), the spine, and a counter-turn of the neck so the head stays
 *   steadier. Everything is smoothed by critically damped springs.
 * - **Landing squash** scaled by the impact speed (the land clip itself plays in locomotion.ts): the hips drop and
 *   the knees take it (`drop`, applied by the planted-feet pass), no scaling.
 * - **Launch flail** above `launchSpeedX` (a blast launch, NOTES §17): arms out and flapping, legs kicking,
 *   the body tumbling slowly with the velocity; it recovers on landing.
 * - **Dash pose** (the sim's 8-way dash, docs/02 §21): stretched along a sideways dash, tucked for an up-dash,
 *   a slam for a down-dash. The dash streak and afterimages are render3d-b's (vfx/dash.ts, from PlayerView.dashing).
 * - **Hit reactions** from the sim's hit events (`hit()`): a flinch away from the shot sized by the damage and the
 *   weapon's class (a pistol twitches, a shotgun or sniper staggers), a head snap on a headshot, a torso twist for a
 *   hit from behind, the knees giving on a hard hit, more of all of it in the air. A quarter of a second, render only.
 * Every bone it turns is in `bones`, which the avatar adds to its `posed` restore list. Arms the aim layer holds a
 * gun with keep their aim through all of it.
 */
import { DamageSource, type SimEvent } from '@military-forge/sim';
import { HitZone, defaultTuning, weapons } from '@military-forge/content';
import { Quaternion, Vector3, type Object3D } from 'three';
import type { CharacterInstance } from './character';
import { rotateWorld } from './ik';
import { Spring, type LocoLayer } from './locomotion';

const DEG = Math.PI / 180;

export const LEAN = {
  /** ground: forward lean at full run (rad) and the speed band it builds over (m/s) */
  run: 13 * DEG,
  from: 1.2,
  to: 5,
  /** running backwards (aiming the other way) leans less */
  backwards: 0.5,
  /** lean per m/s² of acceleration, capped: braking and reversing tip the body back briefly */
  perAccel: 0.85 * DEG,
  accelMax: 14 * DEG,
  /** the ground lean never goes past this either way */
  groundMax: 22 * DEG,
  /** air: lean per m/s of horizontal speed, capped, plus a nudge into the jet direction */
  airPerSpeed: 2.2 * DEG,
  airMax: 16 * DEG,
  jet: 5 * DEG,
  /** bank into a facing turn: per (rad/s of yaw × m/s of speed), capped */
  bankPer: 0.004,
  bankMax: 9 * DEG,
  /** shares of the tilt: whole body about the feet, lower spine, upper spine; the neck takes back this much */
  shares: [0.45, 0.3, 0.25] as const,
  neckCounter: 0.35,
  /** spring frequencies (rad/s): the lean itself, the velocity filter that gives the acceleration */
  omega: 16,
  velocityOmega: 9,
};

export const SQUASH = {
  /** impact speed (m/s) below which a landing doesn't squash, and the speed of the deepest squash */
  from: 2.5,
  to: 16,
  /** deepest squash: the body's height shrinks by this share, its width grows to keep the volume */
  max: 0.14,
  omega: 26,
  damping: 0.38,
};

export const FLAIL = {
  /** hysteresis: flailing stops in the air once the speed drops below this share of launchSpeedX */
  release: 0.6,
  omega: 16,
  /** tumble rate per m/s of horizontal speed (rad/s), and its cap (rad) */
  tumblePerSpeed: 0.08,
  tumbleMax: 75 * DEG,
  armOut: 72 * DEG,
  armFlap: 28 * DEG,
  flapRate: 15,
  legKick: 38 * DEG,
  kneeBend: 55 * DEG,
  kickRate: 12,
};

export const HIT = {
  /** the damage of a full-sized hit (the Widow's body shot is 75) */
  damageFull: 60,
  /** how hard each kind of source hits, × damage / damageFull (weapon classes, then the other sources) */
  classes: {
    sidearm: 0.6,
    smg: 0.5,
    rifle: 0.75,
    dmr: 0.95,
    shotgun: 1.4,
    sniper: 1.35,
    heavy: 1.0,
    launcher: 1.3,
    special: 1.0,
    melee: 1.1,
    grenade: 1.3,
    mine: 1.3,
    gas: 0.25,
    world: 0.5,
  } as Record<string, number>,
  /** the smallest reaction a hit shows, and the most a frame's hits add up to */
  min: 0.12,
  max: 1.5,
  /** at size 1: the torso's flinch away from the shot, the head's snap on a headshot, the twist from behind (rad) */
  flinch: 15 * DEG,
  head: 20 * DEG,
  twist: 20 * DEG,
  /** at size 1 on the ground: the knees give this much (m, the hips drop) */
  buckle: 0.07,
  /** the head snap and the twist from behind show at least this size: they say where a hit came from */
  cue: 0.45,
  /** in the air: everything this much bigger, and the whole body turns with the flinch rather than the spine alone */
  air: 1.6,
  /** how fast a reaction plays out (critically damped, rad/s): it peaks after 1/ω (45 ms) and is gone in ~0.25 s */
  omega: 22,
  /** Reduce motion: reactions this much of their size */
  reduced: 0.3,
};

/**
 * How big a hit looks (0 … HIT.max): `damage` against a full-sized hit, scaled by what dealt it (`source`: a weapon
 * index or a DamageSource).
 */
export function hitSize(damage: number, source: number): number {
  const kind =
    source === DamageSource.Grenade ? 'grenade' : source === DamageSource.Mine ? 'mine' : source === DamageSource.Gas ? 'gas' : source === DamageSource.Melee ? 'melee' : source === DamageSource.World ? 'world' : (weapons[source]?.class ?? 'rifle');
  const size = (HIT.classes[kind] ?? 0.75) * (damage / HIT.damageFull);
  return Math.min(HIT.max, Math.max(HIT.min, size));
}

/** What one hit event shows on its target. */
export interface HitReaction {
  target: number;
  /** the way the shot travelled (unit), or 0, 0 */
  dirX: number;
  dirY: number;
  size: number;
  zone: number;
}

/**
 * The reactions a batch of sim events calls for (local play: each tick's; online: as the remote timeline releases
 * them). The way each hit travelled comes from its bullet's shot or ricochet event, a grenade or mine's blast, or
 * else from the attacker toward the target; `chestOf` gives a player's chest, or null when it isn't drawn.
 */
export function hitReactions(events: readonly SimEvent[], chestOf: (id: number) => { x: number; y: number } | null): HitReaction[] {
  const out: HitReaction[] = [];
  const used = new Set<number>();
  for (const e of events) {
    if (e.type !== 'hit') continue;
    let dx = 0;
    let dy = 0;
    const target = chestOf(e.target);
    if (e.source < DamageSource.Mine) {
      // the bullet (or pellet) that struck: its shot, or the ricochet that brought it
      const i = events.findIndex((s, k) => !used.has(k) && (s.type === 'shot' || s.type === 'ricochet') && s.shooter === e.attacker && s.hit === 2 && s.target === e.target);
      const s = events[i];
      if (s?.type === 'shot') [dx, dy] = [s.ex - s.ox, s.ey - s.oy];
      else if (s?.type === 'ricochet') [dx, dy] = [s.ex - s.x, s.ey - s.y];
      if (s) used.add(i);
    } else if ((e.source === DamageSource.Grenade || e.source === DamageSource.Mine) && target) {
      // away from the nearest blast
      let best = Infinity;
      for (const b of events)
        if (b.type === 'explosion') {
          const d = Math.hypot(target.x - b.x, target.y - b.y);
          if (d < best) [best, dx, dy] = [d, target.x - b.x, target.y - b.y];
        }
    }
    if (dx === 0 && dy === 0 && target && e.attacker !== e.target) {
      const from = chestOf(e.attacker);
      if (from) [dx, dy] = [target.x - from.x, target.y - from.y];
    }
    const len = Math.hypot(dx, dy);
    out.push({ target: e.target, dirX: len > 1e-6 ? dx / len : 0, dirY: len > 1e-6 ? dy / len : 0, size: hitSize(e.damage, e.source), zone: e.zone });
  }
  return out;
}

export const DASH = {
  /** the sim's burst (docs/02 §21: 8 ticks at 60 Hz) */
  seconds: 8 / 60,
  /** a dash is 14 m/s, past launchSpeedX: no launch flail starts during one or this long after (s), while the
   *  sim caps the exit speed (review M2) */
  flailGrace: 0.15,
  omegaIn: 40,
  omegaOut: 16,
  /** tilt of the whole body toward a sideways dash */
  tilt: 34 * DEG,
};

/** A dash in progress, for the pose and the VFX: unit direction (8-way) and progress 0..1 over the burst. */
export interface DashPose {
  active: boolean;
  dirX: number;
  dirY: number;
  t: number;
}

/** What motion reads from a player view. `dashing` comes with the sim's dash (PlayerView.dashing, PR #36). */
export interface MotionInput {
  grounded: boolean;
  crouched: boolean;
  jetting: boolean;
  vx: number;
  vy: number;
  aim: number;
  dashing?: boolean;
  /** deaths so far (PlayerView.deaths): a change is a respawn, which starts every motion afresh */
  deaths?: number;
}


/** Underdamped spring (the squash bounce): semi-implicit Euler in ≤ 4 ms steps. */
class Bounce {
  x = 0;
  v = 0;
  constructor(
    readonly omega: number,
    readonly damping: number,
  ) {}

  step(dt: number): number {
    for (let left = dt; left > 1e-6; left -= 0.004) {
      const h = Math.min(0.004, left);
      this.v += (-this.omega * this.omega * this.x - 2 * this.damping * this.omega * this.v) * h;
      this.x += this.v * h;
    }
    return this.x;
  }
}

const smoothstep = (e0: number, e1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Forward lean (rad, + toward +x) the body settles at on the ground for velocity `vx` and acceleration `ax`. */
export function groundLean(vx: number, ax: number, facing: 1 | -1): number {
  const speed = Math.abs(vx);
  const backwards = vx * facing < 0 ? LEAN.backwards : 1;
  const run = Math.sign(vx) * LEAN.run * smoothstep(LEAN.from, LEAN.to, speed) * backwards;
  return clamp(run + clamp(ax * LEAN.perAccel, -LEAN.accelMax, LEAN.accelMax), -LEAN.groundMax, LEAN.groundMax);
}

/** The lean in the air: with the velocity, a little more into the jet's horizontal direction. */
export function airLean(vx: number, jetting: boolean): number {
  const lean = clamp(vx * LEAN.airPerSpeed, -LEAN.airMax, LEAN.airMax);
  return lean + (jetting ? Math.sign(vx) * LEAN.jet * Math.min(1, Math.abs(vx) / 2) : 0);
}

/** Height share the body loses at the bottom of a landing squash, for an impact at `speed` m/s (≥ 0). */
export function squashDepth(speed: number): number {
  return SQUASH.max * smoothstep(SQUASH.from, SQUASH.to, speed);
}

const Z = new Vector3(0, 0, 1);
const _q = new Quaternion();
const _axis = new Vector3();


export class MotionLayer {
  /** bones this layer turns (the avatar restores them to the animation pose every frame) */
  readonly bones: Object3D[];
  /** current tilt toward +x (rad) */
  lean = 0;
  /** blast-launch flail weight, 0..1 */
  flail = 0;
  /** landing squash: < 0 squashed, > 0 stretched (share of the height) */
  squash = 0;
  readonly dash: DashPose = { active: false, dirX: 1, dirY: 0, t: 0 };
  /** blasts launch players above this horizontal speed (tuning `launchSpeedX`) */
  launchSpeedX = defaultTuning.launchSpeedX;

  private readonly b: Record<string, Object3D | null>;
  private readonly velocity = new Spring(0, LEAN.velocityOmega);
  private readonly leanSpring = new Spring(0, LEAN.omega);
  private readonly bank = new Spring(0, 10);
  private readonly flailSpring = new Spring(0, FLAIL.omega);
  private readonly dashSpring = new Spring(0, DASH.omegaIn);
  private readonly bounce = new Bounce(SQUASH.omega, SQUASH.damping);
  /** hit reactions: the flinch (rad, + top toward +x), the head's snap and the torso's twist (rad), the knees giving (m) */
  private readonly flinch = new Spring(0, HIT.omega);
  private readonly headSnap = new Spring(0, HIT.omega);
  private readonly twist = new Spring(0, HIT.omega);
  private readonly buckle = new Spring(0, HIT.omega);
  /** the hits landed since the last update */
  private readonly pending = { dirX: 0, dirY: 0, size: 0, head: false, legs: false };
  private reactAir = 0;
  private flailing = false;
  private tumble = 0;
  private time: number;
  private dashTime = 0;
  private lastYaw: number | null = null;
  private first = true;
  private sinceDash = Infinity;
  private deaths: number | undefined;
  /** the head's rest height (m): a squash lowers it by `squash` of this */
  private readonly height: number;


  constructor(
    inst: Pick<CharacterInstance, 'root' | 'bone'>,
    seed = 0,
  ) {
    const names = ['root', 'pelvis', 'spine1', 'spine2', 'neck', 'head', 'thigh_L', 'thigh_R', 'calf_L', 'calf_R', 'foot_L', 'foot_R', 'upperarm_L', 'upperarm_R', 'forearm_L', 'forearm_R'];
    this.b = Object.fromEntries(names.map((n) => [n, inst.bone(n)]));
    this.bones = names.map((n) => this.b[n]).filter((o): o is Object3D => !!o);
    this.time = (seed * 0.61) % 10;
    const head = inst.bone('head');
    inst.root.updateMatrixWorld(true);
    this.height = head ? inst.root.worldToLocal(head.getWorldPosition(new Vector3())).y : 1;
  }

  /**
   * How far (m) a landing squash lowers the hips now. The planted-feet pass takes it (FootPlanter `drop`): the knees
   * bend and the feet stay on the ground. A squash used to scale the whole body, which skewed the aim (review M1).
   */
  get drop(): number {
    return Math.max(0, -this.squash) * this.height + Math.max(0, this.buckle.x);
  }

  /**
   * A hit landed (the sim's hit event). `dirX, dirY`: the way the shot travelled (a unit vector, or 0, 0 when it has
   * none, as for gas); `size` from hitSize, already scaled for Reduce motion; `zone`: the sim's HitZone. Hits in one
   * frame add up (a shotgun's pellets) to HIT.max, and play from the next update.
   */
  hit(dirX: number, dirY: number, size: number, zone: number): void {
    const q = this.pending;
    q.dirX += dirX * size;
    q.dirY += dirY * size;
    q.size = Math.min(HIT.max, q.size + size);
    if (zone === HitZone.Head) q.head = true;
    if (zone === HitZone.Legs) q.legs = true;
  }

  /** how much a reaction shows right now (0 … ~HIT.max): tests, and whoever wants to know */
  get reacting(): number {
    return Math.max(Math.abs(this.flinch.x) / HIT.flinch, Math.abs(this.headSnap.x) / HIT.head, Math.abs(this.twist.x) / HIT.twist);
  }

  /** Everything at rest: no lean, squash, flail or dash (a respawn; review L5). */
  reset(): void {
    for (const spring of [this.velocity, this.leanSpring, this.bank, this.flailSpring, this.dashSpring, this.flinch, this.headSnap, this.twist, this.buckle]) spring.x = spring.v = 0;
    this.pending.size = 0;
    this.bounce.x = this.bounce.v = 0;
    this.lean = this.flail = this.squash = this.tumble = 0;
    this.flailing = false;
    this.dash.active = false;
    this.sinceDash = Infinity;
    this.lastYaw = null;
    this.first = true;
  }

  /**
   * After the mixer and the facing turn, before the aim layer. `yaw` is the body's current yaw; `holdLean` (rad, +
   * into the gun) is the spine lean the aim layer adds for the held weapon (holds.ts): the run's spine lean gives way
   * to it, so the two don't add up (review L6). `held`: the arms the aim layer holds a gun or shield with. They keep
   * the pose the aim layer gave them, pointing the same way in the world however the body leans, tumbles or dashes,
   * so the gun stays at the hand the aim pose put it in (and the muzzle with it).
   */
  update(p: MotionInput, dt: number, yaw: number, loco: Pick<LocoLayer, 'landing'>, holdLean = 0, held: readonly ('L' | 'R')[] = []): void {
    if (p.deaths !== undefined && this.deaths !== undefined && p.deaths !== this.deaths) this.reset();
    this.deaths = p.deaths;
    this.time += dt;
    const facing: 1 | -1 = Math.cos(p.aim) >= 0 ? 1 : -1;
    if (this.first) {
      this.velocity.x = p.vx;
      this.first = false;
    }
    // acceleration from a smoothed velocity: per-frame differences of vx are too noisy to lean on
    this.velocity.step(p.vx, dt);
    const ax = this.velocity.v;
    const target = p.grounded ? groundLean(p.vx, ax, facing) : airLean(p.vx, p.jetting);
    this.lean = this.leanSpring.step(target, dt);
    const yawRate = this.lastYaw === null || dt <= 0 ? 0 : (yaw - this.lastYaw) / dt;
    this.lastYaw = yaw;
    const bank = this.bank.step(p.grounded ? clamp(yawRate * Math.abs(p.vx) * LEAN.bankPer, -LEAN.bankMax, LEAN.bankMax) : 0, dt);

    // landing squash: kick the bounce down in proportion to the impact
    if (loco.landing > 0) {
      const depth = squashDepth(loco.landing);
      // from rest, the deepest point of the bounce is 0.615 v/ω at this damping: kick so it reaches `depth`
      if (depth > 0) this.bounce.v = (-depth * SQUASH.omega) / 0.615;
    }
    this.squash = this.bounce.step(dt);
    if (Math.abs(this.squash) < 1e-4 && Math.abs(this.bounce.v) < 1e-3) this.squash = this.bounce.x = this.bounce.v = 0;

    // blast launch: flail above launchSpeedX in the air, until landing (or the flight slows right down). A dash
    // is faster still, but it's the player's own move: not during one, nor on its way out
    const speed = Math.abs(p.vx);
    this.sinceDash = p.dashing ? 0 : this.sinceDash + dt;
    if (!p.grounded && speed > this.launchSpeedX && this.sinceDash > DASH.flailGrace) this.flailing = true;
    if (p.grounded || speed < this.launchSpeedX * FLAIL.release) this.flailing = false;
    this.flail = this.flailSpring.step(this.flailing ? 1 : 0, dt);
    this.tumble = this.flailing
      ? clamp(this.tumble - p.vx * FLAIL.tumblePerSpeed * dt, -FLAIL.tumbleMax, FLAIL.tumbleMax)
      : this.tumble * Math.exp(-dt * 8);

    // dash: the burst's direction is its velocity (14 m/s along one of 8 directions, no gravity)
    const dashing = !!p.dashing;
    if (dashing && !this.dash.active) this.dashTime = 0;
    if (dashing && Math.hypot(p.vx, p.vy) > 2) {
      const len = Math.hypot(p.vx, p.vy);
      this.dash.dirX = p.vx / len;
      this.dash.dirY = p.vy / len;
    }
    this.dash.active = dashing;
    this.dashTime += dt;
    this.dash.t = Math.min(1, this.dashTime / DASH.seconds);
    this.dashSpring.omega = dashing ? DASH.omegaIn : DASH.omegaOut;
    const dashW = this.dashSpring.step(dashing ? 1 : 0, dt);

    // hit reactions: the frame's hits kick critically damped springs (a quick rise, gone in a quarter of a second)
    const q = this.pending;
    if (q.size > 0) {
      const air = p.grounded ? 1 : HIT.air;
      const size = q.size * air;
      const len = Math.hypot(q.dirX, q.dirY);
      const dx = len > 1e-6 ? q.dirX / len : 0;
      const dy = len > 1e-6 ? q.dirY / len : 0;
      // the critically damped spring kicked with v peaks at v / (ω e): kick so it peaks at the reaction's size
      const kick = (spring: Spring, peak: number) => (spring.v += peak * HIT.omega * Math.E);
      kick(this.flinch, dx * size * HIT.flinch);
      // a headshot snaps the head along the shot: back when shot from the front, forward from behind
      const along = dx * facing; // + the shot travels the way he faces (from behind)
      // the snap and the twist say where a hit came from, so even a small one shows them a little
      const cue = Math.max(size, HIT.cue);
      if (q.head) kick(this.headSnap, (along >= 0 ? 1 : -1) * cue * HIT.head);
      // from behind, the torso twists round toward the hit
      if (along > 0.3) kick(this.twist, (dy >= 0 ? 1 : -1) * facing * cue * HIT.twist * along);
      // the knees give on a hard hit on the ground, and on any leg hit
      if (p.grounded) kick(this.buckle, size * HIT.buckle * (q.legs ? 1.5 : 0.6) * Math.min(1, size));
      this.reactAir = air > 1 ? 1 : 0;
      q.dirX = q.dirY = q.size = 0;
      q.head = q.legs = false;
    }
    for (const spring of [this.flinch, this.headSnap, this.twist, this.buckle]) spring.step(0, dt);

    this.pose(yaw, facing, bank, dashW, holdLean, held);
  }

  private pose(yaw: number, facing: 1 | -1, bank: number, dashW: number, holdLean: number, held: readonly ('L' | 'R')[]): void {
    const b = this.b;
    const flail = this.flail;
    // the held arms' turn in the world as the aim layer posed them, before the body moves under them
    for (const side of held) b[`upperarm_${side}`]?.getWorldQuaternion(_heldArm[side]);
    // the body's left (+X of an upright bone) and forward, in world space
    const lat = _axis.set(Math.cos(yaw), 0, -Math.sin(yaw));
    const h = this.dash.dirX * facing; // + forward, − backward along the facing
    const fwd = Math.max(0, h) * dashW;
    const back = Math.max(0, -h) * dashW;
    const up = Math.max(0, this.dash.dirY) * dashW;
    const down = Math.max(0, -this.dash.dirY) * dashW;

    // tilt in the gameplay plane (+ = top toward +x): lean, dash, tumble
    const tilt = this.lean + this.dash.dirX * Math.abs(this.dash.dirX) * DASH.tilt * dashW;
    const [whole, lower, upper] = LEAN.shares;
    const body = b.root ?? b.pelvis;
    if (body) {
      rotateWorld(body, _q.setFromAxisAngle(Z, -(tilt * whole + this.tumble * flail)));
      if (bank) rotateWorld(body, _q.setFromAxisAngle(_axisForward(yaw), bank));
    }
    // the spine's share of a forward lean gives way to the hold's own lean into the gun: the larger shows, not the
    // sum (a sniper's hunch at a run stays a hunch); leaning back (braking) or a hold leaning back isn't touched
    const forward = tilt * facing * (lower + upper);
    const spine = forward > 0 && holdLean > 0 ? Math.max(0, forward - holdLean) / forward : 1;
    if (b.spine1) rotateWorld(b.spine1, _q.setFromAxisAngle(Z, -tilt * lower * spine));
    if (b.spine2) rotateWorld(b.spine2, _q.setFromAxisAngle(Z, -tilt * upper * spine));
    if (b.neck) rotateWorld(b.neck, _q.setFromAxisAngle(Z, tilt * (lower + upper) * spine * LEAN.neckCounter));
    // curl the spine into an up-dash tuck (+ about the body's left flexes forward, docs/04 §9.2)
    if (up && b.spine1) rotateWorld(b.spine1, _q.setFromAxisAngle(lat, 14 * DEG * up));
    // hit reactions: the flinch in the gameplay plane (in the air the whole body turns with it), the twist about the
    // vertical, the head's snap about the body's left axis
    const flinch = this.flinch.x;
    if (flinch) {
      if (body) rotateWorld(body, _q.setFromAxisAngle(Z, -flinch * (this.reactAir ? 0.6 : 0.15)));
      if (b.spine1) rotateWorld(b.spine1, _q.setFromAxisAngle(Z, -flinch * 0.4));
      if (b.spine2) rotateWorld(b.spine2, _q.setFromAxisAngle(Z, -flinch * 0.45));
    }
    if (this.twist.x) {
      if (b.spine1) rotateWorld(b.spine1, _q.setFromAxisAngle(_up, this.twist.x * 0.45));
      if (b.spine2) rotateWorld(b.spine2, _q.setFromAxisAngle(_up, this.twist.x * 0.55));
    }
    if (this.headSnap.x && b.head) rotateWorld(b.head, _q.setFromAxisAngle(lat, this.headSnap.x));

    // legs (local axes: +X flexes a thigh forward; a calf bends back with −X)
    const kick = Math.sin(this.time * FLAIL.kickRate);
    for (const [side, s] of [['L', 1], ['R', -1]] as const) {
      const thigh = b[`thigh_${side}`];
      const calf = b[`calf_${side}`];
      const foot = b[`foot_${side}`];
      const swing = FLAIL.legKick * kick * s * flail + 18 * DEG * flail;
      const thighX = swing + 78 * DEG * up - 24 * DEG * fwd + 12 * DEG * back - 4 * DEG * down;
      const calfX = -(FLAIL.kneeBend * (0.6 + 0.4 * kick * s) * flail + 105 * DEG * up + 10 * DEG * fwd + 30 * DEG * back);
      if (thigh && thighX) thigh.quaternion.multiply(_q.setFromAxisAngle(_x, thighX));
      if (calf && calfX) calf.quaternion.multiply(_q.setFromAxisAngle(_x, calfX));
      // feet point down in a slam and a sideways stretch
      if (foot && (down || fwd)) foot.quaternion.multiply(_q.setFromAxisAngle(_x, 35 * DEG * down + 25 * DEG * fwd));
    }

    // arms (local axes: +Z raises upperarm_L sideways, −Z upperarm_R; +X swings an arm forward)
    const flap = Math.sin(this.time * FLAIL.flapRate);
    for (const [side, s] of [['L', 1], ['R', -1]] as const) {
      const upperArm = b[`upperarm_${side}`];
      const forearm = b[`forearm_${side}`];
      if (upperArm && held.includes(side)) {
        // a gun or shield arm: no flail or dash swing, and turned back to the way it pointed before the lean
        upperArm.parent!.getWorldQuaternion(_q2).invert();
        upperArm.quaternion.copy(_q2.multiply(_heldArm[side]));
        continue;
      }
      const raise = (FLAIL.armOut + FLAIL.armFlap * flap * s) * flail - 12 * DEG * up;
      const swing = -55 * DEG * fwd + 40 * DEG * back + 25 * DEG * up;
      if (upperArm && raise) upperArm.quaternion.multiply(_q.setFromAxisAngle(Z, raise * s));
      if (upperArm && swing) upperArm.quaternion.multiply(_q.setFromAxisAngle(_x, swing));
      const bend = 30 * DEG * flail + 70 * DEG * up + 20 * DEG * fwd;
      if (forearm && bend) forearm.quaternion.multiply(_q.setFromAxisAngle(_x, bend));
      // a slam: the free fist drives down in front, leading the dive (a raised arm would hide behind the
      // chibi head in the 3/4 view; the aim layer takes back the gun arm)
      if (upperArm && forearm && down > 0) {
        upperArm.updateMatrixWorld(true);
        const from = forearm.getWorldPosition(_from).sub(upperArm.getWorldPosition(_to)).normalize();
        _to.set(0, -1, 0).addScaledVector(_axisForward(yaw), 0.75).addScaledVector(lat, 0.15 * s).normalize();
        rotateWorld(upperArm, _q.identity().slerp(_q2.setFromUnitVectors(from, _to), down));
      }
    }

  }
}


const _x = new Vector3(1, 0, 0);
const _up = new Vector3(0, 1, 0);
const _heldArm = { L: new Quaternion(), R: new Quaternion() };
const _from = new Vector3();
const _to = new Vector3();
const _q2 = new Quaternion();
const _fwd = new Vector3();
/** The body's forward axis in world space for a yaw (glTF +Z forward). */
function _axisForward(yaw: number): Vector3 {
  return _fwd.set(Math.sin(yaw), 0, Math.cos(yaw));
}
