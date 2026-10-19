/**
 * Render-side view model. Both local mode (in-browser sim) and online mode (server snapshots)
 * produce a Frame; the renderer never touches sim state directly (docs/06 §4, layer L3).
 */
import { createBodyEnv, shieldRaised, type Game, type PlayerState, type SimEvent } from '@military-forge/sim';
import type { ThrowArcView } from './throwPreview';

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
  /** the selected grenade type and the belt, by type (local player; absent for remote players online) */
  grenadeType?: number;
  grenadeCounts?: readonly number[];
  /** flashbang white-out 0…1 (sim blindIntensity) and the ticks left of it */
  blind?: number;
  blindTicks?: number;
  /** ticks left of the gas cough (sim gasTicks) */
  gasTicks?: number;
  /** ticks the jetpack stays dead after an EMP */
  jetDisabledTicks?: number;
  /** on fire (the flamethrower's burn: sim burnTicks; remote players by their snapshot flag) */
  burning?: boolean;
  /** the gun in hand winding up: a minigun spinning, a Ripper or Pulse charging (a tell; its sound when there is audio) */
  windup?: boolean;
  active: number;
  dual: boolean;
  weapons: WeaponView[];
  /** melee swing progress (sim PlayerState.meleeTicks): 0 idle, 1 = swing started. Absent for remote players online */
  meleeTicks?: number;
  /** in a dash burst (docs/02 §21): pose and streak. The 'dash' event carries its start and direction */
  dashing?: boolean;
  /**
   * Riot shield: absent = none; 'front' = up, guarding the front; 'back' = slung, guarding the
   * back; 'raising' = on its way up (0.25 s), guarding neither side
   */
  shield?: 'front' | 'back' | 'raising';
  /** the riot shield's HP left (local player, and every player in local mode) */
  shieldHp?: number;
  /** the local player: the jetpack (and so the dash) is dead here, an EMP zone or storm (map mechanics) */
  jetDisabled?: boolean;
  /** the local player: ticks left drawing the gun swapped to, or going in or out of dual (sim swapTicks; 0 = ready) */
  swapTicks?: number;
  respawnTicks: number;
  kills: number;
  deaths: number;
}

export interface GrenadeView {
  x: number;
  y: number;
  fuse: number;
  /** grenade type (packages/content grenades); absent = frag */
  type?: number;
  /** a mine's state (sim MineState); a projectile: 1 once it has bounced */
  state?: number;
  id?: number;
  /** m/s (projectiles point along it: a rocket, a blade's travel) */
  vx?: number;
  vy?: number;
}

/** A smoke or gas cloud (sim clouds.ts), sized by the sim's own functions. */
export interface CloudView {
  id: number;
  /** grenade type that made it (packages/content grenades) */
  type: number;
  x: number;
  y: number;
  /** current radius (m) and opacity 0…1 */
  radius: number;
  density: number;
  /** radius inside which it hides things (0 = see-through: gas, or thinned-out smoke) */
  opaque: number;
  /** seconds since it popped */
  age: number;
}

/** An item lying on the map: `def` is its PickupDef.index (@military-forge/content pickups). */
export interface PickupView {
  id: number;
  def: number;
  /** the point it rests on */
  x: number;
  y: number;
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
  /** the transport in use: WebTransport (QUIC datagrams) or WebSocket; unset before one is open */
  transport?: 'wt' | 'ws';
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

/**
 * The map event under way (docs/02 §20.7), from the local game or, online, the predicted one: the
 * same schedule the sim runs, so the banner flips on exactly the tick the physics do.
 */
export interface MapEventView {
  id: string;
  /** MapEventKind: picks the look */
  kind: string;
  name: string;
  description: string;
  /** the warning ("incoming") or the event itself */
  phase: 'warning' | 'active';
  /** seconds left in that phase */
  secondsLeft: number;
  /** 0 → 1 through that phase */
  progress: number;
  /** 0xRRGGBB (EVENT_KINDS) */
  color: number;
  /** its event zones that are (or, in the warning, will be) on: indices into map.zones */
  zones: number[];
  /** counts occurrences: a new one is a new banner */
  occurrence: number;
  /** the event's map-wide bullet range multiplier (fog: below 1) */
  bulletRangeMul: number;
}

export interface Frame {
  tick: number;
  localId: number;
  players: PlayerView[];
  grenades: GrenadeView[];
  /** the map event being announced or running (maps with events only) */
  mapEvent?: MapEventView | null;
  /** items on the map (riot shields…) */
  pickups?: PickupView[];
  /** smoke and gas clouds (absent: none) */
  clouds?: CloudView[];
  /** the local player's throw arc while a grenade throw is aimed (throwPreview.ts; absent: none) */
  throwArc?: ThrowArcView | null;
  net?: NetStats;
  recording?: number;
  /** online + hitboxes on: recent server rewinds of our shots (docs/05 §15.3) */
  rewinds?: RewindView[];
  /**
   * The same on every client in a match, and one more for the next match: the room's seed plus the
   * match number. The billboards' house art turns with it (render3d/ads); absent = 0.
   */
  matchSeed?: number;
}

export type FrameEventSink = (events: readonly SimEvent[]) => void;

const statusEnv = createBodyEnv();

/** The local player's movement state for the HUD: the swap timer and the map's EMP (the dash reads the fuel: docs/02 §21). */
export function mobilityView(game: Pick<Game, 'mech' | 'tuning'>, p: PlayerState): Pick<PlayerView, 'jetDisabled' | 'swapTicks'> {
  return {
    swapTicks: p.swapTicks,
    jetDisabled: game.mech ? game.mech.bodyEnv(p, game.tuning, statusEnv).jetDisabled : false,
  };
}

/** How a player carries its riot shield (PlayerView.shield). */
export function shieldView(p: PlayerState): PlayerView['shield'] {
  if (p.shieldHp <= 0) return undefined;
  return shieldRaised(p) ? 'front' : p.shieldTicks > 0 ? 'raising' : 'back';
}
