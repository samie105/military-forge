/**
 * The Rooms list's and Online now's data as hooks: each asks the API when it opens, then again every
 * so often while the page is visible, and keeps the last good answer when a refresh fails (the page
 * says so). Plus the one action that outlives the overlay: invite people once our new room is up.
 */
import type { LfgMode, RoomRow } from '@military-forge/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, type Api } from '../shell/api';
import type { ShellStore } from '../shell/store';
import { RoomsApi, type OnlineNow, type OnlinePlayer } from './api';

/** the list refreshes this often while open (the game server's heartbeat is every 10 s) */
export const ROOMS_POLL_MS = 10_000;
/** Online now refreshes this often while open */
export const ONLINE_POLL_MS = 20_000;

const apis = new WeakMap<object, RoomsApi>();
/** One RoomsApi per shell Api. */
export function roomsApi(api: Pick<Api, 'authed'>): RoomsApi {
  if (typeof api !== 'object' || api === null) return new RoomsApi(api);
  let r = apis.get(api);
  if (!r) apis.set(api, (r = new RoomsApi(api)));
  return r;
}

/** What went wrong, in a line a player can act on. */
export function roomsErrorText(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.offline) return "Can't reach the server";
    if (e.code === 'rate_limited') return 'Too many refreshes: wait a moment';
    if (e.code === 'adults_only') return 'Online play is for players 18 and over';
    return e.message;
  }
  return "Can't reach the server";
}

export type LoadStatus = 'loading' | 'ready' | 'error';

export interface Polled<T> {
  data: T | null;
  status: LoadStatus;
  /** the last refresh failed (data, if any, is the last good answer) */
  error: string | null;
  reload(): Promise<void>;
}

/** `load` now and every `everyMs` while the page is visible and `enabled`. */
export function usePolled<T>(load: () => Promise<T>, everyMs: number, enabled = true): Polled<T> {
  const [data, setData] = useState<T | null>(null);
  const [status, setStatus] = useState<LoadStatus>('loading');
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);
  const loadRef = useRef(load);
  loadRef.current = load;
  const reload = useCallback(async () => {
    try {
      const d = await loadRef.current();
      if (!alive.current) return;
      setData(d);
      setStatus('ready');
      setError(null);
    } catch (e) {
      if (!alive.current) return;
      setError(roomsErrorText(e));
      setStatus('error');
    }
  }, []);
  useEffect(() => {
    alive.current = true;
    if (!enabled) return undefined;
    void reload();
    const id = window.setInterval(() => {
      if (document.visibilityState !== 'hidden') void reload();
    }, everyMs);
    return () => {
      alive.current = false;
      window.clearInterval(id);
    };
  }, [enabled, everyMs, reload]);
  return { data, status, error, reload };
}

export function useRoomList(api: RoomsApi, enabled: boolean): Polled<RoomRow[]> {
  const load = useCallback(() => api.list(), [api]);
  return usePolled(load, ROOMS_POLL_MS, enabled);
}

export interface OnlineData {
  now: OnlineNow;
  recent: OnlinePlayer[];
  looking: OnlinePlayer[];
}

export function useOnlineNow(api: RoomsApi, enabled: boolean): Polled<OnlineData> {
  const load = useCallback(async () => {
    const [now, recent, looking] = await Promise.all([api.online(), api.recent(), api.looking()]);
    return { now, recent, looking };
  }, [api]);
  return usePolled(load, ONLINE_POLL_MS, enabled);
}

/** Looking for a match: on (with a mode) or off, applied at once and put back if the API says no. */
export function useLooking(api: RoomsApi, online: Polled<OnlineData>, notify: (line: string) => void) {
  const server = online.data?.now.lfg ?? null;
  const [local, setLocal] = useState<{ on: boolean; mode: LfgMode; until: string | null } | null>(null);
  const state = local ?? { on: server !== null, mode: server?.mode ?? 'any', until: server?.until ?? null };
  useEffect(() => setLocal(null), [server?.until, server?.mode]);
  const set = useCallback(
    async (on: boolean, mode: LfgMode) => {
      const before = local;
      setLocal({ on, mode, until: null });
      try {
        if (on) {
          const s = await api.startLooking(mode);
          setLocal({ on: true, mode: s.mode, until: s.until });
        } else {
          await api.stopLooking();
          setLocal({ on: false, mode, until: null });
        }
        void online.reload();
      } catch (e) {
        setLocal(before);
        notify(e instanceof ApiError && e.code === 'appear_offline' ? e.message : roomsErrorText(e));
      }
    },
    [api, local, notify, online],
  );
  return { ...state, set };
}

/**
 * Invite `players` once our own room's lobby is up (the Rooms screen's Invite for someone looking for
 * a match: we have no room yet, so Create room first). Gives up if we end up anywhere but a room.
 */
export function inviteOnceInRoom(store: ShellStore, invite: (p: { id: string; nickname: string }) => Promise<boolean>, players: readonly { id: string; nickname: string }[], giveUpMs = 60_000): () => void {
  let done = false;
  // Home is where this starts: only leaving the way to the room (after it began) gives up
  let underway = false;
  const finish = () => {
    done = true;
    stop();
    clearTimeout(timer);
  };
  const stop = store.subscribe((s) => {
    if (done) return;
    const on = s.screen.name;
    if (on === 'room' && !s.screen.local && s.screen.code && s.lobby) {
      finish();
      for (const p of players) void invite(p);
    } else if (on === 'finding' || on === 'room' || on === 'name' || on === 'age') underway = true;
    else if (underway) finish();
  });
  const timer = setTimeout(() => {
    if (!done) finish();
  }, giveUpMs);
  return finish;
}
