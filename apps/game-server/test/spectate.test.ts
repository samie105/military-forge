/**
 * Spectating (protocol v20) through a real Room: a spectator's seat (no slot, the cap), its feed
 * (the whole map, no local block, held back by the delay, deltas against its acks), that it can't
 * act, taking a slot (now, or at the next round), the death cam (the killer first, the admin's
 * rule), voice (spectators reach only the dead and each other), old pages, and the registry's door.
 */
import { setAdminValues } from '../src/adminState';
import {
  BitReader,
  BitWriter,
  CloseCode,
  CmdKind,
  HelloFlag,
  MsgType,
  PEER_DEAD,
  SnapshotDecoder,
  SpectateMode,
  SpectateQueue,
  VoiceChannel,
  VoiceCodec,
  VoiceRoute,
  decodeMessage,
  decodeVoiceDown,
  decodeVoiceState,
  encodeCmd,
  encodeHello,
  encodeInput,
  encodeSpectateAck,
  encodeSpectateCmd,
  encodeVoiceUp,
  spectatorRing,
  type Message,
  type SnapshotMsg,
  type SpectateMsg,
  type VoiceChannelId,
  type VoiceDown,
  type WelcomeMsg,
} from '@military-forge/protocol';
import { Btn, MatchPhase, createInput } from '@military-forge/sim';
import { afterEach, describe, expect, it } from 'vitest';
import { Room, type ClientConn } from '../src/room';
import { RoomRegistry } from '../src/rooms';

class FakeConn implements ClientConn {
  readonly sent: Uint8Array[] = [];
  closed: { code: number; reason: string } | null = null;
  send(bytes: Uint8Array) {
    this.sent.push(bytes);
  }
  close(code: number, reason: string) {
    this.closed = { code, reason };
  }
  bufferedAmount() {
    return 0;
  }
  messages(): Message[] {
    return this.sent.filter((b) => b[0] !== MsgType.Snapshot && b[0] !== MsgType.VoiceDown && b[0] !== MsgType.VoiceState).map((b) => decodeMessage(b));
  }
  last<T extends Message['type']>(type: T): Extract<Message, { type: T }> | undefined {
    return this.messages()
      .filter((m): m is Extract<Message, { type: T }> => m.type === type)
      .at(-1);
  }
  snapshotBytes(): Uint8Array[] {
    return this.sent.filter((b) => b[0] === MsgType.Snapshot);
  }
  voice(): VoiceDown[] {
    return this.sent.filter((b) => b[0] === MsgType.VoiceDown).map(decodeVoiceDown);
  }
  clear() {
    this.sent.length = 0;
  }
}

/** HELLO as a page of `version` would send it (the bytes after the version, bit for bit). */
function hello(name: string, flags = 0, version?: number): Uint8Array {
  const at = encodeHello(name, '', '', null, flags);
  if (version === undefined) return at;
  const w = new BitWriter(256).u8(MsgType.Hello).u16(version);
  const r = new BitReader(at);
  r.u8();
  r.u16();
  while (r.remainingBits >= 8) w.u8(r.u8());
  return w.finish().slice();
}

function join(room: Room, name: string, opts: { party?: string } = {}) {
  const conn = new FakeConn();
  const client = room.connect(conn);
  if (opts.party) client.party = opts.party;
  room.receive(client, hello(name));
  return { conn, client, id: client.playerId };
}

function watch(room: Room, name: string, opts: { party?: string; version?: number } = {}) {
  const conn = new FakeConn();
  const client = room.connect(conn);
  if (opts.party) client.party = opts.party;
  room.receive(client, hello(name, HelloFlag.Spectate, opts.version));
  return { conn, client };
}

const spectateOf = (conn: FakeConn) => conn.last(MsgType.Spectate) as SpectateMsg | undefined;

function place(room: Room, id: number, x: number, y = 5) {
  const p = room.game.players[id]!;
  p.alive = true;
  p.x = x;
  p.y = y;
}

/** After the next sim step, `victim` dies to `killer` (a death event the room sees on that tick). */
function killNextStep(room: Room, victim: number, killer: number) {
  const game = room.game;
  const step = game.step.bind(game);
  game.step = (inputs) => {
    step(inputs);
    game.step = step;
    const v = game.players[victim]!;
    v.respawnTicks = 0;
    game.damage(v, 9999, killer, 0, 0);
    v.respawnTicks = 100_000; // stays dead through the test
  };
}

afterEach(() => setAdminValues({}));

describe('spectating (v20)', () => {
  it('a spectator takes a seat, not a slot: WELCOME says so, with its delay; the ROSTER and SPECTATE come at once', () => {
    const room = new Room({ dummies: false, maxHumans: 2 });
    join(room, 'Ade');
    join(room, 'Kemi');
    const s = watch(room, 'Watcher');
    const welcome = s.conn.last(MsgType.Welcome) as WelcomeMsg;
    expect(welcome).toMatchObject({ spectator: true, playerId: -1, delayTicks: 180, sessionToken: '' });
    expect(s.conn.closed).toBeNull();
    expect(room.humanCount).toBe(2);
    expect(room.spectatorCount).toBe(1);
    expect(room.game.players.filter(Boolean)).toHaveLength(2);
    expect((s.conn.last(MsgType.Roster) as { entries: unknown[] }).entries).toHaveLength(2);
    room.tick();
    expect(spectateOf(s.conn)).toMatchObject({ mode: SpectateMode.Spectator, follow: -1, queue: SpectateQueue.Watching, delayTicks: 180, slots: 0, spectators: [{ voiceId: 32, name: 'Watcher' }] });
    // the full room still turns a player away
    const late = join(room, 'Late');
    expect(late.conn.closed?.code).toBe(CloseCode.RoomFull);
  });

  it('the feed: nothing for the delay, then every player (no AOI, no local block), deltas once it acks', () => {
    setAdminValues({ 'spectate.delay': 1 });
    const room = new Room({ dummies: false });
    const a = join(room, 'Ade');
    const b = join(room, 'Kemi');
    place(room, a.id, 5);
    place(room, b.id, 400); // far beyond anyone's view
    const s = watch(room, 'Watcher');
    expect((s.conn.last(MsgType.Welcome) as WelcomeMsg).delayTicks).toBe(60);
    for (let i = 0; i < 59; i++) room.tick();
    expect(s.conn.snapshotBytes()).toHaveLength(0);
    // the players' own snapshots are live and culled
    const dec = new SnapshotDecoder(spectatorRing(60));
    let deltas = 0;
    let got = 0;
    for (let i = 0; i < 240; i++) {
      room.tick();
      for (const bytes of s.conn.snapshotBytes()) {
        const msg = dec.decode(bytes);
        got++;
        if (msg.baselineSeq !== 0) deltas++;
        expect(msg.local).toBeNull();
        expect(msg.players.map((p) => p.id).sort()).toEqual([a.id, b.id].sort());
        room.receive(s.client, encodeSpectateAck(msg.seq));
      }
      s.conn.sent.length = 0;
    }
    expect(got).toBeGreaterThan(100);
    expect(deltas).toBeGreaterThan(got - 40); // full only until its first ack is back
    // what it sees is a second old: the newest snapshot's tick is ~60 behind the room's
    room.tick();
    room.tick();
    const newest = s.conn.snapshotBytes().map((bytes) => dec.decode(bytes)).at(-1)!;
    expect(room.game.tick - newest.serverTick).toBeGreaterThanOrEqual(59);
    expect(room.game.tick - newest.serverTick).toBeLessThanOrEqual(62);
    // a player's own view is live and doesn't hold the far one
    const own = new SnapshotDecoder().decode(a.conn.snapshotBytes().at(-1)!) as SnapshotMsg;
    expect(own.players.map((p) => p.id)).toEqual([a.id]);
  });

  it('a spectator can\'t act: INPUT and match commands do nothing; MATCH_STATE rides its delay', () => {
    const room = new Room({ dummies: false, match: { minPlayers: 1 } });
    const host = join(room, 'Host');
    const s = watch(room, 'Watcher');
    const before = room.game.players.filter(Boolean).length;
    room.receive(s.client, encodeInput({ newestTick: 1, ackSnapshotSeq: 0, renderTick: 0, renderFrac: 0, inputs: [{ ...createInput(), buttons: Btn.Fire | Btn.Jet }] }));
    room.receive(s.client, encodeCmd(CmdKind.StartMatch, ''));
    room.receive(s.client, encodeCmd(CmdKind.Ready, '1'));
    room.receive(s.client, encodeCmd(CmdKind.MatchSettings, JSON.stringify({ killLimit: 5 })));
    for (let i = 0; i < 10; i++) room.tick();
    expect(room.match!.phase).toBe(MatchPhase.Waiting);
    expect(room.match!.rules.killLimit).not.toBe(5);
    expect(room.game.players.filter(Boolean)).toHaveLength(before);
    expect(s.client.playerId).toBe(-1);
    expect(s.conn.closed).toBeNull();
    // the host's MATCH_STATE is live; the spectator's comes the delay later
    expect(host.conn.last(MsgType.MatchState)).toBeDefined();
    expect(s.conn.last(MsgType.MatchState)).toBeUndefined();
    for (let i = 0; i < 180; i++) room.tick();
    expect(s.conn.last(MsgType.MatchState)).toBeDefined();
  });

  it('the cap: spectate.cap seats (4 by default), then 4008; 0 turns spectating off', () => {
    const room = new Room({ dummies: false });
    join(room, 'Ade');
    const seats = [1, 2, 3, 4].map((i) => watch(room, `W${i}`));
    expect(seats.every((w) => w.conn.closed === null)).toBe(true);
    const fifth = watch(room, 'W5');
    expect(fifth.conn.closed?.code).toBe(CloseCode.SpectatorsFull);
    // one leaves: its seat (and voice id) goes to the next
    room.disconnect(seats[1]!.client);
    const again = watch(room, 'W6');
    expect(again.conn.closed).toBeNull();
    expect(again.client.voiceId).toBe(33);
    setAdminValues({ 'spectate.cap': 0 });
    const off = new Room({ dummies: false });
    join(off, 'Ade');
    expect(watch(off, 'W').conn.closed?.code).toBe(CloseCode.SpectatorsFull);
  });

  it('play "now": a spectator takes the first slot that frees up, on the same connection, as a fresh join', () => {
    setAdminValues({ 'spectate.delay': 2 });
    const room = new Room({ dummies: false, maxHumans: 1 });
    const a = join(room, 'Ade');
    const s = watch(room, 'Watcher');
    room.receive(s.client, encodeSpectateCmd({ play: 'now' }));
    for (let i = 0; i < 20; i++) room.tick();
    expect(s.client.spectator).toBe(true);
    expect(spectateOf(s.conn)?.queue).toBe(SpectateQueue.Now);
    room.receive(a.client, encodeCmd(CmdKind.Leave, ''));
    room.tick();
    expect(s.client.spectator).toBe(false);
    expect(s.client.joined).toBe(true);
    const welcome = s.conn.last(MsgType.Welcome) as WelcomeMsg;
    expect(welcome).toMatchObject({ spectator: false, playerId: s.client.playerId });
    expect(welcome.sessionToken).not.toBe('');
    expect(room.game.players[s.client.playerId]!.name).toBe('Watcher');
    expect(room.spectatorCount).toBe(0);
    expect(spectateOf(s.conn)?.mode).toBe(SpectateMode.Playing);
    // live from now: its next snapshot is this tick's and carries its own player
    s.conn.clear();
    room.tick();
    room.tick();
    const snap = new SnapshotDecoder().decode(s.conn.snapshotBytes().at(-1)!);
    expect(room.game.tick - snap.serverTick).toBeLessThanOrEqual(1);
    expect(snap.local).not.toBeNull();
  });

  it('play "next": waits out the running match, then plays once the room is back in the lobby', () => {
    const room = new Room({ dummies: false, match: { minPlayers: 1, countdown: 1 } });
    const host = join(room, 'Host');
    room.receive(host.client, encodeCmd(CmdKind.StartMatch, ''));
    for (let i = 0; i < 90; i++) room.tick();
    expect(room.match!.phase).toBe(MatchPhase.InProgress);
    const s = watch(room, 'Watcher');
    room.receive(s.client, encodeSpectateCmd({ play: 'next' }));
    for (let i = 0; i < 60; i++) room.tick();
    expect(s.client.spectator).toBe(true); // a slot is free, but the round is on
    room.receive(host.client, encodeCmd(CmdKind.ReturnToLobby, ''));
    for (let i = 0; i < 5 && s.client.spectator; i++) room.tick();
    expect(room.match!.phase).toBe(MatchPhase.Waiting);
    expect(s.client.joined).toBe(true);
    // and "false" takes a wish back
    const t = watch(room, 'Second');
    room.receive(t.client, encodeSpectateCmd({ play: 'now' }));
    room.receive(t.client, encodeSpectateCmd({ play: false }));
    room.tick();
    expect(t.client.spectator).toBe(true);
  });

  it('the death cam: a v20 player who dies follows the killer, sees what the killer sees, and may switch (spectate.deathCam)', () => {
    const room = new Room({ dummies: false, mapId: 'street-market' });
    const victim = join(room, 'Victim');
    const killer = join(room, 'Killer');
    const third = join(room, 'Third');
    const b = room.game.map.bounds;
    place(room, victim.id, b.minX + 5, 3);
    place(room, killer.id, b.maxX - 10, 3);
    place(room, third.id, b.maxX - 6, 3); // in the killer's view, not the victim's
    killNextStep(room, victim.id, killer.id);
    room.tick();
    expect(spectateOf(victim.conn)).toMatchObject({ mode: SpectateMode.Dead, follow: killer.id });
    victim.conn.clear();
    room.tick();
    room.tick();
    const snap = new SnapshotDecoder().decode(victim.conn.snapshotBytes().at(-1)!);
    expect(snap.local).not.toBeNull(); // its own block still comes (the respawn timer)
    expect(snap.players.map((p) => p.id).sort()).toEqual([victim.id, killer.id, third.id].sort());
    // switch to the third player
    room.receive(victim.client, encodeSpectateCmd({ follow: third.id }));
    room.tick();
    expect(spectateOf(victim.conn)?.follow).toBe(third.id);
    // the admin's "the killer only": a switch is refused
    setAdminValues({ 'spectate.deathCam': 1 });
    room.receive(victim.client, encodeSpectateCmd({ follow: killer.id }));
    room.receive(victim.client, encodeSpectateCmd({ follow: third.id }));
    room.tick();
    expect(spectateOf(victim.conn)?.follow).toBe(killer.id);
    // back in play: the death cam ends
    const v = room.game.players[victim.id]!;
    v.alive = true;
    for (let i = 0; i < 10; i++) room.tick();
    expect(spectateOf(victim.conn)).toMatchObject({ mode: SpectateMode.Playing, follow: -1 });
  });

  it('a living player\'s follow request does nothing, and a v19 page is never given a death cam', () => {
    const room = new Room({ dummies: false });
    const old = { conn: new FakeConn() };
    const oldClient = room.connect(old.conn);
    room.receive(oldClient, hello('Old', 0, 19));
    const k = join(room, 'Killer');
    const alive = join(room, 'Alive');
    room.receive(alive.client, encodeSpectateCmd({ follow: k.id }));
    room.tick();
    expect(alive.client.follow).toBe(-1);
    killNextStep(room, oldClient.playerId, k.id);
    room.tick();
    expect(oldClient.follow).toBe(-1);
    expect(old.conn.sent.some((b) => b[0] === MsgType.Spectate)).toBe(false);
    // a v19 page's spectate flag isn't read as one (v19 never had it): it plays
    const r = new Room({ dummies: false });
    const w = watch(r, 'Old watcher', { version: 19 });
    expect(w.client.spectator).toBe(false);
    expect(w.client.joined).toBe(true);
  });

  it('voice: in play a spectator reaches only the dead and other spectators (not even a living party mate); it hears the dead', () => {
    const ON = { on: true, mic: true, opus: true, proximity: true, hearOpponents: true, mute: [] };
    const room = new Room({ dummies: false });
    const living = join(room, 'Living', { party: 'p1' });
    const dead = join(room, 'Dead');
    const s = watch(room, 'Watcher', { party: 'p1' });
    const s2 = watch(room, 'Watcher 2');
    for (const c of [living, dead, s, s2]) room.receive(c.client, encodeCmd(CmdKind.Voice, JSON.stringify(ON)));
    place(room, living.id, 10);
    place(room, dead.id, 12);
    const pd = room.game.players[dead.id]!;
    pd.alive = false;
    pd.respawnTicks = 100_000;
    for (let i = 0; i < 6 * 60 + 2; i++) room.tick(); // past its last words
    pd.alive = false;
    let n = 0;
    const frame = (channel: VoiceChannelId) => encodeVoiceUp({ seq: n++, codec: VoiceCodec.Opus, channel, level: 9, frameMs: 20, frame: new Uint8Array([1, 2]), redundant: null });
    for (const ch of [VoiceChannel.Near, VoiceChannel.Party, VoiceChannel.Team]) {
      for (const c of [living, dead, s2]) c.conn.clear();
      room.receive(s.client, frame(ch));
      expect(living.conn.voice(), `channel ${ch}`).toEqual([]);
      expect(dead.conn.voice().map((v) => [v.speaker, v.route])).toEqual([[32, VoiceRoute.Dead]]);
      expect(s2.conn.voice().map((v) => v.speaker)).toEqual([32]);
    }
    // the dead reach the spectators
    s.conn.clear();
    room.receive(dead.client, frame(VoiceChannel.Near));
    expect(s.conn.voice().map((v) => [v.speaker, v.route])).toEqual([[dead.id, VoiceRoute.Dead]]);
    // a living player's voice out loud never reaches a spectator (no soldier to be near)
    s.conn.clear();
    room.receive(living.client, frame(VoiceChannel.Near));
    expect(s.conn.voice()).toEqual([]);
    // VOICE_STATE names spectators by their voice ids, as talking only to the dead
    living.conn.clear();
    room.receive(living.client, encodeCmd(CmdKind.Voice, JSON.stringify({ ...ON, proximity: false })));
    for (let i = 0; i < 12; i++) room.tick();
    const st = decodeVoiceState(living.conn.sent.filter((b) => b[0] === MsgType.VoiceState).at(-1)!);
    expect(st.peers.find((p) => p.id === 32)!.flags & PEER_DEAD).toBe(PEER_DEAD);
    // and mutes take voice ids
    room.receive(dead.client, encodeCmd(CmdKind.Voice, JSON.stringify({ ...ON, mute: [32] })));
    dead.conn.clear();
    room.receive(s.client, frame(VoiceChannel.Near));
    expect(dead.conn.voice()).toEqual([]);
  });

  it('spectators don\'t keep a room open; the registry turns a spectator away from a room nobody opened', () => {
    const room = new Room({ dummies: false });
    const a = join(room, 'Ade');
    watch(room, 'Watcher');
    expect(room.empty).toBe(false);
    room.receive(a.client, encodeCmd(CmdKind.Leave, ''));
    expect(room.empty).toBe(true);

    const reg = new RoomRegistry({ defaultRoom: null });
    const conn = new FakeConn();
    const c = reg.open('/ws/ABCDEF', conn)!;
    c.receive(hello('Watcher', HelloFlag.Spectate));
    expect(conn.closed?.code).toBe(CloseCode.NoRoom);
    expect(reg.rooms.size).toBe(0);
    // once someone plays there, a spectator gets in
    const p = new FakeConn();
    reg.open('/ws/ABCDEF', p)!.receive(hello('Player'));
    const w = new FakeConn();
    reg.open('/ws/ABCDEF', w)!.receive(hello('Watcher', HelloFlag.Spectate));
    expect(w.closed).toBeNull();
    expect((decodeMessage(w.sent[0]!) as WelcomeMsg).spectator).toBe(true);
  });
});
