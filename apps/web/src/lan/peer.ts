/**
 * WebRTC for local rooms: one RTCPeerConnection per guest, with two data channels like the
 * WebTransport path (docs/05 §2.3): `u`, unordered with no retransmits, for the messages the
 * protocol marks unreliable (INPUT, PING, PONG, SNAPSHOT), and `r`, reliable and ordered, for the
 * rest. Both are negotiated (fixed ids), so neither side waits for the other to announce them.
 *
 * No ICE servers when offline: the candidates are the devices' own (LAN) addresses, which browsers
 * show as mDNS names (`<uuid>.local`) that the other device on the same network resolves. Online,
 * one public STUN server adds the network's public address too, for networks where mDNS doesn't get
 * through (the router sends it back inside: traffic still stays local). ICE prefers host candidates.
 *
 * The descriptions are exchanged whole (non-trickle): gathering on a LAN takes a fraction of a
 * second, and one message each way keeps both the signaling relay and the QR path simple.
 */
import { CloseCode, isUnreliableMessage } from '@military-forge/protocol';
import type { GameTransport, TransportHandlers } from '../transport';
import { diag } from '../diag/log';
import { packSdp, unpackSdp, type SdpKind } from './sdp';

/** gathering waits this long at most (a STUN server that doesn't answer, offline) */
const GATHER_TIMEOUT_MS = 2500;
/** a peer not connected in this long won't be */
export const CONNECT_TIMEOUT_MS = 12_000;
/**
 * A transport-level close frame on the reliable channel: 0xFF, u16 LE close code, UTF-8 reason.
 * Protocol messages are 0x01–0x3F, so it can't be mistaken for one (WebSocket has close codes of
 * its own; a data channel doesn't). It is not a protocol message: nothing in the registry.
 */
export const CLOSE_FRAME = 0xff;
/** the game server's limit (transports.ts MAX_PAYLOAD): a bigger message closes the peer */
export const MAX_PEER_MESSAGE = 4 * 1024;

export interface Peer {
  readonly pc: RTCPeerConnection;
  readonly reliable: RTCDataChannel;
  readonly unreliable: RTCDataChannel;
}

const STUN: RTCIceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }];

export function newPeer(online = typeof navigator !== 'undefined' && navigator.onLine): Peer {
  const pc = new RTCPeerConnection({ iceServers: online ? STUN : [] });
  const reliable = pc.createDataChannel('r', { negotiated: true, id: 0, ordered: true });
  const unreliable = pc.createDataChannel('u', { negotiated: true, id: 1, ordered: false, maxRetransmits: 0 });
  reliable.binaryType = unreliable.binaryType = 'arraybuffer';
  watchPeer(pc, reliable, online);
  return { pc, reliable, unreliable };
}

let peers = 0;
/**
 * A peer's life in the device's event log (diag/log.ts), for problem reports: the candidates it found
 * by kind, its ICE and connection states with the time since it was made, and its channel closing.
 */
function watchPeer(pc: RTCPeerConnection, reliable: RTCDataChannel, online: boolean): void {
  const id = ++peers;
  const t0 = typeof performance !== 'undefined' ? performance.now() : 0;
  const since = () => `${Math.round(performance.now() - t0)} ms`;
  const kinds: Record<string, number> = {};
  diag('rtc', `peer ${id}: made (${online ? 'with STUN' : 'no STUN: offline'})`);
  pc.addEventListener('icecandidate', (e) => {
    const kind = e.candidate ? (/ typ (\w+)/.exec(e.candidate.candidate)?.[1] ?? '?') : null;
    if (kind) kinds[kind] = (kinds[kind] ?? 0) + 1;
    else diag('rtc', `peer ${id}: candidates ${Object.entries(kinds).map(([k, n]) => `${k} ${n}`).join(', ') || 'none'} at ${since()}`);
  });
  pc.addEventListener('iceconnectionstatechange', () => diag('rtc', `peer ${id}: ice ${pc.iceConnectionState} at ${since()}`));
  pc.addEventListener('connectionstatechange', () => diag('rtc', `peer ${id}: connection ${pc.connectionState} at ${since()}`));
  reliable.addEventListener('open', () => diag('rtc', `peer ${id}: channel open at ${since()}`));
  reliable.addEventListener('close', () => diag('rtc', `peer ${id}: channel closed at ${since()}`));
}

/** with a candidate in hand and no public one yet, gathering stops waiting this long after it began */
const GATHER_ENOUGH_MS = 1200;

/**
 * The candidates are in: gathering complete, or (a STUN server that answers slowly or not at all)
 * enough to connect on: the network's public address (srflx) as soon as it comes, else whatever was
 * found by GATHER_ENOUGH_MS, else GATHER_TIMEOUT_MS. On a LAN the device's own (mDNS) candidates come
 * in milliseconds, so a guest no longer waits the full timeout for a STUN reply (24 Oct: an offer took
 * 3.3 s of a 3.6 s join).
 */
function gathered(pc: RTCPeerConnection): Promise<void> {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    let found = 0;
    const started = Date.now();
    const done = () => {
      pc.removeEventListener('icegatheringstatechange', check);
      pc.removeEventListener('icecandidate', onCandidate);
      clearTimeout(timer);
      clearTimeout(enough);
      resolve();
    };
    const check = () => {
      if (pc.iceGatheringState === 'complete') done();
    };
    const onCandidate = (e: RTCPeerConnectionIceEvent) => {
      if (!e.candidate) return;
      found++;
      // a public address: what mDNS-blocking networks need; the description has it now
      if (/ typ srflx/.test(e.candidate.candidate)) setTimeout(done, 30);
    };
    const timer = setTimeout(done, GATHER_TIMEOUT_MS);
    const enough = setTimeout(
      () => {
        if (found > 0) done();
      },
      Math.max(0, GATHER_ENOUGH_MS - (Date.now() - started)),
    );
    pc.addEventListener('icegatheringstatechange', check);
    pc.addEventListener('icecandidate', onCandidate);
  });
}

async function localPacked(pc: RTCPeerConnection, kind: SdpKind): Promise<string> {
  await gathered(pc);
  return packSdp(pc.localDescription!.sdp, kind);
}

/** The host's side: an offer for one guest, packed. */
export async function makeOffer(peer: Peer): Promise<string> {
  await peer.pc.setLocalDescription(await peer.pc.createOffer());
  return localPacked(peer.pc, 'offer');
}

/** The guest's side: takes the host's packed offer, returns its packed answer. */
export async function answerOffer(peer: Peer, packedOffer: string): Promise<string> {
  const offer = unpackSdp(packedOffer);
  if (offer.type !== 'offer') throw new Error("that's a reply code, not a room code");
  await peer.pc.setRemoteDescription(offer);
  await peer.pc.setLocalDescription(await peer.pc.createAnswer());
  return localPacked(peer.pc, 'answer');
}

/** The host's side: the guest's packed answer completes the connection. */
export async function acceptAnswer(peer: Peer, packedAnswer: string): Promise<void> {
  const answer = unpackSdp(packedAnswer);
  if (answer.type !== 'answer') throw new Error("that's a room code, not a reply code");
  await peer.pc.setRemoteDescription(answer);
}

/** Resolves when both channels are open; rejects after CONNECT_TIMEOUT_MS or if the connection fails. */
export function channelsOpen(peer: Peer, timeoutMs = CONNECT_TIMEOUT_MS): Promise<void> {
  const { pc, reliable, unreliable } = peer;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => fail(new Error('could not reach the other device: are you on the same Wi-Fi?')), timeoutMs);
    const check = () => {
      if (reliable.readyState === 'open' && unreliable.readyState === 'open') {
        clearTimeout(timer);
        resolve();
      }
    };
    const fail = (e: Error) => {
      clearTimeout(timer);
      reject(e);
    };
    reliable.addEventListener('open', check);
    unreliable.addEventListener('open', check);
    pc.addEventListener('connectionstatechange', () => {
      if (pc.connectionState === 'failed') fail(new Error('the connection failed: are you on the same Wi-Fi?'));
    });
    check();
  });
}

/** A failure with a close code: OnlineMode treats it like that close (4006 NoRoom ends the attempt). */
export class LanError extends Error {
  constructor(
    message: string,
    readonly code: number,
  ) {
    super(message);
  }
}

/** A close frame (CLOSE_FRAME) for `code` and `reason`. */
export function closeFrame(code: number, reason: string): Uint8Array {
  const text = new TextEncoder().encode(reason.slice(0, 120));
  const out = new Uint8Array(3 + text.length);
  out[0] = CLOSE_FRAME;
  out[1] = code & 0xff;
  out[2] = (code >> 8) & 0xff;
  out.set(text, 3);
  return out;
}

/** Sends `bytes` on the channel its message type belongs to. */
export function sendOn(peer: Peer, bytes: Uint8Array): void {
  const ch = isUnreliableMessage(bytes) && peer.unreliable.readyState === 'open' ? peer.unreliable : peer.reliable;
  if (ch.readyState === 'open') ch.send(bytes as Uint8Array<ArrayBuffer>);
}

/**
 * A guest's GameTransport over a connected peer (kind 'lan'). A close frame from the host, the
 * channel closing or the connection failing ends it, once.
 */
export function peerTransport(peer: Peer, handlers: TransportHandlers): GameTransport {
  let closed = false;
  const finish = (code: number, reason: string) => {
    if (closed) return;
    closed = true;
    handlers.onClose(code, reason);
    peer.pc.close();
  };
  const onMessage = (ev: MessageEvent) => {
    if (!(ev.data instanceof ArrayBuffer) || closed) return;
    const bytes = new Uint8Array(ev.data);
    if (bytes[0] === CLOSE_FRAME) return finish(bytes[1]! | (bytes[2]! << 8), new TextDecoder().decode(bytes.subarray(3)));
    handlers.onMessage(bytes);
  };
  peer.reliable.addEventListener('message', onMessage);
  peer.unreliable.addEventListener('message', onMessage);
  // the channel closing is the host's page closing (or leaving): the room is gone. A lost Wi-Fi
  // shows as the connection failing instead, and is worth a reconnect
  peer.reliable.addEventListener('close', () => finish(CloseCode.NoRoom, 'the host closed the local room'));
  peer.pc.addEventListener('connectionstatechange', () => {
    const s = peer.pc.connectionState;
    if (s === 'failed' || s === 'closed') finish(1006, 'the connection to the host was lost');
  });
  return {
    kind: 'lan',
    send(bytes) {
      if (!closed) sendOn(peer, bytes);
    },
    backlog: () => 0,
    close() {
      if (closed) return;
      closed = true;
      peer.pc.close();
    },
  };
}
