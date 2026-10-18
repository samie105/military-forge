/**
 * The production HUD (hud.ts) and its public API.
 *
 *   import { showBanner } from '../hud';
 *   showBanner('Low gravity!', 'event', { detail: 'Jumps go higher for 30 s' });
 *
 * `showBanner(text, kind, options)` is safe to call from anywhere at any time: before the HUD
 * mounts (or with no HUD, e.g. the dev debug client) the banners wait, up to five, and show once
 * it does. Kinds: 'info' | 'event' | 'success' | 'warning' | 'danger'.
 */
import { Hud, type BannerKind, type BannerOptions } from './hud';

export { Hud, netGraph, type BannerKind, type BannerOptions, type HudInput, type HudKeys } from './hud';
export type { ScoreRow } from './model';

let active: Hud | null = null;
const waiting: [string, BannerKind, BannerOptions][] = [];

/** Puts the HUD on the page (the app does this once); banners shown before now appear. */
export function mountHud(parent: HTMLElement = document.body): Hud {
  active?.dispose();
  active = new Hud(parent);
  for (const [text, kind, options] of waiting.splice(0)) active.showBanner(text, kind, options);
  return active;
}

/** A banner under the match clock: map events, announcements. */
export function showBanner(text: string, kind: BannerKind = 'info', options: BannerOptions = {}): void {
  if (active) active.showBanner(text, kind, options);
  else {
    waiting.push([text, kind, options]);
    if (waiting.length > 5) waiting.shift();
  }
}
