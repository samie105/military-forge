/**
 * Shooting-range scenario for lag compensation: a shooter on top of the 12 m tower aims down at a
 * target walking back and forth below it (x 148–153), exactly where its own screen draws it (the
 * interpolated snapshots), tapping fire every 40 ticks. The steep angle matters: in a side view a
 * flat shot runs along the line a walking target moves on and would hit it anyway.
 * Used by test/lagcomp.test.ts.
 */
import { STANDING_HITBOXES } from '@military-forge/content';
import type { ConditionerSettings, RemotePose } from '@military-forge/netcode';
import { angleToU16 } from '@military-forge/shared';
import { Btn } from '@military-forge/sim';
import { simulate } from './netsimHarness';

const SHOOTER_X = 143.6;
const SHOOTER_Y = 12;
const TARGET_MIN_X = 148;
const TARGET_MAX_X = 153;
const WARMUP_MS = 5000;
const TORSO_MID = (STANDING_HITBOXES.torso.y0 + STANDING_HITBOXES.torso.y1) / 2;

export interface RangeResult {
  shots: number;
  hits: number;
  /** misses that hit level geometry first */
  blocked: number;
  /** distance between where the shooter's screen drew the target and the pose the server tested */
  poseErrors: number[];
  rewindTicks: number[];
  clamped: number;
}

export function shootingRange(
  settings: ConditionerSettings,
  lagComp: boolean | { maxRewindMs: number },
  seconds = 40,
  shooterLowBandwidth = false,
  frameMs?: number,
  /** fire on ticks ≡ this (mod 40): odd offsets put shots on the older tick of a batched pair */
  fireOffset = 0,
): RangeResult {
  const result: RangeResult = { shots: 0, hits: 0, blocked: 0, poseErrors: [], rewindTicks: [], clamped: 0 };
  const aimedAt = new Map<number, { x: number; y: number }>();
  const pose: RemotePose = { x: 0, y: 0, src: null! };
  let placed = false;
  let dir = 1;
  let targetId = -1;
  let shooterId = -1;
  simulate(settings, seconds, {
    warmupSeconds: 2,
    room: { dummies: false, lagComp, dev: true },
    ...(shooterLowBandwidth ? { lowBandwidth: [1] } : {}),
    ...(frameMs ? { frameMs } : {}),
    beforeTick: (room, nets) => {
      targetId = nets[0]!.myId;
      shooterId = nets[1]!.myId;
      const target = room.game.players[targetId];
      const shooter = room.game.players[shooterId];
      if (!target || !shooter) return;
      if (!placed) {
        target.x = (TARGET_MIN_X + TARGET_MAX_X) / 2;
        target.y = 0;
        shooter.x = SHOOTER_X;
        shooter.y = SHOOTER_Y;
        target.vx = target.vy = shooter.vx = shooter.vy = 0;
        placed = true;
      }
      // we're measuring aim, not kills: nobody dies
      target.hp = shooter.hp = room.game.tuning.healthMax;
    },
    afterTick: (room) => {
      for (const e of room.game.events) {
        if (e.type !== 'shot' || e.shooter !== shooterId || !aimedAt.has(room.game.tick - 1)) continue;
        result.shots++;
        if (e.target === targetId) result.hits++;
        else if (e.hit === 1) result.blocked++;
      }
      for (const r of room.lagComp?.log ?? []) {
        const aimed = aimedAt.get(r.tick);
        if (r.shooter !== shooterId || r.target !== targetId || !aimed) continue;
        result.poseErrors.push(Math.hypot(aimed.x - r.x, aimed.y - r.y));
        result.rewindTicks.push(r.tick - r.viewTick);
        if (r.clamped) result.clamped++;
      }
    },
    input: (k, now, net, out) => {
      const me = net.predictor?.player;
      if (!me || !placed) return;
      if (k === 0) {
        // target: strafe between the marks at full walking speed
        if (me.x < TARGET_MIN_X) dir = 1;
        if (me.x > TARGET_MAX_X) dir = -1;
        out.buttons = dir > 0 ? Btn.Right : Btn.Left;
        return;
      }
      // shooter: aim at the target's torso as this screen shows it; tap fire every 40 ticks
      if (Number.isNaN(net.viewTick) || !net.remotePose(targetId, net.viewTick, pose)) return;
      const t = net.tuning;
      out.aim = angleToU16(Math.atan2(pose.y + TORSO_MID - me.shoulderY(t), pose.x - me.shoulderX(t)));
      const tick = net.predictor!.tick;
      if (now > WARMUP_MS && tick % 40 === fireOffset) {
        out.buttons = Btn.Fire;
        aimedAt.set(tick, { x: pose.x, y: pose.y });
      } else out.buttons = 0;
    },
  });
  return result;
}
