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
  });
});
