/**
 * Home's stops play through (UX audit 31 Oct, A-03: the pass ended at the first Next, because another
 * spotlight's empty overlay was the first .mf-spot in the page), and Home asks one thing at a time (D-01).
 * No DOM here: a small stand-in for the document, the targets and the spotlight.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HOME_STOPS, runHomeStops } from '../../src/tour/homeStops';
import { homeAsk, homeStopsRunning } from '../../src/tour/homeQueue';
import type { TourMemory } from '../../src/tour/index';
import type { SpotStep, Spotlight } from '../../src/ui/spotlight';

class FakeNode {
  constructor(readonly name: string) {}
  contains(n: unknown) {
    return n === this;
  }
  getClientRects() {
    return [1];
  }
  disabled = false;
}

const g = globalThis as Record<string, unknown>;
let saved: Record<string, unknown>;
let clicks: ((e: { target: unknown }) => void)[];
let active: unknown;
const targets = { create: new FakeNode('create'), join: new FakeNode('join'), locker: new FakeNode('locker') };
const body = new FakeNode('body');
// what used to fool the click guard: another spotlight's leftover overlay, first in the document
const leftover = new FakeNode('leftover .mf-spot');

beforeEach(() => {
  saved = { document: g.document, Node: g.Node };
  clicks = [];
  active = body;
  g.Node = FakeNode;
  g.document = {
    body,
    documentElement: new FakeNode('html'),
    get activeElement() {
      return active;
    },
    querySelector: (sel: string) => {
      if (sel === '.mf-spot') return leftover;
      const id = /data-tour="(\w+)"/.exec(sel)?.[1] as keyof typeof targets | undefined;
      return id ? targets[id] : null;
    },
    addEventListener: (type: string, fn: (e: { target: unknown }) => void) => type === 'click' && clicks.push(fn),
    removeEventListener: (type: string, fn: (e: { target: unknown }) => void) => {
      if (type === 'click') clicks = clicks.filter((f) => f !== fn);
    },
  };
});
afterEach(() => {
  Object.assign(g, saved);
});

function fakeSpot() {
  const callout = new FakeNode('callout');
  const next = new FakeNode('next');
  const shown: SpotStep[] = [];
  let focused = 0;
  const spot = {
    onPrimary: null as ((id: string) => void) | null,
    onSkip: null as ((id: string, all: boolean) => void) | null,
    show: (s: SpotStep) => shown.push(s),
    hide: () => Promise.resolve(),
    dispose: () => {},
    contains: (n: unknown) => n === callout || n === next,
    focusCallout: () => {
      focused++;
      active = next;
    },
  };
  // a press on the callout's Next: the document's capture listener sees it first, then the callout's own
  const pressNext = () => {
    for (const fn of [...clicks]) fn({ target: next });
    spot.onPrimary?.(shown.at(-1)!.id);
  };
  return { spot, shown, pressNext, focused: () => focused, callout };
}

function fakeMemory() {
  const facts: unknown[] = [];
  const memory = {
    record: () => {},
    fact: (e: unknown) => facts.push(e),
    facts: { get: () => ({ experience: 'veteran', invited: false }) },
  } as unknown as TourMemory;
  return { memory, facts };
}

describe('Home stops (A-03)', () => {
  it('every stop plays through on Next, with another spotlight in the page, and the focus follows', () => {
    const { spot, shown, pressNext, focused } = fakeSpot();
    const { memory, facts } = fakeMemory();
    runHomeStops(memory, () => 'keyboard', spot as unknown as Spotlight);
    expect(homeStopsRunning()).toBe(true);
    expect(shown.map((s) => s.title)).toEqual(['Play with friends.']);
    pressNext();
    pressNext();
    expect(shown.map((s) => s.title)).toEqual(['Play with friends.', 'Got a code?', 'Your kit.']);
    expect(shown.at(-1)!.primary?.label).toBe('Done');
    pressNext();
    expect(facts).toContainEqual({ k: 'tour', tour: HOME_STOPS, finished: true });
    expect(homeStopsRunning()).toBe(false);
    // each stop's Next took the focus (the first from nowhere, the rest from the last Next)
    expect(focused()).toBe(3);
  });

  it('a tap elsewhere on the screen still leaves the pass, and the ringed control ends it done', () => {
    const a = fakeSpot();
    const m1 = fakeMemory();
    runHomeStops(m1.memory, () => 'keyboard', a.spot as unknown as Spotlight);
    for (const fn of [...clicks]) fn({ target: new FakeNode('elsewhere') });
    expect(m1.facts).toContainEqual({ k: 'tour', tour: HOME_STOPS, skipped: true });

    const b = fakeSpot();
    const m2 = fakeMemory();
    runHomeStops(m2.memory, () => 'keyboard', b.spot as unknown as Spotlight);
    for (const fn of [...clicks]) fn({ target: targets.create });
    expect(m2.facts).toContainEqual({ k: 'tour', tour: HOME_STOPS, finished: true });
  });

  it("doesn't take the focus from what the player is on", () => {
    active = targets.join;
    const { spot, focused } = fakeSpot();
    runHomeStops(fakeMemory().memory, () => 'keyboard', spot as unknown as Spotlight)?.();
    expect(focused()).toBe(0);
  });
});

describe("Home's queue (D-01)", () => {
  it('the play-data question first, then the stops, then nothing (Next orders); a pass already running finishes first', () => {
    expect(homeAsk(true, false)).toBe('consent');
    expect(homeAsk(false, true)).toBe('stops');
    expect(homeAsk(true, true)).toBe('stops');
    expect(homeAsk(false, false)).toBeNull();
  });
});
