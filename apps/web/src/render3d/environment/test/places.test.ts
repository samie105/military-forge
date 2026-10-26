import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { maps } from '@military-forge/content';
import type { Mesh } from 'three';
import { describe, expect, it } from 'vitest';
import { Camera } from '../../../camera';
import { planePose } from '../../planeCamera';
import { ENVIRONMENTS, MapEnvironment, environmentFor } from '../index';

const WEB = new URL('../../../../', import.meta.url);
const digest = (url: URL) => createHash('sha256').update(readFileSync(url)).digest('hex');
const never = { loadAsync: () => new Promise<never>(() => {}) };
const fetchNever = () => new Promise<never>(() => {});

describe('map environments without a kit (the mechanics demos)', () => {
  it('lunar-outpost, storm-front and flux-lab each have their own look and painted layers', () => {
    for (const id of ['lunar-outpost', 'storm-front', 'flux-lab']) {
      const def = environmentFor(id)!;
      expect(def, id).toBeDefined();
      expect(maps[id], id).toBeDefined();
      expect(def.kitUrl, id).toBeUndefined();
      expect(def.backdrop!.layers.length, id).toBeGreaterThan(0);
      expect(def.looks[def.defaultLook], id).toBeDefined();
    }
  });

  it('a painted layer close behind the play plane reads as background, hazed toward the air (owner’s playtest, 18 Oct: “bullets go through buildings”)', () => {
    for (const id of ['lunar-outpost', 'storm-front', 'flux-lab']) {
      const def = environmentFor(id)!;
      const look = def.looks[def.defaultLook]!;
      for (const layer of def.backdrop!.layers) {
        if (layer.z > -16) expect(look.backdropHaze?.amount[layer.name] ?? 0, `${id} ${layer.name}`).toBeGreaterThanOrEqual(0.3);
      }
    }
  });

  it('only the Street Market is the Lagos map: no other map uses its kit, layout, lamps, dressing, billboards or art (owner, 18 Oct)', () => {
    const marketArt = new Set(readdirSync(new URL('public/assets/backdrops/street_market/', WEB)).map((f) => digest(new URL(`public/assets/backdrops/street_market/${f}`, WEB))));
    const folders = new Set<string>();
    for (const def of Object.values(ENVIRONMENTS)) {
      const own = `assets/backdrops/${def.mapId.replace(/-/g, '_')}/`;
      if (def.backdrop) {
        // each map paints from a folder of its own, named after it
        expect(def.backdrop.base, def.mapId).toBe(own);
        expect(folders.has(def.backdrop.base), def.mapId).toBe(false);
        folders.add(def.backdrop.base);
      }
      if (def.mapId === 'street-market') continue;
      // a kit of its own (Fog Stair's, 26 Oct), never the market's
      const kits = `assets/kits/${def.mapId.replace(/-/g, '_')}/`;
      if (def.kitUrl) expect(def.kitUrl.startsWith(kits), def.mapId).toBe(true);
      if (def.layoutUrl) expect(def.layoutUrl.startsWith(kits), def.mapId).toBe(true);
      expect(def.lamps, def.mapId).toBeUndefined();
      expect(def.dressing, def.mapId).toBeUndefined();
      if (def.ads) {
        // its own slots and pool; the pool may show the sponsors' creatives (Deet Studios, WorldStreet:
        // the owner's own, not Lagos art), never the market's local house art
        expect(def.ads.slots.startsWith(kits), def.mapId).toBe(true);
        expect(def.ads.pool, def.mapId).toBe(`assets/ads/${def.mapId.replace(/-/g, '_')}/house.json`);
        const pool = JSON.parse(readFileSync(new URL(`public/${def.ads.pool}`, WEB), 'utf8')) as { screens: unknown[]; hoardings: unknown[] };
        expect([...pool.screens, ...pool.hoardings], def.mapId).toEqual([]);
      }
      // and none of its painted files is a copy of a Street Market one
      const files = [...Object.values(def.backdrop?.skies ?? {}), ...(def.backdrop?.layers ?? []).flatMap((l) => l.panels.map((p) => p.file))];
      for (const f of files) expect(marketArt.has(digest(new URL(`public/${own}${f}`, WEB))), `${def.mapId} ${f}`).toBe(false);
    }
  });

  it('keeps the extruded play plane, the generated ground and foreground, and fills below ground behind the band', async () => {
    const def = environmentFor('lunar-outpost')!;
    const env = new MapEnvironment(def, maps['lunar-outpost']!, '/', never, fetchNever);
    await env.ready;
    expect(env.drawsPlane).toBe(false);
    const names: string[] = [];
    env.background.traverse((o) => (o as Mesh).isMesh && names.push(o.name));
    expect(names).toContain('ground-skirt');
    expect(names).toContain('sky-art');
    expect(names).toContain('backdrop-far');
    expect(names).toContain('backdrop-mid');
    expect(names).not.toContain('street');
    expect(env.foreground.length).toBeGreaterThan(0);
    const skirt = env.background.getObjectByName('ground-skirt') as Mesh;
    skirt.geometry.computeBoundingBox();
    expect(skirt.geometry.boundingBox!.max.y).toBeLessThanOrEqual(0); // never above the floor line
    expect(skirt.position.z).toBeLessThan(-1); // behind the gameplay band
    env.dispose();
  });

  it('the lab is indoors: an opaque back wall instead of a sky', () => {
    const def = environmentFor('flux-lab')!;
    expect(Object.keys(def.backdrop!.skies)).toEqual([]);
    expect(def.backdrop!.layers.some((l) => l.opaque)).toBe(true);
  });

  it('keeps the generated sky until the painted sky or back wall is in, so a failed image never shows the clear colour', () => {
    for (const id of ['lunar-outpost', 'flux-lab']) {
      const env = new MapEnvironment(environmentFor(id)!, maps[id]!, '/', never, fetchNever);
      const cam = new Camera();
      cam.resize(1280, 720);
      env.update(planePose(cam), { players: [], tick: 0 }, 1 / 60); // no DOM: the art never loads
      const sky = env.background.getObjectByName('sky');
      expect(sky, id).toBeDefined();
      expect(sky!.visible, id).toBe(true);
      expect(env.background.getObjectByName('ground'), id).toBeDefined(); // picked by name from layers.ts
      env.dispose();
    }
  });
});
