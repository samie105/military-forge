/** The admin page's fields (admin.ts): ranges, clamping, applying and restoring, presets, wire limits. */
import { afterEach, describe, expect, it } from 'vitest';
import {
  ADMIN_FIELDS,
  ADMIN_PRESETS,
  ARMORY_RESPAWN_RANGE,
  FRAG,
  K47,
  ROCKET,
  SPAWN_POOLS,
  THUMPER,
  TUNING_GROUPS,
  adminField,
  adminTuning,
  applyContentOverrides,
  clampAdmin,
  movementTestMap,
  weapons,
} from '../src';

afterEach(() => applyContentOverrides({}, true));

const max = (key: string) => adminField(key)!.max;

describe('admin fields', () => {
  it('unique keys; defaults inside their ranges; content fields read their live value', () => {
    expect(new Set(ADMIN_FIELDS.map((f) => f.key)).size).toBe(ADMIN_FIELDS.length);
    for (const f of ADMIN_FIELDS) {
      expect(f.min, f.key).toBeLessThanOrEqual(f.def);
      expect(f.def, f.key).toBeLessThanOrEqual(f.max);
      expect(f.step, f.key).toBeGreaterThan(0);
      if (f.scope === 'content') expect(f.get!(), f.key).toBe(f.def);
    }
  });

  it('cover the tuning panel, every gun and every grenade type', () => {
    for (const g of TUNING_GROUPS) for (const t of g.fields) expect(adminField(`tuning.${t.key}`), t.key).toBeDefined();
    for (const w of weapons) expect(adminField(`weapon.${w.id}.interval`), w.id).toBeDefined();
    for (const id of ['frag', 'smoke', 'gas', 'flash', 'mine', 'emp']) expect(adminField(`grenade.${id}.fuse`), id).toBeDefined();
    for (const key of ['pickups.crateRespawnMin', 'pickups.armoryRespawn', 'pickups.powerWeight', 'bots.count', 'bots.level', 'match.timeLimit', 'match.killLimit']) expect(adminField(key), key).toBeDefined();
  });

  it('never past what the protocol carries', () => {
    for (const w of weapons) {
      if (adminField(`weapon.${w.id}.mag`)) expect(max(`weapon.${w.id}.mag`), w.id).toBeLessThanOrEqual(255); // local block mag u8
      if (adminField(`weapon.${w.id}.reserve`)) expect(max(`weapon.${w.id}.reserve`)).toBeLessThanOrEqual(1023); // u10
      if (adminField(`weapon.${w.id}.reload`)) expect(max(`weapon.${w.id}.reload`) * 60).toBeLessThanOrEqual(1023); // reloadTicks u10
      expect(max(`weapon.${w.id}.equip`) * 60, w.id).toBeLessThanOrEqual(255); // swapTicks u8
      // a swing's ticks: meleeTicks u6; a gun's cooldown: 18 bits of 1/1024 tick
      expect(max(`weapon.${w.id}.interval`) * 60, w.id).toBeLessThanOrEqual(w.fireMode === 'melee' ? 63 : 255);
      if (adminField(`weapon.${w.id}.holdRepeat`)) expect(max(`weapon.${w.id}.holdRepeat`) * 60).toBeLessThanOrEqual(127); // ticksSinceShot u7
      if (adminField(`weapon.${w.id}.charge`)) expect(max(`weapon.${w.id}.charge`) * 60).toBeLessThanOrEqual(255); // spin u8
      if (adminField(`weapon.${w.id}.projectileLife`)) expect(max(`weapon.${w.id}.projectileLife`) * 60).toBeLessThanOrEqual(511); // fuse u9
    }
    for (const id of ['frag', 'smoke', 'gas', 'flash', 'mine', 'emp']) expect(max(`grenade.${id}.fuse`) * 60, id).toBeLessThanOrEqual(511);
    expect((max('grenade.flash.white') + max('grenade.flash.fadeOut')) * 60).toBeLessThanOrEqual(255); // blindTicks u8
    expect(max('grenade.flash.fadeOut') * 60).toBeLessThanOrEqual(127); // blindFade u7
    expect(max('grenade.smoke.duration') * 60).toBeLessThanOrEqual(1023); // cloud age u10
    expect(max('grenade.emp.jetDisable') * 60).toBeLessThanOrEqual(255); // jetDisabledTicks u8
    expect(max('weapon.dragon.burnSeconds') * 60).toBeLessThanOrEqual(127); // burnTicks u7
    // the tuning panel's fields too (local block)
    expect(max('tuning.dashBurstTicks')).toBeLessThanOrEqual(63); // dashTicks u6
    expect(max('tuning.dashGap') * 60).toBeLessThanOrEqual(63); // dashGap u6 (v14)
    expect(max('tuning.dashChainWindow') * 60).toBeLessThanOrEqual(127); // dashChainTicks u7 (v14)
    expect(max('tuning.jetKickTicks')).toBeLessThanOrEqual(63); // jetTicks u6
    expect(max('tuning.fuelMax')).toBeLessThanOrEqual(1023); // fuel: 20 bits of 1/1024
    expect(Math.max(max('tuning.fuelRegenDelayGround'), max('tuning.fuelRegenDelayAir')) * 60).toBeLessThanOrEqual(1023); // fuelRegenDelay u10
    expect(max('tuning.respawnDelay') * 60).toBeLessThanOrEqual(1023); // respawnTicks u10
    expect(max('tuning.healthRegenDelay') * 60).toBeLessThanOrEqual(1023); // regenDelay u10
  });
});

describe('admin values', () => {
  it('clamped into range, whole-number fields rounded; unknown keys, non-numbers and defaults dropped', () => {
    expect(
      clampAdmin({
        'weapon.k47.damage': 9999,
        'weapon.k47.mag': 12.6,
        'tuning.gravity': -5,
        'weapon.k47.spread': K47.spread.base, // the default: not a change
        'nope.nothing': 3,
        'weapon.buzz.damage': 'lots',
        'weapon.buzz.interval': Number.NaN,
      }),
    ).toEqual({ 'weapon.k47.damage': 250, 'weapon.k47.mag': 13, 'tuning.gravity': 2 });
    expect(clampAdmin('not an object')).toEqual({});
    expect(clampAdmin([1, 2])).toEqual({});
    // the crate respawn's ends stay in order
    expect(clampAdmin({ 'pickups.crateRespawnMin': 30, 'pickups.crateRespawnMax': 10 })).toEqual({ 'pickups.crateRespawnMin': 30, 'pickups.crateRespawnMax': 30 });
  });

  it('applied in place and taken back by {}: weapons, projectiles, grenades; server fields only with `server`', () => {
    applyContentOverrides({ 'weapon.k47.damage': 14, 'weapon.thumper.damage': 60, [`grenade.${FRAG.id}.fuse`]: 3, 'pickups.armoryRespawn': 9 });
    expect([K47.damage, ROCKET.damage, THUMPER.damage, FRAG.fuse]).toEqual([14, 60, 60, 3]);
    expect(ARMORY_RESPAWN_RANGE).toEqual([2, 2]); // a client doesn't run pickups
    applyContentOverrides({ 'pickups.armoryRespawn': 9, 'pickups.powerWeight': 0, 'pickups.crateRespawnMin': 3, 'pickups.crateRespawnMax': 5 }, true);
    expect(ARMORY_RESPAWN_RANGE).toEqual([9, 9]);
    expect(SPAWN_POOLS.weapons!.items.filter((i) => i.weight === 0).length).toBeGreaterThan(0);
    expect(movementTestMap.spawners!.find((s) => s.pool === 'weapons')!.respawn).toEqual([3, 5]);
    applyContentOverrides({}, true);
    expect([K47.damage, ROCKET.damage, FRAG.fuse, ARMORY_RESPAWN_RANGE[0]]).toEqual([adminField('weapon.k47.damage')!.def, 100, adminField(`grenade.${FRAG.id}.fuse`)!.def, 2]);
    expect(movementTestMap.spawners!.find((s) => s.pool === 'weapons')!.respawn).toEqual([12, 18]);
  });

  it('tuning keys come out as a Tuning patch', () => {
    expect(adminTuning({ 'tuning.gravity': 12, 'tuning.fuelMax': 999, 'weapon.k47.damage': 3 })).toEqual({ gravity: 12, fuelMax: 300 });
  });

  it('presets: Classic is the shipped game; Floaty and Chaos are known keys inside their ranges', () => {
    expect(ADMIN_PRESETS.classic).toEqual({});
    for (const name of ['floaty', 'chaos'] as const) {
      const p = ADMIN_PRESETS[name];
      expect(Object.keys(p).length, name).toBeGreaterThan(5);
      expect(clampAdmin(p), name).toEqual(p);
    }
  });
});
