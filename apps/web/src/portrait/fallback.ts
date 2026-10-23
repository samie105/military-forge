/**
 * The stand-in until a soldier's portrait exists (§7.3.5, last fallback): a head-and-shoulders silhouette
 * in the team's tint with the player's initial. It shows at once, and the live render cross-fades over it.
 * (The middle fallback, a pre-rendered atlas per body and skin tone, is the art pipeline's to make.)
 */

/** Field Print tints for the silhouette: no team (olive), and team colours once team modes exist. */
export const PORTRAIT_TINTS = {
  none: { plate: '#2b3020', figure: '#59613f', ink: '#ece3c8' },
  volt: { plate: '#2c3311', figure: '#9db82a', ink: '#15170f' },
  brass: { plate: '#33291a', figure: '#b48a46', ink: '#15170f' },
  steel: { plate: '#1f2830', figure: '#6f8796', ink: '#ece3c8' },
  ember: { plate: '#36201a', figure: '#b5563a', ink: '#ece3c8' },
} as const;
export type PortraitTint = keyof typeof PORTRAIT_TINTS;

/** The first character of a name, as a person would read it ('?' for none). */
export function initialOf(name: string): string {
  const clean = name.replace(/^\s*\[\s*bot\s*\]\s*/i, '').trim();
  return ([...clean][0] ?? '?').toUpperCase();
}

const escapeXml = (s: string) => s.replace(/[<>&'"]/g, (c) => `&#${c.charCodeAt(0)};`);

/** The silhouette as an SVG data URL (square; `tall` for the poster's 2:3 cards); no initial for an empty name. */
export function silhouetteUrl(name: string, tint: PortraitTint = 'none', tall = false): string {
  const t = PORTRAIT_TINTS[tint];
  const h = tall ? 150 : 100;
  const y = tall ? 50 : 0;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 ${h}">` +
    `<rect width="100" height="${h}" fill="${t.plate}"/>` +
    // shoulders, neck and a helmeted head: the soldier's big-head proportions
    `<path fill="${t.figure}" d="M8 ${y + 100}c2-17 14-25 28-28l6-4h16l6 4c14 3 26 11 28 28z"/>` +
    `<rect fill="${t.figure}" x="42" y="${y + 58}" width="16" height="12"/>` +
    `<ellipse fill="${t.figure}" cx="50" cy="${y + 42}" rx="21" ry="22"/>` +
    `<path fill="${t.figure}" d="M24 ${y + 36}c2-17 13-25 26-25s24 8 26 25l5 3H19z"/>` +
    (name.trim() ? `<text x="50" y="${y + 92}" text-anchor="middle" font-family="Big Shoulders Stencil, Archivo, sans-serif" font-weight="800" font-size="22" fill="${t.ink}">${escapeXml(initialOf(name))}</text>` : '') +
    `</svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}
