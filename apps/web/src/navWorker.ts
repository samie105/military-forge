/**
 * Builds a map's nav graph off the page's thread (navWarm.ts): a tall map's takes seconds on a
 * phone, which on the page would freeze the menus or training's first frame.
 *
 *   page → worker   { mapId, tuning }
 *   worker → page   { mapId, key, data, ms }  (data: NavGraphData, a structured clone)
 */
import { buildNavGraph, navGraphData, navKey } from '@military-forge/bots';
import { createTuning, getMap, type Tuning } from '@military-forge/content';
import { CollisionWorld } from '@military-forge/sim';

const scope = self as unknown as { postMessage(msg: unknown): void; onmessage: ((ev: MessageEvent<{ mapId: string; tuning: Partial<Tuning> }>) => void) | null };

scope.onmessage = (ev) => {
  const { mapId, tuning } = ev.data;
  const map = getMap(mapId);
  const t = createTuning(tuning);
  const t0 = performance.now();
  const graph = buildNavGraph(map, new CollisionWorld(map), t);
  scope.postMessage({ mapId, key: navKey(t), data: navGraphData(graph), ms: performance.now() - t0 });
};
