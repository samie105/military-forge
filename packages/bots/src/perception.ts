/**
 * What a bot knows about the others: only what a human's client in its place is sent (the server's
 * snapshot rules, docs/05 §9 and NOTES §22.5).
 * - **Sight:** players and items inside the human's view rect (netcode's camera model: width by
 *   zoom, 4:3, the look-ahead toward the aim). It's a side view, so a wall between two players
 *   hides neither (shooting needs a line of fire, which the brain checks). Smoke does hide them:
 *   the sim's `SmokeSight`, as the server's AOI uses it. A flashbang's full white hides everyone
 *   and wipes what it knew; its fade is the aim's business (Aim.impair).
 * - **Hearing:** gunfire from someone it can't see is a SOUND: where on a 4 m grid, within
 *   earshot, never who. A hit names who hurt it, but not where they are (only what it saw or heard
 *   of them).
 * - **Gas:** clouds it has seen (the server sends them by the view rect and their radius).
 * - **Items and mines:** where it saw them (a client gets an item's kind and place, not a dropped
 *   shield's HP; a grenade record for a mine in view and out of smoke). Forgotten once it sees the
 *   spot without them.
 * What it knew about players fades after a few seconds, and a player who left is forgotten at once.
 */
import { MINE, STANDING_HITBOXES, grenades } from '@military-forge/content';
import {
  MAX_CLOUDS,
  MAX_GRENADES,
  MAX_PICKUPS,
  MAX_PLAYERS,
  MineState,
  SegFlag,
  SmokeSight,
  closestPointOnSegment,
  TICK_RATE,
  blindIntensity,
  cloudDef,
  cloudRadius,
  createRayHit,
  type Game,
  type PlayerState,
} from '@military-forge/sim';
import { VIEW_LOOKAHEAD, VIEW_MAX_ASPECT, maxZoomLevels, viewWidth } from '@military-forge/netcode';
import { simCos, simSin } from '@military-forge/shared';

export interface Contact {
  /** we know something about this player */
  known: boolean;
  /** seen at the last look (the brain re-checks its target every tick) */
  visible: boolean;
  /** last known feet position and velocity (a heard position is the 4 m grid's, with no velocity) */
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** tick it was last seen or heard */
  tick: number;
  /** tick the current unbroken sighting began (reaction time counts from here) */
  since: number;
  /** it hurt us recently: the tick of its last hit on us (−1: never) */
  hurtTick: number;
}

/** An item it saw lying somewhere (the slot may have been reused since: compare the position). */
export interface ItemSighting {
  /** tick it was last seen (−1: never, or gone) */
  tick: number;
  def: number;
  x: number;
  y: number;
  /** it stood on this one and it wasn't taken (a shield worse than its own): leave it be */
  refused: boolean;
}

/** A mine it saw stuck somewhere (arming or armed), by grenade slot. */
interface MineSighting {
  known: boolean;
  x: number;
  y: number;
}

/** Gunfire from someone it couldn't see: roughly where, and when (−1: nothing to go on). */
export interface Noise {
  tick: number;
  x: number;
  y: number;
}

/** A gas cloud it has seen, by cloud slot: where it was (a slot that moved is another cloud). */
interface GasSighting {
  known: boolean;
  x: number;
  y: number;
}

/** gunfire is heard this far away (m) */
const EARSHOT = 35;
/** contacts fade after this long without news (s) */
const MEMORY = 6;
/**
 * Gunfire off screen arrives on this grid (m): the SOUND event's (packages/protocol snapshot.ts),
 * so a bot gets the same rounding a client does.
 */
export const SOUND_CELL = 4;

const ray = createRayHit();
const pt = { x: 0, y: 0 };

/** One smoke sight per game, gathered once a tick for all its bots: brains run before anything moves. */
const sights = new WeakMap<Game, { tick: number; sight: SmokeSight }>();
export function smokeSight(game: Game): SmokeSight {
  let s = sights.get(game);
  if (!s) {
    s = { tick: -1, sight: new SmokeSight() };
    sights.set(game, s);
  }
  if (s.tick !== game.tick) {
    s.sight.gather(game);
    s.tick = game.tick;
  }
  return s.sight;
}

function onSoundGrid(v: number): number {
  return Math.round(v / SOUND_CELL) * SOUND_CELL;
}

export class Perception {
  readonly contacts: Contact[] = Array.from({ length: MAX_PLAYERS }, () => ({
    known: false,
    visible: false,
    x: 0,
    y: 0,
    vx: 0,
    vy: 0,
    tick: -1,
    since: -1,
    hurtTick: -1,
  }));
  /** items by pickup slot: where and what it last saw */
  readonly items: ItemSighting[] = Array.from({ length: MAX_PICKUPS }, () => ({ tick: -1, def: 0, x: 0, y: 0, refused: false }));
  /** mines it has seen, by grenade slot (anyone's but its own) */
  readonly mines: MineSighting[] = Array.from({ length: MAX_GRENADES }, () => ({ known: false, x: 0, y: 0 }));
  /** some mine it has seen is still where it saw it, as far as it knows */
  knowsMines = false;
  /** the nearest gunfire it heard last from someone it couldn't see */
  readonly noise: Noise = { tick: -1, x: 0, y: 0 };
  /** gas clouds it has seen, by cloud slot */
  readonly gas: GasSighting[] = Array.from({ length: MAX_CLOUDS }, () => ({ known: false, x: 0, y: 0 }));
  /** fraction of the human view the bot gets (BotLevel.view) */
  viewScale = 1;
  /** how whited out it is now (blindIntensity: 1 = full white, then the fade) */
  blind = 0;
  private halfW = 0;
  private halfH = 0;
  private cx = 0;
  private cy = 0;

  forgetAll(): void {
    for (const c of this.contacts) {
      c.known = false;
      c.visible = false;
      c.hurtTick = -1;
    }
    this.noise.tick = -1;
  }

  /** Some gas cloud it has seen is still about. */
  get knowsGas(): boolean {
    for (const k of this.gas) if (k.known) return true;
    return false;
  }

  /**
   * Last tick's events (still in game.events when the brain runs), every tick: gunfire (seen, or a
   * SOUND), who hit us, who died or respawned. A full white wipes the contacts first.
   */
  hear(game: Game, self: PlayerState): void {
    this.frame(self);
    if (this.blind >= 1) this.whiteOut();
    // a player who left is gone at once (its id may come back as someone else)
    for (let id = 0; id < MAX_PLAYERS; id++) {
      const c = this.contacts[id]!;
      if (game.players[id] || (!c.known && c.hurtTick < 0)) continue;
      c.known = false;
      c.visible = false;
      c.hurtTick = -1;
    }
    const sight = smokeSight(game);
    const tick = game.tick;
    let heard = Infinity;
    for (const e of game.events) {
      if (e.type === 'shot') {
        if (e.shooter === self.id) continue;
        const q = game.players[e.shooter];
        // a shooter on its screen: the tracer shows who and where (it's in sight anyway)
        if (q?.alive && this.sees(sight, self, q)) {
          this.note(q, tick);
          continue;
        }
        // anyone else is a SOUND: roughly where, not who; the nearest one this tick
        const x = onSoundGrid(e.ox);
        const y = onSoundGrid(e.oy);
        const d2 = (x - self.x) * (x - self.x) + (y - self.y) * (y - self.y);
        if (d2 > EARSHOT * EARSHOT || d2 >= heard) continue;
        heard = d2;
        this.noise.tick = tick;
        this.noise.x = x;
        this.noise.y = y;
      } else if (e.type === 'hit') {
        if (e.target !== self.id || e.attacker < 0 || e.attacker === self.id) continue;
        const q = game.players[e.attacker];
        if (!q?.alive) continue;
        const c = this.contacts[q.id]!;
        c.hurtTick = tick;
        // the HIT names who hurt it; where they are is only what it sees, or the SOUND of that shot
        if (this.sees(sight, self, q)) this.note(q, tick);
        else if (this.blind < 1) this.heardAt(game, c, q.id, tick);
      } else if (e.type === 'death' || e.type === 'spawn') {
        const id = e.type === 'death' ? e.victim : e.player;
        const c = this.contacts[id];
        if (c) {
          c.known = false;
          c.visible = false;
        }
      }
    }
  }

  /** A look around (10 Hz): who and what is on its screen and out of smoke; old news fades. */
  look(game: Game, self: PlayerState): void {
    const tick = game.tick;
    this.frame(self);
    // gas clouds even in a full white: a client is sent them by the view rect whatever, and the
    // cough says you're in one
    this.lookForGas(game);
    // full white: nothing else to see (hear() has already wiped the contacts)
    if (this.blind >= 1) return;
    const sight = smokeSight(game);
    for (const q of game.players) {
      if (!q || q === self) continue;
      const c = this.contacts[q.id]!;
      if (q.alive && this.sees(sight, self, q)) {
        if (!c.visible) c.since = tick;
        this.note(q, tick);
        c.visible = true;
      } else {
        c.visible = false;
        if (c.known && (!q.alive || tick - c.tick > MEMORY * 60)) c.known = false;
      }
    }
    if (this.noise.tick >= 0 && tick - this.noise.tick > MEMORY * 60) this.noise.tick = -1;
    for (const k of game.pickups) {
      const seen = this.items[k.id]!;
      if (k.alive && this.inView(k.x, k.y)) {
        // a client is sent its kind and place, nothing more (not a dropped shield's HP)
        if (seen.tick < 0 || seen.def !== k.def || seen.x !== k.x || seen.y !== k.y) seen.refused = false;
        seen.tick = tick;
        seen.def = k.def;
        seen.x = k.x;
        seen.y = k.y;
      }
      // the spot it remembers is on screen now and the item isn't there: gone
      else if (seen.tick >= 0 && this.inView(seen.x, seen.y) && !(k.alive && k.x === seen.x && k.y === seen.y)) seen.tick = -1;
    }
    this.knowsMines = false;
    for (const g of game.grenades) {
      const seen = this.mines[g.id]!;
      // a mine stuck somewhere (arming, armed, beeping), someone else's
      const mine = g.alive && g.owner !== self.id && grenades[g.type]?.effect === 'mine' && g.state !== MineState.Flying;
      if (mine && this.inView(g.x, g.y) && !sight.pointHidden(self.id, g.x, g.y)) {
        seen.known = true;
        seen.x = g.x;
        seen.y = g.y;
      } else if (seen.known && this.inView(seen.x, seen.y) && !sight.pointHidden(self.id, seen.x, seen.y) && !(mine && g.x === seen.x && g.y === seen.y)) {
        seen.known = false;
      }
      if (seen.known) this.knowsMines = true;
    }
  }

  /** Gas clouds in view (the server sends them by the view rect and their radius); one gone is forgotten. */
  private lookForGas(game: Game): void {
    for (const c of game.clouds) {
      const k = this.gas[c.id]!;
      const def = c.alive ? cloudDef(c.type) : null;
      if (!def || def.dpsCore <= 0) k.known = false;
      else if (this.cloudInView(c.x, c.y, def.radius)) {
        k.known = true;
        k.x = c.x;
        k.y = c.y;
      } else if (k.known && (k.x !== c.x || k.y !== c.y)) k.known = false;
    }
  }

  /** Can it see `q` right now: on its screen, not hidden by smoke, not whited out (the brain's target, every tick). */
  canSee(game: Game, self: PlayerState, q: PlayerState): boolean {
    return q.alive && this.sees(smokeSight(game), self, q);
  }

  /** Keeps a player in sight up to date between looks (the brain's target). */
  refresh(q: PlayerState, tick: number): void {
    this.note(q, tick);
  }

  /** On its screen (the view rect as of this tick). */
  inView(x: number, y: number): boolean {
    return Math.abs(x - this.cx) <= this.halfW && Math.abs(y - this.cy) <= this.halfH;
  }

  /**
   * How deep (0…1; 0 = not in it) a body standing at (x, y) (its feet) is in a gas cloud it has
   * seen, the cloud's radius grown by `margin`. The sim's own test (clouds.ts gasPulse): the
   * torso's nearest point to the centre, less the torso's radius, and a wall between that point and
   * the centre keeps it out. Beside a ledge a test from the body's middle can say "out" while the
   * pulses still land. A cloud still growing in counts at its full size (it's there within the
   * second). `out` gets the centre and (grown) radius of the cloud it's deepest in. `walls` false:
   * by distance alone (a way out: a wall's edge can't make one, as a step or two over the pulses land).
   */
  gasAt(game: Game, x: number, y: number, margin: number, out?: { x: number; y: number; r: number }, walls = true): number {
    const torso = STANDING_HITBOXES.torso;
    let worst = 0;
    for (const c of game.clouds) {
      if (!c.alive || !this.gas[c.id]!.known) continue;
      const def = cloudDef(c.type);
      if (!def) continue;
      const r = (c.age < def.grow * TICK_RATE ? def.radius : cloudRadius(def, c.age)) + margin;
      closestPointOnSegment(c.x, c.y, x, y + torso.y0, x, y + torso.y1, pt);
      const dx = pt.x - c.x;
      const dy = pt.y - c.y;
      const reach = Math.sqrt(dx * dx + dy * dy);
      const d = Math.max(0, reach - torso.r);
      if (d >= r) continue;
      if (walls && reach > 1e-6 && game.world.raycast(c.x, c.y, dx / reach, dy / reach, reach, SegFlag.BulletPass, ray)) continue;
      if (1 - d / r <= worst) continue;
      worst = 1 - d / r;
      if (out) {
        out.x = c.x;
        out.y = c.y;
        out.r = r;
      }
    }
    return worst;
  }

  /**
   * A body standing at (x, y) would set off a mine it has seen: within its trigger radius (grown by
   * `margin`) of the body, with nothing solid between (mines.ts's rule).
   */
  mineAt(game: Game, x: number, y: number, margin: number): boolean {
    if (!this.knowsMines) return false;
    const t = game.tuning;
    const r = t.capsuleRadius;
    const reach = MINE.mine.triggerRadius + margin;
    for (const k of this.mines) {
      if (!k.known) continue;
      closestPointOnSegment(k.x, k.y, x, y + r, x, y + t.standHeight - r, pt);
      const dx = pt.x - k.x;
      const dy = pt.y - k.y;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d - r > reach) continue;
      if (d > 1e-6 && game.world.raycast(k.x, k.y, dx / d, dy / d, d, SegFlag.BulletPass, ray)) continue;
      return true;
    }
    return false;
  }

  /** The human camera this tick: centred above the feet, pushed toward the aim; and the white-out. */
  private frame(self: PlayerState): void {
    this.blind = blindIntensity(self);
    this.halfW = (viewWidth(maxZoomLevels(self) - 1) / 2) * this.viewScale;
    this.halfH = this.halfW * VIEW_MAX_ASPECT;
    this.cx = self.x + simCos(self.aim) * this.halfW * VIEW_LOOKAHEAD;
    this.cy = self.y + 0.9 + simSin(self.aim) * this.halfH * VIEW_LOOKAHEAD;
  }

  /** What a client is sent of a player: in its view, not hidden by smoke, and it isn't whited out. */
  private sees(sight: SmokeSight, self: PlayerState, q: PlayerState): boolean {
    return this.blind < 1 && this.inView(q.x, q.y + 0.75) && !sight.hides(self.id, q.id);
  }

  /** A cloud is sent while any of it (its full radius) is in the view rect. */
  private cloudInView(x: number, y: number, r: number): boolean {
    return Math.abs(x - this.cx) <= this.halfW + r && Math.abs(y - this.cy) <= this.halfH + r;
  }

  /** Full white: everyone it knew of is lost (it still knows who hurt it, for when it sees again). */
  private whiteOut(): void {
    for (const c of this.contacts) {
      c.known = false;
      c.visible = false;
    }
  }

  /** Who hit it, placed where that shot's SOUND came from (none: a grenade, gas, a mine, a blow it can't place). */
  private heardAt(game: Game, c: Contact, id: number, tick: number): void {
    for (const e of game.events) {
      if (e.type !== 'shot' || e.shooter !== id) continue;
      if (!c.known) c.since = tick;
      c.known = true;
      c.x = onSoundGrid(e.ox);
      c.y = onSoundGrid(e.oy);
      c.vx = 0;
      c.vy = 0;
      c.tick = tick;
      return;
    }
  }

  private note(q: PlayerState, tick: number): void {
    const c = this.contacts[q.id]!;
    if (!c.known) c.since = tick;
    c.known = true;
    c.x = q.x;
    c.y = q.y;
    c.vx = q.vx;
    c.vy = q.vy;
    c.tick = tick;
  }
}
