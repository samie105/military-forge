/**
 * The play stats' entry points for the rest of the app (no dependencies, so any module can call
 * them, the shell's first chunk included): they do nothing until main.ts starts the play stats.
 */
import type { ErrorKind, Feature } from '@military-forge/shared';

interface Sink {
  feature(f: Feature): void;
  error(e: ErrorKind, where: string): void;
}

let sink: Sink | null = null;

/** metrics/index.ts, once it runs. */
export function setMetricsSink(s: Sink | null): void {
  sink = s;
}

/** A feature was used (each counts once per page load). */
export function metricsFeature(f: Feature): void {
  sink?.feature(f);
}

/** Something failed on this device (an anonymous count). `where`: a route or screen id. */
export function metricsError(e: ErrorKind, where: string): void {
  sink?.error(e, where);
}
