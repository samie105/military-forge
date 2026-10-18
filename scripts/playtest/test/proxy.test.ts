/**
 * The playtest proxy against stand-in services: static files and the app's routes, the API under
 * /api, game WebSockets under /ws (with the origin check), and what must never be served.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Duplex } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import { TUNE_META, clientIp, createProxy, isHashedAsset, pageForOrigin, pageWithFlags, pickEncoding, securityHeaders, staticPath } from '../src/proxy';
import { parseTunnelUrl } from '../src/tunnel';

// the build in a temp dir of its own, with a secret beside it (all removed afterwards)
const outer = mkdtempSync(join(tmpdir(), 'playtest-proxy-'));
const root = join(outer, 'dist');
mkdirSync(join(root, 'assets'), { recursive: true });
writeFileSync(join(root, 'index.html'), '<!doctype html><title>app</title><meta property="og:image" content="%ORIGIN%/og-image.jpg">');
writeFileSync(join(root, 'assets', 'index-abC12_34.js'), 'console.log(1)');
writeFileSync(join(root, 'locker.html'), '<!doctype html><title>locker</title>');
const BIG_JS = `export const data = ${JSON.stringify(Array.from({ length: 400 }, (_, i) => ({ i, name: 'player', ok: true })))};`;
writeFileSync(join(root, 'assets', 'chunk-Zq9_xY12.js'), BIG_JS);
// a secret next to the build must stay unreachable
writeFileSync(join(outer, 'secret.txt'), 'nope');
mkdirSync(join(root, '.hidden'));
writeFileSync(join(root, '.hidden', 'x.txt'), 'nope');

let api: Server;
let game: Server;
let proxy: Server;
let base: string;
const apiSeen: { method: string; url: string; body: string; cf: string | undefined; origin: string | undefined; secret?: string | undefined }[] = [];
const gameSeen: { url: string; xff: string | undefined; headers: string[] }[] = [];
let slowRequestClosed = false;
const allowed: string[] = ['https://abc-def.trycloudflare.com'];

const port = (s: Server) => (s.address() as AddressInfo).port;
const listen = (s: Server) => new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));

beforeAll(async () => {
  api = createServer((req, res) => {
    if (req.url === '/slow') {
      // never answers: the proxy must give up on it when the player does
      res.on('close', () => (slowRequestClosed = true));
      req.resume();
      return;
    }
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      apiSeen.push({ method: req.method!, url: req.url!, body, cf: req.headers['cf-connecting-ip'] as string | undefined, origin: req.headers.origin, secret: req.headers['x-secret'] as string | undefined });
      const hop = req.url === '/hop' ? { connection: 'x-internal', 'x-internal': 'upstream only' } : { connection: 'keep-alive' };
      res.writeHead(201, { 'content-type': 'application/json', 'x-request-id': 'r1', ...hop });
      res.end(JSON.stringify({ ok: true, url: req.url }));
    });
  });
  game = createServer();
  game.on('upgrade', (req: IncomingMessage, socket: Duplex) => {
    gameSeen.push({ url: req.url!, xff: req.headers['x-forwarded-for'] as string | undefined, headers: Object.keys(req.headers) });
    // a refusal, as the game server answers a bad request
    if (req.url!.startsWith('/ws/REFUSE')) return void socket.end('HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n');
    acceptEcho(req, socket);
  });
  await Promise.all([listen(api), listen(game)]);
  proxy = createProxy({ root, api: { host: '127.0.0.1', port: port(api) }, game: { host: '127.0.0.1', port: port(game) }, allowedOrigins: () => allowed, apiOrigin: 'http://127.0.0.1:1234' });
  await listen(proxy);
  base = `http://127.0.0.1:${port(proxy)}`;
});

afterAll(() => {
  proxy?.closeAllConnections();
  proxy?.close();
  game?.close();
  api?.close();
  rmSync(outer, { recursive: true, force: true });
});

// ---- a tiny WebSocket echo server (RFC 6455: handshake, short text frames), standing in for the game server ----

function textFrame(text: string): Buffer {
  const payload = Buffer.from(text);
  return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
}

function acceptEcho(req: IncomingMessage, socket: Duplex): void {
  const accept = createHash('sha1')
    .update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  socket.write(textFrame(`room:${req.url}`));
  socket.on('data', (buf: Buffer) => {
    // client frames are masked; short text only (opcode 1), close frames end it
    const opcode = buf[0]! & 0x0f;
    if (opcode === 8) return (socket as Socket).end();
    const len = buf[1]! & 0x7f;
    const mask = buf.subarray(2, 6);
    const data = Buffer.from(buf.subarray(6, 6 + len).map((b, i) => b ^ mask[i % 4]!));
    if (opcode === 1) socket.write(textFrame(`echo:${data.toString()}`));
  });
  socket.on('error', () => {});
}

/** A raw upgrade request: the status line the proxy answers (101 when it reached the game server). */
function upgrade(path: string, origin?: string, extra: Record<string, string> = {}): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({
      host: '127.0.0.1',
      port: port(proxy),
      path,
      headers: { connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', ...(origin ? { origin } : {}), ...extra },
    });
    req.on('upgrade', (res, socket) => {
      socket.destroy();
      resolve(res.statusCode!);
    });
    req.on('response', (res) => {
      res.resume();
      resolve(res.statusCode!);
    });
    req.on('error', reject);
    req.end();
  });
}

/** Raw request (fetch would normalise ../ away before it reaches the proxy). */
function raw(path: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string; headers: Record<string, string | string[] | undefined> }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: port(proxy), path, method: 'GET', headers }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode!, body, headers: res.headers }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('static files and app routes', () => {
  it('serves the app at / and /r/<code>, with security headers, and files from the build', async () => {
    for (const path of ['/', '/r/KQXMZP', '/r/KQXMZP/', '/index.html']) {
      const res = await fetch(base + path);
      expect(res.status, path).toBe(200);
      const html = await res.text();
      expect(html).toContain('<title>app</title>');
      expect(html).toContain(`content="http://127.0.0.1:${port(proxy)}/og-image.jpg"`); // link previews: absolute
      expect(res.headers.get('cache-control')).toBe('no-cache');
      expect(res.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    }
    const js = await fetch(`${base}/assets/index-abC12_34.js`);
    expect(js.headers.get('content-type')).toMatch(/^text\/javascript/);
    expect(js.headers.get('cache-control')).toContain('immutable');
    const etag = js.headers.get('etag')!;
    expect((await fetch(`${base}/assets/index-abC12_34.js`, { headers: { 'if-none-match': etag } })).status).toBe(304);
    expect((await fetch(`${base}/locker.html`)).status).toBe(200);
    expect((await fetch(`${base}/assets/index-abC12_34.js`, { method: 'HEAD' })).status).toBe(200);
  });

  it("answers the client's /health probe: no WebTransport through the tunnel (WebSocket at once, no 404)", async () => {
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^application\/json/);
    expect(await res.json()).toEqual({ ok: true, webtransport: null });
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('never serves anything outside the build, dotfiles or unknown paths', async () => {
    for (const path of ['/../secret.txt', '/assets/../../secret.txt', '/%2e%2e/secret.txt', '/..%2fsecret.txt', '/.hidden/x.txt', '/%00', '/nope.js', '/r/a/b']) {
      const res = await raw(path);
      expect([400, 404], path).toContain(res.status);
      expect(res.body, path).not.toContain('nope');
    }
    expect((await fetch(`${base}/`, { method: 'POST' })).status).toBe(405);
  });

  it('maps paths safely', () => {
    expect(staticPath('/srv/dist', '/r/ABCDEF')).toEqual({ kind: 'app' });
    expect(staticPath('/srv/dist', '/assets/a.js')).toEqual({ kind: 'file', file: '/srv/dist/assets/a.js' });
    expect(staticPath('/srv/dist', '/../etc/passwd')).toEqual({ kind: 'none' });
    expect(staticPath('/srv/dist', '/a/../../etc/passwd')).toEqual({ kind: 'none' });
    expect(staticPath('/srv/dist', '/.env')).toEqual({ kind: 'none' });
    expect(securityHeaders('abc.trycloudflare.com')['Content-Security-Policy']).toContain('wss://abc.trycloudflare.com');
    expect([isHashedAsset('/assets/main-fCXJHfDR.js'), isHashedAsset('/assets/characters/rookie/rookie.glb'), isHashedAsset('/favicon.svg')]).toEqual([true, false, false]);
    const page = '<meta content="%ORIGIN%/og-image.jpg">';
    expect(pageForOrigin(page, 'abc-def.trycloudflare.com', ['https://abc-def.trycloudflare.com'])).toBe('<meta content="https://abc-def.trycloudflare.com/og-image.jpg">');
    expect(pageForOrigin(page, 'localhost:5191', [])).toBe('<meta content="http://localhost:5191/og-image.jpg">');
    expect(pageForOrigin(page, 'evil.com"><script>', [])).toBe('<meta content="/og-image.jpg">');
    expect(securityHeaders('evil.com; script-src *')['Content-Security-Policy']).not.toContain('evil');
  });

  it('--tune flags the page for the tuning panel (the head gets the meta); without it the page is as built', () => {
    const page = '<html><head><title>app</title></head><body></body></html>';
    expect(pageWithFlags(page, { tune: true })).toBe(`<html><head><title>app</title>  ${TUNE_META}\n  </head><body></body></html>`);
    expect(pageWithFlags(page, { tune: false })).toBe(page);
    expect(pageWithFlags(page, {})).toBe(page);
  });
});

describe('compression', () => {
  it('sends brotli or gzip for text and models when the browser takes it, the same bytes when decoded', async () => {
    const get = (enc: string) =>
      new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: Buffer }>((resolve, reject) => {
        const req = request({ host: '127.0.0.1', port: port(proxy), path: '/assets/chunk-Zq9_xY12.js', headers: { 'accept-encoding': enc } }, (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks) }));
        });
        req.on('error', reject);
        req.end();
      });
    const br = await get('gzip, deflate, br');
    expect(br.headers['content-encoding']).toBe('br');
    expect(br.headers.vary).toBe('Accept-Encoding');
    expect(br.body.length).toBeLessThan(BIG_JS.length / 3);
    expect(brotliDecompressSync(br.body).toString()).toBe(BIG_JS);
    const gz = await get('gzip');
    expect(gz.headers['content-encoding']).toBe('gzip');
    expect(gunzipSync(gz.body).toString()).toBe(BIG_JS);
    const plain = await get('identity');
    expect(plain.headers['content-encoding']).toBeUndefined();
    expect(plain.body.toString()).toBe(BIG_JS);
    expect(pickEncoding('br', 'a.png', 50_000)).toBeNull();
    expect(pickEncoding('br', 'a.js', 100)).toBeNull();
    expect(pickEncoding('br;q=1, gzip', 'model.glb', 50_000)).toBe('br');
  });
});

describe('the API under /api', () => {
  it('forwards any method with the body, without the prefix, and keeps the client IP header', async () => {
    const res = await fetch(`${base}/api/rooms/KQXMZP/join?x=1`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': '198.51.100.7' },
      body: '{"a":1}',
    });
    expect(res.status).toBe(201);
    expect(res.headers.get('x-request-id')).toBe('r1');
    expect(await res.json()).toEqual({ ok: true, url: '/rooms/KQXMZP/join?x=1' });
    expect(apiSeen.at(-1)).toEqual({ method: 'POST', url: '/rooms/KQXMZP/join?x=1', body: '{"a":1}', cf: '198.51.100.7', origin: undefined });
    await fetch(`${base}/api`);
    expect(apiSeen.at(-1)!.url).toBe('/');
  });

  it('the page origin can change with the tunnel: allowed ones reach the API as the origin it trusts, others get 403', async () => {
    const ok = await fetch(`${base}/api/auth/guest`, { method: 'POST', headers: { origin: allowed[0]! }, body: '{}' });
    expect(ok.status).toBe(201);
    expect(apiSeen.at(-1)!.origin).toBe('http://127.0.0.1:1234');
    allowed[0] = 'https://new-words-after-a-restart.trycloudflare.com';
    expect((await fetch(`${base}/api/auth/guest`, { method: 'POST', headers: { origin: allowed[0] }, body: '{}' })).status).toBe(201);
    const evil = await fetch(`${base}/api/auth/guest`, { method: 'POST', headers: { origin: 'https://evil.example' }, body: '{}' });
    expect(evil.status).toBe(403);
    expect(((await evil.json()) as { error: { code: string } }).error.code).toBe('origin_not_allowed');
    allowed[0] = 'https://abc-def.trycloudflare.com';
  });

  it('routes and forwards by the same normalised path', async () => {
    expect((await raw('/x/../api/version')).status).toBe(201);
    expect(apiSeen.at(-1)!.url).toBe('/version');
    const before = apiSeen.length;
    for (const path of ['/api%2fversion', '/api/../../version', '/apiX']) expect((await raw(path)).status, path).toBe(404);
    expect(apiSeen.length).toBe(before); // none of them reached the API
  });

  it("drops the headers either side lists in Connection, and abandons the API's work when the player goes", async () => {
    await raw('/api/version', { connection: 'close, X-Secret', 'x-secret': '1' });
    expect(apiSeen.at(-1)).toMatchObject({ url: '/version', secret: undefined });
    const hop = await raw('/api/hop');
    expect(hop.status).toBe(201);
    expect(hop.headers['x-internal']).toBeUndefined();

    slowRequestClosed = false;
    const req = request({ host: '127.0.0.1', port: port(proxy), path: '/api/slow', method: 'GET' });
    req.on('error', () => {});
    req.end();
    await new Promise((r) => setTimeout(r, 100));
    expect(slowRequestClosed).toBe(false);
    req.destroy();
    await expect.poll(() => slowRequestClosed).toBe(true);
  });

  it('answers 502 when the API is down', async () => {
    const dead = createProxy({ root, api: { host: '127.0.0.1', port: 1 }, game: { host: '127.0.0.1', port: 1 }, allowedOrigins: () => [] });
    await listen(dead);
    const res = await fetch(`http://127.0.0.1:${port(dead)}/api/health`);
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('bad_gateway');
    dead.close();
  });
});

describe('game WebSockets under /ws', () => {
  function open(path: string) {
    const ws = new WebSocket(`ws://127.0.0.1:${port(proxy)}${path}`);
    const messages: string[] = [];
    ws.onmessage = (e) => messages.push(String(e.data));
    const result = new Promise<string>((resolve) => {
      ws.onopen = () => resolve('open');
      ws.onerror = () => resolve('error');
    });
    return { ws, messages, result };
  }

  it('pipes /ws/<code> to the game server, both ways, path and query intact', async () => {
    const c = open('/ws/KQXMZP?x=1');
    expect(await c.result).toBe('open');
    c.ws.send('hi');
    await expect.poll(() => c.messages).toEqual(['room:/ws/KQXMZP?x=1', 'echo:hi']);
    c.ws.close();
  });

  it('refuses other paths and pages from other sites', async () => {
    expect(await open('/api/x').result).toBe('error');
    expect(await upgrade('/assets/x')).toBe(404);
    expect(await upgrade('/ws/KQXMZP', 'https://evil.example')).toBe(403);
    expect(await upgrade('/ws/KQXMZP', allowed[0])).toBe(101);
    expect(await upgrade('/ws/KQXMZP')).toBe(101); // no Origin: not a browser page
  });

  it('pipes WebSockets only: other upgrades are refused, and a refusal from the game server ends the pipe', async () => {
    expect(await upgrade('/ws/KQXMZP', undefined, { upgrade: 'h2c' })).toBe(400);
    expect(await upgrade('/ws/KQXMZP', undefined, { 'sec-websocket-key': 'short' })).toBe(400);
    expect(await upgrade('/ws/KQXMZP', undefined, { 'sec-websocket-version': '8' })).toBe(400);
    expect(await upgrade('/ws/REFUSE')).toBe(400);
  });

  it("sends the game server a clean handshake with the player's address", async () => {
    expect(await upgrade('/ws/KQXMZP', undefined, { 'cf-connecting-ip': '198.51.100.23', 'x-forwarded-for': '6.6.6.6', cookie: 'session=1' })).toBe(101);
    const seen = gameSeen.at(-1)!;
    expect(seen.xff).toBe('198.51.100.23'); // ours, not the client's own claim
    expect(seen.headers).not.toContain('cookie');
    expect(seen.headers).not.toContain('cf-connecting-ip');
    expect(await upgrade('/ws/KQXMZP')).toBe(101);
    expect(gameSeen.at(-1)!.xff).toBe('127.0.0.1'); // not through the tunnel: this machine
  });
});

describe('quick tunnel', () => {
  it('finds the public URL in cloudflared output', () => {
    expect(parseTunnelUrl('2026-10-17T16:00:00Z INF |  https://wealth-indicated-designer-jerusalem.trycloudflare.com                    |')).toBe(
      'https://wealth-indicated-designer-jerusalem.trycloudflare.com',
    );
    expect(parseTunnelUrl('INF Requesting new quick Tunnel on trycloudflare.com...')).toBeNull();
    expect(parseTunnelUrl('ERR failed to request quick Tunnel: Post "https://api.trycloudflare.com/tunnel"')).toBeNull();
  });
});

describe('clientIp', () => {
  const req = (remoteAddress: string, cf?: string) =>
    ({ socket: { remoteAddress }, headers: cf === undefined ? {} : { 'cf-connecting-ip': cf } }) as unknown as IncomingMessage;

  it("takes Cloudflare's address only from this Mac (cloudflared)", () => {
    expect(clientIp(req('127.0.0.1', '203.0.113.9'))).toBe('203.0.113.9');
    expect(clientIp(req('::ffff:127.0.0.1', '203.0.113.9'))).toBe('203.0.113.9');
    expect(clientIp(req('::1', '2001:db8::7'))).toBe('2001:db8::7');
  });

  it('ignores the header from a Wi-Fi player (--lan), so per-IP limits see the real socket', () => {
    expect(clientIp(req('192.168.18.23', '203.0.113.9'))).toBe('192.168.18.23');
    expect(clientIp(req('::ffff:192.168.18.23', '127.0.0.1'))).toBe('::ffff:192.168.18.23');
  });

  it('falls back to the socket for a missing or malformed header', () => {
    expect(clientIp(req('127.0.0.1'))).toBe('127.0.0.1');
    expect(clientIp(req('127.0.0.1', 'not an ip'))).toBe('127.0.0.1');
  });
});
