import { describe, expect, it } from 'vitest';
import compiledStreetMarket from '../../../art/maps/street_market/street_market.map.json';
import committedSchema from '../schema/map.schema.json';
import stormFrontJson from '../src/maps/stormFront.map.json';
import {
  CROUCHED_HITBOXES,
  DEFAULT_LOADOUT,
  DEMO_MAPS,
  EVENT_KINDS,
  FRAG,
  GRENADE_TYPES,
  MODIFIER_FIELDS,
  RIOT_SHIELD,
  SPAWN_POOLS,
  STANDING_HITBOXES,
  TUNING_GROUPS,
  ZONE_KINDS,
  grenades,
  spawnGrenades,
  changedTuning,
  createTuning,
  defaultTuning,
  limitTuning,
  mapJsonSchema,
  maps,
  movementTestMap,
  parseMapJson,
  pickupById,
  pickups,
  zonePoints,
  shotDamage,
  streetMarketMap,
  timeToKill,
  tuningHash,
  weapons,
  type MapOneWay,
  type WeaponClass,
} from '../src';

/** docs/03 §6 time-to-kill sheet (100 HP, every shot hits): [body shots, s, head shots, s]. */
const TTK_SHEET: Record<string, [number, number, number | null, number | null]> = {
  hammer44: [4, 1.8, 3, 1.2],
  buzz: [15, 1.4, 10, 0.9],
  k47: [10, 0.9, 7, 0.6],
  widow: [2, 0.8, 1, 0],
  breacher: [1, 0, null, null], // all 5 pellets, inside ~4 m
  machete: [1, 0, null, null],
  // the owner's "more guns" (docs/03 §5–6 roles; see weapons.ts for where a number moved)
  hawk50: [12, 2.75, 8, 1.75],
  rattler: [10, 1.35, 7, 0.9],
  hornet: [15, 0.84, 10, 0.54],
  trident: [8, 1 + 1 / 15, 5, 0.5 + 1 / 15], // 3-round bursts 0.5 s apart, rounds 1/15 s (4 ticks) apart
  bullpup: [12, 1.32, 8, 0.84],
  longbow: [3, 1.1, 2, 0.55],
  shredder: [12, 0.8 + 11 / 15, 8, 0.8 + 7 / 15], // includes the 0.8 s spin-up
  arc: [17, 2.4, 12, 1.65],
};

/** Body-shot DPS sanity range per class (docs/03 §4 lint). */
const DPS_RANGE: Partial<Record<WeaponClass, [number, number]>> = {
  sidearm: [30, 90],
  smg: [50, 130],
  rifle: [60, 150],
  sniper: [60, 130],
  shotgun: [90, 180],
  melee: [100, 250],
  dmr: [50, 100],
  heavy: [80, 160],
  special: [30, 60],
};

/** Weapon model ids from W8's art/weapons/weapons.json (the art and content must match). */
const ART_IDS = ['hawk50', 'hammer44', 'buzz', 'k47', 'breacher', 'widow', 'thumper', 'shredder', 'rattler', 'hornet', 'trident', 'bullpup', 'longbow', 'dragon', 'arc', 'popper', 'ripper', 'pulse', 'machete'];

describe('weapons', () => {
  it('indices match their position, and stats are sane', () => {
    weapons.forEach((w, i) => {
      expect(w.index, w.id).toBe(i);
      expect(w.minDamageMul, w.id).toBeGreaterThan(0);
      expect(w.minDamageMul, w.id).toBeLessThanOrEqual(1);
      expect(w.zoomMax, w.id).toBeGreaterThanOrEqual(1);
      expect(w.zoomMax, w.id).toBeLessThanOrEqual(7);
      expect(w.pellets, w.id).toBeGreaterThanOrEqual(1);
      expect(w.moveSpeedMul, w.id).toBeGreaterThanOrEqual(0.7);
      expect(w.moveSpeedMul, w.id).toBeLessThanOrEqual(1.05);
      expect(ART_IDS, w.id).toContain(w.id);
      if (w.fireMode === 'melee') {
        expect(w.mag, w.id).toBe(0);
        expect(w.range, w.id).toBeLessThanOrEqual(1.5);
      } else {
        expect(w.mag, w.id).toBeGreaterThan(0);
        // falloff starts at 50% of range (docs/03 §8); the beam never falls off
        if (w.minDamageMul < 1) expect(w.falloffStart, w.id).toBeCloseTo(w.range / 2, 9);
      }
      // two-handed classes can't be dual-wielded
      if (['rifle', 'dmr', 'sniper', 'shotgun', 'heavy'].includes(w.class)) expect(w.hands, w.id).toBe(2);
    });
    expect(new Set(weapons.map((w) => w.id)).size).toBe(weapons.length);
  });

  it('body-shot DPS is inside its class range', () => {
    for (const w of weapons) {
      const range = DPS_RANGE[w.class];
      expect(range, `${w.class} has a DPS range`).toBeDefined();
      const dps = (shotDamage(w) * (w.burst?.count ?? 1)) / w.interval;
      expect(dps, `${w.id} dps`).toBeGreaterThanOrEqual(range![0]);
      expect(dps, `${w.id} dps`).toBeLessThanOrEqual(range![1]);
    }
  });

  it('time-to-kill matches the docs/03 §6 sheet', () => {
    for (const w of weapons) {
      const sheet = TTK_SHEET[w.id];
      expect(sheet, `${w.id} is in the TTK sheet`).toBeDefined();
      const [bodyShots, bodyTtk, headShots, headTtk] = sheet!;
      const body = timeToKill(w, defaultTuning.healthMax);
      expect(body.shots, `${w.id} body shots`).toBe(bodyShots);
      expect(body.seconds, `${w.id} body TTK`).toBeCloseTo(bodyTtk, 6);
      if (headShots !== null) {
        const head = timeToKill(w, defaultTuning.healthMax, true);
        expect(head.shots, `${w.id} head shots`).toBe(headShots);
        expect(head.seconds, `${w.id} head TTK`).toBeCloseTo(headTtk!, 6);
      }
    }
  });

  it('a Widow headshot kills a standing target outright; a body shot does not', () => {
    const widow = weapons.find((w) => w.id === 'widow')!;
    expect(widow.damage * widow.headMul).toBeGreaterThanOrEqual(defaultTuning.healthMax);
    expect(widow.damage).toBeLessThan(defaultTuning.healthMax);
  });

  it('default loadout references real weapons', () => {
    for (const i of DEFAULT_LOADOUT) expect(weapons[i]).toBeDefined();
  });
});

describe('tuning', () => {
  it('hash is stable and sensitive to values', () => {
    expect(tuningHash(createTuning())).toBe(tuningHash(defaultTuning));
    expect(tuningHash(createTuning({ gravity: 21 }))).not.toBe(tuningHash(defaultTuning));
  });

  it("the panel's fields are real tuning keys whose defaults sit inside their ranges, each once", () => {
    const seen = new Set<string>();
    for (const g of TUNING_GROUPS) {
      for (const f of g.fields) {
        expect(seen.has(f.key), f.key).toBe(false);
        seen.add(f.key);
        expect(typeof defaultTuning[f.key], f.key).toBe('number');
        expect(f.label.length, f.key).toBeGreaterThan(2);
        expect(defaultTuning[f.key], f.key).toBeGreaterThanOrEqual(f.min);
        expect(defaultTuning[f.key], f.key).toBeLessThanOrEqual(f.max);
      }
    }
    // the owner's asks: fuel, jet, gravity, the dash, blast launch and grenade throw speed
    for (const k of ['fuelMax', 'fuelBurn', 'jetThrust', 'gravity', 'dashSpeed', 'blastImpulseScale', 'grenadeThrowScale']) expect(seen.has(k), k).toBe(true);
  });

  it("limitTuning keeps a host's edit to the panel's keys and ranges", () => {
    expect(limitTuning({ gravity: 25, fuelMax: 1e9, jetKickTicks: 6.6, grenadeThrowScale: 1.3, capsuleRadius: 0.01, walkMax: Number.NaN, airAccel: '30' })).toEqual({
      gravity: 25,
      fuelMax: 300, // clamped to the range
      jetKickTicks: 7, // whole ticks
      grenadeThrowScale: 1.3,
    });
    expect(limitTuning(null)).toEqual({});
    expect(limitTuning('{"gravity":1}')).toEqual({});
  });

  it('changedTuning lists only what differs from the defaults (Copy values)', () => {
    expect(changedTuning(createTuning())).toEqual({});
    expect(changedTuning(createTuning({ fuelBurn: 30, grenadeThrowScale: 1.3 }))).toEqual({ fuelBurn: 30, grenadeThrowScale: 1.3 });
  });

  it('body fits the hitboxes', () => {
    expect(STANDING_HITBOXES.head.y + STANDING_HITBOXES.head.r).toBeLessThanOrEqual(defaultTuning.standHeight + 0.01);
    expect(CROUCHED_HITBOXES.head.y + CROUCHED_HITBOXES.head.r).toBeLessThanOrEqual(defaultTuning.crouchHeight + 0.02);
    expect(STANDING_HITBOXES.headIsHeadshot).toBe(true);
    expect(CROUCHED_HITBOXES.headIsHeadshot).toBe(false);
  });

  it('frag explosion is self-consistent', () => {
    expect(FRAG.explosion.core).toBeLessThan(FRAG.explosion.radius);
    expect(FRAG.spawnCount).toBeLessThanOrEqual(FRAG.maxCount);
  });
});

describe('grenades', () => {
  it('indices match their position (u3 on the wire) and every type fits the belt', () => {
    grenades.forEach((g, i) => expect(g.index, g.id).toBe(i));
    expect(grenades.length).toBeLessThanOrEqual(GRENADE_TYPES);
    expect(GRENADE_TYPES).toBeLessThanOrEqual(8);
    expect(new Set(grenades.map((g) => g.id)).size).toBe(grenades.length);
  });

  it('carry limits fit the local block (u3) and the spawn loadout is frag ×3', () => {
    for (const g of grenades) {
      expect(g.spawnCount, g.id).toBeLessThanOrEqual(g.maxCount);
      expect(g.maxCount, g.id).toBeLessThanOrEqual(7);
      expect(g.fuse, g.id).toBeGreaterThan(0);
    }
    const belt = spawnGrenades();
    expect(belt).toHaveLength(GRENADE_TYPES);
    expect(belt[FRAG.index]).toBe(3);
    expect(belt.reduce((a, b) => a + b, 0)).toBe(3);
  });

  it('clouds grow, hold and fade inside their life, and gas is worst at the core', () => {
    for (const g of grenades) {
      if (g.effect !== 'cloud') continue;
      const c = g.cloud;
      expect(c.grow + c.fade, g.id).toBeLessThan(c.duration);
      expect(c.startFraction, g.id).toBeGreaterThan(0);
      expect(c.endFraction, g.id).toBeLessThanOrEqual(1);
      expect(c.dpsCore, g.id).toBeGreaterThanOrEqual(c.dpsEdge);
      expect(c.core, g.id).toBeLessThan(c.radius);
      expect(c.duration * 60, g.id).toBeLessThan(1024); // age is u10 on the wire
    }
  });

  it('mines and EMPs fit their wire fields (fuse u8, jetDisabledTicks u8)', () => {
    for (const g of grenades) {
      if (g.effect === 'mine') {
        expect(g.mine.explosion.core, g.id).toBeLessThan(g.mine.explosion.radius);
        expect(g.mine.triggerRadius, g.id).toBeLessThan(g.mine.explosion.radius);
        expect(Math.round(g.fuse * 60), g.id).toBeLessThanOrEqual(255);
        expect(Math.round(g.mine.chainDelay * 60), g.id).toBeGreaterThanOrEqual(1);
      }
      if (g.effect === 'emp') expect(Math.round(g.emp.jetDisable * 60), g.id).toBeLessThanOrEqual(255);
    }
  });

  it('a flashbang blinds within the local block\'s ranges (blindTicks u8, blindFade u7)', () => {
    for (const g of grenades) {
      if (g.effect !== 'flash') continue;
      const f = g.flash;
      expect(Math.round((f.white + Math.max(f.fade, f.minFade)) * 60), g.id).toBeLessThanOrEqual(255);
      expect(Math.round(Math.max(f.fade, f.minFade) * 60), g.id).toBeLessThanOrEqual(127);
      expect(f.fullRadius, g.id).toBeLessThan(f.radius);
      for (const mul of [f.awayMul, f.coverMul, f.smokeMul, f.minStrength]) {
        expect(mul, g.id).toBeGreaterThan(0);
        expect(mul, g.id).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe('maps', () => {
  it('registers the movement test map by id', () => {
    expect(maps[movementTestMap.id]).toBe(movementTestMap);
  });

  it('registers the demo maps and the mechanics test map', () => {
    for (const id of [...DEMO_MAPS, 'mechanics-test']) expect(maps[id]?.id).toBe(id);
  });

  it('registers the Street Market exactly as the art pipeline compiled it (re-copy street_market.map.json after a recompile)', () => {
    expect(maps['street-market']).toBe(streetMarketMap);
    // the pipeline doesn't mark slabs yet (streetMarket.ts): blocksBullets is the copy's only change;
    // the weapon crates and the armory rack are gameplay on top
    const { oneWays, spawners: _crates, armory: _rack, ...rest } = streetMarketMap;
    const { oneWays: compiledOneWays, ...compiledRest } = compiledStreetMarket;
    expect(rest).toEqual(compiledRest);
    expect(oneWays.map(({ blocksBullets: _, ...o }) => o)).toEqual(compiledOneWays);
    expect(streetMarketMap.spawns.length).toBeGreaterThanOrEqual(12);
  });

  it('Street Market: the floors stop bullets (balconies, the tank deck, the catwalk); awnings and umbrellas let them through', () => {
    const slab = (o: MapOneWay) => o.blocksBullets === true;
    const at = (o: MapOneWay) => `${Math.min(o.ax, o.bx)}..${Math.max(o.ax, o.bx)}@${Math.max(o.ay, o.by)}`;
    const balconies = ['-54..-52@4', '-54..-52@8', '52..54@4', '52..54@8', '-52..-50@4', '50..52@4', '-25..-23@4', '-17..-15@8', '23..25@4', '15..17@8'];
    expect(streetMarketMap.oneWays.filter(slab).map(at).sort()).toEqual([...balconies, '-1.6..-0.8@4', '0.8..1.6@4', '-4..4@10'].sort());
    // every one-way left see-through is a stall awning or an umbrella canopy (≤ 3.05 m, over a stall)
    for (const o of streetMarketMap.oneWays.filter((w) => !slab(w))) expect(Math.max(o.ay, o.by)).toBeLessThanOrEqual(3.05);
  });

  for (const map of Object.values(maps)) {
    it(`${map.id}: geometry is finite and inside bounds`, () => {
      const b = map.bounds;
      const inside = (x: number, y: number) => x >= b.minX && x <= b.maxX && y >= b.minY && y <= b.maxY;
      for (const poly of map.solids) {
        expect(poly.points.length % 2).toBe(0);
        expect(poly.points.length).toBeGreaterThanOrEqual(6);
        for (let i = 0; i < poly.points.length; i += 2) {
          expect(Number.isFinite(poly.points[i]) && Number.isFinite(poly.points[i + 1])).toBe(true);
          expect(inside(poly.points[i]!, poly.points[i + 1]!)).toBe(true);
        }
      }
      for (const ow of map.oneWays) {
        expect(inside(ow.ax, ow.ay) && inside(ow.bx, ow.by)).toBe(true);
        expect(ow.ax).not.toBe(ow.bx);
      }
      for (const s of [...map.spawns, ...map.dummies]) expect(inside(s.x, s.y)).toBe(true);
      expect(map.spawns.length).toBeGreaterThanOrEqual(2);
      for (const z of map.zones ?? []) {
        const pts = zonePoints(z);
        for (let i = 0; i < pts.length; i += 2) expect(inside(pts[i]!, pts[i + 1]!), `zone ${z.id}`).toBe(true);
      }
    });

    it(`${map.id}: pickup spawners use known pools, sit inside the map and can fire`, () => {
      for (const sp of map.spawners ?? []) {
        expect(SPAWN_POOLS[sp.pool], `${sp.id} pool`).toBeDefined();
        expect(sp.spots.length, sp.id).toBeGreaterThan(0);
        for (const spot of sp.spots) expect(spot.x >= map.bounds.minX && spot.x <= map.bounds.maxX && spot.y >= map.bounds.minY && spot.y <= map.bounds.maxY).toBe(true);
        const max = sp.maxActive ?? 1;
        expect(max >= 1 && max <= sp.spots.length, `${sp.id} maxActive`).toBe(true);
        for (const [a, b] of [sp.first, sp.respawn]) expect(a >= 0 && b >= a, `${sp.id} time range`).toBe(true);
      }
    });
  }

  it('the movement test map has a riot shield spawner in front of the shooting range', () => {
    const sp = movementTestMap.spawners?.find((s) => s.pool === 'shield');
    expect(sp?.spots.length).toBeGreaterThanOrEqual(2);
  });
});

describe('pickups and the riot shield', () => {
  it('pickup indices match their position; pools list real pickups with positive weights', () => {
    pickups.forEach((p, i) => expect(p.index, p.id).toBe(i));
    expect(pickups.length).toBeLessThanOrEqual(64); // u6 on the wire (v11)
    expect(new Set(pickups.map((p) => p.id)).size).toBe(pickups.length);
    for (const pool of Object.values(SPAWN_POOLS)) {
      expect(pool.items.length, pool.id).toBeGreaterThan(0);
      for (const it of pool.items) {
        expect(pickupById(it.pickup), `${pool.id}: ${it.pickup}`).toBeDefined();
        expect(it.weight).toBeGreaterThan(0);
      }
    }
  });

  it('the riot shield matches docs/03 §5/§9 and covers the torso from the front', () => {
    expect([RIOT_SHIELD.hp, RIOT_SHIELD.arcDeg, RIOT_SHIELD.bashDamage, RIOT_SHIELD.moveSpeedMul]).toEqual([300, 60, 25, 0.75]);
    expect(RIOT_SHIELD.ricochetDamageMul).toBe(0.6);
    expect(RIOT_SHIELD.maxBounces).toBe(1);
    // in front of the torso hitbox raised, behind it slung, and spanning most of it standing and crouched
    expect(RIOT_SHIELD.forward).toBeGreaterThan(STANDING_HITBOXES.torso.r);
    expect(RIOT_SHIELD.backOffset).toBeGreaterThan(STANDING_HITBOXES.torso.r);
    for (const [bottom, box] of [
      [RIOT_SHIELD.bottomStand, STANDING_HITBOXES],
      [RIOT_SHIELD.bottomCrouch, CROUCHED_HITBOXES],
    ] as const) {
      expect(bottom).toBeLessThanOrEqual(box.torso.y0);
      expect(bottom + RIOT_SHIELD.height).toBeGreaterThanOrEqual(box.torso.y1);
    }
  });
});

describe('map JSON format (docs/02 §20.6)', () => {
  it('the committed schema is what the catalogue generates (pnpm --filter @military-forge/content schema)', () => {
    expect(committedSchema).toEqual(mapJsonSchema());
  });

  it('the schema offers every zone kind, event kind and modifier, with their descriptions', () => {
    const schema = mapJsonSchema() as { $defs: { zone: { properties: Record<string, { oneOf?: { const: string; description: string }[] }> }; event: { properties: Record<string, { oneOf?: { const: string }[] }> } } };
    const zoneKinds = schema.$defs.zone.properties.kind!.oneOf!;
    expect(zoneKinds.map((k) => k.const)).toEqual(Object.keys(ZONE_KINDS));
    expect(zoneKinds.find((k) => k.const === 'jumpPad')!.description).toMatch(/launch \[0, 16\]/);
    expect(schema.$defs.event.properties.kind!.oneOf!.map((k) => k.const)).toEqual(Object.keys(EVENT_KINDS));
    for (const f of MODIFIER_FIELDS) expect(schema.$defs.zone.properties[f.key], f.key).toBeDefined();
  });

  it('Storm Front is authored as JSON and parses into the registered map (without $schema)', () => {
    const raw = JSON.parse(JSON.stringify(stormFrontJson)) as Record<string, unknown>;
    expect(raw.$schema).toBe('../../schema/map.schema.json');
    const map = parseMapJson(raw);
    expect(map).toEqual(maps['storm-front']);
    expect('$schema' in map).toBe(false);
    expect(map.zones!.map((z) => z.kind)).toEqual(['water', 'damping', 'wind']);
  });

  it('refuses misspelt keys and wrong shapes, listing every problem with its path', () => {
    const base = JSON.parse(JSON.stringify(maps['storm-front'])) as Record<string, unknown> & { zones: Record<string, unknown>[] };
    base.zones[0]!.gravitymul = 0.5;
    base.zones[1]!.kind = 'toString'; // a prototype name is no kind either
    delete base.zones[2]!.rect;
    (base as { rules?: unknown }).rules = { gravityMul: 'low' };
    let message = '';
    try {
      parseMapJson(base, 'bad.map.json');
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/^bad\.map\.json: /);
    expect(message).toMatch(/\$\.zones\[0\]: unknown key "gravitymul"/);
    expect(message).toMatch(/\$\.zones\[1\]\.kind: must be one of zeroG/);
    const event = JSON.parse(JSON.stringify(maps['storm-front'])) as { events: { defs: Record<string, unknown>[] } };
    event.events.defs[0]!.kind = 'constructor';
    expect(() => parseMapJson(event)).toThrow(/\$\.events\.defs\[0\]\.kind: must be one of/);
    expect(message).toMatch(/\$\.zones\[2\]: needs exactly one of rect or points/);
    expect(message).toMatch(/\$\.rules\.gravityMul: must be a number/);
  });

  it('one-way platforms: blocksBullets (true or false) parses; a misspelt key or a non-boolean is refused', () => {
    const slab = JSON.parse(JSON.stringify(maps['storm-front'])) as { oneWays: Record<string, unknown>[] };
    slab.oneWays[0]!.blocksBullets = true;
    slab.oneWays[1]!.blocksBullets = false;
    const map = parseMapJson(slab);
    expect(map.oneWays[0]!.blocksBullets).toBe(true);
    expect(map.oneWays[1]!.blocksBullets).toBe(false);
    expect(map.oneWays[2]!.blocksBullets).toBeUndefined();
    const schema = mapJsonSchema() as { properties: { oneWays: { items: { additionalProperties: boolean; properties: Record<string, { type: string }> } } } };
    expect(schema.properties.oneWays.items.properties.blocksBullets!.type).toBe('boolean');
    expect(schema.properties.oneWays.items.additionalProperties).toBe(false);
    const bad = JSON.parse(JSON.stringify(maps['storm-front'])) as { oneWays: Record<string, unknown>[] };
    bad.oneWays[0]!.blockBullets = true;
    bad.oneWays[1]!.blocksBullets = 'yes';
    let message = '';
    try {
      parseMapJson(bad, 'bad.map.json');
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/\$\.oneWays\[0\]: unknown key "blockBullets"/);
    expect(message).toMatch(/\$\.oneWays\[1\]\.blocksBullets: must be true or false/);
  });

  it('carries pickup spawners: the movement-test map round-trips, and a bad spawner is refused', () => {
    expect(movementTestMap.spawners?.length).toBeGreaterThan(0);
    expect(parseMapJson(JSON.parse(JSON.stringify(movementTestMap)))).toEqual(movementTestMap);
    const schema = mapJsonSchema() as { properties: Record<string, unknown>; $defs: { spawner: { properties: { pool: { enum: string[] } } } } };
    expect(schema.properties.spawners).toBeDefined();
    expect(schema.$defs.spawner.properties.pool.enum).toEqual(Object.keys(SPAWN_POOLS));
    const bad = JSON.parse(JSON.stringify(movementTestMap)) as { spawners: Record<string, unknown>[] };
    bad.spawners[0]!.pool = 'toString';
    bad.spawners[0]!.first = [3];
    bad.spawners[0]!.maxActve = 2;
    bad.spawners[0]!.maxActive = 0;
    let message = '';
    try {
      parseMapJson(bad, 'bad.map.json');
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/\$\.spawners\[0\]\.pool: must be one of shield/);
    expect(message).toMatch(/\$\.spawners\[0\]\.first: must be \[min, max\]/);
    expect(message).toMatch(/\$\.spawners\[0\]: unknown key "maxActve"/);
    expect(message).toMatch(/\$\.spawners\[0\]\.maxActive: must be a whole number/);
  });
});
