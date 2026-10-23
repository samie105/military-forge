/**
 * Bullet-only parts (MapDef.bulletOnly; 23 Oct QA, "bullets pass through obstacles"): thin posts,
 * poles, masts, rails and plates stop bullets and the bots' line of fire, never bodies. And the
 * Street Market's kit parts that had no collider: a ray fired at each one stops on it.
 */
import { maps, type MapDef } from '@military-forge/content';
import { describe, expect, it } from 'vitest';
import { Btn, CollisionWorld, SegFlag, createRayHit } from '../src';
import { flatMap, hold, makeGame, placeOnGround } from './helpers';

const hit = createRayHit();
/** a 0.1 m post at x 20, 0..3 m */
const POST = { points: [19.95, 0, 20.05, 0, 20.05, 3, 19.95, 3] };

function withPost(): MapDef {
  return { ...flatMap([], [], 80), bulletOnly: [POST] };
}

describe('bullet-only parts', () => {
  it('stop a bullet coming from either side; bodies, grenades, blasts and sight (raycast) pass them', () => {
    const world = new CollisionWorld(withPost());
    expect(world.raycastBullet(10, 1, 1, 0, 30, SegFlag.BulletPass, hit)).toBe(true);
    expect(hit.x).toBeCloseTo(19.95, 6);
    expect(world.material[hit.seg]).toBe(1); // metal by default
    expect(world.raycastBullet(30, 1, -1, 0, 30, SegFlag.BulletPass, hit)).toBe(true);
    expect(hit.x).toBeCloseTo(20.05, 6);
    // over the top: clear
    expect(world.raycastBullet(10, 3.5, 1, 0, 30, SegFlag.BulletPass, hit)).toBe(false);
    // everything else: the grid doesn't hold them
    expect(world.raycast(10, 1, 1, 0, 30, SegFlag.BulletPass, hit)).toBe(false);
    const n = world.queryAabb(19.9, 0.5, 20.1, 2.5);
    for (let i = 0; i < n; i++) expect(world.queryResult[i]!).toBeLessThan(world.segCount);
    expect(world.shotCount).toBe(4);
  });

  it('a shot that starts inside one leaves it (a shooter standing at a pole can shoot out)', () => {
    const world = new CollisionWorld(withPost());
    expect(world.raycastBullet(20, 1, 1, 0, 5, SegFlag.BulletPass, hit)).toBe(false);
    expect(world.raycastBullet(20, 1, -1, 0, 5, SegFlag.BulletPass, hit)).toBe(false);
  });

  it('the world in front still wins when it is nearer', () => {
    const map = withPost();
    map.solids.push({ points: [15, 0, 16, 0, 16, 3, 15, 3] });
    const world = new CollisionWorld(map);
    expect(world.raycastBullet(10, 1, 1, 0, 30, SegFlag.BulletPass, hit)).toBe(true);
    expect(hit.x).toBeCloseTo(15, 6);
  });

  it('a player walks straight through one, and a shot at it from outside stops there', () => {
    const { game, p } = makeGame(withPost());
    placeOnGround(game, p, 16);
    hold(game, p, Btn.Right, 90);
    expect(p.x).toBeGreaterThan(22); // no snag
    placeOnGround(game, p, 12);
    hold(game, p, Btn.Fire, 1, 0);
    const shot = game.events.find((e) => e.type === 'shot');
    expect(shot).toMatchObject({ hit: 1 });
    expect(shot?.type === 'shot' && shot.ex).toBeCloseTo(19.95, 3);
  });
});

describe('Street Market: kit parts that had no collider (QA 23 Oct)', () => {
  const world = new CollisionWorld(maps['street-market']!);
  /** where a bullet fired from (ox, oy) along (dx, dy) stops, or null */
  const stop = (ox: number, oy: number, dx: number, dy: number) => (world.raycastBullet(ox, oy, dx, dy, 20, SegFlag.BulletPass, hit) ? { x: hit.x, y: hit.y } : null);

  it.each([
    ['the minibus underside (0–0.35 m), west', -12.5, 0.2, 1, 0, -11.6, 0.2],
    ['the minibus underside, east', 12.5, 0.2, -1, 0, 11.6, 0.2],
    ['a stall post', -42, 2, 1, 0, -39.95, 2],
    ['an umbrella pole', -35.5, 2, 1, 0, -34.04, 2],
    ['a tank tower leg', -2.5, 2, 1, 0, -1.46, 2],
    ['a tank tower brace', 0, 3.5, 0, -1, 0, 2.76],
    ['a billboard mast', -6, 7, 1, 0, -3.34, 7],
    ['the catwalk front plate', -4.5, 10.4, 1, 0, -4, 10.4],
    ['a balcony handrail post', -52.6, 4.5, 1, 0, -52.08, 4.5],
    ['a balcony handrail', -51.5, 5.5, 0, -1, -51.5, 4.9],
  ] as const)('%s', (_name, ox, oy, dx, dy, ex, ey) => {
    const at = stop(ox, oy, dx, dy);
    expect(at).not.toBeNull();
    expect(at!.x).toBeCloseTo(ex, 3);
    expect(at!.y).toBeCloseTo(ey, 3);
  });

  it('bodies still pass them: the street at the tank tower is open to walking', () => {
    expect(world.raycast(-2.5, 2, 1, 0, 5, SegFlag.OneWay, hit)).toBe(false);
  });
});
