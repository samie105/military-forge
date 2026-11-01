import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { shellCues } from '../src/audio/ui';
import { INTRO_MS, TitleScreen, introElapsed, pressTitle, promptKind } from '../src/shell/screens/Title';
import { createShellStore } from '../src/shell/store';
import { continuesTitle, titleWanted } from '../src/shell/title';

const want = (path: string, search = '', webdriver = false, appMode = true) => titleWanted({ appMode, path, params: new URLSearchParams(search), webdriver });

describe('the title screen: when it shows', () => {
  it('opens the app; not for an invite link, a local-room join, the debug client or ?notitle', () => {
    expect(want('/')).toBe(true);
    expect(want('/', '?app')).toBe(true);
    expect(want('/r/KMTXRB')).toBe(false);
    expect(want('/', '?lan=ABCD')).toBe(false);
    expect(want('/', '', false, false)).toBe(false);
    expect(want('/', '?notitle')).toBe(false);
  });

  it('a browser under automation skips it (the end-to-end scripts) unless it asks with ?title', () => {
    expect(want('/', '?app', true)).toBe(false);
    expect(want('/', '?app&title', true)).toBe(true);
  });
});

describe('the title screen: what continues', () => {
  const key = (key: string, mods: Partial<KeyboardEvent> = {}) => continuesTitle({ key, ctrlKey: false, metaKey: false, altKey: false, repeat: false, ...mods });
  it('any key but a lone modifier, a browser shortcut or a held repeat', () => {
    for (const k of ['Enter', ' ', 'a', 'Escape', 'ArrowUp', 'F2']) expect(key(k), k).toBe(true);
    for (const k of ['Shift', 'Control', 'Alt', 'Meta', 'Tab']) expect(key(k), k).toBe(false);
    expect(key('r', { metaKey: true })).toBe(false);
    expect(key('r', { ctrlKey: true })).toBe(false);
    expect(key('a', { repeat: true })).toBe(false);
  });

  it('a press while the app still boots waits (a loading line); once ready it pushes in; a second press does nothing', () => {
    const store = createShellStore({ title: 'on', screen: { name: 'boot' } });
    pressTitle(store);
    expect(store.getState().title).toBe('pressed');
    const hit = store.getState().titleHit;
    expect(hit).toBeGreaterThan(0);
    pressTitle(store);
    expect(store.getState().titleHit).toBe(hit);
    const ready = createShellStore({ title: 'on', screen: { name: 'home' } });
    pressTitle(ready);
    expect(ready.getState().title).toBe('leaving');
  });

  it("the landing's Play now marks its press (a first visit goes straight into Play now); a key doesn't", () => {
    const key = createShellStore({ title: 'on', screen: { name: 'boot' } });
    pressTitle(key);
    expect(key.getState().titlePlay).toBeFalsy();
    const play = createShellStore({ title: 'on', screen: { name: 'boot' } });
    pressTitle(play, true);
    expect(play.getState().titlePlay).toBe(true);
  });

  it('the press plays the war-tone hit', () => {
    const before = createShellStore({ screen: { name: 'home' } }).getState();
    expect(shellCues(before, { ...before, titleHit: 1234 })).toEqual(['sting.start']);
    expect(shellCues({ ...before, titleHit: 1234 }, { ...before, titleHit: 1234 })).toEqual([]);
  });
});

describe('the title screen: the corners and the prompt', () => {
  it('the prompt follows the input: a finger taps (phones and touch tablets), a keyboard presses a key (A-38)', () => {
    expect(promptKind(true, true)).toBe('tap');
    expect(promptKind(false, true)).toBe('tap');
    expect(promptKind(false, false)).toBe('key');
  });

  it('draws the lockup, one keyboard prompt (no pad line without a pad, no build id) and the art', () => {
    const html = renderToStaticMarkup(<TitleScreen store={createShellStore({ title: 'on', screen: { name: 'home' } })} />);
    expect(html).toContain('data-screen="title"');
    expect(html).toContain('Forged Force');
    // audit 31 Oct A-24: the key cap carries "Any key" once; A-39: the controller's line only with a pad connected
    expect(html).toMatch(/<span class="mf-title__press">Press<kbd class="kbd kbd--lg">Any key<\/kbd><\/span>/);
    // at full strength: a volt cue pulses under it (no fade to half)
    expect(html).toContain('<i class="mf-title__cue" aria-hidden="true"></i>');
    // the vector lockup with the game's name as its accessible name
    expect(html).toMatch(/<svg class="mf-lockup mf-title__mark"[^>]*role="img" aria-label="Forged Force"/);
    expect(html.match(/any key/gi)).toHaveLength(1);
    expect(html).not.toContain('controller');
    expect(html).not.toMatch(/\bbuild\b/i);
    // the Forge's key art (#185): AVIF first, WebP as the fallback, and the soldiers' parallax layer
    expect(html).toMatch(/<picture><source type="image\/avif" srcSet="[^"]*key-art-desktop\.avif"\/><img class="mf-title__art" src="[^"]*key-art-desktop\.webp"/);
    expect(html).toContain('key-art-desktop-fg.avif');
    // the old two-soldier loop is gone with its art: nothing to play
    expect(html).not.toContain('mf-title__fallback');
    expect(html).not.toContain('<video'); // the loop waits for the client to say it's welcome
    expect(renderToStaticMarkup(<TitleScreen store={createShellStore({ title: 'pressed', screen: { name: 'boot' } })} />)).toContain('Getting ready…');
    expect(renderToStaticMarkup(<TitleScreen store={createShellStore({ title: 'off' })} />)).toBe('');
  });
});

describe('the title screen: a finger, and the opening beat', () => {
  it('a phone gets "Tap to play" as one big plate', () => {
    const css = readFileSync(new URL('../src/shell/screens/title.css', import.meta.url), 'utf8');
    expect(css).toMatch(/\.mf-title__press--plate \{[^}]*background: var\(--c-volt\)/);
    expect(css).not.toMatch(/mf-title-breath/);
  });

  it('the title joins the landing\'s beat where it is, never starts it again, and never under Reduce motion', () => {
    expect(introElapsed(1300, 1000, false)).toBe(300);
    expect(introElapsed(1000 + INTRO_MS, 1000, false)).toBeNull();
    expect(introElapsed(1300, 1000, true)).toBeNull();
    expect(introElapsed(1300, undefined, false)).toBeNull();
    expect(introElapsed(900, 1000, false)).toBeNull();
  });
});
