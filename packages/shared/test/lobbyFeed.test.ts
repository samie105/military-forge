import { describe, expect, it } from 'vitest';
import { CARD_REPLIES, QUICK_CHAT, fightNightWindow, isQuickChatId, quickChat } from '../src';

describe('the Lobby feed contract', () => {
  it('quick chat ids are unique, short and every card reply is one of them', () => {
    const ids = QUICK_CHAT.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z_]{2,24}$/);
    for (const replies of Object.values(CARD_REPLIES)) for (const id of replies) expect(isQuickChatId(id)).toBe(true);
    expect(QUICK_CHAT.filter((p) => !('emote' in p)).length).toBeGreaterThanOrEqual(20);
    for (const p of QUICK_CHAT) if ('emote' in p) expect(p.label).toBeTruthy();
    expect(quickChat('how_far')?.text).toBe('How far?');
    expect(isQuickChatId('free text')).toBe(false);
  });

  it('Fight night runs 20:00–22:00 WAT (19:00–21:00 UTC), today until it ends, then tomorrow', () => {
    const at = (iso: string) => Date.parse(iso);
    const morning = fightNightWindow(at('2026-11-01T08:00:00Z'));
    expect(new Date(morning.startsAt).toISOString()).toBe('2026-11-01T19:00:00.000Z');
    expect(new Date(morning.endsAt).toISOString()).toBe('2026-11-01T21:00:00.000Z');
    expect(morning.live).toBe(false);
    const during = fightNightWindow(at('2026-11-01T20:30:00Z'));
    expect(during.live).toBe(true);
    expect(new Date(during.startsAt).toISOString()).toBe('2026-11-01T19:00:00.000Z');
    const after = fightNightWindow(at('2026-11-01T21:00:00Z'));
    expect(after.live).toBe(false);
    expect(new Date(after.startsAt).toISOString()).toBe('2026-11-02T19:00:00.000Z');
    // 23:30 WAT is still "today" in Lagos but past the window: tomorrow's
    const late = fightNightWindow(at('2026-11-01T22:30:00Z'));
    expect(new Date(late.startsAt).toISOString()).toBe('2026-11-02T19:00:00.000Z');
  });
});
