import { describe, expect, it } from 'vitest';
import { MAX_LOCAL_BOTS, localBots } from '../src/localBots';

const parse = (query: string, matchMode = true) => localBots(new URLSearchParams(query), matchMode);

describe('local bots (?bots= and ?botlevel=)', () => {
  it('a local match plays three Normal bots by default; the sandbox keeps its dummies', () => {
    expect(parse('')).toEqual({ count: 3, level: 'normal' });
    expect(parse('', false)).toBeNull();
  });

  it('takes a count and a level, in a match or the sandbox', () => {
    expect(parse('bots=5&botlevel=hard')).toEqual({ count: 5, level: 'hard' });
    expect(parse('bots=2&botlevel=easy', false)).toEqual({ count: 2, level: 'easy' });
    expect(parse('bots=2.6')).toEqual({ count: 3, level: 'normal' });
  });

  it('?bots=0 (or nonsense) gives the dummies back; too many is capped; an unknown level is Normal', () => {
    expect(parse('bots=0')).toBeNull();
    expect(parse('bots=-4')).toBeNull();
    expect(parse('bots=many')).toBeNull();
    expect(parse(`bots=${MAX_LOCAL_BOTS + 20}`)).toEqual({ count: MAX_LOCAL_BOTS, level: 'normal' });
    expect(parse('bots=1&botlevel=nightmare')).toEqual({ count: 1, level: 'normal' });
  });
});
