/**
 * Weapon skins' own sounds against their base sounds (docs/17 V11, §3.6, §3.7; docs/04 §1 #5): the same length,
 * loudness (±1 LU), peak (±1 dB), frequency band (octave shares ±3 dB, centroid ±15 %), transient and playback
 * (range, far layer, voices, priority), so a skinned gun is heard as far and reads as the same gun; only the
 * timbre changes. And the Stardust Shatter's sound: within its effect's time, no louder than the base death voice,
 * clear of the footsteps' and the jetpack's bands.
 */
import { cosmetics, getKillEffect, killEffects, weapons } from '@military-forge/content';
import { describe, expect, it } from 'vitest';
import { centroid, loudness, momentaryMax, octaveShares, peakDb, shareBelow } from './analysis';
import { BANK_RATE, renderSound, variantsOf } from './bank';
import { familyOf, skinnedWeaponSounds, weaponSoundIds, weaponSounds } from './families';
import { SOUNDS, isSoundId, type SoundId } from './sounds';
import { loadRecordingsFromDisk } from './recordings.test-util';

// the recorded takes (the app fetches their banks before the sound starts: recordings/banks.ts)
loadRecordingsFromDisk();

const sr = BANK_RATE;
const skins = cosmetics.filter((c) => c.sounds);
/** every (base, skin) sound pair a skin swaps */
const pairs = skins.flatMap((c) => Object.entries(c.sounds!).map(([from, to]) => ({ skin: c.id, from: from as SoundId, to: to as SoundId })));
const db = (x: number) => 10 * Math.log10(x);

describe('the skins\' sounds exist and swap only that gun\'s sounds', () => {
  it('every swap names two sounds in the bank, the base one a sound of the skin\'s gun', () => {
    expect(pairs.length).toBeGreaterThanOrEqual(5);
    for (const { skin, from, to } of pairs) {
      expect(isSoundId(from), `${skin}: ${from}`).toBe(true);
      expect(isSoundId(to), `${skin}: ${to}`).toBe(true);
      const gun = weapons.find((w) => w.id === cosmetics.find((c) => c.id === skin)!.weaponId)!;
      expect(weaponSoundIds(weaponSounds(gun.index)!), `${skin}: ${from} is the ${gun.id}'s`).toContain(from);
    }
  });

  it('the inspect chime is an interface sound; the kill effects\' sounds are in the bank', () => {
    for (const c of cosmetics.filter((x) => x.inspectSound)) {
      expect(isSoundId(c.inspectSound!), c.id).toBe(true);
      expect(SOUNDS[c.inspectSound as SoundId].bus, c.id).toBe('ui');
    }
    for (const e of killEffects) if (e.sound) expect(isSoundId(e.sound), e.id).toBe(true);
    expect(getKillEffect('stardust')!.sound).toBe('stardust.shatter');
  });

  it('a skinned gun keeps every step, timing, pitch and level of the base\'s; only the ids change', () => {
    const k47 = weapons.find((w) => w.id === 'k47')!;
    const relic = cosmetics.find((c) => c.id === 'skin_k47_galaxy_relic')!;
    const base = weaponSounds(k47.index)!;
    const skinned = skinnedWeaponSounds(k47.index, relic.id, relic.sounds!)!;
    expect(skinned.fire).toBe('relic.fire');
    expect(skinned.reload.map((s) => s.at)).toEqual(base.reload.map((s) => s.at));
    expect(skinned.reload.map((s) => s.id)).toEqual(['relic.magout', 'relic.magin', 'relic.bolt']);
    expect(skinned.draw).toBe('relic.draw');
    expect(skinned.empty).toBe(base.empty);
    expect([skinned.rate, skinned.gain, skinned.family, skinned.brass]).toEqual([base.rate, base.gain, base.family, base.brass]);
    expect(familyOf(k47)).toBe('rifle');
  });
});

describe('parity with the base sound (V11)', () => {
  for (const { from, to } of pairs) {
    describe(`${to} vs ${from}`, () => {
      it('the same playback: bus, range, far layer, voices, cooldown, priority, takes, level', () => {
        const a = SOUNDS[from];
        const b = SOUNDS[to];
        for (const k of ['bus', 'range', 'far', 'farFrom', 'farTo', 'maxVoices', 'cooldown', 'priority', 'variants', 'gain', 'wet', 'soft', 'pitchJitter'] as const) expect(b[k], k).toBe(a[k]);
      });

      for (let v = 0; v < variantsOf(from); v++) {
        it(`take ${v}: the same length, loudness ±1 LU, peak ±1 dB, band and centroid`, () => {
          const x = renderSound(from, v)[0]!;
          const y = renderSound(to, v)[0]!;
          expect(y.length).toBe(x.length);
          expect(Math.abs(loudness(y, sr) - loudness(x, sr))).toBeLessThanOrEqual(1);
          expect(Math.abs(peakDb(y) - peakDb(x))).toBeLessThanOrEqual(1);
          const sx = octaveShares(x, sr);
          const sy = octaveShares(y, sr);
          sx.forEach((s, i) => {
            if (s >= 0.02) expect(Math.abs(db(sy[i]! / s)), `octave ${i}`).toBeLessThanOrEqual(3);
          });
          expect(Math.abs(centroid(y, sr) / centroid(x, sr) - 1)).toBeLessThanOrEqual(0.15);
        });
      }
    });
  }

  it('the fire keeps the K-47\'s transient: its first 4 ms (the crack and the blast\'s front) are the base\'s samples × one level', () => {
    for (let v = 0; v < variantsOf('rifle.fire'); v++) {
      const x = renderSound('rifle.fire', v)[0]!;
      const y = renderSound('relic.fire', v)[0]!;
      const n = Math.round(sr * 0.004);
      // the level: least squares over those 4 ms; every sample then within 0.1 % of full scale of base × level
      let xy = 0;
      let xx = 0;
      for (let i = 0; i < n; i++) {
        xy += x[i]! * y[i]!;
        xx += x[i]! * x[i]!;
      }
      const k = xy / xx;
      expect(Math.abs(20 * Math.log10(k))).toBeLessThanOrEqual(1);
      for (let i = 0; i < n; i++) expect(Math.abs(y[i]! - k * x[i]!)).toBeLessThan(1e-3);
    }
  });
});

describe('the Stardust Shatter\'s sound (docs/17 §3.7)', () => {
  const effect = getKillEffect('stardust')!;
  const id = effect.sound as SoundId;
  const def = SOUNDS[id];
  const death = SOUNDS['voice.death'];
  const level = (sid: SoundId, v: number) => momentaryMax(renderSound(sid, v)[0]!, sr) + 20 * Math.log10(SOUNDS[sid].gain ?? 1);

  it('≤ the effect\'s duration (≤ 1 s), heard no further than a death', () => {
    for (let v = 0; v < variantsOf(id); v++) expect(renderSound(id, v)[0]!.length / sr).toBeLessThanOrEqual(effect.durationS);
    expect(def.range!).toBeLessThanOrEqual(death.range!);
    expect(def.loop).toBeFalsy();
    expect(def.far).toBeUndefined();
  });

  it('no louder than the base death voice: its loudest 400 ms ≥ 1 dB under the death voice\'s quietest take\'s', () => {
    let quietestDeath = Infinity;
    for (let v = 0; v < variantsOf('voice.death'); v++) quietestDeath = Math.min(quietestDeath, level('voice.death', v));
    for (let v = 0; v < variantsOf(id); v++) expect(level(id, v)).toBeLessThanOrEqual(quietestDeath - 1);
  });

  it('above 2.8 kHz, where neither the footsteps (thump, scuff) nor the jetpack\'s roar sit', () => {
    for (let v = 0; v < variantsOf(id); v++) expect(shareBelow(renderSound(id, v)[0]!, sr, 2800)).toBeLessThanOrEqual(0.05);
    // and those cues really are below it
    for (const cue of ['step', 'jet.loop'] as SoundId[]) expect(shareBelow(renderSound(cue, 0)[0]!, sr, 2800), cue).toBeGreaterThanOrEqual(0.85);
  });
});
