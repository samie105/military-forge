/**
 * Presence (apps/api presence.ts, docs/07 §7): while the page is visible and a player is signed
 * in, tell the API "here" every 30 s, with the room code when in an online match; the API forgets a
 * player 60 s after the last beat. Hidden pages stop beating (they fade out by themselves); a page
 * going away says so at once. Failures are ignored: presence is a hint, never in the way of play.
 *
 * In a room it also says whether the match is on (audit C-27: a host waiting in the lobby showed to
 * friends as "In a match"), and beats at once when that changes.
 */
import { MatchPhase } from '@military-forge/sim';

export interface PresenceApi {
  readonly me: { id: string } | null;
  onSignIn(listener: (me: { id: string }) => void): () => void;
  beatPresence(room: string | null, playing?: boolean): Promise<void>;
  clearPresence(): Promise<void>;
}

export const PRESENCE_BEAT_MS = 30_000;

/** A match is on (the countdown to the scoreboard); the lobby, the rematch vote and no match are not. */
export function matchOn(phase: number | null | undefined): boolean {
  return phase === MatchPhase.Countdown || phase === MatchPhase.InProgress || phase === MatchPhase.Ending;
}

/** Whether the room's match is on, and where to hear that it may have changed (main.ts: the shell's store). */
export interface PlayingSource {
  playing(): boolean;
  subscribe(listener: () => void): () => void;
}

export class PresenceBeat {
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastRoom: string | null = null;
  private lastPlaying = false;

  constructor(
    private readonly api: PresenceApi,
    private readonly room: () => string | null,
    private readonly doc: Pick<Document, 'visibilityState' | 'addEventListener'> = document,
    win: Pick<Window, 'addEventListener'> = window,
    private readonly everyMs = PRESENCE_BEAT_MS,
    private readonly match: PlayingSource | null = null,
  ) {
    api.onSignIn(() => this.update());
    match?.subscribe(() => this.update());
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
    } else if (this.room() !== this.lastRoom || (this.lastRoom !== null && this.playing() !== this.lastPlaying)) this.beat();
  }

  private playing(): boolean {
    return this.match?.playing() ?? false;
  }

  private beat(): void {
    this.lastRoom = this.room();
    this.lastPlaying = this.playing();
    if (this.match && this.lastRoom) void this.api.beatPresence(this.lastRoom, this.lastPlaying).catch(() => {});
    else void this.api.beatPresence(this.lastRoom).catch(() => {});
  }
}
