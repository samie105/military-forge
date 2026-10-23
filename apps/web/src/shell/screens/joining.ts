/**
 * The invite link's name screen says whose room the player is joining (mobile audit P1-3): the code
 * from the name screen's intent, the host's nickname from the API (GET /rooms/:code, no session).
 */
import { useEffect, useState } from 'react';
import { useStore } from 'zustand';
import { useCtl } from '../context';
import type { ShellStore } from '../store';

export interface Joining {
  code: string;
  /** the host's nickname, once the API answers (null: not known) */
  host: string | null;
}

/** The room the name screen leads into, or null when it leads Home. */
export function useJoining(store: ShellStore): Joining | null {
  const ctl = useCtl();
  const screen = useStore(store, (s) => s.screen);
  const code = screen.name === 'name' && screen.then.to === 'join' ? screen.then.code : null;
  const [host, setHost] = useState<{ code: string; host: string | null } | null>(null);
  useEffect(() => {
    if (!code) return undefined;
    let live = true;
    void ctl.peekRoom(code).then((r) => live && setHost(r));
    return () => {
      live = false;
    };
  }, [ctl, code]);
  if (!code) return null;
  return { code, host: host?.code === code ? host.host : null };
}

/** The line above the name field. */
export function joiningLine(j: Joining): string {
  return j.host ? `Joining ${j.host}'s room · ${j.code}` : `Joining room ${j.code}`;
}
