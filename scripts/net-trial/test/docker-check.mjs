/**
 * Checks a box set up by cloud-init.sh in the local test container (docker-test.sh): every public
 * route through Caddy, the owner's private links, the probe's echo and results, and the origin checks.
 *   node scripts/net-trial/test/docker-check.mjs <container>
 * Caddy's internal CA signs the test certificate, so these requests skip certificate checks.
 */
import { execFileSync } from 'node:child_process';
import { request } from 'node:https';

const container = process.argv[2] ?? 'mf-trial-test';
const origin = 'https://127-0-0-1.sslip.io:8443';
const sh = (cmd) => execFileSync('docker', ['exec', container, 'sh', '-c', cmd], { encoding: 'utf8' });
const secrets = Object.fromEntries(
  sh('cat /etc/military-forge/secrets')
    .trim()
    .split('\n')
    .map((l) => l.split('=')),
);
const room = sh('cat /etc/military-forge/room-code').trim();
let failed = 0;
const check = (what, ok, detail = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}${ok || !detail ? '' : `: ${detail}`}`);
  if (!ok) failed++;
};
// the host name resolves to 127.0.0.1 here whatever the local DNS thinks of it (SNI and Host stay real)
const lookup = (_host, opts, cb) => (opts?.all ? cb(null, [{ address: '127.0.0.1', family: 4 }]) : cb(null, '127.0.0.1', 4));
const call = (path, { method = 'GET', headers = {}, body } = {}) =>
  new Promise((resolve, reject) => {
    const req = request(origin + path, { method, headers, lookup, rejectUnauthorized: false }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (text += c));
      res.on('end', () => resolve({ status: res.statusCode, headers: { get: (k) => res.headers[k.toLowerCase()] }, text, json: () => JSON.parse(text) }));
    });
    req.on('error', reject);
    req.end(body);
  });
const get = (path, init = {}) => call(path, init);
const post = (path, body, headers = {}) => call(path, { method: 'POST', headers: { 'content-type': 'application/json', origin, ...headers }, body: JSON.stringify(body) });
/** A WebSocket upgrade with a given Origin: its status (101 = accepted) and, when accepted, the socket. */
const upgrade = (path, from, keep = false) =>
  new Promise((resolve) => {
    const req = request(`${origin}${path}`, {
      lookup,
      rejectUnauthorized: false,
      headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==', Origin: from },
    });
    req.on('upgrade', (_res, socket) => {
      if (!keep) socket.destroy();
      resolve(keep ? { status: 101, socket } : 101);
    });
    req.on('response', (res) => resolve(keep ? { status: res.statusCode } : res.statusCode));
    req.on('error', (e) => resolve(keep ? { status: e.message } : e.message));
    req.end();
  });

const status = await get('/trial-status/');
check('public status page says ready, with the room link', status.status === 200 && status.text.includes('<b>ready</b>') && status.text.includes(`${origin}/r/${room}`), status.text.slice(0, 300));
check('the public status page has no secrets', !status.text.includes(secrets.ADMIN_TOKEN) && !status.text.includes(secrets.OWNER) && !status.text.includes(secrets.EXPORT_TOKEN));
const owner = await get(`/owner-${secrets.OWNER}/`);
check("owner's page has the admin link and the results export", owner.status === 200 && owner.text.includes(`/admin#t=${secrets.ADMIN_TOKEN}`) && owner.text.includes(`/probe-api/export/${secrets.EXPORT_TOKEN}`));
check('a wrong owner path is a 404', (await get('/owner-0123456789abcdef01234567/')).status === 404);

const home = await get('/');
check('/ is the game, with this origin and the tuning flag', home.status === 200 && home.text.includes(origin) && home.text.includes('mf-tune') && !home.text.includes('%ORIGIN%'));
check('security headers', (home.headers.get('content-security-policy') ?? '').includes("frame-ancestors 'none'"));
check(`/r/${room} is the game`, (await get(`/r/${room}`)).text.includes('mf-tune'));
const asset = home.text.match(/\/assets\/[^"]+\.js/)?.[0];
check('a hashed script loads, cached', !!asset && (await get(asset)).status === 200);

const health = await get('/health');
check('/health is the game server', health.status === 200 && JSON.parse(health.text).ok === true, health.text);
const guest = await post('/api/auth/guest', {});
const token = guest.json().accessToken;
check('the API makes a guest through /api', guest.status === 201 || guest.status === 200);
const join = await post(`/api/rooms/${room}/join`, {}, { authorization: `Bearer ${token}` });
const joined = join.json();
check(`the room ${room} takes players and hands out a ticket`, join.status === 200 && typeof joined.ticket === 'string', JSON.stringify(joined));
check('a game socket opens from this site', (await upgrade(`/ws/${room}`, origin)) === 101);
check('a game socket from another site is refused', (await upgrade(`/ws/${room}`, 'https://evil.example')) === 403);

check('/admin is the admin page', (await get('/admin')).text.includes('admin'));
const adminState = await get('/admin/api/state', { headers: { authorization: `Bearer ${secrets.ADMIN_TOKEN}` } });
check('the admin API answers the token', adminState.status === 200 && adminState.text.includes('fields'), adminState.text.slice(0, 200));
check('the admin API refuses without it', (await get('/admin/api/state')).status === 401);

const probe = await get('/probe');
check('/probe is the probe page', probe.status === 200 && probe.text.includes('/src/probe') === false && probe.text.includes('Ping test'));
const config = JSON.parse((await get('/probe-config.json')).text);
check('probe config names this box', config.regions?.[0]?.echo === 'wss://127-0-0-1.sslip.io:8443/echo', JSON.stringify(config));
// a masked binary frame [7, 7, 7] out, the unmasked echo back
const ws = await upgrade('/echo', origin, true);
const echoed = await new Promise((resolve) => {
  if (!ws.socket) return resolve(`no socket (${ws.status})`);
  let got = Buffer.alloc(0);
  ws.socket.on('data', (c) => {
    got = Buffer.concat([got, c]);
    if (got.length >= 5) {
      ws.socket.destroy();
      resolve(`${got[0]}:${[...got.subarray(2, 5)].join(',')}`);
    }
  });
  ws.socket.write(Buffer.from([0x82, 0x83, 1, 2, 3, 4, 7 ^ 1, 7 ^ 2, 7 ^ 3]));
  setTimeout(() => resolve('timeout'), 5000);
});
check('the echo socket echoes through Caddy', echoed === '130:7,7,7', echoed);
check('an echo socket from another site is refused', (await upgrade('/echo', 'https://evil.example')) === 403);
const run = { id: 'docker-check-1', city: 'Lagos', network: 'mtn', device: 'Android phone', regions: { los: { sent: 3, rtts: [20, 21, null] } } };
const posted = await post('/probe-api/results', run);
check('a probe result is saved', posted.status === 201, posted.text);
const exported = await get(`/probe-api/export/${secrets.EXPORT_TOKEN}`);
check('the export has it (with the token)', exported.status === 200 && exported.text.includes('docker-check-1'));
check('the export needs the token', (await get('/probe-api/export/nope-nope-nope-nope-nope')).status === 404);
const file = sh('cat /var/lib/military-forge/probe/results.jsonl');
check('no address in the results file', !/\b(127\.0\.0\.1|172\.\d+\.\d+\.\d+|192\.168\.)/.test(file));

const units = sh('systemctl is-active mf-api mf-game mf-probe caddy mf-room.timer').trim().split('\n');
check('services active', units.every((u) => u === 'active'), units.join(' '));
check('the game server runs on uWebSockets.js', sh('journalctl -u mf-game --no-pager').includes('uWebSockets.js'));

console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
