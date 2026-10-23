/**
 * Voice chat's relay (v18, src/voice.ts) through a real Room: who hears whom (proximity from sim
 * positions, the lobby, party, mutes, "Hear opponents"), last words and the dead's own channel,
 * the per-listener cap, the frame budget, VOICE_STATE, the admin's radius, and v17 clients.
 */
import { VOICE, applyContentOverrides } from '@military-forge/content';
import {
  BitReader,
  BitWriter,
  CmdKind,
  MsgType,
  PEER_DEAD,
  PEER_MIC,
  PEER_MUTED,
  PEER_PARTY,
  PEER_VOICE,
  VoiceChannel,
  VoiceCodec,
  VoiceRoute,
  decodeVoiceDown,
  decodeVoiceState,
  encodeCmd,
  encodeHello,
  encodeVoiceUp,
  type VoiceChannelId,
  type VoiceDown,
  type VoiceSettingsCmd,
} from '@military-forge/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { Room, type ClientConn } from '../src/room';

class FakeConn implements ClientConn {
  readonly sent: Uint8Array[] = [];
  closed: { code: number; reason: string } | null = null;
  backlog = 0;
  send(bytes: Uint8Array) {
    this.sent.push(bytes);
  }
  close(code: number, reason: string) {
    this.closed = { code, reason };
  }
  bufferedAmount() {
    return this.backlog;
  }
  voice(): VoiceDown[] {
    return this.sent.filter((b) => b[0] === MsgType.VoiceDown).map(decodeVoiceDown);
  }
  clear() {
    this.sent.length = 0;
  }
}

const ON: VoiceSettingsCmd = { on: true, mic: true, opus: true, proximity: true, hearOpponents: true, mute: [] };

/** A v18 HELLO, or an older one (the same bytes with another version: an older page's). */
function hello(name: string, version?: number): Uint8Array {
  if (version === undefined) return encodeHello(name);
  const at = encodeHello(name);
  const w = new BitWriter(256).u8(MsgType.Hello).u16(version);
  // everything after the version, bit for bit (the bitstream packs LSB first)
  const r = new BitReader(at);
  r.u8();
  r.u16();
  while (r.remainingBits >= 8) w.u8(r.u8());
  return w.finish().slice();
}

function join(room: Room, name: string, opts: { party?: string; version?: number; voice?: Partial<VoiceSettingsCmd> | null } = {}) {
  const conn = new FakeConn();
  const client = room.connect(conn);
  if (opts.party) client.party = opts.party;
  room.receive(client, hello(name, opts.version));
  if (opts.voice !== null) room.receive(client, encodeCmd(CmdKind.Voice, JSON.stringify({ ...ON, ...opts.voice })));
  return { conn, client, id: client.playerId };
}

let seq = 0;
const frame = (channel: VoiceChannelId = VoiceChannel.Near) => encodeVoiceUp({ seq: seq++, codec: VoiceCodec.Opus, channel, level: 9, frameMs: 20, frame: new Uint8Array([1, 2, 3, 4]), redundant: null });

/** Puts a soldier at (x, y), alive. */
function place(room: Room, id: number, x: number, y = 5) {
  const p = room.game.players[id]!;
  p.alive = true;
  p.x = x;
  p.y = y;
}

afterEach(() => applyContentOverrides({}));

describe('voice relay', () => {
  it('in play: out loud reaches whoever is within the radius, from real positions, not farther', () => {
    const room = new Room({ dummies: false });
    const a = join(room, 'Ade');
    const near = join(room, 'Kemi');
    const far = join(room, 'Seun');
    place(room, a.id, 10);
    place(room, near.id, 10 + VOICE.radius - 1);
    place(room, far.id, 10 + VOICE.radius + 1);
    room.receive(a.client, frame());
    expect(near.conn.voice()).toHaveLength(1);
    expect(near.conn.voice()[0]).toMatchObject({ speaker: a.id, route: VoiceRoute.Proximity, lastWords: false, level: 9, frame: new Uint8Array([1, 2, 3, 4]) });
    expect(far.conn.voice()).toEqual([]);
    expect(a.conn.voice()).toEqual([]); // never yourself
  });

  it('the admin page moves the radius', () => {
    const room = new Room({ dummies: false });
    const a = join(room, 'Ade');
    const b = join(room, 'Kemi');
    place(room, a.id, 10);
    place(room, b.id, 22);
    applyContentOverrides({ 'voice.radius': 8 });
    room.receive(a.client, frame());
    expect(b.conn.voice()).toEqual([]);
    applyContentOverrides({});
    room.receive(a.client, frame());
    expect(b.conn.voice()).toHaveLength(1);
  });

  it('in the lobby the whole room hears, at any distance', () => {
    const room = new Room({ dummies: false, match: { minPlayers: 4 } });
    const a = join(room, 'Ade');
    const b = join(room, 'Kemi');
    place(room, a.id, 0);
    place(room, b.id, 500);
    room.receive(a.client, frame());
    expect(b.conn.voice().map((v) => v.route)).toEqual([VoiceRoute.Lobby]);
  });

  it('party voice reaches party mates anywhere, nobody else; mutes and "Hear opponents" are the listener\'s', () => {
    const room = new Room({ dummies: false });
    const a = join(room, 'Ade', { party: 'p_1' });
    const mate = join(room, 'Kemi', { party: 'p_1' });
    const other = join(room, 'Seun', { party: 'p_2' });
    place(room, a.id, 0);
    place(room, mate.id, 400);
    place(room, other.id, 2);
    room.receive(a.client, frame(VoiceChannel.Party));
    expect(mate.conn.voice().map((v) => v.route)).toEqual([VoiceRoute.Party]);
    expect(other.conn.voice()).toEqual([]);

    // Seun mutes Ade: nothing of Ade's reaches Seun, out loud or otherwise
    room.receive(other.client, encodeCmd(CmdKind.Voice, JSON.stringify({ ...ON, mute: [a.id] })));
    room.receive(a.client, frame());
    expect(other.conn.voice()).toEqual([]);

    // Kemi (a party mate) near Seun, who turns off opponents: Kemi's party mate status doesn't count for Seun
    place(room, mate.id, 3);
    room.receive(other.client, encodeCmd(CmdKind.Voice, JSON.stringify({ ...ON, hearOpponents: false })));
    room.receive(mate.client, frame());
    expect(other.conn.voice()).toEqual([]);
    expect(a.conn.voice()).toHaveLength(1); // Ade, her party mate, still hears her
  });

  it('last words: a fallen soldier is heard from the death spot for a few seconds, then only by the dead', () => {
    const room = new Room({ dummies: false });
    const a = join(room, 'Ade');
    const near = join(room, 'Kemi');
    const deadToo = join(room, 'Seun');
    place(room, a.id, 10);
    place(room, near.id, 14);
    place(room, deadToo.id, 300);
    const pa = room.game.players[a.id]!;
    const ps = room.game.players[deadToo.id]!;
    for (const p of [pa, ps]) {
      p.alive = false;
      p.respawnTicks = 100_000;
    }
    room.tick(); // the room notices the deaths
    // the corpse moves (a blast, a fall): last words still come from where they fell
    pa.x = 200;
    near.conn.clear();
    room.receive(a.client, frame());
    expect(near.conn.voice().map((v) => [v.route, v.lastWords])).toEqual([[VoiceRoute.Proximity, true]]);
    expect(deadToo.conn.voice()).toEqual([]); // far from the death spot

    for (let i = 0; i < VOICE.lastWords * 60 + 1; i++) room.tick();
    for (const p of [pa, ps]) p.alive = false; // still dead (respawn is far off)
    near.conn.clear();
    room.receive(a.client, frame());
    expect(near.conn.voice()).toEqual([]); // never the living, once last words are over
    expect(deadToo.conn.voice().map((v) => v.route)).toEqual([VoiceRoute.Dead]); // the dead, any distance
    // the dead keep their party
    const st = decodeVoiceState(near.conn.sent.filter((b) => b[0] === MsgType.VoiceState).at(-1) ?? deadToo.conn.sent.filter((b) => b[0] === MsgType.VoiceState).at(-1)!);
    expect(st.peers.find((p) => p.id === a.id)!.flags & PEER_DEAD).toBe(PEER_DEAD);
  });

  it('each listener gets a few voices at once: the nearest, and the party before strangers', () => {
    const room = new Room({ dummies: false });
    const listener = join(room, 'Ade', { party: 'p_1' });
    place(room, listener.id, 0);
    const talkers = [1, 2, 3, 4, 5].map((d) => {
      const t = join(room, `T${d}`);
      place(room, t.id, d);
      return t;
    });
    for (const t of talkers) room.receive(t.client, frame());
    expect(listener.conn.voice()).toHaveLength(VOICE.maxSpeakers);
    expect(listener.conn.voice().map((v) => v.speaker)).not.toContain(talkers[4]!.id);
    // a party mate cuts in, far away
    const mate = join(room, 'Kemi', { party: 'p_1' });
    place(room, mate.id, 600);
    room.receive(mate.client, frame(VoiceChannel.Party));
    expect(listener.conn.voice().at(-1)).toMatchObject({ speaker: mate.id, route: VoiceRoute.Party });
  });

  it('a speaker has a frame budget; a bad frame is dropped, never a kick; a backed-up connection skips voice', () => {
    const room = new Room({ dummies: false });
    const a = join(room, 'Ade');
    const b = join(room, 'Kemi');
    place(room, a.id, 0);
    place(room, b.id, 1);
    for (let i = 0; i < 100; i++) room.receive(a.client, frame());
    expect(b.conn.voice().length).toBe(60);
    expect(room.voice.counters.rateLimited).toBe(40);
    for (let i = 0; i < 30; i++) room.tick(); // half a second refills half the budget
    room.receive(a.client, new Uint8Array([MsgType.VoiceUp, 0, 0, 0xff, 0xff]));
    expect(room.voice.counters.malformed).toBe(1);
    expect(a.conn.closed).toBeNull();
    b.conn.backlog = 64 * 1024;
    const before = b.conn.voice().length;
    room.receive(a.client, frame());
    expect(b.conn.voice().length).toBe(before);
  });

  it('listen-only and voice-off players send nothing; a v17 page plays on and never gets voice', () => {
    const room = new Room({ dummies: false });
    const old = join(room, 'Old', { version: 17, voice: null });
    expect(old.client.joined).toBe(true);
    const listenOnly = join(room, 'Ade', { voice: { mic: false } });
    const b = join(room, 'Kemi');
    for (const p of [old, listenOnly, b]) place(room, p.id, 1);
    room.receive(listenOnly.client, frame());
    expect(b.conn.voice()).toEqual([]);
    room.receive(b.client, frame());
    expect(listenOnly.conn.voice()).toHaveLength(1);
    expect(old.conn.sent.some((m) => m[0] === MsgType.VoiceDown || m[0] === MsgType.VoiceState)).toBe(false);
    // a v17 page asking for voice anyway is ignored
    room.receive(old.client, encodeCmd(CmdKind.Voice, JSON.stringify(ON)));
    room.receive(b.client, frame());
    expect(old.conn.sent.some((m) => m[0] === MsgType.VoiceDown)).toBe(false);
    // and something older than v17 is still turned away
    const ancient = new FakeConn();
    room.receive(room.connect(ancient), hello('Ancient', 16));
    expect(ancient.closed?.code).toBe(4001);
  });

  it("VOICE_STATE tells each player the others' voice, mic, party and mute, and when someone can't decode Opus", () => {
    const room = new Room({ dummies: false });
    const a = join(room, 'Ade', { party: 'p_1' });
    const mate = join(room, 'Kemi', { party: 'p_1', voice: { mic: false } });
    const other = join(room, 'Seun', { voice: { opus: false } });
    room.receive(a.client, encodeCmd(CmdKind.Voice, JSON.stringify({ ...ON, mute: [other.id] })));
    for (let i = 0; i < 12; i++) room.tick();
    const last = a.conn.sent.filter((b) => b[0] === MsgType.VoiceState).at(-1)!;
    const st = decodeVoiceState(last);
    expect(st.fallback).toBe(true);
    const flags = (id: number) => st.peers.find((p) => p.id === id)!.flags;
    expect(flags(mate.id)).toBe(PEER_VOICE | PEER_PARTY);
    expect(flags(other.id)).toBe(PEER_VOICE | PEER_MIC | PEER_MUTED);
  });
});
