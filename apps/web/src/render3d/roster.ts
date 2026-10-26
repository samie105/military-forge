/**
 * Which soldier is drawn for which player (the renderer's entity bookkeeping). Characters stream in
 * without blocking the frame (docs/04 §5.2), so a soldier is built asynchronously and attached when
 * it arrives; this class makes sure it lands on the player it was built for.
 *
 * The bug it fixes (team deathmatch on a phone, 26 Oct): the build's callback read the id from the
 * frame's PlayerView, and online those views are pooled (render3d/online.ts reuses one object per
 * slot every frame). A slow build (phone, 4G) finished after its slot had been handed to another
 * player, so the new soldier replaced that player's soldier in the map while the old one stayed in
 * the scene, frozen where it last stood, and the player it was built for kept a pending entry for
 * ever: never drawn, only its health bar. Here everything async is keyed by the id taken when the
 * build starts, and a build that no longer matches its request is thrown away.
 */
import type { PlayerView } from '../view';

export interface RosterSoldier {
  dispose(): void;
}

export interface RosterHooks<T extends RosterSoldier> {
  /** Builds the soldier for player `id` (`view` is only valid during this call: read what you need now). */
  build(id: number, view: PlayerView): Promise<T>;
  /** The soldier is now the player's: put it in the scene. */
  attach(id: number, soldier: T): void;
  /** The soldier leaves (its player left, or clear()): take it out of the scene and free it. */
  detach(id: number, soldier: T): void;
  /** A build failed; it is tried again after `retryMs`. */
  failed?(id: number, err: unknown, retryMs: number): void;
}

export class SoldierRoster<T extends RosterSoldier> {
  /** the drawn soldier of each player */
  readonly live = new Map<number, T>();
  /** builds in flight: player id → the request's token (a newer request or clear() invalidates it) */
  private readonly requests = new Map<number, number>();
  private readonly seen = new Set<number>();
  private nextToken = 1;
  /** after a failed build, wait this long before trying again (doubles, ≤ 30 s) */
  private retryMs = 1000;

  constructor(private readonly hooks: RosterHooks<T>) {}

  /** players whose soldier is being built */
  get pending(): ReadonlySet<number> {
    return new Set(this.requests.keys());
  }

  isPending(id: number): boolean {
    return this.requests.has(id);
  }

  get(id: number): T | undefined {
    return this.live.get(id);
  }

  /**
   * One frame's players: each drawn soldier is updated, missing ones are built, and the soldiers of
   * players no longer in the frame leave. A build for a player who left is dropped when it lands.
   */
  sync(players: readonly PlayerView[], update: (soldier: T, view: PlayerView) => void): void {
    const seen = this.seen;
    seen.clear();
    for (const p of players) {
      const id = p.id;
      seen.add(id);
      const soldier = this.live.get(id);
      if (soldier) update(soldier, p);
      else if (!this.requests.has(id)) this.request(id, p);
    }
    for (const [id, soldier] of this.live) {
      if (seen.has(id)) continue;
      this.live.delete(id);
      this.hooks.detach(id, soldier);
    }
    // gone before its soldier arrived: the build is dropped when it lands (a return starts a fresh one)
    for (const id of this.requests.keys()) if (!seen.has(id)) this.requests.delete(id);
  }

  /** Every soldier leaves and every build in flight is dropped (a level-of-detail change: they are rebuilt). */
  clear(): void {
    for (const [id, soldier] of this.live) this.hooks.detach(id, soldier);
    this.live.clear();
    this.requests.clear();
  }

  private request(id: number, view: PlayerView): void {
    const token = this.nextToken++;
    this.requests.set(id, token);
    let build: Promise<T>;
    try {
      build = this.hooks.build(id, view);
    } catch (err) {
      build = Promise.reject(err);
    }
    build.then(
      (soldier) => {
        if (this.requests.get(id) !== token) {
          soldier.dispose(); // its player left, or the roster was cleared, while it was built
          return;
        }
        this.requests.delete(id);
        this.retryMs = 1000;
        const old = this.live.get(id);
        if (old) this.hooks.detach(id, old); // never two soldiers for one player
        this.live.set(id, soldier);
        this.hooks.attach(id, soldier);
      },
      (err: unknown) => {
        if (this.requests.get(id) !== token) return;
        const wait = this.retryMs;
        this.retryMs = Math.min(30_000, this.retryMs * 2);
        this.hooks.failed?.(id, err, wait);
        setTimeout(() => {
          if (this.requests.get(id) === token) this.requests.delete(id);
        }, wait);
      },
    );
  }
}
