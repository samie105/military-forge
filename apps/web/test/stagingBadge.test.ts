import { describe, expect, it } from 'vitest';
import { showStagingBadge } from '../src/stagingBadge';

/** a document with just enough of the DOM for the badge */
function fakeDoc() {
  const added: { textContent: string; style: { cssText: string } }[] = [];
  const doc = {
    createElement: () => ({ textContent: '', title: '', dataset: {}, style: { cssText: '' } }),
    body: { append: (el: (typeof added)[number]) => added.push(el) },
  };
  return { doc: doc as unknown as Pick<Document, 'createElement' | 'body'>, added };
}

describe('the staging badge (docs/release.md)', () => {
  it('shows on a staging build, out of the way of input', () => {
    const { doc, added } = fakeDoc();
    expect(showStagingBadge('staging', doc)).toBe(true);
    expect(added).toHaveLength(1);
    expect(added[0]!.textContent).toBe('Staging');
    expect(added[0]!.style.cssText).toContain('pointer-events:none');
  });
  it('shows nothing on production or a build without VITE_ENV', () => {
    for (const env of [undefined, '', 'production']) {
      const { doc, added } = fakeDoc();
      expect(showStagingBadge(env, doc)).toBe(false);
      expect(added).toHaveLength(0);
    }
  });
});
