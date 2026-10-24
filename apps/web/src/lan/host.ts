/**
 * A local room's host (same Wi-Fi; the owner's request, 20 Oct 2026): the game server's own Room,
 * running in the host's browser. Guests connect straight to it over WebRTC (peer.ts), so a match
 * on one Wi-Fi or phone hotspot plays at LAN ping, with the internet slow or gone.
 *
 * It is the same authoritative code as a server room: every byte from a guest goes through
 * `Room.receive` (strict decoders, strikes, rate limits, the input buffer's lead limit, host-only
 * commands), and a guest's state is never taken from the guest. On top of the server's transport
 * rules: binary frames only, at most MAX_PEER_MESSAGE bytes. The host itself plays through a link
 * inside the page (`hostTransport`), as one more client of its own room.
 *
 * Nothing is recorded: no results sink, so no account, XP or leaderboard ever hears of a local
 * match (a host could fake any of it). The room runs in a worker (roomWorker.ts), so it keeps
 * 60 Hz behind a heavy frame or in a hidden tab; this page keeps the WebRTC side.
 *
 * Joining: online, through the game server's signaling relay (/ws/lan/host: a room code; each
 * guest that asks gets an offer and answers); offline, by codes the two devices show each other as
 * QR codes or text (`newOffer` / `acceptAnswer`).
 */
import { CloseCode } from '@military-forge/protocol';
import type { GameTransport, TransportHandlers } from '../transport';
import { diag } from '../diag/log';
import { MAX_PEER_MESSAGE, acceptAnswer, channelsOpen, closeFrame, makeOffer, newPeer, sendOn, type Peer } from './peer';

export { LOCAL_ROOM_RULES } from './rules';

/** What the page needs to hear from the room for one connection (the game server's ClientConn, minus backpressure). */
interface RoomLink {
  send(bytes: Uint8Array): void;
  close(code: number, reason: string): void;
}

/** The room in its worker (roomWorker.ts), seen from the page: connections by number. */
class WorkerRoom {
  private readonly worker: Worker;
  private readonly links = new Map<number, RoomLink>();
  private nextId = 1;

  constructor(options: { seed: number; mapId?: string; fillBots?: LanHostOptions['fillBots'] }) {
    this.worker = new Worker(new URL('./roomWorker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (ev: MessageEvent<{ t: 'send' | 'kick'; id: number; bytes?: ArrayBuffer; code?: number; reason?: string }>) => {
      const m = ev.data;
      const link = this.links.get(m.id);
      if (!link) return;
      if (m.t === 'send' && m.bytes) link.send(new Uint8Array(m.bytes));
      else if (m.t === 'kick') {
        this.links.delete(m.id);
        link.close(m.code ?? 1000, m.reason ?? '');
      }
    };
    this.worker.postMessage({ t: 'open', options });
  }

  connect(link: RoomLink): number {
    const id = this.nextId++;
    this.links.set(id, link);
    this.worker.postMessage({ t: 'connect', id });
    return id;
  }

  receive(id: number, bytes: Uint8Array): void {
    const copy = bytes.slice();
    this.worker.postMessage({ t: 'recv', id, bytes: copy.buffer }, [copy.buffer]);
  }

  disconnect(id: number, resumable = true): void {
    if (!this.links.delete(id)) return;
    this.worker.postMessage({ t: 'disconnect', id, resumable });
  }

  closeAll(code: number, reason: string): void {
    this.worker.postMessage({ t: 'close', code, reason });
    // the kicks come back as messages; give them a moment, then stop the worker
    setTimeout(() => this.worker.terminate(), 1000);
  }
}

export interface LanGuest {
  /** the relay's peer number, or a local one for a guest who joined by code */
  id: number;
  state: 'offered' | 'connecting' | 'connected' | 'gone';
  peer: Peer;
  /** its connection number in the room, once connected */
  client: number | null;
  /** the packed offer (shown as a QR code for a guest joining offline) */
  offer: string;
  error: string;
}

export interface LanHostOptions {
  /** the relay (wss://<site>/ws/lan/host); none: offline, codes only */
  signalUrl?: string | null;
  /** bots filling the room (the lobby's Bots setting changes it later) */
  fillBots?: { target: number; level: 'easy' | 'normal' | 'hard' } | null;
  mapId?: string;
  seed?: number;
  /** a WebSocket constructor (tests) */
  WebSocketImpl?: typeof WebSocket;
}

export class LanHost {
  private readonly room: WorkerRoom;
  /** the room code guests type (online), '' until the relay gives one, or offline */
  code = '';
  /** what the relay said went wrong, '' when fine */
  signalError = '';
  readonly guests = new Map<number, LanGuest>();
  private signal: WebSocket | null = null;
  private nextLocalId = 1000;
  private closed = false;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly options: LanHostOptions = {}) {
    this.room = new WorkerRoom({
      seed: options.seed ?? Math.floor(Math.random() * 0x7fffffff),
      mapId: options.mapId ?? 'street-market',
      ...(options.fillBots ? { fillBots: options.fillBots } : {}),
    });
    if (options.signalUrl) this.openSignal(options.signalUrl);
    // the host's page closing ends the room (guests are told: their channels close)
    window.addEventListener('pagehide', this.onPageHide);
  }

  /**
   * The room code from the relay, or '' once it's clear there won't be one (no connection to the
   * game server: players then join by QR codes), at most `timeoutMs` from now.
   */
  whenCoded(timeoutMs = 4000): Promise<string> {
    if (this.code || this.signalError || !this.signal) return Promise.resolve(this.code);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        off();
        resolve(this.code);
      }, timeoutMs);
      const off = this.onChange(() => {
        if (!this.code && !this.signalError) return;
        clearTimeout(timer);
        off();
        resolve(this.code);
      });
    });
  }

  /** Hears changes to the code, the guests or the relay (the lobby's local-room card). Returns the way to stop. */
  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private changed(): void {
    for (const fn of this.listeners) fn();
  }

  /**
   * The host's own link into its room (OnlineMode's `connect`): messages are handed over on the next
   * microtask, both ways, so neither side runs inside the other's call.
   */
  hostTransport(handlers: TransportHandlers): Promise<GameTransport> {
    let open = true;
    const id = this.room.connect({
      send: (bytes) => {
        if (open) handlers.onMessage(bytes);
      },
      close: (code, reason) => {
        if (!open) return;
        open = false;
        handlers.onClose(code, reason);
      },
    });
    return Promise.resolve({
      kind: 'lan',
      send: (bytes) => {
        if (open) this.room.receive(id, bytes);
      },
      backlog: () => 0,
      close: () => {
        if (!open) return;
        open = false;
        this.room.disconnect(id);
      },
    });
  }

  // ---------- guests ----------

  /** A new guest: a peer and its offer. `id`: the relay's peer number, or a local one (offline). */
  async newOffer(id = this.nextLocalId++): Promise<LanGuest> {
    const peer = newPeer();
    const guest: LanGuest = { id, state: 'offered', peer, client: null, offer: '', error: '' };
    this.guests.set(id, guest);
    try {
      guest.offer = await makeOffer(peer);
    } catch (e) {
      guest.state = 'gone';
      guest.error = (e as Error).message;
    }
    this.changed();
    return guest;
  }

  /** The guest's answer (from the relay, or scanned/pasted offline): connect it into the room. */
  async acceptAnswer(id: number, packedAnswer: string): Promise<void> {
    const guest = this.guests.get(id);
    if (!guest || guest.state !== 'offered') throw new Error('that player is no longer waiting');
    guest.state = 'connecting';
    this.changed();
    try {
      await acceptAnswer(guest.peer, packedAnswer);
      await channelsOpen(guest.peer);
    } catch (e) {
      diag('lan', `host: guest ${id} didn't connect: ${(e as Error).message}`);
      this.drop(guest, (e as Error).message);
      throw e;
    }
    diag('lan', `host: guest ${id} connected`);
    if (this.closed) return;
    this.attach(guest);
  }

  /** A connected guest becomes a client of the room; everything it sends goes through Room.receive. */
  private attach(guest: LanGuest): void {
    const { peer } = guest;
    let open = true;
    const client = this.room.connect({
      send: (bytes) => {
        if (open) sendOn(peer, bytes);
      },
      close: (code, reason) => {
        if (!open) return;
        open = false;
        if (peer.reliable.readyState === 'open') peer.reliable.send(closeFrame(code, reason) as Uint8Array<ArrayBuffer>);
        // let the close frame go out before the connection does
        setTimeout(() => peer.pc.close(), 250);
      },
    });
    guest.client = client;
    guest.state = 'connected';
    const onMessage = (ev: MessageEvent) => {
      if (!open) return;
      // the transport's own rules (the game server's): binary, and no bigger than MAX_PEER_MESSAGE
      if (!(ev.data instanceof ArrayBuffer) || ev.data.byteLength === 0 || ev.data.byteLength > MAX_PEER_MESSAGE) {
        open = false;
        if (peer.reliable.readyState === 'open') peer.reliable.send(closeFrame(CloseCode.BadMessage, 'bad message') as Uint8Array<ArrayBuffer>);
        this.room.disconnect(client, false);
        setTimeout(() => peer.pc.close(), 250);
        return;
      }
      this.room.receive(client, new Uint8Array(ev.data));
    };
    peer.reliable.addEventListener('message', onMessage);
    peer.unreliable.addEventListener('message', onMessage);
    const gone = () => {
      if (guest.state === 'gone') return;
      diag('lan', `host: guest ${guest.id} gone (${peer.pc.connectionState})`);
      open = false;
      guest.state = 'gone';
      this.room.disconnect(client); // resumable: a guest whose Wi-Fi blinked comes back as itself
      this.guests.delete(guest.id);
      this.changed();
    };
    peer.reliable.addEventListener('close', gone);
    peer.pc.addEventListener('connectionstatechange', () => {
      if (peer.pc.connectionState === 'failed' || peer.pc.connectionState === 'closed') gone();
    });
    this.changed();
  }

  private drop(guest: LanGuest, error: string): void {
    guest.state = 'gone';
    guest.error = error;
    guest.peer.pc.close();
    this.guests.delete(guest.id);
    this.changed();
  }

  /** Players connected over the network (not counting the host or bots). */
  get connectedGuests(): number {
    let n = 0;
    for (const g of this.guests.values()) if (g.state === 'connected') n++;
    return n;
  }

  // ---------- the relay (online) ----------

  private openSignal(url: string): void {
    const Ws = this.options.WebSocketImpl ?? WebSocket;
    const ws = new Ws(url);
    ws.binaryType = 'arraybuffer';
    this.signal = ws;
    const send = (msg: unknown) => {
      if (ws.readyState === Ws.OPEN) ws.send(new TextEncoder().encode(JSON.stringify(msg)));
    };
    ws.onmessage = (ev) => {
      let msg: { t?: string; code?: string; peer?: number; sdp?: string };
      try {
        msg = JSON.parse(new TextDecoder().decode(ev.data as ArrayBuffer)) as typeof msg;
      } catch {
        return;
      }
      if (msg.t === 'code' && typeof msg.code === 'string') {
        diag('lan', `host: the relay gave code ${msg.code}`);
        this.code = msg.code;
        this.changed();
      } else if (msg.t === 'join' && typeof msg.peer === 'number') {
        const peer = msg.peer;
        diag('lan', `host: guest ${peer} asks to join`);
        void this.newOffer(peer).then((g) => {
          if (g.offer) send({ t: 'offer', peer, sdp: g.offer });
        });
      } else if (msg.t === 'answer' && typeof msg.peer === 'number' && typeof msg.sdp === 'string') {
        diag('lan', `host: guest ${msg.peer} answered`);
        this.acceptAnswer(msg.peer, msg.sdp).catch(() => {});
      } else if (msg.t === 'leave' && typeof msg.peer === 'number') {
        // the guest's signaling socket closed: fine once connected; before that, it gave up
        const g = this.guests.get(msg.peer);
        diag('lan', `host: guest ${msg.peer} left the relay (${g?.state ?? 'unknown'})`);
        if (g && g.state !== 'connected') this.drop(g, 'left');
      }
    };
    ws.onclose = (ev) => {
      if (this.closed) return;
      diag('lan', `host: relay closed ${ev.code}${ev.reason ? ` ${ev.reason}` : ''}`);
      this.signal = null;
      this.signalError = ev.code === CloseCode.RateLimited ? ev.reason || 'too many local rooms on this network' : 'no connection to the game server: players can still join by code';
      this.code = '';
      this.changed();
    };
  }

  private readonly onPageHide = () => this.close();

  /** Closes the room for everyone (the host left): guests get 4006 and are back at the menu. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    diag('lan', 'host: closed the room');
    window.removeEventListener('pagehide', this.onPageHide);
    this.signal?.close();
    this.room.closeAll(CloseCode.NoRoom, 'the host closed the local room');
    for (const g of this.guests.values()) setTimeout(() => g.peer.pc.close(), 300);
    this.guests.clear();
    this.changed();
  }
}
