import { BLADE, PROJECTILE_TYPE_BASE, RIOT_SHIELD, ROCKET, SHELL } from '@military-forge/content';
import { shieldBottom } from '@military-forge/sim';
import { describe, expect, it } from 'vitest';
import { F, ParticlePool, STRIDE } from '../vfx/pool';
import { Ramp } from '../vfx/ramps';
import { ShieldBlasts } from '../vfx/shieldBlast';
import { playerView } from './helpers';

const T_ROCKET = PROJECTILE_TYPE_BASE + ROCKET.index;
const T_SHELL = PROJECTILE_TYPE_BASE + SHELL.index;
/** a carrier at x 10 facing right (aim 0): a raised shield's face at 10.42, a slung one's at 9.6 */
const FRONT = 10 + RIOT_SHIELD.forward;
const BACK = 10 - RIOT_SHIELD.backOffset;
const MID = shieldBottom(false) + RIOT_SHIELD.height / 2;

function setup(shield: 'front' | 'back' | 'raising' | undefined, over: Parameters<typeof playerView>[0] = {}) {
  const s = new ShieldBlasts();
  s.players = [playerView({ x: 10, y: 0, aim: 0, shield, ...over })];
  return { s, pool: new ParticlePool(256) };
}

/** the sparks (streaks), the flare (the Flash one) and the hot spot (the rest) in `pool` */
function read(pool: ParticlePool) {
  const sparks: { vx: number; x: number }[] = [];
  let flare: { x: number; alpha: number } | null = null;
  let hot = 0;
  for (let i = 0; i < pool.count; i++) {
    const o = i * STRIDE;
    if (pool.data[o + F.ramp] === Ramp.Flash) flare = { x: pool.data[o + F.x]!, alpha: pool.data[o + F.alpha]! };
    else if (pool.data[o + F.stretch]! > 0) sparks.push({ vx: pool.data[o + F.vx]!, x: pool.data[o + F.x]! });
    else hot++;
  }
  return { sparks, flare, hot };
}

describe('a launcher blast at a riot shield: the plate flares and throws sparks', () => {
  it('a rocket at a raised shield: a flare on its face and sparks thrown back the way it came', () => {
    const { s, pool } = setup('front');
    const hit = s.blast(FRONT + ROCKET.radius, MID, T_ROCKET, pool, 1, false, false);
    expect(hit).toMatchObject({ x: FRONT, side: 1 });
    const { sparks, flare, hot } = read(pool);
    expect(flare).not.toBeNull();
    expect(hot).toBe(1);
    expect(flare!.x).toBeGreaterThan(FRONT); // in front of the plate
    expect(sparks.length).toBe(18);
    expect(sparks.every((p) => p.x > FRONT)).toBe(true);
    expect(sparks.reduce((sum, p) => sum + p.vx, 0)).toBeGreaterThan(0); // back toward the shooter
  });

  it('a Ripper blade goes off at the face too (its blast at the end of its life)', () => {
    const { s, pool } = setup('front');
    expect(s.blast(FRONT + BLADE.radius, MID, PROJECTILE_TYPE_BASE + BLADE.index, pool, 1, false, false)).not.toBeNull();
  });

  it('a shell from behind at a slung shield: the face on the back, sparks thrown behind', () => {
    const { s, pool } = setup('back');
    expect(s.blast(BACK - SHELL.radius, MID, T_SHELL, pool, 1, false, false)).toMatchObject({ x: BACK, side: -1 });
    const { sparks } = read(pool);
    expect(sparks.reduce((sum, p) => sum + p.vx, 0)).toBeLessThan(0);
  });

  it('nothing for a blast away from a face, behind it, above it, at a shield on its way up, or for a frag', () => {
    const cases: [ReturnType<typeof setup>, number, number, number][] = [
      [setup('front'), FRONT + 1.2, MID, T_ROCKET], // a metre off the face
      [setup('front'), FRONT - 0.3, MID, T_ROCKET], // behind the face (the carrier's own side)
      [setup('front'), FRONT + ROCKET.radius, 2.2, T_ROCKET], // over the shield's top
      [setup('raising'), FRONT + ROCKET.radius, MID, T_ROCKET], // on its way up it guards neither side
      [setup(undefined), FRONT + ROCKET.radius, MID, T_ROCKET], // no shield
      [setup('front', { alive: false }), FRONT + ROCKET.radius, MID, T_ROCKET],
      [setup('front'), FRONT + 0.1, MID, 1], // a frag isn't a launcher's
    ];
    for (const [{ s, pool }, x, y, type] of cases) {
      expect(s.blast(x, y, type, pool, 1, false, false)).toBeNull();
      expect(pool.count).toBe(0);
    }
  });

  it('a crouched carrier: the face lower down', () => {
    const { s, pool } = setup('front', { crouched: true });
    expect(s.blast(FRONT + ROCKET.radius, shieldBottom(true) + 0.05, T_ROCKET, pool, 1, false, false)).not.toBeNull();
  });

  it('Low and Reduce motion throw fewer sparks; Reduce flashes dims the flare', () => {
    const count = (detail: number, reduced: boolean) => {
      const { s, pool } = setup('front');
      s.blast(FRONT + ROCKET.radius, MID, T_ROCKET, pool, detail, reduced, false);
      return read(pool).sparks.length;
    };
    expect(count(0.6, false)).toBe(11);
    expect(count(1, true)).toBe(9);
    const { s, pool } = setup('front');
    s.blast(FRONT + ROCKET.radius, MID, T_ROCKET, pool, 1, false, true);
    expect(read(pool).flare!.alpha).toBeLessThan(0.5);
  });
});
