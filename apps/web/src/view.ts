/**
 * Render-side view model. Both local mode (in-browser sim) and online mode (server snapshots)
 * produce a Frame; the renderer never touches sim state directly (docs/06 §4, layer L3).
 */
import type { SimEvent } from '@military-forge/sim';

export interface WeaponView {
  def: number;
  mag: number;
  reserve: number;
  reloadTicks: number;
}

export interface PlayerView {
  id: number;
  name: string;
  isBot: boolean;
  isLocal: boolean;
  alive: boolean;
  x: number;
  y: number;
  vx: number;
  vy: number;
  grounded: boolean;
  crouched: boolean;
  jetting: boolean;
  /** radians */
  aim: number;
  hp: number;
  fuel: number;
  /** ticks until fuel starts regenerating (local mode only; online shows −1) */
  fuelRegenDelay: number;
  frags: number;
  active: number;
  dual: boolean;
  weapons: WeaponView[];
  /** melee swing progress (sim PlayerState.meleeTicks): 0 idle, 1 = swing started. Absent for remote players online */
  meleeTicks?: number;
  respawnTicks: number;
  kills: number;
  deaths: number;
}

export interface GrenadeView {
  x: number;
  y: number;
  fuse: number;
}

/** Client-side prediction + clock sync numbers (docs/05 §15.1). */
export interface PredictionStats {
  /** spare ticks of our input the server had queued (NaN before the first report) */
  inputBufferHealth: number;
  /** the pacer's tick-rate multiplier (1 ± 0.03) */
  timeScale: number;
  /** predicted ticks not yet confirmed by a snapshot */
  unackedTicks: number;
  /** reconciliations that moved the local player by > 1 mm, per minute */
  correctionsPerMin: number;
  /** any state mismatch (incl. hp from hits), per minute */
  mispredictionsPerMin: number;
  lastErrorCm: number;
  resyncs: number;
  snapshotLossPct: number;
  rttJitterMs: number;
  /** network conditioner summary, "off" when disabled */
  netSim: string;
  lowBandwidth: boolean;
  /** heavy loss for 5 s: the HUD offers low-bandwidth mode */
  suggestLowBandwidth: boolean;
}

export interface NetStats {
  rttMs: number;
  snapshotsPerSec: number;
  kbInPerSec: number;
  kbOutPerSec: number;
  interpDelayMs: number;
  status: string;
  prediction?: PredictionStats;
}

/** A lag-compensated shot (dev rooms): the poses the server tested, for the rewind visualiser. */
export interface RewindView {
  /** seconds since it arrived */
  age: number;
  /** how far back the server looked */
  rewindMs: number;
  /** the shooter's view was older than the rewind cap */
  clamped: boolean;
  targets: { x: number; y: number; crouched: boolean; nowX: number; nowY: number; hit: boolean }[];
}

export interface Frame {
  tick: number;
  localId: number;
  players: PlayerView[];
  grenades: GrenadeView[];
  net?: NetStats;
  recording?: number;
  /** online + hitboxes on: recent server rewinds of our shots (docs/05 §15.3) */
  rewinds?: RewindView[];
}

export type FrameEventSink = (events: readonly SimEvent[]) => void;
