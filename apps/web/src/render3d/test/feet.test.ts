/**
 * Planted feet on W8's real skeleton and clips (locomotion.ts FootPlanter; review M3, L3, L4). Every case drives a
 * planted avatar and a clip-only twin with the same views and compares them frame by frame:
 * - no snaps: holds fade in and out over at least 4 frames, so planting adds little to how far a foot moves in a
 *   frame and nothing to how sharply a knee turns; a planted knee never straightens past the clip's bend;
 * - feet on the floor: a held foot keeps the clip's height over the floor under it (steps, slopes), a swinging
 *   foot never goes into the ground;
 * - fresh plants after a teleport, nothing held through a dash, nothing held crouched.
 */
import { defaultTuning, movementTestMap } from '@military-forge/content';
import { Btn, CollisionWorld, Game, createInput, createRayHit } from '@military-forge/sim';
import { angleToU16 } from '@military-forge/shared';
import { Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import type { PlayerView } from '../../view';
import { Avatar, AvatarKit } from '../avatar';
import { FEET } from '../locomotion';
import { toonRamp } from '../character';
import { playerView } from './helpers';
import { rookieRig } from './rookieRig';

const world = new CollisionWorld(movementTestMap);
const kit = new AvatarKit(toonRamp());
const DT = 1 / 60;
/** whole-skeleton runs: generous under a loaded CI machine */
const SLOW = 60_000;
const hit = createRayHit();
const groundAt = (x: number, fromY: number) => (world.raycast(x, fromY + 0.6, 0, -1, 1.6, 0, hit) ? hit.y : NaN);
/** the rest pose's ankle height above the soles (m) */
const REST = 0.12;
/** the knee bend (°) of a two-bone leg of equal parts reaching FEET.unbend of its length */
const UNBENT = (2 * Math.acos(FEET.unbend) * 180) / Math.PI;
const _a = new Vector3();
const _b = new Vector3();
const _c = new Vector3();
const _p = new Vector3();

interface Leg {
  x: number;
  y: number;
  /** foot relative to the pelvis */
  rx: number;
  ry: number;
  /** knee bend (°, 0 = straight) */
  knee: number;
  planted: number;
}

function legs(av: Avatar): Leg[] {
  const pelvis = av.inst.bone('pelvis')!.getWorldPosition(_p);
  return (['L', 'R'] as const).map((s, k) => {
    const thigh = av.inst.bone(`thigh_${s}`)!.getWorldPosition(_a);
    const calf = av.inst.bone(`calf_${s}`)!.getWorldPosition(_b);
    const foot = av.inst.bone(`foot_${s}`)!.getWorldPosition(_c);
    const knee = (new Vector3().subVectors(calf, thigh).angleTo(new Vector3().subVectors(foot, calf)) * 180) / Math.PI;
    return { x: foot.x, y: foot.y, rx: foot.x - pelvis.x, ry: foot.y - pelvis.y, knee, planted: av.feet.planted[k]! };
  });
}

interface Run {
  /** per frame: planted avatar's legs, the clip-only twin's, and the view */
  a: Leg[][];
  b: Leg[][];
  views: PlayerView[];
}

/** Drives a planted avatar and a clip-only twin through `views` (frames before `skip` settle the gait unrecorded). */
async function drive(views: Iterable<PlayerView>, skip = 60): Promise<Run> {
  const A = new Avatar(await rookieRig(), 0, kit, 1);
  const B = new Avatar(await rookieRig(), 0, kit, 1);
  (B.feet as unknown as { update: () => void }).update = () => {};
  const run: Run = { a: [], b: [], views: [] };
  let i = 0;
  for (const p of views) {
    A.update(p, DT, world, false);
    B.update(p, DT, world, false);
    if (i++ < skip) continue;
    run.a.push(legs(A));
    run.b.push(legs(B));
    run.views.push(p);
  }
  return run;
}

function* steady(vx: number, frames: number, over: Partial<PlayerView> = {}, x0 = 117): Generator<PlayerView> {
  let x = x0; // flat floor (116–142)
  for (let i = 0; i < frames; i++) yield playerView({ x: (x += vx * DT), vx, aim: 0.1, ...over });
}

/** The real sim walking or running over the movement-test map's step and hills. */
function* course(x0: number, ticks: number, buttons: number): Generator<PlayerView> {
  const game = new Game({ map: movementTestMap, seed: 7, dummies: false });
  const me = game.addPlayer('P');
  me.spawn(x0, 0, game.tuning);
  const input = createInput();
  for (let i = 0; i < ticks; i++) {
    input.buttons = i < 20 ? 0 : buttons;
    input.aim = angleToU16(buttons & Btn.Left ? Math.PI - 0.1 : 0.1);
    game.step([input]);
    yield playerView({ x: me.x, y: me.y, vx: me.vx, vy: me.vy, grounded: me.grounded, crouched: me.crouched, jetting: me.jetting, aim: me.aim });
  }
}

/**
 * A walk at `vx` over the map's ground the way the sim stands the capsule on it: its rounded bottom resting on the
 * ground, so on a slope the player's y is above the ground under its middle (docs/02 §7).
 */
function* walkOver(x0: number, x1: number, vx: number): Generator<PlayerView> {
  const r = defaultTuning.capsuleRadius;
  let y = 0; // every walk starts on the map's floor
  const frames = Math.round((x1 - x0) / (vx * DT));
  for (let i = 0; i < frames; i++) {
    const x = x0 + vx * DT * i;
    let top = -Infinity;
    for (let j = 0; j <= 32; j++) {
      const u = -r + (2 * r * j) / 32;
      const g = groundAt(x + u, y + 0.5);
      if (!Number.isNaN(g)) top = Math.max(top, g + Math.sqrt(r * r - u * u));
    }
    if (top > -Infinity) y = top - r;
    yield playerView({ x, y, vx, aim: 0.1 });
  }
}

/**
 * What planting adds: foot motion relative to the pelvis beyond the twin's (cm/frame), and how sharply the knee
 * turns, planted and clip-only (°/frame², second difference: a snap is a spike).
 */
function pops(run: Run) {
  let foot = 0;
  let jerkA = 0;
  let jerkB = 0;
  let straighter = 0;
  for (let i = 2; i < run.a.length; i++) {
    for (let k = 0; k < 2; k++) {
      const [a0, a1, a2] = [run.a[i - 2]![k]!, run.a[i - 1]![k]!, run.a[i]![k]!];
      const [b0, b1, b2] = [run.b[i - 2]![k]!, run.b[i - 1]![k]!, run.b[i]![k]!];
      foot = Math.max(foot, Math.hypot(a2.rx - a1.rx - (b2.rx - b1.rx), a2.ry - a1.ry - (b2.ry - b1.ry)) * 100);
      jerkA = Math.max(jerkA, Math.abs(a2.knee - 2 * a1.knee + a0.knee));
      jerkB = Math.max(jerkB, Math.abs(b2.knee - 2 * b1.knee + b0.knee));
      // a held leg may unbend to FEET.unbend of its length (a bent walk reaching a step down), never further
      if (a2.planted > 0) straighter = Math.max(straighter, Math.min(b2.knee, UNBENT) - a2.knee);
    }
  }
  return { foot, jerkA, jerkB, straighter };
}

/** Mean speed (m/s) a held foot moves along the ground, weighted by how firmly it is held (frames held > ½). */
function slide(run: Run): number {
  let sum = 0;
  let w = 0;
  for (let i = 1; i < run.a.length; i++)
    for (let k = 0; k < 2; k++) {
      const f = run.a[i]![k]!;
      if (f.planted <= 0.5) continue;
      sum += (Math.abs(f.x - run.a[i - 1]![k]!.x) / DT) * f.planted;
      w += f.planted;
    }
  return w ? sum / w : 0;
}

const share = (run: Run, k: number) => run.a.filter((f) => f[k]!.planted > 0.5).length / run.a.length;

describe('planted feet on W8 clips: no snaps', () => {
  for (const speed of [0.4, 1.2, 2.5, 3.5, 5]) {
    it(`at ${speed} m/s: held where they land, eased in and out, never straightened past the clip`, async () => {
      const run = await drive(steady(speed, 300));
      const p = pops(run);
      // the reviewer's one-frame snaps were 3–7.5 cm of foot and 60° of knee at a run
      expect(p.foot, 'extra foot motion (cm/frame)').toBeLessThan(1 + 0.9 * speed);
      expect(p.jerkA, 'knee jerk (°/frame²)').toBeLessThan(1.5 * p.jerkB + 4);
      expect(p.straighter, 'knee straighter than the clip (°)').toBeLessThan(1);
      // and the feet do plant, and stay put while they do (a W8 cycle alone slides them 40–70 %)
      if (speed <= 3.5) expect(slide(run), 'held foot slide (m/s)').toBeLessThan(0.2 * speed);
      // (the Forge's walk_slow is down 65 % of its cycle, its run 17 %)
      for (const k of [0, 1]) expect(share(run, k), `foot ${k} held share`).toBeGreaterThan(speed <= 1.2 ? 0.25 : 0.03);
      // on flat ground a held foot keeps the clip's own height (a heel-strike walk, a forefoot run), or stands on the
      // ground where the clip (and the run's lean) would put it into it
      for (let i = 0; i < run.a.length; i++)
        for (const k of [0, 1]) if (run.a[i]![k]!.planted > 0.5) expect(Math.abs(run.a[i]![k]!.y - Math.max(run.b[i]![k]!.y, REST - FEET.soft / 2))).toBeLessThan(0.01);
    }, SLOW);
  }

  it('backpedalling plants as smoothly as running forward', async () => {
    const p = pops(await drive(steady(2.5, 300, { aim: Math.PI - 0.1 })));
    expect(p.foot).toBeLessThan(1 + 0.9 * 2.5);
    expect(p.jerkA).toBeLessThan(1.5 * p.jerkB + 4);
    expect(p.straighter).toBeLessThan(1);
  }, SLOW);

  it('stopping, starting, turning round and dashing let go over a few frames', async () => {
    const cases: [string, (i: number) => Partial<PlayerView>][] = [
      ['stop', (i) => ({ vx: i < 100 ? 3 : 0 })],
      ['start', (i) => ({ vx: i < 70 ? 0 : 3 })],
      ['reverse', (i) => ({ vx: i < 100 ? 2 : -2, aim: i < 100 ? 0.1 : Math.PI - 0.1 })],
      ['turn to backpedal', (i) => ({ vx: 2, aim: i < 100 ? 0.1 : Math.PI - 0.1 })],
      ['dash', (i) => ({ vx: i >= 100 && i < 108 ? 14 : 3, dashing: i >= 100 && i < 108 })],
    ];
    for (const [name, at] of cases) {
      let x = 117;
      const views = Array.from({ length: 200 }, (_, i) => {
        const o = at(i);
        return playerView({ aim: 0.1, ...o, x: (x += (o.vx ?? 0) * DT) });
      });
      const run = await drive(views, 40);
      expect(pops(run).foot, name).toBeLessThan(4);
      if (name === 'dash')
        run.views.forEach((v, i) => {
          if (v.dashing) expect(Math.max(...run.a[i]!.map((f) => f.planted)), 'held through a dash').toBe(0);
        });
    }
  }, SLOW);

  it('a crouch walk (the Forge’s crouch_walk) holds its feet at the crouch pose’s own height, without snaps', async () => {
    const run = await drive(steady(2.2, 200, { crouched: true }));
    // (crouch_walk is down half its cycle; at 2.9 cycles/s the 70 ms fades leave a fifth of it held past ½)
    for (const k of [0, 1]) expect(share(run, k), `foot ${k} held share`).toBeGreaterThan(0.15);
    for (let i = 0; i < run.a.length; i++)
      for (const k of [0, 1]) if (run.a[i]![k]!.planted > 0.5) expect(Math.abs(run.a[i]![k]!.y - Math.max(run.b[i]![k]!.y, REST - FEET.soft / 2))).toBeLessThan(0.01);
    const p = pops(run);
    expect(p.foot, 'extra foot motion (cm/frame)').toBeLessThan(1 + 0.9 * 2.2);
    expect(p.jerkA, 'knee jerk (°/frame²)').toBeLessThan(1.5 * p.jerkB + 4);
    expect(p.straighter, 'knee straightened past the clip (°)').toBeLessThan(1);
  }, SLOW);

  it('a fall from 4 m under platforms lands with the feet on the floor (the floor is read on the ground only)', async () => {
    // x 124 is under the movement-test map's one-way platforms (2.5, 5 and 7.5 m up)
    const views = Array.from({ length: 100 }, (_, i) => {
      const t = i / 60;
      const h = 4 - 10 * t * t;
      return h > 0 ? playerView({ x: 124, y: h, vy: -20 * t, grounded: false, aim: 0.1 }) : playerView({ x: 124, aim: 0.1 });
    });
    const run = await drive(views, 0);
    const last = run.a[run.a.length - 1]!;
    for (const [k, f] of last.entries()) {
      expect(Math.abs(f.y - run.b[run.b.length - 1]![k]!.y), `foot ${k} on the clip's floor`).toBeLessThan(0.01);
      expect(f.knee, `knee ${k}`).toBeLessThan(40);
    }
  }, SLOW);

  it('plants afresh after a teleport (a respawn) instead of reaching back to the old spot', async () => {
    let x = 117;
    const views = Array.from({ length: 160 }, (_, i) => playerView({ x: (x += 1.5 * DT + (i === 120 ? 2 : 0)), vx: 1.5, aim: 0.1 }));
    const run = await drive(views);
    const after = run.a[120 - 60]!;
    after.forEach((f, k) => expect(Math.hypot(f.rx - run.b[120 - 60]![k]!.rx, f.ry - run.b[120 - 60]![k]!.ry), `foot ${k}`).toBeLessThan(0.03));
  }, SLOW);
});

describe('planted feet on the floor under them (steps and hills)', () => {
  const ankle = (async () => {
    const rest = await rookieRig();
    rest.root.updateMatrixWorld(true);
    return rest.bone('foot_L')!.getWorldPosition(new Vector3()).y - rest.root.getWorldPosition(new Vector3()).y;
  })();

  /** how far feet go into the ground (m), and how far held ones stand off the clip's height over the ground under them */
  function onGround(run: Run, rest: number) {
    let inGround = 0;
    const off: number[] = [];
    run.a.forEach((f, i) =>
      f.forEach((leg, k) => {
        const v = run.views[i]!;
        if (!v.grounded) return;
        const ground = groundAt(leg.x, leg.y - rest);
        if (Number.isNaN(ground)) return;
        // no foot goes into the ground, held or swinging (its sole: the rest pose's ankle height below the ankle)
        inGround = Math.max(inGround, ground + rest - leg.y);
        // the twin stands its feet on the player's y; a held foot stands on the ground under it at the same height
        if (leg.planted > 0.95) off.push(leg.y - ground - (run.b[i]![k]!.y - v.y));
      }),
    );
    return { inGround, off: off.sort((p, q) => p - q) };
  }

  // a foot has to leave the clip to follow the ground (up and down with it, held while the body climbs past): the
  // steeper, the more; the knee turns about as sharply as a flat run's (33 °/frame²) on the steepest walkable hill
  for (const [name, x0, x1, foot, jerk] of [
    ['a 0.2 m step, up', 3, 8, 3, 20],
    ['a 30° hill, up and over', 33, 46, 4.5, 20],
    ['a 45° hill, up and over', 48, 57, 6, 30],
  ] as const) {
    it(`walking ${name}: a held foot stands on the ground under it, no foot goes into it`, async () => {
      const rest = await ankle;
      const run = await drive(walkOver(x0, x1, 1.2));
      const { inGround, off } = onGround(run, rest);
      expect(off.length, 'held frames').toBeGreaterThan(30);
      expect(-off[0]!, 'held foot below the clip height over the ground (m)').toBeLessThan(0.01);
      // above it only where the dip runs out of reach (the steeper side of a hill): the leg keeps the clip's bend
      expect(off[Math.floor(off.length * 0.9)]!, 'held foot above it (m, 90th percentile)').toBeLessThan(0.04);
      expect(inGround, 'a foot in the ground (m)').toBeLessThan(0.02);
      const p = pops(run);
      expect(p.foot, 'extra foot motion (cm/frame)').toBeLessThan(foot);
      expect(p.jerkA, 'knee jerk (°/frame²)').toBeLessThan(Math.max(jerk, 1.5 * p.jerkB + 4));
      expect(p.straighter, 'knee straighter than the clip (°)').toBeLessThan(1);
    }, SLOW);
  }

  for (const [name, x0, ticks, buttons] of [
    ['a 0.2 m step up and down', 1.5, 150, Btn.Right],
    ['a 30° hill, up and down', 32, 260, Btn.Right],
    ['a 30° hill going left', 49, 260, Btn.Left],
  ] as const) {
    it(`the sim running ${name}: no foot in the ground, no snaps`, async () => {
      const rest = await ankle;
      const run = await drive(course(x0, ticks, buttons), 40);
      // at a 5 m/s run a swinging foot meets a rising slope ~10 cm deep in a frame: it is lifted out over two
      // (FEET.liftRate) rather than popped up in one, touching into the slope meanwhile
      expect(onGround(run, rest).inGround, 'a foot in the ground (m)').toBeLessThan(0.05);
      const p = pops(run);
      // (a 5 m/s run's own feet move ~12 cm a frame)
      expect(p.foot, 'extra foot motion (cm/frame)').toBeLessThan(8);
      expect(p.jerkA, 'knee jerk (°/frame²)').toBeLessThan(1.5 * p.jerkB + 4);
      expect(p.straighter, 'knee straighter than the clip (°)').toBeLessThan(1);
    }, SLOW);
  }
});
