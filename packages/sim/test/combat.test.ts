import { BUZZ, FRAG, HAMMER, defaultTuning as T } from '@military-forge/content';
import { describe, expect, it } from 'vitest';
import { Btn, DamageSource, Game, hashGame, type SimEvent } from '../src';
import { dummyAt, flatMap, hold, makeGame, placeOnGround, rect } from './helpers';

/** Aim from the player's shoulder at a point. */
function aimAt(p: { x: number; y: number; facing: number }, tx: number, ty: number): number {
  return Math.atan2(ty - (p.y + T.shoulderStand), tx - (p.x + T.shoulderForward));
}

function shots(game: Game): Extract<SimEvent, { type: 'shot' }>[] {
  return game.events.filter((e): e is Extract<SimEvent, { type: 'shot' }> => e.type === 'shot');
}

describe('hitscan', () => {
  it('Hammer body shot deals 30, headshot 45, crouched head counts as torso', () => {
    const { game, p } = makeGame(flatMap());
    placeOnGround(game, p, 5);
    const d = dummyAt(game, 10);
    hold(game, p, 0, 5);
    hold(game, p, Btn.Fire, 1, aimAt(p, 10, 0.7));
    expect(d.hp).toBeCloseTo(70, 3);

    hold(game, p, 0, 60);
    d.hp = 100;
    hold(game, p, Btn.Fire, 1, aimAt(p, 10, 1.24));
    expect(d.hp).toBeCloseTo(100 - 30 * HAMMER.headMul, 3);

    hold(game, p, 0, 60);
    d.hp = 100;
    d.script = { kind: 'crouch', periodTicks: 1_000_000 };
    hold(game, p, 0, 5);
    expect(d.crouched).toBe(true);
    hold(game, p, Btn.Fire, 1, aimAt(p, 10, 0.84));
    expect(d.hp).toBeCloseTo(70, 3);
  });

  it('applies damage falloff beyond 50% range', () => {
    const { game, p } = makeGame(flatMap());
    placeOnGround(game, p, 5);
    const d = dummyAt(game, 25);
    hold(game, p, 0, 5);
    hold(game, p, Btn.Fire, 1, aimAt(p, 25, 0.7));
    const dist = Math.hypot(25 - (5 + T.shoulderForward), 0.7 - T.shoulderStand) - 0.3;
    const k = (dist - HAMMER.falloffStart) / (HAMMER.range - HAMMER.falloffStart);
    expect(100 - d.hp).toBeCloseTo(30 * (1 - 0.5 * k), 0);
    expect(100 - d.hp).toBeLessThan(30);
  });

  it('semi-auto fires once per press; auto fires every interval while held', () => {
    const { game, p } = makeGame(flatMap());
    placeOnGround(game, p, 5);
    let fired = 0;
    for (let i = 0; i < 120; i++) {
      hold(game, p, Btn.Fire, 1);
      fired += shots(game).length;
    }
    expect(fired).toBe(1);

    hold(game, p, Btn.Swap, 1);
    hold(game, p, 0, 20);
    expect(p.active).toBe(1);
    fired = 0;
    for (let i = 0; i < 60; i++) {
      hold(game, p, Btn.Fire, 1);
      fired += shots(game).length;
    }
    expect(fired).toBe(Math.round(1 / BUZZ.interval));
  });

  it('spread is deterministic for a seed and varies across seeds', () => {
    const endpoints = (seed: number) => {
      const { game, p } = makeGame(flatMap(), seed);
      placeOnGround(game, p, 5);
      hold(game, p, Btn.Swap, 1);
      hold(game, p, 0, 20);
      const out: number[] = [];
      for (let i = 0; i < 30; i++) {
        hold(game, p, Btn.Fire, 1);
        for (const s of shots(game)) out.push(s.ey);
      }
      return out;
    };
    expect(endpoints(7)).toEqual(endpoints(7));
    expect(endpoints(7)).not.toEqual(endpoints(8));
  });

  it('muzzle-in-wall guard: pressed against a wall, you shoot the wall, not the enemy behind it', () => {
    const { game, p } = makeGame(flatMap([rect(10, 0, 10.3, 6)]));
    placeOnGround(game, p, 9);
    hold(game, p, Btn.Right, 30); // walk into the wall
    expect(p.x).toBeGreaterThan(9.6);
    const d = dummyAt(game, 11.5);
    hold(game, p, 0, 5);
    hold(game, p, Btn.Fire, 1, 0);
    const s = shots(game)[0]!;
    expect(s.hit).toBe(1);
    expect(s.ex).toBeLessThanOrEqual(10 + 1e-9);
    expect(d.hp).toBe(100);
  });

  it('auto-reloads an empty magazine from reserve', () => {
    const { game, p } = makeGame(flatMap());
    placeOnGround(game, p, 5);
    const slot = p.weapons[0];
    for (let i = 0; i < HAMMER.mag; i++) {
      hold(game, p, Btn.Fire, 1);
      hold(game, p, 0, 40);
    }
    expect(slot.mag).toBe(0);
    expect(slot.reloadTicks).toBeGreaterThan(0);
    hold(game, p, 0, Math.round(HAMMER.reload * 60));
    expect(slot.mag).toBe(HAMMER.mag);
    expect(slot.reserve).toBe(HAMMER.reserve - HAMMER.mag);
  });

  it('dual-wield fires both guns', () => {
    const { game, p } = makeGame(flatMap());
    placeOnGround(game, p, 5);
    hold(game, p, Btn.Dual, 1);
    hold(game, p, 0, 30);
    expect(p.dual).toBe(true);
    hold(game, p, Btn.Fire, 1);
    expect(new Set(shots(game).map((s) => s.weapon))).toEqual(new Set([HAMMER.index, BUZZ.index]));
  });

  it('kills, scores and respawns', () => {
    const { game, p } = makeGame(flatMap());
    placeOnGround(game, p, 5);
    const d = dummyAt(game, 9);
    hold(game, p, 0, 5);
    for (let i = 0; i < 4; i++) {
      hold(game, p, Btn.Fire, 1, aimAt(p, 9, 0.7));
      hold(game, p, 0, 40);
    }
    expect(d.alive).toBe(false);
    expect(p.kills).toBe(1);
    hold(game, p, 0, Math.round(T.respawnDelay * 60));
    expect(d.alive).toBe(true);
    expect(d.hp).toBe(T.healthMax);
  });

  it('regenerates health after 4 s without damage', () => {
    const { game, p } = makeGame(flatMap());
    placeOnGround(game, p, 5);
    game.damage(p, 50, -1, DamageSource.World, 2);
    hold(game, p, 0, Math.round(T.healthRegenDelay * 60) - 1);
    expect(p.hp).toBeCloseTo(50, 5);
    hold(game, p, 0, 60);
    expect(p.hp).toBeCloseTo(50 + T.healthRegen, 0);
  });
});

describe('frag grenade', () => {
  it('bounces, settles on the floor without tunnelling, and explodes on its fuse', () => {
    const { game, p } = makeGame(flatMap());
    placeOnGround(game, p, 5);
    hold(game, p, Btn.Grenade, 1, Math.PI / 4);
    const g = game.grenades.find((x) => x.alive)!;
    expect(g).toBeDefined();
    let exploded = false;
    for (let i = 0; i < 200 && !exploded; i++) {
      hold(game, p, 0, 1);
      if (g.alive) expect(g.y).toBeGreaterThanOrEqual(FRAG.radius - 1e-3);
      exploded = game.events.some((e) => e.type === 'explosion');
    }
    expect(exploded).toBe(true);
    expect(p.frags).toBe(FRAG.spawnCount - 1);
  });

  it('never passes through a thin wall at full speed', () => {
    const { game, p } = makeGame(flatMap([rect(8, 0, 8.4, 10)]));
    placeOnGround(game, p, 5);
    hold(game, p, Btn.Grenade, 1, 0.05);
    const g = game.grenades.find((x) => x.alive)!;
    for (let i = 0; i < 80 && g.alive; i++) {
      hold(game, p, 0, 1);
      expect(g.x).toBeLessThan(8);
    }
  });

  it('full damage at the core, falloff with distance, none behind a wall, half to the thrower', () => {
    const { game, p } = makeGame(flatMap([rect(30, 0, 30.5, 10)]));
    placeOnGround(game, p, 5);
    const near = dummyAt(game, 15);
    const mid = dummyAt(game, 20);
    const covered = dummyAt(game, 32);
    hold(game, p, 0, 5);
    const explodeAt = (x: number) => {
      const g = game.allocGrenade()!;
      g.alive = true;
      g.owner = p.id;
      g.x = x;
      g.y = 0.5;
      g.vx = 0;
      g.vy = 0;
      g.fuse = 1;
      hold(game, p, 0, 1);
    };
    explodeAt(15);
    expect(near.alive).toBe(false);
    explodeAt(17.5);
    expect(100 - mid.hp).toBeGreaterThan(5);
    expect(100 - mid.hp).toBeLessThan(110);
    explodeAt(29.4);
    expect(covered.hp).toBe(100);
    explodeAt(5.5);
    expect(p.alive).toBe(true);
    expect(100 - p.hp).toBeCloseTo(110 * FRAG.explosion.selfDamageMul, 0);
  });
});

describe('determinism', () => {
  it('two games fed the same inputs hash identically every tick', () => {
    const a = new Game({ seed: 3, dummies: true });
    const b = new Game({ seed: 3, dummies: true });
    const pa = a.addPlayer('a');
    const pb = b.addPlayer('b');
    const script = [Btn.Right, Btn.Right | Btn.Jet, Btn.Fire | Btn.Right, Btn.Grenade, 0, Btn.Left | Btn.Fire];
    for (let i = 0; i < 600; i++) {
      const buttons = script[Math.floor(i / 37) % script.length]!;
      hold(a, pa, buttons, 1, (i % 90) / 30);
      hold(b, pb, buttons, 1, (i % 90) / 30);
      expect(hashGame(a)).toBe(hashGame(b));
    }
  });
});
