/**
 * cloud-init.sh stays pasteable: under EC2's 16 KB user-data limit, valid bash, shellcheck-clean
 * (when shellcheck is installed), and with the settings the docs tell the owner to look at. data.sh,
 * which it sources for Postgres and Valkey, is checked the same way.
 *   node --test scripts/net-trial/
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, 'cloud-init.sh');
const text = readFileSync(script, 'utf8');
const dataScript = join(here, 'data.sh');
const data = readFileSync(dataScript, 'utf8');
const has = (bin) => {
  try {
    execFileSync('sh', ['-c', `command -v ${bin}`], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};

describe('cloud-init.sh', () => {
  it('fits in EC2 user data (16 KB, before base64)', () => {
    assert.ok(statSync(script).size < 16 * 1024, `${statSync(script).size} bytes`);
  });
  it('is a bash script that parses', () => {
    assert.ok(text.startsWith('#!/bin/bash\n'));
    execFileSync('bash', ['-n', script]);
  });
  it('ends with exit 0, so cloud-init records a success', () => {
    assert.match(text, /\nexit 0\n$/);
  });
  it('passes shellcheck', { skip: !has('shellcheck') && 'shellcheck not installed' }, () => {
    execFileSync('shellcheck', ['-s', 'bash', script]);
  });
  it('clones the public repo and plays Street Market with bots by default', () => {
    assert.match(text, /^REPO="\$\{MF_REPO:-https:\/\/github\.com\/samie105\/military-forge\}"$/m);
    assert.match(text, /^REF="\$\{MF_REF:-main\}"$/m);
    assert.match(text, /^MAP="street-market"$/m);
    assert.match(text, /^BOTS="4"$/m);
  });
  it('leaves UDP 443 to the WebTransport gateway: Caddy serves no HTTP/3', () => {
    assert.match(text, /servers \{\\n\\t\\tprotocols h1 h2\\n/);
  });
  it('sets the game server up for the gateway before it starts, and the gateway after the box is ready', () => {
    const env = text.indexOf('bash "$W" env');
    const gateway = text.indexOf('bash "$W" gateway');
    assert.ok(env > 0 && env < text.indexOf('restart.sh" $services'), 'wt-setup.sh env before the services start');
    assert.ok(gateway > text.indexOf('phase ready'), 'wt-setup.sh gateway after ready (WebSocket works meanwhile)');
  });
  it('restarts the services through restart.sh (no match is dropped by a deploy), and Caddy only when its config changed', () => {
    assert.match(text, /^bash "\$SRC\/scripts\/net-trial\/restart\.sh" \$services /m);
    assert.ok(!/systemctl restart \$services/.test(text), 'no plain restart of the game server');
    assert.match(text, /^cmp -s \/etc\/caddy\/Caddyfile\{\.new,\} && rm /m);
  });
  it('never prints the owner secrets to the public status page', () => {
    const status = text.slice(text.indexOf('status() {'), text.indexOf('[ -n "${OWNER:-}" ] || return 0'));
    assert.ok(!/ADMIN_TOKEN|EXPORT_TOKEN|\$OWNER/.test(status.replace('| redact', '')), 'the public part of status() must not use the secrets');
  });
  it('runs the API in production on Postgres and Valkey from data.sh, not PGlite', () => {
    assert.match(text, /^\. "\$SRC\/scripts\/net-trial\/data\.sh"/m);
    assert.ok(text.indexOf('data.sh') < text.indexOf('envfile api.env'), 'data.sh runs before the env files are written');
    const apiEnv = text.slice(text.indexOf('envfile api.env'), text.indexOf('envfile game.env'));
    assert.match(apiEnv, /^NODE_ENV='production'$/m);
    assert.match(apiEnv, /^DATABASE_URL='\$DB_URL'$/m);
    assert.match(apiEnv, /^REDIS_URL='\$KV_URL'$/m);
    assert.doesNotMatch(apiEnv, /PGLITE_DIR/);
  });
});

describe('data.sh', () => {
  it('is bash that parses', () => {
    execFileSync('bash', ['-n', dataScript]);
  });
  it('passes shellcheck', { skip: !has('shellcheck') && 'shellcheck not installed' }, () => {
    execFileSync('shellcheck', ['-s', 'bash', dataScript]);
  });
  it('keeps both stores on localhost with generated passwords in a 0600 file', () => {
    assert.match(data, /listen_addresses = 'localhost'/);
    assert.match(data, /bind 127\.0\.0\.1 -::1/);
    assert.match(data, /requirepass %s/);
    assert.match(data, /\(umask 077 && printf 'PG_PASS=%s\\nKV_PASS=%s\\n' "\$\(r 24\)" "\$\(r 24\)" >"\$ETC\/db"\)/);
    assert.match(data, /chmod 0600 "\$ETC\/db"/);
    assert.match(data, /^DB_URL="postgres:\/\/mf:\$PG_PASS@127\.0\.0\.1:5432\/mf"$/m);
    assert.match(data, /^KV_URL="redis:\/\/:\$KV_PASS@127\.0\.0\.1:6379"$/m);
  });
  it('never puts a password on a command line', () => {
    for (const line of data.split('\n').filter((l) => /\$(PG|KV)_PASS/.test(l))) {
      assert.ok(/^(DB_URL|KV_URL)=|^ALTER ROLE|printf .*>/.test(line.trim()) || line.includes('(umask'), line);
    }
  });
  it('gives the game server a results key of its own and the API its public half; Caddy hides the route', () => {
    assert.match(data, /openssl genpkey -algorithm ed25519 -out "\$ETC\/results\.key"/);
    assert.match(data, /RESULTS_PRIVATE_KEY=.*API_URL='http:\/\/127\.0\.0\.1:8787'/);
    assert.match(data, /RESULTS_PUBLIC_KEY=.*openssl pkey -in "\$ETC\/results\.key" -pubout/);
    assert.match(text, /respond \/api\/internal\/\* 404/);
  });
  it('backs up nightly into /var/backups/military-forge and keeps 7', () => {
    assert.match(data, /OnCalendar=\*-\*-\* 02:30:00 UTC/);
    assert.match(data, /head -n -7/);
  });
});

for (const name of ['wt-setup.sh', 'where.sh']) {
  describe(name, () => {
    const file = join(here, name);
    it('is a bash script that parses', () => {
      assert.ok(readFileSync(file, 'utf8').startsWith('#!/bin/bash\n'));
      execFileSync('bash', ['-n', file]);
    });
    it('passes shellcheck', { skip: !has('shellcheck') && 'shellcheck not installed' }, () => {
      execFileSync('shellcheck', ['-s', 'bash', file]);
    });
  });
}

describe('wt-setup.sh', () => {
  const wt = readFileSync(join(here, 'wt-setup.sh'), 'utf8');
  it('runs the gateway on UDP 443 as the mf user, sharing the game server socket directory', () => {
    assert.match(wt, /WT_ADDR=0\.0\.0\.0:443/);
    assert.match(wt, /AmbientCapabilities=CAP_NET_BIND_SERVICE/);
    assert.equal((wt.match(/RuntimeDirectoryPreserve=yes/g) ?? []).length, 2, 'both services keep /run/military-forge');
  });
  it('builds with the toolchain the repo pins, from a checked rustup', () => {
    assert.match(wt, /rust-toolchain\.toml/);
    assert.match(wt, /dl -o "\$tmp\/sum" "\$u\.sha256"/);
    assert.match(wt, /sha256sum -c --quiet/);
    assert.match(wt, /cargo build -q --release --locked/);
  });
});
