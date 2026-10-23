/**
 * Voice chat on the game connection (v18; protocol-registry.md, docs/05 §17). The game server
 * relays compressed voice frames between players and never decodes them: it only reads the small
 * header, decides who hears whom from where the soldiers stand (proximity, last words), the team,
 * the party and the match phase, and forwards the client's bytes.
 *
 * VOICE_UP (0x29, client → server, unreliable: a WebTransport datagram, else the WebSocket):
 *
 *   u8  type 0x29
 *   u16 seq (little-endian, wraps)
 *   u8  meta: codec (bits 0-1) · channel the speaker asked for (bits 2-3) · level 0-15 (bits 4-7)
 *   u8  info: frame length (bits 0-1: 20 / 40 / 60 ms) · redundant copy (bit 2) · 5 bits spare
 *   [u8 n · n bytes: the previous frame again, when bit 2 is set (packet-level FEC under loss)]
 *   …   the frame
 *
 * VOICE_DOWN (0x2A, server → client, unreliable): u8 type · u8 speaker id · u8 route (bits 0-2)
 * with bit 7 = last words · then VOICE_UP's bytes from the seq on, unchanged.
 *
 * VOICE_STATE (0x2B, server → client, reliable): u8 type · u8 flags (bit 0: the room uses the
 * fallback codec, someone in it can't decode Opus) · u8 n · n × (u8 player id · u8 flags, PEER_*).
 */
import { DecodeError } from './bitstream';
import { MsgType } from './wire';

/** What a frame is coded as. Opus via WebCodecs; IMA ADPCM at 6 kHz where a browser has no Opus. */
export const VoiceCodec = { Opus: 0, Adpcm: 1 } as const;
export type VoiceCodecId = (typeof VoiceCodec)[keyof typeof VoiceCodec];

/** Who the speaker means to reach (push-to-talk keys pick it). */
export const VoiceChannel = {
  /** out loud: whoever is near (in play), everyone in the room (lobby, results) */
  Near: 0,
  /** team radio: teammates at any distance (team modes; free-for-all has no teams) */
  Team: 1,
  /** the party: party mates at any distance */
  Party: 2,
} as const;
export type VoiceChannelId = (typeof VoiceChannel)[keyof typeof VoiceChannel];

/** How a frame reached a listener: it decides how it's played (in 3D, flat, through a radio). */
export const VoiceRoute = {
  /** near the listener in the world: played at the speaker's soldier (or death spot), in 3D */
  Proximity: 0,
  /** the room outside play (lobby, results): flat */
  Lobby: 1,
  /** team radio: flat, with a radio filter */
  Team: 2,
  /** the party: flat */
  Party: 3,
  /** the dead talking to the dead: flat, quieter */
  Dead: 4,
} as const;
export type VoiceRouteId = (typeof VoiceRoute)[keyof typeof VoiceRoute];

export const VOICE_FRAME_MS = [20, 40, 60] as const;
export type VoiceFrameMs = (typeof VOICE_FRAME_MS)[number];

/** A frame's bytes at most (Opus at 48 kbps × 60 ms is 360 B; with a redundant copy, more). */
export const MAX_VOICE_FRAME = 400;
/** A whole VOICE_UP at most: two frames and the header, under a 1000-byte datagram. */
export const MAX_VOICE_UP = 5 + 1 + 2 * MAX_VOICE_FRAME;

/** VOICE_STATE per-player flags. */
export const PEER_VOICE = 1; // voice chat on
export const PEER_MIC = 2; // has a microphone (else listen-only)
export const PEER_PARTY = 4; // in your party
export const PEER_MUTED = 8; // you muted them (the server sends you nothing of theirs)
export const PEER_TEAM = 16; // on your team (team modes)
export const PEER_DEAD = 32; // dead, past their last words: talks only to the dead, the team and the party

export interface VoiceFrameHeader {
  seq: number;
  codec: VoiceCodecId;
  channel: VoiceChannelId;
  /** loudness 0-15 (speaking rings without decoding) */
  level: number;
  frameMs: VoiceFrameMs;
}

export interface VoiceUp extends VoiceFrameHeader {
  frame: Uint8Array;
  /** the previous frame again (under loss), or null */
  redundant: Uint8Array | null;
}

export interface VoiceDown extends VoiceUp {
  speaker: number;
  route: VoiceRouteId;
  lastWords: boolean;
}

export interface VoicePeer {
  id: number;
  flags: number;
}

export interface VoiceStateMsg {
  type: typeof MsgType.VoiceState;
  /** someone here can't decode Opus: everyone sends the fallback codec */
  fallback: boolean;
  peers: VoicePeer[];
}

/** The Voice CMD's JSON (CmdKind.Voice): the whole state each time, so a lost one is fixed by the next. */
export interface VoiceSettingsCmd {
  /** voice chat on (else this client hears nothing and sends nothing) */
  on: boolean;
  /** a microphone is open (else listen-only) */
  mic: boolean;
  /** this client decodes Opus */
  opus: boolean;
  /** hear players near you out loud (off: only the party, team radio and the lobby) */
  proximity: boolean;
  /** hear opponents near you (off: only party mates and teammates) */
  hearOpponents: boolean;
  /** player ids you muted (the server stops sending them to you) */
  mute: number[];
}

const frameCode = (ms: number): number => Math.max(0, VOICE_FRAME_MS.indexOf(ms as VoiceFrameMs));

export function encodeVoiceUp(up: VoiceUp): Uint8Array {
  const red = up.redundant && up.redundant.length > 0 && up.redundant.length <= 255 ? up.redundant : null;
  const out = new Uint8Array(5 + (red ? 1 + red.length : 0) + up.frame.length);
  out[0] = MsgType.VoiceUp;
  out[1] = up.seq & 0xff;
  out[2] = (up.seq >> 8) & 0xff;
  out[3] = (up.codec & 3) | ((up.channel & 3) << 2) | ((Math.max(0, Math.min(15, Math.round(up.level))) & 15) << 4);
  out[4] = frameCode(up.frameMs) | (red ? 4 : 0);
  let at = 5;
  if (red) {
    out[at++] = red.length;
    out.set(red, at);
    at += red.length;
  }
  out.set(up.frame, at);
  return out;
}

function readHeader(bytes: Uint8Array, at: number): VoiceFrameHeader & { redundant: boolean } {
  const meta = bytes[at + 2]!;
  const info = bytes[at + 3]!;
  const code = info & 3;
  const codec = meta & 3;
  const channel = (meta >> 2) & 3;
  if (code > 2) throw new DecodeError('voice: bad frame length');
  if (codec > VoiceCodec.Adpcm) throw new DecodeError('voice: unknown codec');
  if (channel > VoiceChannel.Party) throw new DecodeError('voice: unknown channel');
  return {
    seq: bytes[at]! | (bytes[at + 1]! << 8),
    codec: codec as VoiceCodecId,
    channel: channel as VoiceChannelId,
    level: meta >> 4,
    frameMs: VOICE_FRAME_MS[code]!,
    redundant: (info & 4) !== 0,
  };
}

/** Reads the frame part of a VOICE_UP/VOICE_DOWN starting at `at` (the seq). */
function readFrames(bytes: Uint8Array, at: number, hasRedundant: boolean): { frame: Uint8Array; redundant: Uint8Array | null } {
  let i = at + 4;
  let redundant: Uint8Array | null = null;
  if (hasRedundant) {
    const n = bytes[i++];
    if (n === undefined || i + n > bytes.length) throw new DecodeError('voice: truncated redundant frame');
    redundant = bytes.subarray(i, i + n);
    i += n;
  }
  const frame = bytes.subarray(i);
  if (frame.length === 0) throw new DecodeError('voice: empty frame');
  if (frame.length > MAX_VOICE_FRAME || (redundant && redundant.length > MAX_VOICE_FRAME)) throw new DecodeError('voice: oversized frame');
  return { frame, redundant };
}

/**
 * Checks a VOICE_UP and reads its header (the server's whole job with it). Throws DecodeError on
 * anything malformed; the frames are views into `bytes`.
 */
export function decodeVoiceUp(bytes: Uint8Array): VoiceUp {
  if (bytes[0] !== MsgType.VoiceUp) throw new DecodeError('voice: not a VOICE_UP');
  if (bytes.length < 6) throw new DecodeError('voice: too short');
  if (bytes.length > MAX_VOICE_UP) throw new DecodeError('voice: too long');
  const h = readHeader(bytes, 1);
  return { ...h, ...readFrames(bytes, 1, h.redundant) };
}

/** VOICE_DOWN from a checked VOICE_UP: the speaker, how it reached you, and the client's bytes. */
export function encodeVoiceDown(speaker: number, route: VoiceRouteId, lastWords: boolean, up: Uint8Array): Uint8Array {
  const out = new Uint8Array(3 + up.length - 1);
  out[0] = MsgType.VoiceDown;
  out[1] = speaker & 0xff;
  out[2] = (route & 7) | (lastWords ? 0x80 : 0);
  out.set(up.subarray(1), 3);
  return out;
}

export function decodeVoiceDown(bytes: Uint8Array): VoiceDown {
  if (bytes[0] !== MsgType.VoiceDown) throw new DecodeError('voice: not a VOICE_DOWN');
  if (bytes.length < 8) throw new DecodeError('voice: too short');
  const route = bytes[2]! & 7;
  if (route > VoiceRoute.Dead) throw new DecodeError('voice: unknown route');
  const h = readHeader(bytes, 3);
  return { speaker: bytes[1]!, route: route as VoiceRouteId, lastWords: (bytes[2]! & 0x80) !== 0, ...h, ...readFrames(bytes, 3, h.redundant) };
}

export function encodeVoiceState(fallback: boolean, peers: readonly VoicePeer[]): Uint8Array {
  const n = Math.min(255, peers.length);
  const out = new Uint8Array(3 + 2 * n);
  out[0] = MsgType.VoiceState;
  out[1] = fallback ? 1 : 0;
  out[2] = n;
  for (let i = 0; i < n; i++) {
    out[3 + 2 * i] = peers[i]!.id & 0xff;
    out[4 + 2 * i] = peers[i]!.flags & 0xff;
  }
  return out;
}

export function decodeVoiceState(bytes: Uint8Array): VoiceStateMsg {
  if (bytes[0] !== MsgType.VoiceState || bytes.length < 3) throw new DecodeError('voice: bad VOICE_STATE');
  const n = bytes[2]!;
  if (bytes.length < 3 + 2 * n) throw new DecodeError('voice: truncated VOICE_STATE');
  const peers: VoicePeer[] = [];
  for (let i = 0; i < n; i++) peers.push({ id: bytes[3 + 2 * i]!, flags: bytes[4 + 2 * i]! });
  return { type: MsgType.VoiceState, fallback: (bytes[1]! & 1) !== 0, peers };
}

/**
 * The Voice CMD's JSON, held to its shape (unknown fields dropped, mutes to valid voice ids: players
 * 0–31 and, v20, spectators 32 + seat, up to 40).
 */
export function parseVoiceSettings(payload: string, maxPlayers = 40): VoiceSettingsCmd | null {
  let raw: unknown;
  try {
    raw = JSON.parse(payload);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const flag = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d);
  const mute = Array.isArray(o.mute) ? [...new Set(o.mute.filter((x): x is number => Number.isInteger(x) && (x as number) >= 0 && (x as number) < maxPlayers))] : [];
  return {
    on: flag(o.on, false),
    mic: flag(o.mic, false),
    opus: flag(o.opus, false),
    proximity: flag(o.proximity, true),
    hearOpponents: flag(o.hearOpponents, true),
    mute,
  };
}
