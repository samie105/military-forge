/**
 * The Weapons Forge's explosion art, when it is published (`assets/vfx/explosions.vfx.json`, built
 * by art/pipeline/build_explosions.py):
 *
 *   { "atlas": "explosion_atlas.webp", "atlasSize": [2048, 1024], "cell": [256, 256], "blend": "normal",
 *     "flipbooks": { "frag": { "cellM": 4.035, "anchorUV": [0.5, 0.5], "fps": 18, "frames": 16, "firstCell": [0, 0] } },
 *     "styles": { "frag": { "flipbook": "frag", "scale": 1, "radiusM": 4,
 *       "shockwave": { "fromM": 0.3, "toM": 4, "ms": 220, "tint": "#fff6e0", "opacity": 0.85 },
 *       "light": { "color": "#ffcf80", "ms": 160, … }, "cameraShake": { "amplitudeM": 0.35, "fullWithinM": 4, "zeroAtM": 14, … } } } }
 *
 * A flipbook's frames fill a block of cells from `firstCell`, row by row: `cols` per row when the
 * entry gives it (or `grid: [cols, rows]`), else a square block (4 × 4 for 16);
 * cells count from the atlas's top-left. `anchorUV` is the blast point in the cell (u from the left,
 * v from the top). Sizes are for the style's `radiusM` and scale with the blast. Anything missing or
 * malformed keeps the procedural effect.
 */
import { Color, SRGBColorSpace, TextureLoader, type Texture } from 'three';
import { CASING_KINDS, EJECT_MODES, type CasingArt, type CasingKind, type EjectMode, type GunEject } from './casings';

export interface FlipbookArt {
  atlas: string;
  /** cells per row, rows */
  grid: [number, number];
  /** the atlas cell of each frame */
  frames: number[];
  fps: number;
  /** quad width for the style's radius */
  sizeM: number;
  /** quad height / width */
  aspect: number;
  blend: 'additive' | 'alpha';
  /** the blast point in the cell: u from the left, v from the top */
  anchorU: number;
  anchorV: number;
}

export interface ExplosionArt {
  /** the radius the sizes below are for */
  radiusM: number;
  book: FlipbookArt | null;
  shockwave: { fromM: number; toM: number; seconds: number; tint: [number, number, number]; opacity: number } | null;
  light: { color: Color; seconds: number } | null;
  shake: { amplitudeM: number; fullWithinM: number; zeroAtM: number } | null;
}

const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const rec = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const pair = (v: unknown): v is [number, number] => Array.isArray(v) && v.length === 2 && v.every(num);

/** An atlas of equal cells: its file and grid, or null. */
export function parseAtlas(atlas: unknown, atlasSize: unknown, cell: unknown): { atlas: string; grid: [number, number]; aspect: number } | null {
  if (typeof atlas !== 'string' || !atlas || atlas.includes('..') || atlas.includes('/')) return null;
  if (!pair(atlasSize) || !pair(cell) || !(cell[0] > 0 && cell[1] > 0)) return null;
  const grid: [number, number] = [Math.floor(atlasSize[0] / cell[0]), Math.floor(atlasSize[1] / cell[1])];
  return grid[0] >= 1 && grid[1] >= 1 ? { atlas, grid, aspect: cell[1] / cell[0] } : null;
}

/** sRGB "#rrggbb" → linear RGB */
export function linear(hex: unknown, fallback: [number, number, number]): [number, number, number] {
  if (typeof hex !== 'string' || !/^#[0-9a-f]{6}$/i.test(hex)) return fallback;
  const c = new Color(hex);
  return [c.r, c.g, c.b];
}

/** One style's art from a parsed explosions.vfx.json (null when it has nothing usable). */
export function parseExplosionManifest(json: unknown, style = 'frag'): ExplosionArt | null {
  const root = rec(json);
  const s = rec(rec(root?.styles)?.[style]);
  if (!root || !s) return null;
  const scale = num(s.scale) && s.scale > 0 ? s.scale : 1;
  let book: FlipbookArt | null = null;
  const sheet = parseAtlas(root.atlas, root.atlasSize, root.cell);
  const fb = rec(rec(root.flipbooks)?.[typeof s.flipbook === 'string' ? s.flipbook : '']);
  if (sheet && fb && num(fb.cellM) && fb.cellM > 0 && num(fb.fps) && fb.fps > 0 && num(fb.frames) && fb.frames >= 1 && pair(fb.firstCell)) {
    const count = Math.floor(fb.frames);
    // frames per row of the block: the manifest's `cols` (or `grid: [cols, rows]`) when it gives
    // one, else a square block (the published 16-frame sheets are 4 × 4)
    const given = num(fb.cols) ? fb.cols : pair(fb.grid) ? fb.grid[0] : 0;
    const block = given >= 1 ? Math.floor(given) : Math.max(1, Math.round(Math.sqrt(count)));
    const [c0, r0] = fb.firstCell;
    const frames: number[] = [];
    for (let k = 0; k < count; k++) {
      const col = c0 + (k % block);
      const row = r0 + Math.floor(k / block);
      if (col < 0 || row < 0 || col >= sheet.grid[0] || row >= sheet.grid[1]) break;
      frames.push(row * sheet.grid[0] + col);
    }
    const anchor = pair(fb.anchorUV) ? fb.anchorUV : [0.5, 0.5];
    if (frames.length === count)
      book = {
        atlas: sheet.atlas,
        grid: sheet.grid,
        frames,
        fps: fb.fps,
        sizeM: fb.cellM * scale,
        aspect: sheet.aspect,
        blend: root.blend === 'additive' ? 'additive' : 'alpha',
        anchorU: Math.min(1, Math.max(0, anchor[0])),
        anchorV: Math.min(1, Math.max(0, anchor[1])),
      };
  }
  const sw = rec(s.shockwave);
  const light = rec(s.light);
  const lc = linear(light?.color, [1, 0.8, 0.5]);
  const shake = rec(s.cameraShake);
  const art: ExplosionArt = {
    radiusM: num(s.radiusM) && s.radiusM > 0 ? s.radiusM : 4,
    book,
    shockwave:
      sw && num(sw.fromM) && num(sw.toM) && num(sw.ms) && sw.toM > 0 && sw.ms > 0
        ? { fromM: sw.fromM, toM: sw.toM, seconds: sw.ms / 1000, tint: linear(sw.tint, [1, 0.95, 0.85]), opacity: num(sw.opacity) ? sw.opacity : 0.85 }
        : null,
    light: light && num(light.ms) && light.ms > 0 ? { color: new Color(lc[0], lc[1], lc[2]), seconds: light.ms / 1000 } : null,
    shake:
      shake && num(shake.amplitudeM) && num(shake.fullWithinM) && num(shake.zeroAtM) && shake.zeroAtM > shake.fullWithinM
        ? { amplitudeM: shake.amplitudeM, fullWithinM: shake.fullWithinM, zeroAtM: shake.zeroAtM }
        : null,
  };
  return art.book || art.shockwave || art.light || art.shake ? art : null;
}

/**
 * Fetches explosions.vfx.json and its atlas. Any failure (no file yet, a bad entry, a missing
 * image) resolves to null, or to the art without its flipbook: the procedural effects stay.
 */
export async function loadExplosionArt(baseUrl: string): Promise<{ art: ExplosionArt; texture: Texture | null } | null> {
  try {
    const res = await fetch(`${baseUrl}assets/vfx/explosions.vfx.json`);
    // a dev server answers unknown paths with index.html: only JSON counts
    if (!res.ok || !(res.headers.get('content-type') ?? '').includes('json')) return null;
    const art = parseExplosionManifest(await res.json());
    if (!art) return null;
    let texture: Texture | null = null;
    if (art.book) {
      try {
        texture = await new TextureLoader().loadAsync(`${baseUrl}assets/vfx/${art.book.atlas}`);
        texture.colorSpace = SRGBColorSpace;
      } catch (err) {
        console.warn(`render3d: ${art.book.atlas} failed to load, keeping the procedural fireball`, err);
        art.book = null;
      }
    }
    return { art, texture };
  } catch {
    return null;
  }
}

// ---------- weapon fire: the Forge's weapons.vfx.json ----------

export interface FlashStyle {
  /** atlas cells, one picked per shot */
  frames: number[];
  widthM: number;
  heightM: number;
  /** where the muzzle sits along the quad's width (0 left … 1 right; the flash blasts toward +U) */
  originU: number;
  seconds: number;
  light: { color: Color; intensity: number; rangeM: number } | null;
  scale: [number, number];
  rollRad: number;
  flipV: boolean;
}

export interface TracerStyle {
  /** linear RGB */
  tint: [number, number, number];
  widthM: number;
  lengthM: number;
  speedMps: number;
  /** one tracer every N shots */
  every: number;
  /** a smoke line left behind (snipers) */
  trail: { tint: [number, number, number]; widthM: number; seconds: number } | null;
}

export interface WeaponFxEntry {
  flash: string | null;
  flashScale: number;
  tracer: string | null;
}

export interface WeaponVfxArt {
  atlas: string;
  grid: [number, number];
  flashes: Record<string, FlashStyle>;
  tracers: Record<string, TracerStyle>;
  /** by weapon id (packages/content `WeaponDef.id`) */
  weapons: Record<string, WeaponFxEntry>;
  /** spent casings (vfx/casings.ts) */
  casings: CasingArt;
}

/**
 * weapons.vfx.json's casings: `casings.types[kind]` {node, speedMps, coneDeg, spinRps, lifeMs} and,
 * per weapon, `casing` (a kind or null), `eject` (shot, pump, bolt, reload or null), `ejectDelayMs`
 * and `ejectCount`. A weapon with no `casing` key isn't listed (vfx/casings.ts goes by its class).
 */
export function parseCasings(raw: unknown, weapons: Record<string, unknown>): CasingArt {
  const c = rec(raw);
  const types: CasingArt['types'] = {};
  for (const kind of CASING_KINDS) {
    const t = rec(rec(c?.types)?.[kind]);
    if (!t || !num(t.speedMps) || !num(t.lifeMs) || t.lifeMs <= 0) continue;
    types[kind] = {
      node: typeof t.node === 'string' ? t.node : null,
      speed: t.speedMps,
      cone: ((num(t.coneDeg) ? t.coneDeg : 15) * Math.PI) / 180,
      spin: num(t.spinRps) ? t.spinRps : 15,
      life: t.lifeMs / 1000,
    };
  }
  const byWeapon: Record<string, GunEject | null> = {};
  for (const [id, entry] of Object.entries(weapons)) {
    const w = rec(entry);
    if (!w || !('casing' in w)) continue;
    const kind = w.casing as CasingKind;
    const mode = w.eject as EjectMode;
    byWeapon[id] =
      CASING_KINDS.includes(kind) && EJECT_MODES.includes(mode)
        ? { kind, mode, delay: num(w.ejectDelayMs) ? Math.max(0, w.ejectDelayMs) / 1000 : 0, count: num(w.ejectCount) ? Math.max(1, Math.round(w.ejectCount)) : 1 }
        : null;
  }
  return { file: typeof c?.file === 'string' ? c.file : 'casings.glb', types, weapons: byWeapon };
}

/** Validates weapons.vfx.json; null (or a style left out) keeps the procedural effect. */
export function parseWeaponVfx(json: unknown): WeaponVfxArt | null {
  const root = rec(json);
  const flash = rec(root?.flash);
  const tracer = rec(root?.tracer);
  const weapons = rec(root?.weapons);
  if (!root || !flash || !weapons) return null;
  const sheet = parseAtlas(flash.atlas, flash.atlasSize, flash.cell);
  if (!sheet) return null;
  const cells = sheet.grid[0] * sheet.grid[1];
  const flashes: Record<string, FlashStyle> = {};
  for (const [name, raw] of Object.entries(rec(flash.styles) ?? {})) {
    const s = rec(raw);
    const quad = rec(s?.quad);
    const frames = s?.frames;
    if (!s || !quad || !Array.isArray(frames) || !frames.length || !frames.every((f) => num(f) && Number.isInteger(f) && f >= 0 && f < cells)) continue;
    if (!num(quad.widthM) || !num(quad.heightM) || quad.widthM <= 0 || quad.heightM <= 0) continue;
    const light = rec(s.light);
    const jitter = rec(s.jitter);
    const scale = jitter?.scale;
    flashes[name] = {
      frames: frames as number[],
      widthM: quad.widthM,
      heightM: quad.heightM,
      originU: num(quad.originU) ? Math.min(1, Math.max(0, quad.originU)) : 0,
      seconds: num(s.ms) && s.ms > 0 ? s.ms / 1000 : 0.05,
      light: light && num(light.intensity) && num(light.rangeM) ? { color: new Color(typeof light.color === 'string' ? light.color : '#ffd890'), intensity: light.intensity, rangeM: light.rangeM } : null,
      scale: Array.isArray(scale) && scale.length === 2 && scale.every(num) ? [scale[0], scale[1]] : [1, 1],
      rollRad: num(jitter?.rollDeg) ? (jitter.rollDeg * Math.PI) / 180 : 0,
      flipV: jitter?.flipV === true,
    };
  }
  const tracers: Record<string, TracerStyle> = {};
  for (const [name, raw] of Object.entries(rec(tracer?.styles) ?? {})) {
    const s = rec(raw);
    if (!s || !num(s.widthM) || !num(s.lengthM) || !num(s.speedMps) || s.widthM <= 0 || s.lengthM <= 0 || s.speedMps <= 0) continue;
    const trail = rec(s.trail);
    tracers[name] = {
      tint: linear(s.tint, [1, 0.95, 0.75]),
      widthM: s.widthM,
      lengthM: s.lengthM,
      speedMps: s.speedMps,
      every: num(s.every) && s.every >= 1 ? Math.round(s.every) : 1,
      trail: trail && num(trail.widthM) && num(trail.fadeMs) ? { tint: linear(trail.tint, [0.7, 0.7, 0.68]), widthM: trail.widthM, seconds: trail.fadeMs / 1000 } : null,
    };
  }
  const byWeapon: Record<string, WeaponFxEntry> = {};
  for (const [id, raw] of Object.entries(weapons)) {
    const w = rec(raw);
    if (!w) continue;
    byWeapon[id] = {
      flash: typeof w.flash === 'string' && flashes[w.flash] ? w.flash : null,
      flashScale: num(w.flashScale) && w.flashScale > 0 ? w.flashScale : 1,
      tracer: typeof w.tracer === 'string' && tracers[w.tracer] ? w.tracer : null,
    };
  }
  return { atlas: sheet.atlas, grid: sheet.grid, flashes, tracers, weapons: byWeapon, casings: parseCasings(root.casings, weapons) };
}

/** Fetches weapons.vfx.json and its flash atlas; null keeps the procedural flashes and tracers. */
export async function loadWeaponVfx(baseUrl: string): Promise<{ art: WeaponVfxArt; texture: Texture } | null> {
  try {
    const res = await fetch(`${baseUrl}assets/vfx/weapons.vfx.json`);
    if (!res.ok || !(res.headers.get('content-type') ?? '').includes('json')) return null;
    const art = parseWeaponVfx(await res.json());
    if (!art) return null;
    const texture = await new TextureLoader().loadAsync(`${baseUrl}assets/vfx/${art.atlas}`);
    texture.colorSpace = SRGBColorSpace;
    return { art, texture };
  } catch (err) {
    console.warn('render3d: weapons.vfx.json is unusable, keeping the procedural muzzle flashes', err);
    return null;
  }
}
