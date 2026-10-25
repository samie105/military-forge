/** The premium in-match moments (owner, 23 Oct 2026): the map event's sequence, the world tags' fade, the item and compare cards, the swap's landing, the kill confirm. */
import { BREACHER, BUZZ, HAMMER, K47, RIOT_SHIELD, THUMPER, createTuning, grenades, pickups, weaponPickup, weapons } from '@military-forge/content';
import { describe, expect, it } from 'vitest';
import { hudFrame, type HudInput, type HudMemory } from './hud';
import { EVENT_END_MS, EVENT_IMPACT_MS, EventTimeline, eventArrow, eventEffect, eventEndLine, eventFx, eventMomentOf, fireWords, itemCard, streakWords, tagDistance, tagFade, type HudPlayer } from './model';
import { PHONE_TAGS, planTags, tagWords } from './worldTags';

const t = createTuning();

function player(over: Partial<HudPlayer> = {}): HudPlayer {
  return { id: 0, name: 'You', isBot: false, isLocal: true, alive: true, x: 10, y: 2, vx: 0, vy: 0, grounded: true, crouched: false, jetting: false, aim: 0, hp: 100, fuel: 100, fuelRegenDelay: 0, frags: 3, active: 0, dual: false, weapons: [], respawnTicks: 0, kills: 0, deaths: 0, ...over } as HudPlayer;
}
const gun = (def: number, mag = 6, reserve = 30) => ({ def, mag, reserve, reloadTicks: 0 });
const input = (p: HudPlayer, over: Partial<HudInput['frame']> = {}): HudInput => ({
  frame: { tick: 1, localId: 0, players: [p], grenades: [], ...over },
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
});
const mem: HudMemory = { sinceHitS: 9, death: null, keys: { interact: 'E', swap: 'Q' }, netDetail: '', hpGhost: 1, hitMarker: false, killMarker: false, boardOpen: false };

const view = (phase: 'warning' | 'active', secondsLeft: number, progress: number, occurrence = 1, kind = 'gravitySurge') => ({
  id: 'surge',
  kind,
  name: 'GRAVITY SURGE',
  description: 'Everything is heavier: jets climb slowly',
  phase,
  secondsLeft,
  progress,
  occurrence,
});

describe('the map event sequence (EventTimeline)', () => {
  it('warns with a countdown, stamps the impact as it starts, runs, then gives the all-clear', () => {
    const tl = new EventTimeline();
    expect(tl.update(null, 0)).toBeNull();
    const warn = tl.update(view('warning', 2.4, 0.4), 100)!;
    expect(warn).toMatchObject({ stage: 'warning', seconds: 3, progress: 0.4, name: 'GRAVITY SURGE' });
    expect(tl.update(view('active', 15, 0.01), 1000)!.stage).toBe('impact');
    expect(tl.update(view('active', 14.5, 0.04), 1000 + EVENT_IMPACT_MS - 1)!.stage).toBe('impact');
    const active = tl.update(view('active', 14, 0.07), 1000 + EVENT_IMPACT_MS)!;
    expect(active).toMatchObject({ stage: 'active', seconds: 14 });
    expect(active.progress).toBeCloseTo(0.93);
    // it ends: the all-clear for a moment, then nothing
    expect(tl.update(null, 20_000)).toMatchObject({ stage: 'end', kind: 'gravitySurge', seconds: 0 });
    expect(tl.update(null, 20_000 + EVENT_END_MS - 1)!.stage).toBe('end');
    expect(tl.update(null, 20_000 + EVENT_END_MS)).toBeNull();
  });

  it('joining mid-event shows it running (no impact); a new event takes over the all-clear at once', () => {
    const tl = new EventTimeline();
    expect(tl.update(view('active', 8, 0.5), 0)!.stage).toBe('active');
    expect(tl.update(null, 100)!.stage).toBe('end');
    expect(tl.update(view('warning', 3, 0, 2, 'emp'), 200)).toMatchObject({ stage: 'warning', kind: 'emp' });
  });

  it('a warning that never starts (a new map, a reset) leaves no all-clear', () => {
    const tl = new EventTimeline();
    tl.update(view('warning', 3, 0), 0);
    expect(tl.update(null, 50)).toBeNull();
  });

  it('without the timeline the frame still reads as warning or active', () => {
    expect(eventMomentOf(null)).toBeNull();
    expect(eventMomentOf(view('active', 17.2, 0.25))).toMatchObject({ stage: 'active', seconds: 18, progress: 0.75 });
  });

  it('the words and looks: the effect in a few words, the all-clear, the arrow, the treatment', () => {
    expect(eventEffect('Everything is heavier: jets climb slowly')).toBe('Jets climb slowly');
    expect(eventEffect('Jetpacks offline')).toBe('Jetpacks offline');
    expect(eventEffect('')).toBe('');
    expect(eventEndLine('emp')).toBe('Jetpacks back online');
    expect(eventEndLine('fog')).toBe('Full range again');
    expect(eventEndLine('custom')).toBe('Back to normal');
    expect([eventArrow('gravitySurge'), eventArrow('lowGravity'), eventArrow('flip'), eventArrow('fog')]).toEqual(['chev-down', 'chev-up', 'rotate', '']);
    expect(['gravitySurge', 'lowGravity', 'emp', 'fog', 'gust', 'flip', 'custom', 'meteor'].map(eventFx)).toEqual(['gravitySurge', 'lowGravity', 'emp', 'fog', 'gust', 'flip', 'custom', 'custom']);
  });

  it('hudFrame: one token per stage, the countdown digit restamps each second, the kind treatment while it runs', () => {
    const me = player({ weapons: [gun(HAMMER.index)] });
    const frame = (event: HudMemory['event']) => hudFrame(input(me), { ...mem, event });
    const w3 = frame({ stage: 'warning', kind: 'gravitySurge', name: 'GRAVITY SURGE', description: 'Everything is heavier: jets climb slowly', seconds: 3, progress: 0.2 });
    const w2 = frame({ stage: 'warning', kind: 'gravitySurge', name: 'GRAVITY SURGE', description: 'x', seconds: 2, progress: 0.6 });
    expect(w3.tokens).toEqual(expect.arrayContaining(['ev-shown', 'ev-warning']));
    expect(w3.tokens).not.toContain('ev-fx-gravitySurge');
    expect(w3.values).toMatchObject({ 'event.count': '3', 'event.stage': 'warning', 'event.arrow': '#icon-chev-down', 'event.fx': 'gravitySurge', 'v.evWarn': '0.2', 'v.event': '0' });
    expect(w3.values['event.countClass']).not.toBe(w2.values['event.countClass']);
    const impact = frame({ stage: 'impact', kind: 'emp', name: 'EMP STORM', description: 'Jetpacks offline', seconds: 8, progress: 1 });
    expect(impact.tokens).toEqual(expect.arrayContaining(['ev-impact', 'ev-fx-emp']));
    expect(impact.values).toMatchObject({ 'event.effect': 'Jetpacks offline', 'event.timeLeft': '8', 'event.count': '', 'event.icon': '#icon-ev-emp' });
    const end = frame({ stage: 'end', kind: 'emp', name: 'EMP STORM', description: 'Jetpacks offline', seconds: 0, progress: 0 });
    expect(end.tokens).toEqual(expect.arrayContaining(['ev-end', 'ev-shown']));
    expect(end.tokens.some((k) => k.startsWith('ev-fx-'))).toBe(false);
    expect(end.values).toMatchObject({ 'event.over': 'EMP STORM over', 'event.endLine': 'Jetpacks back online', 'event.stage': 'end' });
    expect(frame(null).tokens.some((k) => k.startsWith('ev-'))).toBe(false);
  });
});

describe('guns and items on the ground', () => {
  it('a tag is full size up close, smaller and fainter far off, gone past 48 m, in steps', () => {
    expect(tagFade(3)).toEqual({ scale: 1, opacity: 1 });
    expect(tagFade(30)).toEqual({ scale: 0.72, opacity: 0.45 });
    expect(tagFade(80)).toBeNull();
    const mid = tagFade(18)!;
    expect(mid.scale).toBeLessThan(1);
    expect(mid.scale).toBeGreaterThan(0.72);
    // stepped: a small move doesn't change it
    expect(tagFade(18.1)).toEqual(mid);
    expect([tagDistance(4.4), tagDistance(13), tagDistance(27.6)]).toEqual(['4 m', '15 m', '30 m']);
  });

  it("a tag's words: name, class, the mag, a power weapon's brass", () => {
    expect(tagWords(weaponPickup(K47.index)!)).toMatchObject({ name: 'K-47', family: 'Rifle', ammo: `${K47.mag} rd`, power: false, kind: 'gun' });
    expect(tagWords(weaponPickup(BREACHER.index)!)).toMatchObject({ power: true });
    const frags = pickups.find((p) => p.kind === 'grenades' && grenades[p.grenade!]?.id === 'frag')!;
    expect(tagWords(frags)).toMatchObject({ name: '×2', family: 'Grenades', ammo: '', kind: 'grenades', icon: '#icon-g-frag' });
  });

  it('the phone tags the nearest four only, and a rack gun near you as a plain tag', () => {
    const crate = (id: number, x: number) => ({ id, def: weaponPickup(weapons[id % 8]!.index)!.index, x, y: 0 });
    const lone = [crate(1, 3), crate(2, -9), crate(3, 20), crate(4, -30), crate(5, 41), crate(6, 12)];
    const phone = planTags(lone, { x: 0, y: 0 }, PHONE_TAGS);
    expect(phone.tags.map((t) => t.id)).toEqual([1, 2, 6, 3]);
    const rack = Array.from({ length: 6 }, (_, i) => crate(100 + i, 20 + i * 0.8));
    const near = planTags(rack, { x: 22, y: 0 }, PHONE_TAGS);
    expect(near.sign).toBeNull();
    expect(near.tags.length).toBeGreaterThan(0);
    expect(near.tags.every((t) => t.kind === 'crate' && Number.isFinite(t.distance))).toBe(true);
  });

  it('the item card, one short line: what a grenade pair does to your count, the shield, a gun a step away', () => {
    const frags = pickups.find((p) => p.kind === 'grenades' && grenades[p.grenade!]?.id === 'frag')!;
    const max = grenades[frags.grenade!]!.maxCount;
    expect(itemCard(frags, { grenadeCounts: [1, 0, 0, 0, 0, 0] })).toMatchObject({ tone: 'grenades', title: 'Frag', line: `1 → ${Math.min(max, 3)}` });
    expect(itemCard(frags, { grenadeCounts: [max, 0, 0, 0, 0, 0] }).line).toBe('Full');
    const shield = pickups.find((p) => p.kind === 'shield')!;
    expect(itemCard(shield, {})).toMatchObject({ tone: 'shield', line: `${RIOT_SHIELD.hp} HP` });
    const k47 = weaponPickup(K47.index)!;
    expect(itemCard(k47, { weapons: [gun(HAMMER.index)] })).toMatchObject({ title: 'K-47', line: 'Stand on it' });
    expect(itemCard(k47, { weapons: [gun(K47.index)] }).line).toBe('Ammo');
  });

  it("the compare card: the new gun's class, fire mode and mag, a power weapon in brass; the item card for a pair close by", () => {
    const me = player({ weapons: [gun(HAMMER.index), gun(BUZZ.index, 40)] });
    const onCrate = hudFrame(input(me, { pickups: [{ id: 4, def: weaponPickup(K47.index)!.index, x: me.x, y: me.y }] }), mem);
    expect(onCrate.values).toMatchObject({ 'pickup.weapon.family': 'Rifle', 'pickup.weapon.fire': fireWords(K47), 'pickup.weapon.magWords': `${K47.mag}-round mag`, 'pickup.weapon.power': '' });
    const power = hudFrame(input(me, { pickups: [{ id: 4, def: weaponPickup(THUMPER.index)!.index, x: me.x, y: me.y }] }), mem);
    expect(power.values['pickup.weapon.power']).toBe('power');
    const frags = pickups.find((p) => p.kind === 'grenades' && grenades[p.grenade!]?.id === 'frag')!;
    const near = hudFrame(input({ ...me, grenadeCounts: [2, 0, 0, 0, 0, 0] }, { pickups: [{ id: 5, def: frags.index, x: me.x + 1.5, y: me.y }] }), mem);
    expect(near.tokens).toContain('pickup-item');
    expect(near.values).toMatchObject({ 'pickup.item.title': 'Frag', 'pickup.item.line': '2 → 4', 'pickup.item.tone': 'grenades' });
    expect(fireWords(K47)).toBe('Full auto');
    expect(fireWords(HAMMER)).toBe('Semi-auto');
  });
});

describe('the swap and the kill confirm', () => {
  it('a draw: its length for the motion; then the landing and the swap-back hint', () => {
    const me = player({ weapons: [gun(HAMMER.index), gun(K47.index, 30)], active: 1 });
    const drawing = hudFrame(input({ ...me, swapTicks: 9 }), { ...mem, swapTotal: 21 });
    expect(drawing.tokens).toEqual(expect.arrayContaining(['switching', 'swap-hint']));
    expect(drawing.tokens).not.toContain('drawn');
    expect(drawing.values).toMatchObject({ 'v.equipMs': '350ms', 'player.slot.0.fire': 'Full auto', 'player.slot.1.name': HAMMER.name });
    const landed = hudFrame(input(me), { ...mem, swapTotal: 21, drawn: true, swapHint: true });
    expect(landed.tokens).toEqual(expect.arrayContaining(['drawn', 'swap-hint']));
    expect(landed.tokens).not.toContain('switching');
    expect(hudFrame(input(me), mem).tokens).not.toContain('swap-hint');
    // the equip time's bounds (the motion stays between 0.25 and 0.6 s)
    expect(hudFrame(input({ ...me, swapTicks: 60 }), { ...mem, swapTotal: 60 }).values['v.equipMs']).toBe('600ms');
  });

  it('a kill: the name (restamped on the next), a headshot, the streak in words', () => {
    const me = player({ weapons: [gun(HAMMER.index)] });
    const one = hudFrame(input(me), { ...mem, kill: { victim: 'Kemi', streak: 1, headshot: true, n: 1 } });
    expect(one.tokens).toEqual(expect.arrayContaining(['kill-confirm', 'kill-head']));
    expect(one.values).toMatchObject({ 'kill.victim': 'Kemi', 'kill.streak': '' });
    const two = hudFrame(input(me), { ...mem, kill: { victim: 'Tunde', streak: 2, headshot: false, n: 2 } });
    expect(two.values['kill.streak']).toBe('2 down');
    expect(two.values['kill.class']).not.toBe(one.values['kill.class']);
    expect(two.tokens).not.toContain('kill-head');
    // dead: no confirm
    expect(hudFrame(input({ ...me, alive: false, respawnTicks: 60 }), { ...mem, kill: { victim: 'Kemi', streak: 1, headshot: false, n: 1 } }).tokens).not.toContain('kill-confirm');
    expect([streakWords(1), streakWords(3), streakWords(9)]).toEqual(['', '3 down', 'Unstoppable']);
  });
});
