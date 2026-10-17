/**
 * Map event → view model for the HUD banner and the renderers (docs/02 §20.7). Reads the game's
 * own copy of the schedule (MapMechanics), which runs in local play and in online prediction alike,
 * so no snapshot is needed for the banner and none can be lost.
 */
import { EVENT_KINDS } from '@military-forge/content';
import { TICK_RATE, type Game } from '@military-forge/sim';
import type { MapEventView } from './view';

export function mapEventView(game: Game): MapEventView | null {
  const mech = game.mech;
  const o = mech?.activeEvent;
  if (!mech || !o) return null;
  const e = mech.events[o.event]!;
  const kind = game.map.events!.defs[o.event]!.kind;
  const tick = mech.tick;
  const warning = tick < o.startTick;
  const from = warning ? o.warnTick : o.startTick;
  const to = warning ? o.startTick : o.endTick;
  return {
    id: e.id,
    kind,
    name: e.def.name,
    description: e.def.description,
    phase: warning ? 'warning' : 'active',
    secondsLeft: (to - tick) / TICK_RATE,
    progress: (tick - from) / Math.max(1, to - from),
    color: EVENT_KINDS[kind]?.color ?? 0x8b949e,
    zones: o.zone >= 0 ? [o.zone] : e.zones.slice(),
    occurrence: o.occurrence,
    bulletRangeMul: e.def.bulletRangeMul,
  };
}
