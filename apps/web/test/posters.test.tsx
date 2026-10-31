/**
 * The map posters (owner, 31 Oct: "the quick match feature and the maps when selecting should have its own
 * posters"): every map a room can pick has its poster, in every crop, as files the app ships, and a shot in
 * art/posters/shots.json to remake it from (scripts/map-posters.mjs). A new map can't ship without one.
 */
import { maps } from '@military-forge/content';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { lobbyMaps } from '../src/shell/screens/Lobby';
import { MapPoster, POSTER_KINDS, POSTER_MAPS, QUICK_MATCH_ART, mapIdByName, mapPoster } from '../src/shell/posters';

const web = (path: string) => fileURLToPath(new URL(`../${path}`, import.meta.url));
const repo = (path: string) => fileURLToPath(new URL(`../../../${path}`, import.meta.url));
const shots = (JSON.parse(readFileSync(repo('art/posters/shots.json'), 'utf8')) as { shots: { id: string; map: string; at: number }[] }).shots;
const REMAKE = 're-run apps/web/scripts/map-posters.mjs (art/posters/README.md)';

/** A WebP file's pixel size (lossy VP8, lossless VP8L or extended VP8X), or null if it isn't one. */
function webpSize(file: string): { width: number; height: number } | null {
  const b = readFileSync(file);
  if (b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WEBP') return null;
  const chunk = b.toString('ascii', 12, 16);
  if (chunk === 'VP8 ') return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
  if (chunk === 'VP8L') {
    const bits = b.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  if (chunk === 'VP8X') return { width: b.readUIntLE(24, 3) + 1, height: b.readUIntLE(27, 3) + 1 };
  return null;
}

/** Every file a poster names (its srcset), with the width it claims. */
function files(src: string, srcSet: string): { path: string; width: number }[] {
  expect(srcSet.split(', ')[0]).toMatch(new RegExp(`^${src} \\d+w$`));
  return srcSet.split(', ').map((entry) => {
    const [url, w] = entry.split(' ');
    return { path: web(`public${url}`), width: Number(w!.replace('w', '')) };
  });
}

describe('the map posters', () => {
  it('every map a room can pick has a poster (a new map needs its shot and files before it ships)', () => {
    const selectable = lobbyMaps('');
    expect(selectable.length).toBeGreaterThanOrEqual(7);
    for (const id of selectable) expect(POSTER_MAPS, `${id}: no poster; add a shot to art/posters/shots.json and ${REMAKE}`).toContain(id);
    // and nothing names a map that isn't in the game
    for (const id of POSTER_MAPS) expect(maps[id], id).toBeDefined();
  });

  it('every poster crop is a WebP of the size its srcset says, light enough for a phone', () => {
    for (const id of POSTER_MAPS) {
      for (const kind of Object.keys(POSTER_KINDS) as (keyof typeof POSTER_KINDS)[]) {
        const poster = mapPoster(id, kind)!;
        expect(poster.width / poster.height).toBeCloseTo(POSTER_KINDS[kind].aspect, 1);
        for (const f of files(poster.src, poster.srcSet)) {
          expect(existsSync(f.path), `${f.path}: missing; ${REMAKE}`).toBe(true);
          const size = webpSize(f.path);
          expect(size, f.path).toEqual({ width: f.width, height: Math.round(f.width / POSTER_KINDS[kind].aspect) });
          expect(readFileSync(f.path).length, f.path).toBeLessThan(90_000);
        }
      }
    }
  });

  it('Quick match has its key art, 2:1, in both sizes', () => {
    for (const f of files(QUICK_MATCH_ART.src, QUICK_MATCH_ART.srcSet)) {
      expect(webpSize(f.path)).toEqual({ width: f.width, height: f.width / 2 });
      expect(readFileSync(f.path).length).toBeLessThan(90_000);
    }
  });

  it('each poster has the shot it was made from (art/posters/shots.json), and its master', () => {
    const ids = shots.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual([...POSTER_MAPS, 'quick-match'].sort());
    for (const s of shots) {
      expect(maps[s.map], s.id).toBeDefined();
      expect(s.at, s.id).toBeGreaterThan(0);
      expect(existsSync(repo(`art/posters/${s.id}.webp`)), s.id).toBe(true);
    }
  });

  it('shows as an img that holds its space and loads quietly (decoration: the card names the map)', () => {
    const html = renderToStaticMarkup(<MapPoster id="lunar-outpost" kind="card" sizes="240px" lazy />);
    expect(html).toContain('src="/assets/posters/lunar-outpost-card.webp"');
    expect(html).toContain('srcSet="/assets/posters/lunar-outpost-card.webp 400w, /assets/posters/lunar-outpost-card@2x.webp 800w"');
    expect(html).toContain('width="400" height="200"');
    expect(html).toContain('alt="" aria-hidden="true" decoding="async" loading="lazy"');
    expect(renderToStaticMarkup(<MapPoster id="lunar-outpost" kind="wide" sizes="100vw" />)).toContain('loading="eager"');
  });

  it("a map with no poster yet gets the neutral plate, never another map's picture", () => {
    expect(mapPoster('a-new-map', 'card')).toBeNull();
    expect(mapPoster(null, 'wide')).toBeNull();
    const html = renderToStaticMarkup(<MapPoster id="a-new-map" kind="card" sizes="240px" />);
    expect(html).toContain('mapart mapart--plate');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('/assets/posters/');
  });

  it('finds a map by the name a match view carries', () => {
    expect(mapIdByName('Storm Front')).toBe('storm-front');
    expect(mapIdByName('Nowhere')).toBeNull();
  });
});
