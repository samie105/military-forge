/**
 * The portrait renderer (§7.3): a player's real soldier, posed and framed, rendered through the game's own
 * WebGL context (one context for the whole app) into a multisampled render target and read back without a
 * stall (readRenderTargetPixelsAsync), then encoded to WebP. It pools one CharacterInstance from the shared
 * CharacterAssembler, so it shares the game's geometry and part caches.
 *
 * The renderer's state (render target, clear colour and alpha, autoClear) is saved and restored around
 * each job; shadowMap.enabled is never touched (it would re-link shaders). The scene has a hemisphere
 * light and one directional light, like the game's: the first portrait links its programs, later ones
 * don't.
 */
import {
  AnimationMixer,
  Box3,
  Color,
  DirectionalLight,
  HemisphereLight,
  Matrix4,
  PerspectiveCamera,
  Quaternion,
  SRGBColorSpace,
  Scene,
  Vector3,
  WebGLRenderTarget,
  type AnimationClip,
  type Bone,
  type SkinnedMesh,
  type WebGLRenderer,
} from 'three';
import type { CosmeticLoadout } from '@military-forge/content';
import { OutlineMaterial, type CharacterAssembler, type CharacterInstance } from '../character';
import { isPoster, type PortraitPose } from './key';

/** How each pose is made: a clip, a moment in it, and the head's turn toward the camera and its pitch (deg; + = chin down). */
export const POSES: Record<PortraitPose, { clip: string; t: number; headYaw: number; headPitch: number; yaw: number }> = {
  portrait: { clip: 'idle', t: 0, headYaw: 15, headPitch: 6, yaw: 20 },
  'portrait-win': { clip: 'idle', t: 0.4, headYaw: 12, headPitch: -9, yaw: 20 },
  'portrait-down': { clip: 'idle', t: 0, headYaw: 4, headPitch: 22, yaw: 16 },
  'poster-1': { clip: 'idle', t: 0, headYaw: 14, headPitch: 2, yaw: 24 },
  'poster-2': { clip: 'aim_rifle_level', t: 0, headYaw: 8, headPitch: 0, yaw: 30 },
  'poster-3': { clip: 'jet_hover', t: 0.45, headYaw: 12, headPitch: -4, yaw: 22 },
  'poster-4': { clip: 'walk_slow', t: 0.35, headYaw: 14, headPitch: 0, yaw: 28 },
  'poster-5': { clip: 'idle', t: 1.1, headYaw: 18, headPitch: -6, yaw: 18 },
  'poster-6': { clip: 'crouch_idle', t: 0, headYaw: 16, headPitch: -2, yaw: 20 },
};

const FOV = 20;
const D2R = Math.PI / 180;

export interface RenderedPortrait {
  blob: Blob;
  width: number;
  height: number;
}

export class PortraitRenderer {
  private readonly scene = new Scene();
  private readonly camera = new PerspectiveCamera(FOV, 1, 0.05, 40);
  private readonly hemi = new HemisphereLight(0xdfe8ff, 0x3a3530, 1.15);
  private readonly key = new DirectionalLight(0xffffff, 2.3);
  private readonly outline = new OutlineMaterial();
  private readonly targets = new Map<string, WebGLRenderTarget>();
  private inst: CharacterInstance | null = null;
  private mixer: AnimationMixer | null = null;
  private building: Promise<CharacterInstance> | null = null;
  /** jobs run one at a time: they share the pooled soldier and the render target */
  private chain: Promise<unknown> = Promise.resolve();
  private readonly clearColour = new Color();

  constructor(
    private readonly renderer: WebGLRenderer,
    private readonly assembler: CharacterAssembler,
  ) {
    this.scene.add(this.hemi, this.key, this.key.target);
  }

  /** Renders one picture; jobs queue behind each other. Rejects if the soldier can't be built (the caller falls back). */
  render(look: CosmeticLoadout, pose: PortraitPose, width: number, height: number): Promise<RenderedPortrait> {
    const job = this.chain.then(() => this.renderNow(look, pose, width, height));
    this.chain = job.catch(() => {});
    return job;
  }

  dispose(): void {
    for (const t of this.targets.values()) t.dispose();
    this.targets.clear();
    this.inst?.dispose();
    this.inst = null;
    this.outline.dispose();
  }

  private async soldier(look: CosmeticLoadout): Promise<CharacterInstance> {
    if (this.inst) {
      await this.inst.setLoadout(look);
      return this.inst;
    }
    this.building ??= this.assembler.create(look, 0).then((inst) => {
      inst.setOutline(this.outline);
      inst.setTeamColour(null);
      inst.material.rim.colour.set(0xcfe0ff);
      inst.material.rim.strength.value = 0.35;
      this.scene.add(inst.root);
      this.mixer = new AnimationMixer(inst.root);
      this.inst = inst;
      return inst;
    });
    try {
      const inst = await this.building;
      await inst.setLoadout(look);
      return inst;
    } finally {
      this.building = null;
    }
  }

  private async renderNow(look: CosmeticLoadout, pose: PortraitPose, width: number, height: number): Promise<RenderedPortrait> {
    const inst = await this.soldier(look);
    const recipe = POSES[pose];
    this.pose(inst, recipe.clip, recipe.t, recipe.headYaw, recipe.headPitch);
    this.frame(inst, pose, recipe.yaw, width / height);
    const px = Math.min(width, height);
    this.outline.setViewport(width, height);
    this.outline.setWidth(px >= 128 ? 2 : 1.5);

    const target = this.target(width, height);
    const r = this.renderer;
    const prevTarget = r.getRenderTarget();
    const prevAlpha = r.getClearAlpha();
    r.getClearColor(this.clearColour);
    const prevAuto = r.autoClear;
    try {
      r.setRenderTarget(target);
      r.setClearColor(0x000000, 0);
      r.autoClear = true;
      r.clear(true, true, true);
      r.render(this.scene, this.camera);
    } finally {
      r.setRenderTarget(prevTarget);
      r.setClearColor(this.clearColour, prevAlpha);
      r.autoClear = prevAuto;
    }
    const pixels = new Uint8Array(width * height * 4);
    await r.readRenderTargetPixelsAsync(target, 0, 0, width, height, pixels);
    return { blob: await encode(pixels, width, height), width, height };
  }

  private target(width: number, height: number): WebGLRenderTarget {
    const key = `${width}x${height}`;
    let t = this.targets.get(key);
    if (!t) {
      // sRGB storage: the toon colours come back as the game shows them; 4× MSAA for clean edges
      t = new WebGLRenderTarget(width, height, { samples: 4, colorSpace: SRGBColorSpace });
      this.targets.set(key, t);
    }
    return t;
  }

  /** One frame of a clip, then the head turned toward the camera and pitched (world axes). */
  private pose(inst: CharacterInstance, clipName: string, t: number, headYaw: number, headPitch: number): void {
    const mixer = this.mixer!;
    mixer.stopAllAction();
    const clip: AnimationClip | undefined = inst.clips.find((c) => c.name === clipName) ?? inst.clips.find((c) => c.name === 'idle');
    if (clip) {
      const action = mixer.clipAction(clip);
      action.reset().play();
      mixer.setTime(Math.min(t, Math.max(0, clip.duration - 1e-3)));
    }
    inst.root.updateMatrixWorld(true);
    const head = inst.bone('head');
    if (head) {
      turn(head, new Vector3(0, 1, 0), headYaw * D2R);
      turn(head, new Vector3(1, 0, 0), headPitch * D2R);
      inst.root.updateMatrixWorld(true);
    }
  }

  /**
   * The camera: 3/4 front (`yaw` degrees round from the soldier's front), FOV 20°. Head-and-shoulders
   * frames the collarbones to just above the headgear's top (the bind-pose bounds moved with the head,
   * so tall hats fit); posters frame the whole soldier, from a little below eye level.
   */
  private frame(inst: CharacterInstance, pose: PortraitPose, yaw: number, aspect: number): void {
    const mesh = inst.meshes[0] as SkinnedMesh;
    if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
    const bounds = new Box3().copy(mesh.geometry.boundingBox!).applyMatrix4(mesh.matrixWorld);
    const head = inst.bone('head');
    const headNow = head ? head.getWorldPosition(new Vector3()) : new Vector3(0, 1.2, 0);
    const headBind = bindPosition(mesh, 'head') ?? headNow.clone();
    const top = bounds.max.y + (headNow.y - headBind.y);
    const clavicles = ['clavicle_L', 'clavicle_R'].map((n) => inst.bone(n)?.getWorldPosition(new Vector3())).filter((v): v is Vector3 => !!v);
    const shoulders = clavicles.length ? clavicles.reduce((s, v) => s + v.y, 0) / clavicles.length : headNow.y - 0.3;

    const poster = isPoster(pose);
    const bottom = poster ? Math.min(0, bounds.min.y) - 0.04 : shoulders - 0.12;
    const ceiling = top + (poster ? 0.06 : 0.07);
    const span = ceiling - bottom;
    const centre = new Vector3(poster ? 0 : headNow.x, (ceiling + bottom) / 2, poster ? 0 : headNow.z);
    // the span fills the height (square and tall pictures: the width follows)
    const distance = span / 2 / Math.tan((FOV * D2R) / 2);
    const a = yaw * D2R;
    const lift = poster ? -0.12 * span : 0.04 * span;
    this.camera.fov = FOV;
    this.camera.aspect = aspect;
    this.camera.position.set(centre.x + Math.sin(a) * distance, centre.y + lift, centre.z + Math.cos(a) * distance);
    this.camera.lookAt(centre);
    this.camera.updateProjectionMatrix();
    // the key light from the camera's side and above; the hemisphere fills the rest
    this.key.position.set(this.camera.position.x + 1.6, centre.y + 2.4, this.camera.position.z * 0.6 + 1.2);
    this.key.target.position.copy(centre);
    this.key.target.updateMatrixWorld();
  }
}

/** Rotates a bone about a world-space axis (its parent's frame converts it). */
function turn(bone: Bone, worldAxis: Vector3, angle: number): void {
  if (angle === 0) return;
  const parent = bone.parent;
  const local = worldAxis.clone();
  if (parent) {
    const q = parent.getWorldQuaternion(new Quaternion()).invert();
    local.applyQuaternion(q);
  }
  bone.quaternion.premultiply(new Quaternion().setFromAxisAngle(local.normalize(), angle));
}

/** Where a bone sits in the bind pose, in world space (from the skeleton's inverse bind matrices). */
function bindPosition(mesh: SkinnedMesh, name: string): Vector3 | null {
  const i = mesh.skeleton.bones.findIndex((b) => b.name === name);
  if (i < 0) return null;
  const m = new Matrix4().copy(mesh.skeleton.boneInverses[i]!).invert();
  return new Vector3().setFromMatrixPosition(m).applyMatrix4(mesh.bindMatrix).applyMatrix4(mesh.matrixWorld);
}

/** Bottom-up premultiplied RGBA → a top-down straight-alpha WebP (PNG where the browser can't encode WebP). */
export async function encode(pixels: Uint8Array, width: number, height: number): Promise<Blob> {
  const out = new Uint8ClampedArray(width * height * 4);
  const row = width * 4;
  for (let y = 0; y < height; y++) {
    const src = (height - 1 - y) * row;
    const dst = y * row;
    for (let x = 0; x < row; x += 4) {
      const a = pixels[src + x + 3]!;
      const k = a > 0 && a < 255 ? 255 / a : 1;
      out[dst + x] = pixels[src + x]! * k;
      out[dst + x + 1] = pixels[src + x + 1]! * k;
      out[dst + x + 2] = pixels[src + x + 2]! * k;
      out[dst + x + 3] = a;
    }
  }
  const image = new ImageData(out, width, height);
  if (typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(width, height);
    canvas.getContext('2d')!.putImageData(image, 0, 0);
    return canvas.convertToBlob({ type: 'image/webp', quality: 0.9 });
  }
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.getContext('2d')!.putImageData(image, 0, 0);
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/webp', 0.9));
}
