/**
 * The player's loadout (the Locker look and the two guns) saved to their account, so it follows
 * them to every device (apps/api `GET/PUT /me/loadout/0`). This device keeps a copy as an offline
 * cache: the game reads the cache (LocalLoadoutStore, savedGuns()), the Locker writes it and this
 * module carries it to and from the account.
 *
 * - Sign-in (any time the API's signed-in player changes): a change made here while offline is
 *   sent up; otherwise the account's loadout, if it has one, replaces the cache; otherwise this
 *   device's loadout becomes the account's (a player's first device).
 * - A Locker change is saved to the cache at once and sent up a moment later, batched, so a
 *   session of tries is one request. If that fails, the change stays marked and goes up at the
 *   next change or sign-in.
 */
import { DEFAULT_COSMETIC_LOADOUT, DEFAULT_GUN_IDS, DEFAULT_LOADOUT, loadoutGunIndices, sanitizeCosmeticLoadout, weapons, type CosmeticLoadout } from '@military-forge/content';
import { ApiError } from '../shell/api';
import { LocalLoadoutStore, type LoadoutStore } from './loadouts';

type KeyValueStorage = Pick<Storage, 'getItem' | 'setItem'>;

/** What the account stores (apps/api loadouts/validate.ts): guns by weapon id. */
export interface AccountLoadout {
  look: CosmeticLoadout;
  guns: [string, string];
}

/** The calls this module needs from the shell's Api (shell/api.ts). */
export interface LoadoutApi {
  readonly me: { id: string } | null;
  onSignIn(listener: (me: { id: string }) => void): () => void;
  /** the look comes back as the server stored it; it's sanitised before use */
  getLoadout(slot: number): Promise<{ look: unknown; guns: [string, string] } | null>;
  putLoadout(slot: number, loadout: AccountLoadout): Promise<unknown>;
  /** runs `hook` (awaited, briefly) before each room create or join: a just-made change reaches the join ticket */
  beforeRoom?(hook: () => Promise<void>): void;
}

/** The two guns a player spawns with, as weapon indices (the Locker's Guns tab, the Armory's Equip). */
export interface GunStore {
  get(): [number, number];
  set(pair: readonly [number, number]): void;
}

const GUNS_KEY = 'loadout.guns.v1';
const SYNC_KEY = 'loadout.sync.v1';
const SLOT = 0;
const UPLOAD_DELAY_MS = 1500;

function browserStorage(): KeyValueStorage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

const defaultGuns = (): [string, string] => [DEFAULT_GUN_IDS[0], DEFAULT_GUN_IDS[1]];

/** A gun pair as weapon indices, falling back to the default pair for anything unknown, melee or doubled. */
export function gunIndices(guns: readonly [string, string] | null): [number, number] {
  return loadoutGunIndices(guns) ?? [DEFAULT_LOADOUT[0], DEFAULT_LOADOUT[1]];
}

function readJson<T>(storage: KeyValueStorage | null, key: string): T | null {
  try {
    return JSON.parse(storage?.getItem(key) ?? 'null') as T | null;
  } catch {
    return null;
  }
}

function writeJson(storage: KeyValueStorage | null, key: string, value: unknown): void {
  try {
    storage?.setItem(key, JSON.stringify(value));
  } catch {
    /* storage blocked or full: this session only */
  }
}

/** The gun pair saved on this device, by id (null: none). */
export function readGunIds(storage: KeyValueStorage | null = browserStorage()): [string, string] | null {
  const saved = readJson<{ version?: number; guns?: unknown }>(storage, GUNS_KEY);
  return saved?.version === 1 && Array.isArray(saved.guns) && saved.guns.length === 2 && saved.guns.every((g) => typeof g === 'string') ? (saved.guns as [string, string]) : null;
}

/** The guns to spawn with on this device, as weapon indices (the default pair when nothing is saved). */
export function savedGunIndices(storage: KeyValueStorage | null = browserStorage()): [number, number] {
  return gunIndices(readGunIds(storage));
}

function syncState(storage: KeyValueStorage | null): SyncState {
  const s = readJson<{ user?: unknown; dirty?: unknown }>(storage, SYNC_KEY);
  const dirty = Array.isArray(s?.dirty) ? s.dirty.filter((p): p is Part => p === 'look' || p === 'guns') : [];
  return { user: typeof s?.user === 'string' ? s.user : null, dirty };
}

/** Marks a part changed on this device (it goes to the account at the next sync); returns the new state. */
function markChanged(storage: KeyValueStorage | null, part: Part, user: string | null): SyncState {
  const st = syncState(storage);
  const who = user ?? st.user;
  const dirty = st.user === who ? st.dirty : [];
  const next = { user: who, dirty: dirty.includes(part) ? dirty : [...dirty, part] };
  writeJson(storage, SYNC_KEY, next);
  return next;
}

/** Saves a gun pair on this device only (a page without the app's session: the Armory, locker.html); it reaches the account when the app next signs in. */
export function saveGunsHere(pair: readonly [number, number], storage: KeyValueStorage | null = browserStorage()): boolean {
  const ids = pair.map((i) => weapons[i]?.id);
  if (!loadoutGunIndices(ids)) return false;
  writeJson(storage, GUNS_KEY, { version: 1, guns: ids });
  markChanged(storage, 'guns', null);
  return true;
}

/** A GunStore on this device only (see saveGunsHere). */
export function localGunStore(storage: KeyValueStorage | null = browserStorage()): GunStore {
  return { get: () => savedGunIndices(storage), set: (pair) => void saveGunsHere(pair, storage) };
}

type Part = 'look' | 'guns';
interface SyncState {
  /** whose loadout the cache holds (null: never synced) */
  user: string | null;
  /** parts changed on this device and not yet on the account */
  dirty: Part[];
}

export class LoadoutSync {
  private readonly local: LocalLoadoutStore;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running: Promise<void> = Promise.resolve();
  /** the account this page has read (a change is merged onto the account's loadout, never sent blind) */
  private pulledFor: string | null = null;
  /** the Locker's store: cache first, then the account */
  readonly store: LoadoutStore;
  /** the gun pair: cache first, then the account */
  readonly guns: GunStore;
  /** v19: who hears of a new look (the 3D view, the room we're in) */
  private readonly lookListeners = new Set<(look: CosmeticLoadout) => void>();

  constructor(
    private readonly api: LoadoutApi,
    private readonly storage: KeyValueStorage | null = browserStorage(),
    private readonly uploadDelayMs = UPLOAD_DELAY_MS,
  ) {
    this.local = new LocalLoadoutStore(storage);
    const signedIn = () => api.me !== null;
    this.store = {
      get label() {
        return signedIn() ? 'Saved to your account' : 'Saved on this device';
      },
      load: () => this.local.load(),
      save: async (look) => {
        await this.local.save(look);
        this.changed('look');
        this.lookChanged(look);
      },
    };
    this.guns = { get: () => this.savedGunIndices(), set: (pair) => this.saveGuns(pair) };
    // a room's join ticket carries the account's guns: a change made a moment ago goes up first
    api.beforeRoom?.(() => this.flush());
    api.onSignIn(() => void this.sync());
    if (api.me) void this.sync();
  }

  /**
   * v19: `listener` hears every new look: a Locker or creator save, and the account's look replacing
   * this device's at sign-in. Returns the unsubscribe.
   */
  onLook(listener: (look: CosmeticLoadout) => void): () => void {
    this.lookListeners.add(listener);
    return () => this.lookListeners.delete(listener);
  }

  private lookChanged(look: CosmeticLoadout): void {
    for (const l of [...this.lookListeners]) l(look);
  }

  /** The guns to spawn with, as weapon indices (the default pair when nothing is saved). */
  savedGunIndices(): [number, number] {
    return gunIndices(this.readGuns());
  }

  /** Remembers a gun pair (weapon indices) here and on the account. */
  saveGuns(indices: readonly [number, number]): void {
    if (!saveGunsHere(indices, this.storage)) return;
    this.changed('guns');
  }

  /** Sends a pending change now (the page is being hidden, or a test), and waits for any sync under way. */
  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
      void this.sync();
    }
    await this.running;
  }

  private changed(part: Part): void {
    markChanged(this.storage, part, this.api.me?.id ?? null);
    if (!this.api.me) return; // goes up at the next sign-in
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.sync();
    }, this.uploadDelayMs);
  }

  /** One sync at a time: read the account once per page and sign-in, then send what changed here. */
  private sync(): Promise<void> {
    this.running = this.running.then(() => this.syncNow()).catch(() => {});
    return this.running;
  }

  private async syncNow(): Promise<void> {
    const me = this.api.me;
    if (!me) return;
    let st = this.state();
    // changes left by another player on this device are theirs, not this account's
    if (st.user !== null && st.user !== me.id) st = { user: me.id, dirty: [] };
    if (this.pulledFor !== me.id) {
      let remote: Awaited<ReturnType<LoadoutApi['getLoadout']>>;
      try {
        remote = await this.api.getLoadout(SLOT);
      } catch {
        return; // offline: the cache stands, the change stays marked
      }
      if (this.api.me?.id !== me.id) return; // another player signed in meanwhile
      if (remote) {
        // the account wins, except for what was changed here since
        if (!st.dirty.includes('look')) {
          const look = sanitizeCosmeticLoadout(remote.look);
          await this.local.save(look).catch(() => {});
          this.lookChanged(look);
        }
        if (!st.dirty.includes('guns')) this.write(GUNS_KEY, { version: 1, guns: remote.guns });
      } else {
        // the account's first device: what's here becomes the account's
        const here: Part[] = [];
        if (await this.local.load()) here.push('look');
        if (this.readGuns()) here.push('guns');
        st = { user: me.id, dirty: [...new Set([...st.dirty, ...here])] };
      }
      this.pulledFor = me.id;
    }
    this.setState({ user: me.id, dirty: st.dirty });
    if (!st.dirty.length) return;
    const loadout: AccountLoadout = { look: (await this.local.load()) ?? DEFAULT_COSMETIC_LOADOUT, guns: this.readGuns() ?? defaultGuns() };
    try {
      await this.api.putLoadout(SLOT, loadout);
    } catch (e) {
      // a 400: the server refuses this loadout (an id it doesn't know, or not unlocked); retrying
      // won't help, so stop and keep it on this device only. Anything else: try again later.
      if (!(e instanceof ApiError && e.status === 400)) return;
    }
    // only what was sent is clean: a change made during the request goes up next time
    const now = this.state();
    if (now.user === me.id) this.setState({ user: me.id, dirty: now.dirty.filter((p) => !st.dirty.includes(p)) });
  }

  private readGuns(): [string, string] | null {
    return readGunIds(this.storage);
  }

  private state(): SyncState {
    return syncState(this.storage);
  }

  private setState(s: SyncState): void {
    writeJson(this.storage, SYNC_KEY, s);
  }

  private write(key: string, value: unknown): void {
    writeJson(this.storage, key, value);
  }
}
