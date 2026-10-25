import { HAMMER, WIDOW, movementTestMap } from '@military-forge/content';
import { angleToU16 } from '@military-forge/shared';
import { Game, createInput } from '@military-forge/sim';
import { Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { AimLinePreview, showsAimLine } from '../../aimLine';
import type { Frame } from '../../view';
import { Cell } from '../vfx/atlas';
import { AIM_SEGMENTS, AimLine, CONVERGE_M } from '../vfx/aimLine';
import type { MuzzleLookup } from '../vfx/gunfire';

/** A player on the movement test map's open floor with `weapon` in slot 0, aiming `deg` (down: negative). */
function setup(weapon: number, deg: number) {
  const game = new Game({ map: movementTestMap });
  const me = game.addPlayer('P');
  game.setLoadout(me, [weapon, HAMMER.index]);
  me.x = 118;
  me.y = 0;
  const input = { ...createInput(), aim: angleToU16((deg * Math.PI) / 180) };
  for (let i = 0; i < 40; i++) game.step([input]);
  return { game, me };
}

const frame = (aimLine: Frame['aimLine'], throwArc: Frame['throwArc'] = null) => ({ aimLine, throwArc }) as unknown as Frame;
const camera = { camera: { ppm: 40 } } as never;
const attr = (a: AimLine, name: string) => a.layer.mesh.geometry.getAttribute(name).array as Float32Array;
const cells = (a: AimLine) => Array.from(attr(a, 'iCell').subarray(0, a.layer.count));

describe('the sniper aim line', () => {
  it('only the scoped guns show it, and only while one is in hand', () => {
    expect(showsAimLine(WIDOW)).toBe(true);
    expect(showsAimLine(HAMMER)).toBe(false);
    const preview = new AimLinePreview();
    const widow = setup(WIDOW.index, -20);
    expect(preview.update(widow.game, widow.me)).not.toBeNull();
    widow.me.alive = false;
    expect(preview.update(widow.game, widow.me)).toBeNull();
    const hammer = setup(HAMMER.index, -20);
    expect(preview.update(hammer.game, hammer.me)).toBeNull();
  });

  it('runs along the sim ray to the floor it meets, with a dot there; nothing without a line or while a throw is aimed', () => {
    const { game, me } = setup(WIDOW.index, -20);
    const view = new AimLinePreview().update(game, me)!;
    expect(view.hit).toBe(true);
    expect(view.ey).toBeCloseTo(0, 2); // the floor
    expect(view.ready).toBe(true);
    const a = new AimLine();
    a.update(frame(view), 1 / 60, camera);
    // a rim pass and a core pass: the segments and the dot each (no drawn gun: no bend)
    expect(a.layer.count).toBe(2 * (AIM_SEGMENTS + 1));
    expect(cells(a).filter((c) => c === Cell.Dot)).toHaveLength(2);
    // every segment's centre lies on the sim's ray
    const pos = attr(a, 'iPos');
    const ux = view.ex - view.ox;
    const uy = view.ey - view.oy;
    for (let i = 0; i < AIM_SEGMENTS; i++) {
      const x = pos[i * 3]! - view.ox;
      const y = pos[i * 3 + 1]! - view.oy;
      expect(Math.abs(x * uy - y * ux) / Math.hypot(ux, uy)).toBeLessThan(1e-4);
    }
    a.update(frame(null), 1 / 60, camera);
    expect(a.layer.count).toBe(0);
    expect(a.layer.mesh.visible).toBe(false);
    a.update(frame(view, { count: 2 } as Frame['throwArc']), 1 / 60, camera);
    expect(a.layer.count).toBe(0);
  });

  it('leaves the drawn muzzle and meets the ray CONVERGE_M along it', () => {
    const { game, me } = setup(WIDOW.index, 0);
    const view = new AimLinePreview().update(game, me)!;
    // the drawn gun 0.3 m under the sim's line
    const muzzle: MuzzleLookup = (_id, _w, out, dir) => {
      out.set(view.ox - 0.1, view.oy - 0.3, 0.2);
      dir.set(1, 0, 0);
      return true;
    };
    const a = new AimLine(muzzle);
    a.update(frame(view), 1 / 60, camera);
    const core = AIM_SEGMENTS + 1 + (view.hit ? 1 : 0); // the rim pass first
    const pos = attr(a, 'iPos');
    const axis = attr(a, 'iAxisA');
    const i = core * 3;
    const start = new Vector3(pos[i]! - axis[i]! / 1.03, pos[i + 1]! - axis[i + 1]! / 1.03, 0);
    const end = new Vector3(pos[i]! + axis[i]! / 1.03, pos[i + 1]! + axis[i + 1]! / 1.03, 0);
    expect(start.x).toBeCloseTo(view.ox - 0.1, 3);
    expect(start.y).toBeCloseTo(view.oy - 0.3, 3);
    const len = Math.hypot(view.ex - view.ox, view.ey - view.oy);
    expect(end.x).toBeCloseTo(view.ox + ((view.ex - view.ox) / len) * CONVERGE_M, 3);
    expect(end.y).toBeCloseTo(view.oy + ((view.ey - view.oy) / len) * CONVERGE_M, 3);
    expect(pos[i + 2]).toBeCloseTo(0.2, 5); // at the drawn gun's depth
  });
});
