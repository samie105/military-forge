/**
 * Weapon skins and kill effects against docs/17 §3.3–3.7: the automated rows of the visual-advantage
 * checklist that content can hold on its own (V1, V5's glow colours, V7, V13's limits). The tracer's core, width,
 * length and speed in the renderer are apps/web's render3d/test/skins.test.ts.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_COSMETIC_LOADOUT,
  KILL_EFFECT_LIMITS,
  RESERVED_COLOURS,
  RESERVED_DELTA_E,
  WEAPON_SKIN_GUNS,
  cosmetics,
  cosmeticsForSlot,
  deltaE,
  getCosmetic,
  getKillEffect,
  killEffectColours,
  killEffectOf,
  killEffects,
  luminance,
  nearestReserved,
  sanitizeCosmeticLoadout,
  tracerGlowOf,
  weaponSkinOf,
  weaponSkinSlot,
  weapons,
  type CosmeticLoadout,
} from '../src';

const skins = cosmetics.filter((c) => c.weaponId !== undefined);
const wearing = (id: string): CosmeticLoadout => ({ ...DEFAULT_COSMETIC_LOADOUT, items: { ...DEFAULT_COSMETIC_LOADOUT.items, skin_k47: id } });

describe('weapon skins (docs/17 §3.3)', () => {
  it('every skin-line gun is a real gun with one starter base skin as its slot default', () => {
    for (const gun of WEAPON_SKIN_GUNS) {
      expect(weapons.some((w) => w.id === gun), gun).toBe(true);
      const slot = weaponSkinSlot(gun)!;
      const base = cosmeticsForSlot(slot).filter((c) => c.tier === 'base');
      expect(base.map((c) => c.id)).toEqual([DEFAULT_COSMETIC_LOADOUT.items[slot]]);
      expect(base[0]!.source.kind).toBe('starter');
    }
    expect(weaponSkinSlot('widow')).toBeNull();
  });

  it('every skin sits in its gun\'s slot; only the paid tiers carry a model, and none is sold in a way that grants it to everyone', () => {
    for (const s of skins) {
      expect(s.slot, s.id).toBe(weaponSkinSlot(s.weaponId!));
      if (s.tier === 'base') expect(s.assets.model, s.id).toBeUndefined();
      else {
        expect(s.assets.model, s.id).toMatch(/^weapons\/skins\/[a-z0-9_]+\.glb$/);
        expect(s.source.kind, `${s.id}: paid skins are store items (no purchase path yet: owner grants only)`).toBe('store');
      }
    }
  });

  it('a kill effect only on the forged_kill_effect tier, naming a real effect, and that tier includes its plain Forged skin', () => {
    for (const s of skins) {
      if (s.tier === 'forged_kill_effect') {
        expect(getKillEffect(s.killEffect ?? ''), s.id).toBeDefined();
        for (const inc of s.includes ?? []) expect(getCosmetic(inc)?.tier, `${s.id} includes ${inc}`).toBe('forged');
        expect(s.includes?.length, s.id).toBeGreaterThan(0);
      } else expect(s.killEffect, s.id).toBeUndefined();
    }
  });

  it('a skin never reaches another gun: a K-47 skin in another slot falls back', () => {
    const l = sanitizeCosmeticLoadout({ ...DEFAULT_COSMETIC_LOADOUT, items: { ...DEFAULT_COSMETIC_LOADOUT.items, hair: 'skin_k47_galaxy_relic' } });
    expect(l.items.hair).toBe(DEFAULT_COSMETIC_LOADOUT.items.hair);
  });

  it('lookups: the base skin is no skin; the effect and hue follow the gun', () => {
    expect(weaponSkinOf(DEFAULT_COSMETIC_LOADOUT, 'k47')).toBeNull();
    expect(weaponSkinOf(wearing('skin_k47_galaxy_relic'), 'k47')?.id).toBe('skin_k47_galaxy_relic');
    expect(weaponSkinOf(wearing('skin_k47_galaxy_relic'), 'hammer44')).toBeNull();
    expect(killEffectOf(wearing('skin_k47_galaxy_relic'), 'k47')).toBeNull();
    expect(killEffectOf(wearing('skin_k47_galaxy_relic_fx'), 'k47')?.id).toBe('stardust');
    expect(killEffectOf(wearing('skin_k47_galaxy_relic_fx'), 'widow')).toBeNull();
    const glow = tracerGlowOf(wearing('skin_k47_galaxy_relic'), 'k47')!;
    for (const hex of glow) expect(hex).toMatch(/^#[0-9a-f]{6}$/);
    expect(tracerGlowOf(null, 'k47')).toBeNull();
    expect(tracerGlowOf(DEFAULT_COSMETIC_LOADOUT, 'k47')).toBeNull();
  });
});

describe('tracer glow (V5, V7; owner, 28 Oct: "yes upgrade it")', () => {
  // the base rifle tracer's tint (apps/web/public/assets/vfx/weapons.vfx.json `tracer.styles.rifle.tint`; the web's
  // tracer test reads the file itself and checks this copy). The bolt's core always draws in it.
  const BASE_TRACER = '#ffe9a0';
  /** every glow stop a skin sets */
  const stops = skins.flatMap((c) => (c.tracerGlow ?? []).map((hex) => ({ id: c.id, hex })));

  it('a glow is a gradient of 2–3 stops, and only paid skins carry one', () => {
    expect(stops.length).toBeGreaterThan(0);
    for (const s of skins) {
      if (!s.tracerGlow) continue;
      expect(s.tier, s.id).not.toBe('base');
      expect(s.tracerGlow.length, s.id).toBeGreaterThanOrEqual(2);
      expect(s.tracerGlow.length, s.id).toBeLessThanOrEqual(3);
    }
  });

  it('every stop is a saturated colour, dimmer than the base core (the core stays the brightest part)', () => {
    for (const { id, hex } of stops) {
      const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as [number, number, number];
      const max = Math.max(r, g, b);
      expect((max - Math.min(r, g, b)) / max, `${id} ${hex}: saturated`).toBeGreaterThanOrEqual(0.5);
      expect(luminance(hex), `${id} ${hex}`).toBeLessThan(luminance(BASE_TRACER));
    }
  });

  it('every stop ≥ ΔE 15 from every reserved colour (teams, marks, HP, grenades, EMP, events, zones)', () => {
    expect(RESERVED_COLOURS.length).toBeGreaterThan(20);
    for (const { id, hex } of stops) {
      const near = nearestReserved(hex);
      expect(near.deltaE, `${id}: ${hex} is ΔE ${near.deltaE.toFixed(1)} from ${near.name}`).toBeGreaterThanOrEqual(RESERVED_DELTA_E);
    }
  });

  it('the ΔE helper agrees with known values', () => {
    expect(deltaE('#ffffff', '#ffffff')).toBe(0);
    expect(deltaE('#000000', '#ffffff')).toBeCloseTo(100, 0);
  });
});

describe('kill effects (docs/17 §3.7, docs/04 §7)', () => {
  it('≤ 1 s, ≤ 80 particles, a still variant over the same time', () => {
    expect(killEffects.length).toBeGreaterThan(0);
    for (const e of killEffects) {
      expect(e.durationS, e.id).toBeGreaterThan(0);
      expect(e.durationS, e.id).toBeLessThanOrEqual(KILL_EFFECT_LIMITS.maxDurationS);
      expect(e.particles, e.id).toBeLessThanOrEqual(KILL_EFFECT_LIMITS.maxParticles);
      expect(e.shards.count + e.sparkles.count + e.swirl.count, e.id).toBe(e.particles);
      expect(e.still.durationS, e.id).toBeLessThanOrEqual(KILL_EFFECT_LIMITS.maxDurationS);
      // every quad is gone by the end: the late phases start early enough for their longest life
      expect(e.shards.lifeS[1], e.id).toBeLessThanOrEqual(e.durationS);
      expect(e.sparkles.secondWaveS + e.sparkles.lifeS[1], e.id).toBeLessThanOrEqual(e.durationS);
      expect(e.swirl.atS + e.swirl.lifeS[1], e.id).toBeLessThanOrEqual(e.durationS);
      expect(e.swirl.riseM, `${e.id}: drifts, never flies off`).toBeLessThanOrEqual(0.5);
      expect(e.dissolveS[0], e.id).toBeLessThan(e.dissolveS[1]);
      expect(e.dissolveS[1], `${e.id}: the body goes before the shards do`).toBeLessThanOrEqual(e.shards.lifeS[0]);
      expect(e.shards.burstMps, `${e.id}: a crumble, not a blast`).toBeLessThanOrEqual(0.5);
      // no quad bigger than a fist: the shatter reads as the body breaking up, never a cloud over the spot
      for (const p of [e.shards, e.sparkles, e.swirl]) expect(p.sizeM[1], e.id).toBeLessThanOrEqual(0.14);
      expect(e.sound, `${e.id}: no sound until one is checked for loudness and band`).toBeNull();
    }
  });

  it('never brighter than a lit body, and clear of the reserved colours (never a hit marker, damage or team cue)', () => {
    for (const e of killEffects) {
      for (const c of killEffectColours(e)) {
        expect(luminance(c), `${e.id} ${c}: no glare`).toBeLessThanOrEqual(0.9);
        const near = nearestReserved(c);
        expect(near.deltaE, `${e.id}: ${c} is ΔE ${near.deltaE.toFixed(1)} from ${near.name}`).toBeGreaterThanOrEqual(RESERVED_DELTA_E);
      }
      expect(luminance(e.still.tint), `${e.id}: the still variant is a dim tint`).toBeLessThanOrEqual(0.25);
    }
  });

  it('every effect is used by some skin', () => {
    for (const e of killEffects) expect(skins.some((s) => s.killEffect === e.id), e.id).toBe(true);
  });
});
