/**
 * The onboarding's memory (docs/design/onboarding-research.md, phase 1): on-device facts
 * (`mf.facts.v1`) and the event log (`mf.log.v1`), fed by the shell's store and the sim events every
 * mode reports. The tour, the hints and Next orders (later phases) read and write through this.
 * `?tourlog` shows the log and the First flight funnel on the page (tour/readout.ts).
 */
import { MatchPhase, type SimEvent } from '@military-forge/sim';
import type { ShellState, ShellStore } from '../shell/store';
import { FactStore, daysBetween, type FactEvent, type Facts } from './facts';
import { EventLog, type Device, type Move, type TourLogEvent } from './log';
import { MatchTracker, type MatchSummary } from './track';

export type { Facts, FactEvent } from './facts';
export type { Device, Move, Persona, TourLogEvent } from './log';

export interface TourMemory {
  readonly log: EventLog;
  readonly facts: FactStore;
  /** the last match played to its end (or left), for the Debrief on Results */
  readonly lastMatch: MatchSummary | null;
  /** the sim events of every frame (GameRenderer.onEvents) */
  onEvents(events: readonly SimEvent[], localId: number): void;
  /** the device the player is using now (detected; a pad from its first button) */
  setDevice(device: Device): void;
  /** a move the sim doesn't report (swap, shield, zoom, an aimed throw) */
  used(move: Move): void;
  record(e: TourLogEvent): void;
  fact(e: FactEvent): Facts;
  dispose(): void;
}

type KeyValue = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

const ENDED = new Set<number>([MatchPhase.Ending, MatchPhase.Postgame, MatchPhase.Closed]);

export interface TourMemoryOptions {
  store: ShellStore;
  storage: KeyValue | null;
  /** arrived by an invite link (/r/CODE) */
  invited?: boolean;
  now?: () => number;
  clock?: () => number;
}

export function startTourMemory(o: TourMemoryOptions): TourMemory {
  const now = o.now ?? Date.now;
  const clock = o.clock ?? (() => performance.now());
  const log = new EventLog(o.storage, now);
  const facts = new FactStore(o.storage, now);
  const tracker = new MatchTracker(clock);

  // a session: days since the first one (D1/D7 on the device)
  log.record({ t: 'session.start', days: daysBetween(facts.get().firstSeen, now()) });
  facts.apply({ k: 'session', at: now() });
  if (o.invited) facts.apply({ k: 'invited' });

  tracker.onFirstKill = (secondsIntoMatch) => {
    // the first kill ever on this device
    if (facts.get().kills > 0) return;
    const hit = o.store.getState().titleHit;
    log.record({ t: 'first.kill', sinceTitle: hit ? Math.round((clock() - hit) / 100) / 10 : null, sinceMatch: Math.round(secondsIntoMatch * 10) / 10 });
  };

  let lastMatch: MatchSummary | null = null;
  const finish = (s: ShellState, finished: boolean) => {
    const sum = tracker.end();
    if (!sum) return;
    lastMatch = sum; // before the facts change: the Debrief re-renders on them
    const results = s.match?.results;
    const me = results?.standings.find((r) => r.id === s.match?.localId && !r.left);
    const won = finished && !!me && me.key === results?.winnerKey;
    log.record({ t: 'match.end', online: sum.online, bots: sum.bots, kills: sum.kills, deaths: sum.deaths, moves: sum.moves });
    facts.apply({ k: 'match', online: sum.online, finished, won, kills: sum.kills, deaths: sum.deaths, moves: sum.moves });
  };

  let last: ShellState = o.store.getState();
  const stop = o.store.subscribe((s) => {
    const prev = last;
    last = s;
    // a match: from GO to the end (or leaving before it)
    const phase = s.match?.phase;
    const was = prev.match?.phase;
    const playing = s.screen.name === 'room' || s.screen.name === 'training';
    if (phase === MatchPhase.InProgress && was !== MatchPhase.InProgress && !tracker.active) {
      const online = s.screen.name === 'room';
      tracker.begin(online, online ? (s.lobby ? (s.lobby.bots > 0 ? s.lobby.botLevel : null) : null) : 'normal');
    }
    if (tracker.active && phase !== undefined && ENDED.has(phase)) finish(s, true);
    else if (tracker.active && (!playing || !s.match)) finish(s, false);
    // rooms: made, joined, or local (the screen the API's 'finding' step leads to)
    if (s.screen.name === 'room' && prev.screen.name !== 'room') {
      if (s.screen.local) facts.apply({ k: 'room', how: 'local' });
      else facts.apply({ k: 'room', how: prev.screen.name === 'finding' && prev.screen.creating ? 'created' : 'joined' });
    }
    // screens visited: the routes (Locker, Creator, Armory) and the Settings tabs
    if (s.route && s.route !== prev.route) facts.apply({ k: 'screen', screen: s.route.id });
    if (s.overlay === 'settings' && (prev.overlay !== 'settings' || s.settingsTab !== prev.settingsTab)) facts.apply({ k: 'screen', screen: `settings:${s.settingsTab}` });
  });

  return {
    log,
    facts,
    get lastMatch() {
      return lastMatch;
    },
    onEvents: (events, localId) => tracker.onEvents(events, localId),
    setDevice: (device) => {
      if (facts.get().lastDevice !== device) facts.apply({ k: 'device', device });
    },
    used: (move) => tracker.used(move),
    record: (e) => log.record(e),
    fact: (e) => facts.apply(e),
    dispose: stop,
  };
}
