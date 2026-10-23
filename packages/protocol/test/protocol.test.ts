import { BLADE, BREACHER, DEFAULT_COSMETIC_LOADOUT, FRAG, GAS, GRENADE_TYPES, MACHETE, MAX_LOOK_IDS, PROJECTILE_TYPE_BASE, RIPPER, ROCKET, SHREDDER, SMOKE, TRIDENT, WIDOW, cosmeticLoadoutFromWireIds, cosmeticLoadoutWireIds } from '@military-forge/content';
import { Btn, Game, PlayerState, createInput, spawnCloud, type SimEvent } from '@military-forge/sim';
import type { MapDef } from '@military-forge/content';
import { describe, expect, it } from 'vitest';
import {
  BitReader,
  BitWriter,
  CONTENT_HASH,
  HASHED_CONTENT,
  contentHashOf,
  DecodeError,
  LOCAL_STATE_FIELDS,
  LOCAL_STATE_MAX_BITS,
  LS,
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
  encodeOverrides,
  encodeTuning,
  encodeWelcome,
  decodeFullSnapshot,
  isUnreliableMessage,
  localStatesEqual,
  CmdKind,
  MIN_PROTOCOL_VERSION,
  encodeLookCmd,
  parseLookCmd,
  protocolSupported,
  type HelloMsg,
  type RosterMsg,
  type SnapshotMsg,
  type ViewRect,
  CloseCode,
  HelloFlag,
  MAX_SPECTATORS,
  SPECTATOR_VOICE_BASE,
  SpectateMode,
  SpectateQueue,
  encodeSpectate,
  encodeSpectateAck,
  encodeSpectateCmd,
  parseSpectateCmd,
  spectatorRing,
  type SpectateMsg,
  type WelcomeMsg,
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
    expect(decodeMessage(encodeHello('Ade'))).toEqual({ type: MsgType.Hello, protocolVersion: PROTOCOL_VERSION, contentHash: CONTENT_HASH, name: 'Ade', resumeToken: '', ticket: '', look: null, spectate: false });
    expect(decodeMessage(encodeHello('Ade', 'tok-123'))).toMatchObject({ name: 'Ade', resumeToken: 'tok-123', ticket: '' });
    // a join ticket (a JWT: longer than a u8-length string) follows the token
    const ticket = `eyJhbGciOiJFZERTQSJ9.${'x'.repeat(400)}.sig`;
    expect(decodeMessage(encodeHello('Ade', '', ticket))).toMatchObject({ name: 'Ade', resumeToken: '', ticket });
    // a HELLO without the trailing token (older client / minimal tools) still decodes
    const bare = encodeHello('Kemi');
    expect(decodeMessage(bare.subarray(0, bare.length - 1))).toMatchObject({ name: 'Kemi', resumeToken: '' });
    const welcome = { playerId: 4, seed: 123456789, serverTick: 99, mapId: 'movement-test', tuningJson: '{"gravity":20}', sessionToken: 'abc_DEF-123', resumed: true, overridesJson: '{"weapon.k47.damage":14}' };
    expect(decodeMessage(encodeWelcome(welcome))).toEqual({ type: MsgType.Welcome, ...welcome, spectator: false, delayTicks: 0 });
    expect(decodeMessage(encodePing(1234.5))).toEqual({ type: MsgType.Ping, clientTime: 1234.5 });
    expect(decodeMessage(encodePong(1234.5, 77))).toEqual({ type: MsgType.Pong, clientTime: 1234.5, serverTick: 77 });
    expect(decodeMessage(encodeCmd(1, '{"a":1}'))).toEqual({ type: MsgType.Cmd, kind: 1, payload: '{"a":1}' });
    const entries = [
      { id: 0, name: 'Strafer', isBot: true, since: 1 },
      { id: 4, name: 'Kemi', isBot: false, since: 4_000_000_000 },
    ];
    expect(decodeMessage(encodeRoster(entries))).toEqual({ type: MsgType.Roster, entries: entries.map((e) => ({ ...e, look: null })) });
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

  it('input packets carry up to 4 redundant inputs in 14–32 bytes, each with its render lag', () => {
    const inputs = [0, 1, 2, 3].map((i) => ({ ...createInput(), buttons: Btn.Right | (i % 2 ? Btn.Fire : 0), aim: 1000 * i }));
    const renderLags = [0, 0.0625, 4.5, 15.9375];
    const sizes = [1, 2, 3, 4].map((n) => encodeInput({ newestTick: 1, ackSnapshotSeq: 0, renderTick: 0, renderFrac: 0, inputs: inputs.slice(0, n) }).length);
    expect(sizes).toEqual([14, 20, 26, 32]); // v14: + u3 dashStrength each
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

  it('map events (v8) reach every client in full, whatever its view', () => {
    const game = new Game({ mapId: 'mechanics-test', seed: 4 });
    const me = game.addPlayer('me');
    const events: SimEvent[] = [];
    while (game.tick < 60 * 40) {
      game.step([]);
      events.push(...game.events);
    }
    const sent = events.filter((e) => e.type === 'mapEvent');
    expect(sent.length).toBeGreaterThan(12); // the timeline's warnings, starts and ends so far
    const far: ViewRect = { minX: 1000, minY: 1000, maxX: 1010, maxY: 1010 };
    const snap = decodeMessage(encodeSnapshot(game, 3, events, { local: me, view: far })) as SnapshotMsg;
    expect(snap.events.filter((e) => e.type === 'mapEvent')).toEqual(sent);
    const pocket = sent.find((e) => e.type === 'mapEvent' && e.zone >= 0);
    expect(pocket).toBeDefined(); // the pocket's picked zone survives the trip, and -1 (all) does too
    expect(PROTOCOL_VERSION).toBeGreaterThanOrEqual(8); // MAP_EVENT since v8
  });

  it('CONTENT_HASH covers tuning, weapons, grenades, hitboxes, maps, zone/event defaults and pickups, not key order', () => {
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
      zoneDefaults: Record<string, { gravityMul?: number }>;
      eventDefaults: Record<string, { duration?: number }>;
      pickups: { shield: { hp: number }; pools: Record<string, { items: { weight: number }[] }> };
    };
    expect(changed(() => {})).toBe(CONTENT_HASH);
    expect(changed((c) => (c.tuning.walkMax! += 0.5))).not.toBe(CONTENT_HASH);
    expect(changed((c) => (c.weapons[0]!.damage += 1))).not.toBe(CONTENT_HASH);
    expect(changed((c) => (c.grenades[0]!.fuse += 0.1))).not.toBe(CONTENT_HASH);
    expect(changed((c) => (c.hitboxes.standing.head.r += 0.01))).not.toBe(CONTENT_HASH);
    expect(changed((c) => (Object.values(c.maps)[0]!.solids[0]!.points[0]! += 0.5))).not.toBe(CONTENT_HASH);
    expect(changed((c) => (c.zoneDefaults.lowG!.gravityMul! += 0.05))).not.toBe(CONTENT_HASH);
    expect(changed((c) => (c.eventDefaults.emp!.duration! += 1))).not.toBe(CONTENT_HASH);
    expect(changed((c) => (c.pickups.shield.hp += 1))).not.toBe(CONTENT_HASH);
    expect(changed((c) => (c.pickups.pools.shield!.items[0]!.weight += 1))).not.toBe(CONTENT_HASH);
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

  it('round-trips dash state (burst, direction, gap, chain, window, strength), full and delta, on every tick', () => {
    const game = new Game({ seed: 7 });
    const me = game.addPlayer('me');
    const inputs: ReturnType<typeof createInput>[] = [];
    const enc = new SnapshotEncoder();
    const baselines = new SnapshotBaselines();
    const decoder = new SnapshotDecoder();
    const ghost = new PlayerState(me.id);
    // dash right, up-left, then jet and dash again in the air, down-dash, presses inside the gap,
    // chains (a press every 12 ticks is inside the window), every strength, and an empty tank
    const script = [Btn.Dash | Btn.Right, Btn.Right, Btn.Dash | Btn.Jet | Btn.Left, Btn.Jet, Btn.Jet, Btn.Dash | Btn.Right, Btn.Dash | Btn.Down, 0, Btn.Dash, 0];
    let burstTicks = 0;
    let chained = 0;
    for (let t = 0; t < 900; t++) {
      const k = Math.floor(t / 12);
      inputs[me.id] = { ...createInput(), buttons: script[k % script.length]! & (t % 12 < 2 ? ~0 : ~Btn.Dash), dashStrength: k % 8 };
      game.step(inputs);
      if (me.dashTicks > 0) burstTicks++;
      if (game.events.some((e) => e.type === 'dash' && (e.chain ?? 0) > 0)) chained++;
      enc.begin(game, t + 1, game.events);
      const server = captureLocalState(me, createLocalState());
      const snap = decodeMessage(enc.encodeFor({ baselines: null, ackInputTick: t & 0xffff, inputBufferHealth: 1, local: me, view: null })) as SnapshotMsg;
      expect(describeLocalDiff(snap.local!, server)).toBe('');
      applyLocalState(snap.local!, ghost);
      expect(describeLocalDiff(captureLocalState(ghost, createLocalState()), server)).toBe('');
      const got = decoder.decode(enc.encodeFor({ baselines, ackInputTick: t & 0xffff, inputBufferHealth: 1, local: me, view: null }));
      baselines.ack(got.seq);
      expect(describeLocalDiff(got.local!, server)).toBe('');
    }
    expect(burstTicks).toBeGreaterThan(60);
    expect(chained).toBeGreaterThan(2);
  });

  it('dashes reach other clients that can see the dasher, never the dasher itself; remotes carry a dashing flag', () => {
    const game = new Game({ seed: 8 });
    const a = game.addPlayer('a');
    const b = game.addPlayer('b');
    a.spawn(20, 0, game.tuning);
    b.spawn(30, 0, game.tuning);
    const inputs: ReturnType<typeof createInput>[] = [];
    for (let t = 0; t < 5; t++) game.step(inputs);
    inputs[a.id] = { ...createInput(), buttons: Btn.Dash | Btn.Jet | Btn.Right };
    game.step(inputs);
    const dash = game.events.find((e) => e.type === 'dash')!;
    expect(dash).toMatchObject({ player: a.id, dir: 1 });
    const near: ViewRect = { minX: 0, minY: -10, maxX: 50, maxY: 20 };
    const far: ViewRect = { minX: 500, minY: -10, maxX: 550, maxY: 20 };
    const enc = new SnapshotEncoder();
    enc.begin(game, 1, game.events);
    const forB = decodeFullSnapshot(enc.encodeFor({ baselines: null, ackInputTick: 0, inputBufferHealth: 1, local: b, view: near }));
    expect(forB.events.filter((e) => e.type === 'dash')).toEqual([dash]);
    expect(forB.players.find((p) => p.id === a.id)!.dashing).toBe(true);
    expect(forB.players.find((p) => p.id === b.id)!.dashing).toBe(false);
    const forA = decodeFullSnapshot(enc.encodeFor({ baselines: null, ackInputTick: 0, inputBufferHealth: 1, local: a, view: near }));
    expect(forA.events.some((e) => e.type === 'dash')).toBe(false); // drawn from its own prediction
    const blind = decodeFullSnapshot(enc.encodeFor({ baselines: null, ackInputTick: 0, inputBufferHealth: 1, local: b, view: far }));
    expect(blind.events.some((e) => e.type === 'dash')).toBe(false);
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
    // ~67 bytes in full since v10 (the grenade belt and status groups after the shield's); a full
    // block only goes out on joining or after loss, deltas carry the groups that changed
    expect(LOCAL_STATE_MAX_BITS / 8).toBeLessThan(72);
  });
});

describe('grenade variety (v10)', () => {
  it('takes the v10 slots from the protocol registry: after the shield, nothing before it moved', () => {
    expect(PROTOCOL_VERSION).toBeGreaterThanOrEqual(10); // v11 (more guns) appends after these
    expect([LS.shieldTicks, LS.grenadeType, LS.grenades, LS.blindTicks, LS.blindFade, LS.gasTicks, LS.jetDisabledTicks]).toEqual([47, 48, 49, 54, 55, 56, 57]);
    // the clouds section after the pickups section: an item and a cloud in the same snapshot
    const game = new Game({ seed: 2, dummies: false, pickups: true });
    const me = game.addPlayer('me');
    Object.assign(me, { x: 150, y: 0 });
    const k = game.pickups[0]!;
    Object.assign(k, { alive: true, def: 3, x: 152, y: 0, spawner: -1, spot: -1 });
    const c = spawnCloud(game, GAS.index, 155, 0, me.id)!;
    c.age = 77;
    const events: SimEvent[] = [{ type: 'explosion', x: 151, y: 1, radius: 4, owner: me.id, grenade: GAS.index }];
    const snap = decodeMessage(encodeSnapshot(game, 1, events, { local: me })) as SnapshotMsg;
    expect(snap.pickups).toEqual([{ id: k.id, def: 3, x: 152, y: 0 }]);
    expect(snap.clouds).toEqual([{ id: c.id, type: GAS.index, x: c.x, y: c.y, age: 77 }]);
    expect(snap.events).toEqual(events);
  });

  it('grenade types, mine state, clouds and what went off round-trip; clouds out of view stay home', () => {
    const game = new Game({ seed: 4, dummies: false });
    const me = game.addPlayer('me');
    me.x = 10;
    me.y = 0;
    const g = game.allocGrenade()!;
    Object.assign(g, { alive: true, owner: me.id, x: 12, y: 1, vx: 3, vy: 2, fuse: 50, type: GAS.index, state: 3 });
    const near = spawnCloud(game, SMOKE.index, 20, 0, me.id)!;
    const far = spawnCloud(game, GAS.index, 140, 0, me.id)!;
    near.age = 37;
    far.age = 899;
    const events: SimEvent[] = [{ type: 'explosion', x: 12, y: 1, radius: 4, owner: me.id, grenade: GAS.index }];
    const snap = decodeMessage(encodeSnapshot(game, 1, events, { local: me })) as SnapshotMsg;
    expect(snap.grenades).toEqual([expect.objectContaining({ id: g.id, type: GAS.index, state: 3, fuse: 50, x: 12, y: 1 })]);
    expect(snap.clouds).toEqual([
      { id: near.id, type: SMOKE.index, x: near.x, y: near.y, age: 37 },
      { id: far.id, type: GAS.index, x: far.x, y: far.y, age: 899 },
    ]);
    expect(snap.events).toEqual([{ type: 'explosion', x: 12, y: 1, radius: 4, owner: me.id, grenade: GAS.index }]);

    const view: ViewRect = { minX: -10, minY: -5, maxX: 60, maxY: 30 };
    const enc = new SnapshotEncoder();
    const culled = () => {
      enc.begin(game, 2, []);
      return new SnapshotDecoder().decode(enc.encodeFor({ baselines: null, ackInputTick: 0, inputBufferHealth: 0, local: me, view })).clouds.map((c) => c.id);
    };
    expect(culled()).toEqual([near.id]);
    far.x = 63; // its edge pokes into the view
    expect(culled()).toEqual([near.id, far.id]);
  });

  describe('AOI anti-wallhack: smoke', () => {
    /** obs on the floor at x 10 looking right; a smoke cloud popped at (30, 0): its core is 3.4 m around (30, 1) */
    function scene(extra: { name: string; x: number; y?: number }[] = [], solids: number[][] = []) {
      // a flat floor at y = 0 from x −2 to 80
      const map: MapDef = {
        id: 'smoke-aoi',
        name: 'smoke',
        bounds: { minX: -2, minY: -6, maxX: 80, maxY: 40 },
        solids: [{ points: [-2, -6, 80, -6, 80, 0, -2, 0] }, ...solids.map((points) => ({ points }))],
        oneWays: [],
        spawns: [{ x: 5, y: 0 }, { x: 60, y: 0 }],
        dummies: [],
        labels: [],
      };
      const game = new Game({ map, seed: 9, dummies: false });
      const obs = game.addPlayer('obs');
      Object.assign(obs, { x: 10, y: 0 });
      const others = Object.fromEntries(
        extra.map((e) => {
          const p = game.addPlayer(e.name);
          Object.assign(p, { x: e.x, y: e.y ?? 0 });
          return [e.name, p];
        }),
      );
      const cloud = spawnCloud(game, SMOKE.index, 30, 0, obs.id)!;
      cloud.age = 120;
      const view: ViewRect = { minX: -20, minY: -10, maxX: 70, maxY: 40 };
      const enc = new SnapshotEncoder();
      const sees = (viewer: PlayerState, events: SimEvent[] = []) => {
        enc.begin(game, 1, events);
        return new SnapshotDecoder().decode(enc.encodeFor({ baselines: null, ackInputTick: 0, inputBufferHealth: 0, local: viewer, view }));
      };
      const ids = (viewer: PlayerState) => sees(viewer).players.map((p) => p.id);
      return { game, obs, others, cloud, sees, ids };
    }

    it('hides players inside it and behind it, not beside or above it', () => {
      const { obs, others, ids } = scene([
        { name: 'inside', x: 30 },
        { name: 'behind', x: 37 }, // past the cloud: every sight line runs through it
        { name: 'front', x: 26.2 }, // just short of it
        { name: 'above', x: 37, y: 8 }, // the sight line passes over it
      ]);
      expect(ids(obs)).toEqual([obs.id, others.front!.id, others.above!.id]);
    });

    it('inside a cloud you see who is next to you, not across it; from deep inside you can\'t see out, from its edge you can', () => {
      const { obs, others, ids } = scene([
        { name: 'deep', x: 30 },
        { name: 'deep2', x: 31.2 }, // 1.2 m away in the same smoke
        { name: 'rim', x: 27.1 }, // eyes 0.5 m inside the core's edge, 2.9 m from deep
      ]);
      // obs is out there behind 3 m of smoke; rim is in the same cloud but across 2.9 m of it
      expect(ids(others.deep!)).toEqual([others.deep!.id, others.deep2!.id]);
      // head in the rim, body half out: it sees out, but not into the cloud (review M1)
      expect(ids(others.rim!)).toContain(obs.id);
      expect(ids(others.rim!)).not.toContain(others.deep!.id);
      // one-way at the rim: obs can't see rim back (all of it is in the core)
      expect(ids(obs)).not.toContain(others.rim!.id);
    });

    it('a wall between the smoke and the sight line: the smoke there does not count', () => {
      const slab = [23, 2, 37, 2, 37, 2.2, 23, 2.2]; // a slab through the cloud, above its centre
      const over = scene([{ name: 'right', x: 36.5, y: 2.2 }], [slab]);
      Object.assign(over.obs, { x: 23.5, y: 2.2 }); // both stand on it: every sight line is above the slab
      expect(over.ids(over.obs)).toContain(over.others.right!.id);
      // the same sight lines with no slab run through the smoke
      const open = scene([{ name: 'right', x: 36.5, y: 2.2 }]);
      Object.assign(open.obs, { x: 23.5, y: 2.2 });
      expect(open.ids(open.obs)).not.toContain(open.others.right!.id);
    });

    it('a thinning cloud stops hiding', () => {
      const { obs, others, cloud, ids } = scene([{ name: 'behind', x: 37 }]);
      expect(ids(obs)).not.toContain(others.behind!.id);
      cloud.age = 60 * SMOKE.cloud.duration - 20;
      expect(ids(obs)).toContain(others.behind!.id);
    });

    it('events don\'t give a hidden player away (the rules for culled players)', () => {
      const { game, obs, others, sees } = scene([
        { name: 'hidden', x: 37 },
        { name: 'third', x: 12 },
      ]);
      const weapon = obs.weapons[0]!.def;
      const h = others.hidden!;
      const third = others.third!;
      // a grenade it threw, now flying in plain view
      const g = game.allocGrenade()!;
      Object.assign(g, { alive: true, owner: h.id, x: 20, y: 2, vx: -8, vy: 3, fuse: 40 });
      const snap = sees(obs, [
        // the hidden player fires out of the smoke at obs: only a sound
        { type: 'shot', shooter: h.id, weapon, ox: 36.5, oy: 1.1, ex: 10, ey: 1.1, hit: 2, target: obs.id, zone: 2 },
        // a visible player's shot into the smoke that hit the hidden one: cut where it enters, a miss
        { type: 'shot', shooter: third.id, weapon, ox: 12.5, oy: 1.1, ex: 37, ey: 1.1, hit: 2, target: h.id, zone: 2 },
        // a visible player's shot into the smoke that hit nothing: cut the same way (no hit/miss tell)
        { type: 'shot', shooter: third.id, weapon, ox: 12.5, oy: 1.1, ex: 45, ey: 1.1, hit: 0, target: -1, zone: 0 },
        { type: 'hit', attacker: third.id, target: h.id, damage: 30, zone: 2, source: weapon }, // a damage number would place it
        { type: 'hit', attacker: h.id, target: obs.id, damage: 20.4375, zone: 2, source: weapon }, // the victim learns who
      ]);
      const shots = snap.events.filter((e) => e.type === 'shot');
      expect(snap.events.filter((e) => e.type === 'sound')).toHaveLength(1);
      expect(shots).toHaveLength(2);
      for (const shot of shots) {
        expect(shot).toMatchObject({ shooter: third.id, hit: 0, target: -1 });
        expect((shot as { ex: number }).ex).toBeCloseTo(30 - 3.4, 0); // where it enters the core
      }
      // the victim learns who, but in whole HP: 1/16 HP and the falloff would give the range (review M3)
      expect(snap.events.filter((e) => e.type === 'hit')).toEqual([expect.objectContaining({ attacker: h.id, target: obs.id, damage: 20 })]);
      expect(snap.grenades.find((x) => x.id === g.id)?.owner).toBe(-1); // without its thrower's name
    });

    it('a hit on a player hidden behind smoke goes on as a miss, so the tracer doesn\'t mark the body (review H2)', () => {
      // `sky` floats over the far side and fires straight down at `behind`: obs sees sky (the sight line
      // passes over the cloud), not behind; the tracer never touches the smoke
      const { obs, others, sees } = scene([
        { name: 'behind', x: 37 },
        { name: 'sky', x: 37, y: 10 },
      ]);
      const weapon = obs.weapons[0]!.def;
      const snap = sees(obs, [{ type: 'shot', shooter: others.sky!.id, weapon, ox: 37, oy: 10.8, ex: 37, ey: 1.2, hit: 2, target: others.behind!.id, zone: 1 }]);
      expect(snap.players.map((p) => p.id)).toEqual([obs.id, others.sky!.id]);
      const shot = snap.events.find((e) => e.type === 'shot') as { ex: number; ey: number; hit: number; target: number };
      // on to the floor under it, a bullet into the ground like any miss
      expect(shot).toMatchObject({ hit: 1, target: -1 });
      expect(shot.ex).toBeCloseTo(37, 3);
      expect(shot.ey).toBeCloseTo(0, 3);
    });

    it('the shooter gets whole HP for a hit on a player smoke hides from it (review M3)', () => {
      const { obs, others, sees } = scene([{ name: 'inside', x: 30 }]);
      const weapon = obs.weapons[0]!.def;
      const snap = sees(obs, [{ type: 'hit', attacker: obs.id, target: others.inside!.id, damage: 30.4375, zone: 2, source: weapon }]);
      expect(snap.events).toEqual([expect.objectContaining({ type: 'hit', attacker: obs.id, target: others.inside!.id, damage: 30 })]);
      // and exact when both sides are in plain sight
      const plain = scene([{ name: 'front', x: 20 }]);
      const exact = plain.sees(plain.obs, [{ type: 'hit', attacker: plain.obs.id, target: plain.others.front!.id, damage: 30.4375, zone: 2, source: weapon }]);
      expect(exact.events).toEqual([expect.objectContaining({ damage: 30.4375 })]);
    });

    it('a blast or an item taken where smoke hides the spot: only a sound, and no pickup (#107 review)', () => {
      const { obs, others, sees } = scene([{ name: 'inside', x: 30 }]);
      const inside = others.inside!;
      const rocket = { type: 'explosion' as const, x: 30, y: 1, radius: 3.5, owner: obs.id, grenade: PROJECTILE_TYPE_BASE + ROCKET.index };
      const open = { ...rocket, x: 20 };
      const taken = { type: 'pickup' as const, player: inside.id, item: 11, x: 30.4, y: 0 };
      const events = sees(obs, [rocket, open, taken]).events;
      expect(events.filter((e) => e.type === 'explosion').map((e) => (e as { x: number }).x)).toEqual([20]);
      expect(events.filter((e) => e.type === 'sound')).toHaveLength(1);
      expect(events.some((e) => e.type === 'pickup')).toBe(false);
      // the one inside sees its own taking and the blast on it
      const own = sees(inside, [rocket, taken]).events;
      expect(own.map((e) => e.type).sort()).toEqual(['explosion', 'pickup']);
    });

    it('grenades in smoke the client can\'t see into, or behind it, aren\'t sent; its own always are (review M2)', () => {
      const { game, obs, others, sees } = scene([
        { name: 'inside', x: 30 },
        { name: 'other', x: 20 },
      ]);
      const at = (owner: number, x: number, y: number) => {
        const g = game.allocGrenade()!;
        Object.assign(g, { alive: true, owner, x, y, vx: 0, vy: 0, fuse: 60, type: FRAG.index });
        return g.id;
      };
      const ids = (viewer: PlayerState) => sees(viewer).grenades.map((g) => g.id).sort((a, b) => a - b);
      const inside = others.inside!;
      const fromSmoke = at(inside.id, 30.4, 1.4); // just thrown in the core: it would point at its thrower
      const behind = at(inside.id, 40, 1); // past the cloud
      const above = at(inside.id, 30, 8); // over it
      const mine = at(obs.id, 31, 1); // ours, in the smoke
      expect(ids(obs)).toEqual([above, mine]);
      // in the cloud: the one by your hand, not one across the smoke (others' grenades)
      const near = at(others.other!.id, 30.8, 1.2);
      const across = at(others.other!.id, 32.8, 1);
      expect(ids(inside)).toEqual(expect.arrayContaining([fromSmoke, behind, near]));
      expect(ids(inside)).not.toContain(across);
    });

    it('ricochets off a hidden player\'s shield aren\'t sent; one into the smoke stops at it; a hidden taking isn\'t sent at all', () => {
      const { obs, others, sees } = scene([
        { name: 'inside', x: 30 },
        { name: 'front', x: 20 },
      ]);
      const weapon = obs.weapons[0]!.def;
      const snap = sees(obs, [
        // off the shield of the player in the smoke: the spark would mark it
        { type: 'ricochet', shooter: others.front!.id, owner: others.inside!.id, weapon, x: 29.6, y: 1, nx: -1, ny: 0, ex: 21, ey: 1, hit: 2, target: others.front!.id, zone: 1 },
        // off a visible shield (front's), back into the smoke and the player in it: cut where it enters
        { type: 'ricochet', shooter: obs.id, owner: others.front!.id, weapon, x: 20.4, y: 1, nx: 1, ny: 0, ex: 29.8, ey: 1, hit: 2, target: others.inside!.id, zone: 1 },
        // the player in the smoke takes an item lying there: nothing (the item stays as obs last saw it, #107 review)
        { type: 'pickup', player: others.inside!.id, item: 0, x: 30, y: 0 },
      ]);
      const r = snap.events.filter((e) => e.type === 'ricochet') as { owner: number; ex: number; hit: number; target: number }[];
      expect(r).toHaveLength(1);
      expect(r[0]).toMatchObject({ owner: others.front!.id, hit: 0, target: -1 });
      expect(r[0]!.ex).toBeCloseTo(30 - 3.4, 0);
      expect(snap.events.some((e) => e.type === 'pickup')).toBe(false);
    });
  });

  it('a client in a flashbang\'s full white is sent nobody else, their gunfire only as sounds, no grenades but its own', () => {
    const game = new Game({ seed: 5, dummies: false });
    const obs = game.addPlayer('obs');
    const other = game.addPlayer('other');
    Object.assign(obs, { x: 150, y: 0 });
    Object.assign(other, { x: 156, y: 0 });
    const g = game.allocGrenade()!;
    Object.assign(g, { alive: true, owner: other.id, x: 153, y: 2, vx: 0, vy: 0, fuse: 60 });
    const own = game.allocGrenade()!;
    Object.assign(own, { alive: true, owner: obs.id, x: 152, y: 2, vx: 0, vy: 0, fuse: 60 });
    const view: ViewRect = { minX: 120, minY: -10, maxX: 190, maxY: 40 };
    const weapon = other.weapons[0]!.def;
    const shot: SimEvent = { type: 'shot', shooter: other.id, weapon, ox: 155.5, oy: 1.2, ex: 150, ey: 1.2, hit: 2, target: obs.id, zone: 2 };
    const sees = () => {
      const enc = new SnapshotEncoder();
      enc.begin(game, 1, [shot]);
      return new SnapshotDecoder().decode(enc.encodeFor({ baselines: null, ackInputTick: 0, inputBufferHealth: 0, local: obs, view }));
    };
    obs.blindTicks = 200; // full white (blindFade 90): blindIntensity 1
    obs.blindFade = 90;
    let snap = sees();
    expect(snap.players.map((p) => p.id)).toEqual([obs.id]);
    expect(snap.events.map((e) => e.type)).toEqual(['sound']);
    expect(snap.grenades.map((x) => x.id)).toEqual([own.id]);
    obs.blindTicks = 45; // fading out: the screen clears by itself, the server sends everything again
    snap = sees();
    expect(snap.players.map((p) => p.id).sort()).toEqual([obs.id, other.id].sort());
    expect(snap.events.map((e) => e.type)).toEqual(['shot']);
    expect(snap.grenades).toHaveLength(2);
  });

  it('round-trips the grenade belt and status timers, full and delta, on every tick', () => {
    const game = new Game({ seed: 8, dummies: true });
    const me = game.addPlayer('me');
    const belt = new Array<number>(GRENADE_TYPES).fill(0);
    belt[FRAG.index] = 1;
    belt[SMOKE.index] = 2;
    belt[GAS.index] = 2;
    game.setGrenadeLoadout(me, belt);
    const inputs: ReturnType<typeof createInput>[] = [];
    const enc = new SnapshotEncoder();
    const baselines = new SnapshotBaselines();
    const decoder = new SnapshotDecoder();
    const ghost = new PlayerState(me.id);
    // cycle, throw at our own feet (gas: we cough), walk, repeat
    const script = [Btn.CycleGrenade, 0, Btn.Grenade, 0, Btn.Right, Btn.CycleGrenade, Btn.Grenade, Btn.Left, 0];
    let types = 0;
    let gassed = 0;
    for (let t = 0; t < 720; t++) {
      inputs[me.id] = { ...createInput(), buttons: script[Math.floor(t / 17) % script.length]!, aim: 49152 };
      if (t === 300) {
        // a flashbang and an EMP land on us (their timers are in the status group)
        me.blindTicks = 200;
        me.blindFade = 90;
        me.jetDisabledTicks = 180;
      }
      game.step(inputs);
      types |= 1 << me.grenadeType;
      if (me.gasTicks > 0) gassed++;
      enc.begin(game, t + 1, game.events);
      const server = captureLocalState(me, createLocalState());
      const snap = decodeMessage(enc.encodeFor({ baselines: null, ackInputTick: t & 0xffff, inputBufferHealth: 1, local: me, view: null })) as SnapshotMsg;
      expect(describeLocalDiff(snap.local!, server)).toBe('');
      applyLocalState(snap.local!, ghost);
      expect(describeLocalDiff(captureLocalState(ghost, createLocalState()), server)).toBe('');
      expect([ghost.grenadeType, ...ghost.grenadeCounts, ghost.blindTicks, ghost.blindFade, ghost.gasTicks, ghost.jetDisabledTicks]).toEqual([
        me.grenadeType,
        ...me.grenadeCounts,
        me.blindTicks,
        me.blindFade,
        me.gasTicks,
        me.jetDisabledTicks,
      ]);
      const got = decoder.decode(enc.encodeFor({ baselines, ackInputTick: t & 0xffff, inputBufferHealth: 1, local: me, view: null }));
      baselines.ack(got.seq);
      expect(describeLocalDiff(got.local!, server)).toBe('');
    }
    expect(types).toBe((1 << FRAG.index) | (1 << SMOKE.index) | (1 << GAS.index));
    expect(gassed).toBeGreaterThan(30);
  });
});

describe('more guns (v11)', () => {
  it('takes the v11 slots from the protocol registry: a weapon-handling group after the status group', () => {
    expect(PROTOCOL_VERSION).toBeGreaterThanOrEqual(11);
    expect([LS.spin0, LS.burst0, LS.spin1, LS.burst1]).toEqual([58, 59, 60, 61]);
  });

  it('a spinning minigun and a burst under way round-trip, full and delta, so prediction fires exactly', () => {
    const game = new Game({ seed: 3, dummies: false });
    const me = game.addPlayer('me');
    game.setLoadout(me, [SHREDDER.index, TRIDENT.index]);
    const inputs: ReturnType<typeof createInput>[] = [];
    const enc = new SnapshotEncoder();
    const baselines = new SnapshotBaselines();
    const decoder = new SnapshotDecoder();
    let spun = 0;
    let bursting = 0;
    for (let t = 0; t < 240; t++) {
      // spin and fire the minigun, swap to the burst rifle, fire a burst
      const buttons = t < 100 ? Btn.Fire : t === 100 ? Btn.Swap : t > 140 && t < 150 ? Btn.Fire : 0;
      inputs[me.id] = { ...createInput(), buttons, aim: 0 };
      game.step(inputs);
      if (me.weapons[0].spin > 0) spun++;
      if (me.weapons[1].burst > 0) bursting++;
      enc.begin(game, t + 1, game.events);
      const bytes = enc.encodeFor({ baselines, ackInputTick: t & 0xffff, inputBufferHealth: 1, local: me, view: null });
      baselines.acked = t + 1;
      const snap = decoder.decode(bytes);
      expect(describeLocalDiff(snap.local!, captureLocalState(me, createLocalState()))).toBe('');
    }
    expect(spun).toBeGreaterThan(30);
    expect(bursting).toBeGreaterThan(0);
  });

  it('48 items, weapon items past def 15, and a PICKUP naming one, round-trip (u6 since v11)', () => {
    const game = new Game({ seed: 3, dummies: false, pickups: true });
    const me = game.addPlayer('me');
    for (const k of game.pickups) Object.assign(k, { alive: true, def: 7 + (k.id % 14), x: 100 + k.id * 0.5, y: 0, spawner: -1, spot: -1 });
    const events: SimEvent[] = [{ type: 'pickup', player: me.id, item: 20, x: 101, y: 0 }];
    const snap = decodeMessage(encodeSnapshot(game, 1, events, { local: me })) as SnapshotMsg;
    expect(snap.pickups).toHaveLength(game.pickups.length);
    expect(snap.pickups.at(-1)).toEqual({ id: 47, def: 7 + (47 % 14), x: 100 + 47 * 0.5, y: 0 });
    expect(snap.events).toEqual(events);
  });
});

describe('launchers and the flamethrower (v12)', () => {
  it('takes the v12 slots from the protocol registry: a burn group after the fire-mode group', () => {
    expect(PROTOCOL_VERSION).toBeGreaterThanOrEqual(12);
    expect(LS.burnTicks).toBe(62);
    expect(LOCAL_STATE_FIELDS).toBeGreaterThanOrEqual(63); // v14 (the dash chain) appends after it
  });

  it('projectiles ride the grenade records: types past 7 (u4) and a blade\'s 300-tick fuse (u9) round-trip', () => {
    const game = new Game({ seed: 3, dummies: false });
    const me = game.addPlayer('me');
    const rocket = game.allocGrenade()!;
    Object.assign(rocket, { alive: true, owner: me.id, type: PROJECTILE_TYPE_BASE + ROCKET.index, x: 12.5, y: 3.25, vx: 20, vy: -0.5, fuse: 180, state: 0 });
    const blade = game.allocGrenade()!;
    Object.assign(blade, { alive: true, owner: me.id, type: PROJECTILE_TYPE_BASE + BLADE.index, x: 30, y: 2, vx: -18, vy: 0, fuse: 300, state: 1 });
    const events: SimEvent[] = [{ type: 'explosion', x: 40, y: 1, radius: ROCKET.explosion!.radius, owner: me.id, grenade: PROJECTILE_TYPE_BASE + ROCKET.index }];
    const snap = decodeMessage(encodeSnapshot(game, 1, events, { local: me })) as SnapshotMsg;
    expect(snap.grenades).toEqual([
      { id: rocket.id, owner: me.id, x: 12.5, y: 3.25, vx: 20, vy: -0.5, fuse: 180, type: PROJECTILE_TYPE_BASE + ROCKET.index, state: 0 },
      { id: blade.id, owner: me.id, x: 30, y: 2, vx: -18, vy: 0, fuse: 300, type: PROJECTILE_TYPE_BASE + BLADE.index, state: 1 },
    ]);
    expect(snap.events).toEqual(events);
  });

  it('burning: its ticks in the local block (prediction burns exactly), and a flag on everyone else', () => {
    const game = new Game({ seed: 3, dummies: false });
    const me = game.addPlayer('me');
    const other = game.addPlayer('other');
    me.burnTicks = 97;
    other.burnTicks = 5;
    const snap = decodeMessage(encodeSnapshot(game, 1, [], { local: me })) as SnapshotMsg;
    expect(snap.local![LS.burnTicks]).toBe(97);
    const mirror = new PlayerState(me.id);
    applyLocalState(snap.local!, mirror);
    expect(mirror.burnTicks).toBe(97);
    expect(snap.players.find((q) => q.id === other.id)?.burning).toBe(true);
    other.burnTicks = 0;
    const cool = decodeMessage(encodeSnapshot(game, 2, [], { local: me })) as SnapshotMsg;
    expect(cool.players.find((q) => q.id === other.id)?.burning).toBe(false);
  });

  it('a minigun spinning or a charge weapon charging is a remote tell (review M1)', () => {
    const game = new Game({ seed: 3, dummies: false });
    const me = game.addPlayer('me');
    const gunner = game.addPlayer('gunner');
    const charger = game.addPlayer('charger');
    game.setLoadout(gunner, [SHREDDER.index, TRIDENT.index]);
    game.setLoadout(charger, [RIPPER.index, TRIDENT.index]);
    const tell = () => {
      const snap = decodeMessage(encodeSnapshot(game, 1, [], { local: me })) as SnapshotMsg;
      return [gunner.id, charger.id].map((id) => snap.players.find((q) => q.id === id)!.windup);
    };
    expect(tell()).toEqual([false, false]);
    gunner.weapons[0].spin = 12;
    charger.weapons[0].spin = 3;
    expect(tell()).toEqual([true, true]);
  });
});

describe('items in smoke (review M2)', () => {
  it('a hidden player taking a crate and dropping his gun changes nothing for a viewer outside the smoke, until it clears', () => {
    const map: MapDef = {
      id: 'smoke-items',
      name: 'smoke items',
      bounds: { minX: -2, minY: -6, maxX: 80, maxY: 40 },
      solids: [{ points: [-2, -6, 80, -6, 80, 0, -2, 0] }],
      oneWays: [],
      spawns: [{ x: 5, y: 0 }],
      dummies: [],
      labels: [],
    };
    const game = new Game({ map, seed: 9, dummies: false, pickups: true });
    const obs = game.addPlayer('obs');
    Object.assign(obs, { x: 10, y: 0 });
    const item = (x: number, def: number) => {
      const k = game.pickups.find((q) => !q.alive)!;
      Object.assign(k, { alive: true, def, x, y: 0, spawner: -1, spot: -1, ttl: 9999 });
      return k;
    };
    const crate = item(30, 7 + WIDOW.index);
    const plain = item(20, 7 + BREACHER.index);
    const view: ViewRect = { minX: -20, minY: -10, maxX: 70, maxY: 40 };
    const enc = new SnapshotEncoder();
    const baselines = new SnapshotBaselines();
    const decoder = new SnapshotDecoder();
    let seq = 0;
    const seen = () => {
      enc.begin(game, ++seq, []);
      const snap = decoder.decode(enc.encodeFor({ baselines, ackInputTick: 0, inputBufferHealth: 0, local: obs, view }));
      baselines.acked = seq;
      return snap.pickups.map((k) => `${k.def}@${k.x}`).sort();
    };
    const crateSeen = `${crate.def}@30`;
    const plainSeen = `${plain.def}@20`;
    expect(seen()).toEqual([crateSeen, plainSeen].sort());
    const cloud = spawnCloud(game, SMOKE.index, 30, 0, -1)!;
    cloud.age = 120;
    // in the smoke: the crate taken, the taker's old gun dropped where he stands (in the crate's slot, as the sim does)
    crate.alive = false;
    const dropped = item(30.5, 7 + MACHETE.index);
    expect(seen()).toEqual([crateSeen, plainSeen].sort());
    // in plain sight, a change shows at once
    plain.alive = false;
    expect(seen()).toEqual([crateSeen]);
    // the smoke clears: the truth
    cloud.alive = false;
    expect(seen()).toEqual([`${dropped.def}@30.5`]);
  });
});

describe('the admin page\'s overrides (v13)', () => {
  it('OVERRIDES (0x28) and WELCOME\'s overridesJson carry the admin values whole, however many', () => {
    expect(PROTOCOL_VERSION).toBeGreaterThanOrEqual(13); // v13 brought OVERRIDES; later versions keep it
    expect(MsgType.Overrides).toBe(0x28);
    const many = JSON.stringify(Object.fromEntries(Array.from({ length: 400 }, (_, i) => [`weapon.gun${i}.damage`, i + 0.25])));
    expect(many.length).toBeGreaterThan(4096);
    expect(decodeMessage(encodeOverrides(many))).toEqual({ type: MsgType.Overrides, overridesJson: many });
    const welcome = { playerId: 2, seed: 9, serverTick: 120, mapId: 'movement-test', tuningJson: '{}', sessionToken: 'tok', resumed: false, overridesJson: many };
    expect(decodeMessage(encodeWelcome(welcome))).toEqual({ type: MsgType.Welcome, ...welcome, spectator: false, delayTicks: 0 });
  });
});

describe('the fluid dash (v14)', () => {
  it('takes the v14 slots from the protocol registry: INPUT dashStrength, the reworked dash group, a chain group', () => {
    expect(PROTOCOL_VERSION).toBeGreaterThanOrEqual(14);
    expect([LS.dashTicks, LS.dashDir, LS.dashGap, LS.dashChain]).toEqual([41, 42, 43, 44]);
    expect([LS.dashChainTicks, LS.dashPower, LOCAL_STATE_FIELDS]).toEqual([63, 64, 65]);
  });

  it('INPUT carries every dash strength; the DASH event carries its chain link', () => {
    const inputs = [0, 3, 6, 7].map((dashStrength) => ({ ...createInput(), buttons: Btn.Dash, dashStrength }));
    const m = decodeMessage(encodeInput({ newestTick: 9, ackSnapshotSeq: 0, renderTick: 0, renderFrac: 0, inputs })) as { inputs: { dashStrength: number }[] };
    expect(m.inputs.map((i) => i.dashStrength)).toEqual([0, 3, 6, 7]);
    const game = new Game({ seed: 3, dummies: false });
    const me = game.addPlayer('me');
    const other = game.addPlayer('other');
    other.spawn(me.x + 4, me.y, game.tuning);
    const events: SimEvent[] = [{ type: 'dash', player: other.id, x: 4.5, y: 1.25, dir: 2, chain: 5 }];
    const snap = decodeMessage(encodeSnapshot(game, 1, events, { local: me })) as SnapshotMsg;
    expect(snap.events).toEqual(events);
  });
});

describe('remote melee swings (v16)', () => {
  it('a remote swing travels, full and delta, every tick of it, and a miss shows', () => {
    expect(PROTOCOL_VERSION).toBeGreaterThanOrEqual(16);
    const game = new Game({ seed: 5, dummies: false });
    const viewer = game.addPlayer('viewer');
    const swinger = game.addPlayer('swinger');
    viewer.spawn(20, 0, game.tuning);
    swinger.spawn(26, 0, game.tuning);
    game.setLoadout(swinger, [MACHETE.index, MACHETE.index]);
    const enc = new SnapshotEncoder();
    const baselines = new SnapshotBaselines();
    const decoder = new SnapshotDecoder();
    const inputs: ReturnType<typeof createInput>[] = [];
    let swinging = 0;
    let deltas = 0;
    for (let t = 0; t < 240; t++) {
      // a swing every second, aimed away from the viewer: every one misses
      inputs[swinger.id] = { ...createInput(), buttons: t % 60 === 5 ? Btn.Melee : 0 };
      game.step(inputs);
      enc.begin(game, t + 1, game.events);
      const full = decodeMessage(enc.encodeFor({ baselines: null, ackInputTick: 0, inputBufferHealth: 0, local: viewer, view: null })) as SnapshotMsg;
      expect(full.players.find((p) => p.id === swinger.id)!.meleeTicks).toBe(swinger.meleeTicks);
      const got = decoder.decode(enc.encodeFor({ baselines, ackInputTick: 0, inputBufferHealth: 0, local: viewer, view: null }));
      baselines.ack(got.seq);
      if (got.baselineSeq !== 0) deltas++;
      expect(got.players.find((p) => p.id === swinger.id)!.meleeTicks).toBe(swinger.meleeTicks);
      if (swinger.meleeTicks > 0) swinging++;
      expect(game.events.some((e) => e.type === 'hit')).toBe(false);
    }
    expect(swinging).toBeGreaterThan(40);
    expect(deltas).toBeGreaterThan(200);
  });
});

describe('looks on the wire (v19)', () => {
  const hers = cosmeticLoadoutWireIds({
    items: { ...DEFAULT_COSMETIC_LOADOUT.items, bodyType: 'body_female', hair: 'hair_braids' },
    dyes: { ...DEFAULT_COSMETIC_LOADOUT.dyes, primary: 'dye_khaki' },
  });
  const his = cosmeticLoadoutWireIds(DEFAULT_COSMETIC_LOADOUT);

  /** a v17/v18 client's ROSTER decoder, as it shipped */
  function oldRosterDecode(bytes: Uint8Array) {
    const r = new BitReader(bytes);
    r.u8();
    const n = r.bits(6);
    const entries = [];
    for (let i = 0; i < n; i++) entries.push({ id: r.bits(5), isBot: r.bool(), since: r.u32(), name: r.string() });
    return entries;
  }

  /** a v17 server's ROSTER, as it shipped (no looks section) */
  function oldRosterEncode(entries: { id: number; isBot: boolean; since: number; name: string }[]) {
    const w = new BitWriter(1024).u8(MsgType.Roster).unsigned(entries.length, 6);
    for (const e of entries) w.unsigned(e.id, 5).bool(e.isBot).u32(e.since).string(e.name);
    return w.finish().slice();
  }

  it('ROSTER carries each entry\'s look (15 wire ids), none for a player whose look is unknown', () => {
    const entries = [
      { id: 0, name: 'Strafer', isBot: true, since: 1, look: his },
      { id: 3, name: 'Kemi', isBot: false, since: 4_000_000_000, look: hers },
      { id: 7, name: 'Old page', isBot: false, since: 9, look: null },
    ];
    const msg = decodeMessage(encodeRoster(entries)) as RosterMsg;
    expect(msg.entries).toEqual(entries);
    expect(hers).toHaveLength(15);
    expect(cosmeticLoadoutFromWireIds(msg.entries[1]!.look!).items.bodyType).toBe('body_female');
  });

  it('every name length and entry count: the looks section never confuses the padding (exhaustive over 0–7 bits)', () => {
    for (let n = 0; n <= 4; n++) {
      for (let len = 0; len < 9; len++) {
        const entries = Array.from({ length: n }, (_, i) => ({ id: i, name: 'x'.repeat(len), isBot: i % 2 === 0, since: i, look: i % 3 === 1 ? null : hers }));
        expect((decodeMessage(encodeRoster(entries)) as RosterMsg).entries).toEqual(entries);
        // an older server's ROSTER: no section, so no looks (never garbage from the padding)
        const old = entries.map(({ look: _look, ...e }) => e);
        expect((decodeMessage(oldRosterEncode(old)) as RosterMsg).entries).toEqual(old.map((e) => ({ ...e, look: null })));
      }
    }
  });

  it('a v17/v18 client reads a v19 ROSTER\'s entries and never sees the looks', () => {
    const entries = [
      { id: 2, name: 'Ade', isBot: false, since: 12, look: hers },
      { id: 5, name: '[BOT] Kolo', isBot: true, since: 13, look: his },
    ];
    expect(oldRosterDecode(encodeRoster(entries))).toEqual(entries.map(({ look: _look, ...e }) => e));
  });

  it('HELLO: an optional look after the ticket; the ticket is written (empty) when only a look follows', () => {
    const ticket = `eyJhbGciOiJFZERTQSJ9.${'x'.repeat(300)}.sig`;
    expect(decodeMessage(encodeHello('Ade', '', '', hers))).toMatchObject({ name: 'Ade', ticket: '', look: hers });
    expect(decodeMessage(encodeHello('Ade', 'tok', ticket, hers))).toMatchObject({ resumeToken: 'tok', ticket, look: hers });
    expect(decodeMessage(encodeHello('Ade', 'tok', ticket))).toMatchObject({ ticket, look: null });
    expect(decodeMessage(encodeHello('Ade', '', '', []))).toMatchObject({ ticket: '', look: null });
    // padding never reads as a look, whatever the name length
    for (let len = 1; len < 10; len++) expect(decodeMessage(encodeHello('n'.repeat(len), 't'.repeat(len)))).toMatchObject({ look: null });
    // too many ids: capped at the u5 count
    const long = Array.from({ length: 40 }, (_, i) => i + 1);
    expect((decodeMessage(encodeHello('Ade', '', '', long)) as HelloMsg).look).toEqual(long.slice(0, MAX_LOOK_IDS));
  });

  it('SetLook (CMD 12): a JSON list of wire ids; anything else is refused', () => {
    const cmd = decodeMessage(encodeLookCmd(hers));
    expect(cmd).toEqual({ type: MsgType.Cmd, kind: CmdKind.SetLook, payload: JSON.stringify(hers) });
    expect(parseLookCmd((cmd as { payload: string }).payload)).toEqual(hers);
    for (const bad of ['', 'nope', '{}', '[]', '[1.5]', '[-1]', '[65536]', '["1"]', JSON.stringify(Array(32).fill(1)), `[${'1,'.repeat(300)}1]`]) expect(parseLookCmd(bad), bad).toBeNull();
  });

  it('v17 and v18 clients are still admitted; nothing newer or older', () => {
    expect(PROTOCOL_VERSION).toBeGreaterThanOrEqual(19);
    expect(MIN_PROTOCOL_VERSION).toBe(17);
    expect([16, 17, 18, 19, 20, 21].map(protocolSupported)).toEqual([false, true, true, true, true, false]);
    expect(CmdKind.SetLook).toBe(12);
  });
});

describe('spectating (v20)', () => {
  it('takes the v20 slots from the protocol registry', () => {
    expect(PROTOCOL_VERSION).toBe(20);
    expect(MsgType.SpectateAck).toBe(0x2c);
    expect(MsgType.Spectate).toBe(0x2d);
    expect(CmdKind.Spectate).toBe(13);
    expect(CloseCode.SpectatorsFull).toBe(4008);
    expect(HelloFlag.Spectate).toBe(1);
    expect(SPECTATOR_VOICE_BASE + MAX_SPECTATORS).toBeLessThanOrEqual(255);
    expect(isUnreliableMessage(encodeSpectateAck(7))).toBe(true);
    expect(isUnreliableMessage(encodeSpectate({ mode: 2, follow: -1, queue: 0, delayTicks: 180, slots: 0, spectators: [] }))).toBe(false);
  });

  it('HELLO: the spectate flag after the look; the ticket and look are written (empty) when only the flag follows', () => {
    const ticket = `eyJhbGciOiJFZERTQSJ9.${'x'.repeat(300)}.sig`;
    const look = [4, 17, 260];
    expect(decodeMessage(encodeHello('Ade', '', '', null, HelloFlag.Spectate))).toMatchObject({ name: 'Ade', ticket: '', look: null, spectate: true });
    expect(decodeMessage(encodeHello('Ade', '', ticket, look, HelloFlag.Spectate))).toMatchObject({ ticket, look, spectate: true });
    expect(decodeMessage(encodeHello('Ade', 'tok', ticket, look))).toMatchObject({ resumeToken: 'tok', ticket, look, spectate: false });
    // whatever the name and token lengths, padding never reads as a flag, and the flag never as padding
    for (let len = 1; len < 10; len++) {
      expect(decodeMessage(encodeHello('n'.repeat(len), 't'.repeat(len)))).toMatchObject({ look: null, spectate: false });
      expect(decodeMessage(encodeHello('n'.repeat(len), '', '', null, HelloFlag.Spectate))).toMatchObject({ look: null, spectate: true });
      expect(decodeMessage(encodeHello('n'.repeat(len), '', '', look.slice(0, len % 3), HelloFlag.Spectate))).toMatchObject({ spectate: true });
    }
  });

  it('WELCOME: a spectator has no player and a delay; a v17–v19 decoder reads the same WELCOME and stops before the tail', () => {
    const base = { playerId: 3, seed: 5, serverTick: 1000, mapId: 'street-market', tuningJson: '{}', sessionToken: '', resumed: false, overridesJson: '{}' };
    expect(decodeMessage(encodeWelcome({ ...base, spectator: true, delayTicks: 180 }))).toEqual({ type: MsgType.Welcome, ...base, playerId: -1, spectator: true, delayTicks: 180 });
    expect((decodeMessage(encodeWelcome({ ...base, spectator: true, delayTicks: 99_999 })) as WelcomeMsg).delayTicks).toBe(1023);
    // a v19 decoder, as it shipped
    const old = (bytes: Uint8Array) => {
      const r = new BitReader(bytes);
      r.u8();
      return { playerId: r.bits(5), seed: r.u32(), serverTick: r.u32(), mapId: r.string(), tuningJson: r.string(16), sessionToken: r.string(), resumed: r.bool(), overridesJson: r.string(16) };
    };
    expect(old(encodeWelcome(base))).toEqual(base);
    expect(old(encodeWelcome({ ...base, spectator: true, delayTicks: 180 }))).toEqual({ ...base, playerId: 31 });
    // a v19 server's WELCOME (no tail): a player, no delay
    const w = new BitWriter(256).u8(MsgType.Welcome).unsigned(3, 5).u32(5).u32(1000).string('street-market').string('{}', 16).string('').bool(false).string('{}', 16);
    expect(decodeMessage(w.finish().slice())).toEqual({ type: MsgType.Welcome, ...base, spectator: false, delayTicks: 0 });
  });

  it('SPECTATE round-trips: mode, follow, queue, delay, free slots and the room\'s spectators', () => {
    const m: Omit<SpectateMsg, 'type'> = {
      mode: SpectateMode.Spectator,
      follow: 6,
      queue: SpectateQueue.Next,
      delayTicks: 180,
      slots: 2,
      spectators: [
        { voiceId: 32, name: 'Kemi' },
        { voiceId: 35, name: 'Ọlá 🎯' },
      ],
    };
    expect(decodeMessage(encodeSpectate(m))).toEqual({ type: MsgType.Spectate, ...m });
    const dead = { mode: SpectateMode.Dead, follow: -1, queue: SpectateQueue.Watching, delayTicks: 0, slots: 0, spectators: [] };
    expect(decodeMessage(encodeSpectate(dead))).toEqual({ type: MsgType.Spectate, ...dead });
    // the list is capped at MAX_SPECTATORS
    const many = Array.from({ length: 12 }, (_, i) => ({ voiceId: 32 + i, name: `s${i}` }));
    expect((decodeMessage(encodeSpectate({ ...m, spectators: many })) as SpectateMsg).spectators).toHaveLength(MAX_SPECTATORS);
  });

  it('SPECTATE_ACK carries a u16 seq and nothing else', () => {
    expect(decodeMessage(encodeSpectateAck(65_535))).toEqual({ type: MsgType.SpectateAck, seq: 65_535 });
    expect(decodeMessage(encodeSpectateAck(65_536 + 9))).toEqual({ type: MsgType.SpectateAck, seq: 9 });
    expect(() => decodeMessage(new Uint8Array([MsgType.SpectateAck, 1, 2, 3]))).toThrow(DecodeError);
  });

  it('the Spectate CMD (13): follow a player, ask to play now or next round; anything else is refused', () => {
    const cmd = decodeMessage(encodeSpectateCmd({ follow: 4, play: 'next' }));
    expect(cmd).toEqual({ type: MsgType.Cmd, kind: CmdKind.Spectate, payload: '{"follow":4,"play":"next"}' });
    expect(parseSpectateCmd((cmd as { payload: string }).payload)).toEqual({ follow: 4, play: 'next' });
    expect(parseSpectateCmd('{"play":false}')).toEqual({ play: false });
    expect(parseSpectateCmd('{"play":"now"}')).toEqual({ play: 'now' });
    for (const bad of ['', 'x', '[]', '{}', '{"follow":-1}', '{"follow":31}', '{"follow":1.5}', '{"follow":"2"}', '{"play":true}', '{"play":"later"}', `{"follow":1,"pad":"${'x'.repeat(200)}"}`])
      expect(parseSpectateCmd(bad), bad).toBeNull();
  });

  it('a spectator\'s ring covers its delay: deltas keep flowing though acks come 3 s late (the default ring would send full snapshots)', () => {
    expect(spectatorRing(0)).toBe(64);
    expect(spectatorRing(180)).toBe(128);
    expect(spectatorRing(600)).toBe(512);
    expect(spectatorRing(10_000)).toBe(1024);
    const run = (bl: SnapshotBaselines, dec: SnapshotDecoder) => {
      const game = new Game({ seed: 4, dummies: true });
      const a = game.addPlayer('a');
      const enc = new SnapshotEncoder();
      const full = new SnapshotEncoder();
      const inputs: ReturnType<typeof createInput>[] = [];
      const queue: { at: number; bytes: Uint8Array; truth: SnapshotMsg }[] = [];
      let seq = 0;
      let deltas = 0;
      let got = 0;
      for (let t = 0; t < 1200; t++) {
        inputs[a.id] = { ...createInput(), buttons: t % 100 < 50 ? Btn.Right : Btn.Left | Btn.Jet, aim: (t * 77) & 0xffff };
        game.step(inputs);
        if (game.tick % 2 !== 0) continue;
        seq++;
        enc.begin(game, seq, game.events);
        full.begin(game, seq, game.events);
        // a spectator: no local block, the whole map, held back 180 ticks (90 snapshots), acked 5 snapshots after decoding
        const bytes = enc.encodeFor({ baselines: bl, ackInputTick: 0, inputBufferHealth: -128, local: null, view: null });
        queue.push({ at: seq + 90, bytes, truth: decodeMessage(full.encodeFor({ baselines: null, ackInputTick: 0, inputBufferHealth: -128, local: null, view: null })) as SnapshotMsg });
        while (queue.length && queue[0]!.at <= seq) {
          const q = queue.shift()!;
          let msg: SnapshotMsg;
          try {
            msg = dec.decode(q.bytes);
          } catch (e) {
            expect((e as Error).message).toMatch(/missing baseline/);
            continue;
          }
          got++;
          if (msg.baselineSeq !== 0) deltas++;
          expect(msg.players).toEqual(q.truth.players);
          expect(msg.local).toBeNull();
          const ackSeq = msg.seq;
          setTimeout0(() => bl.ack(ackSeq));
        }
        flush0(seq);
      }
      return { got, deltas };
    };
    // acks travel 5 snapshots back to the server
    let pending: { at: number; fn: () => void }[] = [];
    let nowSeq = 0;
    const setTimeout0 = (fn: () => void) => pending.push({ at: nowSeq + 5, fn });
    const flush0 = (seq: number) => {
      nowSeq = seq;
      const due = pending.filter((p) => p.at <= seq);
      pending = pending.filter((p) => p.at > seq);
      for (const p of due) p.fn();
    };
    const ring = spectatorRing(180);
    const spectator = run(new SnapshotBaselines(ring), new SnapshotDecoder(ring));
    expect(spectator.got).toBeGreaterThan(500);
    // full only until the first ack is back (the delay plus the ack's way): every one after is a delta
    expect(spectator.got - spectator.deltas).toBeLessThanOrEqual(96);
    pending = [];
    const player = run(new SnapshotBaselines(), new SnapshotDecoder());
    expect(player.deltas).toBe(0); // its acks are always older than its 32-snapshot ring: full every time
    expect(() => new SnapshotBaselines(100)).toThrow();
  });
});
