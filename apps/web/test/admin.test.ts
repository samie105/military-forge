/** The admin page's logic (src/admin/model.ts): the token, the API calls, search, values. */
import { describe, expect, it } from 'vitest';
import { AdminApiError, adminCall, clampValue, formatValue, grouped, matches, readToken, withValue, type AdminFieldView } from '../src/admin/model';

const field = (over: Partial<AdminFieldView> = {}): AdminFieldView => ({
  key: 'weapon.k47.damage',
  group: 'Weapons',
  section: 'K-47',
  label: 'Damage',
  min: 0,
  max: 250,
  step: 1,
  def: 10,
  scope: 'content',
  ...over,
});

function store() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
}

describe('admin page', () => {
  it('the token comes from the link\'s #t=…, then from the tab\'s session; short or odd ones are ignored', () => {
    const s = store();
    expect(readToken('#t=abcdefghijklmnop_-XYZ', s)).toBe('abcdefghijklmnop_-XYZ');
    expect(readToken('', s)).toBe('abcdefghijklmnop_-XYZ'); // after the address bar lost it
    expect(readToken('#t=short', store())).toBe('');
    expect(readToken('#x=1&t=0123456789abcdefgh', store())).toBe('0123456789abcdefgh');
    expect(readToken('', null)).toBe('');
  });

  it('every call carries the token in a header, never in the URL; errors carry the status', async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const ok = (async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      return new Response(JSON.stringify({ values: { a: 1 } }), { status: 200 });
    }) as unknown as typeof fetch;
    await adminCall('TOKEN1234567890abcd', 'PUT', '/values', { a: 1 }, ok);
    expect(seen[0]!.url).toBe('/admin/api/values');
    expect(seen[0]!.url).not.toContain('TOKEN');
    expect(seen[0]!.init.headers).toEqual({ Authorization: 'Bearer TOKEN1234567890abcd', 'Content-Type': 'application/json' });
    expect(seen[0]!.init.body).toBe('{"a":1}');
    const denied = (async () => new Response(JSON.stringify({ error: 'nope' }), { status: 401 })) as unknown as typeof fetch;
    await expect(adminCall('x'.repeat(16), 'GET', '/state', undefined, denied)).rejects.toMatchObject({ status: 401, message: 'nope' });
    expect(new AdminApiError(500, 'x')).toBeInstanceOf(Error);
  });

  it('values: clamped like the server, shown on their step, dropped at the default', () => {
    const f = field({ min: 0.05, max: 3, step: 0.01, def: 0.1 });
    expect(clampValue(f, 9)).toBe(3);
    expect(clampValue(field(), 12.6)).toBe(13);
    expect(formatValue(f, 0.1)).toBe('0.10');
    expect(withValue({}, f, 0.2)).toEqual({ [f.key]: 0.2 });
    expect(withValue({ [f.key]: 0.2 }, f, 0.1)).toEqual({});
  });

  it('search matches words in any order across group, section, label and key; fields group in order', () => {
    const f = field();
    expect(matches(f, 'k-47 dam')).toBe(true);
    expect(matches(f, 'damage weapons')).toBe(true);
    expect(matches(f, 'fuse')).toBe(false);
    expect(matches(f, '  ')).toBe(true);
    const g = grouped([f, field({ key: 'b', section: 'Buzz' }), field({ key: 'c', group: 'Grenades', section: 'Frag' })]);
    expect([...g.keys()]).toEqual(['Weapons', 'Grenades']);
    expect([...g.get('Weapons')!.keys()]).toEqual(['K-47', 'Buzz']);
  });
});
