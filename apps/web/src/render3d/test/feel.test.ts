/**
 * The character-feel acceptance criteria (docs/design/character-feel-research.md §9) as pass/fail numbers, on the real
 * skeleton and clips (feel.ts drives the Avatar at 60 Hz).
 */
import { BREACHER, BUZZ, HAMMER, K47, MACHETE, NO_WEAPON, SHREDDER, WIDOW, weapons } from '@military-forge/content';
import { Quaternion, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import type { PlayerView, WeaponView } from '../../view';
import { UPPER_BODY } from '../locomotion';
import { switchSeconds } from '../sling';
import { DT, feelAvatar, peak, timeline, turns } from './feel';

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
