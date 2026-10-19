/**
 * State hash over every simulated field, as fixed-point integers. Used by golden replays and,
 * later, by the client/server desync telemetry (docs/02 §15.6).
 */
import { MINE, PROJECTILE_TYPE_BASE } from '@military-forge/content';
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

  /** A field added after the first goldens: hashed (with a tag) only when it isn't 0, so old hashes hold. */
  opt(tag: number, v: number): void {
    if (v === 0) return;
    this.int(tag);
    this.int(v);
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
    f.int(p.grenadeCounts[0]!); // the frag count (the only type before grenade variety)
    f.int(p.throwCooldown);
    f.int(p.shotCounter);
    f.int(p.kills);
    f.int(p.deaths);
    f.int(p.botDir);
    // Fields added after the first golden replays are hashed only when they differ from their
    // resting value, so the existing goldens (none of which swing a melee weapon) keep their hashes.
    if (p.meleeTicks !== 0) f.int(p.meleeTicks);
    // dash (docs/02 §21): likewise only away from rest (tagged), so replays that never dash keep their hashes
    if (p.dashTicks !== 0 || p.dashGap !== 0 || p.dashChainTicks !== 0 || p.dashChain !== 0) {
      f.int(0xda54);
      f.int(p.dashTicks);
      f.int(p.dashTicks > 0 ? p.dashDir : 0); // the direction and strength only matter during a burst
      f.int(p.dashGap);
      f.int(p.dashChain);
      f.int(p.dashChainTicks);
      f.int(p.dashTicks > 0 ? p.dashPower : 0);
    }
    // riot shield: likewise (tagged); its other fields rest whenever it has no HP (shield.ts)
    if (p.shieldHp !== 0) {
      f.int(0x5e1d);
      f.fx(p.shieldHp);
      f.bool(p.shieldStowed);
      f.int(p.shieldTicks);
    }
    // grenade variety: other types carried, the selection, status effects (tagged: they're optional)
    for (let i = 1; i < p.grenadeCounts.length; i++) f.opt(0x100 + i, p.grenadeCounts[i]!);
    f.opt(0x110, p.grenadeType);
    f.opt(0x111, p.blindTicks);
    f.opt(0x112, p.blindFade);
    f.opt(0x113, p.gasTicks);
    f.opt(0x114, p.jetDisabledTicks);
    f.opt(0x115, p.burnTicks);
    f.opt(0x116, p.burnBy + 1);
    // a minigun's spin and a burst in progress (the owner's more guns): hashed only when set
    for (let i = 0; i < 2; i++) {
      f.opt(0x130 + 2 * i, p.weapons[i]!.spin);
      f.opt(0x131 + 2 * i, p.weapons[i]!.burst);
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
    f.opt(0x120, g.type);
    f.opt(0x121, g.state);
    f.opt(0x122, Math.round(g.hp * 1024));
    if (g.type === MINE.index || g.type >= PROJECTILE_TYPE_BASE) f.opt(0x123, g.born); // mines (a new one retires the oldest) and projectiles (a flame grows): frags hash as before
    f.opt(0x124, g.weapon + 1);
    f.opt(0x125, g.hits);
  }
  // clouds: nothing hashed when there are none (every golden before grenade variety)
  for (const c of game.clouds) {
    if (!c.alive) continue;
    f.int(0x130 + c.id);
    f.int(c.type);
    f.int(c.owner);
    f.fx(c.x);
    f.fx(c.y);
    f.int(c.age);
  }
  // pickups: nothing at all without spawners or drops (pickups off, or a map without spawners)
  for (const k of game.pickups) {
    if (!k.alive) continue;
    f.int(k.id);
    f.int(k.def);
    f.fx(k.x);
    f.fx(k.y);
    f.fx(k.hp);
    f.int(k.ttl);
    f.int(k.spawner);
    f.int(k.spot);
    // a weapon's ammo (more guns): hashed only on weapon items
    f.opt(0x140, k.mag);
    f.opt(0x141, k.reserve);
    f.opt(0x142, Math.round(k.readyTick * 1024));
  }
  for (const s of game.spawners) {
    f.int(s.timer);
    f.int(s.active);
  }
  return f.h >>> 0;
}
