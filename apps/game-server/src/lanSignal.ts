/**
 * Signaling for local rooms (same Wi-Fi; apps/web/src/lan). A local room's game runs in its host's
 * browser and the guests connect to it directly over WebRTC: this server only passes the two short
 * connection descriptions between them (the host's offer, the guest's answer), then has nothing more
 * to do with the game. No game traffic, no accounts, no results come through here.
 *
 *   /ws/lan/host          a host: gets {t:'code', code}, then {t:'join', peer} per guest and
 *                         {t:'answer', peer, sdp} / {t:'leave', peer}; sends {t:'offer', peer, sdp}
 *   /ws/lan/join/<CODE>   a guest: gets {t:'offer', sdp}; sends {t:'answer', sdp}
 *
 * Frames are binary (UTF-8 JSON), like every other message here. Limits: a description ≤ 2 KB
 * (the packed form, apps/web/src/lan/sdp.ts, is ~200 B), 10 messages a second, 4 hosts per
 * address, 15 guests per room. The host leaving closes its guests (4006, the room is gone).
 */
import { CloseCode } from '@military-forge/protocol';
import type { ClientConn } from './room';

export const LAN_PREFIX = '/ws/lan/';
const CODE_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const MAX_SDP = 2048;
const MAX_MESSAGES_PER_SECOND = 10;
const MAX_HOSTS_PER_IP = 4;
const MAX_GUESTS = 15;

interface Connection {
  receive(bytes: Uint8Array): void;
  closed(resumable?: boolean): void;
}

interface Host {
  code: string;
  conn: ClientConn;
  ip: string;
  guests: Map<number, Guest>;
  nextPeer: number;
}

interface Guest {
  peer: number;
  conn: ClientConn;
  host: Host;
}

const enc = new TextEncoder();
const dec = new TextDecoder();
const send = (conn: ClientConn, msg: unknown) => conn.send(enc.encode(JSON.stringify(msg)));

function parse(bytes: Uint8Array): Record<string, unknown> | null {
  if (bytes.length > MAX_SDP + 256) return null;
  try {
    const v: unknown = JSON.parse(dec.decode(bytes));
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const validSdp = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= MAX_SDP;

/** Counts messages per second; true while under the limit. */
function limiter(now: () => number): () => boolean {
  let windowStart = now();
  let count = 0;
  return () => {
    const t = now();
    if (t - windowStart >= 1000) {
      windowStart = t;
      count = 0;
    }
    return ++count <= MAX_MESSAGES_PER_SECOND;
  };
}

export class LanSignal {
  private readonly hosts = new Map<string, Host>();
  private readonly hostsByIp = new Map<string, number>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly random: () => number = Math.random,
  ) {}

  /** whether `url` is a local-room signaling path */
  static handles(url: string): boolean {
    return url.startsWith(LAN_PREFIX);
  }

  get hostCount(): number {
    return this.hosts.size;
  }

  open(url: string, conn: ClientConn, ip: string | null): Connection | null {
    const path = url.split('?')[0]!.slice(LAN_PREFIX.length);
    if (path === 'host') return this.openHost(conn, ip ?? '');
    const m = /^join\/([A-Z]{6})$/.exec(path);
    if (m) return this.openGuest(m[1]!, conn);
    conn.close(CloseCode.NoRoom, 'not a local room path');
    return null;
  }

  private newCode(): string {
    for (;;) {
      let code = '';
      for (let i = 0; i < 6; i++) code += CODE_LETTERS[Math.floor(this.random() * CODE_LETTERS.length)];
      if (!this.hosts.has(code)) return code;
    }
  }

  private openHost(conn: ClientConn, ip: string): Connection | null {
    if (ip && (this.hostsByIp.get(ip) ?? 0) >= MAX_HOSTS_PER_IP) {
      conn.close(CloseCode.RateLimited, 'too many local rooms from your network');
      return null;
    }
    const host: Host = { code: this.newCode(), conn, ip, guests: new Map(), nextPeer: 1 };
    this.hosts.set(host.code, host);
    if (ip) this.hostsByIp.set(ip, (this.hostsByIp.get(ip) ?? 0) + 1);
    send(conn, { t: 'code', code: host.code });
    const ok = limiter(this.now);
    let gone = false;
    return {
      receive: (bytes) => {
        if (gone) return;
        const msg = parse(bytes);
        if (!ok() || !msg) return void conn.close(CloseCode.RateLimited, 'bad or too many messages');
        if (msg.t === 'offer' && typeof msg.peer === 'number' && validSdp(msg.sdp)) {
          const g = host.guests.get(msg.peer);
          if (g) send(g.conn, { t: 'offer', sdp: msg.sdp });
        } else if (msg.t === 'drop' && typeof msg.peer === 'number') {
          host.guests.get(msg.peer)?.conn.close(CloseCode.NoRoom, 'the host turned you away');
        }
      },
      closed: () => {
        if (gone) return;
        gone = true;
        this.hosts.delete(host.code);
        if (ip) {
          const n = (this.hostsByIp.get(ip) ?? 1) - 1;
          if (n > 0) this.hostsByIp.set(ip, n);
          else this.hostsByIp.delete(ip);
        }
        for (const g of host.guests.values()) g.conn.close(CloseCode.NoRoom, 'the local room is closed');
        host.guests.clear();
      },
    };
  }

  private openGuest(code: string, conn: ClientConn): Connection | null {
    const host = this.hosts.get(code);
    if (!host) {
      conn.close(CloseCode.NoRoom, 'no local room with that code');
      return null;
    }
    if (host.guests.size >= MAX_GUESTS) {
      conn.close(CloseCode.RoomFull, 'the local room is full');
      return null;
    }
    const guest: Guest = { peer: host.nextPeer++, conn, host };
    host.guests.set(guest.peer, guest);
    send(host.conn, { t: 'join', peer: guest.peer });
    const ok = limiter(this.now);
    let gone = false;
    return {
      receive: (bytes) => {
        if (gone) return;
        const msg = parse(bytes);
        if (!ok() || !msg) return void conn.close(CloseCode.RateLimited, 'bad or too many messages');
        if (msg.t === 'answer' && validSdp(msg.sdp) && host.guests.get(guest.peer) === guest) send(host.conn, { t: 'answer', peer: guest.peer, sdp: msg.sdp });
      },
      closed: () => {
        if (gone) return;
        gone = true;
        if (host.guests.get(guest.peer) === guest) {
          host.guests.delete(guest.peer);
          if (this.hosts.get(host.code) === host) send(host.conn, { t: 'leave', peer: guest.peer });
        }
      },
    };
  }
}
