/**
 * A body for trying things out, away from any Game: the nav graph settles it on candidate points
 * and flies the motor through candidate links with the real movement code (stepMovement), feeling
 * the map's rules and always-on zones as a player would (no map events: those come and go).
 */
import { HAMMER, WIDOW, weapons, type MapDef, type Tuning } from '@military-forge/content';
import { CollisionWorld, MapMechanics, PlayerState, createBodyEnv, depenetrate, giveLoadout, quantizeMovement, stepMovement, type BodyEnv } from '@military-forge/sim';

/** the heaviest gun in hand (×0.9 speed): a link it can fly, every loadout can */
const PROBE_LOADOUT = [WIDOW.index, HAMMER.index] as const;

export class Probe {
  readonly p = new PlayerState(0);
  /** what the body felt on the last step (null on a map without mechanics) */
  env: BodyEnv | null = null;
  private readonly scratch = createBodyEnv();
  private readonly minY: number;

  constructor(
    readonly world: CollisionWorld,
    readonly t: Tuning,
    readonly mech: MapMechanics | null,
    map: MapDef,
  ) {
    this.minY = map.bounds.minY;
    giveLoadout(this.p, weapons, PROBE_LOADOUT);
  }

  /** The environment at the body now. */
  feel(): BodyEnv | null {
    return this.mech ? this.mech.bodyEnv(this.p, this.t, this.scratch) : null;
  }

  /** Puts the body at (x, y), standing, with a full tank, pushed out of anything it overlaps. */
  place(x: number, y: number): void {
    const p = this.p;
    p.spawn(x, y, this.t);
    p.active = 0;
    p.input.buttons = 0;
    p.prevButtons = 0;
    depenetrate(this.world, p, this.t);
  }

  step(buttons: number): void {
    const p = this.p;
    p.input.buttons = buttons;
    this.env = this.feel();
    stepMovement(this.world, p, this.t, this.env);
    quantizeMovement(p);
    p.prevButtons = buttons;
  }

  /** Fell out of the map (the sim's kill line). */
  get dead(): boolean {
    return this.p.y <= this.minY + 0.5;
  }

  /** Lets the body come to rest. True if it ends up standing still on the ground. */
  settle(maxTicks = 40): boolean {
    const p = this.p;
    for (let i = 0; i < maxTicks; i++) {
      this.step(0);
      if (this.dead) return false;
      if (p.grounded && Math.abs(p.vx) < 1e-3 && Math.abs(p.vy) < 1e-3) return true;
    }
    return false;
  }
}
