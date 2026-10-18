import { BREACHER, BUZZ, HAMMER, K47, MACHETE, NO_WEAPON, WIDOW, movementTestMap } from '@military-forge/content';
import { CollisionWorld, type SimEvent } from '@military-forge/sim';
import { Quaternion, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { Avatar, AvatarKit } from '../avatar';
import { toonRamp } from '../character';
import { KICK_MAX, eachKick, recoilOf, recoilProfile } from '../recoil';
import { CameraShake, KICK_LIMIT } from '../vfx/shake';
import { aimRig, playerView } from './helpers';

describe('recoil profiles', () => {
  it('the Breacher and the Widow kick hardest, then the Hammer, the K-47 and the Buzz', () => {
    const [hammer, buzz, k47, breacher, widow] = [HAMMER, BUZZ, K47, BREACHER, WIDOW].map(recoilProfile);
    for (const key of ['kick', 'torso', 'camera'] as const) {
      expect(breacher![key]).toBeGreaterThan(hammer![key]);
      expect(widow![key]).toBeGreaterThan(hammer![key]);
      expect(hammer![key]).toBeGreaterThan(k47![key]);
      expect(k47![key]).toBeGreaterThan(buzz![key]);
    }
  });

  it('rapid guns settle between shots; slow ones ride the kick longer', () => {
    for (const def of [BUZZ, K47]) expect(Math.exp(-recoilProfile(def).recover * def.interval)).toBeLessThan(0.1);
    expect(recoilProfile(WIDOW).recover).toBeLessThan(recoilProfile(BUZZ).recover / 2);
  });

  it('a one-handed gun flips up at the wrist more than a shouldered one', () => {
    expect(recoilProfile({ ...K47, hands: 1 }).rise).toBeGreaterThan(2 * recoilProfile(K47).rise);
  });

  it('a machete and unknown weapons have none', () => {
    expect(recoilProfile(MACHETE).kick).toBe(0);
    expect(recoilOf(NO_WEAPON).kick).toBe(0);
    expect(recoilOf(BUZZ.index)).toEqual(recoilProfile(BUZZ));
  });
});

const shot = (shooter: number, weapon: number, dx = 1, dy = 0): SimEvent => ({
  type: 'shot',
  shooter,
  weapon,
  ox: 0,
  oy: 1,
  ex: dx * 10,
  ey: 1 + dy * 10,
  hit: 0,
  target: -1,
  zone: 0,
});

describe('eachKick', () => {
  it('one kick per shooter and weapon in a batch: a shotgun’s pellets are one', () => {
    const kicks: number[][] = [];
    const batch: SimEvent[] = [shot(0, BREACHER.index, 3, 4), shot(0, BREACHER.index), shot(0, BREACHER.index), { type: 'spawn', player: 2 }, shot(1, BUZZ.index), shot(1, HAMMER.index)];
    eachKick(batch, (s, w, x, y) => kicks.push([s, w, x, y]));
    expect(kicks).toEqual([
      [0, BREACHER.index, 0.6, 0.8],
      [1, BUZZ.index, 1, 0],
      [1, HAMMER.index, 1, 0],
    ]);
    eachKick([shot(0, BREACHER.index)], (s) => kicks.push([s])); // the next batch kicks again
    expect(kicks).toHaveLength(4);
  });
});

describe('camera kick', () => {
  it('pushes the 3D camera in full on the frame it lands, then settles in a few frames', () => {
    const shake = new CameraShake();
    shake.kick(-0.1, 0.02);
    const o = shake.update(1 / 60);
    expect(o.x).toBeCloseTo(-0.1, 6);
    expect(o.y).toBeCloseTo(0.02, 6);
    for (let i = 0; i < 15; i++) shake.update(1 / 60);
    expect(Math.abs(shake.update(1 / 60).x)).toBeLessThan(0.01);
  });

  it('a burst is capped, and reduced motion has none', () => {
    const shake = new CameraShake();
    for (let i = 0; i < 20; i++) shake.kick(0.05, 0);
    expect(shake.update(0).x).toBeCloseTo(KICK_LIMIT, 6);
    shake.enabled = false;
    shake.kick(0.1, 0);
    expect(shake.update(1 / 60).x).toBe(0);
  });
});

const world = new CollisionWorld(movementTestMap);
const AIM = 0.2;
const aimDir = new Vector3(Math.cos(AIM), Math.sin(AIM), 0);

/** An avatar aiming right and a little up with `def` in hand (and `second` in the other slot). */
function shooter(def: number, opts: { dual?: boolean; second?: number; scale?: number } = {}) {
  const kit = new AvatarKit(toonRamp());
  kit.recoilScale = opts.scale ?? 1;
  const inst = aimRig();
  const a = new Avatar(inst, 0, kit, 1);
  const view = playerView({
    x: 20,
    aim: AIM,
    dual: opts.dual ?? false,
    weapons: [
      { def, mag: 10, reserve: 10, reloadTicks: 0 },
      { def: opts.second ?? HAMMER.index, mag: 6, reserve: 30, reloadTicks: 0 },
    ],
  });
  const step = (n = 1) => {
    for (let i = 0; i < n; i++) a.update(view, 1 / 60, world, true);
  };
  step(12);
  const at = (n: string) => inst.bone(n)!.getWorldPosition(new Vector3());
  /** the gun hand's socket out from the shoulder, along the aim */
  const reach = (side = 'R') => at(`socket_weapon_${side}`).sub(at(`upperarm_${side}`)).dot(aimDir);
  /** the barrel's angle above the aim (facing right) */
  const climb = (side = 'R') => {
    const d = new Vector3(0, 1, 0).applyQuaternion(inst.bone(`socket_weapon_${side}`)!.getWorldQuaternion(new Quaternion()));
    return Math.atan2(d.y, d.x) - AIM;
  };
  return { a, step, reach, climb, headX: () => at('head').x };
}

describe('Avatar recoil', () => {
  it('shows from the frame after the shot (the flash leaves the gun where it aimed), then settles', () => {
    const s = shooter(HAMMER.index);
    const rest = s.reach();
    const level = s.climb();
    s.a.kick(HAMMER.index);
    s.step(); // the shot's frame: drawn as aimed
    expect(s.reach()).toBeCloseTo(rest, 6);
    s.step(); // the next: kicked back and climbing
    expect(s.reach()).toBeLessThan(rest - 0.03);
    expect(s.climb()).toBeGreaterThan(level + 0.15);
    s.step(60);
    expect(s.reach()).toBeCloseTo(rest, 3);
    expect(s.climb()).toBeCloseTo(level, 2);
  });

  it('the Breacher and the Widow kick harder than the Buzz, and the Breacher jolts the torso back', () => {
    const measure = (def: number) => {
      const s = shooter(def);
      const rest = s.reach();
      const head = s.headX();
      s.a.kick(def);
      s.step(2);
      return { pull: rest - s.reach(), jolt: head - s.headX() }; // facing right: back is −x
    };
    const buzz = measure(BUZZ.index);
    const breacher = measure(BREACHER.index);
    const widow = measure(WIDOW.index);
    expect(buzz.pull).toBeGreaterThan(0.01);
    expect(breacher.pull).toBeGreaterThan(2 * buzz.pull);
    expect(widow.pull).toBeGreaterThan(2 * buzz.pull);
    expect(breacher.jolt).toBeGreaterThan(0.03);
    expect(breacher.jolt).toBeGreaterThan(4 * buzz.jolt);
  });

  it('dual guns: the hand that fired kicks', () => {
    const s = shooter(BUZZ.index, { dual: true, second: HAMMER.index }); // Buzz right, Hammer left
    const right = s.reach('R');
    const left = s.reach('L');
    s.a.kick(HAMMER.index);
    s.step(2);
    expect(s.reach('L')).toBeLessThan(left - 0.02);
    expect(s.reach('R')).toBeCloseTo(right, 4);
  });

  it('a burst piles up to a cap; a gun not in hand kicks nothing', () => {
    const s = shooter(BUZZ.index);
    const rest = s.reach();
    for (let i = 0; i < 10; i++) s.a.kick(BUZZ.index);
    s.a.kick(WIDOW.index);
    s.step(2);
    const pull = rest - s.reach();
    expect(pull).toBeGreaterThan(recoilOf(BUZZ.index).kick * 1.2);
    expect(pull).toBeLessThan(recoilOf(BUZZ.index).kick * KICK_MAX + 0.005);
  });

  it('reduced motion halves the kick', () => {
    const pull = (scale: number) => {
      const s = shooter(BREACHER.index, { scale });
      const rest = s.reach();
      s.a.kick(BREACHER.index);
      s.step(2);
      return rest - s.reach();
    };
    expect(pull(0.5) / pull(1)).toBeCloseTo(0.5, 1);
  });
});
