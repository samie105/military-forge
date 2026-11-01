/**
 * One back stack for the whole app (audit 2 N-18, N-07; audit 1 C-01, C-02, C-43, A-35): every
 * layer the player opens over Home (a room or training, a route like #/locker, an overlay like
 * Settings, the Friends panel) is exactly one browser history entry, and every way of going back
 * agrees on what it closes: the browser's Back (or Android's back gesture, a mouse's back button),
 * Escape, and a controller's B (gamepad/: it calls closeTop()).
 *
 * The rules:
 * - Opening a layer pushes one entry; closing it from the game (Back, Done, ✕, Escape, B) goes back
 *   over that entry. Nothing ever pushes on close (C-02: history grew one per open and close).
 * - The browser's Back closes the top layer only, through the layer's own `popped` (a room's means
 *   "open the pause menu": Back never leaves a match at once, N-07).
 * - The browser's Forward never brings anything back: a closed Settings stays closed, a left room is
 *   never rejoined (it steps straight back).
 * - Closing never goes back past the page's first entry: a layer the page opened on (a deep link,
 *   #/settings/audio, a reload) is closed by rewriting the address, so the game never falls out to
 *   the previous site or about:blank.
 * - Browser history never moves the player into or out of a room: the shell does that (a refresh on
 *   /r/CODE still rejoins: that's the page loading, not history).
 *
 * Each entry carries `{ mf: { n, d, k } }`: n its place in the tab's history (so a jump of several
 * entries is seen as one), d how many layers were open, k the top layer's key. Traversals the game
 * starts itself (history.go) are asynchronous: pushes and rewrites asked for meanwhile wait for them.
 */

/** The bits of the page this needs (tests pass a fake). */
export interface NavWindow {
  readonly history: Pick<History, 'state' | 'pushState' | 'replaceState' | 'go'>;
  readonly location: Pick<Location, 'pathname' | 'search' | 'hash'>;
  addEventListener(type: 'popstate' | 'hashchange', fn: () => void): void;
  removeEventListener(type: 'popstate' | 'hashchange', fn: () => void): void;
  setTimeout(fn: () => void, ms: number): number;
  clearTimeout(id: number): void;
}

/** What one entry of the stack is. */
export interface Layer {
  /** 'play' (a room or training), 'route:locker', 'overlay:settings', 'friends', 'age' … */
  key: string;
  /** the address's #hash while this layer is on top ('' none) */
  hash: string;
  /** the address's path for this layer and everything over it (a room's /r/CODE); default: the one under it */
  path?: string;
  /** the browser's Back took it away (its entry is gone): what that means here. Default: nothing more. */
  popped?(): void;
}

interface Open extends Layer {
  /** the history entry it stands on */
  n: number;
  /** it has an entry of its own (always, today: a deep link opens its layer over the page's first entry) */
  own: boolean;
}

interface EntryTag {
  n: number;
  d: number;
  k: string;
}

/** how long a traversal the game asked for may take before the queue moves on anyway (a browser that sent no popstate) */
const TRAVERSE_TIMEOUT_MS = 600;

/** the stack answering the page's popstate (one per page; the newest) */
let active: NavHistory | null = null;

function tagOf(state: unknown): EntryTag | null {
  const mf = (state as { mf?: unknown } | null)?.mf as Partial<EntryTag> | undefined;
  return mf && typeof mf.n === 'number' && typeof mf.d === 'number' && typeof mf.k === 'string' ? { n: mf.n, d: mf.d, k: mf.k } : null;
}

export class NavHistory {
  private stack: Open[] = [];
  /** the entry the page stands on (its n) */
  private cur = 0;
  /** the first entry of this page (n): never go back past it */
  private first = 0;
  /** the address's path with no layers open: '/' (Home), or a room link the page opened on until it's left */
  private basePath = '/';
  /** a traversal the game started is on its way: the entry it lands on (n), else null */
  private expect: number | null = null;
  private expectTimer = 0;
  private queue: (() => void)[] = [];
  private listeners = new Set<() => void>();
  private readonly onPop = () => active === this && this.popped();
  private readonly onHash = () => active === this && this.hashed();
  /** what a #hash nobody tagged names (a tab's `location.hash = '#/locker'`, a typed address): the app's answer */
  resolve: (hash: string) => Layer | null = () => null;

  constructor(private readonly win: NavWindow) {
    const tag = tagOf(win.history.state);
    this.cur = this.first = tag?.n ?? 0;
    this.basePath = win.location.pathname + win.location.search;
    // the page's first entry: this page's floor, whatever it was before a reload
    this.write('replace', this.currentUrl(), 0, 'base');
    // the newest one answers the page's events (tests make a controller per case)
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- the page's one stack, not an alias
    active = this;
    win.addEventListener('popstate', this.onPop);
    win.addEventListener('hashchange', this.onHash);
  }

  dispose(): void {
    this.win.removeEventListener('popstate', this.onPop);
    this.win.removeEventListener('hashchange', this.onHash);
    this.win.clearTimeout(this.expectTimer);
    if (active === this) active = null;
  }

  /** Called after every change of the open layers (the route the shell shows follows them). */
  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  // ---- reading ----

  /** The open layers' keys, bottom first. */
  keys(): string[] {
    return this.stack.map((l) => l.key);
  }

  top(): Layer | null {
    return this.stack.at(-1) ?? null;
  }

  has(key: string): boolean {
    return this.stack.some((l) => l.key === key);
  }

  /** The route open (the topmost 'route:<id>' layer), null when none. */
  routeId(): string | null {
    for (let i = this.stack.length - 1; i >= 0; i--) if (this.stack[i]!.key.startsWith('route:')) return this.stack[i]!.key.slice(6);
    return null;
  }

  /** The address the page should show now: the top layer's path and hash. */
  url(): string {
    return this.pathAt(this.stack.length) + (this.stack.at(-1)?.hash ?? '');
  }

  // ---- changing (each waits for a traversal on its way) ----

  /** A layer opens over the others: one new entry. Opening one that's open already only rewrites it. */
  push(layer: Layer): void {
    this.run(() => {
      const i = this.stack.findIndex((l) => l.key === layer.key);
      if (i >= 0 && i === this.stack.length - 1) return this.rewriteTop(layer);
      this.cur += 1;
      this.stack.push({ ...layer, n: this.cur, own: true });
      this.write('push', this.url(), this.stack.length, layer.key);
      this.emit();
    });
  }

  /**
   * The top layer becomes `layer` in place (a Settings tab, the creator handing over to the
   * Briefing): no new entry. With nothing open, it opens.
   */
  replaceTop(layer: Layer): void {
    this.run(() => {
      if (this.stack.length === 0) {
        this.cur += 1;
        this.stack.push({ ...layer, n: this.cur, own: true });
        this.write('push', this.url(), 1, layer.key);
        this.emit();
        return;
      }
      this.rewriteTop(layer);
    });
  }

  /** The open layer `key` changes its hash or path in place (a room's link once it has a code). */
  update(key: string, patch: Partial<Pick<Layer, 'hash' | 'path' | 'popped'>>): void {
    this.run(() => {
      const l = this.stack.find((x) => x.key === key);
      if (!l) return;
      Object.assign(l, patch);
      this.fix();
    });
  }

  /**
   * The game closed layer `key` (and anything over it): back over their entries. Nothing of theirs
   * runs (`popped` is the browser's Back only). A layer that isn't open: nothing.
   */
  close(key: string): void {
    this.run(() => {
      let i = -1;
      for (let j = this.stack.length - 1; j >= 0; j--)
        if (this.stack[j]!.key === key) {
          i = j;
          break;
        }
      if (i < 0) return;
      const gone = this.stack.splice(i);
      const owned = gone.filter((l) => l.own).length;
      this.emit();
      if (owned > 0) this.traverse(-owned);
      else this.fix();
    });
  }

  /** The address with nothing open: '/' once a room the page opened on is left. */
  setBasePath(path: string): void {
    this.run(() => {
      if (this.basePath === path) return;
      this.basePath = path;
      this.fix();
    });
  }

  // ---- inside ----

  private pathAt(depth: number): string {
    for (let i = depth - 1; i >= 0; i--) {
      const p = this.stack[i]!.path;
      if (p) return p;
    }
    return this.basePath;
  }

  private currentUrl(): string {
    const loc = this.win.location;
    return loc.pathname + loc.search + (loc.hash ?? '');
  }

  private write(how: 'push' | 'replace', url: string, d: number, k: string): void {
    const state = { mf: { n: this.cur, d, k } };
    try {
      if (how === 'push') this.win.history.pushState(state, '', url);
      else this.win.history.replaceState(state, '', url);
    } catch {
      /* a sandboxed page: the stack still works without the address */
    }
  }

  private rewriteTop(layer: Layer): void {
    const top = this.stack.at(-1)!;
    this.stack[this.stack.length - 1] = { ...layer, n: top.n, own: top.own };
    this.fix(true);
    this.emit();
  }

  /** The address and tag of the entry we stand on, as the stack says (`force`: the key may have changed). */
  private fix(force = false): void {
    const url = this.url();
    const tag = tagOf(this.win.history.state);
    const key = this.stack.at(-1)?.key ?? 'base';
    if (force || url !== this.currentUrl() || !tag || tag.n !== this.cur || tag.d !== this.stack.length || tag.k !== key) this.write('replace', url, this.stack.length, key);
  }

  /** Runs `op` now, or after the traversal on its way. */
  private run(op: () => void): void {
    if (this.expect !== null) this.queue.push(op);
    else op();
  }

  private traverse(delta: number): void {
    // never past this page's first entry
    const from = this.cur;
    const target = Math.max(this.first, from + delta);
    if (target === from) return this.fix();
    this.expect = target;
    this.cur = target;
    this.win.clearTimeout(this.expectTimer);
    this.expectTimer = this.win.setTimeout(() => this.arrived(), TRAVERSE_TIMEOUT_MS);
    try {
      this.win.history.go(target - from);
    } catch {
      this.arrived();
    }
  }

  /** The traversal the game started is done (or timed out): the address as the stack says, then what waited. */
  private arrived(): void {
    this.win.clearTimeout(this.expectTimer);
    this.expect = null;
    this.fix();
    const waiting = this.queue;
    this.queue = [];
    for (const op of waiting) this.run(op);
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }

  /** A #hash set by plain assignment (state null): a new entry nobody tagged. */
  private hashed(): void {
    if (tagOf(this.win.history.state)) return; // popstate has it (or it's ours)
    this.fresh();
  }

  private fresh(): void {
    this.cur += 1;
    const layer = this.resolve(this.win.location.hash);
    if (layer) {
      // a route opened by `location.hash = '#/locker'`: one layer, on the entry the browser made
      this.stack.push({ ...layer, n: this.cur, own: true });
      this.write('replace', this.url(), this.stack.length, layer.key);
    } else this.write('replace', this.currentUrl(), this.stack.length, 'hash'); // an anchor (#about): no layer
    this.emit();
  }

  private popped(): void {
    const tag = tagOf(this.win.history.state);
    if (!tag) {
      if (this.expect === null) this.fresh();
      return;
    }
    if (this.expect !== null) {
      if (tag.n === this.expect) return this.arrived();
      // the player moved again before ours landed: theirs counts, from where ours was going
      this.win.clearTimeout(this.expectTimer);
      this.expect = null;
    }
    const delta = tag.n - this.cur;
    if (delta === 0) return;
    if (delta > 0) {
      // Forward: nothing closed comes back (a left room is never rejoined): straight back
      this.expect = this.cur;
      this.win.clearTimeout(this.expectTimer);
      this.expectTimer = this.win.setTimeout(() => this.arrived(), TRAVERSE_TIMEOUT_MS);
      this.win.history.go(-delta);
      return;
    }
    // Back (one entry or several): the layers on the entries above are gone, top first
    this.cur = tag.n;
    const gone: Open[] = [];
    while (this.stack.length > 0 && this.stack.at(-1)!.own && this.stack.at(-1)!.n > tag.n) gone.push(this.stack.pop()!);
    this.fix();
    // theirs first, while what they were is still on screen (the first-run creator's Back is its Skip)
    for (const l of gone) l.popped?.();
    this.emit();
    const waiting = this.queue;
    this.queue = [];
    for (const op of waiting) this.run(op);
  }
}

// ---- the app's one stack, and the one way back (Escape, a controller's B, the shell's Back) ----

/** What the shell controller does for the module's functions below (one controller per page). */
export interface NavHooks {
  closeTop(): boolean;
  closeRoute(): void;
  openRoute(id: string): void;
  swapRoute(id: string): void;
}

let hooks: NavHooks | null = null;

export function setNavHooks(h: NavHooks | null): void {
  hooks = h;
}

/**
 * Closes the top layer, the way Escape does: an overlay (Settings opened from the pause menu goes back
 * to it), the Friends panel or the invite picker, a route (the first-run creator's is "Skip for now"),
 * the age question (Home); with nothing open in a room or training, the pause menu opens. On Home:
 * nothing (it never leaves the site). True when it did something. A controller's B calls this.
 */
export function closeTop(): boolean {
  return hooks?.closeTop() ?? false;
}

/** Opens the route `id` (#/<id>) over what's there: one entry. */
export function openRoute(id: string): void {
  if (hooks) hooks.openRoute(id);
  else location.hash = `#/${id}`;
}

/**
 * One route hands over to another (the creator to the Briefing, the Store's Wear to the Locker): back to
 * `id` when it's right under this one, else in this one's place. No new entry either way.
 */
export function swapRoute(id: string): void {
  if (hooks) hooks.swapRoute(id);
  else location.hash = `#/${id}`;
}

/** Leaves the open route (store.ts closeRoute). False: no controller (the debug client): the caller clears the hash. */
export function closeRouteByNav(): boolean {
  if (!hooks) return false;
  hooks.closeRoute();
  return true;
}

/** No page (a test without a DOM): a history that remembers its one entry. */
const NO_PAGE = {
  state: null as unknown,
  pushState(state: unknown) {
    NO_PAGE.state = state;
  },
  replaceState(state: unknown) {
    NO_PAGE.state = state;
  },
  go() {},
};

/** The page's own history, read live (tests stub `location`). */
export function pageNav(): NavWindow {
  return {
    get history() {
      return typeof history === 'undefined' ? NO_PAGE : history;
    },
    get location() {
      return typeof location === 'undefined' ? { pathname: '/', search: '', hash: '' } : location;
    },
    addEventListener: (type, fn) => (typeof window === 'undefined' ? undefined : window.addEventListener?.(type, fn)),
    removeEventListener: (type, fn) => (typeof window === 'undefined' ? undefined : window.removeEventListener?.(type, fn)),
    setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms) as unknown as number,
    clearTimeout: (id) => globalThis.clearTimeout(id),
  };
}
