/**
 * Weapon skins and kill effects against docs/17 §3.3–3.7: the automated rows of the visual-advantage
 * checklist that content can hold on its own (V1, V5's hue, V7, V13's limits). The tracer's width, length,
 * speed and brightness in the renderer are apps/web's test/skins/tracer.test.ts.
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
  killEffectOf,
  killEffects,
  luminance,
  nearestReserved,
  sanitizeCosmeticLoadout,
  tracerTintOf,
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
    const hues = tracerTintOf(wearing('skin_k47_galaxy_relic'), 'k47')!;
    expect(hues.bolt).toMatch(/^#[0-9a-f]{6}$/);
    expect(hues.trail).toMatch(/^#[0-9a-f]{6}$/);
    expect(tracerTintOf(null, 'k47')).toBeNull();
  });
});

describe('tracer hue (V5, V7)', () => {
  // the base rifle tracer's tint (apps/web/public/assets/vfx/weapons.vfx.json `tracer.styles.rifle.tint`; the web's
  // tracer test reads the file itself and checks this copy)
  const BASE_TRACER = '#ffe9a0';
  /** every tracer hue a skin sets: the bolt's and its path line's */
  const hues = skins.flatMap((c) => [c.tracerTint, c.tracerTrail].filter((h): h is string => !!h).map((hex) => ({ id: c.id, hex })));

  it('a hue only: each tint\'s luminance within ±10% of the base tracer\'s', () => {
    expect(hues.length).toBeGreaterThan(0);
    for (const { id, hex } of hues) {
      const ratio = luminance(hex) / luminance(BASE_TRACER);
      expect(ratio, `${id} ${hex}`).toBeGreaterThanOrEqual(0.9);
      expect(ratio, `${id} ${hex}`).toBeLessThanOrEqual(1.1);
    }
  });

  it('every tracer hue ≥ ΔE 15 from every reserved colour (teams, marks, HP, grenades, EMP, events, zones)', () => {
    expect(RESERVED_COLOURS.length).toBeGreaterThan(20);
    for (const { id, hex } of hues) {
      const near = nearestReserved(hex);
      expect(near.deltaE, `${id}: ${hex} is ΔE ${near.deltaE.toFixed(1)} from ${near.name}`).toBeGreaterThanOrEqual(RESERVED_DELTA_E);
    }
  });

  it('a trail hue only with a bolt hue (a skin never recolours half a tracer)', () => {
    for (const s of skins) if (s.tracerTrail) expect(s.tracerTint, s.id).toBeDefined();
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
      expect(e.still.durationS, e.id).toBeLessThanOrEqual(KILL_EFFECT_LIMITS.maxDurationS);
      expect(e.rise, `${e.id}: drifts, never flies off`).toBeLessThanOrEqual(0.5);
      expect(e.sound, `${e.id}: no sound until one is checked for loudness and band`).toBeNull();
    }
  });

  it('never brighter than a lit body, and clear of the reserved colours (never a hit marker, damage or team cue)', () => {
    for (const e of killEffects) {
      for (const c of [...e.palette, e.bodyTint, e.still.tint]) {
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
