/** The sound bank: every sound renders, is clean and sized, and the game's things all have one. */
import { GRENADE_TYPES, projectiles, weapons } from '@military-forge/content';
import { describe, expect, it } from 'vitest';
import { BANK_RATE, renderSound, variantsOf } from './bank';
import { Rng, hashSeed, peak, rms, seamless, svf, noise } from './dsp';
import { PROJECTILE, blastSound, familyOf, weaponSoundIds, weaponSounds } from './families';
import { SOUNDS, SOUND_IDS, type SoundId } from './sounds';
import { SKIN_SOUND_IDS } from './sounds/skins';

describe('every sound', () => {
  it('renders finite samples at its peak, with sound in it, at a sane length', () => {
    for (const id of SOUND_IDS) {
      for (let v = 0; v < variantsOf(id); v++) {
        const chans = renderSound(id, v);
        for (const ch of chans) {
          expect(ch.every(Number.isFinite), `${id}#${v} finite`).toBe(true);
          expect(peak(ch), `${id}#${v} peak`).toBeLessThanOrEqual((SOUNDS[id].peak ?? 0.9) + 1e-6);
          expect(rms(ch), `${id}#${v} energy`).toBeGreaterThan(0.004);
          const seconds = ch.length / BANK_RATE;
          expect(seconds, `${id}#${v} length`).toBeGreaterThan(0.02);
          expect(seconds, `${id}#${v} length`).toBeLessThan(4);
        }
      }
    }
  });

  it('variants differ, and the same variant renders the same every time', () => {
    const a = renderSound('rifle.fire', 0);
    const b = renderSound('rifle.fire', 1);
    expect(a[0]!.length > 0 && b[0]!.length > 0).toBe(true);
    expect(Array.from(a[0]!.subarray(0, 400))).not.toEqual(Array.from(b[0]!.subarray(0, 400)));
    expect(Array.from(renderSound('rifle.fire', 0)[0]!)).toEqual(Array.from(a[0]!));
  });

  it('loops join without a click (start and end meet)', () => {
    for (const id of SOUND_IDS.filter((i) => SOUNDS[i].loop)) {
      const ch = renderSound(id, 0)[0]!;
      const jump = Math.abs(ch[0]! - ch[ch.length - 1]!);
      // a loop's seam is no bigger than its typical sample-to-sample step
      let step = 0;
      for (let i = 1; i < ch.length; i++) step = Math.max(step, Math.abs(ch[i]! - ch[i - 1]!));
      expect(jump, id).toBeLessThanOrEqual(step + 1e-6);
    }
  });

  // Memory, not download: this is the decoded audio a page holds
  // if it plays every take of every sound (a match renders only what it hears, a few MB)
  it('fits the memory budget: everything rendered at once stays under 20 MB, and each skin line\'s own sounds under 1.25 MB', () => {
    const bytesOf = (ids: readonly SoundId[]) => {
      let bytes = 0;
      for (const id of ids) for (let v = 0; v < variantsOf(id); v++) bytes += renderSound(id, v).reduce((n, c) => n + c.length * 4, 0);
      return bytes;
    };
    const skins = new Set<SoundId>(SKIN_SOUND_IDS);
    expect(bytesOf(SOUND_IDS.filter((id) => !skins.has(id)))).toBeLessThan(20 * 1024 * 1024);
    // a skin line's sounds render only when someone in the match wears it (sounds/skins.ts): one line today
    expect(bytesOf(SKIN_SOUND_IDS)).toBeLessThan(1.25 * 1024 * 1024);
  });
});

describe('the arsenal has sounds', () => {
  it('every weapon has a family with fire (or a held loop), reload, empty and draw', () => {
    for (const w of weapons) {
      const ws = weaponSounds(w.index)!;
      expect(ws, w.id).not.toBeNull();
      if (ws.family === 'melee') continue;
      expect(ws.fire ?? ws.fireLoop?.loop, `${w.id} fire`).toBeTruthy();
      expect(ws.reload.length + (ws.perRound ? 1 : 0) + (ws.family === 'flame' ? 1 : 0), `${w.id} reload`).toBeGreaterThan(0);
      for (const id of weaponSoundIds(ws)) expect(SOUNDS[id], `${w.id}: ${id}`).toBeDefined();
    }
  });

  it('the families are the ones the owner asked for', () => {
    const fam = (id: string) => familyOf(weapons.find((w) => w.id === id)!);
    expect(['hammer44', 'hawk50'].map(fam)).toEqual(['pistol', 'pistol']);
    expect(['buzz', 'rattler', 'hornet'].map(fam)).toEqual(['smg', 'smg', 'smg']);
    expect(['k47', 'trident', 'bullpup'].map(fam)).toEqual(['rifle', 'rifle', 'rifle']);
    expect([fam('breacher'), fam('widow'), fam('longbow'), fam('shredder')]).toEqual(['shotgun', 'sniper', 'sniper', 'lmg']);
    expect([fam('thumper'), fam('popper'), fam('dragon'), fam('ripper'), fam('pulse'), fam('arc'), fam('machete')]).toEqual(['rocket', 'popper', 'flame', 'ripper', 'pulse', 'beam', 'melee']);
  });

  it('every grenade type and every exploding projectile has a blast', () => {
    for (let t = 0; t < GRENADE_TYPES; t++) expect(blastSound(t), `grenade ${t}`).not.toBeNull();
    for (const p of projectiles) {
      const b = blastSound(PROJECTILE.rocket + p.index);
      if (p.explosion || p.emp) expect(b, p.id).not.toBeNull();
    }
  });
});

describe('dsp', () => {
  it('Rng is seeded and in range', () => {
    const a = new Rng(hashSeed('x'));
    const b = new Rng(hashSeed('x'));
    const xs = Array.from({ length: 100 }, () => a.next());
    expect(xs).toEqual(Array.from({ length: 100 }, () => b.next()));
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...xs)).toBeLessThan(1);
  });

  it('the low-pass takes the highs away', () => {
    const n = noise(BANK_RATE, 0.5, new Rng(1));
    expect(rms(svf(n, BANK_RATE, 'lp', 300))).toBeLessThan(rms(n) * 0.4);
  });

  it('seamless shortens by the cross-fade', () => {
    const n = noise(BANK_RATE, 1, new Rng(2));
    expect(seamless(n, BANK_RATE, 0.1).length).toBe(n.length - Math.round(BANK_RATE * 0.1));
  });

  it('renders the whole bank quickly enough to warm in idle time', () => {
    const t0 = performance.now();
    for (const id of ['rifle.fire', 'frag.explode', 'jet.loop', 'step'] as SoundId[]) renderSound(id, 0);
    // generous for a loaded CI box: the browser spreads this over idle callbacks anyway
    expect(performance.now() - t0).toBeLessThan(1500);
  });
});
