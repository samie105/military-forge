/** The VS poster (research §8): layouts, the countdown's mount (it never touches GO), avatars in rows, warming. */
import { DEFAULT_COSMETIC_LOADOUT, botLook, lookSeed, type CosmeticLoadout } from '@military-forge/content';
import { MatchPhase } from '@military-forge/sim';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import { lookBook, type LookBook } from '../../src/looks/book';
import { avatarElement } from '../../src/presentation/domAvatar';
import { cardName, rollCall, rulesLine, vsLayout, type VsFighter } from '../../src/presentation/layout';
import { VsPoster, VsStrip } from '../../src/presentation/VsPoster';
import { roomPortraits } from '../../src/presentation/warm';
import { placeholderLoadout } from '../../src/render3d/character';
import { Countdown, countdownState } from '../../src/shell/screens/Countdown';
import type { MatchView } from '../../src/shell/matchView';

const f = (id: number, over: Partial<VsFighter> = {}): VsFighter => ({ id, name: `P${id}`, isBot: false, you: false, host: false, ...over });

describe('poster layouts', () => {
  it('free-for-all: one fighter, a duel of two, a row to 8, two rows to 16; you first, bots last', () => {
    expect(vsLayout([f(0, { you: true })]).kind).toBe('solo');
    const duel = vsLayout([f(3), f(1, { you: true })]);
    expect(duel.kind).toBe('duel');
    expect(duel.stamp).toBe('VS');
    expect(duel.sides.map((s) => s[0]!.id)).toEqual([1, 3]);
    const row = vsLayout([f(5, { isBot: true }), f(2), f(7, { you: true }), f(1)]);
    expect(row).toMatchObject({ kind: 'row', stamp: 'ALL VS ALL' });
    expect(row.sides[0]!.map((x) => x.id)).toEqual([7, 1, 2, 5]);
    const full = vsLayout(Array.from({ length: 16 }, (_, i) => f(i)));
    expect(full.kind).toBe('rows');
    expect(full.sides.map((s) => s.length)).toEqual([8, 8]);
    expect(vsLayout(Array.from({ length: 9 }, (_, i) => f(i))).sides.map((s) => s.length)).toEqual([5, 4]);
  });

  it('teams (when team modes exist): a side per team in the given order, VS between; 4v4v4 and 2v2v2v2', () => {
    const all = Array.from({ length: 12 }, (_, i) => f(i, { you: i === 6 }));
    const three = vsLayout(all, [[0, 1, 2, 3], [4, 5, 6, 7], [8, 9, 10, 11]]);
    expect(three.kind).toBe('teams');
    expect(three.sides.map((s) => s.length)).toEqual([4, 4, 4]);
    expect(three.sides[1]![0]!.id).toBe(6);
    expect(vsLayout(all.slice(0, 8), [[0, 1], [2, 3], [4, 5], [6, 7]]).sides).toHaveLength(4);
  });

  it('names: no bot tag, 16 characters at most; the rules line', () => {
    expect(cardName({ name: '[BOT] Kolo', isBot: true })).toBe('Kolo');
    expect(cardName({ name: 'Abcdefghijklmnopq', isBot: false })).toBe('Abcdefghijklmno…');
    expect(rulesLine(20, 300)).toBe('First to 20 · 5 min');
    expect(rulesLine(0, 90)).toBe('No kill limit · 1:30');
    expect(rollCall([f(2, { isBot: true }), f(9), f(4, { you: true })]).map((x) => x.id)).toEqual([4, 9, 2]);
  });
});

const view = (over: Partial<MatchView> = {}): MatchView => ({
  phase: MatchPhase.Countdown,
  number: 1,
  secondsLeft: 5,
  untimed: false,
  secondsElapsed: 0,
  killLimit: 20,
  timeLimit: 300,
  countdownTotal: 5,
  mapName: 'Street Market',
  localId: 0,
  myScore: 0,
  leaderScore: 0,
  leaderName: '',
  ready: false,
  votes: 0,
  humans: 2,
  voted: false,
  results: null,
  ...over,
});

const roster = (book: LookBook) => {
  book.setRoster(0, [
    { id: 0, name: 'Ade', isBot: false },
    { id: 1, name: 'Kemi', isBot: false },
    { id: 2, name: '[BOT] Kolo', isBot: true },
  ]);
  book.setHost(0);
  book.replace([
    [0, DEFAULT_COSMETIC_LOADOUT],
    [2, botLook(lookSeed(1, '[BOT] Kolo'))],
  ]);
};

afterEach(() => lookBook.clear());

describe('the poster in the countdown', () => {
  it('replaces the map intro once the room is known: names, tags, the stamp, the map and rules', () => {
    roster(lookBook);
    const html = renderToStaticMarkup(<Countdown view={view()} state="intro" />);
    expect(html).toContain('data-screen="vs-poster"');
    expect(html).toContain('ALL VS ALL');
    expect(html).toContain('Street Market');
    expect(html).toContain('First to 20 · 5 min');
    for (const name of ['Ade', 'Kemi', 'Kolo']) expect(html).toContain(`>${name}<`);
    expect(html).not.toContain('[BOT]');
    expect(html).toMatch(/tag--you[^>]*>You</);
    expect(html).toMatch(/tag--host[^>]*>Host</);
    expect(html).toMatch(/tag--bot[^>]*>Bot</);
    // the silhouettes are there at once (the renders cross-fade in)
    expect(html).toContain('pt__base');
  });

  it('with nobody known yet (an old server): the map intro as before', () => {
    const html = renderToStaticMarkup(<Countdown view={view()} state="intro" />);
    expect(html).not.toContain('vs-poster');
    expect(html).toContain('intro__name');
  });

  it('after the poster: the folded strip over 3-2-1, no "Match 1" block; GO as before', () => {
    roster(lookBook);
    const three = renderToStaticMarkup(<Countdown view={view({ secondsLeft: 3 })} state="3" />);
    expect(three).toContain('data-screen="vs-strip"');
    expect(three).toContain('cd__num');
    const match = renderToStaticMarkup(<Countdown view={view({ secondsLeft: 4 })} state="match" />);
    expect(match).not.toContain('cd__match-title');
    const go = renderToStaticMarkup(<Countdown view={view({ phase: MatchPhase.InProgress })} state="go" />);
    expect(go).not.toContain('vs-strip');
    expect(go).toContain('cd__go');
  });

  it('never moves GO: the countdown states still come from the sim\'s seconds alone', () => {
    expect(countdownState({ phase: MatchPhase.Countdown, secondsLeft: 4 })).toBe('match');
    expect(countdownState({ phase: MatchPhase.Countdown, secondsLeft: 1 })).toBe('1');
    expect(countdownState({ phase: MatchPhase.InProgress, secondsLeft: 300 })).toBeNull();
  });

  it('a duel and a team layout render (the teams for later team modes)', () => {
    const two = [f(0, { name: 'Ade', you: true }), f(1, { name: 'Kemi' })];
    const duel = renderToStaticMarkup(<VsPoster view={view()} fighters={two} leaving={false} held={false} />);
    expect(duel).toContain('vs--duel');
    expect(duel).toContain('vs__stamp--big');
    const teams = renderToStaticMarkup(<VsPoster view={view()} fighters={Array.from({ length: 8 }, (_, i) => f(i))} leaving={false} held={false} teams={[[0, 1, 2, 3], [4, 5, 6, 7]]} />);
    expect(teams).toContain('data-teams="2"');
    expect(teams).toContain('Team deathmatch');
    const strip = renderToStaticMarkup(<VsStrip view={view()} fighters={two} />);
    expect(strip).toContain('vs-strip__face is-you');
  });
});

describe('avatars and warming', () => {
  it('the scoreboard\'s DOM avatar: the silhouette with the initial, and a bot badge', () => {
    roster(lookBook);
    const made: { tag: string; className?: string; src?: string; kids: unknown[] }[] = [];
    const node = (tag: string) => {
      const n = { tag, className: '', src: '', alt: '', kids: [] as unknown[], appendChild(c: unknown) { this.kids.push(c); return c; }, setAttribute() {} };
      made.push(n);
      return n;
    };
    const doc = { createElement: node, createElementNS: (_: string, tag: string) => node(tag) } as unknown as Document;
    const el = avatarElement(doc, 2, '[BOT] Kolo', true) as unknown as { className: string; kids: { className: string }[] };
    expect(el.className).toBe('avatar avatar--portrait');
    expect(el.kids.map((k) => k.className)).toEqual(['pt', 'avatar__bot']);
    const base = made.find((m) => m.className === 'pt__base')!;
    expect(decodeURIComponent(base.src!)).toContain('>K<');
  });

  it('a room warms everyone\'s avatar first, then their poster render (compact cards past 8)', () => {
    roster(lookBook);
    const reqs = roomPortraits(lookBook);
    // Kemi's page sends no look (an old page): she wears the 3D view's placeholder, avatar and all
    expect(reqs.map((r) => `${r.size}:${r.pose}`)).toEqual(['64:portrait', '64:portrait', '64:portrait', ...Array(3).fill(expect.stringMatching(/^512:poster-\d$/))]);
    expect(reqs[1]!.look).toEqual(placeholderLoadout(1));
    const many = { fighters: () => Array.from({ length: 10 }, (_, i) => ({ id: i, name: `P${i}`, isBot: false })), drawn: (): CosmeticLoadout => DEFAULT_COSMETIC_LOADOUT };
    expect(roomPortraits(many).filter((r) => r.size === 128)).toHaveLength(10);
  });
});
