import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AssetTracker, type ItemHooks } from '../assetLoad';
import { defaultBindings } from './controls';
import { MAX_ART_WAIT_MS, fieldTips, holdLoading, loadLine, loadPercent, threeTips } from './mapLoading';
import type { LobbyView } from './onlineView';
import { MapLoading } from './screens/Connection';

const manager = (): ItemHooks & { log: string[] } => {
  const log: string[] = [];
  return {
    log,
    itemStart: (url) => log.push(`start ${url}`),
    itemEnd: (url) => log.push(`end ${url}`),
    itemError: (url) => log.push(`error ${url}`),
  };
};

describe('the asset tracker', () => {
  it("counts the manager's files from a mark, the ones still loading then included, and keeps its hooks", () => {
    const m = manager();
    const t = new AssetTracker();
    t.attach(m, false);
    m.itemStart('a.glb');
    m.itemStart('b.ktx2');
    m.itemEnd('a.glb');
    const mark = t.mark();
    expect(t.since(mark)).toEqual({ files: 1, done: 0, bytes: 0 });
    m.itemStart('c.webp');
    m.itemEnd('b.ktx2');
    t.addBytes(2_100_000);
    expect(t.since(mark)).toEqual({ files: 2, done: 1, bytes: 2_100_000 });
    // a failed load: three calls itemError, then itemEnd, which counts it once
    m.itemError('c.webp');
    m.itemEnd('c.webp');
    expect(t.since(mark)).toEqual({ files: 2, done: 2, bytes: 2_100_000 });
    expect(m.log).toEqual(['start a.glb', 'start b.ktx2', 'end a.glb', 'start c.webp', 'end b.ktx2', 'error c.webp', 'end c.webp']);
  });

  it('attaches once', () => {
    const m = manager();
    const t = new AssetTracker();
    t.attach(m, false);
    t.attach(m, false);
    const mark = t.mark();
    m.itemStart('a');
    expect(t.since(mark).files).toBe(1);
  });
});

describe('the map loading screen', () => {
  const idle = { files: 0, done: 0, bytes: 0 };
  const busy = { files: 4, done: 1, bytes: 1_500_000 };

  it('holds until the first world update, then in a lobby while the art loads, 8 s at most', () => {
    expect(holdLoading({ haveMatch: false, waiting: false, load: idle, heldMs: 0 })).toBe(true);
    expect(holdLoading({ haveMatch: true, waiting: true, load: idle, heldMs: 0 })).toBe(false);
    expect(holdLoading({ haveMatch: true, waiting: true, load: busy, heldMs: 1000 })).toBe(true);
    expect(holdLoading({ haveMatch: true, waiting: true, load: busy, heldMs: MAX_ART_WAIT_MS })).toBe(false);
    // a match under way doesn't wait for art: the player is already in it
    expect(holdLoading({ haveMatch: true, waiting: false, load: busy, heldMs: 0 })).toBe(false);
  });

  it('reads progress from the room, the world and the files', () => {
    expect(loadPercent(false, idle)).toBe(25);
    expect(loadPercent(false, busy)).toBe(40);
    expect(loadPercent(true, busy)).toBe(55);
    expect(loadPercent(true, idle)).toBe(100);
    expect(loadLine(true, busy)).toBe("Loading the map · 1 of 4 · 1.5 MB");
    expect(loadLine(true, { files: 2, done: 1, bytes: 0 })).toBe("Loading the map · 1 of 2");
    expect(loadLine(false, idle)).toBe('Getting the battlefield from the server');
  });

  it("writes the tips in the player's own keys and pages three of them", () => {
    const b = defaultBindings();
    const tips = fieldTips({ ...b, jet: ['KeyF'] });
    expect(tips[0]!.title).toBe('Hold F to fly.');
    expect(tips).toHaveLength(5);
    expect(threeTips(tips, 4).map((t) => t.title)).toEqual([tips[4]!.title, tips[0]!.title, tips[1]!.title]);
  });

  it("shows the map, the room's rules, the progress and a tip", () => {
    const lobby: LobbyView = {
      code: 'KMTXRB',
      players: [
        { id: 0, name: 'Ade', isBot: false, ready: false, host: true, you: true, pingMs: 30 },
        { id: 1, name: 'Kemi', isBot: false, ready: false, host: false, you: false, pingMs: 40 },
        { id: 2, name: 'Rook', isBot: true, ready: false, host: false, you: false, pingMs: -1 },
      ],
      isHost: true,
      ready: false,
      minPlayers: 2,
      timeLimit: 300,
      killLimit: 10,
      mapId: 'street-market',
      mapName: 'Street Market',
      bots: 4,
      botLevel: 'normal',
    };
    const html = renderToStaticMarkup(
      createElement(MapLoading, { code: 'KMTXRB', lobby, mapName: 'Street Market', haveMatch: true, load: busy, bindings: defaultBindings(), onCancel: () => {} }),
    );
    expect(html).toContain('Street Market');
    expect(html).toMatch(/First to <b class="num">10<\/b>/);
    expect(html).toContain('5:00');
    expect(html).toContain('2 players · 1 bot');
    expect(html).toContain('55%');
    expect(html).toContain('aria-valuenow="55"');
    expect(html).toMatch(/Field tip <span class="num">1<\/span> of 3/);
  });
});
