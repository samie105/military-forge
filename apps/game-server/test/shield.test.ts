/**
 * The riot shield online (protocol v9): its carry state rides in the local block, so a carrier who
 * raises and slings it, and swaps to a two-handed weapon that slings it, predicts exactly.
 */
import { HAMMER, K47, RIOT_SHIELD } from '@military-forge/content';
import { symmetric } from '@military-forge/netcode';
import { Btn, giveShield } from '@military-forge/sim';
import { describe, expect, it } from 'vitest';
import { movement, simulate } from './netsimHarness';

describe('riot shield online', () => {
  it('a carrier toggling and swapping predicts exactly (clean LAN): no mispredictions after it got the shield', () => {
    let given = false;
    let sawUp = 0;
    let sawSlung = 0;
    const r = simulate(symmetric(20, 0, 1), 14, {
      warmupSeconds: 4,
      room: { dummies: false, aoi: false },
      // the server hands client 0 a shield (as a pickup would) and a two-handed second weapon, in warm-up
      beforeTick: (room, nets) => {
        const p = nets[0]!.myId >= 0 ? room.game.players[nets[0]!.myId] : null;
        if (!given && p && room.game.tick > 120) {
          room.game.setLoadout(p, [HAMMER.index, K47.index]);
          giveShield(p, RIOT_SHIELD.hp);
          given = true;
        }
      },
      afterTick: (room, nets) => {
        const p = nets[0]!.myId >= 0 ? room.game.players[nets[0]!.myId] : null;
        if (!p || room.game.tick < 300) return;
        if (p.shieldTicks > 0) sawUp++;
        else if (p.shieldHp > 0) sawSlung++;
      },
      input: (k, nowMs, _net, out) => {
        out.buttons = movement(nowMs, k * 1700);
        if (k !== 0) return;
        if (nowMs % 900 < 17) out.buttons |= Btn.Shield; // raise / sling
        if (nowMs % 2300 < 17) out.buttons |= Btn.Swap; // Hammer ↔ K-47 (which slings it)
      },
    });
    const me = r.clients[0]!;
    expect(given).toBe(true);
    expect(me.net.predictor!.player.shieldHp).toBe(RIOT_SHIELD.hp);
    expect(sawUp).toBeGreaterThan(60);
    expect(sawSlung).toBeGreaterThan(60);
    expect(me.mispredictions).toBe(0);
    expect(me.corrections).toBe(0);
    // the other client sees it: carried (slung, raising or up)
    const seen = r.clients[1]!.net.snapshots.at(-1)!.msg.players.find((p) => p.id === me.net.myId)!;
    expect(seen.shield).not.toBe('none');
  });
});
