/**
 * Readable everywhere (UX-90, UX-91, UX-95, UX-96): which layouts each window wears (ui/landscape.ts
 * layoutTier), the zoom it draws them at (ui/fit.ts), and what the kit's size tokens then render at
 * (ui/kit.css READABLE FLOORS). The floors are read from kit.css itself and worked out at each
 * viewport's zoom, so a token edit that lets text under 12 px or a touch target under 44 px back in
 * fails here.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MENU_MIN_FIT, TABLET_MAX_FIT, menuFit, phoneFit } from '../src/ui/fit';
import { TIER_QUERIES, isPhoneShape, isRotated, layoutTier, usesPhoneLayouts, viewport, type LayoutTier } from '../src/ui/landscape';

const SRC = fileURLToPath(new URL('../src', import.meta.url));
const KIT = readFileSync(join(SRC, 'ui', 'kit.css'), 'utf8');

afterEach(() => vi.unstubAllGlobals());

/** A small media-query evaluator for the queries the tiers are made of (and, or a comma list). */
function evaluate(query: string, w: number, h: number, coarse: boolean): boolean {
  return query.split(',').some((part) =>
    part
      .trim()
      .split(/\s+and\s+/)
      .every((feature) => {
        const m = /^\(\s*([a-z-]+)\s*:\s*([a-z0-9]+)\s*\)$/.exec(feature.trim());
        if (!m) throw new Error(`a query this test can't read: ${feature}`);
        const [, name, value] = m;
        const px = parseFloat(value!);
        switch (name) {
          case 'orientation':
            return value === (w > h ? 'landscape' : 'portrait');
          case 'pointer':
            return value === (coarse ? 'coarse' : 'fine');
          case 'max-width':
            return w <= px;
          case 'min-width':
            return w >= px;
          case 'max-height':
            return h <= px;
          case 'min-height':
            return h >= px;
          default:
            throw new Error(`a feature this test can't read: ${name}`);
        }
      }),
  );
}

/** A window for the matchMedia the tiers read: its CSS size and its pointer. */
function windowOf(w: number, h: number, coarse: boolean): void {
  vi.stubGlobal('matchMedia', (q: string) => ({ matches: evaluate(q, w, h, coarse), addEventListener: () => {}, removeEventListener: () => {} }));
}

/** The atlas's viewports (apps/web/scripts/screen-atlas.mjs) and a few more. */
const VIEWPORTS: { id: string; w: number; h: number; coarse: boolean; tier: LayoutTier }[] = [
  { id: 'd1920', w: 1920, h: 1080, coarse: false, tier: 'desktop' },
  { id: 'd1440', w: 1440, h: 900, coarse: false, tier: 'desktop' },
  { id: 'd1280', w: 1280, h: 800, coarse: false, tier: 'desktop' },
  { id: 'd1366 (768 high, browser bars)', w: 1366, h: 657, coarse: false, tier: 'desktop' },
  { id: 'a laptop at 200 % zoom', w: 640, h: 360, coarse: false, tier: 'short' },
  { id: 'a laptop at 175 % zoom', w: 823, h: 457, coarse: false, tier: 'short' },
  { id: 't1024', w: 1024, h: 768, coarse: true, tier: 'tablet' },
  { id: 't768', w: 768, h: 1024, coarse: true, tier: 'tablet' },
  { id: 'android tablet 1280×800', w: 1280, h: 800, coarse: true, tier: 'tablet' },
  { id: 'iPad Pro 12.9', w: 1366, h: 1024, coarse: true, tier: 'tablet' },
  { id: 'pl844', w: 844, h: 390, coarse: true, tier: 'phone' },
  { id: 'pl667', w: 667, h: 375, coarse: true, tier: 'phone' },
  { id: 'pu390', w: 390, h: 844, coarse: true, tier: 'phone' },
  { id: 'pu360', w: 360, h: 740, coarse: true, tier: 'phone' },
];

describe('the layout tier', () => {
  it('tablets and short windows wear the phone layouts; phones still turn when upright; tablets never turn', () => {
    for (const v of VIEWPORTS) {
      windowOf(v.w, v.h, v.coarse);
      expect(layoutTier(), v.id).toBe(v.tier);
      expect(usesPhoneLayouts(), v.id).toBe(v.tier !== 'desktop');
      expect(isPhoneShape(), v.id).toBe(v.tier === 'phone'); // full screen and the lock: phones only
      expect(isRotated(), v.id).toBe(v.tier === 'phone' && v.h > v.w);
    }
  });

  it('every tier query is one the app listens to (a tablet turned or a window resized re-tiers it)', () => {
    expect(TIER_QUERIES).toHaveLength(4);
    for (const q of TIER_QUERIES) expect(() => evaluate(q, 1024, 768, true)).not.toThrow();
  });
});

/** The zoom a viewport's menus draw at: the phone layouts' fit, or the desktop menus'. */
function menuZoom(v: (typeof VIEWPORTS)[number]): number {
  windowOf(v.w, v.h, v.coarse);
  const { w, h } = viewport(isRotated(), v.w, v.h);
  const zoom = v.tier === 'desktop' ? menuFit(w, h).fit : phoneFit(w, h, v.tier).fit;
  vi.unstubAllGlobals();
  return zoom;
}

describe('the phone layouts on a tablet', () => {
  it('scale up to TABLET_MAX_FIT, no further (thumb-sized, never poster-sized)', () => {
    expect(phoneFit(1024, 768, 'tablet').fit).toBeCloseTo(1024 / 812, 6); // 1.26: 812×609 design pixels
    expect(phoneFit(1280, 800, 'tablet').fit).toBe(TABLET_MAX_FIT);
    expect(phoneFit(1366, 1024, 'tablet').fit).toBe(TABLET_MAX_FIT);
    expect(phoneFit(1366, 1024, 'tablet').w).toBeCloseTo(1366 / 1.5, 6);
    expect(phoneFit(932, 430, 'phone').fit).toBeCloseTo(430 / 375, 6); // a phone is never capped
  });

  it('a tablet draws its menus far bigger than the desktop menus did (0.48–0.64 before)', () => {
    for (const v of VIEWPORTS.filter((x) => x.tier === 'tablet')) {
      expect(menuZoom(v), v.id).toBeGreaterThanOrEqual(0.9);
      const old = menuFit(v.w, v.h).fit;
      expect(old, v.id).toBeLessThan(MENU_MIN_FIT + 1e-9);
    }
  });
});

// ---- the kit's floors, worked out from kit.css ----

/** The floors block: the rule that redeclares the size tokens on every zoomed root. */
function floorsBlock(): string {
  const m = /:root, \.screen[^{]*\{([^}]*)\}/.exec(KIT);
  if (!m) throw new Error('kit.css has no READABLE FLOORS block (:root, .screen, … { --fs-14: … })');
  return m[1]!;
}
function rootValue(name: string, coarse: boolean): number {
  const touch = /@media \(pointer: coarse\)\{ :root\{([^}]*)\} \}/g;
  const blocks = [...KIT.replace(touch, '').matchAll(/:root\{([^}]*)\}/g)].map((m) => m[1]!);
  if (coarse) for (const m of KIT.matchAll(touch)) blocks.push(m[1]!);
  let found: number | null = null;
  for (const b of blocks) {
    const m = new RegExp(`${name}:([0-9.]+)px`).exec(b);
    if (m) found = Number(m[1]);
  }
  if (found === null) throw new Error(`no ${name} in kit.css`);
  return found;
}
/** A floored token's size in design px at a zoom and a text scale: calc(max(Npx, var(--floor) / var(--zoom)) * scale). */
function fontToken(name: string, zoom: number, scale = 1): number {
  const m = new RegExp(`${name}:calc\\(max\\(([0-9.]+)px, var\\((--[a-z-]+)\\) / var\\(--zoom\\)\\) \\* var\\(--text-scale\\)\\);`).exec(floorsBlock());
  if (!m) throw new Error(`${name} isn't a floored type token`);
  return Math.max(Number(m[1]), rootValue(m[2]!, false) / zoom) * scale;
}
/** A floored target token in design px: max(Npx, var(--tap) / var(--zoom)). */
function targetToken(name: string, zoom: number, coarse: boolean): number {
  const m = new RegExp(`${name}:max\\(([0-9.]+)px, var\\(--tap\\) / var\\(--zoom\\)\\);`).exec(floorsBlock());
  if (!m) throw new Error(`${name} isn't a floored target token`);
  return Math.max(Number(m[1]), rootValue('--tap', coarse) / zoom);
}

const LABELS = ['--fs-12', '--fs-13', '--fs-14'];
const BODY = ['--fs-16', '--fs-18', '--fs-20', '--fs-24', '--fs-28', '--fs-36', '--fs-body'];
const TARGETS = ['--touch-min', '--hit-min', '--btn-h', '--btn-h-sm', '--btn-h-xl'];
// the zooms a screen is drawn at: the menus' at each viewport, plus the desktop-only cards (the
// connecting and error cards, the countdown) that a phone draws at the desktop fit, and the HUD's floor
const ZOOMS = [...VIEWPORTS.map((v) => ({ id: v.id, zoom: menuZoom(v), coarse: v.coarse })), ...VIEWPORTS.map((v) => ({ id: `${v.id} desktop card`, zoom: menuFit(v.w, v.h).fit, coarse: v.coarse })), { id: 'HUD floor', zoom: 0.75, coarse: false }];

describe('the readable floors (kit.css)', () => {
  it('no token renders text under 12 px, at any viewport, and body text renders at 14 px or more', () => {
    for (const { id, zoom } of ZOOMS) {
      for (const t of LABELS) expect(fontToken(t, zoom) * zoom, `${t} at ${id} (zoom ${zoom.toFixed(2)})`).toBeGreaterThanOrEqual(12.5 - 1e-9);
      for (const t of BODY) expect(fontToken(t, zoom) * zoom, `${t} at ${id}`).toBeGreaterThanOrEqual(14 - 1e-9);
    }
  });

  it("at full size the tokens are the kit's own sizes (the floor only lifts what a zoom shrinks)", () => {
    expect(fontToken('--fs-14', 1)).toBe(14);
    expect(fontToken('--fs-16', 1)).toBe(16);
    expect(fontToken('--fs-12', 1)).toBe(12.5);
    expect(targetToken('--btn-h', 1, false)).toBe(64);
    expect(targetToken('--touch-min', 1.26, true)).toBe(48);
  });

  it('a laptop at the 0.8 floor draws labels at 12.5 px, not 11.2 (UX-90)', () => {
    expect(fontToken('--fs-14', 0.8) * 0.8).toBeCloseTo(12.5, 6);
    expect(fontToken('--fs-16', 0.8) * 0.8).toBeCloseTo(14, 6);
  });

  it('Text size still enlarges every size, floored or not', () => {
    for (const zoom of [0.43, 0.8, 1, 1.26]) {
      for (const t of [...LABELS, ...BODY]) expect(fontToken(t, zoom, 1.5), `${t} at ${zoom}`).toBeCloseTo(fontToken(t, zoom) * 1.5, 6);
    }
  });

  it('on a touch screen no target token renders under 44 px; with a mouse they are the design sizes', () => {
    for (const { id, zoom, coarse } of ZOOMS) {
      for (const t of TARGETS) {
        const px = targetToken(t, zoom, coarse) * zoom;
        if (coarse) expect(px, `${t} at ${id}`).toBeGreaterThanOrEqual(44 - 1e-9);
      }
    }
    expect(targetToken('--btn-h-sm', 0.8, false)).toBe(48);
  });
});

// ---- every zoomed root tells the floors its zoom ----

function files(dir: string, ext: RegExp): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'render3d' ? [] : files(path, ext);
    return ext.test(name) ? [path] : [];
  });
}
const CSS = files(SRC, /\.css$/).map((f) => ({ f: f.slice(SRC.length + 1), text: readFileSync(f, 'utf8') }));

describe('zoomed roots', () => {
  it('every rule that zooms a screen by a fit (or back to 1) sets --zoom to the same', () => {
    const missing: string[] = [];
    for (const { f, text } of CSS) {
      for (const m of text.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
        const body = m[2]!;
        const zoom = /(?:^|[;\s])zoom:\s*([^;]+);/.exec(body);
        if (!zoom || !/--(phone-|hud-)?fit|^1$/.test(zoom[1]!.trim())) continue;
        if (!/\.screen|mf-notice|mf-tstrip|mf-install|mf-title__turn/.test(m[1]!)) continue;
        if (f === 'shell/screens/title.css') continue; // the first-screen work's file: its root keeps --zoom 1 (named in the PR)
        const z = /--zoom:\s*([^;]+);/.exec(body);
        if (!z || z[1]!.trim() !== zoom[1]!.trim()) missing.push(`${f}: ${m[1]!.trim()}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('no game stylesheet sets a raw font size under 15 px: small text goes through the floored tokens (UX-96)', () => {
    // pages outside the game's screens keep their own sizes: the staff console, the gamepad test page,
    // the legal pages (no kit), an SVG's own units, and the first-screen and Home work's files
    const outside = /^(admin\/|gamepad\/testPage\.css|ui\/legal\.css|touch\/fireArt\.css|shell\/screens\/title\.css|shell\/screens\/age\.css|.*home[^/]*\.css$)/;
    const raw: string[] = [];
    for (const { f, text } of CSS) {
      if (outside.test(f)) continue;
      for (const m of text.matchAll(/(font-size\s*:|(?<![-\w])font\s*:)([^;}]*)/g)) {
        if (/var\(--fs-/.test(m[2]!)) continue;
        for (const px of m[2]!.matchAll(/(?:^|[\s(])([0-9.]+)px/g)) if (Number(px[1]) < 15 && Number(px[1]) > 0) raw.push(`${f}: ${m[0].trim()}`);
      }
    }
    expect(raw).toEqual([]);
  });
});
