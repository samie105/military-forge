/**
 * Tall maps (maps-vertical): tiers, the updraft and thin-air zones, the tiered pickup pools, and
 * the vertical test map's promises.
 */
import { describe, expect, it } from 'vitest';
import {
  POWER_WEAPONS,
  SPAWN_POOLS,
  TIER_SLACK,
  ZONE_KINDS,
  fogStairMap,
  mapTiers,
  maps,
  parseMapJson,
  pickupById,
  resolveZone,
  tierIndexAt,
  verticalTestMap,
  weapons,
  type MapDef,
} from '../src';

const weaponOf = (pickup: string) => weapons[pickupById(pickup)!.weapon!]!.id;

describe('tiers', () => {
  for (const map of Object.values(maps)) {
    const tiers = map.tiers;
    if (!tiers) continue;
    it(`${map.id}: tiers run bottom to top inside the map, with unique ids and names`, () => {
      expect(tiers.length).toBeGreaterThanOrEqual(2);
      expect(new Set(tiers.map((t) => t.id)).size).toBe(tiers.length);
      for (let i = 1; i < tiers.length; i++) expect(tiers[i]!.y, tiers[i]!.id).toBeGreaterThan(tiers[i - 1]!.y + 2 * TIER_SLACK);
      for (const t of tiers) {
        expect(t.y >= map.bounds.minY && t.y < map.bounds.maxY, t.id).toBe(true);
        expect(t.name.length).toBeGreaterThan(0);
      }
      // respawns spread across tiers: at least two tiers have spawns
      expect(new Set(map.spawns.map((s) => tierIndexAt(map, s.y))).size).toBeGreaterThanOrEqual(2);
    });
  }

  it('tierIndexAt: the highest tier whose line (less the slack) is at or under the feet; −1 without tiers', () => {
    const m = verticalTestMap;
    expect(tierIndexAt(m, -3)).toBe(0);
    expect(tierIndexAt(m, 0)).toBe(0);
    expect(tierIndexAt(m, 18)).toBe(0);
    expect(tierIndexAt(m, 20 - TIER_SLACK)).toBe(1);
    expect(tierIndexAt(m, 20)).toBe(1);
    expect(tierIndexAt(m, 42)).toBe(2);
    expect(tierIndexAt(m, 66)).toBe(3);
    expect(tierIndexAt(m, 99)).toBe(3);
    expect(tierIndexAt(maps['street-market']!, 10)).toBe(-1);
    expect(mapTiers({ ...m, tiers: [m.tiers![0]!] })).toBeNull();
  });

  it('map JSON carries tiers and refuses unknown keys in them', () => {
    const json = JSON.parse(JSON.stringify(verticalTestMap)) as MapDef;
    expect(parseMapJson(json).tiers).toEqual(verticalTestMap.tiers);
    const bad = JSON.parse(JSON.stringify(verticalTestMap)) as { tiers: Record<string, unknown>[] };
    bad.tiers[1]!.height = 3;
    expect(() => parseMapJson(bad)).toThrow(/tiers\[1\]: unknown key "height"/);
    delete bad.tiers[1]!.height;
    bad.tiers[1]!.y = 'high';
    expect(() => parseMapJson(bad)).toThrow(/tiers\[1\]\.y: must be a number/);
  });
});

describe('tall-map zones', () => {
  it('an updraft lifts fliers (wind beats gravity) to a gentle terminal speed and refuels them', () => {
    const r = resolveZone({ id: 'u', kind: 'updraft', rect: [0, 0, 1, 1] });
    expect(r.windY).toBeGreaterThan(20); // the default gravity is 20 m/s²
    const terminal = (r.windY - 20) / r.drag;
    expect(terminal).toBeGreaterThan(4);
    expect(terminal).toBeLessThan(9);
    expect(r.fuelRegenMul).toBeGreaterThan(1);
    expect(r.jetDisabled).toBe(false);
  });

  it('thin air cuts jetpacks and pushes down', () => {
    const r = resolveZone({ id: 't', kind: 'thinAir', rect: [0, 0, 1, 1] });
    expect(r.jetDisabled).toBe(true);
    expect(r.windY).toBeLessThan(0);
    expect(ZONE_KINDS.thinAir.label).toBe('Thin air');
  });
});

describe('tiered pickup pools', () => {
  it('common holds every everyday gun, power every power weapon, and nothing else', () => {
    const common = SPAWN_POOLS.common!.items.map((i) => weaponOf(i.pickup));
    const power = SPAWN_POOLS.power!.items.map((i) => weaponOf(i.pickup));
    expect(common.length + power.length).toBe(SPAWN_POOLS.weapons!.items.length);
    expect(common.some((w) => POWER_WEAPONS.has(w))).toBe(false);
    expect(power.every((w) => POWER_WEAPONS.has(w))).toBe(true);
    expect(power.length).toBeGreaterThan(0);
  });
});

describe('vertical-test promises', () => {
  const m = verticalTestMap;
  it('is big and tall: at least 200 × 100 m with four tiers and a soft ceiling under the hard one', () => {
    expect(m.bounds.maxX - m.bounds.minX).toBeGreaterThanOrEqual(200);
    expect(m.bounds.maxY - m.bounds.minY).toBeGreaterThanOrEqual(100);
    expect(m.tiers!.map((t) => t.id)).toEqual(['streets', 'roofs', 'high', 'sky']);
    const thin = m.zones!.find((z) => z.kind === 'thinAir')!;
    expect(thin.rect![1]).toBeGreaterThan(m.tiers!.at(-1)!.y + 10);
    expect(thin.rect![3]).toBe(m.bounds.maxY - 2); // up to the ceiling's underside
  });

  it('pays for the climb: power weapons only on the upper tiers, everyday guns and grenades low', () => {
    for (const sp of m.spawners!) {
      const tiersOf = sp.spots.map((s) => tierIndexAt(m, s.y));
      if (sp.pool === 'power') expect(Math.min(...tiersOf), sp.id).toBeGreaterThanOrEqual(2);
      if (sp.pool === 'common') expect(Math.max(...tiersOf), sp.id).toBeLessThanOrEqual(1);
    }
    expect(m.spawners!.some((sp) => sp.pool === 'power' && sp.spots.every((s) => tierIndexAt(m, s.y) === 3))).toBe(true);
  });

  it('every one-way is a slab: drawn solid, it stops bullets', () => {
    expect(m.oneWays.every((o) => o.blocksBullets === true)).toBe(true);
  });
});

describe('fog-stair promises (the owner’s pick, 23 Oct)', () => {
  const m = fogStairMap;
  const mid = (m.bounds.minX + m.bounds.maxX) / 2;
  const key = (pts: readonly number[]) => {
    const xs = pts.filter((_, i) => i % 2 === 0);
    const ys = pts.filter((_, i) => i % 2 === 1);
    return `${Math.min(...xs).toFixed(3)},${Math.max(...xs).toFixed(3)},${Math.min(...ys).toFixed(3)},${Math.max(...ys).toFixed(3)}`;
  };
  const mirror = (pts: readonly number[]) => pts.map((v, i) => (i % 2 === 0 ? 2 * mid - v : v));

  it('is fair: mirrored about the river, every solid, slab, post and spawn', () => {
    const solids = new Set(m.solids.map((s) => key(s.points)));
    for (const s of m.solids) expect(solids.has(key(mirror(s.points))), key(s.points)).toBe(true);
    const posts = new Set((m.bulletOnly ?? []).map((s) => key(s.points)));
    for (const s of m.bulletOnly ?? []) expect(posts.has(key(mirror(s.points))), key(s.points)).toBe(true);
    const slabs = new Set(m.oneWays.map((o) => `${Math.min(o.ax, o.bx)},${Math.max(o.ax, o.bx)},${o.ay}`));
    for (const o of m.oneWays) expect(slabs.has(`${2 * mid - Math.max(o.ax, o.bx)},${2 * mid - Math.min(o.ax, o.bx)},${o.ay}`)).toBe(true);
    const spawns = new Set(m.spawns.map((s) => `${s.x},${s.y}`));
    for (const s of m.spawns) expect(spawns.has(`${2 * mid - s.x},${s.y}`)).toBe(true);
  });

  it('big and tall, four tiers, a river of deep water, a fog that rolls up the gorge', () => {
    expect(m.bounds.maxX - m.bounds.minX).toBeGreaterThanOrEqual(240);
    expect(m.bounds.maxY - m.bounds.minY).toBeGreaterThanOrEqual(100);
    expect(m.tiers!.map((t) => t.id)).toEqual(['riverside', 'stairs', 'monorail', 'rooftops']);
    expect(m.zones!.find((z) => z.id === 'river')?.kind).toBe('water');
    expect(m.events!.defs.map((d) => d.kind)).toEqual(['fog']);
    expect(m.oneWays.every((o) => o.blocksBullets === true)).toBe(true);
    expect(m.spawns.length).toBeGreaterThanOrEqual(12);
  });

  it('pays for the climb: power weapons only on the rooftops, everyday guns only below the monorail', () => {
    for (const sp of m.spawners!) {
      const tiersOf = sp.spots.map((s) => tierIndexAt(m, s.y));
      if (sp.pool === 'power') expect(Math.min(...tiersOf), sp.id).toBe(3);
      if (sp.pool === 'common') expect(Math.max(...tiersOf), sp.id).toBeLessThanOrEqual(1);
    }
  });

  it('is its own place: no Lagos, no Street Market names in it', () => {
    const words = [m.name, ...m.labels.map((l) => l.text), ...m.tiers!.map((t) => t.name), ...m.events!.defs.map((d) => `${d.name} ${d.description}`)].join(' ');
    expect(words).not.toMatch(/lagos|market|danfo|okada/i);
  });
});
