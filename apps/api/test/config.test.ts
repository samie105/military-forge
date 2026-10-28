import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config';

const PROD = {
  NODE_ENV: 'production',
  DATABASE_URL: 'postgres://game:game@db:5432/game',
  REDIS_URL: 'redis://cache:6379',
  ACCESS_TOKEN_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----',
  JOIN_TICKET_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\\nxyz\\n-----END PRIVATE KEY-----',
  CORS_ORIGINS: 'https://play.example.com, https://portal.example.net',
};

function issues(env: Record<string, string>): string[] {
  try {
    loadConfig(env);
  } catch (err) {
    if (err instanceof ConfigError) return err.issues;
    throw err;
  }
  return [];
}

describe('loadConfig', () => {
  it('runs with no env at all: PGlite, memory KV, dev key, localhost CORS', () => {
    const c = loadConfig({});
    expect(c.env).toBe('development');
    expect(c.port).toBe(8787);
    expect(c.db).toEqual({ kind: 'pglite', dataDir: '.data/pglite' });
    expect(c.redisUrl).toBeNull();
    expect(c.accessToken).toEqual({ privateKeyPem: null, ttlSeconds: 900 });
    expect(c.joinTicket).toEqual({ privateKeyPem: null, ttlSeconds: 30 });
    expect(c.corsOrigins).toBe('localhost');
    expect(c.cookie).toEqual({ secure: false, sameSite: 'Lax', domain: null });
    expect(c.trustProxy).toBe('none');
    expect(c.trustProxyHops).toBe(1);
    expect(c.logLevel).toBe('info');
  });

  it('COSMETIC_GRANTS: the owner grants store items to accounts by id; malformed pairs and unknown items refuse to start', () => {
    expect(loadConfig({}).cosmeticGrants.size).toBe(0);
    const c = loadConfig({ COSMETIC_GRANTS: 'u_owner:skin_k47_galaxy_relic_fx, u_owner:headgear_combat_helmet,u_dev:skin_k47_galaxy_relic' });
    expect(c.cosmeticGrants.get('u_owner')).toEqual(['skin_k47_galaxy_relic_fx', 'headgear_combat_helmet']);
    expect(c.cosmeticGrants.get('u_dev')).toEqual(['skin_k47_galaxy_relic']);
    expect(issues({ COSMETIC_GRANTS: 'u_owner' })).toEqual(['COSMETIC_GRANTS: "u_owner" is not <accountId>:<itemId>']);
    expect(issues({ COSMETIC_GRANTS: 'u_owner:skin_nope' })).toEqual(['COSMETIC_GRANTS: "skin_nope" is not a cosmetic item']);
  });

  it('FLUTTERWAVE_*: all three keys turn the store on (test or live, not mixed); none leaves it off; some is an error', () => {
    const keys = { FLUTTERWAVE_SECRET_KEY: 'FLWSECK_TEST-abcdef0123456789-X', FLUTTERWAVE_PUBLIC_KEY: 'FLWPUBK_TEST-abcdef0123456789-X', FLUTTERWAVE_WEBHOOK_HASH: 'a-long-random-webhook-hash' };
    expect(loadConfig({}).flutterwave).toBeNull();
    expect(loadConfig(keys).flutterwave).toEqual({ secretKey: keys.FLUTTERWAVE_SECRET_KEY, publicKey: keys.FLUTTERWAVE_PUBLIC_KEY, webhookHash: keys.FLUTTERWAVE_WEBHOOK_HASH, apiUrl: 'https://api.flutterwave.com' });
    expect(issues({ FLUTTERWAVE_SECRET_KEY: keys.FLUTTERWAVE_SECRET_KEY })).toEqual([expect.stringMatching(/^FLUTTERWAVE_\*: set FLUTTERWAVE_SECRET_KEY, FLUTTERWAVE_PUBLIC_KEY and FLUTTERWAVE_WEBHOOK_HASH together/)]);
    expect(issues({ ...keys, FLUTTERWAVE_PUBLIC_KEY: 'FLWPUBK-abcdef0123456789-X' })).toEqual(['FLUTTERWAVE_*: the secret and public keys must both be test keys or both live keys']);
    expect(issues({ ...keys, FLUTTERWAVE_SECRET_KEY: 'sk_live_123456789' })[0]).toMatch(/^FLUTTERWAVE_SECRET_KEY: must be a Flutterwave secret key/);
    expect(issues({ ...keys, FLUTTERWAVE_WEBHOOK_HASH: 'short' })[0]).toMatch(/^FLUTTERWAVE_WEBHOOK_HASH: at least 16/);
  });

  it('treats empty values (FOO= in a .env file) as unset', () => {
    expect(loadConfig({ DATABASE_URL: '', REDIS_URL: '  ', API_PORT: '' }).db.kind).toBe('pglite');
  });

  it('uses Postgres and Redis when their URLs are set', () => {
    const c = loadConfig({ DATABASE_URL: 'postgres://game:game@localhost:55432/game', REDIS_URL: 'redis://localhost:56379' });
    expect(c.db).toEqual({ kind: 'postgres', url: 'postgres://game:game@localhost:55432/game' });
    expect(c.redisUrl).toBe('redis://localhost:56379');
  });

  it('production: secure cookies, exact CORS origins, PEM newlines restored', () => {
    const c = loadConfig(PROD);
    expect(c.cookie.secure).toBe(true);
    expect(c.corsOrigins).toEqual(['https://play.example.com', 'https://portal.example.net']);
    expect(c.accessToken.privateKeyPem).toBe('-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----');
    expect(c.joinTicket.privateKeyPem).toBe('-----BEGIN PRIVATE KEY-----\nxyz\n-----END PRIVATE KEY-----');
  });

  it('production refuses to start without its real dependencies', () => {
    expect(issues({ NODE_ENV: 'production' })).toEqual([
      'DATABASE_URL: required in production',
      'REDIS_URL: required in production',
      'ACCESS_TOKEN_PRIVATE_KEY: required in production',
      'JOIN_TICKET_PRIVATE_KEY: required in production',
      'CORS_ORIGINS: required in production',
    ]);
  });

  it('rejects bad values with the variable name', () => {
    expect(issues({ API_PORT: '99999' })[0]).toMatch(/^API_PORT:/);
    expect(issues({ DATABASE_URL: 'mysql://x' })[0]).toMatch(/^DATABASE_URL: must be a postgres/);
    expect(issues({ REDIS_URL: 'http://x' })[0]).toMatch(/^REDIS_URL:/);
    expect(issues({ CORS_ORIGINS: 'not a url' })[0]).toMatch(/^CORS_ORIGINS/);
    expect(issues({ TRUST_PROXY: 'everyone' })[0]).toMatch(/^TRUST_PROXY:/);
    expect(issues({ COOKIE_SAMESITE: 'None' })).toEqual(['COOKIE_SAMESITE: None requires COOKIE_SECURE=true']);
    expect(issues({ COOKIE_SAMESITE: 'None', COOKIE_SECURE: 'true' })).toEqual([]);
  });

  it('parses the reserved nickname list', () => {
    expect(loadConfig({ RESERVED_NICKNAMES: 'Richie, Ade ,,' }).reservedNicknames).toEqual(['Richie', 'Ade']);
    // KEEP_ROOMS (pnpm playtest's API restarts): room codes, normalised, each once; anything else is refused
    expect(loadConfig({ KEEP_ROOMS: 'kqx-mzp, BGAKSS,KQXMZP' }).keepRooms).toEqual(['KQXMZP', 'BGAKSS']);
    expect(loadConfig({}).keepRooms).toEqual([]);
    expect(() => loadConfig({ KEEP_ROOMS: 'NOPE0' })).toThrow(/KEEP_ROOMS: "NOPE0" is not a room code/);
  });
});
