/**
 * Feel targets: the numbers the tuning must hit (docs/02 §19, docs/03 §6, NOTES.md §2).
 * Grounded in the genre's feel (thrust ~2–3 s, refill ~3–4 s) and the 2.5D camera
 * (default view ≈ 36 m wide × 20 m tall). `tune` sweeps parameters against these ranges.
 */
export interface Target {
  key: string;
  label: string;
  min: number;
  max: number;
  why: string;
}

export const MOVEMENT_TARGETS: Target[] = [
  { key: 'burn', label: 'Full-tank burn (s)', min: 2.2, max: 2.6, why: 'genre feel: 2–3 s of thrust' },
  {
    key: 'climb',
    label: 'Full-tank climb (m)',
    min: 12.2,
    max: 13.3,
    why: 'clears the tallest tower (12 m, map lint) with a little margin; well under the 20 m view so high ground is never out of reach',
  },
  { key: 'jetRun', label: 'Jet + run distance (m)', min: 15, max: 32, why: 'one tank < one screen width (36 m), fights stay on screen' },
  { key: 'hover', label: 'Best hover above 3 m (s)', min: 2.0, max: 4.5, why: 'feathering buys time but cannot camp the air (best of several tap rhythms)' },
  { key: 'refill', label: 'Ground refill from empty (s)', min: 2.8, max: 3.6, why: 'genre feel: ~3–4 s' },
  { key: 'tapHop', label: '0.2 s tap hop (m)', min: 1.0, max: 3.0, why: 'a quick tap must clear crates and low cover' },
  { key: 'to2m', label: 'Time to 2 m from standing (s)', min: 0, max: 0.5, why: 'take-off feels instant: dodging upward is a reaction' },
  { key: 'toWalk', label: 'Time to walk speed (ms)', min: 80, max: 140, why: 'crisp starts' },
  { key: 'stop', label: 'Stop distance (m)', min: 0.1, max: 0.3, why: 'crisp stops' },
];

export const BLAST_TARGETS: { distance: number; flewMin: number; flewMax: number; peakMin: number; why: string }[] = [
  { distance: 2, flewMin: 12, flewMax: 22, peakMin: 4, why: 'a near miss throws you half a screen: blasts move fights (owner request)' },
  { distance: 3, flewMin: 4, flewMax: 10, peakMin: 1.5, why: 'still a real launch at the edge of the damage radius' },
];

export interface WeaponTarget {
  label: string;
  /** weapon id (packages/content weapons.ts) */
  weapon: string;
  distance: number;
  airborne: boolean;
  hitMin?: number;
  hitMax?: number;
  ttkMax?: number;
  why: string;
}

export const WEAPON_TARGETS: WeaponTarget[] = [
  { label: 'Buzz @5 m grounded', weapon: 'buzz', distance: 5, airborne: false, hitMin: 0.85, ttkMax: 1.6, why: 'close-range SMG shreds up close' },
  { label: 'Buzz @12 m grounded', weapon: 'buzz', distance: 12, airborne: false, hitMin: 0.5, hitMax: 0.75, ttkMax: 2.6, why: 'usable at mid range, not a rifle' },
  { label: 'Buzz @18 m grounded', weapon: 'buzz', distance: 18, airborne: false, hitMax: 0.5, why: 'still weak at long range (role separation)' },
  { label: 'Hammer @18 m grounded', weapon: 'hammer44', distance: 18, airborne: false, hitMin: 0.95, why: 'accurate when planted' },
  { label: 'Hammer @18 m airborne', weapon: 'hammer44', distance: 18, airborne: true, hitMin: 0.55, hitMax: 0.8, why: 'flying costs accuracy, but air duels stay viable' },
  { label: 'K-47 @5 m grounded', weapon: 'k47', distance: 5, airborne: false, hitMin: 0.95, ttkMax: 1.0, why: 'docs/03 §6: 10 body shots, 0.9 s' },
  { label: 'K-47 @12 m grounded', weapon: 'k47', distance: 12, airborne: false, hitMin: 0.5, hitMax: 0.7, ttkMax: 2.0, why: 'mid-range rifle: beats the Buzz at 12 m but stays wild' },
  { label: 'K-47 @18 m grounded', weapon: 'k47', distance: 18, airborne: false, hitMax: 0.5, ttkMax: 4.0, why: 'long range belongs to the Hammer and the Widow' },
  { label: 'Breacher @5 m grounded', weapon: 'breacher', distance: 5, airborne: false, ttkMax: 0.8, why: 'two pumps at 5 m, one inside ~4 m (docs/03 §6)' },
  { label: 'Breacher @12 m grounded', weapon: 'breacher', distance: 12, airborne: false, hitMax: 0.35, why: 'a shotgun is no mid-range gun' },
  { label: 'Widow @18 m grounded', weapon: 'widow', distance: 18, airborne: false, hitMin: 0.95, ttkMax: 0.85, why: 'docs/03 §6: 2 body shots, 0.8 s' },
  { label: 'Machete @1 m grounded', weapon: 'machete', distance: 1, airborne: false, hitMin: 0.95, ttkMax: 0.2, why: 'one swing after the 0.15 s windup' },
];
