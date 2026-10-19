import { DEFAULT_COSMETIC_LOADOUT, DEFAULT_LOADOUT, weapons } from '@military-forge/content';
import { describe, expect, it } from 'vitest';
import { LoadoutSync, gunIndices, localGunStore, saveGunsHere, savedGunIndices, type AccountLoadout, type LoadoutApi } from '../../src/locker/accountSync';
import { LocalLoadoutStore, withItem } from '../../src/locker/loadouts';
import { Api, ApiError, type Me } from '../../src/shell/api';

function memoryStorage() {
  const data = new Map<string, string>();
  return { data, getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) };
}

const me = (id: string): Me => ({ id, nickname: id, isGuest: true, createdAt: '', nicknameChangeableAt: null, level: 1, xp: 0 });
const idOf = (i: number) => weapons[i]!.id;
const K47 = weapons.find((w) => w.id === 'k47')!.index;
const WIDOW = weapons.find((w) => w.id === 'widow')!.index;
const jungle = withItem(DEFAULT_COSMETIC_LOADOUT, 'boots', 'boots_jungle');

/** The account side: one stored loadout per user, and every PUT seen. */
class FakeApi implements LoadoutApi {
  me: Me | null = null;
  accounts = new Map<string, AccountLoadout>();
  puts: AccountLoadout[] = [];
  offline = false;
  refuse = false;
  private listeners = new Set<(me: Me) => void>();
  onSignIn(l: (me: Me) => void) {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
  signIn(id: string) {
    this.me = me(id);
    for (const l of this.listeners) l(this.me);
  }
  async getLoadout() {
    if (this.offline) throw new ApiError(0, 'network', 'offline');
    return this.accounts.get(this.me!.id) ?? null;
  }
  async putLoadout(_slot: number, loadout: AccountLoadout) {
    if (this.offline) throw new ApiError(0, 'network', 'offline');
    if (this.refuse) throw new ApiError(400, 'invalid_loadout', 'no');
    this.puts.push(structuredClone(loadout));
    this.accounts.set(this.me!.id, structuredClone(loadout));
  }
}

const settle = async (sync: LoadoutSync) => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
  await sync.flush();
};

describe('LoadoutSync', () => {
  it("a player's first device gives the account its look and guns; a second device takes them", async () => {
    const api = new FakeApi();
    const phone = memoryStorage();
    await new LocalLoadoutStore(phone).save(jungle);
    const first = new LoadoutSync(api, phone, 0);
    first.saveGuns([K47, WIDOW]); // before sign-in: kept for later
    expect(api.puts).toEqual([]);
    api.signIn('u1');
    await settle(first);
    expect(api.accounts.get('u1')).toEqual({ look: jungle, guns: ['k47', 'widow'] });

    const laptop = memoryStorage();
    const second = new LoadoutSync(api, laptop, 0);
    await settle(second);
    expect(await second.store.load()).toEqual(jungle);
    expect(second.savedGunIndices()).toEqual([K47, WIDOW]);
    expect(await new LocalLoadoutStore(laptop).load()).toEqual(jungle); // the cache the game reads
    expect(api.puts).toHaveLength(1); // the laptop only read
    expect(second.store.label).toBe('Saved to your account');
  });

  it('batches a run of Locker changes into one upload', async () => {
    const api = new FakeApi();
    api.signIn('u1');
    const sync = new LoadoutSync(api, memoryStorage(), 20);
    await settle(sync);
    await sync.store.save(withItem(DEFAULT_COSMETIC_LOADOUT, 'boots', 'boots_jungle'));
    await sync.store.save(withItem(jungle, 'eyewear', 'eyewear_aviators'));
    await new Promise((r) => setTimeout(r, 60));
    await sync.flush();
    expect(api.puts).toHaveLength(1);
    expect(api.puts[0]!.look.items.eyewear).toBe('eyewear_aviators');
    expect(api.puts[0]!.guns).toEqual([idOf(DEFAULT_LOADOUT[0]), idOf(DEFAULT_LOADOUT[1])]);
  });

  it('a change made offline goes up at the next sign-in instead of being overwritten', async () => {
    const api = new FakeApi();
    api.accounts.set('u1', { look: DEFAULT_COSMETIC_LOADOUT, guns: ['k47', 'widow'] });
    api.signIn('u1');
    api.offline = true;
    const storage = memoryStorage();
    const sync = new LoadoutSync(api, storage, 0);
    await sync.store.save(jungle);
    await settle(sync);
    expect(await sync.store.load()).toEqual(jungle); // still worn on this device

    api.offline = false;
    const later = new LoadoutSync(api, storage, 0); // the next visit
    await settle(later);
    expect(api.accounts.get('u1')!.look).toEqual(jungle);
    expect(api.accounts.get('u1')!.guns).toEqual(['k47', 'widow']);
  });

  it("another player signing in on this device gets their own loadout, not the last player's change", async () => {
    const api = new FakeApi();
    api.accounts.set('u2', { look: DEFAULT_COSMETIC_LOADOUT, guns: ['widow', 'k47'] });
    const storage = memoryStorage();
    api.signIn('u1');
    api.offline = true;
    const sync = new LoadoutSync(api, storage, 0);
    await sync.store.save(jungle); // u1's change, stuck offline
    await settle(sync);
    api.offline = false;
    api.signIn('u2');
    await settle(sync);
    expect(await sync.store.load()).toEqual(DEFAULT_COSMETIC_LOADOUT);
    expect(sync.savedGunIndices()).toEqual([WIDOW, K47]);
    expect(api.puts).toEqual([]);
  });

  it('stops retrying a loadout the server refuses, and keeps working with no storage at all', async () => {
    const api = new FakeApi();
    api.refuse = true;
    api.signIn('u1');
    const storage = memoryStorage();
    const sync = new LoadoutSync(api, storage, 0);
    await sync.store.save(jungle);
    await settle(sync);
    expect(JSON.parse(storage.data.get('loadout.sync.v1')!)).toEqual({ user: 'u1', dirty: [] });

    const bare = new LoadoutSync(new FakeApi(), null, 0);
    expect(bare.savedGunIndices()).toEqual([...DEFAULT_LOADOUT]);
    expect(bare.store.label).toBe('Saved on this device');
    await expect(bare.store.save(jungle)).rejects.toThrow('storage unavailable');
  });
});

describe('gunIndices', () => {
  it('maps ids to indices and falls back to the default pair for anything odd', () => {
    expect(gunIndices(['k47', 'widow'])).toEqual([K47, WIDOW]);
    for (const bad of [null, ['k47', 'k47'], ['k47', 'machete'], ['nope', 'widow']] as const) expect(gunIndices(bad as never)).toEqual([...DEFAULT_LOADOUT]);
  });
});

describe('Api sign-in listeners', () => {
  it('fire when a different player is signed in, not on every token refresh', async () => {
    const session = (id: string) => ({ accessToken: 't', accessTokenExpiresAt: new Date(0).toISOString(), refreshToken: 'r', user: me(id) });
    let next = session('u1');
    const api = new Api('/api', async () => new Response(JSON.stringify(next), { status: 201, headers: { 'content-type': 'application/json' } }));
    const seen: string[] = [];
    api.onSignIn((m) => seen.push(m.id));
    await api.guest();
    await api.restore();
    next = session('u2');
    await api.guest();
    expect(seen).toEqual(['u1', 'u2']);
  });
});

describe('the gun pair', () => {
  it('a pair saved on a page without the session (the Armory) reaches the account at the next sign-in', async () => {
    const storage = memoryStorage();
    expect(localGunStore(storage).get()).toEqual([...DEFAULT_LOADOUT]);
    localGunStore(storage).set([WIDOW, K47]);
    expect(savedGunIndices(storage)).toEqual([WIDOW, K47]);
    expect(saveGunsHere([K47, K47], storage)).toBe(false); // the same gun twice isn't a pair
    const machete = weapons.find((w) => w.id === 'machete')!.index;
    expect(saveGunsHere([machete, K47], storage)).toBe(false); // nor is a melee weapon
    const api = new FakeApi();
    api.accounts.set('u1', { look: DEFAULT_COSMETIC_LOADOUT, guns: ['hammer44', 'buzz'] });
    const sync = new LoadoutSync(api, storage, 0);
    api.signIn('u1');
    await settle(sync);
    expect(api.accounts.get('u1')!.guns).toEqual(['widow', 'k47']);
    expect(sync.guns.get()).toEqual([WIDOW, K47]);
  });

  it('a change made just before a room join goes up first, so the join ticket carries it', async () => {
    const api = new FakeApi() as FakeApi & { hooks: (() => Promise<void>)[]; beforeRoom(h: () => Promise<void>): void };
    api.hooks = [];
    api.beforeRoom = (h) => void api.hooks.push(h);
    api.signIn('u1');
    const sync = new LoadoutSync(api, memoryStorage(), 60_000); // a long batching delay
    await settle(sync);
    sync.guns.set([K47, WIDOW]);
    expect(api.puts).toHaveLength(0); // batched: not sent yet
    for (const h of api.hooks) await h(); // what Api.joinRoom does first
    expect(api.accounts.get('u1')!.guns).toEqual(['k47', 'widow']);
  });
});
