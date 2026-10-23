/** db/copy.ts: moving one database's rows into another (PGlite → Postgres on the trial box). */
import { DEFAULT_COSMETIC_LOADOUT } from '@military-forge/content';
import { getTableName } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { copyAllTables, tablesInCopyOrder } from '../src/db/copy';
import { createGuest, createTestApi, json, type SessionBody, type TestApi } from './helpers';

let from: TestApi;
let to: TestApi;
beforeAll(async () => {
  // two databases of their own, even when TEST_DATABASE_URL points the suite at one Postgres
  from = await createTestApi({ DATABASE_URL: '' });
  to = await createTestApi({ DATABASE_URL: '' });
});
afterAll(async () => {
  await Promise.all([from.close(), to.close()]);
});

describe('tablesInCopyOrder', () => {
  it('puts every table after the tables it references', () => {
    const names = tablesInCopyOrder().map(getTableName);
    expect(names[0]).toBe('users');
    expect(names.indexOf('matches')).toBeLessThan(names.indexOf('match_players'));
    expect(new Set(names)).toEqual(new Set(['users', 'identities', 'profiles', 'sessions', 'loadouts', 'matches', 'match_players', 'stats_lifetime', 'friendships', 'friend_requests', 'blocks']));
  });
});

describe('copyAllTables', () => {
  it('moves the accounts over, so the players stay signed in, and a second run adds nothing', async () => {
    const guests: SessionBody[] = [];
    for (const nickname of ['Kemi', 'Tunde', undefined]) guests.push(await createGuest(from, nickname ? { nickname } : {}));

    const put = await from.app.request('/me/loadout/0', {
      method: 'PUT',
      headers: { authorization: `Bearer ${guests[0]!.accessToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ look: DEFAULT_COSMETIC_LOADOUT, guns: ['k47', 'widow'] }),
    });
    expect(put.status).toBe(200);

    const first = await copyAllTables(from.database.db, to.database.db);
    expect(first).toMatchObject({ users: { read: 3, added: 3 }, identities: { added: 3 }, profiles: { added: 3 }, sessions: { added: 3 }, loadouts: { added: 1 } });

    // a refresh token minted by the old database works against the new one
    const res = await to.app.request('/auth/refresh', json({ refreshToken: guests[0]!.refreshToken }, { 'x-forwarded-for': to.ip() }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as SessionBody).user).toMatchObject({ id: guests[0]!.user.id, nickname: 'Kemi' });

    const again = await copyAllTables(from.database.db, to.database.db);
    for (const c of Object.values(again)) expect(c.added).toBe(0);
  });
});
