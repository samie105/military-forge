/**
 * Join tickets (docs/06 §6): for each join, the API signs a short-lived Ed25519 JWT saying who
 * (`sub`), under which name (`nick`, already held to the nickname rules and reserved names) and for
 * which room (`room`, the code). A new player gets into a room by code only with a valid ticket for
 * that code, so rooms open only for players the API let in. No database calls here: the API's public
 * key is enough, and a seen-`jti` list (kept until the tickets expire) stops a ticket being used twice.
 *
 * The format is the API's own (apps/api/src/auth/tokens.ts): exactly its header, EdDSA, and its own
 * issuer with an audience of its own, so an access token can never pass for a ticket or the reverse.
 */
import { createPublicKey, verify, type KeyObject } from 'node:crypto';
import { MAX_LOOK_IDS } from '@military-forge/content';

export const TICKET_ISSUER = 'api';
export const TICKET_AUDIENCE = 'game-server';
const HEADER = Buffer.from(JSON.stringify({ alg: 'EdDSA', typ: 'JWT' })).toString('base64url');
/** the API's clock and ours may disagree a little */
const CLOCK_SKEW_S = 5;
const MAX_TICKET_CHARS = 2048;
const MAX_CLAIM_CHARS = 128;
/** a ticket says nothing useful past this, whatever its exp claims (the API issues ~30 s) */
const MAX_LIFETIME_S = 300;

export interface TicketClaims {
  sub: string;
  nick: string;
  room: string;
  exp: number;
  jti: string;
  /** the player's saved gun pair, weapon ids (absent = the default pair); room.ts checks it against content */
  guns?: [string, string];
  /** the player's party (the API's invites/party): party voice reaches its other members */
  party?: string;
  /** v19: the player's saved look, cosmetic wire ids the API checked (absent = none saved); room.ts checks it again */
  look?: number[];
  /** v19: the player's level (absent = 0: starter items only): what they may wear */
  lvl?: number;
}

export type TicketFailure = 'missing' | 'malformed' | 'bad_signature' | 'wrong_audience' | 'expired' | 'wrong_room' | 'used';

/** What the player is told (the close reason) for each failure. */
export const TICKET_FAILURE_TEXT: Record<TicketFailure, string> = {
  missing: 'this room takes players from its link only: open the room link again',
  malformed: "your pass for this room didn't check out: open the room link again",
  bad_signature: "your pass for this room didn't check out: open the room link again",
  wrong_audience: "your pass for this room didn't check out: open the room link again",
  expired: 'your pass for this room expired: open the room link again',
  wrong_room: 'that pass is for another room: open the room link again',
  used: 'that pass was already used: open the room link again',
};

/** An Ed25519 public key from PEM; keys pasted into one-line env vars arrive with literal "\n". */
export function ticketPublicKey(pem: string): KeyObject {
  const key = createPublicKey(pem.replaceAll('\\n', '\n'));
  if (key.asymmetricKeyType !== 'ed25519') throw new Error(`expected an Ed25519 public key, got ${key.asymmetricKeyType}`);
  return key;
}

const shortString = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= MAX_CLAIM_CHARS;
const wireId = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 0xffff;

export class TicketVerifier {
  /** jti → when it can be forgotten (s): the ticket has expired by then */
  private readonly used = new Map<string, number>();
  private prunedAt = 0;

  constructor(
    private readonly key: KeyObject,
    private readonly nowSeconds: () => number = () => Date.now() / 1000,
  ) {}

  /** Checks a ticket for room `room` and spends it: each ticket admits one player once. */
  admit(ticket: string, room: string): { ok: true; claims: TicketClaims } | { ok: false; reason: TicketFailure } {
    if (!ticket) return { ok: false, reason: 'missing' };
    if (ticket.length > MAX_TICKET_CHARS) return { ok: false, reason: 'malformed' };
    const parts = ticket.split('.');
    if (parts.length !== 3 || parts[0] !== HEADER) return { ok: false, reason: 'malformed' };
    const [, payload, signature] = parts as [string, string, string];
    let valid: boolean;
    try {
      valid = verify(null, Buffer.from(`${HEADER}.${payload}`), this.key, Buffer.from(signature, 'base64url'));
    } catch {
      return { ok: false, reason: 'malformed' };
    }
    if (!valid) return { ok: false, reason: 'bad_signature' };
    let claims: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return { ok: false, reason: 'malformed' };
      claims = parsed as Record<string, unknown>;
    } catch {
      return { ok: false, reason: 'malformed' };
    }
    const { iss, aud, sub, nick, exp, jti, iat } = claims;
    if (iss !== TICKET_ISSUER || aud !== TICKET_AUDIENCE) return { ok: false, reason: 'wrong_audience' };
    if (!shortString(sub) || !shortString(nick) || !shortString(jti) || typeof claims.room !== 'string' || typeof exp !== 'number' || typeof iat !== 'number') {
      return { ok: false, reason: 'malformed' };
    }
    const now = this.nowSeconds();
    if (exp + CLOCK_SKEW_S <= now || exp - iat > MAX_LIFETIME_S || iat - CLOCK_SKEW_S > now) return { ok: false, reason: 'expired' };
    if (claims.room !== room) return { ok: false, reason: 'wrong_room' };
    this.prune(now);
    if (this.used.has(jti)) return { ok: false, reason: 'used' };
    this.used.set(jti, exp + CLOCK_SKEW_S);
    const guns = Array.isArray(claims.guns) && claims.guns.length === 2 && claims.guns.every(shortString) ? (claims.guns as [string, string]) : undefined;
    const party = shortString(claims.party) ? (claims.party as string) : undefined;
    const look = Array.isArray(claims.look) && claims.look.length > 0 && claims.look.length <= MAX_LOOK_IDS && claims.look.every(wireId) ? (claims.look as number[]) : undefined;
    const lvl = Number.isInteger(claims.lvl) && (claims.lvl as number) >= 0 && (claims.lvl as number) <= 10_000 ? (claims.lvl as number) : undefined;
    return { ok: true, claims: { sub, nick, room: claims.room, exp, jti, ...(guns ? { guns } : {}), ...(party ? { party } : {}), ...(look ? { look } : {}), ...(lvl !== undefined ? { lvl } : {}) } };
  }

  /** tickets remembered as used (tests) */
  get remembered(): number {
    return this.used.size;
  }

  private prune(now: number): void {
    if (now - this.prunedAt < 1) return;
    this.prunedAt = now;
    for (const [jti, until] of this.used) if (until <= now) this.used.delete(jti);
  }
}
