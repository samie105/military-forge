/**
 * Smoke and gas clouds, and the grenades other than the frag (arsenal B; docs/02 §14, docs/11).
 *
 * A cloud is a cluster of soft camera-facing puffs (sprites) spread around its centre and through
 * the depth of the gameplay plane. Their size and opacity follow the sim (CloudView: radius and
 * density come from sim/clouds.ts). Smoke is a dense grey: the puffs in front of the plane are
 * drawn after the opaque scene without writing depth, so they hide whoever is inside or behind
 * the cloud. Gas is a thin, sickly green-yellow haze that hides nothing, so "cover" and "deadly"
 * read apart at a glance.
 *
 * Walls bound a cloud in the sim (a point is in it only with no wall between it and the centre),
 * so every puff is masked to the part of the cloud its centre reaches (cloudReach): thin walls
 * included, nothing shows on their far side.
 *
 * Thrown grenades and the grenade pairs on the map are render3d-b's grenades.ts, one Forge model
 * per type (#91). This layer draws a thrown mine: a dark puck with a state light (green flying,
 * yellow arming, flashing red armed, a fast red/white beep when triggered). It is an effect module
 * (Vfx.register): a flashbang going off is a quick pop and a ring, never a screen-sized flash (the
 * white-out is the fx overlay's), and an EMP is a blue ring out to its radius.
 */
import { EMP, FLASHBANG, GAS, MINE, SMOKE } from '@military-forge/content';
import { MineState, cloudDef, type CollisionWorld, type SimEvent } from '@military-forge/sim';
import {
  AdditiveBlending,
  Color,
  CylinderGeometry,
  DataTexture,
  Group,
  LinearFilter,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  RedFormat,
  SphereGeometry,
  Sprite,
  SpriteMaterial,
  Vector4,
  type Scene,
} from 'three';
import { reduceFlashes } from '../fx';
import { REACH_RAYS, cloudReach, reachToward } from '../grenadeViews';
import type { CloudView, Frame, GrenadeView } from '../view';
import type { VfxContext, VfxModule } from './vfx';
import { Cell } from './vfx/atlas';
import { particleSpec, type ParticleSpec } from './vfx/pool';
import { Ramp } from './vfx/ramps';

interface CloudStyle {
  color: number;
  /** puffs per cloud */
  puffs: number;
  /** opacity of one puff at full density */
  alpha: number;
  /** puff size, as a share of the cloud's radius */
  size: number;
}

const STYLES: Record<number, CloudStyle> = {
  [SMOKE.index]: { color: 0xa7adb5, puffs: 18, alpha: 0.8, size: 1.2 },
  [GAS.index]: { color: 0x9fbe26, puffs: 12, alpha: 0.32, size: 1.25 },
};

/** Smoke's dense core: one flat-topped billboard over the part that blocks sight (CloudView.opaque). */
const CORE_ALPHA = 0.9;
const CORE_Z = 0.55;

/** Puff centres sit within this share of the cloud's radius; their soft edges fill out the rest. */
const SPREAD = 0.55;
/**
 * Depth range of the puffs (m). The terrain's front face is at z = +1 (mapGeometry), so puffs stay
 * just behind it: a cloud never shows below the floor or through the front of a wall, while the
 * puffs in front of the players (z = 0, ±0.3) hide whoever is inside or behind the smoke.
 */
const Z_BACK = -0.8;
const Z_FRONT = 0.9;

const MINE_LIGHTS = { green: 0x3fb950, yellow: 0xd29922, red: 0xf85149, dark: 0x3a1210, white: 0xffffff };

/** The Forge's state light (grenades.vfx.json): armed blinks 4 Hz, a triggered mine beeps fast red/white. */
export const MINE_ARMED_HZ = 4;
export const MINE_BEEP_HZ = 8;
/** Reduce motion or Reduce flashes: no light blinks faster than this (the spec's reducedMotionMaxHz) */
export const MINE_CALM_HZ = 3;

/** On in the first half of each `hz` cycle at `time` (s). */
const blinkOn = (time: number, hz: number): boolean => Math.floor(time * hz * 2) % 2 === 0;

/** A mine's light colour by state, blinking by the client clock (seconds), never faster than `maxHz`. */
export function mineLight(state: number, time: number, maxHz = Infinity): number {
  if (state === MineState.Flying) return MINE_LIGHTS.green;
  if (state === MineState.Arming) return MINE_LIGHTS.yellow;
  if (state === MineState.Armed) return blinkOn(time, Math.min(MINE_ARMED_HZ, maxHz)) ? MINE_LIGHTS.red : MINE_LIGHTS.dark;
  return blinkOn(time, Math.min(MINE_BEEP_HZ, maxHz)) ? MINE_LIGHTS.red : MINE_LIGHTS.white;
}

/** A mine: a dark puck facing the camera, an unlit light on its face and a glow around it (one per mine). */
class MineMesh {
  readonly group = new Group();
  readonly light: Mesh<SphereGeometry, MeshBasicMaterial>;
  /** the light's glow, so the state reads at gameplay zoom (the puck is ~30 cm) */
  readonly glow: Sprite;

  constructor(puck: CylinderGeometry, body: MeshLambertMaterial, bulb: SphereGeometry, glowTexture: DataTexture) {
    const p = new Mesh(puck, body);
    p.rotation.x = Math.PI / 2; // the flat face toward the camera
    this.light = new Mesh(bulb, new MeshBasicMaterial({ color: MINE_LIGHTS.green }));
    this.light.position.z = 0.05;
    this.glow = new Sprite(new SpriteMaterial({ map: glowTexture, color: MINE_LIGHTS.green, transparent: true, depthWrite: false, blending: AdditiveBlending }));
    this.glow.position.z = 0.08;
    this.glow.scale.setScalar(0.7);
    this.group.add(p, this.light, this.glow);
  }

  setLight(color: number): void {
    this.light.material.color.setHex(color);
    this.glow.material.color.setHex(color);
    // the blink's off half: the bulb goes dark and the glow out
    this.glow.material.opacity = color === MINE_LIGHTS.dark ? 0 : 0.85;
  }

  dispose(): void {
    this.light.material.dispose();
    this.glow.material.dispose();
    this.group.removeFromParent();
  }
}

// ---------- walls: the part of a cloud its centre reaches ----------

/** The reach mask spans this many of the cloud's full radii from its centre (puffs' soft edges overhang it). */
const MASK_SPAN = 1.5;
const MASK_N = 64;
/** soft edge of the mask (m) */
const MASK_EDGE = 0.12;

/** What a cloud's puffs share: its reach mask, and the world rect it covers (x0, y0, 1/w, 1/h). */
interface ReachUniforms {
  cloudMask: { value: DataTexture };
  cloudRect: { value: Vector4 };
}

/** A 1×1 "reaches everywhere" mask, for clouds no wall cuts (and the shader warm-up). */
function openMask(): DataTexture {
  const t = new DataTexture(new Uint8Array([255]), 1, 1, RedFormat);
  t.needsUpdate = true;
  return t;
}

/**
 * The reach of the cloud (cloudReach) as a coverage mask over its bounding square, or null when
 * no wall is in reach. 1 where its centre reaches, 0 past a wall, with a soft edge.
 */
export function reachMask(world: CollisionWorld, x: number, y: number, radius: number): { texture: DataTexture; rect: Vector4 } | null {
  const half = radius * MASK_SPAN;
  const rays = new Float32Array(REACH_RAYS);
  if (!cloudReach(world, x, y, half, rays)) return null;
  const data = new Uint8Array(MASK_N * MASK_N);
  const cell = (2 * half) / MASK_N;
  for (let j = 0; j < MASK_N; j++) {
    for (let i = 0; i < MASK_N; i++) {
      const dx = -half + (i + 0.5) * cell;
      const dy = -half + (j + 0.5) * cell;
      const k = (reachToward(rays, dx, dy) - Math.sqrt(dx * dx + dy * dy)) / MASK_EDGE + 0.5;
      data[j * MASK_N + i] = Math.round(255 * Math.max(0, Math.min(1, k)));
    }
  }
  const texture = new DataTexture(data, MASK_N, MASK_N, RedFormat);
  texture.magFilter = LinearFilter;
  texture.minFilter = LinearFilter;
  texture.needsUpdate = true;
  return { texture, rect: new Vector4(x - half, y - half, 1 / (2 * half), 1 / (2 * half)) };
}

/**
 * A puff material masked by its cloud's reach: alpha × the mask at the fragment's world xy. The
 * camera looks straight down −Z (planeCamera), so a sprite's view-space offsets are world offsets.
 */
function masked(material: SpriteMaterial, reach: ReachUniforms): SpriteMaterial {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.cloudMask = reach.cloudMask;
    shader.uniforms.cloudRect = reach.cloudRect;
    shader.vertexShader = shader.vertexShader
      .replace('void main() {', 'varying vec2 vCloudXY;\nvoid main() {')
      .replace('mvPosition.xy += rotatedPosition;', 'mvPosition.xy += rotatedPosition;\n\tvCloudXY = modelMatrix[ 3 ].xy + rotatedPosition;');
    shader.fragmentShader = shader.fragmentShader
      .replace('void main() {', 'uniform sampler2D cloudMask;\nuniform vec4 cloudRect;\nvarying vec2 vCloudXY;\nvoid main() {')
      .replace('#include <alphamap_fragment>', '#include <alphamap_fragment>\n\tdiffuseColor.a *= texture2D( cloudMask, ( vCloudXY - cloudRect.xy ) * cloudRect.zw ).r;');
  };
  material.customProgramCacheKey = () => 'cloud-reach';
  return material;
}

// ---------- a flashbang's pop, an EMP's ring (from explosion events) ----------

const fxSpec: ParticleSpec = particleSpec();
const base = particleSpec();

function emit(pool: VfxContext['glow'], over: Partial<ParticleSpec>): void {
  pool.emit(Object.assign(fxSpec, base, over));
}

/**
 * A flashbang going off: a quick star and glow about the canister and a ring out to its full-white
 * radius. Small on purpose: the blinding is the fx overlay's (rate-limited); "Reduce flashes" greys it.
 */
export function flashPop(fx: VfxContext, x: number, y: number, radius: number): void {
  const grey = reduceFlashes();
  const k = grey ? 0.4 : 1;
  const tint = grey ? { tr: 0.5, tg: 0.52, tb: 0.55 } : { tr: 1, tg: 1, tb: 1 };
  emit(fx.glow, { x, y, z: 0.5, life: 0.12, size0: 1.2, size1: 2.2, rot: (x * 7.3 + y) % 6.28, ramp: Ramp.Flash, cell: Cell.Star, alpha: k, ...tint });
  emit(fx.glow, { x, y, z: 0.45, life: 0.22, size0: 2, size1: 3.2, ramp: Ramp.Flash, cell: Cell.Glow, alpha: 0.45 * k, ...tint });
  emit(fx.glow, { x, y, z: 0.7, life: 0.32, size0: 0.6, size1: 2.24 * radius, ease: 0.4, ramp: Ramp.Ring, cell: Cell.Ring, alpha: 0.7 * k, ...tint });
}

/**
 * An EMP: a blue ring out to its radius (where jetpacks die) and a slower echo, alpha-blended so
 * they read against a bright sky too, with a bright glow and a few arcs on top.
 */
export function empRing(fx: VfxContext, x: number, y: number, radius: number): void {
  const blue = { tr: 0.35, tg: 0.65, tb: 1 };
  const deep = { tr: 0.12, tg: 0.38, tb: 1 };
  emit(fx.smoke, { x, y, z: 0.7, life: 0.5, size0: 0.6, size1: 2.24 * radius, ease: 0.45, ramp: Ramp.Ring, cell: Cell.Ring, alpha: 0.95, ...deep });
  emit(fx.smoke, { x, y, z: 0.65, life: 0.85, size0: 0.4, size1: 2.24 * radius, ease: 0.6, ramp: Ramp.Ring, cell: Cell.Ring, alpha: 0.5, fadeIn: 0.25, ...deep });
  // a soft blue wash over the area it reached, so "jetpacks off here" reads at a glance
  emit(fx.smoke, { x, y, z: 0.6, life: 0.6, size0: 1.2 * radius, size1: 2.2 * radius, ease: 0.35, ramp: Ramp.Flash, cell: Cell.Glow, alpha: 0.35, ...deep });
  emit(fx.glow, { x, y, z: 0.72, life: 0.35, size0: 0.6, size1: 2.24 * radius, ease: 0.45, ramp: Ramp.Ring, cell: Cell.Ring, alpha: 0.6, ...blue });
  emit(fx.glow, { x, y, z: 0.5, life: 0.3, size0: 1.4, size1: 2.6, ramp: Ramp.Flash, cell: Cell.Glow, alpha: 0.6, ...blue });
  const arcs = Math.max(4, Math.round(10 * fx.detail));
  for (let i = 0; i < arcs; i++) {
    const a = (i / arcs) * Math.PI * 2 + 0.4;
    const v = 7 + 5 * ((i * 0.618) % 1);
    emit(fx.glow, { x, y, z: 0.6, vx: Math.cos(a) * v, vy: Math.sin(a) * v, drag: 3, life: 0.3, size0: 0.22, size1: 0.12, aspect: 0.35, stretch: 0.05, ramp: Ramp.Spark, cell: Cell.Streak, ...blue });
  }
}

const GOLDEN_ANGLE = 2.399963229728653;

/** Deterministic 0…1 per (cloud slot, puff, salt): the same cloud always looks the same. */
function hash01(a: number, b: number, salt: number): number {
  let h = Math.imul(a + 1, 374761393) ^ Math.imul(b + 1, 668265263) ^ Math.imul(salt, 2246822519);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/**
 * A soft round puff: alpha falls off with the square of the distance, with a little lumpiness.
 * `flat` > 0 keeps it fully opaque out to that share of the radius first (the smoke core).
 */
export function puffTexture(n = 64, flat = 0): DataTexture {
  const data = new Uint8Array(n * n * 4);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const dx = (x + 0.5) / (n / 2) - 1;
      const dy = (y + 0.5) / (n / 2) - 1;
      const d = Math.sqrt(dx * dx + dy * dy);
      const u = d <= flat ? 0 : (d - flat) / (1 - flat);
      const d2 = u * u;
      const lump = 0.82 + 0.18 * hash01(x >> 3, y >> 3, 7);
      const a = d2 >= 1 ? 0 : (1 - d2) * (1 - d2) * lump;
      const o = (y * n + x) * 4;
      data[o] = data[o + 1] = data[o + 2] = 255;
      data[o + 3] = Math.round(255 * a);
    }
  }
  const t = new DataTexture(data, n, n);
  t.magFilter = LinearFilter;
  t.minFilter = LinearFilter;
  t.needsUpdate = true;
  return t;
}

interface Puff {
  sprite: Sprite;
  material: SpriteMaterial;
  /** offset from the centre as a share of the radius, and depth (m) */
  ox: number;
  oy: number;
  z: number;
  scale: number;
  spin: number;
  phase: number;
}

class CloudPuffs {
  readonly group = new Group();
  readonly puffs: Puff[] = [];
  /** smoke only: the dense core that hides bodies (the sim's opaque radius) */
  readonly core: Sprite | null = null;
  type: number;

  /** the mask of its reach past the walls (null: no wall cuts it, the shared open mask) */
  private readonly mask: DataTexture | null;

  constructor(
    readonly id: number,
    type: number,
    texture: DataTexture,
    coreTexture: DataTexture,
    reach: { texture: DataTexture; rect: Vector4 } | null,
    open: DataTexture,
  ) {
    this.type = type;
    const style = STYLES[type]!;
    this.mask = reach?.texture ?? null;
    const uniforms: ReachUniforms = { cloudMask: { value: reach?.texture ?? open }, cloudRect: { value: reach?.rect ?? new Vector4(0, 0, 0, 0) } };
    if (type === SMOKE.index) {
      this.core = new Sprite(masked(new SpriteMaterial({ map: coreTexture, color: new Color(style.color), transparent: true, depthWrite: false, opacity: 0 }), uniforms));
      this.group.add(this.core);
    }
    for (let i = 0; i < style.puffs; i++) {
      // a sunflower disc: even cover, denser towards the middle
      const r = SPREAD * Math.sqrt((i + 0.5) / style.puffs);
      const a = i * GOLDEN_ANGLE + hash01(id, i, 1) * 0.6;
      const material = masked(new SpriteMaterial({ map: texture, color: new Color(style.color), transparent: true, depthWrite: false, opacity: 0 }), uniforms);
      material.rotation = hash01(id, i, 2) * Math.PI * 2;
      const sprite = new Sprite(material);
      // spread through the depth: the ones in front of the core give it a lumpy surface
      const z = Z_BACK + (Z_FRONT - Z_BACK) * hash01(id, i, 3);
      this.puffs.push({ sprite, material, ox: Math.cos(a) * r, oy: Math.sin(a) * r * 0.85, z, scale: style.size * (0.8 + 0.4 * hash01(id, i, 4)), spin: (hash01(id, i, 5) - 0.5) * 0.4, phase: hash01(id, i, 6) * 6.28 });
      this.group.add(sprite);
    }
  }

  update(c: CloudView, time: number, dt: number): void {
    const style = STYLES[this.type]!;
    if (this.core) {
      this.core.position.set(c.x, c.y, CORE_Z);
      this.core.scale.setScalar(2.3 * Math.max(c.opaque, 0.5 * c.radius));
      this.core.material.opacity = CORE_ALPHA * c.density;
    }
    for (const p of this.puffs) {
      // a slow churn: each puff wanders a little around its spot and turns
      const wob = 0.06 * c.radius;
      p.sprite.position.set(c.x + p.ox * c.radius + Math.sin(time * 0.5 + p.phase) * wob, c.y + p.oy * c.radius + Math.cos(time * 0.4 + p.phase) * wob, p.z);
      p.sprite.scale.setScalar(c.radius * p.scale);
      p.material.rotation += p.spin * dt;
      p.material.opacity = style.alpha * c.density;
    }
  }

  dispose(): void {
    for (const p of this.puffs) p.material.dispose();
    this.core?.material.dispose();
    this.mask?.dispose();
    this.group.removeFromParent();
  }
}

/**
 * Smoke and gas clouds plus the non-frag grenades, and the flashbang's and EMP's bursts; one per
 * Renderer3D, plugged into its effects (`vfx.register`).
 */
export class CloudLayer implements VfxModule {
  readonly group = new Group();
  private readonly texture = puffTexture();
  private readonly coreTexture = puffTexture(64, 0.62);
  private readonly open = openMask();
  /** the map's walls (from the effects' context; none in tests without one: no masks) */
  private world: CollisionWorld | null = null;
  private readonly clouds = new Map<number, CloudPuffs>();
  private readonly puckGeo = new CylinderGeometry(MINE.radius * 1.3, MINE.radius * 1.3, 0.07, 16);
  private readonly bulbGeo = new SphereGeometry(MINE.radius * 0.6, 10, 6);
  private readonly mineBody = new MeshLambertMaterial({ color: 0x2b3036 });
  private readonly mines: MineMesh[] = [];
  private time = 0;
  /** an invisible puff the renderer's shader warm-up compiles, so the first smoke doesn't hitch */
  private warm: Sprite | null;

  constructor(scene: Scene) {
    this.group.name = 'clouds';
    const warm = { cloudMask: { value: this.open }, cloudRect: { value: new Vector4() } };
    this.warm = new Sprite(masked(new SpriteMaterial({ map: this.texture, transparent: true, depthWrite: false, opacity: 0 }), warm));
    this.group.add(this.warm);
    scene.add(this.group);
  }

  /** A flashbang's pop and an EMP's ring (explosion events carry the grenade type). */
  onEvents(events: readonly SimEvent[], fx: VfxContext): void {
    for (const e of events) {
      if (e.type !== 'explosion') continue;
      if (e.grenade === FLASHBANG.index) flashPop(fx, e.x, e.y, e.radius);
      else if (e.grenade === EMP.index) empRing(fx, e.x, e.y, e.radius);
    }
  }

  update(frame: Frame, dt: number, fx?: VfxContext): void {
    if (fx && fx.world !== this.world) this.world = fx.world;
    if (this.warm) {
      this.warm.material.dispose();
      this.warm.removeFromParent();
      this.warm = null;
    }
    this.time += dt;
    this.syncClouds(frame.clouds ?? [], dt);
    this.syncMines(frame.grenades, (fx?.reducedMotion ?? false) || reduceFlashes());
  }

  private syncClouds(views: readonly CloudView[], dt: number): void {
    const seen = new Set<number>();
    for (const c of views) {
      if (!STYLES[c.type]) continue;
      seen.add(c.id);
      let puffs = this.clouds.get(c.id);
      // cloud slots are reused: a different type in the slot is a new cloud
      if (puffs && puffs.type !== c.type) {
        puffs.dispose();
        puffs = undefined;
      }
      if (!puffs) {
        const reach = this.world ? reachMask(this.world, c.x, c.y, cloudDef(c.type)?.radius ?? c.radius) : null;
        puffs = new CloudPuffs(c.id, c.type, this.texture, this.coreTexture, reach, this.open);
        this.clouds.set(c.id, puffs);
        this.group.add(puffs.group);
      }
      puffs.update(c, this.time, dt);
    }
    for (const [id, puffs] of this.clouds) {
      if (seen.has(id)) continue;
      puffs.dispose();
      this.clouds.delete(id);
    }
  }

  /** Thrown mines (`calm`: Reduce motion or Reduce flashes: the lights blink no faster than MINE_CALM_HZ). */
  private syncMines(views: readonly GrenadeView[], calm: boolean): void {
    let mines = 0;
    for (const g of views) {
      if (g.type !== MINE.index) continue; // every other type is grenades.ts's (one model each) or vfx/projectiles.ts's
      let mine = this.mines[mines];
      if (!mine) {
        mine = new MineMesh(this.puckGeo, this.mineBody, this.bulbGeo, this.texture);
        this.mines.push(mine);
        this.group.add(mine.group);
      }
      mine.group.visible = true;
      mine.group.position.set(g.x, g.y, 0);
      mine.setLight(mineLight(g.state ?? 0, this.time, calm ? MINE_CALM_HZ : Infinity));
      mines++;
    }
    for (let i = mines; i < this.mines.length; i++) this.mines[i]!.group.visible = false;
  }

  dispose(): void {
    for (const puffs of this.clouds.values()) puffs.dispose();
    this.clouds.clear();
    this.texture.dispose();
    this.coreTexture.dispose();
    this.open.dispose();
    for (const m of this.mines) m.dispose();
    this.puckGeo.dispose();
    this.bulbGeo.dispose();
    this.mineBody.dispose();
    this.group.removeFromParent();
  }
}
