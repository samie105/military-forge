/**
 * What the game is downloading, for the map loading screen's real progress (docs/design/pen-diff.md
 * N2): files counted through three's loading manager (every GLTF, texture and KTX2 load the 3D view
 * makes goes through it), bytes from the browser's resource timing for /assets/. main.ts attaches it
 * once; the shell reads it. No three import here: main.ts passes the manager in.
 */

/** The part of three's LoadingManager this counts (its item hooks). */
export interface ItemHooks {
  itemStart(url: string): void;
  itemEnd(url: string): void;
  itemError(url: string): void;
}

export interface AssetLoad {
  /** files to load since the mark: those still loading then, and those started after */
  files: number;
  /** of those, the ones done (or failed: they won't come) */
  done: number;
  /** bytes of game art downloaded since the mark (0 when it came from the cache) */
  bytes: number;
}

export interface AssetMark {
  readonly ended: number;
  readonly bytes: number;
}

export class AssetTracker {
  private started = 0;
  private ended = 0;
  private bytes = 0;
  private attached = false;

  /** Counts the manager's items from now on (its own hooks still run), and /assets/ bytes. */
  attach(manager: ItemHooks, observe = typeof PerformanceObserver !== 'undefined'): void {
    if (this.attached) return;
    this.attached = true;
    const { itemStart, itemEnd, itemError } = manager;
    manager.itemStart = (url) => {
      this.started++;
      itemStart.call(manager, url);
    };
    manager.itemEnd = (url) => {
      this.ended++;
      itemEnd.call(manager, url);
    };
    manager.itemError = (url) => {
      // three calls itemError and then itemEnd for a failed load: the end counts it
      itemError.call(manager, url);
    };
    if (!observe) return;
    try {
      new PerformanceObserver((list) => {
        for (const e of list.getEntries() as PerformanceResourceTiming[]) if (e.name.includes('/assets/')) this.addBytes(e.encodedBodySize || e.transferSize || 0);
      }).observe({ type: 'resource', buffered: false });
    } catch {
      // no resource timing: files only
    }
  }

  addBytes(n: number): void {
    this.bytes += Math.max(0, n);
  }

  /** Where loading stands now: what `since` counts from. */
  mark(): AssetMark {
    return { ended: this.ended, bytes: this.bytes };
  }

  since(mark: AssetMark): AssetLoad {
    return { files: this.started - mark.ended, done: this.ended - mark.ended, bytes: this.bytes - mark.bytes };
  }
}

/** The game's one tracker (main.ts attaches it to three's DefaultLoadingManager). */
export const assetLoad = new AssetTracker();
