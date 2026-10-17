/**
 * Three.js renderer behind the `Frame` view model (docs/06 §4 layer L3, docs/11). It draws the
 * gameplay plane, depth layers, players, grenades and effects (vfx/); the 2D canvas renderer stays
 * on top as the HUD and the toggleable debug overlay (RenderOptions.overlay). Sim events reach the
 * effects through `onEvents` (main.ts forwards the 2D renderer's events here).
 */
import type { MapDef } from '@military-forge/content';
import { CollisionWorld, type SimEvent } from '@military-forge/sim';
import {
  DirectionalLight,
  Fog,
  HemisphereLight,
  Mesh,
  MeshToonMaterial,
  PerspectiveCamera,
  Scene,
  Vector2,
  Vector3,
  WebGLRenderer,
} from 'three';
import type { Frame } from '../view';
import { Avatar, AvatarKit } from './avatar';
import { RookieAssembler, toonRamp, type CharacterAssembler, type CharacterLod } from './character';
import { buildDepthLayers, updateForeground, type DepthLayers } from './layers';
import { lightingFor } from './lighting';
import { buildMapGeometry } from './mapGeometry';
import { FOV_DEG, PlaneCamera, applyPlanePose, planePose } from './planeCamera';
import { DynamicResolution, PRESETS, SampleWindow, parsePreset, type GraphicsPreset, type PresetName } from './presets';
import { Vfx } from './vfx';

export { PlaneCamera, parsePreset, type PresetName };

export interface RenderStats {
  preset: PresetName;
  /** drawing-buffer size in device pixels */
  width: number;
  height: number;
  pixelRatio: number;
  scale: number;
  /** frame interval percentiles over the last 240 frames, ms */
  frameP50: number;
  frameP90: number;
  frameP99: number;
  /** main-thread time inside render(): animation, IK, culling and WebGL submission, ms */
  cpuMean: number;
  cpuP90: number;
  calls: number;
  triangles: number;
  avatars: number;
  /** live VFX particles (docs/11 §3: ≤ 1.5K Low, ≤ 5K High) */
  particles: number;
}

export class Renderer3D {
  readonly renderer: WebGLRenderer;
  readonly scene = new Scene();
  readonly camera3 = new PerspectiveCamera(FOV_DEG, 1, 1, 200);
  /** set once the map, the base character and the shader warm-up are done */
  ready = false;
  private preset: GraphicsPreset;
  private readonly dynres: DynamicResolution;
  private readonly frameMs = new SampleWindow(240);
  private readonly cpuMs = new SampleWindow(240);
  private readonly pose = planePose(new PlaneCamera());
  private readonly world: CollisionWorld;
  private readonly layers: DepthLayers;
  private readonly kit: AvatarKit;
  private readonly sun: DirectionalLight;
  private readonly hemi: HemisphereLight;
  private readonly sunDir = new Vector3();
  /** grenades, explosions, the blast light and camera shake */
  readonly vfx: Vfx;
  private readonly assembler: CharacterAssembler;
  private readonly avatars = new Map<number, Avatar>();
  private readonly pending = new Set<number>();
  /** after a failed character load, wait this long before trying again (doubles, ≤ 30 s) */
  private retryMs = 1000;
  private readonly seen = new Set<number>();
  private readonly statsEl: HTMLElement | null = null;
  private lastFrameAt = 0;
  private frames = 0;

  /** WebGL2 is the baseline (docs/11 §1); without it the page keeps the 2D renderer. */
  static supported(): boolean {
    try {
      return !!document.createElement('canvas').getContext('webgl2');
    } catch {
      return false;
    }
  }

  constructor(
    canvas: HTMLCanvasElement,
    private readonly camera: PlaneCamera,
    map: MapDef,
    preset: GraphicsPreset,
    /** show the frame-time panel (dev builds, or ?perf) */
    showStats = false,
    assembler?: CharacterAssembler,
  ) {
    if (showStats) {
      this.statsEl = document.body.appendChild(document.createElement('pre'));
      this.statsEl.id = 'perf3d';
    }
    this.preset = preset;
    this.dynres = new DynamicResolution(preset.minScale);
    this.renderer = new WebGLRenderer({ canvas, antialias: preset.antialias, powerPreference: 'high-performance' });
    this.renderer.shadowMap.enabled = true; // only the High preset's sun casts (setPreset)
    const ramp = toonRamp();
    this.assembler = assembler ?? new RookieAssembler(import.meta.env.BASE_URL, ramp);
    this.kit = new AvatarKit(ramp);
    this.world = new CollisionWorld(map);

    const light = lightingFor(map.id);
    this.scene.background = null; // the sky card covers the view
    this.scene.fog = new Fog(light.fog.color, light.fog.near, light.fog.far);
    this.hemi = new HemisphereLight(light.hemi.sky, light.hemi.ground, light.hemi.intensity);
    this.scene.add(this.hemi);
    this.sun = new DirectionalLight(light.sun.color, light.sun.intensity);
    this.sun.shadow.mapSize.set(1024, 1024); // docs/11 §2: one 1024² map over the gameplay plane
    this.sun.shadow.bias = -0.0005;
    this.scene.add(this.sun, this.sun.target);
    this.sunDir.fromArray(light.sun.dir).normalize();

    const plane = new Mesh(buildMapGeometry(map, light), new MeshToonMaterial({ vertexColors: true, gradientMap: ramp }));
    plane.name = 'gameplay-plane';
    plane.receiveShadow = plane.castShadow = true;
    this.layers = buildDepthLayers(map, light);
    this.scene.add(plane, this.layers.background, this.layers.foregroundGroup);
    this.vfx = new Vfx(this.scene, this.world, camera, { hemi: this.hemi, sun: this.sun }, ramp, preset);
    // reduced motion (docs/11 §5): the OS setting until the settings screen calls setReducedMotion
    this.setReducedMotion(typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches);
    this.setPreset(preset.name);
  }

  /** Sim events (shots, explosions) for the effects. An arrow function: main.ts hands it to the 2D renderer. */
  readonly onEvents = (events: readonly SimEvent[]): void => {
    if (this.ready) this.vfx.onEvents(events);
  };

  /** No camera shake, a third of the blast light, fuse lights blinking ≤ 3 times a second. */
  setReducedMotion(on: boolean): void {
    this.vfx.setReducedMotion(on);
  }

  /** Loads the base character and effect assets, then compiles every material variant (docs/11 §3 shader warm-up). */
  async load(spawn: { x: number; y: number }): Promise<void> {
    await this.vfx.load(import.meta.env.BASE_URL);
    try {
      await this.warmUp(spawn);
    } catch (err) {
      console.error('render3d: warm-up failed, characters may pop in', err);
    }
    this.ready = true;
  }

  private async warmUp(spawn: { x: number; y: number }): Promise<void> {
    const lods: CharacterLod[] = [0, 1];
    const warm = await Promise.all(lods.map((lod, i) => this.assembler.create(null, lod).then((inst) => new Avatar(inst, lod, this.kit, i))));
    for (const a of warm) {
      a.pivot.position.set(spawn.x, spawn.y, 0);
      a.showAllForWarmUp();
      this.scene.add(a.pivot, a.blob);
    }
    // a scratch camera at the spawn: the game camera (follow, mouse aim) is read-only here
    const cam = new PlaneCamera();
    cam.resize(this.camera.width, this.camera.height);
    cam.x = spawn.x;
    cam.y = spawn.y;
    applyPlanePose(this.camera3, planePose(cam, FOV_DEG, undefined, this.pose));
    await this.renderer.compileAsync(this.scene, this.camera3);
    // keep the warm-up blob materials: disposing them would release the blob shader program (no
    // other material uses it yet) and the first real avatar would link it again mid-game
    for (const a of warm) a.dispose({ keepBlobMaterial: true });
  }

  setPreset(name: PresetName): void {
    const lodChanged = PRESETS[name].remoteLod1 !== this.preset.remoteLod1;
    this.preset = PRESETS[name];
    this.dynres.minScale = this.preset.minScale;
    this.dynres.scale = Math.max(this.dynres.scale, this.preset.minScale);
    this.sun.castShadow = this.preset.shadows === 'map';
    this.vfx.setPreset(this.preset);
    if (lodChanged) {
      for (const a of this.avatars.values()) a.dispose();
      this.avatars.clear();
    }
    this.resize();
  }

  /** Pins the render scale (null = dynamic again): repeatable screenshots and measurements. */
  pinScale(scale: number | null): void {
    this.dynres.pinned = scale;
    if (scale !== null) this.dynres.scale = scale;
    this.resize();
  }

  get presetName(): PresetName {
    return this.preset.name;
  }

  resize(): void {
    const canvas = this.renderer.domElement;
    const dpr = Math.min(window.devicePixelRatio || 1, this.preset.dprCap) * this.dynres.scale;
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(canvas.clientWidth, canvas.clientHeight, false);
  }

  render(frame: Frame, dt: number): void {
    if (!this.ready) return; // loading frames would skew the meter and dynamic resolution
    if (document.hidden) {
      // main.ts's watchdog still ticks (≈1 Hz) while rAF is paused: draw nothing, measure nothing
      this.lastFrameAt = 0;
      this.dynres.reset();
      return;
    }
    const now = performance.now();
    if (this.lastFrameAt) {
      const ms = now - this.lastFrameAt;
      this.frameMs.push(ms);
      if (this.dynres.sample(ms)) this.resize();
    }
    this.lastFrameAt = now;

    // effects first: their camera shake moves the 3D camera only (never the 2D Camera: aim, AOI, HUD)
    const shake = this.vfx.update(frame, dt);
    const pose = planePose(this.camera, FOV_DEG, undefined, this.pose);
    pose.x += shake.x;
    pose.y += shake.y;
    applyPlanePose(this.camera3, pose);
    // a screen taller than 4:3 is letterboxed: draw into the band only (the 2D overlay paints the bars)
    const { top, bottom } = this.camera.band;
    this.renderer.setViewport(0, top, this.camera.width, bottom - top);
    this.renderer.setScissor(0, top, this.camera.width, bottom - top);
    this.renderer.setScissorTest(top > 0);
    if (this.sun.castShadow) {
      // the High shadow map covers the visible gameplay plane only (docs/11 §2)
      const extents = this.camera.halfExtents;
      const cam = this.sun.shadow.camera;
      const r = Math.max(extents.halfW, extents.halfH) + 2;
      Object.assign(cam, { left: -r, right: r, top: r, bottom: -r, near: 1, far: 120 });
      cam.updateProjectionMatrix();
      this.sun.target.position.set(this.camera.x, this.camera.y, 0);
      this.sun.position.copy(this.sun.target.position).addScaledVector(this.sunDir, 50);
    } else {
      this.sun.position.copy(this.sunDir);
      this.sun.target.position.set(0, 0, 0);
    }

    this.syncAvatars(frame, dt);
    updateForeground(this.layers.foreground, frame.players, this.pose, dt);
    this.renderer.render(this.scene, this.camera3);
    this.cpuMs.push(performance.now() - now);
    if (this.statsEl && this.frames++ % 30 === 0) this.statsEl.textContent = formatStats(this.stats());
  }

  private syncAvatars(frame: Frame, dt: number): void {
    const blob = this.preset.shadows === 'blob';
    this.seen.clear();
    for (const p of frame.players) {
      this.seen.add(p.id);
      const avatar = this.avatars.get(p.id);
      if (avatar) {
        avatar.update(p, dt, this.world, blob);
        continue;
      }
      if (this.pending.has(p.id)) continue;
      // characters stream in without blocking the frame (docs/04 §5.2)
      const lod: CharacterLod = !p.isLocal && this.preset.remoteLod1 ? 1 : 0;
      this.pending.add(p.id);
      this.assembler.create(null, lod).then(
        (inst) => {
          this.pending.delete(p.id);
          this.retryMs = 1000;
          const a = new Avatar(inst, lod, this.kit, p.id);
          a.pivot.traverse((o) => (o.castShadow = true));
          this.avatars.set(p.id, a);
          this.scene.add(a.pivot, a.blob);
        },
        // retried with backoff (the assembler doesn't cache a failed load); the 2D overlay (H) shows the player meanwhile
        (err: unknown) => {
          console.error(`render3d: no character for player ${p.id}, retrying in ${this.retryMs} ms`, err);
          setTimeout(() => this.pending.delete(p.id), this.retryMs);
          this.retryMs = Math.min(30_000, this.retryMs * 2);
        },
      );
    }
    for (const [id, a] of this.avatars) {
      if (this.seen.has(id)) continue;
      a.dispose();
      this.avatars.delete(id);
    }
  }

  stats(): RenderStats {
    const info = this.renderer.info.render;
    const size = this.renderer.getDrawingBufferSize(new Vector2());
    return {
      preset: this.preset.name,
      width: size.x,
      height: size.y,
      pixelRatio: this.renderer.getPixelRatio(),
      scale: this.dynres.scale,
      frameP50: this.frameMs.percentile(0.5),
      frameP90: this.frameMs.percentile(0.9),
      frameP99: this.frameMs.percentile(0.99),
      cpuMean: this.cpuMs.mean(),
      cpuP90: this.cpuMs.percentile(0.9),
      calls: info.calls,
      triangles: info.triangles,
      avatars: this.avatars.size,
      particles: this.vfx.particles,
    };
  }
}

export function formatStats(s: RenderStats): string {
  const f = (v: number) => (Number.isFinite(v) ? v.toFixed(1) : '–');
  return (
    `3D ${s.preset} · ${s.width}×${s.height} (dpr ${s.pixelRatio.toFixed(2)}, scale ${s.scale.toFixed(2)})\n` +
    `frame p50 ${f(s.frameP50)} · p90 ${f(s.frameP90)} · p99 ${f(s.frameP99)} ms · render cpu ${f(s.cpuMean)} ms (p90 ${f(s.cpuP90)})\n` +
    `${s.calls} draw calls · ${(s.triangles / 1000).toFixed(1)}k tris · ${s.avatars} characters · ${s.particles} particles`
  );
}
