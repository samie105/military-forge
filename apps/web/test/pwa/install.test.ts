import { describe, expect, it } from 'vitest';
import { serviceWorkerSource } from '../../pwa';
import { AGAIN_AFTER_SESSIONS, freshMemory, isIosSafari, launchedInstalled, loadInstallMemory, saveInstallMemory, shouldOffer, type InstallMemory } from '../../src/pwa/install';

const ctx = (p: Partial<Parameters<typeof shouldOffer>[1]> = {}) => ({ kind: 'prompt' as const, installed: false, matchesFinished: 1, shownThisSession: false, ...p });
const mem = (p: Partial<InstallMemory> = {}) => ({ ...freshMemory(), sessions: 1, ...p });

describe('the install toast: when it may show', () => {
  it('first after a finished match (iPhone Safari: on the first Home visit), only where the browser can install us, never once installed', () => {
    expect(shouldOffer(mem(), ctx({ matchesFinished: 0 }))).toBe(false);
    expect(shouldOffer(mem(), ctx())).toBe(true);
    expect(shouldOffer(mem(), ctx({ kind: null }))).toBe(false);
    expect(shouldOffer(mem(), ctx({ kind: 'ios' }))).toBe(true);
    // iPhone Safari: from the first Home visit, before any match (only a home-screen launch drops the bars)
    expect(shouldOffer(mem(), ctx({ kind: 'ios', matchesFinished: 0 }))).toBe(true);
    expect(shouldOffer(mem({ dismissedAt: 1 }), ctx({ kind: 'ios', matchesFinished: 0 }))).toBe(false);
    expect(shouldOffer(mem(), ctx({ installed: true }))).toBe(false);
    expect(shouldOffer(mem({ accepted: true }), ctx())).toBe(false);
    expect(shouldOffer(mem(), ctx({ shownThisSession: true }))).toBe(false);
  });

  it('after Not now: again every 3rd session, or after another match; never twice a session', () => {
    const said = mem({ sessions: 4, dismissedAt: 4, matchesAtDismiss: 2 });
    expect(shouldOffer(said, ctx({ matchesFinished: 2 }))).toBe(false);
    expect(shouldOffer({ ...said, sessions: 4 + AGAIN_AFTER_SESSIONS - 1 }, ctx({ matchesFinished: 2 }))).toBe(false);
    expect(shouldOffer({ ...said, sessions: 4 + AGAIN_AFTER_SESSIONS }, ctx({ matchesFinished: 2 }))).toBe(true);
    expect(shouldOffer(said, ctx({ matchesFinished: 3 }))).toBe(true);
    expect(shouldOffer(said, ctx({ matchesFinished: 3, shownThisSession: true }))).toBe(false);
  });

  it('iPhone and iPad Safari get the guide; Chrome or an in-app browser on iOS don’t', () => {
    const iphone = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
    expect(isIosSafari(iphone)).toBe(true);
    expect(isIosSafari(iphone.replace('Version/17.5', 'CriOS/130.0'))).toBe(false);
    expect(isIosSafari(`${iphone} Instagram 300.0`)).toBe(false);
    expect(isIosSafari('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15', 5, 'MacIntel')).toBe(true); // iPadOS
    expect(isIosSafari('Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/26.0 Chrome/122.0 Mobile Safari/537.36')).toBe(false);
  });

  it('installed: launched in full screen or standalone, or an iOS home-screen app', () => {
    expect(launchedInstalled((q) => q === '(display-mode: fullscreen)')).toBe(true);
    expect(launchedInstalled(() => false, true)).toBe(true);
    expect(launchedInstalled(() => false)).toBe(false);
  });

  it('its memory round-trips and survives junk', () => {
    const data: Record<string, string> = {};
    const store = { getItem: (k: string) => data[k] ?? null, setItem: (k: string, v: string) => void (data[k] = v) };
    saveInstallMemory(store, mem({ sessions: 7, dismissedAt: 5, matchesAtDismiss: 2 }));
    expect(loadInstallMemory(store)).toEqual({ sessions: 7, dismissedAt: 5, matchesAtDismiss: 2, accepted: false });
    data['mf.install.v1'] = '{"sessions":"x","dismissedAt":"y"}';
    expect(loadInstallMemory(store)).toEqual(freshMemory());
  });
});

describe('the service worker', () => {
  const src = serviceWorkerSource('20261023-abc');
  it('is this build’s (a deploy is a new worker), and waits to be told to take over', () => {
    expect(src).toContain('"20261023-abc"');
    expect(src).not.toMatch(/skipWaiting\(\)\s*;?\s*\n\s*\}\);\s*\n\s*self\.addEventListener\('activate'/);
    expect(src).toMatch(/if \(event\.data === 'activate'\) self\.skipWaiting\(\)/);
  });
  it('never touches the API, the game sockets or the admin page; caches hashed bundles only, pages network-first', () => {
    const NEVER = new RegExp(/const NEVER = \/(.+)\/;/.exec(src)![1]!.replace(/\\\\/g, '\\'));
    for (const p of ['/api/rooms', '/ws/ABCD', '/admin', '/admin.html', '/sw.js']) expect(NEVER.test(p), p).toBe(true);
    for (const p of ['/', '/r/ABCD', '/assets/index-Ab12Cd34.js', '/art/key-art/key-art-phone.avif']) expect(NEVER.test(p), p).toBe(false);
    const HASHED = new RegExp(/const IS_HASHED = \/(.+)\/;/.exec(src)![1]!.replace(/\\\\/g, '\\'));
    expect(HASHED.test('/assets/index-Ab12Cd34.js')).toBe(true);
    expect(HASHED.test('/assets/art/soldier.glb')).toBe(false);
    expect(src).toMatch(/request\.mode === 'navigate'\) event\.respondWith\(networkFirst/);
  });
});
