/**
 * The map-event banner's view model (docs/02 §20.7): what the HUD shows while an event is coming
 * or running. The game loop hands every frame's MapEventView to `shell.setMapEvent`; the store only
 * changes (and React only re-renders) when the banner's text does, at most once a second.
 */
import type { MapEventView } from '../view';

export interface MapEventBanner {
  /** a new occurrence or phase is a new banner (and replays its entrance) */
  key: string;
  title: string;
  line: string;
  phase: 'warning' | 'active';
  /** whole seconds left in the phase */
  seconds: number;
  /** the event's kind (MapEventKind): its colour token and icon (hud/model.ts eventLook) */
  kind: string;
  /** the event def's own colour (EVENT_KINDS), for anything drawn in the world */
  color: string;
}

export function bannerOf(v: MapEventView | null | undefined): MapEventBanner | null {
  if (!v) return null;
  return {
    key: `${v.occurrence}:${v.phase}`,
    title: v.name,
    line: v.description,
    phase: v.phase,
    seconds: Math.max(1, Math.ceil(v.secondsLeft - 1e-9)),
    kind: v.kind,
    color: `#${v.color.toString(16).padStart(6, '0')}`,
  };
}

export function sameBanner(a: MapEventBanner | null, b: MapEventBanner | null): boolean {
  if (!a || !b) return a === b;
  return a.key === b.key && a.seconds === b.seconds && a.title === b.title && a.line === b.line && a.kind === b.kind && a.color === b.color;
}
