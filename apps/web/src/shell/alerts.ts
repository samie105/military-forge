/**
 * Why a room didn't work out, in the kit's words (5 · Connection): the API's errors before the game
 * connects, and the game server's close codes after. Pure, so tests can check every case.
 */
import { CloseCode } from '@military-forge/protocol';
import { ApiError } from './api';
import type { AlertInfo, ConnectionView } from './store';

/** "ROOM_FULL · room KMTXRA" */
function codeLine(name: string, room?: string): string {
  return room ? `${name} · room ${room}` : name;
}

/** An API failure while creating or looking up a room (before the game server is involved). */
export function alertFromApiError(e: unknown, room?: string): AlertInfo {
  if (e instanceof ApiError) {
    if (e.code === 'room_not_found')
      return { kind: 'room-not-found', title: 'Room not found', message: 'This room has closed, or the link is wrong. Rooms close when everyone leaves.', code: codeLine('ROOM_NOT_FOUND', room), action: 'rejoin' };
    if (e.code === 'invalid_room_code')
      return { kind: 'room-not-found', title: 'Not a room code', message: 'Room codes are 6 letters, like KMTXRA. Check the link, or ask your friend to send it again.', code: codeLine('INVALID_ROOM_CODE', room), action: null };
    if (e.code === 'rate_limited') {
      const wait = Number(e.extra.retryAfter ?? 60);
      return { kind: 'slow-down', title: 'Too many tries', message: `Wait ${Number.isFinite(wait) ? wait : 60} s, then try again.`, code: 'RATE_LIMITED', action: 'rejoin' };
    }
    if (e.offline)
      return { kind: 'offline', title: "Can't reach the server", message: "The game server isn't answering. It may have stopped: ask whoever sent you the link.", code: codeLine('SERVER_OFFLINE', room), action: 'rejoin' };
    return { kind: 'error', title: 'Something went wrong', message: e.message, code: `${e.code.toUpperCase()} · HTTP ${e.status}`, action: 'rejoin' };
  }
  return { kind: 'error', title: 'Something went wrong', message: (e as Error)?.message ?? String(e), code: 'ERROR', action: 'rejoin' };
}

/** A room connection that ended for good (onlineMode gave up, or the server refused or kicked us). */
export function alertFromConnection(c: Pick<ConnectionView, 'code' | 'detail' | 'attempt' | 'lastPingMs' | 'lossPct'>, room: string): AlertInfo {
  switch (c.code) {
    case CloseCode.VersionMismatch:
      return { kind: 'new-version', title: 'New version available', message: 'The game was updated. Reload to get the latest version, then rejoin with the same link.', code: 'VERSION_MISMATCH', action: 'reload' };
    case CloseCode.RoomFull:
      return { kind: 'room-full', title: 'This room is full', message: 'Every slot is taken. Try again when someone leaves.', code: codeLine('ROOM_FULL', room), action: 'rejoin' };
    case CloseCode.NoRoom:
      return { kind: 'server-full', title: 'Server is full', message: 'The server can’t open another room right now. Wait a few seconds and try again.', code: codeLine('NO_ROOM', room), action: 'rejoin' };
    case CloseCode.RateLimited:
      return { kind: 'server-full', title: 'Too much at once', message: 'Your connection sent more than the server takes at once (or too many tabs joined from here). Rejoin to carry on.', code: codeLine('RATE_LIMITED', room), action: 'rejoin' };
    case CloseCode.BadMessage:
      return { kind: 'error', title: 'Disconnected', message: 'The server couldn’t read what this browser sent. Reload the page, then rejoin.', code: codeLine('BAD_MESSAGE', room), action: 'reload' };
    case CloseCode.DuplicateSession:
      return { kind: 'replaced', title: 'Opened somewhere else', message: 'You joined this room from another tab or window. Carry on there, or rejoin here.', code: codeLine('DUPLICATE_SESSION', room), action: 'rejoin' };
    case CloseCode.TicketInvalid:
      return /closed/.test(c.detail)
        ? { kind: 'room-not-found', title: 'Room not found', message: 'This room has closed. Rooms close when everyone leaves.', code: codeLine('ROOM_NOT_FOUND', room), action: null }
        : { kind: 'refused', title: 'Couldn’t get in', message: c.detail ? `The server said: ${c.detail}.` : 'The server didn’t accept this join. Open the room link again.', code: codeLine('TICKET_INVALID', room), action: 'rejoin' };
    case 1008:
      // the room's door closes a connection that doesn't say hello within 5 s (a very slow link)
      return { kind: 'connection-lost', title: 'Too slow to join', message: 'Your connection took too long to reach the room, so the server let it go. Check your data or Wi-Fi, then rejoin.', code: codeLine('HELLO_TIMEOUT', room), action: 'rejoin' };
    case 1011:
      return { kind: 'error', title: 'Match error', message: 'Something went wrong in this room and it was closed.', code: codeLine('SERVER_ERROR', room), action: 'rejoin' };
    default: {
      const tries = c.attempt > 0 ? ` after ${c.attempt} ${c.attempt === 1 ? 'try' : 'tries'}` : '';
      const last = c.lastPingMs >= 0 ? ` · last ping ${c.lastPingMs} ms, ${Math.round(c.lossPct)}% loss` : '';
      return { kind: 'connection-lost', title: 'Connection lost', message: `We couldn't reach the server${tries}. Check your data or Wi-Fi, then rejoin.`, code: `CONNECTION_LOST${last}`, action: 'rejoin' };
    }
  }
}

/** The kit's icon and tone for each kind of alert. */
export const ALERT_LOOK: Readonly<Record<AlertInfo['kind'], { icon: string; tone: 'warn' | 'bad' | 'info' }>> = {
  'room-full': { icon: 'users', tone: 'warn' },
  'room-not-found': { icon: 'search-x', tone: 'bad' },
  'new-version': { icon: 'download', tone: 'info' },
  'server-full': { icon: 'server', tone: 'warn' },
  'connection-lost': { icon: 'unplug', tone: 'bad' },
  offline: { icon: 'unplug', tone: 'bad' },
  'slow-down': { icon: 'clock', tone: 'warn' },
  replaced: { icon: 'monitor', tone: 'info' },
  refused: { icon: 'lock', tone: 'bad' },
  error: { icon: 'x-octagon', tone: 'bad' },
};
