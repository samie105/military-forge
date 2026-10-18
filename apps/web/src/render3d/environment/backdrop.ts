/**
 * Painted backdrops (docs/11 §2: the far background, z −40 and beyond, and the deep end of the mid
 * band): a sky that stays with the camera, and skyline panels standing in the world behind the
 * street, so perspective gives each its own gentle parallax. Unlit, out of the fog (the art is
 * already hazed and graded by apps/web/scripts/backdrops.py) and tinted per look (dusk, night).
 *
 * Art: Higgsfield (GPT Image 2.5) originals, processed into WebP; see art/README.md's cost table
 * for the jobs and credits.
 */
import { Mesh, MeshBasicMaterial, PlaneGeometry, SRGBColorSpace, TextureLoader, type Texture } from 'three';
import type { PlanePose } from '../planeCamera';
import { FOV_DEG, TILT_DEG } from '../planeCamera';

export interface BackdropPanel {
  file: string;
  /** centre x and width (m); the height follows the image */
  x: number;
  width: number;
  /** mirror the image left-right (a second copy of a distant ridge or row that doesn't read as a repeat) */
  flip?: boolean;
}

export interface BackdropLayer {
  name: string;
  /** depth (negative: behind the play plane) and the height of the panels' bottom edge */
  z: number;
  y: number;
  panels: BackdropPanel[];
  /** an opaque painting (an interior's back wall) rather than a cut-out skyline */
  opaque?: boolean;
}

export interface BackdropDef {
  /** under BASE_URL, ending in '/' */
  base: string;
  /** the sky image for each look name (a look without one keeps the gradient) */
  skies: Record<string, string>;
  layers: BackdropLayer[];
}

/** the sky card's depth: in front of the gradient, behind every layer */
export const SKY_CARD_Z = -71.5;

const HALF_TAN = Math.tan(((FOV_DEG / 2) * Math.PI) / 180);
const TILT_TAN = Math.tan((TILT_DEG * Math.PI) / 180);

export interface Rect3 {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * The rectangle the 3D camera sees at depth `z` (planeCamera.ts: it looks straight down −Z with
 * the 5° look-down done as a lens shift, so the view's centre drops by tan 5° per metre of depth).
 */
export function viewAtDepth(pose: PlanePose, z: number, out: Rect3 = { x: 0, y: 0, width: 0, height: 0 }): Rect3 {
  const d = pose.z - z;
  out.height = 2 * d * HALF_TAN;
  out.width = out.height * pose.aspect;
  out.x = pose.x;
  out.y = pose.y - d * TILT_TAN;
  return out;
}

/** world-space bounds the camera roams (for the sky's slow slide) */
export interface Roam {
  cx: number;
  cy: number;
  halfW: number;
  halfH: number;
}

const view: Rect3 = { x: 0, y: 0, width: 0, height: 0 };

/**
 * Places a camera-anchored card of image aspect `aspect` so it covers the view at its depth with a
 * margin, sliding a little against the camera's position on the map (the sky's own parallax).
 */
export function coverView(mesh: Mesh, aspect: number, pose: PlanePose, roam: Roam, margin = 0.18): void {
  viewAtDepth(pose, mesh.position.z, view);
  const h = Math.max(view.height * (1 + margin), (view.width * (1 + margin)) / aspect);
  const w = h * aspect;
  const mx = (w - view.width) / 2;
  const my = (h - view.height) / 2;
  const fx = Math.max(-1, Math.min(1, (pose.x - roam.cx) / Math.max(1, roam.halfW)));
  const fy = Math.max(-1, Math.min(1, (pose.y - roam.cy) / Math.max(1, roam.halfH)));
  mesh.scale.set(w, h, 1);
  mesh.position.x = view.x - fx * mx * 0.85;
  mesh.position.y = view.y - fy * my * 0.85;
}

export interface BackdropMeshes {
  sky: Mesh<PlaneGeometry, MeshBasicMaterial> | null;
  /** sky image aspect (width / height), once loaded */
  skyAspect: number;
  panels: Mesh<PlaneGeometry, MeshBasicMaterial>[];
  textures: Texture[];
  ready: Promise<void>;
}

/**
 * Builds the backdrop meshes for a look. Textures stream in; `ready` resolves when all are in (a
 * missing image only leaves its panel out).
 */
export function buildBackdrop(def: BackdropDef, look: string, tints: Record<string, number>, baseUrl: string, loader = new TextureLoader()): BackdropMeshes {
  const out: BackdropMeshes = { sky: null, skyAspect: 21 / 9, panels: [], textures: [], ready: Promise.resolve() };
  const loads: Promise<void>[] = [];
  // images need a DOM: in tests and workers the meshes exist but never show
  const canLoad = typeof document !== 'undefined';
  const load = (file: string, onLoad: (t: Texture) => void) =>
    canLoad &&
    loads.push(
      loader.loadAsync(baseUrl + def.base + file).then(
        (t) => {
          t.colorSpace = SRGBColorSpace;
          t.anisotropy = 4;
          out.textures.push(t);
          onLoad(t);
        },
        (err: unknown) => console.warn(`backdrop: ${file} not loaded`, err),
      ),
    );
  const skyFile = def.skies[look];
  if (skyFile) {
    const sky = new Mesh(new PlaneGeometry(1, 1), new MeshBasicMaterial({ color: tints.sky ?? 0xffffff, fog: false, depthWrite: false }));
    sky.name = 'sky-art';
    sky.position.z = SKY_CARD_Z;
    sky.renderOrder = -18;
    sky.frustumCulled = false;
    sky.visible = false;
    out.sky = sky;
    load(skyFile, (t) => {
      sky.material.map = t;
      sky.material.needsUpdate = true;
      const img = t.image as { width: number; height: number };
      out.skyAspect = img.width / img.height;
      sky.visible = true;
    });
  }
  def.layers.forEach((layer, li) => {
    for (const p of layer.panels) {
      const geometry = new PlaneGeometry(1, 1).translate(0, 0.5, 0);
      if (p.flip) {
        const uv = geometry.attributes.uv!;
        for (let i = 0; i < uv.count; i++) uv.setX(i, 1 - uv.getX(i));
      }
      const mesh = new Mesh(
        geometry,
        new MeshBasicMaterial({ color: tints[layer.name] ?? 0xffffff, transparent: !layer.opaque, depthWrite: !!layer.opaque, fog: false }),
      );
      mesh.name = `backdrop-${layer.name}`;
      mesh.position.set(p.x, layer.y, layer.z);
      // deepest first: transparent layers blend back to front
      mesh.renderOrder = -16 + li;
      mesh.visible = false;
      out.panels.push(mesh);
      load(p.file, (t) => {
        const img = t.image as { width: number; height: number };
        mesh.scale.set(p.width, (p.width * img.height) / img.width, 1);
        mesh.material.map = t;
        mesh.material.needsUpdate = true;
        mesh.visible = true;
      });
    }
  });
  out.ready = Promise.all(loads).then(() => undefined);
  return out;
}
