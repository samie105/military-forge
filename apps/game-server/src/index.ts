import { homedir } from 'node:os';
import { join } from 'node:path';
import { BOT_LEVELS, queueNavGraphs, warmNavGraphs, type BotLevelId } from '@military-forge/bots';
import { ADMIN_BOT_LEVELS, adminTuning, adminValue, maps, setAdminDefault } from '@military-forge/content';
import { adminValues, loadAdminDefaults, setAdminValues, startAdminServer } from './admin';
import { describeNetSim, parseNetSim } from '@military-forge/netcode';
import { CloseCode } from '@military-forge/protocol';
import { ResultsReporter, resultsPrivateKey } from './results';
import { createServer, nodeScheduler } from './server';
import { TicketVerifier, ticketPublicKey } from './tickets';
import { defaultGatewaySocket } from './transports';

const port = Number(process.env.PORT ?? 9001);
const dev = process.env.NODE_ENV !== 'production';
// HOST=127.0.0.1 keeps the server behind a local proxy (pnpm playtest); DEFAULT_ROOM=0 drops the
// uncoded dev room so only rooms by code (rooms.ts) exist; MAX_ROOMS caps them.
const host = process.env.HOST || undefined;
const defaultRoom = process.env.DEFAULT_ROOM !== '0';
const maxRooms = process.env.MAX_ROOMS ? Number(process.env.MAX_ROOMS) : undefined;
// Join tickets (docs/06 §6): JOIN_TICKET_PUBLIC_KEY is the API's ticket key (PEM). With it, a new
// player in a room by code needs the API's ticket; production refuses to run rooms without it.
// TRUST_PROXY=1: client addresses from X-Forwarded-For (only behind our own proxy, pnpm playtest).
const ticketKeyPem = process.env.JOIN_TICKET_PUBLIC_KEY;
let tickets: TicketVerifier | null = null;
try {
  tickets = ticketKeyPem ? new TicketVerifier(ticketPublicKey(ticketKeyPem)) : null;
} catch (e) {
  console.error(`[game-server] JOIN_TICKET_PUBLIC_KEY: ${(e as Error).message}`);
  process.exit(1);
}
if (!dev && !tickets) {
  console.error(`[game-server] production needs JOIN_TICKET_PUBLIC_KEY (the API's join-ticket public key, PEM): rooms by code admit players with the API's tickets only`);
  process.exit(1);
}
const trustProxy = process.env.TRUST_PROXY === '1' || process.env.TRUST_PROXY === 'true';
// Network conditioner on every connection (docs/05 §15.2), e.g. NET_SIM="rtt=150,loss=2" or --net-sim=rtt=150,loss=2
const netSimSpec = process.argv.find((a) => a.startsWith('--net-sim='))?.slice('--net-sim='.length) ?? process.env.NET_SIM;
const netSim = dev ? parseNetSim(netSimSpec) : null;
// WebTransport gateway socket (apps/wt-gateway connects to it). Dev: on by default, one per port,
// in a private directory. Production: --wt-socket= or WT_SOCKET (e.g. /run/military-forge/gs1.sock).
const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const devSocket = () => {
  try {
    return defaultGatewaySocket(port);
  } catch (e) {
    console.log(`[game-server] no WebTransport (WebSocket only): ${(e as Error).message}`);
    return undefined;
  }
};
const wtSocket = arg('wt-socket') ?? process.env.WT_SOCKET ?? (dev ? devSocket() : undefined);
// The room's map: --map=flux-lab or MAP=flux-lab (docs/02 §20 demo maps: lunar-outpost, storm-front, flux-lab)
const mapId = arg('map') ?? process.env.MAP ?? 'movement-test';
if (!maps[mapId]) {
  console.error(`[game-server] unknown map "${mapId}" (maps: ${Object.keys(maps).join(', ')})`);
  process.exit(1);
}
// Bots (docs/08 §9): --bots=4 or BOTS=4 keeps every room with a human in it at 4 players, topping
// it up with bots ([BOT] names); --bot-level= or BOT_LEVEL= easy|normal|hard (default normal).
const botTarget = Number(arg('bots') ?? process.env.BOTS ?? 0);
const botLevel = (arg('bot-level') ?? process.env.BOT_LEVEL ?? 'normal') as BotLevelId;
if (!Number.isInteger(botTarget) || botTarget < 0 || !Object.hasOwn(BOT_LEVELS, botLevel)) {
  console.error(`[game-server] bots: --bots= takes a whole number of players, --bot-level= one of ${Object.keys(BOT_LEVELS).join(', ')}`);
  process.exit(1);
}
const fillBots = botTarget > 0 ? { target: botTarget, level: botLevel } : undefined;
// Live tuning by a room's host (the tuning panel in the in-match menu; nobody else may): HOST_TUNING=1
// (pnpm playtest --tune). On by default in development, off in production unless asked for.
const hostTuning = process.env.HOST_TUNING === '1' || (dev && process.env.HOST_TUNING !== '0');
// The test armory (one of every gun on a rack near the spawns): --armory or ARMORY=1 (the playtest's default)
const armory = process.argv.includes('--armory') || process.env.ARMORY === '1' || process.env.ARMORY === 'true';
// Lag compensation (docs/05 §7.1): LAG_COMP_LATENCY_MS is the latency a shot is rewound for, on top
// of the most a shooter's view can lag (200 ms); default 250 ms (450 ms of rewind). The admin page's
// net.lagCompMs changes it live. LAG_COMP_MAX_MS (a total; the trial box ran 900 ms, and players were
// hit up to 0.9 s after reaching cover: QA, 23 Oct 2026) is no longer read.
const lagCompLatencyMs = process.env.LAG_COMP_LATENCY_MS ? Number(process.env.LAG_COMP_LATENCY_MS) : undefined;
if (lagCompLatencyMs !== undefined && !(lagCompLatencyMs >= 0 && lagCompLatencyMs <= 1000)) {
  console.error('[game-server] LAG_COMP_LATENCY_MS takes 0–1000 (ms)');
  process.exit(1);
}
if (process.env.LAG_COMP_MAX_MS) console.log(`[game-server] LAG_COMP_MAX_MS=${process.env.LAG_COMP_MAX_MS} is no longer read: the rewind cap is LAG_COMP_LATENCY_MS (default 250 ms of latency) or the admin page's`);
if (lagCompLatencyMs !== undefined) setAdminDefault('net.lagCompMs', lagCompLatencyMs);
const lagComp = lagCompLatencyMs !== undefined ? { lagComp: { latencyCapMs: lagCompLatencyMs } } : {};

// The owner's admin page (pnpm playtest → /admin): ADMIN_TOKEN (the run's secret, 16+ characters)
// and ADMIN_PORT turn its API on (127.0.0.1, behind the playtest proxy). The values saved with
// "Save as defaults" (ADMIN_DEFAULTS, default ~/.military-forge/admin-defaults.json) apply from the start.
const adminToken = process.env.ADMIN_TOKEN ?? '';
const adminPort = Number(process.env.ADMIN_PORT ?? 0);
const adminDefaults = process.env.ADMIN_DEFAULTS || join(homedir(), '.military-forge', 'admin-defaults.json');
setAdminDefault('bots.count', botTarget);
setAdminDefault('bots.level', ADMIN_BOT_LEVELS.indexOf(botLevel as (typeof ADMIN_BOT_LEVELS)[number]));
if (adminToken) {
  const saved = loadAdminDefaults(adminDefaults, console.log);
  if (Object.keys(saved).length) {
    setAdminValues(saved);
    console.log(`[admin] ${Object.keys(saved).length} saved values from ${adminDefaults}`);
  }
}
// A nav graph takes 90–330 ms to build. Rooms never build one on a tick (they queue it for the time
// between ticks and their bots wait), so build the rooms' map now, before anyone joins, for the
// tuning the rooms start on (the admin page's saved values) and the defaults; the other maps (a host
// can switch) build in the spare time between ticks once the server runs.
if (fillBots || adminValue(adminValues(), 'bots.count') > 0) {
  const t0 = performance.now();
  const startTuning = adminTuning(adminValues());
  warmNavGraphs([maps[mapId]!], startTuning);
  if (Object.keys(startTuning).length) warmNavGraphs([maps[mapId]!]);
  queueNavGraphs(Object.values(maps).filter((m) => m.id !== mapId), startTuning);
  console.log(`[game-server] bots' nav graph for ${mapId} built in ${(performance.now() - t0).toFixed(0)} ms; the other maps build between ticks`);
}

// Match results (docs/07 §12): RESULTS_PRIVATE_KEY (an Ed25519 key of its own, PEM; the API holds
// its public half as RESULTS_PUBLIC_KEY) and API_URL (the API's base, e.g. http://127.0.0.1:8787)
// send each finished match in a room by code to the API, signed. Without them nothing is recorded.
let results: ResultsReporter | null = null;
if (process.env.RESULTS_PRIVATE_KEY && process.env.API_URL) {
  try {
    results = new ResultsReporter(process.env.API_URL.replace(/\/+$/, ''), resultsPrivateKey(process.env.RESULTS_PRIVATE_KEY));
  } catch (e) {
    console.error(`[game-server] RESULTS_PRIVATE_KEY: ${(e as Error).message}`);
    process.exit(1);
  }
}

const server = await createServer(
  port,
  {
    dev,
    // bots take the dummies' place in the default room
    dummies: !fillBots,
    ...(fillBots ? { fillBots } : {}),
    ...(armory ? { armory } : {}),
    ...lagComp,
    mapId,
    seed: Number(process.env.SEED ?? 1),
    ...(netSim ? { netSim: { settings: netSim, scheduler: nodeScheduler } } : {}),
  },
  console.log,
  'uws',
  // the bridge opens sessions through the room registry, rooms by code included (NOTES §16): a
  // server without the default room (DEFAULT_ROOM=0, the trial box) needs it as much
  wtSocket,
  {
    ...(host ? { host } : {}),
    defaultRoom,
    ...(maxRooms !== undefined && Number.isInteger(maxRooms) && maxRooms >= 0 ? { maxRooms } : {}),
    // rooms by code play the same map (one map per room until rooms can switch)
    // results and play stats (docs/16) go to the API through one signed reporter
    roomOptions: { mapId, hostTuning, ...(fillBots ? { fillBots } : {}), ...(armory ? { armory } : {}), ...lagComp, results, stats: results },
    tickets,
    trustProxy,
  },
);
console.log(
  `[game-server] ${server.room ? `room "${server.room.game.map.id}"` : 'no default room'} + rooms by code on ws://${host ?? 'localhost'}:${server.port} · transport ${server.transport === 'uws' ? 'uWebSockets.js' : 'ws (fallback)'} · dev commands ${dev ? 'on' : 'off'}` +
    ` · join tickets ${tickets ? 'required' : 'off (dev)'}` +
    ` · match results ${results ? 'sent to the API' : 'not recorded'}` +
    (fillBots ? ` · bots fill rooms to ${fillBots.target} (${fillBots.level})` : '') +
    (hostTuning ? ' · hosts may tune their rooms' : '') +
    (armory ? ' · test armory on (one of every gun by the spawns)' : '') +
    (lagCompLatencyMs !== undefined ? ` · lag compensation for up to ${lagCompLatencyMs} ms of latency` : '') +
    (netSim ? ` · NET_SIM ${describeNetSim(netSim)}` : '') +
    (wtSocket ? ` · WebTransport gateway socket ${wtSocket}` : ''),
);

const admin =
  adminToken && adminPort > 0
    ? await startAdminServer({ token: adminToken, port: adminPort, defaultsFile: adminDefaults, log: console.log }).catch((e: Error) => {
        console.error(`[admin] no admin page: ${e.message}`);
        return null;
      })
    : null;
if (admin) console.log(`[admin] admin API on 127.0.0.1:${admin.port} (the playtest's /admin; defaults save to ${adminDefaults})`);

/** Everyone is told the server is updating (they rejoin when it's back), then it stops. */
function stop(): void {
  server.rooms.closeEveryone(CloseCode.ServerUpdating, 'server updated: rejoin');
  // let the closes go out
  setTimeout(() => {
    admin?.close();
    server.close();
    process.exit(0);
  }, 300);
}
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, stop);

// An update without dropping live matches (scripts/net-trial/restart.sh): SIGUSR2 drains: no new
// rooms; once no match is counting down, being played or showing results (DRAIN_MAX_MS at most,
// default 10 min), everyone is told to rejoin and the server stops (systemd starts the new code).
const drainMaxMs = Number(process.env.DRAIN_MAX_MS ?? 600_000);
process.on('SIGUSR2', () => {
  if (server.rooms.draining) return;
  server.rooms.draining = true;
  const since = Date.now();
  console.log(`[game-server] draining for an update: no new rooms; stopping when no match is running (${Math.round(drainMaxMs / 60_000)} min at most)`);
  const wait = setInterval(() => {
    const over = Date.now() - since >= drainMaxMs;
    if (server.rooms.matchRunning && !over) return;
    clearInterval(wait);
    console.log(`[game-server] drained after ${((Date.now() - since) / 1000).toFixed(0)} s${over ? ' (the cap: matches still running were ended)' : ''}: stopping for the update`);
    stop();
  }, 1000);
});
