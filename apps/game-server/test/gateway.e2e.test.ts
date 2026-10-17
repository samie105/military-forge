/**
 * The Rust↔TypeScript contract: the real gateway binary (apps/wt-gateway) against this server's
 * bridge, with real QUIC/WebTransport clients (its wt-probe binary). Skipped unless both are built:
 *   cd apps/wt-gateway && cargo build --release
 * CI runs it in .github/workflows/wt-gateway.yml.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createSocket } from 'node:dgram';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MsgType, encodeHello, encodeInput } from '@military-forge/protocol';
import { createInput } from '@military-forge/sim';
import { describe, expect, it } from 'vitest';
import { Room } from '../src/room';
import { startGatewayBridge } from '../src/transports';

const binDir = process.env.WT_GATEWAY_BIN_DIR ?? join(dirname(fileURLToPath(import.meta.url)), '../../wt-gateway/target/release');
const gatewayBin = join(binDir, 'wt-gateway');
const probeBin = join(binDir, 'wt-probe');
const built = existsSync(gatewayBin) && existsSync(probeBin);

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');

async function until(pred: () => boolean, what: string, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

function freeUdpPort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createSocket('udp4');
    s.bind(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

/** A scripted WebTransport client (wt-probe): commands on stdin, what arrives on stdout. */
class Probe {
  readonly lines: string[] = [];
  private readonly proc: ChildProcess;
  constructor(url: string, hash: string) {
    this.proc = spawn(probeBin, [url, hash], { stdio: ['pipe', 'pipe', 'inherit'] });
    let buf = '';
    this.proc.stdout!.on('data', (chunk: Buffer) => {
      buf += chunk.toString();
      const parts = buf.split('\n');
      buf = parts.pop()!;
      this.lines.push(...parts);
    });
  }
  send(line: string): void {
    this.proc.stdin!.write(`${line}\n`);
  }
  messages(kind: 'R' | 'D'): Uint8Array[] {
    return this.lines.filter((l) => l.startsWith(`${kind} `)).map((l) => Buffer.from(l.slice(2), 'hex'));
  }
  get closeCode(): number | null {
    const line = this.lines.find((l) => l.startsWith('CLOSED '));
    return line ? Number(line.split(' ')[1]) : null;
  }
  kill(): void {
    this.proc.kill();
  }
}

describe.skipIf(!built)('WebTransport gateway contract (real binaries)', () => {
  it('sessions play over QUIC; an oversized message ends only its own; SIGTERM drains to a resume', async () => {
    const room = new Room({ dummies: false, aoi: false, reconnectGraceMs: 20_000 });
    const sock = join(tmpdir(), `mm-gwe2e-${process.pid}.sock`);
    const bridge = await startGatewayBridge(sock, room);
    const port = await freeUdpPort();
    const env = { ...process.env, WT_ADDR: `127.0.0.1:${port}`, WT_PUBLIC_URL: `https://127.0.0.1:${port}/wt`, WT_SOCKET: sock };
    const gateway = spawn(gatewayBin, [], { env, stdio: ['ignore', 'ignore', 'inherit'] });
    const ticker = setInterval(() => room.tick(), 16);
    const probes: Probe[] = [];
    try {
      await until(() => bridge.info() !== null, 'the gateway');
      const { url, certHashes } = bridge.info()!;
      expect(url).toBe(`https://127.0.0.1:${port}/wt`);
      const join = async (name: string) => {
        const p = new Probe(url, certHashes[0]!);
        probes.push(p);
        await until(() => p.lines.includes('READY'), `${name} to connect`);
        p.send(`R ${hex(encodeHello(name))}`);
        await until(() => p.messages('R').some((m) => m[0] === MsgType.Welcome), `${name}'s WELCOME`);
        return p;
      };

      const a = await join('Alpha');
      // INPUT goes up as a datagram, snapshots come down as datagrams
      a.send(`D ${hex(encodeInput({ newestTick: room.game.tick & 0xffff, ackSnapshotSeq: 0, renderTick: 0, renderFrac: 0, inputs: [createInput()] }))}`);
      await until(() => a.messages('D').some((m) => m[0] === MsgType.Snapshot), 'snapshots over datagrams');

      // 65,535 bytes used to drop the whole bridge
      const b = await join('Bravo');
      b.send('BIG 65535');
      await until(() => b.closeCode !== null, "Bravo's close");
      expect(b.closeCode).toBe(4003);
      await until(() => room.humanCount === 1, 'Bravo to leave'); // ended like a kick
      const seen = a.messages('D').length;
      await until(() => a.messages('D').length > seen + 5, 'Alpha to keep getting snapshots');
      expect(a.closeCode).toBeNull();

      // a deploy: the gateway drains, Alpha's session closes with 1001 and keeps its slot to resume
      gateway.kill('SIGTERM');
      await until(() => a.closeCode !== null, "Alpha's close");
      expect(a.closeCode).toBe(1001);
      await until(() => bridge.info() === null, '/health to stop advertising');
      expect(room.humanCount).toBe(1);
    } finally {
      clearInterval(ticker);
      for (const p of probes) p.kill();
      gateway.kill();
      bridge.close();
    }
  }, 30_000);
});
