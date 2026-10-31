/**
 * The map posters and the Quick match key art: frames from the game itself (each map in a real match
 * against bots, on the GPU, one light grade for the set), made by scripts/map-posters.mjs from
 * art/posters/shots.json into public/assets/posters/. A map without its files yet gets a neutral
 * plate, never another map's picture. test/posters.test.ts holds every selectable map to a poster.
 */
import { maps } from '@military-forge/content';
import type { CSSProperties } from 'react';
import { Icon } from '../ui/Icon';
import './posters.css';

/** The maps that have their poster files (one per id: `<id>-card[@2x].webp`, `<id>-wide[@2x].webp`). */
export const POSTER_MAPS: readonly string[] = ['street-market', 'movement-test', 'lunar-outpost', 'storm-front', 'flux-lab', 'fog-stair', 'vertical-test'];

/** A poster's crops: the lobby's 2:1 card (400 and 800 wide) and the 16:9 wide one (960 and 1920). */
export const POSTER_KINDS = {
  card: { widths: [400, 800], aspect: 2 },
  wide: { widths: [960, 1920], aspect: 16 / 9 },
} as const;
export type PosterKind = keyof typeof POSTER_KINDS;

export interface PosterImage {
  src: string;
  srcSet: string;
  /** the 1× file's size: the img's width and height (its aspect, so nothing moves while it loads) */
  width: number;
  height: number;
}

const BASE = '/assets/posters/';

function image(stem: string, widths: readonly [number, number], aspect: number): PosterImage {
  const [w1, w2] = widths;
  return { src: `${BASE}${stem}.webp`, srcSet: `${BASE}${stem}.webp ${w1}w, ${BASE}${stem}@2x.webp ${w2}w`, width: w1, height: Math.round(w1 / aspect) };
}

/** A map's poster in one crop, or null while the map has none. */
export function mapPoster(id: string | null | undefined, kind: PosterKind): PosterImage | null {
  if (!id || !POSTER_MAPS.includes(id)) return null;
  const k = POSTER_KINDS[kind];
  return image(`${id}-${kind}`, k.widths, k.aspect);
}

/** Quick match's key art: a Street Market fight, 2:1, 760 and 1520 wide. */
export const QUICK_MATCH_ART: PosterImage = image('quick-match', [760, 1520], 2);

/** A map's id from its name (the match view carries the name only). */
export function mapIdByName(name: string): string | null {
  return Object.values(maps).find((m) => m.name === name)?.id ?? null;
}

/**
 * A map's poster as an img (decoration: the card around it names the map), or the neutral plate.
 * `sizes` is how wide it shows (CSS), so a phone or a 1× screen takes the smaller file; `lazy` for
 * posters that start out of view (the lobby's lower cards).
 */
export function MapPoster({ id, kind, sizes, lazy = false, className = '' }: { id: string | null | undefined; kind: PosterKind; sizes: string; lazy?: boolean; className?: string }) {
  const poster = mapPoster(id, kind);
  if (!poster) {
    return (
      <span className={`mapart mapart--plate ${className}`.trim()} aria-hidden="true" style={{ aspectRatio: String(POSTER_KINDS[kind].aspect) } as CSSProperties}>
        <Icon name="map" className="mapart__glyph" />
      </span>
    );
  }
  return <PosterImg poster={poster} sizes={sizes} lazy={lazy} className={`mapart ${className}`.trim()} />;
}

export function PosterImg({ poster, sizes, lazy = false, className }: { poster: PosterImage; sizes: string; lazy?: boolean; className: string }) {
  return <img className={className} src={poster.src} srcSet={poster.srcSet} sizes={sizes} width={poster.width} height={poster.height} alt="" aria-hidden="true" decoding="async" loading={lazy ? 'lazy' : 'eager'} draggable={false} />;
}
