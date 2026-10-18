/**
 * pnpm playtest: the game on a public https link, for playing with a friend from this Mac.
 *
 *   1. builds the web app (production: no dev hooks, no tuning panel),
 *   2. starts the API (guest accounts, nicknames, room codes) and the game server (rooms by code,
 *      NODE_ENV=production: no dev commands, no DEBUG messages) on 127.0.0.1 only,
 *   3. puts the build, /api and /ws behind one local port (proxy.ts),
 *   4. opens a Cloudflare quick tunnel to it and prints the link, with a room ready to join.
 *
 * It rides out a flaky connection: the services and the proxy keep running whatever the tunnel
 * does, cloudflared reconnects by itself, and if it gives up it is started again (with backoff).
 * A new tunnel means a new address: the new link is printed in a box again and written to
 * `.playtest-link` (repo root). A service that crashes is restarted too. Only Ctrl-C stops it all.
 * The Mac must stay awake and online while people play (this keeps it from idle-sleeping).
 *
 * Players get into rooms with the API's join tickets (docs/06 §6): a key pair is made per run, the
 * API signs with one half and the game server checks with the other.
 *
 * Flags: --no-build (reuse apps/web/dist) · --local (no tunnel: http://127.0.0.1:<port>) ·
 *        --port <n> (the local proxy port) · --api-port <n> · --game-port <n> (default: any free ones) ·
 *        --tunnel-protocol quic|http2 (default quic, falling back to http2 when UDP is blocked) ·
 *        --map <id> (the rooms' map: movement-test by default; lunar-outpost, storm-front, flux-lab, …) ·
 *        --bots <n> (bots keep each room at n players: 4 by default, so two people get a real match;
 *        0 = no bots) · --bot-level easy|normal|hard (default normal)
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
// the brand lives in one place (packages/shared/src/brand.ts), as vite.config.ts reads it
import { GAME_NAME } from '../../../packages/shared/src/brand';
import { Backoff } from './backoff';
import { createProxy } from './proxy';
import { findCloudflared, startQuickTunnel, type Tunnel } from './tunnel';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const DIST = join(ROOT, 'apps', 'web', 'dist');
/** the current link, for whoever relays it (one line; removed on exit) */
export const LINK_FILE = join(ROOT, '.playtest-link');
const PID_FILE = join(tmpdir(), `military-forge-playtest-${process.pid}.pids`);
const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const option = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const tty = process.stdout.isTTY;
const paint = (code: string) => (s: string) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const bold = paint('1');
const dim = paint('2');
const green = paint('32');
const red = paint('31');
const cyan = paint('36');
const yellow = paint('33');
const say = (line = '') => process.stdout.write(`${line}\n`);
const clock = () => new Date().toLocaleTimeString();

let stopping = false;
const stoppers: (() => Promise<void>)[] = [];
let watchdog: ChildProcess | null = null;

async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const s = createNetServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolvePort(port));
    });
  });
}

/** Only what a service needs from this shell, so stray dev variables (NET_SIM, DATABASE_URL, …) stay out. */
function cleanEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const keep = ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'TERM', 'USER', 'SHELL', 'XDG_RUNTIME_DIR'];
  const env: NodeJS.ProcessEnv = {};
  for (const k of keep) if (process.env[k] !== undefined) env[k] = process.env[k];
  return { ...env, ...extra };
}

/** A process's output, line by line, through a filter (null drops the line). */
function pipeLines(child: ChildProcess, show: (line: string) => string | null): void {
  for (const stream of [child.stdout, child.stderr]) {
    if (!stream) continue;
    let buf = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk: string) => {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = show(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
        if (line !== null) say(line);
      }
    });
  }
}

function stopChild(child: ChildProcess | null): Promise<void> {
  return new Promise((done) => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return done();
    child.once('exit', () => done());
    child.kill('SIGTERM');
    setTimeout(() => {
      child.kill('SIGKILL');
      done();
    }, 5000).unref();
  });
}

/** A service that is started again whenever it stops, until Ctrl-C. */
class Supervised {
  child: ChildProcess | null = null;
  /** called after a restart (not the first start) */
  onRestart: () => void = () => {};
  private readonly backoff = new Backoff();
  private starts = 0;

  constructor(
    readonly name: string,
    private readonly cwd: string,
    private readonly entry: string,
    private readonly env: Record<string, string>,
    private readonly show: (line: string) => string | null,
  ) {
    stoppers.push(() => stopChild(this.child));
  }

  get pid(): number | undefined {
    return this.child?.pid;
  }

  start(): void {
    if (this.starts++ > 0) this.onRestart();
    // node --import tsx: one process per service (no wrapper), so signals reach it directly
    const child = spawn(process.execPath, ['--import', 'tsx', this.entry], { cwd: this.cwd, env: cleanEnv(this.env), stdio: ['ignore', 'pipe', 'pipe'] });
    this.child = child;
    this.backoff.started();
    pipeLines(child, this.show);
    writePids();
    child.on('exit', (code, signal) => {
      if (stopping) return;
      const delay = this.backoff.next();
      say(red(`  ${clock()}  ✖ The ${this.name} stopped (${signal ?? `exit ${code}`}); restarting in ${delay / 1000} s.`));
      setTimeout(() => !stopping && this.start(), delay);
    });
  }
}

/**
 * The quick tunnel, kept alive: cloudflared reconnects to Cloudflare's edge by itself; when it
 * exits (no edge for too long, a failed tunnel request) it is started again with backoff, which
 * gives a new address. QUIC first (lower, steadier latency); HTTP/2 when QUIC can't connect.
 */
/** How long a tunnel may sit without an edge connection before it is replaced (a new address). */
const TUNNEL_DOWN_LIMIT_MS = 90_000;

interface TunnelRun {
  tunnel: Tunnel;
  /** it has had a connection: from now on it can only be lost, not "not up yet" */
  up: boolean;
  lastError: string;
  metricsPort: number;
}

class TunnelKeeper {
  url: string | null = null;
  connected = false;
  private current: TunnelRun | null = null;
  private readonly backoff = new Backoff();
  private protocol: string;
  private readonly forced: boolean;
  private downSince = 0;

  constructor(
    private readonly bin: string,
    private readonly localUrl: string,
    protocol: string | undefined,
    private readonly onReady: (url: string) => void,
  ) {
    this.forced = protocol !== undefined;
    this.protocol = protocol ?? 'quic';
    stoppers.push(() => stopChild(this.current?.tunnel.process ?? null));
    // cloudflared's own /ready says whether the edge connection is up; it reconnects by itself,
    // but a tunnel that stays down is replaced
    setInterval(() => void this.checkHealth(), 5000).unref();
  }

  get pid(): number | undefined {
    return this.current?.tunnel.process.pid;
  }

  async start(): Promise<void> {
    const protocol = this.protocol;
    const metricsPort = await freePort();
    if (stopping) return;
    const run: TunnelRun = { tunnel: startQuickTunnel(this.bin, this.localUrl, (line) => this.onLine(run, line), protocol, metricsPort), up: false, lastError: '', metricsPort };
    const { tunnel } = run;
    this.current = run;
    this.connected = false;
    this.downSince = 0;
    this.backoff.started();
    writePids();
    // QUIC needs outbound UDP; a network without it never connects: use HTTP/2 instead
    const fallback = setTimeout(() => {
      if (run.up || this.forced || protocol !== 'quic' || stopping) return;
      say(yellow(`  ${clock()}  The tunnel can't connect over QUIC (UDP blocked?): switching to HTTP/2.`));
      this.protocol = 'http2';
      tunnel.process.kill('SIGTERM'); // the exit handler starts it again, now over HTTP/2
    }, 25_000);
    // both promises reject when cloudflared exits first: the exit handler below deals with that
    tunnel.url.then(
      (url) =>
        tunnel.connected.then(
          () => {
            if (this.current !== run) return;
            clearTimeout(fallback);
            run.up = true;
            this.connected = true;
            if (url !== this.url) {
              this.url = url;
              this.onReady(url);
            }
          },
          () => {},
        ),
      () => {},
    );
    tunnel.process.on('exit', (code) => {
      clearTimeout(fallback);
      if (stopping || this.current !== run) return;
      this.connected = false;
      const delay = this.backoff.next();
      const why = run.lastError ? `: ${run.lastError}` : '';
      say(yellow(`  ${clock()}  The tunnel closed (exit ${code}${why}). Starting a new one in ${delay / 1000} s${this.url ? ': the link will change' : ''}.`));
      setTimeout(() => !stopping && void this.start(), delay);
    });
  }

  /** Why a tunnel that never came up gave up (shown when it exits). */
  private onLine(run: TunnelRun, line: string): void {
    const err = /\b(?:ERR|failed)\b\s*(.*)$/i.exec(line);
    if (err && !run.up) run.lastError = err[1]!.replace(/\s+/g, ' ').slice(0, 140);
  }

  /** Edge drops and recoveries from cloudflared's /ready, one calm line each; replaced after TUNNEL_DOWN_LIMIT_MS. */
  private async checkHealth(): Promise<void> {
    const run = this.current;
    if (!run?.up || stopping) return;
    let ready: boolean;
    try {
      ready = (await fetch(`http://127.0.0.1:${run.metricsPort}/ready`, { signal: AbortSignal.timeout(3000) })).ok;
    } catch {
      ready = false;
    }
    if (this.current !== run || stopping) return;
    const now = Date.now();
    if (ready) {
      if (!this.connected) say(green(`  ${clock()}  Tunnel back up: the link still works.`));
      this.connected = true;
      this.downSince = 0;
      return;
    }
    if (this.connected) {
      this.connected = false;
      this.downSince = now;
      say(yellow(`  ${clock()}  The tunnel lost Cloudflare; retrying (the link stays the same if it's back within ${TUNNEL_DOWN_LIMIT_MS / 1000} s).`));
    } else if (this.downSince && now - this.downSince > TUNNEL_DOWN_LIMIT_MS) {
      this.downSince = 0;
      say(yellow(`  ${clock()}  The tunnel has been down for ${TUNNEL_DOWN_LIMIT_MS / 1000} s: replacing it (the link will change).`));
      run.tunnel.process.kill('SIGTERM'); // the exit handler starts a new one
    }
  }
}

/** Child PIDs for the watchdog (they change when something restarts). */
const pidSources: { pid: number | undefined }[] = [];
function writePids(): void {
  const pids = pidSources.map((s) => s.pid).filter((p): p is number => p !== undefined);
  try {
    writeFileSync(PID_FILE, pids.join(' '));
  } catch {
    /* the watchdog just has less to clean up */
  }
}

/** If this script is killed outright (no Ctrl-C), a tiny watchdog still takes the services and the tunnel down. */
function startWatchdog(): void {
  const code = `const fs = require('fs'); const [parent, file] = process.argv.slice(1);
setInterval(() => { try { process.kill(Number(parent), 0); } catch {
  try { for (const p of fs.readFileSync(file, 'utf8').split(' ').map(Number).filter(Boolean)) { try { process.kill(p, 'SIGTERM'); } catch {} } } catch {}
  try { fs.rmSync(file, { force: true }); } catch {}
  try { fs.rmSync(${JSON.stringify(LINK_FILE)}, { force: true }); } catch {}
  process.exit(0);
} }, 1000);`;
  watchdog = spawn(process.execPath, ['-e', code, String(process.pid), PID_FILE], { detached: true, stdio: 'ignore' });
  watchdog.unref();
}

async function shutdown(exitCode: number): Promise<void> {
  if (stopping) return;
  stopping = true;
  say(dim('\nStopping: the link is closing…'));
  watchdog?.kill();
  rmSync(LINK_FILE, { force: true });
  rmSync(PID_FILE, { force: true });
  await Promise.all(stoppers.map((stop) => stop()));
  say(dim('Stopped.'));
  process.exit(exitCode);
}

// only these stop everything (Ctrl-C, a kill, the terminal closing)
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(signal, () => void shutdown(0));

async function waitFor(what: string, check: () => Promise<boolean>, timeoutMs: number, everyMs = 300): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      if (await check()) return;
    } catch {
      /* not yet */
    }
    if (Date.now() > deadline) throw new Error(`${what} did not come up in ${timeoutMs / 1000} s`);
    await new Promise((r) => setTimeout(r, everyMs));
  }
}

/** A service coming up: as long as it takes (a busy Mac can need minutes), saying so every 30 s. */
async function waitForService(what: string, check: () => Promise<boolean>): Promise<void> {
  const since = Date.now();
  let told = since;
  for (;;) {
    try {
      if (await check()) return;
    } catch {
      /* not yet */
    }
    if (stopping) return;
    if (Date.now() - told > 30_000) {
      told = Date.now();
      say(dim(`  ${clock()}  Still waiting for the ${what} (${Math.round((told - since) / 1000)} s; this Mac is busy)…`));
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}

function build(): Promise<void> {
  return new Promise((done, fail) => {
    const child = spawn('pnpm', ['--filter', '@military-forge/web', 'build'], { cwd: ROOT, env: { ...process.env, NODE_ENV: 'production' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.stderr.on('data', (d: Buffer) => (out += d.toString()));
    child.on('error', fail);
    child.on('exit', (code) => (code === 0 ? done() : fail(new Error(`the web build failed:\n${out}`))));
  });
}

/** The box with the link: every line padded to the widest. */
function box(lines: { text: string; style?: (s: string) => string }[]): string[] {
  const width = Math.max(...lines.map((l) => l.text.length)) + 2;
  const row = (l: { text: string; style?: (s: string) => string }) => `  │ ${(l.style ?? ((x: string) => x))(l.text)}${' '.repeat(width - l.text.length - 1)}│`;
  return [`  ┌${'─'.repeat(width)}┐`, ...lines.map(row), `  └${'─'.repeat(width)}┘`];
}

async function main(): Promise<void> {
  const local = flag('local');
  say(bold(`\n  ${GAME_NAME} · playtest`) + dim('  (Ctrl-C stops everything)\n'));

  const cloudflared = local ? null : findCloudflared();
  if (!local && !cloudflared) {
    say(red('  cloudflared is not installed. Install it with: brew install cloudflared'));
    say(dim('  (or run pnpm playtest --local to play on this machine only)'));
    process.exit(1);
  }

  const proxyPort = Number(option('port') ?? (await freePort()));
  const apiPort = Number(option('api-port') ?? (await freePort()));
  const gamePort = Number(option('game-port') ?? (await freePort()));
  const base = `http://127.0.0.1:${proxyPort}`;
  const localOrigins = [base, `http://localhost:${proxyPort}`];
  let roomCode = '';
  let servicesUp = false;
  let announced: string | null = null;

  /** Prints the link in a box (again when it changed: a new tunnel or a new room) and writes .playtest-link. */
  const announce = (site: string, why = 'the tunnel was recreated') => {
    if (!servicesUp) return;
    const link = roomCode ? `${site}/r/${roomCode}` : site;
    if (link === announced) return;
    const again = announced !== null;
    announced = link;
    try {
      writeFileSync(LINK_FILE, `${link}\n`);
    } catch {
      /* the console still has it */
    }
    say('');
    for (const l of box([
      again
        ? { text: `The link CHANGED (${why}). Send this one:`, style: (x) => bold(yellow(x)) }
        : { text: 'Ready! Send this link to a friend, and open it yourself:', style: (x) => bold(green(x)) },
      { text: '' },
      { text: link, style: (x) => bold(cyan(x)) },
      { text: '' },
      { text: roomCode ? `Room ${roomCode}. Home page: ${site}` : `Home page: ${site}`, style: dim },
    ]))
      say(l);
    say(dim(`  (also in ${LINK_FILE})`));
    say('');
    if (again) return;
    if (site !== base) {
      say(dim('  • The link survives short outages; if the tunnel has to be recreated it changes, and the new one shows here.'));
      say(dim("  • Keep this Mac awake and online while you play (it won't idle-sleep while this runs)."));
      say(dim('  • Plays in a desktop browser (Chrome, Edge, Firefox, Safari) with a keyboard and mouse, or on a phone held sideways (touch controls).'));
    } else say(dim('  • --local: only this machine can open it.'));
    say('');
  };

  // the tunnel first (it takes the longest); its address can change, so nothing else depends on it
  const tunnel = cloudflared
    ? new TunnelKeeper(cloudflared, base, option('tunnel-protocol'), (url) => {
        void (async () => {
          // a new trycloudflare name takes a moment to resolve; an early miss would sit in the DNS cache
          await new Promise((r) => setTimeout(r, 2000));
          await waitFor('the public link', async () => (await fetch(`${url}/api/version`, { signal: AbortSignal.timeout(5000) })).ok, 30_000, 1500).catch(() =>
            say(yellow('  The new link is slow to resolve from this Mac; it usually works for others already.')),
          );
          if (tunnel?.url === url) announce(url);
        })();
      })
    : null;
  if (tunnel) pidSources.push(tunnel);
  if (tunnel) {
    say(dim('  Opening a Cloudflare quick tunnel…'));
    void tunnel.start();
  }

  // fresh keys per run (never written to disk, never sent to a browser): the API's access tokens,
  // and join tickets (the API signs them, the game server checks them)
  const accessKey = generateKeyPairSync('ed25519');
  const ticketKey = generateKeyPairSync('ed25519');
  const map = option('map');
  const bots = option('bots') ?? '4';
  const botLevel = option('bot-level') ?? 'normal';

  // the game server: rooms by code only, admitted by the API's tickets, no dev commands or DEBUG
  // messages (NODE_ENV=production); client addresses (the door's per-IP caps) come from the proxy
  const game = new Supervised(
    'game server',
    join(ROOT, 'apps', 'game-server'),
    'src/index.ts',
    {
      NODE_ENV: 'production',
      HOST: '127.0.0.1',
      PORT: String(gamePort),
      DEFAULT_ROOM: '0',
      MAX_ROOMS: '24',
      JOIN_TICKET_PUBLIC_KEY: ticketKey.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      TRUST_PROXY: '1',
      ...(map ? { MAP: map } : {}),
      BOTS: bots,
      BOT_LEVEL: botLevel,
    },
    // start-up, rooms opened/closed and refused joins; the 10 s tick reports are for development
    (line) => (/^\[game-server\]|^\[rooms\] (opened|closed|refused)|crash|rror/.test(line) ? dim(`  [game] ${line}`) : null),
  );
  pidSources.push(game);
  game.start();

  // the production build (no dev hooks, no tuning panel)
  if (!flag('no-build') || !existsSync(join(DIST, 'index.html'))) {
    say(dim('  Building the web app…'));
    await build();
  }

  const api = new Supervised(
    'API',
    join(ROOT, 'apps', 'api'),
    'src/index.ts',
    {
      // development = embedded Postgres (PGlite) + in-memory KV; production would need real ones
      NODE_ENV: 'development',
      API_HOST: '127.0.0.1',
      API_PORT: String(apiPort),
      PGLITE_DIR: 'memory://',
      ACCESS_TOKEN_PRIVATE_KEY: accessKey.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      JOIN_TICKET_PRIVATE_KEY: ticketKey.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      // the API trusts only this local origin; the proxy vouches for the tunnel's current one (CSRF)
      CORS_ORIGINS: localOrigins.join(','),
      COOKIE_SECURE: local ? 'false' : 'true',
      // rate limits per player IP: Cloudflare's CF-Connecting-IP (anything not from the tunnel is this Mac)
      TRUST_PROXY: local ? 'none' : 'cloudflare',
      LOG_LEVEL: 'warn',
    },
    (line) => (line.trim() ? dim(`  [api] ${line}`) : null),
  );
  pidSources.push(api);
  api.start();

  const allowedOrigins = () => (tunnel?.url ? [tunnel.url, ...localOrigins] : localOrigins);
  const server = createProxy({
    root: DIST,
    api: { host: '127.0.0.1', port: apiPort },
    game: { host: '127.0.0.1', port: gamePort },
    allowedOrigins,
    apiOrigin: base,
    log: (l) => say(dim(`  ${l}`)),
  });
  await new Promise<void>((done, fail) => {
    server.once('error', fail);
    server.listen(proxyPort, '127.0.0.1', done);
  });
  stoppers.push(async () => {
    server.closeAllConnections();
    server.close();
  });

  await waitForService('API', async () => (await fetch(`http://127.0.0.1:${apiPort}/health`)).ok);
  await waitForService('game server', async () => (await fetch(`http://127.0.0.1:${gamePort}/health`)).ok);
  writePids();
  startWatchdog();
  if (process.platform === 'darwin') {
    // keep the Mac from idle-sleeping while this runs (lid closed on battery still sleeps)
    const caffeinate = spawn('caffeinate', ['-i', '-w', String(process.pid)], { stdio: 'ignore' });
    caffeinate.on('error', () => {});
  }

  // a room ready to share: minted through the API like any player's (it outlives tunnel changes)
  const mintRoom = async () => {
    try {
      const guest = (await (await fetch(`${base}/api/auth/guest`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).json()) as { accessToken: string };
      const room = (await (await fetch(`${base}/api/rooms`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${guest.accessToken}` }, body: '{}' })).json()) as { code: string };
      roomCode = room.code;
    } catch {
      /* the home page still works: Play with friends makes one */
    }
  };
  await mintRoom();
  // a restarted API has forgotten the room codes: mint a new one and say so
  api.onRestart = () =>
    void waitForService('API', async () => (await fetch(`http://127.0.0.1:${apiPort}/health`)).ok)
      .then(mintRoom)
      .then(() => announce(tunnel?.url ?? base, 'the API restarted: new room'))
      .catch(() => {});

  servicesUp = true;
  if (!tunnel) announce(base);
  else if (tunnel.url && tunnel.connected) announce(tunnel.url);
  else say(dim(`  Services are up; waiting for the tunnel… (on this Mac meanwhile: ${base}${roomCode ? `/r/${roomCode}` : ''})`));

  // a quiet heartbeat: who's on
  let lastStatus = '';
  setInterval(async () => {
    try {
      const h = (await (await fetch(`http://127.0.0.1:${gamePort}/health`)).json()) as { players: number; rooms: number };
      const status = `${h.players} player${h.players === 1 ? '' : 's'} in ${h.rooms} room${h.rooms === 1 ? '' : 's'}`;
      if (status !== lastStatus) say(dim(`  ${clock()}  ${status}`));
      lastStatus = status;
    } catch {
      /* restarting, or stopping */
    }
  }, 5000).unref();
}

main().catch((e: unknown) => {
  say(red(`\n✖ ${(e as Error).message}`));
  void shutdown(1);
});
