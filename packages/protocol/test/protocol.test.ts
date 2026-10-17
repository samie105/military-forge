import { BREACHER, MACHETE, WIDOW } from '@military-forge/content';
import { Btn, Game, PlayerState, createInput, type SimEvent } from '@military-forge/sim';
import { describe, expect, it } from 'vitest';
import {
  BitReader,
  BitWriter,
  CONTENT_HASH,
  HASHED_CONTENT,
  contentHashOf,
  DecodeError,
  LOCAL_STATE_MAX_BITS,
  MsgType,
  PROTOCOL_VERSION,
  SnapshotBaselines,
  SnapshotDecoder,
  SnapshotEncoder,
  applyLocalState,
  captureLocalState,
  createInputPacket,
  createLocalState,
  decodeInputInto,
  decodeMessage,
  describeLocalDiff,
  encodeCmd,
  encodeHello,
  encodeInput,
  encodePing,
  encodePong,
  encodeRewindDebug,
  encodeRoster,
  encodeSnapshot,
  encodeTuning,
  encodeWelcome,
  isUnreliableMessage,
  localStatesEqual,
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

describe('bitstream', () => {
  it('round-trips random unsigned and signed fields of every width', () => {
    const rand = rng(1);
    const fields: { bits: number; value: number; signed: boolean }[] = [];
    const w = new BitWriter(16);
    for (let i = 0; i < 2000; i++) {
      const bits = 1 + Math.floor(rand() * 32);
      const signed = bits > 1 && rand() < 0.5;
      const span = 2 ** bits;
      const value = signed ? Math.floor(rand() * span) - span / 2 : Math.floor(rand() * span);
      fields.push({ bits, value, signed });
      if (signed) w.signed(value, bits);
      else w.bits(value, bits);
    }
    const r = new BitReader(w.finish().slice());
    for (const f of fields) expect(f.signed ? r.signed(f.bits) : r.bits(f.bits)).toBe(f.value);
  });

  it('clamps out-of-range values instead of wrapping', () => {
    const w = new BitWriter();
    w.signed(1_000_000, 8).unsigned(-5, 4).unsigned(99, 4);
    const r = new BitReader(w.finish().slice());
    expect(r.signed(8)).toBe(127);
    expect(r.bits(4)).toBe(0);
    expect(r.bits(4)).toBe(15);
  });

  it('strings and doubles round-trip', () => {
    const w = new BitWriter();
    w.bits(1, 3).string('Ọlá 🚀').f64(Math.PI).string('x'.repeat(300), 16);
    const r = new BitReader(w.finish().slice());
    expect(r.bits(3)).toBe(1);
    expect(r.string()).toBe('Ọlá 🚀');
    expect(r.f64()).toBe(Math.PI);
    expect(r.string(16)).toBe('x'.repeat(300));
  });

  it('throws DecodeError when reading past the end', () => {
    const r = new BitReader(new Uint8Array([1]));
    r.bits(8);
    expect(() => r.bits(1)).toThrow(DecodeError);
  });
});

describe('messages', () => {
  it('hello / welcome / ping / pong / cmd / roster round-trip', () => {
    expect(decodeMessage(encodeHello('Ade'))).toEqual({ type: MsgType.Hello, protocolVersion: PROTOCOL_VERSION, contentHash: CONTENT_HASH, name: 'Ade', resumeToken: '' });
    expect(decodeMessage(encodeHello('Ade', 'tok-123'))).toMatchObject({ name: 'Ade', resumeToken: 'tok-123' });
    // a HELLO without the trailing token (older client / minimal tools) still decodes
    const bare = encodeHello('Kemi');
    expect(decodeMessage(bare.subarray(0, bare.length - 1))).toMatchObject({ name: 'Kemi', resumeToken: '' });
    const welcome = { playerId: 4, seed: 123456789, serverTick: 99, mapId: 'movement-test', tuningJson: '{"gravity":20}', sessionToken: 'abc_DEF-123', resumed: true };
    expect(decodeMessage(encodeWelcome(welcome))).toEqual({ type: MsgType.Welcome, ...welcome });
    expect(decodeMessage(encodePing(1234.5))).toEqual({ type: MsgType.Ping, clientTime: 1234.5 });
    expect(decodeMessage(encodePong(1234.5, 77))).toEqual({ type: MsgType.Pong, clientTime: 1234.5, serverTick: 77 });
    expect(decodeMessage(encodeCmd(1, '{"a":1}'))).toEqual({ type: MsgType.Cmd, kind: 1, payload: '{"a":1}' });
    const entries = [
      { id: 0, name: 'Strafer', isBot: true, since: 1 },
      { id: 4, name: 'Kemi', isBot: false, since: 4_000_000_000 },
    ];
    expect(decodeMessage(encodeRoster(entries))).toEqual({ type: MsgType.Roster, entries });
    expect(decodeMessage(encodeTuning('{"walkMax":6}'))).toEqual({ type: MsgType.Tuning, tuningJson: '{"walkMax":6}' });
    const rewind = {
      tick: 123456,
      shooter: 4,
      rewindTicks: 16.75,
      requestedTicks: 21.25,
      clamped: true,
      targets: [
        { id: 2, x: 10.5, y: 2.25, crouched: true, nowX: 11.75, nowY: 2.25, hit: true },
        { id: 7, x: -3, y: 0.5, crouched: false, nowX: -2.5, nowY: 0.5, hit: false },
      ],
    };
    expect(decodeMessage(encodeRewindDebug(rewind))).toEqual({ type: MsgType.Debug, kind: 1, ...rewind });
  });

  it('only INPUT, PING, PONG and SNAPSHOT are unreliable', () => {
    expect(isUnreliableMessage(encodePing(1))).toBe(true);
    expect(isUnreliableMessage(encodePong(1, 2))).toBe(true);
    expect(isUnreliableMessage(encodeInput({ newestTick: 1, ackSnapshotSeq: 0, renderTick: 0, renderFrac: 0, inputs: [createInput()] }))).toBe(true);
    expect(isUnreliableMessage(encodeHello('a'))).toBe(false);
    expect(isUnreliableMessage(encodeRoster([]))).toBe(false);
    expect(isUnreliableMessage(encodeTuning('{}'))).toBe(false);
  });

  it('input packets carry up to 4 redundant inputs in 13–31 bytes, each with its render lag', () => {
    const inputs = [0, 1, 2, 3].map((i) => ({ ...createInput(), buttons: Btn.Right | (i % 2 ? Btn.Fire : 0), aim: 1000 * i }));
    const renderLags = [0, 0.0625, 4.5, 15.9375];
    const sizes = [1, 2, 3, 4].map((n) => encodeInput({ newestTick: 1, ackSnapshotSeq: 0, renderTick: 0, renderFrac: 0, inputs: inputs.slice(0, n) }).length);
    expect(sizes).toEqual([13, 19, 25, 31]);
    const bytes = encodeInput({ newestTick: 65535, ackSnapshotSeq: 12, renderTick: 400, renderFrac: 128, inputs, renderLags });
    const m = decodeMessage(bytes);
    expect(m).toEqual({ type: MsgType.Input, newestTick: 65535, ackSnapshotSeq: 12, renderTick: 400, renderFrac: 128, inputs, renderLags });
    // without explicit lags each older input is assumed one frame (tick) older; lags saturate at 15.94
    expect((decodeMessage(encodeInput({ newestTick: 1, ackSnapshotSeq: 0, renderTick: 0, renderFrac: 0, inputs })) as { renderLags: number[] }).renderLags).toEqual([0, 1, 2, 3]);
    const saturated = encodeInput({ newestTick: 1, ackSnapshotSeq: 0, renderTick: 0, renderFrac: 0, inputs: inputs.slice(0, 2), renderLags: [5, 40] });
    expect((decodeMessage(saturated) as { renderLags: number[] }).renderLags).toEqual([0, 15.9375]); // [0] is never sent
  });

  it('INPUT with trailing bytes after the last input is refused', () => {
    const packet = createInputPacket();
    const bytes = encodeInput({ newestTick: 1, ackSnapshotSeq: 0, renderTick: 0, renderFrac: 0, inputs: [createInput()] });
    const padded = new Uint8Array(bytes.length + 1);
    padded.set(bytes);
    expect(() => decodeMessage(bytes)).not.toThrow();
    expect(() => decodeInputInto(bytes, packet)).not.toThrow();
    expect(() => decodeMessage(padded)).toThrow(DecodeError);
    expect(() => decodeInputInto(padded, packet)).toThrow(DecodeError);
  });

  it('pooled INPUT decode matches decodeMessage and reuses the same objects', () => {
    const packet = createInputPacket();
    const objects = [...packet.inputs];
    for (let n = 1; n <= 4; n++) {
      const inputs = Array.from({ length: n }, (_, i) => ({ ...createInput(), buttons: (i * 37) & 0xffff, aim: 4000 * i + n, weaponSelect: i, throwStrength: 7 - i }));
      const bytes = encodeInput({ newestTick: 1000 + n, ackSnapshotSeq: n, renderTick: 990, renderFrac: 7, inputs });
      decodeInputInto(bytes, packet);
      expect(packet.count).toBe(n);
      expect(packet.newestTick).toBe(1000 + n);
      expect(packet.inputs.slice(0, n)).toEqual(inputs);
      expect([...packet.renderLags.subarray(0, n)]).toEqual(Array.from({ length: n }, (_, i) => i));
      expect(packet.inputs).toEqual(expect.arrayContaining(objects));
      packet.inputs.forEach((o, i) => expect(o).toBe(objects[i]));
    }
    expect(() => decodeInputInto(encodePing(1), packet)).toThrow(DecodeError);
    expect(() => decodeInputInto(new Uint8Array([MsgType.Input, 1, 2]), packet)).toThrow(DecodeError);
  });

  it('full snapshots reproduce the authoritative state', () => {
    const game = new Game({ seed: 9, dummies: true });
    const me = game.addPlayer('me');
    const other = game.addPlayer('other');
    const inputs: ReturnType<typeof createInput>[] = [];
    inputs[me.id] = { ...createInput(), buttons: Btn.Right | Btn.Jet | Btn.Fire };
    inputs[other.id] = { ...createInput(), buttons: Btn.Left | Btn.Fire, aim: 32768 };
    const events = [];
    for (let i = 0; i < 90; i++) {
      game.step(inputs);
      events.push(...game.events);
    }
    inputs[me.id] = { ...createInput(), buttons: Btn.Grenade };
    game.step(inputs);
    events.push(...game.events);
    game.step(inputs);

    const bytes = encodeSnapshot(game, 7, events, { ackInputTick: 91, inputBufferHealth: -3, local: me });
    const snap = decodeMessage(bytes) as SnapshotMsg;
    expect(snap.type).toBe(MsgType.Snapshot);
    expect([snap.serverTick, snap.ackInputTick, snap.inputBufferHealth, snap.baselineSeq]).toEqual([game.tick, 91, -3, 0]);
    expect(localStatesEqual(snap.local!, captureLocalState(me, createLocalState()))).toBe(true);
    expect(snap.players.map((p) => p.id)).toEqual(game.players.filter((p) => p).map((p) => p!.id));
    for (const sp of snap.players) {
      const p = game.players[sp.id]!;
      expect([sp.x, sp.y, sp.hp, sp.active]).toEqual([p.x, p.y, Math.ceil(p.hp), p.active]);
      expect(Math.abs(sp.vx - p.vx)).toBeLessThanOrEqual(1 / 128);
      expect(Math.abs(sp.vy - p.vy)).toBeLessThanOrEqual(1 / 128);
      expect(sp.weapons.map((w) => w.def)).toEqual(p.weapons.map((w) => w.def));
      expect([sp.alive, sp.isBot, sp.crouched, sp.kills, sp.deaths]).toEqual([p.alive, p.isBot, p.crouched, p.kills, p.deaths]);
    }
    const g = game.grenades.find((x) => x.alive)!;
    expect(snap.grenades[0]).toMatchObject({ id: g.id, x: g.x, y: g.y, fuse: g.fuse });
    // our own shots are drawn from prediction: only the other player's come back
    const shots = snap.events.filter((e) => e.type === 'shot');
    expect(shots.length).toBe(events.filter((e) => e.type === 'shot' && e.shooter === other.id).length);
    expect(shots.length).toBeGreaterThan(0);
    expect(bytes.length).toBeLessThan(1200);
  });

  it('delta snapshots against acked baselines decode to exactly the full state, through loss and lag', () => {
    const game = new Game({ seed: 3, dummies: true });
    const a = game.addPlayer('a');
    const b = game.addPlayer('b');
    const enc = new SnapshotEncoder();
    const full = new SnapshotEncoder();
    const baselines = new SnapshotBaselines();
    const decoder = new SnapshotDecoder();
    const rand = rng(7);
    const inputs: ReturnType<typeof createInput>[] = [];
    const delivered: { at: number; bytes: Uint8Array }[] = [];
    const truth = new Map<number, SnapshotMsg>();
    let deltaBytes = 0;
    let fullBytes = 0;
    let deltas = 0;
    let checked = 0;
    let seq = 0;
    for (let t = 0; t < 1800; t++) {
      inputs[a.id] = { ...createInput(), buttons: t % 120 < 60 ? Btn.Right : Btn.Left | (t % 40 < 10 ? Btn.Jet : 0), aim: (t * 131) & 0xffff };
      inputs[b.id] = { ...createInput(), buttons: t % 90 < 30 ? Btn.Jet | Btn.Fire : Btn.Down, aim: (t * 17) & 0xffff };
      game.step(inputs);
      if (game.tick % 2 !== 0) continue;
      seq++;
      enc.begin(game, seq, game.events);
      full.begin(game, seq, game.events);
      const bytes = enc.encodeFor({ baselines, ackInputTick: game.tick - 1, inputBufferHealth: 2, local: a, view: null });
      const fullBytesNow = full.encodeFor({ baselines: null, ackInputTick: game.tick - 1, inputBufferHealth: 2, local: a, view: null });
      truth.set(seq, decodeMessage(fullBytesNow) as SnapshotMsg);
      deltaBytes += bytes.length;
      fullBytes += fullBytesNow.length;
      // 10 % loss; the rest arrives 5 snapshots (~150 ms) later and is acked on arrival
      if (rand() >= 0.1) delivered.push({ at: seq + 5, bytes });
      while (delivered.length && delivered[0]!.at <= seq) {
        const got = decoder.decode(delivered.shift()!.bytes);
        baselines.ack(got.seq);
        if (got.baselineSeq !== 0) deltas++;
        const want = truth.get(got.seq)!;
        expect(got.players).toEqual(want.players);
        expect(describeLocalDiff(got.local!, want.local!)).toBe('');
        expect(got.events).toEqual(want.events);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(750);
    expect(deltas).toBeGreaterThan(700);
    expect(deltaBytes / fullBytes).toBeLessThan(0.6);

    // decoding a delta stream must equal decoding the full snapshot of the same tick
    const dec2 = new SnapshotDecoder();
    const bl2 = new SnapshotBaselines();
    for (let t = 0; t < 200; t++) {
      inputs[a.id] = { ...createInput(), buttons: t % 50 < 25 ? Btn.Right : Btn.Left | Btn.Jet, aim: (t * 501) & 0xffff };
      game.step(inputs);
      seq++;
      enc.begin(game, seq, []);
      full.begin(game, seq, []);
      const got = dec2.decode(enc.encodeFor({ baselines: bl2, ackInputTick: 1, inputBufferHealth: 0, local: b, view: null }));
      bl2.ack(got.seq);
      const truth = decodeMessage(full.encodeFor({ baselines: null, ackInputTick: 1, inputBufferHealth: 0, local: b, view: null })) as SnapshotMsg;
      expect(got.players).toEqual(truth.players);
      expect(describeLocalDiff(got.local!, truth.local!)).toBe('');
    }
  });

  it('a delta whose baseline the client lacks is refused (and decodeMessage only takes full snapshots)', () => {
    const game = new Game({ seed: 2, dummies: true });
    const me = game.addPlayer('me');
    game.step([]);
    const enc = new SnapshotEncoder();
    const baselines = new SnapshotBaselines();
    enc.begin(game, 1, []);
    const first = enc.encodeFor({ baselines, ackInputTick: 0, inputBufferHealth: 0, local: me, view: null });
    baselines.ack(1); // claims to have decoded #1, but this decoder never saw it
    game.step([]);
    enc.begin(game, 2, []);
    const delta = enc.encodeFor({ baselines, ackInputTick: 0, inputBufferHealth: 0, local: me, view: null });
    expect(() => new SnapshotDecoder().decode(delta)).toThrow(/missing baseline 1/);
    expect(() => decodeMessage(delta)).toThrow(DecodeError);
    const dec = new SnapshotDecoder();
    dec.decode(first);
    expect(dec.decode(delta).baselineSeq).toBe(1);
    expect(delta.length).toBeLessThan(first.length / 3);
  });

  it('AOI: players and grenades outside the view are not sent; gunfire there arrives as coarse SOUND', () => {
    const game = new Game({ seed: 2, dummies: true });
    const me = game.addPlayer('me');
    const far = game.addPlayer('far');
    me.x = 10;
    far.x = 120;
    me.y = far.y = 0;
    const view: ViewRect = { minX: -20, minY: -10, maxX: 40, maxY: 30 };
    const inputs: ReturnType<typeof createInput>[] = [];
    inputs[far.id] = { ...createInput(), buttons: Btn.Fire };
    game.step(inputs);
    const enc = new SnapshotEncoder();
    const baselines = new SnapshotBaselines();
    const dec = new SnapshotDecoder();
    enc.begin(game, 1, game.events);
    const snap = dec.decode(enc.encodeFor({ baselines, ackInputTick: 0, inputBufferHealth: 0, local: me, view }));
    const ids = snap.players.map((p) => p.id);
    expect(ids).toContain(me.id);
    expect(ids).not.toContain(far.id);
    expect(ids.every((id) => game.players[id]!.x <= 40)).toBe(true);
    const sounds = snap.events.filter((e) => e.type === 'sound');
    expect(snap.events.some((e) => e.type === 'shot')).toBe(false);
    expect(sounds).toHaveLength(1);
    expect(sounds[0]).toMatchObject({ kind: 'shot', source: far.weapons[far.active]!.def });
    expect(Math.abs((sounds[0] as { x: number }).x - far.x)).toBeLessThanOrEqual(4);
    // the far player walks into view: it arrives as a full record on top of the baseline
    baselines.ack(1);
    far.x = 30;
    game.step([]);
    enc.begin(game, 2, []);
    const next = dec.decode(enc.encodeFor({ baselines, ackInputTick: 0, inputBufferHealth: 0, local: me, view }));
    expect(next.players.find((p) => p.id === far.id)?.x).toBe(far.x);
    // and leaves again: removed
    baselines.ack(2);
    far.x = 100;
    game.step([]);
    enc.begin(game, 3, []);
    const gone = dec.decode(enc.encodeFor({ baselines, ackInputTick: 0, inputBufferHealth: 0, local: me, view }));
    expect(gone.players.some((p) => p.id === far.id)).toBe(false);
  });

  it('AOI: no tracer, tracer end or HIT locates or names a culled player', () => {
    const game = new Game({ seed: 2, dummies: false });
    const obs = game.addPlayer('obs');
    const a = game.addPlayer('a');
    const b = game.addPlayer('b');
    const c = game.addPlayer('c');
    const d = game.addPlayer('d');
    obs.x = 10;
    a.x = 20;
    b.x = 66; // well outside the view
    c.x = 60.3; // feet just outside: culled, though its muzzle reaches into the rect
    d.x = 60.25; // feet just outside, body inside the rect
    obs.y = a.y = b.y = c.y = d.y = 15;
    const view: ViewRect = { minX: -20, minY: 0, maxX: 60, maxY: 40 };
    const weapon = a.weapons[a.active]!.def;
    const shot = (shooter: number, ox: number, ex: number, hit: 0 | 1 | 2, target: number): SimEvent => ({
      type: 'shot',
      shooter,
      weapon,
      ox,
      oy: 15.5,
      ex,
      ey: 15.5,
      hit,
      target,
      zone: target >= 0 ? 2 : 0,
    });
    const hit = (attacker: number, target: number): SimEvent => ({ type: 'hit', attacker, target, damage: 20, zone: 2, source: weapon });
    const enc = new SnapshotEncoder();
    enc.begin(game, 1, [
      shot(b.id, 65.5, 20.2, 2, a.id), // from a culled shooter
      shot(c.id, 59.83, 20.2, 2, a.id), // from a culled shooter whose muzzle is in the rect
      shot(a.id, 20.5, 65.8, 2, b.id), // into a culled target beyond the view
      shot(a.id, 20.5, 59.95, 2, d.id), // into a culled target's body inside the rect
      shot(a.id, 20.5, 40, 1, -1), // all in view
      hit(b.id, a.id), // a culled attacker, seen by obs through its visible victim
      hit(b.id, obs.id), // obs is the victim: it learns who
    ]);
    const snap = new SnapshotDecoder().decode(enc.encodeFor({ baselines: null, ackInputTick: 0, inputBufferHealth: 0, local: obs, view }));
    expect(snap.players.map((p) => p.id).sort()).toEqual([obs.id, a.id].sort());
    // culled shooters: only the coarse SOUND, however close to the edge they stand
    const sounds = snap.events.filter((e) => e.type === 'sound');
    expect(sounds).toHaveLength(2);
    const shots = snap.events.filter((e) => e.type === 'shot');
    expect(shots.every((e) => e.shooter === a.id)).toBe(true);
    expect(shots).toHaveLength(3);
    const [intoDark, intoSliver, inside] = shots;
    // into a culled target: no id, stopped a body's reach short of the edge, and read as a miss
    for (const e of [intoDark!, intoSliver!]) {
      expect(e).toMatchObject({ hit: 0, target: -1, zone: 0 });
      expect(e.ox).toBeCloseTo(20.5, 2);
      expect(e.ex).toBeLessThan(60 - 1.48); // the top of a standing head
      expect(e.ex).toBeGreaterThan(55);
    }
    expect(inside).toMatchObject({ hit: 1, target: -1 });
    expect(inside!.ex).toBeCloseTo(40, 2);
    const hits = snap.events.filter((e) => e.type === 'hit');
    expect(hits).toEqual([expect.objectContaining({ attacker: -1, target: a.id }), expect.objectContaining({ attacker: b.id, target: obs.id })]);
  });

  it('CONTENT_HASH covers tuning, weapons, grenades, hitboxes and maps, not key order', () => {
    expect(CONTENT_HASH).toBe(contentHashOf(HASHED_CONTENT));
    const changed = (edit: (c: Mutable) => void) => {
      const copy = JSON.parse(JSON.stringify(HASHED_CONTENT)) as Mutable;
      edit(copy);
      return contentHashOf(copy);
    };
    type Mutable = {
      tuning: Record<string, number>;
      weapons: { damage: number }[];
      grenades: { fuse: number }[];
      hitboxes: { standing: { head: { r: number } } };
      maps: Record<string, { solids: { points: number[] }[] }>;
    };
    expect(changed(() => {})).toBe(CONTENT_HASH);
    expect(changed((c) => (c.tuning.walkMax! += 0.5))).not.toBe(CONTENT_HASH);
    expect(changed((c) => (c.weapons[0]!.damage += 1))).not.toBe(CONTENT_HASH);
    expect(changed((c) => (c.grenades[0]!.fuse += 0.1))).not.toBe(CONTENT_HASH);
    expect(changed((c) => (c.hitboxes.standing.head.r += 0.01))).not.toBe(CONTENT_HASH);
    expect(changed((c) => (Object.values(c.maps)[0]!.solids[0]!.points[0]! += 0.5))).not.toBe(CONTENT_HASH);
    // key order and undefined fields don't matter
    expect(contentHashOf({ a: 1, b: [2, { c: 3, d: undefined }] })).toBe(contentHashOf({ b: [2, { c: 3 }], a: 1 }));
    // what JSON would silently flatten is refused, not hashed as null or {}
    for (const bad of [{ a: Number.NaN }, { a: Infinity }, { m: new Map([[1, 2]]) }, { s: new Set([1]) }, { f: () => 1 }, [undefined], { t: new Float32Array(2) }]) {
      expect(() => contentHashOf(bad)).toThrow(/content hash/);
    }
    expect(contentHashOf({ a: null })).not.toBe(contentHashOf({ a: 0 }));
  });

  it('AOI: a hidden attacker\'s damage is whole HP, hidden throwers go unnamed, and a shot into the dark always reads as a miss', () => {
    const game = new Game({ seed: 2, dummies: false });
    const obs = game.addPlayer('obs');
    const a = game.addPlayer('a');
    const b = game.addPlayer('b');
    const c = game.addPlayer('c');
    obs.x = 10;
    a.x = 20;
    b.x = 66; // culled
    c.x = 59.5; // visible, in the off-screen margin near the edge
    obs.y = a.y = b.y = c.y = 15;
    const view: ViewRect = { minX: -20, minY: 0, maxX: 60, maxY: 40 };
    // b's grenade in view, and a blast of b's in view
    const g = game.grenades[0]!;
    Object.assign(g, { alive: true, owner: b.id, x: 30, y: 16, vx: -3, vy: 2, fuse: 40 });
    const mine = game.grenades[1]!;
    Object.assign(mine, { alive: true, owner: obs.id, x: 12, y: 16, vx: 0, vy: 0, fuse: 40 });
    const weapon = a.weapons[a.active]!.def;
    const events: SimEvent[] = [
      { type: 'hit', attacker: b.id, target: a.id, damage: 20.4375, zone: 2, source: weapon },
      { type: 'hit', attacker: c.id, target: a.id, damage: 20.4375, zone: 2, source: weapon }, // c is seen: exact
      { type: 'explosion', x: 25, y: 15, radius: 4, owner: b.id },
      // c, in the margin, hits b just past the edge: nothing of the tracer is inside the shrunk view
      { type: 'shot', shooter: c.id, weapon, ox: 59.8, oy: 15.5, ex: 65.8, ey: 15.5, hit: 2, target: b.id, zone: 2 },
      // a hits b's old (rewound) pose deep inside the view: still a miss with no target
      { type: 'shot', shooter: a.id, weapon, ox: 20.5, oy: 15.5, ex: 40, ey: 15.5, hit: 2, target: b.id, zone: 2 },
    ];
    const enc = new SnapshotEncoder();
    enc.begin(game, 1, events);
    const snap = new SnapshotDecoder().decode(enc.encodeFor({ baselines: null, ackInputTick: 0, inputBufferHealth: 0, local: obs, view }));
    const hits = snap.events.filter((e) => e.type === 'hit');
    expect(hits).toEqual([
      expect.objectContaining({ attacker: -1, damage: 20 }),
      expect.objectContaining({ attacker: c.id, damage: 20.4375 }),
    ]);
    expect(snap.events.find((e) => e.type === 'explosion')).toMatchObject({ owner: -1 });
    expect(snap.grenades.find((x) => x.id === g.id)?.owner).toBe(-1);
    expect(snap.grenades.find((x) => x.id === mine.id)?.owner).toBe(obs.id);
    const shots = snap.events.filter((e) => e.type === 'shot');
    expect(shots).toHaveLength(2);
    expect(shots[0]).toMatchObject({ shooter: c.id, hit: 0, target: -1, zone: 0 });
    expect(shots[0]!.ex).toBeCloseTo(shots[0]!.ox, 6); // zero length, at the visible muzzle
    expect(shots[1]).toMatchObject({ shooter: a.id, hit: 0, target: -1, zone: 0 });
    expect(shots[1]!.ex).toBeCloseTo(40, 2);
  });

  it('never throws anything but DecodeError on garbage (fuzz)', () => {
    const packet = createInputPacket();
    const rand = rng(42);
    for (let i = 0; i < 5000; i++) {
      const len = Math.floor(rand() * 64);
      const bytes = new Uint8Array(len);
      for (let k = 0; k < len; k++) bytes[k] = Math.floor(rand() * 256);
      if (len > 0) bytes[0] = [0x01, 0x02, 0x03, 0x04, 0x10, 0x11, 0x21, 0x25, 0x26, 0x30, 0x3f][Math.floor(rand() * 11)]!;
      try {
        decodeMessage(bytes);
      } catch (e) {
        expect(e).toBeInstanceOf(DecodeError);
      }
      try {
        decodeInputInto(bytes, packet);
      } catch (e) {
        expect(e).toBeInstanceOf(DecodeError);
      }
    }
  });
});

describe('local-player block', () => {
  /** Plays a busy sequence (walk, jet, crouch, fire both guns, reload, swap, dual, throw) and checks every tick. */
  it('capture → wire → apply → capture is exact on every tick', () => {
    const game = new Game({ seed: 5, dummies: true });
    const me = game.addPlayer('me');
    const inputs: ReturnType<typeof createInput>[] = [];
    const enc = new SnapshotEncoder();
    const ghost = new PlayerState(me.id);
    const script = [Btn.Right, Btn.Right | Btn.Jet, Btn.Jet | Btn.Fire, Btn.Left | Btn.Fire, Btn.Down, Btn.Reload, Btn.Swap, Btn.Fire, Btn.Dual, Btn.Fire, Btn.Grenade, 0];
    for (let t = 0; t < 900; t++) {
      inputs[me.id] = { ...createInput(), buttons: script[Math.floor(t / 20) % script.length]!, aim: (t * 311) & 0xffff };
      game.step(inputs);
      enc.begin(game, t + 1, game.events);
      const snap = decodeMessage(enc.encodeFor({ baselines: null, ackInputTick: t & 0xffff, inputBufferHealth: 1, local: me, view: null })) as SnapshotMsg;
      const server = captureLocalState(me, createLocalState());
      expect(describeLocalDiff(snap.local!, server)).toBe('');
      applyLocalState(snap.local!, ghost);
      expect(describeLocalDiff(captureLocalState(ghost, createLocalState()), server)).toBe('');
    }
    expect(me.shotCounter).toBeGreaterThan(10);
  });

  it('round-trips arsenal state (pellets, melee swings, the Machete), full and delta, on every tick', () => {
    const game = new Game({ seed: 6, dummies: true });
    const me = game.addPlayer('me');
    game.setLoadout(me, [BREACHER.index, MACHETE.index]);
    const inputs: ReturnType<typeof createInput>[] = [];
    const enc = new SnapshotEncoder();
    const baselines = new SnapshotBaselines();
    const decoder = new SnapshotDecoder();
    const ghost = new PlayerState(me.id);
    const script = [Btn.Right | Btn.Melee, Btn.Fire, Btn.Jet | Btn.Fire, Btn.Melee, Btn.Swap, Btn.Fire, Btn.Left, 0];
    let swingTicks = 0;
    let deltas = 0;
    for (let t = 0; t < 600; t++) {
      inputs[me.id] = { ...createInput(), buttons: script[Math.floor(t / 13) % script.length]!, aim: (t * 523) & 0xffff };
      game.step(inputs);
      if (me.meleeTicks > 0) swingTicks++;
      enc.begin(game, t + 1, game.events);
      const server = captureLocalState(me, createLocalState());
      const snap = decodeMessage(enc.encodeFor({ baselines: null, ackInputTick: t & 0xffff, inputBufferHealth: 1, local: me, view: null })) as SnapshotMsg;
      expect(describeLocalDiff(snap.local!, server)).toBe('');
      applyLocalState(snap.local!, ghost);
      expect(describeLocalDiff(captureLocalState(ghost, createLocalState()), server)).toBe('');
      expect(ghost.meleeTicks).toBe(me.meleeTicks);
      // the delta encoder sends the melee group only when the swing timer changed
      const got = decoder.decode(enc.encodeFor({ baselines, ackInputTick: t & 0xffff, inputBufferHealth: 1, local: me, view: null }));
      baselines.ack(got.seq);
      if (got.baselineSeq !== 0) deltas++;
      expect(describeLocalDiff(got.local!, server)).toBe('');
    }
    expect(swingTicks).toBeGreaterThan(60);
    expect(deltas).toBeGreaterThan(500);
  });

  it('CONTENT_HASH covers the arsenal weapons', () => {
    const edited = (i: number, edit: (w: Record<string, unknown>) => void) => {
      const copy = JSON.parse(JSON.stringify(HASHED_CONTENT)) as { weapons: Record<string, unknown>[] };
      edit(copy.weapons[i]!);
      return contentHashOf(copy);
    };
    expect(edited(BREACHER.index, (w) => (w.pellets = (w.pellets as number) + 1))).not.toBe(CONTENT_HASH);
    expect(edited(WIDOW.index, (w) => (w.moveSpeedMul = (w.moveSpeedMul as number) + 0.01))).not.toBe(CONTENT_HASH);
    expect(edited(MACHETE.index, (w) => (w.meleeDamage = (w.meleeDamage as number) + 1))).not.toBe(CONTENT_HASH);
  });

  it('fits in the docs/05 §6.2 budget order of magnitude', () => {
    expect(LOCAL_STATE_MAX_BITS / 8).toBeLessThan(64);
  });
});
