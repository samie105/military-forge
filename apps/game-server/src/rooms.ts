/**
 * Rooms by code (docs/07 §5, docs/06 §5.1–5.2): one Room per 6-letter code, opened for the first
 * player the API let in and closed once nobody is connected or waiting to reconnect. One process,
 * one tick loop for every room; a room whose tick throws is closed on its own (its players get
 * close code 1011), the others keep running.
 *
 * WebSocket paths: `/ws/<CODE>`, `/<CODE>` or `?room=<CODE>` name a room; `/` (and `/ws`) is the
 * default room, the old single dev room, unless it is turned off.
 *
 * Every new connection waits at the door until its HELLO (5 s at most). Only then does it get a
 * room, and a room by code is opened only then: with join tickets on (`tickets`, the API's signed
 * tickets, docs/06 §6) a new player needs a valid ticket for that code, and plays under the name
 * the API approved; a resume needs its session token instead. Connections still at the door are
 * capped per IP, per room and overall, so idle sockets can't hold the server's room slots.
 */
import { CONTENT_HASH, CloseCode, MsgType, PROTOCOL_VERSION, decodeMessage, encodeHello, encodePong, type HelloMsg, type Message } from '@military-forge/protocol';
import { isRoomCode } from '@military-forge/shared';
import { createMatchRules, type MatchRules } from '@military-forge/sim';
import { Room, type Client, type ClientConn, type RoomOptions } from './room';
import { TICKET_FAILURE_TEXT, type TicketVerifier } from './tickets';

/** A custom room's starting settings (docs/07 §5.2); the host changes them in the lobby. */
export const CUSTOM_ROOM_RULES: Readonly<MatchRules> = createMatchRules({ timeLimit: 300, killLimit: 20, onNoRematch: 'lobby' });

/** A connection says HELLO within this long or is closed (1008). */
export const HELLO_TIMEOUT_MS = 5000;
/** messages a connection may send before its HELLO (PINGs: the playtest's ping tool measures without joining) */
const MAX_MESSAGES_BEFORE_HELLO = 32;

/** One client connection as a transport sees it: bytes in, and its end. */
export interface Connection {
  receive(bytes: Uint8Array): void;
  /** the transport closed; `resumable` (default true): the player may come back within the reconnect grace */
  closed(resumable?: boolean): void;
}

export interface DoorLimits {
  /** connections without a HELLO yet, in all */
  total: number;
  /** … from one IP address */
  perIp: number;
  /** … asking for one room */
  perRoom: number;
}

export const DEFAULT_DOOR_LIMITS: Readonly<DoorLimits> = { total: 128, perIp: 8, perRoom: 16 };

export interface RoomRegistryOptions {
  /** options for the default (uncoded) room; null = no default room */
  defaultRoom?: RoomOptions | null;
  /** options for every coded room (match rules default to CUSTOM_ROOM_RULES) */
  roomOptions?: RoomOptions;
  /** most coded rooms open at once */
  maxRooms?: number;
  /** a room nobody has used for this long closes (ticks; the last session's reconnect grace runs first) */
  emptyTicks?: number;
  /** join tickets: a new player in a room by code needs a valid one (null = dev: rooms are open) */
  tickets?: TicketVerifier | null;
  /** caps on connections that haven't said HELLO yet */
  door?: Partial<DoorLimits>;
  helloTimeoutMs?: number;
  /** milliseconds, for the HELLO deadline (tests move it) */
  now?: () => number;
  log?: (msg: string) => void;
}

/** Where a WebSocket URL points: the default room (code ''), a room code, or nothing valid (null). */
export function roomCodeFromUrl(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url, 'ws://x');
  } catch {
    return null;
  }
  const query = u.searchParams.get('room');
  const path = u.pathname.replace(/^\/ws(?=\/|$)/, '').replace(/^\/+|\/+$/g, '');
  const raw = query ?? path;
  if (raw === '') return '';
  const code = raw.toUpperCase();
  return isRoomCode(code) ? code : null;
}

/** A connection at the door: no HELLO yet, so no room. */
interface Visitor {
  conn: ClientConn;
  code: string;
  ip: string;
  openedAt: number;
  messages: number;
  /** still counted at the door */
  waiting: boolean;
  /** refused or gone */
  done: boolean;
  /** admitted: where its messages go from now on */
  room: Room | null;
  client: Client | null;
}

export class RoomRegistry {
  /** the default room ('' code), if any */
  readonly defaultRoom: Room | null;
  readonly rooms = new Map<string, Room>();
  private readonly options: RoomOptions;
  private readonly maxRooms: number;
  private readonly emptyTicks: number;
  private readonly emptyFor = new Map<Room, number>();
  private readonly tickets: TicketVerifier | null;
  private readonly door: DoorLimits;
  private readonly helloTimeoutMs: number;
  private readonly now: () => number;
  private readonly log: (msg: string) => void;
  private readonly visitors = new Set<Visitor>();
  private readonly atDoorByIp = new Map<string, number>();
  private readonly atDoorByRoom = new Map<string, number>();
  private seed = 1;
  private ticks = 0;

  constructor(options: RoomRegistryOptions = {}) {
    this.log = options.log ?? (() => {});
    this.defaultRoom = options.defaultRoom === null ? null : new Room({ log: this.log, ...(options.defaultRoom ?? {}) });
    this.options = options.roomOptions ?? {};
    this.maxRooms = options.maxRooms ?? 64;
    this.emptyTicks = options.emptyTicks ?? 10 * 60;
    this.tickets = options.tickets ?? null;
    this.door = { ...DEFAULT_DOOR_LIMITS, ...options.door };
    this.helloTimeoutMs = options.helloTimeoutMs ?? HELLO_TIMEOUT_MS;
    this.now = options.now ?? (() => performance.now());
  }

  /** connections that haven't said HELLO yet */
  get atDoor(): number {
    return this.visitors.size;
  }

  /**
   * A new connection to `url` (path + query) from `ip` ('' or null = unknown). It waits at the door
   * for its HELLO; null when it's refused right away (`conn` is closed already).
   */
  open(url: string, conn: ClientConn, ip: string | null = null): Connection | null {
    const code = roomCodeFromUrl(url);
    if (code === null) return refuse(conn, CloseCode.NoRoom, 'invalid room code');
    if (code === '' && !this.defaultRoom) return refuse(conn, CloseCode.NoRoom, 'no room code');
    const from = ip ?? '';
    if (this.visitors.size >= this.door.total) return refuse(conn, CloseCode.RateLimited, 'server busy: try again in a moment');
    if (from && (this.atDoorByIp.get(from) ?? 0) >= this.door.perIp) return refuse(conn, CloseCode.RateLimited, 'too many connections from your network');
    if ((this.atDoorByRoom.get(code) ?? 0) >= this.door.perRoom) return refuse(conn, CloseCode.RateLimited, 'too many players joining this room at once');

    const v: Visitor = { conn, code, ip: from, openedAt: this.now(), messages: 0, waiting: true, done: false, room: null, client: null };
    this.visitors.add(v);
    bump(this.atDoorByIp, from, 1);
    bump(this.atDoorByRoom, code, 1);
    return {
      receive: (bytes) => {
        if (v.client) v.room!.receive(v.client, bytes);
        else if (!v.done) this.beforeHello(v, bytes);
      },
      closed: (resumable = true) => {
        if (v.client) v.room!.disconnect(v.client, resumable);
        v.done = true;
        this.leaveDoor(v);
      },
    };
  }

  private beforeHello(v: Visitor, bytes: Uint8Array): void {
    if (++v.messages > MAX_MESSAGES_BEFORE_HELLO) return this.turnAway(v, CloseCode.RateLimited, 'rate limited');
    let msg: Message;
    try {
      msg = decodeMessage(bytes);
    } catch {
      return this.turnAway(v, CloseCode.BadMessage, 'malformed message');
    }
    if (msg.type === MsgType.Ping) {
      v.conn.send(encodePong(msg.clientTime, this.roomOf(v.code)?.game.tick ?? 0));
      return;
    }
    // nothing else means anything before HELLO
    if (msg.type === MsgType.Hello) this.hello(v, msg, bytes);
  }

  private hello(v: Visitor, msg: HelloMsg, bytes: Uint8Array): void {
    if (msg.protocolVersion !== PROTOCOL_VERSION || msg.contentHash !== CONTENT_HASH) {
      return this.turnAway(v, CloseCode.VersionMismatch, 'version mismatch: refresh to update');
    }
    let room = this.roomOf(v.code);
    // a player coming back (reconnect, reload) is admitted by its session token
    const resuming = room !== null && msg.resumeToken !== '' && room.hasSession(msg.resumeToken);
    if (!room && this.rooms.size >= this.maxRooms) return this.turnAway(v, CloseCode.NoRoom, 'server full: too many rooms, try again soon');
    let hello = bytes;
    let accountId: string | null = null;
    if (!resuming && v.code !== '' && this.tickets) {
      const verdict = this.tickets.admit(msg.ticket, v.code);
      if (!verdict.ok) {
        this.log(`[rooms] refused a player for ${v.code}: ticket ${verdict.reason}`);
        return this.turnAway(v, CloseCode.TicketInvalid, TICKET_FAILURE_TEXT[verdict.reason]);
      }
      // a new player, under the name the API approved (nickname rules, reserved names)
      hello = encodeHello(verdict.claims.nick, '');
      accountId = verdict.claims.sub;
    }
    room ??= this.openRoom(v.code);
    this.leaveDoor(v);
    v.room = room;
    v.client = room.connect(v.conn);
    v.client.accountId = accountId;
    room.receive(v.client, hello);
  }

  private roomOf(code: string): Room | null {
    return code === '' ? this.defaultRoom : (this.rooms.get(code) ?? null);
  }

  private openRoom(code: string): Room {
    const room = new Room({
      dummies: false,
      dev: false,
      log: this.log,
      ...this.options,
      seed: this.options.seed ?? this.seed++,
      match: this.options.match ?? CUSTOM_ROOM_RULES,
      code,
    });
    this.rooms.set(code, room);
    this.log(`[rooms] opened ${code} (${this.rooms.size} open)`);
    return room;
  }

  private turnAway(v: Visitor, code: number, reason: string): void {
    if (v.done) return;
    v.done = true;
    this.leaveDoor(v);
    v.conn.close(code, reason);
  }

  private leaveDoor(v: Visitor): void {
    if (!v.waiting) return;
    v.waiting = false;
    this.visitors.delete(v);
    bump(this.atDoorByIp, v.ip, -1);
    bump(this.atDoorByRoom, v.code, -1);
  }

  /** Every room, the default one first. */
  *all(): IterableIterator<[string, Room]> {
    if (this.defaultRoom) yield ['', this.defaultRoom];
    yield* this.rooms;
  }

  get humanCount(): number {
    let n = 0;
    for (const [, room] of this.all()) n += room.humanCount;
    return n;
  }

  /** One 60 Hz tick of every room; empty coded rooms close after `emptyTicks`; slow HELLOs are shown out. */
  tick(): void {
    if (++this.ticks % 30 === 0) this.closeSilentVisitors();
    for (const [code, room] of this.all()) {
      try {
        room.tick();
      } catch (e) {
        if (!code) throw e; // the dev room's errors should be loud
        this.log(`[rooms] ${code} crashed and was closed: ${(e as Error).stack ?? e}`);
        this.close(code, 1011, 'match error, returning to the menu');
        continue;
      }
      if (!code) continue;
      if (!room.empty) this.emptyFor.delete(room);
      else {
        const n = (this.emptyFor.get(room) ?? 0) + 1;
        this.emptyFor.set(room, n);
        if (n >= this.emptyTicks) this.close(code, 1001, 'room closed');
      }
    }
  }

  /** Connections that haven't said HELLO in time go (policy violation, 1008). */
  closeSilentVisitors(): void {
    const now = this.now();
    for (const v of [...this.visitors]) {
      if (now - v.openedAt >= this.helloTimeoutMs) this.turnAway(v, 1008, `no HELLO within ${this.helloTimeoutMs / 1000} s`);
    }
  }

  resetRateLimits(): void {
    for (const [, room] of this.all()) room.resetRateLimits();
  }

  close(code: string, closeCode: number, reason: string): void {
    const room = this.rooms.get(code);
    if (!room) return;
    this.rooms.delete(code);
    this.emptyFor.delete(room);
    room.closeAll(closeCode, reason);
    this.log(`[rooms] closed ${code} (${this.rooms.size} open)`);
  }
}

function refuse(conn: ClientConn, code: number, reason: string): null {
  conn.close(code, reason);
  return null;
}

function bump(counts: Map<string, number>, key: string, by: number): void {
  const n = (counts.get(key) ?? 0) + by;
  if (n > 0) counts.set(key, n);
  else counts.delete(key);
}
