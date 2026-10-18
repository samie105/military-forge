/**
 * Round trip to a playtest's game server, the way the game measures ping: PING/PONG over the
 * room's WebSocket (through the tunnel when given the public link). No player joins.
 *
 *   pnpm --filter @military-forge/playtest run ping https://<words>.trycloudflare.com/r/KQXMZP [--count 40]
 *
 * Prints min / median / p90 / max in ms. PING is the protocol's 0x03 (u8 type + f64 client time);
 * the server answers PONG 0x04 with the same time even before a HELLO. A connection gets 5 s and a
 * few dozen messages without one (apps/game-server rooms.ts), so the pings go in short batches.
 */

/** The room's WebSocket URL from a playtest link (https://host/r/CODE, a home page, or ws(s)://…). */
export function socketUrlFor(link: string): string {
  const u = new URL(link);
  if (u.protocol === 'ws:' || u.protocol === 'wss:') return u.toString();
  const code = /^\/r\/([A-Za-z]{6})/.exec(u.pathname)?.[1]?.toUpperCase() ?? 'PNGPNG';
  return `${u.protocol === 'https:' ? 'wss' : 'ws'}://${u.host}/ws/${code}`;
}

export function encodePing(clientTime: number): Uint8Array {
  const out = new Uint8Array(9);
  out[0] = 0x03;
  new DataView(out.buffer).setFloat64(1, clientTime, true);
  return out;
}

/** The client time a PONG echoes, or null for anything else. */
export function pongTime(bytes: Uint8Array): number | null {
  if (bytes.length < 9 || bytes[0] !== 0x04) return null;
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getFloat64(1, true);
}

export function percentiles(samples: number[]): { min: number; median: number; p90: number; max: number; n: number } {
  const s = [...samples].sort((a, b) => a - b);
  const at = (q: number) => s[Math.min(s.length - 1, Math.floor(q * s.length))] ?? NaN;
  return { min: s[0] ?? NaN, median: at(0.5), p90: at(0.9), max: s[s.length - 1] ?? NaN, n: s.length };
}

/** pings per connection: well inside the server's allowance before a HELLO (5 s, 32 messages) */
const PER_SOCKET = 20;

export async function measure(link: string, count = 40, everyMs = 100): Promise<number[]> {
  const rtts: number[] = [];
  for (let sent = 0; sent < count; sent += PER_SOCKET) rtts.push(...(await batch(link, Math.min(PER_SOCKET, count - sent), everyMs)));
  return rtts;
}

async function batch(link: string, count: number, everyMs: number): Promise<number[]> {
  const ws = new WebSocket(socketUrlFor(link));
  ws.binaryType = 'arraybuffer';
  const rtts: number[] = [];
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error(`can't open ${socketUrlFor(link)}`));
  });
  ws.onmessage = (e) => {
    const t = pongTime(new Uint8Array(e.data as ArrayBuffer));
    if (t !== null) rtts.push(performance.now() - t);
  };
  for (let i = 0; i < count; i++) {
    ws.send(encodePing(performance.now()));
    await new Promise((r) => setTimeout(r, everyMs));
  }
  await new Promise((r) => setTimeout(r, 1500)); // the last answers
  ws.close();
  return rtts;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [link, ...rest] = process.argv.slice(2);
  if (!link) {
    console.error('usage: ping <playtest link> [--count 40]');
    process.exit(2);
  }
  const i = rest.indexOf('--count');
  const count = i >= 0 ? Number(rest[i + 1]) : 40;
  const p = percentiles(await measure(link, count));
  console.log(`${socketUrlFor(link)}: ${p.n}/${count} pongs · min ${p.min.toFixed(0)} · median ${p.median.toFixed(0)} · p90 ${p.p90.toFixed(0)} · max ${p.max.toFixed(0)} ms`);
}
