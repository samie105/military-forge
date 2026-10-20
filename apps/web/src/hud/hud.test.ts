/** The HUD's numbers: kill feed, damage arcs, vitals, weapons, the brief's shield/dash/EMP/blind/gas/belt/pickup fields, the bound values, the net graph. */
import { BUZZ, DRAGON, HAMMER, HitZone, K47, NO_WEAPON, SHREDDER, THUMPER, WIDOW, createTuning, defaultTuning, weaponPickup, weapons } from '@military-forge/content';
import { DamageSource, MatchPhase } from '@military-forge/sim';
import { describe, expect, it } from 'vitest';
import { Linger, blastName, hudFrame, netGraph, pingLook, type HudInput, type HudMemory } from './hud';
import { conditions, leaderLine, crateCompare, damageArc, dashHint, dashStatus, eventLook, feedFromEvents, fuelView, grenadeBelt, healthView, isBlastSource, isBurnTick, pickupIcon, pickupNear, pickupPrompt, screenAngle, shieldStatus, tunedSummary, weaponCards, weaponFamily, weightWords, type HudPlayer, type ScoreRow } from './model';
import { StateTokens, stateMatches } from './state';
import { HUD_VARS, hudTemplate } from './template';
import type { NetStats } from '../view';

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
    // the kit's glyphs and badges: weapon art, the grenade, melee; headshot, own goal, fall, blast
    expect(lines.map((l) => [l.icon, l.badge, l.fell])).toEqual([
      ['#icon-wpn-hammer', 'headshot', false],
      ['#icon-melee', null, false],
      ['#icon-g-frag', 'suicide', false],
      ['', 'fall', true],
      ['#icon-g-frag', 'blast', false],
    ]);
  });

  it('a bullet off a shield into the victim is a ricochet; bots are marked', () => {
    const ricochet = { type: 'ricochet' as const, shooter: 1, owner: 2, weapon: 0, x: 0, y: 0, nx: 1, ny: 0, ex: 0, ey: 0, hit: 2 as const, target: 0, zone: HitZone.Torso };
    const [line] = feedFromEvents([ricochet, { type: 'death', victim: 0, killer: 1, source: 0 }], 0, names, () => 1, new Set([1]));
    expect(line).toMatchObject({ badge: 'ricochet', killerBot: true, victimBot: false, mine: 'victim' });
    expect(feedFromEvents([{ type: 'death', victim: 2, killer: 1, source: DamageSource.Mine }], 0, names, () => 1)[0]).toMatchObject({ how: 'mine', icon: '#icon-g-mine', badge: 'blast' });
    expect(feedFromEvents([{ type: 'death', victim: 2, killer: 1, source: DamageSource.Gas }], 0, names, () => 1)[0]).toMatchObject({ how: 'gas', icon: '#icon-g-gas', badge: null });
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
    // the kit's own strip under the bar: how much of the delay is left
    expect(waiting.delayLeft).toBeCloseTo(1);
    expect(fuelView({ fuel: tank(0.4), fuelRegenDelay: full / 2, grounded: true }, t).delayLeft).toBeCloseTo(0.5, 1);
    expect(fuelView({ fuel: tank(1), fuelRegenDelay: full, grounded: true }, t).delayLeft).toBe(0);
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

  it('dash: no cooldown, the fuel: ready with the dashes it buys, or spent and refilling toward one', () => {
    const cost = t.dashFuelCost;
    expect(dashStatus({ fuel: t.fuelMax }, t)).toEqual({ state: 'ready', fill: 0, left: Math.floor(t.fuelMax / cost) });
    expect(dashStatus({ fuel: cost }, t)).toEqual({ state: 'ready', fill: 0, left: 1 });
    expect(dashStatus({ fuel: cost / 4 }, t)).toEqual({ state: 'spent', fill: 0.75, left: 0 });
    expect(dashStatus({ fuel: 5 }, { dashFuelCost: 0 })).toEqual({ state: 'ready', fill: 0, left: -1 });
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
    const near = pickupNear({ x: 10, y: 2, alive: true }, [shield])!;
    expect([near.name, pickupIcon(near)]).toEqual(['Riot Shield', '#icon-shield']);
  });

  it('map events wear their kind: colour token and icon', () => {
    expect(eventLook('emp')).toEqual({ color: 'var(--c-ev-emp)', icon: 'ev-emp' });
    expect(eventLook('flip').icon).toBe('ev-gravity');
    expect(eventLook('fog')).toEqual({ color: 'var(--c-ev-fog)', icon: 'ev-fog' });
    expect(eventLook('gust').color).toBe('var(--c-ev-squall)');
    expect(eventLook('custom')).toEqual({ color: 'var(--c-ev-gravity)', icon: 'warn' });
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

describe('the kit wiring', () => {
  it('data-state shows on one token, or on every token joined by +', () => {
    const on = new Set(['host', 'ready']);
    expect(stateMatches('host', on)).toBe(true);
    expect(stateMatches('guest host+ready', on)).toBe(true);
    expect(stateMatches('host+not-ready', on)).toBe(false);
    expect(stateMatches('guest', on)).toBe(false);
    // round two's negation: "!a" while a is not active, combinable with + and alternatives
    expect(stateMatches('!guest', on)).toBe(true);
    expect(stateMatches('!host', on)).toBe(false);
    expect(stateMatches('!switching+!dual', on)).toBe(true);
    expect(stateMatches('host+!ready', on)).toBe(false);
    expect(stateMatches('guest !ready', on)).toBe(false);
    expect(stateMatches('guest !copied', on)).toBe(true);
  });

  it('the tokens reach inside the kits: every fitted screen carries them too (their scoped state rules)', () => {
    const el = () => ({ dataset: {} as Record<string, string>, querySelectorAll: () => [] });
    const root = el();
    const screens = [el(), el()];
    const states = new StateTokens(root as unknown as HTMLElement, screens as unknown as HTMLElement[]);
    states.set(['spectating', 'low-hp']);
    expect(root.dataset.activeState).toBe('low-hp spectating');
    expect(screens.map((s) => s.dataset.activeState)).toEqual(['low-hp spectating', 'low-hp spectating']);
  });

  it('ping looks: green up to 100 ms, amber to 200, red beyond', () => {
    expect([30, 80, 150, 450].map((ms) => pingLook(ms))).toEqual([
      { cls: 'ping--good', bars: 4, sig: 'sig sig--ok', tone: 'ok' },
      { cls: 'ping--good', bars: 3, sig: 'sig sig--warn', tone: 'ok' },
      { cls: 'ping--mid', bars: 2, sig: 'sig sig--bad', tone: 'warn' },
      { cls: 'ping--bad', bars: 1, sig: 'sig sig--bad', tone: 'bad' },
    ]);
  });
});

describe('hudFrame', () => {
  const me = player({ hp: 25, shield: 'front', shieldHp: 240, fuel: 4, jetDisabled: true, weapons: [{ def: 0, mag: 2, reserve: 24, reloadTicks: 20 }, { def: 1, mag: 40, reserve: 250, reloadTicks: 0 }], frags: 2 });
  const event = { id: 'storm', kind: 'emp', name: 'EMP STORM', description: 'Jetpacks offline', phase: 'warning' as const, secondsLeft: 2.4, progress: 0.4, color: 0xf4d84a, zones: [], occurrence: 1, bulletRangeMul: 1 };
  const input = (over: Partial<HudInput> = {}): HudInput => ({
    frame: { tick: 1, localId: 0, players: [me], grenades: [], pickups: [{ id: 3, def: 0, x: 12, y: 2 }], mapEvent: event },
    tuning: t,
    match: null,
    zoom: 2,
    toScreen: (x, y) => ({ x: x * 10, y: y * 10 }),
    pointer: { x: 400, y: 300 },
    showNet: false,
    showFps: true,
    fps: 59.6,
    reduceFlashes: false,
    flash: 0,
    scoreRows: () => null,
    ...over,
  });
  const memory: HudMemory = { sinceHitS: 1, death: null, keys: { dash: 'Shift', grenade: 'G', cycleGrenade: 'T', shield: 'X', swap: 'Q', reload: 'R', scoreboard: 'Tab', interact: 'E', fire: 'Left' }, netDetail: '', hpGhost: 0.5, hitMarker: true, killMarker: false, boardOpen: false };
  const solo = (p: HudPlayer, over: Partial<HudInput['frame']> = {}) => ({ frame: { tick: 1, localId: 0, players: [p], grenades: [], ...over } });

  it('gives every key the template binds a value, in play and in death', () => {
    const bound = new Set<string>();
    const html = hudTemplate();
    for (const m of html.matchAll(/data-bind(?:-roll)?="([^"]+)"/g)) bound.add(m[1]!.trim());
    for (const m of html.matchAll(/data-bind-(?:attr|var)="([^"]+)"/g)) for (const pair of m[1]!.split(';')) bound.add(pair.split(':')[1]!.trim());
    for (const pair of HUD_VARS.split(';')) bound.add(pair.split(':')[1]!.trim());
    const playing = { phase: MatchPhase.InProgress, number: 1, secondsLeft: 222, untimed: false, secondsElapsed: 0, killLimit: 10, timeLimit: 300, countdownTotal: 3, mapName: 'Lunar Outpost', localId: 0, myScore: 6, leaderScore: 8, leaderName: 'Kemi', ready: true, votes: 0, humans: 2, voted: false, results: null };
    const net = { rttMs: 38, snapshotsPerSec: 30, kbInPerSec: 8, kbOutPerSec: 4, interpDelayMs: 100, status: 'connected' };
    const alive = hudFrame(input({ match: playing, frame: { ...input().frame, net } }), memory).values;
    const dead = hudFrame(input({ frame: { tick: 1, localId: 0, players: [{ ...me, alive: false, respawnTicks: 90 }], grenades: [] } }), { ...memory, death: { label: 'Taken out by', killer: 'Kemi', icon: '#icon-wpn-widow' } }).values;
    const crate = hudFrame(input(solo(me, { pickups: [{ id: 4, def: weaponPickup(WIDOW.index)!.index, x: me.x, y: me.y }] })), memory).values;
    expect([...bound].filter((k) => alive[k] === undefined && dead[k] === undefined && crate[k] === undefined)).toEqual([]);
  });

  it('the net plate reads ping, jitter, loss and the transport (and a compact line for phones)', () => {
    const prediction: NonNullable<NetStats['prediction']> = {
      inputBufferHealth: 2,
      timeScale: 1,
      unackedTicks: 12,
      correctionsPerMin: 0,
      mispredictionsPerMin: 0,
      lastErrorCm: 0,
      resyncs: 0,
      snapshotLossPct: 2.04,
      rttJitterMs: 18.4,
      netSim: 'off',
      lowBandwidth: false,
      suggestLowBandwidth: false,
    };
    const net: NetStats = { rttMs: 151.6, snapshotsPerSec: 30, kbInPerSec: 8, kbOutPerSec: 4, interpDelayMs: 140, status: 'connected', transport: 'wt', prediction };
    const v = hudFrame(input({ frame: { ...input().frame, net } }), memory).values;
    expect(v['net.ping']).toBe('152 ms');
    expect(v['net.jitter']).toBe('±18');
    expect(v['net.loss']).toBe('2.0%');
    expect(v['net.via']).toBe('WT');
    expect(v['net.viaTitle']).toBe('WebTransport (UDP)');
    expect(v['net.short']).toBe('±18 · 2.0% · WT');
    expect(netGraph(net)).toMatch(/WebTransport/);
    const ws = hudFrame(input({ frame: { ...input().frame, net: { ...net, transport: 'ws', prediction: { ...prediction, snapshotLossPct: 12.6 } } } }), memory).values;
    expect(ws['net.short']).toBe('±18 · 13% · WS');
    const none = hudFrame(input({ frame: { ...input().frame, net: { ...net, transport: undefined, prediction: undefined } } }), memory).values;
    expect(none['net.short']).toBe('0.0%');
    expect(none['net.via']).toBe('');
  });

  it("the brief's fields as the kit's values and state tokens", () => {
    const { values: v, tokens } = hudFrame(input(), memory);
    expect(v).toMatchObject({
      'player.hp': '25',
      'v.hp': '0.25',
      'v.hpGhost': '0.5',
      'player.hpCue': ` · regen starts in ${Math.ceil(t.healthRegenDelay - 1)} s`,
      'player.shield.state': 'Up',
      'player.shield.hp': '240',
      'player.shield.max': '300',
      'player.shield.covers': 'Front covered',
      'v.shield': '0.8',
      'player.empCause': 'EMP field',
      'weapon.0.icon': '#icon-wpn-hammer',
      'weapon.0.mag': '2',
      'player.slot.0.idx': '1',
      'player.slot.0.name': 'Hammer .44',
      'player.slot.0.family': 'Pistol',
      'player.slot.0.icon': '#icon-wpn-hammer',
      'player.slot.0.mag': '2',
      'player.slot.0.magSize': '6',
      'player.slot.0.reserve': '24',
      'player.slot.1.name': 'Buzz',
      'player.slot.1.icon': '#icon-wpn-buzz',
      'player.slot.1.mag': '40',
      'player.slot.1.reserve': '250',
      'weapon.zoom': '2×',
      'grenades.selected': 'Frag',
      'grenades.count': '2',
      'grenades.icon': '#icon-g-frag',
      'event.color': 'var(--c-ev-emp)',
      'event.icon': '#icon-ev-emp',
      'event.startsIn': '3',
      'event.timeLeft': '',
      'pickup.icon': '#icon-shield',
      'pickup.text': 'Riot Shield: walk over to take',
      'bind.dash.0': 'Shift',
      'fps.value': '60',
    });
    expect(Number(v['v.reload'])).toBeGreaterThan(0);
    expect(tokens).toEqual(expect.arrayContaining(['alive', 'low-hp', 'shield', 'shield-up', 'emp', 'dash-cooldown', 'reloading', 'weapon', 'gun', 'slung', 'slung-item', 'slung-gun', 'belt', 'event', 'event-warning', 'pickup', 'pickup-item', 'reticle', 'hit', 'fps']));
    for (const not of ['match', 'spectating', 'event-active', 'pickup-crate', 'dual', 'switching', 'empty', 'low-ammo', 'aiming', 'tuned', 'headshot', 'kill', 'launched', 'blood-on', 'admin']) expect(tokens).not.toContain(not);
    // the owner's admin page changed gameplay numbers on this server: the small tag
    expect(hudFrame(input({ adminTuned: true }), memory).tokens).toContain('admin');
  });

  it('a weapon crate underfoot shows its whole take line and the gun icon, not "walk over to take"', () => {
    const crate = { id: 4, def: weaponPickup(WIDOW.index)!.index, x: me.x, y: me.y };
    const { values: v, tokens } = hudFrame(input({ frame: { tick: 1, localId: 0, players: [me], grenades: [], pickups: [crate], mapEvent: null } }), memory);
    expect(tokens).toContain('pickup');
    expect(v['pickup.text']).toBe('[E] take Widow (swaps your Hammer .44)');
    expect(v['pickup.icon']).not.toBe('#icon-shield');
  });

  it('dead: who did it, the respawn countdown and its bar', () => {
    const dead = { ...me, alive: false, respawnTicks: 90 };
    const { values: v, tokens } = hudFrame(input({ frame: { tick: 1, localId: 0, players: [dead], grenades: [] } }), { ...memory, death: { label: 'Taken out by', killer: 'Kemi', icon: '#icon-wpn-widow' } });
    expect(v).toMatchObject({ 'death.killer': 'Kemi', 'death.lead': 'Respawn in', 'player.respawnIn': '2', 'death.unit': 's', 'v.respawn': '0.5' });
    expect(tokens).toEqual(expect.arrayContaining(['spectating', 'death-weapon']));
    expect(tokens).not.toContain('reticle');
  });

  it('Reduce flashes shows the Flashed tag; a slung shield covers the back and leaves the dash alone', () => {
    const blinded = player({ blind: 0.8, shield: 'back', shieldHp: 300 });
    const reduced = hudFrame(input({ frame: { tick: 1, localId: 0, players: [blinded], grenades: [] }, reduceFlashes: true }), memory);
    expect(reduced.tokens).toEqual(expect.arrayContaining(['flash-reduced', 'shield']));
    expect(reduced.tokens).not.toContain('shield-up');
    expect(reduced.values['player.shield.covers']).toBe('Back covered');
    expect(hudFrame(input({ frame: { tick: 1, localId: 0, players: [blinded], grenades: [] } }), memory).tokens).not.toContain('flash-reduced');
  });
});

describe('round two desktop HUD', () => {
  const gun = (def: number, mag: number, reserve = 30, reloadTicks = 0) => ({ def, mag, reserve, reloadTicks });
  const base = (over: Partial<HudInput> = {}): HudInput => ({
    frame: { tick: 1, localId: 0, players: [player({ weapons: [gun(HAMMER.index, 6), gun(BUZZ.index, 40, 250)] })], grenades: [] },
    tuning: t,
    match: null,
    toScreen: (x, y) => ({ x, y }),
    pointer: { x: 10, y: 10 },
    showNet: false,
    showFps: false,
    fps: 60,
    reduceFlashes: false,
    flash: 0,
    scoreRows: () => null,
    ...over,
  });
  const mem: HudMemory = { sinceHitS: 9, death: null, keys: {}, netDetail: '', hpGhost: 1, hitMarker: false, killMarker: false, boardOpen: false };
  const with_ = (p: Partial<HudPlayer>, over: Partial<HudInput> = {}, m: Partial<HudMemory> = {}) => hudFrame(base({ frame: { tick: 1, localId: 0, players: [player({ weapons: [gun(HAMMER.index, 6), gun(BUZZ.index, 40, 250)], ...p })], grenades: [] }, ...over }), { ...mem, ...m });

  it('the slots: the held gun big, the other slung on your back; dual holds both; a draw fills the equip ring', () => {
    const one = with_({});
    expect(one.tokens).toEqual(expect.arrayContaining(['slung', 'slung-item', 'slung-gun', 'gun']));
    expect(one.values['player.slot.1.name']).toBe('Buzz');
    const dual = with_({ dual: true, weapons: [gun(HAMMER.index, 4), gun(BUZZ.index, 7, 250)] });
    expect(dual.tokens).toContain('dual');
    expect(dual.tokens).not.toContain('slung');
    expect(dual.values).toMatchObject({ 'player.slot.0.idx': '1', 'player.slot.0.name': 'Hammer .44 & Buzz', 'player.slot.0.magL': '4', 'player.slot.0.magR': '7', 'player.slot.0.reserve': '30 · 250', 'player.dual.icon': '#icon-wpn-buzz' });
    const lone = with_({ weapons: [gun(HAMMER.index, 6), gun(NO_WEAPON, 0, 0)] });
    expect(lone.tokens).toEqual(expect.arrayContaining(['slung', 'slung-empty']));
    expect(lone.tokens).not.toContain('slung-item');
    const drawing = with_({ swapTicks: 6 }, {}, { swapTotal: 24 });
    expect(drawing.tokens).toContain('switching');
    expect(drawing.values).toMatchObject({ 'v.equip': '0.75', 'player.slot.0.equipLeft': '0.1 s' });
    expect(with_({}).values['v.equip']).toBe('0');
  });

  it('ammo: low, empty (not while reloading), melee only when no gun is left; charge and spin-up guns wind up', () => {
    expect(with_({ weapons: [gun(HAMMER.index, 1), gun(BUZZ.index, 40)] }).tokens).toContain('low-ammo');
    const empty = with_({ weapons: [gun(HAMMER.index, 0), gun(BUZZ.index, 40)] }).tokens;
    expect(empty).toContain('empty');
    expect(empty).not.toContain('low-ammo');
    expect(with_({ weapons: [gun(HAMMER.index, 0, 30, 20), gun(BUZZ.index, 40)] }).tokens).not.toContain('empty');
    const machete = weapons.find((w) => w.fireMode === 'melee')!.index;
    expect(with_({ weapons: [gun(machete, 0, 0), gun(NO_WEAPON, 0, 0)] }).tokens).toEqual(expect.arrayContaining(['melee', 'melee-only']));
    expect(with_({ weapons: [gun(machete, 0, 0), gun(BUZZ.index, 40)] }).tokens).not.toContain('melee-only');
    const ripper = weapons.find((w) => w.id === 'ripper')!.index;
    expect(with_({ windup: true, weapons: [gun(ripper, 4), gun(BUZZ.index, 40)] }).values['player.slot.0.windup']).toBe('Charging');
    expect(with_({ windup: true, weapons: [gun(SHREDDER.index, 40), gun(BUZZ.index, 40)] }).values['player.slot.0.windup']).toBe('Spinning up');
  });

  it('the throw meter: a hold aims at 70–100 %, the arc warns while a gravity or wind event runs, a tap stamps', () => {
    expect(with_({}).tokens).not.toContain('aiming');
    const aim = with_({}, { throwAim: 7 });
    expect(aim.tokens).toContain('aiming');
    expect(aim.values).toMatchObject({ 'v.throw': '1', 'grenades.throwPercent': '100%' });
    expect(with_({}, { throwAim: 0 }).values['grenades.throwPercent']).toBe('70%');
    const gravity = { id: 'g', kind: 'lowGravity', name: 'Gravity pocket', description: '', phase: 'active' as const, secondsLeft: 9, progress: 0.2, color: 0, zones: [], occurrence: 1, bulletRangeMul: 1 };
    const bends = hudFrame(base({ throwAim: 3, frame: { tick: 1, localId: 0, players: [player({})], grenades: [], mapEvent: gravity } }), mem);
    expect(bends.tokens).toEqual(expect.arrayContaining(['aiming', 'arc-warning', 'event-active']));
    expect(bends.values['grenades.arcCause']).toBe('Gravity pocket');
    expect(with_({}, {}, { quickThrow: true }).tokens).toContain('quick-throw');
  });

  it('feedback: markers by how the hit landed, hurt and heavy hits, blood only when it is on, launched while flying', () => {
    const hit = with_({}, {}, { hitMarker: true, headshot: true, killMarker: true });
    expect(hit.tokens).toEqual(expect.arrayContaining(['hit', 'headshot', 'kill']));
    expect(with_({}, {}, { hitMarker: false, headshot: true }).tokens).not.toContain('headshot');
    expect(with_({}, { blood: true }, { hurt: true, heavyHit: true }).tokens).toEqual(expect.arrayContaining(['blood-on', 'hurt', 'heavy-hit']));
    const by = "Kemi's Thumper";
    expect(with_({ grounded: false, vx: 30, vy: 4 }, {}, { launchedBy: by }).tokens).toContain('launched');
    expect(with_({ grounded: false, vx: 30, vy: 4 }, {}, { launchedBy: by }).values['hit.by']).toBe(by);
    expect(with_({ grounded: true, vx: 30 }, {}, { launchedBy: by }).tokens).not.toContain('launched');
    expect(with_({ grounded: false, vx: 30 }, {}, { launchedBy: null }).tokens).not.toContain('launched');
    expect(with_({ burning: true }).tokens).toContain('burning');
    expect(with_({}, {}, { hpEase: true }).tokens).toContain('hp-ease');
  });

  it('the dash: ready ticks, the hint names the last dash on the rose', () => {
    expect(with_({}).tokens).toContain('dash-ready');
    const hint = with_({}, {}, { dashDir: 1 });
    expect(hint.tokens).toContain('dash-hint');
    expect(hint.values).toMatchObject({ 'dash.hintDir': 'Up-right', 'dash.hintRotate': 'rotate(45 50 50)', 'dash.hintArrow': '-45deg' });
    expect(dashHint(4)).toEqual({ words: 'Left', rose: -90, arrow: -180 });
    const dry = with_({ fuel: t.dashFuelCost / 2 });
    expect(dry.tokens).toEqual(expect.arrayContaining(['dash-cooldown', 'air-used']));
    expect(dry.tokens).not.toContain('dash-ready');
    expect(with_({}).values['dash.left']).toMatch(/^×\d+$/);
    // the fuel bar's mark: one dash's worth of the tank
    expect(Number(with_({}).values['v.dashCost'])).toBeCloseTo(t.dashFuelCost / t.fuelMax, 2);
  });

  it('the desktop dash has no cooldown ring: the rose and the fuel-cost marks instead', () => {
    const html = hudTemplate();
    expect(html).not.toContain('dash__fill');
    expect(html).toContain('dash__rose');
    expect(html).toMatch(/bar--fuel[^]*mf-fuel__cost[^]*mf-fuel__tick/);
    expect(HUD_VARS).toContain('--dash-cost: v.dashCost');
  });

  it('a weapon crate underfoot: Swap your gun for it, with the quick compare', () => {
    const crate = { id: 4, def: weaponPickup(K47.index)!.index, x: 10, y: 2 };
    const f = hudFrame(base({ frame: { tick: 1, localId: 0, players: [player({ weapons: [gun(HAMMER.index, 6), gun(BUZZ.index, 40)] })], grenades: [], pickups: [crate] } }), mem);
    expect(f.tokens).toEqual(expect.arrayContaining(['pickup', 'pickup-crate', 'pickup-swaps', 'pickup-cmp']));
    expect(f.tokens).not.toContain('pickup-item');
    expect(f.values).toMatchObject({ 'pickup.verb': 'Swap', 'pickup.held.name': 'Hammer .44', 'pickup.weapon.name': K47.name, 'pickup.weapon.icon': '#icon-wpn-k47', 'pickup.held.stats.mag': '6', 'pickup.weapon.stats.mag': String(K47.mag) });
    expect(f.values['pickup.delta.mag.class']).toBe('cmp__d cmp__d--up');
  });

  it('the map event: the warning counts down to it, then its own time runs', () => {
    const ev = { id: 'storm', kind: 'emp', name: 'EMP storm', description: 'Jetpacks offline', phase: 'active' as const, secondsLeft: 17.2, progress: 0.25, color: 0, zones: [], occurrence: 1, bulletRangeMul: 1 };
    const f = hudFrame(base({ frame: { tick: 1, localId: 0, players: [player({})], grenades: [], mapEvent: ev } }), mem);
    expect(f.tokens).toEqual(expect.arrayContaining(['event', 'event-active']));
    expect(f.values).toMatchObject({ 'event.timeLeft': '18', 'event.startsIn': '', 'v.event': '0.75', 'event.icon': '#icon-ev-emp' });
  });

  it('"Tuned by host" when the room plays changed values: the first two by name', () => {
    expect(tunedSummary(createTuning())).toBe('');
    expect(tunedSummary(createTuning({ gravity: defaultTuning.gravity * 0.6, dashSpeed: defaultTuning.dashSpeed * 1.4 }))).toBe('Gravity 0.6× · Dash speed 1.4×');
    // online, the admin's values are the room's own: only what the host changed on top is the host's (the audit, M3)
    const adminBase = createTuning({ gravity: defaultTuning.gravity * 0.6 });
    expect(tunedSummary(createTuning({ gravity: defaultTuning.gravity * 0.6 }), adminBase)).toBe('');
    expect(tunedSummary(createTuning({ gravity: defaultTuning.gravity * 0.6, dashSpeed: defaultTuning.dashSpeed * 1.4 }), adminBase)).toBe('Dash speed 1.4×');
    expect(tunedSummary(createTuning({ gravity: defaultTuning.gravity * 0.5, dashSpeed: defaultTuning.dashSpeed * 2, walkMax: defaultTuning.walkMax * 1.5 }))).toBe('Gravity 0.5× · Dash speed 2× · 1 more');
    const tuned = hudFrame(base({ tuning: createTuning({ gravity: defaultTuning.gravity * 0.6 }) }), mem);
    expect(tuned.tokens).toContain('tuned');
    expect(tuned.values['match.tunedSummary']).toBe('Gravity 0.6×');
  });

  it('the crate compare: per-shot damage, rounds a minute, range, weight in words, mag; lighter is better', () => {
    const rows = crateCompare(HAMMER, K47);
    expect(rows.map((r) => r.key)).toEqual(['damage', 'rate', 'range', 'weight', 'mag']);
    const byKey = Object.fromEntries(rows.map((r) => [r.key, r]));
    expect(byKey.damage!.held).toBe(String(HAMMER.damage * HAMMER.pellets));
    expect(byKey.rate!.held).toBe(String(Math.round(60 / HAMMER.interval)));
    expect(byKey.range!.floor).toBe(`${K47.range} m`);
    expect(byKey.mag!.delta).toBe(`+${K47.mag - HAMMER.mag}`);
    for (const r of rows) {
      expect(r.a).toBeGreaterThan(0);
      expect(r.a).toBeLessThanOrEqual(1);
      expect(r.b).toBeLessThanOrEqual(1);
    }
    expect(crateCompare(K47, HAMMER).find((r) => r.key === 'mag')!.delta).toBe(`−${K47.mag - HAMMER.mag}`);
    expect(weightWords(1)).toBe('Light');
    expect(weightWords(0.8)).toBe('Heavy');
    expect(weaponFamily(WIDOW)).toBe('Sniper');
  });

  it('blasts launch, the flame burns on without an arc, heavy hits draw wider arcs', () => {
    expect(isBlastSource(DamageSource.Grenade)).toBe(true);
    expect(isBlastSource(DamageSource.Mine)).toBe(true);
    expect(isBlastSource(THUMPER.index)).toBe(true);
    expect(isBlastSource(HAMMER.index)).toBe(false);
    expect(isBlastSource(DRAGON.index)).toBe(false);
    const burn = DRAGON.projectile!.burn!;
    expect(isBurnTick(DRAGON.index, burn.dps * burn.pulse)).toBe(true);
    expect(isBurnTick(DRAGON.index, DRAGON.damage + 5)).toBe(false);
    expect(damageArc(HAMMER.index, 30)).toEqual({ kind: 'bullet', amount: 0.5 });
    expect(damageArc(WIDOW.index, 90).kind).toBe('heavy');
    expect(damageArc(DamageSource.Grenade, 40).kind).toBe('blast');
    expect(blastName('Kemi', THUMPER.index)).toBe("Kemi's Thumper");
    expect(blastName(null, DamageSource.Grenade)).toBe('your own frag');
  });

  it('Linger: an edge banner and its members stay up for their exit, with <main>-leaving; coming back cancels it', () => {
    const l = new Linger([{ main: 'event', members: ['event-active', 'event-warning'] }], 170);
    expect(l.apply(['event', 'event-active', 'alive'], 0)).toEqual(['event', 'event-active', 'alive']);
    expect(l.apply(['alive'], 16)).toEqual(['alive', 'event', 'event-active', 'event-leaving']);
    expect(l.apply(['alive'], 100)).toEqual(['alive', 'event', 'event-active', 'event-leaving']);
    expect(l.apply(['alive'], 200)).toEqual(['alive']);
    l.apply(['event', 'event-warning'], 300);
    l.apply([], 316);
    expect(l.apply(['event', 'event-active'], 330)).toEqual(['event', 'event-active']);
    expect(l.apply(['event', 'event-active'], 600)).toEqual(['event', 'event-active']);
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

describe("the scoreboard's leader bar (Pen N4)", () => {
  const row = (key: number, name: string, score: number, you = false): ScoreRow => ({ key, name, score, kills: score, deaths: 0, assists: 0, ping: -1, you, host: false, bot: false, left: false });
  it('says who leads, towards the kill limit, and where you stand', () => {
    expect(leaderLine([row(1, 'Kemi', 8), row(2, 'Ade', 6, true)], 10)).toBe("Kemi leads 8/10 · you're 2 kills behind");
    expect(leaderLine([row(2, 'Ade', 8, true), row(1, 'Kemi', 7)], 10)).toBe('You lead 8/10 · 1 kill ahead of Kemi');
    expect(leaderLine([row(1, 'Kemi', 5), row(2, 'Tolu', 5), row(3, 'Ade', 2, true)], 0)).toBe("Tied at 5 · you're 3 kills behind");
    expect(leaderLine([row(2, 'Ade', 3, true)], 10)).toBe('You lead 3/10');
    expect(leaderLine([], 10)).toBe('');
  });
});
