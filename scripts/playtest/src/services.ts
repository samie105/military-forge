/**
 * How the playtest runs its API and game server so that restarts don't strand players:
 *
 * - Each service is spawned as `node --title=military-forge-playtest-<name> --import tsx <absolute
 *   entry>` with MILITARY_FORGE_PLAYTEST=<name>:<playtest pid> in its environment. `ps` then shows it
 *   by its title alone (military-forge-playtest-api, …-game-server): recognisably the playtest's, and
 *   out of reach of a pattern like "tsx src/index.ts" meant for some dev server.
 * - The room book remembers the room the playtest announced and the rooms the game server has open
 *   (its "[rooms] opened/closed" lines), so a restarted API is handed them (KEEP_ROOMS) and the link
 *   people were sent keeps working.
 */

/** The `--title=` marker for a service ("game server" → military-forge-playtest-game-server). */
export function serviceTitle(name: string): string {
  return `military-forge-playtest-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
}

/** node's arguments for a service: its title marker, tsx, and the entry by absolute path. */
export function serviceArgs(name: string, absoluteEntry: string): string[] {
  if (!absoluteEntry.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(absoluteEntry)) throw new Error(`entry must be absolute: ${absoluteEntry}`);
  return [`--title=${serviceTitle(name)}`, '--import', 'tsx', absoluteEntry];
}

/** The environment marker: which service, under which playtest process. */
export function serviceMarker(name: string, playtestPid: number): Record<string, string> {
  return { MILITARY_FORGE_PLAYTEST: `${serviceTitle(name).slice('military-forge-playtest-'.length)}:${playtestPid}` };
}

/** Rooms the game server can hold at once (its MAX_ROOMS in the playtest). */
export const MAX_KEPT_ROOMS = 24;

/** The room codes a restarted API must keep: the announced room first, then the rooms in play. */
export class RoomBook {
  /** the room in the link the playtest printed ('' = none yet) */
  announced = '';
  private readonly live = new Set<string>();

  /** A line from the game server: "[rooms] opened KQXMZP (2 open)" or "[rooms] closed …". */
  noteGameLine(line: string): void {
    const m = /^\[rooms\] (opened|closed) ([A-Z]{6})\b/.exec(line);
    if (!m) return;
    if (m[1] === 'opened') this.live.add(m[2]!);
    else this.live.delete(m[2]!);
  }

  /** The game server started over: its rooms are gone (they open again as players rejoin). */
  gameRestarted(): void {
    this.live.clear();
  }

  /** KEEP_ROOMS for the API: the announced room and the open ones, at most MAX_KEPT_ROOMS. */
  keepList(): string[] {
    const codes = this.announced ? [this.announced] : [];
    for (const c of this.live) if (c !== this.announced) codes.push(c);
    return codes.slice(0, MAX_KEPT_ROOMS);
  }
}
