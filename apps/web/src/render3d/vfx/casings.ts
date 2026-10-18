/**
 * Spent casings (the owner, 18 Oct: "each gun shows its own mechanism when it fires: casings
 * ejected…"). A casing leaves the drawn gun's `eject` socket (sockets.json) along its direction,
 * spinning, falls, bounces once or twice off the map and lies there until it shrinks away. When it
 * goes is the gun's (the Forge's weapons.vfx.json `eject`): every shot (pistols, SMGs, rifles), on
 * the pump's or the bolt's back stroke after the shot (`ejectDelayMs`), or the spent rounds all at
 * once when a revolver's reload starts (`ejectCount`). Melee weapons and launchers drop none.
 *
 * Shapes are the Forge's casings.glb (weapons.vfx.json `casings.types[kind].node`), with brass
 * stand-ins until it loads; the sniper's big case is its own node when the file has one, else the
 * rifle case 1.35× larger. All are drawn CASING_DRAW_SCALE× so they read at gameplay zoom. Every
 * live casing of a kind is an instance of one InstancedMesh: a draw call per kind while any are
 * out, none otherwise. The steady state allocates nothing.
 */
import { NO_WEAPON, weapons, type WeaponDef } from '@military-forge/content';
import { SegFlag, createRayHit, type CollisionWorld, type SimEvent } from '@military-forge/sim';
import { BufferAttribute, CylinderGeometry, DynamicDrawUsage, InstancedMesh, Matrix4, MeshToonMaterial, Quaternion, Vector3, type BufferGeometry, type Scene, type Texture } from 'three';
import type { Frame } from '../../view';
import { firesWhileHeld } from './gunfire';

/** what a gun drops; each is drawn by its own InstancedMesh */
export type CasingKind = 'pistol' | 'rifle' | 'shotgun' | 'sniper';
export const CASING_KINDS: readonly CasingKind[] = ['pistol', 'rifle', 'shotgun', 'sniper'];
/** when a gun drops its casings */
export type EjectMode = 'shot' | 'pump' | 'bolt' | 'reload';
export const EJECT_MODES: readonly EjectMode[] = ['shot', 'pump', 'bolt', 'reload'];

/** A casing kind's flight (weapons.vfx.json `casings.types`). */
export interface CasingFlight {
  /** m/s out of the port */
  speed: number;
  /** half-angle of the scatter around the eject direction, rad */
  cone: number;
  /** turns a second */
  spin: number;
  /** seconds until it's gone (it shrinks away over the last FADE_S) */
  life: number;
}

/** How a gun ejects. */
export interface GunEject {
  kind: CasingKind;
  mode: EjectMode;
  /** seconds after the shot (a pump's or bolt's back stroke) */
  delay: number;
  /** most casings at once (a revolver's reload: its chambers) */
  count: number;
}

/** weapons.vfx.json's casing fields (vfx/manifest.ts parseWeaponVfx) */
export interface CasingArt {
  /** the model file, in assets/vfx/ */
  file: string;
  types: Partial<Record<CasingKind, CasingFlight & { node: string | null }>>;
  /** by weapon id; null: drops none */
  weapons: Record<string, GunEject | null>;
}

const DEG = Math.PI / 180;
/** the Forge's numbers (weapons.vfx.json, 17 Oct) until the file says otherwise */
export const DEFAULT_FLIGHTS: Readonly<Record<CasingKind, CasingFlight>> = {
  pistol: { speed: 2.2, cone: 18 * DEG, spin: 18, life: 1.4 },
  rifle: { speed: 2.8, cone: 15 * DEG, spin: 22, life: 1.5 },
  shotgun: { speed: 1.8, cone: 20 * DEG, spin: 10, life: 1.8 },
  sniper: { speed: 2.4, cone: 12 * DEG, spin: 14, life: 1.8 },
};
/** casings.glb's node for a kind when weapons.vfx.json names none (the first that exists) */
export const DEFAULT_NODES: Readonly<Record<CasingKind, readonly string[]>> = {
  pistol: ['casing_pistol'],
  rifle: ['casing_rifle'],
  shotgun: ['shell_shotgun', 'casing_shotgun'],
  sniper: ['casing_sniper'],
};

/** the sniper's case, when casings.glb has none: the rifle case this much larger */
export const SNIPER_SCALE = 1.35;
/** the end of a casing's life, when it shrinks away (the Forge: fade over the last 300 ms) */
const FADE_S = 0.3;
/** most casings out at once (the Forge's maxLive), on Low, and under Reduce motion (which also spins them slower) */
export const CASINGS_MAX = 32;
export const CASINGS_LOW = 16;
export const CASINGS_CALM = 8;
const CALM_SPIN = 0.4;
const GRAVITY = 9.8;
/** a bounce keeps this much of the speed into the surface, and along it */
const RESTITUTION = 0.35;
const FRICTION = 0.7;
/** slower than this after touching down on a floor (m/s): it lies still */
const SETTLE_SPEED = 0.8;
/** casings stay this close to the gameplay plane (m), in front of the background */
const Z_MAX = 0.7;
/** a flung casing's throw: this much of the port's depth kept, and the bias back along the bore and up */
const DEPTH_KEEP = 0.35;
const BACK = 0.45;
const UP_BIAS = 0.6;
/** of the shooter's own velocity, a casing keeps this much */
const INHERIT = 0.6;
/**
 * Casings are drawn this much larger than the Forge's models (themselves chunkier than life), so
 * they read at gameplay zoom (36 m across the screen: a 5 cm case would be two pixels), as the frag
 * is (grenades.ts GRENADE_WIDTH_M)
 */
export const CASING_DRAW_SCALE = 2;
/** a drawn casing's radius (m): it lies this far off the surface */
const RADIUS = 0.018 * CASING_DRAW_SCALE;

/**
 * How weapon `def` ejects: the Forge's entry for it when it has one, else by its class (sidearms
 * and SMGs a pistol case a shot, rifles a rifle case, a pump shotgun its shell on the pump, a
 * sniper its big case on the bolt). A sniper drops the big case whatever the file says.
 */
export function gunEject(def: WeaponDef | undefined, art: CasingArt | null): GunEject | null {
  if (!def) return null;
  const listed = art && Object.hasOwn(art.weapons, def.id) ? art.weapons[def.id]! : undefined;
  let e: GunEject | null;
  if (listed !== undefined) e = listed && { ...listed };
  else if (def.class === 'sidearm' || def.class === 'smg') e = { kind: 'pistol', mode: 'shot', delay: 0, count: 1 };
  else if (def.class === 'rifle' || def.class === 'dmr' || def.class === 'heavy') e = { kind: 'rifle', mode: 'shot', delay: 0, count: 1 };
  else if (def.class === 'shotgun') e = firesWhileHeld(def) ? { kind: 'shotgun', mode: 'shot', delay: 0, count: 1 } : { kind: 'shotgun', mode: 'pump', delay: 0.25, count: 1 };
  else if (def.class === 'sniper') e = { kind: 'sniper', mode: 'bolt', delay: 0.35, count: 1 };
  else e = null; // melee, specials (launchers…)
  if (e && def.class === 'sniper' && e.kind === 'rifle') e.kind = 'sniper';
  return e;
}

/**
 * Where a shooter's gun that fired `weapon` ejects, in world space, which way, and the gun's bore
 * (toward its muzzle). False: that gun isn't drawn.
 */
export type EjectLookup = (shooter: number, weapon: number, out: Vector3, dir: Vector3, bore: Vector3) => boolean;

// one casing in `data`: position, velocity, spin axis, angle and rate, age, life, kind, state, and
// the orientation it left with
const X = 0;
const Y = 1;
const Z = 2;
const VX = 3;
const VY = 4;
const VZ = 5;
const AX = 6;
const AY = 7;
const AZ = 8;
const ANGLE = 9;
const SPIN = 10;
const AGE = 11;
const LIFE = 12;
const KIND = 13;
const RESTING = 14;
const BOUNCES = 15;
const QX = 16;
const QY = 17;
const QZ = 18;
const QW = 19;
const STRIDE = 20;

/** ejections waiting for a pump's or bolt's back stroke */
const PENDING_MAX = 64;

const _p = new Vector3();
const _d = new Vector3();
const _b = new Vector3();
const _a = new Vector3();
const _s = new Vector3();
const _q = new Quaternion();
const _q2 = new Quaternion();
const _m = new Matrix4();
const UP = new Vector3(0, 1, 0);
const hit = createRayHit();

/** A stand-in casing along Y: a brass cylinder, or a shell's red hull on a brass head. */
function standIn(radius: number, length: number, shell: boolean): BufferGeometry {
  const g = new CylinderGeometry(radius, radius, length, 8, 1).toNonIndexed();
  const pos = g.getAttribute('position');
  const color = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) color.set(!shell || pos.getY(i) < -length * 0.3 ? [0.78, 0.56, 0.2] : [0.62, 0.08, 0.06], i * 3);
  g.setAttribute('color', new BufferAttribute(color, 3));
  return g;
}

export class Casings {
  readonly meshes: Readonly<Record<CasingKind, InstancedMesh>>;
  private readonly byKind: InstancedMesh[];
  private readonly material: MeshToonMaterial;
  private readonly data = new Float32Array(CASINGS_MAX * STRIDE);
  private live = 0;
  private max = CASINGS_MAX;
  private calm = false;
  private readonly ejects: (GunEject | null)[] = [];
  private readonly flights: Record<CasingKind, CasingFlight> = { ...DEFAULT_FLIGHTS };
  private time = 0;
  /** deterministic scatter (no Math.random: stepped screenshots repeat) */
  private seed = 7;
  private readonly dueShooter = new Int32Array(PENDING_MAX);
  private readonly dueWeapon = new Int32Array(PENDING_MAX);
  private readonly dueAt = new Float64Array(PENDING_MAX);
  private dueCount = 0;
  /** per player: the active slot's reload ticks last frame (a revolver dumps its rounds as a reload starts) */
  private readonly reloading = new Map<number, number>();
  /** shots seen in this batch (a shotgun's pellets are one shot) */
  private readonly batch = new Set<number>();
  private readonly counts = [0, 0, 0, 0];

  constructor(
    scene: Scene,
    ramp: Texture,
    /** the map's collision (Vfx.setMap swaps it) */
    public world: CollisionWorld,
    private readonly ejectOf: EjectLookup = () => false,
  ) {
    this.material = new MeshToonMaterial({ vertexColors: true, gradientMap: ramp });
    const make = (kind: CasingKind, g: BufferGeometry) => {
      const m = new InstancedMesh(g, this.material, CASINGS_MAX);
      m.name = `vfx-casings-${kind}`;
      m.instanceMatrix.setUsage(DynamicDrawUsage);
      m.count = 0;
      m.visible = false;
      m.frustumCulled = false; // the instances spread far past the base geometry's bounds
      scene.add(m);
      return m;
    };
    const rifle = standIn(0.018, 0.093, false);
    this.meshes = {
      pistol: make('pistol', standIn(0.018, 0.048, false)),
      rifle: make('rifle', rifle),
      shotgun: make('shotgun', standIn(0.024, 0.102, true)),
      sniper: make('sniper', rifle.clone().scale(SNIPER_SCALE, SNIPER_SCALE, SNIPER_SCALE)),
    };
    this.byKind = CASING_KINDS.map((k) => this.meshes[k]);
    this.setArt(null);
  }

  /** casings.glb's shapes by kind (a missing sniper case: the rifle's, larger). */
  setModels(models: Partial<Record<CasingKind, BufferGeometry>>): void {
    const sniper = models.sniper ?? models.rifle?.clone().scale(SNIPER_SCALE, SNIPER_SCALE, SNIPER_SCALE);
    for (const kind of CASING_KINDS) {
      const g = kind === 'sniper' ? sniper : models[kind];
      if (!g) continue;
      this.meshes[kind].geometry.dispose();
      this.meshes[kind].geometry = g;
    }
  }

  /** weapons.vfx.json's casing fields (null: the Forge's numbers built in, ejection by class). */
  setArt(art: CasingArt | null): void {
    for (const kind of CASING_KINDS) {
      const t = art?.types[kind];
      this.flights[kind] = t ? { speed: t.speed, cone: t.cone, spin: t.spin, life: t.life } : DEFAULT_FLIGHTS[kind];
    }
    this.ejects.length = 0;
    for (const def of weapons) this.ejects[def.index] = gunEject(def, art);
  }

  /** How weapon `index` ejects (null: it doesn't). */
  ejectFor(index: number): GunEject | null {
    return this.ejects[index] ?? null;
  }

  /** Low keeps fewer out; Reduce motion fewer still, spinning slower. */
  setLimits(low: boolean, reducedMotion: boolean): void {
    this.calm = reducedMotion;
    this.max = reducedMotion ? CASINGS_CALM : low ? CASINGS_LOW : CASINGS_MAX;
    while (this.live > this.max) this.remove(0);
  }

  /** A new map: none carried over. */
  clear(): void {
    this.live = 0;
    this.dueCount = 0;
    this.reloading.clear();
    for (const m of this.byKind) {
      m.count = 0;
      m.visible = false;
    }
  }

  /** One batch of sim events: a casing a shot (pellets are one), now or on the gun's back stroke. */
  onEvents(events: readonly SimEvent[]): void {
    this.batch.clear();
    for (const e of events) {
      if (e.type !== 'shot') continue;
      const key = e.shooter * 64 + e.weapon;
      if (this.batch.has(key)) continue;
      this.batch.add(key);
      const eject = this.ejects[e.weapon];
      if (!eject || eject.mode === 'reload' || this.dueCount >= PENDING_MAX) continue;
      const i = this.dueCount++;
      this.dueShooter[i] = e.shooter;
      this.dueWeapon[i] = e.weapon;
      this.dueAt[i] = this.time + eject.delay;
    }
  }

  private rand(): number {
    this.seed = (Math.imul(this.seed, 1664525) + 1013904223) >>> 0;
    return this.seed / 4294967296;
  }

  /** Steps every casing and draws them; call it after the avatars are posed (they leave the drawn guns). */
  update(frame: Frame, dt: number): void {
    this.time += dt;
    this.watchReloads(frame);
    let kept = 0;
    for (let i = 0; i < this.dueCount; i++) {
      if (this.dueAt[i]! <= this.time) {
        this.eject(this.dueShooter[i]!, this.dueWeapon[i]!, 1, frame, false);
        continue;
      }
      this.dueShooter[kept] = this.dueShooter[i]!;
      this.dueWeapon[kept] = this.dueWeapon[i]!;
      this.dueAt[kept] = this.dueAt[i]!;
      kept++;
    }
    this.dueCount = kept;
    this.step(dt);
    this.draw();
  }

  /** A revolver's reload starting: its spent rounds drop out together. */
  private watchReloads(frame: Frame): void {
    for (const p of frame.players) {
      const slot = p.alive ? p.weapons[p.active] : undefined;
      const ticks = slot && slot.def !== NO_WEAPON ? slot.reloadTicks : 0;
      const before = this.reloading.get(p.id) ?? 0;
      if (ticks !== before) this.reloading.set(p.id, ticks);
      if (!slot || ticks <= 0 || before > 0) continue;
      const eject = this.ejects[slot.def];
      if (eject?.mode !== 'reload') continue;
      // the rounds fired since the last reload (online, remote players' mags are unknown: all of them)
      const mag = weapons[slot.def]?.mag ?? eject.count;
      const spent = slot.mag > 0 ? Math.min(eject.count, mag - slot.mag) : eject.count;
      if (spent > 0) this.eject(p.id, slot.def, spent, frame, true);
    }
  }

  /** `n` casings from `shooter`'s gun; `dump`: falling out of a swung-out cylinder rather than flung. */
  private eject(shooter: number, weapon: number, n: number, frame: Frame, dump: boolean): void {
    const e = this.ejects[weapon];
    if (!e || !this.ejectOf(shooter, weapon, _p, _d, _b)) return;
    // the port faces the gun's side, mostly toward or away from the camera: the throw keeps a little
    // of that depth and arcs up and back over the shooter's shoulder, where the side view shows it
    _d.z *= DEPTH_KEEP;
    _d.addScaledVector(_b, -BACK);
    _d.y += UP_BIAS;
    _d.normalize();
    const flight = this.flights[e.kind];
    let vx = 0;
    let vy = 0;
    for (const p of frame.players) {
      if (p.id !== shooter) continue;
      vx = p.vx * INHERIT;
      vy = p.vy * INHERIT;
      break;
    }
    const kind = CASING_KINDS.indexOf(e.kind);
    const d = this.data;
    for (let k = 0; k < n; k++) {
      if (this.live >= this.max) this.remove(0); // the oldest goes
      const o = this.live++ * STRIDE;
      // out along the eject direction (a dump: down), scattered inside the cone
      _s.copy(dump ? _a.set(0, -1, 0) : _d);
      _a.set(this.rand() - 0.5, this.rand() - 0.5, this.rand() - 0.5).cross(_s);
      if (_a.lengthSq() < 1e-8) _a.set(0, 0, 1);
      _s.applyAxisAngle(_a.normalize(), (this.rand() * 2 - 1) * flight.cone);
      const speed = flight.speed * (dump ? 0.2 : 0.8 + this.rand() * 0.4);
      d[o + X] = _p.x + (dump ? (this.rand() - 0.5) * 0.05 : 0);
      d[o + Y] = _p.y;
      d[o + Z] = _p.z;
      d[o + VX] = _s.x * speed + vx;
      d[o + VY] = _s.y * speed + vy;
      d[o + VZ] = _s.z * speed;
      // spinning about a random axis
      _a.set(this.rand() - 0.5, this.rand() - 0.5, this.rand() - 0.5);
      if (_a.lengthSq() < 1e-8) _a.set(1, 0, 0);
      _a.normalize();
      d[o + AX] = _a.x;
      d[o + AY] = _a.y;
      d[o + AZ] = _a.z;
      d[o + ANGLE] = this.rand() * Math.PI * 2;
      d[o + SPIN] = flight.spin * Math.PI * 2 * (this.calm ? CALM_SPIN : 1) * (this.rand() < 0.5 ? -1 : 1);
      d[o + AGE] = 0;
      d[o + LIFE] = flight.life * (0.9 + this.rand() * 0.2);
      d[o + KIND] = kind;
      d[o + RESTING] = 0;
      d[o + BOUNCES] = 0;
      // it leaves lying across its throw: its long axis (Y) at right angles to the eject direction
      _a.set(-_d.y, _d.x, 0);
      if (_a.lengthSq() < 1e-6) _a.set(1, 0, 0);
      _q.setFromUnitVectors(UP, _a.normalize());
      d[o + QX] = _q.x;
      d[o + QY] = _q.y;
      d[o + QZ] = _q.z;
      d[o + QW] = _q.w;
    }
  }

  /** Removes casing `i` (the last one takes its place). */
  private remove(i: number): void {
    const last = --this.live;
    if (i !== last) this.data.copyWithin(i * STRIDE, last * STRIDE, last * STRIDE + STRIDE);
  }

  private step(dt: number): void {
    const d = this.data;
    for (let i = 0; i < this.live; i++) {
      const o = i * STRIDE;
      d[o + AGE]! += dt;
      if (d[o + AGE]! >= d[o + LIFE]!) {
        this.remove(i--);
        continue;
      }
      if (d[o + RESTING]) continue;
      d[o + VY]! -= GRAVITY * dt;
      d[o + ANGLE]! += d[o + SPIN]! * dt;
      const mx = d[o + VX]! * dt;
      const my = d[o + VY]! * dt;
      const len = Math.sqrt(mx * mx + my * my);
      // one-way platforms catch it only on the way down
      const ignore = my > 0 ? SegFlag.OneWay : 0;
      const into = len > 1e-7 && this.world.raycast(d[o + X]!, d[o + Y]!, mx / len, my / len, len + RADIUS, ignore, hit);
      const nx = into ? this.world.nx[hit.seg]! : 0;
      const ny = into ? this.world.ny[hit.seg]! : 0;
      const vn = d[o + VX]! * nx + d[o + VY]! * ny;
      if (into && vn < 0) {
        // up to the surface, then a bounce: most of the speed into it is lost, some along it
        const t = Math.max(0, hit.t - RADIUS);
        d[o + X]! += (mx / len) * t;
        d[o + Y]! += (my / len) * t;
        const tx = d[o + VX]! - vn * nx;
        const ty = d[o + VY]! - vn * ny;
        d[o + VX] = tx * FRICTION - vn * RESTITUTION * nx;
        d[o + VY] = ty * FRICTION - vn * RESTITUTION * ny;
        d[o + VZ]! *= FRICTION;
        d[o + SPIN]! *= 0.5;
        const speed = Math.sqrt(d[o + VX]! * d[o + VX]! + d[o + VY]! * d[o + VY]!);
        if (ny > 0.6 && (++d[o + BOUNCES]! >= 3 || speed < SETTLE_SPEED)) this.settle(o, nx, ny);
      } else {
        // free (or leaving a wall from inside it, as from a gun held into one)
        d[o + X]! += mx;
        d[o + Y]! += my;
      }
      d[o + Z]! += d[o + VZ]! * dt;
      if (Math.abs(d[o + Z]!) > Z_MAX) {
        d[o + Z] = Math.sign(d[o + Z]!) * Z_MAX;
        d[o + VZ]! *= -RESTITUTION;
      }
    }
  }

  /** On a floor with normal (nx, ny): lying on its side along it, as it came to rest. */
  private settle(o: number, nx: number, ny: number): void {
    const d = this.data;
    d[o + RESTING] = 1;
    d[o + VX] = d[o + VY] = d[o + VZ] = 0;
    // its long axis along the floor, turned a little in depth; it rolls no more
    _a.set(ny, -nx, (this.rand() - 0.5) * 0.8).normalize();
    _q.setFromUnitVectors(UP, _a);
    d[o + QX] = _q.x;
    d[o + QY] = _q.y;
    d[o + QZ] = _q.z;
    d[o + QW] = _q.w;
    d[o + AX] = _a.x; // what's left of the spin turns it about its own axis
    d[o + AY] = _a.y;
    d[o + AZ] = _a.z;
  }

  private draw(): void {
    const d = this.data;
    const counts = this.counts;
    counts.fill(0);
    for (let i = 0; i < this.live; i++) {
      const o = i * STRIDE;
      const kind = d[o + KIND]!;
      const left = d[o + LIFE]! - d[o + AGE]!;
      const s = CASING_DRAW_SCALE * (left < FADE_S ? left / FADE_S : 1);
      _q.set(d[o + QX]!, d[o + QY]!, d[o + QZ]!, d[o + QW]!);
      _q.premultiply(_q2.setFromAxisAngle(_a.set(d[o + AX]!, d[o + AY]!, d[o + AZ]!), d[o + ANGLE]!));
      _m.compose(_p.set(d[o + X]!, d[o + Y]!, d[o + Z]!), _q, _s.set(s, s, s));
      this.byKind[kind]!.setMatrixAt(counts[kind]!++, _m);
    }
    for (let k = 0; k < this.byKind.length; k++) {
      const mesh = this.byKind[k]!;
      mesh.count = counts[k]!;
      mesh.visible = counts[k]! > 0;
      if (counts[k]) mesh.instanceMatrix.needsUpdate = true;
    }
  }

  /** casings out (tests, the perf panel) */
  get count(): number {
    return this.live;
  }

  /** One of each on show at `at`, so the shader warm-up compiles the instanced program; `clear()` after. */
  showForWarmUp(at: Vector3): void {
    _m.makeTranslation(at.x, at.y, at.z);
    for (const m of this.byKind) {
      m.setMatrixAt(0, _m);
      m.count = 1;
      m.visible = true;
    }
  }

  dispose(): void {
    for (const m of this.byKind) {
      m.removeFromParent();
      m.geometry.dispose();
      m.dispose();
    }
    this.material.dispose();
  }
}
