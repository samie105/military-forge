/**
 * Team colours (team modes, protocol v21; Pen board "MATCH PRESENTATION", D5–D7): one palette per
 * colour-blind mode (Settings → Accessibility), and never colour alone: every team also has a shape
 * and a letter. The DOM reads `--c-team-0…3` (set on <html> by applyTeamPalette); 3D outlines and the
 * minimap read teamColour(team) (a hex number).
 *
 * For the maps agent's minimap and anyone else drawing teams: `teamColour(team)`, `teamColourCss`,
 * `TEAM_SHAPES`, `TEAM_LETTERS`, `TEAM_NAMES`, and `onTeamPalette(listener)` for a mode change.
 */
export type TeamPaletteMode = 'standard' | 'deutan' | 'tritan';

/** Up to four teams: blue, orange, pink, chalk; red-green safe: blue, yellow, chalk, sky; blue-yellow safe: red, teal, chalk, pink. */
export const TEAM_PALETTES: Readonly<Record<TeamPaletteMode, readonly [string, string, string, string]>> = {
  standard: ['#3d8bff', '#ff8a1f', '#e87ad0', '#ece3c8'],
  deutan: ['#3d8bff', '#ffc53d', '#ece3c8', '#8fd3ff'],
  tritan: ['#ff4d5e', '#8fe0c8', '#ece3c8', '#e87ad0'],
};

export const TEAM_SHAPES = ['◆', '▲', '●', '■'] as const;
export const TEAM_LETTERS = ['A', 'B', 'C', 'D'] as const;
export const TEAM_NAMES = ['Alpha', 'Bravo', 'Charlie', 'Delta'] as const;

let mode: TeamPaletteMode = 'standard';
const listeners = new Set<() => void>();

/** The palette in use (follows Settings → Accessibility → colour-blind mode). */
export function teamPaletteMode(): TeamPaletteMode {
  return mode;
}

/** Sets the palette and writes `--c-team-0…3` on <html> (main.ts, whenever settings apply). */
export function applyTeamPalette(next: TeamPaletteMode, root: { style: { setProperty(k: string, v: string): void } } | null = typeof document !== 'undefined' ? document.documentElement : null): void {
  mode = next in TEAM_PALETTES ? next : 'standard';
  TEAM_PALETTES[mode].forEach((c, i) => root?.style.setProperty(`--c-team-${i}`, c));
  for (const l of [...listeners]) l();
}

export function onTeamPalette(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** A team's colour as CSS (#rrggbb); a neutral for no team. */
export function teamColourCss(team: number): string {
  return team >= 0 && team < 4 ? TEAM_PALETTES[mode][team]! : '#b5b9a2';
}

/** A team's colour as a number (three.js, canvas); null for no team. */
export function teamColour(team: number): number | null {
  return team >= 0 && team < 4 ? parseInt(TEAM_PALETTES[mode][team]!.slice(1), 16) : null;
}

/** "◆ Alpha", for labels that name a team. */
export function teamLabel(team: number): string {
  return team >= 0 && team < 4 ? `${TEAM_SHAPES[team]} ${TEAM_NAMES[team]}` : '';
}
