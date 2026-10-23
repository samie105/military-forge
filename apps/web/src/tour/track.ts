/**
 * One match as the tour and Next orders count it (docs/design/onboarding-research.md §5, §6.1): the
 * local player's kills, deaths by cause and the moves they used, from the sim events every mode
 * already reports. Pure apart from the clock it is handed, so tests drive it with fake events.
 */
import { pickups } from '@military-forge/content';
import { DamageSource, type SimEvent } from '@military-forge/sim';
import type { DeathCause, Move } from './log';

const PICKUP_KIND = new Map(pickups.map((p) => [p.index, p.kind]));

/** Why the local player died: the damage source, or their own doing. */
export function deathCause(e: { victim: number; killer: number; source: number }): DeathCause {
  if (e.source === DamageSource.Gas) return 'gas';
  if (e.source === DamageSource.World) return 'fall';
  if (e.killer === e.victim) return 'self';
  if (e.source === DamageSource.Mine) return 'mine';
  if (e.source === DamageSource.Grenade) return 'grenade';
  if (e.source === DamageSource.Melee) return 'melee';
  return 'gun';
}

export interface MatchSummary {
  online: boolean;
  bots: string | null;
  kills: number;
  deaths: Partial<Record<DeathCause, number>>;
  moves: Move[];
  /** seconds from begin() to the first kill, null = none */
  firstKillAt: number | null;
}

export class MatchTracker {
  private running = false;
  private online = false;
  private bots: string | null = null;
  private startedAt = 0;
  private kills = 0;
  private deaths: Partial<Record<DeathCause, number>> = {};
  private moves = new Set<Move>();
  private firstKillAt: number | null = null;
  /** the first kill of this match, once, for the caller to log */
  onFirstKill: ((secondsIntoMatch: number) => void) | null = null;

  constructor(private readonly now: () => number = () => performance.now()) {}

  get active(): boolean {
    return this.running;
  }

  begin(online: boolean, bots: string | null): void {
    this.running = true;
    this.online = online;
    this.bots = bots;
    this.startedAt = this.now();
    this.kills = 0;
    this.deaths = {};
    this.moves = new Set();
    this.firstKillAt = null;
  }

  /** the local player's doings in a batch of sim events (ignored between matches) */
  onEvents(events: readonly SimEvent[], localId: number): void {
    if (!this.running || localId < 0) return;
    for (const e of events) {
      switch (e.type) {
        case 'death':
          if (e.victim === localId) {
            const c = deathCause(e);
            this.deaths[c] = (this.deaths[c] ?? 0) + 1;
          } else if (e.killer === localId) {
            this.kills++;
            if (this.firstKillAt === null) {
              this.firstKillAt = (this.now() - this.startedAt) / 1000;
              this.onFirstKill?.(this.firstKillAt);
            }
          }
          break;
        case 'dash':
          if (e.player === localId) this.moves.add('dash');
          break;
        case 'throw':
          if (e.owner === localId) this.moves.add('grenade');
          break;
        case 'hit':
          if (e.attacker === localId && e.source === DamageSource.Melee) this.moves.add('melee');
          break;
        case 'pickup':
          if (e.player === localId && PICKUP_KIND.get(e.item) === 'weapon') this.moves.add('take');
          break;
        default:
          break;
      }
    }
  }

  /** a move the sim doesn't report as an event (swap, shield, zoom, an aimed throw), from the input side */
  used(move: Move): void {
    if (this.running) this.moves.add(move);
  }

  /** the match is over (or left); null when none was running */
  end(): MatchSummary | null {
    if (!this.running) return null;
    this.running = false;
    return { online: this.online, bots: this.bots, kills: this.kills, deaths: { ...this.deaths }, moves: [...this.moves], firstKillAt: this.firstKillAt };
  }
}
