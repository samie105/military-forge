/**
 * Who's who at a glance (the owner, 26 Oct: "how should I know which one is me? I don't know who is an
 * enemy, who's a friend"): every soldier is you, an ally (your team, in team modes) or an enemy (the
 * other teams; in a free-for-all, everyone else). One colour and one shape per relation, the same on
 * the soldier (3D rim and outline), its name tag and health bar, and the minimap:
 *
 *   you    volt     ▲ a chevron under the feet, "YOU"
 *   ally   teal     ● a dot over the name
 *   enemy  red      ◆ a diamond over the name
 *
 * The colours follow the colour-blind setting (Settings → Accessibility, teams/palette.ts): red-green
 * safe turns enemies amber against blue allies. The shapes carry the meaning on their own.
 * Spectating, "you" is the soldier being watched: the picture is theirs.
 */
import { teamPaletteMode, type TeamPaletteMode } from './palette';

export type Relation = 'self' | 'ally' | 'enemy';

export interface MarkColours {
  self: string;
  ally: string;
  enemy: string;
}

export const MARK_COLOURS: Readonly<Record<TeamPaletteMode, MarkColours>> = {
  standard: { self: '#d6ff3b', ally: '#3fd0c9', enemy: '#ff4d5e' },
  deutan: { self: '#d6ff3b', ally: '#3d8bff', enemy: '#ffc53d' },
  tritan: { self: '#d6ff3b', ally: '#4fd1c5', enemy: '#ff4d5e' },
};

export const MARK_SHAPES: Readonly<Record<Relation, string>> = { self: '▲', ally: '●', enemy: '◆' };

/** The relation colours in use (the colour-blind setting's). */
export function markColours(mode: TeamPaletteMode = teamPaletteMode()): MarkColours {
  return MARK_COLOURS[mode] ?? MARK_COLOURS.standard;
}

/** A relation's colour as CSS (#rrggbb). */
export function markColourCss(rel: Relation, mode?: TeamPaletteMode): string {
  return markColours(mode)[rel];
}

/** A relation's colour as a number (three.js). */
export function markColour(rel: Relation, mode?: TeamPaletteMode): number {
  return parseInt(markColourCss(rel, mode).slice(1), 16);
}

/**
 * How `id` stands to `viewer` (the local player, or the soldier being watched): themselves, an ally
 * (the same team, in a team mode) or an enemy. `teamOf` gives −1 for no team (a free-for-all): then
 * everyone else is an enemy. No viewer (−1): nobody is "you" and everyone reads as an enemy.
 */
export function relationOf(id: number, viewer: number, teamOf: (id: number) => number): Relation {
  if (viewer >= 0 && id === viewer) return 'self';
  const mine = viewer >= 0 ? teamOf(viewer) : -1;
  const theirs = teamOf(id);
  if (mine >= 0 && theirs === mine) return 'ally';
  return 'enemy';
}
