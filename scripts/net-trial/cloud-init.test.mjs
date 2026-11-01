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
    // production runs the public production branch; staging (below) runs main (docs/release.md)
    assert.match(text, /^REF="\$\{MF_REF:-production\}"$/m);
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
    assert.match(text, /elif \[ -z "\$STG" \] && ! grep -qs "\^\$HOST \{" \/etc\/caddy\/Caddyfile; then/, 'a new box only (production): never replaces a working config with the first one');
    assert.match(text, /^site_fill$/m);
  });
  it('sets the game server up for the gateway before it starts, and the gateway after the box is ready', () => {
    const env = text.indexOf('bash "$W" env');
    const gateway = text.indexOf('bash "$W" gateway');
    assert.ok(env > 0 && env < text.indexOf('restart.sh" $services'), 'wt-setup.sh env before the services start');
    assert.ok(gateway > text.indexOf('phase ready'), 'wt-setup.sh gateway after ready (WebSocket works meanwhile)');
  });
  it('restarts the services through restart.sh (no match is dropped by a deploy), and Caddy only when its config changed', () => {
    assert.match(text, /^MF_SRC=\$SRC MF_DATA=\$DATA MF_GAME_UNIT=\$\{N\}game MF_GAME_PORT=\$GAME_PORT bash "\$SRC\/scripts\/net-trial\/restart\.sh" \$services /m);
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
    assert.match(data, /^DB=mf KV_PORT=6379$/m);
    assert.match(data, /^DB_URL="postgres:\/\/\$DB:\$PG_PASS@127\.0\.0\.1:5432\/\$DB"$/m);
    assert.match(data, /^KV_URL="redis:\/\/:\$KV_PASS@127\.0\.0\.1:\$KV_PORT"$/m);
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

for (const name of ['wt-setup.sh', 'where.sh', 'site.sh', 'restart.sh']) {
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
  it("lets the bot check (Cloudflare Turnstile) load its script and frame, and nothing else of Cloudflare's (bot check, 30 Oct)", () => {
    const csp = /Content-Security-Policy "([^"]*)"/.exec(caddyfile)?.[1] ?? '';
    const directive = (name) => csp.split('; ').find((d) => d.startsWith(`${name} `)) ?? '';
    assert.equal(directive('script-src'), "script-src 'self' 'wasm-unsafe-eval' https://challenges.cloudflare.com");
    assert.equal(directive('frame-src'), "frame-src 'self' https://challenges.cloudflare.com");
    assert.ok(directive('connect-src').endsWith(' https://challenges.cloudflare.com'));
    assert.equal(directive('default-src'), "default-src 'self'");
    assert.doesNotMatch(csp, /\*\.cloudflare\.com|https:\/\/\*[ ;]|'unsafe-eval'/);
  });
  it('caches only the build\'s hashed files for a year; everything else revalidates', () => {
    const re = /@hashed path_regexp (\S+)/.exec(caddyfile)?.[1];
    assert.ok(re);
    assert.ok(caddyfile.includes(`@fresh not path_regexp ${re}\n`));
    const hashed = new RegExp(re);
    assert.ok(hashed.test('/assets/main-DmMYxFY-.js'));
    assert.ok(hashed.test('/assets/voices-AbC_12-x.bin'));
    for (const p of ['/assets/weapons/k47.glb', '/assets/characters/rookie/textures/rookie_body_dye_mask.webp', '/art/key-art/key-art-phone.avif', '/sw.js', '/index.html']) assert.ok(!hashed.test(p), p);
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

/**
 * cloud-init.sh's settings and environment block (everything before it logs or installs), run in bash:
 * the values it settles on, as an object.
 */
function settings(env = {}, name = 'cloud-init.sh') {
  const head = text.slice(0, text.indexOf("PHASE='starting'")).replace('exec > >(tee -a "$LOG") 2>&1', ':');
  const vars = ['MF_ENV', 'REF', 'HOST', 'SRC', 'WEB', 'ETC', 'DATA', 'PUB', 'NODE_DIR', 'LOG', 'U', 'N', 'STG', 'SETUP', 'API_PORT', 'GAME_PORT', 'ADMIN_PORT'];
  const out = execFileSync('bash', ['-c', `${head}\n${vars.map((v) => `printf '%s=%s\\n' ${v} "$${v}"`).join('\n')}`, name], { encoding: 'utf8', env: { PATH: process.env.PATH, ...env } });
  return Object.fromEntries(out.trim().split('\n').map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
}

describe('environments: production and staging on one box (docs/release.md)', () => {
  it('production, with no MF_ENV, keeps every path, port, unit name and user it had', () => {
    assert.deepEqual(settings(), {
      MF_ENV: 'production', REF: 'production', HOST: '', SRC: '/opt/military-forge/src', WEB: '/opt/military-forge/web', ETC: '/etc/military-forge', DATA: '/var/lib/military-forge',
      PUB: '/opt/military-forge/public', NODE_DIR: '/opt/node', LOG: '/var/log/mf-trial.log', U: 'mf', N: 'mf-', STG: '', SETUP: 'mf-trial-setup', API_PORT: '8787', GAME_PORT: '9001', ADMIN_PORT: '9002',
    });
  });
  it('staging has its own of each, runs main, and is what mf-staging-setup runs by default', () => {
    const staging = {
      MF_ENV: 'staging', REF: 'main', HOST: '', SRC: '/opt/military-forge-staging/src', WEB: '/opt/military-forge-staging/web', ETC: '/etc/military-forge-staging', DATA: '/var/lib/military-forge-staging',
      PUB: '/opt/military-forge-staging/public', NODE_DIR: '/opt/military-forge-staging/node', LOG: '/var/log/mf-trial-staging.log', U: 'mf-staging', N: 'mf-stg-', STG: '1', SETUP: 'mf-staging-setup', API_PORT: '8887', GAME_PORT: '9101', ADMIN_PORT: '9102',
    };
    assert.deepEqual(settings({ MF_ENV: 'staging' }), staging);
    assert.deepEqual(settings({}, '/usr/local/sbin/mf-staging-setup'), staging);
    assert.equal(settings({ MF_ENV: 'production' }, '/usr/local/sbin/mf-staging-setup').MF_ENV, 'production', 'an explicit MF_ENV wins');
  });
  it('takes MF_REF in either environment, and refuses an unknown one', () => {
    assert.equal(settings({ MF_REF: 'main' }).REF, 'main');
    assert.equal(settings({ MF_ENV: 'staging', MF_REF: 'abc' }).REF, 'abc');
    assert.throws(() => settings({ MF_ENV: 'prod' }), /production or staging/);
  });
  it('names staging under the box name, builds it with VITE_ENV=staging and caps its units', () => {
    assert.match(text, /^HOST=\$\{STG:\+staging\.\}\$HOST$/m);
    assert.match(text, /as_mf env NODE_ENV=production \$\{STG:\+VITE_ENV=staging\} NODE_OPTIONS/);
    assert.match(text, /ReadWritePaths=\$DATA\$\{STG:\+\nMemoryMax=700M\nCPUWeight=20\}\n\[Install\]/);
    assert.match(text, /^EnvironmentFile=\$ETC\/\$\{1#"\$N"\}\.env$/m);
  });
  it('staging stops at code from before staging (its site.sh would write production\'s Caddyfile)', () => {
    assert.match(text, /^stg_ok\(\) \{ \[ -z "\$STG" \] \|\| grep -qs site_caddy_staging "\$S"; \}$/m);
    assert.match(text, /^if \[ -f "\$S" \] && stg_ok; then \. "\$S"; site_caddy/m, 'before the fetch: the last deploy\'s code');
    const guard = text.indexOf('stg_ok || fail');
    assert.ok(guard > text.indexOf('log "commit $COMMIT"') && guard < text.indexOf('[ -f "$S" ] && . "$S" && { site_caddy'), 'after it: this commit\'s');
    assert.match(site, /^site_caddy_staging\(\) \{$/m);
  });
  it('leaves production\'s Caddyfile, room, probe and WebTransport to production', () => {
    assert.match(text, /elif \[ -z "\$STG" \] && ! grep -qs "\^\$HOST \{" \/etc\/caddy\/Caddyfile; then/);
    const prodOnly = text.slice(text.indexOf('if [ -z "$STG" ]; then # production only'), text.indexOf('systemctl daemon-reload\nsystemctl enable'));
    for (const s of ['mf-room', 'wt-setup.sh', 'bash "$W" env', 'mf-probe']) assert.ok(prodOnly.includes(s), s);
    assert.match(text, /^\[ -z "\$STG" \] && \[ -f "\$W" \] && MF_HOST=\$HOST MF_ORIGIN_PORT=\$ORIGIN_PORT bash "\$W" gateway$/m);
  });
  it('data.sh: staging gets its own database and Valkey, and never takes a live Flutterwave key', async () => {
    assert.match(data, /^\[ -n "\$STG" \] && DB=mf_staging KV_PORT=6380$/m);
    assert.match(data, /kv_unit=valkey-server@staging/);
    assert.match(data, /maxmemory 64mb/);
    const prodConf = data.slice(data.indexOf('if [ -z "$STG" ]; then\n  kv_unit=valkey-server'), data.indexOf('else\n  # a whole config'));
    assert.ok(prodConf.includes('/etc/postgresql/16/main/conf.d/military-forge.conf') && prodConf.includes('/etc/valkey/military-forge.conf'), 'the shared servers\' settings: production only');
    const re = /grep -qsE '([^']+)' "\$ETC\/store\.env"/.exec(data)?.[1];
    assert.ok(re);
    const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const dir = mkdtempSync(join(tmpdir(), 'mf-store-'));
    try {
      const live = (body) => {
        writeFileSync(join(dir, 'store.env'), body);
        try {
          execFileSync('grep', ['-qsE', re, join(dir, 'store.env')]);
          return true;
        } catch {
          return false;
        }
      };
      assert.equal(live("FLUTTERWAVE_SECRET_KEY='FLWSECK-abcdef123456-X'\n"), true);
      assert.equal(live('FLUTTERWAVE_PUBLIC_KEY=FLWPUBK-abcdef123456-X\n'), true);
      assert.equal(live("FLUTTERWAVE_SECRET_KEY='FLWSECK_TEST-abcdef123456-X'\nFLUTTERWAVE_PUBLIC_KEY='FLWPUBK_TEST-abcdef123456-X'\n"), false);
      assert.equal(live("STORE_CLAIMABLE='a,b'\n"), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('site.sh: one Caddy for both environments', () => {
  const staging = { STG: '1', HOST: 'staging.a-b.sslip.io', ORIGIN: 'https://staging.a-b.sslip.io', API_PORT: '8887', GAME_PORT: '9101', ADMIN_PORT: '9102', WEB: '/srv/web-s', PUB: '/srv/pub-s' };
  it('production: the global options, its site on its ports, then the import of the other sites', () => {
    const prod = runSite('site_caddyfile');
    assert.ok(prod.startsWith('{\n\tservers {\n\t\tprotocols h1 h2\n\t}\n}\n\na-b.sslip.io {\n'));
    assert.ok(prod.endsWith('\n}\n\nimport /etc/caddy/mf-env/*.caddy\n'));
    for (const s of ['reverse_proxy 127.0.0.1:8787', 'reverse_proxy @game 127.0.0.1:9001', 'reverse_proxy /admin/api/* 127.0.0.1:9002', 'reverse_proxy @probe 127.0.0.1:9300']) assert.ok(prod.includes(s), s);
    assert.doesNotMatch(prod, /nofollow/);
  });
  it('staging: its site alone, on its ports, noindex everywhere, no probe', () => {
    const stg = runSite('site_caddyfile', staging);
    assert.ok(stg.startsWith('staging.a-b.sslip.io {\n'));
    assert.doesNotMatch(stg, /servers \{|^import /m);
    for (const s of ['reverse_proxy 127.0.0.1:8887', 'reverse_proxy @game 127.0.0.1:9101', 'reverse_proxy /admin/api/* 127.0.0.1:9102', 'respond @probe 404', '\t\tX-Robots-Tag "noindex, nofollow"\n', 'root /srv/web-s']) assert.ok(stg.includes(s), s);
    assert.match(stg, /not header_regexp Origin \^https:\/\/staging\\\.a-b\\\.sslip\\\.io/);
    assert.doesNotMatch(stg, /9300|8787|9001/);
  });
  it('a staging deploy writes only its own file, reloads only on a change, and puts everything back when Caddy refuses', async () => {
    const { mkdtempSync, writeFileSync, rmSync, existsSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const dir = mkdtempSync(join(tmpdir(), 'mf-caddy-'));
    const caddyfile = join(dir, 'Caddyfile');
    const sites = join(dir, 'sites');
    const env = { ...staging, MF_CADDYFILE: caddyfile, MF_CADDY_SITES: sites, DATA: dir };
    // caddy and systemctl stand-ins: validation passes unless $dir/refuse exists; reloads are counted
    const stubs = `caddy() { [ ! -e "${dir}/refuse" ]; }; systemctl() { echo "systemctl $*"; }; `;
    try {
      const prod = runSite('site_caddyfile', { MF_CADDY_SITES: sites });
      writeFileSync(caddyfile, prod.replace(/\nimport .*\n$/, '')); // a production deploy from before staging
      assert.match(runSite(`${stubs}site_caddy`, env), /^systemctl reload caddy$/m);
      assert.equal(readFileSync(caddyfile, 'utf8'), `${prod.replace(/\nimport .*\n$/, '')}\nimport ${sites}/*.caddy\n`, 'production\'s site untouched; the import added once');
      assert.equal(readFileSync(join(sites, 'staging.caddy'), 'utf8'), runSite('site_caddyfile', env));
      assert.equal(runSite(`${stubs}site_caddy`, env), '', 'unchanged: no reload');
      // a new staging config Caddy refuses: the old one stays
      writeFileSync(join(dir, 'refuse'), '');
      const before = readFileSync(join(sites, 'staging.caddy'), 'utf8');
      assert.throws(() => runSite(`${stubs}site_caddy`, { ...env, API_PORT: '8888' }));
      assert.equal(readFileSync(join(sites, 'staging.caddy'), 'utf8'), before);
      assert.ok(!existsSync(join(sites, 'staging.caddy.new')));
      // production's own deploy writes the import itself: a staging deploy then changes nothing
      writeFileSync(caddyfile, prod);
      rmSync(join(dir, 'refuse'));
      assert.equal(runSite(`${stubs}site_caddy`, env), '');
      assert.equal(readFileSync(caddyfile, 'utf8'), prod);
      // no production site yet: staging refuses rather than write a Caddyfile of its own
      writeFileSync(caddyfile, '{\n}\n');
      assert.throws(() => runSite(`${stubs}site_caddy`, env), (e) => /set production up first/.test(e.stdout));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('staging pages say noindex (replacing the build\'s robots tag) and robots.txt disallows everything', async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const web = mkdtempSync(join(tmpdir(), 'mf-site-'));
    const shim = 'sed() { if [ "$1" = -i ] && [ "$(uname)" = Darwin ]; then shift; command sed -i "" "$@"; else command sed "$@"; fi; }; ';
    try {
      writeFileSync(join(web, 'index.html'), '<head><meta name="robots" content="index, follow, max-image-preview:large" /><link href="%ORIGIN%/x"></head>');
      writeFileSync(join(web, 'admin.html'), '<head><title>a</title></head>');
      writeFileSync(join(web, 'robots.txt'), 'User-agent: *\nAllow: /\nSitemap: %ORIGIN%/sitemap.xml\n');
      runSite(`${shim}site_fill`, { ...staging, WEB: web });
      const index = readFileSync(join(web, 'index.html'), 'utf8');
      assert.match(index, /<meta name="robots" content="noindex, nofollow" \/>/);
      assert.doesNotMatch(index, /index, follow/);
      assert.ok(index.includes('https://staging.a-b.sslip.io/x'));
      assert.match(readFileSync(join(web, 'admin.html'), 'utf8'), /<meta name="robots" content="noindex, nofollow" \/><\/head>/);
      assert.equal(readFileSync(join(web, 'robots.txt'), 'utf8'), 'User-agent: *\nDisallow: /\n');
      // production: the build's own robots tag and robots.txt stay
      writeFileSync(join(web, 'index.html'), '<head><meta name="robots" content="index, follow" /></head>');
      writeFileSync(join(web, 'robots.txt'), 'User-agent: *\nAllow: /\n');
      runSite(`${shim}site_fill`, { WEB: web });
      assert.match(readFileSync(join(web, 'index.html'), 'utf8'), /content="index, follow"/);
      assert.equal(readFileSync(join(web, 'robots.txt'), 'utf8'), 'User-agent: *\nAllow: /\n');
    } finally {
      rmSync(web, { recursive: true, force: true });
    }
  });
});
