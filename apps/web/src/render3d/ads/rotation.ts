/**
 * Rotation (docs/14 §4.4): deterministic from the synced match clock, so every player in a match
 * sees the same frame at the same moment and the server can compute it too. One beat per map:
 * every Screen changes on the same 10 s beat, crossfading for 0.5 s, never a hard cut.
 */
import type { AdSlot } from './manifest';

export const DWELL_MS = 10_000;
export const CROSSFADE_MS = 500;
/** the sim's tick rate (packages/sim DT = 1/60) */
export const TICK_MS = 1000 / 60;

/** frameIndex(slot, t) = (⌊t / dwellMs⌋ + phaseIdx) mod frames */
export function frameIndex(slot: Pick<AdSlot, 'frames' | 'dwellMs' | 'phaseIdx'>, matchTimeMs: number): number {
  const n = Math.max(1, slot.frames);
  const beat = Math.floor(matchTimeMs / slot.dwellMs) + slot.phaseIdx;
  return ((beat % n) + n) % n;
}

/** 0 at a beat, 1 once the crossfade into the new frame is done (CROSSFADE_MS later). */
export function crossfade(matchTimeMs: number, dwellMs = DWELL_MS, fadeMs = CROSSFADE_MS): number {
  const into = ((matchTimeMs % dwellMs) + dwellMs) % dwellMs;
  return Math.min(1, into / fadeMs);
}

/** The frame shown before the current one (what the crossfade fades from). */
export function previousFrame(slot: Pick<AdSlot, 'frames' | 'dwellMs' | 'phaseIdx'>, matchTimeMs: number): number {
  return frameIndex(slot, matchTimeMs - slot.dwellMs);
}

/**
 * Motion creatives (docs/14 §3.3): up to MAX_KEYS still keyframes, each shown ≥ 1.5 s, crossfading
 * in ≤ 0.3 s, never a flash. Keyframes run on the same match clock as the beat, restarting at every
 * beat, so every client shows the same keyframe and one fade uniform still serves every surface:
 * a frame's dwell splits into ⌊dwell / KEY_MS⌋ segments (the last one takes the remainder, so no
 * keyframe is ever cut short) and segment s shows keyframe s mod k. At 10 s that is six segments,
 * 1.5 s each but the last (2.5 s): ≤ 1 change per 1.5 s, far under 3 flashes/s.
 */
export const KEY_MS = 1_500;
export const KEY_FADE_MS = 300;
export const MAX_KEYS = 4;

/** The keyframe segment `matchTimeMs` falls in, within its frame's dwell (0 at the beat). */
export function keySegment(matchTimeMs: number, dwellMs = DWELL_MS): number {
  const into = ((matchTimeMs % dwellMs) + dwellMs) % dwellMs;
  const segments = Math.max(1, Math.floor(dwellMs / KEY_MS));
  return Math.min(segments - 1, Math.floor(into / KEY_MS));
}

/** The segment the dwell ends on: the keyframe a frame shows when the beat fades it out. */
export function lastKeySegment(dwellMs = DWELL_MS): number {
  return keySegment(dwellMs - 1, dwellMs);
}

/** 0 at a keyframe change (any segment but the first), 1 once its crossfade is done; 1 in the first segment. */
export function keyFade(matchTimeMs: number, dwellMs = DWELL_MS, fadeMs = KEY_FADE_MS): number {
  const s = keySegment(matchTimeMs, dwellMs);
  if (s === 0) return 1;
  const into = ((matchTimeMs % dwellMs) + dwellMs) % dwellMs;
  return Math.min(1, (into - s * KEY_MS) / fadeMs);
}
