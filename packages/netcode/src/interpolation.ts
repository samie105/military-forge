/**
 * Remote-entity interpolation (docs/05 §10). The client renders other players between the two
 * snapshots around its render tick; the server's lag compensation (lagComp.ts) rewinds targets with
 * the same arithmetic, so a shot is tested against exactly what the shooter's screen showed.
 */
import type { SnapshotMsg } from '@military-forge/protocol';

/** Larger jumps between two samples are teleports (respawns): show the newer one, don't slide. */
export const TELEPORT_DISTANCE = 3;

/** Render ticks travel as u16 + 1/256 tick; both sides use the quantised value. */
export function quantizeRenderTick(tick: number): number {
  return Math.floor(tick * 256) / 256;
}

/** Position between two samples (linear, or the newer one across a teleport). */
export function lerpPosition(x0: number, y0: number, x1: number, y1: number, alpha: number, out: { x: number; y: number }): void {
  if (Math.abs(x1 - x0) + Math.abs(y1 - y0) > TELEPORT_DISTANCE) {
    out.x = x1;
    out.y = y1;
  } else {
    out.x = x0 + (x1 - x0) * alpha;
    out.y = y0 + (y1 - y0) * alpha;
  }
}

export interface SnapshotBracket {
  a: SnapshotMsg;
  b: SnapshotMsg;
  /** 0 at a, 1 at b; discrete fields come from a below 0.5, from b above */
  alpha: number;
}

/**
 * The snapshots around `renderTick` (newest last in `snapshots`). Past the newest snapshot it holds
 * the newest (no extrapolation). Null when there are none.
 */
export function bracketSnapshots(snapshots: readonly { msg: SnapshotMsg }[], renderTick: number, out: SnapshotBracket): SnapshotBracket | null {
  const newest = snapshots[snapshots.length - 1];
  if (!newest) return null;
  out.a = newest.msg;
  out.b = newest.msg;
  for (let i = snapshots.length - 1; i > 0; i--) {
    const older = snapshots[i - 1]!.msg;
    if (older.serverTick <= renderTick) {
      out.a = older;
      out.b = snapshots[i]!.msg;
      break;
    }
  }
  const span = out.b.serverTick - out.a.serverTick;
  out.alpha = span > 0 ? Math.max(0, Math.min(1, (renderTick - out.a.serverTick) / span)) : 1;
  return out;
}
