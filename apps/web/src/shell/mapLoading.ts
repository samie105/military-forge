/**
 * The map loading screen's numbers (docs/design/pen-diff.md N2, Field Print's 15 · Loading): how far
 * along getting into a room's map is, what the line under the bar says, and how long the screen
 * holds once the world is in (a lobby waits for the map's art; a match under way doesn't).
 */
import { capText } from '../ui/icons';
import type { AssetLoad } from '../assetLoad';
import type { ActionId } from './controls';
import type { Settings } from './store';

/** The longest the screen waits for the map's art once the world is in (then the art pops in). */
export const MAX_ART_WAIT_MS = 8000;

/** Stays on the loading screen: before the first world update, and in a lobby while the map's art loads. */
export function holdLoading(o: { haveMatch: boolean; waiting: boolean; load: AssetLoad; heldMs: number }): boolean {
  if (!o.haveMatch) return true;
  if (!o.waiting) return false;
  return o.load.done < o.load.files && o.heldMs < MAX_ART_WAIT_MS;
}

/** 0..100: in the room (25), the first world update (15), the files (60). */
export function loadPercent(haveMatch: boolean, load: AssetLoad): number {
  const files = load.files > 0 ? Math.min(1, load.done / load.files) : haveMatch ? 1 : 0;
  return Math.round(100 * (0.25 + (haveMatch ? 0.15 : 0) + 0.6 * files));
}

const mb = (bytes: number) => `${(bytes / 1e6).toFixed(1)} MB`;

/** The line beside the percentage. */
export function loadLine(haveMatch: boolean, load: AssetLoad): string {
  if (load.done < load.files) return `Loading the map · ${load.done} of ${load.files}${load.bytes > 0 ? ` · ${mb(load.bytes)}` : ''}`;
  if (!haveMatch) return 'Getting the battlefield from the server';
  return 'Map loaded';
}

export interface FieldTip {
  title: string;
  body: string;
}

/** The field tips, in the player's own keys (Settings → Controls). */
export function fieldTips(bindings: Settings['bindings'], layout: ReadonlyMap<string, string> | null = null): FieldTip[] {
  const key = (id: ActionId, fallback: string) => {
    const code = bindings[id][0];
    return code ? capText(code, layout) : fallback;
  };
  return [
    { title: `Hold ${key('jet', 'jet')} to fly.`, body: 'Fuel refills on the ground, faster than in the air.' },
    { title: 'Dashes run on fuel.', body: `Dash as often as your tank allows: ${key('dash', 'the dash key')} and a direction, any of 8 ways.` },
    { title: `Tap ${key('grenade', 'the grenade key')} to throw.`, body: 'Hold it to see the arc and how hard you throw.' },
    { title: 'Drop through yellow.', body: `Hold ${key('down', 'crouch')} on a yellow platform to drop through it.` },
    { title: 'Sling your shield.', body: `Press ${key('shield', 'the shield key')} to sling a riot shield: it covers your back while you fight.` },
  ];
}

/** Three tips from `start` (the screen picks a start at random, so a player sees them all over time). */
export function threeTips(tips: readonly FieldTip[], start: number): FieldTip[] {
  return [0, 1, 2].map((i) => tips[(start + i) % tips.length]!);
}
