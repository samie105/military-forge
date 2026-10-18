/**
 * The launchers' and the flamethrower's projectiles in 3D, with the Forge's art (#107: they reach
 * the frame as grenade views of type PROJECTILE_TYPE_BASE + index; arsenal-projectiles-render.md):
 * - the Thumper's rocket (projectiles.glb `proj_rocket`), nose along its flight, spinning, a flame at
 *   its tail and a smoke trail;
 * - the Popper's shell (`proj_grenade`), tumbling, with a thin dust trail;
 * - the Ripper's blade (`proj_blade`), face on and spinning, a pale glow trail that runs hot after
 *   its first bounce, and sparks off every wall it bounces from;
 * - the Pulse's orb (the specials atlas's orb flipbook), a blue trail, and on its EMP burst a flash
 *   and a tinted shockwave on top of the EMP ring clouds.ts draws;
 * - the Dragon's flames (the flame flipbook, three puffs per sim flame along its first metre so the
 *   stream reads unbroken; its frame follows the flame's age as the sim's radius does), a heat
 *   shimmer over them, a pilot light at the gun's `pilot` socket, and the stream's warm light (High);
 * - burning players (`PlayerView.burning`): flames at the chest and embers for the burn;
 * - the wind-up tells (`PlayerView.windup`): the Ripper's sparks and the Pulse's gathering glow at
 *   the gun's `charge` socket, and the Shredder's barrels blurring at its muzzle.
 * Numbers are the Forge's specials.vfx.json and projectiles.json (18 Oct).
 *
 * Budget: three InstancedMeshes (rocket, shell, blade) and two card layers (the flame atlas, the
 * specials atlas), each a draw call only while it has something to show; trails, sparks and embers
 * are the shared pools'. Nothing is allocated per frame once a projectile's track exists. Low: half
 * the trail and ember density (the preset's detail), no shimmer and no light. Reduce motion: no
 * shimmer, no spin blur, calmer flames and fewer embers. Reduce flashes: the pilot light and the
 * stream's light hold steady, and the orb's burst flash is dimmer.
 */
import { BLADE, FLAME, ORB, PROJECTILE_TYPE_BASE, ROCKET, SHELL, projectileOfType, projectileRadius, weapons } from '@military-forge/content';
import type { SimEvent } from '@military-forge/sim';
import {
  BufferAttribute,
  ConeGeometry,
  CylinderGeometry,
  DynamicDrawUsage,
  InstancedMesh,
  Matrix4,
  MeshToonMaterial,
  PointLight,
  Quaternion,
  Vector3,
  type BufferGeometry,
  type Scene,
  type Texture,
} from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { Frame, GrenadeView, PlayerView } from '../../view';
import { ATLAS_GRID, Cell } from './atlas';
import type { VfxContext } from './index';
import { ParticleLayer } from './particles';
import { ParticlePool, particleSpec, type ParticleSpec } from './pool';
import { Ramp } from './ramps';

/** Where a shooter's drawn gun has socket `name` (or its muzzle), in world space; false: not drawn. */
export type GunPointLookup = (shooter: number, weapon: number, name: string, out: Vector3) => boolean;

/** projectile wire types */
export const T_ROCKET = PROJECTILE_TYPE_BASE + ROCKET.index;
export const T_SHELL = PROJECTILE_TYPE_BASE + SHELL.index;
export const T_BLADE = PROJECTILE_TYPE_BASE + BLADE.index;
export const T_ORB = PROJECTILE_TYPE_BASE + ORB.index;
export const T_FLAME = PROJECTILE_TYPE_BASE + FLAME.index;
const EMP_GRENADE = 5;

/** drawn this much larger than the Forge's models so they read at gameplay zoom (36 m across) */
export const DRAW_SCALE = { rocket: 1.7, shell: 2.8, blade: 1.35 } as const;
/** spin, turns a second (projectiles.json) */
const SPIN_RPS = { rocket: 2, shell: 1.5, blade: 14 };
/** where a model's trail leaves it, model frame (projectiles.json `trail`) */
const TRAIL_AT = { rocket: new Vector3(0, -0.14, 0), shell: new Vector3(0, -0.04, 0) };

/** the specials atlas (512², 4×4 cells of 128²): specials.vfx.json `atlases.specials.cells` */
export const SPECIAL = { orb0: 0, pilot: 4, flare: 5, glow: 6, ring: 7, star4: 11, streak: 12 } as const;
/** the flame atlas (1024², 4×4 of 256²): one puff over its life, 16 frames */
const FLAME_FRAMES = 16;
/**
 * the flame flipbook's cell (m): the painted flame grows inside it frame by frame, 0.15 → 0.6 m in
 * radius as the sim's flame does (specials.vfx.json `flipbooks.flame.cellM`)
 */
export const FLAME_CELL = 1.544;

/** trails (specials.vfx.json `styles.*.trail`): seconds between puffs, size (m), life (s), linear tint */
const TRAILS = {
  rocket: { every: 0.025, size: 0.2, life: 0.6, tint: [0.62, 0.59, 0.53] as const },
  shell: { every: 0.04, size: 0.16, life: 0.4, tint: [0.78, 0.75, 0.68] as const },
  blade: { every: 0.03, size: 0.2, life: 0.12, tint: [0.69, 0.76, 0.82] as const },
  bladeHot: { every: 0.03, size: 0.22, life: 0.14, tint: [1, 0.55, 0.22] as const },
  orb: { every: 0.04, size: 0.14, life: 0.24, tint: [0.16, 0.47, 1] as const },
};
const SPARK_TINT = [1, 0.75, 0.24] as const;
const CHARGE_SPARK_TINT = [1, 0.8, 0.35] as const;
const ORB_TINT = [0.16, 0.47, 1] as const;
const FLAME_LIGHT = 0xff9a40;

const spec: ParticleSpec = particleSpec();
const base = particleSpec();
const reset = (): ParticleSpec => Object.assign(spec, base);

interface Track {
  type: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** seconds owed toward the next trail puff */
  owed: number;
  seed: number;
  seen: boolean;
}

/** per player: how long the gun in hand has been winding up (s), for the gathering charge */
interface Windup {
  t: number;
  owed: number;
}

const _m = new Matrix4();
const _q = new Quaternion();
const _q2 = new Quaternion();
const _p = new Vector3();
const _s = new Vector3();
const _a = new Vector3();
const _d = new Vector3();
const UP = new Vector3(0, 1, 0);
const Z = new Vector3(0, 0, 1);
const X = new Vector3(1, 0, 0);

/** A brass-and-steel stand-in until projectiles.glb loads (Y along the flight). */
function painted(g: BufferGeometry, rgb: readonly [number, number, number]): BufferGeometry {
  const n = g.getAttribute('position').count;
  const c = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) c.set(rgb, i * 3);
  g.setAttribute('color', new BufferAttribute(c, 3));
  return g.index ? g.toNonIndexed() : g;
}

function standIns(): { rocket: BufferGeometry; shell: BufferGeometry; blade: BufferGeometry } {
  const body = painted(new CylinderGeometry(0.045, 0.045, 0.24, 10), [0.32, 0.36, 0.3]);
  const nose = painted(new ConeGeometry(0.045, 0.08, 10).translate(0, 0.16, 0), [0.75, 0.35, 0.12]);
  return {
    rocket: mergeGeometries([body, nose])!,
    shell: painted(new CylinderGeometry(0.028, 0.028, 0.08, 10), [0.35, 0.4, 0.25]),
    blade: painted(new CylinderGeometry(0.117, 0.117, 0.02, 20).rotateZ(Math.PI / 2), [0.8, 0.82, 0.85]),
  };
}

export class ProjectileFx {
  readonly meshes: { rocket: InstancedMesh; shell: InstancedMesh; blade: InstancedMesh };
  /** the flame flipbook (alpha-blended: its late frames are smoke) */
  readonly flames: ParticleLayer;
  /** the specials atlas: orbs, pilot lights, charge glows, the orb burst (additive) */
  readonly cards: ParticleLayer;
  /** specials-atlas particles that live a while (trails' glow, the burst's flash and rings) */
  readonly cardPool = new ParticlePool(256);
  /** High only: the flame stream's warm light (kept in the scene at 0 between streams) */
  readonly light = new PointLight(FLAME_LIGHT, 0, 3.5, 2);
  private readonly material: MeshToonMaterial;
  private readonly tracks = new Map<number, Track>();
  private readonly windups = new Map<number, Windup>();
  /** per burning player: embers owed */
  private readonly burns = new Map<number, number>();
  private time = 0;
  private seed = 5;
  private flameArt = false;
  private cardArt = false;
  /** the preset has real lights (High) */
  lights = false;
  /** Reduce flashes: steady pilot and stream lights, a dimmer burst flash */
  steady = false;

  constructor(
    scene: Scene,
    ramp: Texture,
    fallback: Texture,
    private readonly gunPoint: GunPointLookup = () => false,
  ) {
    this.material = new MeshToonMaterial({ vertexColors: true, gradientMap: ramp });
    const geos = standIns();
    const make = (name: string, g: BufferGeometry) => {
      const m = new InstancedMesh(g, this.material, 32);
      m.name = `vfx-${name}`;
      m.instanceMatrix.setUsage(DynamicDrawUsage);
      m.count = 0;
      m.visible = false;
      m.frustumCulled = false;
      scene.add(m);
      return m;
    };
    this.meshes = { rocket: make('rocket', geos.rocket), shell: make('shell', geos.shell), blade: make('blade', geos.blade) };
    const grid = [ATLAS_GRID, ATLAS_GRID] as const;
    this.flames = new ParticleLayer(512, { texture: fallback, grid, blend: 'alpha', depthTest: true, renderOrder: 11 });
    this.flames.mesh.name = 'vfx-flames';
    this.cards = new ParticleLayer(512, { texture: fallback, grid, blend: 'additive', depthTest: false, renderOrder: 12 });
    this.cards.mesh.name = 'vfx-cards';
    scene.add(this.flames.mesh, this.cards.mesh);
  }

  /** The Forge's art: projectiles.glb's models (Y along the flight), the flame and specials atlases. */
  setArt(art: { models?: Partial<Record<'rocket' | 'shell' | 'blade', BufferGeometry>>; flame?: Texture | null; specials?: Texture | null }): void {
    for (const k of ['rocket', 'shell', 'blade'] as const) {
      const g = art.models?.[k];
      if (!g) continue;
      this.meshes[k].geometry.dispose();
      this.meshes[k].geometry = g;
    }
    const swap = (layer: ParticleLayer, tex: Texture | null | undefined): boolean => {
      if (!tex) return false;
      layer.mesh.material.uniforms.map!.value = tex;
      layer.mesh.material.uniforms.uGrid!.value.set(4, 4);
      return true;
    };
    this.flameArt = swap(this.flames, art.flame) || this.flameArt;
    this.cardArt = swap(this.cards, art.specials) || this.cardArt;
  }

  private rand(): number {
    this.seed = (Math.imul(this.seed, 1664525) + 1013904223) >>> 0;
    return this.seed / 4294967296;
  }

  /** A cell of the specials atlas, or the procedural atlas's nearest until it loads. */
  private card(cell: number): number {
    if (this.cardArt) return cell;
    return cell === SPECIAL.ring ? Cell.Ring : cell === SPECIAL.star4 ? Cell.Star : cell === SPECIAL.streak ? Cell.Streak : Cell.Glow;
  }

  /** The orb's EMP burst (an EMP explosion where an orb flew): a flash and a tinted shockwave. */
  onEvents(events: readonly SimEvent[]): void {
    for (const e of events) {
      if (e.type !== 'explosion' || e.grenade !== EMP_GRENADE) continue;
      let orb = false;
      for (const t of this.tracks.values()) if (t.type === T_ORB && Math.abs(t.x - e.x) + Math.abs(t.y - e.y) < 1.5) orb = true;
      if (!orb) continue;
      let p = reset();
      p.x = e.x;
      p.y = e.y;
      p.z = 0.3;
      p.life = 0.18;
      p.size0 = 1.1;
      p.size1 = 1.4;
      p.alpha = this.steady ? 0.45 : 1;
      p.ramp = Ramp.Flash;
      p.cell = this.card(SPECIAL.orb0);
      [p.tr, p.tg, p.tb] = ORB_TINT;
      this.cardPool.emit(p);
      p = reset();
      p.x = e.x;
      p.y = e.y;
      p.z = 0.2;
      p.life = 0.28;
      p.size0 = 0.4;
      p.size1 = 2 * e.radius;
      p.ease = 0.4;
      p.alpha = 0.9;
      p.ramp = Ramp.Ring;
      p.cell = this.card(SPECIAL.ring);
      [p.tr, p.tg, p.tb] = [0.5, 0.77, 1];
      this.cardPool.emit(p);
    }
  }

  /** Every projectile, flame, burn and wind-up of this frame; call it after the avatars are posed. */
  update(frame: Frame, dt: number, fx: VfxContext): void {
    this.time += dt;
    const calm = fx.reducedMotion;
    for (const t of this.tracks.values()) t.seen = false;
    const counts = { rocket: 0, shell: 0, blade: 0 };
    this.cardPool.update(dt);
    this.flames.begin();
    this.cards.begin();
    let lightW = 0;
    let lightX = 0;
    let lightY = 0;
    for (const g of frame.grenades) {
      const type = g.type ?? 0;
      const def = projectileOfType(type);
      if (!def) continue;
      const track = this.track(g, type);
      const age = def.life - g.fuse / 60;
      if (type === T_ROCKET) this.rocket(g, track, dt, fx, counts.rocket++);
      else if (type === T_SHELL) this.shell(g, track, dt, fx, counts.shell++, calm);
      else if (type === T_BLADE) this.blade(g, track, dt, fx, counts.blade++, calm);
      else if (type === T_ORB) this.orb(g, track, dt, fx, calm);
      else if (type === T_FLAME) {
        const r = projectileRadius(def, age);
        this.flame(g, track, age, def.life, r, dt, fx, calm);
        lightX += g.x;
        lightY += g.y;
        lightW++;
      }
    }
    for (const [id, t] of this.tracks) if (!t.seen) this.tracks.delete(id);
    for (const k of ['rocket', 'shell', 'blade'] as const) {
      const m = this.meshes[k];
      m.count = counts[k];
      m.visible = counts[k] > 0;
      if (counts[k]) m.instanceMatrix.needsUpdate = true;
    }
    for (const p of frame.players) {
      if (!p.alive) {
        this.windups.delete(p.id);
        continue;
      }
      if (p.burning) this.burn(p, dt, fx, calm);
      else this.burns.delete(p.id);
      this.windup(p, dt, fx, calm);
    }
    // the stream's warm light (High): at the flames' centre, flickering (steady under Reduce flashes)
    if (this.lights && lightW > 0) {
      this.light.position.set(lightX / lightW, lightY / lightW, 0.8);
      this.light.intensity = 3 * (this.steady || calm ? 0.85 : 0.75 + 0.25 * Math.sin(this.time * 9 * Math.PI * 2));
    } else this.light.intensity = 0;
    this.cards.addPool(this.cardPool);
    this.flames.end();
    this.cards.end();
  }

  private track(g: GrenadeView, type: number): Track {
    const id = g.id ?? -1;
    let t = this.tracks.get(id);
    if (!t || t.type !== type) {
      t = { type, x: g.x, y: g.y, vx: g.vx ?? 0, vy: g.vy ?? 0, owed: 0, seed: (id * 2654435761) >>> 0, seen: true };
      this.tracks.set(id, t);
    }
    t.seen = true;
    return t;
  }

  /** where the trail's puffs this frame start from (the projectile's last position) */
  private fromX = 0;
  private fromY = 0;

  /**
   * How many trail puffs are due along the path since the last frame (one every `every` s, × the
   * preset's detail): the i-th of n goes at `along(i, n)` between fromX/fromY and the projectile.
   */
  private due(t: Track, g: GrenadeView, dt: number, every: number, fx: VfxContext): number {
    t.owed += (dt / every) * fx.detail;
    const n = Math.min(8, Math.floor(t.owed));
    t.owed -= n;
    this.fromX = t.x;
    this.fromY = t.y;
    t.x = g.x;
    t.y = g.y;
    return n;
  }

  /** the i-th of n puffs' position along the path just flown, into _a */
  private along(i: number, n: number, g: GrenadeView): Vector3 {
    const k = (i + 1) / n;
    return _a.set(this.fromX + (g.x - this.fromX) * k, this.fromY + (g.y - this.fromY) * k, 0);
  }

  /** The instance matrix: Y along the flight at (x, y, z), spun by `spin` about `axis`, scaled. */
  private place(mesh: InstancedMesh, i: number, g: GrenadeView, axis: Vector3 | null, spin: number, scale: number, faceOn = false): void {
    const vx = g.vx ?? 0;
    const vy = g.vy ?? 0;
    if (faceOn) _q.setFromUnitVectors(X, Z); // a blade's face (its +X) toward the camera
    else _q.setFromUnitVectors(UP, _d.set(vx, vy, 0).lengthSq() > 1e-6 ? _d.normalize() : _d.set(1, 0, 0));
    if (axis) _q.multiply(_q2.setFromAxisAngle(axis, spin));
    _m.compose(_p.set(g.x, g.y, 0), _q, _s.set(scale, scale, scale));
    mesh.setMatrixAt(i, _m);
  }

  private rocket(g: GrenadeView, t: Track, dt: number, fx: VfxContext, i: number): void {
    const s = DRAW_SCALE.rocket;
    this.place(this.meshes.rocket, i, g, UP, this.time * SPIN_RPS.rocket * Math.PI * 2, s);
    // the flame at its tail (the flipbook's first frames, flickering through them)
    _p.copy(TRAIL_AT.rocket).multiplyScalar(s).applyQuaternion(_q).add(_s.set(g.x, g.y, 0));
    // the flame flipbook's first frames (a 0.15–0.27 m flame in its cell: the style's 0.22 m)
    const frame = this.flameArt ? Math.floor(this.time * 20 + t.seed) % 5 : Cell.Fire;
    this.flames.sprite(_p.x, _p.y, 0.05, this.flameArt ? FLAME_CELL : 0.45, this.time * 3 + t.seed, 1, 1, 1, 1, frame);
    const tr = TRAILS.rocket;
    const ox = _p.x - g.x;
    const oy = _p.y - g.y;
    for (let i = 0, n = this.due(t, g, dt, tr.every, fx); i < n; i++) {
      this.along(i, n, g);
      const p = reset();
      p.x = _a.x + ox;
      p.y = _a.y + oy;
      p.z = (this.rand() - 0.5) * 0.15;
      p.vx = (this.rand() - 0.5) * 0.4;
      p.vy = 0.15 + this.rand() * 0.2;
      p.drag = 2;
      p.life = tr.life * (0.85 + this.rand() * 0.3);
      p.size0 = tr.size;
      p.size1 = tr.size * 3;
      p.ease = 0.6;
      p.rot = this.rand() * 6.28;
      p.ramp = Ramp.Trail;
      p.cell = Cell.Puff;
      [p.tr, p.tg, p.tb] = tr.tint;
      fx.smoke.emit(p);
    }
  }

  private shell(g: GrenadeView, t: Track, dt: number, fx: VfxContext, i: number, calm: boolean): void {
    this.place(this.meshes.shell, i, g, X, calm ? 0 : this.time * SPIN_RPS.shell * Math.PI * 2 * 4, DRAW_SCALE.shell);
    const tr = TRAILS.shell;
    for (let i = 0, n = this.due(t, g, dt, tr.every, fx); i < n; i++) {
      this.along(i, n, g);
      const p = reset();
      p.x = _a.x;
      p.y = _a.y;
      p.life = tr.life;
      p.size0 = tr.size;
      p.size1 = tr.size * 2.5;
      p.ease = 0.6;
      p.rot = this.rand() * 6.28;
      p.ramp = Ramp.Trail;
      p.cell = Cell.Puff;
      [p.tr, p.tg, p.tb] = tr.tint;
      fx.smoke.emit(p);
    }
  }

  private blade(g: GrenadeView, t: Track, dt: number, fx: VfxContext, i: number, calm: boolean): void {
    this.place(this.meshes.blade, i, g, X, (calm ? 0.25 : 1) * this.time * SPIN_RPS.blade * Math.PI * 2, DRAW_SCALE.blade, true);
    // a bounce: the flight turned sharply since the last frame — sparks off the wall, along the new path
    const vx = g.vx ?? 0;
    const vy = g.vy ?? 0;
    const was = Math.sqrt(t.vx * t.vx + t.vy * t.vy);
    const now = Math.sqrt(vx * vx + vy * vy);
    if (was > 1 && now > 1 && (t.vx * vx + t.vy * vy) / (was * now) < 0.6) this.sparks(g.x, g.y, vx / now, vy / now, fx);
    t.vx = vx;
    t.vy = vy;
    const tr = (g.state ?? 0) > 0 ? TRAILS.bladeHot : TRAILS.blade;
    for (let i = 0, n = this.due(t, g, dt, tr.every, fx); i < n; i++) {
      this.along(i, n, g);
      const p = reset();
      p.x = _a.x;
      p.y = _a.y;
      p.z = 0.05;
      p.life = tr.life;
      p.size0 = tr.size * DRAW_SCALE.blade;
      p.size1 = tr.size * 0.5;
      p.alpha = 0.7;
      p.ramp = Ramp.Haze;
      p.cell = this.card(SPECIAL.glow);
      [p.tr, p.tg, p.tb] = tr.tint;
      this.cardPool.emit(p);
    }
  }

  /** The Forge's bounce: 8–12 sparks fanning ±70° about (ux, uy), 3–6 m/s, 0.3 s. */
  private sparks(x: number, y: number, ux: number, uy: number, fx: VfxContext): void {
    const along = Math.atan2(uy, ux);
    for (let i = 0, n = Math.max(4, Math.round((8 + 4 * this.rand()) * fx.detail)); i < n; i++) {
      const a = along + (this.rand() * 2 - 1) * 1.22;
      const v = 3 + 3 * this.rand();
      const p = reset();
      p.x = x;
      p.y = y;
      p.z = 0.3;
      p.vx = Math.cos(a) * v;
      p.vy = Math.sin(a) * v;
      p.grav = 10;
      p.drag = 2;
      p.life = 0.2 + 0.1 * this.rand();
      p.size0 = 0.12;
      p.size1 = 0.06;
      p.aspect = 0.35;
      p.stretch = 0.03;
      p.ramp = Ramp.Spark;
      p.cell = Cell.Streak;
      [p.tr, p.tg, p.tb] = SPARK_TINT;
      fx.glow.emit(p);
    }
  }

  private orb(g: GrenadeView, t: Track, dt: number, fx: VfxContext, calm: boolean): void {
    // the orb flipbook (16 fps, looping), with a soft glow behind it
    const frame = this.cardArt ? SPECIAL.orb0 + (Math.floor(this.time * 16 + t.seed) % 4) : Cell.Glow;
    const size = 2 * ORB.radius * (calm ? 1 : 1 + 0.06 * Math.sin(this.time * 9 + t.seed));
    this.cards.sprite(g.x, g.y, 0.1, size * 1.8, 0, ORB_TINT[0] * 0.5, ORB_TINT[1] * 0.5, ORB_TINT[2] * 0.5, 0.6, this.card(SPECIAL.glow));
    this.cards.sprite(g.x, g.y, 0.12, size, calm ? 0 : this.time * 2, 1, 1, 1, 1, frame);
    const tr = TRAILS.orb;
    for (let i = 0, n = this.due(t, g, dt, tr.every, fx); i < n; i++) {
      this.along(i, n, g);
      const p = reset();
      p.x = _a.x;
      p.y = _a.y;
      p.z = 0.05;
      p.life = tr.life;
      p.size0 = tr.size * 2.4;
      p.size1 = tr.size;
      p.alpha = 0.8;
      p.ramp = Ramp.Haze;
      p.cell = this.card(SPECIAL.glow);
      [p.tr, p.tg, p.tb] = tr.tint;
      this.cardPool.emit(p);
    }
  }

  /**
   * One sim flame: three puffs of the flame flipbook along its first metre behind it (the stream
   * reads unbroken), each the flame's age into the flipbook and its radius, and a shimmer over it.
   */
  private flame(g: GrenadeView, t: Track, age: number, life: number, r: number, dt: number, fx: VfxContext, calm: boolean): void {
    const vx = g.vx ?? 0;
    const vy = g.vy ?? 0;
    const v = Math.sqrt(vx * vx + vy * vy) || 1;
    const back = Math.min(1, age * 7) / 3; // spread over what it has flown, ≤ 1 m
    for (let k = 0; k < 3; k++) {
      const a = Math.max(0, age - k * 0.04);
      const frame = this.flameArt ? Math.min(FLAME_FRAMES - 1, Math.floor((FLAME_FRAMES * a) / life)) : Cell.Fire;
      const h = (t.seed + k * 977) >>> 0;
      const roll = ((h % 360) * Math.PI) / 180 + (calm ? 0 : a * 2);
      const jitter = 0.9 + ((h >>> 9) % 21) / 100;
      // the flipbook paints the flame's growth inside a fixed cell; the stand-in sprite grows itself
      const size = (this.flameArt ? FLAME_CELL : 2.2 * r) * jitter * (1 - 0.12 * k);
      const fade = this.flameArt ? 1 : 1 - a / life;
      this.flames.sprite(g.x - (vx / v) * back * k, g.y - (vy / v) * back * k, (k - 1) * 0.06, size, roll, 1, 1, 1, fade, frame);
    }
    // heat shimmer: a faint warm haze rising off the stream (not on Low, not under Reduce motion)
    if (calm || fx.detail < 0.7) return;
    t.owed += dt / 0.12;
    if (t.owed < 1) return;
    t.owed -= 1;
    const p = reset();
    p.x = g.x + (this.rand() - 0.5) * r;
    p.y = g.y + r * 0.8;
    p.z = 0.15;
    p.vx = (this.rand() - 0.5) * 0.3;
    p.vy = 0.9;
    p.drag = 1;
    p.life = 0.35;
    p.size0 = r * 1.6;
    p.size1 = r * 2.6;
    p.alpha = 0.18;
    p.spin = (this.rand() - 0.5) * 3;
    p.rot = this.rand() * 6.28;
    p.ramp = Ramp.Haze;
    p.cell = Cell.Puff;
    [p.tr, p.tg, p.tb] = [1, 0.85, 0.7];
    fx.smoke.emit(p);
  }

  /** A burning player: flames at the chest (the flipbook's frames 1–7, looping) and embers. */
  private burn(p: PlayerView, dt: number, fx: VfxContext, calm: boolean): void {
    for (let k = 0; k < 2; k++) {
      const f = Math.floor(this.time * (calm ? 10 : 20) + p.id * 3 + k * 3) % 7;
      const frame = this.flameArt ? 1 + f : Cell.Fire;
      const sway = calm ? 0 : Math.sin(this.time * 7 + k * 2 + p.id) * 0.05;
      // frames 1–7: a flame of about the style's 0.35 m in a cell two-thirds the stream's
      const size = (this.flameArt ? FLAME_CELL * 0.65 : 0.55) * (1 - 0.2 * k);
      this.flames.sprite(p.x + (k - 0.5) * 0.18 + sway, p.y + 0.95 + k * 0.15, 0.25, size, sway * 2, 1, 1, 1, 1, frame);
    }
    let owed = (this.burns.get(p.id) ?? 0) + (dt / 0.06) * fx.detail * (calm ? 0.5 : 1);
    for (; owed >= 1; owed--) {
      const e = reset();
      e.x = p.x + (this.rand() - 0.5) * 0.4;
      e.y = p.y + 0.6 + this.rand() * 0.7;
      e.z = 0.3;
      e.vx = (this.rand() - 0.5) * 0.6;
      e.vy = 0.8 + this.rand() * 0.8;
      e.drag = 1.5;
      e.life = 0.35 + 0.25 * this.rand();
      e.size0 = 0.07;
      e.size1 = 0.02;
      e.ramp = Ramp.Fire;
      e.cell = Cell.Glow;
      fx.glow.emit(e);
    }
    this.burns.set(p.id, owed);
  }

  /**
   * The gun in hand's tell: a Ripper's sparks at its `charge` socket, a Pulse's glow gathering there
   * (with a ring closing in), a Shredder's barrels blurring at the muzzle; a Dragon's pilot light,
   * always on.
   */
  private windup(p: PlayerView, dt: number, fx: VfxContext, calm: boolean): void {
    const def = weapons[p.weapons[p.active]?.def ?? -1];
    if (def?.id === 'dragon' && this.gunPoint(p.id, def.index, 'pilot', _p)) {
      const flicker = this.steady || calm ? 1 : 0.8 + 0.2 * Math.sin(this.time * 14 * Math.PI * 2 + p.id);
      this.cards.sprite(_p.x, _p.y, _p.z + 0.02, 0.07 * 2.4 * flicker, 0, 1, 0.75, 0.4, 1, this.card(SPECIAL.pilot));
    }
    if (!p.windup || !def) {
      this.windups.delete(p.id);
      return;
    }
    let w = this.windups.get(p.id);
    if (!w) this.windups.set(p.id, (w = { t: 0, owed: 0 }));
    w.t += dt;
    if (def.id === 'ripper') {
      if (!this.gunPoint(p.id, def.index, 'charge', _p)) return;
      w.owed += (dt / 0.05) * fx.detail * (calm ? 0.5 : 1);
      for (; w.owed >= 1; w.owed--) {
        const a = this.rand() * Math.PI * 2;
        const v = 1 + 1.5 * this.rand();
        const s = reset();
        s.x = _p.x;
        s.y = _p.y;
        s.z = _p.z;
        s.vx = Math.cos(a) * v;
        s.vy = Math.sin(a) * v;
        s.grav = 6;
        s.life = 0.15 + 0.1 * this.rand();
        s.size0 = 0.08;
        s.size1 = 0.03;
        s.aspect = 0.35;
        s.stretch = 0.02;
        s.ramp = Ramp.Spark;
        s.cell = Cell.Streak;
        [s.tr, s.tg, s.tb] = CHARGE_SPARK_TINT;
        fx.glow.emit(s);
      }
    } else if (def.id === 'pulse') {
      if (!this.gunPoint(p.id, def.index, 'charge', _p)) return;
      const k = Math.min(1, w.t / 0.7);
      this.cards.sprite(_p.x, _p.y, _p.z + 0.02, 0.03 + 0.11 * k, 0, ORB_TINT[0], ORB_TINT[1], ORB_TINT[2], 0.9, this.card(SPECIAL.glow));
      this.cards.sprite(_p.x, _p.y, _p.z + 0.02, 2 * (0.3 - 0.24 * k), 0, 0.62, 0.82, 1, 0.8 * (1 - k * 0.5), this.card(SPECIAL.ring));
    } else if (def.id === 'shredder' && !calm) {
      if (!this.gunPoint(p.id, def.index, 'muzzle', _p)) return;
      const spin = w.t * 40;
      for (let i = 0; i < 2; i++) this.cards.sprite(_p.x, _p.y, _p.z, 0.16, spin + i * 1.57, 0.8, 0.8, 0.85, 0.35, this.card(SPECIAL.streak));
    }
  }

  /** projectiles drawn (tests) */
  get count(): number {
    return this.tracks.size;
  }

  /** One of each on show at (x, y) so the shader warm-up compiles them; `clear()` after. */
  showForWarmUp(x: number, y: number): void {
    _m.makeTranslation(x, y, 0);
    for (const m of Object.values(this.meshes)) {
      m.setMatrixAt(0, _m);
      m.count = 1;
      m.visible = true;
    }
    this.flames.begin();
    this.flames.sprite(x, y, 0, 0.5, 0, 1, 1, 1, 1, 0);
    this.flames.end();
    this.cards.begin();
    this.cards.sprite(x, y, 0, 0.5, 0, 1, 1, 1, 1, 0);
    this.cards.end();
  }

  clear(): void {
    for (const m of Object.values(this.meshes)) {
      m.count = 0;
      m.visible = false;
    }
    this.flames.begin();
    this.flames.end();
    this.cards.begin();
    this.cards.end();
    this.cardPool.clear();
    this.tracks.clear();
    this.windups.clear();
    this.burns.clear();
    this.light.intensity = 0;
  }

  dispose(): void {
    for (const m of Object.values(this.meshes)) {
      m.removeFromParent();
      m.geometry.dispose();
      m.dispose();
    }
    this.flames.dispose();
    this.cards.dispose();
    this.material.dispose();
    this.light.removeFromParent();
  }
}
