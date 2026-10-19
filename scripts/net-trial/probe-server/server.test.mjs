/**
 * The probe service (server.mjs): network prefixes, result checks, the /echo WebSocket against
 * Node's own WebSocket client, and the results endpoint (what is stored, and what never is).
 *   node --test scripts/net-trial/probe-server/
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { FrameReader, MAX_WS_PAYLOAD, acceptKey, createProbeServer, encodeFrame, expandIPv6, networkOf, parseAsName, parseOrigin, sanitizeResult } from './server.mjs';

const run = (over = {}) => ({
  id: 'run-12345678',
  trial: 'mf-trial',
  at: '2026-10-20T10:00:00.000Z',
  city: 'Lagos',
  network: 'mtn',
  isp: '',
  connection: 'mobile',
  device: 'Android phone',
  note: '',
  page: 'x.sslip.io',
  backgrounded: false,
  regions: {
    los: { connectMs: 120.44, sent: 4, rtts: [30.12, 31, null, 29], median: 30, p95: 31, jitter: 1, loss: 25 },
    jnb: { connectMs: 300, sent: 4, rtts: [90, 91, 92, 93], median: 91.5, p95: 93, jitter: 1, loss: 0 },
  },
  ...over,
});

describe('network prefixes (the address itself is never kept)', () => {
  it('IPv4 → its /24 and the Cymru name of the /24 base', () => {
    assert.deepEqual(networkOf('102.89.33.7'), { family: 4, prefix: '102.89.33.0/24', cymru: '0.33.89.102.origin.asn.cymru.com' });
    assert.equal(networkOf('::ffff:102.89.33.7')?.prefix, '102.89.33.0/24');
  });
  it('IPv6 → its /48', () => {
    assert.deepEqual(expandIPv6('2c0f:f4c0:1::5'), ['2c0f', 'f4c0', '0001', '0000', '0000', '0000', '0000', '0005']);
    const n = networkOf('2c0f:f4c0:1::5');
    assert.equal(n?.prefix, '2c0f:f4c0:0001::/48');
    assert.equal(n?.cymru, '1.0.0.0.0.c.4.f.f.0.c.2.origin6.asn.cymru.com');
    assert.equal(networkOf('not an ip'), null);
  });
  it('reads Team Cymru answers', () => {
    assert.deepEqual(parseOrigin('29465 | 102.89.0.0/16 | NG | afrinic | 2016-01-01'), { asn: 29465, cc: 'NG' });
    assert.deepEqual(parseOrigin('29465 36873 | 1.2.3.0/24 | ZA | afrinic | x'), { asn: 29465, cc: 'ZA' });
    assert.equal(parseOrigin('garbage'), null);
    assert.equal(parseAsName('29465 | NG | afrinic | 2004-01-01 | VCG-AS, NG'), 'VCG-AS, NG');
  });
});

describe('sanitizeResult', () => {
  it('keeps the typed fields and the measurements, drops anything else', () => {
    const r = sanitizeResult({ ...run(), ip: '1.2.3.4', userAgent: 'x', extra: { a: 1 } }, ['los', 'jnb']);
    assert.ok(r.ok);
    assert.equal(r.value.ip, undefined);
    assert.equal(r.value.userAgent, undefined);
    assert.equal(r.value.extra, undefined);
    assert.equal(r.value.regions.los.received, 3);
    assert.equal(r.value.regions.los.connectMs, 120.4);
    assert.deepEqual(r.value.regions.los.rtts, [30.1, 31, null, 29]);
  });
  it('needs a city, a known network and a device', () => {
    assert.equal(sanitizeResult(run({ city: '  ' }), ['los']).ok, false);
    assert.equal(sanitizeResult(run({ network: 'mtn-ng' }), ['los']).ok, false);
    assert.equal(sanitizeResult(run({ device: '' }), ['los']).ok, false);
    assert.equal(sanitizeResult(run({ regions: { fra: { sent: 3, rtts: [1, 2, 3] } } }), ['los', 'jnb']).ok, false);
    assert.equal(sanitizeResult([], ['los']).ok, false);
  });
  it('trims long or odd text and bad numbers', () => {
    const r = sanitizeResult(run({ city: `Port\u0000Harcourt${'x'.repeat(100)}`, id: 'bad id!', connection: 'carrier pigeon' }), ['los']);
    assert.ok(r.ok);
    assert.equal(r.value.city.length, 60);
    assert.ok(!r.value.city.includes('\u0000'));
    assert.match(r.value.id, /^[0-9a-f-]{36}$/);
    assert.equal(r.value.connection, '');
    const bad = sanitizeResult(run({ regions: { los: { sent: 2, rtts: [-5, 'x'], median: Infinity } } }), ['los']);
    assert.ok(bad.ok);
    assert.deepEqual(bad.value.regions.los.rtts, [null, null]);
    assert.equal(bad.value.regions.los.median, null);
  });
});

describe('frames', () => {
  it('reads masked client frames split across chunks', () => {
    const payload = Buffer.from('hello');
    const mask = Buffer.from([1, 2, 3, 4]);
    const masked = Buffer.from(payload.map((b, i) => b ^ mask[i & 3]));
    const frame = Buffer.concat([Buffer.from([0x82, 0x80 | payload.length]), mask, masked]);
    const r = new FrameReader();
    assert.deepEqual(r.push(frame.subarray(0, 3)), []);
    const [f] = r.push(frame.subarray(3));
    assert.equal(f.opcode, 2);
    assert.equal(f.payload.toString(), 'hello');
  });
  it('refuses unmasked or oversized frames', () => {
    assert.throws(() => new FrameReader().push(Buffer.from([0x82, 0x01, 0x00])), { closeCode: 1002 });
    const big = Buffer.from([0x82, 0x80 | 126, (MAX_WS_PAYLOAD + 1) >> 8, (MAX_WS_PAYLOAD + 1) & 255]);
    assert.throws(() => new FrameReader().push(big), { closeCode: 1009 });
  });
  it('encodes server frames and the handshake key (RFC 6455 §1.3 example)', () => {
    assert.deepEqual([...encodeFrame(1, Buffer.from('hi'))], [0x81, 2, 104, 105]);
    assert.equal(acceptKey('dGhlIHNhbXBsZSBub25jZQ=='), 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
  });
});

describe('the service', () => {
  let dir;
  let server;
  let base;
  const allowed = 'https://los.example';
  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'mf-probe-test-'));
    server = await createProbeServer({
      dataDir: dir,
      region: 'los',
      regionIds: ['los', 'jnb'],
      origins: [allowed, 'https://jnb.example'],
      trustProxy: true,
      salt: 'test-salt',
      exportToken: 'export-token-0123456789',
      lookupAsn: async (net) => (net.prefix === '102.89.33.0/24' ? { asn: 29465, cc: 'NG', asName: 'VCG-AS, NG' } : null),
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    base = `127.0.0.1:${server.address().port}`;
  });
  after(() => {
    server.close();
    server.closeAllConnections?.();
    rmSync(dir, { recursive: true, force: true });
  });

  const post = (body, headers = {}) =>
    fetch(`http://${base}/probe-api/results`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });

  it('echoes text and binary messages over /echo', async () => {
    const ws = new WebSocket(`ws://${base}/echo`);
    ws.binaryType = 'arraybuffer';
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = reject;
    });
    const got = [];
    const done = new Promise((resolve) => {
      ws.onmessage = (e) => {
        got.push(e.data);
        if (got.length === 2) resolve();
      };
    });
    ws.send('ping 1');
    ws.send(new Uint8Array([1, 2, 3, 250]));
    await done;
    assert.equal(got[0], 'ping 1');
    assert.deepEqual([...new Uint8Array(got[1])], [1, 2, 3, 250]);
    const closed = new Promise((resolve) => (ws.onclose = (e) => resolve(e.code)));
    ws.close(1000);
    assert.equal(await closed, 1000);
  });

  it('closes a socket that sends an oversized message (1009)', async () => {
    const ws = new WebSocket(`ws://${base}/echo`);
    await new Promise((resolve) => (ws.onopen = resolve));
    const closed = new Promise((resolve) => (ws.onclose = (e) => resolve(e.code)));
    ws.send(new Uint8Array(MAX_WS_PAYLOAD + 10));
    assert.equal(await closed, 1009);
  });

  it('refuses a socket from a page on another site', async () => {
    const status = await new Promise((resolve) => {
      const req = request({ host: '127.0.0.1', port: server.address().port, path: '/echo', headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==', Origin: 'https://evil.example' } });
      req.on('response', (res) => resolve(res.statusCode));
      req.on('upgrade', () => resolve(101));
      req.end();
    });
    assert.equal(status, 403);
  });

  it('saves a result with the network ASN and a salted prefix hash, never the address', async () => {
    const res = await post(run(), { origin: allowed, 'x-forwarded-for': '102.89.33.7' });
    assert.equal(res.status, 201);
    assert.equal(res.headers.get('access-control-allow-origin'), allowed);
    assert.deepEqual(await res.json(), { ok: true, id: 'run-12345678', asn: 29465, asName: 'VCG-AS, NG' });
    const raw = readFileSync(join(dir, 'results.jsonl'), 'utf8');
    assert.ok(!raw.includes('102.89.33'), 'no address or prefix in the file');
    const line = JSON.parse(raw.trim().split('\n').pop());
    assert.equal(line.via, 'los');
    assert.equal(line.net.asn, 29465);
    assert.match(line.net.prefixHash, /^[0-9a-f]{16}$/);
    assert.equal(line.city, 'Lagos');
    assert.deepEqual(line.regions.jnb.rtts, [90, 91, 92, 93]);
  });

  it('answers CORS preflights for the trial pages only', async () => {
    const ok = await fetch(`http://${base}/probe-api/results`, { method: 'OPTIONS', headers: { origin: 'https://jnb.example', 'access-control-request-method': 'POST' } });
    assert.equal(ok.status, 204);
    assert.equal(ok.headers.get('access-control-allow-origin'), 'https://jnb.example');
    const no = await post(run(), { origin: 'https://evil.example' });
    assert.equal(no.status, 403);
  });

  it('turns away bad bodies', async () => {
    assert.equal((await post('{nope')).status, 400);
    assert.equal((await post(run({ city: '' }))).status, 400);
    assert.equal((await post(JSON.stringify({ ...run(), note: 'x'.repeat(70_000) }))).status, 413);
    assert.equal((await fetch(`http://${base}/probe-api/results`)).status, 405);
    assert.equal((await fetch(`http://${base}/nope`)).status, 404);
  });

  it('rate-limits one network', async () => {
    let last = 0;
    for (let i = 0; i < 32; i++) last = (await post(run({ id: `rate-limit-${i}` }), { 'x-forwarded-for': '41.58.1.2' })).status;
    assert.equal(last, 429);
  });

  it('exports the results only with the token (path or bearer)', async () => {
    const byPath = await fetch(`http://${base}/probe-api/export/export-token-0123456789`);
    assert.equal(byPath.status, 200);
    const lines = (await byPath.text()).trim().split('\n');
    assert.ok(lines.length >= 1);
    assert.equal(JSON.parse(lines[0]).id, 'run-12345678');
    const byHeader = await fetch(`http://${base}/probe-api/export`, { headers: { authorization: 'Bearer export-token-0123456789' } });
    assert.equal(byHeader.status, 200);
    assert.equal((await fetch(`http://${base}/probe-api/export/wrong-token-0123456789`)).status, 404);
    assert.equal((await fetch(`http://${base}/probe-api/export`)).status, 404);
  });

  it('reports health', async () => {
    const h = await (await fetch(`http://${base}/probe-api/health`)).json();
    assert.equal(h.ok, true);
    assert.equal(h.region, 'los');
    assert.ok(h.saved >= 1);
  });
});
