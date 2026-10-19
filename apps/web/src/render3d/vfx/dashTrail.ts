/**
 * The dash's green trail (the owner's playtest, 18 Oct: "the dash should have like a blur or green
 * trail with sparkles"): a soft ribbon, the body's width, streaming behind every dashing soldier,
 * local and remote, bright at the body and thinning and fading toward its tail. The owner's war
 * tone (19 Oct: "serious battle", not "joyous") makes it a tactical energy streak: a few hot
 * embers shed along it, short streaks that cool and fall away, instead of twinkling glitter. It
 * rides on top of the jet kick, the speed lines and the afterimages (dash.ts, dashGhosts.ts).
 *
 * Green (a mint, hue ~145°) is nobody's team colour: well apart from team blue and team orange.
 * Reduce motion: a shorter ribbon and half the sparkles. Reduce flashes: sparkles hold steady
 * instead of twinkling. Every ribbon on screen is one mesh, one draw call (rebuilt in place each
 * frame, nothing allocated); the sparkles are the shared glow pool's particles, so they count
 * against its budget and Low's density.
 */
import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  DataTexture,
  DoubleSide,
  DynamicDrawUsage,
  LinearFilter,
  Mesh,
  MeshBasicMaterial,
  RGBAFormat,
  type Scene,
} from 'three';
import type { Frame } from '../../view';
import { Cell } from './atlas';
import type { VfxContext } from './index';
import { particleSpec, type ParticleSpec } from './pool';
import { Ramp } from './ramps';

/** the trail's green, linear RGB: a mint well apart from team blue and team orange */
export const TRAIL_GREEN = [0.2, 0.9, 0.38] as const;
/** the embers: hot white-green cooling through the spark ramp */
const EMBER_TINT = [0.8, 1, 0.82] as const;
/** seconds of path the ribbon shows behind a dashing body (Reduce motion: shorter) */
export const TRAIL_SECONDS = 0.24;
const CALM_SECONDS = 0.12;
/** the ribbon's width at the body (m): a little more than the torso's */
const WIDTH = 0.8;
/** the ribbon's middle, above the feet */
const BODY_Y = 0.85;
/** behind the body (the soldier hides the ribbon where they overlap) */
const Z = -0.08;
/** ribbons drawn at once, and the samples each keeps */
export const MAX_TRAILS = 8;
const SAMPLES = 20;
/** embers shed per metre of trail (× the preset's detail; half under Reduce motion) */
export const SPARKLES_PER_M = 5.5;

interface Trail {
  id: number;
  /** x, y, time per sample, oldest first */
  readonly xs: Float32Array;
  readonly ys: Float32Array;
  readonly ts: Float64Array;
  count: number;
  /** the frame it was last seen dashing (it fades out after) */
  dashing: boolean;
  /** metres owed toward the next sparkle */
  owed: number;
  lastX: number;
  lastY: number;
}

const spec: ParticleSpec = particleSpec();
const base = particleSpec();
const reset = (): ParticleSpec => Object.assign(spec, base);

/** A soft profile across the ribbon (alpha 0 at both edges, 1 down the middle). */
function profileTexture(): DataTexture {
  const n = 32;
  const data = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    const v = Math.sin(((i + 0.5) / n) * Math.PI) ** 1.6;
    data.set([255, 255, 255, Math.round(255 * v)], i * 4);
  }
  const t = new DataTexture(data, 1, n, RGBAFormat);
  t.magFilter = t.minFilter = LinearFilter;
  t.needsUpdate = true;
  return t;
}

export class DashTrail {
  readonly mesh: Mesh;
  private readonly geometry = new BufferGeometry();
  private readonly position: BufferAttribute;
  private readonly color: BufferAttribute;
  private readonly uv: BufferAttribute;
  private readonly index: BufferAttribute;
  private readonly trails: Trail[] = Array.from({ length: MAX_TRAILS }, () => ({
    id: -1,
    xs: new Float32Array(SAMPLES),
    ys: new Float32Array(SAMPLES),
    ts: new Float64Array(SAMPLES),
    count: 0,
    dashing: false,
    owed: 0,
    lastX: 0,
    lastY: 0,
  }));
  private time = 0;
  private seed = 11;
  /** Reduce flashes: sparkles don't twinkle */
  steady = false;

  constructor(scene: Scene) {
    const verts = MAX_TRAILS * SAMPLES * 2;
    this.position = new BufferAttribute(new Float32Array(verts * 3), 3).setUsage(DynamicDrawUsage);
    this.color = new BufferAttribute(new Float32Array(verts * 4), 4).setUsage(DynamicDrawUsage);
    this.uv = new BufferAttribute(new Float32Array(verts * 2), 2);
    for (let v = 0; v < verts; v++) this.uv.setXY(v, 0.5, v % 2);
    this.index = new BufferAttribute(new Uint16Array(MAX_TRAILS * (SAMPLES - 1) * 6), 1).setUsage(DynamicDrawUsage);
    this.geometry.setAttribute('position', this.position);
    this.geometry.setAttribute('color', this.color);
    this.geometry.setAttribute('uv', this.uv);
    this.geometry.setIndex(this.index);
    this.geometry.setDrawRange(0, 0);
    // both sides: the strip's winding flips with the dash's direction
    const material = new MeshBasicMaterial({ map: profileTexture(), vertexColors: true, transparent: true, blending: AdditiveBlending, depthWrite: false, side: DoubleSide });
    this.mesh = new Mesh(this.geometry, material);
    this.mesh.name = 'vfx-dash-trail';
    this.mesh.frustumCulled = false;
    // first of the see-through things: the soldiers (opaque) hide it where they overlap, and the
    // afterimages blend over it rather than cutting it out of the depth buffer
    this.mesh.renderOrder = -1;
    this.mesh.visible = false;
    scene.add(this.mesh);
  }

  private rand(): number {
    this.seed = (Math.imul(this.seed, 1664525) + 1013904223) >>> 0;
    return this.seed / 4294967296;
  }

  private trailOf(id: number, create: boolean): Trail | null {
    let free: Trail | null = null;
    for (const t of this.trails) {
      if (t.id === id) return t;
      if (!free && t.count === 0 && !t.dashing) free = t;
    }
    if (!create || !free) return null;
    free.id = id;
    free.count = 0;
    free.owed = 0;
    return free;
  }

  /** Samples every dashing body, ages the ribbons, sheds sparkles and rebuilds the mesh. */
  update(frame: Frame, dt: number, fx: VfxContext): void {
    this.time += dt;
    const keep = fx.reducedMotion ? CALM_SECONDS : TRAIL_SECONDS;
    for (const t of this.trails) t.dashing = false;
    for (const p of frame.players) {
      if (!p.alive || !p.dashing) continue;
      const t = this.trailOf(p.id, true);
      if (!t) continue;
      t.dashing = true;
      const x = p.x;
      const y = p.y + BODY_Y;
      if (t.count === 0) {
        t.lastX = x;
        t.lastY = y;
      }
      this.push(t, x, y);
      this.shed(t, x, y, fx);
    }
    // drop samples past the trail's length; a trail no longer dashing drains away
    for (const t of this.trails) {
      let drop = 0;
      while (drop < t.count && this.time - t.ts[drop]! > keep) drop++;
      if (drop > 0) this.shift(t, drop);
      if (t.count === 0 && !t.dashing) t.id = -1;
    }
    this.build(keep);
  }

  private push(t: Trail, x: number, y: number): void {
    if (t.count === SAMPLES) this.shift(t, 1);
    t.xs[t.count] = x;
    t.ys[t.count] = y;
    t.ts[t.count] = this.time;
    t.count++;
  }

  private shift(t: Trail, n: number): void {
    t.xs.copyWithin(0, n, t.count);
    t.ys.copyWithin(0, n, t.count);
    t.ts.copyWithin(0, n, t.count);
    t.count -= n;
  }

  /** Sparkles along the stretch just covered, about SPARKLES_PER_M a metre. */
  private shed(t: Trail, x: number, y: number, fx: VfxContext): void {
    const dx = x - t.lastX;
    const dy = y - t.lastY;
    const len = Math.sqrt(dx * dx + dy * dy);
    t.lastX = x;
    t.lastY = y;
    const rate = SPARKLES_PER_M * fx.detail * (fx.reducedMotion ? 0.5 : 1);
    t.owed += len * rate;
    for (; t.owed >= 1; t.owed--) {
      const k = this.rand();
      const p = reset();
      p.x = x - dx * k + (this.rand() - 0.5) * WIDTH * 0.8;
      p.y = y - dy * k + (this.rand() - 0.5) * WIDTH * 0.9;
      p.z = Z + (this.rand() - 0.5) * 0.4;
      // an ember: a short hot streak thrown back off the streak, cooling as it falls away
      p.vx = (this.rand() - 0.5) * 1.2 - dx * 4;
      p.vy = (this.rand() - 0.2) * 1.4;
      p.grav = 3;
      p.drag = 3;
      p.life = 0.22 + 0.22 * this.rand();
      p.size0 = 0.07 + 0.04 * this.rand();
      p.size1 = 0.02;
      p.aspect = 0.35;
      p.stretch = this.steady ? 0.01 : 0.03;
      p.ramp = Ramp.Spark;
      p.cell = Cell.Streak;
      [p.tr, p.tg, p.tb] = EMBER_TINT;
      fx.glow.emit(p);
    }
  }

  /** The ribbons into the one mesh: two vertices a sample, across the path, fading toward the tail. */
  private build(keep: number): void {
    const pos = this.position.array as Float32Array;
    const col = this.color.array as Float32Array;
    const idx = this.index.array as Uint16Array;
    let v = 0;
    let n = 0;
    const [gr, gg, gb] = TRAIL_GREEN;
    for (const t of this.trails) {
      if (t.count < 2) continue;
      const first = v;
      for (let i = 0; i < t.count; i++) {
        // the path's direction here, and across it
        const a = Math.max(0, i - 1);
        const b = Math.min(t.count - 1, i + 1);
        let tx = t.xs[b]! - t.xs[a]!;
        let ty = t.ys[b]! - t.ys[a]!;
        const l = Math.sqrt(tx * tx + ty * ty) || 1;
        tx /= l;
        ty /= l;
        // 0 at the tail, 1 at the head (the body); a trail no longer dashing dims as a whole
        const age = (this.time - t.ts[i]!) / keep;
        const head = 1 - Math.min(1, age);
        const w = WIDTH * (0.3 + 0.7 * head) * 0.5;
        const alpha = Math.sqrt(head) * (t.dashing ? 1 : 0.7);
        for (let side = -1; side <= 1; side += 2) {
          pos[v * 3] = t.xs[i]! - ty * w * side;
          pos[v * 3 + 1] = t.ys[i]! + tx * w * side;
          pos[v * 3 + 2] = Z;
          col[v * 4] = gr * alpha;
          col[v * 4 + 1] = gg * alpha;
          col[v * 4 + 2] = gb * alpha;
          col[v * 4 + 3] = alpha;
          v++;
        }
      }
      for (let i = 0; i < t.count - 1; i++) {
        const q = first + i * 2;
        idx[n++] = q;
        idx[n++] = q + 1;
        idx[n++] = q + 2;
        idx[n++] = q + 1;
        idx[n++] = q + 3;
        idx[n++] = q + 2;
      }
    }
    this.geometry.setDrawRange(0, n);
    this.mesh.visible = n > 0;
    if (n > 0) {
      this.position.needsUpdate = true;
      this.color.needsUpdate = true;
      this.index.needsUpdate = true;
    }
  }

  /** ribbons showing (tests) */
  get count(): number {
    let k = 0;
    for (const t of this.trails) if (t.count >= 2) k++;
    return k;
  }

  /** One quad on show, so the shader warm-up compiles its program; `clear()` after. */
  showForWarmUp(x: number, y: number): void {
    const t = this.trails[0]!;
    t.id = -2;
    t.count = 0;
    this.push(t, x - 1, y);
    this.push(t, x, y);
    this.build(1e9);
  }

  /** None carried over (a new map). */
  clear(): void {
    for (const t of this.trails) {
      t.id = -1;
      t.count = 0;
      t.dashing = false;
    }
    this.build(1);
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.geometry.dispose();
    const m = this.mesh.material as MeshBasicMaterial;
    m.map?.dispose();
    m.dispose();
  }
}
