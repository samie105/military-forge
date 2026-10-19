/**
 * Presence (apps/api presence.ts, docs/07 §7): while the page is visible and a player is signed
 * in, tell the API "here" every 30 s, with the room code when in an online match; the API forgets a
 * player 60 s after the last beat. Hidden pages stop beating (they fade out by themselves); a page
 * going away says so at once. Failures are ignored: presence is a hint, never in the way of play.
 */
export interface PresenceApi {
  readonly me: { id: string } | null;
  onSignIn(listener: (me: { id: string }) => void): () => void;
  beatPresence(room: string | null): Promise<void>;
  clearPresence(): Promise<void>;
}

export const PRESENCE_BEAT_MS = 30_000;

export class PresenceBeat {
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastRoom: string | null = null;

  constructor(
    private readonly api: PresenceApi,
    private readonly room: () => string | null,
    private readonly doc: Pick<Document, 'visibilityState' | 'addEventListener'> = document,
    win: Pick<Window, 'addEventListener'> = window,
    private readonly everyMs = PRESENCE_BEAT_MS,
  ) {
    api.onSignIn(() => this.update());
    doc.addEventListener('visibilitychange', () => this.update());
    win.addEventListener('pagehide', () => {
      if (this.api.me) void this.api.clearPresence().catch(() => {});
    });
    this.update();
  }

  /** Beat now if anything changed (a room joined or left), and keep beating while it makes sense. */
  update(): void {
    const on = this.api.me !== null && this.doc.visibilityState === 'visible';
    if (!on) {
      if (this.timer) clearInterval(this.timer);
      this.timer = null;
      return;
    }
    if (!this.timer) {
      this.timer = setInterval(() => this.beat(), this.everyMs);
      this.beat();
    } else if (this.room() !== this.lastRoom) this.beat();
  }

  private beat(): void {
    this.lastRoom = this.room();
    void this.api.beatPresence(this.lastRoom).catch(() => {});
  }
}
