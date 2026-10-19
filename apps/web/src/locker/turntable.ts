/**
 * The Locker's 3D preview (docs/04 §6): the soldier on a turntable with drag-to-rotate, wheel
 * zoom, focus presets (full body, face, jetpack) and lighting presets matching the maps.
 */
import {
  AnimationMixer,
  Clock,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DirectionalLight,
  Group,
  HemisphereLight,
  Mesh,
  MeshBasicMaterial,
  MeshToonMaterial,
  PerspectiveCamera,
  Scene,
  Vector3,
  WebGLRenderer,
} from 'three';
import { OutlineMaterial, characterToonRamp, type CharacterInstance } from '../character';
import { logicalPoint } from '../ui/landscape';

export type FocusPreset = 'full' | 'face' | 'jetpack';
export type LightPreset = 'lobby' | 'night' | 'desert';

const FOCUS: Record<FocusPreset, { y: number; distance: number; yaw: number | null }> = {
  full: { y: 0.8, distance: 3.6, yaw: null },
  face: { y: 1.18, distance: 1.8, yaw: 0.25 },
  jetpack: { y: 0.8, distance: 2.6, yaw: Math.PI * 0.85 },
};

const LIGHTS: Record<LightPreset, { background: string; sky: string; ground: string; ambient: number; key: string; keyIntensity: number; rim: string; floor: string }> = {
  lobby: { background: '#1a2130', sky: '#dfe8ff', ground: '#3a3530', ambient: 1.1, key: '#ffffff', keyIntensity: 2.2, rim: '#7fb8ff', floor: '#2a3344' },
  night: { background: '#080c18', sky: '#5466a0', ground: '#10121a', ambient: 0.7, key: '#a9bcff', keyIntensity: 1.3, rim: '#3fd0c0', floor: '#161c2c' },
  desert: { background: '#c99a64', sky: '#fff1d6', ground: '#8a6238', ambient: 1.3, key: '#ffe2b8', keyIntensity: 2.8, rim: '#ffd29a', floor: '#a97b4a' },
};

/** the Locker's lighting presets, shared with the Armory */
export { LIGHTS as LOCKER_LIGHTS };

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
  /** the same outline as in game (character/outline.ts), so the Locker shows the soldier you'll play */
  private readonly outline = new OutlineMaterial();
  private readonly clock = new Clock();
  private readonly observer: ResizeObserver;
  private character: CharacterInstance | null = null;
  private mixer: AnimationMixer | null = null;
  private focus: FocusPreset = 'full';
  private yaw = 0.35;
  private yawVelocity = 0;
  /** eased towards by focus presets; dragging cancels it */
  private yawTarget: number | null = null;
  private distance = FOCUS.full.distance;
  private zoom = 1;
  private targetY = FOCUS.full.y;
  private dragX: number | null = null;
  private frame = 0;

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.renderer = new WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    this.key.position.set(1.5, 3, 2.5);
    this.rim.position.set(-2, 2, -2.5);
    this.floor = new Mesh(new CylinderGeometry(0.62, 0.66, 0.06, 48), new MeshToonMaterial({ gradientMap: characterToonRamp() }));
    this.floor.position.y = -0.03;
    // Jet flame preview in the exhaust colour, shown when looking at the jetpack.
    this.flame = new Mesh(new ConeGeometry(0.06, 0.32, 12), new MeshBasicMaterial({ transparent: true, opacity: 0.9, depthWrite: false }));
    this.flame.rotation.x = Math.PI;
    this.flame.position.set(0, 0.4, -0.3);
    this.scene.add(this.hemi, this.key, this.rim, this.floor, this.pivot);
    this.setLighting('lobby');

    canvas.addEventListener('pointerdown', this.onPointerDown);
    canvas.addEventListener('pointermove', this.onPointerMove);
    canvas.addEventListener('pointerup', this.onPointerUp);
    canvas.addEventListener('pointercancel', this.onPointerUp);
    canvas.addEventListener('wheel', this.onWheel, { passive: false });
    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(canvas);
    this.resize();
    this.frame = requestAnimationFrame(this.tick);
  }

  setCharacter(character: CharacterInstance): void {
    if (this.character) this.pivot.remove(this.character.root);
    this.mixer?.stopAllAction();
    this.character = character;
    character.setOutline(this.outline);
    this.pivot.add(character.root);
    character.root.add(this.flame);
    this.mixer = new AnimationMixer(character.root);
    const idle = character.clips.find((c) => c.name === 'idle');
    if (idle) this.mixer.clipAction(idle).play();
  }

  setFocus(focus: FocusPreset): void {
    this.focus = focus;
    this.zoom = 1;
    this.yawTarget = FOCUS[focus].yaw;
  }

  setLighting(preset: LightPreset): void {
    const l = LIGHTS[preset];
    this.scene.background = new Color(l.background);
    this.hemi.color.set(l.sky);
    this.hemi.groundColor.set(l.ground);
    this.hemi.intensity = l.ambient;
    this.key.color.set(l.key);
    this.key.intensity = l.keyIntensity;
    this.rim.color.set(l.rim);
    this.rim.intensity = l.keyIntensity * 0.6;
    this.floor.material.color.set(l.floor);
  }

  dispose(): void {
    cancelAnimationFrame(this.frame);
    this.observer.disconnect();
    this.canvas.removeEventListener('pointerdown', this.onPointerDown);
    this.canvas.removeEventListener('pointermove', this.onPointerMove);
    this.canvas.removeEventListener('pointerup', this.onPointerUp);
    this.canvas.removeEventListener('pointercancel', this.onPointerUp);
    this.canvas.removeEventListener('wheel', this.onWheel);
    this.mixer?.stopAllAction();
    this.flame.removeFromParent();
    this.outline.dispose();
    for (const m of [this.floor, this.flame]) {
      m.geometry.dispose();
      m.material.dispose();
    }
    this.renderer.dispose();
    // dispose() frees GPU resources but keeps the context alive, and browsers cap live contexts
    // (~16): without this, repeated Locker visits make the browser drop the oldest one (the game's).
    this.renderer.forceContextLoss();
  }

  private resize(): void {
    const w = Math.max(1, this.canvas.clientWidth);
    const h = Math.max(1, this.canvas.clientHeight);
    this.renderer.setSize(w, h, false);
    const dpr = Math.min(2, window.devicePixelRatio || 1); // the pixel ratio set in the constructor
    this.outline.setViewport(w * dpr, h * dpr);
    this.outline.setWidth(2 * dpr);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  private readonly tick = (): void => {
    this.frame = requestAnimationFrame(this.tick);
    const dt = Math.min(0.1, this.clock.getDelta());
    const f = FOCUS[this.focus];
    const ease = 1 - Math.exp(-dt * 8);
    if (this.dragX === null && this.yawTarget !== null) {
      const d = Math.atan2(Math.sin(this.yawTarget - this.yaw), Math.cos(this.yawTarget - this.yaw));
      this.yaw += d * ease;
      if (Math.abs(d) < 1e-3) this.yawTarget = null;
    } else if (this.dragX === null) {
      this.yaw += this.yawVelocity * dt;
      this.yawVelocity *= Math.exp(-dt * 3);
    }
    this.distance += (f.distance * this.zoom - this.distance) * ease;
    this.targetY += (f.y - this.targetY) * ease;
    this.pivot.rotation.y = this.yaw;
    this.camera.position.set(0, this.targetY + this.distance * 0.08, this.distance);
    this.camera.lookAt(new Vector3(0, this.targetY, 0));
    if (this.character) {
      this.flame.visible = this.focus === 'jetpack';
      this.flame.material.color.copy(this.character.exhaustColour);
      this.flame.scale.y = 1 + Math.sin(performance.now() / 45) * 0.08;
    }
    this.mixer?.update(dt);
    this.renderer.render(this.scene, this.camera);
  };

  private readonly onPointerDown = (e: PointerEvent): void => {
    this.dragX = logicalPoint(e).x; // the page's axes (an upright phone plays turned: ui/landscape.ts)
    this.yawVelocity = 0;
    this.yawTarget = null;
    this.canvas.setPointerCapture(e.pointerId);
  };

  private readonly onPointerMove = (e: PointerEvent): void => {
    if (this.dragX === null) return;
    const x = logicalPoint(e).x;
    const dx = x - this.dragX;
    this.dragX = x;
    this.yaw += dx * 0.01;
    this.yawVelocity = dx * 0.6;
  };

  private readonly onPointerUp = (e: PointerEvent): void => {
    this.dragX = null;
    if (this.canvas.hasPointerCapture(e.pointerId)) this.canvas.releasePointerCapture(e.pointerId);
  };

  private readonly onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    this.zoom = Math.min(1.6, Math.max(0.55, this.zoom * Math.exp(e.deltaY * 0.0015)));
  };
}
