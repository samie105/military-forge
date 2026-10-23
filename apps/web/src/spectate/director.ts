/**
 * Spectating's camera and choices (protocol v20; the owner, 23 Oct: "spectating too will bang").
 * Pure: main.ts feeds it the frame, what the room says (SPECTATE) and this frame's actions
 * (input.ts), and it says where the camera goes and what the HUD shows.
 *
 * Two kinds:
 * - **The death cam** (`death`): a dead player watches its killer until the respawn, and may step to
 *   anyone else (prev / next). The room decides whom its snapshots follow (spectate.deathCam may keep
 *   it on the killer), so the camera goes where SPECTATE's `follow` says.
 * - **Watching** (`watch`): a spectator (no player). It follows a soldier (prev / next, or click
 *   one), or flies free over the map (pan and zoom). Its feed runs a few seconds behind the match,
 *   which the HUD says. "Join next round" asks for a slot ("Jump in now" while one is free).
 */
import { SpectateMode, SpectateQueue, type SpectateMsg, type SpectateQueueId } from '@military-forge/protocol';
import { weapons } from '@military-forge/content';
import type { MapDef } from '@military-forge/content';
import type { Frame, PlayerView } from '../view';

export type SpectateKind = 'off' | 'death' | 'watch';

/** What the player asked for this frame (keys, buttons, touch, the pad: input.ts). */
export interface SpectateActions {
  prev: boolean;
  next: boolean;
  /** free camera on / off (watching only) */
  toggleFree: boolean;
  /** Join next round / Jump in now / leave the queue */
  join: boolean;
  /** held pan, −1..1 each way (keys, the stick) */
  panX: number;
  panY: number;
  /** dragged this frame, metres (a mouse or a finger) */
  dragX: number;
  dragY: number;
  /** zoom steps (+ out, − in): the wheel, a pinch, the triggers */
  zoom: number;
  /** a click or tap on the world: follow the soldier nearest it */
  pick: { x: number; y: number } | null;
  /** a row of the picker: follow this player (−1: none) */
  followId: number;
}

export const NO_ACTIONS: Readonly<SpectateActions> = { prev: false, next: false, toggleFree: false, join: false, panX: 0, panY: 0, dragX: 0, dragY: 0, zoom: 0, pick: null, followId: -1 };

/** What the director needs of the online mode. */
export interface SpectateLink {
  follow(id: number): void;
  play(when: 'now' | 'next' | false): void;
}

/** What the room says (OnlineMode: spectating, spectateState, spectateDelay). */
export interface SpectateRoom {
  spectating: boolean;
  state: SpectateMsg | null;
  /** seconds behind the match (a spectator's) */
  delay: number;
}

/** One row of the picker: who's in the match. */
export interface SpectateRow {
  id: number;
  name: string;
  alive: boolean;
  kills: number;
  deaths: number;
  bot: boolean;
  followed: boolean;
}

/** Where the camera goes and what the HUD shows. */
export interface SpectateView {
  kind: Exclude<SpectateKind, 'off'>;
  /** the soldier watched, −1: none (free camera, or nobody in sight yet) */
  followId: number;
  free: boolean;
  /** the camera's focus, metres */
  x: number;
  y: number;
  /** zoom level (0 closest; camera ZOOM_MULTIPLIERS) */
  zoom: number;
  name: string;
  /** 0..1 */
  hp: number;
  /** "K-47 · 7 kills" */
  line: string;
  /** seconds behind live (watching), 0 for the death cam */
  delay: number;
  /** the room's spectators */
  watching: number;
  queue: SpectateQueueId;
  /** player slots free now */
  slots: number;
  rows: SpectateRow[];
}

/** a followed soldier down this long (s): watching moves on to the next one alive */
export const MOVE_ON_AFTER_S = 2;
/** free camera pan speed at full deflection, view widths a second */
const PAN_SPEED = 28;
/** zoom levels (camera.ts ZOOM_MULTIPLIERS) */
export const ZOOM_LEVELS = 7;
/** zoom a free camera starts at (the widest) and a follow camera (a little out) */
const FREE_ZOOM = ZOOM_LEVELS - 1;
const FOLLOW_ZOOM = 1;
/** a click this close to a soldier (m) follows it */
const PICK_RADIUS = 2.5;

export class SpectateDirector {
  kind: SpectateKind = 'off';
  followId = -1;
  free = false;
  x = 0;
  y = 0;
  zoom = FOLLOW_ZOOM;
  /** how long the followed soldier has been down (watching) */
  private downFor = 0;

  /** Who to watch next in `dir` (+1 / −1) after the current one: the living, by id; others when nobody lives. */
  static cycle(players: readonly PlayerView[], current: number, dir: 1 | -1, exclude = -1): number {
    const pool = players.filter((p) => p.id !== exclude);
    const alive = pool.filter((p) => p.alive);
    const list = (alive.length > 0 ? alive : pool).map((p) => p.id).sort((a, b) => a - b);
    if (list.length === 0) return -1;
    const at = list.indexOf(current);
    if (at < 0) return dir > 0 ? (list.find((id) => id > current) ?? list[0]!) : ([...list].reverse().find((id) => id < current) ?? list[list.length - 1]!);
    return list[(at + dir + list.length) % list.length]!;
  }

  /**
   * One frame. Returns null when there's nothing to watch (alive and playing): the camera follows
   * the player as usual then.
   */
  update(frame: Frame, room: SpectateRoom, link: SpectateLink, act: Readonly<SpectateActions>, dt: number, map: MapDef, camera: { x: number; y: number; viewWidth: number }): SpectateView | null {
    const me = frame.players.find((p) => p.id === frame.localId) ?? null;
    const st = room.state;
    const kind: SpectateKind = room.spectating ? 'watch' : me && !me.alive && st?.mode === SpectateMode.Dead ? 'death' : 'off';
    if (kind !== this.kind) this.enter(kind, camera);
    if (kind === 'off') return null;

    const others = frame.players.filter((p) => p.id !== frame.localId);
    if (kind === 'death') {
      // the room decides whom it follows (the admin's death-cam rule); prev / next ask it
      if (act.prev || act.next) {
        const want = SpectateDirector.cycle(others, st?.follow ?? -1, act.next ? 1 : -1);
        if (want >= 0) link.follow(want);
      }
      this.followId = st?.follow ?? -1;
      this.free = false;
      this.zoom = 0; // the room sends what the followed player's camera can show, no wider
    } else {
      if (act.toggleFree) {
        this.free = !this.free;
        if (this.free) {
          this.x = camera.x;
          this.y = camera.y;
          this.zoom = FREE_ZOOM;
        } else this.zoom = FOLLOW_ZOOM;
      }
      if (act.pick) {
        let best: PlayerView | null = null;
        let bestD = PICK_RADIUS;
        for (const p of others) {
          const d = Math.hypot(p.x - act.pick.x, p.y + 0.9 - act.pick.y);
          if (d < bestD) [best, bestD] = [p, d];
        }
        if (best) {
          this.setFollow(best.id, link);
          this.free = false;
          this.zoom = FOLLOW_ZOOM;
        }
      }
      if (act.followId >= 0 && others.some((p) => p.id === act.followId)) {
        this.setFollow(act.followId, link);
        this.free = false;
        this.zoom = FOLLOW_ZOOM;
      }
      if (act.prev || act.next) {
        this.setFollow(SpectateDirector.cycle(others, this.followId, act.next ? 1 : -1), link);
        if (this.free) {
          this.free = false;
          this.zoom = FOLLOW_ZOOM;
        }
      }
      const followed = others.find((p) => p.id === this.followId);
      // nobody yet, or the one watched left, or has been down a while: the next one alive
      this.downFor = followed && !followed.alive ? this.downFor + dt : 0;
      if (!this.free && (!followed || this.downFor >= MOVE_ON_AFTER_S)) {
        const next = SpectateDirector.cycle(others, this.followId, 1);
        if (next !== this.followId) this.setFollow(next, link);
        this.downFor = 0;
      }
      if (act.join) {
        const q = st?.queue ?? SpectateQueue.Watching;
        link.play(q !== SpectateQueue.Watching ? false : (st?.slots ?? 0) > 0 ? 'now' : 'next');
      }
      this.zoom = Math.max(0, Math.min(ZOOM_LEVELS - 1, this.zoom + act.zoom));
      if (this.free) {
        this.x += act.panX * PAN_SPEED * dt * (camera.viewWidth / 36) + act.dragX;
        this.y += act.panY * PAN_SPEED * dt * (camera.viewWidth / 36) + act.dragY;
        const b = map.bounds;
        this.x = Math.max(b.minX, Math.min(b.maxX, this.x));
        this.y = Math.max(b.minY, Math.min(b.maxY, this.y));
      }
    }

    const target = this.free ? null : (frame.players.find((p) => p.id === this.followId) ?? null);
    if (target) {
      this.x = target.x;
      this.y = target.y;
    } else if (!this.free && me) {
      this.x = me.x;
      this.y = me.y;
    }
    const w = target ? weapons[target.weapons[target.active]?.def ?? -1] : undefined;
    const rows: SpectateRow[] = others
      .map((p) => ({ id: p.id, name: p.name, alive: p.alive, kills: p.kills ?? 0, deaths: p.deaths ?? 0, bot: p.isBot, followed: !this.free && p.id === this.followId }))
      .sort((a, b) => b.kills - a.kills || a.deaths - b.deaths || a.id - b.id);
    return {
      kind,
      followId: target ? target.id : -1,
      free: this.free,
      x: this.x,
      y: this.y,
      zoom: this.zoom,
      name: target ? target.name : this.free ? 'Free camera' : '',
      hp: target ? Math.max(0, Math.min(1, target.hp / 100)) : 0,
      line: target ? [w?.name, `${target.kills ?? 0} ${target.kills === 1 ? 'kill' : 'kills'}`].filter(Boolean).join(' · ') : '',
      delay: kind === 'watch' ? room.delay : 0,
      watching: st?.spectators.length ?? 0,
      queue: st?.queue ?? SpectateQueue.Watching,
      slots: st?.slots ?? 0,
      rows,
    };
  }

  private setFollow(id: number, link: SpectateLink): void {
    if (id === this.followId) return;
    this.followId = id;
    this.downFor = 0;
    if (id >= 0) link.follow(id);
  }

  private enter(kind: SpectateKind, camera: { x: number; y: number }): void {
    this.kind = kind;
    this.followId = -1;
    this.free = false;
    this.downFor = 0;
    this.zoom = kind === 'watch' ? FOLLOW_ZOOM : 0;
    this.x = camera.x;
    this.y = camera.y;
  }
}
