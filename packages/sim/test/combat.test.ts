import { BUZZ, FRAG, HAMMER, WIDOW, createTuning, defaultTuning as T } from '@military-forge/content';
import { describe, expect, it } from 'vitest';
import { Btn, DamageSource, Game, aimRay, createAimRay, hashGame, ticks, type SimEvent } from '../src';
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

  it('semi-auto fires on a press, then every holdRepeat while held; auto fires every interval while held', () => {
    const { game, p } = makeGame(flatMap());
    placeOnGround(game, p, 5);
    let fired = 0;
    const at: number[] = [];
    for (let i = 0; i < 120; i++) {
      hold(game, p, Btn.Fire, 1);
      if (shots(game).length) at.push(i);
      fired += shots(game).length;
    }
    // the press fires at once, the held trigger again every holdRepeat (0.7 s), not every interval (0.6 s)
    const repeat = ticks(HAMMER.holdRepeat!);
    expect(repeat).toBeGreaterThan(ticks(HAMMER.interval));
    expect(at).toEqual([0, repeat, 2 * repeat]);
    expect(fired).toBe(3);

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

  it('tapping a semi stays faster than holding it', () => {
    const fire = (tap: boolean): number => {
      const { game, p } = makeGame(flatMap());
      placeOnGround(game, p, 5);
      let n = 0;
      // a mag (6) is 6 shots either way: in 200 ticks the tapper gets all 6 off (0.6 s apart), the holder 5
      for (let i = 0; i < 200; i++) {
        // a fast tapper: down one tick, up the next
        hold(game, p, tap && i % 2 === 1 ? 0 : Btn.Fire, 1);
        n += shots(game).length;
      }
      return n;
    };
    expect([fire(true), fire(false)]).toEqual([6, 5]);
  });

  it('a semi without holdRepeat (the bolt sniper, the launchers) fires once per press', () => {
    const { game, p } = makeGame(flatMap());
    game.setLoadout(p, [WIDOW.index, HAMMER.index]);
    placeOnGround(game, p, 5);
    hold(game, p, 0, 30);
    let fired = 0;
    for (let i = 0; i < 180; i++) {
      hold(game, p, Btn.Fire, 1);
      fired += shots(game).length;
    }
    expect(WIDOW.holdRepeat).toBeUndefined();
    expect(fired).toBe(1);
  });

  it('the aim ray is where an unspread shot goes, cut at the first wall', () => {
    const { game, p } = makeGame(flatMap([rect(20, 0, 21, 4)]));
    game.setLoadout(p, [WIDOW.index, HAMMER.index]);
    placeOnGround(game, p, 5);
    hold(game, p, 0, 30);
    const ray = aimRay(game, p, p.weapons[0], WIDOW, createAimRay());
    expect(ray.spread).toBe(0); // planted: the Widow goes exactly down the line
    expect(ray.hit).toBe(true);
    expect(ray.ex).toBeCloseTo(20, 3);
    hold(game, p, Btn.Fire, 1);
    const [shot] = shots(game);
    expect(shot).toBeDefined();
    // (the event's coordinates are quantised)
    for (const [a, b] of [[shot!.ox, ray.ox], [shot!.oy, ray.oy], [shot!.ex, ray.ex], [shot!.ey, ray.ey]] as const) expect(a).toBeCloseTo(b, 2);
    // no wall within reach: the line runs to the gun's range
    const open = makeGame(flatMap([], [], 200));
    open.game.setLoadout(open.p, [WIDOW.index, HAMMER.index]);
    placeOnGround(open.game, open.p, 5);
    const far = aimRay(open.game, open.p, open.p.weapons[0], WIDOW, createAimRay());
    expect(far.hit).toBe(false);
    expect(Math.hypot(far.ex - far.ox, far.ey - far.oy)).toBeCloseTo(WIDOW.range - WIDOW.muzzleLength, 3);
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

  /** Sets off a frag at (x, y) owned by the shooter, then follows `target` until it lands. */
  function blastAndFollow(target: { x: number; y: number; grounded: boolean; alive: boolean; vx: number }, game: Game, owner: number, x: number, y: number) {
    const g = game.allocGrenade()!;
    Object.assign(g, { alive: true, owner, x, y, vx: 0, vy: 0, fuse: 1 / 60 });
    const x0 = target.x;
    let peak = target.y;
    let t = 0;
    for (; t < 300; t++) {
      game.step([]);
      peak = Math.max(peak, target.y);
      if (t > 3 && target.grounded && Math.abs(target.vx) < 0.05) break;
    }
    return { flew: target.x - x0, peak, seconds: t / 60, alive: target.alive };
  }

  it('a ground-level blast launches a survivor in an arc, far from it (regression: 3.6 m shove along the floor)', () => {
    const { game, p } = makeGame(flatMap([], [], 200));
    placeOnGround(game, p, 5);
    const target = dummyAt(game, 60);
    hold(game, p, 0, 5);
    const r = blastAndFollow(target, game, p.id, 58, 0.15); // 2 m to its left, on the floor
    expect(r.alive).toBe(true);
    expect(r.flew).toBeGreaterThan(12);
    expect(r.peak).toBeGreaterThan(4);
  });

  it('a blast from above still pushes down, never up', () => {
    const { game, p } = makeGame(flatMap([], [], 200));
    placeOnGround(game, p, 5);
    const target = dummyAt(game, 60);
    hold(game, p, 0, 5);
    const g = game.allocGrenade()!;
    Object.assign(g, { alive: true, owner: p.id, x: 60.5, y: 3.6, vx: 0, vy: 0, fuse: 1 / 60 });
    game.step([]);
    expect(target.vy).toBeLessThanOrEqual(0);
  });

  it("the tuning's grenade scales: throw speed and a blast's push (the host's tuning panel)", () => {
    const thrown = (grenadeThrowScale: number) => {
      const { game, p } = makeGame(flatMap());
      game.tuning = createTuning({ grenadeThrowScale });
      placeOnGround(game, p, 5);
      hold(game, p, Btn.Grenade, 1, Math.PI / 4);
      return game.grenades.find((x) => x.alive)!.vx;
    };
    expect(thrown(1.3) / thrown(1)).toBeCloseTo(1.3, 2);
    const pushed = (blastImpulseScale: number) => {
      const { game, p } = makeGame(flatMap([], [], 200));
      game.tuning = createTuning({ blastImpulseScale });
      placeOnGround(game, p, 5);
      const target = dummyAt(game, 60);
      hold(game, p, 0, 5);
      const g = game.allocGrenade()!;
      Object.assign(g, { alive: true, owner: p.id, x: 58, y: 0.15, vx: 0, vy: 0, fuse: 1 / 60 });
      game.step([]);
      return Math.hypot(target.vx, target.vy);
    };
    expect(pushed(0.5) / pushed(1)).toBeCloseTo(0.5, 1);
  });

  it('melee lunges never reach blast-launch speed, so they keep the normal air drag', () => {
    const { game, p } = makeGame(flatMap([], [], 400));
    placeOnGround(game, p, 5);
    let maxVx = 0;
    for (let i = 0; i < 180; i++) {
      hold(game, p, Btn.Right | (p.fuel > 0 ? Btn.Jet : 0) | (i % 2 === 0 ? Btn.Melee : 0), 1);
      maxVx = Math.max(maxVx, Math.abs(p.vx));
    }
    expect(maxVx).toBeLessThan(T.launchSpeedX);
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
