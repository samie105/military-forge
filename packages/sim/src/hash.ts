/**
 * State hash over every simulated field, as fixed-point integers. Used by golden replays and,
 * later, by the client/server desync telemetry (docs/02 §15.6).
 */
import type { Game } from './game';

export class Fnv32 {
  h = 0x811c9dc5;

  int(v: number): void {
    const x = v | 0;
    for (let i = 0; i < 32; i += 8) {
      this.h ^= (x >>> i) & 0xff;
      this.h = Math.imul(this.h, 0x01000193);
    }
  }

  fx(v: number): void {
    this.int(Math.round(v * 1024));
  }

  bool(v: boolean): void {
    this.int(v ? 1 : 0);
  }
}

export function hashGame(game: Game): number {
  const f = new Fnv32();
  f.int(game.tick);
  for (const p of game.players) {
    if (!p) {
      f.int(-1);
      continue;
    }
    f.int(p.id);
    f.bool(p.alive);
    f.int(p.respawnTicks);
    f.fx(p.x);
    f.fx(p.y);
    f.fx(p.vx);
    f.fx(p.vy);
    f.bool(p.grounded);
    f.bool(p.crouched);
    f.bool(p.jetting);
    f.int(p.jetTicks);
    f.fx(p.fuel);
    f.int(p.fuelRegenDelay);
    f.int(p.downHeldTicks);
    f.int(p.dropTicks);
    f.int(p.facing);
    f.int(p.input.aim);
    f.fx(p.hp);
    f.int(p.regenDelay);
    for (const w of p.weapons) {
      f.int(w.def);
      f.int(w.mag);
      f.int(w.reserve);
      f.fx(w.cooldown);
      f.int(w.reloadTicks);
      f.fx(w.bloom);
    }
    f.int(p.active);
    f.bool(p.dual);
    f.int(p.swapTicks);
    f.int(p.frags);
    f.int(p.throwCooldown);
    f.int(p.shotCounter);
    f.int(p.kills);
    f.int(p.deaths);
    f.int(p.botDir);
    // Fields added after the first golden replays are hashed only when they differ from their
    // resting value, so the existing goldens (none of which swing a melee weapon) keep their hashes.
    if (p.meleeTicks !== 0) f.int(p.meleeTicks);
    // dash (docs/02 §21): likewise only away from rest (tagged), so replays that never dash keep their hashes
    if (p.dashTicks !== 0 || p.dashCooldown !== 0 || p.airDashUsed) {
      f.int(0xda54);
      f.int(p.dashTicks);
      f.int(p.dashTicks > 0 ? p.dashDir : 0); // the direction only matters during a burst
      f.int(p.dashCooldown);
      f.bool(p.airDashUsed);
    }
  }
  for (const g of game.grenades) {
    if (!g.alive) continue;
    f.int(g.id);
    f.int(g.owner);
    f.fx(g.x);
    f.fx(g.y);
    f.fx(g.vx);
    f.fx(g.vy);
    f.int(g.fuse);
  }
  return f.h >>> 0;
}
