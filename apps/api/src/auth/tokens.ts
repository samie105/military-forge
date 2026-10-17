/**
 * Compact JWS (JWT) signed with Ed25519 (`alg: EdDSA`), on node:crypto only. Verifiers hold just
 * the public key (docs/06 §6, docs/10 §2.5). Only our own header is accepted, so there is no
 * algorithm negotiation to abuse (`alg: none`, HS256-with-public-key and friends).
 */
import { sign, verify, type KeyObject } from 'node:crypto';

const HEADER = Buffer.from(JSON.stringify({ alg: 'EdDSA', typ: 'JWT' })).toString('base64url');

export interface StandardClaims {
  iss: string;
  aud: string;
  sub: string;
  /** seconds since the epoch */
  iat: number;
  exp: number;
}

export function signJwt<T extends StandardClaims>(claims: T, privateKey: KeyObject): string {
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const signature = sign(null, Buffer.from(`${HEADER}.${payload}`), privateKey).toString('base64url');
  return `${HEADER}.${payload}.${signature}`;
}

export type VerifyFailure = 'malformed' | 'bad_signature' | 'expired' | 'wrong_audience';

/** Checks header, signature, issuer, audience and expiry (no clock skew allowance: we issue and verify). */
export function verifyJwt<T extends StandardClaims>(
  token: string,
  publicKey: KeyObject,
  expect: { iss: string; aud: string; nowSeconds: number },
): { ok: true; claims: T } | { ok: false; reason: VerifyFailure } {
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== HEADER) return { ok: false, reason: 'malformed' };
  const [, payload, signature] = parts as [string, string, string];
  if (!verify(null, Buffer.from(`${HEADER}.${payload}`), publicKey, Buffer.from(signature, 'base64url'))) {
    return { ok: false, reason: 'bad_signature' };
  }
  let claims: T;
  try {
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as T;
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (typeof claims !== 'object' || claims === null || typeof claims.sub !== 'string' || typeof claims.exp !== 'number') {
    return { ok: false, reason: 'malformed' };
  }
  if (claims.iss !== expect.iss || claims.aud !== expect.aud) return { ok: false, reason: 'wrong_audience' };
  if (claims.exp <= expect.nowSeconds) return { ok: false, reason: 'expired' };
  return { ok: true, claims };
}

/** Access tokens: who (`sub`) and which session (`sid`), so logout can revoke them early. */
export interface AccessClaims extends StandardClaims {
  sid: string;
}

export const ACCESS_ISSUER = 'api';
export const ACCESS_AUDIENCE = 'api';
