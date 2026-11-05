import { createTuning } from '@military-forge/content';
import { SpectateQueue } from '@military-forge/protocol';
import { describe, expect, it } from 'vitest';
import { hudFrame, type HudInput, type HudMemory } from '../../src/hud/hud';
import { hudTemplate } from '../../src/hud/template';
import type { SpectateView } from '../../src/spectate/director';

const mem: HudMemory = { sinceHitS: 9, death: null, keys: {}, netDetail: '', hpGhost: 1, hitMarker: false, killMarker: false, boardOpen: false };
const input = (spectate: SpectateView | null): HudInput => ({
  frame: { tick: 1, localId: -1, players: [], grenades: [] },
  tuning: createTuning(),
  match: null,
  toScreen: (x, y) => ({ x, y }),
  pointer: null,
  showNet: false,
  showFps: false,
  fps: 60,
  reduceFlashes: false,
  flash: 0,
  scoreRows: () => null,
  spectate,
});
const watch: SpectateView = { kind: 'watch', followId: 3, free: false, x: 0, y: 0, zoom: 1, name: 'KEMI', bot: false, hp: 0.6, line: 'Hammer .44 · 7 kills', delay: 3, watching: 4, queue: SpectateQueue.Watching, slots: 0, rows: [] };

describe('the spectator bar (v20)', () => {
  it('a spectator (no player of its own) gets the bar, its label saying how far behind, and Join next round', () => {
    const { tokens, values } = hudFrame(input(watch), mem);
    expect(tokens).toEqual(expect.arrayContaining(['spectate-bar', 'spec-watch', 'spec-target']));
    expect(tokens).not.toContain('spec-death');
    expect(values).toMatchObject({ 'spectate.label': 'Watching · 3 s behind', 'spectate.name': 'KEMI', 'spectate.line': 'Hammer .44 · 7 kills', 'v.specHp': '0.6', 'spectate.watching': '4 watching', 'spectate.join': 'Join next round', 'spectate.freeLabel': 'Free cam' });
  });

  it('a free slot says Jump in now; queued says so; the free camera says Follow', () => {
    expect(hudFrame(input({ ...watch, slots: 2 }), mem).values['spectate.join']).toBe('Jump in now');
    const q = hudFrame(input({ ...watch, queue: SpectateQueue.Next }), mem);
    expect(q.values['spectate.join']).toBe('Queued · cancel');
    expect(q.tokens).toContain('spec-queued');
    const free = hudFrame(input({ ...watch, free: true, followId: -1, name: 'Free camera' }), mem);
    expect(free.values['spectate.freeLabel']).toBe('Follow');
    expect(free.values['spectate.label']).toBe('Overview · 3 s behind');
    expect(free.tokens).not.toContain('spec-target');
  });

  it('the death cam: the bar, no delay, no Join; nothing when playing', () => {
    const d = hudFrame(input({ ...watch, kind: 'death', delay: 0 }), mem);
    expect(d.tokens).toEqual(expect.arrayContaining(['spectate-bar', 'spec-death']));
    expect(d.tokens).not.toContain('spec-watch');
    expect(d.values['spectate.label']).toBe('Death cam');
    expect(hudFrame(input(null), mem).tokens).not.toContain('spectate-bar');
  });

  it('no delay, no "behind"; a bot takes the Bot chip, never a tag in its name (UX-32)', () => {
    expect(hudFrame(input({ ...watch, delay: 0 }), mem).values['spectate.label']).toBe('Watching');
    expect(hudFrame(input({ ...watch, bot: true }), mem).tokens).toContain('spec-bot');
    expect(hudFrame(input(watch), mem).tokens).not.toContain('spec-bot');
    const html = hudTemplate();
    expect(html.match(/<span class="tag tag--bot" data-state="spec-bot">Bot<\/span>/g)!.length).toBe(2);
  });

  it('the tags that sat under the minimap are gone: the delay is the bar\'s label (UX-32)', () => {
    const html = hudTemplate();
    expect(html).not.toContain('mf-spec-tags');
    expect(html).not.toContain('mf-spec-tag--delay');
    expect(html).not.toContain('spectate.delay');
  });

  it('the bar\'s buttons carry their hooks on both screens', () => {
    const html = hudTemplate();
    for (const hook of ['prev', 'next', 'free', 'join']) expect(html.match(new RegExp(`data-spec="${hook}"`, 'g'))!.length).toBe(2);
  });
});
