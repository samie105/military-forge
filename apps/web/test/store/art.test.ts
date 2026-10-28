/**
 * The Store's baked art (scripts/store-art.mjs → src/store/art.json, public/assets/store/): every store skin has its
 * gun baked and every kill effect a store skin carries has its frame strip, each baked from what's in the repo now
 * (the GLB's and the effect entry's sha256: a changed skin or effect without a re-bake fails here); and the cards
 * show the images, the effect's loop with its still frame.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import art from '../../src/store/art.json';
import { storeArt } from '../../src/store/model';
import { storeBody, type StoreState } from '../../src/store/screen';

const repo = (path: string) => fileURLToPath(new URL(`../../../../${path}`, import.meta.url));
const web = (path: string) => fileURLToPath(new URL(`../../${path}`, import.meta.url));
const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
const RE_BAKE = 'stale: re-run apps/web/scripts/store-art.mjs (see its header)';

interface RawSkin {
  id: string;
  source: { kind: string };
  assets?: { model?: string };
  killEffect?: string;
}
const skins = (JSON.parse(readFileSync(repo('packages/content/cosmetics/weapon-skins.json'), 'utf8')) as { items: RawSkin[] }).items.filter((s) => s.source.kind === 'store' && s.assets?.model);
const effects = (JSON.parse(readFileSync(repo('packages/content/cosmetics/kill-effects.json'), 'utf8')) as { effects: { id: string }[] }).effects;
const guns = art.guns as Record<string, { image: string; sha256: string }>;
const fx = art.killEffects as Record<string, { image: string; sha256: string; frames: number; still: number; frameW: number; frameH: number; ms: number }>;

describe('the Store’s baked art', () => {
  it('every store skin’s gun is baked from its GLB as it is now', () => {
    expect(skins.length).toBeGreaterThan(0);
    for (const s of skins) {
      const model = s.assets!.model!;
      const baked = guns[model];
      expect(baked, `${model}: no baked gun; ${RE_BAKE}`).toBeDefined();
      expect(existsSync(web(`public/assets/${baked!.image}`)), baked!.image).toBe(true);
      expect(baked!.sha256, `${model} ${RE_BAKE}`).toBe(sha256(readFileSync(web(`public/assets/${model}`))));
    }
  });

  it('every kill effect a store skin carries is baked as a frame strip from its content entry as it is now', () => {
    const carried = [...new Set(skins.flatMap((s) => (s.killEffect ? [s.killEffect] : [])))];
    expect(carried).toContain('stardust');
    for (const id of carried) {
      const baked = fx[id];
      expect(baked, `${id}: no baked strip; ${RE_BAKE}`).toBeDefined();
      expect(existsSync(web(`public/assets/${baked!.image}`)), baked!.image).toBe(true);
      expect(baked!.sha256, `${id} ${RE_BAKE}`).toBe(sha256(JSON.stringify(effects.find((e) => e.id === id))));
      expect(baked!.still).toBeGreaterThanOrEqual(0);
      expect(baked!.still).toBeLessThan(baked!.frames);
      // small enough for a phone's card: a strip, never a video
      expect(readFileSync(web(`public/assets/${baked!.image}`)).length).toBeLessThan(150_000);
    }
  });

  it('the cards show the baked gun on both tiers, and the effect’s loop (with its still frame) on the kill-effect tier', () => {
    expect(storeArt('skin_k47_galaxy_relic')).toEqual({ gun: '/assets/store/k47_galaxy_relic.webp', fx: null });
    expect(storeArt('skin_k47_galaxy_relic_fx')).toMatchObject({ gun: '/assets/store/k47_galaxy_relic.webp', fx: { image: '/assets/store/stardust.webp', name: 'Stardust Shatter', frames: fx.stardust!.frames, still: fx.stardust!.still } });
    expect(storeArt('skin_unknown')).toEqual({ gun: null, fx: null });

    const item = (itemId: string, name: string, tier: string, killEffect: string | null) => ({ itemId, line: 'k47_galaxy_relic', name, tier, weaponId: 'k47', killEffect, includes: [], price: 1050, fullPrice: 1050, upgrade: false, money: null, owned: false, claimable: false });
    const state: StoreState = {
      view: { enabled: true, payments: true, mode: 'test', claim: null, currency: { name: 'Brass', walletCap: 20_000 }, bundles: [], items: [item('skin_k47_galaxy_relic', 'Galaxy Relic', 'forged', null), item('skin_k47_galaxy_relic_fx', 'Galaxy Relic + Stardust', 'forged_kill_effect', 'stardust')], account: null },
      failed: null,
      notice: null,
      confirm: null,
      busy: false,
      payments: null,
      deviceAge: null,
    };
    const html = storeBody(state);
    expect(html.match(/<img class="mf-st__gun" src="\/assets\/store\/k47_galaxy_relic\.webp"/g)).toHaveLength(2);
    expect(html).toContain(`--fx-frames:${fx.stardust!.frames};--fx-still:${fx.stardust!.still};--fx-ms:${fx.stardust!.ms}ms`);
    expect(html).toContain('src="/assets/store/stardust.webp"');
    expect(html).toContain('<figcaption>Stardust Shatter</figcaption>');
    // the old placeholder (the K-47 glyph in cream) is gone where a render exists
    expect(html).not.toContain('mf-st__gun--glyph');
  });
});
