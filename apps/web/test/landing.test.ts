/** The landing (index.html, ui/landing.ts) and the crawl files (seo.ts): docs/seo.md. */
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { seoFiles } from '../seo';
import { afterFirstPaint } from '../src/ui/firstPaint';
import { landingOwns, onPlay, releaseLanding } from '../src/ui/landing';
import { LOCKUP_PICTURE, lockupPictureMarkup } from '../src/ui/lockupImage';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const html = read('../index.html');
const all = (re: RegExp) => [...html.matchAll(re)];

describe('the landing page (index.html)', () => {
  it('has one h1 (the name), a title, a description of a useful length, a canonical and link previews', () => {
    expect(all(/<h1\b/g)).toHaveLength(1);
    expect(html).toMatch(/<h1[^>]*>[\s\S]*%GAME_NAME%[\s\S]*<\/h1>/);
    const description = /<meta name="description" content="([^"]+)"/.exec(html)![1]!.replace('%GAME_NAME%', 'Forged Force');
    expect(description.length).toBeGreaterThan(70);
    expect(description.length).toBeLessThanOrEqual(170);
    for (const tag of ['<link rel="canonical" href="%ORIGIN%/"', 'property="og:image" content="%ORIGIN%/og-image.jpg"', 'name="twitter:card" content="summary_large_image"', '<link rel="manifest"', 'name="theme-color"', 'viewport-fit=cover']) {
      expect(html, tag).toContain(tag);
    }
    expect(html).toContain('<html lang="en">');
  });

  it('describes the game for search engines: JSON-LD VideoGame, WebSite and Organization', () => {
    const raw = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html)![1]!;
    const data = JSON.parse(raw.replaceAll('%GAME_NAME%', 'Forged Force').replaceAll('%ORIGIN%', 'https://example.test')) as { '@graph': { '@type': string; name?: string; offers?: { price: string } }[] };
    const types = data['@graph'].map((n) => n['@type']);
    expect(types).toEqual(['VideoGame', 'WebSite', 'Organization']);
    expect(data['@graph'][0]!.name).toBe('Forged Force');
    expect(data['@graph'][0]!.offers!.price).toBe('0');
  });

  it('every picture has alt text, every id is unique, and the dialog is labelled', () => {
    for (const [img] of all(/<img\b[^>]*>/g)) expect(img, img).toMatch(/\salt="/);
    const ids = all(/\sid="([^"]+)"/g).map((m) => m[1]);
    expect(new Set(ids).size).toBe(ids.length);
    expect(html).toMatch(/id="about"[^>]*role="dialog"[^>]*aria-labelledby="about-h"/);
    expect(html).toContain('id="about-h"');
    // the game's name lives in packages/shared/src/brand.ts only
    expect(html).not.toMatch(/Forged Force/);
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
    for (const cls of ['mf-title__world', 'mf-title__art', 'mf-title__fg', 'mf-title__smoke--a', 'mf-title__sweep', 'mf-title__vignette', 'mf-title__lockup', 'mf-title__name', 'mf-title__word', 'mf-title__sub']) {
      expect(html, cls).toContain(cls);
      expect(titleCss, cls).toContain(`.${cls}`);
    }
    // the lockup is the title's own art, filled in at build time (vite.config.ts) as a picture of the pipeline's
    // colour file (ui/lockupImage.ts), so it needs no stylesheet of its own
    expect(html).toMatch(/<h1 class="mf-title__name">%LOCKUP%<span class="mf-title__word">%GAME_NAME%<\/span><\/h1>/);
    expect(html).not.toContain('/src/ui/lockup.css');
    expect(read('../vite.config.ts')).toMatch(/lockupPictureMarkup\(\s*readFileSync\([^)]*'\.\/public\/art\/brand\/forged-force-lockup-1000\.avif'[\s\S]*?'\/art\/brand\/forged-force-lockup-1000\.webp',\s*'mf-title__mark',\s*'landing-lockup',\s*\)/);
    expect(titleCss).toMatch(/\.mf-title__mark \{[^}]*height: auto;/);
  });

  it('the first frame: a big volt Play now with the plain facts under it, and the opening beat', () => {
    expect(html).toMatch(/<a id="land-play" class="btn btn--volt mf-land__play" href="#play">[\s\S]*?Play now<\/a>\s*<\/div>\s*<p class="mf-land__free">Free · no download · phone or PC<\/p>/);
    expect(html).toContain('class="mf-title mf-land__hero has-art is-intro"');
    const boot = read('../public/boot.js');
    // the beat starts only on the landing and never under Reduce motion; the title joins in from its start
    expect(boot).toMatch(/if \(!roomish && !reduce\) \{\s*root\.classList\.add\('mf-intro'\);\s*window\.__mfIntroAt = performance\.now\(\);/);
    const titleCss = read('../src/shell/screens/title.css');
    expect(titleCss).toMatch(/html\.reduce-motion \.mf-title :is\([^)]*\.mf-title__art[^)]*\.mf-title__lockup[^)]*\) \{ animation: none !important; \}/);
  });
});

describe('the first screen paints at once (first screen audit, 1 Nov 2026)', () => {
  const titleCss = read('../src/shell/screens/title.css');
  const keyframes = (name: string) => new RegExp(`@keyframes ${name} \\{((?:[^{}]*\\{[^}]*\\})*)\\s*\\}`).exec(titleCss)?.[1];

  it('the opening beat moves what is already there: none of its keyframes hides the art or the lockup', () => {
    const used = [...titleCss.matchAll(/html\.mf-intro [^{]*\{ animation(?:-name)?: ([\w-]+)/g)].map((m) => m[1]!).filter((n) => n !== 'none');
    expect(used).toEqual(expect.arrayContaining(['mf-title-push', 'mf-title-slam', 'mf-title-push-phone']));
    for (const name of new Set(used)) {
      const body = keyframes(name);
      expect(body, name).toBeDefined();
      expect(body, name).not.toMatch(/opacity:\s*0(\.0*)?\s*[;}]|visibility:\s*hidden|display:\s*none/);
      // never pushed off screen either
      expect(body, name).not.toMatch(/translate/);
    }
  });

  it("the lockup is a picture in the first frame (a page's largest paint counts pictures and text, never inline SVG paths)", () => {
    const pic = lockupPictureMarkup('QUJD', '/art/brand/x.webp', 'mf-title__mark', 'landing-lockup');
    expect(pic).toBe(
      '<picture><source type="image/avif" srcset="data:image/avif;base64,QUJD" />' +
        '<img class="mf-title__mark" src="/art/brand/x.webp" width="1000" height="504" alt="" elementtiming="landing-lockup" fetchpriority="high" draggable="false" /></picture>',
    );
    // the picture is the vector file's shape (its viewBox), small enough to go inline, and drawn in the kit's colours
    const file = read('../public/art/brand/forged-force-lockup.svg');
    const [, , w, h] = /viewBox="([-\d.]+) ([-\d.]+) ([\d.]+) ([\d.]+)"/.exec(file)!.slice(1).map(Number);
    expect(LOCKUP_PICTURE.width / LOCKUP_PICTURE.height).toBeCloseTo(w! / h!, 1);
    const avif = readFileSync(new URL('../public/art/brand/forged-force-lockup-1000.avif', import.meta.url));
    expect(avif.subarray(4, 12).toString('latin1')).toBe('ftypavif');
    expect(avif.length).toBeLessThan(24 * 1024);
    expect(readFileSync(new URL('../public/art/brand/forged-force-lockup-1000.webp', import.meta.url)).subarray(8, 12).toString('latin1')).toBe('WEBP');
    for (const colour of ['#070806', '#d6ff3b', '#0e100b', '#f2eedf']) expect(file).toContain(colour);
  });

  it("the game's chunk waits for the landing's first frame, and the About sheet's screens wait for the sheet", () => {
    const entry = read('../src/boot.ts');
    expect(entry).toMatch(/afterFirstPaint\(landing \? 'landing-lockup' : null\)\.then\(/);
    expect(entry).toContain("classList.contains('mf-boot-landing')");
    // the hero's decorative layers wait for that frame; without scripts they show at once
    expect(entry).toMatch(/\.then\(\(\) => \{\s*(?:\/\/[^\n]*\s*)?document\.documentElement\.classList\.add\('mf-painted'\);\s*return import\('\.\/main'\)/);
    expect(html).toContain('@media (scripting: enabled) { html:not(.mf-painted) .mf-land__hero :is(.mf-title__fg, .mf-title__sweep, .mf-title__smoke) { visibility: hidden; opacity: 0; } }');
    expect(html).toMatch(/html:not\(\.mf-about-seen\) \.mf-about:not\(:target\) \.mf-about__shots \{ display: none; \}/);
    expect(read('../public/boot.js')).toContain("root.classList.add('mf-about-open', 'mf-about-seen');");
  });
});

describe('afterFirstPaint (ui/firstPaint.ts)', () => {
  type Entry = { name: string; identifier?: string };
  type Cb = (list: { getEntries: () => Entry[] }) => void;
  const realPO = globalThis.PerformanceObserver;
  const realPerf = globalThis.performance;
  function stub(painted: string[], supported = ['paint', 'element']) {
    const observers: { cb: Cb; disconnected: boolean; opts?: unknown }[] = [];
    class FakePO {
      static supportedEntryTypes = supported;
      o: (typeof observers)[number];
      constructor(cb: Cb) {
        this.o = { cb, disconnected: false };
        observers.push(this.o);
      }
      observe(opts: unknown) {
        this.o.opts = opts;
      }
      disconnect() {
        this.o.disconnected = true;
      }
    }
    Object.assign(globalThis, { PerformanceObserver: FakePO, performance: { getEntriesByType: () => painted.map((name) => ({ name })) } });
    return observers;
  }
  const flush = () => new Promise<void>((r) => queueMicrotask(r));
  afterEach(() => {
    Object.assign(globalThis, { PerformanceObserver: realPO, performance: realPerf });
    vi.useRealTimers();
  });

  it('waits for the named picture on screen, not for the first words', async () => {
    vi.useFakeTimers();
    const observers = stub(['first-paint', 'first-contentful-paint']);
    let done = false;
    void afterFirstPaint('landing-lockup').then(() => (done = true));
    expect(observers[0]!.opts).toEqual({ type: 'element', buffered: true });
    observers[0]!.cb({ getEntries: () => [{ name: 'image-paint', identifier: 'something-else' }] });
    await flush();
    expect(done).toBe(false);
    observers[0]!.cb({ getEntries: () => [{ name: 'image-paint', identifier: 'landing-lockup' }] });
    await flush();
    expect(done).toBe(true);
    expect(observers[0]!.disconnected).toBe(true);
  });

  it('without a picture (or element timing): the first contentful paint, not a plain first paint', async () => {
    vi.useFakeTimers();
    for (const [element, supported] of [[null, ['paint', 'element']], ['landing-lockup', ['paint']]] as const) {
      const observers = stub([], [...supported]);
      let done = false;
      void afterFirstPaint(element).then(() => (done = true));
      expect(observers[0]!.opts).toEqual({ type: 'paint', buffered: true });
      observers[0]!.cb({ getEntries: () => [{ name: 'first-paint' }] });
      await flush();
      expect(done).toBe(false);
      observers[0]!.cb({ getEntries: () => [{ name: 'first-contentful-paint' }] });
      await flush();
      expect(done).toBe(true);
    }
  });

  it('at once when the frame is already painted, and after the cap when it never comes (a background tab)', async () => {
    vi.useFakeTimers();
    stub(['first-paint', 'first-contentful-paint']);
    await expect(afterFirstPaint(null, 2500)).resolves.toBeUndefined();
    const observers = stub([]);
    let done = false;
    void afterFirstPaint('landing-lockup', 2500).then(() => (done = true));
    await vi.advanceTimersByTimeAsync(2499);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(done).toBe(true);
    expect(observers[0]!.disconnected).toBe(true);
  });
});

describe('the crawl and install files (seo.ts)', () => {
  const files = seoFiles('Forged Force', { '/': '2026-10-23', '/terms.html': '2026-10-28' });
  it('a web app manifest that installs the game sideways, with icons and a short name that fits under the icon (audit 28 Oct)', () => {
    const m = JSON.parse(files['manifest.webmanifest']) as { name: string; short_name: string; orientation: string; start_url: string; icons: { sizes: string; purpose: string }[] };
    expect(m.name).toBe('Forged Force');
    expect(m.short_name).toBe('Forge');
    expect(m.short_name.length).toBeLessThanOrEqual(12);
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
  it('the sitemap lists only pages with words in their HTML, each dated by its own last change or not at all (audit 28 Oct)', () => {
    const sitemap = files['sitemap.xml'];
    expect([...sitemap.matchAll(/<loc>%ORIGIN%([^<]*)<\/loc>/g)].map((m) => m[1])).toEqual(['/', '/privacy.html', '/terms.html']);
    // script-only pages and the unfinished official links stay out
    for (const page of ['armory.html', 'gamepad.html', 'official.html']) expect(sitemap).not.toContain(page);
    expect(sitemap).toContain('<loc>%ORIGIN%/terms.html</loc><lastmod>2026-10-28</lastmod>');
    expect(sitemap).toContain('<url><loc>%ORIGIN%/privacy.html</loc></url>');
  });
  it('llms.txt: a title, a one-line summary and absolute links to the pages', () => {
    const llms = files['llms.txt'];
    expect(llms.startsWith('# Forged Force\n\n> ')).toBe(true);
    expect(llms).toContain('](%ORIGIN%/privacy.html)');
    expect(llms).not.toMatch(/\u2014/); // no em dashes
  });
});

describe('the text pages (privacy.html, terms.html, official.html)', () => {
  const pages = ['privacy', 'terms', 'official'].map((p) => [p, read(`../${p}.html`)] as const);
  it("show no unfinished markers, say Brass (the store's currency), and don't wait for the game's kit to draw (audit 28 Oct)", () => {
    for (const [p, page] of pages) {
      const shown = page.replace(/<!--[\s\S]*?-->/g, '');
      expect(shown, p).not.toMatch(/TODO|Draft|\bGems?\b/);
      expect(shown, p).not.toMatch(/\u2014/);
      expect(page, p).not.toContain('kit.css');
      expect(page, p).toContain('<link rel="stylesheet" href="/src/ui/legal.css" />');
    }
  });
  it('each has one h1, an icon, a canonical and link previews, and links back to the game and its About', () => {
    for (const [p, page] of pages) {
      expect([...page.matchAll(/<h1\b/g)], p).toHaveLength(1);
      expect(page, p).toContain('<link rel="icon" href="/favicon.svg"');
      expect(page, p).toContain(`<link rel="canonical" href="%ORIGIN%/${p}.html" />`);
      expect(page, p).toContain('property="og:image" content="%ORIGIN%/og-image.jpg"');
      expect(page, p).toContain('<a href="/#about">About the game</a>');
    }
  });
  it('the official links stay out of search until the owner lists the accounts', () => {
    expect(read('../official.html')).toContain('<meta name="robots" content="noindex, follow" />');
  });
  it('the privacy note says what the code does (the legal review, 29 Oct): no blanket IP promise, no guest clean-up that never runs, the processors named', () => {
    const privacy = read('../privacy.html').replace(/<!--[\s\S]*?-->/g, '');
    expect(privacy).not.toMatch(/never keep your IP address/);
    expect(privacy).not.toMatch(/guest player nobody has used/i);
    expect(privacy).not.toMatch(/never sell or share your data/);
    for (const fact of ['90 days', '13 months', 'Problem reports</b>: 7 days', 'last 7 are kept', 'Flutterwave', 'Resend', 'Cloudflare Turnstile', 'Microsoft Azure', 'never recorded', 'Also delete my player']) expect(privacy).toContain(fact);
  });
  it('the privacy note says where the bot check can appear and how long sign-ins and emailed links are kept (bot check, 30 Oct)', () => {
    const privacy = read('../privacy.html').replace(/<!--[\s\S]*?-->/g, '');
    for (const where of ['save an account', 'Forgot password', 'sign in after several wrong passwords', 'send a problem report', 'its own problem report']) expect(privacy).toContain(where);
    expect(privacy).toContain("a device's sign-in is deleted 7 days after it ends");
    expect(privacy).toContain('deleted 7 days after they are used or run out');
    expect(privacy).not.toContain('—');
  });
  it('the terms match the store: a 14-day refund of unspent Brass', () => {
    const terms = read('../terms.html');
    expect(terms).toMatch(/14 days/);
    expect(terms).toMatch(/still unspent/);
    expect(terms).not.toMatch(/Purchases are final unless/);
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
