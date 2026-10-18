import { BREACHER, BUZZ, HAMMER, K47, RIOT_SHIELD, RIOT_SHIELD_PICKUP } from '@military-forge/content';
import { Btn, DamageSource, Game, PlayerState, createInput, giveShield, shieldRaised, shieldSlung, type Input, type SimEvent } from '@military-forge/sim';
import { describe, expect, it } from 'vitest';
import {
  DecodeError,
  LOCAL_STATE_FIELDS,
  LS,
  PROTOCOL_VERSION,
  SnapshotBaselines,
  SnapshotDecoder,
  SnapshotEncoder,
  applyLocalState,
  captureLocalState,
  createLocalState,
  decodeMessage,
  describeLocalDiff,
  type SnapshotMsg,
  type ViewRect,
} from '../src';

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

describe('riot shield on the wire (protocol v9)', () => {
  it('takes the v9 slots from the protocol registry, next to the dash (v8) without overlapping it', () => {
    expect(PROTOCOL_VERSION).toBeGreaterThanOrEqual(9); // v10 (arsenal B) appends after the shield's slots
    expect([Btn.Dash, Btn.Shield]).toEqual([1 << 13, 1 << 14]);
    expect([LS.dashTicks, LS.airDashUsed, LS.shieldHp, LS.shieldStowed, LS.shieldTicks]).toEqual([41, 44, 45, 46, 47]);
    expect(LOCAL_STATE_FIELDS).toBeGreaterThanOrEqual(48);
    // a carrier dashing with its shield slung: the dashing flag (128) and the shield state (256/512) both arrive
    const game = new Game({ seed: 4, dummies: false });
    const obs = game.addPlayer('obs');
    const p = game.addPlayer('p');
    giveShield(p, 200);
    p.shieldStowed = true;
    for (let i = 0; i < 20; i++) game.step([]);
    expect(shieldSlung(p)).toBe(true);
    const inputs: Input[] = [];
    inputs[p.id] = { ...createInput(), buttons: Btn.Dash | Btn.Right };
    game.step(inputs);
    expect(p.dashTicks).toBeGreaterThan(0);
    // the extended kinds side by side: DASH 0, RICOCHET 1, SHIELD_BREAK 2, PICKUP 3, after a MAP_EVENT (tag 6)
    const events: SimEvent[] = [
      { type: 'mapEvent', event: 0, phase: 1, occurrence: 3, zone: -1, flip: false, ticks: 600 },
      { type: 'dash', player: p.id, x: 5, y: 1, dir: 2 },
      { type: 'ricochet', shooter: obs.id, owner: p.id, weapon: HAMMER.index, x: 5.5, y: 1, nx: -1, ny: 0, ex: 1, ey: 1, hit: 0, target: -1, zone: 0 },
      { type: 'shieldBreak', owner: p.id, attacker: obs.id, x: 5.5, y: 1 },
      { type: 'pickup', player: p.id, item: RIOT_SHIELD_PICKUP.index, x: 6, y: 0 },
    ];
    const enc = new SnapshotEncoder();
    enc.begin(game, 1, events);
    const snap = decodeMessage(enc.encodeFor({ baselines: null, ackInputTick: 0, inputBufferHealth: 0, local: obs, view: null })) as SnapshotMsg;
    const seen = snap.players.find((q) => q.id === p.id)!;
    expect([seen.dashing, seen.shield]).toEqual([true, 'slung']);
    expect(snap.events).toEqual(events);
  });

  it('the local block carries the shield exactly, full and delta, through raising, slinging, dual and damage', () => {
    const game = new Game({ seed: 8, dummies: false });
    const me = game.addPlayer('me');
    const foe = game.addPlayer('foe');
    game.setLoadout(me, [HAMMER.index, K47.index]);
    game.setLoadout(foe, [BREACHER.index, HAMMER.index]);
    me.x = 20;
    foe.x = 16;
    me.y = foe.y = 0.01;
    giveShield(me, RIOT_SHIELD.hp);
    const enc = new SnapshotEncoder();
    const baselines = new SnapshotBaselines();
    const decoder = new SnapshotDecoder();
    const ghost = new PlayerState(me.id);
    const script = [0, Btn.Shield, 0, Btn.Shield, Btn.Swap, 0, Btn.Swap, Btn.Dual, 0, Btn.Shield, Btn.Right, Btn.Left | Btn.Shield];
    const inputs: Input[] = [];
    let carried = 0;
    let sawStowed = false;
    let sawRaising = false;
    let deltas = 0;
    for (let t = 0; t < 900; t++) {
      inputs[me.id] = { ...createInput(), buttons: script[Math.floor(t / 9) % script.length]!, aim: 32768 }; // facing the foe
      inputs[foe.id] = { ...createInput(), buttons: t % 47 === 0 ? Btn.Fire : 0, aim: 0 };
      game.step(inputs);
      if (me.shieldHp > 0) carried++;
      sawStowed ||= me.shieldStowed;
      sawRaising ||= me.shieldTicks > 0 && me.shieldTicks < 15;
      if (t === 600) giveShield(me, 123.5); // a new (dropped) one
      enc.begin(game, t + 1, game.events);
      const server = captureLocalState(me, createLocalState());
      const full = decodeMessage(enc.encodeFor({ baselines: null, ackInputTick: t & 0xffff, inputBufferHealth: 1, local: me, view: null })) as SnapshotMsg;
      expect(describeLocalDiff(full.local!, server)).toBe('');
      applyLocalState(full.local!, ghost);
      expect([ghost.shieldHp, ghost.shieldStowed, ghost.shieldTicks]).toEqual([me.shieldHp, me.shieldStowed, me.shieldTicks]);
      const got = decoder.decode(enc.encodeFor({ baselines, ackInputTick: t & 0xffff, inputBufferHealth: 1, local: me, view: null }));
      baselines.ack(got.seq);
      if (got.baselineSeq !== 0) deltas++;
      expect(describeLocalDiff(got.local!, server)).toBe('');
    }
    expect(carried).toBeGreaterThan(300);
    expect(sawStowed && sawRaising).toBe(true);
    expect(deltas).toBeGreaterThan(800);
    expect(captureLocalState(me, createLocalState())[LS.shieldHp]).toBe(Math.round(me.shieldHp * 1024));
  });

  it('remote players show their shield as slung, on its way up (guarding neither side), or up', () => {
    const game = new Game({ seed: 4, dummies: false });
    const obs = game.addPlayer('obs');
    const up = game.addPlayer('up');
    const slung = game.addPlayer('slung');
    const raising = game.addPlayer('raising');
    const none = game.addPlayer('none');
    game.setLoadout(slung, [K47.index, HAMMER.index]); // two-handed: slung
    giveShield(up, 200);
    giveShield(slung, 200);
    for (let i = 0; i < 20; i++) game.step([]);
    giveShield(raising, 200);
    game.step([]);
    game.step([]);
    expect(shieldRaised(up)).toBe(true);
    expect(shieldSlung(slung)).toBe(true);
    expect(raising.shieldTicks).toBe(2);
    const enc = new SnapshotEncoder();
    enc.begin(game, 1, []);
    const snap = decodeMessage(enc.encodeFor({ baselines: null, ackInputTick: 0, inputBufferHealth: 0, local: obs, view: null })) as SnapshotMsg;
    const by = (id: number) => snap.players.find((p) => p.id === id)!.shield;
    expect([by(up.id), by(slung.id), by(raising.id), by(none.id)]).toEqual(['up', 'slung', 'raising', 'none']);
  });

  it('items on the map arrive in full snapshots and in deltas only when they change, through loss and lag', () => {
    const game = new Game({ mapId: 'movement-test', seed: 1234, pickups: true, dummies: false });
    const a = game.addPlayer('a');
    const b = game.addPlayer('b');
    a.x = 148;
    b.x = 30;
    const enc = new SnapshotEncoder();
    const full = new SnapshotEncoder();
    const baselines = new SnapshotBaselines();
    const decoder = new SnapshotDecoder();
    const rand = rng(3);
    const truth = new Map<number, SnapshotMsg>();
    const delivered: { at: number; bytes: Uint8Array }[] = [];
    const inputs: Input[] = [];
    let checked = 0;
    let seq = 0;
    let withItems = 0;
    let changes = 0;
    let prev = '';
    for (let t = 0; t < 3600; t++) {
      // a strolls across the spots now and then, taking what's there; it dies once and drops it
      const phase = Math.floor(t / 400) % 3;
      inputs[a.id] = { ...createInput(), buttons: phase === 0 ? Btn.Right : phase === 1 ? Btn.Left : 0 };
      game.step(inputs);
      if (t === 2500 && a.shieldHp > 0) game.damage(a, 500, b.id, DamageSource.World, 0);
      if (game.tick % 2 !== 0) continue;
      seq++;
      enc.begin(game, seq, game.events);
      full.begin(game, seq, game.events);
      const bytes = enc.encodeFor({ baselines, ackInputTick: 0, inputBufferHealth: 0, local: b, view: null });
      const want = decodeMessage(full.encodeFor({ baselines: null, ackInputTick: 0, inputBufferHealth: 0, local: b, view: null })) as SnapshotMsg;
      truth.set(seq, want);
      const key = JSON.stringify(want.pickups);
      if (key !== prev) changes++;
      prev = key;
      if (rand() >= 0.1) delivered.push({ at: seq + 5, bytes });
      while (delivered.length && delivered[0]!.at <= seq) {
        const got = decoder.decode(delivered.shift()!.bytes);
        baselines.ack(got.seq);
        expect(got.pickups).toEqual(truth.get(got.seq)!.pickups);
        if (got.pickups.length) withItems++;
        checked++;
      }
    }
    // the list is the game's alive items, quantised
    const alive = game.pickups.filter((k) => k.alive).map((k) => ({ id: k.id, def: k.def, x: k.x, y: k.y }));
    expect(truth.get(seq)!.pickups).toEqual(alive);
    expect(checked).toBeGreaterThan(1500);
    expect(withItems).toBeGreaterThan(300);
    expect(changes).toBeGreaterThan(4); // spawned, taken, respawned, dropped…
    expect(changes).toBeLessThan(40);
  });

  it('ricochets, shield breaks and pickups round-trip, and the AOI hides culled players behind them', () => {
    const game = new Game({ seed: 2, dummies: false });
    const obs = game.addPlayer('obs');
    const a = game.addPlayer('a');
    const owner = game.addPlayer('owner');
    const far = game.addPlayer('far');
    obs.x = 10;
    a.x = 20;
    owner.x = 30;
    far.x = 66; // culled
    obs.y = a.y = owner.y = far.y = 15;
    const view: ViewRect = { minX: -20, minY: 0, maxX: 60, maxY: 40 };
    const w = BREACHER.index;
    const ricochet = (shooter: number, x: number, ex: number, hit: 0 | 1 | 2 | 3, target: number): SimEvent => ({
      type: 'ricochet',
      shooter,
      owner: owner.id,
      weapon: w,
      x,
      y: 15.75,
      nx: 1,
      ny: 0,
      ex,
      ey: 15.75,
      hit,
      target,
      zone: hit === 2 ? 2 : 0,
    });
    const events: SimEvent[] = [
      ricochet(a.id, 29.625, 21, 2, a.id), // all in view (into a third player: here, a)
      ricochet(far.id, 29.625, 34, 1, -1), // a culled shooter's bullet off a visible shield: the spark only
      ricochet(far.id, 29.625, 10.5, 2, obs.id), // …and one that hits you: the spark, and that it hit you
      ricochet(a.id, 29.625, 65.75, 2, far.id), // into a culled player: clipped, no target, a miss
      ricochet(a.id, 70, 64, 1, -1), // off a shield outside the view: not sent
      { type: 'shieldBreak', owner: owner.id, attacker: far.id, x: 29.625, y: 15.75 }, // hidden attacker
      { type: 'shieldBreak', owner: far.id, attacker: a.id, x: 65.625, y: 15.75 }, // culled owner: not sent
      { type: 'pickup', player: a.id, item: RIOT_SHIELD_PICKUP.index, x: 25, y: 15 },
      { type: 'pickup', player: far.id, item: RIOT_SHIELD_PICKUP.index, x: 66, y: 15 }, // out of view: not sent
      // a tracer that ends on a culled player's shield stops short and reads as a miss
      { type: 'shot', shooter: a.id, weapon: HAMMER.index, ox: 20.5, oy: 15.5, ex: 65.625, ey: 15.5, hit: 3, target: far.id, zone: 0 },
    ];
    const enc = new SnapshotEncoder();
    enc.begin(game, 1, events);
    const everything = decodeMessage(enc.encodeFor({ baselines: null, ackInputTick: 0, inputBufferHealth: 0, local: null, view: null })) as SnapshotMsg;
    // no view: everything, exactly (positions on the 1/1024 grid)
    expect(everything.events).toEqual(events.map((e) => (e.type === 'shot' ? { ...e, ox: 20.5, oy: 15.5 } : e)));

    const snap = new SnapshotDecoder().decode(enc.encodeFor({ baselines: null, ackInputTick: 0, inputBufferHealth: 0, local: obs, view }));
    const r = snap.events.filter((e) => e.type === 'ricochet');
    expect(r).toHaveLength(4);
    expect(r[0]).toEqual(events[0]);
    // a culled shooter (review M1): un-reflecting two lines would cross at its shoulder, so no line at all
    expect(r[1]).toEqual({ ...events[1], shooter: -1, ex: 29.625, ey: 15.75, hit: 0, target: -1, zone: 0 });
    // one that hit the viewer: still no line, but it says so (and names the shooter to its target, as HIT does)
    expect(r[2]).toEqual({ ...events[2], shooter: far.id, ex: 29.625, ey: 15.75 });
    expect(r[3]).toMatchObject({ shooter: a.id, hit: 0, target: -1, zone: 0 });
    expect(r[3]!.ex).toBeLessThan(60 - 1.48);
    expect(r[3]!.ex).toBeGreaterThan(55);
    const breaks = snap.events.filter((e) => e.type === 'shieldBreak');
    expect(breaks).toEqual([{ type: 'shieldBreak', owner: owner.id, attacker: -1, x: 29.625, y: 15.75 }]);
    const picks = snap.events.filter((e) => e.type === 'pickup');
    expect(picks).toEqual([events[7]]);
    const shots = snap.events.filter((e) => e.type === 'shot');
    expect(shots).toHaveLength(1);
    expect(shots[0]).toMatchObject({ hit: 0, target: -1, zone: 0 });
    expect(shots[0]!.ex).toBeLessThan(60 - 1.48);

    // the culled player sees its own pickup
    const own = new SnapshotDecoder().decode(enc.encodeFor({ baselines: null, ackInputTick: 0, inputBufferHealth: 0, local: far, view: { minX: 40, minY: 0, maxX: 100, maxY: 40 } }));
    expect(own.events.filter((e) => e.type === 'pickup')).toEqual([events[8]]);
  });

  it('items are culled by view: one taken or dropped out of view gives no one away (review L2)', () => {
    const game = new Game({ seed: 2, dummies: false, pickups: true });
    const viewer = game.addPlayer('viewer');
    const hidden = game.addPlayer('hidden');
    viewer.x = 10;
    hidden.x = 90;
    viewer.y = hidden.y = 0.01;
    const view: ViewRect = { minX: -10, minY: -5, maxX: 40, maxY: 20 };
    const enc = new SnapshotEncoder();
    const baselines = new SnapshotBaselines();
    const decoder = new SnapshotDecoder();
    const send = (seq: number) => {
      enc.begin(game, seq, []);
      const got = decoder.decode(enc.encodeFor({ baselines, ackInputTick: 0, inputBufferHealth: 0, local: viewer, view }));
      baselines.ack(got.seq);
      return got;
    };
    // a hidden player dies with a shield out of view: the drop appears, but not to the viewer
    giveShield(hidden, 120);
    game.damage(hidden, 500, viewer.id, DamageSource.World, 0);
    expect(game.pickups.filter((k) => k.alive)).toHaveLength(1);
    expect(send(1).pickups).toEqual([]);
    // one dropped in view is sent, and dropped from the list once the view moves off it
    giveShield(viewer, 80);
    game.damage(viewer, 500, hidden.id, DamageSource.World, 0);
    const seen = send(2).pickups;
    expect(seen).toHaveLength(1);
    expect(seen[0]!.x).toBeCloseTo(10, 6);
    expect(send(3).pickups).toEqual(seen); // unchanged: not re-sent, kept from the baseline
    view.minX = 50;
    view.maxX = 100;
    expect(send(4).pickups.map((k) => k.x)).toEqual([90]);
  });

  it('never throws anything but DecodeError on mutated snapshots full of items and extended events (fuzz, review L5)', () => {
    // a corpus of real snapshots that reach the item list and every tag-7 kind
    // right of the range's cover, away from the shield spots: the item stays on the map while they fight
    const game = new Game({ mapId: 'movement-test', seed: 5, pickups: true, dummies: false });
    const me = game.addPlayer('me');
    const foe = game.addPlayer('foe');
    game.setLoadout(foe, [BUZZ.index, BREACHER.index]); // a Buzz: a ricochet every 0.1 s
    giveShield(me, RIOT_SHIELD.hp);
    me.x = 159;
    foe.x = 156.4;
    me.y = foe.y = 0.01;
    const enc = new SnapshotEncoder();
    const corpus: Uint8Array[] = [];
    const inputs: Input[] = [];
    for (let t = 0; t < 900; t++) {
      inputs[me.id] = { ...createInput(), aim: 32768, buttons: t % 300 === 150 ? Btn.Shield : 0 };
      inputs[foe.id] = { ...createInput(), aim: 0, buttons: Btn.Fire };
      foe.weapons[0].mag = 40; // no reloads
      if (me.shieldHp < 40) me.shieldHp = RIOT_SHIELD.hp;
      me.hp = 100;
      game.step(inputs);
      const events: SimEvent[] = [...game.events];
      if (t % 97 === 0) events.push({ type: 'shieldBreak', owner: me.id, attacker: foe.id, x: 158.6, y: 0.9 }, { type: 'pickup', player: me.id, item: 0, x: 150.5, y: 0 });
      enc.begin(game, t + 1, events);
      const bytes = enc.encodeFor({ baselines: null, ackInputTick: t & 0xffff, inputBufferHealth: 1, local: me, view: null });
      const got = decodeMessage(bytes) as SnapshotMsg;
      if (got.pickups.length && got.events.some((e) => e.type === 'ricochet' || e.type === 'shieldBreak' || e.type === 'pickup')) corpus.push(bytes);
    }
    expect(corpus.length).toBeGreaterThan(20);
    const rand = rng(4242);
    let decoded = 0;
    let refused = 0;
    for (let i = 0; i < 20000; i++) {
      const bytes = corpus[Math.floor(rand() * corpus.length)]!.slice();
      let input = bytes;
      const mode = rand();
      if (mode < 0.4) {
        // flip a few bits, mostly in the tail where the items and events live
        for (let k = 1 + Math.floor(rand() * 4); k > 0; k--) bytes[Math.min(bytes.length - 1, Math.floor(bytes.length * (0.4 + 0.6 * rand())))]! ^= 1 << Math.floor(rand() * 8);
      } else if (mode < 0.7) input = bytes.slice(0, Math.floor(bytes.length * rand()));
      else for (let k = Math.floor(bytes.length / 2); k < bytes.length; k++) if (rand() < 0.3) bytes[k] = Math.floor(rand() * 256);
      try {
        const m = decodeMessage(input) as SnapshotMsg;
        expect(m.pickups.length).toBeLessThanOrEqual(32);
        decoded++;
      } catch (e) {
        expect(e).toBeInstanceOf(DecodeError);
        refused++;
      }
    }
    expect(decoded).toBeGreaterThan(1000);
    expect(refused).toBeGreaterThan(1000);
  });
});
