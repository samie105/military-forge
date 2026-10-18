import { BREACHER, BUZZ, HAMMER, SHREDDER, WIDOW, movementTestMap } from '@military-forge/content';
import { CollisionWorld, type SimEvent } from '@military-forge/sim';
import { describe, expect, it } from 'vitest';
import { Gunfire, type MuzzleLookup } from '../vfx/gunfire';
import { parseWeaponVfx } from '../vfx/manifest';
import { F, ParticlePool, STRIDE } from '../vfx/pool';
import { Ramp } from '../vfx/ramps';

const world = new CollisionWorld(movementTestMap);
type Shot = Extract<SimEvent, { type: 'shot' }>;

const shot = (over: Partial<Shot> = {}): Shot => ({ type: 'shot', shooter: 0, weapon: HAMMER.index, ox: 150, oy: 1.2, ex: 159.8, ey: 1.4, hit: 1, target: -1, zone: 0, ...over });
const targets = () => ({ glow: new ParticlePool(2000), smoke: new ParticlePool(2000) });
const ramps = (pool: ParticlePool) => Array.from({ length: pool.count }, (_, i) => pool.data[i * STRIDE + F.ramp]!);
const count = (pool: ParticlePool, ramp: number) => ramps(pool).filter((r) => r === ramp).length;
const noMuzzle: MuzzleLookup = () => false;
const field = (pool: ParticlePool, i: number, f: number) => pool.data[i * STRIDE + f]!;

describe('Gunfire', () => {
  it('a shot: one flash, a tracer bolt and its fading path, and sparks where it hit the wall', () => {
    const g = new Gunfire(world);
    const t = targets();
    g.onEvents([shot()]);
    g.update(1 / 60, t, noMuzzle);
    expect(count(t.glow, Ramp.Flash)).toBe(2 + 1); // star + cone at the muzzle, a hot point at the impact
    expect(count(t.glow, Ramp.Book)).toBe(1); // the bolt
    expect(count(t.glow, Ramp.Tracer)).toBe(1); // the path
    expect(count(t.glow, Ramp.Spark)).toBeGreaterThanOrEqual(2);
    expect(count(t.smoke, Ramp.Dust)).toBe(1); // stone dust (not metal)
  });

  it('the bolt reaches the end within 70 ms however long the shot (hitscan already decided the hit)', () => {
    const g = new Gunfire(world);
    const t = targets();
    g.onEvents([shot({ ex: 150 + 40, ey: 1.2, hit: 0 })]);
    g.update(1 / 60, t, noMuzzle);
    const i = ramps(t.glow).indexOf(Ramp.Book);
    const o = i * STRIDE;
    const speed = Math.hypot(t.glow.data[o + F.vx]!, t.glow.data[o + F.vy]!);
    expect(40 / speed).toBeLessThanOrEqual(0.07 + 1e-6);
    expect(t.glow.data[o + F.life]!).toBeLessThan(0.07);
  });

  it('leaves the drawn muzzle when the shooter is drawn, else the sim origin', () => {
    const g = new Gunfire(world);
    const t = targets();
    const muzzle: MuzzleLookup = (id, _w, out, dir) => {
      out.set(150.2, 0.9, 0.15);
      dir.set(1, 0.02, 0).normalize();
      return id === 0;
    };
    g.onEvents([shot()]);
    g.update(1 / 60, t, muzzle);
    const flash = ramps(t.glow).indexOf(Ramp.Flash);
    expect(t.glow.data[flash * STRIDE + F.x]).toBeCloseTo(150.2);
    expect(t.glow.data[flash * STRIDE + F.y]).toBeCloseTo(0.9);
    // a drawn muzzle far from the sim's (a gun wedged through a wall): the sim origin wins
    const t2 = targets();
    g.onEvents([shot({ ox: 140 })]);
    g.update(1 / 60, t2, muzzle);
    expect(t2.glow.data[ramps(t2.glow).indexOf(Ramp.Flash) * STRIDE + F.x]).toBeCloseTo(140);
  });

  it('a shotgun blast: one flash for the shot, a tracer per pellet', () => {
    const g = new Gunfire(world);
    const t = targets();
    const pellets = [0, 1, 2, 3, 4].map((k) => shot({ weapon: BREACHER.index, ey: 0.8 + k * 0.3, hit: 0 }));
    g.onEvents(pellets);
    g.update(1 / 60, t, noMuzzle);
    expect(count(t.glow, Ramp.Flash)).toBe(2);
    expect(count(t.glow, Ramp.Book)).toBe(5);
  });

  it('SMGs draw a tracer every 2nd shot, and every 3rd on Low (docs/11 §5); every shot still flashes', () => {
    for (const [low, every] of [
      [false, 2],
      [true, 3],
    ] as const) {
      const g = new Gunfire(world);
      g.low = low;
      expect(g.every(BUZZ.index)).toBe(every);
      expect(g.every(HAMMER.index)).toBe(1);
      const t = targets(); // never stepped here: every particle emitted stays countable
      for (let i = 0; i < 12; i++) {
        g.onEvents([shot({ weapon: BUZZ.index, hit: 0 })]); // one shot per tick batch
        g.update(1 / 60, t, noMuzzle);
      }
      expect(count(t.glow, Ramp.Flash)).toBe(12 * 2);
      // the first shot, then every Nth: 1, 2, 4 … 12 (7) or 1, 3, 6, 9, 12 (5)
      expect(count(t.glow, Ramp.Book)).toBe(every === 2 ? 7 : 5);
    }
  });

  it('a player hit: a hot thud and a few sparks, no dust (no gore)', () => {
    const g = new Gunfire(world);
    const t = targets();
    g.onEvents([shot({ hit: 2, target: 3, ex: 157, ey: 1.1 })]);
    g.update(1 / 60, t, noMuzzle);
    expect(count(t.smoke, Ramp.Dust)).toBe(0);
    expect(count(t.glow, Ramp.Spark)).toBeGreaterThanOrEqual(2);
  });

  it('the sniper leaves a smoke line that hangs', () => {
    const g = new Gunfire(world);
    const t = targets();
    g.onEvents([shot({ weapon: WIDOW.index, hit: 0 })]);
    g.update(1 / 60, t, noMuzzle);
    expect(count(t.smoke, Ramp.Haze)).toBe(1);
  });

  it('a ricochet off a riot shield: metal sparks at the bounce, a cold tracer on along its new path', () => {
    const g = new Gunfire(world);
    const t = targets();
    // the shot ends on the shield (hit 3); the bullet flies on up and back from there
    const ricochet: SimEvent = { type: 'ricochet', shooter: 0, owner: 4, weapon: HAMMER.index, x: 155, y: 1.2, nx: -1, ny: 0, ex: 151, ey: 4, hit: 0, target: -1, zone: 0 };
    g.onEvents([shot({ ex: 155, ey: 1.2, hit: 3, target: 4 }), ricochet]);
    g.update(1 / 60, t, noMuzzle);
    const bolts = Array.from({ length: t.glow.count }, (_, i) => i).filter((i) => field(t.glow, i, F.ramp) === Ramp.Book);
    expect(bolts.length).toBe(2); // the shot's, and the ricochet's
    const back = bolts.find((i) => field(t.glow, i, F.vx) < 0)!; // flying back toward the shooter
    expect(field(t.glow, back, F.tr)).toBeLessThan(0.7); // cold cyan, not the warm tracer
    expect(Math.atan2(field(t.glow, back, F.vy), field(t.glow, back, F.vx))).toBeCloseTo(Math.atan2(4 - 1.2, 151 - 155), 5);
    // sparks off the plate fan back along its normal (−x)
    const sparks = Array.from({ length: t.glow.count }, (_, i) => i).filter((i) => field(t.glow, i, F.ramp) === Ramp.Spark && field(t.glow, i, F.x) === 155);
    expect(sparks.length).toBeGreaterThanOrEqual(3 + 3); // the shot's impact on the plate and the bounce
    // a steel plate: no stone dust where the shot struck it
    expect(count(t.smoke, Ramp.Dust)).toBe(0);
  });

  it('pops the light on each shot and lets it die within a few frames', () => {
    const g = new Gunfire(world);
    const t = targets();
    g.onEvents([shot()]);
    g.update(1 / 60, t, noMuzzle);
    expect(g.light.intensity).toBeGreaterThan(0);
    for (let i = 0; i < 12; i++) g.update(1 / 60, t, noMuzzle);
    expect(g.light.intensity).toBe(0);
  });
});

describe('weapons.vfx.json (the Forge flash atlas)', () => {
  const manifest = {
    version: 1,
    flash: {
      atlas: 'flash_atlas.webp',
      atlasSize: [1024, 1024],
      cell: [256, 128],
      styles: {
        pistol: { frames: [0, 1, 2, 3], quad: { widthM: 0.44, heightM: 0.22, originU: 0.02 }, ms: 40, light: { color: '#ffd890', intensity: 2, rangeM: 3 }, jitter: { scale: [0.85, 1.15], rollDeg: 6, flipV: true } },
        bad: { frames: [99], quad: { widthM: 0.4, heightM: 0.2 } },
      },
    },
    tracer: { texture: 'tracer.webp', styles: { pistol: { tint: '#fff1b8', widthM: 0.035, lengthM: 1.2, speedMps: 90, every: 1 }, sniper: { tint: '#ffffff', widthM: 0.06, lengthM: 4, speedMps: 260, every: 1, trail: { tint: '#d8d8d0', widthM: 0.05, fadeMs: 450 } } } },
    weapons: { hammer44: { flash: 'pistol', flashScale: 1.25, tracer: 'pistol' }, widow: { flash: 'bad', tracer: 'sniper' }, machete: { flash: null, tracer: null } },
  };

  it('reads flash styles, tracer styles and the per-weapon hook-up', () => {
    const art = parseWeaponVfx(manifest)!;
    expect(art.grid).toEqual([4, 8]);
    expect(art.flashes.pistol!.seconds).toBeCloseTo(0.04);
    expect(art.flashes.pistol!.rollRad).toBeCloseTo((6 * Math.PI) / 180);
    expect(art.flashes.bad).toBeUndefined(); // a frame past the atlas
    expect(art.weapons.hammer44).toEqual({ flash: 'pistol', flashScale: 1.25, tracer: 'pistol' });
    expect(art.weapons.widow!.flash).toBeNull(); // its style was dropped: procedural flash
    expect(art.tracers.sniper!.trail!.seconds).toBeCloseTo(0.45);
    expect(art.tracers.pistol!.tint[0]).toBeCloseTo(1);
  });

  it('a published style takes over: the flash comes from the atlas layer, tinted tracers', () => {
    const art = parseWeaponVfx(manifest)!;
    const g = new Gunfire(world);
    g.flashPool = new ParticlePool(8); // what setArt builds, without a texture
    (g as unknown as { art: typeof art }).art = art;
    const t = targets();
    g.onEvents([shot()]);
    g.update(1 / 60, t, noMuzzle);
    expect(count(t.glow, Ramp.Flash)).toBe(1); // only the impact's hot point: the flash went to the atlas layer
    expect(g.flashPool.count).toBe(1);
    expect([0, 1, 2, 3]).toContain(g.flashPool.data[F.cell]);
  });

  it('a Forge flash rides its gun while it lasts: moved and turned with the recoiling muzzle', () => {
    const art = parseWeaponVfx(manifest)!;
    const g = new Gunfire(world);
    g.flashPool = new ParticlePool(8, true);
    (g as unknown as { art: typeof art }).art = art;
    const t = targets();
    const at = { x: 150.2, y: 0.9, angle: 0 };
    const muzzle: MuzzleLookup = (id, _w, out, dir) => {
      out.set(at.x, at.y, 0.15);
      dir.set(Math.cos(at.angle), Math.sin(at.angle), 0);
      return id === 0;
    };
    g.onEvents([shot(), shot({ shooter: 1, ox: 140, ex: 145 })]);
    g.update(1 / 60, t, muzzle);
    const d = g.flashPool.data;
    const mine = d[F.x]! > 145 ? 0 : 1;
    const theirs = 1 - mine;
    const flash = (i: number) => ({ x: d[i * STRIDE + F.x]!, y: d[i * STRIDE + F.y]!, rot: d[i * STRIDE + F.rot]! });
    const before = flash(mine);
    const other = flash(theirs);
    // the gun kicks back 5 cm and climbs 0.2 rad: the flash keeps its place on the gun
    at.x -= 0.05;
    at.angle = 0.2;
    g.update(1 / 60, t, muzzle);
    const after = flash(mine);
    const rx = before.x - 150.2;
    const ry = before.y - 0.9;
    // (float32 storage: ~1e-5 at x = 150)
    expect(after.x).toBeCloseTo(150.15 + rx * Math.cos(0.2) - ry * Math.sin(0.2), 4);
    expect(after.y).toBeCloseTo(0.9 + rx * Math.sin(0.2) + ry * Math.cos(0.2), 4);
    expect(after.rot - before.rot).toBeCloseTo(0.2, 4);
    expect(flash(theirs)).toEqual(other); // an undrawn shooter's flash stays where the sim put it
  });

  it('keeps the procedural effects for anything unusable', () => {
    expect(parseWeaponVfx(null)).toBeNull();
    expect(parseWeaponVfx({ flash: { atlas: 'x.webp', atlasSize: [0, 1], cell: [1, 1] }, weapons: {} })).toBeNull();
  });
});

describe("Low's thinner tracers (every 3rd at most) for every gun that fires while held", () => {
  it('auto, burst, spin-up and beam guns (content heldTrigger: the Shredder too), not semi or melee', () => {
    const g = new Gunfire(new CollisionWorld(movementTestMap));
    g.low = true;
    expect(g.every(BUZZ.index)).toBeGreaterThanOrEqual(3);
    expect(g.every(SHREDDER.index)).toBeGreaterThanOrEqual(3); // spin-up
    expect(g.every(HAMMER.index)).toBe(1);
    g.low = false;
    expect(g.every(BUZZ.index)).toBeLessThan(3);
  });
});
