/**
 * mf-room.sh (the timer that keeps the trial room open, every 2 h) plays as one guest it keeps, not a
 * new guest per run (audit P-12: 233 of the first 267 "players" were this script). Run against a
 * small fake API:
 *   node --test "scripts/net-trial/**\/*.test.mjs"
 */
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, 'mf-room.sh');
const has = (bin) => {
  try {
    execFileSync('sh', ['-c', `command -v ${bin}`], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};

/** The API's few routes the script uses: guests, refresh (rotates the token), rooms. */
function fakeApi() {
  const api = { guests: 0, refreshes: 0, rejectRefresh: false, live: new Set(), rooms: new Set(), tokens: new Map() };
  let n = 0;
  const session = (user) => {
    const refreshToken = `s${++n}.${'x'.repeat(20)}${n}`;
    api.live.add(refreshToken);
    const accessToken = `a${n}`;
    api.tokens.set(accessToken, user);
    return { accessToken, refreshToken, user: { id: user } };
  };
  api.server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const json = (status, obj) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
      const authed = api.tokens.has((req.headers.authorization ?? '').replace(/^Bearer /, ''));
      if (req.url === '/health') return json(200, { ok: true });
      if (req.method === 'POST' && req.url === '/auth/guest') {
        api.guests++;
        return json(201, session(`u_${api.guests}`));
      }
      if (req.method === 'POST' && req.url === '/auth/refresh') {
        const t = JSON.parse(body || '{}').refreshToken;
        if (api.rejectRefresh || !api.live.has(t)) return json(401, { error: 'invalid_refresh_token' });
        api.refreshes++;
        api.live.delete(t); // rotated: the old one is spent
        return json(200, session('u_kept'));
      }
      if (req.method === 'POST' && req.url === '/rooms') {
        if (!authed) return json(401, { error: 'no_session' });
        api.rooms.add('KQXMZP');
        return json(201, { code: 'KQXMZP' });
      }
      const join = /^\/rooms\/([A-Z]{6})\/join$/.exec(req.url ?? '');
      if (req.method === 'POST' && join) return json(authed && api.rooms.has(join[1]) ? 200 : 404, {});
      json(404, {});
    });
  });
  return api;
}

describe('mf-room.sh', { skip: !has('jq') && 'jq not installed' }, () => {
  let api;
  let port;
  let dir;
  let bin;
  before(async () => {
    api = fakeApi();
    await new Promise((done) => api.server.listen(0, '127.0.0.1', done));
    port = api.server.address().port;
  });
  after(() => api.server.close());
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mf-room-'));
    bin = join(dir, 'bin');
    execFileSync('mkdir', ['-p', bin, join(dir, 'etc')]);
    writeFileSync(join(dir, 'etc', 'api.env'), "PORT=8787\nKEEP_ROOMS=''\n");
    // the box's tools the fake can't be: systemctl does nothing, sed -i is GNU's (perl here, on any OS)
    writeFileSync(join(bin, 'systemctl'), '#!/bin/sh\nexit 0\n');
    writeFileSync(join(bin, 'sed'), '#!/bin/sh\n[ "$1" = -i ] && exec perl -pi -e "$2" "$3"\nexec /usr/bin/sed "$@"\n');
    for (const f of ['systemctl', 'sed']) chmodSync(join(bin, f), 0o755);
    api.guests = 0;
    api.refreshes = 0;
    api.rejectRefresh = false;
    api.rooms.clear();
  });
  const run = () =>
    new Promise((done) => {
      const p = spawn('bash', [script], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, MF_ROOM_API: `http://127.0.0.1:${port}`, MF_ETC: join(dir, 'etc') } });
      let out = '';
      p.stdout.on('data', (c) => (out += c));
      p.stderr.on('data', (c) => (out += c));
      p.on('close', (code) => done({ code, out }));
    });

  it('is valid bash and shellcheck-clean', { skip: !has('shellcheck') && 'shellcheck not installed' }, () => {
    execFileSync('bash', ['-n', script]);
    execFileSync('shellcheck', ['-s', 'bash', script]);
  });

  it('makes one guest on its first run, then keeps it: twelve runs (a day) are still one guest', async () => {
    try {
      const first = await run();
      assert.equal(first.code, 0, first.out);
      assert.match(first.out, /made room KQXMZP/);
      assert.equal(api.guests, 1);
      assert.equal(readFileSync(join(dir, 'etc', 'room-code'), 'utf8').trim(), 'KQXMZP');
      assert.match(readFileSync(join(dir, 'etc', 'api.env'), 'utf8'), /^KEEP_ROOMS='KQXMZP'$/m);
      // the kept token: owner-only, the rotated one each run
      const kept = join(dir, 'etc', 'room-guest');
      assert.equal(statSync(kept).mode & 0o777, 0o600);
      for (let i = 0; i < 11; i++) {
        const before = readFileSync(kept, 'utf8');
        const r = await run();
        assert.equal(r.code, 0, r.out);
        assert.notEqual(readFileSync(kept, 'utf8'), before, 'the refresh token rotates');
      }
      assert.equal(api.guests, 1);
      assert.equal(api.refreshes, 11);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a token the API no longer takes (or a lost file): one new guest, kept from then on', async () => {
    try {
      assert.equal((await run()).code, 0);
      api.rejectRefresh = true;
      assert.equal((await run()).code, 0);
      assert.equal(api.guests, 2);
      api.rejectRefresh = false;
      assert.equal((await run()).code, 0);
      assert.equal(api.guests, 2);
      rmSync(join(dir, 'etc', 'room-guest'));
      assert.equal((await run()).code, 0);
      assert.equal(api.guests, 3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
