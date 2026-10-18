/**
 * The round-two kit's foundation (docs/design/ui-v2-wiring-brief.md, phase 1): every icon the app
 * names is in the sprite, and every CSS variable it reads is defined (the kit's tokens, or a value
 * the app sets itself). Reads the sources: what a review would grep for.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EVENT_KINDS, grenades, weapons } from '@military-forge/content';
import { describe, expect, it } from 'vitest';
import { eventLook } from '../src/hud/model';
import { iconHref, weaponIcon } from '../src/ui/icons';
import { SPRITE_IDS } from '../src/ui/sprite';

const SRC = fileURLToPath(new URL('../src', import.meta.url));
const WEB = fileURLToPath(new URL('..', import.meta.url));

function files(dir: string, ext: RegExp): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path, ext);
    return ext.test(name) ? [path] : [];
  });
}
const sources = files(SRC, /\.(tsx?|css)$/).filter((f) => !/\.test\.tsx?$/.test(f));
const read = (f: string) => readFileSync(f, 'utf8');
const inSprite = (href: string) => SPRITE_IDS.includes(href.replace(/^#/, ''));

describe('icons', () => {
  it('every icon the code names by a literal is in the sprite', () => {
    const missing: string[] = [];
    const pats = [/<Icon name="([\w-]+)"/g, /<Icon name=\{[^}]*?'([\w-]+)'[^}]*?(?:'([\w-]+)')?[^}]*?\}/g, /href="#(icon-[\w-]+)"/g, /\bic\('([\w-]+)'/g, /\bicon\('([\w-]+)'/g, /iconHref\('([\w-]+)'/g, /icon: '([\w-]+)'/g];
    for (const f of sources) {
      const text = read(f);
      for (const p of pats) {
        for (const m of text.matchAll(p)) {
          for (const name of m.slice(1).filter((x): x is string => !!x)) if (!inSprite(iconHref(name))) missing.push(`${f.slice(SRC.length + 1)}: ${name}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it('weapons, grenades and map events all have their icon (the touch controls name theirs as ic() literals, checked above)', () => {
    for (const w of weapons) expect(weaponIcon(w.id), w.id).not.toBeNull();
    for (const g of grenades) expect(inSprite(iconHref(`g-${g.id}`)), g.id).toBe(true);
    for (const kind of Object.keys(EVENT_KINDS)) expect(inSprite(iconHref(eventLook(kind).icon)), kind).toBe(true);
    expect(iconHref('wpn-k47')).toBe('#icon-wpn-k47');
    expect(weaponIcon('hammer44')).toBe('wpn-hammer');
    expect(weaponIcon('not-a-gun')).toBeNull();
  });
});

describe('tokens', () => {
  it('every var(--…) the app reads is defined: a kit token, or a custom property the app sets', () => {
    const page = read(join(WEB, 'index.html'));
    const all = [...sources.map(read), page];
    const defined = new Set<string>();
    for (const text of all) {
      for (const m of text.matchAll(/(--[\w-]+)\s*:/g)) defined.add(m[1]!);
      // set from TS: style.setProperty('--x', …), { '--x': … } objects, `--x` in template strings
      for (const m of text.matchAll(/['"`](--[\w-]+)['"`]/g)) defined.add(m[1]!);
      for (const m of text.matchAll(/setProperty\(`(--[\w-]+)/g)) defined.add(m[1]!);
      for (const m of text.matchAll(/data-bind-var="([^"]+)"/g)) for (const v of m[1]!.split(/\s+/)) defined.add(v.split(':')[0]!);
    }
    // the kit's runtime variables: set inline on the element that reads them (the HUD, the picker's
    // previews) as the screens that use them are wired, not tokens (kit.css's header: "WIRING MARKERS")
    const runtime = new Set(['--load', '--ang', '--rad', '--x', '--blind']);
    const missing = new Set<string>();
    for (const f of [...sources, join(WEB, 'index.html')]) {
      if (f.endsWith('/ui/kit.css')) continue; // the kit's own contract; its runtime variables arrive phase by phase
      for (const m of read(f).matchAll(/var\((--[\w-]+)\s*(,)?/g)) if (!m[2] && !defined.has(m[1]!) && !runtime.has(m[1]!)) missing.add(`${f.slice(WEB.length)}: ${m[1]}`);
    }
    expect([...missing]).toEqual([]);
  });

  it("round one's token names are gone (round two renamed them)", () => {
    const retired = ['--c-accent', '--c-sand', '--c-bg', '--c-panel', '--font-ui', '--font-stencil', '--hud-plate', '--fs-md', '--safe-top', '--z-overlay'];
    for (const f of sources) for (const name of retired) expect(read(f).includes(`var(${name})`), `${f.slice(SRC.length + 1)} reads ${name}`).toBe(false);
  });
});
