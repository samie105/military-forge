import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { shellCues } from '../src/audio/ui';
import { TitleScreen, pressTitle } from '../src/shell/screens/Title';
import { createShellStore } from '../src/shell/store';
import { continuesTitle, regionLabel, titleWanted } from '../src/shell/title';

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

  it('the press plays the war-tone hit', () => {
    const before = createShellStore({ screen: { name: 'home' } }).getState();
    expect(shellCues(before, { ...before, titleHit: 1234 })).toEqual(['sting.start']);
    expect(shellCues({ ...before, titleHit: 1234 }, { ...before, titleHit: 1234 })).toEqual([]);
  });
});

describe('the title screen: the corners and the prompt', () => {
  it("names the server's region: the box's probe config, this computer in dev, else the host", () => {
    expect(regionLabel('40-123-240-224.sslip.io', { regions: [{ name: 'Johannesburg' }] })).toBe('Johannesburg');
    expect(regionLabel('localhost', null)).toBe('This computer');
    expect(regionLabel('127.0.0.1', null)).toBe('This computer');
    expect(regionLabel('play.example.org', {})).toBe('play.example.org');
  });

  it('draws the lockup, the desktop prompt, the build and the fallback art', () => {
    const html = renderToStaticMarkup(<TitleScreen store={createShellStore({ title: 'on', screen: { name: 'home' } })} />);
    expect(html).toContain('data-screen="title"');
    expect(html).toContain('Military Forge');
    expect(html).toContain('Press any key · click');
    expect(html).toContain('or any controller button');
    expect(html).toMatch(/build [0-9a-f]{7,}|build dev/);
    // the Forge's key art (#185): AVIF first, WebP as the fallback, and the soldiers' parallax layer
    expect(html).toMatch(/<picture><source type="image\/avif" srcSet="[^"]*key-art-desktop\.avif"\/><img class="mf-title__art" src="[^"]*key-art-desktop\.webp"/);
    expect(html).toContain('key-art-desktop-fg.avif');
    expect(html).not.toContain('mf-title__fallback');
    expect(html).not.toContain('<video'); // the loop waits for the client to say it's welcome
    expect(renderToStaticMarkup(<TitleScreen store={createShellStore({ title: 'pressed', screen: { name: 'boot' } })} />)).toContain('Getting ready…');
    expect(renderToStaticMarkup(<TitleScreen store={createShellStore({ title: 'off' })} />)).toBe('');
  });
});
