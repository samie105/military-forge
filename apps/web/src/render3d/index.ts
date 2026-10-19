/**
 * Three.js renderer behind the `Frame` view model (docs/06 §4 layer L3, docs/11). It draws the
 * gameplay plane, depth layers, players, grenades and effects (vfx/); the 2D canvas renderer stays
 * on top as the HUD and the toggleable debug overlay (RenderOptions.overlay). Sim events reach the
 * effects through `onEvents` (main.ts forwards the 2D renderer's events here).
 */
import type { MapDef } from '@military-forge/content';
import { CollisionWorld, DamageSource, type SimEvent } from '@military-forge/sim';
import {
  BufferGeometry,
  DirectionalLight,
  Fog,
  Group,
  HemisphereLight,
  Material,
  Mesh,
  NearestFilter,
  MeshToonMaterial,
  Object3D,
  PerspectiveCamera,
  Scene,
  Texture,
  Vector2,
  Vector3,
  WebGLRenderer,
} from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import type { Frame } from '../view';
import { Avatar, AvatarKit } from './avatar';
import { HIT, hitReactions } from './motion';
import { CharacterAssembler, OutlineMaterial, characterToonRamp, type CharacterInstance, type CharacterLod } from '../character';
import { LoadoutDirectory } from './character';
import { CloudLayer } from './clouds';
import { KIT_WAIT_MS, MapEnvironment, createKtx2, environmentFor, ktx2Gate, withTimeout, type Ktx2Source } from './environment';
import { buildDepthLayers, updateForeground, type DepthLayers } from './layers';
import { lightingFor, type LightingPreset } from './lighting';
import { buildMapGeometry } from './mapGeometry';
import { OnlineView, type RemoteView } from './online';
import { FOV_DEG, PlaneCamera, applyPlanePose, planePose } from './planeCamera';
import { ZoneVolumes } from './zones';
import { DynamicResolution, PRESETS, SampleWindow, TierGovernor, parsePreset, type GraphicsPreset, type PresetName } from './presets';
import { eachKick, recoilOf } from './recoil';
import { PickupMeshes, RicochetSparks } from './shield';
import { WeaponItems } from './weaponItems';
import { Vfx } from './vfx';
import { isTouchDevice } from '../touch';
import type { EjectLookup } from './vfx/casings';
import type { SwingLookup } from './vfx/melee';
import type { GunPointLookup } from './vfx/projectiles';
import type { BodyLookup } from './vfx/dash';
import type { MuzzleLookup } from './vfx/gunfire';

export { PlaneCamera, parsePreset, type PresetName, type RemoteView };


/**
 * Software WebGL is accepted for automated browsers (headless tests and screenshot scripts, which
 * run on SwiftShader) and with `?softgl`; a player on a software rasteriser gets the 2D view.
 */
export function softwareGl(params: URLSearchParams): boolean {
  return params.has('softgl') || (typeof navigator !== 'undefined' && navigator.webdriver === true);
}

/**
 * Whether play renders in 3D, online included (the owner's default, 18 Oct): yes, unless
 * `?render=2d`, or WebGL 2 can't start on a real GPU (softwareGl).
 */
export function online3d(params: URLSearchParams): boolean {
  return params.get('render') !== '2d' && Renderer3D.supported(softwareGl(params));
}

/**
 * The render pixel ratio: the device's, capped by the preset (its touchDprCap on a phone or tablet)
 * and by an override, the lower cap winning; then the dynamic scale.
 */
export function pixelRatio(device: number, presetCap: number, override: number | null, scale: number): number {
  return Math.min(device, presetCap, override ?? Infinity) * scale;
}

/**
 * The 3D view, or null when WebGL fails to start after all (main.ts then draws in 2D). Same
 * arguments as the constructor; pass `softwareGl(params)` for `allowSoftware`.
 */
export function create3d(...args: ConstructorParameters<typeof Renderer3D>): Renderer3D | null {
  try {
    return new Renderer3D(...args);
  } catch (err) {
    console.warn('render3d: WebGL did not start; drawing in 2D', err);
    return null;
  }
}

/** The part of the 2D renderer the 3D view hooks into (its event forwarding). */
export interface EventSource2D {
  forwardEvents: ((events: readonly SimEvent[], localId: number) => void) | null;
}

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
  /** Auto quality is adapting (the tier it started on, its ceiling), or null for a fixed preset */
  auto: PresetName | null;
  /** drawn at the touch caps (a phone or tablet) */
  touch: boolean;
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
  /** overrides the preset's DPR cap (phones: sharp text on a small, dense screen; dynamic resolution still scales down) */
  private dprCapOverride: number | null = null;
  private readonly dynres: DynamicResolution;
  private readonly frameMs = new SampleWindow(240);
  private readonly cpuMs = new SampleWindow(240);
  private readonly pose = planePose(new PlaneCamera());
  /** the map on screen (setMap swaps it: online play follows the server's map) */
  private map: MapDef;
  private world: CollisionWorld;
  private plane: Mesh<BufferGeometry, MeshToonMaterial>;
  private layers: DepthLayers;
  /** map zones (docs/02 §20): tinted volumes and particles */
  private zones: ZoneVolumes;
  /** the map's kit, lighting look and dressing, for maps that have one (environment/) */
  private env: MapEnvironment | null = null;
  /** KTX2 transcoding for a map's art, where it's wanted (phones, touch, Low); null: WebP only */
  private readonly ktx2For: (preset: PresetName, touch: boolean) => Ktx2Source;
  /** the lighting preset's fog, and how far a fog event has thickened it (0 → 1) */
  private readonly fogBase = { near: 45, far: 150 };
  private fogMix = 0;
  private readonly kit: AvatarKit;
  private readonly sun: DirectionalLight;
  private readonly hemi: HemisphereLight;
  private readonly sunDir = new Vector3();
  /** grenades, explosions, the blast light and camera shake */
  readonly vfx: Vfx;
  private readonly assembler: CharacterAssembler;
  /** who wears what: the Locker's saved look for the local player, placeholders for the rest */
  private readonly loadouts: LoadoutDirectory;
  private readonly avatars = new Map<number, Avatar>();
  /** each avatar's character, for look changes (Avatar only sees the skeleton side) */
  private readonly looks = new Map<number, CharacterInstance>();
  /** riot shields lying on the map, and ricochet sparks (shield.ts) */
  private readonly pickupMeshes: PickupMeshes;
  /** weapon crates on the map: the gun itself, side-on (the owner's "more guns") */
  private readonly weaponItems: WeaponItems;
  private readonly sparks: RicochetSparks;
  private readonly clouds = new CloudLayer(this.scene); // smoke, gas, non-frag grenades (arsenal B)
  /** one outline material for every soldier (docs/04 §5.5) */
  private readonly outline = new OutlineMaterial();
  /** the map's rim light on soldiers (lighting.ts), set by buildMap */
  private rim: LightingPreset['rim'] = { color: 0x7fb8ff, strength: 0 };
  /** the shader warm-up's soldiers, kept off the scene and never disposed so their programs stay linked */
  readonly warmedUp: Avatar[] = [];
  private readonly pending = new Set<number>();
  /** after a failed character load, wait this long before trying again (doubles, ≤ 30 s) */
  private retryMs = 1000;
  private readonly seen = new Set<number>();
  private readonly statsEl: HTMLElement | null = null;
  private lastFrameAt = 0;
  private frames = 0;

  /**
   * WebGL 2 starts, on a GPU unless `allowSoftware` (a software rasteriser is too slow to play on).
   * It is the baseline (docs/11 §1): without it the page keeps the 2D renderer.
   */
  static supported(allowSoftware = false): boolean {
    try {
      return !!document.createElement('canvas').getContext('webgl2', { failIfMajorPerformanceCaveat: !allowSoftware });
    } catch {
      return false;
    }
  }

  /** The context was lost (GPU reset, driver update, too many contexts): main.ts draws in 2D until it's back. */
  private lost = false;

  /** Drawing the world: not while the WebGL context is lost. */
  get drawing(): boolean {
    return !this.lost;
  }

  constructor(
    canvas: HTMLCanvasElement,
    private readonly camera: PlaneCamera,
    map: MapDef,
    preset: GraphicsPreset,
    /** show the frame-time panel (dev builds, or ?perf) */
    showStats = false,
    assembler?: CharacterAssembler,
    /** accept software WebGL (softwareGl: automated browsers, ?softgl); otherwise a major performance caveat fails */
    allowSoftware = false,
    /** who wears what (default: the Locker's saved look for the local player, placeholders for the rest) */
    loadouts?: LoadoutDirectory,
  ) {
    this.preset = preset;
    this.dynres = new DynamicResolution(preset.minScale);
    // throws when no context can be had (create3d falls back to 2D)
    this.renderer = new WebGLRenderer({ canvas, antialias: preset.antialias, powerPreference: 'high-performance', failIfMajorPerformanceCaveat: !allowSoftware });
    // map art (backdrops, billboards) as KTX2 only where GPU memory matters: phones, touch, Low (environment/ktx2.ts)
    this.ktx2For = ktx2Gate(() => createKtx2(this.renderer, import.meta.env.BASE_URL));
    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault(); // ask for it back
      this.lost = true;
    });
    canvas.addEventListener('webglcontextrestored', () => {
      this.lost = false;
      this.lastFrameAt = 0;
      this.vfx.gunfire.clear(); // nothing from before the loss fires late
      this.resize();
    });
    if (showStats) {
      this.statsEl = document.body.appendChild(document.createElement('pre'));
      this.statsEl.id = 'perf3d';
    }
    this.renderer.shadowMap.enabled = true; // only the High preset's sun casts (setPreset)
    // one toon ramp for soldiers, guns and the gameplay plane, the same as the Locker's
    const ramp = characterToonRamp();
    this.assembler = assembler ?? new CharacterAssembler();
    this.loadouts = loadouts ?? new LoadoutDirectory();
    this.loadouts.onChange = () => {
      for (const [id, look] of this.looks) if (id === this.localId) void look.setLoadout(this.loadouts.for({ id, isLocal: true }));
    };
    this.kit = new AvatarKit(ramp);

    this.scene.background = null; // the sky card covers the view
    // colours and intensities come from the map (buildMap)
    this.scene.fog = new Fog(0, 1, 2);
    this.hemi = new HemisphereLight();
    this.sun = new DirectionalLight();
    this.sun.shadow.mapSize.set(1024, 1024); // docs/11 §2: one 1024² map over the gameplay plane
    this.sun.shadow.bias = -0.0005;
    this.scene.add(this.hemi, this.sun, this.sun.target);

    this.map = map;
    this.world = new CollisionWorld(map);
    this.plane = new Mesh(new BufferGeometry(), new MeshToonMaterial({ vertexColors: true, gradientMap: ramp }));
    this.plane.name = 'gameplay-plane';
    this.plane.receiveShadow = this.plane.castShadow = true;
    this.layers = { background: new Group(), foreground: [], foregroundGroup: new Group(), materials: [] };
    this.zones = new ZoneVolumes(map);
    this.buildMap(map);
    this.scene.add(this.plane, this.zones.group);
    // after buildMap: the blast light flashes from the map's light levels
    this.vfx = new Vfx(this.scene, this.world, camera, { hemi: this.hemi, sun: this.sun }, ramp, preset, this.muzzleOf, this.bodyOf, this.ejectOf, this.gunPointOf, this.swingOf);
    // reduced motion (docs/11 §5): the OS setting until the settings screen calls setReducedMotion
    this.setReducedMotion(typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches);
    // riot shields lying on the map, and the ricochet spark (an effect module: it gets the sim events)
    this.pickupMeshes = new PickupMeshes(this.kit.shield);
    this.sparks = new RicochetSparks(this.kit.shield);
    this.weaponItems = new WeaponItems(this.kit);
    this.scene.add(this.pickupMeshes.group, this.sparks.group, this.weaponItems.group);
    this.vfx.register(this.sparks);
    // smoke, gas and the other grenades, the flashbang's pop and the EMP's ring (arsenal B)
    this.vfx.register(this.clouds);
    this.setPreset(preset.name);
  }

  /** A shooter's drawn muzzle, for tracers and flashes (false while its character isn't drawn). */
  private readonly muzzleOf: MuzzleLookup = (id, weapon, out, dir, peek) => this.avatars.get(id)?.muzzle(weapon, out, dir, peek) ?? false;
  /** a player's drawn character (dash afterimages) */
  private readonly bodyOf: BodyLookup = (id) => this.avatars.get(id)?.inst ?? null;
  /** where a shooter's drawn gun throws its casings (vfx/casings.ts) */
  private readonly ejectOf: EjectLookup = (id, weapon, out, dir, bore) => this.avatars.get(id)?.eject(weapon, out, dir, bore) ?? false;
  /** a drawn gun's named socket (the Dragon's pilot light, the Ripper's and Pulse's charge) */
  private readonly gunPointOf: GunPointLookup = (id, weapon, name, out) => this.avatars.get(id)?.gunPoint(weapon, name, out) ?? false;
  /** a soldier's weapon mid-strike (the swing's trail) */
  private readonly swingOf: SwingLookup = (id, out) => this.avatars.get(id)?.swingSegment(out) ?? false;

  /** the online timeline while online play is attached (attach) */
  private online: OnlineView | null = null;
  private netOf: () => RemoteView | null = () => null;

  /**
   * Hooks the 3D view into the page (main.ts, one line): the 2D renderer forwards its sim events
   * here, and `net` gives the current online mode's NetClient (null in local play). Online, remote
   * players are drawn only through net.remoteRenderTick/remotePose (online.ts).
   */
  attach(renderer2d: EventSource2D, net: () => RemoteView | null = () => null): void {
    renderer2d.forwardEvents = this.onEvents;
    this.netOf = net;
  }

  /** The online timeline for the attached NetClient (a fresh one per connection), or null offline. */
  private onlineView(): OnlineView | null {
    const net = this.netOf();
    if (!net) return (this.online = null);
    if (this.online?.net !== net) this.online = new OnlineView(net);
    return this.online;
  }

  /**
   * Sim events (shots, explosions) for the effects; online, remote ones wait for the render tick.
   * None while nothing is drawn (loading, the context lost, a hidden tab whose sim the watchdog keeps
   * stepping): queued shots and blasts would all go off, stale, on the first frame back.
   */
  readonly onEvents = (events: readonly SimEvent[], localId = -1): void => {
    if (!this.ready || this.lost || document.hidden) return;
    const online = this.onlineView();
    if (online) online.hold(events, localId, this.toVfx);
    else this.toVfx(events);
  };

  /** Events reach the effects and the shooters' recoil together (online: on the remote timeline). */
  private readonly toVfx = (events: readonly SimEvent[]): void => {
    this.vfx.onEvents(events);
    eachKick(events, this.onKick);
    // animation: hit reactions (motion.ts), for every drawn player, the remote ones included
    for (const r of hitReactions(events, this.chestOf)) this.avatars.get(r.target)?.hit(r.dirX, r.dirY, r.size, r.zone, this.reducedMotion ? HIT.reduced : 1);
    // a melee hit: the attacker's swing plays from the strike where its swing wasn't sent (a remote player online)
    for (const e of events) if (e.type === 'hit' && e.source === DamageSource.Melee) this.avatars.get(e.attacker)?.struck();
  };

  /** a drawn player's chest (hit directions), or null */
  private readonly chestOf = (id: number): { x: number; y: number } | null => {
    const a = this.avatars.get(id);
    return a ? { x: a.pivot.position.x, y: a.pivot.position.y + 0.9 } : null;
  };

  /** Reduce motion is on: hit reactions play smaller (setReducedMotion; until it's called, the OS preference) */
  private reducedMotion = osPrefersReducedMotion();

  /** Visual recoil (recoil.ts): the shooter's gun, arm and torso, and the local player's camera. */
  private readonly onKick = (shooter: number, weapon: number, dirX: number, dirY: number): void => {
    this.avatars.get(shooter)?.kick(weapon);
    if (shooter !== this.localId) return;
    const camera = recoilOf(weapon).camera;
    this.vfx.shake.kick(-dirX * camera, -dirY * camera);
  };

  /** the local player's id, from the last drawn frame (−1: none) */
  private localId = -1;

  /**
   * Blood on player hits (vfx/blood.ts: a spray sized by the damage, a floor splat that fades), for
   * the Settings toggle. **Off by default** (age ratings): off, a hit is a non-gory thud.
   */
  setBlood(on: boolean): void {
    this.vfx.setBlood(on);
  }

  /**
   * No camera shake or camera kick, half the gun kick, a third of the blast light, fuse lights
   * blinking ≤ 3 times a second, hit reactions at HIT.reduced of their size.
   */
  setReducedMotion(on: boolean): void {
    this.reducedMotion = on;
    this.vfx.setReducedMotion(on);
    this.kit.recoilScale = on ? 0.5 : 1;
  }

  /** Swaps the map on screen (online play follows the server's map from WELCOME). */
  setMap(map: MapDef): void {
    if (map === this.map) return;
    this.map = map;
    this.world = new CollisionWorld(map);
    this.plane.geometry.dispose();
    this.scene.remove(this.layers.background, this.layers.foregroundGroup, this.zones.group);
    disposeTree(this.layers.background);
    disposeTree(this.layers.foregroundGroup);
    this.env?.dispose();
    this.zones.dispose();
    this.zones = new ZoneVolumes(map);
    this.scene.add(this.zones.group);
    this.buildMap(map);
  }

  /** Everything that comes from the map: lighting preset, the gameplay plane, the depth layers and the effects' world. */
  private buildMap(map: MapDef): void {
    const envDef = environmentFor(map.id);
    this.env = envDef ? new MapEnvironment(envDef, map, import.meta.env.BASE_URL, undefined, undefined, undefined, this.ktx2For(this.preset.name, isTouchDevice())) : null;
    this.env?.setShadowMap(this.preset.shadows === 'map');
    // a map swapped in after load (online: the room's map) gets its art's shaders compiled as it arrives
    if (this.ready) this.warmEnvironment();
    const light = this.env?.look ?? lightingFor(map.id);
    const fog = this.scene.fog as Fog;
    fog.color.setHex(light.fog.color);
    fog.near = this.fogBase.near = light.fog.near;
    fog.far = this.fogBase.far = light.fog.far;
    this.fogMix = 0;
    this.hemi.color.setHex(light.hemi.sky);
    this.hemi.groundColor.setHex(light.hemi.ground);
    this.hemi.intensity = light.hemi.intensity;
    this.sun.color.setHex(light.sun.color);
    this.sun.intensity = light.sun.intensity;
    this.sunDir.fromArray(light.sun.dir).normalize();
    this.rim = light.rim;
    for (const look of this.looks.values()) this.dress(look);
    this.plane.geometry = buildMapGeometry(map, light);
    this.layers = this.env?.layers ?? buildDepthLayers(map, light);
    this.scene.add(this.layers.background, this.layers.foregroundGroup);
    // the effects take the new world and the relit scene (the constructor's first build runs before Vfx exists)
    this.vfx?.setMap(this.world);
  }

  /** Loads the base character and effect assets, then compiles every material variant (docs/11 §3 shader warm-up). */
  async load(spawn: { x: number; y: number }): Promise<void> {
    const base = import.meta.env.BASE_URL;
    // the map's kit (the play plane) only, and not for ever: the art around it pops in and is warmed when it lands
    await Promise.all([this.vfx.load(base), this.kit.loadWeapons(base, new GLTFLoader().setMeshoptDecoder(MeshoptDecoder)), this.env && withTimeout(this.env.kitReady, KIT_WAIT_MS)]);
    try {
      await this.warmUp(spawn);
    } catch (err) {
      console.error('render3d: warm-up failed, characters may pop in', err);
    }
    this.ready = true;
    this.warmEnvironment();
  }

  /**
   * Compiles the map environment's materials once all its art is in (docs/11 §3: no first-sight
   * hitches): whatever arrived after the load's warm-up, and everything for a map set later.
   */
  private warmEnvironment(): void {
    const env = this.env;
    env?.ready
      .then(() => (this.env === env ? this.renderer.compileAsync(this.scene, this.camera3) : undefined))
      .catch((err: unknown) => console.warn('render3d: environment warm-up failed', err));
  }

  private async warmUp(spawn: { x: number; y: number }): Promise<void> {
    const lods: CharacterLod[] = [0, 1];
    const insts = await Promise.all(lods.map((lod) => this.assembler.create(null, lod)));
    const warm = insts.map((inst, i) => new Avatar(inst, lods[i]!, this.kit, i));
    for (const [i, a] of warm.entries()) {
      a.pivot.position.set(spawn.x, spawn.y, 0);
      a.showAllForWarmUp(i);
      a.pivot.traverse((o) => (o.castShadow = true)); // as the real ones (syncAvatars): the shadow pass below
      this.dress(insts[i]!); // after the shadow flags, as the real ones: the outline casts none
      this.scene.add(a.pivot, a.blob);
    }
    // a scratch camera at the spawn: the game camera (follow, mouse aim) is read-only here
    const cam = new PlaneCamera();
    cam.resize(this.camera.width, this.camera.height);
    cam.x = spawn.x;
    cam.y = spawn.y;
    applyPlanePose(this.camera3, planePose(cam, FOV_DEG, undefined, this.pose));
    this.vfx.showForWarmUp(spawn.x, spawn.y + 1); // effects with meshes of their own (the dash trail, casings)
    await this.renderer.compileAsync(this.scene, this.camera3);
    this.vfx.endWarmUp();
    // compileAsync skips the shadow pass: where the sun casts shadows (High), one draw links its
    // depth programs (the skinned soldiers' included) now, not when the first soldiers spawn
    if (this.sun.castShadow) {
      this.sun.target.position.set(spawn.x, spawn.y, 0);
      this.sun.position.copy(this.sun.target.position).addScaledVector(this.sunDir, 50);
      this.renderer.render(this.scene, this.camera3);
    }
    // keep the warm-up soldiers, off the scene: disposing them would release the dye, blob and shadow programs (no
    // other material uses them yet), and the first real soldiers would link them again mid-game (review L1)
    for (const a of warm) {
      a.pivot.removeFromParent();
      a.blob.removeFromParent();
    }
    this.warmedUp.push(...warm);
  }

  /** The in-game finish on a soldier: the outline, and the rim light of the Locker preset this map matches. */
  private dress(inst: CharacterInstance): CharacterInstance {
    inst.setOutline(this.outline);
    inst.material.rim.colour.set(this.rim.color);
    inst.material.rim.strength.value = this.rim.strength;
    return inst;
  }

  setPreset(name: PresetName): void {
    const lodChanged = PRESETS[name].remoteLod1 !== this.preset.remoteLod1;
    this.preset = PRESETS[name];
    this.dynres.minScale = this.preset.minScale;
    this.dynres.scale = Math.max(this.dynres.scale, this.preset.minScale);
    this.sun.castShadow = this.preset.shadows === 'map';
    this.env?.setShadowMap(this.sun.castShadow);
    this.vfx.setPreset(this.preset);
    this.kit.animateParts = this.preset.name !== 'low'; // Low: guns' parts stand still, merged in (no draws)
    if (lodChanged) {
      for (const a of this.avatars.values()) a.dispose();
      this.avatars.clear();
      this.looks.clear();
    }
    this.resize();
    if (this.ready) this.applyAnisotropy();
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

  // --- render3d-b: quality for the device (the owner, 19 Oct) ---
  /** a phone or tablet: the presets' touch caps (touch/index.ts) */
  private touch = false;
  /** Auto quality adapting to the measured frames, or null */
  private governor: TierGovernor | null = null;
  private judged = 0;
  /** Auto stepped to another tier (main.ts: Settings shows it) */
  onAutoTier: ((tier: PresetName) => void) | null = null;

  /** A phone or tablet: render at the presets' touch caps (up to 3× on High) instead of the desktop ones. */
  setTouchDevice(on: boolean): void {
    this.touch = on;
    this.resize();
  }

  /**
   * Settings → Quality: Auto. `start` is Auto's pick for the device (gfxAuto.ts): the tier it runs
   * and the ceiling it may come back up to; frames that keep missing at the lowest render scale step
   * it down (TierGovernor). Null: a preset the player chose, left alone.
   */
  setAutoTier(start: PresetName | null): void {
    this.governor = start ? new TierGovernor(start) : null;
    this.judged = this.dynres.windows;
    if (start && start !== this.preset.name) this.setPreset(start);
  }

  /** after each dynamic-resolution window: Auto's verdict on the tier */
  private governTier(): void {
    if (!this.governor || this.dynres.windows === this.judged) return;
    this.judged = this.dynres.windows;
    const next = this.governor.judge(this.dynres.lastMissed, this.dynres.scale <= this.preset.minScale + 1e-6, this.dynres.scale >= 1);
    if (!next) return;
    this.setPreset(next);
    this.onAutoTier?.(next);
  }

  private anisoFrames = 0;
  private readonly anisoVisit = (o: Object3D): void => {
    const m = (o as Mesh).material as Material | Material[] | undefined;
    if (!m) return;
    if (Array.isArray(m)) for (const mat of m) this.anisoMaterial(mat);
    else this.anisoMaterial(m);
  };
  private aniso = 1;

  private anisoMaterial(m: Material): void {
    const mat = m as Material & { map?: Texture | null; normalMap?: Texture | null; emissiveMap?: Texture | null };
    for (const t of [mat.map, mat.normalMap, mat.emissiveMap]) {
      if (!t || t.anisotropy === this.aniso || t.minFilter === NearestFilter) continue;
      t.anisotropy = this.aniso;
      t.needsUpdate = true;
    }
  }

  /**
   * Anisotropic filtering on the textures drawn (the preset's, capped by the GPU): the ground and the
   * walls stay sharp at a glancing angle. Run on a preset change and every couple of seconds (art
   * and characters arrive late); a texture already at it is left alone.
   */
  private applyAnisotropy(): void {
    this.aniso = Math.max(1, Math.min(this.preset.anisotropy, this.renderer.capabilities.getMaxAnisotropy()));
    this.scene.traverse(this.anisoVisit);
  }

  /** A device-pixel-ratio cap on top of the preset's: the lower one wins (null: the preset's alone). */
  setDprCap(cap: number | null): void {
    this.dprCapOverride = cap;
    this.resize();
  }

  resize(): void {
    const canvas = this.renderer.domElement;
    const dpr = pixelRatio(window.devicePixelRatio || 1, this.touch ? this.preset.touchDprCap : this.preset.dprCap, this.dprCapOverride, this.dynres.scale);
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(canvas.clientWidth, canvas.clientHeight, false);
    // 2 CSS px at full resolution, whatever the render scale
    this.outline.setWidth(2 * dpr);
  }

  render(frame: Frame, dt: number): void {
    if (!this.ready || this.lost) return; // loading frames would skew the meter and dynamic resolution; no context, nothing to draw
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
      this.governTier();
    }
    if (this.anisoFrames++ % 120 === 0) this.applyAnisotropy();
    this.lastFrameAt = now;

    // online: remote players at net.remotePose on this frame's render tick, and the snapshot world
    // (grenades, remote shots, dashes and blasts) on the same timeline
    const online = this.onlineView();
    if (online) {
      frame = online.frame(frame, now);
      online.release(this.toVfx);
    }
    // characters first (tracers leave their drawn muzzles), then effects; the effects' camera
    // shake moves the 3D camera only (never the 2D Camera: aim, AOI, HUD)
    this.syncAvatars(frame, dt);
    const shake = this.vfx.update(frame, dt);
    const pose = planePose(this.camera, FOV_DEG, undefined, this.pose);
    pose.x += shake.x;
    pose.y += shake.y;
    applyPlanePose(this.camera3, pose);
    // a screen taller than 4:3 is letterboxed: draw into the band only (the 2D overlay paints the bars)
    const { top, bottom } = this.camera.band;
    this.renderer.setViewport(0, top, this.camera.width, bottom - top);
    this.outline.setViewport(this.camera.width * this.renderer.getPixelRatio(), (bottom - top) * this.renderer.getPixelRatio());
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

    this.plane.visible = !this.env?.drawsPlane; // the kit draws the plane once it's in
    this.env?.update(this.pose, frame, dt); // painted sky, lamp glows over players, billboard rotation
    this.pickupMeshes.sync(frame.pickups, dt);
    this.weaponItems.sync(frame.pickups, dt);
    updateForeground(this.layers.foreground, frame.players, this.pose, dt);
    this.zones.update(frame, dt, now / 1000);
    this.applyEventAtmosphere(frame, dt);
    this.renderer.render(this.scene, this.camera3);
    this.cpuMs.push(performance.now() - now);
    if (this.statsEl && this.frames++ % 30 === 0) this.statsEl.textContent = formatStats(this.stats());
  }

  /**
   * A fog event (any map event that cuts bullet range, docs/02 §20.7) thickens the air while it
   * runs: the gameplay plane hazes over and the background all but disappears.
   */
  private applyEventAtmosphere(frame: Frame, dt: number): void {
    const ev = frame.mapEvent;
    const target = ev && ev.phase === 'active' && ev.bulletRangeMul < 1 ? 1 : 0;
    if (target === 0 && this.fogMix < 1e-3) return;
    this.fogMix += (target - this.fogMix) * (1 - Math.exp(-Math.min(dt, 0.1) * 2));
    const fog = this.scene.fog as Fog;
    fog.near = this.fogBase.near + (10 - this.fogBase.near) * this.fogMix;
    fog.far = this.fogBase.far + (70 - this.fogBase.far) * this.fogMix;
  }

  private syncAvatars(frame: Frame, dt: number): void {
    const blob = this.preset.shadows === 'blob';
    this.seen.clear();
    this.localId = -1;
    for (const p of frame.players) {
      this.seen.add(p.id);
      if (p.isLocal) this.localId = p.id;
      const avatar = this.avatars.get(p.id);
      if (avatar) {
        avatar.update(p, dt, this.world, blob);
        continue;
      }
      if (this.pending.has(p.id)) continue;
      // characters stream in without blocking the frame (docs/04 §5.2)
      const lod: CharacterLod = !p.isLocal && this.preset.remoteLod1 ? 1 : 0;
      this.pending.add(p.id);
      this.assembler.create(this.loadouts.for(p), lod).then(
        (inst) => {
          this.pending.delete(p.id);
          this.retryMs = 1000;
          const a = new Avatar(inst, lod, this.kit, p.id);
          a.pivot.traverse((o) => (o.castShadow = true));
          this.dress(inst); // after the shadow flags: the outline casts none
          this.avatars.set(p.id, a);
          this.looks.set(p.id, inst);
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
      this.looks.delete(id);
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
      auto: this.governor?.ceiling ?? null,
      touch: this.touch,
      calls: info.calls,
      triangles: info.triangles,
      avatars: this.avatars.size,
      particles: this.vfx.particles,
    };
  }
}

/** Frees the geometries and materials under `root` (textures shared with other meshes stay). */
/** The OS asks for less motion (prefers-reduced-motion). */
function osPrefersReducedMotion(): boolean {
  try {
    return typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

function disposeTree(root: Object3D): void {
  root.traverse((o) => {
    const mesh = o as Mesh;
    if (!mesh.isMesh) return;
    mesh.geometry.dispose();
    for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) m.dispose();
  });
}

export function formatStats(s: RenderStats): string {
  const f = (v: number) => (Number.isFinite(v) ? v.toFixed(1) : '–');
  return (
    `3D ${s.auto ? `Auto: ${s.preset} (from ${s.auto})` : s.preset}${s.touch ? ' · touch' : ''} · ${s.width}×${s.height} (dpr ${s.pixelRatio.toFixed(2)}, scale ${s.scale.toFixed(2)})\n` +
    `frame p50 ${f(s.frameP50)} · p90 ${f(s.frameP90)} · p99 ${f(s.frameP99)} ms · render cpu ${f(s.cpuMean)} ms (p90 ${f(s.cpuP90)})\n` +
    `${s.calls} draw calls · ${(s.triangles / 1000).toFixed(1)}k tris · ${s.avatars} characters · ${s.particles} particles`
  );
}
