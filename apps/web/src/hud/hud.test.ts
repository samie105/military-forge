/** The HUD's numbers: kill feed, damage arcs, vitals, weapons, the brief's shield/dash/EMP/blind/gas/belt/pickup fields, the bound values, the net graph. */
import { HAMMER, HitZone, NO_WEAPON, WIDOW, createTuning, weaponPickup } from '@military-forge/content';
import { DamageSource, MatchPhase } from '@military-forge/sim';
import { describe, expect, it } from 'vitest';
import { hudFrame, netGraph, pingLook, type HudInput, type HudMemory } from './hud';
import { conditions, dashStatus, eventLook, feedFromEvents, fuelView, grenadeBelt, healthView, pickupIcon, pickupNear, pickupPrompt, screenAngle, shieldStatus, weaponCards, type HudPlayer } from './model';
import { stateMatches } from './state';
import { HUD_VARS, hudTemplate } from './template';
import { iconMask, touchGrenade, touchSkinCss } from './touchSkin';

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

  it('ping looks: green up to 100 ms, amber to 200, red beyond', () => {
    expect([30, 80, 150, 450].map((ms) => pingLook(ms))).toEqual([
      { cls: 'ping--good', bars: 4 },
      { cls: 'ping--good', bars: 3 },
      { cls: 'ping--mid', bars: 2 },
      { cls: 'ping--bad', bars: 1 },
    ]);
  });

  it('the touch buttons get the kit icons as masks', () => {
    expect(iconMask('icon-reload')).toMatch(/^url\("data:image\/svg\+xml,/);
    expect(iconMask('icon-nope')).toBeNull();
    const css = touchSkinCss();
    for (const control of ['grenade', 'dash', 'reload', 'swap', 'shield', 'pause']) expect(css).toContain(`.mf-ctl-${control}::before`);
  });

  it('the touch grenade button shows the selected type and how many you carry', () => {
    const css = touchSkinCss();
    for (const id of ['frag', 'smoke', 'gas', 'flash', 'mine', 'emp']) expect(css).toContain(`.mf-ctl-grenade[data-grenade="${id}"]::before`);
    expect(css).toContain('.mf-ctl-grenade[data-count]::after { content: attr(data-count)');
    const slot = (id: string, count: number, selected = false) => ({ id, count, selected });
    expect(touchGrenade([slot('frag', 3), slot('smoke', 2, true)])).toEqual({ id: 'smoke', count: 2 });
    expect(touchGrenade([slot('frag', 0)])).toEqual({ id: 'frag', count: 0 });
    expect(touchGrenade([])).toEqual({ id: 'frag', count: 0 });
  });
});

describe('hudFrame', () => {
  const me = player({ hp: 25, shield: 'front', shieldHp: 240, dashCooldown: 30, jetDisabled: true, weapons: [{ def: 0, mag: 2, reserve: 24, reloadTicks: 20 }, { def: 1, mag: 40, reserve: 250, reloadTicks: 0 }], frags: 2 });
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
  const memory: HudMemory = { sinceHitS: 1, death: null, keys: { dash: 'Shift', grenade: 'G', cycleGrenade: 'T', shield: 'X', swap: 'Q', reload: 'R', scoreboard: 'Tab' }, netDetail: '', hpGhost: 0.5, hitMarker: true, killMarker: false, boardOpen: false };

  it('gives every key the template binds a value, in play and in death', () => {
    const bound = new Set<string>();
    const html = hudTemplate();
    for (const m of html.matchAll(/data-bind="([^"]+)"/g)) bound.add(m[1]!.trim());
    for (const m of html.matchAll(/data-bind-(?:attr|var)="([^"]+)"/g)) for (const pair of m[1]!.split(';')) bound.add(pair.split(':')[1]!.trim());
    for (const pair of HUD_VARS.split(';')) bound.add(pair.split(':')[1]!.trim());
    const playing = { phase: MatchPhase.InProgress, number: 1, secondsLeft: 222, untimed: false, secondsElapsed: 0, killLimit: 10, timeLimit: 300, countdownTotal: 3, mapName: 'Lunar Outpost', localId: 0, myScore: 6, leaderScore: 8, leaderName: 'Kemi', ready: true, votes: 0, humans: 2, voted: false, results: null };
    const net = { rttMs: 38, snapshotsPerSec: 30, kbInPerSec: 8, kbOutPerSec: 4, interpDelayMs: 100, status: 'connected' };
    const alive = hudFrame(input({ match: playing, frame: { ...input().frame, net } }), memory).values;
    const dead = hudFrame(input({ frame: { tick: 1, localId: 0, players: [{ ...me, alive: false, respawnTicks: 90 }], grenades: [] } }), { ...memory, death: { label: 'Taken out by', killer: 'Kemi', icon: '#icon-wpn-widow' } }).values;
    expect([...bound].filter((k) => alive[k] === undefined && dead[k] === undefined)).toEqual([]);
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
      'weapon.0.name': 'Hammer .44',
      'weapon.0.icon': '#icon-wpn-hammer',
      'weapon.0.mag': '2',
      'weapon.1.name': 'Buzz',
      'weapon.1.ammo': '40 / 250',
      'weapon.zoom': '2×',
      'belt.selected': 'Frag',
      'belt.count': '2',
      'event.class': 'event-banner event-banner--warn',
      'event.color': 'var(--c-ev-emp)',
      'event.icon': '#icon-warn',
      'event.time': 'in 3 s',
      'pickup.name': 'Riot Shield',
      'pickup.icon': '#icon-shield',
      'pickup.text': 'Riot Shield: walk over to take',
      'bind.dash.0': 'Shift',
      'fps.value': '60',
    });
    expect(Number(v['v.reload'])).toBeGreaterThan(0);
    expect(tokens).toEqual(expect.arrayContaining(['alive', 'low-hp', 'shield', 'shield-up', 'emp', 'dash-cooldown', 'reloading', 'weapon', 'gun', 'second-weapon', 'belt', 'event', 'pickup', 'reticle', 'hit-marker', 'fps']));
    expect(tokens).not.toContain('match');
    expect(tokens).not.toContain('spectating');
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
