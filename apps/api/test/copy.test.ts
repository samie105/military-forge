/** db/copy.ts: moving one database's rows into another (PGlite → Postgres on the trial box). */
import { getTableName } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { copyAllTables, tablesInCopyOrder } from '../src/db/copy';
import { createGuest, createTestApi, json, type SessionBody, type TestApi } from './helpers';

let from: TestApi;
let to: TestApi;
beforeAll(async () => {
  from = await createTestApi();
  to = await createTestApi();
});
afterAll(async () => {
  await Promise.all([from.close(), to.close()]);
});

describe('tablesInCopyOrder', () => {
  it('puts every table after the tables it references', () => {
    const names = tablesInCopyOrder().map(getTableName);
    expect(names[0]).toBe('users');
    expect(new Set(names)).toEqual(new Set(['users', 'identities', 'profiles', 'sessions']));
  });
});

describe('copyAllTables', () => {
  it('moves the accounts over, so the players stay signed in, and a second run adds nothing', async () => {
    const guests: SessionBody[] = [];
    for (const nickname of ['Kemi', 'Tunde', undefined]) guests.push(await createGuest(from, nickname ? { nickname } : {}));

    const first = await copyAllTables(from.database.db, to.database.db);
    expect(first).toMatchObject({ users: { read: 3, added: 3 }, identities: { added: 3 }, profiles: { added: 3 }, sessions: { added: 3 } });

    // a refresh token minted by the old database works against the new one
    const res = await to.app.request('/auth/refresh', json({ refreshToken: guests[0]!.refreshToken }, { 'x-forwarded-for': to.ip() }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as SessionBody).user).toMatchObject({ id: guests[0]!.user.id, nickname: 'Kemi' });

    const again = await copyAllTables(from.database.db, to.database.db);
    for (const c of Object.values(again)) expect(c.added).toBe(0);
  });
});
