import { describe, expect, it } from 'vitest';
import {
  FALL_DELAY,
  Locomotion,
  RUN_ENTER,
  TURN_RATE,
  aimElevation,
  clipCandidates,
  facingOf,
  facingYaw,
  fadeTime,
  runTimeScale,
  stepYaw,
  type LocoInput,
} from '../locomotion';

const ground = (vx = 0, crouched = false): LocoInput => ({ grounded: true, crouched, jetting: false, vx, vy: 0 });
const air = (vy: number, jetting = false): LocoInput => ({ grounded: false, crouched: false, jetting, vx: 0, vy });

describe('locomotion state machine', () => {
  it('runs above the enter speed and stops below the exit speed (no flicker in between)', () => {
    const l = new Locomotion();
    expect(l.update(ground(0.5), 1 / 60)).toBe('idle');
    expect(l.update(ground(RUN_ENTER + 0.1), 1 / 60)).toBe('run');
    expect(l.update(ground(0.4), 1 / 60)).toBe('run');
    expect(l.update(ground(-0.4), 1 / 60)).toBe('run');
    expect(l.update(ground(0.2), 1 / 60)).toBe('idle');
    expect(l.update(ground(3, true), 1 / 60)).toBe('crouch');
  });

  it('jets while thrusting upward, hovers when the climb stops', () => {
    const l = new Locomotion();
    expect(l.update(air(0.5, true), 1 / 60)).toBe('hover');
    expect(l.update(air(1.5, true), 1 / 60)).toBe('jet');
    expect(l.update(air(0.3, true), 1 / 60)).toBe('jet');
    expect(l.update(air(-0.2, true), 1 / 60)).toBe('hover');
    expect(l.update(air(-1), 1 / 60)).toBe('fall');
  });

  it('waits FALL_DELAY before falling off a step, unless dropping fast', () => {
    const l = new Locomotion();
    l.update(ground(2), 1 / 60);
    expect(l.update(air(-0.5), FALL_DELAY / 2)).toBe('run');
    expect(l.update(air(-0.5), FALL_DELAY / 2)).toBe('fall');
    const fast = new Locomotion();
    expect(fast.update(air(-3), 1 / 60)).toBe('fall');
    expect(fast.update(ground(0), 1 / 60)).toBe('idle');
  });

  it('maps states to clips with fallbacks for the Phase 0 Rookie, and snaps landings', () => {
    expect(clipCandidates('run', 5)).toEqual(['run', 'walk']);
    expect(clipCandidates('crouch', 2)).toEqual(['crouch_walk', 'crouch_idle']);
    expect(clipCandidates('crouch', 0)).toEqual(['crouch_idle']);
    expect(clipCandidates('hover', 0)[0]).toBe('jet_hover');
    expect(fadeTime('fall', 'idle')).toBeLessThan(fadeTime('idle', 'fall'));
    expect(runTimeScale(5)).toBe(1);
    expect(runTimeScale(20)).toBe(1.4);
    expect(runTimeScale(0.1)).toBe(0.6);
  });
});

describe('facing and aim', () => {
  it('faces the side the sim puts the shoulder on (cos(aim) ≥ 0 → right)', () => {
    expect(facingOf(0)).toBe(1);
    expect(facingOf(Math.PI / 2 - 0.01)).toBe(1);
    expect(facingOf(Math.PI / 2 + 0.01)).toBe(-1);
    expect(facingOf(-Math.PI + 0.1)).toBe(-1);
  });

  it('turns (never mirrors) through facing the camera at 180° per 120 ms', () => {
    let yaw = facingYaw(1);
    expect(yaw).toBeCloseTo((60 * Math.PI) / 180, 9);
    const target = facingYaw(-1);
    let t = 0;
    let passedCamera = false;
    while (yaw !== target) {
      yaw = stepYaw(yaw, target, 1 / 240);
      t += 1 / 240;
      if (Math.abs(yaw) < 0.05) passedCamera = true;
    }
    expect(passedCamera).toBe(true);
    expect(t).toBeCloseTo((2 * facingYaw(1)) / TURN_RATE, 2); // 120° → 80 ms
  });

  it('measures elevation on the facing side', () => {
    expect(aimElevation(0.3)).toBeCloseTo(0.3, 9);
    expect(aimElevation(Math.PI - 0.3)).toBeCloseTo(0.3, 9);
    expect(aimElevation(-Math.PI + 0.2)).toBeCloseTo(-0.2, 9);
  });
});
