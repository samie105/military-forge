/**
 * Joining a local room (host.ts) as a guest: OnlineMode's `connect` for a room on the same Wi-Fi.
 *
 * - By room code (online): the game server's relay (/ws/lan/join/<CODE>) passes the host's offer
 *   and this answer, then the two devices talk directly; the relay socket closes. A reconnect does
 *   the same again with the same code, and the room gives the player back (the session token).
 * - By codes (offline): the host's offer comes from its QR code (or pasted); `answerFor` makes the
 *   reply code the host scans in turn. A dropped offline link can't be redialled without new codes.
 */
import { CloseCode } from '@military-forge/protocol';
import { normalizeRoomCode } from '@military-forge/shared';
import type { GameTransport, TransportHandlers } from '../transport';
import { diag } from '../diag/log';
import { LanError, answerOffer, channelsOpen, newPeer, peerTransport, type Peer } from './peer';

/** the relay must hand over an offer within this long */
const OFFER_TIMEOUT_MS = 10_000;

/** A local room's code (6 letters, as the host shows it, the API rooms' alphabet) from what a person typed, or null. */
export function normalizeLanCode(typed: string): string | null {
  return normalizeRoomCode(typed);
}

/**
 * Whether the relay has a local room with `code`: a probe socket gets {t:'here'} (yes) or is refused
 * (no), in one round trip; the host never hears of it. (A relay from before the probe treats it as a
 * join and answers with the host's offer: any message is a yes.) 3 s at most.
 */
export function lanRoomExists(code: string, WebSocketImpl: typeof WebSocket = WebSocket): Promise<boolean> {
  return new Promise((resolve) => {
    let ws: WebSocket;
    try {
      ws = new WebSocketImpl(lanSignalUrl(`join/${code}?probe`));
    } catch {
      return resolve(false);
    }
    const done = (yes: boolean) => {
      clearTimeout(timer);
      ws.onmessage = ws.onclose = null;
      try {
        ws.close();
      } catch {
        /* gone */
      }
      resolve(yes);
    };
    const timer = setTimeout(() => done(false), 3000);
    ws.onmessage = () => done(true);
    ws.onclose = () => done(false);
  });
}

/** The relay's address for this page (the game server's /ws/ path on the same site). */
export function lanSignalUrl(path: string, loc: Pick<Location, 'protocol' | 'host'> = location): string {
  return `${loc.protocol === 'https:' ? 'wss' : 'ws'}://${loc.host}/ws/lan/${path}`;
}

/** The host's offer through the relay, for `code`. */
function offerFromRelay(code: string, WebSocketImpl: typeof WebSocket = WebSocket): Promise<{ offer: string; reply(answer: string): void; done(): void }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocketImpl(lanSignalUrl(`join/${code}`));
    ws.binaryType = 'arraybuffer';
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error("the host didn't answer: is the room still open?"));
    }, OFFER_TIMEOUT_MS);
    ws.onmessage = (ev) => {
      let msg: { t?: string; sdp?: string };
      try {
        msg = JSON.parse(new TextDecoder().decode(ev.data as ArrayBuffer)) as typeof msg;
      } catch {
        return;
      }
      if (msg.t !== 'offer' || typeof msg.sdp !== 'string') return;
      clearTimeout(timer);
      resolve({
        offer: msg.sdp,
        reply: (answer) => ws.send(new TextEncoder().encode(JSON.stringify({ t: 'answer', sdp: answer }))),
        // the relay isn't needed once the devices talk; a while after, let it go
        done: () => setTimeout(() => ws.close(), 2000),
      });
    };
    ws.onclose = (ev) => {
      clearTimeout(timer);
      reject(ev.code === CloseCode.NoRoom || ev.code === CloseCode.RoomFull ? new LanError(ev.reason || 'no local room with that code (the host may have closed it)', ev.code) : new Error(ev.reason || 'could not reach the game server'));
    };
  });
}

/** Connect to a local room by its code, through the relay (OnlineOptions.connect). */
export async function joinByCode(code: string, handlers: TransportHandlers, WebSocketImpl?: typeof WebSocket): Promise<GameTransport> {
  const t0 = performance.now();
  const ms = () => `${Math.round(performance.now() - t0)} ms`;
  diag('lan', `guest: joining ${code} through the relay`);
  let relay: Awaited<ReturnType<typeof offerFromRelay>>;
  try {
    relay = await offerFromRelay(code, WebSocketImpl);
  } catch (e) {
    diag('lan', `guest: no offer for ${code}: ${(e as Error).message} (${ms()})`);
    throw e;
  }
  diag('lan', `guest: got the host's offer (${ms()})`);
  const peer = newPeer();
  try {
    relay.reply(await answerOffer(peer, relay.offer));
    diag('lan', `guest: answered (${ms()})`);
    await channelsOpen(peer);
    diag('lan', `guest: connected to the host (${ms()})`);
  } catch (e) {
    diag('lan', `guest: couldn't connect: ${(e as Error).message} (${ms()})`);
    peer.pc.close();
    throw e;
  } finally {
    relay.done();
  }
  return peerTransport(peer, handlers);
}

/**
 * Offline: the host's offer code (scanned or pasted) → this device's reply code for the host to
 * scan, and the connection once the host has it.
 */
export async function answerFor(offerCode: string): Promise<{ reply: string; peer: Peer }> {
  const peer = newPeer(false);
  try {
    return { reply: await answerOffer(peer, offerCode), peer };
  } catch (e) {
    peer.pc.close();
    throw e;
  }
}

/** Offline: OnlineOptions.connect for a peer made with `answerFor` (once: no redial without new codes). */
export function connectAnswered(peer: Peer): (handlers: TransportHandlers, reconnect: boolean) => Promise<GameTransport> {
  let used = false;
  return async (handlers) => {
    if (used) throw new LanError("the local link dropped: scan a new code from the host", CloseCode.NoRoom);
    used = true;
    // the host scans this device's reply code first: give it time
    await channelsOpen(peer, 120_000);
    return peerTransport(peer, handlers);
  };
}
