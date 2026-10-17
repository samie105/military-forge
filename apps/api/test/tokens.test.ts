import { describe, expect, it } from 'vitest';
import { generateSigningKey, privateKeyPem, signingKeyFromPem } from '../src/auth/keys';
import { signJwt, verifyJwt, type AccessClaims } from '../src/auth/tokens';

const key = generateSigningKey();
const claims: AccessClaims = { iss: 'api', aud: 'api', sub: 'u_1', sid: 's_1', iat: 1000, exp: 1900 };
const expect_ = { iss: 'api', aud: 'api', nowSeconds: 1500 };
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');

describe('Ed25519 JWT', () => {
  it('round-trips with only the public key', () => {
    const token = signJwt(claims, key.privateKey);
    expect(verifyJwt(token, key.publicKey, expect_)).toEqual({ ok: true, claims });
  });

  it('rejects expiry, audience, another key and tampering', () => {
    const token = signJwt(claims, key.privateKey);
    expect(verifyJwt(token, key.publicKey, { ...expect_, nowSeconds: 1900 })).toEqual({ ok: false, reason: 'expired' });
    expect(verifyJwt(token, key.publicKey, { ...expect_, aud: 'gs' })).toEqual({ ok: false, reason: 'wrong_audience' });
    expect(verifyJwt(token, generateSigningKey().publicKey, expect_)).toEqual({ ok: false, reason: 'bad_signature' });
    const [h, , s] = token.split('.');
    expect(verifyJwt(`${h}.${b64({ ...claims, sub: 'u_admin' })}.${s}`, key.publicKey, expect_)).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('accepts only its own header (no alg: none, no algorithm switching)', () => {
    const payload = b64(claims);
    expect(verifyJwt(`${b64({ alg: 'none', typ: 'JWT' })}.${payload}.`, key.publicKey, expect_).ok).toBe(false);
    expect(verifyJwt(`${b64({ alg: 'HS256', typ: 'JWT' })}.${payload}.abc`, key.publicKey, expect_).ok).toBe(false);
    for (const junk of ['', 'a.b', 'a.b.c.d', '...', signJwt(claims, key.privateKey) + 'x']) {
      expect(verifyJwt(junk, key.publicKey, expect_).ok).toBe(false);
    }
  });

  it('loads keys from PEM and refuses non-Ed25519 keys', () => {
    const pem = privateKeyPem(key);
    const loaded = signingKeyFromPem(pem);
    expect(verifyJwt(signJwt(claims, loaded.privateKey), key.publicKey, expect_).ok).toBe(true);
    expect(() => signingKeyFromPem('not a key')).toThrow();
  });
});
