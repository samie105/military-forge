/**
 * Voice chat's relay (v18; packages/protocol voice.ts, docs/05 §17). The room hands it each
 * VOICE_UP and the Voice CMD; it decides, frame by frame, who hears whom, and forwards the
 * client's bytes as VOICE_DOWN. It never decodes audio.
 *
 * Who hears a frame (the owner's rules, 23 Oct):
 * - **Out loud (Near)** in play: everyone whose soldier is within VOICE.radius of the speaker's,
 *   opponents included, from real sim positions (a modded client can't hear far-away enemies:
 *   the frames never leave the server). A listener who turned off "Hear opponents" gets only party
 *   mates and teammates; "Proximity voice" off gets none of it.
 * - **Last words:** a speaker who just died keeps that for VOICE.lastWords seconds, from the
 *   death spot. After that the dead reach only the dead (any distance), their team radio and their
 *   party, never living opponents.
 * - **Outside play** (lobby, results), Near is the whole room.
 * - **Party:** party mates anywhere in the room (the join ticket's `party`). **Team radio:**
 *   teammates anywhere, in team modes (free-for-all has none yet: `teamOf` returns null).
 * - A listener's mutes: the server sends them nothing of a muted player.
 * - Each listener gets at most VOICE.maxSpeakers voices at once: party and team first, then the
 *   nearest; a voice past the cap waits until one goes quiet. Phones decode only so many.
 * - A connection backed up (a stalled WebSocket) skips voice rather than queue stale audio.
 */
import { VOICE } from '@military-forge/content';
import {
  DecodeError,
  PEER_DEAD,
  PEER_MIC,
  PEER_MUTED,
  PEER_PARTY,
  PEER_TEAM,
  PEER_VOICE,
  VoiceChannel,
  VoiceRoute,
  decodeVoiceUp,
  encodeVoiceDown,
  encodeVoiceState,
  parseVoiceSettings,
  type VoiceRouteId,
  type VoiceSettingsCmd,
} from '@military-forge/protocol';

/** Frames a speaker may send a second (20 ms frames are 50), with a second of burst. */
export const VOICE_FRAMES_PER_SECOND = 60;
/** A voice counts as still talking this long after its last frame (the cap's window), in ticks. */
const ACTIVE_TICKS = 24;
/** VOICE_STATE at most this often while things change, in ticks. */
const STATE_EVERY_TICKS = 10;
/** Skip voice to a connection with more than this queued (snapshots use the same line). */
const BACKLOG_LIMIT = 16 * 1024;
const TICKS_PER_SECOND = 60;

/** What the relay needs of a connection (room.ts Client). */
export interface VoiceClient {
  readonly playerId: number;
  readonly joined: boolean;
  /** the protocol version its HELLO said */
  protocolVersion: number;
  /** its party (the join ticket), or null */
  party: string | null;
  readonly conn: { send(bytes: Uint8Array): void; bufferedAmount(): number };
  /** set by the relay: its voice settings (null: never asked for voice) and its counters */
  voice: VoiceSettingsCmd | null;
  voiceMutes?: Set<number>;
  voiceTokens?: number;
  voiceTokensAt?: number;
  /** the voices it's hearing now: speaker id → [last tick, priority] */
  voiceActive?: Map<number, [number, number]>;
}

/** What the relay needs of the room. */
export interface VoiceRoom {
  readonly tick: number;
  clients(): Iterable<VoiceClient>;
  /** false in the lobby and on the results (Near is the whole room then) */
  inPlay(): boolean;
  /** a player's soldier, or null */
  player(id: number): { x: number; y: number; alive: boolean } | null;
  /** a player's team, or null in free-for-all */
  teamOf(id: number): number | null;
}

export class VoiceRelay {
  /** when each dead player died, and where (last words, and dead-to-dead chat) */
  private readonly deaths = new Map<number, { tick: number; x: number; y: number }>();
  private dirty = false;
  private lastStateTick = -Infinity;
  /** frames forwarded and dropped, for the room's log line and tests */
  readonly counters = { in: 0, out: 0, rateLimited: 0, malformed: 0, capped: 0, backlogged: 0 };

  constructor(private readonly room: VoiceRoom) {}

  /** Whether a client may use voice: it said v18 or later. */
  static capable(c: Pick<VoiceClient, 'protocolVersion'>): boolean {
    return c.protocolVersion >= 18;
  }

  /** The Voice CMD (CmdKind.Voice): a v18 client's whole voice state. */
  onSettings(client: VoiceClient, payload: string): void {
    if (!VoiceRelay.capable(client)) return;
    const s = parseVoiceSettings(payload);
    if (!s) return;
    client.voice = s;
    client.voiceMutes = new Set(s.mute);
    this.dirty = true;
  }

  /** Someone joined, left, changed party: VOICE_STATE goes out again soon. */
  changed(): void {
    this.dirty = true;
  }

  /** Once per room tick: deaths (last words) and VOICE_STATE when something changed. */
  tick(): void {
    const now = this.room.tick;
    for (const c of this.room.clients()) {
      if (!c.joined) continue;
      const p = this.room.player(c.playerId);
      if (!p) continue;
      const dead = this.deaths.get(c.playerId);
      if (!p.alive && !dead) {
        this.deaths.set(c.playerId, { tick: now, x: p.x, y: p.y });
        this.dirty = true;
      } else if (p.alive && dead) {
        this.deaths.delete(c.playerId);
        this.dirty = true;
      } else if (dead && now - dead.tick === this.lastWordsTicks()) this.dirty = true; // last words just ended
    }
    if (this.dirty && now - this.lastStateTick >= STATE_EVERY_TICKS) this.sendState();
  }

  private lastWordsTicks(): number {
    return Math.round(VOICE.lastWords * TICKS_PER_SECOND);
  }

  /** A player's voice is past its last words: it reaches only the dead, the team and the party. */
  private silenced(id: number): boolean {
    const d = this.deaths.get(id);
    return !!d && this.room.tick - d.tick >= this.lastWordsTicks();
  }

  /** Where a speaker's voice comes from: the soldier, or the death spot while last words last. */
  private origin(id: number): { x: number; y: number; lastWords: boolean } | null {
    const d = this.deaths.get(id);
    if (d) return this.room.tick - d.tick < this.lastWordsTicks() ? { x: d.x, y: d.y, lastWords: true } : null;
    const p = this.room.player(id);
    return p ? { x: p.x, y: p.y, lastWords: false } : null;
  }

  /** One VOICE_UP: checked, rate limited, then forwarded to whoever should hear it. */
  onFrame(speaker: VoiceClient, bytes: Uint8Array): void {
    this.counters.in++;
    const s = speaker.voice;
    if (!speaker.joined || !s?.on || !s.mic || !VoiceRelay.capable(speaker)) return;
    const now = this.room.tick;
    // a token bucket: 60 frames a second, a second of burst
    const elapsed = Math.max(0, now - (speaker.voiceTokensAt ?? now));
    speaker.voiceTokens = Math.min(VOICE_FRAMES_PER_SECOND, (speaker.voiceTokens ?? VOICE_FRAMES_PER_SECOND) + (elapsed * VOICE_FRAMES_PER_SECOND) / TICKS_PER_SECOND);
    speaker.voiceTokensAt = now;
    if (speaker.voiceTokens < 1) {
      this.counters.rateLimited++;
      return;
    }
    speaker.voiceTokens--;
    let channel: number;
    try {
      channel = decodeVoiceUp(bytes).channel;
    } catch (e) {
      if (!(e instanceof DecodeError)) throw e;
      this.counters.malformed++; // dropped, never a kick: a voice bug mustn't end anyone's match
      return;
    }

    const id = speaker.playerId;
    const inPlay = this.room.inPlay();
    const origin = this.origin(id);
    const silenced = inPlay && this.silenced(id);
    const team = this.room.teamOf(id);
    const r2 = VOICE.radius * VOICE.radius;
    for (const l of this.room.clients()) {
      if (l === speaker || !l.joined || !l.voice?.on || !VoiceRelay.capable(l) || l.voiceMutes?.has(id)) continue;
      const partyMate = speaker.party !== null && l.party === speaker.party;
      const teammate = team !== null && this.room.teamOf(l.playerId) === team;
      let route: VoiceRouteId | null = null;
      let priority = 0;
      if (channel === VoiceChannel.Party) {
        if (partyMate) [route, priority] = [VoiceRoute.Party, 3];
      } else if (channel === VoiceChannel.Team) {
        if (teammate) [route, priority] = [VoiceRoute.Team, 3];
      } else if (!inPlay) {
        [route, priority] = [VoiceRoute.Lobby, 2];
      } else if (silenced) {
        // the dead to the dead, any distance
        if (this.silenced(l.playerId)) [route, priority] = [VoiceRoute.Dead, 1];
      } else if (origin && l.voice.proximity && (l.voice.hearOpponents || partyMate || teammate)) {
        const at = this.room.player(l.playerId);
        if (at) {
          const d2 = (at.x - origin.x) ** 2 + (at.y - origin.y) ** 2;
          if (d2 <= r2) [route, priority] = [VoiceRoute.Proximity, 2 - Math.sqrt(d2) / VOICE.radius];
        }
      }
      if (route === null) continue;
      if (!this.admit(l, id, priority, now)) {
        this.counters.capped++;
        continue;
      }
      if (l.conn.bufferedAmount() > BACKLOG_LIMIT) {
        this.counters.backlogged++;
        continue;
      }
      l.conn.send(encodeVoiceDown(id, route, route === VoiceRoute.Proximity && !!origin?.lastWords, bytes));
      this.counters.out++;
    }
  }

  /** The cap: is there room for this voice at `listener` (evicting a lower-priority one if not)? */
  private admit(listener: VoiceClient, speaker: number, priority: number, now: number): boolean {
    const active = (listener.voiceActive ??= new Map());
    for (const [k, [t]] of active) if (now - t > ACTIVE_TICKS) active.delete(k);
    const mine = active.get(speaker);
    if (mine || active.size < Math.max(1, VOICE.maxSpeakers)) {
      active.set(speaker, [now, priority]);
      return true;
    }
    let low: number | null = null;
    let lowP = Infinity;
    for (const [k, [, p]] of active) {
      if (p < lowP) [low, lowP] = [k, p];
    }
    if (low === null || priority <= lowP) return false;
    active.delete(low);
    active.set(speaker, [now, priority]);
    return true;
  }

  /** VOICE_STATE to every voice client: each sees the others' flags as they relate to them. */
  private sendState(): void {
    this.dirty = false;
    this.lastStateTick = this.room.tick;
    const all = [...this.room.clients()].filter((c) => c.joined);
    const fallback = all.some((c) => c.voice?.on && !c.voice.opus);
    for (const l of all) {
      if (!l.voice || !VoiceRelay.capable(l)) continue;
      const team = this.room.teamOf(l.playerId);
      const peers = all
        .filter((c) => c !== l)
        .map((c) => {
          let flags = 0;
          if (c.voice?.on) flags |= PEER_VOICE;
          if (c.voice?.on && c.voice.mic) flags |= PEER_MIC;
          if (l.party !== null && c.party === l.party) flags |= PEER_PARTY;
          if (l.voiceMutes?.has(c.playerId)) flags |= PEER_MUTED;
          if (team !== null && this.room.teamOf(c.playerId) === team) flags |= PEER_TEAM;
          if (this.room.inPlay() && this.silenced(c.playerId)) flags |= PEER_DEAD;
          return { id: c.playerId, flags };
        });
      l.conn.send(encodeVoiceState(fallback, peers));
    }
  }

  /** A player left: forget their death, and tell the others. */
  remove(playerId: number): void {
    this.deaths.delete(playerId);
    for (const c of this.room.clients()) c.voiceActive?.delete(playerId);
    this.dirty = true;
  }
}
