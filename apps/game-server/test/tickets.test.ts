/** Join tickets: the API's format, checked with its public key alone; spent tickets are forgotten once expired. */
import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { TICKET_AUDIENCE, TICKET_ISSUER, TicketVerifier, ticketPublicKey } from '../src/tickets';

const keys = generateKeyPairSync('ed25519');
const header = Buffer.from(JSON.stringify({ alg: 'EdDSA', typ: 'JWT' })).toString('base64url');
const ticket = (claims: Record<string, unknown>) => {
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${header}.${payload}.${sign(null, Buffer.from(`${header}.${payload}`), keys.privateKey).toString('base64url')}`;
};

describe('TicketVerifier', () => {
  it('reads the key from a one-line env value and refuses other key types', () => {
    const pem = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    expect(ticketPublicKey(pem.replaceAll('\n', '\\n')).asymmetricKeyType).toBe('ed25519');
    const rsa = generateKeyPairSync('rsa', { modulusLength: 1024 }).publicKey.export({ type: 'spki', format: 'pem' }).toString();
    expect(() => ticketPublicKey(rsa)).toThrow(/Ed25519/);
  });

  it('remembers a spent ticket until it has expired, then forgets it', () => {
    let now = 1000;
    const v = new TicketVerifier(keys.publicKey, () => now);
    const claims = (jti: string) => ({ iss: TICKET_ISSUER, aud: TICKET_AUDIENCE, sub: 'u_1', nick: 'Ade', room: 'AAAAAA', iat: now, exp: now + 30, jti });
    const first = ticket(claims('a'));
    expect(v.admit(first, 'AAAAAA').ok).toBe(true);
    expect(v.admit(first, 'AAAAAA')).toEqual({ ok: false, reason: 'used' });
    expect(v.remembered).toBe(1);
    now += 40; // past exp + the 5 s allowance
    expect(v.admit(ticket(claims('b')), 'AAAAAA').ok).toBe(true);
    expect(v.remembered).toBe(1); // 'a' is gone, 'b' is kept
    expect(v.admit(first, 'AAAAAA')).toEqual({ ok: false, reason: 'expired' }); // and can't come back
  });

  it('wants every claim it relies on', () => {
    const v = new TicketVerifier(keys.publicKey, () => 1000);
    const base = { iss: TICKET_ISSUER, aud: TICKET_AUDIENCE, sub: 'u_1', nick: 'Ade', room: 'AAAAAA', iat: 1000, exp: 1030, jti: 'x' };
    for (const drop of ['sub', 'nick', 'room', 'exp', 'iat', 'jti']) {
      const claims: Record<string, unknown> = { ...base, jti: `x-${drop}` };
      delete claims[drop];
      expect(v.admit(ticket(claims), 'AAAAAA').ok, drop).toBe(false);
    }
    expect(v.admit(ticket({ ...base, nick: 'x'.repeat(500) }), 'AAAAAA')).toEqual({ ok: false, reason: 'malformed' });
    expect(v.admit(`${ticket(base)}x`, 'AAAAAA').ok).toBe(false);
  });
});
