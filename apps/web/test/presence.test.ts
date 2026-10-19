import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PresenceBeat, type PresenceApi } from '../src/presence';

class FakeApi implements PresenceApi {
  me: { id: string } | null = null;
  beats: (string | null)[] = [];
  cleared = 0;
  private listeners = new Set<(me: { id: string }) => void>();
  onSignIn(l: (me: { id: string }) => void) {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
  signIn(id: string) {
    this.me = { id };
    for (const l of this.listeners) l(this.me);
  }
  async beatPresence(room: string | null) {
    this.beats.push(room);
  }
  async clearPresence() {
    this.cleared++;
  }
}

function page() {
  const handlers = new Map<string, () => void>();
  const target = { addEventListener: (type: string, fn: () => void) => void handlers.set(type, fn) } as unknown as Pick<Window, 'addEventListener'>;
  const doc = { visibilityState: 'visible' as DocumentVisibilityState, addEventListener: (type: string, fn: () => void) => void handlers.set(type, fn) } as unknown as Pick<Document, 'visibilityState' | 'addEventListener'> & { visibilityState: DocumentVisibilityState };
  return { doc, win: target, fire: (type: string) => handlers.get(type)?.() };
}

describe('PresenceBeat', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('beats every 30 s once signed in and visible, with the room when in one; stops when hidden; clears on leaving', () => {
    const api = new FakeApi();
    const p = page();
    let room: string | null = null;
    const beat = new PresenceBeat(api, () => room, p.doc, p.win, 30_000);
    vi.advanceTimersByTime(60_000);
    expect(api.beats).toEqual([]); // nobody signed in

    api.signIn('u1');
    expect(api.beats).toEqual([null]);
    vi.advanceTimersByTime(30_000);
    expect(api.beats).toEqual([null, null]);

    room = 'KQXMZP';
    beat.update(); // joined a match: at once, not at the next beat
    expect(api.beats.at(-1)).toBe('KQXMZP');
    beat.update(); // nothing changed: no extra beat
    expect(api.beats).toHaveLength(3);

    p.doc.visibilityState = 'hidden';
    p.fire('visibilitychange');
    vi.advanceTimersByTime(120_000);
    expect(api.beats).toHaveLength(3);
    p.doc.visibilityState = 'visible';
    p.fire('visibilitychange');
    expect(api.beats).toHaveLength(4);

    p.fire('pagehide');
    expect(api.cleared).toBe(1);
  });
});
