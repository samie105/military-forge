/**
 * One local port for the whole public playtest (pnpm playtest):
 *   /api/*        → the API (prefix stripped), any method
 *   /ws/<code>    → the game server's WebSocket (upgraded; wss:// through the tunnel)
 *   /r/<code>, /  → the app (index.html: it reads the room from the path)
 *   anything else → a file from the production build, or 404
 *
 * Only the built files are served (never the Vite dev server), every response carries security
 * headers (a CSP among them), and a game WebSocket from a page on another site is refused.
 * It listens on 127.0.0.1 only: the tunnel reaches it locally, the LAN doesn't.
 */
import { createReadStream, readFileSync, statSync, type Stats } from 'node:fs';
import { createServer, request, type IncomingHttpHeaders, type IncomingMessage, type OutgoingHttpHeaders, type Server, type ServerResponse } from 'node:http';
import { connect, type Socket } from 'node:net';
import { extname, resolve, sep } from 'node:path';
import type { Duplex } from 'node:stream';
import { brotliCompressSync, constants as zlib, gzipSync } from 'node:zlib';

export interface Upstream {
  host: string;
  port: number;
}

export interface ProxyOptions {
  /** the production build (apps/web/dist) */
  root: string;
  api: Upstream;
  game: Upstream;
  /** pages that may open game WebSockets and call the API: the public origin and the local ones (read per request: the tunnel URL comes later and can change) */
  allowedOrigins: () => readonly string[];
  /**
   * The Origin the API is configured to trust (its CORS/CSRF allow-list). A browser request from an
   * allowed origin reaches the API with this Origin instead, so the API's config never has to
   * follow the tunnel's address; anything else is refused here with the API's 403.
   */
  apiOrigin?: string;
  log?: (line: string) => void;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.bin': 'application/octet-stream',
  '.ktx2': 'image/ktx2',
  '.wasm': 'application/wasm',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
};

/** Hop-by-hop headers (RFC 9110 §7.6.1) never cross a proxy. */
const HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade']);

/** The headers that go on: not the hop-by-hop ones, nor any the sender listed in its own `Connection` header. */
export function endToEnd(headers: IncomingHttpHeaders): OutgoingHttpHeaders {
  const listed = new Set(
    String(headers.connection ?? '')
      .toLowerCase()
      .split(',')
      .map((h) => h.trim())
      .filter(Boolean),
  );
  const out: OutgoingHttpHeaders = {};
  for (const [k, v] of Object.entries(headers)) if (v !== undefined && !HOP.has(k) && !listed.has(k)) out[k] = v;
  return out;
}

const IP = /^[0-9a-fA-F.:]{2,45}$/;

/**
 * The player's address: Cloudflare's CF-Connecting-IP when the request came through the tunnel
 * (only cloudflared and this Mac can reach the proxy: it listens on 127.0.0.1), else the socket's.
 */
export function clientIp(req: IncomingMessage): string {
  const cf = req.headers['cf-connecting-ip'];
  const fromCf = typeof cf === 'string' ? cf.trim() : '';
  return IP.test(fromCf) ? fromCf : (req.socket.remoteAddress ?? '');
}

/** Security headers for the app's pages and files (the API adds its own). */
export function securityHeaders(host: string | undefined): Record<string, string> {
  const ws = host && /^[a-z0-9.-]+(:\d+)?$/i.test(host) ? ` wss://${host} ws://${host}` : '';
  return {
    'Content-Security-Policy': [
      "default-src 'self'",
      // WebAssembly: three's meshopt decoder
      "script-src 'self' 'wasm-unsafe-eval'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "font-src 'self' data:",
      "media-src 'self' data: blob:",
      `connect-src 'self' data: blob:${ws}`,
      "worker-src 'self' blob:",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ].join('; '),
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'same-origin',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  };
}

/** `/r/<code>` and `/` are the app; a path with a dot-segment or a NUL is never a file. */
export function staticPath(root: string, pathname: string): { kind: 'app' } | { kind: 'file'; file: string } | { kind: 'none' } {
  if (pathname === '/' || pathname === '/index.html' || /^\/r\/[^/]+\/?$/.test(pathname)) return { kind: 'app' };
  if (pathname.includes('\0') || pathname.split('/').some((part) => part.startsWith('.'))) return { kind: 'none' };
  const file = resolve(root, `.${pathname}`);
  if (!file.startsWith(root + sep)) return { kind: 'none' };
  return { kind: 'file', file };
}

/** Vite's build output (/assets/<name>-<hash>.<ext>) never changes under one name; public/ files (/assets/characters/…) can. */
export function isHashedAsset(pathname: string): boolean {
  return /^\/assets\/[^/]+-[A-Za-z0-9_-]{8}\.[a-z0-9]+$/.test(pathname);
}

function send(res: ServerResponse, status: number, body: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}

/** Worth compressing: text, and glTF binaries (their JSON chunk and meshopt buffers still shrink). */
const COMPRESSIBLE = new Set(['.html', '.js', '.mjs', '.css', '.json', '.webmanifest', '.txt', '.svg', '.glb', '.gltf', '.bin', '.wasm']);
const MAX_COMPRESS_BYTES = 8 * 1024 * 1024;

type Encoding = 'br' | 'gzip';
/** Compressed copies, made on first request (the build doesn't change while the playtest runs). */
const compressed = new Map<string, Buffer>();

/**
 * The encoding to send, from Accept-Encoding: brotli, else gzip, else none. The host's upload is
 * the bottleneck of a tunnel playtest, so the game's ~1.6 MB of scripts and models leave as ~0.5 MB.
 */
export function pickEncoding(acceptEncoding: string | undefined, file: string, size: number): Encoding | null {
  if (!COMPRESSIBLE.has(extname(file).toLowerCase()) || size < 512 || size > MAX_COMPRESS_BYTES) return null;
  const accepted = (acceptEncoding ?? '').split(',').map((e) => e.trim().split(';')[0]!.toLowerCase());
  if (accepted.includes('br')) return 'br';
  if (accepted.includes('gzip')) return 'gzip';
  return null;
}

function compressedFile(file: string, etag: string, encoding: Encoding): Buffer {
  const key = `${encoding}:${file}:${etag}`;
  let body = compressed.get(key);
  if (!body) {
    const raw = readFileSync(file);
    body =
      encoding === 'br'
        ? brotliCompressSync(raw, { params: { [zlib.BROTLI_PARAM_QUALITY]: 9, [zlib.BROTLI_PARAM_SIZE_HINT]: raw.length } })
        : gzipSync(raw, { level: 9 });
    compressed.set(key, body);
  }
  return body;
}

function serveFile(req: IncomingMessage, res: ServerResponse, file: string, stats: Stats, immutable: boolean): void {
  const etag = `W/"${stats.size.toString(16)}-${Math.floor(stats.mtimeMs).toString(16)}"`;
  const encoding = pickEncoding(req.headers['accept-encoding'], file, stats.size);
  const headers: Record<string, string> = {
    ...securityHeaders(req.headers.host),
    'Content-Type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
    'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
    ETag: etag,
    Vary: 'Accept-Encoding',
  };
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, headers);
    res.end();
    return;
  }
  if (encoding) {
    let body: Buffer;
    try {
      body = compressedFile(file, etag, encoding);
    } catch {
      res.destroy();
      return;
    }
    res.writeHead(200, { ...headers, 'Content-Encoding': encoding, 'Content-Length': String(body.length) });
    res.end(req.method === 'HEAD' ? undefined : body);
    return;
  }
  res.writeHead(200, { ...headers, 'Content-Length': String(stats.size) });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  createReadStream(file)
    .on('error', () => res.destroy())
    .pipe(res);
}

let lastApiError = 0;

function proxyApi(req: IncomingMessage, res: ServerResponse, api: Upstream, path: string, log: (line: string) => void, origins: readonly string[], apiOrigin?: string): void {
  const headers = endToEnd(req.headers);
  const origin = req.headers.origin;
  if (origin !== undefined && apiOrigin) {
    if (!origins.includes(origin)) {
      send(res, 403, JSON.stringify({ error: { code: 'origin_not_allowed', message: `Origin ${origin} may not call this API` } }), { 'Content-Type': 'application/json' });
      return;
    }
    headers.origin = apiOrigin;
  }
  const upstream = request({ host: api.host, port: api.port, method: req.method, path, headers }, (answer) => {
    res.writeHead(answer.statusCode ?? 502, endToEnd(answer.headers));
    answer.pipe(res);
  });
  // the player went away (a closed tab, a dropped tunnel): stop the API's work for them too
  res.on('close', () => {
    if (!res.writableFinished) upstream.destroy();
  });
  upstream.on('error', (e) => {
    // once per 10 s at most: a down API would otherwise flood the console
    if (Date.now() - lastApiError > 10_000) log(`[proxy] API unreachable: ${e.message}`);
    lastApiError = Date.now();
    if (!res.headersSent) send(res, 502, JSON.stringify({ error: { code: 'bad_gateway', message: 'The API is not answering' } }), { 'Content-Type': 'application/json' });
    else res.destroy();
  });
  req.pipe(upstream);
}

function refuseUpgrade(socket: Duplex, status: number, text: string): void {
  socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

/** A WebSocket handshake, or nothing: GET, `Upgrade: websocket`, version 13 and a 16-byte key. */
export function isWebSocketUpgrade(req: IncomingMessage): boolean {
  return (
    req.method === 'GET' &&
    String(req.headers.upgrade ?? '').toLowerCase() === 'websocket' &&
    req.headers['sec-websocket-version'] === '13' &&
    /^[A-Za-z0-9+/]{22}==$/.test(String(req.headers['sec-websocket-key'] ?? ''))
  );
}

/** Only these reach the game server, and X-Forwarded-For is ours: the player's address (clientIp). */
const WS_HEADERS = ['host', 'origin', 'user-agent', 'sec-websocket-key', 'sec-websocket-version', 'sec-websocket-protocol'];

/**
 * TCP pipe to the game server for one WebSocket: a fresh, minimal handshake request goes up; what
 * comes back must be `101 Switching Protocols` before anything else is relayed either way (any
 * other answer is passed on and the pipe closed), so this can't tunnel some other protocol.
 */
function proxyWebSocket(req: IncomingMessage, socket: Duplex, head: Buffer, game: Upstream): void {
  const upstream: Socket = connect(game.port, game.host);
  /** the handshake went through: both ways are piped, and either side closing ends both */
  let piped = false;
  const close = () => {
    socket.destroy();
    upstream.destroy();
  };
  upstream.setNoDelay(true);
  (socket as Socket).setNoDelay?.(true);
  upstream.on('connect', () => {
    let lines = `GET ${req.url} HTTP/1.1\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n`;
    for (const name of WS_HEADERS) {
      const value = req.headers[name];
      if (typeof value === 'string' && !/[\r\n]/.test(value)) lines += `${name}: ${value}\r\n`;
    }
    lines += `X-Forwarded-For: ${clientIp(req)}\r\n`;
    upstream.write(`${lines}\r\n`);
    let answer = Buffer.alloc(0);
    const onAnswer = (chunk: Buffer) => {
      answer = Buffer.concat([answer, chunk]);
      const end = answer.indexOf('\r\n\r\n');
      if (end < 0) {
        if (answer.length > 16 * 1024) close();
        return;
      }
      upstream.off('data', onAnswer);
      const status = /^HTTP\/1\.1 (\d{3}) /.exec(answer.subarray(0, end).toString('latin1'))?.[1];
      if (status !== '101') {
        // refused: the client gets the status (our own short answer, closing); nothing goes through
        upstream.destroy();
        refuseUpgrade(socket, status && status !== '200' ? Number(status) : 502, status ? 'Refused' : 'Bad Gateway');
        return;
      }
      piped = true;
      socket.write(answer);
      if (head.length) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    };
    upstream.on('data', onAnswer);
  });
  upstream.on('error', () => {}); // 'close' follows
  // a live pipe ends with its upstream; before the handshake the client gets an answer (unless it has one)
  upstream.on('close', () => {
    if (piped) close();
    else if (!socket.writableEnded) refuseUpgrade(socket, 502, 'Bad Gateway');
  });
  socket.on('error', close);
  socket.on('close', close);
}

export function createProxy(options: ProxyOptions): Server {
  const root = resolve(options.root);
  const log = options.log ?? (() => {});
  const server = createServer((req, res) => {
    let url: URL;
    let pathname: string;
    try {
      url = new URL(req.url ?? '/', 'http://proxy');
      pathname = decodeURIComponent(url.pathname);
    } catch {
      send(res, 400, 'Bad request');
      return;
    }
    // routed and forwarded by the same, normalised path (dot-segments resolved, still percent-encoded)
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      proxyApi(req, res, options.api, `${url.pathname.slice('/api'.length) || '/'}${url.search}`, log, options.allowedOrigins(), options.apiOrigin);
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      send(res, 405, 'Method not allowed', { Allow: 'GET, HEAD' });
      return;
    }
    const target = staticPath(root, pathname);
    const file = target.kind === 'app' ? resolve(root, 'index.html') : target.kind === 'file' ? target.file : null;
    let stats: Stats | null;
    try {
      stats = file ? statSync(file) : null;
    } catch {
      stats = null;
    }
    if (!file || !stats?.isFile()) {
      send(res, 404, 'Not found', securityHeaders(req.headers.host));
      return;
    }
    serveFile(req, res, file, stats, target.kind === 'file' && isHashedAsset(pathname));
  });

  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const path = (req.url ?? '/').split('?')[0]!;
    if (!/^\/ws(\/|$)/.test(path)) return refuseUpgrade(socket, 404, 'Not Found');
    if (!isWebSocketUpgrade(req)) return refuseUpgrade(socket, 400, 'Bad Request');
    const origin = req.headers.origin;
    // a page on another site can't open game sockets in a visitor's name
    if (origin && !options.allowedOrigins().includes(origin)) {
      log(`[proxy] refused a game socket from ${origin}`);
      return refuseUpgrade(socket, 403, 'Forbidden');
    }
    proxyWebSocket(req, socket, head, options.game);
  });
  return server;
}
