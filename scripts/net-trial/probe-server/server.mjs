#!/usr/bin/env node
/**
 * The net trial's probe service (docs/net-trial.md): one per box, on 127.0.0.1 behind Caddy.
 *
 *   /echo                    WebSocket; every text or binary message goes straight back (the
 *                            probe page's 30 Hz pings measure the round trip through the same
 *                            Caddy → Node path the game's sockets take)
 *   POST /probe-api/results  one probe run (JSON, ≤ 64 KB) → one line in <data dir>/results.jsonl
 *   GET  /probe-api/health   {ok, region, saved, uptimeS}
 *   GET  /probe-api/export/<token>, or /probe-api/export with "Authorization: Bearer <token>":
 *                            the whole results.jsonl, for results.mjs (off without PROBE_EXPORT_TOKEN)
 *
 * No dependencies (node: modules only), so a box runs it straight from the bundle.
 *
 * Privacy: a result holds what the tester typed (city, network, device, an optional note) and the
 * measurements. The tester's IP address is never stored or logged: the service keeps only the
 * origin ASN of their /24 (IPv4) or /48 (IPv6) network, looked up in Team Cymru's DNS by the
 * network's base address (so not even that DNS query carries the full address), and an HMAC of the
 * same network prefix under a random per-box salt, to count distinct networks and rate-limit posts.
 * ASN_LOOKUP=0 turns the lookup off.
 *
 * Environment: PORT (9300) · HOST (127.0.0.1) · PROBE_DATA_DIR (./.probe-data) · PROBE_REGION (this
 * box's region id, e.g. los) · PROBE_REGIONS (region ids a result may carry: los,jnb) · PROBE_ORIGINS
 * (pages that may post and open /echo: https://a,https://b; empty = any) · TRUST_PROXY=1 (the client
 * address is the last X-Forwarded-For entry: only behind Caddy) · ASN_LOOKUP (1) · PROBE_EXPORT_TOKEN
 * (16+ characters; unset = no export).
 */
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { Resolver } from 'node:dns/promises';
import { createReadStream } from 'node:fs';
import { appendFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { isIPv4, isIPv6 } from 'node:net';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
/** a ping is a few dozen bytes; anything bigger than this is not ours */
export const MAX_WS_PAYLOAD = 4096;
const MAX_BODY = 64 * 1024;
const MAX_FILE_BYTES = 200 * 1024 * 1024;
const IDLE_MS = 120_000;
const MAX_SOCKETS = 2000;
const MAX_SOCKETS_PER_NET = 24;
const POSTS_PER_WINDOW = 30;
const POST_WINDOW_MS = 10 * 60_000;

export const NETWORKS = ['mtn', 'airtel', 'glo', '9mobile', 'fibre', 'starlink', 'other'];
export const CONNECTIONS = ['mobile', 'wifi', 'ethernet', ''];

// ---------- addresses → network prefixes (never stored) ----------

/** "2001:db8::1" → eight 4-digit groups; null when it isn't an IPv6 address. */
export function expandIPv6(addr) {
  if (!isIPv6(addr)) return null;
  let a = addr.toLowerCase().split('%')[0];
  // an embedded IPv4 tail (::ffff:1.2.3.4) as two groups
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(a);
  if (v4) {
    const p = v4[1].split('.').map(Number);
    a = a.slice(0, -v4[1].length) + ((p[0] << 8) | p[1]).toString(16) + ':' + ((p[2] << 8) | p[3]).toString(16);
  }
  const [head, tail] = a.includes('::') ? a.split('::') : [a, null];
  const h = head ? head.split(':') : [];
  const t = tail === null ? [] : tail ? tail.split(':') : [];
  const fill = tail === null ? 0 : 8 - h.length - t.length;
  const groups = [...h, ...Array(fill).fill('0'), ...t];
  return groups.length === 8 ? groups.map((g) => g.padStart(4, '0')) : null;
}

/** The client's network: an IPv4 /24 or an IPv6 /48 (IPv4-mapped IPv6 counts as IPv4). */
export function networkOf(ip) {
  const s = String(ip ?? '').trim();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(s);
  const v4 = mapped ? mapped[1] : s;
  if (isIPv4(v4)) {
    const [a, b, c] = v4.split('.');
    return { family: 4, prefix: `${a}.${b}.${c}.0/24`, cymru: `0.${c}.${b}.${a}.origin.asn.cymru.com` };
  }
  const g = expandIPv6(s);
  if (!g) return null;
  const nibbles = g.slice(0, 3).join('').split('');
  return { family: 6, prefix: `${g.slice(0, 3).join(':')}::/48`, cymru: `${nibbles.reverse().join('.')}.origin6.asn.cymru.com` };
}

/** The client address: the socket's, or with trustProxy the last X-Forwarded-For entry (Caddy's). */
export function clientAddress(req, trustProxy) {
  const xff = req.headers['x-forwarded-for'];
  if (trustProxy && typeof xff === 'string' && xff.trim()) return xff.split(',').pop().trim();
  return req.socket.remoteAddress ?? '';
}

/** "36873 | 102.89.0.0/16 | NG | afrinic | 2016-01-01" → { asn: 36873, cc: 'NG' } */
export function parseOrigin(txt) {
  const parts = String(txt).split('|').map((p) => p.trim());
  const asn = Number(parts[0]?.split(/\s+/)[0]);
  return Number.isInteger(asn) && asn > 0 ? { asn, cc: /^[A-Z]{2}$/.test(parts[2] ?? '') ? parts[2] : '' } : null;
}

/** "36873 | NG | afrinic | 2007-02-08 | CELTEL-NIGERIA, NG" → "CELTEL-NIGERIA, NG" */
export function parseAsName(txt) {
  const parts = String(txt).split('|').map((p) => p.trim());
  return (parts[4] ?? '').slice(0, 80);
}

/** ASN lookups through Team Cymru's DNS, cached per network prefix. */
export function cymruLookup({ timeoutMs = 1500 } = {}) {
  const resolver = new Resolver({ timeout: timeoutMs, tries: 1 });
  const cache = new Map();
  const txt = async (name) => (await resolver.resolveTxt(name)).map((r) => r.join(''))[0] ?? '';
  return async (net) => {
    if (cache.has(net.prefix)) return cache.get(net.prefix);
    let out = null;
    try {
      const origin = parseOrigin(await txt(net.cymru));
      if (origin) {
        let asName = '';
        try {
          asName = parseAsName(await txt(`AS${origin.asn}.asn.cymru.com`));
        } catch {
          /* the number alone will do */
        }
        out = { ...origin, asName };
      }
    } catch {
      out = null;
    }
    if (cache.size > 5000) cache.clear();
    cache.set(net.prefix, out);
    return out;
  };
}

// ---------- results ----------

// control characters (C0 and DEL) become spaces
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/g;
const text = (v, max) => (typeof v === 'string' ? v.replace(CONTROL, ' ').trim().slice(0, max) : '');
const num = (v, min, max) => (typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? v : null);
const round1 = (v) => Math.round(v * 10) / 10;

/**
 * A posted run, checked and trimmed to the fields the trial keeps; anything else is dropped.
 * `regionIds`: the regions a result may carry. Returns { ok, value } or { ok: false, error }.
 */
export function sanitizeResult(raw, regionIds) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'expected a JSON object' };
  const city = text(raw.city, 60);
  const network = NETWORKS.includes(raw.network) ? raw.network : '';
  const device = text(raw.device, 40);
  if (!city) return { ok: false, error: 'city is required' };
  if (!network) return { ok: false, error: `network must be one of ${NETWORKS.join(', ')}` };
  if (!device) return { ok: false, error: 'device is required' };
  const regions = {};
  for (const id of regionIds) {
    const r = raw.regions?.[id];
    if (!r || typeof r !== 'object') continue;
    const rtts = Array.isArray(r.rtts) ? r.rtts.slice(0, 1000).map((x) => (num(x, 0, 60_000) === null ? null : round1(x))) : [];
    const sent = num(r.sent, 0, 1000) ?? rtts.length;
    const received = rtts.filter((x) => x !== null).length;
    if (!sent) continue;
    regions[id] = {
      connectMs: num(r.connectMs, 0, 120_000) === null ? null : round1(r.connectMs),
      sent,
      received,
      rtts,
      median: num(r.median, 0, 60_000),
      p95: num(r.p95, 0, 60_000),
      jitter: num(r.jitter, 0, 60_000),
      loss: num(r.loss, 0, 100),
      error: text(r.error, 120),
    };
  }
  if (!Object.keys(regions).length) return { ok: false, error: 'no measurements' };
  const at = text(raw.at, 40);
  return {
    ok: true,
    value: {
      v: 1,
      id: typeof raw.id === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(raw.id) ? raw.id : randomUUID(),
      trial: text(raw.trial, 40),
      at: Number.isNaN(Date.parse(at)) ? '' : at,
      city,
      network,
      isp: text(raw.isp, 60),
      connection: CONNECTIONS.includes(raw.connection) ? raw.connection : '',
      device,
      note: text(raw.note, 200),
      page: text(raw.page, 100),
      backgrounded: raw.backgrounded === true,
      regions,
    },
  };
}

// ---------- WebSocket echo (RFC 6455, unfragmented frames only) ----------

export function acceptKey(key) {
  return createHash('sha1').update(key + WS_GUID).digest('base64');
}

/** A server frame (never masked). */
export function encodeFrame(opcode, payload = Buffer.alloc(0)) {
  const len = payload.length;
  const head = len < 126 ? Buffer.from([0x80 | opcode, len]) : Buffer.from([0x80 | opcode, 126, len >> 8, len & 255]);
  return Buffer.concat([head, payload]);
}

/**
 * Client frames out of a byte stream. `push(chunk)` returns the complete frames so far as
 * { opcode, fin, payload } (unmasked), or throws { closeCode } for anything this echo won't take.
 */
export class FrameReader {
  buf = Buffer.alloc(0);
  push(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    const frames = [];
    for (;;) {
      const b = this.buf;
      if (b.length < 2) break;
      const fin = (b[0] & 0x80) !== 0;
      const opcode = b[0] & 0x0f;
      if (b[0] & 0x70) throw { closeCode: 1002 };
      if (!(b[1] & 0x80)) throw { closeCode: 1002 }; // clients must mask
      let len = b[1] & 0x7f;
      let off = 2;
      if (len === 127) throw { closeCode: 1009 };
      if (len === 126) {
        if (b.length < 4) break;
        len = b.readUInt16BE(2);
        off = 4;
      }
      if (len > MAX_WS_PAYLOAD) throw { closeCode: 1009 };
      if (b.length < off + 4 + len) break;
      const mask = b.subarray(off, off + 4);
      const payload = Buffer.allocUnsafe(len);
      for (let i = 0; i < len; i++) payload[i] = b[off + 4 + i] ^ mask[i & 3];
      frames.push({ opcode, fin, payload });
      this.buf = b.subarray(off + 4 + len);
    }
    if (this.buf.length > MAX_WS_PAYLOAD + 16) throw { closeCode: 1009 };
    return frames;
  }
}

function refuse(socket, status, text) {
  socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

// ---------- the service ----------

/**
 * The probe service as an http.Server (not yet listening).
 * options: { dataDir, region, regionIds, origins, trustProxy, lookupAsn (net → {asn, cc, asName} | null), salt, exportToken, log }
 */
export async function createProbeServer(options) {
  const dataDir = options.dataDir;
  const regionIds = options.regionIds ?? ['los', 'jnb'];
  const origins = options.origins ?? [];
  const trustProxy = options.trustProxy ?? false;
  const lookupAsn = options.lookupAsn ?? (async () => null);
  const log = options.log ?? (() => {});
  await mkdir(dataDir, { recursive: true, mode: 0o750 });
  const resultsFile = join(dataDir, 'results.jsonl');
  let salt = options.salt;
  if (!salt) {
    const saltFile = join(dataDir, 'salt');
    try {
      salt = (await readFile(saltFile, 'utf8')).trim();
    } catch {
      salt = randomBytes(32).toString('hex');
      await writeFile(saltFile, `${salt}\n`, { mode: 0o600 });
    }
  }
  const netHash = (net) => createHmac('sha256', salt).update(net.prefix).digest('hex').slice(0, 16);
  const started = Date.now();
  let saved = 0;
  let writing = Promise.resolve();
  const posts = new Map();
  const socketsPerNet = new Map();
  let sockets = 0;

  const exportDigest = options.exportToken && options.exportToken.length >= 16 ? createHash('sha256').update(options.exportToken).digest() : null;
  /** the export token, compared in constant time */
  const exportOk = (given) => exportDigest !== null && typeof given === 'string' && timingSafeEqual(createHash('sha256').update(given).digest(), exportDigest);
  const originOk = (origin) => origin === undefined || origins.length === 0 || origins.includes(origin);
  const cors = (origin) => (origin && originOk(origin) ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : {});
  const json = (res, status, body, origin) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...cors(origin) });
    res.end(JSON.stringify(body));
  };

  const server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    const origin = req.headers.origin;
    if (path === '/probe-api/health' && (req.method === 'GET' || req.method === 'HEAD')) {
      return json(res, 200, { ok: true, region: options.region ?? '', saved, uptimeS: Math.round((Date.now() - started) / 1000) }, origin);
    }
    if (path === '/probe-api/export' || path.startsWith('/probe-api/export/')) {
      const auth = /^Bearer (.+)$/.exec(String(req.headers.authorization ?? ''))?.[1];
      const given = path.startsWith('/probe-api/export/') ? decodeURIComponent(path.slice('/probe-api/export/'.length)) : auth;
      if (req.method !== 'GET' || !exportOk(given)) return json(res, 404, { error: 'not found' });
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' });
      createReadStream(resultsFile)
        .on('error', () => res.end())
        .pipe(res);
      return;
    }
    if (path !== '/probe-api/results') return json(res, 404, { error: 'not found' }, origin);
    if (!originOk(origin)) return json(res, 403, { error: 'origin not allowed' });
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { ...cors(origin), 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': 'content-type', 'Access-Control-Max-Age': '600' });
      return res.end();
    }
    if (req.method !== 'POST') return json(res, 405, { error: 'POST only' }, origin);
    const net = networkOf(clientAddress(req, trustProxy));
    const key = net ? netHash(net) : 'unknown';
    const now = Date.now();
    if (posts.size > 10_000) posts.clear();
    let slot = posts.get(key);
    if (!slot || now - slot.since >= POST_WINDOW_MS) posts.set(key, (slot = { since: now, count: 0 }));
    if (slot.count >= POSTS_PER_WINDOW) return json(res, 429, { error: 'too many results from this network; try again later' }, origin);
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        json(res, 413, { error: 'too big' }, origin);
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', async () => {
      if (size > MAX_BODY) return;
      let raw;
      try {
        raw = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        return json(res, 400, { error: 'not JSON' }, origin);
      }
      const checked = sanitizeResult(raw, regionIds);
      if (!checked.ok) return json(res, 400, { error: checked.error }, origin);
      slot.count++;
      const asn = net ? await lookupAsn(net) : null;
      const record = {
        ...checked.value,
        receivedAt: new Date().toISOString(),
        via: options.region ?? '',
        net: { family: net?.family ?? null, prefixHash: net ? key : null, asn: asn?.asn ?? null, asName: asn?.asName ?? '', cc: asn?.cc ?? '' },
      };
      try {
        const size = await stat(resultsFile).then((s) => s.size, () => 0);
        if (size > MAX_FILE_BYTES) return json(res, 507, { error: 'the results file is full' }, origin);
        writing = writing.then(() => appendFile(resultsFile, `${JSON.stringify(record)}\n`, { mode: 0o640 }));
        await writing;
      } catch (e) {
        log(`[probe] could not save a result: ${e.message}`);
        return json(res, 500, { error: 'could not save' }, origin);
      }
      saved++;
      json(res, 201, { ok: true, id: record.id, asn: record.net.asn, asName: record.net.asName }, origin);
    });
  });

  server.on('upgrade', (req, socket, head) => {
    const path = (req.url ?? '/').split('?')[0];
    if (path !== '/echo') return refuse(socket, 404, 'Not Found');
    const key = String(req.headers['sec-websocket-key'] ?? '');
    if (
      req.method !== 'GET' ||
      String(req.headers.upgrade ?? '').toLowerCase() !== 'websocket' ||
      req.headers['sec-websocket-version'] !== '13' ||
      !/^[A-Za-z0-9+/]{22}==$/.test(key)
    )
      return refuse(socket, 400, 'Bad Request');
    if (!originOk(req.headers.origin)) return refuse(socket, 403, 'Forbidden');
    const net = networkOf(clientAddress(req, trustProxy));
    const netKey = net ? netHash(net) : 'unknown';
    const mine = socketsPerNet.get(netKey) ?? 0;
    if (sockets >= MAX_SOCKETS || mine >= MAX_SOCKETS_PER_NET) return refuse(socket, 503, 'Busy');
    sockets++;
    socketsPerNet.set(netKey, mine + 1);
    let counted = true;
    const uncount = () => {
      if (!counted) return;
      counted = false;
      sockets--;
      const n = (socketsPerNet.get(netKey) ?? 1) - 1;
      if (n > 0) socketsPerNet.set(netKey, n);
      else socketsPerNet.delete(netKey);
    };
    socket.on('close', uncount);
    socket.on('error', () => socket.destroy());
    socket.setNoDelay(true);
    socket.setTimeout(IDLE_MS, () => socket.destroy());
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`);
    const reader = new FrameReader();
    let closing = false;
    const close = (code) => {
      if (closing) return;
      closing = true;
      const p = Buffer.alloc(2);
      p.writeUInt16BE(code);
      socket.end(encodeFrame(0x8, p));
    };
    const onData = (chunk) => {
      if (closing) return;
      let frames;
      try {
        frames = reader.push(chunk);
      } catch (e) {
        return close(e.closeCode ?? 1002);
      }
      for (const f of frames) {
        if (!f.fin || f.opcode === 0x0) return close(1003); // no fragments: pings are tiny
        if (f.opcode === 0x1 || f.opcode === 0x2) socket.write(encodeFrame(f.opcode, f.payload));
        else if (f.opcode === 0x9) socket.write(encodeFrame(0xa, f.payload));
        else if (f.opcode === 0x8) return close(f.payload.length >= 2 ? f.payload.readUInt16BE(0) : 1000);
        else if (f.opcode !== 0xa) return close(1002);
      }
    };
    if (head?.length) onData(head);
    socket.on('data', onData);
  });

  return server;
}

// ---------- run ----------

async function main() {
  const env = process.env;
  const list = (s) =>
    String(s ?? '')
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean);
  const port = Number(env.PORT ?? 9300);
  const host = env.HOST ?? '127.0.0.1';
  const region = env.PROBE_REGION ?? '';
  const server = await createProbeServer({
    dataDir: env.PROBE_DATA_DIR ?? '.probe-data',
    region,
    regionIds: list(env.PROBE_REGIONS ?? 'los,jnb'),
    origins: list(env.PROBE_ORIGINS),
    trustProxy: env.TRUST_PROXY === '1' || env.TRUST_PROXY === 'true',
    lookupAsn: env.ASN_LOOKUP === '0' ? undefined : cymruLookup(),
    exportToken: env.PROBE_EXPORT_TOKEN,
    log: (l) => console.log(l),
  });
  server.listen(port, host, () => console.log(`[probe] ${region || 'probe'} on http://${host}:${port}: /echo, /probe-api/results, /probe-api/health`));
  for (const signal of ['SIGINT', 'SIGTERM'])
    process.on(signal, () => {
      server.close();
      // open /echo sockets don't hold the exit up for long
      setTimeout(() => process.exit(0), 500).unref();
    });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
