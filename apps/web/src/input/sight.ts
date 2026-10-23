/**
 * Who the local player can see, for aim assist and auto-fire (input/assist.ts): the sim's sight rule
 * (`lineOfSight` in packages/sim clouds.ts: nothing solid between, fences and see-through platforms
 * don't count, and no opaque smoke) from what a client has, the map and the frame's clouds. Smoke and
 * walls hide an enemy from assist exactly as they hide him from bots.
 */
import { CROUCHED_HITBOXES, STANDING_HITBOXES, type MapDef } from '@military-forge/content';
import { CollisionWorld, SegFlag, createRayHit } from '@military-forge/sim';
import type { AssistTarget } from './assist';

/** A cloud as the frame carries it (view.ts CloudView): its centre and the radius inside which it hides things. */
export interface SightCloud {
  x: number;
  y: number;
  opaque: number;
}

/** A player as the frame carries it (view.ts PlayerView): the fields sight needs. */
export interface SightPlayer {
  id: number;
  alive: boolean;
  x: number;
  y: number;
  crouched?: boolean;
}

/** The points sight lines go to and from, above the feet (m): the head and the middle of the torso (the sim's canSee). */
export function sightPoints(crouched = false): { head: number; torso: number } {
  const box = crouched ? CROUCHED_HITBOXES : STANDING_HITBOXES;
  return { head: box.head.y, torso: (box.torso.y0 + box.torso.y1) / 2 };
}

export class Sight {
  private map: MapDef | null = null;
  private world: CollisionWorld | null = null;
  private readonly hit = createRayHit();

  /** The map being played (the collision world is built once per map). */
  setMap(map: MapDef | null | undefined): void {
    if (!map || map === this.map) return;
    this.map = map;
    try {
      this.world = new CollisionWorld(map);
    } catch {
      this.world = null; // a map that won't compile: walls hide nobody, smoke still does
    }
  }

  /** A clear line from (ax, ay) to (bx, by): no solid wall, no opaque smoke across it. */
  clear(ax: number, ay: number, bx: number, by: number, clouds: readonly SightCloud[] = []): boolean {
    const dx = bx - ax;
    const dy = by - ay;
    const d = Math.hypot(dx, dy);
    if (d > 1e-6 && this.world?.raycast(ax, ay, dx / d, dy / d, d, SegFlag.BulletPass, this.hit)) return false;
    for (const c of clouds) if (c.opaque > 0 && segmentDistance(c.x, c.y, ax, ay, bx, by) < c.opaque) return false;
    return true;
  }

  /**
   * The enemies the local player can see from his eyes (ex, ey), as the sim's canSee decides: a
   * clear line to the head or the middle of the torso. Each target's aim point is the torso when
   * that line is clear, else the head (over a low wall).
   */
  targets(players: readonly SightPlayer[], localId: number, ex: number, ey: number, clouds: readonly SightCloud[] = [], out: AssistTarget[] = []): AssistTarget[] {
    out.length = 0;
    for (const p of players) {
      if (p.id === localId || !p.alive) continue;
      const at = sightPoints(p.crouched);
      if (this.clear(ex, ey, p.x, p.y + at.torso, clouds)) out.push({ id: p.id, x: p.x, y: p.y + at.torso });
      else if (this.clear(ex, ey, p.x, p.y + at.head, clouds)) out.push({ id: p.id, x: p.x, y: p.y + at.head });
    }
    return out;
  }
}

/** Distance from (px, py) to the segment a→b. */
export function segmentDistance(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}
