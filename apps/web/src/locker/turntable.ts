/**
 * The Locker's 3D preview (docs/04 §6), also the character creator's stage: the soldier on a turntable with
 * drag-to-rotate, wheel or pinch zoom, focus presets and lighting presets matching the maps. The stage is dressed for
 * the toon soldier (docs/design/character-feel-research.md §3.12, §5.1 H; stage.ts holds the pure parts):
 * - a studio: key, fill (hemisphere) and rim light, the same three in every preset (adding or removing lights would
 *   re-link shaders); a backdrop plate (a soft vignette and a floor glow in the preset's colours); a contact shadow
 *   under the feet; no environment map (MeshToonMaterial ignores it) and no tone mapping;
 * - per-tab and per-slot camera shots, eased over 450 ms (`frameTab`, `frameSlot`); a change of look frames the slot
 *   that changed and plays a short equip reaction; the head follows the pointer (±25°);
 * - the close-up textures on the body when its manifest lists them (`CharacterInstance.setHero`), a sharper pixel
 *   ratio (2 on phones, up to 3 on desktop) and an outline that thickens as the camera comes closer;
 * - render on demand: while dragging, easing, reacting or a look changes, and the idle (at most 30 fps on a phone);
 *   under Reduce motion the stage rests 3 s after the last input. `Timer` (Page Visibility) instead of `Clock`.
 */
import type { CosmeticLoadout } from '@military-forge/content';
import {
  AnimationMixer,
  CanvasTexture,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DirectionalLight,
  Group,
  HemisphereLight,
  Mesh,
  MeshBasicMaterial,
  MeshDepthMaterial,
  MeshToonMaterial,
  OrthographicCamera,
  PerspectiveCamera,
  PlaneGeometry,
  Quaternion,
  Scene,
  ShaderMaterial,
  SRGBColorSpace,
  Timer,
  Vector3,
  WebGLRenderTarget,
  WebGLRenderer,
  type Object3D,
} from 'three';
import { HorizontalBlurShader } from 'three/addons/shaders/HorizontalBlurShader.js';
import { VerticalBlurShader } from 'three/addons/shaders/VerticalBlurShader.js';
import { OutlineMaterial, characterGltfLoader, characterToonRamp, type CharacterInstance } from '../character';
import { SKIN_GLOW, weaponFromGltf } from '../render3d/weaponModels';
import { rotateWorld, solveTwoBone } from '../render3d/ik';
import { logicalPoint } from '../ui/landscape';
import { DRAW, REACTION_SECONDS, SHOTS, SHOT_SECONDS, changedSlots, easeTravel, reactionFor, reactionWeight, shotForSlot, shotForTab, shouldDraw, type Reaction, type Shot, type ShotName } from './stage';

export type FocusPreset = 'full' | 'face' | 'jetpack';
export type LightPreset = 'lobby' | 'night' | 'desert';

const LIGHTS: Record<LightPreset, { background: string; sky: string; ground: string; ambient: number; key: string; keyIntensity: number; rim: string; floor: string }> = {
  lobby: { background: '#1a2130', sky: '#dfe8ff', ground: '#3a3530', ambient: 1.1, key: '#ffffff', keyIntensity: 2.2, rim: '#7fb8ff', floor: '#2a3344' },
  night: { background: '#080c18', sky: '#5466a0', ground: '#10121a', ambient: 0.7, key: '#a9bcff', keyIntensity: 1.3, rim: '#3fd0c0', floor: '#161c2c' },
  desert: { background: '#c99a64', sky: '#fff1d6', ground: '#8a6238', ambient: 1.3, key: '#ffe2b8', keyIntensity: 2.8, rim: '#ffd29a', floor: '#a97b4a' },
};

/** the Locker's lighting presets, shared with the Armory */
export { LIGHTS as LOCKER_LIGHTS };

const DEG = Math.PI / 180;
const UP = new Vector3(0, 1, 0);
const _v = new Vector3();
const _w = new Vector3();
const _p = new Vector3();
const _q = new Quaternion();

/** A backdrop plate for a preset: a radial vignette over its colour and a soft glow where the floor meets it. */
function backdrop(preset: LightPreset): CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 256;
  const g = c.getContext('2d')!;
  const base = new Color(LIGHTS[preset].background);
  const light = base.clone().lerp(new Color('#ffffff'), 0.08);
  const dark = base.clone().multiplyScalar(0.55);
  const radial = g.createRadialGradient(128, 110, 10, 128, 128, 190);
  radial.addColorStop(0, `#${light.getHexString()}`);
  radial.addColorStop(0.6, `#${base.getHexString()}`);
  radial.addColorStop(1, `#${dark.getHexString()}`);
  g.fillStyle = radial;
  g.fillRect(0, 0, 256, 256);
  const floor = g.createLinearGradient(0, 150, 0, 256);
  floor.addColorStop(0, 'rgba(255,255,255,0)');
  floor.addColorStop(0.35, `#${new Color(LIGHTS[preset].floor).getHexString()}55`);
  floor.addColorStop(1, 'rgba(0,0,0,0.25)');
  g.fillStyle = floor;
  g.fillRect(0, 150, 256, 106);
  const tex = new CanvasTexture(c);
  tex.colorSpace = SRGBColorSpace;
  return tex;
}

/**
 * A soft contact shadow under the feet (after three.js's contact-shadow example): the soldier's depth seen from
 * under the floor into a small target (256² on a phone, 512² on desktop), darker where closer, blurred twice, on a
 * plane at the floor. Redrawn at most every other drawn frame.
 */
class ContactShadow {
  readonly plane: Mesh<PlaneGeometry, MeshBasicMaterial>;
  private readonly target: WebGLRenderTarget;
  private readonly blurTarget: WebGLRenderTarget;
  private readonly camera: OrthographicCamera;
  private readonly depth = new MeshDepthMaterial();
  private readonly blurPlane: Mesh<PlaneGeometry, ShaderMaterial>;
  private readonly h = new ShaderMaterial(HorizontalBlurShader);
  private readonly v = new ShaderMaterial(VerticalBlurShader);
  private frame = 0;

  constructor(size: number, readonly width = 1.6, readonly height = 1.6, depthReach = 0.9) {
    this.target = new WebGLRenderTarget(size, size);
    this.blurTarget = new WebGLRenderTarget(size, size);
    this.target.texture.generateMipmaps = this.blurTarget.texture.generateMipmaps = false;
    this.plane = new Mesh(new PlaneGeometry(width, height).rotateX(Math.PI / 2), new MeshBasicMaterial({ map: this.target.texture, transparent: true, opacity: 0.55, depthWrite: false }));
    this.plane.scale.y = -1; // the target is seen from below
    this.plane.position.y = 0.002;
    this.plane.renderOrder = 1;
    this.camera = new OrthographicCamera(-width / 2, width / 2, height / 2, -height / 2, 0, depthReach);
    this.camera.rotation.x = Math.PI / 2; // up from the floor
    this.depth.depthTest = this.depth.depthWrite = false;
    this.depth.onBeforeCompile = (shader) => {
      // darker where the body is nearer the floor
      shader.fragmentShader = shader.fragmentShader.replace(
        'gl_FragColor = vec4( vec3( 1.0 - fragCoordZ ), opacity );',
        'gl_FragColor = vec4( vec3( 0.0 ), ( 1.0 - fragCoordZ ) * 1.6 );',
      );
    };
    this.blurPlane = new Mesh(new PlaneGeometry(width, height).rotateX(Math.PI / 2), this.h);
    this.blurPlane.visible = false;
  }

  /** Redraws the shadow (every other call); `hide` are things not to cast (the floor, the flame, the outline). */
  update(renderer: WebGLRenderer, scene: Scene, hide: readonly Object3D[]): void {
    if (this.frame++ % 2) return;
    const was = hide.map((o) => o.visible);
    hide.forEach((o) => (o.visible = false));
    this.plane.visible = false;
    const background = scene.background;
    scene.background = null;
    scene.overrideMaterial = this.depth;
    const target = renderer.getRenderTarget();
    const clear = renderer.getClearAlpha();
    renderer.setClearAlpha(0);
    renderer.setRenderTarget(this.target);
    renderer.clear();
    renderer.render(scene, this.camera);
    scene.overrideMaterial = null;
    // two blurs, there and back
    this.blurPlane.visible = true;
    this.blurPlane.material = this.h;
    this.h.uniforms.tDiffuse!.value = this.target.texture;
    this.h.uniforms.h!.value = 1 / 128;
    renderer.setRenderTarget(this.blurTarget);
    renderer.render(this.blurPlane, this.camera);
    this.blurPlane.material = this.v;
    this.v.uniforms.tDiffuse!.value = this.blurTarget.texture;
    this.v.uniforms.v!.value = 1 / 128;
    renderer.setRenderTarget(this.target);
    renderer.render(this.blurPlane, this.camera);
    this.blurPlane.visible = false;
    renderer.setRenderTarget(target);
    renderer.setClearAlpha(clear);
    scene.background = background;
    this.plane.visible = true;
    hide.forEach((o, i) => (o.visible = was[i]!));
  }

  dispose(): void {
    this.target.dispose();
    this.blurTarget.dispose();
    this.depth.dispose();
    this.h.dispose();
    this.v.dispose();
    this.plane.geometry.dispose();
    this.plane.material.dispose();
    this.blurPlane.geometry.dispose();
  }
}

/** The bones the stage poses over the idle (pointer look, equip reactions): put back to the clip's pose each frame. */
const POSED = ['spine1', 'spine2', 'neck', 'head', 'clavicle_L', 'clavicle_R', 'upperarm_L', 'upperarm_R', 'forearm_L', 'forearm_R', 'hand_L', 'hand_R', 'thigh_L', 'thigh_R', 'calf_L', 'calf_R', 'foot_L', 'foot_R'];

export class Turntable {
  private readonly renderer: WebGLRenderer;
  private readonly scene = new Scene();
  private readonly camera = new PerspectiveCamera(28, 1, 0.05, 50);
  private readonly pivot = new Group();
  private readonly hemi = new HemisphereLight();
  private readonly key = new DirectionalLight();
  private readonly rim = new DirectionalLight();
  private readonly floor: Mesh<CylinderGeometry, MeshToonMaterial>;
  private readonly flame: Mesh<ConeGeometry, MeshBasicMaterial>;
  private readonly shadow: ContactShadow;
  /** the same outline as in game (character/outline.ts), so the Locker shows the soldier you'll play */
  private readonly outline = new OutlineMaterial();
  private readonly timer = new Timer();
  private readonly observer: ResizeObserver;
  private character: CharacterInstance | null = null;
  private mixer: AnimationMixer | null = null;
  private posed: { bone: Object3D; anim: Quaternion }[] = [];
  private shot: Shot = SHOTS.full;
  private yaw = 0.35;
  private yawVelocity = 0;
  /** a camera move under way: from, to, how far (s) */
  private move: { from: { y: number; distance: number; yaw: number }; to: Shot; t: number } | null = null;
  private distance: number = SHOTS.full.distance;
  private zoom = 1;
  private targetY: number = SHOTS.full.y;
  private dragX: number | null = null;
  /** the pointers down on the canvas (two: a pinch zooms) */
  private readonly pointers = new Map<number, { x: number; y: number }>();
  private pinch = 0;
  private frame = 0;
  private readonly dpr: number;
  private readonly touch: boolean;
  private reduced: boolean;
  /** drawing: the clock now, when it last drew, and until when it draws whatever (input, moves, reactions) */
  private now = 0;
  private lastDraw = -Infinity;
  private busyUntil = 0;
  /** frames drawn (tests, the stats) */
  drawn = 0;
  /** the pointer over the stage (−1…1), and the head's look toward it (rad) */
  private readonly pointer = { x: 0, y: 0, over: false };
  private readonly look = { yaw: 0, pitch: 0 };
  /** the look last frame, an equip reaction playing, and the slot it frames */
  private lastLook: CosmeticLoadout | null = null;
  private lastHash = 0;
  /** the soldier's geometry last frame: new parts (or a new body) arrive after the look changed, once loaded */
  private lastGeometry: unknown = null;
  private reaction: { kind: Reaction; t: number } | null = null;
  private lightPreset: LightPreset = 'lobby';

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.touch = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
    this.reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.renderer = new WebGLRenderer({ canvas, antialias: true });
    // sharper close-ups: up to 2 on a phone, 3 on desktop
    this.dpr = Math.min(this.touch ? 2 : 3, window.devicePixelRatio || 1);
    this.renderer.setPixelRatio(this.dpr);
    this.key.position.set(1.5, 3, 2.5);
    this.rim.position.set(-2, 2, -2.5);
    this.floor = new Mesh(new CylinderGeometry(0.62, 0.66, 0.06, 48), new MeshToonMaterial({ gradientMap: characterToonRamp() }));
    this.floor.position.y = -0.03;
    // Jet flame preview in the exhaust colour, shown when looking at the jetpack.
    this.flame = new Mesh(new ConeGeometry(0.06, 0.32, 12), new MeshBasicMaterial({ transparent: true, opacity: 0.9, depthWrite: false }));
    this.flame.rotation.x = Math.PI;
    this.flame.position.set(0, 0.4, -0.3);
    this.shadow = new ContactShadow(this.touch ? 256 : 512);
    this.scene.add(this.hemi, this.key, this.rim, this.floor, this.shadow.plane, this.pivot);
    this.setLighting('lobby');
    if (typeof document !== 'undefined') this.timer.connect(document); // pauses with the page hidden

    canvas.addEventListener('pointerdown', this.onPointerDown);
    canvas.addEventListener('pointermove', this.onPointerMove);
    canvas.addEventListener('pointerup', this.onPointerUp);
    canvas.addEventListener('pointercancel', this.onPointerUp);
    canvas.addEventListener('pointerleave', this.onPointerLeave);
    canvas.addEventListener('wheel', this.onWheel, { passive: false });
    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(canvas);
    this.resize();
    this.frame = requestAnimationFrame(this.tick);
  }

  setCharacter(character: CharacterInstance): void {
    if (this.character) {
      this.pivot.remove(this.character.root);
      void this.character.setHero(false);
    }
    this.mixer?.stopAllAction();
    this.character = character;
    character.setOutline(this.outline);
    this.pivot.add(character.root);
    character.root.add(this.flame);
    // the close-up textures, when the body's manifest has them (the Forge's ask)
    void character.setHero(true).then((on) => on && this.wake());
    this.mixer = new AnimationMixer(character.root);
    const idle = character.clips.find((c) => c.name === 'idle');
    if (idle) this.mixer.clipAction(idle).play();
    this.posed = POSED.flatMap((n) => {
      const bone = character.bone(n);
      return bone ? [{ bone, anim: bone.quaternion.clone() }] : [];
    });
    this.lastLook = character.loadout;
    this.lastHash = character.loadoutHash;
    this.wake();
  }

  // --- skins: a gun on a stand in front of the soldier (the Locker's Gun skins tab, docs/17 §3.6) ---
  private gun: { url: string; mesh: Mesh | null } | null = null;
  private readonly gunMaterials = new Map<unknown, MeshToonMaterial>();

  /**
   * Shows the gun GLB at `url` (under the site, e.g. `/assets/weapons/skins/k47_galaxy_relic.glb`) on a stand at the
   * soldier's chest, its right side to the camera, turning with the soldier; null takes it away. Drawn as in a
   * match: the scan's albedo on the toon ramp, a Forged skin's seams and window through its emissive map.
   */
  setGun(url: string | null): void {
    if (this.gun?.url === url) return;
    this.gun?.mesh?.removeFromParent();
    this.gun = url ? { url, mesh: null } : null;
    this.wake();
    if (!url) return;
    const want = this.gun!;
    characterGltfLoader()
      .loadAsync(url)
      .then((gltf) => {
        const ramp = characterToonRamp();
        const model = weaponFromGltf(gltf, {
          plain: new MeshToonMaterial({ color: 0x2d3136, gradientMap: ramp }),
          vertexColors: new MeshToonMaterial({ vertexColors: true, gradientMap: ramp }),
          textured: (map, emissiveMap) => {
            let m = this.gunMaterials.get(map);
            if (!m) {
              m = new MeshToonMaterial({ map, gradientMap: ramp, ...(emissiveMap ? { emissiveMap, emissive: 0xffffff, emissiveIntensity: SKIN_GLOW } : {}) });
              this.gunMaterials.set(map, m);
            }
            return m;
          },
        });
        if (!model || this.gun !== want) return;
        const mesh = new Mesh(model.solid ?? model.geometry, model.material);
        // the weapon frame (+Y muzzle, +Z up) turned so the muzzle points to the soldier's left and its top up,
        // held a little larger than life at chest height, in front of the body
        mesh.rotation.set(-Math.PI / 2, 0, -Math.PI / 2);
        mesh.scale.setScalar(1.35);
        mesh.position.set(0.1, 0.78, 0.42);
        want.mesh = mesh;
        this.pivot.add(mesh);
        this.wake();
      })
      .catch((err: unknown) => console.warn(`locker: ${url} failed to load`, err));
  }
  // --- end skins ---

  setFocus(focus: FocusPreset): void {
    this.zoom = 1;
    this.to(SHOTS[focus]);
  }

  /** Frames a creator look tab (creator/model.ts: hair, head, outfit, gear; anything else, the whole body). */
  frameTab(tab: string): void {
    this.zoom = 1;
    this.to(SHOTS[shotForTab(tab)]);
  }

  /** Frames a slot (a creator item list, or the slot a look change touched). */
  frameSlot(slot: string): void {
    this.zoom = 1;
    this.to(SHOTS[shotForSlot(slot)]);
  }

  /** Reduce motion: the stage rests (draws nothing) a few seconds after the last input. Defaults to the OS setting. */
  setReducedMotion(on: boolean): void {
    this.reduced = on;
    this.wake();
  }

  setLighting(preset: LightPreset): void {
    const l = LIGHTS[preset];
    this.lightPreset = preset;
    (this.scene.background as CanvasTexture | null)?.dispose?.();
    this.scene.background = typeof document !== 'undefined' ? backdrop(preset) : new Color(l.background);
    this.hemi.color.set(l.sky);
    this.hemi.groundColor.set(l.ground);
    this.hemi.intensity = l.ambient;
    this.key.color.set(l.key);
    this.key.intensity = l.keyIntensity;
    this.rim.color.set(l.rim);
    this.rim.intensity = l.keyIntensity * 0.6;
    this.floor.material.color.set(l.floor);
    this.wake();
  }

  get preset(): LightPreset {
    return this.lightPreset;
  }

  dispose(): void {
    cancelAnimationFrame(this.frame);
    this.observer.disconnect();
    this.timer.dispose();
    this.canvas.removeEventListener('pointerdown', this.onPointerDown);
    this.canvas.removeEventListener('pointermove', this.onPointerMove);
    this.canvas.removeEventListener('pointerup', this.onPointerUp);
    this.canvas.removeEventListener('pointercancel', this.onPointerUp);
    this.canvas.removeEventListener('pointerleave', this.onPointerLeave);
    this.canvas.removeEventListener('wheel', this.onWheel);
    this.mixer?.stopAllAction();
    void this.character?.setHero(false);
    this.flame.removeFromParent();
    this.outline.dispose();
    this.shadow.dispose();
    (this.scene.background as CanvasTexture | null)?.dispose?.();
    for (const m of [this.floor, this.flame]) {
      m.geometry.dispose();
      m.material.dispose();
    }
    this.renderer.dispose();
    // dispose() frees GPU resources but keeps the context alive, and browsers cap live contexts
    // (~16): without this, repeated Locker visits make the browser drop the oldest one (the game's).
    this.renderer.forceContextLoss();
  }

  /** Draw for a while whatever (an input, a change). */
  private wake(seconds = 0.6): void {
    this.busyUntil = Math.max(this.busyUntil, this.now + seconds);
  }

  private to(shot: Shot): void {
    // under Reduce motion the camera cuts to the shot
    this.move = { from: { y: this.targetY, distance: this.distance, yaw: this.yaw }, to: shot, t: this.reduced ? SHOT_SECONDS : 0 };
    this.shot = shot;
    this.wake(SHOT_SECONDS + 0.2);
  }

  private resize(): void {
    const w = Math.max(1, this.canvas.clientWidth);
    const h = Math.max(1, this.canvas.clientHeight);
    this.renderer.setSize(w, h, false);
    this.outline.setViewport(w * this.dpr, h * this.dpr);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.wake();
  }

  private readonly tick = (timestamp?: number): void => {
    this.frame = requestAnimationFrame(this.tick);
    this.timer.update(timestamp);
    const dt = Math.min(0.1, Math.max(0, this.timer.getDelta()));
    this.now += dt;
    this.watchLook();
    if (!shouldDraw(this.now, this.lastDraw, this.busyUntil, this.touch, this.reduced, DRAW)) return;
    const step = Math.min(0.1, this.now - (Number.isFinite(this.lastDraw) ? this.lastDraw : this.now - dt));
    this.lastDraw = this.now;
    this.draw(step);
  };

  /** A change of look: frame the slot it touched and play its reaction. */
  private watchLook(): void {
    const c = this.character;
    if (!c) return;
    // the parts land later than the look (a phone on a slow network: seconds), when the stage may be at rest
    const geometry = c.meshes[0]?.geometry ?? null;
    if (geometry !== this.lastGeometry) {
      this.lastGeometry = geometry;
      this.wake();
    }
    if (c.loadoutHash === this.lastHash) return;
    const slots = changedSlots(this.lastLook, c.loadout);
    this.lastLook = c.loadout;
    this.lastHash = c.loadoutHash;
    const slot = slots.find((s) => s !== 'dyes' && s !== 'skinTone') ?? slots[0];
    if (!slot) return;
    if (slot !== 'dyes' && slot !== 'skinTone' && slot !== 'bodyType') this.frameSlot(slot);
    this.reaction = this.reduced ? null : { kind: reactionFor(slot), t: 0 };
    this.wake(this.reaction ? REACTION_SECONDS[this.reaction.kind] + 0.3 : 0.6);
  }

  private draw(dt: number): void {
    // the camera: a shot easing in (450 ms), or as the player turned and zoomed it
    const ease = 1 - Math.exp(-dt * 8);
    if (this.move) {
      this.move.t += dt;
      const k = easeTravel(this.move.t / SHOT_SECONDS);
      const { from, to } = this.move;
      this.targetY = from.y + (to.y - from.y) * k;
      if (to.yaw !== null && this.dragX === null) {
        const d = Math.atan2(Math.sin(to.yaw - from.yaw), Math.cos(to.yaw - from.yaw));
        this.yaw = from.yaw + d * k;
      }
      this.distance = from.distance + (to.distance * this.zoom - from.distance) * k;
      if (this.move.t >= SHOT_SECONDS) this.move = null;
    } else {
      this.distance += (this.shot.distance * this.zoom - this.distance) * ease;
      if (this.dragX === null) {
        this.yaw += this.yawVelocity * dt;
        this.yawVelocity *= Math.exp(-dt * 3);
        if (Math.abs(this.yawVelocity) > 0.01) this.wake(0.1);
      }
    }
    this.pivot.rotation.y = this.yaw;
    this.camera.position.set(0, this.targetY + this.distance * 0.08, this.distance);
    this.camera.lookAt(_v.set(0, this.targetY, 0));
    // the outline thickens as the camera comes closer (2 px at the full shot)
    this.outline.setWidth(2 * this.dpr * Math.min(1.6, Math.max(0.9, Math.sqrt(SHOTS.full.distance / this.distance))));
    const c = this.character;
    if (c) {
      this.flame.visible = this.shot === SHOTS.jetpack || this.shot === SHOTS.back;
      this.flame.material.color.copy(c.exhaustColour);
      this.flame.scale.y = 1 + Math.sin(this.now * 22) * 0.08;
      for (const b of this.posed) b.bone.quaternion.copy(b.anim);
      this.mixer?.update(dt);
      for (const b of this.posed) b.anim.copy(b.bone.quaternion);
      this.pivot.updateMatrixWorld(true);
      this.lookAtPointer(c, dt);
      this.react(c, dt);
      this.shadow.update(this.renderer, this.scene, [this.floor, this.flame, ...(c.outline ? [c.outline] : [])]);
    }
    this.renderer.render(this.scene, this.camera);
    this.drawn++;
  }

  /** The head turns toward the pointer over the stage (±25° across, ±12° up and down), eased; back ahead when it leaves. */
  private lookAtPointer(c: CharacterInstance, dt: number): void {
    const head = c.bone('head');
    if (!head) return;
    const k = 1 - Math.exp(-dt * 6);
    const want = this.pointer.over && this.dragX === null && !this.reduced;
    // the pointer's direction against the soldier's facing: the turntable's yaw turns him away from the camera
    const toward = Math.atan2(Math.sin(this.pointer.x * 0.45 - this.yaw), Math.cos(this.pointer.x * 0.45 - this.yaw));
    // facing away (the back shot): look ahead rather than over the shoulder
    const across = Math.abs(toward) < 90 * DEG ? Math.max(-25 * DEG, Math.min(25 * DEG, toward)) : 0;
    this.look.yaw += ((want ? across : 0) - this.look.yaw) * k;
    this.look.pitch += ((want ? this.pointer.y * 12 * DEG : 0) - this.look.pitch) * k;
    if (Math.abs(this.look.yaw) + Math.abs(this.look.pitch) < 1e-4) return;
    const neck = c.bone('neck');
    _w.set(1, 0, 0).applyQuaternion(c.root.getWorldQuaternion(_q)); // the body's left (pitching about it: + looks down)
    if (neck) rotateWorld(neck, _q.setFromAxisAngle(UP, this.look.yaw * 0.4));
    rotateWorld(head, _q.setFromAxisAngle(UP, this.look.yaw * 0.6));
    rotateWorld(head, _q.setFromAxisAngle(_w, -this.look.pitch));
    if (want) this.wake(0.1);
  }

  /**
   * An equip reaction over the idle (stage.ts reactionFor): an envelope over a pose for the slot that changed, in the
   * body's own axes (shared-v1: +X the soldier's left, +Z forward, +Y up).
   */
  private react(c: CharacterInstance, dt: number): void {
    const r = this.reaction;
    if (!r) return;
    r.t += dt;
    const seconds = REACTION_SECONDS[r.kind];
    if (r.t >= seconds) {
      this.reaction = null;
      return;
    }
    const w = reactionWeight(r.t, seconds);
    const u = r.t / seconds;
    const body = c.root.getWorldQuaternion(new Quaternion());
    const L = new Vector3(1, 0, 0).applyQuaternion(body);
    const F = new Vector3(0, 0, 1).applyQuaternion(body);
    const turn = (name: string, axis: Vector3, angle: number) => {
      const bone = c.bone(name);
      if (bone && angle) rotateWorld(bone, _q.setFromAxisAngle(axis, angle));
    };
    /** a limb swung forward (up, for an arm hanging down) by `angle` */
    const forward = (name: string, angle: number) => turn(name, L, -angle);
    switch (r.kind) {
      case 'helmet': {
        // the right hand up to the side of the helmet, the head tipping into it
        const head = c.bone('head');
        const upper = c.bone('upperarm_R');
        const lower = c.bone('forearm_R');
        const hand = c.bone('hand_R');
        if (head && upper && lower && hand) {
          const from = [upper.quaternion.clone(), lower.quaternion.clone()];
          head.getWorldPosition(_p).addScaledVector(L, -0.13).addScaledVector(UP, 0.12).addScaledVector(F, 0.02);
          const pole = upper.getWorldPosition(new Vector3()).addScaledVector(L, -0.4).addScaledVector(UP, -0.15);
          solveTwoBone(upper, lower, hand, _p, pole);
          upper.quaternion.copy(from[0]!.slerp(upper.quaternion, w));
          lower.quaternion.copy(from[1]!.slerp(lower.quaternion, w));
          upper.updateMatrixWorld(true);
          turn('head', F, 9 * DEG * w);
        }
        break;
      }
      case 'gloves': {
        // forearms up in front, hands turning to look at them
        const flex = w * (0.75 + 0.25 * Math.sin(u * Math.PI * 6));
        forward('upperarm_L', 25 * DEG * w);
        forward('upperarm_R', 25 * DEG * w);
        forward('forearm_L', 70 * DEG * flex);
        forward('forearm_R', 70 * DEG * flex);
        turn('hand_L', UP, 30 * DEG * w * Math.sin(u * Math.PI * 4));
        turn('hand_R', UP, -30 * DEG * w * Math.sin(u * Math.PI * 4));
        turn('head', L, 14 * DEG * w);
        break;
      }
      case 'stamp': {
        // the right foot lifts, then comes down hard
        const lift = u < 0.55 ? Math.sin((Math.PI / 2) * (u / 0.55)) : Math.max(0, 1 - (u - 0.55) / 0.08);
        forward('thigh_R', 38 * DEG * lift * w);
        forward('calf_R', -60 * DEG * lift * w);
        turn('head', L, 12 * DEG * w);
        break;
      }
      case 'shrug': {
        // the shoulders hitch the pack up twice, the chest turning a little
        const up = w * Math.abs(Math.sin(u * Math.PI * 2));
        turn('clavicle_L', F, 14 * DEG * up);
        turn('clavicle_R', F, -14 * DEG * up);
        turn('spine2', UP, 8 * DEG * w * Math.sin(u * Math.PI * 2));
        break;
      }
      case 'sleeve': {
        // the left forearm comes up across, the head looking down along it
        forward('upperarm_L', 40 * DEG * w);
        forward('forearm_L', 65 * DEG * w);
        turn('head', UP, 22 * DEG * w);
        turn('head', L, 20 * DEG * w);
        break;
      }
      case 'legs': {
        // a look down at the trousers
        turn('spine1', L, 10 * DEG * w);
        turn('head', L, 24 * DEG * w);
        break;
      }
      case 'proud': {
        // chest up, shoulders back
        turn('spine2', L, -8 * DEG * w);
        turn('head', L, -6 * DEG * w);
        turn('clavicle_L', UP, 7 * DEG * w);
        turn('clavicle_R', UP, -7 * DEG * w);
        break;
      }
    }
  }

  /** Zoom by `factor` (>1 = farther), within the turntable's range. */
  zoomBy(factor: number): void {
    this.zoom = Math.min(1.6, Math.max(0.55, this.zoom * factor));
    this.wake();
  }

  private pinchSpan(): number {
    const [a, b] = [...this.pointers.values()];
    return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
  }

  private readonly onPointerDown = (e: PointerEvent): void => {
    const p = logicalPoint(e); // the page's axes (an upright phone plays turned: ui/landscape.ts)
    this.pointers.set(e.pointerId, { x: p.x, y: p.y });
    this.canvas.setPointerCapture(e.pointerId);
    this.yawVelocity = 0;
    this.move = null;
    if (this.pointers.size === 2) {
      // two fingers: a pinch zooms, and the turn stops
      this.dragX = null;
      this.pinch = this.pinchSpan();
    } else if (this.pointers.size === 1) this.dragX = p.x;
    this.wake();
  };

  private readonly onPointerMove = (e: PointerEvent): void => {
    const p = logicalPoint(e);
    const rect = this.canvas.getBoundingClientRect?.();
    if (rect && rect.width > 0 && rect.height > 0) {
      this.pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      this.pointer.y = 1 - ((e.clientY - rect.top) / rect.height) * 2;
      this.pointer.over = e.pointerType !== 'touch';
    }
    const at = this.pointers.get(e.pointerId);
    if (!at) {
      if (this.pointer.over) this.wake(0.3);
      return;
    }
    at.x = p.x;
    at.y = p.y;
    this.wake();
    if (this.pointers.size >= 2) {
      const span = this.pinchSpan();
      if (this.pinch > 0 && span > 0) this.zoomBy(this.pinch / span);
      this.pinch = span;
      return;
    }
    if (this.dragX === null) return;
    const dx = p.x - this.dragX;
    this.dragX = p.x;
    this.yaw += dx * 0.01;
    this.yawVelocity = dx * 0.6;
  };

  private readonly onPointerLeave = (): void => {
    this.pointer.over = false;
    this.wake(0.6);
  };

  private readonly onPointerUp = (e: PointerEvent): void => {
    this.pointers.delete(e.pointerId);
    this.pinch = 0;
    // the finger left on the glass carries on turning from where it is
    const rest = [...this.pointers.values()][0];
    this.dragX = rest ? rest.x : null;
    if (this.canvas.hasPointerCapture(e.pointerId)) this.canvas.releasePointerCapture(e.pointerId);
    this.wake(1);
  };

  private readonly onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    this.zoomBy(Math.exp(e.deltaY * 0.0015));
  };
}

export type { ShotName };
