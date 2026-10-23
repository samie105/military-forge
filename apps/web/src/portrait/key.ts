/**
 * Portrait requests and their cache keys (docs/design/character-feel-research.md §7.1, §7.3.4).
 * A portrait is a picture of a player's real, current soldier: their look (protocol v19) drawn by the
 * game's own assembler, never a stand-in person.
 */
import { cosmeticLoadoutFromWireIds, cosmeticLoadoutHash, type CosmeticLoadout } from '@military-forge/content';

export type PortraitPose = 'portrait' | 'portrait-win' | 'portrait-down' | `poster-${1 | 2 | 3 | 4 | 5 | 6}`;
/** 64, 128, 256: square head-and-shoulders; 512: the VS poster's full body (512×768) */
export type PortraitSize = 64 | 128 | 256 | 512;

export interface PortraitRequest {
  /** the look, or its wire ids (cosmeticLoadoutWireIds) */
  look: CosmeticLoadout | readonly number[];
  size: PortraitSize;
  /** default 'portrait' */
  pose?: PortraitPose;
}

export interface PortraitImage {
  /** the cache key */
  key: string;
  /** an object URL for an <img>, valid while cached (peek again after a remount) */
  url: string;
  width: number;
  height: number;
  /** a stand-in (no 3D on this page, or the render failed): the silhouette, not the soldier */
  fallback?: boolean;
}

/** Bumped whenever the framing, light or pose recipe changes: every cached portrait renders again. */
export const RENDER_VERSION = 1;

export const POSTER_POSES = ['poster-1', 'poster-2', 'poster-3', 'poster-4', 'poster-5', 'poster-6'] as const satisfies readonly PortraitPose[];

export function isPoster(pose: PortraitPose): boolean {
  return pose.startsWith('poster-');
}

export function lookOf(req: Pick<PortraitRequest, 'look'>): CosmeticLoadout {
  return isWireIds(req.look) ? cosmeticLoadoutFromWireIds(req.look) : req.look;
}

function isWireIds(look: CosmeticLoadout | readonly number[]): look is readonly number[] {
  return Array.isArray(look);
}

/** Pixel size of a request: square portraits; full-body posters at 2:3. */
export function portraitDims(size: PortraitSize, pose: PortraitPose = 'portrait'): { width: number; height: number } {
  return isPoster(pose) ? { width: size, height: Math.round(size * 1.5) } : { width: size, height: size };
}

/** `p1:{RENDER_VERSION}:{artVersion}:{look hash}:{pose}:{size}` (§7.3.4): the hash covers every slot, skin and dye. */
export function portraitKey(req: PortraitRequest, artVersion: string): string {
  return `p1:${RENDER_VERSION}:${artVersion}:${cosmeticLoadoutHash(lookOf(req))}:${req.pose ?? 'portrait'}:${req.size}`;
}

/** A poster pose for a look, until players pick one: stable per look, varied across a lineup. */
export function defaultPosterPose(look: CosmeticLoadout): PortraitPose {
  return POSTER_POSES[cosmeticLoadoutHash(look) % POSTER_POSES.length]!;
}

/** FNV-1a of a string as 8 hex digits (the art version from the manifests' text). */
export function textHash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(16).padStart(8, '0');
}
