/**
 * The rooms' state from the game server (apps/game-server/src/roomState.ts): about every 10 s it posts
 * each room's phase, mode, map, people, bots, free slots, time left and who is in it, signed like
 * match results (matches/report.ts `checkReportAuth`, the token's `sub` ROOM_STATE_SUBJECT). Each room
 * is kept in Valkey as `roomstate:{code}` for 30 s: a room that stops beating leaves the Rooms list.
 *
 *   POST /internal/rooms/state   204 · 401 invalid_report_signature · 400 invalid_request
 */
import type { KeyObject } from 'node:crypto';
import { ROOM_MAX_PEOPLE, ROOM_PHASES, ROOM_STATE_TTL_MS, isRoomCode, type RoomStateEntry } from '@military-forge/shared';
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../http/context';
import { ApiError } from '../http/errors';
import type { Kv } from '../kv/kv';
import { checkReportAuth } from '../matches/report';

/** the token's subject for a room-state report (the game server's ROOM_STATE_SUBJECT) */
export const ROOM_STATE_SUBJECT = 'roomstate';

export const roomStateKey = (code: string) => `roomstate:${code}`;

const accountId = z.string().min(1).max(64);

export const RoomStateBody = z.strictObject({
  at: z.number().int().min(0),
  rooms: z
    .array(
      z.strictObject({
        code: z.string().refine(isRoomCode, 'not a room code'),
        phase: z.enum(ROOM_PHASES),
        teams: z.number().int().min(0).max(4),
        map: z.string().min(1).max(64),
        people: z.number().int().min(0).max(ROOM_MAX_PEOPLE),
        bots: z.number().int().min(0).max(ROOM_MAX_PEOPLE),
        seats: z.number().int().min(0).max(ROOM_MAX_PEOPLE),
        timeLeftS: z.number().int().min(0).max(24 * 3600).nullable(),
        hostId: accountId.nullable(),
        ids: z.array(accountId).max(ROOM_MAX_PEOPLE),
      }),
    )
    .max(64),
});

/** A room's state as kept: the game server's entry and when it read it. */
export interface StoredRoomState extends RoomStateEntry {
  at: number;
}

/** Several rooms' state in one round trip, in order (null: no beat in the last 30 s). */
export async function readRoomStates(kv: Kv, codes: readonly string[]): Promise<(StoredRoomState | null)[]> {
  if (!codes.length) return [];
  return (await kv.mget(codes.map(roomStateKey))).map((raw) => {
    if (!raw) return null;
    try {
      return JSON.parse(raw) as StoredRoomState;
    } catch {
      return null;
    }
  });
}

/** Keeps a report's rooms (a report older than what's kept for a room doesn't replace it). */
export async function storeRoomStates(kv: Kv, at: number, rooms: readonly RoomStateEntry[]): Promise<number> {
  const kept = await readRoomStates(
    kv,
    rooms.map((r) => r.code),
  );
  let n = 0;
  for (const [i, r] of rooms.entries()) {
    if ((kept[i]?.at ?? -1) > at) continue;
    const stored: StoredRoomState = { ...r, ids: [...new Set(r.ids)], at };
    await kv.set(roomStateKey(r.code), JSON.stringify(stored), { ttlMs: ROOM_STATE_TTL_MS });
    n++;
  }
  return n;
}

export function roomStateRoutes(deps: { kv: Kv; key: KeyObject; now: () => number }): Hono<AppEnv> {
  const { kv, key, now } = deps;
  const app = new Hono<AppEnv>();
  app.post('/rooms/state', async (c) => {
    const raw = await c.req.text();
    const auth = checkReportAuth(c.req.header('authorization'), raw, key, Math.floor(now() / 1000));
    if (!auth.ok || auth.matchId !== ROOM_STATE_SUBJECT) {
      c.get('log').warn({ reason: auth.ok ? 'wrong_subject' : auth.reason }, 'room state refused');
      throw new ApiError(401, 'invalid_report_signature', `Room state refused: ${auth.ok ? 'wrong_subject' : auth.reason}`);
    }
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      throw new ApiError(400, 'invalid_json', 'Request body is not valid JSON');
    }
    const parsed = RoomStateBody.safeParse(json);
    if (!parsed.success) {
      throw new ApiError(400, 'invalid_request', 'Request body failed validation', { issues: parsed.error.issues.slice(0, 5).map((i) => ({ path: i.path.join('.'), message: i.message })) });
    }
    await storeRoomStates(kv, parsed.data.at, parsed.data.rooms);
    return c.body(null, 204);
  });
  return app;
}
