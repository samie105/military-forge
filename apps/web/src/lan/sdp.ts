/**
 * WebRTC descriptions for local rooms, packed small: a browser's offer or answer is 1–2 KB of SDP,
 * but a data-channel connection needs only a few fields of it (the ICE credentials, the DTLS
 * fingerprint and role, and the candidates). Packed, an offer is ~150–250 characters: it fits a
 * QR code a phone camera reads at arm's length, a URL fragment, and the signaling relay's limit.
 * `unpackSdp` rebuilds a minimal description every browser accepts.
 *
 *   L1.<o|a>.<setup a|c|p>.<ufrag>.<pwd>.<fingerprint, base64url>.<candidates>
 *   candidates: `,`-separated `<h|s>~<address>~<port>` (host or server-reflexive, UDP only)
 */

export type SdpKind = 'offer' | 'answer';

export interface PackedParts {
  kind: SdpKind;
  setup: 'actpass' | 'active' | 'passive';
  ufrag: string;
  pwd: string;
  /** SHA-256 fingerprint, 32 bytes */
  fingerprint: Uint8Array;
  candidates: { type: 'host' | 'srflx'; address: string; port: number }[];
}

const SETUP = { actpass: 'c', active: 'a', passive: 'p' } as const;
const SETUP_BACK: Record<string, PackedParts['setup']> = { c: 'actpass', a: 'active', p: 'passive' };
/** ICE credentials are ice-chars (RFC 5245: ALPHA / DIGIT / + / /), at most 256 */
const ICE_CHARS = /^[A-Za-z0-9+/]{1,256}$/;
/** an IPv4 or IPv6 address, or an mDNS name (`<uuid>.local`, what browsers show for LAN addresses) */
const ADDRESS = /^([0-9.]{7,15}|[0-9a-fA-F:]{2,39}|[A-Za-z0-9-]{1,63}\.local)$/;
const MAX_CANDIDATES = 8;

function b64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function unb64url(s: string): Uint8Array {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

/** The fields of a browser's description that a data-channel connection needs. */
export function sdpParts(sdp: string, kind: SdpKind): PackedParts {
  const line = (name: string) => new RegExp(`^a=${name}:(.+)$`, 'm').exec(sdp)?.[1]?.trim();
  const ufrag = line('ice-ufrag');
  const pwd = line('ice-pwd');
  const fp = line('fingerprint');
  const setup = line('setup') as PackedParts['setup'] | undefined;
  if (!ufrag || !pwd || !fp || !setup) throw new Error('not a WebRTC description');
  const [algo, hex] = fp.split(/\s+/);
  if (algo?.toLowerCase() !== 'sha-256' || !hex) throw new Error('needs a SHA-256 fingerprint');
  const fingerprint = Uint8Array.from(hex.split(':'), (h) => parseInt(h, 16));
  const candidates: PackedParts['candidates'] = [];
  for (const m of sdp.matchAll(/^a=candidate:\S+ (\d+) (\S+) \d+ (\S+) (\d+) typ (host|srflx)/gm)) {
    if (m[1] !== '1' || m[2]!.toLowerCase() !== 'udp') continue;
    if (candidates.length < MAX_CANDIDATES) candidates.push({ type: m[5] as 'host' | 'srflx', address: m[3]!, port: Number(m[4]) });
  }
  return { kind, setup, ufrag, pwd, fingerprint, candidates };
}

export function packParts(p: PackedParts): string {
  const cands = p.candidates.map((c) => `${c.type === 'host' ? 'h' : 's'}~${c.address}~${c.port}`).join(',');
  return ['L1', p.kind === 'offer' ? 'o' : 'a', SETUP[p.setup], p.ufrag, p.pwd, b64url(p.fingerprint), cands].join('.');
}

/** A browser's description, packed (see the top). */
export function packSdp(sdp: string, kind: SdpKind): string {
  return packParts(sdpParts(sdp, kind));
}

/** The parts of a packed description, checked: anything malformed throws. */
export function unpackParts(packed: string): PackedParts {
  const s = packed.trim();
  if (s.length > 1500) throw new Error('code too long');
  // the address part may hold dots (IPv4, `.local`): split the fixed fields off the front
  const head = s.split('.');
  if (head.length < 7 || head[0] !== 'L1') throw new Error('not a local room code');
  const [, k, setupCode, ufrag, pwd, fp] = head;
  const cands = head.slice(6).join('.');
  const kind: SdpKind | null = k === 'o' ? 'offer' : k === 'a' ? 'answer' : null;
  const setup = SETUP_BACK[setupCode ?? ''];
  if (!kind || !setup || !ICE_CHARS.test(ufrag ?? '') || !ICE_CHARS.test(pwd ?? '')) throw new Error('a damaged local room code');
  const fingerprint = unb64url(fp ?? '');
  if (fingerprint.length !== 32) throw new Error('a damaged local room code');
  const candidates: PackedParts['candidates'] = [];
  for (const c of cands ? cands.split(',') : []) {
    const [t, address, port] = c.split('~');
    const n = Number(port);
    if ((t !== 'h' && t !== 's') || !ADDRESS.test(address ?? '') || !Number.isInteger(n) || n < 1 || n > 65535) throw new Error('a damaged local room code');
    candidates.push({ type: t === 'h' ? 'host' : 'srflx', address: address!, port: n });
  }
  if (candidates.length === 0 || candidates.length > MAX_CANDIDATES) throw new Error('the code has no address to reach');
  return { kind, setup, ufrag: ufrag!, pwd: pwd!, fingerprint, candidates };
}

/** A minimal SDP for a packed description: one data-channel m-line, its credentials and candidates. */
export function unpackSdp(packed: string): { type: SdpKind; sdp: string } {
  const p = unpackParts(packed);
  const fp = [...p.fingerprint].map((b) => b.toString(16).padStart(2, '0').toUpperCase()).join(':');
  const lines = [
    'v=0',
    `o=- ${Date.now()} 2 IN IP4 127.0.0.1`,
    's=-',
    't=0 0',
    'a=group:BUNDLE 0',
    'a=msid-semantic: WMS',
    'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
    'c=IN IP4 0.0.0.0',
    ...p.candidates.map((c, i) => `a=candidate:${i + 1} 1 udp ${(c.type === 'host' ? 2122260223 : 1686052607) - i} ${c.address} ${c.port} typ ${c.type} generation 0`),
    'a=end-of-candidates',
    `a=ice-ufrag:${p.ufrag}`,
    `a=ice-pwd:${p.pwd}`,
    'a=ice-options:trickle',
    `a=fingerprint:sha-256 ${fp}`,
    `a=setup:${p.setup}`,
    'a=mid:0',
    'a=sctp-port:5000',
    'a=max-message-size:262144',
  ];
  return { type: p.kind, sdp: `${lines.join('\r\n')}\r\n` };
}
