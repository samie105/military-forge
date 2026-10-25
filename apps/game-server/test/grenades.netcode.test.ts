/**
 * Grenade variety through the real Room and NetClients (protocol v8): the belt is predicted
 * exactly, clouds arrive in snapshots, gas damage only corrects HP, and smoke hides a player
 * from the other client (the AOI's anti-wallhack).
 */
import { GAS, SMOKE } from '@military-forge/content';
import { symmetric } from '@military-forge/netcode';
import { Btn, addGrenades, spawnCloud } from '@military-forge/sim';
import { describe, expect, it } from 'vitest';
import type { Room } from '../src/room';
import { simulate } from './netsimHarness';

const DOWN = 49152; // aim straight down (u16, three quarters of a turn)

describe('grenade variety online (protocol v8)', () => {
  it('predicts the belt, sends clouds, and keeps a player hidden in smoke from the other client', () => {
    const seen: { before: boolean[]; hidden: boolean[] } = { before: [], hidden: [] };
    let clouds = 0;
    let serverPlayers: Room['game']['players'] = [];
    const r = simulate(symmetric(60, 0, 1), 15, {
      warmupSeconds: 3,
      room: { dummies: false, seed: 5 },
      input: (k, now, _net, out) => {
        out.aim = DOWN;
        out.buttons = 0;
        if (k !== 0) return;
        if (now >= 6000 && now < 6100) out.buttons = Btn.CycleGrenade; // frag → smoke
        if (now >= 6400 && now < 6500) out.buttons = Btn.CycleGrenade; // smoke → gas
        if (now >= 7000 && now < 7100) out.buttons = Btn.Grenade; // gas at our feet
      },
      beforeTick: (room, nets) => {
        const game = room.game;
        serverPlayers = game.players;
        const a = game.players[nets[0]!.myId];
        const b = game.players[nets[1]!.myId];
        if (!a || !b) return;
        if (game.tick === 240) {
          // side by side on the flat by the range, 3.5 m apart; two gas grenades for the first
          Object.assign(a, { x: 150, y: 0, vx: 0, vy: 0 });
          Object.assign(b, { x: 146.5, y: 0, vx: 0, vy: 0 });
          addGrenades(a, GAS.index, 2);
        }
        if (game.tick === 600) spawnCloud(game, SMOKE.index, 150, 0, b.id);
      },
      afterTick: (room, nets) => {
        const t = room.game.tick;
        const a = nets[0]!.myId;
        const newest = nets[1]!.snapshots.at(-1)?.msg;
        if (!newest) return;
        const bSeesA = newest.players.some((p) => p.id === a);
        if (t > 500 && t < 600) seen.before.push(bSeesA);
        if (t > 660 && t < 720) seen.hidden.push(bSeesA);
        clouds = Math.max(clouds, nets[0]!.snapshots.at(-1)?.msg.clouds.length ?? 0);
      },
    });
    const [c0] = r.clients;
    const me = c0!.net.predictor!.player;
    const onServer = serverPlayers[me.id]!;
    // the belt the client predicted is the server's: 3 of each, then gas x2 given (3 → 5, its cap), one thrown
    expect(onServer.grenadeCounts[GAS.index]).toBe(GAS.maxCount - 1);
    expect(onServer.grenadeType).toBe(GAS.index);
    expect(me.grenadeCounts).toEqual(onServer.grenadeCounts);
    expect(me.grenadeType).toBe(onServer.grenadeType);
    // gas and smoke both reached client 0; it coughed, and it never had to be moved for it
    expect(clouds).toBe(2);
    expect(c0!.corrections).toBe(0);
    expect(c0!.mispredictions).toBeGreaterThan(0); // HP from the gas, server-authoritative
    // the other client saw us until the smoke hid us completely
    expect(seen.before.length).toBeGreaterThan(50);
    expect(seen.before.every(Boolean)).toBe(true);
    expect(seen.hidden.length).toBeGreaterThan(30);
    expect(seen.hidden.some(Boolean)).toBe(false);
  });
});
