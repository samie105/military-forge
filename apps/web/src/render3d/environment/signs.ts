/**
 * Shop fascias on the houses of the gameplay plane: painted boards with the names of invented,
 * region-neutral businesses (docs/14 §2.1 house-only surfaces: never sold, no phone numbers, no
 * URLs, no real brands). Drawn once into a canvas atlas at load, so they cost no download; every
 * board is one quad in one mesh (one draw call). Each board sits inside its house's collision
 * silhouette, on the wall in front of the pilasters, so render = collision still holds.
 */
import { BufferAttribute, BufferGeometry, CanvasTexture, LinearMipmapLinearFilter, SRGBColorSpace } from 'three';

export interface SignDesign {
  text: string;
  sub: string;
  bg: string;
  fg: string;
}

export const SHOP_SIGNS: readonly SignDesign[] = [
  { text: 'SUNRISE BAKERY', sub: 'BREAD · CAKES · PIES', bg: '#c49a3c', fg: '#3b2a1a' },
  { text: 'GOLDEN NEEDLE', sub: 'TAILORS & ALTERATIONS', bg: '#6b2d29', fg: '#efe3c8' },
  { text: 'CORNER HARDWARE', sub: 'TOOLS · PAINT · PIPES', bg: '#2f4a3a', fg: '#e9dfc6' },
  { text: 'MARKET KITCHEN', sub: 'HOT MEALS ALL DAY', bg: '#e3d6ba', fg: '#5a2a20' },
  { text: 'BRIGHT SMILE', sub: 'HAIR · BRAIDS · NAILS', bg: '#3f5658', fg: '#f0ead8' },
  { text: 'GOOD HARVEST', sub: 'PROVISIONS STORE', bg: '#dcd6c8', fg: '#2c2c2c' },
];

/**
 * A cell is about the size a board is drawn at 1080p and 1× (≈ 280 × 47 px): the atlas is
 * 512 × 256 (0.7 MB with mips), and a closer zoom only softens the paint a little.
 */
const CELL_W = 256;
const CELL_H = 64;
const COLS = 2;
const ROWS = 4;
/** sizes below are for a 128 px tall cell: everything scales by this */
const K = CELL_H / 128;

/** The atlas cell (u0, v0, u1, v1) of sign `i`; v is up (three's texture space with flipY). */
export function signCell(i: number): [number, number, number, number] {
  const col = i % COLS;
  const row = Math.floor(i / COLS) % ROWS;
  return [col / COLS, 1 - (row + 1) / ROWS, (col + 1) / COLS, 1 - row / ROWS];
}

/** Paints every design into one atlas (null without a DOM: tests, workers). */
export function signAtlas(designs: readonly SignDesign[]): CanvasTexture | null {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = CELL_W * COLS;
  canvas.height = CELL_H * ROWS;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  designs.slice(0, COLS * ROWS).forEach((d, i) => {
    const x = (i % COLS) * CELL_W;
    const y = Math.floor(i / COLS) * CELL_H;
    ctx.fillStyle = d.bg;
    ctx.fillRect(x, y, CELL_W, CELL_H);
    // a painted border, inset
    ctx.strokeStyle = d.fg;
    ctx.globalAlpha = 0.55;
    ctx.lineWidth = 4 * K;
    ctx.strokeRect(x + 9 * K, y + 9 * K, CELL_W - 18 * K, CELL_H - 18 * K);
    ctx.globalAlpha = 1;
    ctx.fillStyle = d.fg;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    let size = 60 * K;
    ctx.font = `900 ${size}px "Arial Black", "Helvetica Neue", Arial, sans-serif`;
    while (ctx.measureText(d.text).width > CELL_W - 56 * K && size > 24 * K) {
      size -= 1;
      ctx.font = `900 ${size}px "Arial Black", "Helvetica Neue", Arial, sans-serif`;
    }
    ctx.fillText(d.text, x + CELL_W / 2, y + 74 * K);
    ctx.font = `700 ${Math.round(22 * K)}px "Helvetica Neue", Arial, sans-serif`;
    ctx.globalAlpha = 0.85;
    ctx.fillText(d.sub, x + CELL_W / 2, y + 106 * K);
    ctx.globalAlpha = 1;
  });
  const tex = new CanvasTexture(canvas);
  tex.colorSpace = SRGBColorSpace;
  tex.minFilter = LinearMipmapLinearFilter;
  tex.anisotropy = 4;
  return tex;
}

export interface SignPlacement {
  /** centre x, bottom and top y, depth z, width */
  x: number;
  y0: number;
  y1: number;
  z: number;
  width: number;
  design: number;
}

/** One quad per board, facing the camera, UVs into the atlas. */
export function signGeometry(signs: readonly SignPlacement[]): BufferGeometry {
  const pos: number[] = [];
  const nor: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  signs.forEach((s, i) => {
    const [u0, v0, u1, v1] = signCell(s.design);
    const x0 = s.x - s.width / 2;
    const x1 = s.x + s.width / 2;
    pos.push(x0, s.y0, s.z, x1, s.y0, s.z, x1, s.y1, s.z, x0, s.y1, s.z);
    for (let k = 0; k < 4; k++) nor.push(0, 0, 1);
    uv.push(u0, v0, u1, v0, u1, v1, u0, v1);
    const b = i * 4;
    idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
  });
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  g.setAttribute('normal', new BufferAttribute(new Float32Array(nor), 3));
  g.setAttribute('uv', new BufferAttribute(new Float32Array(uv), 2));
  g.setIndex(idx);
  g.computeBoundingBox();
  g.computeBoundingSphere();
  return g;
}
