/** Local rooms' signaling (lanSignal.ts): codes, the offer/answer relay, limits, and the host leaving. */
import { CloseCode } from '@military-forge/protocol';
import { describe, expect, it } from 'vitest';
import { LanSignal } from '../src/lanSignal';
import { RoomRegistry } from '../src/rooms';
import type { ClientConn } from '../src/room';

class Conn implements ClientConn {
  readonly got: Record<string, unknown>[] = [];
  closed: { code: number; reason: string } | null = null;
  send(bytes: Uint8Array) {
    this.got.push(JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>);
  }
  close(code: number, reason: string) {
    this.closed = { code, reason };
  }
  bufferedAmount() {
    return 0;
  }
}

const frame = (msg: unknown) => new TextEncoder().encode(JSON.stringify(msg));

describe('local room signaling', () => {
  it('relays the host’s offer to a guest and the answer back, by peer', () => {
    const lan = new LanSignal();
    const h = new Conn();
    const host = lan.open('/ws/lan/host', h, '10.0.0.2')!;
    const code = h.got[0]!.code as string;
    expect(code).toMatch(/^[A-Z]{6}$/);
    const g = new Conn();
    const guest = lan.open(`/ws/lan/join/${code}`, g, '10.0.0.3')!;
    expect(h.got[1]).toEqual({ t: 'join', peer: 1 });
    // the guest hears at once that the room is there, before the host's offer
    expect(g.got[0]).toEqual({ t: 'here' });
    host.receive(frame({ t: 'offer', peer: 1, sdp: 'OFFER' }));
    expect(g.got[1]).toEqual({ t: 'offer', sdp: 'OFFER' });
    guest.receive(frame({ t: 'answer', sdp: 'ANSWER' }));
    expect(h.got[2]).toEqual({ t: 'answer', peer: 1, sdp: 'ANSWER' });
    guest.closed();
    expect(h.got[3]).toEqual({ t: 'leave', peer: 1 });
  });

  it('refuses unknown codes, oversized descriptions, floods and too many rooms from one address', () => {
    const lan = new LanSignal();
    const nobody = new Conn();
    expect(lan.open('/ws/lan/join/ZZZZZZ', nobody, null)).toBeNull();
    expect(nobody.closed?.code).toBe(CloseCode.NoRoom);
    const h = new Conn();
    const host = lan.open('/ws/lan/host', h, '10.0.0.2')!;
    const g = new Conn();
    lan.open(`/ws/lan/join/${h.got[0]!.code as string}`, g, null);
    host.receive(frame({ t: 'offer', peer: 1, sdp: 'x'.repeat(5000) }));
    expect(g.got).toEqual([{ t: 'here' }]); // too big: not relayed
    for (let i = 0; i < 12; i++) host.receive(frame({ t: 'noise' }));
    expect(h.closed?.code).toBe(CloseCode.RateLimited);
    const many = [1, 2, 3, 4, 5].map(() => new Conn());
    const opened = many.map((c) => lan.open('/ws/lan/host', c, '10.0.0.9'));
    expect(opened.filter(Boolean).length).toBe(4);
    expect(many[4]!.closed?.code).toBe(CloseCode.RateLimited);
  });

  it('a probe says whether the room is there in one message, and the host never hears of it', () => {
    const lan = new LanSignal();
    const h = new Conn();
    lan.open('/ws/lan/host', h, null);
    const code = h.got[0]!.code as string;
    const p = new Conn();
    expect(lan.open(`/ws/lan/join/${code}?probe`, p, null)).toBeNull();
    expect(p.got).toEqual([{ t: 'here' }]);
    expect(p.closed?.code).toBe(1000);
    expect(h.got).toHaveLength(1); // no join, no offer made for it
    const none = new Conn();
    expect(lan.open('/ws/lan/join/ZZZZZZ?probe', none, null)).toBeNull();
    expect(none.got).toEqual([]);
    expect(none.closed?.code).toBe(CloseCode.NoRoom);
  });

  it('the host leaving closes the room for its guests, and frees the code', () => {
    const lan = new LanSignal();
    const h = new Conn();
    const host = lan.open('/ws/lan/host', h, null)!;
    const code = h.got[0]!.code as string;
    const g = new Conn();
    lan.open(`/ws/lan/join/${code}`, g, null);
    host.closed();
    expect(g.closed?.code).toBe(CloseCode.NoRoom);
    expect(lan.hostCount).toBe(0);
    expect(lan.open(`/ws/lan/join/${code}`, new Conn(), null)).toBeNull();
  });

  it('the room registry sends /ws/lan/… here, not to a room', () => {
    const reg = new RoomRegistry({ defaultRoom: null });
    const h = new Conn();
    expect(reg.open('/ws/lan/host', h, null)).not.toBeNull();
    expect(h.got[0]!.t).toBe('code');
    expect(reg.rooms.size).toBe(0);
  });
});
