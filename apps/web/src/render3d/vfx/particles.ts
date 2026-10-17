/**
 * One draw call per particle layer: an instanced quad whose per-instance attributes (centre, two
 * half-axes, colour, atlas cell) are rewritten from the pools each frame (docs/11 §2 batching,
 * §3 budgets). The half-axes let one shader draw camera-plane cards, rotated sprites, streaks
 * stretched along their velocity and decals lying on a surface; the camera looks straight down
 * −Z (planeCamera.ts), so a quad in the XY plane already faces it.
 *
 * Stock ShaderMaterial with a few lines of GLSL: a WebGPU/TSL port later is a small rewrite.
 */
import {
  AdditiveBlending,
  BufferAttribute,
  DoubleSide,
  DynamicDrawUsage,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  NormalBlending,
  ShaderMaterial,
  Vector2,
  type Texture,
} from 'three';
import { F, STRIDE, type ParticlePool } from './pool';
import { RAMPS, rampIndex } from './ramps';

export interface LayerOptions {
  texture: Texture;
  /** cells per row, rows */
  grid: readonly [number, number];
  blend: 'additive' | 'alpha';
  /** additive light (fire, sparks, fuse lights) ignores depth: nothing hides it (docs/01 §5) */
  depthTest: boolean;
  renderOrder: number;
  /** decals: pulled toward the camera in depth so they win over the surface they lie on */
  polygonOffset?: boolean;
  /** animated cells: frame = frames[age × fps], clamped to the last (Forge flipbooks) */
  flipbook?: { fps: number; frames: readonly number[] };
}

const VERTEX = /* glsl */ `
attribute vec3 iPos;
attribute vec3 iAxisA;
attribute vec3 iAxisB;
attribute vec4 iColor;
attribute float iCell;
uniform vec2 uGrid;
varying vec2 vUv;
varying vec4 vColor;
void main() {
  vec3 p = iPos + position.x * iAxisA + position.y * iAxisB;
  float col = floor(mod(iCell + 0.5, uGrid.x));
  float row = floor((iCell + 0.5) / uGrid.x);
  vUv = vec2((col + uv.x) / uGrid.x, (uGrid.y - 1.0 - row + uv.y) / uGrid.y);
  vColor = iColor;
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
}`;

const FRAGMENT = /* glsl */ `
uniform sampler2D map;
varying vec2 vUv;
varying vec4 vColor;
void main() {
  vec4 t = texture2D(map, vUv);
  gl_FragColor = vec4(vColor.rgb * t.rgb, vColor.a * t.a);
  #include <colorspace_fragment>
}`;

export class ParticleLayer {
  readonly mesh: Mesh<InstancedBufferGeometry, ShaderMaterial>;
  private readonly pos: InstancedBufferAttribute;
  private readonly axisA: InstancedBufferAttribute;
  private readonly axisB: InstancedBufferAttribute;
  private readonly color: InstancedBufferAttribute;
  private readonly cell: InstancedBufferAttribute;
  private readonly attrs: InstancedBufferAttribute[];
  private n = 0;

  constructor(
    readonly capacity: number,
    private readonly opts: LayerOptions,
  ) {
    const g = new InstancedBufferGeometry();
    g.setAttribute('position', new BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), 3));
    g.setAttribute('uv', new BufferAttribute(new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), 2));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    const attr = (name: string, size: number) => {
      const a = new InstancedBufferAttribute(new Float32Array(capacity * size), size).setUsage(DynamicDrawUsage);
      g.setAttribute(name, a);
      return a;
    };
    this.pos = attr('iPos', 3);
    this.axisA = attr('iAxisA', 3);
    this.axisB = attr('iAxisB', 3);
    this.color = attr('iColor', 4);
    this.cell = attr('iCell', 1);
    this.attrs = [this.pos, this.axisA, this.axisB, this.color, this.cell];
    g.instanceCount = 0;
    const material = new ShaderMaterial({
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      uniforms: { map: { value: opts.texture }, uGrid: { value: new Vector2(opts.grid[0], opts.grid[1]) } },
      transparent: true,
      // quads lying on a surface face up, cards face the camera: no culling either way
      side: DoubleSide,
      depthWrite: false,
      depthTest: opts.depthTest,
      blending: opts.blend === 'additive' ? AdditiveBlending : NormalBlending,
      polygonOffset: !!opts.polygonOffset,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -4,
    });
    this.mesh = new Mesh(g, material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = opts.renderOrder;
    this.mesh.visible = false;
  }

  /** quads written this frame */
  get count(): number {
    return this.n;
  }

  begin(): void {
    this.n = 0;
  }

  /** One quad spanning centre ± a ± b (half-axes), in linear colour. */
  quad(x: number, y: number, z: number, ax: number, ay: number, az: number, bx: number, by: number, bz: number, r: number, g: number, b: number, a: number, cell: number): void {
    if (this.n >= this.capacity) return;
    const i = this.n++;
    const i3 = i * 3;
    const i4 = i * 4;
    const p = this.pos.array as Float32Array;
    const A = this.axisA.array as Float32Array;
    const B = this.axisB.array as Float32Array;
    const c = this.color.array as Float32Array;
    p[i3] = x;
    p[i3 + 1] = y;
    p[i3 + 2] = z;
    A[i3] = ax;
    A[i3 + 1] = ay;
    A[i3 + 2] = az;
    B[i3] = bx;
    B[i3 + 1] = by;
    B[i3 + 2] = bz;
    c[i4] = r;
    c[i4 + 1] = g;
    c[i4 + 2] = b;
    c[i4 + 3] = a;
    (this.cell.array as Float32Array)[i] = cell;
  }

  /** A square card in the camera plane, rotated by `rot`. */
  sprite(x: number, y: number, z: number, size: number, rot: number, r: number, g: number, b: number, a: number, cell: number): void {
    const h = size / 2;
    const c = Math.cos(rot) * h;
    const s = Math.sin(rot) * h;
    this.quad(x, y, z, c, s, 0, -s, c, 0, r, g, b, a, cell);
  }

  /**
   * Every live particle of `pool`: its size and colour at its age, oriented by its kind. One draw
   * call blends in instance order, so `front` particles (solid debris) go in a second pass, over
   * the smoke they fly through.
   */
  addPool(pool: ParticlePool): void {
    this.addPass(pool, 0);
    this.addPass(pool, 1);
  }

  private addPass(pool: ParticlePool, front: number): void {
    const d = pool.data;
    const fb = this.opts.flipbook;
    for (let i = 0; i < pool.count; i++) {
      const o = i * STRIDE;
      if (d[o + F.front] !== front) continue;
      const t = d[o + F.age]! / d[o + F.life]!;
      const ri = rampIndex(d[o + F.ramp]!, t);
      const fadeIn = d[o + F.fadeIn]!;
      const alpha = RAMPS[ri + 3]! * d[o + F.alpha]! * (fadeIn > 0 && t < fadeIn ? t / fadeIn : 1);
      if (alpha <= 0.003) continue;
      const ease = d[o + F.ease]!;
      const size = d[o + F.size0]! + (d[o + F.size1]! - d[o + F.size0]!) * (ease === 1 ? t : t ** ease);
      const w = size / 2;
      const h = w * d[o + F.aspect]!;
      const r = RAMPS[ri]! * d[o + F.tr]!;
      const g = RAMPS[ri + 1]! * d[o + F.tg]!;
      const b = RAMPS[ri + 2]! * d[o + F.tb]!;
      const cell = fb ? fb.frames[Math.min(fb.frames.length - 1, Math.floor(d[o + F.age]! * fb.fps))]! : d[o + F.cell]!;
      const x = d[o + F.x]!;
      const y = d[o + F.y]!;
      const z = d[o + F.z]!;
      if (d[o + F.orient]! === 1) {
        // lying on a surface: along its tangent, and through the gameplay band's depth
        const nx = d[o + F.nx]!;
        const ny = d[o + F.ny]!;
        this.quad(x, y, z, ny * w, -nx * w, 0, 0, 0, h, r, g, b, alpha, cell);
        continue;
      }
      const stretch = d[o + F.stretch]!;
      if (stretch > 0) {
        const vx = d[o + F.vx]!;
        const vy = d[o + F.vy]!;
        const speed = Math.hypot(vx, vy);
        if (speed > 1e-3) {
          const ux = vx / speed;
          const uy = vy / speed;
          const half = w + 0.5 * speed * stretch;
          this.quad(x, y, z, ux * half, uy * half, 0, -uy * h, ux * h, 0, r, g, b, alpha, cell);
          continue;
        }
      }
      const rot = d[o + F.rot]!;
      const c = Math.cos(rot);
      const s = Math.sin(rot);
      this.quad(x, y, z, c * w, s * w, 0, -s * h, c * h, 0, r, g, b, alpha, cell);
    }
  }

  /** Uploads this frame's quads (only the written range) and hides the layer when empty. */
  end(): void {
    this.mesh.geometry.instanceCount = this.n;
    for (const a of this.attrs) {
      a.clearUpdateRanges();
      if (this.n > 0) {
        a.addUpdateRange(0, this.n * a.itemSize);
        a.needsUpdate = true;
      }
    }
    this.mesh.visible = this.n > 0;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
  }
}
