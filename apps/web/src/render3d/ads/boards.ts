/**
 * The billboard renderer (docs/14 §4.5, docs/11 §2):
 * - mid-depth only: creatives sit on W8's bezels at z −5…−8, never on or in front of the gameplay
 *   plane;
 * - one InstancedMesh per format (4:3 Screens, 6:1 Hoardings) over one texture array per format,
 *   each instance picking its layers by attribute: every ad on the map costs ≤ 2 draw calls;
 * - unlit and non-emissive (a plain texture times the look's tint), flagged `noBloom` for the
 *   High post pass when it lands;
 * - rotation on the shared 10 s beat with a 0.5 s crossfade (rotation.ts), at most two surfaces lit
 *   on screen (visibility.ts), and an "AD" chip on paid frames only;
 * - Motion creatives (docs/14 §3.3) as extra layers `${id}#k`, their keyframes on the same clock, so
 *   the one fade uniform serves both the beat and the keyframes. Only the KTX2 path uploads them
 *   (≈ 74 KB each on the GPU); the decoded fallback shows a Motion creative's first keyframe as a
 *   still, which keeps it inside docs/14 §4.9's 5.1 MB plan.
 *
 * GPU memory: each format's array holds only the creatives the current manifest shows: with house
 * art the match's 6 Screen creatives and 2 Hoarding creatives, at about their drawn size (384 × 288,
 * 864 × 144). Where the runtime transcodes KTX2 they're ETC1S layers, compressed on the GPU
 * (≈ 0.6 MB as BC1; the copies cost ≤ 1.2× the WebPs' download); otherwise the WebPs decoded to
 * RGBA8 with mips: ≈ 4.9 MB. Both fit docs/14 §4.9's 5.1 MB plan. A new match
 * (Frame.matchSeed) picks the next house set and uploads it then, a safe moment (§4.5), so over
 * matches every pool creative gets airtime. The "AD" chip is a small texture made only once a
 * frame is paid. Paid creatives will be ETC1S layers too (docs/14 §3.1: ads/{id}.etc1s.ktx2): at
 * RGBA8, docs/14 §4.5's 32 + 8 layer pool would be ≈ 24 MB.
 */
import {
  CanvasTexture,
  Color,
  DataArrayTexture,
  InstancedBufferAttribute,
  InstancedMesh,
  LinearFilter,
  LinearMipmapLinearFilter,
  Matrix4,
  PlaneGeometry,
  RGBAFormat,
  SRGBColorSpace,
  ShaderMaterial,
  UnsignedByteType,
  type CompressedTexture,
  type Texture,
} from 'three';
import { arrayFromLayers, textureBytes, type Ktx2Source } from '../environment/ktx2';
import type { PlanePose } from '../planeCamera';
import { houseManifest, poolEntries, type AdFrame, type AdManifest, type AdSlot, type HouseEntry, type HousePool } from './manifest';
import { CROSSFADE_MS, crossfade, frameIndex, keyFade, keySegment, lastKeySegment, previousFrame } from './rotation';
import { creativeAt, type BoardHit } from './click';
import { LitLimiter } from './visibility';

export interface FormatSpec {
  format: AdSlot['format'];
  /** texture layer size, px */
  width: number;
  height: number;
  /** the "AD" chip, in the creative's uv (x0, y0, x1, y1): inside the bezel's 3% safe edge (§3.2, §4.4) */
  chip: [number, number, number, number];
}

export const FORMATS: Readonly<Record<AdSlot['format'], FormatSpec>> = {
  '4:3': { format: '4:3', width: 384, height: 288, chip: [0.865, 0.9, 0.955, 0.96] },
  '6:1': { format: '6:1', width: 864, height: 144, chip: [0.918, 0.84, 0.958, 0.96] },
};

/** In front of the bezel's placeholder face (local z 0), behind its frame lip (z +0.10). */
export const CREATIVE_Z = 0.005;
/** docs/14 §4.9: the fixed per-map pool budget, bytes */
export const AD_POOL_BUDGET = 5.1 * 1024 * 1024;
/** the "AD" chip texture (made only once a frame is paid) */
const CHIP_W = 128;
const CHIP_H = 96;

const VERTEX = /* glsl */ `
attribute vec2 aLayers;
attribute vec2 aPaid;
attribute float aLit;
varying vec2 vUv;
varying vec2 vLayers;
varying vec2 vPaid;
varying float vLit;
void main() {
  vUv = uv;
  vLayers = aLayers;
  vPaid = aPaid;
  vLit = aLit;
  gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
}`;

const FRAGMENT = /* glsl */ `
precision highp sampler2DArray;
uniform sampler2DArray uMap;
uniform sampler2D uChip;
uniform float uFade;
uniform vec3 uTint;
uniform vec3 uOff;
uniform vec4 uChipRect;
varying vec2 vUv;
varying vec2 vLayers;
varying vec2 vPaid;
varying float vLit;
void main() {
  // layers were written top row first
  vec2 uv = vec2(vUv.x, 1.0 - vUv.y);
  vec3 c = mix(texture(uMap, vec3(uv, vLayers.x)).rgb, texture(uMap, vec3(uv, vLayers.y)).rgb, uFade);
  // the "AD" chip on paid frames, fading with its frame (docs/14 §4.4)
  float paid = mix(vPaid.x, vPaid.y, uFade);
  if (paid > 0.001) {
    vec2 q = (vUv - uChipRect.xy) / (uChipRect.zw - uChipRect.xy);
    if (all(greaterThanEqual(q, vec2(0.0))) && all(lessThanEqual(q, vec2(1.0)))) {
      vec4 chip = texture(uChip, q);
      c = mix(c, chip.rgb, chip.a * paid);
    }
  }
  gl_FragColor = vec4(mix(uOff, c * uTint, vLit), 1.0);
  #include <colorspace_fragment>
}`;

/** Per-instance rotation state for one format, computed on the CPU each frame (tests use it directly). */
export interface InstanceState {
  layers: Float32Array; // 2 per instance: previous, current
  paid: Float32Array; // 2 per instance
  fade: number;
}

/** Layer per creative id, in upload order. */
export function layerTable(ids: readonly (string | HouseEntry)[]): Map<string, number> {
  return new Map(ids.map((e, i) => [typeof e === 'string' ? e : e.id, i]));
}

/** The creatives a manifest shows on the slots of one format, each once, in first-use order: what to upload. */
export function referencedCreatives(manifest: AdManifest, slots: readonly AdSlot[], format: AdSlot['format']): string[] {
  const ids = new Set(slots.filter((s) => s.format === format).map((s) => s.slotId));
  const out = new Set<string>();
  for (const s of manifest.slots) if (ids.has(s.slot)) for (const f of s.frames) out.add(f.c);
  return [...out];
}

/** The layers a format's creatives take with their keyframes: id, then `${id}#1` … for a Motion creative. */
export function keyframeLayers(ids: readonly string[], keys: (id: string) => number): string[] {
  return ids.flatMap((id) => [id, ...Array.from({ length: Math.max(1, keys(id)) - 1 }, (_, k) => `${id}#${k + 1}`)]);
}

/** Layer of keyframe `key` of a frame's creative: keyframe 0 where that keyframe isn't uploaded, layer 0 where nothing is. */
function layerOf(layers: ReadonlyMap<string, number>, frame: AdFrame | undefined, key: number): number {
  if (!frame) return 0;
  const k = key % Math.max(1, frame.k ?? 1);
  return (k ? layers.get(`${frame.c}#${k}`) : undefined) ?? layers.get(frame.c) ?? 0;
}

/** One RGBA8 layer with its mip chain, bytes. */
export function layerBytes(spec: FormatSpec): number {
  return Math.round((spec.width * spec.height * 4 * 4) / 3);
}

/** GPU memory the boards take for `manifest` (every format's array; the chip only if a frame is paid). */
export function plannedGpuBytes(manifest: AdManifest, slots: readonly AdSlot[]): number {
  let bytes = 0;
  for (const spec of Object.values(FORMATS)) bytes += referencedCreatives(manifest, slots, spec.format).length * layerBytes(spec);
  if (manifest.slots.some((s) => s.frames.some((f) => f.paid))) bytes += Math.round((CHIP_W * CHIP_H * 4 * 4) / 3);
  return bytes;
}

/**
 * The rotation for every slot of one format at `matchTimeMs`: which layers to fade between, and
 * whether the frames are paid. During the beat's crossfade: the previous frame's last keyframe into
 * the current frame's first; then the current frame's keyframes (a still's are all the same layer).
 * A creative without a layer (not uploaded yet) falls back to layer 0, a keyframe without one to
 * its creative's first.
 */
export function rotationState(slots: readonly AdSlot[], manifest: AdManifest, layers: ReadonlyMap<string, number>, matchTimeMs: number, out?: InstanceState): InstanceState {
  const st = out ?? { layers: new Float32Array(slots.length * 2), paid: new Float32Array(slots.length * 2), fade: 1 };
  const dwell = slots[0]?.dwellMs ?? 10_000;
  const beat = ((matchTimeMs % dwell) + dwell) % dwell < CROSSFADE_MS;
  const seg = keySegment(matchTimeMs, dwell);
  const kf = keyFade(matchTimeMs, dwell);
  slots.forEach((slot, i) => {
    const frames = manifest.slots.find((s) => s.slot === slot.slotId)?.frames ?? [];
    const cur = frames[frameIndex(slot, matchTimeMs)];
    const prev = beat ? frames[previousFrame(slot, matchTimeMs)] : cur;
    st.layers[i * 2] = beat ? layerOf(layers, prev, lastKeySegment(dwell)) : layerOf(layers, cur, kf < 1 ? seg - 1 : seg);
    st.layers[i * 2 + 1] = layerOf(layers, cur, beat ? 0 : seg);
    st.paid[i * 2] = prev?.paid ? 1 : 0;
    st.paid[i * 2 + 1] = cur?.paid ? 1 : 0;
  });
  st.fade = slots.length ? (beat ? crossfade(matchTimeMs, dwell) : kf) : 1;
  return st;
}

/** Decodes one image (memoised per URL; null when it fails). Browser only. */
function loadImage(cache: Map<string, Promise<HTMLImageElement | null>>, url: string): Promise<HTMLImageElement | null> {
  let p = cache.get(url);
  if (!p) {
    p = new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => resolve(null);
      img.src = url;
    });
    cache.set(url, p);
  }
  return p;
}

/** Draws images into the layers of an RGBA8 array texture, one per layer (a grey layer for a missing one). */
function arrayTexture(images: readonly (HTMLImageElement | null)[], spec: FormatSpec): DataArrayTexture {
  const { width, height } = spec;
  const layers = Math.max(1, images.length);
  const data = new Uint8Array(width * height * 4 * layers);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  images.forEach((img, i) => {
    ctx.clearRect(0, 0, width, height);
    if (img) ctx.drawImage(img, 0, 0, width, height);
    else {
      ctx.fillStyle = '#3a3f45';
      ctx.fillRect(0, 0, width, height);
    }
    data.set(ctx.getImageData(0, 0, width, height).data, i * width * height * 4);
  });
  const tex = new DataArrayTexture(data, width, height, layers);
  tex.format = RGBAFormat;
  tex.type = UnsignedByteType;
  tex.colorSpace = SRGBColorSpace;
  tex.minFilter = LinearMipmapLinearFilter;
  tex.magFilter = LinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return tex;
}

/** The "AD" chip (§1.3 rule 7, paid frames only): a dark rounded tag with white letters, on transparent. */
function chipTexture(): CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = CHIP_W;
  canvas.height = CHIP_H;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = 'rgba(20, 22, 26, 0.92)';
  ctx.beginPath();
  ctx.roundRect(CHIP_W * 0.04, CHIP_H * 0.08, CHIP_W * 0.92, CHIP_H * 0.84, CHIP_H * 0.18);
  ctx.fill();
  ctx.fillStyle = '#f2f2f2';
  ctx.font = `700 ${Math.round(CHIP_H * 0.62)}px "Helvetica Neue", Arial, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('AD', CHIP_W / 2, CHIP_H * 0.53);
  const tex = new CanvasTexture(canvas);
  tex.colorSpace = SRGBColorSpace;
  tex.minFilter = LinearMipmapLinearFilter;
  return tex;
}

/** Boards alive now (one per loaded map with ad slots): tap-to-save asks the one being drawn. */
const live = new Set<AdBoards>();

/** The boards drawn within the last `withinMs` (the 3D view is up and showing them), or null. */
export function drawnBoards(now: number = performance.now(), withinMs = 400): AdBoards | null {
  let best: AdBoards | null = null;
  for (const b of live) if (now - b.drawnAt <= withinMs && (!best || b.drawnAt > best.drawnAt)) best = b;
  return best;
}

/** A board's creative under a point, with its picture (for the saved card). */
export interface SavedPick extends BoardHit {
  /** the creative's WebP, under the page's base URL; null when it isn't in the pool */
  image: string | null;
  /** its title (the words on it) */
  title: string;
}

interface FormatMesh {
  spec: FormatSpec;
  slots: AdSlot[];
  /** index of each of `slots` in the full slot list (for the limiter) */
  index: number[];
  mesh: InstancedMesh<PlaneGeometry, ShaderMaterial>;
  /** creative id → layer in the uploaded array */
  layers: Map<string, number>;
  state: InstanceState;
}

export class AdBoards {
  readonly meshes: InstancedMesh<PlaneGeometry, ShaderMaterial>[] = [];
  private readonly formats: FormatMesh[] = [];
  private readonly limiter: LitLimiter;
  private readonly images = new Map<string, Promise<HTMLImageElement | null>>();
  private readonly files: Map<string, string>;
  private readonly ktx2Files: Map<string, string>;
  /** keyframes per pool creative (1 = a still) */
  private readonly keyCount: Map<string, number>;
  /** GPU bytes of what is uploaded now, per format (null: nothing yet) */
  private readonly uploaded = new Map<string, number>();
  /** what the boards show now */
  manifest: AdManifest;
  /** the house set's match seed (null: not chosen yet, or a manifest was set from outside) */
  private seed: number | null = null;
  /** a manifest set from outside (the paid flow) pins the content: match seeds no longer change it */
  private pinned = false;
  /** bumps on every manifest change: a slower upload never overwrites a newer one */
  private generation = 0;
  private chip: CanvasTexture | null = null;
  private disposed = false;
  /** when update() last ran (performance.now): the boards are on screen */
  drawnAt = -Infinity;
  /** the pose and match time of the last update: what is on screen */
  private readonly pose: PlanePose = { x: 0, y: 0, z: 1, shift: 0, aspect: 1 };
  private matchTimeMs = 0;
  private readonly titles: Map<string, string>;

  constructor(
    readonly mapId: string,
    readonly slots: readonly AdSlot[],
    private readonly pool: HousePool,
    private readonly base: string,
    tint = 0xffffff,
    /** KTX2 transcoding (null: the WebP creatives, decoded to RGBA8 layers) */
    private readonly ktx2: Ktx2Source = null,
  ) {
    this.limiter = new LitLimiter(slots);
    const entries = poolEntries(pool);
    this.files = new Map(entries.map((e) => [e.id, e.file]));
    const files = entries.flatMap((e) => [[e.id, e.ktx2] as const, ...(e.keys ?? []).map((k, i) => [`${e.id}#${i + 1}`, k.ktx2] as const)]);
    this.ktx2Files = new Map(files.filter((f): f is readonly [string, string] => !!f[1]));
    this.keyCount = new Map(entries.map((e) => [e.id, (e.keys?.length ?? 0) + 1]));
    this.titles = new Map(entries.map((e) => [e.id, e.title]));
    live.add(this);
    this.manifest = houseManifest(mapId, slots, pool, 0);
    const m = new Matrix4();
    for (const spec of Object.values(FORMATS)) {
      const index = slots.map((s, i) => (s.format === spec.format ? i : -1)).filter((i) => i >= 0);
      if (!index.length) continue;
      const own = index.map((i) => slots[i]!);
      const material = new ShaderMaterial({
        vertexShader: VERTEX,
        fragmentShader: FRAGMENT,
        uniforms: {
          uMap: { value: null },
          uChip: { value: null },
          uFade: { value: 1 },
          uTint: { value: new Color(tint) },
          uOff: { value: new Color(0x15181d) },
          uChipRect: { value: spec.chip },
        },
        depthWrite: true,
      });
      material.userData.noBloom = true;
      const geometry = new PlaneGeometry(1, 1);
      const mesh = new InstancedMesh(geometry, material, own.length);
      own.forEach((s, k) => mesh.setMatrixAt(k, m.makeScale(s.size[0], s.size[1], 1).setPosition(s.pos[0], s.pos[1], s.pos[2] + CREATIVE_Z)));
      mesh.instanceMatrix.needsUpdate = true;
      geometry.setAttribute('aLayers', new InstancedBufferAttribute(new Float32Array(own.length * 2), 2));
      geometry.setAttribute('aPaid', new InstancedBufferAttribute(new Float32Array(own.length * 2), 2));
      // switched off (the bezel's dark screen) until the first creatives are uploaded
      geometry.setAttribute('aLit', new InstancedBufferAttribute(new Float32Array(own.length), 1));
      mesh.computeBoundingSphere();
      mesh.name = `ads-${spec.format}`;
      this.meshes.push(mesh);
      this.formats.push({ spec, slots: own, index, mesh, layers: new Map(), state: rotationState(own, this.manifest, new Map(), 0) });
    }
  }

  /**
   * The paid flow (docs/14 §4.3): a verified manifest replaces the house set until the map changes.
   * Only the creatives it shows are uploaded. (Paid creatives come from the ads CDN, not built yet:
   * until then only house ids resolve.)
   */
  setManifest(manifest: AdManifest): void {
    this.pinned = true;
    this.seed = null;
    this.show(manifest);
  }

  setTint(tint: number): void {
    for (const f of this.formats) (f.mesh.material.uniforms.uTint!.value as Color).setHex(tint);
  }

  /** The house manifest for a match: the same on every client (same seed), the next set next match. */
  private chooseHouse(matchSeed: number): void {
    if (this.pinned || matchSeed === this.seed) return;
    this.seed = matchSeed;
    this.show(houseManifest(this.mapId, this.slots, this.pool, matchSeed));
  }

  /** Switches the content: uploads the creatives `manifest` shows (and the chip if a frame is paid). */
  private show(manifest: AdManifest): void {
    this.manifest = manifest;
    const generation = ++this.generation;
    if (typeof document === 'undefined') return; // tests: no images, no GPU
    for (const f of this.formats) {
      const ids = referencedCreatives(manifest, f.slots, f.spec.format);
      const install = (tex: Texture, layerIds: readonly string[]) => {
        if (this.disposed || generation !== this.generation) return tex.dispose();
        const old = f.mesh.material.uniforms.uMap!.value as Texture | null;
        f.mesh.material.uniforms.uMap!.value = tex;
        f.layers = layerTable(layerIds);
        this.uploaded.set(f.spec.format, textureBytes(tex));
        old?.dispose();
      };
      const decoded = () =>
        Promise.all(ids.map((id) => (this.files.has(id) ? loadImage(this.images, this.base + this.files.get(id)!) : Promise.resolve(null)))).then((images) =>
          install(arrayTexture(images, f.spec), ids),
        );
      // KTX2 layers stay compressed on the GPU (docs/14 §4.5's ETC1S pool); any failure: the WebPs
      // (with Motion creatives' keyframes: compressed, they fit the plan)
      const ktx2 = this.ktx2;
      const keyed = keyframeLayers(ids, (id) => this.keyCount.get(id) ?? 1);
      if (ktx2 && keyed.length && keyed.every((id) => this.ktx2Files.has(id))) {
        void Promise.all(keyed.map((id) => ktx2.loadAsync(this.base + this.ktx2Files.get(id)!) as Promise<CompressedTexture>))
          .then((layers) => {
            const tex = arrayFromLayers(layers);
            for (const l of layers) l.dispose();
            install(tex, keyed);
          })
          .catch((err: unknown) => {
            console.warn('ads: KTX2 layers not transcoded, loading the WebPs', err);
            return decoded();
          });
      } else void decoded();
    }
    const paid = manifest.slots.some((s) => s.frames.some((f) => f.paid));
    if (paid && !this.chip) this.chip = chipTexture();
    for (const f of this.formats) f.mesh.material.uniforms.uChip!.value = paid ? this.chip : null;
  }

  /**
   * Per frame: the house set for this match (`matchSeed`), the beat (match clock), which surfaces
   * are lit, and the instance attributes.
   */
  update(matchTimeMs: number, pose: PlanePose, dt: number, matchSeed = 0): void {
    this.chooseHouse(matchSeed);
    const lit = this.limiter.update(pose, dt);
    Object.assign(this.pose, pose);
    this.matchTimeMs = matchTimeMs;
    this.drawnAt = typeof performance === 'undefined' ? 0 : performance.now();
    for (const f of this.formats) {
      rotationState(f.slots, this.manifest, f.layers, matchTimeMs, f.state);
      const g = f.mesh.geometry;
      const aLayers = g.getAttribute('aLayers') as InstancedBufferAttribute;
      const aPaid = g.getAttribute('aPaid') as InstancedBufferAttribute;
      const aLit = g.getAttribute('aLit') as InstancedBufferAttribute;
      (aLayers.array as Float32Array).set(f.state.layers);
      (aPaid.array as Float32Array).set(f.state.paid);
      // nothing to show until the set's creatives are in: the screens stay switched off
      const ready = f.layers.size > 0;
      f.index.forEach((i, k) => ((aLit.array as Float32Array)[k] = ready ? lit[i]! : 0));
      aLayers.needsUpdate = aPaid.needsUpdate = aLit.needsUpdate = true;
      f.mesh.material.uniforms.uFade!.value = f.state.fade;
    }
  }

  /**
   * The creative under the gameplay-plane point (x, y) as last drawn: only a lit surface whose
   * creatives are in counts. Null over anything else.
   */
  pickAt(x: number, y: number): SavedPick | null {
    const lit = new Float32Array(this.slots.length);
    for (const f of this.formats) if (f.layers.size > 0) f.index.forEach((i) => (lit[i] = this.limiter.lit[i]!));
    const hit = creativeAt(this.slots, this.manifest, lit, this.pose, this.matchTimeMs, x, y);
    if (!hit) return null;
    const file = this.files.get(hit.frame.c);
    return { ...hit, image: file ? this.base + file : null, title: this.titles.get(hit.frame.c) ?? '' };
  }

  /** Some lit surface on screen shows a creative that can be saved (the tap-to-save hint). */
  litOnScreenSavable(): boolean {
    return this.formats.some(
      (f) =>
        f.layers.size > 0 &&
        f.slots.some((slot, k) => {
          if (this.limiter.lit[f.index[k]!]! <= 0.5) return false;
          const frames = this.manifest.slots.find((s) => s.slot === slot.slotId)?.frames ?? [];
          return !!frames[frameIndex(slot, this.matchTimeMs)]?.click;
        }),
    );
  }

  /** On-screen surfaces showing a creative right now (≤ 2 by construction). */
  litOnScreen(pose: PlanePose): number {
    return this.limiter.litOnScreen(pose);
  }

  /**
   * GPU memory the boards' textures take: what is uploaded (compressed or decoded), or, before the
   * first upload, the decoded (RGBA8) plan for the current manifest.
   */
  gpuBytes(): number {
    if (!this.uploaded.size) return plannedGpuBytes(this.manifest, this.slots);
    let bytes = 0;
    for (const b of this.uploaded.values()) bytes += b;
    return bytes + textureBytes(this.chip);
  }

  dispose(): void {
    this.disposed = true;
    live.delete(this);
    this.chip?.dispose();
    for (const f of this.formats) {
      (f.mesh.material.uniforms.uMap!.value as Texture | null)?.dispose();
      f.mesh.material.dispose();
      f.mesh.geometry.dispose();
      f.mesh.removeFromParent();
    }
  }
}
