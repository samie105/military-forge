/**
 * The minimap's drawing: a side view of the whole level (the game is 2.5D, so the map is its cross
 * section), fitted into a box. The level's silhouette (solids, slabs, zones, tiers) is drawn once
 * per map and size into its own canvas (`drawSilhouette`); each frame only blits it and draws the
 * dots on top (`drawDots`): you and the way you aim, what's on screen, pickups, allies, and the
 * enemy marks EnemyIntel allows.
 */
import { MARK_COLOURS } from '../teams/marking';
import { ZONE_KINDS, mapTiers, pickups, POWER_WEAPONS, weapons, zonePoints, type MapDef } from '@military-forge/content';
import type { IntelMark } from './intel';

/** A box the level is fitted into (px), and the world → box transform. */
export interface Fit {
  /** px per metre */
  scale: number;
  /** box px of world x = 0 / y = 0 (y grows down on screen) */
  ox: number;
  oy: number;
}

/**
 * Fits the map's bounds into a w × h box with `pad` px all round, centred; `zoom` ≥ 1 magnifies about
 * the world point (cx, cy), which the box's centre then shows (clamped so the level fills the box).
 */
export function fitMap(map: MapDef, w: number, h: number, pad = 4, zoom = 1, cx?: number, cy?: number): Fit {
  const b = map.bounds;
  const bw = b.maxX - b.minX;
  const bh = b.maxY - b.minY;
  const base = Math.min((w - 2 * pad) / bw, (h - 2 * pad) / bh);
  const scale = base * Math.max(1, zoom);
  const midX = (b.minX + b.maxX) / 2;
  const midY = (b.minY + b.maxY) / 2;
  let fx = cx ?? midX;
  let fy = cy ?? midY;
  // keep the level over the box: a centre no closer to an edge than half the box shows
  const halfW = w / 2 / scale;
  const halfH = h / 2 / scale;
  fx = halfW * 2 >= bw ? midX : Math.max(b.minX + halfW, Math.min(b.maxX - halfW, fx));
  fy = halfH * 2 >= bh ? midY : Math.max(b.minY + halfH, Math.min(b.maxY - halfH, fy));
  return { scale, ox: w / 2 - fx * scale, oy: h / 2 + fy * scale };
}

export const toBoxX = (f: Fit, x: number) => f.ox + x * f.scale;
export const toBoxY = (f: Fit, y: number) => f.oy - y * f.scale;
export const toWorldX = (f: Fit, px: number) => (px - f.ox) / f.scale;
export const toWorldY = (f: Fit, py: number) => (f.oy - py) / f.scale;

/** The colours, from the kit's tokens (read once from CSS; these are the kit's values). */
export interface Palette {
  ink: string;
  band: string;
  solid: string;
  slab: string;
  line: string;
  you: string;
  enemy: string;
  ally: string;
  power: string;
  item: string;
  updraft: string;
  thinAir: string;
  view: string;
}

export const DEFAULT_PALETTE: Palette = {
  ink: '#070806',
  band: 'rgba(163,173,120,.07)',
  solid: '#a3ad78',
  slab: '#ece3c8',
  line: 'rgba(236,227,200,.28)',
  // who's who: the soldiers' own marking colours (teams/marking.ts)
  you: MARK_COLOURS.standard.self,
  enemy: MARK_COLOURS.standard.enemy,
  ally: MARK_COLOURS.standard.ally,
  power: '#d9b25f',
  item: '#ece3c8',
  updraft: '#d6ff3b',
  thinAir: '#c9d1d9',
  view: 'rgba(236,227,200,.55)',
};

/**
 * The colour-blind modes (Settings → Accessibility, the team pairs of Settings.tsx CB): enemies
 * and allies take that mode's pair. Shapes carry the meaning too (you a chevron, enemies diamonds,
 * allies circles, sounds rings), so no mark depends on its colour alone.
 */
export function paletteFor(mode: 'standard' | 'deutan' | 'tritan', base: Palette = DEFAULT_PALETTE): Palette {
  if (mode === 'standard') return base;
  const m = MARK_COLOURS[mode];
  return { ...base, enemy: m.enemy, ally: m.ally };
}

function polygon(ctx: CanvasRenderingContext2D, f: Fit, pts: readonly number[]): void {
  ctx.beginPath();
  for (let i = 0; i < pts.length; i += 2) {
    const x = toBoxX(f, pts[i]!);
    const y = toBoxY(f, pts[i + 1]!);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
}

/**
 * The level, once per map and box size: tier bands, zones (updrafts as rising columns with chevrons,
 * thin air hatched, the rest tinted by kind), solids filled, slabs as lines you can fly up through.
 * `ctx` is already scaled for the device pixel ratio; w × h in CSS px.
 */
export function drawSilhouette(ctx: CanvasRenderingContext2D, map: MapDef, f: Fit, w: number, h: number, pal: Palette = DEFAULT_PALETTE): void {
  ctx.clearRect(0, 0, w, h);
  const b = map.bounds;
  const x0 = toBoxX(f, b.minX);
  const x1 = toBoxX(f, b.maxX);
  // tiers: alternate bands, with a hairline on each tier's floor
  const tiers = mapTiers(map);
  if (tiers) {
    for (let i = 0; i < tiers.length; i++) {
      const top = i + 1 < tiers.length ? tiers[i + 1]!.y : b.maxY;
      const bottom = i === 0 ? b.minY : tiers[i]!.y;
      if (i % 2 === 1) {
        ctx.fillStyle = pal.band;
        ctx.fillRect(x0, toBoxY(f, top), x1 - x0, toBoxY(f, bottom) - toBoxY(f, top));
      }
      if (i > 0) {
        ctx.strokeStyle = pal.line;
        ctx.lineWidth = 1;
        ctx.setLineDash([2, 3]);
        ctx.beginPath();
        ctx.moveTo(x0, Math.round(toBoxY(f, tiers[i]!.y)) + 0.5);
        ctx.lineTo(x1, Math.round(toBoxY(f, tiers[i]!.y)) + 0.5);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }
  }
  // zones under the geometry
  for (const z of map.zones ?? []) {
    if (z.event) continue; // event zones come and go
    const pts = zonePoints(z);
    if (z.kind === 'updraft') {
      ctx.globalAlpha = 0.16;
      ctx.fillStyle = pal.updraft;
      polygon(ctx, f, pts);
      ctx.fill();
      ctx.globalAlpha = 0.85;
      ctx.strokeStyle = pal.updraft;
      ctx.lineWidth = Math.max(1, f.scale * 0.5);
      // chevrons up the column's middle, every ~6 m
      let minX = Infinity;
      let maxX = -Infinity;
      let minY = Infinity;
      let maxY = -Infinity;
      for (let i = 0; i < pts.length; i += 2) {
        minX = Math.min(minX, pts[i]!);
        maxX = Math.max(maxX, pts[i]!);
        minY = Math.min(minY, pts[i + 1]!);
        maxY = Math.max(maxY, pts[i + 1]!);
      }
      const cx = toBoxX(f, (minX + maxX) / 2);
      const half = Math.max(2, Math.min(5, ((maxX - minX) * f.scale) / 2.5));
      for (let y = minY + 3; y < maxY - 1; y += 6) {
        const py = toBoxY(f, y);
        ctx.beginPath();
        ctx.moveTo(cx - half, py + half * 0.7);
        ctx.lineTo(cx, py);
        ctx.lineTo(cx + half, py + half * 0.7);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    } else if (z.kind === 'thinAir') {
      ctx.save();
      polygon(ctx, f, pts);
      ctx.clip();
      ctx.globalAlpha = 0.22;
      ctx.strokeStyle = pal.thinAir;
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let x = x0 - h; x < x1 + h; x += 6) {
        ctx.moveTo(x, h);
        ctx.lineTo(x + h, 0);
      }
      ctx.stroke();
      ctx.restore();
      ctx.globalAlpha = 1;
    } else {
      ctx.globalAlpha = 0.14;
      ctx.fillStyle = `#${(ZONE_KINDS[z.kind]?.color ?? 0x8b949e).toString(16).padStart(6, '0')}`;
      polygon(ctx, f, pts);
      ctx.fill();
      ctx.globalAlpha = 1;
    }
  }
  // the solids
  ctx.fillStyle = pal.solid;
  ctx.globalAlpha = 0.62;
  for (const s of map.solids) {
    polygon(ctx, f, s.points);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  // slabs: you fly up through them and drop down through them
  ctx.strokeStyle = pal.slab;
  ctx.lineWidth = Math.max(1, Math.min(2, f.scale * 0.35));
  ctx.lineCap = 'round';
  ctx.beginPath();
  for (const o of map.oneWays) {
    ctx.moveTo(toBoxX(f, o.ax), toBoxY(f, o.ay));
    ctx.lineTo(toBoxX(f, o.bx), toBoxY(f, o.by));
  }
  ctx.stroke();
  ctx.lineCap = 'butt';
}

export interface DotsInput {
  /** you: feet and aim (radians) */
  me: { x: number; y: number; aim: number; alive: boolean } | null;
  /** what's on your screen (world rect) */
  view: { minX: number; minY: number; maxX: number; maxY: number } | null;
  allies: readonly { x: number; y: number }[];
  items: readonly { x: number; y: number; def: number }[];
  marks: readonly IntelMark[];
  /** 0–1 for the pulse on fresh marks; constant under Reduce motion */
  pulse: number;
}

/** What a pickup is, for its dot: a power weapon (brass), another weapon, or an item. */
export function itemKind(def: number): 'power' | 'weapon' | 'item' {
  const p = pickups[def];
  if (p?.kind !== 'weapon') return 'item';
  return POWER_WEAPONS.has(weapons[p.weapon!]?.id ?? '') ? 'power' : 'weapon';
}

/** Per frame: the dots over the silhouette. Sizes are in CSS px (`unit` scales them for the big map). */
export function drawDots(ctx: CanvasRenderingContext2D, f: Fit, d: DotsInput, pal: Palette = DEFAULT_PALETTE, unit = 1): void {
  // what's on screen
  if (d.view) {
    ctx.strokeStyle = pal.view;
    ctx.lineWidth = 1;
    const x = toBoxX(f, d.view.minX);
    const y = toBoxY(f, d.view.maxY);
    ctx.strokeRect(Math.round(x) + 0.5, Math.round(y) + 0.5, Math.round((d.view.maxX - d.view.minX) * f.scale), Math.round((d.view.maxY - d.view.minY) * f.scale));
  }
  // pickups: a diamond for power weapons, a square for guns, a dot for items
  for (const it of d.items) {
    const x = toBoxX(f, it.x);
    const y = toBoxY(f, it.y + 0.5);
    const k = itemKind(it.def);
    ctx.fillStyle = k === 'power' ? pal.power : pal.item;
    ctx.globalAlpha = k === 'item' ? 0.75 : 0.9;
    const r = (k === 'power' ? 2.6 : 1.8) * unit;
    ctx.beginPath();
    if (k === 'power') {
      ctx.moveTo(x, y - r);
      ctx.lineTo(x + r, y);
      ctx.lineTo(x, y + r);
      ctx.lineTo(x - r, y);
    } else if (k === 'weapon') ctx.rect(x - r, y - r, 2 * r, 2 * r);
    else ctx.arc(x, y, r * 0.8, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  // allies: circles
  ctx.fillStyle = pal.ally;
  for (const a of d.allies) {
    ctx.beginPath();
    ctx.arc(toBoxX(f, a.x), toBoxY(f, a.y + 0.9), 2.4 * unit, 0, Math.PI * 2);
    ctx.fill();
  }
  // enemies: seen = a filled diamond, last seen = a hollow one, heard = a ring; all fade
  for (const m of d.marks) {
    const x = toBoxX(f, m.x);
    const y = toBoxY(f, m.y + 0.9);
    ctx.globalAlpha = Math.max(0, Math.min(1, m.alpha));
    ctx.strokeStyle = pal.enemy;
    ctx.fillStyle = pal.enemy;
    if (m.kind === 'heard') {
      ctx.lineWidth = 1.2 * unit;
      ctx.beginPath();
      ctx.arc(x, y, Math.max(0, (2.6 + 2.2 * (1 - m.alpha) + d.pulse) * unit), 0, Math.PI * 2);
      ctx.stroke();
      continue;
    }
    const r = 3 * unit;
    ctx.beginPath();
    ctx.moveTo(x, y - r);
    ctx.lineTo(x + r, y);
    ctx.lineTo(x, y + r);
    ctx.lineTo(x - r, y);
    ctx.closePath();
    if (m.kind === 'seen') {
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.strokeStyle = pal.ink;
      ctx.lineWidth = 1;
      ctx.stroke();
    } else {
      ctx.lineWidth = 1.3 * unit;
      ctx.stroke();
    }
  }
  ctx.globalAlpha = 1;
  // you: a chevron the way you aim, ringed
  if (d.me) {
    const x = toBoxX(f, d.me.x);
    const y = toBoxY(f, d.me.y + 0.9);
    const r = 4.2 * unit;
    const a = d.me.alive ? d.me.aim : -Math.PI / 2;
    const cos = Math.cos(a);
    const sin = -Math.sin(a); // world up is screen down
    ctx.fillStyle = d.me.alive ? pal.you : pal.view;
    ctx.strokeStyle = pal.ink;
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(x + cos * r * 1.25, y + sin * r * 1.25);
    ctx.lineTo(x - cos * r * 0.75 - sin * r * 0.8, y - sin * r * 0.75 + cos * r * 0.8);
    ctx.lineTo(x - cos * r * 0.35, y - sin * r * 0.35);
    ctx.lineTo(x - cos * r * 0.75 + sin * r * 0.8, y - sin * r * 0.75 - cos * r * 0.8);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  }
}
