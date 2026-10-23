/**
 * What the minimap may show of the enemy: only what the player has legitimately seen or heard (the
 * owner's "no wallhacks"). Never where an enemy is now unless it's on the player's own screen.
 *
 * - **Seen:** an enemy inside the camera's view this frame: a solid mark where it is.
 * - **Last seen:** one that has left the view (or died, or gone into smoke) leaves a hollow mark
 *   where it was last seen, fading over LAST_SEEN_MS.
 * - **Heard:** gunfire or a blast off screen gives a ring at a coarse spot (a 4 m cell, the same as
 *   the server's SOUND events online), fading over HEARD_MS. A shot from someone on screen is just
 *   seen. In local play every shot is known exactly, so off-screen ones are coarsened here the same
 *   way: the minimap never knows more than an online client does.
 *
 * Pure (no DOM): the minimap feeds it frames, shots and sounds, and draws `marks`.
 */

export interface ViewBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export type MarkKind = 'seen' | 'last' | 'heard';

export interface IntelMark {
  kind: MarkKind;
  x: number;
  y: number;
  /** 1 fresh … 0 gone */
  alpha: number;
  /** the enemy's id for seen and last-seen marks; −1 for a sound */
  id: number;
}

/** how long a last-seen mark lasts (ms) */
export const LAST_SEEN_MS = 5000;
/** how long a heard ring lasts (ms) */
export const HEARD_MS = 3000;
/** heard positions snap to this grid (m): SOUND's cell (packages/protocol snapshot.ts) */
export const HEARD_CELL = 4;
/** at most this many heard rings at once (the oldest go) */
const MAX_HEARD = 12;

interface Remembered {
  x: number;
  y: number;
  at: number;
  /** on screen at `at` */
  inView: boolean;
}

export interface IntelPlayer {
  id: number;
  alive: boolean;
  x: number;
  y: number;
}

const inBox = (v: ViewBox, x: number, y: number) => x >= v.minX && x <= v.maxX && y >= v.minY && y <= v.maxY;
const snap = (v: number) => Math.round(v / HEARD_CELL) * HEARD_CELL;

export class EnemyIntel {
  private readonly enemies = new Map<number, Remembered>();
  private readonly heard: { x: number; y: number; at: number }[] = [];
  private view: ViewBox = { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  /** players who aren't enemies (the local player, teammates, party in team modes) */
  allies: ReadonlySet<number> = new Set();

  /**
   * One frame: `players` is what the client has (a snapshot's AOI, or local play's whole game), and
   * `view` what's on screen. Enemies on screen are seen; the rest only keep their last-seen marks.
   */
  update(players: readonly IntelPlayer[], localId: number, view: ViewBox, now: number): void {
    this.view = view;
    const present = new Set<number>();
    for (const p of players) {
      if (p.id === localId || this.allies.has(p.id)) continue;
      present.add(p.id);
      const known = this.enemies.get(p.id);
      if (p.alive && inBox(view, p.x, p.y)) {
        if (known) {
          known.x = p.x;
          known.y = p.y;
          known.at = now;
          known.inView = true;
        } else this.enemies.set(p.id, { x: p.x, y: p.y, at: now, inView: true });
      } else if (known?.inView) known.inView = false; // left the screen (or died): its last-seen mark starts fading
    }
    // gone from the client's view entirely (out of the AOI, behind smoke): the same
    for (const [id, known] of this.enemies) {
      if (!present.has(id) && known.inView) known.inView = false;
      if (!known.inView && now - known.at > LAST_SEEN_MS) this.enemies.delete(id);
    }
    while (this.heard.length && now - this.heard[0]!.at > HEARD_MS) this.heard.shift();
  }

  /** A shot fired by `shooter` from (x, y): seen if on screen (the frame shows it), else heard at a coarse spot. */
  shot(shooter: number, localId: number, x: number, y: number, now: number): void {
    if (shooter === localId || shooter < 0 || this.allies.has(shooter)) return;
    if (inBox(this.view, x, y)) return;
    this.hear(x, y, now);
  }

  /** Gunfire or a blast off screen (online: a SOUND event, already on its 4 m grid). */
  hear(x: number, y: number, now: number): void {
    const sx = snap(x);
    const sy = snap(y);
    const same = this.heard.find((h) => h.x === sx && h.y === sy);
    if (same) {
      same.at = now;
      // keep the list oldest first
      this.heard.splice(this.heard.indexOf(same), 1);
      this.heard.push(same);
      return;
    }
    this.heard.push({ x: sx, y: sy, at: now });
    if (this.heard.length > MAX_HEARD) this.heard.shift();
  }

  /** What to draw now. */
  marks(now: number, out: IntelMark[] = []): IntelMark[] {
    out.length = 0;
    for (const [id, e] of this.enemies) {
      if (e.inView) out.push({ kind: 'seen', x: e.x, y: e.y, alpha: 1, id });
      else {
        const a = 1 - (now - e.at) / LAST_SEEN_MS;
        if (a > 0) out.push({ kind: 'last', x: e.x, y: e.y, alpha: a, id });
      }
    }
    for (const h of this.heard) {
      const a = 1 - (now - h.at) / HEARD_MS;
      if (a > 0) out.push({ kind: 'heard', x: h.x, y: h.y, alpha: a, id: -1 });
    }
    return out;
  }

  /** A new map or match: forget everything. */
  clear(): void {
    this.enemies.clear();
    this.heard.length = 0;
  }
}
