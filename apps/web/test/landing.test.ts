/** The landing (index.html, ui/landing.ts) and the crawl files (seo.ts): docs/seo.md. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { seoFiles } from '../seo';
import { landingOwns, onPlay, releaseLanding } from '../src/ui/landing';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const html = read('../index.html');
const all = (re: RegExp) => [...html.matchAll(re)];

describe('the landing page (index.html)', () => {
  it('has one h1 (the name), a title, a description of a useful length, a canonical and link previews', () => {
    expect(all(/<h1\b/g)).toHaveLength(1);
    expect(html).toMatch(/<h1[^>]*>[\s\S]*%GAME_NAME%[\s\S]*<\/h1>/);
    const description = /<meta name="description" content="([^"]+)"/.exec(html)![1]!.replace('%GAME_NAME%', 'Military Forge');
    expect(description.length).toBeGreaterThan(70);
    expect(description.length).toBeLessThanOrEqual(170);
    for (const tag of ['<link rel="canonical" href="%ORIGIN%/"', 'property="og:image" content="%ORIGIN%/og-image.jpg"', 'name="twitter:card" content="summary_large_image"', '<link rel="manifest"', 'name="theme-color"', 'viewport-fit=cover']) {
      expect(html, tag).toContain(tag);
    }
    expect(html).toContain('<html lang="en">');
  });

  it('describes the game for search engines: JSON-LD VideoGame, WebSite and Organization', () => {
    const raw = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html)![1]!;
    const data = JSON.parse(raw.replaceAll('%GAME_NAME%', 'Military Forge').replaceAll('%ORIGIN%', 'https://example.test')) as { '@graph': { '@type': string; name?: string; offers?: { price: string } }[] };
    const types = data['@graph'].map((n) => n['@type']);
    expect(types).toEqual(['VideoGame', 'WebSite', 'Organization']);
    expect(data['@graph'][0]!.name).toBe('Military Forge');
    expect(data['@graph'][0]!.offers!.price).toBe('0');
  });

  it('every picture has alt text, every id is unique, and the dialog is labelled', () => {
    for (const [img] of all(/<img\b[^>]*>/g)) expect(img, img).toMatch(/\salt="/);
    const ids = all(/\sid="([^"]+)"/g).map((m) => m[1]);
    expect(new Set(ids).size).toBe(ids.length);
    expect(html).toMatch(/id="about"[^>]*role="dialog"[^>]*aria-labelledby="about-h"/);
    expect(html).toContain('id="about-h"');
    // the game's name lives in packages/shared/src/brand.ts only
    expect(html).not.toMatch(/Military Forge/);
  });

  it('its links take taps while the game loads, and it never shows through the app once that is up (26 Oct: no blank page)', () => {
    // the game's canvases come later in the page: until the app is up, the foot is above them
    expect(html).toMatch(/html:not\(\.mf-app\) \.mf-land__foot \{ z-index: 1; \}/);
    expect(html.indexOf('id="land-foot"')).toBeLessThan(html.indexOf('<canvas id="view3d"'));
    // once it's up, the foot (Play now, About, the loading line) stops painting; its words stay in the page
    expect(html).toMatch(/html\.mf-app #land-foot \{ visibility: hidden; \}/);
  });

  it("the game's code not loading says so and offers Try again, never \"Loading\" forever", () => {
    const boot = read('../public/boot.js');
    const entry = read('../src/boot.ts');
    expect(entry).toMatch(/import\('\.\/main'\)\.catch\(/);
    expect(entry).toContain("new Event('mf:boot-failed')");
    expect(boot).toContain("addEventListener('mf:boot-failed', bootFailed)");
    expect(boot).toContain('location.reload()');
    // the landing's and the loading screen's Try again, hidden until then
    expect(all(/<button type="button" class="btn btn--volt[^"]*mf-land__retry" hidden>Try again<\/button>/g)).toHaveLength(2);
    expect(html).toContain('id="boot-fail"');
  });

  it("draws with the title screen's own classes, so the title takes over without a seam", () => {
    const titleCss = read('../src/shell/screens/title.css');
    for (const cls of ['mf-title__world', 'mf-title__art', 'mf-title__fg', 'mf-title__smoke--a', 'mf-title__sweep', 'mf-title__vignette', 'mf-title__lockup', 'mf-title__name', 'mf-title__emblem', 'mf-title__sub']) {
      expect(html, cls).toContain(cls);
      expect(titleCss, cls).toContain(`.${cls}`);
    }
  });
});

describe('the crawl and install files (seo.ts)', () => {
  const files = seoFiles('Military Forge', '2026-10-23');
  it('a web app manifest that installs the game sideways, with icons', () => {
    const m = JSON.parse(files['manifest.webmanifest']) as { name: string; orientation: string; start_url: string; icons: { sizes: string; purpose: string }[] };
    expect(m.name).toBe('Military Forge');
    expect(m.orientation).toBe('landscape');
    expect(m.start_url).toBe('/');
    expect(m.icons.map((i) => `${i.sizes} ${i.purpose}`)).toEqual(expect.arrayContaining(['192x192 any', '512x512 any', '512x512 maskable']));
  });
  it('robots.txt points at the sitemap and keeps the API out; the sitemap lists the home page', () => {
    expect(files['robots.txt']).toContain('Sitemap: %ORIGIN%/sitemap.xml');
    expect(files['robots.txt']).toContain('Disallow: /api/');
    expect(files['robots.txt']).not.toContain('Disallow: /r/'); // rooms must be crawled to see their noindex
    expect(files['sitemap.xml']).toContain('<loc>%ORIGIN%/</loc><lastmod>2026-10-23</lastmod>');
  });
});

describe('the landing under the app (ui/landing.ts)', () => {
  function fakeDoc(classes: string[] = []) {
    const cls = new Set(classes);
    const attrs = new Map<string, string>();
    const inert: string[] = [];
    const doc = {
      documentElement: {
        classList: { contains: (c: string) => cls.has(c), add: (c: string) => void cls.add(c) },
        getAttribute: (k: string) => attrs.get(k) ?? null,
        setAttribute: (k: string, v: string) => void attrs.set(k, v),
        removeAttribute: (k: string) => void attrs.delete(k),
      },
      getElementById: (id: string) => ({ setAttribute: (k: string) => k === 'inert' && inert.push(id) }),
    };
    return { doc: doc as unknown as Document, cls, attrs, inert };
  }
  const el = (match: boolean) => ({ closest: () => (match ? {} : null) }) as unknown as Element;

  it('goes inert under the app once it has its first screen, the About sheet still reachable', () => {
    const f = fakeDoc();
    releaseLanding(f.doc);
    expect(f.cls.has('mf-app')).toBe(true);
    expect(f.inert).toEqual(['land-hero', 'land-foot']);
  });

  it('keeps the title away from the sheet and the links into it', () => {
    expect(landingOwns(el(true), fakeDoc().doc)).toBe(true);
    expect(landingOwns(el(false), fakeDoc().doc)).toBe(false);
    expect(landingOwns(el(false), fakeDoc(['mf-about-open']).doc)).toBe(true);
    expect(landingOwns(null, fakeDoc().doc)).toBe(false);
  });

  it('Play now pressed early is taken once the title is ready; a later press arrives as an event', () => {
    const f = fakeDoc();
    const win = Object.assign(new EventTarget(), { document: f.doc }) as unknown as Window;
    let plays = 0;
    f.attrs.set('data-play', '1');
    const stop = onPlay(() => plays++, win);
    expect(plays).toBe(1);
    expect(f.attrs.has('data-play')).toBe(false);
    win.dispatchEvent(new Event('mf:play')); // no flag: not a press
    expect(plays).toBe(1);
    f.attrs.set('data-play', '1');
    win.dispatchEvent(new Event('mf:play'));
    expect(plays).toBe(2);
    stop();
    f.attrs.set('data-play', '1');
    win.dispatchEvent(new Event('mf:play'));
    expect(plays).toBe(2);
  });
});
