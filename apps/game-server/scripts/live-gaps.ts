/**
 * Snapshot gaps on a live server over WebTransport (QA, 23 Oct 2026: "gaps over 250 ms 2–8 times a
 * minute" on the trial box). A headless client makes a guest, opens a fresh room by code (the
 * server's bots fill it), joins it over WebTransport through apps/wt-gateway's `wt-probe` (with the
 * system's certificate roots), stands in it and logs when each snapshot arrives:
 *
 *   - its seq: a jump is snapshots lost on the way (the path);
 *   - its server tick: a long gap with nothing lost and the ticks in step is a late arrival: a
 *     server stall (the box's 10 s room log shows it as `max` tick ms or `dropped` ticks) or a delay
 *     on the path. The same minute's room log tells which.
 *
 * It leaves the room at the end (Leave, then the session closes).
 *
 *   pnpm --filter @military-forge/game-server exec tsx scripts/live-gaps.ts <https://host> <wt-probe> [minutes=5] [out.json]
 */
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { NetClient } from '@military-forge/netcode';
import { CmdKind, MsgType, encodeCmd, isUnreliableMessage } from '@military-forge/protocol';

const [base = '', probe = '', minutesArg = '5', outFile = ''] = process.argv.slice(2);
if (!/^https:\/\//.test(base) || !probe) {
  console.error('usage: live-gaps.ts <https://host> <path to wt-probe> [minutes=5] [out.json]');
  process.exit(2);
}
const minutes = Number(minutesArg);
const TICK_MS = 1000 / 60;
const MAX_DATAGRAM = 1000;
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

async function api<T>(path: string, body: unknown, token?: string): Promise<T> {
  const res = await fetch(`${base}/api${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

interface Arrival {
  /** ms since the session opened, and wall clock */
  t: number;
  wall: number;
  seq: number;
  tick: number;
  /** came on the reliable stream (too big for a datagram) */
  stream: boolean;
}

async function main(): Promise<void> {
  const guest = await api<{ accessToken: string; user: { nickname: string } }>('/auth/guest', {});
  const room = await api<{ code: string; gsUrl: string | null; ticket: string | null }>('/rooms', {}, guest.accessToken);
  const health = (await (await fetch(`${base}/health`)).json()) as { webtransport?: { url: string; rooms?: boolean } | null };
  const wt = health.webtransport;
  if (!wt?.rooms) throw new Error(`no WebTransport for rooms by code on ${base}: ${JSON.stringify(health.webtransport ?? null)}`);
  const url = new URL(wt.url);
  url.searchParams.set('room', room.code);
  console.log(`[live-gaps] ${guest.user.nickname} in room ${room.code} over ${url.host} for ${minutes} min`);

  const child = spawn(probe, [url.toString(), 'system'], { stdio: ['pipe', 'pipe', 'inherit'] });
  const write = (line: string) => child.stdin.write(`${line}\n`);
  const net = new NetClient({
    name: guest.user.nickname,
    ticket: room.ticket ?? '',
    now: () => performance.now(),
    send: (bytes) => write(`${isUnreliableMessage(bytes) && bytes.length <= MAX_DATAGRAM ? 'D' : 'R'} ${hex(bytes)}`),
    stream: () => false,
    ownContent: false,
  });

  const arrivals: Arrival[] = [];
  let opened = 0;
  let closed = '';
  let lastFrame = 0;
  let frames: NodeJS.Timeout | null = null;
  const done = new Promise<void>((resolve) => child.on('exit', () => resolve()));
  createInterface({ input: child.stdout }).on('line', (line) => {
    const now = performance.now();
    if (line === 'READY') {
      opened = now;
      lastFrame = now;
      net.onOpen();
      // ~60 fps frames: inputs (standing still), acks and pings, as a browser tab would
      frames = setInterval(() => {
        const t = performance.now();
        net.update((t - lastFrame) / 1000, (_me, out) => {
          out.buttons = 0;
        });
        net.remoteRenderTick(t);
        lastFrame = t;
      }, TICK_MS);
      return;
    }
    if (line.startsWith('CLOSED')) {
      closed = line;
      return;
    }
    const kind = line[0];
    if ((kind !== 'D' && kind !== 'R') || line[1] !== ' ') return;
    const bytes = new Uint8Array(Buffer.from(line.slice(2), 'hex'));
    if (bytes[0] === MsgType.Snapshot && bytes.length >= 7) {
      arrivals.push({
        t: now - opened,
        wall: Date.now(),
        seq: bytes[1]! | (bytes[2]! << 8),
        tick: (bytes[3]! | (bytes[4]! << 8) | (bytes[5]! << 16) | (bytes[6]! << 24)) >>> 0,
        stream: kind === 'R',
      });
    }
    net.receive(bytes);
  });

  const startWall = new Date();
  await new Promise((r) => setTimeout(r, minutes * 60_000));
  const endWall = new Date();
  // leave the room, then close the session
  write(`R ${hex(encodeCmd(CmdKind.Leave, ''))}`);
  await new Promise((r) => setTimeout(r, 500));
  write('QUIT');
  if (frames) clearInterval(frames);
  await Promise.race([done, new Promise((r) => setTimeout(r, 3000))]);
  if (child.exitCode === null) child.kill('SIGTERM');

  // gaps between snapshots that arrived, in arrival order (a reordered one counts as on time)
  const gaps: { at: string; ms: number; lost: number; serverMs: number; late: number }[] = [];
  let lostTotal = 0;
  for (let i = 1; i < arrivals.length; i++) {
    const a = arrivals[i - 1]!;
    const b = arrivals[i]!;
    const lost = Math.max(0, ((b.seq - a.seq + 0x10000) & 0xffff) - 1);
    lostTotal += lost;
    const ms = b.t - a.t;
    const serverMs = (b.tick - a.tick) * TICK_MS;
    if (ms >= 100) gaps.push({ at: new Date(b.wall).toISOString(), ms: Math.round(ms), lost, serverMs: Math.round(serverMs), late: Math.round(ms - serverMs) });
  }
  const span = arrivals.length ? (arrivals.at(-1)!.t - arrivals[0]!.t) / 60_000 : 0;
  const summary = {
    room: room.code,
    from: startWall.toISOString(),
    to: endWall.toISOString(),
    minutes: Number(span.toFixed(2)),
    snapshots: arrivals.length,
    viaStream: arrivals.filter((a) => a.stream).length,
    lost: lostTotal,
    lossPct: Number(((100 * lostTotal) / Math.max(1, arrivals.length + lostTotal)).toFixed(2)),
    rttMedianMs: Math.round(net.rtt.median),
    /** everyone in the newest snapshot (us and the bots) */
    players: net.snapshots.at(-1)?.msg.players.length ?? 0,
    gaps250: gaps.filter((g) => g.ms >= 250).length,
    gaps100: gaps.length,
    closed,
  };
  console.log(JSON.stringify(summary));
  for (const g of gaps.filter((x) => x.ms >= 250)) console.log(`  gap ${g.ms} ms at ${g.at}: ${g.lost} lost, server ticks spanned ${g.serverMs} ms, arrived ${g.late} ms later than that`);
  if (outFile) writeFileSync(outFile, JSON.stringify({ summary, gaps, arrivals }, null, 1));
}

main().catch((e: unknown) => {
  console.error('[live-gaps]', (e as Error).message);
  process.exit(1);
});
