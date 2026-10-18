/**
 * A Cloudflare quick tunnel (`cloudflared tunnel --url …`): a random https://<words>.trycloudflare.com
 * address that forwards to a local port. No account, no config; the address changes on every run
 * and stops working the moment cloudflared exits.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';

const URL_PATTERN = /https:\/\/[a-z0-9]+(?:-[a-z0-9]+)*\.trycloudflare\.com/;

/** The tunnel's public URL from one line of cloudflared's log, or null. */
export function parseTunnelUrl(line: string): string | null {
  const m = URL_PATTERN.exec(line);
  return m && m[0] !== 'https://api.trycloudflare.com' ? m[0] : null;
}

/** cloudflared on PATH, or in Homebrew's usual places; null when it isn't installed. */
export function findCloudflared(): string | null {
  if (process.env.CLOUDFLARED && existsSync(process.env.CLOUDFLARED)) return process.env.CLOUDFLARED;
  for (const p of ['/opt/homebrew/bin/cloudflared', '/usr/local/bin/cloudflared']) if (existsSync(p)) return p;
  const which = spawnSync('which', ['cloudflared'], { encoding: 'utf8' });
  const found = which.status === 0 ? which.stdout.trim() : '';
  return found || null;
}

export interface Tunnel {
  readonly process: ChildProcess;
  /** resolves with the public URL as soon as Cloudflare assigns it; rejects if cloudflared exits or stays silent */
  readonly url: Promise<string>;
  /** resolves once the tunnel's connection to the edge is up (the URL answers from then on) */
  readonly connected: Promise<void>;
}

/** cloudflared's log line once a connection to Cloudflare's edge is registered. */
export const isConnectedLine = (line: string): boolean => /Registered tunnel connection/.test(line);

/**
 * @param protocol 'http2' (default) runs over TCP 443/7844 and works on networks that block UDP;
 *   'quic' / 'auto' prefer UDP
 */
/**
 * @param metricsPort cloudflared's metrics server (127.0.0.1): `/ready` answers 200 while the tunnel
 *   has a connection to Cloudflare's edge, 503 while it has none
 */
export function startQuickTunnel(bin: string, localUrl: string, log: (line: string) => void, protocol = 'http2', metricsPort?: number, timeoutMs = 90_000): Tunnel {
  // --grace-period: on Ctrl-C, don't hold the game's WebSockets open for cloudflared's default 30 s
  const metrics = metricsPort ? ['--metrics', `127.0.0.1:${metricsPort}`] : [];
  const child = spawn(bin, ['tunnel', '--no-autoupdate', '--grace-period', '1s', '--protocol', protocol, ...metrics, '--url', localUrl], { stdio: ['ignore', 'pipe', 'pipe'] });
  let markConnected: () => void = () => {};
  let failConnected: (e: Error) => void = () => {};
  const connected = new Promise<void>((resolve, reject) => {
    markConnected = resolve;
    failConnected = reject;
  });
  const url = new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      const e = new Error(`cloudflared gave no tunnel address in ${timeoutMs / 1000} s`);
      reject(e);
      failConnected(e);
    }, timeoutMs);
    const onLine = (line: string) => {
      const found = parseTunnelUrl(line);
      if (found) resolve(found);
      if (isConnectedLine(line)) {
        clearTimeout(timer);
        markConnected();
      }
      log(line);
    };
    for (const stream of [child.stdout, child.stderr]) {
      let buf = '';
      stream.setEncoding('utf8');
      stream.on('data', (chunk: string) => {
        buf += chunk;
        let nl: number;
        while ((nl = buf.indexOf('\n')) >= 0) {
          onLine(buf.slice(0, nl));
          buf = buf.slice(nl + 1);
        }
      });
    }
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
      failConnected(e);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      const e = new Error(`cloudflared exited (${code}) before the tunnel was up`);
      reject(e);
      failConnected(e);
    });
  });
  // the caller awaits them; an early exit after success must not be an unhandled rejection
  url.catch(() => {});
  connected.catch(() => {});
  return { process: child, url, connected };
}
