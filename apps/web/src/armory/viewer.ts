/**
 * The Armory's 3D view: one weapon on a turntable (drag to rotate and tilt, wheel to zoom), focus on
 * the whole gun, its muzzle or any socket (weapons/sockets.json), socket gizmos, and a muzzle-flash
 * preview from vfx/weapons.vfx.json. Lighting presets are the Locker's.
 */
import {
  AdditiveBlending,
  Box3,
  BufferGeometry,
  Color,
  CylinderGeometry,
  DirectionalLight,
  DoubleSide,
  Group,
  HemisphereLight,
  Line,
  LineBasicMaterial,
  Matrix4,
  type Material,
  Mesh,
  MeshBasicMaterial,
  type MeshStandardMaterial,
  MeshToonMaterial,
  Object3D,
  PerspectiveCamera,
  PlaneGeometry,
  PointLight,
  Quaternion,
  Scene,
  SphereGeometry,
  SRGBColorSpace,
  Texture,
  TextureLoader,
  Timer,
  Vector3,
  WebGLRenderer,
} from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { characterToonRamp } from '../character';
import { glowMaterial } from './glow';
import { LOCKER_LIGHTS, type LightPreset } from '../locker/turntable';

/** weapons/sockets.json: one socket in the weapon frame (origin at the grip, +Y muzzle, +Z up, +X right) */
export interface Socket {
  pos: [number, number, number];
  dir?: [number, number, number];
  boreRadius?: number;
  lengthM?: number;
  occupied?: string;
}

/** the flash part of vfx/weapons.vfx.json the preview needs */
export interface FlashStyle {
  frames: number[];
  quad: { widthM: number; heightM: number; originU: number };
  ms: number;
  light: { color: string; intensity: number; rangeM: number };
}
export interface FlashSheet {
  atlas: string;
  atlasSize: [number, number];
  cell: [number, number];
  styles: Record<string, FlashStyle>;
}

/** the socket colours of art/screenshots/weapons-sockets.png */
export const SOCKET_COLOURS: Record<string, string> = {
  muzzle: '#ffd91a', grip: '#ffffff', offhand: '#33e64d', eject: '#f259e6', mag: '#33bfff', rail_top: '#ff4d40',
  rail_bottom: '#ff8c33', backblast: '#999999', tip: '#ffd91a', pin: '#f259e6', light: '#ff3333', ground: '#999999',
  pilot: '#ff8019', charge: '#6699ff', face: '#33e6e6',
};

export type Focus = 'whole' | string;

/** stage aspect the whole-weapon framing was tuned at (1920×1080 beside the list and panel) */
const WIDE_ASPECT = 1.35;

/** one entry of attachments/attachments.json */
export interface AttachmentEntry {
  mount: 'rail_top' | 'rail_bottom' | 'muzzle' | 'mag';
  file: string;
  nodes: Record<string, { pos: [number, number, number]; dir?: [number, number, number] }>;
  modelBoreM?: number;
  flashScale?: number;
}

// Weapon frame → view: muzzle (+Y) to screen right (+X), top (+Z) up (+Y), its right side (+X) toward the camera (+Z).
const WEAPON_TO_VIEW = new Matrix4().makeBasis(new Vector3(0, 0, 1), new Vector3(1, 0, 0), new Vector3(0, 1, 0));

export class ArmoryViewer {
  private readonly renderer: WebGLRenderer;
  private readonly scene = new Scene();
  private readonly camera = new PerspectiveCamera(30, 1, 0.01, 30);
  /** turntable: yaw + pitch about the weapon's centre */
  private readonly pivot = new Group();
  /** the weapon in view orientation, recentred on its bounding box */
  private readonly holder = new Group();
  private readonly gizmos = new Group();
  private readonly hemi = new HemisphereLight();
  private readonly key = new DirectionalLight();
  private readonly rim = new DirectionalLight();
  private readonly floor: Mesh<CylinderGeometry, MeshToonMaterial>;
  private readonly loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
  private readonly timer = new Timer();
  private readonly observer: ResizeObserver;
  private weapon: Object3D | null = null;
  /** the loaded weapon's own frame (+Y muzzle, +Z up): attachments mount here */
  private weaponFrame: Object3D | null = null;
  private attachments: Object3D[] = [];
  /** where the flash leaves and how big it is, when a suppressor moves it */
  private flashOverride: { pos: Vector3; scale: number } | null = null;
  private sockets: Record<string, Socket> = {};
  /** the weapon's own materials, to restore after a camo */
  private readonly factory = new Map<Mesh, Material | Material[]>();
  private flash: { mesh: Mesh; light: PointLight; until: number } | null = null;
  private flashTexture: Texture | null = null;
  private size = 1;
  private yaw = 0;
  private pitch = 0.12;
  private yawVelocity = 0;
  private zoom = 1;
  private distance = 2;
  private readonly target = new Vector3();
  private readonly targetGoal = new Vector3();
  /** framing the whole weapon (not a socket): refits and resizes keep it framed */
  private wholeView = true;
  private distanceGoal = 2;
  private drag: { x: number; y: number } | null = null;
  private frame = 0;
  private request = 0;

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.renderer = new WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    this.key.position.set(1.5, 3, 2.5);
    this.rim.position.set(-2, 2, -2.5);
    this.floor = new Mesh(new CylinderGeometry(1, 1.03, 0.03, 48), new MeshToonMaterial({ gradientMap: characterToonRamp() }));
    this.pivot.add(this.holder);
    this.holder.add(this.gizmos);
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

  /** Load and show a weapon; resolves false when a newer request superseded it. */
  async setWeapon(url: string, sockets: Record<string, Socket>): Promise<boolean> {
    const request = ++this.request;
    const gltf = await this.loader.loadAsync(url);
    if (request !== this.request) return false;
    if (this.weapon) this.holder.remove(this.weapon);
    this.clearFlash();
    const w = new Group();
    w.add(gltf.scene);
    this.weaponFrame = gltf.scene;
    gltf.scene.traverse((o) => {
      if (!(o instanceof Mesh) || !o.geometry.getAttribute('_glow')) return;
      const plain = o.material as MeshStandardMaterial;
      o.material = glowMaterial(plain);
      plain.dispose();
    });
    this.factory.clear();
    this.attachments = [];
    this.flashOverride = null;
    w.applyMatrix4(WEAPON_TO_VIEW);
    const box = new Box3().setFromObject(w);
    const centre = box.getCenter(new Vector3());
    this.size = Math.max(0.1, box.getSize(new Vector3()).length());
    this.holder.position.copy(centre).multiplyScalar(-1);
    this.holder.add(w);
    this.weapon = w;
    this.sockets = sockets;
    this.buildGizmos();
    this.floor.scale.setScalar(Math.max(0.08, this.size * 0.45));
    this.floor.position.y = box.min.y - centre.y - 0.03;
    this.setFocus('whole');
    // a new weapon starts framed (no zoom from the previous one's distance)
    this.distance = this.distanceGoal;
    this.target.copy(this.targetGoal);
    return true;
  }

  /**
   * Mount attachments (attachments/attachments.json entries) on the current weapon's sockets,
   * replacing the previous set: rails at their centre (foregrip and laser share the bottom rail
   * at −¼ / +¼), the suppressor on the muzzle scaled to the bore, mags turned onto the mag socket.
   */
  async setAttachments(list: { id: string; url: string; entry: AttachmentEntry }[]): Promise<void> {
    const frame = this.weaponFrame;
    const request = this.request;
    const loaded = await Promise.all(list.map(async (a) => ({ ...a, scene: (await this.loader.loadAsync(a.url)).scene })));
    if (request !== this.request || frame !== this.weaponFrame || !frame) return;
    for (const o of this.attachments) {
      frame.remove(o);
      o.traverse((m) => {
        if (m instanceof Mesh) {
          m.geometry.dispose();
          (Array.isArray(m.material) ? m.material : [m.material]).forEach((x) => x.dispose());
        }
      });
    }
    this.attachments = [];
    this.flashOverride = null;
    const bothBottom = list.filter((a) => a.entry.mount === 'rail_bottom').length > 1;
    for (const a of loaded) {
      const socket = this.sockets[a.entry.mount];
      if (!socket) continue;
      const part = a.scene;
      part.position.set(...socket.pos);
      if (a.entry.mount === 'rail_bottom' && bothBottom) part.position.y += ((a.id === 'laser' ? 1 : -1) * (socket.lengthM ?? 0.08)) / 4;
      if (a.entry.mount === 'muzzle') {
        const k = (socket.boreRadius ?? a.entry.modelBoreM ?? 1) / (a.entry.modelBoreM ?? 1);
        part.scale.setScalar(k);
        const tip = a.entry.nodes.muzzle?.pos ?? [0, 0, 0];
        this.flashOverride = { pos: new Vector3(...tip).multiplyScalar(k).add(new Vector3(...socket.pos)), scale: a.entry.flashScale ?? 1 };
      }
      if (a.entry.mount === 'mag' && socket.dir) {
        part.quaternion.copy(new Quaternion().setFromUnitVectors(new Vector3(0, 0, -1), new Vector3(...socket.dir).normalize()));
      }
      frame.add(part);
      this.attachments.push(part);
    }
    this.refit();
  }

  /** the weapon's bounds in the holder's (unrotated) frame, attachments included */
  private boundsInHolder(): Box3 {
    this.holder.updateWorldMatrix(true, true);
    const toHolder = this.holder.matrixWorld.clone().invert();
    const box = new Box3();
    this.weapon?.traverse((o) => {
      if (!(o instanceof Mesh)) return;
      o.geometry.computeBoundingBox();
      box.union(o.geometry.boundingBox!.clone().applyMatrix4(new Matrix4().multiplyMatrices(toHolder, o.matrixWorld)));
    });
    return box;
  }

  /** keep the floor under everything mounted and the whole view framing it */
  private refit(): void {
    const box = this.boundsInHolder();
    this.size = Math.max(0.1, box.getSize(new Vector3()).length());
    this.floor.position.y = box.min.y + this.holder.position.y - 0.03;
    this.floor.scale.setScalar(Math.max(0.08, this.size * 0.45));
    if (this.wholeView) this.distanceGoal = this.wholeDistance();
  }

  /** camera distance that frames the whole weapon: 1.9× its size on a wide stage, further back on a
   * narrow one (a 0.9 m launcher must still fit a 1280 px window beside the panels) */
  private wholeDistance(): number {
    return Math.max(0.3, this.size * 1.9 * Math.max(1, WIDE_ASPECT / this.camera.aspect));
  }

  /** Repaint the weapon's camo panels (meshes with a `_camo` attribute) with `make`, or restore them (null). */
  setCamo(make: ((original: MeshStandardMaterial) => Material) | null): void {
    this.weaponFrame?.traverse((o) => {
      if (!(o instanceof Mesh) || !o.geometry.getAttribute('_camo')) return;
      if (!this.factory.has(o)) this.factory.set(o, o.material);
      const original = this.factory.get(o) as MeshStandardMaterial;
      if (o.material !== original) (o.material as Material).dispose();
      o.material = make ? make(original) : original;
    });
  }

  /** 'whole' frames the weapon; a socket name zooms to that socket. */
  setFocus(focus: Focus): void {
    this.zoom = 1;
    const whole = this.wholeDistance();
    this.wholeView = focus === 'whole' || !this.sockets[focus];
    if (this.wholeView) {
      // the weapon's centre (the turntable pivot), not its grip: long guns stay centred
      this.targetGoal.copy(this.holder.position).negate();
      this.distanceGoal = whole;
      return;
    }
    this.targetGoal.copy(this.socketView(focus));
    // always closer than the whole view, even for a 9 cm grenade
    this.distanceGoal = Math.min(whole * 0.55, Math.max(0.16, this.size * 0.42));
  }

  setSocketsVisible(visible: boolean): void {
    this.gizmos.visible = visible;
  }

  setLighting(preset: LightPreset): void {
    const l = LOCKER_LIGHTS[preset];
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

  /** Pop a muzzle flash of `style` for its duration (no-op without a muzzle). */
  async fire(sheet: FlashSheet, style: string, atlasUrl: string, scale = 1, holdMs = 0): Promise<void> {
    const st = sheet.styles[style];
    const muzzle = this.sockets.muzzle;
    if (!st || !muzzle) return;
    this.flashTexture ??= await new TextureLoader().loadAsync(atlasUrl).then((t) => {
      t.colorSpace = SRGBColorSpace;
      return t;
    });
    this.clearFlash();
    const [cw, ch] = sheet.cell;
    const [aw, ah] = sheet.atlasSize;
    const cell = st.frames[Math.floor(Math.random() * st.frames.length)]!;
    const cx = (cell % (aw / cw)) * cw;
    const cy = Math.floor(cell / (aw / cw)) * ch;
    scale *= this.flashOverride?.scale ?? 1;
    const w = st.quad.widthM * scale;
    const geo = new PlaneGeometry(w, st.quad.heightM * scale).translate(w * (0.5 - st.quad.originU), 0, 0);
    const uv = geo.attributes.uv!;
    // TextureLoader flips Y: v runs up from the bottom of the atlas
    for (let i = 0; i < uv.count; i++) uv.setXY(i, (cx + uv.getX(i) * cw) / aw, 1 - (cy + (1 - uv.getY(i)) * ch) / ah);
    const mesh = new Mesh(geo, new MeshBasicMaterial({
      map: this.flashTexture, transparent: true, depthWrite: false, blending: AdditiveBlending, side: DoubleSide, toneMapped: false,
    }));
    // two crossed planes along the muzzle axis (view +X): one faces the camera, one is turned 90°
    mesh.position.copy(this.flashOverride ? this.flashOverride.pos.clone().applyMatrix4(WEAPON_TO_VIEW) : this.socketView('muzzle'));
    const cross = new Mesh(geo, mesh.material);
    cross.rotation.x = Math.PI / 2;
    mesh.add(cross);
    const light = new PointLight(new Color(st.light.color), st.light.intensity, st.light.rangeM, 2);
    light.position.copy(mesh.position);
    this.holder.add(mesh, light);
    this.flash = { mesh, light, until: performance.now() + Math.max(80, st.ms * 2, holdMs) };
  }

  dispose(): void {
    cancelAnimationFrame(this.frame);
    this.observer.disconnect();
    this.timer.dispose();
    this.canvas.removeEventListener('pointerdown', this.onPointerDown);
    this.canvas.removeEventListener('pointermove', this.onPointerMove);
    this.canvas.removeEventListener('pointerup', this.onPointerUp);
    this.canvas.removeEventListener('pointercancel', this.onPointerUp);
    this.canvas.removeEventListener('wheel', this.onWheel);
    this.clearFlash();
    this.flashTexture?.dispose();
    this.scene.traverse((o) => {
      if (o instanceof Mesh || o instanceof Line) {
        o.geometry.dispose();
        (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => m.dispose());
      }
    });
    this.renderer.dispose();
    // like the Locker: free the context now, or repeated visits evict the game's
    this.renderer.forceContextLoss();
  }

  /** a socket's position in the holder (view) frame */
  private socketView(name: string): Vector3 {
    const s = this.sockets[name]!;
    return new Vector3(...s.pos).applyMatrix4(WEAPON_TO_VIEW);
  }

  private buildGizmos(): void {
    for (const c of [...this.gizmos.children]) {
      this.gizmos.remove(c);
      if (c instanceof Mesh || c instanceof Line) {
        c.geometry.dispose();
        (c.material as MeshBasicMaterial).dispose();
      }
    }
    const r = Math.max(0.006, this.size * 0.012);
    for (const [name, s] of Object.entries(this.sockets)) {
      const colour = new Color(SOCKET_COLOURS[name] ?? '#ffffff');
      const at = this.socketView(name);
      const ball = new Mesh(new SphereGeometry(r, 12, 8), new MeshBasicMaterial({ color: colour, depthTest: false }));
      ball.position.copy(at);
      ball.renderOrder = 10;
      this.gizmos.add(ball);
      if (!s.dir) continue;
      const dir = new Vector3(...s.dir).applyMatrix4(WEAPON_TO_VIEW).normalize();
      const along = new Vector3(1, 0, 0); // the muzzle axis in view
      const pts = name.startsWith('rail')
        ? [at.clone().addScaledVector(along, -(s.lengthM ?? 0.05) / 2), at.clone().addScaledVector(along, (s.lengthM ?? 0.05) / 2)]
        : [at, at.clone().addScaledVector(dir, Math.max(0.04, this.size * 0.06))];
      const line = new Line(new BufferGeometry().setFromPoints(pts), new LineBasicMaterial({ color: colour, depthTest: false }));
      line.renderOrder = 10;
      this.gizmos.add(line);
    }
  }

  private clearFlash(): void {
    if (!this.flash) return;
    this.holder.remove(this.flash.mesh, this.flash.light);
    this.flash.mesh.geometry.dispose();
    (this.flash.mesh.material as MeshBasicMaterial).dispose();
    this.flash = null;
  }

  private resize(): void {
    const w = Math.max(1, this.canvas.clientWidth);
    const h = Math.max(1, this.canvas.clientHeight);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    if (this.wholeView) this.distanceGoal = this.wholeDistance();
  }

  private readonly tick = (): void => {
    this.frame = requestAnimationFrame(this.tick);
    this.timer.update();
    const dt = Math.min(0.1, this.timer.getDelta());
    const ease = 1 - Math.exp(-dt * 8);
    if (!this.drag) {
      this.yaw += this.yawVelocity * dt;
      this.yawVelocity *= Math.exp(-dt * 3);
    }
    this.pivot.rotation.set(this.pitch, this.yaw, 0, 'YXZ');
    this.target.lerp(this.targetGoal, ease);
    this.distance += (this.distanceGoal * this.zoom - this.distance) * ease;
    // the focus point follows the turntable
    const focus = this.target.clone().add(this.holder.position).applyEuler(this.pivot.rotation);
    this.camera.position.set(focus.x, focus.y + this.distance * 0.12, focus.z + this.distance);
    this.camera.lookAt(focus);
    // socket balls keep about the same size on screen when zooming in on a socket
    const k = Math.min(1, Math.max(0.2, this.distance / this.wholeDistance()));
    for (const g of this.gizmos.children) if (g instanceof Mesh) g.scale.setScalar(k);
    if (this.flash && performance.now() > this.flash.until) this.clearFlash();
    this.renderer.render(this.scene, this.camera);
  };

  private readonly onPointerDown = (e: PointerEvent): void => {
    this.drag = { x: e.clientX, y: e.clientY };
    this.yawVelocity = 0;
    this.canvas.setPointerCapture(e.pointerId);
  };

  private readonly onPointerMove = (e: PointerEvent): void => {
    if (!this.drag) return;
    const dx = e.clientX - this.drag.x;
    const dy = e.clientY - this.drag.y;
    this.drag = { x: e.clientX, y: e.clientY };
    this.yaw += dx * 0.01;
    this.pitch = Math.min(0.6, Math.max(-0.6, this.pitch + dy * 0.006));
    this.yawVelocity = dx * 0.6;
  };

  private readonly onPointerUp = (e: PointerEvent): void => {
    this.drag = null;
    if (this.canvas.hasPointerCapture(e.pointerId)) this.canvas.releasePointerCapture(e.pointerId);
  };

  private readonly onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    this.zoom = Math.min(2.2, Math.max(0.35, this.zoom * Math.exp(e.deltaY * 0.0015)));
  };
}
