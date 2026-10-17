/**
 * Kinematic character controller (docs/02 §7–§11). The feel of the whole game lives here.
 *
 * Shape: a vertical capsule (2D "stadium") with feet at (x, y). Per tick:
 * intent → jetpack/fuel → gravity → move-and-slide (substeps + resolve) → step-up → ground snap.
 */
import type { Tuning } from '@military-forge/content';
import { DEG2RAD, approach, quantize, simCos, simExp, simSin, u16ToAngle, POS_INV, VEL_INV, SCALAR_INV } from '@military-forge/shared';
import { heldSpeedMul, lungeSpeed } from './combat';
import { DT, SKIN, ticks } from './constants';
import { closestSegSeg, createClosestPair, rayCapsule, closestPointOnSegment } from './geometry';
import { Btn, isDown } from './input';
import type { PlayerState } from './player';
import { CollisionWorld, SegFlag } from './world';

const pair = createClosestPair();
/** m/s: below this an upward vertical speed is numerical noise, not take-off. */
const UP_EPSILON = 1e-4;
const pt = { x: 0, y: 0 };

/** Result of the deepest-contact query. Module scratch: the sim is single-threaded. */
export interface Contact {
  depth: number;
  nx: number;
  ny: number;
  /** contact point on the segment */
  px: number;
  py: number;
  seg: number;
  flags: number;
}

const contact: Contact = { depth: 0, nx: 0, ny: 0, px: 0, py: 0, seg: -1, flags: 0 };

/** Context for one-way platform rules. */
interface OneWayRule {
  /** feet height at the start of the tick */
  prevFeetY: number;
  vy: number;
  dropping: boolean;
}

const oneWay: OneWayRule = { prevFeetY: 0, vy: 0, dropping: false };

function oneWaySolid(world: CollisionWorld, seg: number, x: number, rule: OneWayRule): boolean {
  if (rule.dropping || rule.vy > 0.0001) return false;
  return rule.prevFeetY >= world.segmentYAt(seg, x) - 0.05;
}

/**
 * Finds the deepest penetration between a capsule (feet at x,y; height h; radius r) and the
 * world. Returns false if nothing overlaps.
 */
export function deepestContact(
  world: CollisionWorld,
  x: number,
  y: number,
  h: number,
  r: number,
  rule: OneWayRule | null,
  out: Contact,
): boolean {
  const y0 = y + r;
  const y1 = y + h - r;
  const count = world.queryAabb(x - r - 0.05, y - 0.05, x + r + 0.05, y + h + 0.05);
  const r2 = r * r;
  out.depth = 0;
  out.seg = -1;
  for (let k = 0; k < count; k++) {
    const seg = world.queryResult[k]!;
    const flags = world.flags[seg]!;
    if (flags & SegFlag.OneWay) {
      if (!rule || !oneWaySolid(world, seg, x, rule)) continue;
    }
    const ax = world.ax[seg]!;
    const ay = world.ay[seg]!;
    const bx = world.bx[seg]!;
    const by = world.by[seg]!;
    const d2 = closestSegSeg(x, y0, x, y1, ax, ay, bx, by, pair);
    if (d2 >= r2) continue;
    const segNx = world.nx[seg]!;
    const segNy = world.ny[seg]!;
    const dist = Math.sqrt(d2);
    // Is the closest point on the segment one of its endpoints (a corner)?
    const ex = bx - ax;
    const ey = by - ay;
    const len2 = ex * ex + ey * ey;
    const u = len2 > 1e-12 ? ((pair.bx - ax) * ex + (pair.by - ay) * ey) / len2 : 0;
    const atCorner = u <= 1e-9 || u >= 1 - 1e-9;
    let nx: number;
    let ny: number;
    let depth: number;
    if (dist > 1e-9) {
      nx = (pair.ax - pair.bx) / dist;
      ny = (pair.ay - pair.by) / dist;
      if (!atCorner && nx * segNx + ny * segNy < 0) {
        // the capsule core is behind the middle of this face (deep inside the solid): push out along
        // the face normal. Never at a corner: brushing a ledge corner from the side would otherwise
        // read as "inside" and pop the player up through the ledge top (0.6 m teleport).
        nx = segNx;
        ny = segNy;
        depth = r + dist;
      } else depth = r - dist;
    } else {
      nx = segNx;
      ny = segNy;
      depth = r;
    }
    if (flags & SegFlag.OneWay && ny <= 0.3) continue; // platforms only ever push up
    // ascending segment order + strict comparison = ties keep the lowest index (deterministic)
    if (depth > out.depth + 1e-12) {
      out.depth = depth;
      out.nx = nx;
      out.ny = ny;
      out.px = pair.bx;
      out.py = pair.by;
      out.seg = seg;
      out.flags = flags;
    }
  }
  return out.seg >= 0 && out.depth > 1e-9;
}

/** Scratch for sweep results. */
const sweep = { t: 0, nx: 0, ny: 0, seg: -1, flags: 0 };

/**
 * Sweeps the capsule's bottom circle straight down by `dist`. Returns true if it lands on walkable
 * ground (normal.y ≥ cosMaxSlope); on success, `sweep` holds the hit.
 */
function sweepDown(world: CollisionWorld, p: PlayerState, r: number, dist: number, cosMax: number, rule: OneWayRule): boolean {
  const cx = p.x;
  const cy = p.y + r;
  const count = world.queryAabb(cx - r - 0.05, cy - r - dist - 0.05, cx + r + 0.05, cy + 0.05);
  let bestT = Infinity;
  let bestSeg = -1;
  let bestNx = 0;
  let bestNy = 0;
  // earliest steep contacts on each side, for resting in wedges (two steep slopes that together support you)
  let leftT = Infinity;
  let leftNx = 0;
  let leftNy = 0;
  let rightT = Infinity;
  let rightNx = 0;
  let rightNy = 0;
  for (let k = 0; k < count; k++) {
    const seg = world.queryResult[k]!;
    const flags = world.flags[seg]!;
    if (flags & SegFlag.OneWay && !oneWaySolid(world, seg, cx, rule)) continue;
    const ax = world.ax[seg]!;
    const ay = world.ay[seg]!;
    const bx = world.bx[seg]!;
    const by = world.by[seg]!;
    const t = rayCapsule(cx, cy, 0, -dist, ax, ay, bx, by, r);
    if (t > 1) continue;
    // normal at the hit point
    const hy = cy - dist * t;
    closestPointOnSegment(cx, hy, ax, ay, bx, by, pt);
    let nx = cx - pt.x;
    let ny = hy - pt.y;
    const len = Math.sqrt(nx * nx + ny * ny);
    if (len > 1e-9) {
      nx /= len;
      ny /= len;
    } else {
      nx = world.nx[seg]!;
      ny = world.ny[seg]!;
    }
    if (ny <= 0) continue; // only surfaces below us can support us
    if (t < bestT) {
      bestT = t;
      bestSeg = seg;
      bestNx = nx;
      bestNy = ny;
    }
    if (ny < cosMax) {
      if (nx > 0.05 && t < leftT) {
        leftT = t;
        leftNx = nx;
        leftNy = ny;
      } else if (nx < -0.05 && t < rightT) {
        rightT = t;
        rightNx = nx;
        rightNy = ny;
      }
    }
  }
  if (bestSeg < 0) return false;
  if (bestNy < cosMax) {
    // wedge: steep surfaces on both sides, touching at (almost) the same height
    if (leftT === Infinity || rightT === Infinity || Math.abs(leftT - rightT) * dist > 0.01) return false;
    let wx = leftNx + rightNx;
    let wy = leftNy + rightNy;
    const wl = Math.sqrt(wx * wx + wy * wy);
    wx /= wl;
    wy /= wl;
    if (wy < cosMax) return false;
    bestT = Math.min(leftT, rightT);
    bestNx = wx;
    bestNy = wy;
  }
  sweep.t = bestT;
  sweep.nx = bestNx;
  sweep.ny = bestNy;
  sweep.seg = bestSeg;
  sweep.flags = world.flags[bestSeg]!;
  return true;
}

/** Per-tick scratch describing what the resolver touched. */
interface MoveResult {
  hitGround: boolean;
  hitWall: boolean;
  hitCeiling: boolean;
  bonked: boolean;
  /** lowest wall contact point this tick (for step-up) */
  wallPx: number;
  wallPy: number;
}

const moveResult: MoveResult = { hitGround: false, hitWall: false, hitCeiling: false, bonked: false, wallPx: 0, wallPy: 0 };

function resolve(world: CollisionWorld, p: PlayerState, t: Tuning, h: number, cosMax: number, groundedMode: boolean, res: MoveResult): void {
  const r = t.capsuleRadius;
  oneWay.vy = groundedMode ? 0 : p.vy;
  for (let iter = 0; iter < 4; iter++) {
    if (!deepestContact(world, p.x, p.y, h, r, oneWay, contact)) return;
    let nx = contact.nx;
    let ny = contact.ny;
    let depth = contact.depth;

    // Ceiling corner correction (§10.6): flying up past a ledge corner nudges sideways instead of bonking.
    if (!groundedMode && p.vy > 0 && ny < 0 && contact.py > p.y + h - r) {
      const off = contact.px - p.x;
      if (Math.abs(off) > r - t.cornerCorrection) {
        const shift = (r + SKIN - Math.abs(off)) * (off > 0 ? -1 : 1);
        if (!deepestContact(world, p.x + shift, p.y, h, r, oneWay, contact)) {
          p.x += shift;
          continue;
        }
      }
    }

    const walkable = ny >= cosMax;
    if (groundedMode && !walkable) {
      // While walking, anything that isn't walkable ground (steep slopes, ceiling corners) blocks
      // horizontally only: no creeping up steep slopes, no being pushed into the floor.
      const ax = Math.abs(nx);
      if (ax <= 1e-6) return;
      depth = (depth * (nx * nx + ny * ny)) / ax;
      nx = nx > 0 ? 1 : -1;
      ny = 0;
    }

    p.x += nx * (depth + SKIN);
    p.y += ny * (depth + SKIN);

    if (walkable) {
      res.hitGround = true;
      p.groundNx = nx;
      p.groundNy = ny;
      p.groundFlags = contact.flags;
    } else if (ny <= -0.7) {
      res.hitCeiling = true;
      if (p.vy > 0 && !res.bonked) {
        p.vx *= t.ceilingBonkVxMul;
        res.bonked = true;
      }
    } else {
      if (!res.hitWall || contact.py < res.wallPy) {
        res.wallPx = contact.px;
        res.wallPy = contact.py;
      }
      res.hitWall = true;
    }

    // remove the velocity component pointing into the surface
    if (!(groundedMode && walkable)) {
      const vn = p.vx * nx + p.vy * ny;
      if (vn < 0) {
        p.vx -= nx * vn;
        p.vy -= ny * vn;
      }
    }
  }
}

/** Moves the player by its velocity for one tick with collision (§10). */
function moveAndSlide(world: CollisionWorld, p: PlayerState, t: Tuning, cosMax: number, res: MoveResult): void {
  const r = t.capsuleRadius;
  const h = p.height(t);
  const groundedMode = p.grounded;
  // ground tangent (unit), pointing right
  const tx = groundedMode ? p.groundNy : 1;
  const ty = groundedMode ? -p.groundNx : 0;
  const speed = groundedMode ? Math.abs(p.vx) : Math.sqrt(p.vx * p.vx + p.vy * p.vy);
  const steps = Math.min(4, Math.max(1, Math.ceil((speed * DT) / (0.5 * r))));
  const hstep = DT / steps;
  for (let s = 0; s < steps; s++) {
    if (groundedMode) {
      p.x += p.vx * tx * hstep;
      p.y += p.vx * ty * hstep;
    } else {
      p.x += p.vx * hstep;
      p.y += p.vy * hstep;
    }
    resolve(world, p, t, h, cosMax, groundedMode, res);
  }
}

/** True if a capsule of height h at (x, y) overlaps solid geometry. */
export function overlaps(world: CollisionWorld, x: number, y: number, h: number, r: number, prevFeetY: number): boolean {
  oneWay.prevFeetY = prevFeetY;
  oneWay.vy = 0;
  oneWay.dropping = true; // one-way platforms never block standing up or stepping
  return deepestContact(world, x, y, h, r, oneWay, contact);
}

/** Lands the capsule on walkable ground within `dist` below. */
function snapDown(world: CollisionWorld, p: PlayerState, t: Tuning, dist: number, cosMax: number): boolean {
  const r = t.capsuleRadius;
  if (!sweepDown(world, p, r, dist, cosMax, oneWay)) return false;
  p.y += -dist * sweep.t + SKIN;
  p.groundNx = sweep.nx;
  p.groundNy = sweep.ny;
  p.groundFlags = sweep.flags;
  return true;
}

/** Step-up for small ledges (§10.3). Called after a grounded move that hit a wall. */
function tryStepUp(
  world: CollisionWorld,
  p: PlayerState,
  t: Tuning,
  startX: number,
  startY: number,
  intendedVx: number,
  cosMax: number,
): void {
  const r = t.capsuleRadius;
  const h = p.height(t);
  const blockedX = p.x;
  const blockedY = p.y;
  const blockedVx = p.vx;
  const blockedVy = p.vy;
  const blockedNx = p.groundNx;
  const blockedNy = p.groundNy;
  const blockedFlags = p.groundFlags;

  const restore = () => {
    p.x = blockedX;
    p.y = blockedY;
    p.vx = blockedVx;
    p.vy = blockedVy;
    p.groundNx = blockedNx;
    p.groundNy = blockedNy;
    p.groundFlags = blockedFlags;
  };

  // Only for obstacles no taller than a step.
  if (moveResult.wallPy - startY > t.stepHeight + 0.001) return restore();
  p.x = startX;
  p.y = startY + t.stepHeight;
  if (overlaps(world, p.x, p.y, h, r, p.prevY)) return restore();
  // Move forward at least far enough that the ledge corner lies under the walkable part of the
  // rounded capsule bottom (horizontal offset ≤ r·sin(maxSlope)); otherwise slow approaches stall.
  const dir = intendedVx > 0 ? 1 : -1;
  const minForward = dir * (moveResult.wallPx - startX) - (r * simSin(t.maxWalkSlopeDeg * DEG2RAD) - 0.005);
  p.x += dir * Math.max(Math.abs(intendedVx) * DT, minForward);
  if (overlaps(world, p.x, p.y, h, r, p.prevY)) return restore();
  oneWay.prevFeetY = p.y;
  oneWay.vy = 0;
  if (!snapDown(world, p, t, t.stepHeight + 0.02, cosMax)) return restore();
  if (Math.abs(p.x - startX) <= Math.abs(blockedX - startX) + 1e-4) return restore();
  p.vx = intendedVx;
  p.vy = 0;
}

/**
 * One tick of movement for one player. `input` is this tick's input; `prevButtons` last tick's.
 */
export function stepMovement(world: CollisionWorld, p: PlayerState, t: Tuning): void {
  const input = p.input;
  const buttons = input.buttons;
  const cosMax = simCos(t.maxWalkSlopeDeg * DEG2RAD);
  const r = t.capsuleRadius;

  p.prevY = p.y;
  p.aim = u16ToAngle(input.aim);
  p.facing = simCos(p.aim) >= 0 ? 1 : -1;

  // --- crouch / stand (stand-up needs clearance) ---
  const wantCrouch = isDown(buttons, Btn.Down) && p.grounded && !isDown(buttons, Btn.Jet);
  if (wantCrouch) p.crouched = true;
  else if (p.crouched && !overlaps(world, p.x, p.y, t.standHeight, r, p.y)) p.crouched = false;

  // --- drop through one-way platforms (hold down) ---
  if (p.grounded && p.groundFlags & SegFlag.OneWay && isDown(buttons, Btn.Down)) {
    p.downHeldTicks++;
    if (p.downHeldTicks >= ticks(t.dropThroughHold)) {
      p.dropTicks = ticks(t.dropThroughTime);
      p.downHeldTicks = 0;
      p.grounded = false;
      p.vy = -1;
    }
  } else p.downHeldTicks = 0;

  // --- 1. horizontal intent (speed caps scale with the held weapon's weight, docs/03 §9) ---
  const ix = (isDown(buttons, Btn.Right) ? 1 : 0) - (isDown(buttons, Btn.Left) ? 1 : 0);
  const vxBefore = p.vx;
  const speedMul = heldSpeedMul(p);
  let cap: number;
  if (p.grounded) {
    cap = (p.crouched ? t.crouchMax : t.walkMax) * speedMul;
    const target = ix * cap;
    const reversing = ix !== 0 && p.vx !== 0 && Math.sign(p.vx) === -ix;
    const accel = ix === 0 ? t.groundDecel : reversing ? t.groundReverse : t.groundAccel;
    p.vx = approach(p.vx, target, accel * DT);
  } else {
    cap = (p.jetting ? t.jetAirMaxX : t.airMaxX) * speedMul;
    const underCap = Math.abs(p.vx) < cap;
    const steeringAgainst = ix !== 0 && Math.sign(p.vx) !== ix;
    if (ix !== 0 && (underCap || steeringAgainst)) p.vx = approach(p.vx, ix * cap, t.airAccel * DT);
    // bleed impulse excess; blast launches (beyond any lunge or jet speed) bleed slowly so they fly far
    if (Math.abs(p.vx) > cap) p.vx *= simExp(-(Math.abs(p.vx) > t.launchSpeedX ? t.launchDragX : t.airDragX) * DT);
  }
  // melee lunge (docs/02 §12): a 0.12 s burst of +lunge m/s along the facing. The first tick adds
  // it, up to a ceiling of the lunge speed (on top of the cap when running that way), so repeated
  // swings can't stack speed; the rest of the window only holds that speed against decay. It never
  // adds more than `lunge` in total, so a swing trims knockback instead of erasing or reversing it.
  const lunge = lungeSpeed(p);
  if (lunge > 0) {
    const along = p.facing * p.vx;
    const ceiling = (ix === p.facing ? cap : 0) + lunge;
    const held = p.meleeTicks === 1 ? along + lunge : p.facing * vxBefore;
    if (along < ceiling) p.vx = p.facing * Math.max(along, Math.min(ceiling, held));
  }

  // --- 2. jetpack + fuel ---
  const canIgnite = p.fuel >= t.fuelMinIgnite || p.jetting;
  p.jetting = isDown(buttons, Btn.Jet) && canIgnite && p.fuel > 0;
  if (p.jetting) {
    p.jetTicks++;
    // The ignition kick burns fuel at the same multiplier as its thrust, so lift per unit of fuel
    // is constant: rapid tapping (or a macro) can't farm the kick for extra climb per tank.
    const kick = p.jetTicks <= t.jetKickTicks ? t.jetKick : 1;
    let thrust = t.jetThrust * kick;
    const headroom = t.jetMaxVy - p.vy;
    if (headroom < t.jetTaperBand) thrust *= Math.max(0, headroom / t.jetTaperBand);
    p.vy += thrust * DT;
    p.fuel = Math.max(0, p.fuel - t.fuelBurn * kick * DT);
    p.fuelRegenDelay = ticks(t.fuelRegenDelayAir);
    if (p.grounded) {
      p.grounded = false;
      p.vy = Math.max(p.vy, 0);
    }
    // taking off stands you up
    if (p.crouched && !overlaps(world, p.x, p.y, t.standHeight, r, p.y)) p.crouched = false;
  } else {
    p.jetTicks = 0;
    if (p.grounded) p.fuelRegenDelay = Math.min(p.fuelRegenDelay, ticks(t.fuelRegenDelayGround));
    if (p.fuelRegenDelay > 0) p.fuelRegenDelay--;
    else p.fuel = Math.min(t.fuelMax, p.fuel + (p.grounded ? t.fuelRegenGround : t.fuelRegenAir) * DT);
  }

  // --- 3. gravity (not while grounded on walkable ground) ---
  if (!p.grounded) p.vy = Math.max(t.terminalVy, p.vy - t.gravity * DT);
  else p.vy = 0;

  // --- 4. knockback cap ---
  const speed2 = p.vx * p.vx + p.vy * p.vy;
  if (speed2 > t.knockbackCap * t.knockbackCap) {
    const k = t.knockbackCap / Math.sqrt(speed2);
    p.vx *= k;
    p.vy *= k;
  }

  // --- 5. move and slide ---
  if (p.dropTicks > 0) p.dropTicks--;
  oneWay.prevFeetY = p.prevY;
  oneWay.dropping = p.dropTicks > 0;
  const wasGrounded = p.grounded;
  const startX = p.x;
  const startY = p.y;
  const intendedVx = p.vx;
  const res = moveResult;
  res.hitGround = false;
  res.hitWall = false;
  res.hitCeiling = false;
  res.bonked = false;
  moveAndSlide(world, p, t, cosMax, res);

  if (wasGrounded && res.hitWall && Math.abs(intendedVx) > 0.01) {
    tryStepUp(world, p, t, startX, startY, intendedVx, cosMax);
  }

  // --- 6. ground detection / snap (§10.4) ---
  oneWay.prevFeetY = p.prevY;
  oneWay.vy = 0;
  oneWay.dropping = p.dropTicks > 0;
  // "Moving up" needs a real upward speed: clipping a diagonal landing against the floor can leave
  // a floating-point residue like +1e-12 m/s, which must not count as take-off (it kept fast
  // sideways landings airborne forever: no ground friction, no ground fuel regen).
  if (p.vy > UP_EPSILON) {
    p.grounded = false; // jetting up or launched
  } else {
    // walking down slopes/steps stays glued to the ground; falling only lands on contact
    const probe = wasGrounded && !p.jetting ? t.groundSnap : 0.03;
    p.grounded = snapDown(world, p, t, probe, cosMax);
    if (p.grounded) p.vy = 0;
  }

  // airborne crouch → stand when there is room (crouch-walking off a ledge)
  if (!p.grounded && p.crouched && !overlaps(world, p.x, p.y, t.standHeight, r, p.y)) p.crouched = false;
}

/** Quantise movement state at tick end (§15). */
export function quantizeMovement(p: PlayerState): void {
  p.x = quantize(p.x, POS_INV);
  p.y = quantize(p.y, POS_INV);
  p.vx = quantize(p.vx, VEL_INV);
  p.vy = quantize(p.vy, VEL_INV);
  p.fuel = quantize(p.fuel, SCALAR_INV);
  p.hp = quantize(p.hp, SCALAR_INV);
  p.groundNx = quantize(p.groundNx, 65536);
  p.groundNy = quantize(p.groundNy, 65536);
}

/** Pushes a freshly spawned/teleported player out of any overlap (§10 edge cases). */
export function depenetrate(world: CollisionWorld, p: PlayerState, t: Tuning): void {
  const h = p.height(t);
  oneWay.prevFeetY = p.y;
  oneWay.vy = 0;
  oneWay.dropping = false;
  for (let i = 0; i < 8; i++) {
    if (!deepestContact(world, p.x, p.y, h, t.capsuleRadius, oneWay, contact)) return;
    p.x += contact.nx * (contact.depth + SKIN);
    p.y += contact.ny * (contact.depth + SKIN);
  }
}
