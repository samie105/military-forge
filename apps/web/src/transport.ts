/**
 * Game transports (docs/05 §2): WebSocket (TCP) everywhere, WebTransport (QUIC/UDP) where the
 * browser and the server support it.
 *
 * WebTransport splits traffic the way the protocol intends: messages marked unreliable (INPUT,
 * PING) go out as datagrams, so a lost packet costs just that message instead of stalling
 * everything behind it the way a TCP retransmit does. Everything else uses one long-lived
 * bidirectional stream with u16 length prefixes (§2.3: Safari leaks flow-control credit with a
 * stream per message).
 *
 * Selection (§2.1): try WebTransport first (4 s to become ready), insist on real datagrams
 * (Safari may silently fall back to HTTP/2 without them), and fall back to WebSocket. Only a
 * failure that says "this network blocks UDP" (no handshake within 4 s, or no datagrams) on a first
 * connect is remembered, for an hour, per network type and server host, so a doomed network doesn't
 * pay 4 s every time. A refused or broken gateway (4xx/5xx, a reset) costs one attempt, nothing more.
 * Once a session has fallen back to WebSocket it stays there until the page reloads.
 */
import { isUnreliableMessage } from '@military-forge/protocol';

/** 'lan': a local room's WebRTC data channels, or the host's own in-page link (lan/) */
export type TransportKind = 'ws' | 'wt' | 'lan';

export interface TransportHandlers {
  onMessage(bytes: Uint8Array): void;
  /** the transport is gone (code/reason as close codes; WebTransport errors map to 1006) */
  onClose(code: number, reason: string): void;
}

export interface GameTransport {
  readonly kind: TransportKind;
  send(bytes: Uint8Array): void;
  /** bytes queued but not sent yet: WebSocket's bufferedAmount (WebTransport: 0, a full datagram queue drops) */
  backlog(): number;
  close(code?: number, reason?: string): void;
}

/** Server-advertised WebTransport endpoint (game server /health → `webtransport`). */
export interface WebTransportEndpoint {
  url: string;
  /** hex SHA-256 of a short-lived self-signed certificate (dev); empty with a real certificate */
  certHashes: string[];
  /**
   * The server routes WebTransport sessions by room code (`?room=`), as it does WebSocket URLs.
   * Without it a session lands in the default room, so a room by code stays on WebSocket.
   */
  rooms?: boolean;
}

/**
 * The room a WebSocket URL names, as the game server reads it (`/ws/CODE`, `/CODE` or `?room=CODE`),
 * or '' for the default room. The server validates it; this only carries it across.
 */
export function roomOfUrl(wsUrl: string): string {
  let u: URL;
  try {
    u = new URL(wsUrl);
  } catch {
    return '';
  }
  return u.searchParams.get('room') ?? u.pathname.replace(/^\/ws(?=\/|$)/, '').replace(/^\/+|\/+$/g, '');
}

/** The WebTransport URL for a room: the endpoint's, with `?room=` when there is one. */
export function webTransportUrl(endpoint: WebTransportEndpoint, room: string): string {
  if (!room) return endpoint.url;
  const u = new URL(endpoint.url);
  u.searchParams.set('room', room);
  return u.toString();
}

/** Datagram budget (§2.3): never fragment; bigger unreliable messages use the stream. */
const MAX_DATAGRAM_BYTES = 1000;
/**
 * A WebTransport handshake takes ~2 round trips (QUIC, then the CONNECT): 0.3 s at 150 ms, but ~1 s
 * at the 500 ms Nigerian phones measured on 19 Oct 2026, with a tail past 1.3 s. 2 s timed out on
 * those, and the timeout was remembered as "this network blocks UDP" for an hour.
 */
const WT_READY_TIMEOUT_MS = 4000;
const FAILURE_MEMORY_MS = 3600 * 1000;

/** Why WebTransport didn't work. `networkBlocksIt`: the signature of a network that drops UDP. */
export class WebTransportUnavailable extends Error {
  constructor(
    message: string,
    readonly networkBlocksIt: boolean,
  ) {
    super(message);
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, error: () => Error): Promise<T> {
  let timer = 0;
  return Promise.race([p, new Promise<never>((_, reject) => (timer = window.setTimeout(() => reject(error()), ms)))]).finally(() => window.clearTimeout(timer));
}

// ---------- WebSocket ----------

/**
 * A WebSocket that hasn't opened in this long won't (a dark path: TCP keeps trying for minutes).
 * Opening takes ~3 round trips (TCP, TLS, the upgrade): ~1.5 s at 500 ms, ~4 s in a bad tail.
 */
export const WS_CONNECT_TIMEOUT_MS = 6000;

export function openWebSocket(url: string, handlers: TransportHandlers, timeoutMs = WS_CONNECT_TIMEOUT_MS): Promise<GameTransport> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    let open = false;
    const timer = window.setTimeout(() => {
      if (open) return;
      ws.onclose = null;
      try {
        ws.close();
      } catch {
        /* still connecting: it's dropped */
      }
      reject(new Error(`WebSocket not open in ${timeoutMs / 1000} s`));
    }, timeoutMs);
    const transport: GameTransport = {
      kind: 'ws',
      send(bytes) {
        // encoders return fresh ArrayBuffer-backed copies (never SharedArrayBuffer)
        if (ws.readyState === WebSocket.OPEN) ws.send(bytes as Uint8Array<ArrayBuffer>);
      },
      backlog: () => ws.bufferedAmount,
      close(code = 1000, reason = '') {
        ws.close(code, reason);
      },
    };
    ws.onopen = () => {
      open = true;
      window.clearTimeout(timer);
      resolve(transport);
    };
    ws.onmessage = (ev) => handlers.onMessage(new Uint8Array(ev.data as ArrayBuffer));
    ws.onclose = (ev) => {
      window.clearTimeout(timer);
      if (!open) reject(new Error(`WebSocket closed before opening (${ev.code})`));
      else handlers.onClose(ev.code, ev.reason);
    };
  });
}

// ---------- WebTransport ----------

function hexToBytes(hex: string): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Failure memory key: network type (Network Information API where available) and server host. */
function networkKey(endpoint: WebTransportEndpoint): string {
  const c = (navigator as Navigator & { connection?: { type?: string; effectiveType?: string } }).connection;
  let host = 'unknown';
  try {
    host = new URL(endpoint.url).host;
  } catch {
    /* keep 'unknown' */
  }
  return `mm.wt.blocked.${c?.type ?? c?.effectiveType ?? 'unknown'}.${host}`;
}

function rememberedFailure(endpoint: WebTransportEndpoint): boolean {
  try {
    const at = Number(localStorage.getItem(networkKey(endpoint)) ?? 0);
    return Date.now() - at < FAILURE_MEMORY_MS;
  } catch {
    return false;
  }
}

function rememberFailure(endpoint: WebTransportEndpoint, failed: boolean): void {
  try {
    if (failed) localStorage.setItem(networkKey(endpoint), String(Date.now()));
    else localStorage.removeItem(networkKey(endpoint));
  } catch {
    /* private mode etc.: no memory, no problem */
  }
}

/**
 * Opens a WebTransport session with a reliable stream and datagrams, or throws
 * WebTransportUnavailable (timeout, no datagram support, refused) so the caller can fall back to
 * WebSocket.
 */
export async function openWebTransport(endpoint: WebTransportEndpoint, handlers: TransportHandlers): Promise<GameTransport> {
  if (!('WebTransport' in window)) throw new WebTransportUnavailable('WebTransport not supported', false);
  const options: WebTransportOptions = { requireUnreliable: true };
  if (endpoint.certHashes.length) options.serverCertificateHashes = endpoint.certHashes.map((h) => ({ algorithm: 'sha-256', value: hexToBytes(h) }));
  const wt = new WebTransport(endpoint.url, options);
  wt.closed.catch(() => {}); // observed below once open; never an unhandled rejection before that
  let stream: WebTransportBidirectionalStream;
  try {
    // no answer at all in 4 s is what a UDP-blocking network looks like; a quick refusal (a 4xx/5xx,
    // connection refused) is just this server, this time
    await withTimeout(wt.ready, WT_READY_TIMEOUT_MS, () => new WebTransportUnavailable(`WebTransport not ready in ${WT_READY_TIMEOUT_MS / 1000} s`, true)).catch((e: unknown) => {
      throw e instanceof WebTransportUnavailable ? e : new WebTransportUnavailable(`WebTransport refused (${(e as Error).message})`, false);
    });
    // Safari can complete the handshake over HTTP/2, which has no datagrams: that's no better than WS
    const reliability = (wt as WebTransport & { reliability?: string }).reliability;
    if (reliability !== undefined && reliability !== 'supports-unreliable') throw new WebTransportUnavailable(`WebTransport without datagrams (${reliability})`, true);
    stream = await withTimeout(wt.createBidirectionalStream(), WT_READY_TIMEOUT_MS, () => new WebTransportUnavailable(`WebTransport stream not open in ${WT_READY_TIMEOUT_MS / 1000} s`, false));
  } catch (e) {
    wt.close();
    throw e instanceof WebTransportUnavailable ? e : new WebTransportUnavailable((e as Error).message, false);
  }

  const streamWriter = stream.writable.getWriter();
  const datagramWriter = wt.datagrams.writable.getWriter();
  const maxDatagram = Math.min(MAX_DATAGRAM_BYTES, wt.datagrams.maxDatagramSize || MAX_DATAGRAM_BYTES);
  let closed = false;
  const finish = (code: number, reason: string) => {
    if (closed) return;
    closed = true;
    handlers.onClose(code, reason);
  };

  // reliable stream: u16 LE length + message, possibly split or batched across reads
  void (async () => {
    const reader = stream.readable.getReader();
    let buf = new Uint8Array(0);
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        const joined = new Uint8Array(buf.length + value.length);
        joined.set(buf);
        joined.set(value, buf.length);
        let off = 0;
        while (joined.length - off >= 2) {
          const len = joined[off]! | (joined[off + 1]! << 8);
          if (joined.length - off - 2 < len) break;
          handlers.onMessage(joined.slice(off + 2, off + 2 + len));
          off += 2 + len;
        }
        buf = joined.slice(off);
      }
    } catch {
      /* the session closed */
    }
  })();
  void (async () => {
    const reader = wt.datagrams.readable.getReader();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        handlers.onMessage(value);
      }
    } catch {
      /* the session closed */
    }
  })();
  wt.closed.then(
    (info) => finish(info.closeCode || 1000, info.reason ?? ''),
    () => finish(1006, 'WebTransport session lost'),
  );

  return {
    kind: 'wt',
    send(bytes) {
      if (closed) return;
      if (isUnreliableMessage(bytes) && bytes.length <= maxDatagram) {
        // a full datagram queue drops, like the network would
        void datagramWriter.write(bytes as Uint8Array<ArrayBuffer>).catch(() => {});
        return;
      }
      const framed = new Uint8Array(2 + bytes.length);
      framed[0] = bytes.length & 0xff;
      framed[1] = bytes.length >> 8;
      framed.set(bytes, 2);
      void streamWriter.write(framed).catch(() => {});
    },
    backlog: () => 0,
    close(code = 0, reason = '') {
      if (closed) return;
      wt.close({ closeCode: code, reason });
    },
  };
}

/** The game server's /health for its WebSocket URL (same host and port, path /health). */
export function healthUrl(wsUrl: string): string {
  const u = new URL(wsUrl);
  u.protocol = u.protocol === 'wss:' ? 'https:' : 'http:';
  u.pathname = '/health';
  u.search = '';
  u.hash = '';
  return u.toString();
}

/** Asks the game server whether a WebTransport gateway is attached. */
export async function discoverWebTransport(wsUrl: string): Promise<WebTransportEndpoint | null> {
  try {
    // 4 s: a fresh TLS connection is ~3 round trips, ~1.5 s at the 500 ms phones measured (19 Oct)
    const res = await fetch(healthUrl(wsUrl), { signal: AbortSignal.timeout(4000) });
    const body = (await res.json()) as { webtransport?: WebTransportEndpoint | null };
    return body.webtransport ?? null;
  } catch {
    return null;
  }
}

export interface ConnectResult {
  transport: GameTransport;
  /** why WebTransport wasn't used, when it wasn't */
  fallbackReason: string | null;
}

/**
 * docs/05 §2.1: WebTransport when available and allowed, else WebSocket.
 * `prefer`: 'auto' (default), 'wt' (no fallback, for testing), 'ws' (never try WebTransport).
 * `reconnect`: a failure now says little about the network (the gateway may be the problem), so
 * it isn't remembered.
 */
export async function connectGame(wsUrl: string, prefer: 'auto' | 'wt' | 'ws', handlers: TransportHandlers, reconnect = false): Promise<ConnectResult> {
  let fallbackReason: string | null = null;
  if (prefer !== 'ws') {
    const endpoint = await discoverWebTransport(wsUrl);
    const room = roomOfUrl(wsUrl);
    if (!endpoint) fallbackReason = 'no WebTransport gateway on this server';
    else if (!('WebTransport' in window)) fallbackReason = 'browser has no WebTransport';
    else if (room && !endpoint.rooms) fallbackReason = "this server's WebTransport serves its default room only";
    else if (prefer === 'auto' && rememberedFailure(endpoint)) fallbackReason = 'this network blocked WebTransport recently';
    else {
      try {
        const transport = await openWebTransport({ ...endpoint, url: webTransportUrl(endpoint, room) }, handlers);
        rememberFailure(endpoint, false);
        return { transport, fallbackReason: null };
      } catch (e) {
        fallbackReason = (e as Error).message;
        if (prefer === 'wt') throw e;
        if (!reconnect && e instanceof WebTransportUnavailable && e.networkBlocksIt) rememberFailure(endpoint, true);
      }
    }
    if (prefer === 'wt') throw new Error(fallbackReason);
  }
  return { transport: await openWebSocket(wsUrl, handlers), fallbackReason };
}
