/**
 * Gunfire (docs/11 §5, docs/01 §13): a tracer from the gun's muzzle to where the shot ended, a
 * muzzle flash with a light pop, and sparks where it hit. Procedural by weapon class; the Forge's
 * `weapons.vfx.json` (flash atlas and per-family styles) takes over when it is published.
 *
 * Shots are queued as they arrive and drawn once the avatars are posed for the frame, so a tracer
 * leaves the muzzle where the gun is drawn. The drawn muzzle sits below the sim's aim line (W8
 * notes); the tracer runs from it to the sim's end point, which is what was hit. A Forge flash
 * then rides its gun while it lasts, so the recoil (recoil.ts) carries it along.
 */
import { HitZone, heldTrigger, weapons, type WeaponClass } from '@military-forge/content';
import { SegFlag, createRayHit, type CollisionWorld, type SimEvent } from '@military-forge/sim';
import { PointLight, Vector3, type Scene, type Texture } from 'three';
import { Cell } from './atlas';
import { bloodHit } from './blood';
import type { WeaponVfxArt } from './manifest';
import { ParticleLayer } from './particles';
import { F, ParticlePool, STRIDE, particleSpec, type ParticleSpec } from './pool';
import { Ramp } from './ramps';

type ShotEvent = Extract<SimEvent, { type: 'shot' }>;
/** a bullet bouncing off a riot shield (main's shield): its path on from the bounce */
type RicochetEvent = Extract<SimEvent, { type: 'ricochet' }>;
/** where a bullet ended and what it struck (a shot, or a ricochet's second leg) */
type HitEnd = Pick<ShotEvent, 'ex' | 'ey' | 'hit' | 'zone' | 'weapon'>;

/**
 * Where shooter `shooter`'s gun that fired `weapon` has its muzzle, and which way it points (world).
 * Dual guns of one kind take turns per shot; `peek` asks for the one that fired last instead.
 */
export type MuzzleLookup = (shooter: number, weapon: number, out: Vector3, dir: Vector3, peek?: boolean) => boolean;

/** A gun whose Forge flashes ride it: its muzzle when they were last placed, and this frame's move. */
interface Anchor {
  shooter: number;
  weapon: number;
  x: number;
  y: number;
  z: number;
  angle: number;
  nx: number;
  ny: number;
  nz: number;
  turn: number;
  moved: boolean;
  /** gunfire clock (s) after which none of its flashes is left */
  until: number;
}
/** guns with a flash on show at once */
const ANCHORS = 16;

export interface ClassFx {
  /** muzzle flash length (m) */
  flash: number;
  /** tracer width and bolt length (m) */
  width: number;
  length: number;
  /** a tracer every N shots (docs/11 §5: SMGs every 3rd on Low) */
  every: number;
  /** light pop strength */
  light: number;
}

/** The procedural look by weapon class, sized like the Forge's flash styles. */
const CLASS_FX: Record<WeaponClass, ClassFx | null> = {
  sidearm: { flash: 0.5, width: 0.035, length: 1.2, every: 1, light: 2 },
  smg: { flash: 0.5, width: 0.03, length: 1, every: 2, light: 1.8 },
  rifle: { flash: 0.68, width: 0.04, length: 1.8, every: 1, light: 2.5 },
  dmr: { flash: 0.8, width: 0.045, length: 2.5, every: 1, light: 2.8 },
  sniper: { flash: 0.95, width: 0.06, length: 4, every: 1, light: 3 },
  shotgun: { flash: 0.85, width: 0.022, length: 0.6, every: 1, light: 3.5 },
  heavy: { flash: 0.78, width: 0.04, length: 1.6, every: 2, light: 2.5 },
  special: { flash: 0.9, width: 0.05, length: 1.6, every: 1, light: 3 },
  melee: null,
};

const TRACER_TINT: [number, number, number] = [1, 0.92, 0.66];
/** a ricochet's tracer: the cold cyan the 2D view uses for them */
const RICOCHET_TINT: [number, number, number] = [0.6, 0.93, 1];
const RICOCHET_TINTS: TracerTints = { bolt: RICOCHET_TINT, trail: RICOCHET_TINT };
const SNIPER_TRAIL = { tint: [0.62, 0.62, 0.6] as [number, number, number], widthM: 0.05, seconds: 0.45 };
const FLASH_TINT: [number, number, number] = [1, 0.85, 0.5];
/** hitscan: the hit is already decided, so a tracer reaches its end within this */
const MAX_FLIGHT = 0.05;
const MIN_SPEED = 320;
/**
 * The war tone (the owner, 19 Oct: "war, military, serious battle, hard-boiled", not "joyous"):
 * tracers thinner and quicker, flashes shorter and hot with a wisp of gun smoke, impacts dust,
 * sparks and chips rather than stars.
 */
const TRACER_THIN = 0.62;
const TRACER_BOLT = 0.8;
const FLASH_SHORT = 0.75;
/** gun smoke off the muzzle: grey, drifting up and away */
const MUZZLE_SMOKE_TINT = [0.82, 0.8, 0.76] as const;
/** chips off stone and concrete: grey; off dirt: earth */
const CHIP_STONE = [0.52, 0.5, 0.47] as const;
const CHIP_DIRT = [0.36, 0.28, 0.2] as const;
const CHIP_WOOD = [0.45, 0.33, 0.2] as const;
/** the light pop's peak (×style intensity) and fade */
const LIGHT_PEAK = 22;
const QUEUE_MAX = 256;

/** A skin's tracer hues (linear RGB): the bolt's, and its path line's (docs/17 V5: hues only). */
export interface TracerTints {
  bolt: readonly [number, number, number];
  trail: readonly [number, number, number];
}

/**
 * A tracer's look: its bolt's and path line's tints, width, bolt length and speed, from the weapon's Forge style
 * (else its class) over a shot of `dist` metres. A skin's hues (`tintOver`) change the tints only (docs/17 V5;
 * test/skins.test.ts).
 */
export function tracerLook(
  style: { tint: readonly [number, number, number]; widthM: number; lengthM: number; speedMps: number } | undefined,
  cls: { width: number; length: number },
  dist: number,
  tintOver: TracerTints | null = null,
): { tint: readonly [number, number, number]; trail: readonly [number, number, number]; width: number; len: number; speed: number } {
  const base = style?.tint ?? TRACER_TINT;
  return {
    tint: tintOver?.bolt ?? base,
    trail: tintOver?.trail ?? base,
    width: (style?.widthM ?? cls.width) * TRACER_THIN,
    len: Math.min((style?.lengthM ?? cls.length) * TRACER_BOLT, dist),
    speed: Math.max(style?.speedMps ?? 0, MIN_SPEED, dist / MAX_FLIGHT),
  };
}

/** The class look a weapon class's tracer falls back to (tests). */
export function tracerClass(cls: WeaponClass): ClassFx | null {
  return CLASS_FX[cls];
}

const spec: ParticleSpec = particleSpec();
const base = particleSpec();
const reset = (): ParticleSpec => Object.assign(spec, base);
const hit = createRayHit();
const _m = new Vector3();
const _d = new Vector3();

export interface GunfireTargets {
  glow: ParticlePool;
  smoke: ParticlePool;
  /** long-lived marks (blood splats, when blood is on) */
  decals?: ParticlePool;
}

export class Gunfire {
  /** High only: one pooled light for muzzle pops (kept in the scene at 0 between shots) */
  readonly light = new PointLight(0xffd890, 0, 4, 2);
  /** the Forge flash atlas, when published: its own additive layer */
  flashPool: ParticlePool | null = null;
  flashLayer: ParticleLayer | null = null;
  /** effect density (preset), and Low's sparser SMG tracers */
  detail = 1;
  low = false;
  /** blood on player hits instead of the non-gory thud (blood.ts; Renderer3D.setBlood, off by default) */
  blood = false;
  private art: WeaponVfxArt | null = null;
  private readonly queue: (ShotEvent | RicochetEvent)[] = [];
  private readonly batchOf: number[] = [];
  private batch = 0;
  /** shots fired per shooter, for "a tracer every N shots" */
  private readonly fired = new Map<number, number>();
  private lightLevel = 0;
  private lightTau = 0.03;
  /** deterministic jitter (no Math.random: the stepped screenshots repeat exactly) */
  private seed = 1;
  /** seconds, for the anchors */
  private time = 0;
  /** tag − 1 in the flash pool */
  private readonly anchors: Anchor[] = Array.from({ length: ANCHORS }, () => ({
    shooter: -1,
    weapon: -1,
    x: 0,
    y: 0,
    z: 0,
    angle: 0,
    nx: 0,
    ny: 0,
    nz: 0,
    turn: 0,
    moved: false,
    until: -1,
  }));

  /** the map's collision (impact normals and materials); Vfx.setMap swaps it */
  constructor(public world: CollisionWorld) {}

  /** The Forge's flash atlas and styles. */
  setArt(art: WeaponVfxArt, texture: Texture, scene: Scene): void {
    this.art = art;
    this.flashPool = new ParticlePool(64, true);
    this.flashLayer = new ParticleLayer(64, { texture, grid: art.grid, blend: 'additive', depthTest: false, renderOrder: 13 });
    this.flashLayer.mesh.name = 'vfx-flash';
    scene.add(this.flashLayer.mesh);
  }

  /**
   * A clean slate (a new map, or the WebGL context back after a loss): queued shots go unfired, and
   * no flash or light pop carries over.
   */
  clear(): void {
    this.queue.length = 0;
    this.batchOf.length = 0;
    this.flashPool?.clear();
    for (const a of this.anchors) a.until = -1;
    this.lightLevel = 0;
    this.light.intensity = 0;
  }

  /**
   * skins: the tracer tint (linear RGB) a shooter's skin gives a weapon's shots, or null for the base (Renderer3D sets
   * it from the looks; docs/17 V5: a hue only, so it replaces the tint and nothing else: see tracerLook).
   */
  tracerTintOf: ((shooter: number, weapon: number) => TracerTints | null) | null = null;

  /** One batch of sim events: shots wait for the frame's avatar poses. */
  onEvents(events: readonly SimEvent[]): void {
    this.batch++;
    for (const e of events) {
      if ((e.type !== 'shot' && e.type !== 'ricochet') || this.queue.length >= QUEUE_MAX) continue;
      this.queue.push(e);
      this.batchOf.push(this.batch);
    }
  }

  private rand(): number {
    this.seed = (Math.imul(this.seed, 1664525) + 1013904223) >>> 0;
    return this.seed / 4294967296;
  }

  /** `rand` as a value (blood.ts takes it) */
  private readonly random = (): number => this.rand();

  /** Draws the queued shots (avatars posed) and fades the light pop. */
  update(dt: number, fx: GunfireTargets, muzzle: MuzzleLookup): void {
    this.time += dt;
    this.follow(muzzle);
    let prevShooter = -1;
    let prevWeapon = -1;
    let prevBatch = -1;
    let counted = false;
    for (let i = 0; i < this.queue.length; i++) {
      const e = this.queue[i]!;
      if (e.type === 'ricochet') {
        this.ricochet(e, fx);
        continue;
      }
      const b = this.batchOf[i]!;
      // a shotgun's pellets arrive together: one flash and one count for the shot, a tracer per pellet
      const first = b !== prevBatch || e.shooter !== prevShooter || e.weapon !== prevWeapon;
      if (first) {
        const n = (this.fired.get(e.shooter) ?? 0) + 1;
        this.fired.set(e.shooter, n);
        counted = n % this.every(e.weapon) === 0 || n === 1;
      }
      this.shot(e, fx, muzzle, first, counted);
      prevShooter = e.shooter;
      prevWeapon = e.weapon;
      prevBatch = b;
    }
    this.queue.length = 0;
    this.batchOf.length = 0;
    this.lightLevel *= Math.exp(-dt / this.lightTau);
    this.light.intensity = this.lightLevel < 0.01 ? 0 : LIGHT_PEAK * this.lightLevel;
    if (this.flashPool && this.flashLayer) {
      this.flashPool.update(dt);
      this.flashLayer.begin();
      this.flashLayer.addPool(this.flashPool);
      this.flashLayer.end();
    }
  }

  /** a tracer every N shots of this weapon (Low: every 3rd at most for a gun that fires while held) */
  every(weapon: number): number {
    const def = weapons[weapon];
    if (!def) return 1;
    const style = this.art?.tracers[this.art.weapons[def.id]?.tracer ?? ''];
    const n = style?.every ?? CLASS_FX[def.class]?.every ?? 1;
    return this.low && heldTrigger(def) ? Math.max(n, 3) : n;
  }

  private shot(e: ShotEvent, fx: GunfireTargets, muzzle: MuzzleLookup, first: boolean, tracer: boolean): void {
    const def = weapons[e.weapon];
    const cls = def ? CLASS_FX[def.class] : null;
    if (!def || !cls) return;
    // The flash sits on the drawn muzzle when the shooter is drawn (and not wedged in a wall), else
    // on the sim's. The tracer always flies the sim's own ray, (ox, oy) → (ex, ey): the drawn gun
    // sits below the sim's 1.08 m shoulder line, and a streak from it to the end point used to cut
    // through a crate the shot had cleared (23 Oct QA). A short joiner bridges the drawn muzzle to
    // the ray, so the streak still reads as leaving the gun.
    const sdx = e.ex - e.ox;
    const sdy = e.ey - e.oy;
    const dist = Math.sqrt(sdx * sdx + sdy * sdy);
    const ux = dist > 1e-6 ? sdx / dist : 1;
    const uy = dist > 1e-6 ? sdy / dist : 0;
    const drawn = muzzle(e.shooter, e.weapon, _m, _d) && (_m.x - e.ox) ** 2 + (_m.y - e.oy) ** 2 < 1.44;
    const fxX = drawn ? _m.x : e.ox;
    const fxY = drawn ? _m.y : e.oy;
    const oz = drawn ? _m.z : 0;
    const entry = this.art?.weapons[def.id];
    if (first) this.flash(fx, fxX, fxY, oz, drawn ? Math.atan2(_d.y, _d.x) : Math.atan2(uy, ux), cls, entry?.flash ?? null, entry?.flashScale ?? 1, drawn ? e : null);
    if (tracer && dist > 0.3) {
      // a skin's tracer hue (docs/17 V5): the shooter's skin on this gun; shape, speed and brightness stay the base's
      const tint = this.tracerTintOf?.(e.shooter, e.weapon) ?? null;
      this.tracer(fx, e.ox, e.oy, oz, ux, uy, dist, cls, entry?.tracer ?? null, tint);
      if (drawn) this.joiner(fx, fxX, fxY, e.ox, e.oy, oz, cls, entry?.tracer ?? null, tint);
    }
    if (e.hit) this.impact(fx, e, ux, uy);
  }

  /** The drawn muzzle to the start of the sim's ray: a short line in the tracer's tint, gone with its path line. */
  private joiner(fx: GunfireTargets, x0: number, y0: number, x1: number, y1: number, z: number, cls: ClassFx, styleName: string | null, tintOver: TracerTints | null = null): void {
    const dx = x1 - x0;
    const dy = y1 - y0;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len < 0.02) return;
    const style = styleName ? this.art?.tracers[styleName] : undefined;
    const p = reset();
    p.x = (x0 + x1) / 2;
    p.y = (y0 + y1) / 2;
    p.z = z;
    p.life = 0.06;
    p.size0 = p.size1 = len;
    p.aspect = ((style?.widthM ?? cls.width) * TRACER_THIN * 1.4) / len;
    p.rot = Math.atan2(dy, dx);
    p.alpha = 0.45;
    p.ramp = Ramp.Tracer;
    p.cell = Cell.Line;
    [p.tr, p.tg, p.tb] = tintOver?.trail ?? style?.tint ?? TRACER_TINT;
    fx.glow.emit(p);
  }

  /** `rider`: the shot of a drawn gun, whose Forge flash then rides it */
  private flash(fx: GunfireTargets, x: number, y: number, z: number, angle: number, cls: ClassFx, styleName: string | null, styleScale: number, rider: ShotEvent | null): void {
    const style = styleName ? this.art?.flashes[styleName] : undefined;
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    let light = cls.light;
    let seconds = 0.05;
    if (style && this.flashPool) {
      // the Forge's flash: a random frame, its quad blasting forward from the muzzle point
      const k = (style.scale[0] + (style.scale[1] - style.scale[0]) * this.rand()) * styleScale;
      const w = style.widthM * k;
      const p = reset();
      p.x = x + c * w * (0.5 - style.originU);
      p.y = y + s * w * (0.5 - style.originU);
      p.z = z + 0.02;
      p.life = style.seconds * FLASH_SHORT;
      p.size0 = p.size1 = w;
      p.aspect = ((style.heightM * k) / w) * (style.flipV && this.rand() < 0.5 ? -1 : 1);
      p.rot = angle + (this.rand() * 2 - 1) * style.rollRad;
      p.cell = style.frames[Math.floor(this.rand() * style.frames.length)]!;
      p.ramp = Ramp.Book;
      this.flashPool.emit(p, rider ? this.anchor(rider.shooter, rider.weapon, x, y, z, angle, style.seconds * FLASH_SHORT) : 0);
      seconds = style.seconds * FLASH_SHORT;
      if (style.light) {
        light = style.light.intensity;
        this.light.color.copy(style.light.color);
        this.light.distance = style.light.rangeM;
      }
    } else {
      // procedural: a star at the muzzle and a cone of light ahead of it
      const len = cls.flash * (0.85 + 0.3 * this.rand());
      let p = reset();
      p.x = x;
      p.y = y;
      p.z = z + 0.02;
      p.life = 0.035;
      p.size0 = len * 0.7;
      p.size1 = len * 0.5;
      p.rot = this.rand() * Math.PI;
      p.ramp = Ramp.Flash;
      p.cell = Cell.Star;
      [p.tr, p.tg, p.tb] = FLASH_TINT;
      fx.glow.emit(p);
      p = reset();
      p.x = x + c * len * 0.45;
      p.y = y + s * len * 0.45;
      p.z = z + 0.02;
      p.life = 0.035;
      p.size0 = p.size1 = len * 1.1;
      p.aspect = 0.42;
      p.rot = angle;
      p.ramp = Ramp.Flash;
      p.cell = Cell.Glow;
      [p.tr, p.tg, p.tb] = FLASH_TINT;
      fx.glow.emit(p);
      this.light.color.setRGB(1, 0.85, 0.55);
      this.light.distance = 3 + cls.flash * 2;
    }
    this.gunSmoke(fx, x + c * 0.08, y + s * 0.08, z, c, s, cls);
    // the light pop: High's pooled point light (Low and Medium: the emissive cards only, docs/11 §2)
    this.light.position.set(x, y, z + 0.6);
    this.lightLevel = Math.max(this.lightLevel, light / 3);
    this.lightTau = seconds / 2;
  }

  /** A wisp or two of gun smoke off the muzzle, drifting up and on along the shot. */
  private gunSmoke(fx: GunfireTargets, x: number, y: number, z: number, c: number, s: number, cls: ClassFx): void {
    for (let i = 0, n = this.detail >= 0.8 && cls.flash >= 0.6 ? 2 : 1; i < n; i++) {
      const p = reset();
      p.x = x + c * 0.06 * i;
      p.y = y + s * 0.06 * i;
      p.z = z - 0.02;
      p.vx = c * (0.5 + this.rand() * 0.4);
      p.vy = s * (0.5 + this.rand() * 0.4) + 0.35;
      p.drag = 2.4;
      p.life = 0.45 + this.rand() * 0.25;
      p.size0 = 0.07 + cls.flash * 0.06;
      p.size1 = 0.3 + cls.flash * 0.2;
      p.ease = 0.55;
      p.alpha = 0.32;
      p.rot = this.rand() * Math.PI * 2;
      p.spin = (this.rand() - 0.5) * 1.5;
      p.ramp = Ramp.Trail;
      p.cell = Cell.Puff;
      [p.tr, p.tg, p.tb] = MUZZLE_SMOKE_TINT;
      fx.smoke.emit(p);
    }
  }

  /** The tag (anchor index + 1) for a flash riding this gun, its muzzle at (x, y, z) and `angle`; 0 when all are busy. */
  private anchor(shooter: number, weapon: number, x: number, y: number, z: number, angle: number, seconds: number): number {
    let i = -1;
    let free = -1;
    for (let k = 0; k < ANCHORS && i < 0; k++) {
      const a = this.anchors[k]!;
      if (a.shooter === shooter && a.weapon === weapon) i = k;
      else if (free < 0 && a.until < this.time) free = k;
    }
    if (i < 0) i = free;
    if (i < 0) return 0;
    const a = this.anchors[i]!;
    a.shooter = shooter;
    a.weapon = weapon;
    a.x = x;
    a.y = y;
    a.z = z;
    a.angle = angle;
    a.until = Math.max(a.until, this.time + seconds + 0.05);
    return i + 1;
  }

  /**
   * Forge flashes ride their gun while they last: each moves and turns with its gun's muzzle since
   * it was last placed (the recoil kicks the gun back and up from the frame after the shot).
   */
  private follow(muzzle: MuzzleLookup): void {
    const pool = this.flashPool;
    const tags = pool?.tags;
    if (!pool || !tags || pool.count === 0) return;
    let any = false;
    for (let i = 0; i < ANCHORS; i++) {
      const a = this.anchors[i]!;
      a.moved = a.until >= this.time && muzzle(a.shooter, a.weapon, _m, _d, true);
      if (!a.moved) continue;
      const turn = Math.atan2(_d.y, _d.x) - a.angle;
      a.turn = Math.atan2(Math.sin(turn), Math.cos(turn));
      a.nx = _m.x;
      a.ny = _m.y;
      a.nz = _m.z;
      any = true;
    }
    if (!any) return;
    const d = pool.data;
    for (let i = 0; i < pool.count; i++) {
      const tag = tags[i]!;
      const a = tag > 0 ? this.anchors[tag - 1]! : null;
      if (!a?.moved) continue;
      const o = i * STRIDE;
      const rx = d[o + F.x]! - a.x;
      const ry = d[o + F.y]! - a.y;
      const c = Math.cos(a.turn);
      const s = Math.sin(a.turn);
      d[o + F.x] = a.nx + rx * c - ry * s;
      d[o + F.y] = a.ny + rx * s + ry * c;
      d[o + F.z]! += a.nz - a.z;
      d[o + F.rot]! += a.turn;
    }
    for (let i = 0; i < ANCHORS; i++) {
      const a = this.anchors[i]!;
      if (!a.moved) continue;
      a.x = a.nx;
      a.y = a.ny;
      a.z = a.nz;
      a.angle += a.turn;
    }
  }

  private tracer(fx: GunfireTargets, x: number, y: number, z: number, ux: number, uy: number, dist: number, cls: ClassFx, styleName: string | null, tintOver: TracerTints | null = null): void {
    const style = styleName ? this.art?.tracers[styleName] : undefined;
    const { tint, trail: pathTint, width, len, speed } = tracerLook(style, cls, dist, tintOver);
    const angle = Math.atan2(uy, ux);
    // the bolt: a bright streak racing from the muzzle to the end, its head at +U
    let p = reset();
    p.x = x + ux * len * 0.5;
    p.y = y + uy * len * 0.5;
    p.z = z;
    p.vx = ux * speed;
    p.vy = uy * speed;
    p.life = Math.max(1 / 120, (dist - len) / speed);
    p.size0 = p.size1 = len;
    p.aspect = (width * 2.2) / len;
    p.rot = angle;
    p.ramp = Ramp.Book;
    p.cell = Cell.Tracer;
    [p.tr, p.tg, p.tb] = tint;
    fx.glow.emit(p);
    // the path: a thin line from muzzle to end, gone in ~0.1 s
    p = reset();
    p.x = x + ux * dist * 0.5;
    p.y = y + uy * dist * 0.5;
    p.z = z;
    p.life = 0.06;
    p.size0 = p.size1 = dist;
    p.aspect = (width * 1.4) / dist;
    p.rot = angle;
    p.alpha = 0.45;
    p.ramp = Ramp.Tracer;
    p.cell = Cell.Line;
    [p.tr, p.tg, p.tb] = pathTint;
    fx.glow.emit(p);
    // snipers leave a smoke line that hangs a moment
    const trail = style?.trail ?? (cls.width >= 0.06 ? SNIPER_TRAIL : null);
    if (trail) {
      p = reset();
      p.x = x + ux * dist * 0.5;
      p.y = y + uy * dist * 0.5;
      p.z = z - 0.02;
      p.vy = 0.15;
      p.life = trail.seconds;
      p.size0 = p.size1 = dist;
      p.aspect = trail.widthM / dist;
      p.rot = angle;
      p.ramp = Ramp.Haze;
      p.cell = Cell.Line;
      [p.tr, p.tg, p.tb] = trail.tint;
      fx.smoke.emit(p);
    }
  }

  /**
   * A bullet off a riot shield: metal sparks fanning out along the shield's normal where it bounced,
   * a cold tracer on along its new path, and whatever it struck at the end.
   */
  private ricochet(e: RicochetEvent, fx: GunfireTargets): void {
    const def = weapons[e.weapon];
    const cls = def ? CLASS_FX[def.class] : null;
    if (!cls) return;
    const dx = e.ex - e.x;
    const dy = e.ey - e.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const ux = dist > 1e-6 ? dx / dist : e.nx;
    const uy = dist > 1e-6 ? dy / dist : e.ny;
    for (let i = 0, count = Math.max(3, Math.round(8 * this.detail)); i < count; i++) {
      const a = Math.atan2(e.ny, e.nx) + (this.rand() * 2 - 1) * 1.1;
      const v = 4 + this.rand() * 7;
      const p = reset();
      p.x = e.x;
      p.y = e.y;
      p.z = 0.5; // in front of the plate
      p.vx = Math.cos(a) * v;
      p.vy = Math.sin(a) * v;
      p.grav = 12;
      p.drag = 2;
      p.life = 0.12 + this.rand() * 0.2;
      p.size0 = 0.11;
      p.size1 = 0.06;
      p.aspect = 0.35;
      p.stretch = 0.03;
      p.ramp = Ramp.Spark;
      p.cell = Cell.Streak;
      fx.glow.emit(p);
    }
    if (dist > 0.3) this.tracer(fx, e.x, e.y, 0.5, ux, uy, dist, cls, def ? (this.art?.weapons[def.id]?.tracer ?? null) : null, RICOCHET_TINTS);
    if (e.hit) this.impact(fx, e, ux, uy);
  }

  /** Sparks off a wall (by its material), or on a player a non-gory thud (docs/03 §13), or blood when it's on. */
  private impact(fx: GunfireTargets, e: HitEnd, ux: number, uy: number): void {
    const n = (count: number) => Math.max(2, Math.round(count * this.detail));
    let nx = -ux;
    let ny = -uy;
    let material = 0;
    // raycastBullet: a pole or rail the shot stopped on (MapDef.bulletOnly) sparks as its own material
    if (e.hit === 1 && this.world.raycastBullet(e.ex - ux * 0.3, e.ey - uy * 0.3, ux, uy, 0.6, SegFlag.BulletPass, hit)) {
      nx = this.world.nx[hit.seg]!;
      ny = this.world.ny[hit.seg]!;
      // the surface faces back along the shot
      if (nx * ux + ny * uy > 0) {
        nx = -nx;
        ny = -ny;
      }
      material = this.world.material[hit.seg]!;
    }
    const player = e.hit === 2;
    if (player && this.blood) {
      const def = weapons[e.weapon];
      const head = e.zone === HitZone.Head;
      bloodHit(fx, this.world, e.ex, e.ey, ux, uy, (def?.damage ?? 20) * (head ? (def?.headMul ?? 1) : 1), head, this.detail, this.random);
      return;
    }
    // a riot shield (3) is a steel plate: sparks, no dust
    const metal = material === 1 || e.hit === 3;
    // a hot point where it struck: brief and small, no star (a player hit: a dull thud)
    let p = reset();
    p.x = e.ex;
    p.y = e.ey;
    p.z = 0.3;
    p.life = player ? 0.06 : 0.045;
    p.size0 = player ? 0.32 : 0.26;
    p.size1 = player ? 0.18 : 0.14;
    p.rot = this.rand() * Math.PI;
    p.ramp = Ramp.Flash;
    p.cell = Cell.Glow;
    if (player) [p.tr, p.tg, p.tb] = e.zone === HitZone.Head ? [0.85, 0.42, 0.3] : [0.8, 0.62, 0.45];
    fx.glow.emit(p);
    if (player) {
      // a puff of torn cloth and dust off the body, along the shot
      p = reset();
      p.x = e.ex;
      p.y = e.ey;
      p.z = 0.32;
      p.vx = ux * 1.2;
      p.vy = uy * 1.2 + 0.2;
      p.drag = 4;
      p.life = 0.3;
      p.size0 = 0.12;
      p.size1 = 0.36;
      p.ease = 0.6;
      p.alpha = 0.6;
      p.ramp = Ramp.Dust;
      p.cell = Cell.Dust;
      p.rot = this.rand() * 6.28;
      fx.smoke.emit(p);
    }
    // sparks: off the surface (reflected), or a small splash back toward the shooter
    const rx = ux - 2 * (ux * nx + uy * ny) * nx;
    const ry = uy - 2 * (ux * nx + uy * ny) * ny;
    for (let i = 0, count = n(player ? 3 : metal ? 7 : 4); i < count; i++) {
      const a = Math.atan2(ry * 0.5 + ny * 0.5, rx * 0.5 + nx * 0.5) + (this.rand() * 2 - 1) * 0.9;
      const v = 3 + this.rand() * (metal ? 7 : 4);
      p = reset();
      p.x = e.ex;
      p.y = e.ey;
      p.z = 0.3;
      p.vx = Math.cos(a) * v;
      p.vy = Math.sin(a) * v;
      p.grav = 12;
      p.drag = 2;
      p.life = 0.12 + this.rand() * 0.18;
      p.size0 = 0.1;
      p.size1 = 0.06;
      p.aspect = 0.35;
      p.stretch = 0.03;
      p.ramp = Ramp.Spark;
      p.cell = Cell.Streak;
      fx.glow.emit(p);
    }
    // chips off stone, concrete and dirt, thrown off the surface and falling
    if (!player && !metal) {
      // map materials: 0 concrete, 2 wood, 3 dirt (content maps/types.ts)
      const chip = material === 3 ? CHIP_DIRT : material === 2 ? CHIP_WOOD : CHIP_STONE;
      for (let i = 0, count = n(3); i < count; i++) {
        const a = Math.atan2(ny, nx) + (this.rand() * 2 - 1) * 1.1;
        const v = 1.8 + this.rand() * 3;
        p = reset();
        p.x = e.ex + nx * 0.03;
        p.y = e.ey + ny * 0.03;
        p.z = 0.32;
        p.vx = Math.cos(a) * v;
        p.vy = Math.sin(a) * v + 1;
        p.grav = 18;
        p.drag = 0.6;
        p.life = 0.45 + this.rand() * 0.3;
        p.size0 = p.size1 = 0.035 + this.rand() * 0.035;
        p.rot = this.rand() * Math.PI;
        p.spin = (this.rand() - 0.5) * 20;
        p.front = 1;
        p.ramp = Ramp.Book;
        p.cell = Cell.Chunk;
        [p.tr, p.tg, p.tb] = chip;
        fx.smoke.emit(p);
      }
    }
    // dust off stone and dirt
    if (!player && !metal) {
      p = reset();
      p.x = e.ex + nx * 0.05;
      p.y = e.ey + ny * 0.05;
      p.z = 0.2;
      p.vx = nx * 0.8;
      p.vy = ny * 0.8 + 0.3;
      p.drag = 3;
      p.life = 0.35 + this.rand() * 0.15;
      p.size0 = 0.14;
      p.size1 = 0.5;
      p.ease = 0.6;
      p.ramp = Ramp.Dust;
      p.cell = Cell.Dust;
      p.rot = this.rand() * 6.28;
      fx.smoke.emit(p);
    }
  }

  dispose(): void {
    this.flashLayer?.dispose();
    this.light.removeFromParent();
  }
}
