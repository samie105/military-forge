import { BREACHER, BUZZ, FRAG, HAMMER, HitZone, K47, RIOT_SHIELD, WIDOW, defaultTuning as T, type MapZone } from '@military-forge/content';
import { angleToU16 } from '@military-forge/shared';
import { describe, expect, it } from 'vitest';
import {
  Btn,
  DamageSource,
  Game,
  SHIELD_RAISE_TICKS,
  createInput,
  explode,
  giveShield,
  shieldBottom,
  shieldHitT,
  shieldRaised,
  shieldSlung,
  type HitPose,
  type Input,
  type PlayerState,
  type SimEvent,
} from '../src';
import { flatMap, placeOnGround, rect } from './helpers';

type Ev<K extends SimEvent['type']> = Extract<SimEvent, { type: K }>;
const events = <K extends SimEvent['type']>(list: readonly SimEvent[], type: K): Ev<K>[] => list.filter((e): e is Ev<K> => e.type === type);

/** Each player's input for the next steps (aim in radians). */
type Plan = Map<PlayerState, { buttons: number; aim: number }>;

function step(game: Game, plan: Plan, n = 1): SimEvent[] {
  const inputs: Input[] = [];
  const all: SimEvent[] = [];
  for (let i = 0; i < n; i++) {
    for (const [p, { buttons, aim }] of plan) inputs[p.id] = { ...createInput(), buttons, aim: angleToU16(aim) };
    game.step(inputs);
    all.push(...game.events);
  }
  return all;
}

/** Shoulder of a standing player facing right (the sim's shot origin). */
const shoulder = (p: PlayerState) => ({ x: p.x + T.shoulderForward, y: p.y + T.shoulderStand });

/**
 * A (shooter, x = 5) and B (x = 12, shield up, facing A) on flat ground; optionally C behind A.
 * `extra` adds solids (platforms), `zones` map zones (docs/02 §20).
 */
function duel(shooterLoadout: [number, number], opts: { c?: number; extra?: Parameters<typeof flatMap>[0]; zones?: MapZone[] } = {}) {
  const game = new Game({ map: { ...flatMap(opts.extra ?? []), ...(opts.zones ? { zones: opts.zones } : {}) }, seed: 3 });
  const a = game.addPlayer('a');
  const b = game.addPlayer('b');
  const c = opts.c !== undefined ? game.addPlayer('c') : null;
  game.setLoadout(a, shooterLoadout);
  placeOnGround(game, a, 5);
  placeOnGround(game, b, 12);
  if (c) placeOnGround(game, c, opts.c!);
  giveShield(b, RIOT_SHIELD.hp);
  const plan: Plan = new Map([
    [a, { buttons: 0, aim: 0 }],
    [b, { buttons: 0, aim: Math.PI }],
  ]);
  if (c) plan.set(c, { buttons: 0, aim: 0 });
  step(game, plan, SHIELD_RAISE_TICKS + 5);
  expect(shieldRaised(b)).toBe(true);
  expect(b.facing).toBe(-1);
  return { game, a, b, c, plan };
}

/** One trigger pull by `p` aimed at (tx, ty), from where it stands. */
function fireAt(game: Game, plan: Plan, p: PlayerState, tx: number, ty: number, buttons = Btn.Fire): SimEvent[] {
  const s = shoulder(p);
  plan.get(p)!.aim = Math.atan2(ty - s.y, tx - s.x);
  plan.get(p)!.buttons = buttons;
  const out = step(game, plan);
  plan.get(p)!.buttons = 0;
  out.push(...step(game, plan, 60)); // cooldown, and a release for semi-auto
  return out;
}

const SHIELD_X = 12 - RIOT_SHIELD.forward;

/** duel(), then B turns its back on A (facing +x) and slings its shield with the key. */
function backTurned(shooterLoadout: [number, number] = [WIDOW.index, HAMMER.index], c?: number) {
  const d = duel(shooterLoadout, c === undefined ? {} : { c });
  const { game, b, plan } = d;
  plan.get(b)!.aim = 0;
  plan.get(b)!.buttons = Btn.Shield;
  step(game, plan);
  plan.get(b)!.buttons = 0;
  step(game, plan, 2);
  expect(b.facing).toBe(1);
  expect(shieldSlung(b)).toBe(true);
  return d;
}

describe('riot shield: block arc', () => {
  it('blocks a bullet within ±60° of the facing and lets one at 61° through', () => {
    // a ray aimed at the middle of the segment of a shield held by a player at the origin facing −x
    const mid = shieldBottom(false) + RIOT_SHIELD.height / 2;
    const fx = -RIOT_SHIELD.forward;
    for (const deg of [-61, -59, 0, 59, 61]) {
      const a = (deg * Math.PI) / 180;
      // the bullet travels toward +x (into the shield's face) at `deg` off the shield normal
      const dx = Math.cos(a);
      const dy = Math.sin(a);
      const t = shieldHitT(fx - 2 * dx, mid - 2 * dy, dx, dy, 0, 0, -1, false);
      if (Math.abs(deg) <= 60) expect(t, `${deg}°`).toBeCloseTo(2, 9);
      else expect(t, `${deg}°`).toBe(Infinity);
    }
    // from behind, or along the face: never
    expect(shieldHitT(fx + 2, mid, -1, 0, 0, 0, -1, false)).toBe(Infinity);
    expect(shieldHitT(fx, mid + 2, 0, -1, 0, 0, -1, false)).toBe(Infinity);
  });

  it('follows the crouch: crouched it sits lower', () => {
    const fx = -RIOT_SHIELD.forward;
    const y = shieldBottom(true) + 0.05; // below the standing shield, inside the crouched one
    expect(shieldBottom(true)).toBeLessThan(shieldBottom(false));
    expect(shieldHitT(fx - 1, y, 1, 0, 0, 0, -1, true)).toBeCloseTo(1, 9);
    expect(shieldHitT(fx - 1, y, 1, 0, 0, 0, -1, false)).toBe(Infinity);
  });

  it('in play: a shot from steeper than 60° above crosses it and hits the body behind', () => {
    // A stands on a 6 m tower 2.4 m in front of B and shoots down through the shield's upper part
    const { game, a, b, plan } = duel([WIDOW.index, HAMMER.index], { extra: [rect(8.5, 0, 9.5, 6)] });
    a.x = 9.2;
    a.y = 6.01;
    a.grounded = false;
    step(game, plan, 30);
    expect(a.grounded).toBe(true);
    const s = shoulder(a);
    const tx = SHIELD_X;
    const ty = b.y + 1.1; // inside the segment (0.35–1.25)
    expect(Math.atan2(s.y - ty, tx - s.x)).toBeGreaterThan((61 * Math.PI) / 180);
    const ev = fireAt(game, plan, a, tx, ty);
    const shot = events(ev, 'shot')[0]!;
    expect(shot.hit).toBe(2);
    expect(shot.target).toBe(b.id);
    expect(b.shieldHp).toBe(RIOT_SHIELD.hp);
    expect(b.hp).toBeLessThan(T.healthMax);
  });
});

describe('riot shield: damage, break, ricochet', () => {
  it('a bullet on the shield takes shield HP, not health, and bounces off mirrored about the normal', () => {
    const { game, a, b, plan } = duel([WIDOW.index, HAMMER.index]);
    const ev = fireAt(game, plan, a, SHIELD_X, 0.6);
    const shot = events(ev, 'shot')[0]!;
    expect([shot.hit, shot.target]).toEqual([3, b.id]);
    expect(shot.ex).toBeCloseTo(SHIELD_X, 9);
    expect(b.hp).toBe(T.healthMax);
    expect(b.shieldHp).toBe(RIOT_SHIELD.hp - WIDOW.damage);

    const r = events(ev, 'ricochet')[0]!;
    expect(r).toMatchObject({ shooter: a.id, owner: b.id, weapon: WIDOW.index, nx: -1, ny: 0 });
    expect([r.x, r.y]).toEqual([shot.ex, shot.ey]);
    // in: muzzle → bounce point (a Widow on the ground has no spread: the muzzle is on the bullet's
    // line); out: bounce point → end. Mirrored about the normal: horizontal flips, vertical keeps
    const inLen = Math.hypot(r.x - shot.ox, r.y - shot.oy);
    const outLen = Math.hypot(r.ex - r.x, r.ey - r.y);
    expect((r.ex - r.x) / outLen).toBeCloseTo(-(r.x - shot.ox) / inLen, 9);
    expect((r.ey - r.y) / outLen).toBeCloseTo((r.y - shot.oy) / inLen, 9);
    expect((r.ey - r.y) / outLen).toBeLessThan(-0.05); // aimed down, it leaves down
    expect(Math.abs(r.y - 0.6)).toBeLessThan(0.002); // where it was aimed (u16 aim)
    // it flew past the shooter (never hits its own shooter) and into the floor behind it
    expect(r.hit).toBe(1);
    expect(r.ex).toBeLessThan(a.x);
    expect(r.ey).toBeCloseTo(0, 6);
    expect(a.hp).toBe(T.healthMax);
  });

  it('a ricochet hits a third player for 60% of the damage; never the shooter (owner, 17 Oct 2026) or the shield owner', () => {
    const { game, a, b, c, plan } = duel([WIDOW.index, HAMMER.index], { c: 2 });
    const ev = fireAt(game, plan, a, SHIELD_X, shoulder(a).y); // head-on: straight back
    const r = events(ev, 'ricochet')[0]!;
    // it flew back through the shooter's body (level, at its shoulder) and on to C behind it
    expect(Math.abs(r.ey - shoulder(a).y)).toBeLessThan(0.01);
    expect(r.ex).toBeLessThan(a.x);
    expect([r.hit, r.target]).toEqual([2, c!.id]);
    const hit = events(ev, 'hit')[0]!;
    expect(hit).toMatchObject({ attacker: a.id, target: c!.id, source: WIDOW.index });
    expect(hit.damage).toBeCloseTo(WIDOW.damage * RIOT_SHIELD.ricochetDamageMul, 9); // inside falloffStart
    expect(a.hp).toBe(T.healthMax);
    expect(b.hp).toBe(T.healthMax);
    expect(c!.hp).toBeCloseTo(T.healthMax - hit.damage, 2);
  });

  it('one bounce at most: a ricochet that meets another raised shield is stopped by it', () => {
    const { game, a, b, c, plan } = duel([WIDOW.index, HAMMER.index], { c: 2 });
    giveShield(c!, RIOT_SHIELD.hp);
    plan.get(c!)!.aim = 0; // facing B: its shield meets the ricochet head-on
    step(game, plan, SHIELD_RAISE_TICKS + 1);
    const ev = fireAt(game, plan, a, SHIELD_X, shoulder(a).y);
    const r = events(ev, 'ricochet');
    expect(r.length).toBe(1);
    expect([r[0]!.hit, r[0]!.target]).toEqual([3, c!.id]);
    expect(c!.shieldHp).toBeCloseTo(RIOT_SHIELD.hp - WIDOW.damage * RIOT_SHIELD.ricochetDamageMul, 2);
    expect(c!.hp).toBe(T.healthMax);
    expect(b.shieldHp).toBe(RIOT_SHIELD.hp - WIDOW.damage);
  });

  it('wears down and breaks at 0; the bullet that breaks it is spent, the next one hits the body', () => {
    const { game, a, b, plan } = duel([WIDOW.index, HAMMER.index]);
    b.shieldHp = WIDOW.damage + 10;
    let ev = fireAt(game, plan, a, SHIELD_X, 0.8);
    expect(b.shieldHp).toBe(10);
    expect(events(ev, 'shieldBreak').length).toBe(0);
    ev = fireAt(game, plan, a, SHIELD_X, 0.8);
    const broke = events(ev, 'shieldBreak');
    expect(broke.length).toBe(1);
    expect(broke[0]).toMatchObject({ owner: b.id, attacker: a.id });
    expect(broke[0]!.x).toBeCloseTo(SHIELD_X, 9);
    expect(broke[0]!.y).toBeCloseTo(0.8, 2);
    expect(events(ev, 'ricochet').length).toBe(0);
    expect([b.shieldHp, b.shieldTicks, b.shieldStowed]).toEqual([0, 0, false]);
    expect(b.hp).toBe(T.healthMax);
    ev = fireAt(game, plan, a, 12, 0.8);
    expect(events(ev, 'shot')[0]!.hit).toBe(2);
    expect(b.hp).toBeLessThan(T.healthMax);
  });

  it('shotgun pellets ricochet one by one', () => {
    const { game, a, b, plan } = duel([BREACHER.index, HAMMER.index]);
    placeOnGround(game, a, 10);
    const s = shoulder(a);
    plan.get(a)!.aim = Math.atan2(0.8 - s.y, SHIELD_X - s.x);
    plan.get(a)!.buttons = Btn.Fire;
    const ev = step(game, plan);
    const shots = events(ev, 'shot');
    const bounces = events(ev, 'ricochet');
    expect(shots.length).toBe(BREACHER.pellets);
    expect(shots.every((s) => s.hit === 3 && s.target === b.id)).toBe(true);
    expect(bounces.length).toBe(BREACHER.pellets);
    // each pellet leaves at its own (mirrored) angle
    expect(new Set(bounces.map((r) => Math.round(Math.atan2(r.ey - r.y, r.ex - r.x) * 1e6))).size).toBe(BREACHER.pellets);
    expect(b.shieldHp).toBeCloseTo(RIOT_SHIELD.hp - BREACHER.pellets * BREACHER.damage, 6);
    expect(b.hp).toBe(T.healthMax);
    expect(b.vx).toBeGreaterThan(0); // the pellets still shove its owner back
  });

  it('a slung shield does not block the front, and a raised one does not block the back', () => {
    const { game, a, b, plan } = duel([WIDOW.index, HAMMER.index]);
    plan.get(b)!.buttons = Btn.Shield; // sling it
    step(game, plan);
    plan.get(b)!.buttons = 0;
    let ev = fireAt(game, plan, a, 12, 0.8);
    expect(events(ev, 'shot')[0]!.hit).toBe(2);
    expect(b.shieldHp).toBe(RIOT_SHIELD.hp);

    b.hp = T.healthMax;
    plan.get(b)!.buttons = Btn.Shield; // up again, but facing away from A
    plan.get(b)!.aim = 0;
    step(game, plan);
    plan.get(b)!.buttons = 0;
    step(game, plan, SHIELD_RAISE_TICKS);
    expect(shieldRaised(b)).toBe(true);
    ev = fireAt(game, plan, a, 12, 0.8);
    expect(events(ev, 'shot')[0]!.hit).toBe(2);
    expect(b.shieldHp).toBe(RIOT_SHIELD.hp);
  });

  it('melee bypasses it; a gun bash with the shield up is a 25-damage shield bash', () => {
    const { game, a, b, plan } = duel([BUZZ.index, HAMMER.index]);
    placeOnGround(game, a, 11);
    const ev = fireAt(game, plan, a, 12, 0.9, Btn.Melee);
    expect(events(ev, 'hit')[0]).toMatchObject({ attacker: a.id, target: b.id, damage: BUZZ.meleeDamage, source: DamageSource.Melee });
    expect(b.shieldHp).toBe(RIOT_SHIELD.hp);

    // now B (shield up, a Buzz in hand: its own bash would be 20) bashes A
    game.setLoadout(b, [BUZZ.index, HAMMER.index]);
    step(game, plan, 2);
    expect(shieldRaised(b)).toBe(true);
    a.hp = T.healthMax;
    placeOnGround(game, a, 11);
    const bash = fireAt(game, plan, b, 11, 0.9, Btn.Melee);
    expect(events(bash, 'hit')[0]).toMatchObject({ attacker: b.id, target: a.id, damage: RIOT_SHIELD.bashDamage, source: DamageSource.Melee });
  });

  it('a carrier shoved off a ledge by pellets on its shield is the shooter\'s kill, not a suicide (review L1)', () => {
    // the floor ends at x 20: a pit beyond
    const map = { ...flatMap(), solids: [rect(-2, -6, 20, 0), rect(30, -6, 62, 0), rect(-2, 0, 0, 28), rect(60, 0, 62, 28), rect(-2, 28, 62, 30)] };
    const game = new Game({ map, seed: 6 });
    const a = game.addPlayer('a');
    const b = game.addPlayer('b');
    game.setLoadout(a, [BREACHER.index, HAMMER.index]);
    placeOnGround(game, a, 17.6);
    placeOnGround(game, b, 19.6);
    giveShield(b, RIOT_SHIELD.hp);
    const plan: Plan = new Map([
      [a, { buttons: 0, aim: 0 }],
      [b, { buttons: 0, aim: Math.PI }],
    ]);
    step(game, plan, SHIELD_RAISE_TICKS + 2);
    let death: Ev<'death'> | undefined;
    for (let t = 0; t < 1500 && !death; t++) {
      const s = shoulder(a);
      plan.get(a)!.aim = Math.atan2(b.y + 0.8 - s.y, b.x - RIOT_SHIELD.forward - s.x);
      // shove it while it stands; once it tips off the ledge, hold fire (a body hit would credit A anyway).
      // Each pump shoves it ~5 cm: keep the shield topped up so only the shove is in play
      plan.get(a)!.buttons = t % 50 === 0 && b.grounded ? Btn.Fire : 0;
      b.shieldHp = RIOT_SHIELD.hp;
      const ev = step(game, plan);
      expect(events(ev, 'hit').filter((e) => e.target === b.id)).toHaveLength(0); // every pellet meets the shield
      death = events(ev, 'death').find((e) => e.victim === b.id);
    }
    expect(death).toMatchObject({ victim: b.id, killer: a.id, source: DamageSource.World });
    expect(a.kills).toBe(1);
    expect(b.kills).toBe(0);
  });

  it('gives no protection from explosions', () => {
    const { game, b } = duel([WIDOW.index, HAMMER.index]);
    game.events.length = 0;
    explode(game, SHIELD_X - 2, 0.3, -1, FRAG.explosion); // right in front of the shield
    expect(b.alive).toBe(true);
    expect(b.hp).toBeLessThan(T.healthMax);
    expect(b.shieldHp).toBe(RIOT_SHIELD.hp);
  });
});

describe('riot shield: slung on the back it blocks from behind (owner, 17 Oct 2026)', () => {
  /** B (x 12) faces away from A (x 5), its shield slung: its back, and the shield on it, face A. */
  const BACK_X = 12 - RIOT_SHIELD.backOffset;

  it('blocks within ±60° of the back and not beyond', () => {
    // a player at the origin facing −x: its slung shield is RIOT_SHIELD.backOffset behind it, at +x
    const mid = shieldBottom(false) + RIOT_SHIELD.height / 2;
    const bx = RIOT_SHIELD.backOffset;
    for (const deg of [-61, -59, 0, 59, 61]) {
      const a = (deg * Math.PI) / 180;
      const dx = -Math.cos(a); // travelling toward −x, into the back
      const dy = Math.sin(a);
      const t = shieldHitT(bx - 2 * dx, mid - 2 * dy, dx, dy, 0, 0, 1, false, RIOT_SHIELD.backOffset);
      if (Math.abs(deg) <= 60) expect(t, `${deg}°`).toBeCloseTo(2, 9);
      else expect(t, `${deg}°`).toBe(Infinity);
    }
    // from the front (through the body), never
    expect(shieldHitT(-2, mid, 1, 0, 0, 0, 1, false, RIOT_SHIELD.backOffset)).toBe(Infinity);
  });

  it('a shot into the back strikes the slung shield: shield HP, not health, and it ricochets back', () => {
    const { game, a, b, plan } = backTurned();
    const ev = fireAt(game, plan, a, BACK_X, 0.6);
    const shot = events(ev, 'shot')[0]!;
    expect([shot.hit, shot.target]).toEqual([3, b.id]);
    expect(shot.ex).toBeCloseTo(BACK_X, 9);
    expect(b.hp).toBe(T.healthMax);
    expect(b.shieldHp).toBe(RIOT_SHIELD.hp - WIDOW.damage);
    const r = events(ev, 'ricochet')[0]!;
    expect(r).toMatchObject({ owner: b.id, nx: -1, ny: 0 }); // the back faces −x, toward A
    const inLen = Math.hypot(r.x - shot.ox, r.y - shot.oy);
    const outLen = Math.hypot(r.ex - r.x, r.ey - r.y);
    expect((r.ex - r.x) / outLen).toBeCloseTo(-(r.x - shot.ox) / inLen, 9);
    expect((r.ey - r.y) / outLen).toBeCloseTo((r.y - shot.oy) / inLen, 9);
    expect(a.hp).toBe(T.healthMax);
  });

  it('a ricochet off the back never hits the shooter or the owner, but can hit a third player', () => {
    const { game, a, b, c, plan } = backTurned([WIDOW.index, HAMMER.index], 2);
    const ev = fireAt(game, plan, a, BACK_X, shoulder(a).y); // level: it comes straight back through A
    const r = events(ev, 'ricochet')[0]!;
    expect(r.ex).toBeLessThan(a.x); // passed through the shooter's body…
    expect(a.hp).toBe(T.healthMax); // …without hurting it
    expect([r.hit, r.target]).toEqual([2, c!.id]);
    expect(events(ev, 'hit')).toEqual([expect.objectContaining({ attacker: a.id, target: c!.id })]);
    expect(b.hp).toBe(T.healthMax);
  });

  it('one HP pool: worn down from behind, it breaks in front', () => {
    const { game, a, b, plan } = backTurned();
    b.shieldHp = WIDOW.damage + 10;
    fireAt(game, plan, a, BACK_X, 0.8);
    expect(b.shieldHp).toBe(10);
    // up again, facing A
    plan.get(b)!.aim = Math.PI;
    plan.get(b)!.buttons = Btn.Shield;
    step(game, plan);
    plan.get(b)!.buttons = 0;
    step(game, plan, SHIELD_RAISE_TICKS);
    expect(shieldRaised(b)).toBe(true);
    const ev = fireAt(game, plan, a, SHIELD_X, 0.8);
    expect(events(ev, 'shieldBreak')).toHaveLength(1);
    expect(b.shieldHp).toBe(0);
    expect(b.hp).toBe(T.healthMax);
  });

  it('it breaks from behind the same way', () => {
    const { game, a, b, plan } = backTurned();
    b.shieldHp = 30;
    const ev = fireAt(game, plan, a, BACK_X, 0.8);
    expect(events(ev, 'shieldBreak')).toEqual([expect.objectContaining({ owner: b.id, attacker: a.id })]);
    expect(events(ev, 'ricochet')).toHaveLength(0); // the bullet that breaks it is spent
    expect([b.shieldHp, b.shieldTicks]).toEqual([0, 0]);
    expect(b.hp).toBe(T.healthMax);
  });

  it('on its way up it blocks neither way', () => {
    const { game, a, b, plan } = backTurned();
    plan.get(b)!.buttons = Btn.Shield; // starts coming up this tick…
    const s = shoulder(a);
    plan.get(a)!.aim = Math.atan2(0.8 - s.y, BACK_X - s.x);
    plan.get(a)!.buttons = Btn.Fire; // …as A fires into its back
    const ev = step(game, plan);
    expect(b.shieldTicks).toBe(1);
    expect(events(ev, 'shot')[0]!.hit).toBe(2);
    expect(b.shieldHp).toBe(RIOT_SHIELD.hp);
    expect(b.hp).toBeLessThan(T.healthMax);
  });

  it('a two-handed weapon slings it, so it guards the back', () => {
    const { game, a, b, plan } = duel([WIDOW.index, HAMMER.index]);
    game.setLoadout(b, [K47.index, HAMMER.index]);
    plan.get(b)!.aim = 0; // facing away from A
    step(game, plan, 3);
    expect(shieldSlung(b)).toBe(true);
    const ev = fireAt(game, plan, a, BACK_X, 0.8);
    expect(events(ev, 'shot')[0]!.hit).toBe(3);
    expect(b.hp).toBe(T.healthMax);
  });
});

describe('riot shield: lag compensation', () => {
  /** A TargetRewind that shows B to A in a fixed pose. */
  const rewindTo = (b: PlayerState, pose: Partial<HitPose>) => ({
    pose(target: PlayerState, _shooter: PlayerState, out: HitPose): boolean {
      if (target !== b) return false;
      Object.assign(out, { x: b.x, y: b.y, crouched: false, alive: true, facing: 1, shield: false, shieldBack: false }, pose);
      return true;
    },
  });

  it('a slung shield is rewound too: it guards the back the shooter saw, whatever it does now', () => {
    const { game, a, b, plan } = duel([WIDOW.index, HAMMER.index]);
    plan.get(b)!.aim = 0; // now: facing away, shield raised (its back is bare)
    step(game, plan, 2);
    expect(shieldRaised(b)).toBe(true);
    const backX = 12 - RIOT_SHIELD.backOffset;
    // without a rewind the shot hits B's bare back
    let ev = fireAt(game, plan, a, backX, 0.8);
    expect(events(ev, 'shot')[0]!.hit).toBe(2);
    b.hp = T.healthMax;
    // A saw it with the shield slung: blocked by the back strip
    game.rewind = rewindTo(b, { facing: 1, shield: false, shieldBack: true });
    ev = fireAt(game, plan, a, backX, 0.8);
    expect(events(ev, 'shot')[0]!.hit).toBe(3);
    expect(events(ev, 'ricochet')[0]).toMatchObject({ nx: -1 });
    expect(b.hp).toBe(T.healthMax);
    expect(b.shieldHp).toBe(RIOT_SHIELD.hp - WIDOW.damage);
  });

  it('the shield is rewound with its owner: blocked where the shooter saw it, whatever it does now', () => {
    const { game, a, b, plan } = duel([WIDOW.index, HAMMER.index]);
    plan.get(b)!.aim = 0; // B has turned away since A saw it
    step(game, plan, 2);
    expect(b.facing).toBe(1);
    game.rewind = rewindTo(b, { facing: -1, shield: true });
    const ev = fireAt(game, plan, a, SHIELD_X, 0.8);
    expect(events(ev, 'shot')[0]!.hit).toBe(3);
    expect(b.shieldHp).toBe(RIOT_SHIELD.hp - WIDOW.damage);
    expect(b.hp).toBe(T.healthMax);
  });

  it('a shield the shooter did not see up does not block; nor does one that broke since', () => {
    const { game, a, b, plan } = duel([WIDOW.index, HAMMER.index]);
    game.rewind = rewindTo(b, { facing: -1, shield: false });
    let ev = fireAt(game, plan, a, 12, 0.8);
    expect(events(ev, 'shot')[0]!.hit).toBe(2);
    expect(b.shieldHp).toBe(RIOT_SHIELD.hp);

    b.hp = T.healthMax;
    game.rewind = rewindTo(b, { facing: -1, shield: true });
    b.shieldHp = 0; // broke a moment ago (as if by someone else)
    b.shieldTicks = 0;
    ev = fireAt(game, plan, a, 12, 0.8);
    expect(events(ev, 'shot')[0]!.hit).toBe(2);
    expect(b.hp).toBeLessThan(T.healthMax);
  });
});

describe('riot shield in the map\'s air, and with the dash (rebased onto map mechanics + dash)', () => {
  /** 4 m of thick fog behind A (20 m of range per metre): only a ricochet coming back crosses it */
  const fogBehindA: MapZone = { id: 'fog', kind: 'damping', rect: [0, -5, 4, 28], bulletRangeMul: 0.05 };

  it('a ricochet flies on with what the map leaves of its range: fog stops it short', () => {
    // clear air: level, straight back past A and into the wall at x = 0
    const clear = duel([WIDOW.index, HAMMER.index]);
    const r0 = events(fireAt(clear.game, clear.plan, clear.a, SHIELD_X, shoulder(clear.a).y), 'ricochet')[0]!;
    expect(r0.hit).toBe(1);
    expect(r0.ex).toBeCloseTo(0, 6);
    // fog: the range left after the way in and the clear stretch back to x = 4 runs out inside it
    const fogged = duel([WIDOW.index, HAMMER.index], { zones: [fogBehindA] });
    const r = events(fireAt(fogged.game, fogged.plan, fogged.a, SHIELD_X, shoulder(fogged.a).y), 'ricochet')[0]!;
    expect(r.hit).toBe(0);
    const used = r.x - shoulder(fogged.a).x + (r.x - 4); // level: in, then out to the fog's edge
    expect(r.ex).toBeCloseTo(4 - (WIDOW.range - used) * 0.05, 2);
  });

  it('…and its damage falls off with the range the fog used up', () => {
    const hitOnC = (zones?: MapZone[]) => {
      const d = duel([WIDOW.index, HAMMER.index], { c: 2.5, ...(zones ? { zones } : {}) });
      const ev = fireAt(d.game, d.plan, d.a, SHIELD_X, shoulder(d.a).y);
      expect(events(ev, 'ricochet')[0]!.target).toBe(d.c!.id);
      return events(ev, 'hit').find((h) => h.target === d.c!.id)!;
    };
    const clear = hitOnC();
    const fogged = hitOnC([fogBehindA]);
    expect(fogged.zone).toBe(clear.zone);
    const zoneMul = clear.zone === HitZone.Head ? WIDOW.headMul : 1;
    expect(clear.damage).toBeCloseTo(WIDOW.damage * RIOT_SHIELD.ricochetDamageMul * zoneMul, 6); // inside falloffStart
    expect(fogged.damage).toBeLessThan(clear.damage); // past falloffStart once the fog is counted
  });

  it('pellets on a slung shield end its carrier\'s dash, like any push (no i-frames)', () => {
    const run = (fire: boolean) => {
      const { game, a, b, plan } = backTurned([BREACHER.index, HAMMER.index]);
      plan.get(b)!.buttons = Btn.Dash | Btn.Right; // away from A, the slung shield toward it
      step(game, plan);
      plan.get(b)!.buttons = 0;
      expect(b.dashTicks).toBeGreaterThan(1);
      const s = shoulder(a);
      plan.get(a)!.aim = Math.atan2(0.8 - s.y, b.x - RIOT_SHIELD.backOffset - s.x);
      plan.get(a)!.buttons = fire ? Btn.Fire : 0;
      const ev = step(game, plan);
      return { b, ev };
    };
    expect(run(false).b.dashTicks).toBeGreaterThan(0);
    const { b, ev } = run(true);
    expect(events(ev, 'ricochet').length).toBeGreaterThan(0);
    expect(b.dashTicks).toBe(0);
  });
});
