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
  // the owner's playtests: "the fuel finishes quick", then "I want the fuel longer". The tank grew 40%
  // twice (fuelMax 100 → 140 → 196) at the same burn and air regen
  { key: 'burn', label: 'Full-tank burn (s)', min: 4.2, max: 4.7, why: 'twice 40% longer than the 2.25 s tank (owner: "I want the fuel longer")' },
  {
    key: 'climb',
    label: 'Full-tank climb (m)',
    min: 23.5,
    max: 27.5,
    why: 'clears the tallest tower (12 m, map lint) twice over; past the 20 m view, so the camera follows you up (as in low-g)',
  },
  { key: 'jetRun', label: 'Jet + run distance (m)', min: 30, max: 46, why: 'one tank crosses a little more than one screen width (36 m): longer flights, by the owner\'s ask' },
  { key: 'hover', label: 'Best hover above 3 m (s)', min: 6, max: 9.5, why: 'feathering buys time (the burn and air regen are unchanged: the same rhythm, a bigger tank)' },
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

/** Map zones at their kinds' defaults (docs/02 §20, packages/content ZONE_KINDS); keys are ZoneMetrics fields. */
export const ZONE_TARGETS: Target[] = [
  { key: 'lowGTapHop', label: 'Low-g: 0.2 s tap hop (m)', min: 3, max: 5, why: 'a tap clears a storey: low gravity reads at once' },
  { key: 'lowGClimb', label: 'Low-g: full-tank climb (m)', min: 28, max: 34, why: 'well past the 25 m tank on normal ground: low gravity reads (the camera follows you up)' },
  { key: 'zeroGDrift', label: 'Zero-g: drift 1 s after a tap (m/s)', min: 3, max: 6, why: 'a tap sends you drifting at about walking speed, and you keep it' },
  { key: 'zeroGDiveTurn', label: 'Zero-g: Down turns the drift around (s)', min: 0.15, max: 0.6, why: 'diving is quick: zero-g never traps you at the ceiling' },
  { key: 'longFlightBurn', label: 'Long flight: full-tank burn (s)', min: 10, max: 12.5, why: '2.5× the 4.45 s tank: noticeably longer flights' },
  { key: 'longFlightRun', label: 'Long flight: jet + run on one tank (m)', min: 75, max: 120, why: 'one tank crosses two to three screens (36 m)' },
  { key: 'reverseSettle', label: 'Reversed pocket: bob settles (s)', min: 2, max: 5, why: 'you hover at the edge after a few seconds: floaty, not nauseating' },
  { key: 'windDrift', label: 'Wind: drift in a 1 s fall (m)', min: 3, max: 7, why: 'felt in every flight and grenade arc, never a teleport' },
  { key: 'mudSpeed', label: 'Mud: walk speed (m/s)', min: 2, max: 2.6, why: 'about crouch-walk speed (2.2 m/s)' },
  { key: 'waterSink', label: 'Deep water: sink speed after 1 s (m/s)', min: 3.5, max: 6, why: 'slower than a fall (16 m/s terminal), not a hover' },
  { key: 'jumpPadApex', label: 'Jump pad: apex from standing (m)', min: 5.5, max: 8, why: 'reaches a second storey (~6 m) without fuel' },
  { key: 'boostPadFlight', label: 'Boost pad: flight from a run (m)', min: 9, max: 16, why: 'a third of a screen in one throw' },
];

/** Bullet fog at its default (0.35): 10 m of it starting 5 m out. */
export const FOG_TARGETS: { weapon: string; min: number; max: number; why: string }[] = [
  { weapon: 'Hammer .44', min: 10, max: 14, why: 'fog halves a pistol\'s 26 m: bullets don\'t go far' },
  { weapon: 'Widow', min: 35, max: 45, why: 'the sniper still reaches through, at two thirds of its 60 m' },
];

/** Map events at their kinds' defaults (docs/02 §20.7, packages/content EVENT_KINDS); keys are EventMetrics fields. */
export const EVENT_TARGETS: Target[] = [
  { key: 'surgeClimb', label: 'Gravity surge: full-tank climb (m)', min: 16, max: 21, why: 'high ground gets harder to reach for 15 s: about three quarters of a normal (25 m) climb' },
  { key: 'lowGravityTapHop', label: 'Low gravity: 0.2 s tap hop (m)', min: 3, max: 5, why: 'the same float as a low-g zone, map-wide' },
  { key: 'fogHammerReach', label: 'Fog bank: Hammer reach (m)', min: 9, max: 12, why: 'pistols become close-range guns: bullets don\'t go far' },
  { key: 'gustDrift', label: 'Wind gusts: drift of a 1 s fall at a peak (m)', min: 4, max: 9, why: 'a gust visibly throws fliers sideways, then dies down' },
];

/** Dash (docs/02 §21, owner request: "brief, like a fighting game's, but up and down too"); keys are DashMetrics fields. */
export const DASH_TARGETS: Target[] = [
  { key: 'flat', label: 'Dash: ground covered from standing (m)', min: 2.6, max: 3.1, why: '40% farther than the first 2.05 m (owner: "the dash to go farther"), still a hop, not a teleport' },
  { key: 'up', label: 'Dash: up from standing (m)', min: 2.4, max: 3, why: 'onto a crate and then some, under half a second storey (~6 m): the jetpack still owns real height' },
  { key: 'slamTime', label: 'Dash: down from a 6 m hover, to the ground (s)', min: 0.3, max: 0.5, why: 'a real drop: falling takes ~0.8 s' },
  { key: 'wallStop', label: 'Dash: at a wall 1 m away, distance covered (m)', min: 0.95, max: 1, why: 'move-and-slide stops it at the wall: no tunnelling' },
  { key: 'burst', label: 'Dash: burst length (s)', min: 0.1, max: 0.17, why: 'brief: the animation is a blink, not a run' },
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
  // the owner's "more guns" (docs/03 §5–6 roles)
  { label: 'Hawk @12 m grounded', weapon: 'hawk50', distance: 12, airborne: false, hitMin: 0.9, ttkMax: 3.5, why: 'the weakest gun per shot, but it lands' },
  { label: 'Rattler @5 m grounded', weapon: 'rattler', distance: 5, airborne: false, hitMin: 0.95, ttkMax: 1.5, why: 'docs/03 §6: 10 shots, 1.35 s' },
  { label: 'Rattler @12 m grounded', weapon: 'rattler', distance: 12, airborne: false, hitMin: 0.6, hitMax: 0.85, why: 'a machine pistol: close to mid range' },
  { label: 'Hornet @5 m grounded', weapon: 'hornet', distance: 5, airborne: false, hitMin: 0.95, ttkMax: 1.0, why: 'the fastest-firing gun owns close range' },
  { label: 'Hornet @18 m grounded', weapon: 'hornet', distance: 18, airborne: false, hitMax: 0.45, why: 'and loses at long range' },
  { label: 'Trident @12 m grounded', weapon: 'trident', distance: 12, airborne: false, hitMin: 0.9, ttkMax: 1.2, why: 'three bursts: the precise mid-range rifle' },
  { label: 'Trident @18 m grounded', weapon: 'trident', distance: 18, airborne: false, hitMax: 0.8, ttkMax: 2.0, why: 'never out-ranges the Widow' },
  { label: 'Bullpup @12 m grounded', weapon: 'bullpup', distance: 12, airborne: false, hitMin: 0.7, ttkMax: 1.8, why: 'a steadier, lighter K-47' },
  { label: 'Longbow @18 m grounded', weapon: 'longbow', distance: 18, airborne: false, hitMin: 0.95, ttkMax: 1.2, why: 'docs/03 §6: 3 body shots, 1.1 s' },
  { label: 'Shredder @5 m grounded', weapon: 'shredder', distance: 5, airborne: false, hitMin: 0.95, ttkMax: 1.9, why: 'deadly once spun up (0.8 s of it in this TTK)' },
  { label: 'Arc @18 m grounded', weapon: 'arc', distance: 18, airborne: false, hitMin: 0.95, ttkMax: 2.6, why: 'docs/03 §6: 17 ticks, 2.4 s, at any range' },
  // launchers and the flamethrower (docs/03 §5, §11): projectiles, so the flight is in the TTK
  { label: 'Thumper @12 m grounded', weapon: 'thumper', distance: 12, airborne: false, hitMin: 0.95, ttkMax: 0.7, why: 'one rocket kills: 0.6 s to get there' },
  { label: 'Popper @5 m grounded', weapon: 'popper', distance: 5, airborne: false, ttkMax: 1.6, why: 'two shells in the face (a shell knocks, so the next may miss)' },
  { label: 'Ripper @12 m grounded', weapon: 'ripper', distance: 12, airborne: false, hitMin: 0.95, ttkMax: 1.1, why: 'a 0.4 s charge, then one blade' },
  { label: 'Dragon @5 m grounded', weapon: 'dragon', distance: 5, airborne: false, ttkMax: 1.3, why: 'docs/03 §6: 5 flames, plus their flight' },
  { label: 'Dragon @12 m grounded', weapon: 'dragon', distance: 12, airborne: false, hitMax: 0, why: 'flames reach ~6 m' },
];

/** Grenades at 45°, full strength (the owner: "the bombs should go far"): about 30% farther than before. */
export const THROW_TARGETS: { grenade: string; bounceMin: number; bounceMax: number; offMin: number; offMax: number }[] = [
  { grenade: 'frag', bounceMin: 13.5, bounceMax: 15.5, offMin: 18, offMax: 20.5 }, // was 11.1 / 14.8
  { grenade: 'smoke', bounceMin: 11.8, bounceMax: 13.5, offMin: 14.8, offMax: 16.8 }, // was 9.7 / 12.1
  { grenade: 'gas', bounceMin: 11.8, bounceMax: 13.5, offMin: 14.8, offMax: 16.8 },
  { grenade: 'flash', bounceMin: 11.8, bounceMax: 13.5, offMin: 15.5, offMax: 17.5 }, // was 9.7 / 12.7
  { grenade: 'emp', bounceMin: 11.8, bounceMax: 13.5, offMin: 13, offMax: 15 }, // was 9.7 / 10.8
];

/** Toxic gas (docs/02 §14): a player standing still at `distance` m from where the cloud popped. */
export const GAS_TARGETS: { distance: number; ttkMax?: number; dpsMin?: number; dpsMax?: number; why: string }[] = [
  { distance: 0, ttkMax: 8, why: 'staying in the middle kills: get out or die' },
  { distance: 2, dpsMin: 8, dpsMax: 12, why: 'still deadly halfway out' },
  { distance: 3.5, dpsMin: 3, dpsMax: 6, why: 'crossing the edge costs a few HP, it is not a wall' },
];

/** Flashbang blindness (docs/02 §14): seconds of full white, by distance, where you look and cover. */
export const FLASH_TARGETS: { distance: number; lookAway: boolean; wall: boolean; whiteMin: number; whiteMax: number; why: string }[] = [
  { distance: 3, lookAway: false, wall: false, whiteMin: 2.0, whiteMax: 2.5, why: 'up to ~2.5 s of white, then a ~1.5 s fade (owner: "only white for some time")' },
  { distance: 3, lookAway: true, wall: false, whiteMin: 0.3, whiteMax: 0.9, why: 'turning away is the counterplay' },
  { distance: 3, lookAway: false, wall: true, whiteMin: 0, whiteMax: 0.5, why: 'cover protects' },
  { distance: 10, lookAway: false, wall: false, whiteMin: 0.9, whiteMax: 1.6, why: 'still a real flash across a room' },
  { distance: 17, lookAway: false, wall: false, whiteMin: 0, whiteMax: 0, why: 'off-screen flashes do nothing' },
];

/** Pulse (docs/03 §11): an EMP orb at a player 10 m away. */
export const PULSE_TARGETS = {
  reachedAfter: { min: 1.5, max: 2.3, why: 'a 0.7 s charge and a slow orb (8 m/s): you see it coming' },
  jetOff: { min: 2.9, max: 3.1, why: 'jetpack dead for 3 s, like an EMP grenade' },
  damage: { max: 0, why: 'no damage' },
};

/** Proximity mine and EMP (docs/02 §14). */
export const MINE_TARGETS = {
  sticksAt: { min: 15, max: 20, why: 'a mid-range throw: 1 s of straight flight, then it drops (30% farther, owner: "the bombs should go far")' },
  /** an enemy 1 m from a mine */
  damage: { min: 100, why: 'stepping on one kills' },
  blastAfter: { min: 0.2, max: 0.35, why: 'the 0.25 s beep: a warning, not an escape' },
};
export const EMP_TARGETS = {
  jetOff: { min: 2.9, max: 3.1, why: 'jetpacks dead for 3 s' },
  dropped: { min: 2.5, why: 'a hovering player falls out of the sky' },
};

/** Recoil push (docs/02 §12; the owner's "rebounds physics after shots"). Distances in metres. */
export const RECOIL_TARGETS: { weapon: string; key: 'lift' | 'airKnock' | 'slide' | 'crouchSlide'; label: string; min: number; max: number; why: string }[] = [
  { weapon: 'breacher', key: 'lift', label: 'Breacher fired down at the top of a hop: lift', min: 2, max: 3, why: 'shotgun-jumping is a movement trick' },
  { weapon: 'breacher', key: 'airKnock', label: 'Breacher fired level at the top of a hop: knocked back', min: 2, max: 5, why: 'a shotgun dash, not a launch' },
  { weapon: 'breacher', key: 'slide', label: 'Breacher fired level standing: slide back', min: 0.15, max: 0.5, why: 'a small grounded slide' },
  { weapon: 'widow', key: 'slide', label: 'Widow fired level standing: slide back', min: 0.5, max: 1, why: 'a sniper shot knocks you back' },
  { weapon: 'widow', key: 'crouchSlide', label: 'Widow fired level crouched: slide back', min: 0.05, max: 0.4, why: 'crouching braces against the kick' },
  { weapon: 'widow', key: 'airKnock', label: 'Widow fired level at the top of a hop: knocked back', min: 0.5, max: 2, why: 'noticeable, not a dash' },
];
export const SPRAY_TARGETS: { weapon: string; min: number; max: number; why: string }[] = [
  { weapon: 'k47', min: 0.5, max: 2.5, why: 'spraying in the air drifts you back gently' },
  { weapon: 'buzz', min: 0, max: 0, why: 'light guns never push' },
];
