/**
 * Animation logic that doesn't need a GPU: the locomotion state machine (docs/11 §4: idle / run /
 * crouch / jet / hover / fall), the facing turn (docs/04 §4.2) and the aim elevation. Pure, so it is
 * unit-tested; avatar.ts maps the results onto the AnimationMixer and the skeleton.
 */
export type LocoState = 'idle' | 'run' | 'crouch' | 'jet' | 'hover' | 'fall';

export interface LocoInput {
  grounded: boolean;
  crouched: boolean;
  jetting: boolean;
  vx: number;
  vy: number;
}

/** grounded speed (m/s) to start running / to stop again (hysteresis keeps it from flickering) */
export const RUN_ENTER = 0.6;
export const RUN_EXIT = 0.3;
/** airborne this long before 'fall' plays, so step-ups and slope crests don't flash it */
export const FALL_DELAY = 0.12;
/** speed the run clip is authored for: the walk speed (NOTES.md §1) */
export const RUN_CLIP_SPEED = 5;

export class Locomotion {
  state: LocoState = 'idle';
  private airTime = 0;

  update(p: LocoInput, dt: number): LocoState {
    this.airTime = p.grounded ? 0 : this.airTime + dt;
    const prev = this.state;
    let next: LocoState;
    if (p.grounded) {
      const speed = Math.abs(p.vx);
      if (p.crouched) next = 'crouch';
      else next = speed > (prev === 'run' ? RUN_EXIT : RUN_ENTER) ? 'run' : 'idle';
    } else if (p.jetting) {
      next = p.vy > (prev === 'jet' ? 0 : 1) ? 'jet' : 'hover';
    } else if (this.airTime >= FALL_DELAY || p.vy < -2 || prev === 'jet' || prev === 'hover' || prev === 'fall') {
      next = 'fall';
    } else next = prev;
    this.state = next;
    return next;
  }
}

/** Clips to try per state, in order (the Phase 0 Rookie has no walk / crouch_walk yet). */
export function clipCandidates(state: LocoState, speed: number): readonly string[] {
  switch (state) {
    case 'run':
      return ['run', 'walk'];
    case 'crouch':
      return speed > RUN_ENTER ? ['crouch_walk', 'crouch_idle'] : ['crouch_idle'];
    case 'jet':
      return ['jet_ascend', 'jet_hover'];
    case 'hover':
      return ['jet_hover', 'jet_ascend'];
    case 'fall':
      return ['fall', 'idle'];
    default:
      return ['idle'];
  }
}

/** Cross-fade into `to` (seconds): landings snap, take-offs and falls ease. */
export function fadeTime(from: LocoState, to: LocoState): number {
  if (from === 'fall' || from === 'hover' || from === 'jet') return to === 'idle' || to === 'run' || to === 'crouch' ? 0.08 : 0.15;
  return to === 'fall' ? 0.2 : 0.15;
}

/** Playback rate of the run clip at this ground speed. */
export function runTimeScale(speed: number): number {
  return Math.min(1.4, Math.max(0.6, speed / RUN_CLIP_SPEED));
}

/** Which way the body faces: the same rule the sim uses for the shoulder (cos(aim) ≥ 0 → right). */
export function facingOf(aim: number): 1 | -1 {
  return Math.cos(aim) >= 0 ? 1 : -1;
}

/** Yaw that shows the side view turned this far toward the camera (docs/04 §4.2 "3/4 view"). */
export const TOWARD_CAMERA = (30 * Math.PI) / 180;
/** docs/04 §4.2: a full 180° turn takes 120 ms */
export const TURN_RATE = Math.PI / 0.12;

export function facingYaw(facing: 1 | -1): number {
  return facing * (Math.PI / 2 - TOWARD_CAMERA);
}

/** Turns `yaw` toward `target` at TURN_RATE; the path passes through facing the camera (yaw 0). */
export function stepYaw(yaw: number, target: number, dt: number): number {
  const step = TURN_RATE * dt;
  return Math.abs(target - yaw) <= step ? target : yaw + Math.sign(target - yaw) * step;
}

/** Aim angle above the horizontal on the side the player faces, −π/2…π/2. */
export function aimElevation(aim: number): number {
  return Math.atan2(Math.sin(aim), Math.abs(Math.cos(aim)));
}
