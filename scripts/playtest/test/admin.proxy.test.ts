/**
 * The admin page through the playtest proxy: /admin is the admin page, /admin/api/* goes to the
 * game server's admin port with the token header and nothing else; without an admin upstream,
 * neither exists.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createProxy } from '../src/proxy';

const root = join(mkdtempSync(join(tmpdir(), 'playtest-admin-')), 'dist');
mkdirSync(root, { recursive: true });
writeFileSync(join(root, 'index.html'), '<!doctype html><title>app</title>');
writeFileSync(join(root, 'admin.html'), '<!doctype html><title>Admin</title>');

const port = (s: Server) => (s.address() as AddressInfo).port;
const listen = (s: Server) => new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
const seen: { method: string; url: string; headers: Record<string, unknown>; body: string }[] = [];
let admin: Server;
let withAdmin: Server;
let without: Server;
const none = { host: '127.0.0.1', port: 1 };

beforeAll(async () => {
  admin = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.push({ method: req.method!, url: req.url!, headers: { ...req.headers }, body });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  await listen(admin);
  withAdmin = createProxy({ root, api: none, game: none, allowedOrigins: () => [], admin: { host: '127.0.0.1', port: port(admin) } });
  without = createProxy({ root, api: none, game: none, allowedOrigins: () => [] });
  await Promise.all([listen(withAdmin), listen(without)]);
});

afterAll(() => {
  for (const s of [admin, withAdmin, without]) s.close();
});

describe('the admin page through the proxy', () => {
  it('/admin is the admin page, with the site\'s security headers', async () => {
    const res = await fetch(`http://127.0.0.1:${port(withAdmin)}/admin`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('<title>Admin</title>');
    expect(res.headers.get('content-security-policy')).toContain("default-src 'self'");
    expect(res.headers.get('x-frame-options')).toBe('DENY');
  });

  it('/admin/api/* reaches the admin port: method, path, the token header and the body; no cookies, no query', async () => {
    const res = await fetch(`http://127.0.0.1:${port(withAdmin)}/admin/api/values?t=leak`, {
      method: 'PUT',
      headers: { Authorization: 'Bearer secret-token-1234567', 'Content-Type': 'application/json', Cookie: 'session=1', 'X-Other': 'no' },
      body: '{"weapon.k47.damage":20}',
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const got = seen.at(-1)!;
    expect([got.method, got.url, got.body]).toEqual(['PUT', '/admin/api/values', '{"weapon.k47.damage":20}']);
    expect(got.headers.authorization).toBe('Bearer secret-token-1234567');
    expect(got.headers['content-type']).toBe('application/json');
    expect(got.headers.cookie).toBeUndefined();
    expect(got.headers['x-other']).toBeUndefined();
  });

  it('without --admin (no upstream) neither the page nor the API exists', async () => {
    expect((await fetch(`http://127.0.0.1:${port(without)}/admin`)).status).toBe(404);
    expect((await fetch(`http://127.0.0.1:${port(without)}/admin/api/state`)).status).toBe(404);
  });
});
