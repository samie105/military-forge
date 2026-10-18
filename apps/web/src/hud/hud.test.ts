/** The HUD's numbers: kill feed, damage arcs, vitals, weapons, the brief's shield/dash/EMP/blind/gas/belt/pickup fields, the bound values, the net graph. */
import { HAMMER, HitZone, NO_WEAPON, WIDOW, createTuning, weaponPickup } from '@military-forge/content';
import { DamageSource } from '@military-forge/sim';
import { describe, expect, it } from 'vitest';
import { hudValues, netGraph, type HudInput, type HudMemory } from './hud';
import { conditions, dashStatus, feedFromEvents, fuelView, grenadeBelt, healthView, pickupPrompt, screenAngle, shieldStatus, weaponCards, type HudPlayer } from './model';
import { hudTemplate } from './template';

const t = createTuning();
const names = new Map([
  [0, 'You'],
  [1, 'Kemi'],
  [2, 'Tunde'],
]);

describe('kill feed', () => {
  it('names killer, weapon and victim; marks headshots, suicides, falls and your part', () => {
    let k = 0;
    const lines = feedFromEvents(
      [
        { type: 'hit', attacker: 0, target: 1, damage: 90, zone: HitZone.Head, source: 0 },
        { type: 'death', victim: 1, killer: 0, source: 0 },
        { type: 'hit', attacker: 1, target: 2, damage: 40, zone: HitZone.Torso, source: 1 },
        { type: 'death', victim: 2, killer: 1, source: DamageSource.Melee },
        { type: 'death', victim: 0, killer: 0, source: DamageSource.Grenade },
        { type: 'death', victim: 2, killer: -1, source: DamageSource.World },
        { type: 'death', victim: 7, killer: 1, source: DamageSource.Grenade },
      ],
      0,
      names,
      () => ++k,
    );
    expect(lines.map((l) => [l.killer, l.how, l.victim, l.headshot, l.suicide, l.mine])).toEqual([
      ['You', 'Hammer .44', 'Kemi', true, false, 'killer'],
      ['Kemi', 'melee', 'Tunde', false, false, null],
      ['You', 'frag', 'You', false, true, 'victim'],
      ['Tunde', 'fell', 'Tunde', false, true, null],
      ['Kemi', 'frag', 'Player 8', false, false, null],
    ]);
    expect(lines.map((l) => l.key)).toEqual([1, 2, 3, 4, 5]);
  });
});

describe('damage arcs', () => {
  it('point from you toward the attacker on screen (y down)', () => {
    const me = { x: 10, y: 2 };
    expect(screenAngle(me, { x: 20, y: 2 })).toBeCloseTo(0);
    expect(screenAngle(me, { x: 10, y: 12 })).toBeCloseTo(-Math.PI / 2); // above: up on screen
    expect(Math.abs(screenAngle(me, { x: 0, y: 2 }))).toBeCloseTo(Math.PI); // ±π: the same way
    expect(screenAngle(me, { x: 10, y: -8 })).toBeCloseTo(Math.PI / 2);
  });
});

describe('vitals', () => {
  it('health counts down the regen delay after a hit, then regenerates', () => {
    expect(healthView(100, t, 0)).toMatchObject({ fill: 1, regenIn: 0, regenerating: false, low: false });
    expect(healthView(40, t, 1)).toMatchObject({ hp: 40, regenIn: t.healthRegenDelay - 1, regenerating: false });
    expect(healthView(40, t, t.healthRegenDelay + 0.1)).toMatchObject({ regenIn: 0, regenerating: true });
    expect(healthView(30, t, 0).low).toBe(true);
    expect(healthView(-5, t, 0)).toMatchObject({ fill: 0, hp: 0, regenerating: false });
  });

  it('fuel shows the regen-delay segment after the fill, and the ignite mark', () => {
    const full = (t.fuelRegenDelayGround * 60) | 0;
    const tank = (share: number) => share * t.fuelMax;
    const waiting = fuelView({ fuel: tank(0.4), fuelRegenDelay: full, grounded: true }, t);
    expect(waiting.fill).toBeCloseTo(0.4);
    expect(waiting.delay).toBeCloseTo(0.25);
    expect(fuelView({ fuel: tank(0.4), fuelRegenDelay: full / 2, grounded: true }, t).delay).toBeCloseTo(0.125, 1);
    expect(fuelView({ fuel: tank(0.4), fuelRegenDelay: 0, grounded: true }, t).delay).toBe(0);
    expect(fuelView({ fuel: tank(0.9), fuelRegenDelay: full, grounded: true }, t).delay).toBeCloseTo(0.1); // never past the end
    expect(fuelView({ fuel: 5, fuelRegenDelay: -1, grounded: false }, t)).toMatchObject({ empty: true, delay: 0 });
    expect(fuelView({ fuel: tank(0.5), fuelRegenDelay: 0, grounded: true }, t).ignite).toBeCloseTo(t.fuelMinIgnite / t.fuelMax);
  });
});

describe('weapon cards', () => {
  it('ammo, the active slot, reload progress, melee and low ammo', () => {
    const cards = weaponCards({
      active: 1,
      dual: false,
      weapons: [
        { def: 0, mag: 1, reserve: 24, reloadTicks: 0 },
        { def: 1, mag: 10, reserve: 200, reloadTicks: 30 },
      ],
    });
    expect(cards.map((c) => [c.name, c.active, c.mag, c.reserve, c.lowAmmo])).toEqual([
      ['Hammer .44', false, 1, 24, true],
      ['Buzz', true, 10, 200, false],
    ]);
    expect(cards[1]!.reload).toBeGreaterThan(0);
    expect(cards[1]!.reload).toBeLessThan(1);
    expect(cards[0]!.reload).toBe(-1);
    expect(weaponCards({ active: 0, dual: true, weapons: [{ def: 0, mag: 6, reserve: 0, reloadTicks: 0 }, { def: NO_WEAPON, mag: 0, reserve: 0, reloadTicks: 0 }] }).map((c) => c.active)).toEqual([true]);
    expect(weaponCards({ active: 0, dual: false, weapons: [{ def: 5, mag: 0, reserve: 0, reloadTicks: 0 }] })[0]).toMatchObject({ melee: true, lowAmmo: false });
  });
});

describe('net graph', () => {
  it('ping, loss, bandwidth and the transport in four short lines', () => {
    expect(netGraph(undefined)).toBe('local match · no network');
    const text = netGraph({
      rttMs: 41.6,
      snapshotsPerSec: 30,
      kbInPerSec: 8.14,
      kbOutPerSec: 3.96,
      interpDelayMs: 100,
      status: 'connected · WebSocket',
      prediction: {
        inputBufferHealth: 2,
        timeScale: 1,
        unackedTicks: 4,
        correctionsPerMin: 0,
        mispredictionsPerMin: 1,
        lastErrorCm: 0,
        resyncs: 0,
        snapshotLossPct: 0.4,
        rttJitterMs: 3.2,
        netSim: 'off',
        lowBandwidth: false,
        suggestLowBandwidth: false,
      },
    });
    expect(text.split('\n')).toEqual([
      'ping 42 ms ±3 · loss 0.4% · 30 snap/s',
      '↓ 8.1 KB/s · ↑ 4.0 KB/s · interp 100 ms',
      'buffer 2 · ×1.000 · corrections 0.0/min',
      'connected · WebSocket',
    ]);
  });
});

describe('riot shield, dash, conditions, grenade belt, pickups (UI brief fields)', () => {
  it('names the shield the way the brief does: up, slung, raising, none, with HP of 300', () => {
    expect(shieldStatus({ shield: 'front', shieldHp: 150 })).toEqual({ state: 'up', hp: 150, fill: 0.5 });
    expect(shieldStatus({ shield: 'back', shieldHp: 300 })).toMatchObject({ state: 'slung', fill: 1 });
    expect(shieldStatus({ shield: 'raising', shieldHp: 12.2 })).toMatchObject({ state: 'raising', hp: 13 });
    expect(shieldStatus({})).toEqual({ state: 'none', hp: 0, fill: 0 });
  });

  it('dash: ready, recharging (with seconds), or the air dash spent until landing', () => {
    const full = t.dashCooldown * 60;
    expect(dashStatus({ dashCooldown: 0, airDashUsed: false, grounded: true }, t)).toEqual({ state: 'ready', fill: 0, seconds: 0 });
    expect(dashStatus({ dashCooldown: full / 2, airDashUsed: true, grounded: false }, t)).toMatchObject({ state: 'cooldown', fill: 0.5, seconds: t.dashCooldown / 2 });
    expect(dashStatus({ dashCooldown: 0, airDashUsed: true, grounded: false }, t).state).toBe('spent');
    expect(dashStatus({ dashCooldown: 0, airDashUsed: true, grounded: true }, t).state).toBe('ready');
  });

  it("conditions: the map's EMP, the EMP grenade's lockout, flashbang blindness, gas", () => {
    expect(conditions(player({ jetDisabled: true }))).toEqual({ emp: true, empSeconds: 0, blind: 0, inGas: false });
    expect(conditions(player({ jetDisabledTicks: 90, blind: 0.4, gasTicks: 5 }))).toEqual({ emp: true, empSeconds: 1.5, blind: 0.4, inGas: true });
    expect(conditions(player({}))).toEqual({ emp: false, empSeconds: 0, blind: 0, inGas: false });
  });

  it('the grenade belt: frags only until the other types land, then every type with the selected one', () => {
    expect(grenadeBelt(player({ frags: 3 })).map((g) => [g.id, g.present, g.count, g.selected])).toEqual([
      ['frag', true, 3, true],
      ['smoke', false, 0, false],
      ['gas', false, 0, false],
      ['flash', false, 0, false],
      ['mine', false, 0, false],
      ['emp', false, 0, false],
    ]);
    const belt = grenadeBelt(player({ grenadeCounts: [2, 1, 0, 2, 1, 0], grenadeType: 3 }));
    expect(belt.filter((g) => g.present)).toHaveLength(6);
    expect(belt.find((g) => g.selected)?.id).toBe('flash');
    expect(belt.map((g) => g.count)).toEqual([2, 1, 0, 2, 1, 0]);
  });

  it('a pickup close by says how to take it; far away or dead, nothing', () => {
    const shield = { id: 1, def: 0, x: 11.5, y: 2 };
    expect(pickupPrompt({ x: 10, y: 2, alive: true }, [shield])).toBe('Riot Shield: walk over to take');
    expect(pickupPrompt({ x: 20, y: 2, alive: true }, [shield])).toBe('');
    expect(pickupPrompt({ x: 10, y: 2, alive: false }, [shield])).toBe('');
    expect(pickupPrompt({ x: 10, y: 2, alive: true }, undefined)).toBe('');
  });

  it('a weapon crate: E to take it (naming the gun it swaps), or ammo for a gun you hold', () => {
    const widow = { id: 2, def: weaponPickup(WIDOW.index)!.index, x: 10, y: 2 };
    const holding = (def: number) => ({ x: 10, y: 2, alive: true, active: 0, weapons: [{ def, mag: 6, reserve: 30, reloadTicks: 0 }] });
    expect(pickupPrompt(holding(HAMMER.index), [widow])).toBe('[E] take Widow (swaps your Hammer .44)');
    expect(pickupPrompt({ ...holding(HAMMER.index), x: 12 }, [widow])).toBe('Widow: stand on it, E to take');
    expect(pickupPrompt({ ...holding(WIDOW.index), x: 12 }, [widow])).toBe('Widow: walk over for ammo');
    expect(pickupPrompt(holding(WIDOW.index), [widow])).toBe('Widow: walk over for ammo');
  });
});

describe('hudValues', () => {
  const me = player({ hp: 25, shield: 'front', shieldHp: 240, dashCooldown: 30, jetDisabled: true, weapons: [{ def: 0, mag: 2, reserve: 24, reloadTicks: 20 }], frags: 2 });
  const input = (over: Partial<HudInput> = {}): HudInput => ({
    frame: { tick: 1, localId: 0, players: [me], grenades: [], pickups: [{ id: 3, def: 0, x: 12, y: 2 }] },
    tuning: t,
    match: null,
    mapEvent: { key: '1:warning', title: 'EMP STORM', line: 'Jetpacks offline', phase: 'warning', seconds: 3, color: '#d2a8ff' },
    zoom: 2,
    toScreen: (x, y) => ({ x: x * 10, y: y * 10 }),
    showNet: false,
    scoreRows: () => null,
    ...over,
  });
  const memory: HudMemory = { sinceHitS: 1, killedBy: '', glyphs: { dash: 'Shift', grenade: 'G', cycle: 'T', shield: 'X' }, netText: '' };

  it('gives every key the template binds a value', () => {
    const v = hudValues(input(), memory);
    const keys = new Set<string>();
    for (const m of hudTemplate().matchAll(/data-bind(?:-state|-show)?="([^"]+)"/g)) keys.add(m[1]!.trim());
    for (const m of hudTemplate().matchAll(/data-bind-var="([^"]+)"/g)) for (const pair of m[1]!.split(';')) keys.add(pair.split(':')[1]!.trim());
    expect([...keys].filter((k) => v[k] === undefined)).toEqual([]);
  });

  it('carries the brief fields: low health, shield up, dash recharging, EMP, reloading, belt, event, prompt, glyphs', () => {
    const v = hudValues(input(), memory);
    expect(v).toMatchObject({
      'player.hp': '25',
      'player.hpState': 'low',
      'player.shield.state': 'up',
      'player.shield.hp': '240',
      'player.shield.fill': '0.800',
      'player.dashState': 'blocked', // the EMP blocks the dash too
      'player.jetDisabled': 'EMP · jetpack offline',
      'player.fuelState': 'emp',
      'weapons.0.state': 'active reloading',
      'weapons.0.mag': '2',
      'weapons.zoom': '2×',
      'grenades.0.count': '2',
      'grenades.0.state': 'selected',
      'grenades.1.present': '',
      'event.title': 'EMP STORM',
      'event.in': ' in 3',
      'event.color': '#d2a8ff',
      'pickup.prompt': 'Riot Shield: walk over to take',
      'keys.dash': 'Shift',
      'arcs.x': '100',
    });
    expect(Number(v['weapons.0.reload'])).toBeGreaterThan(0);
    expect(Number(v['vignette'])).toBeGreaterThan(0.35);
    expect(hudValues(input({ frame: { tick: 1, localId: 0, players: [{ ...me, jetDisabled: false }], grenades: [] } }), memory)).toMatchObject({ 'player.dashState': 'cooldown', 'player.dashNote': '0.5 s', 'player.jetDisabled': '' });
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
    weapons: [],
    respawnTicks: 0,
    kills: 0,
    deaths: 0,
    ...over,
  };
}
