/**
 * The throw arc (docs/02 §14; hold-to-aim is the default, the owner's decision of 18 Oct): while a
 * throw is aimed, the path the selected grenade will take, simulated ahead with the sim's own
 * grenade step on the live game (local play's, or online the predictor's). Nothing in the game
 * changes. Both views draw it from the Frame (render.ts in 2D, render3d's ThrowArc in 3D).
 *
 * Exact for the throw that follows: the thrower is moved one tick on first (Game.step moves players
 * before they throw), the grenade spawns as the sim's throwGrenade spawns it, and stepGrenade steps
 * it, tick by tick on the map event schedule: a private copy of the map's mechanics runs ahead with
 * it, so the path bends where an event starts or ends mid-flight (the views draw that arc amber).
 * Not foreseen: other players in a mine's path (the preview ignores them).
 */
import { grenades, type GrenadeDef } from '@military-forge/content';
import { simCosSin } from '@military-forge/shared';
import {
  DT,
  GrenadeState,
  MapEventPhase,
  MapMechanics,
  MineState,
  PlayerState,
  SegFlag,
  TICK_RATE,
  copyInput,
  createBodyEnv,
  createRayHit,
  stepGrenade,
  stepMovement,
  ticks,
  type Game,
  type SimEvent,
} from '@military-forge/sim';

/** how far ahead the preview runs (docs/02 §14): past every fuse, so the arc ends where it goes off (frag 1.8 s since the owner's longer throws) */
export const ARC_SECONDS = 2;
export const ARC_POINTS = Math.round(ARC_SECONDS * TICK_RATE) + 1;
/** a velocity change beyond gravity's this big in one tick is a touchdown (m/s) */
const TOUCH_DV = 1.5;

/** The arc both views draw (Frame.throwArc). */
export interface ThrowArcView {
  /** xy pairs: the spawn point, then one per sim tick */
  readonly points: Float32Array;
  count: number;
  /** the point where it first comes down (a mine: where it sticks), or −1 */
  land: number;
  /** grenade type (packages/content grenades) */
  type: number;
  /** the path ends where the fuse runs out (it goes off there), not at the preview's horizon */
  detonates: boolean;
  /** a map event starts or ends during the flight: the path bends there (the views draw it amber) */
  changes: boolean;
}

export function throwArcView(): ThrowArcView {
  return { points: new Float32Array(ARC_POINTS * 2), count: 0, land: -1, type: 0, detonates: false, changes: false };
}

const scratch = new GrenadeState(-1);
const next = new PlayerState(-1);
const env = createBodyEnv();
const aim = { x: 0, y: 0 };
const ray = createRayHit();
/** the event schedule's warnings, starts and ends as the preview's mechanics run ahead */
const announced: SimEvent[] = [];
const NOBODY: readonly null[] = [];

/** each game's private copy of its map mechanics, run ahead on the event schedule (none: no mechanics) */
const ahead = new WeakMap<Game, MapMechanics | null>();

function aheadOf(game: Game): MapMechanics | null {
  let mech = ahead.get(game);
  if (mech === undefined) {
    mech = game.mech ? MapMechanics.compile(game.map) : null;
    ahead.set(game, mech);
  }
  return mech;
}

/** what the preview swaps on the live game while it steps (predictThrow) */
type Swapped = { mech: MapMechanics | null; players: readonly unknown[] };

/** Sets the preview's mechanics up for `tick`; true when an event starts or ends on it. */
function eventTick(mech: MapMechanics, seed: number, tick: number): boolean {
  announced.length = 0;
  mech.beginTick(seed, tick, announced);
  for (const e of announced) if (e.type === 'mapEvent' && e.phase !== MapEventPhase.Warning) return true;
  return false;
}

/** What stepMovement reads of a player: every plain field, its input and its weapon slots. */
function copyForStep(dst: PlayerState, src: PlayerState): void {
  const d = dst as unknown as Record<string, unknown>;
  const s = src as unknown as Record<string, unknown>;
  for (const k in s) {
    const v = s[k];
    if (v === null || typeof v !== 'object') d[k] = v;
  }
  copyInput(dst.input, src.input);
  for (let i = 0; i < 2; i++) Object.assign(dst.weapons[i]!, src.weapons[i]!);
}

/**
 * The path grenade `def` would take thrown by `p` on the next tick at `strength` (0..7). The
 * thrower moves one tick first, with the input it holds now; then the grenade spawns in front of
 * its shoulder, clear of walls, at the strength's speed plus its inherited velocity, and the sim's
 * stepGrenade steps a scratch copy: until the fuse (where it goes off), a mine until it sticks, or
 * ARC_SECONDS. Each tick meets the map as the event schedule has it then.
 *
 * The sim steps the live game with the preview's mechanics (and, for a mine, nobody) swapped in,
 * then put back: views made with Object.create(game) would make the live game a prototype, and
 * Game.step then ran at half speed (measured).
 */
export function predictThrow(game: Game, p: PlayerState, def: GrenadeDef, strength: number, out: ThrowArcView): void {
  const mech = aheadOf(game);
  const live = game as unknown as Swapped;
  const liveMech = live.mech;
  const livePlayers = live.players;
  live.mech = mech;
  if (def.effect === 'mine') live.players = NOBODY; // a previewed mine runs into no one (and blows nobody up)
  try {
    fly(game, mech, p, def, strength, out);
  } finally {
    live.mech = liveMech;
    live.players = livePlayers;
  }
}

function fly(game: Game, mech: MapMechanics | null, p: PlayerState, def: GrenadeDef, strength: number, out: ThrowArcView): void {
  const t = game.tuning;
  // the throw's tick: Game.step sets the schedule up, moves the thrower, then the grenade flies
  const tick = game.tick;
  if (mech) eventTick(mech, game.seed, tick);
  copyForStep(next, p);
  stepMovement(game.world, next, t, mech ? mech.bodyEnv(next, t, env) : null);
  const sx = next.shoulderX(t);
  const sy = next.shoulderY(t);
  simCosSin(next.aim, aim);
  const speed = def.throwSpeed * t.grenadeThrowScale * (0.7 + (0.3 * Math.max(0, Math.min(7, strength))) / 7);
  let spawnDist = 0.35;
  if (game.world.raycast(sx, sy, aim.x, aim.y, spawnDist + def.radius, SegFlag.BulletPass, ray)) {
    spawnDist = Math.max(0, ray.t - def.radius - 0.02);
  }
  const mine = def.effect === 'mine';
  const g = scratch;
  g.alive = true;
  g.owner = p.id;
  g.type = def.index;
  g.state = MineState.Flying;
  g.x = sx + aim.x * spawnDist;
  g.y = sy + aim.y * spawnDist;
  g.vx = aim.x * speed + next.vx * def.inheritVelocity;
  g.vy = aim.y * speed + next.vy * def.inheritVelocity;
  // a mine's fuse is its straight flight; anything else must not go off in the preview: it ends
  // where its fuse would run out instead
  const fuse = ticks(def.fuse);
  g.fuse = mine ? fuse : 0x7fffffff;
  const last = mine ? ARC_POINTS - 1 : Math.min(ARC_POINTS - 1, fuse - 1);
  const pts = out.points;
  pts[0] = g.x;
  pts[1] = g.y;
  out.count = 1;
  out.land = -1;
  out.type = def.index;
  out.detonates = !mine && last < ARC_POINTS - 1;
  out.changes = false;
  const fall = t.gravity * def.gravityScale * DT;
  for (let k = 0; k < last && g.alive; k++) {
    // the grenade's first step is on the throw's own tick
    if (mech && k > 0 && eventTick(mech, game.seed, tick + k)) out.changes = true;
    const vx = g.vx;
    const vy = g.vy - fall;
    stepGrenade(game, g);
    pts[out.count * 2] = g.x;
    pts[out.count * 2 + 1] = g.y;
    if (out.land < 0) {
      const dvx = g.vx - vx;
      const dvy = g.vy - vy;
      if (mine ? g.state !== MineState.Flying : dvx * dvx + dvy * dvy > TOUCH_DV * TOUCH_DV) out.land = out.count;
    }
    out.count++;
    if (mine && g.state !== MineState.Flying) break; // stuck: that's where it stays
  }
}

/** The arc for the local player, recomputed each frame while a throw is aimed. */
export class ThrowPreview {
  private readonly view = throwArcView();

  /**
   * The arc for a throw by `me` at `strength` (the sampler's throwAim: −1 when nothing is aimed),
   * with the grenade type it holds selected, or null: not aiming, dead, or none of that type left.
   */
  update(game: Game | null, me: PlayerState | null, strength: number): ThrowArcView | null {
    if (!game || !me || strength < 0 || !me.alive) return null;
    const def = grenades[me.grenadeType];
    if (!def || (me.grenadeCounts[me.grenadeType] ?? 0) <= 0) return null;
    predictThrow(game, me, def, strength, this.view);
    return this.view;
  }
}

// ---------- the dots both views draw ----------

/** metres between dots along the path */
export const ARC_SPACING = 0.42;
/** the dots march along the path at this speed (m/s); still under reduced motion */
export const ARC_MARCH = 0.7;
/** most dots drawn */
export const ARC_DOTS = 48;

/** One dot of the arc: where it is, whether the grenade has come down by then, how faded it is. */
export type ArcDot = (x: number, y: number, after: boolean, fade: number) => void;

/**
 * Walks the arc placing a dot every ARC_SPACING m, the first `phase` m along (the march). Dots
 * fade toward the end of the path; `after`: past where it first comes down (drawn fainter).
 */
export function arcDots(view: ThrowArcView, phase: number, dot: ArcDot): void {
  const { points: pts, count, land } = view;
  let next = ARC_SPACING - phase; // path length to the next dot
  let dots = 0;
  for (let i = 1; i < count && dots < ARC_DOTS; i++) {
    const ax = pts[(i - 1) * 2]!;
    const ay = pts[(i - 1) * 2 + 1]!;
    const dx = pts[i * 2]! - ax;
    const dy = pts[i * 2 + 1]! - ay;
    const seg = Math.sqrt(dx * dx + dy * dy);
    const after = land >= 0 && i > land;
    let along = next;
    while (along <= seg && dots < ARC_DOTS) {
      const k = along / seg;
      dot(ax + dx * k, ay + dy * k, after, 1 - (0.55 * i) / count);
      dots++;
      along += ARC_SPACING;
    }
    next = along - seg;
  }
}
