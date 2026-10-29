/**
 * Tap-to-save (the owner's ask, 23 Oct 2026): a player can save a billboard's ad while playing, and
 * the results screen (and Home) lists what they saved, each with a Visit link. Nothing ever opens
 * mid-match. This file is the data half: what a creative leads to (`AdClick`, carried on its manifest
 * frame), the checks a destination must pass, the link a Visit opens, and which creative is under a
 * point on screen right now (`creativeAt`). The gesture, the queue and the cards are apps/web/src/ads.
 */
import { GAME_SLUG } from '@military-forge/shared';
import { projectToPlane, type PlanePose, type Rect } from '../planeCamera';
import type { AdFrame, AdManifest, AdSlot } from './manifest';
import { CROSSFADE_MS, frameIndex, previousFrame } from './rotation';

/** An advertiser in a pool (house-ads.py ADVERTISERS). */
export interface Advertiser {
  name: string;
  /** default destination, https only; null = not set yet (its creatives can't be saved) */
  url: string | null;
  /** optional UTM campaign tag */
  utm?: string;
  /** its share of the boards against the other advertisers' (default 1) */
  weight?: number;
}

/** Where a saved creative leads: on its manifest frame. */
export interface AdClick {
  /** advertiser id (e.g. "deet") */
  advertiser: string;
  /** shown on the toast and the card, e.g. "Deet Studios" */
  name: string;
  /** destination, https only */
  url: string;
  /** UTM campaign tag (letters, digits, . _ -) */
  utm?: string;
  /** e.g. "finance": shown with the risk line on its card, and can be switched off per region */
  category?: string;
}

/** The card's line under a finance creative (the art carries it too). */
export const FINANCE_NOTE = 'Trading involves risk. 18+.';

const TAG = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
const MAX_NAME = 40;
const MAX_URL = 512;

/** Problems with a click-through (empty = usable): https only, no credentials, a real host, short tags. */
export function checkClick(c: AdClick): string[] {
  const out: string[] = [];
  if (!c.name || c.name.length > MAX_NAME || c.name.trim() !== c.name) out.push(`advertiser name "${c.name}" (1…${MAX_NAME} characters)`);
  if (!TAG.test(c.advertiser)) out.push(`advertiser id "${c.advertiser}"`);
  if (c.utm !== undefined && !TAG.test(c.utm)) out.push(`UTM tag "${c.utm}"`);
  if (c.category !== undefined && !/^[a-z]{1,24}$/.test(c.category)) out.push(`category "${c.category}"`);
  let u: URL | null;
  try {
    u = c.url.length <= MAX_URL ? new URL(c.url) : null;
  } catch {
    u = null;
  }
  if (!u) out.push(`destination "${c.url}" is not a URL`);
  else {
    if (u.protocol !== 'https:') out.push(`destination "${c.url}" is not https`);
    if (u.username || u.password) out.push(`destination "${c.url}" carries credentials`);
    if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(u.hostname) || /^[\d.]+$/.test(u.hostname)) out.push(`destination "${c.url}" has no public host name`);
    if (u.port) out.push(`destination "${c.url}" names a port`);
  }
  return out;
}

/**
 * The link a Visit opens: the destination with utm_source (the game), utm_medium=billboard, the
 * campaign tag if any and the creative as utm_content. Never anything about the player.
 */
export function visitUrl(c: AdClick, creative: string): string {
  const u = new URL(c.url);
  u.searchParams.set('utm_source', GAME_SLUG);
  u.searchParams.set('utm_medium', 'billboard');
  if (c.utm) u.searchParams.set('utm_campaign', c.utm);
  const content = creative.replace(/^house:/, '');
  if (TAG.test(content)) u.searchParams.set('utm_content', content);
  return u.toString();
}

/** A board's creative under a point: which slot, and the frame it shows. */
export interface BoardHit {
  slot: AdSlot;
  frame: AdFrame;
}

/** a surface counts as lit (showing its creative, not switched off) past this */
export const LIT_TO_SAVE = 0.5;

const onPlane: Rect = { x0: 0, y0: 0, x1: 0, y1: 0 };

/**
 * The creative shown under the gameplay-plane point (x, y) (metres, z = 0: where the cursor, a tap or
 * the pad's reticle lands on screen), seen from `pose`, or null. Only a lit surface counts (a dark one
 * shows nothing), and during a beat's crossfade the frame that's more than half in. Boards are drawn
 * axis-aligned (boards.ts), so each one's projection onto the plane is a rectangle.
 */
export function creativeAt(slots: readonly AdSlot[], manifest: AdManifest, lit: ArrayLike<number>, pose: PlanePose, matchTimeMs: number, x: number, y: number): BoardHit | null {
  for (let i = 0; i < slots.length; i++) {
    const slot = slots[i]!;
    if ((lit[i] ?? 0) <= LIT_TO_SAVE) continue;
    const [w, h] = slot.size;
    projectToPlane({ x0: slot.pos[0] - w / 2, x1: slot.pos[0] + w / 2, y0: slot.pos[1] - h / 2, y1: slot.pos[1] + h / 2 }, slot.pos[2], pose.x, pose.y, pose.z, onPlane);
    if (x < onPlane.x0 || x > onPlane.x1 || y < onPlane.y0 || y > onPlane.y1) continue;
    const frames = manifest.slots.find((s) => s.slot === slot.slotId)?.frames ?? [];
    const into = ((matchTimeMs % slot.dwellMs) + slot.dwellMs) % slot.dwellMs;
    const frame = frames[into < CROSSFADE_MS / 2 ? previousFrame(slot, matchTimeMs) : frameIndex(slot, matchTimeMs)];
    return frame ? { slot, frame } : null;
  }
  return null;
}
