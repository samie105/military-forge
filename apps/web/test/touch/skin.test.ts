/** The touch controls in the round-two kit's look: the ammo ring's geometry, the values they read, the phone's states. */
import { HAMMER, WIDOW, createTuning, grenades, weaponPickup, weapons } from '@military-forge/content';
import { MatchPhase } from '@military-forge/sim';
import { describe, expect, it } from 'vitest';
import { hudFrame, type HudInput, type HudMemory } from '../../src/hud/hud';
import type { HudPlayer } from '../../src/hud/model';
import { CONTROL_IDS } from '../../src/touch/layout';
import { EquipClock, MAX_SEGMENTS, TOUCH_VARS, adaptHudValues, controlValues, hudVarPairs, localView, phoneTokens, roundSegments, roundsLeftDash, skinHtml } from '../../src/touch/skin';

describe('the aim dial: one segment per round', () => {
  it("draws the kit's six-round ring exactly (13 of each 16.67, from 1.5 in)", () => {
    expect(roundSegments(6)).toEqual([
      { dash: '13 87', offset: '-1.5' },
      { dash: '13 87', offset: '-18.17' },
      { dash: '13 87', offset: '-34.83' },
      { dash: '13 87', offset: '-51.5' },
      { dash: '13 87', offset: '-68.17' },
      { dash: '13 87', offset: '-84.83' },
    ]);
  });

  it('keeps the proportions for any mag; past MAX_SEGMENTS rounds it is one arc that empties; none for melee', () => {
    const thirty = roundSegments(30);
    expect(thirty).toHaveLength(30);
    expect(Number(thirty[0]!.dash.split(' ')[0])).toBeCloseTo(2.6, 1);
    expect(roundSegments(MAX_SEGMENTS + 1)).toEqual([{ dash: '100 0', offset: '0' }]);
    expect(roundsLeftDash(50, 200)).toBe('25 100');
    expect(roundsLeftDash(0, 0)).toBe('0 100');
    expect(roundSegments(0)).toEqual([]);
  });
});

describe('values', () => {
  it("fills the kit's slot names from the HUD's current ones, and leaves the kit's alone once the model has them", () => {
    expect(adaptHudValues({ 'weapon.0.mag': '4', 'weapon.0.name': 'Hammer .44' })).toMatchObject({ 'player.slot.0.mag': '4', 'player.slot.0.name': 'Hammer .44' });
    expect(adaptHudValues({ 'weapon.0.mag': '4', 'player.slot.0.mag': '9' })['player.slot.0.mag']).toBe('9');
  });

  it("reads the HUD root's variables from its own list, and adds the controls' raw ones", () => {
    expect(hudVarPairs('--hp: v.hp; --fuel: v.fuel ; --equip: v.equip')).toEqual([
      ['--hp', 'v.hp'],
      ['--fuel', 'v.fuel'],
    ]); // --equip is the controls' own: one writer per variable
    expect(hudVarPairs().map(([n]) => n)).toEqual(expect.arrayContaining(['--hp', '--fuel', '--dash', '--reload']));
    expect(TOUCH_VARS.map(([n]) => n)).toEqual(['--equip', '--throw']);
  });

  it('the grenade button shows the selected type and its count; zoom only for a gun that zooms; the take button only on a crate with a gun you lack', () => {
    const me = player({ grenadeType: 3, grenadeCounts: [2, 1, 0, 1, 0, 0] });
    const plain = localView({ localId: 0, players: [me] });
    expect(plain.values).toMatchObject({ 'touch.grenade.icon': `#icon-g-${grenades[3]!.id}`, 'touch.grenade.count': '1' });
    expect(plain.tokens).toContain('zoomable'); // the Hammer zooms ×3
    expect(plain.tokens).not.toContain('near-crate');
    const crate = { id: 4, def: weaponPickup(WIDOW.index)!.index, x: me.x, y: me.y };
    const near = localView({ localId: 0, players: [me], pickups: [crate] });
    expect(near.tokens).toContain('near-crate');
    expect(near.values).toMatchObject({ 'touch.take.name': 'Widow', 'touch.take.icon': '#icon-wpn-widow', 'touch.take.verb': 'Swap' });
    // a gun you hold already: walking over it is ammo, no button
    const holding = player({ weapons: [{ def: WIDOW.index, mag: 1, reserve: 4, reloadTicks: 0 }] });
    expect(localView({ localId: 0, players: [holding], pickups: [crate] }).tokens).not.toContain('near-crate');
    // no grenades left: the button dims
    expect(localView({ localId: 0, players: [player({ grenadeCounts: [0, 0, 0, 0, 0, 0] })] }).tokens).toContain('no-grenades');
    // dead: nothing to take, nothing to zoom
    expect(localView({ localId: 0, players: [{ ...me, alive: false }], pickups: [crate] }).tokens).toEqual([]);
  });

  it("the equip clock runs the gun's own equip time after a swap (the first frame isn't one)", () => {
    const clock = new EquipClock();
    expect(clock.update(0, HAMMER.index, 1000)).toBe(1);
    expect(clock.update(1, WIDOW.index, 2000)).toBe(0);
    const equip = weapons[WIDOW.index]!.equip * 1000;
    expect(clock.update(1, WIDOW.index, 2000 + equip / 2)).toBeCloseTo(0.5, 5);
    expect(clock.update(1, WIDOW.index, 2000 + equip + 1)).toBe(1);
  });

  it('a swap between the slots crosses the guns; a gun taken into the same slot only runs the ring', () => {
    const clock = new EquipClock();
    clock.update(0, HAMMER.index, 0);
    expect(clock.swapped).toBe(false); // the first frame
    clock.update(1, WIDOW.index, 100);
    expect(clock.swapped).toBe(true);
    expect(clock.ms).toBeCloseTo(weapons[WIDOW.index]!.equip * 1000, 6);
    clock.update(1, WIDOW.index, 116);
    expect(clock.swapped).toBe(false);
    clock.update(1, HAMMER.index, 132); // took the Hammer from a crate into the slot in hand
    expect(clock.swapped).toBe(false);
  });

  it("the phone's states: grenade-aim, near-crate, swap and low-hp from the HUD's tokens and the controls' own", () => {
    const base = { aiming: false, equip: 1, slung: false, heldIcon: true, slungIcon: true };
    expect(phoneTokens(['low-hp'], [], base)).toEqual(expect.arrayContaining(['low-hp', 'held-icon']));
    expect(phoneTokens([], [], { ...base, aiming: true })).toContain('grenade-aim');
    expect(phoneTokens(['aiming'], [], base)).toContain('grenade-aim');
    expect(phoneTokens(['pickup-crate'], [], base)).toContain('near-crate');
    expect(phoneTokens([], ['near-crate'], base)).toContain('near-crate');
    expect(phoneTokens([], [], { ...base, equip: 0.4 })).toContain('swap');
    expect(phoneTokens(['switching'], [], base)).toContain('swap');
    expect(phoneTokens([], [], base)).not.toEqual(expect.arrayContaining(['swap', 'grenade-aim', 'near-crate']));
  });
});

describe('every key the controls bind gets a value', () => {
  const t = createTuning();
  const me = player({ hp: 25, weapons: [{ def: HAMMER.index, mag: 4, reserve: 30, reloadTicks: 0 }, { def: 1, mag: 40, reserve: 250, reloadTicks: 0 }] });
  const crate = { id: 4, def: weaponPickup(WIDOW.index)!.index, x: me.x, y: me.y };
  const input: HudInput = {
    frame: { tick: 1, localId: 0, players: [me], grenades: [], pickups: [crate] },
    tuning: t,
    match: { phase: MatchPhase.InProgress, number: 1, secondsLeft: 222, untimed: false, secondsElapsed: 0, killLimit: 10, timeLimit: 300, countdownTotal: 3, mapName: 'Street Market', localId: 0, myScore: 6, leaderScore: 8, leaderName: 'Kemi', ready: true, votes: 0, humans: 2, voted: false, results: null },
    zoom: 2,
    toScreen: (x, y) => ({ x, y }),
    pointer: { x: 400, y: 300 },
    showNet: false,
    showFps: false,
    fps: 60,
    reduceFlashes: false,
    flash: 0,
    scoreRows: () => null,
  };
  const memory: HudMemory = { sinceHitS: 1, death: null, keys: {}, netDetail: '', hpGhost: 0.5, hitMarker: false, killMarker: false, boardOpen: false };

  it('from the HUD (through the adapter) and the frame, for every control', () => {
    const bound = new Set<string>();
    for (const id of CONTROL_IDS) {
      const html = skinHtml(id);
      for (const m of html.matchAll(/data-bind="([^"]+)"/g)) bound.add(m[1]!.trim());
      for (const m of html.matchAll(/data-bind-(?:attr|var)="([^"]+)"/g)) for (const pair of m[1]!.split(';')) bound.add(pair.split(':')[1]!.trim());
    }
    for (const [, key] of [...hudVarPairs(), ...TOUCH_VARS]) bound.add(key);
    const values = controlValues(hudFrame(input, memory).values, localView(input.frame), { throwAim: 3, equip: 0.5 });
    expect(values).toMatchObject({ 'touch.throw': '0.429', 'touch.equip': '0.5', 'touch.zoom': '2×', 'player.slot.0.name': 'Hammer .44' });
    expect([...bound].filter((k) => values[k] === undefined)).toEqual([]);
  });

  it('every control has a skin in the kit\'s classes', () => {
    for (const id of CONTROL_IDS) expect(skinHtml(id), id).toMatch(/class="mf-skin (dial|dial-btn|tb|pt-swap|pt-pick)\b/);
  });
});

function player(over: Partial<HudPlayer>): HudPlayer {
  return {
    id: 0,
    name: 'You',
    isBot: false,
    isLocal: true,
    alive: true,
    x: 10,
    y: 2,
    vx: 0,
    vy: 0,
    grounded: true,
    crouched: false,
    jetting: false,
    aim: 0,
    hp: 100,
    fuel: 100,
    fuelRegenDelay: 0,
    frags: 3,
    active: 0,
    dual: false,
    weapons: [{ def: HAMMER.index, mag: 4, reserve: 30, reloadTicks: 0 }],
    respawnTicks: 0,
    kills: 0,
    deaths: 0,
    ...over,
  };
}
