/**
 * Launchers and the flamethrower through the real Room and NetClients (protocol v12): the shooter's
 * ammo, charge and cooldowns are predicted exactly (no corrections), its projectiles arrive in
 * snapshots like grenades, and a burning player's burn is predicted from its local block.
 */
import { DRAGON, PROJECTILE_TYPE_BASE, RIPPER, ROCKET, THUMPER } from '@military-forge/content';
import { symmetric } from '@military-forge/netcode';
import { Btn } from '@military-forge/sim';
import { describe, expect, it } from 'vitest';
import type { Room } from '../src/room';
import { simulate } from './netsimHarness';

describe('launchers online (protocol v12)', () => {
  it('a rocket and a charged blade: predicted without a correction; the rocket reaches the other client', () => {
    let rocketsSeen = 0;
    let serverPlayers: Room['game']['players'] = [];
    let charged = 0;
    const ammo: { server: number[][]; client: number[][] } = { server: [], client: [] };
    const r = simulate(symmetric(60, 0, 1), 14, {
      warmupSeconds: 3,
      room: { dummies: false, seed: 5 },
      input: (k, now, _net, out) => {
        out.aim = 0;
        out.buttons = 0;
        if (k !== 0) return;
        if (now >= 5000 && now < 5050) out.buttons = Btn.Fire; // a rocket
        if (now >= 7000 && now < 7050) out.buttons = Btn.Swap; // the Ripper
        if (now >= 8500 && now < 9100) out.buttons = Btn.Fire; // charge it: a blade
      },
      beforeTick: (room, nets) => {
        const game = room.game;
        serverPlayers = game.players;
        const a = game.players[nets[0]!.myId];
        const b = game.players[nets[1]!.myId];
        if (!a || !b) return;
        if (game.tick === 120) {
          game.setLoadout(a, [THUMPER.index, RIPPER.index]);
          // on the open floor between the tower (142–144) and the range's cover (154), 8 m apart
          Object.assign(a, { x: 145, y: 0, vx: 0, vy: 0 });
          Object.assign(b, { x: 153, y: 0, vx: 0, vy: 0 });
        }
      },
      afterTick: (room, nets) => {
        const newest = nets[1]!.snapshots.at(-1)?.msg;
        if (newest?.grenades.some((g) => g.type === PROJECTILE_TYPE_BASE + ROCKET.index)) rocketsSeen++;
        const me = nets[0]!.predictor?.player;
        if (me && me.weapons[me.active]!.spin > 0) charged++;
        // a moment after the blade leaves (before it comes back off the cover for its owner)
        if (room.game.tick === 575 && me) {
          const server = room.game.players[me.id]!;
          ammo.server = server.weapons.map((w) => [w.def, w.mag, w.reserve]);
          ammo.client = me.weapons.map((w) => [w.def, w.mag, w.reserve]);
        }
      },
    });
    const [c0] = r.clients;
    expect(ammo.server).toEqual([
      [THUMPER.index, THUMPER.mag - 1, THUMPER.reserve],
      [RIPPER.index, 0, RIPPER.reserve], // the blade gone, its reload under way
    ]);
    expect(ammo.client).toEqual(ammo.server); // predicted to the round (the client is ahead of the server: it's already there)
    expect(charged).toBeGreaterThan(20); // the charge was predicted
    expect(rocketsSeen).toBeGreaterThan(3);
    expect(serverPlayers[r.clients[1]!.net.myId]!.deaths).toBeGreaterThanOrEqual(1); // the rocket killed it
    expect(c0!.corrections).toBe(0);
  });

  it('flames set the other player burning; its client predicts the burn from the local block', () => {
    let burning = 0;
    const r = simulate(symmetric(60, 0, 1), 10, {
      warmupSeconds: 3,
      room: { dummies: false, seed: 5 },
      input: (k, now, _net, out) => {
        out.aim = 0;
        out.buttons = k === 0 && now >= 5000 && now < 5200 ? Btn.Fire : 0;
      },
      beforeTick: (room, nets) => {
        const game = room.game;
        const a = game.players[nets[0]!.myId];
        const b = game.players[nets[1]!.myId];
        if (!a || !b || game.tick !== 120) return;
        game.setLoadout(a, [DRAGON.index, THUMPER.index]);
        Object.assign(a, { x: 146, y: 0, vx: 0, vy: 0 });
        Object.assign(b, { x: 149, y: 0, vx: 0, vy: 0 });
      },
      afterTick: (_room, nets) => {
        const b = nets[1]!.predictor?.player;
        if (b && b.burnTicks > 0) burning++;
      },
    });
    expect(burning).toBeGreaterThan(60); // the victim's client counted its burn down too
    expect(r.clients[0]!.corrections).toBe(0);
    expect(r.clients[1]!.corrections).toBe(0); // flames don't push: only its HP is the server's
  });
});
