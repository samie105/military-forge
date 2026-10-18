/** Restart delays: 1 s, 2 s, 4 s … 30 s; back to 1 s once a run has lasted a minute. */
export class Backoff {
  private attempt = 0;
  private startedAt = 0;

  constructor(
    private readonly baseMs = 1000,
    private readonly maxMs = 30_000,
    private readonly healthyMs = 60_000,
  ) {}

  /** a run began now */
  started(now = Date.now()): void {
    this.startedAt = now;
  }

  /** the delay before the next try, after a run that just ended */
  next(now = Date.now()): number {
    if (now - this.startedAt >= this.healthyMs) this.attempt = 0;
    return Math.min(this.maxMs, this.baseMs * 2 ** this.attempt++);
  }
}
