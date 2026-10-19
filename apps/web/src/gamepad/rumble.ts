/**
 * Rumble (pure, unit-tested): which of a tick's events the local player feels, and how hard. Light for
 * firing, harder for a hit (by its damage), heavy for a death, a blast by how near it went off, and a
 * short kick for a dash. The pad plays the strongest of a tick's (manager.ts), scaled by Settings.
 */
import type { SimEvent } from '@military-forge/sim';

export interface Rumble {
  kind?: 'shot' | 'hit' | 'death' | 'blast' | 'dash';
  /** the low, heavy motor 0..1 */
  strong: number;
  /** the high, light motor 0..1 */
  weak: number;
  ms: number;
}

export const RUMBLE = {
  shot: { kind: 'shot', strong: 0.05, weak: 0.2, ms: 45 },
  dash: { kind: 'dash', strong: 0.15, weak: 0.45, ms: 90 },
  death: { kind: 'death', strong: 0.9, weak: 0.6, ms: 320 },
  /** a blast is felt out to this many of its radii (and at least this far, m) */
  blastReach: 2.5,
  blastMin: 6,
} as const satisfies Record<string, Rumble | number>;

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** The stronger of two (null: none). */
export function strongest(a: Rumble | null, b: Rumble | null): Rumble | null {
  if (!a) return b;
  if (!b) return a;
  return a.strong + a.weak >= b.strong + b.weak ? a : b;
}

/** What the local player (`localId`, standing at `me`) feels from these events, or null. */
export function rumbleFor(events: readonly SimEvent[], localId: number, me: { x: number; y: number } | null): Rumble | null {
  let r: Rumble | null = null;
  for (const e of events) {
    switch (e.type) {
      case 'shot':
        if (e.shooter === localId) r = strongest(r, RUMBLE.shot);
        break;
      case 'hit':
        if (e.target === localId && e.attacker !== localId) {
          const k = clamp01(e.damage / 100);
          r = strongest(r, { kind: 'hit', strong: 0.3 + 0.55 * k, weak: 0.35, ms: Math.round(110 + 90 * k) });
        }
        break;
      case 'death':
        if (e.victim === localId) r = strongest(r, RUMBLE.death);
        break;
      case 'explosion': {
        if (!me) break;
        const reach = Math.max(RUMBLE.blastMin, e.radius * RUMBLE.blastReach);
        const d = Math.hypot(e.x - me.x, e.y - me.y);
        if (d >= reach) break;
        const k = 1 - d / reach;
        r = strongest(r, { kind: 'blast', strong: 0.25 + 0.65 * k, weak: 0.4 * k, ms: Math.round(160 + 160 * k) });
        break;
      }
      case 'dash':
        if (e.player === localId) r = strongest(r, RUMBLE.dash);
        break;
    }
  }
  return r;
}

/** Settings' strength (0..1) on a rumble; null when it rounds to nothing. */
export function scaleRumble(r: Rumble | null, strength: number): Rumble | null {
  if (!r || strength <= 0) return null;
  const strong = clamp01(r.strong * strength);
  const weak = clamp01(r.weak * strength);
  return strong + weak < 0.02 ? null : { ...r, strong, weak };
}
