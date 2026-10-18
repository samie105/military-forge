import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BREACHER, BUZZ, HAMMER, K47, MACHETE, WIDOW, defaultTuning as T } from '@military-forge/content';
import { describe, expect, it } from 'vitest';
import { Btn, DamageSource, Game, currentSpread, hashGame, heldSpeedMul, runReplay, type PlayerState, type ReplayFile, type SimEvent } from '../src';
import { dummyAt, flatMap, hold, makeGame, placeOnGround, rect } from './helpers';

/** Aim from a standing player's shoulder at a point. */
function aimAt(p: { x: number; y: number }, tx: number, ty: number): number {
  return Math.atan2(ty - (p.y + T.shoulderStand), tx - (p.x + T.shoulderForward));
}

function events<K extends SimEvent['type']>(game: Game, type: K): Extract<SimEvent, { type: K }>[] {
  return game.events.filter((e): e is Extract<SimEvent, { type: K }> => e.type === type);
}

/** A player standing at x = 5 on flat ground holding `loadout` (slot 0 active). */
function armed(loadout: [number, number], extra: Parameters<typeof flatMap>[0] = [], seed = 1): { game: Game; p: PlayerState } {
  const { game, p } = makeGame(flatMap(extra), seed);
  game.setLoadout(p, loadout);
  placeOnGround(game, p, 5);
  return { game, p };
}

describe('weight (moveSpeedMul)', () => {
  it('caps walk, crouch and air speed by the held weapon', () => {
    const { game, p } = armed([WIDOW.index, HAMMER.index]);
    hold(game, p, Btn.Right, 60);
    expect(p.vx).toBeCloseTo(T.walkMax * WIDOW.moveSpeedMul, 9);

    hold(game, p, Btn.Right | Btn.Down, 60);
    expect(p.vx).toBeCloseTo(T.crouchMax * WIDOW.moveSpeedMul, 3); // velocity is on the 1/1024 grid

    hold(game, p, Btn.Right | Btn.Jet, 50);
    expect(p.grounded).toBe(false);
    expect(p.vx).toBeCloseTo(T.jetAirMaxX * WIDOW.moveSpeedMul, 2);

    // swap to the Hammer: back to full speed
    placeOnGround(game, p, 5);
    hold(game, p, Btn.Swap, 1);
    hold(game, p, Btn.Right, 60);
    expect(p.active).toBe(1);
    expect(p.vx).toBe(T.walkMax);
  });

  it('the Machete is lighter than a gun', () => {
    const { game, p } = armed([MACHETE.index, HAMMER.index]);
    hold(game, p, Btn.Right, 60);
    expect(p.vx).toBeCloseTo(T.walkMax * MACHETE.moveSpeedMul, 9);
  });

  it('a dual pair moves at the heaviest gun’s speed', () => {
    const saved = BUZZ.moveSpeedMul;
    BUZZ.moveSpeedMul = 0.8;
    try {
      const { game, p } = makeGame(flatMap());
      placeOnGround(game, p, 5);
      expect(heldSpeedMul(p)).toBe(HAMMER.moveSpeedMul);
      hold(game, p, Btn.Dual, 1);
      expect(p.dual).toBe(true);
      expect(heldSpeedMul(p)).toBe(0.8);
    } finally {
      BUZZ.moveSpeedMul = saved;
    }
  });
});

describe('new guns', () => {
  it('K-47: full auto at 10 rounds/s, 10 body hits kill, two-handed (no dual)', () => {
    const { game, p } = armed([K47.index, HAMMER.index]);
    hold(game, p, Btn.Dual, 1);
    expect(p.dual).toBe(false);
    let shots = 0;
    for (let i = 0; i < 60; i++) {
      hold(game, p, Btn.Fire, 1);
      shots += events(game, 'shot').length;
    }
    expect(shots).toBe(Math.round(1 / K47.interval));

    // a crouched target has no head zone, so every hit is a body hit
    const c = armed([K47.index, HAMMER.index]);
    const d = dummyAt(c.game, 8, 0, { kind: 'crouch', periodTicks: 1_000_000 });
    hold(c.game, c.p, 0, 5);
    let hits = 0;
    for (let i = 0; i < 120 && d.alive; i++) {
      hold(c.game, c.p, Btn.Fire, 1, aimAt(c.p, 8, 0.5));
      hits += events(c.game, 'hit').length;
    }
    expect(d.alive).toBe(false);
    expect(hits).toBe(10);
  });

  it('Breacher: 5 pellets spread evenly across the cone, with a small seeded jitter', () => {
    const { game, p } = armed([BREACHER.index, HAMMER.index]);
    const aim = Math.PI / 4;
    hold(game, p, Btn.Fire, 1, aim);
    const pellets = events(game, 'shot');
    expect(pellets.length).toBe(BREACHER.pellets);
    const sx = p.x + T.shoulderForward;
    const sy = p.y + T.shoulderStand;
    const offsets = pellets.map((s) => (Math.atan2(s.ey - sy, s.ex - sx) - aim) * (180 / Math.PI)).sort((a, b) => a - b);
    const gap = (2 * BREACHER.spread.base) / (BREACHER.pellets - 1);
    // jitter: ± PELLET_JITTER (0.25) of half the gap
    offsets.forEach((o, i) => expect(Math.abs(o - (-BREACHER.spread.base + i * gap))).toBeLessThanOrEqual(0.125 * gap + 0.01));
    expect(offsets.some((o, i) => Math.abs(o - (-BREACHER.spread.base + i * gap)) > 0.01)).toBe(true);
    expect(p.weapons[0].mag).toBe(BREACHER.mag - 1);
  });

  it('Breacher: one shot kills inside ~4 m; at 10 m most pellets miss and falloff bites', () => {
    const close = armed([BREACHER.index, HAMMER.index]);
    const d1 = dummyAt(close.game, 8.5);
    hold(close.game, close.p, 0, 5);
    hold(close.game, close.p, Btn.Fire, 1, aimAt(close.p, 8.5, 0.7));
    expect(events(close.game, 'hit').filter((h) => h.target === d1.id).length).toBe(BREACHER.pellets);
    expect(d1.alive).toBe(false);

    const far = armed([BREACHER.index, HAMMER.index]);
    const d2 = dummyAt(far.game, 15);
    hold(far.game, far.p, 0, 5);
    hold(far.game, far.p, Btn.Fire, 1, aimAt(far.p, 15, 0.7));
    expect(d2.alive).toBe(true);
    expect(100 - d2.hp).toBeLessThan(BREACHER.damage * BREACHER.pellets * 0.75);
  });

  it('Breacher: pellets do not pass through a victim an earlier pellet of the same shot killed', () => {
    for (const frontHp of [1000, 30]) {
      const { game, p } = armed([BREACHER.index, HAMMER.index]);
      const front = dummyAt(game, 8.5);
      const rear = dummyAt(game, 9.5); // fully covered by the front victim
      hold(game, p, 0, 5);
      front.hp = frontHp;
      hold(game, p, Btn.Fire, 1, aimAt(p, 8.5, 0.7));
      const shots = events(game, 'shot');
      expect(shots.length).toBe(BREACHER.pellets);
      expect(shots.every((s) => s.target === front.id)).toBe(true);
      expect(front.alive).toBe(frontHp > 100);
      expect(rear.hp).toBe(100);
    }
  });

  it('Breacher: pellets shove the victim; firing in the air pushes the shooter back', () => {
    const { game, p } = armed([BREACHER.index, HAMMER.index]);
    const d = dummyAt(game, 8, 0, { kind: 'jet', periodTicks: 1_000_000, burstTicks: 1_000_000 });
    d.hp = 1000; // survive, so the shove can be measured
    hold(game, p, Btn.Jet, 20);
    expect(p.grounded).toBe(false);
    const vx0 = p.vx;
    hold(game, p, Btn.Jet | Btn.Fire, 1, aimAt(p, d.x, d.y + 0.7));
    const hits = events(game, 'hit').filter((h) => h.target === d.id).length;
    expect(hits).toBeGreaterThan(0);
    expect(d.vx).toBeGreaterThan(0.5 * hits * BREACHER.hitImpulse);
    expect(p.vx).toBeLessThan(vx0 - 0.9 * BREACHER.recoilPushAir);

    // grounded: a short slide back (heavy guns only, NOTES §22.4)
    const g = armed([BREACHER.index, HAMMER.index]);
    hold(g.game, g.p, Btn.Fire, 1, 0);
    expect(g.p.vx).toBe(-BREACHER.recoilPushGround);
  });

  it('Widow: a headshot kills outright, a body shot does not, crouching denies the one-shot', () => {
    const { game, p } = armed([WIDOW.index, HAMMER.index]);
    const d = dummyAt(game, 20);
    hold(game, p, 0, 5);
    hold(game, p, Btn.Fire, 1, aimAt(p, 20, 0.7));
    expect(d.hp).toBeCloseTo(100 - WIDOW.damage, 3);
    hold(game, p, 0, 60);
    d.hp = 100;
    hold(game, p, Btn.Fire, 1, aimAt(p, 20, 1.24));
    expect(d.alive).toBe(false);

    const c = armed([WIDOW.index, HAMMER.index]);
    const crouched = dummyAt(c.game, 20, 0, { kind: 'crouch', periodTicks: 1_000_000 });
    hold(c.game, c.p, 0, 5);
    expect(crouched.crouched).toBe(true);
    hold(c.game, c.p, Btn.Fire, 1, aimAt(c.p, 20, 0.84));
    expect(crouched.alive).toBe(true);
    expect(crouched.hp).toBeCloseTo(100 - WIDOW.damage, 3);
  });

  it('Widow: zero spread on the ground, a minimum spread in the air', () => {
    const { game, p } = armed([WIDOW.index, HAMMER.index]);
    expect(currentSpread(p, p.weapons[0], WIDOW)).toBe(0);
    hold(game, p, Btn.Jet, 10);
    expect(p.grounded).toBe(false);
    expect(currentSpread(p, p.weapons[0], WIDOW)).toBe(WIDOW.spread.minAir);
  });
});

describe('melee', () => {
  it('lands 0.15 s after the press, for the held weapon’s melee damage, and shoves the victim', () => {
    const { game, p } = armed([HAMMER.index, BUZZ.index]);
    const d = dummyAt(game, 6.3);
    hold(game, p, 0, 5);
    hold(game, p, Btn.Melee, 1);
    hold(game, p, 0, 8);
    expect(d.hp).toBe(100);
    hold(game, p, 0, 1);
    const hit = events(game, 'hit')[0]!;
    expect(hit).toMatchObject({ attacker: p.id, target: d.id, damage: HAMMER.meleeDamage, source: DamageSource.Melee });
    expect(d.vx).toBeCloseTo(6, 3);
  });

  it('lunges: a short burst along the facing, on top of the run speed', () => {
    const still = armed([HAMMER.index, BUZZ.index]);
    hold(still.game, still.p, Btn.Melee, 1);
    for (let i = 0; i < 7; i++) {
      hold(still.game, still.p, 0, 1);
      expect(still.p.vx).toBe(4); // sidearm lunge
    }
    hold(still.game, still.p, 0, 1);
    expect(still.p.vx).toBeLessThan(4);

    const running = armed([K47.index, HAMMER.index]);
    hold(running.game, running.p, Btn.Left, 40, Math.PI); // facing left
    hold(running.game, running.p, Btn.Left | Btn.Melee, 1, Math.PI);
    hold(running.game, running.p, Btn.Left, 1, Math.PI);
    expect(running.p.vx).toBeCloseTo(-(T.walkMax * K47.moveSpeedMul + 3), 3); // rifle lunge 3 m/s
  });

  it('one swing per cooldown, and no firing during the windup', () => {
    const { game, p } = armed([HAMMER.index, BUZZ.index]);
    const d = dummyAt(game, 6.3);
    d.hp = 1000;
    hold(game, p, 0, 5);
    hold(game, p, Btn.Melee, 1);
    hold(game, p, Btn.Fire, 1);
    expect(events(game, 'shot').length).toBe(0);
    hold(game, p, 0, 15);
    hold(game, p, Btn.Melee, 1); // still cooling down: ignored
    hold(game, p, 0, 20);
    expect(1000 - d.hp).toBe(HAMMER.meleeDamage);
    hold(game, p, Btn.Fire, 1);
    expect(events(game, 'shot').length).toBe(1);
  });

  it('hits everyone in the arc, but not behind, beyond reach or through a wall', () => {
    const { game, p } = armed([HAMMER.index, BUZZ.index]);
    const a = dummyAt(game, 6.2);
    const b = dummyAt(game, 6.4);
    const behind = dummyAt(game, 4.2);
    const far = dummyAt(game, 8.5);
    hold(game, p, 0, 5);
    hold(game, p, Btn.Melee, 1);
    hold(game, p, 0, 40);
    expect([a.hp, b.hp, behind.hp, far.hp]).toEqual([100 - HAMMER.meleeDamage, 100 - HAMMER.meleeDamage, 100, 100]);

    const walled = armed([HAMMER.index, BUZZ.index], [rect(5.7, 0, 5.8, 3)]);
    const covered = dummyAt(walled.game, 6.3);
    hold(walled.game, walled.p, 0, 5);
    hold(walled.game, walled.p, Btn.Melee, 1);
    hold(walled.game, walled.p, 0, 40);
    expect(covered.hp).toBe(100);
  });

  it('a swing trims knockback by the lunge, never erases or reverses it', () => {
    const { game, p } = armed([HAMMER.index, BUZZ.index]);
    hold(game, p, Btn.Jet, 20, Math.PI);
    hold(game, p, 0, 1, Math.PI);
    expect(p.grounded).toBe(false);
    expect(p.facing).toBe(-1);
    p.vx = 12; // flung right (an explosion or a shove), facing left
    hold(game, p, 0, 2, Math.PI);
    const unswung = p.vx; // two ticks of air drag
    p.vx = 12;
    hold(game, p, Btn.Melee, 1, Math.PI);
    hold(game, p, 0, 1, Math.PI);
    expect(p.vx).toBeGreaterThan(0);
    expect(p.vx).toBeCloseTo(unswung - 4, 1); // sidearm lunge: 4 m/s once
    const after = p.vx;
    hold(game, p, 0, 6, Math.PI); // rest of the lunge window: no more than drag
    expect(p.vx).toBeGreaterThan(0);
    expect(p.vx).toBeLessThanOrEqual(after);

    // grounded, running right, then swinging to the left: a 3 m/s trim, not a flip
    const g = armed([K47.index, HAMMER.index]);
    hold(g.game, g.p, Btn.Right, 40, 0);
    const run = g.p.vx;
    hold(g.game, g.p, Btn.Right | Btn.Melee, 1, Math.PI);
    hold(g.game, g.p, Btn.Right, 1, Math.PI);
    expect(g.p.vx).toBeGreaterThan(0);
    expect(g.p.vx).toBeGreaterThanOrEqual(run - 3 - 1e-9);
  });

  it('the Machete kills in one swing, with Fire or Melee while held, and never dual-wields', () => {
    const { game, p } = armed([MACHETE.index, HAMMER.index]);
    const d = dummyAt(game, 6.3);
    hold(game, p, 0, 5);
    hold(game, p, Btn.Dual, 1);
    expect(p.dual).toBe(false);
    hold(game, p, 0, 30);
    hold(game, p, Btn.Fire, 1);
    hold(game, p, 0, 10);
    expect(d.alive).toBe(false);
    expect(p.kills).toBe(1);

    const held = armed([MACHETE.index, HAMMER.index]);
    const e = dummyAt(held.game, 6.3);
    hold(held.game, held.p, 0, 5);
    hold(held.game, held.p, Btn.Melee, 1);
    let death: SimEvent | undefined;
    for (let i = 0; i < 10 && !death; i++) {
      hold(held.game, held.p, 0, 1);
      death = events(held.game, 'death')[0];
    }
    expect(death).toMatchObject({ victim: e.id, killer: held.p.id, source: DamageSource.Melee });
    expect(held.p.weapons[0].mag).toBe(0);
  });

  it('a Machete carried in the other slot does not replace the held gun’s bash (docs/03 §11: "while held")', () => {
    const { game, p } = armed([HAMMER.index, MACHETE.index]);
    const d = dummyAt(game, 6.3);
    hold(game, p, 0, 5);
    expect(p.active).toBe(0);
    hold(game, p, Btn.Melee, 1);
    hold(game, p, 0, 10);
    expect(d.alive).toBe(true);
    expect(events(game, 'hit')).toEqual([]);
    expect(100 - d.hp).toBe(HAMMER.meleeDamage);
  });
});

describe('loadouts', () => {
  it('setLoadout equips now and on every respawn', () => {
    const { game, p } = armed([BREACHER.index, WIDOW.index]);
    expect(p.weapons.map((w) => [w.def, w.mag, w.reserve])).toEqual([
      [BREACHER.index, BREACHER.mag, BREACHER.reserve],
      [WIDOW.index, WIDOW.mag, WIDOW.reserve],
    ]);
    game.damage(p, 1000, -1, DamageSource.World, 2);
    hold(game, p, 0, Math.round(T.respawnDelay * 60) + 1);
    expect(p.alive).toBe(true);
    expect(p.weapons.map((w) => w.def)).toEqual([BREACHER.index, WIDOW.index]);
  });
});

describe('arsenal determinism', () => {
  it('two games fed the same inputs hash identically every tick (pellets, melee, recoil, weight)', () => {
    const run = () => {
      const game = new Game({ seed: 9, dummies: true });
      const p = game.addPlayer('a');
      p.spawn(150, 0, game.tuning);
      game.setLoadout(p, [BREACHER.index, MACHETE.index]);
      return { game, p };
    };
    const a = run();
    const b = run();
    const script = [Btn.Right, Btn.Fire, Btn.Melee | Btn.Right, Btn.Jet | Btn.Fire, Btn.Swap, Btn.Fire | Btn.Left, Btn.Melee, 0];
    const hashes: number[] = [];
    for (let i = 0; i < 480; i++) {
      const buttons = script[Math.floor(i / 23) % script.length]!;
      hold(a.game, a.p, buttons, 1, (i % 90) / 60 - 0.5);
      hold(b.game, b.p, buttons, 1, (i % 90) / 60 - 0.5);
      expect(hashGame(a.game)).toBe(hashGame(b.game));
      hashes.push(hashGame(a.game));
    }
    expect(new Set(hashes).size).toBeGreaterThan(400);
  });

  it('a swing in progress changes the state hash', () => {
    const { game } = armed([HAMMER.index, BUZZ.index]);
    const before = hashGame(game);
    const p = game.players.find((q) => q && !q.isBot)!;
    p.meleeTicks = 3;
    expect(hashGame(game)).not.toBe(before);
  });
});

describe('arsenal golden replays', () => {
  /** Guards the scripted goldens (scripts/generate-replays.ts) against silently missing their targets. */
  const run = (name: string) => {
    const replay = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'replays', `${name}.replay.json`), 'utf8')) as ReplayFile;
    const hits: Record<number, number> = {};
    const kills: Record<number, number> = {};
    let minVx = 0;
    let maxVx = 0;
    /** walking right on the ground, a second after the last shot (its recoil slide is over) */
    let maxWalkVx = 0;
    let sinceShot = 999;
    runReplay(replay, (game) => {
      const me = game.players.find((q) => q && !q.isBot)!;
      minVx = Math.min(minVx, me.vx);
      maxVx = Math.max(maxVx, me.vx);
      sinceShot++;
      for (const e of game.events) {
        if (e.type === 'hit' && e.attacker === me.id) hits[e.source] = (hits[e.source] ?? 0) + 1;
        if (e.type === 'death' && e.killer === me.id) kills[e.source] = (kills[e.source] ?? 0) + 1;
        if (e.type === 'shot' && e.shooter === me.id) sinceShot = 0;
      }
      if (me.grounded && me.input.buttons & Btn.Right && sinceShot > 60) maxWalkVx = Math.max(maxWalkVx, me.vx);
    });
    return { hits, kills, minVx, maxVx, maxWalkVx };
  };

  it('arsenal-guns: a bash, shotgun kills, K-47 hits, airborne recoil and rifle weight', () => {
    const r = run('arsenal-guns');
    expect(r.hits[DamageSource.Melee]).toBe(1);
    expect(r.kills[BREACHER.index]).toBe(2);
    expect(r.hits[K47.index]).toBeGreaterThanOrEqual(8);
    expect(r.minVx).toBeLessThan(-0.8 * BREACHER.recoilPushAir);
    expect(r.maxVx).toBeCloseTo(T.jetAirMaxX * K47.moveSpeedMul, 2);
  });

  it('arsenal-melee-sniper: two Machete kills, a Widow hit and sniper weight', () => {
    const r = run('arsenal-melee-sniper');
    expect(r.kills[DamageSource.Melee]).toBe(2);
    expect(r.hits[WIDOW.index]).toBe(1);
    expect(r.maxWalkVx).toBeCloseTo(T.walkMax * WIDOW.moveSpeedMul, 9);
    expect(r.minVx).toBeCloseTo(-WIDOW.recoilPushGround, 1); // the grounded shot's kick
  });
});
