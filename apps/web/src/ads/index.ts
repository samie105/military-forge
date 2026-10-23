/**
 * Tap-to-save (the owner's ask, 23 Oct 2026): billboard ads a player saves while playing, shown
 * after the match. mount.ts (the gestures, the toast), saved.ts (the queue), SavedAds.tsx (the cards).
 * Shared notes: ads-click.md.
 */
export { mountAdClicks, type AdClicks } from './mount';
export { SavedAdsList } from './SavedAds';
export { savedAds, type SavedAd } from './saved';
