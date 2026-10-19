/**
 * Checks a box set up by cloud-init.sh in the local test container (docker-test.sh): every public
 * route through Caddy, the owner's private links, the probe's echo and results, the origin checks, and
 * the data stores: Postgres and Valkey on localhost with passwords, the API on them, the nightly
 * backup and its pruning, match results signed with the box's key, and (after a FROM= upgrade) the
 * PGlite-era guest still signed in.
 *   node scripts/net-trial/test/docker-check.mjs <container>
 * Caddy's internal CA signs the test certificate, so these requests skip certificate checks.
 */
import { execFileSync } from 'node:child_process';
import { request } from 'node:https';

const container = process.argv[2] ?? 'mf-trial-test';
const origin = 'https://127-0-0-1.sslip.io:8443';
const sh = (cmd) => execFileSync('docker', ['exec', container, 'sh', '-c', cmd], { encoding: 'utf8' });
const fails = (cmd) => {
  try {
    sh(`${cmd} 2>&1`);
    return false;
  } catch {
    return true;
  }
};
const envOf = (file) => Object.fromEntries([...sh(`cat ${file}`).matchAll(/^(\w+)='?(.*?)'?$/gm)].map((m) => [m[1], m[2]]));
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
// the box's region id comes from where it is (where.sh; 'box' in a container)
const regionId = config.regions?.[0]?.id ?? 'box';
const run = {
  id: 'docker-check-1',
  city: 'Lagos',
  network: 'mtn',
  device: 'Android phone',
  regions: { [regionId]: { sent: 3, rtts: [20, 21, null] } },
  refs: { 'aws-eu-west-2': { rtts: [150, 151, null], median: 150.5, colo: '' } },
};
const posted = await post('/probe-api/results', run);
check('a probe result is saved', posted.status === 201, posted.text);
const exported = await get(`/probe-api/export/${secrets.EXPORT_TOKEN}`);
check('the export has it (with the token)', exported.status === 200 && exported.text.includes('docker-check-1'));
check('with its reference pings', exported.text.includes('"aws-eu-west-2"'));
check('the export needs the token', (await get('/probe-api/export/nope-nope-nope-nope-nope')).status === 404);
const file = sh('cat /var/lib/military-forge/probe/results.jsonl');
check('no address in the results file', !/\b(127\.0\.0\.1|172\.\d+\.\d+\.\d+|192\.168\.)/.test(file));

// ---------- the data stores ----------
check('the database passwords file is 0600 root', sh('stat -c "%a %U" /etc/military-forge/db').trim() === '600 root');
const db = envOf('/etc/military-forge/db');
const apiEnv = envOf('/etc/military-forge/api.env');
check(
  'the API runs in production on Postgres and Valkey',
  apiEnv.NODE_ENV === 'production' && apiEnv.DATABASE_URL === `postgres://mf:${db.PG_PASS}@127.0.0.1:5432/mf` && apiEnv.REDIS_URL === `redis://:${db.KV_PASS}@127.0.0.1:6379` && !('PGLITE_DIR' in apiEnv),
  JSON.stringify(Object.keys(apiEnv)),
);
const apiHealth = await get('/api/health');
check('the API is up on Postgres and Valkey', apiHealth.status === 200 && /"db":"postgres","kv":"redis","dbUp":true,"kvUp":true/.test(apiHealth.text), apiHealth.text);
const listening = sh("ss -Hltn '( sport = :5432 or sport = :6379 )'")
  .trim()
  .split('\n')
  .map((l) => l.split(/\s+/)[3]);
check(
  'Postgres and Valkey listen on localhost only',
  listening.length >= 2 && listening.every((a) => /^(127\.0\.0\.1|\[::1\]):(5432|6379)$/.test(a)) && listening.some((a) => a.endsWith(':5432')) && listening.some((a) => a.endsWith(':6379')),
  listening.join(' '),
);
const psql = (sql) => sh(`PGPASSWORD='${db.PG_PASS}' psql -h 127.0.0.1 -U mf -d mf -XAtc "${sql}"`).trim();
check('Postgres refuses the mf role without its password', fails('psql -h 127.0.0.1 -U mf -d mf -w -c "select 1"'));
const users = Number(psql('select count(*) from users'));
check('the guests made above are rows in Postgres', users >= 2, String(users));
check('Valkey refuses without its password', sh('valkey-cli -h 127.0.0.1 ping 2>&1').includes('NOAUTH'));
const vk = (args) => sh(`REDISCLI_AUTH='${db.KV_PASS}' valkey-cli -h 127.0.0.1 ${args}`).trim();
check('Valkey answers with it', vk('ping') === 'PONG');
check(`the room ${room} lives in Valkey`, vk(`exists room:${room}`) === '1');
check('Valkey keeps an append-only file and never evicts', vk('config get appendonly').endsWith('yes') && vk('config get maxmemory-policy').endsWith('noeviction'));

// backups: a run makes today's dump (only postgres can read it) and keeps the newest 7
const day = (n) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
sh(`cd /var/backups/military-forge && for n in ${[3, 4, 5, 6, 7, 8, 9, 10, 11].map(day).join(' ')}; do echo old >mf-$n.dump; done && chown postgres:postgres mf-*.dump`);
sh('systemctl start mf-backup.service');
const dumps = sh('ls -1 /var/backups/military-forge').trim().split('\n');
check('the backup keeps the newest 7 dumps, today first', dumps.length === 7 && dumps.at(-1) === `mf-${day(0)}.dump` && !dumps.includes(`mf-${day(9)}.dump`), dumps.join(' '));
check('the dump is private to postgres', sh(`stat -c "%a %U" /var/backups/military-forge/mf-${day(0)}.dump`).trim() === '600 postgres');
check('the dump restores: it lists the users table', sh(`pg_restore -l /var/backups/military-forge/mf-${day(0)}.dump`).includes('TABLE public users'));
check('the backup runs nightly', sh('systemctl is-enabled mf-backup.timer').trim() === 'enabled' && sh('systemctl show -p TimersCalendar mf-backup.timer').includes('02:30:00 UTC'));

// match results: the game server has its key; a report signed with it is recorded, unsigned ones aren't
check('the game server sends match results to the API', sh('journalctl -u mf-game --no-pager').includes('match results sent to the API'));
check('the results route is not reachable from outside', (await post('/api/internal/matches', {})).status === 404);
check('the API refuses an unsigned report', sh(`curl -s -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' -d '{}' http://127.0.0.1:8787/internal/matches`) === '401');
const signer = `
import { createHash, createPrivateKey, randomUUID, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
const key = createPrivateKey(readFileSync('/etc/military-forge/results.key'));
const now = new Date();
const report = { matchId: randomUUID(), room: 'DOCKER', mode: 'deathmatch', map: 'street-market', startedAt: new Date(now - 60000).toISOString(), endedAt: now.toISOString(), durationS: 60, reason: 'time_limit', playerCount: 4, botCount: 3, serverBuild: 'docker-check',
  players: [{ userId: process.argv[2], nickname: 'Checker', placement: 1, score: 3, kills: 3, deaths: 1, assists: 0, damageDealt: 300, damageTaken: 100, headshots: 1, bestStreak: 3, left: false, mvp: true, killsBy: { k47: 3 } }] };
const body = JSON.stringify(report);
const h = Buffer.from(JSON.stringify({ alg: 'EdDSA', typ: 'JWT' })).toString('base64url');
const t = Math.floor(Date.now() / 1000);
const p = Buffer.from(JSON.stringify({ iss: 'game-server', aud: 'api-results', sub: report.matchId, iat: t, exp: t + 60, jti: randomUUID(), bodySha256: createHash('sha256').update(body).digest('base64url') })).toString('base64url');
const auth = 'GameServer ' + h + '.' + p + '.' + sign(null, Buffer.from(h + '.' + p), key).toString('base64url');
const post = () => fetch('http://127.0.0.1:8787/internal/matches', { method: 'POST', headers: { 'content-type': 'application/json', authorization: auth }, body }).then((r) => r.status);
console.log(await post(), await post());
`;
execFileSync('docker', ['exec', '-i', container, 'sh', '-c', 'cat >/tmp/mf-sign.mjs'], { input: signer });
const statuses = sh(`/opt/node/bin/node /tmp/mf-sign.mjs ${guest.json().user.id}`).trim();
check('a report signed with the box key is recorded once', statuses === '201 200', statuses);
const profile = await get('/api/players/me/profile', { headers: { authorization: `Bearer ${token}` } });
check("the player's profile has the match: XP, level, kills by weapon", profile.status === 200 && profile.json().xp === 100 + 30 + 50 && profile.json().stats?.wins === 1 && profile.json().killsBy?.[0]?.source === 'k47', profile.text.slice(0, 300));
const board = await get('/api/leaderboards/xp?period=week', { headers: { authorization: `Bearer ${token}` } });
check('the weekly XP board has them, from Valkey', board.status === 200 && board.json().me?.rank >= 1 && vk(`exists lb:xp:${board.json().periodId}`) === '1', board.text.slice(0, 300));

// live data in Valkey: an API restart keeps the room (not re-made from KEEP_ROOMS), presence and rate limits
const roomBefore = vk(`get room:${room}`);
const presenceBeat = await call('/api/me/presence', { method: 'PUT', headers: { 'content-type': 'application/json', origin, authorization: `Bearer ${token}` }, body: JSON.stringify({ room }) });
check('presence: in the room', presenceBeat.status === 200 && presenceBeat.json().status === 'in_room', presenceBeat.text);
sh('systemctl restart mf-api && for i in $(seq 60); do curl -fs -o /dev/null http://127.0.0.1:8787/health && break; sleep 1; done');
check('after an API restart the room record is the same one (Valkey kept it)', vk(`get room:${room}`) === roomBefore && !roomBefore.includes('"kept"'), roomBefore);
const presenceAfter = await get('/api/players/me/presence', { headers: { authorization: `Bearer ${token}` } });
check('after an API restart the presence is still there', presenceAfter.status === 200 && presenceAfter.json().status === 'in_room', presenceAfter.text);
check('rate-limit counters live in Valkey', Number(vk("eval \"return #redis.call('keys', 'rl:*')\" 0")) > 0);

// after FROM=<PGlite-era ref>: the guest made then is in Postgres and still signed in
if (!fails('test -f /root/mf-before.json')) {
  const before = JSON.parse(sh('cat /root/mf-before.json'));
  check('the PGlite directory was moved aside once', fails('test -e /var/lib/military-forge/pglite') && sh('ls -d /var/lib/military-forge/pglite.imported-* | wc -l').trim() === '1');
  check('the guest from before the upgrade is in Postgres with its name', psql(`select nickname from profiles where user_id = '${before.user.id}'`) === 'Kemi Before');
  const refreshed = await post('/api/auth/refresh', { refreshToken: before.refreshToken });
  check('their refresh token still signs them in', refreshed.status === 200 && refreshed.json().user?.id === before.user.id, refreshed.text.slice(0, 200));
}

const units = sh('systemctl is-active mf-api mf-game mf-probe caddy mf-room.timer postgresql valkey-server mf-backup.timer').trim().split('\n');
check('services active', units.every((u) => u === 'active'), units.join(' '));
check('the game server runs on uWebSockets.js', sh('journalctl -u mf-game --no-pager').includes('uWebSockets.js'));

console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
