/** Local rooms' packed WebRTC descriptions (src/lan/sdp.ts): small, faithful, and strict about what they accept. */
import { describe, expect, it } from 'vitest';
import { normalizeLanCode, lanSignalUrl } from '../src/lan/guest';
import { packSdp, sdpParts, unpackParts, unpackSdp } from '../src/lan/sdp';

// a real offer from Chrome (this Mac, 20 Oct 2026): two negotiated data channels, no ICE servers
const CHROME_OFFER = [
  'v=0',
  'o=- 3797639764236682864 2 IN IP4 127.0.0.1',
  's=-',
  't=0 0',
  'a=group:BUNDLE 0',
  'a=extmap-allow-mixed',
  'a=msid-semantic: WMS',
  'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
  'c=IN IP4 0.0.0.0',
  'a=candidate:724499117 1 udp 2113937151 cd6bc520-e988-41f8-bd66-da769fc224a9.local 52763 typ host generation 0 network-cost 999',
  'a=candidate:9 1 tcp 1518280447 cd6bc520-e988-41f8-bd66-da769fc224a9.local 9 typ host tcptype active generation 0',
  'a=candidate:842163049 1 udp 1677729535 102.90.99.12 61234 typ srflx raddr 0.0.0.0 rport 0 generation 0',
  'a=ice-ufrag:512C',
  'a=ice-pwd:wTLjI1aI5sYI8QiIXJ4LBVYe',
  'a=ice-options:trickle',
  'a=fingerprint:sha-256 0A:BB:6D:A2:2E:AA:66:45:8F:F6:79:E2:81:16:02:BB:95:8B:5B:02:CC:6E:D7:72:29:C3:7C:C5:30:76:97:64',
  'a=setup:actpass',
  'a=mid:0',
  'a=sctp-port:5000',
  'a=max-message-size:262144',
  '',
].join('\r\n');

describe('packed local-room descriptions', () => {
  it('keep what a data-channel connection needs, in under 200 characters', () => {
    const packed = packSdp(CHROME_OFFER, 'offer');
    expect(packed.length).toBeLessThan(200);
    expect(packed.startsWith('L1.o.c.512C.')).toBe(true);
    const parts = unpackParts(packed);
    expect(parts).toMatchObject({ kind: 'offer', setup: 'actpass', ufrag: '512C', pwd: 'wTLjI1aI5sYI8QiIXJ4LBVYe' });
    // UDP only: the TCP candidate is left out
    expect(parts.candidates).toEqual([
      { type: 'host', address: 'cd6bc520-e988-41f8-bd66-da769fc224a9.local', port: 52763 },
      { type: 'srflx', address: '102.90.99.12', port: 61234 },
    ]);
    expect([...parts.fingerprint]).toEqual([...sdpParts(CHROME_OFFER, 'offer').fingerprint]);
  });

  it('unpack to a minimal description with the same credentials, fingerprint and candidates', () => {
    const { type, sdp } = unpackSdp(packSdp(CHROME_OFFER, 'offer'));
    expect(type).toBe('offer');
    expect(sdp).toContain('m=application 9 UDP/DTLS/SCTP webrtc-datachannel');
    expect(sdp).toContain('a=ice-ufrag:512C');
    expect(sdp).toContain('a=ice-pwd:wTLjI1aI5sYI8QiIXJ4LBVYe');
    expect(sdp).toContain('a=fingerprint:sha-256 0A:BB:6D:A2:2E:AA:66:45:8F:F6:79:E2:81:16:02:BB:95:8B:5B:02:CC:6E:D7:72:29:C3:7C:C5:30:76:97:64');
    expect(sdp).toContain('cd6bc520-e988-41f8-bd66-da769fc224a9.local 52763 typ host');
    expect(sdp).toContain('a=setup:actpass');
    expect(sdp.endsWith('\r\n')).toBe(true);
    // and the minimal one packs back to the same code
    expect(packSdp(sdp, 'offer')).toBe(packSdp(CHROME_OFFER, 'offer'));
  });

  it('refuse anything damaged or foreign (a code is untrusted input)', () => {
    const good = packSdp(CHROME_OFFER, 'offer');
    const bad = [
      '',
      'hello',
      good.replace('L1.', 'L2.'),
      good.replace('.o.', '.x.'),
      good.replace('512C', '512C<script>'),
      good.replace(/\.[A-Za-z0-9_-]{43}\./, '.AAAA.'),
      good.replace('52763', '99999'),
      good.replace('cd6bc520-e988-41f8-bd66-da769fc224a9.local', 'evil.example.com'),
      `${good},h~1.2.3.4~1`.repeat(30),
      'L1.o.c.512C.wTLjI1aI5sYI8QiIXJ4LBVYe.' + 'A'.repeat(43) + '.',
    ];
    for (const code of bad) expect(() => unpackParts(code), code.slice(0, 40)).toThrow();
  });

  it('room codes and the relay address', () => {
    expect(normalizeLanCode(' lqj-nrm ')).toBe('LQJNRM');
    expect(normalizeLanCode('ABC')).toBeNull();
    expect(lanSignalUrl('host', { protocol: 'https:', host: '40-123-240-224.sslip.io' })).toBe('wss://40-123-240-224.sslip.io/ws/lan/host');
    expect(lanSignalUrl('join/LQJNRM', { protocol: 'http:', host: 'localhost:5173' })).toBe('ws://localhost:5173/ws/lan/join/LQJNRM');
  });
});
