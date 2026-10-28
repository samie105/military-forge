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
const siteScript = join(here, 'site.sh');
const site = readFileSync(siteScript, 'utf8');
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
  it('leaves UDP 443 to the WebTransport gateway: Caddy serves no HTTP/3 (the first config and site.sh\'s)', () => {
    assert.match(text, /servers \{\\n\\t\\tprotocols h1 h2\\n/);
    assert.match(site, /servers \{\\n\\t\\tprotocols h1 h2\\n/);
  });
  it("takes Caddy's config from the code's site.sh, before and after the fetch, so a deploy brings its changes", () => {
    const fetch = text.indexOf('# -- the code');
    const first = text.indexOf('. "$S"; site_caddy');
    const after = text.indexOf('[ -f "$S" ] && . "$S" && { site_caddy');
    assert.ok(first > 0 && first < fetch, 'the last deploy\'s config before the fetch');
    assert.ok(after > fetch && after < text.indexOf("phase 'installing Node"), "this commit's config after it");
    assert.match(text, /elif ! grep -qs "\^\$HOST \{" \/etc\/caddy\/Caddyfile; then/, 'a new box only: never replaces a working config with the first one');
    assert.match(text, /^site_fill$/m);
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
    assert.match(site, /if cmp -s "\$new" \/etc\/caddy\/Caddyfile; then rm "\$new"; else mv /);
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
    assert.match(site, /respond \/api\/internal\/\* 404/);
  });
  it('backs up nightly into /var/backups/military-forge and keeps 7', () => {
    assert.match(data, /OnCalendar=\*-\*-\* 02:30:00 UTC/);
    assert.match(data, /head -n -7/);
  });
});

for (const name of ['wt-setup.sh', 'where.sh', 'site.sh']) {
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

/** site.sh's functions run in bash with cloud-init.sh's settings; prints what they made. */
function runSite(body, env = {}) {
  return execFileSync('bash', ['-c', `set -u; . "${siteScript}"; ${body}`], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, HOST: 'a-b.sslip.io', TLS: 'auto', ORIGIN_PORT: '', ACME_EMAIL: '', WEB: '/srv/web', PUB: '/srv/pub', DATA: '/tmp', ORIGIN: 'https://a-b.sslip.io', ...env },
  });
}

describe('site.sh (audit 28 Oct)', () => {
  const caddyfile = runSite('site_caddyfile');
  it('serves the site by name at column 0 (wt-setup.sh reads the name from there)', () => {
    assert.match(caddyfile, /^a-b\.sslip\.io \{$/m);
    assert.doesNotMatch(caddyfile, /tls internal/);
    assert.match(runSite('site_caddyfile', { TLS: 'internal' }), /^\ttls internal$/m);
  });
  it('compresses models, sound banks and the manifest too (Caddy\'s default skips them)', () => {
    for (const type of ['text/*', 'application/javascript*', 'application/json*', 'model/gltf-binary*', 'application/octet-stream*', 'application/manifest+json*']) {
      assert.ok(caddyfile.includes(`header Content-Type ${type}\n`), type);
    }
    assert.match(caddyfile, /\tencode zstd gzip \{\n\t\tmatch \{/);
  });
  it('sends HSTS, a Permissions-Policy, the CSP and the manifest\'s own type', () => {
    assert.match(caddyfile, /Strict-Transport-Security "max-age=31536000"/);
    assert.match(caddyfile, /Permissions-Policy "camera=\(\), microphone=\(self\), geolocation=\(\), payment=\(\), usb=\(\)"/);
    assert.match(caddyfile, /connect-src 'self' data: blob: https:\/\/a-b\.sslip\.io wss:\/\/a-b\.sslip\.io /);
    assert.match(caddyfile, /frame-ancestors 'none'/);
    assert.match(caddyfile, /header \/manifest\.webmanifest Content-Type application\/manifest\+json/);
  });
  it('caches only the build\'s hashed files for a year; everything else revalidates', () => {
    const re = /@hashed path_regexp (\S+)/.exec(caddyfile)?.[1];
    assert.ok(re);
    assert.ok(caddyfile.includes(`@fresh not path_regexp ${re}\n`));
    const hashed = new RegExp(re);
    assert.ok(hashed.test('/assets/main-DmMYxFY-.js'));
    assert.ok(hashed.test('/assets/voices-AbC_12-x.bin'));
    for (const p of ['/assets/weapons/k47.glb', '/assets/characters/rookie/textures/rookie_body_dye_mask.png', '/art/key-art/key-art-phone.avif', '/sw.js', '/index.html']) assert.ok(!hashed.test(p), p);
    assert.match(caddyfile, /header @fresh Cache-Control no-cache\n/);
    assert.match(caddyfile, /header @hashed Cache-Control "public, max-age=31536000, immutable"\n/);
    // the status and owner pages: never stored (after the no-cache, so it wins)
    assert.ok(caddyfile.indexOf('header @pub Cache-Control no-store') > caddyfile.indexOf('header @fresh'));
  });
  it('fills %ORIGIN% in the pages and crawl files, legal pages and llms.txt included, skipping files the build lacks', async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const web = mkdtempSync(join(tmpdir(), 'mf-site-'));
    try {
      for (const f of ['index.html', 'robots.txt', 'sitemap.xml', 'privacy.html', 'terms.html', 'official.html']) writeFileSync(join(web, f), '<head><link href="%ORIGIN%/x"></head>');
      // GNU sed (the box) takes -i alone; BSD sed (a Mac) needs a suffix: a shim keeps the test portable
      runSite('sed() { if [ "$1" = -i ] && [ "$(uname)" = Darwin ]; then shift; command sed -i "" "$@"; else command sed "$@"; fi; }; site_fill', { WEB: web });
      for (const f of ['index.html', 'robots.txt', 'sitemap.xml', 'privacy.html', 'terms.html', 'official.html']) {
        const out = readFileSync(join(web, f), 'utf8');
        assert.ok(out.includes('https://a-b.sslip.io/x') && !out.includes('%ORIGIN%'), f);
        assert.equal(out.includes('mf-tune'), f === 'index.html', f);
      }
    } finally {
      rmSync(web, { recursive: true, force: true });
    }
  });
});

describe('where.sh (audit 28 Oct)', () => {
  /** where.sh with a fake curl answering as one cloud's metadata service */
  async function whereOn(answer) {
    const { mkdtempSync, writeFileSync, rmSync, chmodSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const bin = mkdtempSync(join(tmpdir(), 'mf-where-'));
    try {
      writeFileSync(join(bin, 'curl'), `#!/bin/bash\n${answer}\nexit 22\n`);
      chmodSync(join(bin, 'curl'), 0o755);
      return execFileSync('bash', [join(here, 'where.sh')], { encoding: 'utf8', env: { PATH: `${bin}:${process.env.PATH}` } }).trim();
    } finally {
      rmSync(bin, { recursive: true, force: true });
    }
  }
  it('names an Azure box in South Africa North Johannesburg, whatever the case Azure answers in', async () => {
    const azure = (loc) => `case "$*" in *Metadata:true*) printf ${loc}; exit 0 ;; esac`;
    assert.equal(await whereOn(azure('SouthAfricaNorth')), 'jnb|Johannesburg|Azure southafricanorth');
    assert.equal(await whereOn(azure('southafricanorth')), 'jnb|Johannesburg|Azure southafricanorth');
    assert.equal(await whereOn(azure('WestEurope')), 'ams|Amsterdam|Azure westeurope');
  });
  it('names the AWS Lagos zone, and a box with no metadata "this box"', async () => {
    const aws = `case "$*" in *api/token*) printf tok; exit 0 ;; *availability-zone*) printf af-south-1-los-1a; exit 0 ;; esac`;
    assert.equal(await whereOn(aws), 'los|Lagos|AWS af-south-1-los-1a');
    assert.equal(await whereOn(''), 'box|this box|');
  });
});
