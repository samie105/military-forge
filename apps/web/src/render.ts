/**
 * Canvas-2D debug renderer (Phase 0: programmer art on purpose, docs/12 §2). Draws the map,
 * capsules, hitboxes, aim, grenades, tracers/explosions, and a HUD.
 */
import {
  CROUCHED_HITBOXES,
  EMP,
  FLASHBANG,
  FRAG,
  GAS,
  MINE,
  HitZone,
  NO_WEAPON,
  RIOT_SHIELD,
  SMOKE,
  STANDING_HITBOXES,
  ZONE_KINDS,
  defaultTuning,
  pickups as pickupDefs,
  resolveEvent,
  resolveZone,
  grenades,
  weapons,
  zonePoints,
  type MapDef,
  type MapZone,
  type Tuning,
} from '@military-forge/content';
import { CollisionWorld, DamageSource, MELEE_ARC_DEG, MELEE_REACH, MELEE_WINDUP_TICKS, MineState, TICK_RATE, cloudDef, shieldBottom, type SimEvent } from '@military-forge/sim';
import type { Camera } from './camera';
import { reduceFlashes } from './fx';
import { REACH_RAYS, cloudReach, inSmoke } from './grenadeViews';
import { arcDots, type ThrowArcView } from './throwPreview';
import type { CloudView, Frame, GrenadeView, PickupView, PlayerView, RewindView } from './view';

interface Tracer {
  ox: number;
  oy: number;
  ex: number;
  ey: number;
  /** 0 nothing, 1 wall, 2 player, 3 riot shield */
  hit: number;
  age: number;
  local: boolean;
  /** the leg of a bullet after it bounced off a riot shield */
  ricochet?: boolean;
}

/** Where a bullet bounced off a riot shield, along the shield's normal. */
interface Spark {
  x: number;
  y: number;
  nx: number;
  ny: number;
  age: number;
}

interface Burst {
  x: number;
  y: number;
  r: number;
  age: number;
  /** grenade type that went off */
  grenade: number;
}

/** A dash's trail (docs/02 §21): from where it started, along its direction. */
interface DashStreak {
  x: number;
  y: number;
  dir: number;
  age: number;
  local: boolean;
}

/** 8-way dash directions (0 = right, counter-clockwise), as the sim's DASH_DX/DASH_DY. */
const DASH_UNIT = Array.from({ length: 8 }, (_, i) => [Math.cos((i * Math.PI) / 4), Math.sin((i * Math.PI) / 4)] as const);

interface FloatText {
  /** player the number floats above */
  target: number;
  x: number;
  y: number;
  text: string;
  color: string;
  age: number;
}

interface FeedLine {
  text: string;
  age: number;
}

export interface RenderOptions {
  showHitboxes: boolean;
  showGrid: boolean;
  showNet: boolean;
  /**
   * 3D mode (render3d): this canvas is a transparent layer over the WebGL view. HUD, reticle and
   * damage numbers always; the world layers (map outline, capsules, hitboxes, grenades, tracers,
   * blasts) are the debug overlay, drawn while hitboxes (H) or the grid (B) are on. render3d draws
   * the grenades, tracers and blasts itself.
   */
  overlay?: boolean;
  /**
   * What the 2D layer draws besides the world and effects (the app shell): 'debug' (default) the HUD,
   * debug text and help line; 'basic' the HUD and the net graph (N) only; 'none' no HUD at all
   * (menus, or the DOM HUD in hud/ draws it).
   */
  hud?: 'debug' | 'basic' | 'none';
  /** the aiming reticle and hit markers (default on; off in menus) */
  reticle?: boolean;
}

/** A zone ready to draw (docs/02 §20): outline, label spot and flow direction (wind or launch). */
interface ZoneDraw {
  zone: MapZone;
  points: number[];
  color: number;
  label: string;
  /** centre and top of the bounding box (m) */
  cx: number;
  cy: number;
  top: number;
  /** unit flow direction, 0,0 for none */
  fx: number;
  fy: number;
}

function zoneDraws(map: MapDef): ZoneDraw[] {
  return (map.zones ?? []).map((zone) => {
    const points = zonePoints(zone);
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < points.length; i += 2) {
      minX = Math.min(minX, points[i]!);
      maxX = Math.max(maxX, points[i]!);
      minY = Math.min(minY, points[i + 1]!);
      maxY = Math.max(maxY, points[i + 1]!);
    }
    const r = resolveZone(zone);
    const fx = r.launch ? r.launch[0] : r.windX;
    const fy = r.launch ? r.launch[1] : r.windY;
    const len = Math.hypot(fx, fy);
    return {
      zone,
      points,
      color: ZONE_KINDS[zone.kind]?.color ?? 0x8b949e,
      label: zone.label ?? ZONE_KINDS[zone.kind]?.label ?? zone.kind,
      cx: (minX + maxX) / 2,
      cy: (minY + maxY) / 2,
      top: maxY,
      fx: len > 0 ? fx / len : 0,
      fy: len > 0 ? fy / len : 0,
    };
  });
}

/** 0xRRGGBB → rgba() */
function rgba(c: number, a: number): string {
  return `rgba(${(c >> 16) & 255},${(c >> 8) & 255},${c & 255},${a})`;
}

const COLORS = {
  bg: '#0d1117',
  letterbox: '#05070a',
  grid: 'rgba(255,255,255,0.04)',
  gridMajor: 'rgba(255,255,255,0.08)',
  solid: ['#3d444d', '#4a5568', '#6b4f3a', '#4b3b2a', '#5b8fb9'],
  oneWay: '#d29922',
  label: 'rgba(230,237,243,0.45)',
  local: '#58a6ff',
  enemy: '#f0883e',
  bot: '#8b949e',
  shield: '#79c0ff',
  ricochet: '#a5f3fc',
};

/** Shield colour by the HP left (local mode and the local player online know it). */
function shieldColor(hp: number | undefined): string {
  if (hp === undefined) return COLORS.shield;
  const k = hp / RIOT_SHIELD.hp;
  return k > 0.5 ? COLORS.shield : k > 0.25 ? '#d29922' : '#f85149';
}

/** Grenades by type: frag green, smoke pale grey, gas sickly yellow-green (cover vs deadly at a glance). */
const GRENADE_COLORS: Record<number, string> = {
  [FRAG.index]: '#3fb950',
  [SMOKE.index]: '#c9d1d9',
  [GAS.index]: '#c3d22b',
  [FLASHBANG.index]: '#a5d6ff',
  [MINE.index]: '#d29922',
  [EMP.index]: '#58a6ff',
};

/**
 * A mine's light by state: green flying, yellow arming, red blinking 4 Hz armed, a red/white beep
 * at 8 Hz when triggered (the Forge's grenades.vfx.json, as render3d's clouds.ts); `calm` (Reduce
 * motion or Reduce flashes) keeps both at 3 Hz at most.
 */
export function mineLight(state: number, nowMs: number, calm: boolean): string {
  if (state === MineState.Flying) return '#3fb950';
  if (state === MineState.Arming) return '#d29922';
  const hz = Math.min(state === MineState.Armed ? 4 : 8, calm ? 3 : Infinity);
  const on = Math.floor((nowMs / 1000) * hz * 2) % 2 === 0;
  if (state === MineState.Armed) return on ? '#f85149' : '#5c1d1b';
  return on ? '#f85149' : '#ffffff';
}

/** Cloud tints (r, g, b): smoke a neutral grey, gas a sickly green-yellow. */
const CLOUD_RGB: Record<number, [number, number, number]> = {
  [SMOKE.index]: [176, 182, 190],
  [GAS.index]: [160, 190, 40],
};

const KILL_ICONS: Record<number, string> = {
  [DamageSource.Grenade]: 'frag',
  [DamageSource.Gas]: 'gas',
  [DamageSource.Mine]: 'mine',
  [DamageSource.World]: 'fell',
  [DamageSource.Melee]: 'melee',
};

/** A flashbang's pop in the 2D view (m): the burst stays this small, its ring marks the full-white radius. */
const FLASH_POP_M = 1;

/** Burst tints by grenade type (r, g, b). */
const BURST_RGB: Record<number, [number, number, number]> = {
  [FRAG.index]: [255, 166, 87],
  [FLASHBANG.index]: [255, 255, 255],
  [MINE.index]: [255, 120, 70],
  [EMP.index]: [88, 166, 255],
};

/** "G Smoke ×2 · frag 3 · gas 1": the selected grenade first (T cycles), then the rest of the belt. */
function grenadeLine(p: PlayerView): string {
  const counts = p.grenadeCounts;
  if (!counts) return `frags ${p.frags}`;
  const selected = grenades[p.grenadeType ?? 0];
  const others = grenades.filter((g) => g !== selected && (counts[g.index] ?? 0) > 0).map((g) => `${g.id} ${counts[g.index]}`);
  return `G ${selected?.name ?? '?'} ×${counts[p.grenadeType ?? 0] ?? 0}${others.length ? ` · ${others.join(' · ')}` : ''}`;
}

/** Status effects as short tags; `long` adds the seconds left (HUD). */
function statusTags(p: PlayerView, long = false): string {
  const tags: string[] = [];
  const secs = (ticks: number) => (long ? ` ${(ticks / 60).toFixed(1)} s` : '');
  if (p.blindTicks) tags.push(`BLIND${secs(p.blindTicks)}`);
  if (p.jetDisabledTicks) tags.push(`${long ? 'JETPACK OFFLINE' : 'EMP'}${secs(p.jetDisabledTicks)}`);
  if (p.gasTicks) tags.push(long ? 'GAS: get out!' : 'GAS');
  return tags.join(' · ');
}

export class Renderer {
  private readonly ctx: CanvasRenderingContext2D;
  private readonly tracers: Tracer[] = [];
  private readonly sparks: Spark[] = [];
  private readonly bursts: Burst[] = [];
  private readonly dashes: DashStreak[] = [];
  /** the throw arc's core colour this frame ("r,g,b"): warm white, amber when a map event starts or ends mid-flight */
  private arcCore = '';
  /** one dot of the throw arc (arcDots): a dark rim under a bright core, fainter past the landing */
  private readonly arcDot = (x: number, y: number, after: boolean, fade: number): void => {
    const ctx = this.ctx;
    const sx = this.camera.toScreenX(x);
    const sy = this.camera.toScreenY(y);
    const r = after ? 2.1 : 3;
    ctx.fillStyle = `rgba(0,0,0,${(after ? 0.35 : 0.7) * fade})`;
    ctx.beginPath();
    ctx.arc(sx, sy, r * 1.75, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = `rgba(${this.arcCore},${(after ? 0.5 : 1) * fade})`;
    ctx.beginPath();
    ctx.arc(sx, sy, r, 0, Math.PI * 2);
    ctx.fill();
  };
  private readonly floats: FloatText[] = [];
  private readonly feed: FeedLine[] = [];
  private hitMarker = { age: 1, head: false, kill: false };
  private names = new Map<number, string>();
  private fps = 60;
  private zones: ZoneDraw[];
  /** the map's walls, for clouds a wall cuts through (built on the first such cloud) */
  private world: CollisionWorld | null = null;
  /** per cloud slot: where it popped and how far it reaches past the walls (null: the whole disc) */
  private readonly reach = new Map<number, { x: number; y: number; type: number; rays: Float32Array | null }>();
  /** Also handed every event batch when set: main.ts points it at the 3D view's effects. */
  forwardEvents: ((events: readonly SimEvent[], localId: number) => void) | null = null;
  /**
   * Reduce motion (docs/11 §5), as the 3D view takes it: the OS setting unless set. Lights blink 3
   * times a second at most then, as they do under Reduce flashes.
   */
  reducedMotion = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly camera: Camera,
    private map: MapDef,
    private readonly tuningRef: () => Tuning,
  ) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas not supported');
    this.ctx = ctx;
    this.zones = zoneDraws(map);
  }

  setNames(names: Map<number, string>): void {
    this.names = names;
  }

  /** Online play follows the server's map (WELCOME). */
  setMap(map: MapDef): void {
    this.map = map;
    this.zones = zoneDraws(map);
    this.world = null;
    this.reach.clear();
  }

  /** How far a cloud reaches past the walls (cloudReach), worked out once per cloud: clouds don't move. */
  private cloudRays(c: CloudView): Float32Array | null {
    let r = this.reach.get(c.id);
    if (!r || r.x !== c.x || r.y !== c.y || r.type !== c.type) {
      const rays = new Float32Array(REACH_RAYS);
      this.world ??= new CollisionWorld(this.map);
      const walled = cloudReach(this.world, c.x, c.y, cloudDef(c.type)?.radius ?? c.radius, rays);
      r = { x: c.x, y: c.y, type: c.type, rays: walled ? rays : null };
      this.reach.set(c.id, r);
    }
    return r.rays;
  }

  resize(): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.camera.resize(w, h);
  }

  /** Turns sim events into short-lived visual effects. */
  onEvents(events: readonly SimEvent[], localId: number): void {
    this.forwardEvents?.(events, localId);
    for (const e of events) {
      switch (e.type) {
        case 'shot':
          this.tracers.push({ ox: e.ox, oy: e.oy, ex: e.ex, ey: e.ey, hit: e.hit, age: 0, local: e.shooter === localId });
          break;
        case 'explosion':
          this.bursts.push({ x: e.x, y: e.y, r: e.radius, age: 0, grenade: e.grenade ?? FRAG.index });
          break;
        case 'ricochet':
          this.tracers.push({ ox: e.x, oy: e.y, ex: e.ex, ey: e.ey, hit: e.hit, age: 0, local: e.shooter === localId, ricochet: true });
          this.sparks.push({ x: e.x, y: e.y, nx: e.nx, ny: e.ny, age: 0 });
          break;
        case 'shieldBreak':
          this.bursts.push({ x: e.x, y: e.y, r: 0.6, age: 0, grenade: FRAG.index }); // drawn like a small blast
          this.floats.push({ target: e.owner, x: Number.NaN, y: Number.NaN, text: 'shield broken', color: COLORS.shield, age: 0 });
          break;
        case 'pickup':
          if (e.player < 0) break; // taken by someone this client can't see (snapshot AOI)
          this.floats.push({ target: e.player, x: Number.NaN, y: Number.NaN, text: `+ ${pickupDefs[e.item]?.name ?? 'item'}`, color: COLORS.shield, age: 0 });
          break;
        case 'hit':
          this.floats.push({
            target: e.target,
            // placed over the target once it's drawn; one that's out of view (our hit on a player
            // the AOI culls) shows no number rather than one at the map origin
            x: Number.NaN,
            y: Number.NaN,
            text: e.damage.toFixed(0),
            color: e.zone === HitZone.Head ? '#ff7b72' : '#e6edf3',
            age: 0,
          });
          if (e.attacker === localId && e.target !== localId) this.hitMarker = { age: 0, head: e.zone === HitZone.Head, kill: false };
          break;
        case 'death': {
          const killer = e.killer >= 0 ? (this.names.get(e.killer) ?? `#${e.killer}`) : 'world';
          const victim = this.names.get(e.victim) ?? `#${e.victim}`;
          const how = KILL_ICONS[e.source] ?? weapons[e.source]?.name ?? '?';
          this.feed.push({ text: e.killer === e.victim ? `${victim} ✝ (${how})` : `${killer} ▸ ${victim} (${how})`, age: 0 });
          if (this.feed.length > 6) this.feed.shift();
          if (e.killer === localId && e.victim !== localId) this.hitMarker = { age: 0, head: false, kill: true };
          break;
        }
        case 'dash':
          this.dashes.push({ x: e.x, y: e.y, dir: e.dir, age: 0, local: e.player === localId });
          break;
        case 'mapEvent': {
          // map events (docs/02 §20.7): the banner is the shell's; the feed keeps a short history
          const def = this.map.events?.defs[e.event];
          if (!def) break;
          const ev = resolveEvent(def);
          const text = e.phase === 0 ? `⚠ ${ev.name} in ${Math.ceil(e.ticks / TICK_RATE)} s` : e.phase === 1 ? `⚡ ${ev.name}: ${ev.description}` : `${ev.name} is over`;
          this.feed.push({ text, age: 0 });
          if (this.feed.length > 6) this.feed.shift();
          break;
        }
        default:
          break;
      }
    }
  }

  render(frame: Frame, dt: number, opts: RenderOptions, help: string): void {
    const ctx = this.ctx;
    const cam = this.camera;
    this.fps = this.fps * 0.95 + (dt > 0 ? 1 / dt : 60) * 0.05;
    if (opts.overlay) {
      ctx.clearRect(0, 0, cam.width, cam.height);
      if (!opts.showHitboxes && !opts.showGrid) return this.drawOverlayHud(frame, dt, opts, help);
      ctx.globalAlpha = 0.5;
    } else {
      ctx.fillStyle = COLORS.bg;
      ctx.fillRect(0, 0, cam.width, cam.height);
    }

    if (opts.showGrid) this.drawGrid();
    this.drawMap();
    this.drawZones(frame);

    // floating damage numbers follow their target
    const byId = new Map(frame.players.map((p) => [p.id, p]));
    if (frame.pickups) for (const k of frame.pickups) this.drawPickup(k);
    for (const p of frame.players) this.drawPlayer(p, opts.showHitboxes, frame.clouds);
    if (opts.showHitboxes && frame.rewinds) for (const r of frame.rewinds) this.drawRewind(r);
    for (const g of frame.grenades) this.drawGrenade(g);
    // clouds over the players: smoke hides whoever is inside it
    if (frame.clouds) for (const c of frame.clouds) this.drawCloud(c);
    if (frame.throwArc) this.drawThrowArc(frame.throwArc);
    this.drawEffects(dt, byId, true);
    ctx.globalAlpha = 1;
    this.drawLetterbox();

    const local = byId.get(frame.localId);
    if (local && opts.hud !== 'none') this.drawHud(local, frame, opts, help);
    if (opts.reticle !== false) this.drawReticle();
  }

  /**
   * The throw arc while a grenade throw is aimed (throwPreview.ts; render3d draws its own): dots
   * along the path, a ring where it first comes down and a cross where it goes off. Amber when a
   * map event starts or ends mid-flight: the path bends there.
   */
  private drawThrowArc(view: ThrowArcView): void {
    if (view.count < 2) return;
    const ctx = this.ctx;
    const cam = this.camera;
    const amber = view.changes;
    this.arcCore = amber ? '255,168,51' : '255,247,209';
    const pts = view.points;
    if (view.land >= 0) {
      const sx = cam.toScreenX(pts[view.land * 2]!);
      const sy = cam.toScreenY(pts[view.land * 2 + 1]!);
      ctx.lineWidth = 5;
      ctx.strokeStyle = 'rgba(0,0,0,0.6)';
      ctx.beginPath();
      ctx.arc(sx, sy, 14, 0, Math.PI * 2);
      ctx.stroke();
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = amber ? 'rgba(255,168,51,1)' : 'rgba(255,224,120,1)';
      ctx.stroke();
    }
    if (view.detonates) {
      const end = view.count - 1;
      const sx = cam.toScreenX(pts[end * 2]!);
      const sy = cam.toScreenY(pts[end * 2 + 1]!);
      ctx.beginPath();
      ctx.moveTo(sx - 7, sy - 7);
      ctx.lineTo(sx + 7, sy + 7);
      ctx.moveTo(sx + 7, sy - 7);
      ctx.lineTo(sx - 7, sy + 7);
      ctx.lineWidth = 5;
      ctx.strokeStyle = 'rgba(0,0,0,0.6)';
      ctx.stroke();
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = 'rgba(255,140,51,1)';
      ctx.stroke();
    }
    arcDots(view, 0, this.arcDot);
  }

  /** Overlay without the debug world layers: damage numbers, HUD and reticle (render3d draws grenades, tracers and blasts). */
  private drawOverlayHud(frame: Frame, dt: number, opts: RenderOptions, help: string): void {
    const byId = new Map(frame.players.map((p) => [p.id, p]));
    this.drawEffects(dt, byId, false);
    this.drawLetterbox();
    const local = byId.get(frame.localId);
    if (local && opts.hud !== 'none') this.drawHud(local, frame, opts, help);
    if (opts.reticle !== false) this.drawReticle();
  }

  /**
   * Bars above and below the 4:3 band on screens taller than that: no view shows more of the world
   * than the AOI sends (camera.ts). Over the 3D canvas too, which renders into the band only.
   */
  private drawLetterbox(): void {
    const cam = this.camera;
    const { top, bottom } = cam.band;
    if (top <= 0) return;
    const ctx = this.ctx;
    ctx.fillStyle = COLORS.letterbox;
    ctx.fillRect(0, 0, cam.width, top);
    ctx.fillRect(0, bottom, cam.width, cam.height - bottom);
  }

  private drawGrid(): void {
    const ctx = this.ctx;
    const cam = this.camera;
    const x0 = Math.floor(cam.toWorldX(0));
    const x1 = Math.ceil(cam.toWorldX(cam.width));
    const y0 = Math.floor(cam.toWorldY(cam.height));
    const y1 = Math.ceil(cam.toWorldY(0));
    ctx.lineWidth = 1;
    for (let x = x0; x <= x1; x++) {
      ctx.strokeStyle = x % 4 === 0 ? COLORS.gridMajor : COLORS.grid;
      ctx.beginPath();
      ctx.moveTo(cam.toScreenX(x), 0);
      ctx.lineTo(cam.toScreenX(x), cam.height);
      ctx.stroke();
    }
    for (let y = y0; y <= y1; y++) {
      ctx.strokeStyle = y % 4 === 0 ? COLORS.gridMajor : COLORS.grid;
      ctx.beginPath();
      ctx.moveTo(0, cam.toScreenY(y));
      ctx.lineTo(cam.width, cam.toScreenY(y));
      ctx.stroke();
    }
  }

  private drawMap(): void {
    const ctx = this.ctx;
    const cam = this.camera;
    for (const poly of this.map.solids) {
      ctx.beginPath();
      for (let i = 0; i < poly.points.length; i += 2) {
        const sx = cam.toScreenX(poly.points[i]!);
        const sy = cam.toScreenY(poly.points[i + 1]!);
        if (i === 0) ctx.moveTo(sx, sy);
        else ctx.lineTo(sx, sy);
      }
      ctx.closePath();
      ctx.fillStyle = COLORS.solid[poly.material ?? 0] ?? COLORS.solid[0]!;
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.18)';
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    ctx.setLineDash([6, 4]);
    ctx.strokeStyle = COLORS.oneWay;
    ctx.lineWidth = 3;
    for (const ow of this.map.oneWays) {
      ctx.beginPath();
      ctx.moveTo(cam.toScreenX(ow.ax), cam.toScreenY(ow.ay));
      ctx.lineTo(cam.toScreenX(ow.bx), cam.toScreenY(ow.by));
      ctx.stroke();
    }
    ctx.setLineDash([]);
    ctx.fillStyle = COLORS.label;
    ctx.font = '12px ui-monospace, monospace';
    ctx.textAlign = 'center';
    for (const l of this.map.labels) ctx.fillText(l.text, cam.toScreenX(l.x), cam.toScreenY(l.y));
  }

  /**
   * Map zones (docs/02 §20): tinted by kind with a dashed outline and a label; wind and pads get a
   * drifting arrow. Event zones are a faint dotted outline until their event runs, pulse during its
   * warning (the client knows which site will open), then fill.
   */
  private drawZones(frame: Frame): void {
    if (this.zones.length === 0) return;
    const ctx = this.ctx;
    const cam = this.camera;
    const ev = frame.mapEvent;
    const now = performance.now() / 1000;
    const pulse = 0.5 + 0.5 * Math.abs(Math.sin(now * 5));
    this.zones.forEach((d, i) => {
      let state: 'on' | 'pending' | 'off' = 'on';
      if (d.zone.event !== undefined) state = ev && ev.id === d.zone.event && ev.zones.includes(i) ? (ev.phase === 'active' ? 'on' : 'pending') : 'off';
      ctx.beginPath();
      for (let k = 0; k < d.points.length; k += 2) {
        const sx = cam.toScreenX(d.points[k]!);
        const sy = cam.toScreenY(d.points[k + 1]!);
        if (k === 0) ctx.moveTo(sx, sy);
        else ctx.lineTo(sx, sy);
      }
      ctx.closePath();
      if (state === 'on') {
        ctx.fillStyle = rgba(d.color, 0.13);
        ctx.fill();
      } else if (state === 'pending') {
        ctx.fillStyle = rgba(d.color, 0.1 * pulse);
        ctx.fill();
      }
      ctx.setLineDash(state === 'off' ? [2, 7] : [8, 5]);
      ctx.lineWidth = state === 'pending' ? 2.5 : 1.5;
      ctx.strokeStyle = rgba(d.color, state === 'off' ? 0.3 : state === 'pending' ? 0.4 + 0.6 * pulse : 0.75);
      ctx.stroke();
      ctx.setLineDash([]);
      if (state === 'on' && (d.fx !== 0 || d.fy !== 0)) this.drawFlowArrow(d, now);
      ctx.fillStyle = rgba(d.color, state === 'off' ? 0.45 : 0.95);
      ctx.font = '11px ui-monospace, monospace';
      ctx.textAlign = 'center';
      const tag = state === 'off' ? ' (off)' : state === 'pending' ? ' (opening)' : '';
      ctx.fillText(`${d.label}${tag}`, cam.toScreenX(d.cx), cam.toScreenY(d.top) + 13);
    });
  }

  /** A chevron drifting along the zone's wind or launch direction. */
  private drawFlowArrow(d: ZoneDraw, now: number): void {
    const ctx = this.ctx;
    const cam = this.camera;
    const travel = ((now * 1.5) % 1) - 0.5; // −0.5 … 0.5 m along the flow
    const x = d.cx + d.fx * travel;
    const y = d.cy + d.fy * travel;
    const size = 0.45;
    // a "›" whose tip points along (fx, fy); screen y points down
    const tx = cam.toScreenX(x + d.fx * size);
    const ty = cam.toScreenY(y + d.fy * size);
    const bx = x - d.fx * size;
    const by = y - d.fy * size;
    const px = -d.fy * size;
    const py = d.fx * size;
    ctx.strokeStyle = rgba(d.color, 0.9);
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(cam.toScreenX(bx + px), cam.toScreenY(by + py));
    ctx.lineTo(tx, ty);
    ctx.lineTo(cam.toScreenX(bx - px), cam.toScreenY(by - py));
    ctx.stroke();
  }

  private capsulePath(x: number, y0: number, y1: number, r: number): void {
    const ctx = this.ctx;
    const cam = this.camera;
    const sx = cam.toScreenX(x);
    const sr = r * cam.ppm;
    const top = cam.toScreenY(y1);
    const bottom = cam.toScreenY(y0);
    ctx.beginPath();
    ctx.arc(sx, top, sr, Math.PI, 0);
    ctx.lineTo(sx + sr, bottom);
    ctx.arc(sx, bottom, sr, 0, Math.PI);
    ctx.closePath();
  }

  private drawPlayer(p: PlayerView, showHitboxes: boolean, clouds?: readonly CloudView[]): void {
    const ctx = this.ctx;
    const cam = this.camera;
    const t = this.tuningRef();
    const name = this.names.get(p.id) ?? p.name;
    if (!p.alive) {
      const sx = cam.toScreenX(p.x);
      const sy = cam.toScreenY(p.y + 0.4);
      ctx.strokeStyle = '#ff7b72';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(sx - 8, sy - 8);
      ctx.lineTo(sx + 8, sy + 8);
      ctx.moveTo(sx + 8, sy - 8);
      ctx.lineTo(sx - 8, sy + 8);
      ctx.stroke();
      ctx.fillStyle = '#8b949e';
      ctx.textAlign = 'center';
      ctx.fillText(`${name} · ${(p.respawnTicks / 60).toFixed(1)}s`, sx, sy - 14);
      return;
    }
    const r = t.capsuleRadius;
    const h = p.crouched ? t.crouchHeight : t.standHeight;
    const color = p.isLocal ? COLORS.local : p.isBot ? COLORS.bot : COLORS.enemy;

    // jet flame
    if (p.jetting) {
      const fx = cam.toScreenX(p.x - Math.cos(p.aim) * 0.05);
      const fy = cam.toScreenY(p.y + 0.35);
      const len = (0.5 + Math.random() * 0.25) * cam.ppm;
      ctx.fillStyle = 'rgba(255,166,87,0.85)';
      ctx.beginPath();
      ctx.moveTo(fx - 0.12 * cam.ppm, fy);
      ctx.lineTo(fx + 0.12 * cam.ppm, fy);
      ctx.lineTo(fx, fy + len);
      ctx.closePath();
      ctx.fill();
    }

    this.capsulePath(p.x, p.y + r, p.y + h - r, r);
    ctx.fillStyle = color + '55';
    ctx.fill();
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.stroke();

    // arm + gun along the aim
    const shoulderX = p.x + (Math.cos(p.aim) >= 0 ? 1 : -1) * t.shoulderForward;
    const shoulderY = p.y + (p.crouched ? t.shoulderCrouch : t.shoulderStand);
    const reach = 0.55;
    ctx.strokeStyle = '#e6edf3';
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(cam.toScreenX(shoulderX), cam.toScreenY(shoulderY));
    ctx.lineTo(cam.toScreenX(shoulderX + Math.cos(p.aim) * reach), cam.toScreenY(shoulderY + Math.sin(p.aim) * reach));
    ctx.stroke();
    if (p.dual) {
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(cam.toScreenX(shoulderX), cam.toScreenY(shoulderY - 0.12));
      ctx.lineTo(cam.toScreenX(shoulderX + Math.cos(p.aim) * reach), cam.toScreenY(shoulderY - 0.12 + Math.sin(p.aim) * reach));
      ctx.stroke();
    }

    if (p.meleeTicks) this.drawSwing(p, shoulderX, shoulderY);
    if (p.shield) this.drawShield(p);

    if (showHitboxes) {
      const box = p.crouched ? CROUCHED_HITBOXES : STANDING_HITBOXES;
      ctx.lineWidth = 1;
      ctx.strokeStyle = box.headIsHeadshot ? '#ff7b72' : '#e6edf3';
      ctx.beginPath();
      ctx.arc(cam.toScreenX(p.x), cam.toScreenY(p.y + box.head.y), box.head.r * cam.ppm, 0, Math.PI * 2);
      ctx.stroke();
      ctx.strokeStyle = '#3fb950';
      this.capsulePath(p.x, p.y + box.torso.y0, p.y + box.torso.y1, box.torso.r);
      ctx.stroke();
      ctx.strokeStyle = '#a5d6ff';
      this.capsulePath(p.x, p.y + box.legs.y0, p.y + box.legs.y1, box.legs.r);
      ctx.stroke();
    }

    // name + HP bar (none over a head in smoke: the tag would give the player away)
    if (!p.isLocal && inSmoke(clouds, p.x, p.y + h - r)) return;
    const sx = cam.toScreenX(p.x);
    const sy = cam.toScreenY(p.y + h + 0.25);
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.fillRect(sx - 22, sy, 44, 5);
    ctx.fillStyle = p.hp > 50 ? '#3fb950' : p.hp > 25 ? '#d29922' : '#f85149';
    ctx.fillRect(sx - 22, sy, (44 * p.hp) / defaultTuning.healthMax, 5);
    ctx.fillStyle = color;
    ctx.textAlign = 'center';
    ctx.font = '11px ui-monospace, monospace';
    ctx.fillText(name, sx, sy - 4);
    // status effects (players whose state we hold: everyone locally, ourselves online)
    const status = statusTags(p);
    if (status) {
      ctx.fillStyle = '#ffa657';
      ctx.font = 'bold 10px ui-monospace, monospace';
      ctx.fillText(status, sx, sy - 16);
    }
  }

  /**
   * Riot shield: the sim's blocking segment exactly, RIOT_SHIELD.height tall and lower when
   * crouched, coloured by the HP left when known. Up, RIOT_SHIELD.forward in front of the body;
   * slung, RIOT_SHIELD.backOffset behind it (it guards the back), a little thinner; on its way up,
   * dashed in front (it guards neither side yet).
   */
  private drawShield(p: PlayerView): void {
    const ctx = this.ctx;
    const cam = this.camera;
    const facing = Math.cos(p.aim) >= 0 ? 1 : -1;
    const front = p.shield !== 'back';
    const x = p.x + (front ? facing * RIOT_SHIELD.forward : -facing * RIOT_SHIELD.backOffset);
    const y0 = p.y + shieldBottom(p.crouched);
    ctx.save();
    ctx.lineCap = 'butt';
    ctx.strokeStyle = shieldColor(p.shieldHp) + (p.shield === 'front' ? '' : 'cc');
    ctx.lineWidth = Math.max(front ? 4 : 3, (front ? 0.07 : 0.05) * cam.ppm);
    if (p.shield === 'raising') ctx.setLineDash([5, 4]);
    ctx.beginPath();
    ctx.moveTo(cam.toScreenX(x), cam.toScreenY(y0));
    ctx.lineTo(cam.toScreenX(x), cam.toScreenY(y0 + RIOT_SHIELD.height));
    ctx.stroke();
    ctx.restore();
  }

  /** An item on the map: a riot shield standing on its edge, with its name. */
  private drawPickup(k: PickupView): void {
    const ctx = this.ctx;
    const cam = this.camera;
    const item = pickupDefs[k.def];
    if (item?.kind === 'grenades') {
      // a grenade pair: two canisters in the type's colour
      const r = 0.13 * cam.ppm;
      const sy = cam.toScreenY(k.y + 0.13);
      ctx.fillStyle = GRENADE_COLORS[item.grenade ?? FRAG.index] ?? '#e6edf3';
      ctx.strokeStyle = '#e6edf3';
      ctx.lineWidth = 1.5;
      for (const dx of [-0.17, 0.17]) {
        ctx.beginPath();
        ctx.arc(cam.toScreenX(k.x + dx), sy, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
      ctx.fillStyle = '#e6edf3';
      ctx.font = '11px ui-monospace, monospace';
      ctx.textAlign = 'center';
      ctx.fillText(item.name, cam.toScreenX(k.x), sy - r - 8);
      return;
    }
    const w = 0.34 * cam.ppm;
    const h = 0.6 * cam.ppm;
    const sx = cam.toScreenX(k.x);
    const sy = cam.toScreenY(k.y);
    ctx.fillStyle = COLORS.shield + '66';
    ctx.strokeStyle = COLORS.shield;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.rect(sx - w / 2, sy - h, w, h);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = COLORS.shield;
    ctx.font = '11px ui-monospace, monospace';
    ctx.textAlign = 'center';
    ctx.fillText(pickupDefs[k.def]?.name ?? 'item', sx, sy - h - 6);
  }

  /** Melee swing: a faint wedge over the 70° arc during the windup, then a flash as it lands. */
  private drawSwing(p: PlayerView, sx: number, sy: number): void {
    const ticks = p.meleeTicks ?? 0;
    const after = ticks - MELEE_WINDUP_TICKS;
    if (after > 8) return;
    const ctx = this.ctx;
    const cam = this.camera;
    const held = weapons[p.weapons[p.active]?.def ?? -1]; // the sim swings the active weapon
    const reach = (held?.fireMode === 'melee' ? held.range : MELEE_REACH) * cam.ppm;
    const half = ((MELEE_ARC_DEG / 2) * Math.PI) / 180;
    // canvas y points down, so the screen angle is −aim
    ctx.beginPath();
    ctx.moveTo(cam.toScreenX(sx), cam.toScreenY(sy));
    ctx.arc(cam.toScreenX(sx), cam.toScreenY(sy), reach, -p.aim - half, -p.aim + half);
    ctx.closePath();
    ctx.fillStyle = after <= 0 ? 'rgba(230,237,243,0.12)' : `rgba(255,236,150,${0.55 * (1 - after / 9)})`;
    ctx.fill();
  }

  /**
   * Rewind visualiser (docs/05 §15.3): the hitboxes the server tested a shot against (where this
   * screen showed the target), and a line to where the target really was. Fades over a second.
   */
  private drawRewind(r: RewindView): void {
    const ctx = this.ctx;
    const cam = this.camera;
    const fade = Math.max(0, 1 - r.age);
    if (fade <= 0) return;
    ctx.save();
    ctx.globalAlpha = fade;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 3]);
    for (const t of r.targets) {
      const box = t.crouched ? CROUCHED_HITBOXES : STANDING_HITBOXES;
      ctx.strokeStyle = r.clamped ? '#f85149' : t.hit ? '#ff79c6' : '#bc8cff';
      ctx.beginPath();
      ctx.arc(cam.toScreenX(t.x), cam.toScreenY(t.y + box.head.y), box.head.r * cam.ppm, 0, Math.PI * 2);
      ctx.stroke();
      this.capsulePath(t.x, t.y + box.legs.y0, t.y + box.torso.y1, box.torso.r);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(cam.toScreenX(t.x), cam.toScreenY(t.y + 0.75));
      ctx.lineTo(cam.toScreenX(t.nowX), cam.toScreenY(t.nowY + 0.75));
      ctx.stroke();
    }
    const first = r.targets[0];
    if (first) {
      ctx.setLineDash([]);
      ctx.fillStyle = ctx.strokeStyle;
      ctx.font = '10px ui-monospace, monospace';
      ctx.textAlign = 'center';
      ctx.fillText(`−${r.rewindMs.toFixed(0)} ms${r.clamped ? ' (cap)' : ''}`, cam.toScreenX(first.x), cam.toScreenY(first.y + 2.1));
    }
    ctx.restore();
  }

  private drawGrenade(g: GrenadeView): void {
    const ctx = this.ctx;
    const cam = this.camera;
    const def = grenades[g.type ?? FRAG.index] ?? FRAG;
    const sx = cam.toScreenX(g.x);
    const sy = cam.toScreenY(g.y);
    if (def.effect === 'mine') {
      // a dark puck with its state light; armed, its trigger radius
      const r = Math.max(4, def.radius * cam.ppm);
      ctx.fillStyle = '#30363d';
      ctx.fillRect(sx - r, sy - r * 0.6, 2 * r, 1.2 * r);
      ctx.fillStyle = mineLight(g.state ?? 0, performance.now(), this.reducedMotion || reduceFlashes());
      ctx.beginPath();
      ctx.arc(sx, sy, Math.max(2, r * 0.45), 0, Math.PI * 2);
      ctx.fill();
      if (g.state === MineState.Armed || g.state === MineState.Triggered) {
        ctx.setLineDash([3, 5]);
        ctx.strokeStyle = 'rgba(248,81,73,0.45)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(sx, sy, def.mine.triggerRadius * cam.ppm, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      return;
    }
    const r = Math.max(3, def.radius * cam.ppm);
    ctx.fillStyle = GRENADE_COLORS[def.index] ?? '#3fb950';
    ctx.beginPath();
    ctx.arc(sx, sy, r, 0, Math.PI * 2);
    ctx.fill();
    const total = def.fuse * 60;
    ctx.strokeStyle = '#f85149';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(sx, sy, r + 4, -Math.PI / 2, -Math.PI / 2 + (Math.PI * 2 * g.fuse) / total);
    ctx.stroke();
  }

  /** A soft disc: dense in the middle, feathered to nothing at its radius. Smoke grey, gas green-yellow. */
  private drawCloud(c: CloudView): void {
    const ctx = this.ctx;
    const cam = this.camera;
    const [r, g, b] = CLOUD_RGB[c.type] ?? [180, 180, 180];
    const sx = cam.toScreenX(c.x);
    const sy = cam.toScreenY(c.y);
    const rad = c.radius * cam.ppm;
    // smoke is nearly opaque inside its opaque radius; gas stays see-through (it's a hazard, not cover)
    const core = c.opaque > 0 ? 0.92 : 0.45;
    // the sim stops a cloud at walls: clip it to what its centre reaches (thin walls included)
    const rays = this.cloudRays(c);
    if (rays) {
      ctx.save();
      ctx.beginPath();
      for (let i = 0; i < REACH_RAYS; i++) {
        const a = (i / REACH_RAYS) * Math.PI * 2;
        const d = Math.min(rays[i]!, c.radius) * cam.ppm;
        if (i === 0) ctx.moveTo(sx + Math.cos(a) * d, sy - Math.sin(a) * d);
        else ctx.lineTo(sx + Math.cos(a) * d, sy - Math.sin(a) * d);
      }
      ctx.closePath();
      ctx.clip();
    }
    const grad = ctx.createRadialGradient(sx, sy, 0, sx, sy, rad);
    grad.addColorStop(0, `rgba(${r},${g},${b},${core * c.density})`);
    grad.addColorStop(c.opaque > 0 ? Math.min(0.95, c.opaque / c.radius) : 0.6, `rgba(${r},${g},${b},${core * 0.85 * c.density})`);
    grad.addColorStop(1, `rgba(${r},${g},${b},0)`);
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(sx, sy, rad, 0, Math.PI * 2);
    ctx.fill();
    if (c.type === GAS.index) {
      // a dashed hazard rim, so gas reads as "deadly" and not as cover
      ctx.setLineDash([5, 5]);
      ctx.strokeStyle = `rgba(214,236,60,${0.7 * c.density})`;
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.setLineDash([]);
    }
    if (rays) ctx.restore();
  }

  /** `world`: draw tracers, dash bands and blast rings (2D view and debug overlay; render3d draws its own otherwise). They age either way. */
  private drawEffects(dt: number, byId: Map<number, PlayerView>, world: boolean): void {
    const ctx = this.ctx;
    const cam = this.camera;
    for (let i = this.tracers.length - 1; i >= 0; i--) {
      const tr = this.tracers[i]!;
      tr.age += dt;
      if (tr.age > 0.12) {
        this.tracers.splice(i, 1);
        continue;
      }
      if (!world) continue;
      const a = 1 - tr.age / 0.12;
      ctx.strokeStyle = tr.ricochet ? `rgba(165,243,252,${a})` : tr.local ? `rgba(255,236,150,${a})` : `rgba(255,180,120,${a})`;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(cam.toScreenX(tr.ox), cam.toScreenY(tr.oy));
      ctx.lineTo(cam.toScreenX(tr.ex), cam.toScreenY(tr.ey));
      ctx.stroke();
      if (tr.hit) {
        ctx.fillStyle = tr.hit === 2 ? `rgba(255,123,114,${a})` : tr.hit === 3 ? `rgba(121,192,255,${a})` : `rgba(230,237,243,${a})`;
        ctx.beginPath();
        ctx.arc(cam.toScreenX(tr.ex), cam.toScreenY(tr.ey), 4, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    // dash trails: a fading band from the start along the dash, ~ its length (14 m/s × 8 ticks ≈ 1.9 m)
    for (let i = this.dashes.length - 1; i >= 0; i--) {
      const d = this.dashes[i]!;
      d.age += dt;
      if (d.age > 0.3) {
        this.dashes.splice(i, 1);
        continue;
      }
      if (!world) continue; // render3d draws dashes (the debug overlay and ?render=2d keep the band)
      const a = 1 - d.age / 0.3;
      const [ux, uy] = DASH_UNIT[d.dir] ?? DASH_UNIT[0]!;
      const len = 1.9 * Math.min(1, d.age / 0.13);
      ctx.strokeStyle = d.local ? `rgba(88,166,255,${0.6 * a})` : `rgba(240,136,62,${0.6 * a})`;
      ctx.lineWidth = 0.5 * cam.ppm;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(cam.toScreenX(d.x), cam.toScreenY(d.y + 0.75));
      ctx.lineTo(cam.toScreenX(d.x + ux * len), cam.toScreenY(d.y + 0.75 + uy * len));
      ctx.stroke();
      ctx.lineCap = 'butt';
    }
    // ricochet sparks: a short fan along the shield's normal (render3d sparks its own)
    for (let i = this.sparks.length - 1; i >= 0; i--) {
      const sp = this.sparks[i]!;
      sp.age += dt;
      if (sp.age > 0.18) {
        this.sparks.splice(i, 1);
        continue;
      }
      if (!world) continue;
      const k = sp.age / 0.18;
      const len = (0.15 + 0.35 * k) * cam.ppm;
      ctx.strokeStyle = `rgba(255,244,200,${1 - k})`;
      ctx.lineWidth = 2;
      ctx.beginPath();
      for (const spread of [-0.7, -0.25, 0.25, 0.7]) {
        const c = Math.cos(spread);
        const sn = Math.sin(spread);
        const dx = sp.nx * c - sp.ny * sn;
        const dy = sp.nx * sn + sp.ny * c;
        ctx.moveTo(cam.toScreenX(sp.x), cam.toScreenY(sp.y));
        ctx.lineTo(cam.toScreenX(sp.x) + dx * len, cam.toScreenY(sp.y) - dy * len);
      }
      ctx.stroke();
    }
    for (let i = this.bursts.length - 1; i >= 0; i--) {
      const b = this.bursts[i]!;
      b.age += dt;
      if (b.age > 0.45) {
        this.bursts.splice(i, 1);
        continue;
      }
      // render3d draws every burst over the 3D view: blasts (vfx), the flashbang's pop and the EMP's
      // ring (clouds.ts); the 2D view and the debug overlay draw them here
      if (!world) continue;
      const k = b.age / 0.45;
      const [br, bg, bb] = BURST_RGB[b.grenade] ?? BURST_RGB[FRAG.index]!;
      // a flashbang is a small pop and its ring, never a white disc: full-screen white is the fx
      // overlay's (its limiter), and "Reduce flashes" greys the pop
      const flashbang = b.grenade === FLASHBANG.index;
      const grey = flashbang && reduceFlashes();
      ctx.fillStyle = grey ? `rgba(120,124,130,${0.45 * (1 - k)})` : `rgba(${br},${bg},${bb},${(flashbang ? 0.7 : 0.5) * (1 - k)})`;
      ctx.beginPath();
      ctx.arc(cam.toScreenX(b.x), cam.toScreenY(b.y), (flashbang ? Math.min(b.r, FLASH_POP_M) : b.r) * cam.ppm * (0.3 + 0.7 * k), 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = `rgba(255,255,255,${0.6 * (1 - k)})`;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(cam.toScreenX(b.x), cam.toScreenY(b.y), b.r * cam.ppm, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.font = 'bold 13px ui-monospace, monospace';
    ctx.textAlign = 'center';
    for (let i = this.floats.length - 1; i >= 0; i--) {
      const f = this.floats[i]!;
      f.age += dt;
      if (f.age > 0.8) {
        this.floats.splice(i, 1);
        continue;
      }
      const target = byId.get(f.target);
      if (target) {
        f.x = target.x;
        f.y = target.y + 1.9;
      }
      if (Number.isNaN(f.x)) continue;
      ctx.fillStyle = f.color;
      ctx.globalAlpha = 1 - f.age / 0.8;
      ctx.fillText(f.text, cam.toScreenX(f.x), cam.toScreenY(f.y) - f.age * 30);
      ctx.globalAlpha = 1;
    }
    for (const line of this.feed) line.age += dt;
    while (this.feed.length && this.feed[0]!.age > 6) this.feed.shift();
    this.hitMarker.age += dt;
  }

  private drawReticle(): void {
    const ctx = this.ctx;
    const mx = this.mouse.x;
    const my = this.mouse.y;
    ctx.strokeStyle = '#e6edf3';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(mx, my, 7, 0, Math.PI * 2);
    ctx.moveTo(mx - 12, my);
    ctx.lineTo(mx - 4, my);
    ctx.moveTo(mx + 4, my);
    ctx.lineTo(mx + 12, my);
    ctx.moveTo(mx, my - 12);
    ctx.lineTo(mx, my - 4);
    ctx.moveTo(mx, my + 4);
    ctx.lineTo(mx, my + 12);
    ctx.stroke();
    if (this.hitMarker.age < 0.2) {
      const a = 1 - this.hitMarker.age / 0.2;
      ctx.strokeStyle = this.hitMarker.kill ? `rgba(255,123,114,${a})` : this.hitMarker.head ? `rgba(255,166,87,${a})` : `rgba(255,255,255,${a})`;
      ctx.lineWidth = this.hitMarker.kill ? 3 : 2;
      const s = this.hitMarker.kill ? 14 : 10;
      ctx.beginPath();
      ctx.moveTo(mx - s, my - s);
      ctx.lineTo(mx - 5, my - 5);
      ctx.moveTo(mx + s, my - s);
      ctx.lineTo(mx + 5, my - 5);
      ctx.moveTo(mx - s, my + s);
      ctx.lineTo(mx - 5, my + 5);
      ctx.moveTo(mx + s, my + s);
      ctx.lineTo(mx + 5, my + 5);
      ctx.stroke();
    }
  }

  /** screen-space mouse, set by main each frame */
  mouse = { x: 0, y: 0 };

  private drawHud(p: PlayerView, frame: Frame, opts: RenderOptions, help: string): void {
    const ctx = this.ctx;
    const cam = this.camera;
    const t = this.tuningRef();
    const x = 16;
    let y = cam.height - 110;

    ctx.fillStyle = 'rgba(13,17,23,0.75)';
    ctx.fillRect(x - 8, y - 18, 340, 120);
    ctx.textAlign = 'left';
    ctx.font = '12px ui-monospace, monospace';

    // health
    ctx.fillStyle = '#e6edf3';
    ctx.fillText(`HP ${p.hp.toFixed(0)}`, x, y);
    ctx.fillStyle = '#30363d';
    ctx.fillRect(x + 70, y - 10, 240, 10);
    ctx.fillStyle = p.hp > 50 ? '#3fb950' : p.hp > 25 ? '#d29922' : '#f85149';
    ctx.fillRect(x + 70, y - 10, (240 * p.hp) / t.healthMax, 10);
    y += 20;

    // fuel ("nitro"), faded while the regen delay is running
    ctx.fillStyle = '#e6edf3';
    ctx.fillText(`FUEL ${p.fuel.toFixed(0)}`, x, y);
    ctx.fillStyle = '#30363d';
    ctx.fillRect(x + 70, y - 10, 240, 10);
    ctx.fillStyle = p.fuelRegenDelay > 0 ? '#9e6a03' : p.fuel < t.fuelMinIgnite ? '#f85149' : '#58a6ff';
    ctx.fillRect(x + 70, y - 10, (240 * p.fuel) / t.fuelMax, 10);
    ctx.fillStyle = '#e6edf3';
    ctx.fillRect(x + 70 + (240 * t.fuelMinIgnite) / t.fuelMax, y - 12, 1, 14);
    y += 22;

    // weapons
    p.weapons.forEach((w, i) => {
      if (w.def === NO_WEAPON) return;
      const def = weapons[w.def]!;
      const activeSlot = p.dual || i === p.active;
      ctx.fillStyle = activeSlot ? '#e6edf3' : '#6e7681';
      const reload = w.reloadTicks > 0 ? `  reloading ${(w.reloadTicks / 60).toFixed(1)}s` : '';
      const ammo = def.fireMode === 'melee' ? ' melee' : `${String(w.mag).padStart(2)}/${w.reserve}`;
      const weight = def.moveSpeedMul !== 1 ? `  speed ×${def.moveSpeedMul.toFixed(2)}` : '';
      ctx.fillText(`${i + 1}. ${def.name.padEnd(11)} ${ammo}${reload}${weight}`, x, y + i * 16);
    });
    y += 34;
    ctx.fillStyle = '#e6edf3';
    const shield = p.shield ? `   shield ${Math.ceil(p.shieldHp ?? 0)} ${p.shield === 'front' ? 'up' : p.shield === 'back' ? 'slung' : 'raising'}` : '';
    ctx.fillText(`${p.dual ? 'DUAL  ' : ''}${grenadeLine(p)}   K ${p.kills}  D ${p.deaths}   zoom ${cam.zoom + 1}x${shield}`, x, y);
    const status = statusTags(p, true);
    if (status) {
      ctx.fillStyle = '#ffa657';
      ctx.font = 'bold 13px ui-monospace, monospace';
      ctx.fillText(status, x, cam.height - 148);
      ctx.font = '12px ui-monospace, monospace';
    }

    // kill feed
    ctx.textAlign = 'right';
    this.feed.forEach((line, i) => {
      ctx.fillStyle = `rgba(230,237,243,${Math.min(1, 6 - line.age)})`;
      ctx.fillText(line.text, cam.width - 310, 64 + i * 16);
    });

    // top-left debug block ('basic': the net graph only)
    ctx.textAlign = 'left';
    ctx.fillStyle = 'rgba(230,237,243,0.75)';
    const basic = opts.hud === 'basic';
    const lines = basic
      ? []
      : [
          `fps ${this.fps.toFixed(0)}  tick ${frame.tick}`,
          `pos ${p.x.toFixed(2)}, ${p.y.toFixed(2)}  vel ${p.vx.toFixed(2)}, ${p.vy.toFixed(2)}`,
          `${p.grounded ? 'grounded' : 'airborne'}${p.crouched ? ' · crouched' : ''}${p.jetting ? ' · jetting' : ''}`,
        ];
    if (frame.recording !== undefined) lines.push(`● REC ${(frame.recording / 60).toFixed(1)} s`);
    if (frame.mapEvent) {
      const e = frame.mapEvent;
      lines.push(`map event: ${e.name} · ${e.phase === 'warning' ? 'starts in' : 'ends in'} ${e.secondsLeft.toFixed(1)} s`);
    }
    if (opts.showNet && frame.net) {
      const n = frame.net;
      lines.push(`net: ${n.status}`, `rtt ${n.rttMs.toFixed(0)} ms · snaps ${n.snapshotsPerSec.toFixed(0)}/s · interp ${n.interpDelayMs} ms`, `in ${n.kbInPerSec.toFixed(1)} KB/s · out ${n.kbOutPerSec.toFixed(1)} KB/s`);
      const p = n.prediction;
      if (p) {
        const health = Number.isNaN(p.inputBufferHealth) ? '–' : String(p.inputBufferHealth);
        lines.push(
          `rtt jitter ${p.rttJitterMs.toFixed(1)} ms · snapshot loss ${p.snapshotLossPct.toFixed(1)}%`,
          `input buffer ${health} ticks · rate ×${p.timeScale.toFixed(3)} · unacked ${p.unackedTicks}${p.resyncs ? ` · resyncs ${p.resyncs}` : ''}`,
          `corrections ${p.correctionsPerMin.toFixed(1)}/min · mispredicts ${p.mispredictionsPerMin.toFixed(1)}/min · last ${p.lastErrorCm.toFixed(1)} cm`,
          `netsim ${p.netSim}${p.lowBandwidth ? ' · LOW-BANDWIDTH MODE (30 Hz inputs, 15 Hz snapshots)' : ''}`,
        );
        if (p.suggestLowBandwidth) lines.push('⚠ heavy packet loss: try low-bandwidth mode (panel → Network)');
      }
    }
    lines.forEach((l, i) => ctx.fillText(l, 12, (basic ? 70 : 22) + i * 16));

    if (basic) return;
    ctx.fillStyle = 'rgba(230,237,243,0.45)';
    ctx.fillText(help, 12, cam.height - 128);
  }
}
