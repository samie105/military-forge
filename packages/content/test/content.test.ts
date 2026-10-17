import { describe, expect, it } from 'vitest';
import committedSchema from '../schema/map.schema.json';
import stormFrontJson from '../src/maps/stormFront.map.json';
import {
  CROUCHED_HITBOXES,
  DEFAULT_LOADOUT,
  DEMO_MAPS,
  EVENT_KINDS,
  FRAG,
  MODIFIER_FIELDS,
  STANDING_HITBOXES,
  ZONE_KINDS,
  createTuning,
  defaultTuning,
  mapJsonSchema,
  maps,
  movementTestMap,
  parseMapJson,
  zonePoints,
  shotDamage,
  timeToKill,
  tuningHash,
  weapons,
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
};

/** Body-shot DPS sanity range per class (docs/03 §4 lint). */
const DPS_RANGE: Partial<Record<WeaponClass, [number, number]>> = {
  sidearm: [30, 90],
  smg: [50, 130],
  rifle: [60, 150],
  sniper: [60, 130],
  shotgun: [90, 180],
  melee: [100, 250],
};

/** Weapon model ids from W8's art/weapons/weapons.json (the art and content must match). */
const ART_IDS = ['hawk50', 'hammer44', 'buzz', 'k47', 'breacher', 'widow', 'thumper', 'shredder', 'machete'];

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
        // falloff starts at 50% of range (docs/03 §8)
        expect(w.falloffStart, w.id).toBeCloseTo(w.range / 2, 9);
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
      const dps = shotDamage(w) / w.interval;
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

describe('maps', () => {
  it('registers the movement test map by id', () => {
    expect(maps[movementTestMap.id]).toBe(movementTestMap);
  });

  it('registers the demo maps and the mechanics test map', () => {
    for (const id of [...DEMO_MAPS, 'mechanics-test']) expect(maps[id]?.id).toBe(id);
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
  }
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
});
