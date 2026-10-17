/**
 * Canvas-2D debug renderer (Phase 0: programmer art on purpose, docs/12 §2). Draws the map,
 * capsules, hitboxes, aim, grenades, tracers/explosions, and a HUD.
 */
import {
  CROUCHED_HITBOXES,
  FRAG,
  HitZone,
  NO_WEAPON,
  STANDING_HITBOXES,
  defaultTuning,
  weapons,
  type MapDef,
  type Tuning,
} from '@military-forge/content';
import { DamageSource, MELEE_ARC_DEG, MELEE_REACH, MELEE_WINDUP_TICKS, type SimEvent } from '@military-forge/sim';
import type { Camera } from './camera';
import type { Frame, PlayerView, RewindView } from './view';

interface Tracer {
  ox: number;
  oy: number;
  ex: number;
  ey: number;
  hit: number;
  age: number;
  local: boolean;
}

interface Burst {
  x: number;
  y: number;
  r: number;
  age: number;
}

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
   * 3D mode (render3d): this canvas is a transparent layer over the WebGL view. HUD, reticle and 2D
   * effects always; the world layers (map outline, capsules, hitboxes) are the debug overlay, drawn
   * while hitboxes (H) or the grid (B) are on.
   */
  overlay?: boolean;
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
};

export class Renderer {
  private readonly ctx: CanvasRenderingContext2D;
  private readonly tracers: Tracer[] = [];
  private readonly bursts: Burst[] = [];
  private readonly floats: FloatText[] = [];
  private readonly feed: FeedLine[] = [];
  private hitMarker = { age: 1, head: false, kill: false };
  private names = new Map<number, string>();
  private fps = 60;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly camera: Camera,
    private readonly map: MapDef,
    private readonly tuningRef: () => Tuning,
  ) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas not supported');
    this.ctx = ctx;
  }

  setNames(names: Map<number, string>): void {
    this.names = names;
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
    for (const e of events) {
      switch (e.type) {
        case 'shot':
          this.tracers.push({ ox: e.ox, oy: e.oy, ex: e.ex, ey: e.ey, hit: e.hit, age: 0, local: e.shooter === localId });
          break;
        case 'explosion':
          this.bursts.push({ x: e.x, y: e.y, r: e.radius, age: 0 });
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
          const how =
            e.source === DamageSource.Grenade ? 'frag' : e.source === DamageSource.World ? 'fell' : e.source === DamageSource.Melee ? 'melee' : (weapons[e.source]?.name ?? '?');
          this.feed.push({ text: e.killer === e.victim ? `${victim} ✝ (${how})` : `${killer} ▸ ${victim} (${how})`, age: 0 });
          if (this.feed.length > 6) this.feed.shift();
          if (e.killer === localId && e.victim !== localId) this.hitMarker = { age: 0, head: false, kill: true };
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

    // floating damage numbers follow their target
    const byId = new Map(frame.players.map((p) => [p.id, p]));
    for (const p of frame.players) this.drawPlayer(p, opts.showHitboxes);
    if (opts.showHitboxes && frame.rewinds) for (const r of frame.rewinds) this.drawRewind(r);
    for (const g of frame.grenades) this.drawGrenade(g.x, g.y, g.fuse);
    this.drawEffects(dt, byId);
    ctx.globalAlpha = 1;
    this.drawLetterbox();

    const local = byId.get(frame.localId);
    if (local) this.drawHud(local, frame, opts, help);
    this.drawReticle();
  }

  /** Overlay without the debug world layers: 2D effects (until render3d's VFX), HUD and reticle. */
  private drawOverlayHud(frame: Frame, dt: number, opts: RenderOptions, help: string): void {
    const byId = new Map(frame.players.map((p) => [p.id, p]));
    this.drawEffects(dt, byId);
    this.drawLetterbox();
    const local = byId.get(frame.localId);
    if (local) this.drawHud(local, frame, opts, help);
    this.drawReticle();
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

  private drawPlayer(p: PlayerView, showHitboxes: boolean): void {
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

    // name + HP bar
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

  private drawGrenade(x: number, y: number, fuse: number): void {
    const ctx = this.ctx;
    const cam = this.camera;
    const sx = cam.toScreenX(x);
    const sy = cam.toScreenY(y);
    const r = Math.max(3, FRAG.radius * cam.ppm);
    ctx.fillStyle = '#3fb950';
    ctx.beginPath();
    ctx.arc(sx, sy, r, 0, Math.PI * 2);
    ctx.fill();
    const total = FRAG.fuse * 60;
    ctx.strokeStyle = '#f85149';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(sx, sy, r + 4, -Math.PI / 2, -Math.PI / 2 + (Math.PI * 2 * fuse) / total);
    ctx.stroke();
  }

  private drawEffects(dt: number, byId: Map<number, PlayerView>): void {
    const ctx = this.ctx;
    const cam = this.camera;
    for (let i = this.tracers.length - 1; i >= 0; i--) {
      const tr = this.tracers[i]!;
      tr.age += dt;
      if (tr.age > 0.12) {
        this.tracers.splice(i, 1);
        continue;
      }
      const a = 1 - tr.age / 0.12;
      ctx.strokeStyle = tr.local ? `rgba(255,236,150,${a})` : `rgba(255,180,120,${a})`;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(cam.toScreenX(tr.ox), cam.toScreenY(tr.oy));
      ctx.lineTo(cam.toScreenX(tr.ex), cam.toScreenY(tr.ey));
      ctx.stroke();
      if (tr.hit) {
        ctx.fillStyle = tr.hit === 2 ? `rgba(255,123,114,${a})` : `rgba(230,237,243,${a})`;
        ctx.beginPath();
        ctx.arc(cam.toScreenX(tr.ex), cam.toScreenY(tr.ey), 4, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    for (let i = this.bursts.length - 1; i >= 0; i--) {
      const b = this.bursts[i]!;
      b.age += dt;
      if (b.age > 0.45) {
        this.bursts.splice(i, 1);
        continue;
      }
      const k = b.age / 0.45;
      ctx.fillStyle = `rgba(255,166,87,${0.5 * (1 - k)})`;
      ctx.beginPath();
      ctx.arc(cam.toScreenX(b.x), cam.toScreenY(b.y), b.r * cam.ppm * (0.3 + 0.7 * k), 0, Math.PI * 2);
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
    ctx.fillText(`${p.dual ? 'DUAL  ' : ''}frags ${p.frags}   K ${p.kills}  D ${p.deaths}   zoom ${cam.zoom + 1}x`, x, y);

    // kill feed
    ctx.textAlign = 'right';
    this.feed.forEach((line, i) => {
      ctx.fillStyle = `rgba(230,237,243,${Math.min(1, 6 - line.age)})`;
      ctx.fillText(line.text, cam.width - 310, 64 + i * 16);
    });

    // top-left debug block
    ctx.textAlign = 'left';
    ctx.fillStyle = 'rgba(230,237,243,0.75)';
    const lines = [
      `fps ${this.fps.toFixed(0)}  tick ${frame.tick}`,
      `pos ${p.x.toFixed(2)}, ${p.y.toFixed(2)}  vel ${p.vx.toFixed(2)}, ${p.vy.toFixed(2)}`,
      `${p.grounded ? 'grounded' : 'airborne'}${p.crouched ? ' · crouched' : ''}${p.jetting ? ' · jetting' : ''}`,
    ];
    if (frame.recording !== undefined) lines.push(`● REC ${(frame.recording / 60).toFixed(1)} s`);
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
    lines.forEach((l, i) => ctx.fillText(l, 12, 22 + i * 16));

    ctx.fillStyle = 'rgba(230,237,243,0.45)';
    ctx.fillText(help, 12, cam.height - 128);
  }
}
