/**
 * The owner's admin page, server side (admin.ts): only the run's token changes anything, values are
 * clamped, every room takes them at once and tells its clients, late joiners and reconnects get
 * them, and prediction keeps up after a weapon and tuning change (netsim).
 */
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as joinPath } from 'node:path';
import { K47, THUMPER, adminField, weapons } from '@military-forge/content';
import { symmetric } from '@military-forge/netcode';
import { MsgType, decodeMessage, encodeHello, type Message, type OverridesMsg, type TuningMsg, type WelcomeMsg } from '@military-forge/protocol';
import { Btn } from '@military-forge/sim';
import { afterEach, describe, expect, it } from 'vitest';
import { adminJson, loadAdminDefaults, setAdminValues, startAdminServer, tokenOk } from '../src/admin';
import { Room, type ClientConn } from '../src/room';
import { simulate } from './netsimHarness';

afterEach(() => {
  setAdminValues({});
});

class FakeConn implements ClientConn {
  readonly sent: Uint8Array[] = [];
  closed: { code: number; reason: string } | null = null;
  onClose: (() => void) | null = null;
  send(bytes: Uint8Array) {
    this.sent.push(bytes);
  }
  close(code: number, reason: string) {
    this.closed = { code, reason };
    this.onClose?.();
  }
  bufferedAmount() {
    return 0;
  }
  last<T extends Message['type']>(type: T): Extract<Message, { type: T }> | undefined {
    return this.sent
      .map((b) => decodeMessage(b))
      .filter((m): m is Extract<Message, { type: T }> => m.type === type)
      .at(-1);
  }
}

function join(room: Room, name: string, resumeToken = '') {
  const conn = new FakeConn();
  const client = room.connect(conn);
  room.receive(client, encodeHello(name, resumeToken));
  return { conn, client, welcome: conn.last(MsgType.Welcome) as WelcomeMsg };
}

const TOKEN = 'a-run-secret-of-24-chars';

describe('admin API: the token', () => {
  it('nothing without the run\'s token; with it, the state, and values are clamped', async () => {
    const dir = mkdtempSync(joinPath(tmpdir(), 'mf-admin-'));
    const file = joinPath(dir, 'nested', 'admin-defaults.json');
    const server = await startAdminServer({ token: TOKEN, port: 0, defaultsFile: file });
    const url = (path: string) => `http://127.0.0.1:${server.port}/admin/api${path}`;
    const call = (path: string, init: RequestInit = {}) => fetch(url(path), init);
    try {
      expect((await call('/state')).status).toBe(401);
      expect((await call('/state', { headers: { Authorization: 'Bearer wrong-token-of-24-chars!' } })).status).toBe(401);
      expect((await call('/state', { headers: { Authorization: TOKEN } })).status).toBe(401); // not a Bearer
      expect((await call('/values', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{"weapon.k47.damage":40}' })).status).toBe(401);
      expect(K47.damage).toBe(adminField('weapon.k47.damage')!.def); // and nothing changed

      const auth = { Authorization: `Bearer ${TOKEN}` };
      const state = (await (await call('/state', { headers: auth })).json()) as { fields: { key: string }[]; values: object; presets: string[] };
      expect(state.fields.length).toBeGreaterThan(200);
      expect(state.presets).toEqual(['classic', 'floaty', 'chaos']);
      expect((await call('/values', { method: 'PUT', headers: auth, body: '{}' })).status).toBe(415); // JSON only
      // too big: 413, nothing changed
      const huge = JSON.stringify({ 'weapon.k47.damage': 30, pad: 'x'.repeat(70 * 1024) });
      expect((await call('/values', { method: 'PUT', headers: { ...auth, 'Content-Type': 'application/json' }, body: huge })).status).toBe(413);
      expect(K47.damage).toBe(adminField('weapon.k47.damage')!.def);
      const put = await call('/values', { method: 'PUT', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ 'weapon.k47.damage': 9999, 'tuning.gravity': 1, bogus: 1 }) });
      expect(put.status).toBe(200);
      expect(((await put.json()) as { values: object }).values).toEqual({ 'weapon.k47.damage': 250, 'tuning.gravity': 2 });
      expect(K47.damage).toBe(250);
      // a preset, then saved as the defaults (the next run loads them)
      const chaos = await call('/preset/chaos', { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: '{}' });
      expect(chaos.status).toBe(200);
      expect(THUMPER.interval).toBeLessThan(1);
      expect((await call('/save', { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: '{}' })).status).toBe(200);
      expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(JSON.parse(adminJson()));
      expect(loadAdminDefaults(file)).toEqual(JSON.parse(adminJson()));
      expect(loadAdminDefaults(joinPath(dir, 'missing.json'))).toEqual({});
    } finally {
      server.close();
    }
  });

  it('the token check is exact and refuses short tokens', () => {
    expect(tokenOk(`Bearer ${TOKEN}`, TOKEN)).toBe(true);
    expect(tokenOk(`Bearer ${TOKEN}x`, TOKEN)).toBe(false);
    expect(tokenOk(undefined, TOKEN)).toBe(false);
    expect(() => startAdminServer({ token: 'short', port: 0 })).toThrow();
  });
});

describe('admin values reach every room and every client', () => {
  it('a room takes them at once (tuning, weapons) and tells its clients; late joiners and reconnects get them in WELCOME', () => {
    const room = new Room({ dummies: false });
    const a = join(room, 'Ade');
    expect(a.welcome.overridesJson).toBe('{}');
    setAdminValues({ 'tuning.gravity': 12, 'weapon.k47.damage': 20 });
    expect(room.game.tuning.gravity).toBe(12);
    expect(weapons[K47.index]!.damage).toBe(20);
    expect(JSON.parse((a.conn.last(MsgType.Tuning) as TuningMsg).tuningJson).gravity).toBe(12);
    expect(JSON.parse((a.conn.last(MsgType.Overrides) as OverridesMsg).overridesJson)).toEqual({ 'tuning.gravity': 12, 'weapon.k47.damage': 20 });
    // a late joiner
    const b = join(room, 'Kemi');
    expect(JSON.parse(b.welcome.overridesJson)).toEqual({ 'tuning.gravity': 12, 'weapon.k47.damage': 20 });
    expect(JSON.parse(b.welcome.tuningJson).gravity).toBe(12);
    // a reconnect
    a.conn.close(1006, 'gone');
    room.disconnect(a.client);
    const back = join(room, 'Ade', a.welcome.sessionToken);
    expect(back.welcome.resumed).toBe(true);
    expect(JSON.parse(back.welcome.overridesJson)).toEqual({ 'tuning.gravity': 12, 'weapon.k47.damage': 20 });
    // a room made later starts with them; Classic takes everything back
    expect(new Room({ dummies: false }).game.tuning.gravity).toBe(12);
    setAdminValues({});
    expect([room.game.tuning.gravity, weapons[K47.index]!.damage]).toEqual([adminField('tuning.gravity')!.def, adminField('weapon.k47.damage')!.def]);
  });

  it('bots and match limits: the admin\'s where set, else the room\'s own', () => {
    const room = new Room({ dummies: false, match: { timeLimit: 300, killLimit: 20 } });
    join(room, 'Ade');
    setAdminValues({ 'bots.count': 4, 'bots.level': 2, 'match.killLimit': 7 });
    room.tick();
    expect(room.bots).toHaveLength(3);
    expect(room.bots.every((b) => b.isBot)).toBe(true);
    setAdminValues({});
    room.tick();
    expect(room.bots).toHaveLength(0);
  });
});

describe('prediction after an admin change (netsim)', () => {
  it('a weapon and tuning change mid-game: no corrections once it has landed', () => {
    let atChange = -1;
    let correctionsAfter = 0;
    const r = simulate(symmetric(60, 0, 1), 12, {
      warmupSeconds: 3,
      room: { dummies: false, seed: 5 },
      input: (k, now, _net, out) => {
        out.aim = 0;
        // run back and forth, firing the K-47 (slot 1 of the default loadout is the Buzz: swap first)
        const phase = Math.floor(now / 900) % 2;
        out.buttons = k === 0 ? (phase ? Btn.Right : Btn.Left) | (now % 400 < 200 ? Btn.Fire : 0) : 0;
      },
      beforeTick: (room, nets) => {
        const a = room.game.players[nets[0]!.myId];
        if (!a) return;
        if (room.game.tick === 120) room.game.setLoadout(a, [K47.index, THUMPER.index]);
        if (room.game.tick === 420) {
          setAdminValues({ 'weapon.k47.interval': 0.07, 'weapon.k47.recoilPushGround': 3, 'weapon.k47.moveSpeedMul': 0.8, 'tuning.walkMax': 6.5, 'tuning.groundAccel': 70 });
          atChange = nets[0]!.predictor!.stats.corrections;
        }
        // a second after the change landed
        if (room.game.tick === 540) correctionsAfter = nets[0]!.predictor!.stats.corrections;
      },
    });
    expect(atChange).toBeGreaterThanOrEqual(0);
    const final = r.clients[0]!.net.predictor!.stats.corrections;
    expect(final - correctionsAfter).toBe(0); // from a second after the change to the end: none
    expect(r.clients[0]!.net.predictor!.game.tuning.walkMax).toBe(6.5);
  });
});
