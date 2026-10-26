/**
 * Map environments: the art a map is drawn with in 3D, for maps that have a kit (docs/11 §2).
 *
 * Without an environment a map is its collision, extruded (mapGeometry.ts), plus generated depth
 * layers (layers.ts). With one, the kit's pieces are placed from the map's layout, the same file
 * the art pipeline compiled the map's collision from, so the gameplay plane still shows exactly
 * what you collide with (check with H). Around it: a lighting preset and per-layer grade
 * (looks.ts), the sky, the street in front, the yard behind, contact shadows and foreground props.
 *
 * Painted backdrops (backdrop.ts) go behind it all: a sky that stays with the camera and skyline
 * panels with their own parallax. A map has several looks (day, dusk, night); `?look=` picks one.
 *
 * Renderer3D hooks (render3d/index.ts): `environmentFor(map.id)` in `buildMap`; the environment's
 * `look` replaces `lightingFor`, its `layers` replace `buildDepthLayers`, `load()` waits for
 * `kitReady` (with a timeout), the shaders of whatever arrives later are compiled when `ready`
 * resolves, `update(pose, frame, dt)` runs each frame, and the extruded plane is hidden once
 * `drawsPlane` turns true.
 */
import type { MapDef } from '@military-forge/content';
import {
  AdditiveBlending,
  BufferAttribute,
  Color,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  PlaneGeometry,
  type BufferGeometry,
  type Material,
  type Object3D,
  type Texture,
} from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { AdBoards, TICK_MS, adsUrl, type AdSlot, type AdsDef, type HousePool } from '../ads';
import { buildDepthLayers, coversPlayer, projectToPlane, type DepthLayers, type ForegroundProp, type Rect } from '../layers';
import { PLANE_BACK_Z } from '../mapGeometry';
import type { PlanePose } from '../planeCamera';
import { buildBackdrop, coverView, type BackdropDef, type BackdropMeshes, type Roam } from './backdrop';
import { layoutItems, placementMatrix, type KitLayout } from './layout';
import type { Frame, PlayerView } from '../../view';
import { buildCity } from './city';
import { bunting, faded, mergeBlobs, palm, tree, wire, type Fade, type Vec3 } from './dressing';
import { mapGrade, type EnvironmentLook } from './looks';
import { contactFootprints, kitPieces, mergeLayer, type ContactShadow, type KitPiece } from './merge';
import { contactShadows, streetLampGeometry } from './props';
import { skyGradient, sunGlow } from './sky';
import { KERB_Z, buildBackGround, buildStreet, streetHeight } from './street';
import { QuadBuilder } from './shapes';
import { SHOP_SIGNS, signAtlas, signGeometry, type SignPlacement } from './signs';
import { FLUX_LAB, FOG_STAIR, LUNAR_OUTPOST, STORM_FRONT } from './places';
import { textureBytes, type Ktx2Source } from './ktx2';
import { STREET_MARKET } from './streetMarket';
import { disposeTextures, glowTexture, grimeTexture, softBoxTexture } from './textures';

export interface DressingDef {
  /** power lines between every placement of the pole piece: attach points [x, y] in pole space */
  poles?: { piece: string; attach: [number, number][]; extendTo: [number, number]; sag: number };
  bunting?: { a: Vec3; b: Vec3; sag: number }[];
  trees?: { x: number; z: number; h: number }[];
  palms?: { x: number; z: number; h: number }[];
  city?: { zNear: number; zFar: number; hazeBase: number; hazePerM: number; walls: number[]; window: number; trim: number; tank: number };
  /** shop fascias on these gameplay pieces (piece space: centre x 0), one design each in turn */
  signs?: { pieces: string[]; y0: number; y1: number; z: number; width: number };
}

export interface EnvironmentDef {
  /** the map this dresses */
  mapId: string;
  /** the map's kit and layout under BASE_URL; without them the extruded collision stays the play plane */
  kitUrl?: string;
  layoutUrl?: string;
  /** lighting and grade by name ('day', 'dusk', 'night'); `defaultLook` unless ?look= asks for another */
  looks: Record<string, EnvironmentLook>;
  defaultLook: string;
  /** painted sky and skyline layers (backdrop.ts) */
  backdrop?: BackdropDef;
  /** billboard ads on the kit's bezels: house art until there is an ads backend (render3d/ads) */
  ads?: AdsDef;
  /** world x of each foreground street lamp (kit maps) */
  lamps?: number[];
  /**
   * The street in front of the gameplay band and the yard behind it (kit maps; default true). A kit
   * that draws its own ground at every height (Fog Stair: quays, stairs, a hill) leaves them out.
   */
  street?: boolean;
  dressing?: DressingDef;
}

export const ENVIRONMENTS: Readonly<Record<string, EnvironmentDef>> = {
  [STREET_MARKET.mapId]: STREET_MARKET,
  [LUNAR_OUTPOST.mapId]: LUNAR_OUTPOST,
  [STORM_FRONT.mapId]: STORM_FRONT,
  [FLUX_LAB.mapId]: FLUX_LAB,
  [FOG_STAIR.mapId]: FOG_STAIR,
};

export function environmentFor(mapId: string): EnvironmentDef | null {
  return ENVIRONMENTS[mapId] ?? null;
}

/**
 * How long Renderer3D's `load()` waits for a map's kit (the play plane) before showing the 3D view
 * anyway: the extruded collision stands in until it arrives. The art around it never holds the
 * view back.
 */
export const KIT_WAIT_MS = 6000;

/** `p`, or nothing once `ms` have passed (a stalled request mustn't keep the view blank). */
export function withTimeout(p: Promise<unknown>, ms: number): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([p, new Promise((resolve) => (timer = setTimeout(resolve, ms)))]).finally(() => clearTimeout(timer));
}

/**
 * `?look=dusk|night`, in dev builds only (screenshots, art checks): which look a match uses is the
 * owner's call (still open), so production builds always show the map's default look. A match
 * setting can pass the name to MapEnvironment instead.
 */
export function requestedLook(): string | null {
  if (!import.meta.env.DEV) return null;
  try {
    return typeof location === 'undefined' ? null : new URLSearchParams(location.search).get('look');
  } catch {
    return null;
  }
}

export { createKtx2, ktx2Gate, ktx2Wanted, type Ktx2Source } from './ktx2';


/** a decor piece's world bounds (m) */
export interface DecorBox {
  piece: string;
  min: [number, number, number];
  max: [number, number, number];
}

/** the part of GLTFLoader the environment uses (tests pass a stub) */
export interface KitSource {
  loadAsync(url: string): Promise<GLTF>;
}

/** weathering map tile (m) */
const UV_TILE = 4.5;
/** foreground lamps stand on the near pavement; their heads hang over the road */
const LAMP_Z = 6.15;
const LAMP_HEAD: [number, number] = [6.3, LAMP_Z - 1.72];
/** the lamp-head glow quad (m) */
const GLOW_SIZE = 2.2;
const glowRect: Rect = { x0: 0, y0: 0, x1: 0, y1: 0 };
const glowColor = new Color();

export class MapEnvironment {
  readonly look: EnvironmentLook;
  readonly lookName: string;
  readonly background = new Group();
  readonly foregroundGroup = new Group();
  readonly foreground: ForegroundProp[] = [];
  private readonly materials: Material[] = [];
  private readonly textures: Texture[] = [];
  private readonly kit = new Group();
  /** resolves when the kit is in, or failed to load (the extruded plane stays then): the play plane */
  readonly kitReady: Promise<void>;
  /** resolves when everything the environment loads is in (or failed): the kit and any art around it */
  readonly ready: Promise<void>;
  /** the kit draws the gameplay plane: the extruded collision mesh can hide */
  drawsPlane = false;
  private disposed = false;
  /** the High preset's shadow map is on (contact shadows go lighter) */
  private shadowMap = false;
  private readonly grime: Texture;
  private gradient: Mesh | null = null;
  private backdrop: BackdropMeshes | null = null;
  /** lit lamp heads (night): per-head fade, so a player under one never gets an additive halo */
  private lampHeads: { mesh: InstancedMesh; z: number; bounds: Rect[]; fade: Float32Array } | null = null;
  /** billboard creatives (null for maps without ad slots, and until the slots load) */
  boards: AdBoards | null = null;
  /**
   * World boxes of the kit's mid-layer pieces once the kit is in: drawn, but with no collision. The
   * bullet audit (scripts/bullet-audit.py) marks them; whatever looks solid here must read as
   * background (streetMarket.test.ts).
   */
  readonly decorBoxes: DecorBox[] = [];
  /** the shop-sign atlas (a canvas: no download) */
  private signsTexture: Texture | null = null;
  private readonly roam: Roam;

  constructor(
    readonly def: EnvironmentDef,
    readonly map: MapDef,
    baseUrl: string,
    loader: KitSource = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder),
    fetchJson: (url: string) => Promise<unknown> = (url) => fetch(url).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`${url}: ${r.status}`)))),
    look: string | null = requestedLook(),
    /** KTX2 transcoding (Renderer3D's loader); null: WebP and canvas textures only */
    private readonly ktx2: Ktx2Source = null,
  ) {
    this.lookName = look && def.looks[look] ? look : def.defaultLook;
    this.look = def.looks[this.lookName]!;
    const b = map.bounds;
    this.roam = { cx: (b.minX + b.maxX) / 2, cy: (b.minY + b.maxY) / 2, halfW: (b.maxX - b.minX) / 2, halfH: (b.maxY - b.minY) / 2 };
    this.background.name = `environment:${def.mapId}:${this.lookName}`;
    this.foregroundGroup.name = 'environment-foreground';
    this.grime = this.texture(grimeTexture());
    this.buildStatic(baseUrl, fetchJson);
    this.kit.name = 'kit';
    this.background.add(this.kit);
    const kitUrl = def.kitUrl;
    const layoutUrl = def.layoutUrl;
    this.kitReady = !kitUrl || !layoutUrl ? Promise.resolve() : Promise.all([loader.loadAsync(baseUrl + kitUrl), fetchJson(baseUrl + layoutUrl)]).then(
      ([gltf, layout]) => {
        if (this.disposed) return;
        this.buildKit(kitPieces(gltf.scene), layout as KitLayout);
        this.drawsPlane = true;
      },
      (err: unknown) => console.error(`environment ${def.mapId}: kit not loaded, drawing the collision instead`, err),
    );
    const ads = def.ads ? this.loadAds(def.ads, baseUrl, fetchJson) : undefined;
    this.ready = Promise.all([this.kitReady, this.backdrop?.ready, ads]).then(() => {
      // a texture that arrived after dispose()
      if (this.disposed && this.backdrop) disposeTextures(this.backdrop.textures);
    });
  }

  /** The map's ad slots and house pool → the billboard renderer (≤ 2 draws). */
  private async loadAds(ads: AdsDef, baseUrl: string, fetchJson: (url: string) => Promise<unknown>): Promise<void> {
    try {
      // per build (adsUrl): a week-old cached pool must never outlive the art it names
      const [slots, pool] = (await Promise.all([fetchJson(adsUrl(baseUrl + ads.slots)), fetchJson(adsUrl(baseUrl + ads.pool))])) as [AdSlot[], HousePool];
      if (this.disposed) return;
      // the house set follows the match (Frame.matchSeed, in update): the paid flow will send a signed manifest
      this.boards = new AdBoards(this.def.mapId, slots, pool, baseUrl + ads.base, this.look.adTint, this.ktx2);
      for (const m of this.boards.meshes) this.background.add(m);
    } catch (err) {
      console.warn(`environment ${this.def.mapId}: no billboards`, err);
    }
  }

  /** The depth layers Renderer3D draws and dither-fades (layers.ts shape). */
  get layers(): DepthLayers {
    return { background: this.background, foreground: this.foreground, foregroundGroup: this.foregroundGroup, materials: this.materials };
  }

  private texture<T extends Texture>(t: T): T {
    this.textures.push(t);
    return t;
  }

  private material<T extends Material>(m: T): T {
    this.materials.push(m);
    return m;
  }

  /** Sky, backdrops, street, yard and foreground: everything that doesn't wait for the kit. */
  private buildStatic(baseUrl: string, fetchJson: (url: string) => Promise<unknown>): void {
    const b = this.map.bounds;
    const cx = (b.minX + b.maxX) / 2;
    const x0 = b.minX - 110;
    const x1 = b.maxX + 110;
    const look = this.look;
    const glowMap = this.texture(glowTexture());
    const painted = this.def.backdrop;
    const hasSkyArt = !!painted?.skies[this.lookName];
    if (painted) {
      this.backdrop = buildBackdrop(painted, this.lookName, look.backdropTint, baseUrl, undefined, this.ktx2, fetchJson, look.backdropHaze);
      for (const m of [this.backdrop.sky, ...this.backdrop.panels]) {
        if (!m) continue;
        this.material(m.material);
        this.background.add(m);
      }
    }
    if (!this.def.kitUrl) {
      // no kit: the extruded collision stays the play plane; keep the generated ground and
      // foreground (layers.ts) and let the painted layers stand in for its sky, skyline and blocks
      const base = buildDepthLayers(this.map, look);
      const pick = (name: string) => base.background.getObjectByName(name);
      const sky = pick('sky');
      const far = pick('far-skyline');
      const ground = pick('ground');
      const mid = pick('mid-blocks');
      const paintedMid = !!painted?.layers.some((l) => l.name === 'mid');
      for (const o of [sky, far, ground, mid]) {
        if (!o) continue;
        if (o === far && painted) continue;
        if (o === mid && paintedMid) continue;
        this.background.add(o);
      }
      // the generated sky stays until the painted sky (or an interior's back wall) is in, so a
      // failed or slow image never leaves the clear colour showing (update hides it)
      if (sky) this.gradient = sky as Mesh;
      for (const m of base.materials) this.material(m);
      // below ground behind the band: a pit or crater in the play plane looks into the ground, not the sky
      const skirtMat = this.material(new MeshLambertMaterial({ color: look.palette.ground }));
      const skirt = new Mesh(new PlaneGeometry(x1 - x0, -b.minY + 40).translate((x0 + x1) / 2, (b.minY - 40) / 2, 0), skirtMat);
      skirt.position.z = PLANE_BACK_Z - 0.02;
      skirt.name = 'ground-skirt';
      this.background.add(skirt);
      this.foreground.push(...base.foreground);
      for (const o of [...base.foregroundGroup.children]) this.foregroundGroup.add(o);
      return;
    }

    const sky = skyGradient(look, cx);
    this.material(sky.material);
    this.background.add(sky);
    this.gradient = sky;
    if (look.sunGlow.strength > 0 && !hasSkyArt) {
      const glow = sunGlow(look, glowMap);
      this.material(glow.material);
      this.background.add(glow);
    }

    if (this.def.street === false) return;
    const lit = this.material(new MeshLambertMaterial({ vertexColors: true, map: this.grime }));
    const street = new Mesh(buildStreet(look, x0, x1).build(), lit);
    street.name = 'street';
    street.receiveShadow = true;
    const yard = new Mesh(buildBackGround(look, x0, x1).build(), lit);
    yard.name = 'yard';
    yard.receiveShadow = true;
    this.background.add(street, yard);

    const lampGeo = streetLampGeometry();
    for (const x of this.def.lamps ?? []) {
      const material = this.material(new MeshLambertMaterial({ vertexColors: true, alphaHash: true }));
      const mesh = new Mesh(lampGeo, material);
      mesh.position.set(x, streetHeight(LAMP_Z), LAMP_Z);
      mesh.castShadow = true;
      mesh.name = 'street-lamp';
      this.foregroundGroup.add(mesh);
      this.foreground.push({ mesh, material, bounds: { x0: x - 0.3, y0: -3, x1: x + 0.3, y1: 6.6 }, z: LAMP_Z, opacity: 1 });
    }
    if (look.lampGlow) this.buildLampGlows(look.lampGlow, glowMap);
  }

  /** Lit lamps: a glow at each head and a warm pool on the road under it (two instanced draws). */
  private buildLampGlows(glow: { color: number; strength: number }, map: Texture): void {
    const lamps = this.def.lamps ?? [];
    const m = new Matrix4();
    const make = (name: string, geo: PlaneGeometry, strength: number, place: (x: number) => Matrix4) => {
      const material = this.material(
        new MeshBasicMaterial({ color: new Color(glow.color).multiplyScalar(strength), alphaMap: map, transparent: true, blending: AdditiveBlending, depthWrite: false, fog: false }),
      );
      const mesh = new InstancedMesh(geo, material, lamps.length);
      lamps.forEach((x, i) => mesh.setMatrixAt(i, place(x)));
      mesh.instanceMatrix.needsUpdate = true;
      mesh.computeBoundingSphere();
      mesh.name = name;
      mesh.renderOrder = 5;
      return mesh;
    };
    const [hy, hz] = LAMP_HEAD;
    const heads = make('lamp-glow', new PlaneGeometry(1, 1), glow.strength, (x) => m.makeScale(GLOW_SIZE, GLOW_SIZE, 1).setPosition(x, hy, hz + 0.05));
    const pools = make('lamp-pool', new PlaneGeometry(1, 1).rotateX(-Math.PI / 2), glow.strength * 0.55, (x) => m.makeScale(7, 1, 5.2).setPosition(x, streetHeight(hz) + 0.02, hz));
    this.foregroundGroup.add(heads);
    this.background.add(pools);
    // each head's glow fades out while it covers a player on screen (like the foreground props, but
    // all the way: an additive halo over a player would brighten them)
    const half = GLOW_SIZE / 2;
    const white = new Color(1, 1, 1);
    lamps.forEach((_, i) => heads.setColorAt(i, white));
    this.lampHeads = {
      mesh: heads,
      z: hz + 0.05,
      bounds: lamps.map((x) => ({ x0: x - half, x1: x + half, y0: hy - half, y1: hy + half })),
      fade: new Float32Array(lamps.length).fill(1),
    };
  }

  /** Eases each lamp-head glow to 0 while it covers a living player on screen, back to 1 when clear. */
  private fadeLampHeads(pose: PlanePose, players: readonly PlayerView[], dt: number): void {
    const heads = this.lampHeads;
    if (!heads) return;
    const k = 1 - Math.exp(-dt * 12);
    let changed = false;
    heads.bounds.forEach((b, i) => {
      const target = coversPlayer(projectToPlane(b, heads.z, pose.x, pose.y, pose.z, glowRect), players) ? 0 : 1;
      const f = heads.fade[i]!;
      if (f === target) return;
      const next = Math.abs(target - f) < 0.01 ? target : f + (target - f) * k;
      heads.fade[i] = next;
      heads.mesh.setColorAt(i, glowColor.setScalar(next));
      changed = true;
    });
    if (changed && heads.mesh.instanceColor) heads.mesh.instanceColor.needsUpdate = true;
  }

  private buildKit(pieces: Map<string, KitPiece>, layout: KitLayout): void {
    const items = layoutItems(layout);
    const grade = mapGrade(this.look);
    const missing = new Set<string>();
    const gameplay = mergeLayer(pieces, items, 'gameplay', { grade, uvTile: UV_TILE }, missing);
    const mid = mergeLayer(pieces, items, 'mid', { grade, uvTile: UV_TILE }, missing);
    const far = mergeLayer(pieces, items, 'far', { grade });
    // neon tubes and LED panels: unlit, as authored (they glow through the fog)
    const glow = mergeLayer(pieces, items, 'glow');
    if (missing.size) console.warn(`environment ${this.def.mapId}: the kit has no ${[...missing].join(', ')}`);
    if (gameplay) {
      const mesh = new Mesh(gameplay, this.material(new MeshLambertMaterial({ vertexColors: true, map: this.grime })));
      mesh.name = 'kit-gameplay';
      mesh.castShadow = mesh.receiveShadow = true;
      this.kit.add(mesh);
    }
    if (mid) {
      // the shadow side lifted toward the haze: low contrast behind the play plane (docs/11 §4)
      const material = this.material(new MeshLambertMaterial({ vertexColors: true, map: this.grime, emissive: this.look.grade.haze, emissiveIntensity: this.look.midLift }));
      const mesh = new Mesh(mid, material);
      mesh.name = 'kit-mid';
      mesh.receiveShadow = true;
      this.kit.add(mesh);
    }
    if (far) {
      const mesh = new Mesh(far, this.material(new MeshBasicMaterial({ vertexColors: true })));
      mesh.name = 'kit-far';
      this.kit.add(mesh);
    }
    if (glow) {
      const mesh = new Mesh(glow, this.material(new MeshBasicMaterial({ vertexColors: true })));
      mesh.name = 'kit-glow';
      this.kit.add(mesh);
    }
    const m = new Matrix4();
    for (const item of items) {
      const piece = pieces.get(item.piece);
      if (piece?.layer !== 'mid') continue;
      if (!piece.geometry.boundingBox) piece.geometry.computeBoundingBox();
      const box = piece.geometry.boundingBox!.clone().applyMatrix4(placementMatrix(item, m));
      this.decorBoxes.push({ piece: item.piece, min: box.min.toArray(), max: box.max.toArray() });
    }
    // contact shadows wherever a piece meets the floor (kept on the kit's pavement in front)
    const footprints: ContactShadow[] = [];
    for (const item of items) {
      const piece = pieces.get(item.piece);
      if (!piece || piece.layer === 'far' || piece.layer === 'glow') continue;
      for (const f of contactFootprints(piece, item)) footprints.push({ ...f, z1: Math.min(f.z1, KERB_Z - 0.3) });
    }
    if (footprints.length) {
      const look = this.look.contact;
      const shadows = contactShadows(footprints, this.texture(softBoxTexture()), look.color, this.shadowMap ? look.opacityShadowMap : look.opacity);
      this.material(shadows.material as Material);
      this.kit.add(shadows);
    }
    this.buildSigns(layout);
    const dressing = this.buildDressing(layout);
    if (dressing) {
      const material = this.material(new MeshLambertMaterial({ vertexColors: true, map: this.grime, emissive: this.look.grade.haze, emissiveIntensity: this.look.midLift * 0.5 }));
      const mesh = new Mesh(dressing, material);
      mesh.name = 'dressing';
      mesh.receiveShadow = true;
      this.kit.add(mesh);
    }
  }

  /** Shop fascias on the houses (needs a DOM for the canvas atlas: none in tests). */
  private buildSigns(layout: KitLayout): void {
    const spec = this.def.dressing?.signs;
    if (!spec) return;
    const placements: SignPlacement[] = layout.pieces
      .filter((it) => spec.pieces.includes(it.piece))
      .map((it, i) => ({ x: it.x, y0: spec.y0, y1: spec.y1, z: spec.z, width: spec.width, design: i % SHOP_SIGNS.length }));
    if (!placements.length) return;
    const atlas = signAtlas(SHOP_SIGNS);
    if (!atlas) return;
    this.signsTexture = this.texture(atlas);
    const mesh = new Mesh(signGeometry(placements), this.material(new MeshLambertMaterial({ map: atlas })));
    mesh.name = 'shop-signs';
    mesh.receiveShadow = true;
    this.kit.add(mesh);
  }

  /**
   * GPU memory the environment's textures take, bytes (compressed: as uploaded; decoded: 4 bytes a
   * texel with mips): the painted backdrops, the billboards, the shop signs and the rest.
   */
  gpuTextureBytes(): { backdrops: number; ads: number; signs: number; other: number; total: number } {
    const backdrops = (this.backdrop?.textures ?? []).reduce((s, t) => s + textureBytes(t), 0);
    const ads = this.boards?.gpuBytes() ?? 0;
    const signs = textureBytes(this.signsTexture);
    const other = this.textures.filter((t) => t !== this.signsTexture).reduce((s, t) => s + textureBytes(t), 0);
    return { backdrops, ads, signs, other, total: backdrops + ads + signs + other };
  }

  /** Power lines, bunting, trees, palms and the mid-depth city: one merged mesh. */
  private buildDressing(layout: KitLayout): BufferGeometry | null {
    if (!this.def.dressing) return null; // a kit that dresses itself (Fog Stair): no empty mesh
    const d = this.def.dressing;
    const look = this.look;
    const g = look.grade;
    const fade: Fade = { haze: new Color(g.haze), base: g.mid[2], perM: g.mid[3] };
    const q = new QuadBuilder(UV_TILE);
    const b = this.map.bounds;
    if (d.city) {
      const c = d.city;
      buildCity({ x0: b.minX - 120, x1: b.maxX + 120, zNear: c.zNear, zFar: c.zFar, haze: fade.haze, hazeBase: c.hazeBase, hazePerM: c.hazePerM, walls: c.walls, window: c.window, trim: c.trim, tank: c.tank }, q);
    }
    if (d.poles) {
      const poles = (layout.decor ?? []).filter((it) => it.piece === d.poles!.piece).sort((u, v) => u.x - v.x);
      if (poles.length) {
        const z = poles[0]!.z ?? 0;
        const xs = [d.poles.extendTo[0], ...poles.map((p) => p.x), d.poles.extendTo[1]];
        const colour = faded(0x2b2a28, z, fade);
        for (const [ax, ay] of d.poles.attach) {
          for (let i = 0; i + 1 < xs.length; i++) {
            const span = xs[i + 1]! - xs[i]!;
            wire(q, [xs[i]! + ax, ay, z + 0.05], [xs[i + 1]! + ax, ay, z + 0.05], d.poles.sag * (span / 16), 0.045, colour);
          }
        }
      }
    }
    const flagColours = [0xe2d6bb, 0xc8a13d, 0x7c9a5e, 0x8c3f3a, 0xd9d9cf, 0x6f7f4a];
    (d.bunting ?? []).forEach((s, i) => {
      const z = s.a[2];
      bunting(q, s.a, s.b, s.sag, flagColours.map((h) => faded(h, z, fade)), faded(0x3a3632, z, fade), 0.5, i + 1);
    });
    const blobs: BufferGeometry[] = [];
    (d.trees ?? []).forEach((t, i) => blobs.push(...tree(q, t.x, t.z, t.h, fade, i + 1)));
    (d.palms ?? []).forEach((p, i) => palm(q, p.x, p.z, p.h, fade, i + 1));
    const quads = q.build().toNonIndexed();
    const canopy = mergeBlobs(blobs);
    if (!canopy) return quads;
    // the canopy has no texture coordinates: give it zeros so the two merge
    canopy.setAttribute('uv', new BufferAttribute(new Float32Array(canopy.attributes.position!.count * 2), 2));
    const merged = mergeGeometries([quads, canopy]);
    quads.dispose();
    canopy.dispose();
    return merged;
  }

  /** Contact shadows are lighter under the High preset's real shadow map. */
  setShadowMap(on: boolean): void {
    this.shadowMap = on;
    const shadows = this.kit.getObjectByName('contact-shadows') as Mesh | undefined;
    if (shadows) (shadows.material as MeshBasicMaterial).opacity = on ? this.look.contact.opacityShadowMap : this.look.contact.opacity;
  }

  /**
   * Per frame, after the camera pose: the painted sky stays with the camera, lamp-head glows fade
   * over players, and the billboards follow the match clock (`frame.tick`: everyone in a match sees
   * the same frame). The foreground props' fade is Renderer3D's.
   */
  update(pose: PlanePose, frame: Pick<Frame, 'players' | 'tick' | 'matchSeed'>, dt: number): void {
    this.fadeLampHeads(pose, frame.players, dt);
    this.boards?.update(frame.tick * TICK_MS, pose, dt, frame.matchSeed ?? 0);
    const sky = this.backdrop?.sky;
    if (sky?.visible) coverView(sky, this.backdrop!.skyAspect, pose, this.roam);
    if (this.gradient) this.gradient.visible = !(sky?.visible || this.backdrop?.panels.some((p) => p.visible && !p.material.transparent));
  }

  dispose(): void {
    this.disposed = true;
    const geometries = new Set<BufferGeometry>();
    const collect = (root: Object3D) =>
      root.traverse((o) => {
        const mesh = o as Mesh;
        if (mesh.isMesh) geometries.add(mesh.geometry);
      });
    collect(this.background);
    collect(this.foregroundGroup);
    for (const g of geometries) g.dispose();
    for (const m of this.materials) m.dispose();
    disposeTextures(this.textures);
    if (this.backdrop) disposeTextures(this.backdrop.textures);
    this.boards?.dispose();
    this.background.removeFromParent();
    this.foregroundGroup.removeFromParent();
  }
}
