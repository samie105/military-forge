/**
 * The rooms' heartbeat (the Rooms list, 1 Nov 2026): about every 10 s the game server tells the API
 * how each room by code is doing (its phase, mode, map, people and bots apart, free slots, time left,
 * and who is in it), at `POST /internal/rooms/state`, signed with the same key and token as match
 * results (results.ts `signReport`: the token's `sub` is ROOM_STATE_SUBJECT and it carries the body's
 * SHA-256). The API keeps each room's state for 30 s, so a room that stops beating (closed, the server
 * gone) leaves the list by itself. A beat that fails is not retried: the next one replaces it.
 *
 * Nothing on the wire to the players changes. The body stays under the API's 16 KB limit: rooms go in
 * batches of ROOMS_PER_BEAT.
 */
import type { KeyObject } from 'node:crypto';
import { ROOM_STATE_EVERY_MS, type RoomStateEntry, type RoomStateReport } from '@military-forge/shared';
import { signReport } from './results';
import type { Room } from './room';

/** The token's subject: a room-state token never passes for a match's (whose subject is its uuid). */
export const ROOM_STATE_SUBJECT = 'roomstate';
/** rooms per POST (each is ~350 bytes with 8 account ids: well under the API's 16 KB body limit) */
export const ROOMS_PER_BEAT = 24;

/** The rooms by code worth listing now: match rooms with someone playing in them. */
export function roomStates(rooms: Iterable<[string, Room]>): RoomStateEntry[] {
  const out: RoomStateEntry[] = [];
  for (const [code, room] of rooms) {
    if (!code) continue; // the dev room has no code: nobody can join it from a list
    const l = room.listing();
    if (l && l.people > 0) out.push({ code, ...l });
  }
  return out;
}

export class RoomStateReporter {
  private timer: ReturnType<typeof setInterval> | null = null;
  /** the last beat failed: said once, not every 10 s */
  private failing = false;

  constructor(
    private readonly apiUrl: string,
    private readonly key: KeyObject,
    private readonly rooms: () => Iterable<[string, Room]>,
    private readonly log: (line: string) => void = console.log,
    private readonly fetchImpl: typeof fetch = (...a) => fetch(...a),
    private readonly now: () => number = Date.now,
  ) {}

  start(everyMs = ROOM_STATE_EVERY_MS): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.beat(), everyMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** The signed request bodies for the rooms now (an empty list too: the API then knows there are none). */
  bodies(): string[] {
    const all = roomStates(this.rooms());
    const at = this.now();
    const out: string[] = [];
    for (let i = 0; i === 0 || i < all.length; i += ROOMS_PER_BEAT) {
      const report: RoomStateReport = { at, rooms: all.slice(i, i + ROOMS_PER_BEAT) };
      out.push(JSON.stringify(report));
    }
    return out;
  }

  /** One beat: every room's state, posted (a failure is logged when it starts and when it ends, and dropped). */
  async beat(): Promise<void> {
    let problem: string | null = null;
    for (const body of this.bodies()) {
      try {
        const res = await this.fetchImpl(`${this.apiUrl}/internal/rooms/state`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `GameServer ${signReport(body, ROOM_STATE_SUBJECT, this.key)}` },
          body,
          signal: AbortSignal.timeout(5_000),
        });
        if (!res.ok) problem ??= `the API refused it: ${res.status}`;
      } catch (e) {
        problem ??= (e as Error).message;
      }
    }
    if (problem && !this.failing) this.log(`[rooms] the rooms' state didn't reach the API (${problem}); the Rooms list shows them again once it does`);
    else if (!problem && this.failing) this.log(`[rooms] the rooms' state reaches the API again`);
    this.failing = problem !== null;
  }
}
