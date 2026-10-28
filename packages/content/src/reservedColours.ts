/**
 * The colours that carry gameplay meaning (docs/17 §3.4 V7): no skin's emissive, tracer or flash hue, and no
 * kill effect, may sit within ΔE 15 of one. A skin that glowed team blue, enemy red or grenade green would
 * pass itself off as a signal. apps/web's test/skins/reserved.test.ts checks this list still holds the colours
 * the client draws (relation marks, grenades, events), so it can't drift from them.
 */
import { ZONE_KINDS } from './maps/mechanics';

/** V7: the smallest CIE76 distance a skin's hue may come to a reserved colour. */
export const RESERVED_DELTA_E = 15;

export const RESERVED_COLOURS: readonly { name: string; hex: string }[] = [
  // teams (docs/01 §7; apps/web ui/kit.css --c-team-*, tools/asset-check TEAM_RGB)
  { name: 'team orange', hex: '#ff7a1a' },
  { name: 'team blue', hex: '#2f7dff' },
  { name: 'team A (UI)', hex: '#3d8bff' },
  { name: 'team B (UI)', hex: '#ff8a1f' },
  // relation marks, every colour-blind mode (apps/web teams/marking.ts MARK_COLOURS)
  { name: 'you', hex: '#d6ff3b' },
  { name: 'ally', hex: '#3fd0c9' },
  { name: 'ally (tritan)', hex: '#4fd1c5' },
  { name: 'enemy', hex: '#ff4d5e' },
  { name: 'enemy (deutan)', hex: '#ffc53d' },
  // low HP, damage and warnings (ui/kit.css --c-hp, --c-warn, --c-ok)
  { name: 'health / damage', hex: '#ff4d5e' },
  { name: 'warning', hex: '#ffc53d' },
  { name: 'heal / ok', hex: '#4fe08c' },
  // grenades and their warnings (apps/web render.ts GRENADE_COLORS, render3d/grenades.ts STAND_IN)
  { name: 'frag', hex: '#3fb950' },
  { name: 'gas', hex: '#c3d22b' },
  { name: 'flashbang', hex: '#a5d6ff' },
  { name: 'mine', hex: '#d29922' },
  { name: 'EMP grenade', hex: '#58a6ff' },
  { name: 'EMP canister', hex: '#59f2ff' },
  // map events (ui/kit.css --c-ev-*): the EMP storm and the rest
  { name: 'EMP event', hex: '#ff6fd2' },
  { name: 'gravity event', hex: '#b49dfb' },
  { name: 'solar event', hex: '#ffe14d' },
  { name: 'squall event', hex: '#8fe0c8' },
  // map zones (maps/mechanics.ts): pads, low gravity, wind and the rest
  ...Object.entries(ZONE_KINDS).map(([kind, z]) => ({ name: `zone ${kind}`, hex: `#${z.color.toString(16).padStart(6, '0')}` })),
];

function channel(c: number): number {
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** #rrggbb → linear sRGB [0, 1]. */
export function linearRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [channel(((n >> 16) & 255) / 255), channel(((n >> 8) & 255) / 255), channel((n & 255) / 255)];
}

/** Relative luminance (WCAG) of #rrggbb or of linear rgb. */
export function luminance(c: string | readonly [number, number, number]): number {
  const [r, g, b] = typeof c === 'string' ? linearRgb(c) : c;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** CIE Lab (D65) of #rrggbb or of linear rgb. */
export function lab(c: string | readonly [number, number, number]): [number, number, number] {
  const [r, g, b] = typeof c === 'string' ? linearRgb(c) : c;
  const xyz = [(0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047, 0.2126 * r + 0.7152 * g + 0.0722 * b, (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883];
  const f = xyz.map((t) => (t > 216 / 24389 ? t ** (1 / 3) : (24389 / 27 * t + 16) / 116));
  return [116 * f[1]! - 16, 500 * (f[0]! - f[1]!), 200 * (f[1]! - f[2]!)];
}

/** CIE76 ΔE between two colours. */
export function deltaE(a: string | readonly [number, number, number], b: string | readonly [number, number, number]): number {
  const [l1, a1, b1] = lab(a);
  const [l2, a2, b2] = lab(b);
  return Math.sqrt((l1 - l2) ** 2 + (a1 - a2) ** 2 + (b1 - b2) ** 2);
}

/** The nearest reserved colour to `hex` and its ΔE. */
export function nearestReserved(hex: string | readonly [number, number, number]): { name: string; hex: string; deltaE: number } {
  let best = { name: '', hex: '', deltaE: Infinity };
  for (const r of RESERVED_COLOURS) {
    const d = deltaE(hex, r.hex);
    if (d < best.deltaE) best = { ...r, deltaE: d };
  }
  return best;
}
