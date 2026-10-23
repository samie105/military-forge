/**
 * Local play's bots need the map's nav graph, and a big map's takes a while to build: ~0.3 s for
 * the Street Market on a desktop, 2–6× that for a tall map, and a phone is several times slower
 * again (NOTES §48). Built at once when training starts, that is a frozen first frame. So the app
 * builds it while the player is still in the menus: in a worker (navWorker.ts), off the page's
 * thread, then hands it to the bots' cache (provideNavGraph), and training finds it ready. Where
 * there are no workers, it builds in idle slices of a few milliseconds instead (the same steps a
 * server runs between its ticks). If training starts first, its bots finish the build there.
 */
import { navGraphFromData, navKey, provideNavGraph, readyNavGraph, requestNavGraph, workNavBuilds, type NavGraphData } from '@military-forge/bots';
import { createTuning, type MapDef, type Tuning } from '@military-forge/content';
import { CollisionWorld } from '@military-forge/sim';

/** the most of one idle slice the fallback build may take (ms) */
export const SLICE_MS = 6;

export interface WarmResult {
  /** 'worker' | 'idle' | 'ready' (it was built already) */
  how: 'worker' | 'idle' | 'ready';
  /** from asking to having it (ms) */
  wallMs: number;
  /** the build's own time: the worker's, or the page's slices summed (ms) */
  workMs: number;
  /** the page's longest stretch of work for it (ms): rebuilding the worker's graph, or the longest slice */
  longestMs: number;
  slices: number;
}

type Idle = (cb: (deadline: { timeRemaining(): number }) => void, opts?: { timeout: number }) => number;

/** Builds the map's graph for this tuning (local play's: the defaults) off the page's thread when it can. */
export function warmNavGraph(map: MapDef, tuning: Partial<Tuning> = {}, now: () => number = () => performance.now(), useWorker = typeof Worker !== 'undefined'): Promise<WarmResult> {
  const t = createTuning(tuning);
  const start = now();
  if (readyNavGraph(map, t)) return Promise.resolve({ how: 'ready', wallMs: 0, workMs: 0, longestMs: 0, slices: 0 });
  if (useWorker) {
    return new Promise((resolve) => {
      let worker: Worker;
      try {
        worker = new Worker(new URL('./navWorker.ts', import.meta.url), { type: 'module' });
      } catch {
        resolve(warmInSlices(map, t, now, start));
        return;
      }
      worker.onmessage = (ev: MessageEvent<{ key: string; data: NavGraphData; ms: number }>) => {
        worker.terminate();
        const t0 = now();
        // training may have built it meanwhile; else this is it
        if (!readyNavGraph(map, t) && ev.data.key === navKey(t)) provideNavGraph(map, t, navGraphFromData(map, new CollisionWorld(map), ev.data.data));
        const took = now() - t0;
        resolve({ how: 'worker', wallMs: now() - start, workMs: ev.data.ms, longestMs: took, slices: 1 });
      };
      worker.onerror = () => {
        worker.terminate();
        resolve(warmInSlices(map, t, now, start));
      };
      worker.postMessage({ mapId: map.id, tuning });
    });
  }
  return warmInSlices(map, t, now, start);
}

function warmInSlices(map: MapDef, t: Tuning, now: () => number, start: number): Promise<WarmResult> {
  if (requestNavGraph(map, new CollisionWorld(map), t)) return Promise.resolve({ how: 'ready', wallMs: 0, workMs: 0, longestMs: 0, slices: 0 });
  const idle: Idle =
    (globalThis as { requestIdleCallback?: Idle }).requestIdleCallback ?? ((cb) => setTimeout(() => cb({ timeRemaining: () => SLICE_MS }), 16) as unknown as number);
  let workMs = 0;
  let slices = 0;
  let longestMs = 0;
  return new Promise((resolve) => {
    const slice = (deadline: { timeRemaining(): number }) => {
      const t0 = now();
      const budget = Math.max(1, Math.min(SLICE_MS, deadline.timeRemaining()));
      const more = workNavBuilds(() => now() - t0 >= budget);
      const took = now() - t0;
      workMs += took;
      longestMs = Math.max(longestMs, took);
      slices++;
      if (more) idle(slice, { timeout: 100 });
      else resolve({ how: 'idle', wallMs: now() - start, workMs, slices, longestMs });
    };
    idle(slice, { timeout: 100 });
  });
}
