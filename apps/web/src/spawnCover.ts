/**
 * Spawn cover as an online client sees it (audit B-10). The server's sim runs it (packages/sim
 * GameOptions.spawnCover) and the snapshots don't carry it (no wire change), so the client follows
 * the events every client gets: a player's 'spawn' starts it for SPAWN_COVER.seconds (the admin's
 * value reaches clients through OVERRIDES), and their own shot, throw or launch, or their death, ends
 * it. Training reads the sim's own PlayerState.coverTicks instead.
 */
import { SPAWN_COVER } from '@military-forge/content';
import type { SimEvent } from '@military-forge/sim';

export class SpawnCoverWatch {
  /** seconds of cover left, by player id */
  private readonly left = new Map<number, number>();

  onEvents(events: readonly SimEvent[]): void {
    for (const e of events) {
      switch (e.type) {
        case 'spawn':
          if (SPAWN_COVER.seconds > 0) this.left.set(e.player, SPAWN_COVER.seconds);
          break;
        case 'shot':
          this.left.delete(e.shooter);
          break;
        case 'throw':
        case 'launch':
          this.left.delete(e.owner);
          break;
        case 'death':
          this.left.delete(e.victim);
          break;
        default:
          break;
      }
    }
  }

  /** Time passes (each drawn frame). */
  advance(dt: number): void {
    for (const [id, s] of this.left) {
      if (s - dt <= 0) this.left.delete(id);
      else this.left.set(id, s - dt);
    }
  }

  has(id: number): boolean {
    return this.left.has(id);
  }

  clear(): void {
    this.left.clear();
  }
}
