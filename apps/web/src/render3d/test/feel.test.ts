/**
 * The character-feel acceptance criteria (docs/design/character-feel-research.md §9) as pass/fail numbers, on the real
 * skeleton and clips (feel.ts drives the Avatar at 60 Hz).
 */
import { BREACHER, BUZZ, HAMMER, K47, MACHETE, NO_WEAPON, SHREDDER, WIDOW, movementTestMap, weapons } from '@military-forge/content';
import { Btn, Game, createInput } from '@military-forge/sim';
import { angleToU16 } from '@military-forge/shared';
import { Quaternion, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import type { PlayerView, WeaponView } from '../../view';
import { UPPER_BODY } from '../locomotion';
import { switchSeconds } from '../sling';
import { playerView } from './helpers';
import { DT, contactSkate, feelAvatar, feet, kit, peak, timeline, turns, world } from './feel';

/** whole-skeleton runs: generous under a loaded machine */
const SLOW = 120_000;
const slots = (a: number, b: number): WeaponView[] => [
  { def: a, mag: 6, reserve: 30, reloadTicks: 0 },
  { def: b, mag: 6, reserve: 30, reloadTicks: 0 },
];
const upperBody = (name: string) => UPPER_BODY.includes(name);

/**
 * A change at frame 60 of a 150-frame run: the largest turn of any bone in one frame from the change on (only the
 * upper body while running: a run's own legs turn ~29° a frame), and how long after `busy` s the body takes to come to
 * rest (every frame under 1.5°; standing only).
 */
async function change(before: Partial<PlayerView>, after: Partial<PlayerView>, vx = 0, busy = 0) {
  const av = await feelAvatar();
  const frames = turns(av, timeline(150, 60, before, after, vx), undefined, vx ? (b) => !upperBody(b.name) : undefined);
  const worst = peak(frames, 60);
  const from = 60 + Math.ceil(busy / DT);
  let rest = from;
  for (let i = frames.length - 1; i >= from; i--)
    if (frames[i]!.deg >= 1.5) {
      rest = i + 1;
      break;
    }
  return { worst, settle: (rest - from) * DT };
}

describe('§9 switches: no bone turns more than 20° in one frame, and the pose settles within 0.3 s', () => {
  const pairs = [
    [K47, HAMMER],
    [HAMMER, K47],
    [BREACHER, BUZZ],
    [WIDOW, HAMMER],
    [SHREDDER, BUZZ],
    [MACHETE, K47],
    [K47, MACHETE],
  ] as const;
  for (const [from, to] of pairs)
    it(`${from.name} → ${to.name}, standing and running, aiming level, up, down and the other way`, async () => {
      for (const aim of [0.15, 1.1, -1.0, Math.PI - 0.15])
        for (const vx of [0, 4]) {
          const r = await change({ weapons: slots(from.index, to.index), active: 0, aim }, { weapons: slots(from.index, to.index), active: 1, aim }, vx, switchSeconds(to.index));
          expect(r.worst.deg, `aim ${aim.toFixed(2)} vx ${vx}: ${r.worst.bone}`).toBeLessThan(20);
          if (!vx) expect(r.settle, `aim ${aim.toFixed(2)}: settles`).toBeLessThanOrEqual(0.3);
        }
    }, SLOW);

  const cases: [string, Partial<PlayerView>, Partial<PlayerView>][] = [
    ['the rifle dropped (unarmed)', { weapons: slots(K47.index, HAMMER.index) }, { weapons: slots(NO_WEAPON, HAMMER.index) }],
    ['the pistol dropped (unarmed)', { weapons: slots(HAMMER.index, NO_WEAPON) }, { weapons: slots(NO_WEAPON, NO_WEAPON) }],
    ['a rifle picked up', { weapons: slots(NO_WEAPON, HAMMER.index) }, { weapons: slots(K47.index, HAMMER.index) }],
    ['the shield up', { weapons: slots(HAMMER.index, BUZZ.index), shield: 'back' }, { weapons: slots(HAMMER.index, BUZZ.index), shield: 'front' }],
    ['the shield down', { weapons: slots(HAMMER.index, BUZZ.index), shield: 'front' }, { weapons: slots(HAMMER.index, BUZZ.index), shield: 'back' }],
    ['dual pistols on', { weapons: slots(HAMMER.index, HAMMER.index) }, { weapons: slots(HAMMER.index, HAMMER.index), dual: true }],
    ['dual pistols off', { weapons: slots(HAMMER.index, HAMMER.index), dual: true }, { weapons: slots(HAMMER.index, HAMMER.index) }],
  ];
  for (const [name, before, after] of cases)
    it(`${name}: eased, standing and running`, async () => {
      for (const vx of [0, 4]) {
        const r = await change({ aim: 0.15, ...before }, { aim: 0.15, ...after }, vx);
        expect(r.worst.deg, `vx ${vx}: ${r.worst.bone}`).toBeLessThan(20);
        if (!vx) expect(r.settle).toBeLessThanOrEqual(0.3);
      }
    }, SLOW);

  it('an aimed gun stays exactly on the aim once the change has eased out (within 0.5°)', async () => {
    const av = await feelAvatar();
    const views = [...timeline(120, 30, { weapons: slots(K47.index, HAMMER.index), aim: 0.4 }, { weapons: slots(K47.index, HAMMER.index), active: 1, aim: 0.4 })];
    const socket = av.inst.bone('socket_weapon_R')!;
    const along = new Vector3(Math.cos(0.4), Math.sin(0.4), 0);
    const q = new Quaternion();
    turns(av, views, (_a, i) => {
      // before the switch, and from 0.3 s after it ends
      if (i < 30 || i > 30 + (switchSeconds(HAMMER.index) + 0.3) / DT) {
        const barrel = new Vector3(0, 1, 0).applyQuaternion(socket.getWorldQuaternion(q));
        expect((barrel.angleTo(along) * 180) / Math.PI, `frame ${i}`).toBeLessThan(0.5);
      }
    });
    expect(weapons[HAMMER.index]?.hands).toBe(1);
  }, SLOW);
});

describe('§9 actions: reloads and throws are visible, and the gun is back on the aim within 0.15 s', () => {
  for (const [gun, other] of [
    [K47, HAMMER],
    [HAMMER, K47],
    [SHREDDER, BUZZ],
  ] as const)
    it(`${gun.name}: a ${gun.reload} s reload moves the upper body ≥ 15°; the barrel is within 2° of the aim 0.15 s after`, async () => {
      const av = await feelAvatar();
      const reload = Math.round(gun.reload * 60);
      const views = Array.from({ length: 60 + reload + 30 }, (_, i) => ({
        ...[...timeline(1, 0, {}, {})][0]!,
        aim: 0.15,
        weapons: [
          { def: gun.index, mag: 6, reserve: 30, reloadTicks: i >= 60 && i < 60 + reload ? 60 + reload - i : 0 },
          { def: other.index, mag: 6, reserve: 30, reloadTicks: 0 },
        ],
      }));
      const rest = new Map<string, Quaternion>();
      let moved = 0;
      const socket = av.inst.bone('socket_weapon_R')!;
      const along = new Vector3(Math.cos(0.15), Math.sin(0.15), 0);
      const q = new Quaternion();
      const frames = turns(av, views, (a, i) => {
        if (i === 59) a.inst.root.traverse((b) => upperBody(b.name) && rest.set(b.name, b.quaternion.clone()));
        if (i >= 60 && i < 60 + reload)
          a.inst.root.traverse((b) => {
            const r = rest.get(b.name);
            if (r) moved = Math.max(moved, (2 * Math.acos(Math.min(1, Math.abs(r.dot(b.quaternion)))) * 180) / Math.PI);
          });
        if (i === 60 + reload + 9) expect((new Vector3(0, 1, 0).applyQuaternion(socket.getWorldQuaternion(q)).angleTo(along) * 180) / Math.PI).toBeLessThan(2);
      });
      expect(moved).toBeGreaterThanOrEqual(15);
      // into and out of it: eased, no pop (the clip's own motion stays under 20° a frame)
      expect(peak(frames, 58, 64).deg).toBeLessThan(20);
      expect(peak(frames, 60 + reload - 2, 60 + reload + 20).deg).toBeLessThan(20);
    }, SLOW);

  it('a throw (the sim’s event) plays on the spine and the off hand; the gun stays on the aim', async () => {
    const av = await feelAvatar();
    const views = [...timeline(120, 60, { weapons: slots(K47.index, HAMMER.index) }, { weapons: slots(K47.index, HAMMER.index) })];
    const hand = new Vector3();
    let travel = 0;
    let last: Vector3 | null = null;
    const socket = av.inst.bone('socket_weapon_R')!;
    const along = new Vector3(Math.cos(0.15), Math.sin(0.15), 0);
    const q = new Quaternion();
    turns(av, views, (a, i) => {
      if (i === 59) a.threw();
      if (i >= 60 && i < 100) {
        a.inst.bone('hand_L')!.getWorldPosition(hand);
        if (last) travel += hand.distanceTo(last);
        last = hand.clone();
        // the gun hand stays aimed through the throw (its arm isn't the throwing one)
        if (i > 75) expect((new Vector3(0, 1, 0).applyQuaternion(socket.getWorldQuaternion(q)).angleTo(along) * 180) / Math.PI).toBeLessThan(2);
      }
    });
    expect(travel, 'the off hand’s path (m)').toBeGreaterThan(0.5);
  }, SLOW);
});

describe('§9 death: not invisible on the death frame; gone within 0.7 s; one setting brings back the vanish', () => {
  it('collapses, then fades, then hides until the respawn', async () => {
    const av = await feelAvatar();
    const views = [
      ...timeline(60, 60, { weapons: slots(K47.index, HAMMER.index) }, {}),
      ...timeline(60, 0, {}, { weapons: slots(K47.index, HAMMER.index), alive: false, deaths: 1 }),
      ...timeline(10, 0, {}, { weapons: slots(K47.index, HAMMER.index), deaths: 1 }),
    ];
    const pelvis = new Vector3();
    let low = Infinity;
    const frames = turns(av, views, (a, i) => {
      if (i === 60) expect(a.pivot.visible, 'the death frame').toBe(true);
      if (i >= 60 && i < 84) low = Math.min(low, a.inst.bone('pelvis')!.getWorldPosition(pelvis).y);
      if (i === 60 + Math.ceil(0.7 * 60)) expect(a.pivot.visible, 'gone by 0.7 s').toBe(false);
      if (i === 120) expect(a.pivot.visible, 'back at the respawn').toBe(true);
    });
    expect(low, 'the hips come down (m)').toBeLessThan(0.36);
    expect(peak(frames, 59, 100).deg, 'into the collapse: no pop').toBeLessThan(20);
  }, SLOW);

  it('the vanish style hides on the death frame', async () => {
    const av = await feelAvatar();
    kit.deathStyle = 'vanish';
    try {
      turns(av, timeline(70, 60, {}, { alive: false, deaths: 1 }), (a, i) => {
        if (i >= 60) expect(a.pivot.visible).toBe(false);
      });
    } finally {
      kit.deathStyle = 'collapse';
    }
  }, SLOW);
});

describe('§9 walk band: the foot on the ground keeps up with the ground', () => {
  // (the run band, 2–5 m/s, is the foot-skate PR's)
  for (const speed of [0.5, 1.0, 1.5])
    it(`at ${speed} m/s the contact foot moves at ≤ 15% of the ground speed (the planted walk, mocap_clips.py)`, async () => {
      const r = await contactSkate(speed);
      expect(r.share).toBeLessThanOrEqual(0.15);
    }, SLOW);
});

describe('§9 standing turn: the feet step round instead of sliding; the yaw starts and stops at rest', () => {
  for (const [name, from, to] of [
    ['right to left', 0.15, Math.PI - 0.15],
    ['left to right', Math.PI - 0.15, 0.15],
  ] as const)
    it(`${name}: no foot slides on the floor; both land within 0.2 s; the chest leads with a little overshoot`, async () => {
      const av = await feelAvatar();
      const yaws: number[] = [];
      const slide = [0, 0];
      const lifted = [0, 0];
      let landed = -1;
      let last: ReturnType<typeof feet> | null = null;
      const chest = new Vector3();
      let lead = 0;
      turns(av, timeline(120, 60, { aim: from }, { aim: to }), (a, i) => {
        const f = feet(a);
        yaws.push(a.pivot.rotation.y);
        if (last && i >= 60) {
          for (const k of [0, 1]) {
            const d = Math.hypot(f[k].x - last[k].x, f[k].z - last[k].z);
            if (f[k].y < 0.13 && last[k].y < 0.13) slide[k] += d;
            else lifted[k] += d;
          }
          if (f.every((p) => p.y < 0.125) && landed < 0 && i > 62) landed = i - 60;
          // the chest's facing against the hips': ahead of them mid-turn
          const q = a.inst.bone('spine2')!.getWorldQuaternion(new Quaternion());
          chest.set(0, 0, 1).applyQuaternion(q);
          lead = Math.max(lead, Math.abs(Math.atan2(chest.x, chest.z) - a.pivot.rotation.y));
        }
        last = f;
      });
      for (const k of [0, 1]) {
        expect(slide[k], `foot ${k} sliding on the floor (m)`).toBeLessThan(0.01);
        expect(lifted[k], `foot ${k} stepped`).toBeGreaterThan(0.25);
      }
      expect(landed * DT, 'both feet down again (s)').toBeLessThanOrEqual(0.2);
      const step = (i: number) => (Math.abs(yaws[i]! - yaws[i - 1]!) * 180) / Math.PI;
      expect(step(60), 'the yaw eases in (°/frame)').toBeLessThan(5);
      const end = yaws.findIndex((y, i) => i > 60 && y === yaws[yaws.length - 1]);
      expect(step(end), 'and out').toBeLessThan(5);
      expect((lead * 180) / Math.PI, 'the chest leads the hips (°)').toBeGreaterThan(3);
    }, SLOW);

  it('aiming across the top (the facing flips mid-sweep): the gun rolls over, no bone turns more than 20° a frame', async () => {
    const av = await feelAvatar();
    const views = Array.from({ length: 100 }, (_, i) => {
      const u = Math.min(1, Math.max(0, (i - 60) / 12));
      return { ...[...timeline(1, 0, {}, {})][0]!, aim: 1.2 + 0.75 * u };
    });
    const frames = turns(av, views, undefined, (b) => !upperBody(b.name));
    expect(peak(frames, 55, 100).deg).toBeLessThan(20);
  }, SLOW);
});

describe('§9 timing: a take-off with a crouch, a landing with an attack and a rebound', () => {
  it('jet take-off at the sim’s thrust: a dip as it pushes off, then the climb pose ≥ 90% within 200 ms', async () => {
    const av = await feelAvatar();
    const game = new Game({ map: movementTestMap, seed: 7, dummies: false });
    const me = game.addPlayer('P');
    me.spawn(118, 0, game.tuning);
    const input = createInput();
    let left = -1;
    let reached = -1;
    let dip = 0;
    for (let i = 0; i < 120; i++) {
      input.buttons = i < 60 ? 0 : Btn.Jet;
      input.aim = angleToU16(0.15);
      game.step([input]);
      av.update(playerView({ x: me.x, y: me.y, vx: me.vx, vy: me.vy, grounded: me.grounded, jetting: me.jetting, aim: me.aim }), DT, world, false);
      if (left < 0 && !me.grounded) left = i;
      if (left >= 0 && i - left <= 3) dip = Math.max(dip, av.motion.drop);
      if (left >= 0 && reached < 0 && (av.loco.weights().ascend ?? 0) >= 0.9) reached = i;
    }
    expect(dip, 'the hips dip in the first frames (m)').toBeGreaterThan(0.015);
    expect((reached - left) * DT, 'climb pose at 90% (s)').toBeLessThanOrEqual(0.2);
  }, SLOW);

  it('landing at 10 m/s: no knee turns more than 15° a frame; the dip peaks within 3 frames and rebounds 5–8%', async () => {
    const av = await feelAvatar();
    const drops: number[] = [];
    const frames = turns(
      av,
      (function* () {
        for (let i = 0; i < 90; i++) {
          const t = i * DT;
          const h = 2.5 - 10 * t * t;
          yield h > 0 ? playerView({ x: 118, y: h, vy: -20 * t, grounded: false, aim: 0.15 }) : playerView({ x: 118, aim: 0.15 });
        }
      })(),
      (a) => drops.push(a.motion.drop),
      (b) => !b.name.startsWith('calf'),
    );
    const touch = drops.findIndex((d) => d > 0.001);
    expect(peak(frames, touch - 2, touch + 20).deg, 'knee (°/frame)').toBeLessThan(15);
    const deepest = Math.max(...drops);
    expect(drops.indexOf(deepest) - touch, 'frames to the bottom').toBeLessThanOrEqual(3);
    const rebound = -Math.min(...drops.slice(drops.indexOf(deepest)));
    expect(rebound / deepest, 'rebound past standing').toBeGreaterThanOrEqual(0.05);
    expect(rebound / deepest).toBeLessThanOrEqual(0.08);
  }, SLOW);
});
