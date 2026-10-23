/** Looks on the wire (v19), the page's side: the look book, the 3D view's directory, and a saved look reaching the room. */
import { DEFAULT_COSMETIC_LOADOUT, botLook, cosmeticLoadoutWireIds, lookSeed, type CosmeticLoadout } from '@military-forge/content';
import { describe, expect, it } from 'vitest';
import { LoadoutSync, type AccountLoadout, type LoadoutApi } from '../../src/locker/accountSync';
import { LocalLoadoutStore } from '../../src/locker/loadouts';
import { LookBook, botLooks, followLooks, looksFromWire, savedLookIds } from '../../src/looks/book';
import { LoadoutDirectory, placeholderLoadout } from '../../src/render3d/character';
import type { Me } from '../../src/shell/api';

const look = (items: Partial<CosmeticLoadout['items']>, dyes: Partial<CosmeticLoadout['dyes']> = {}): CosmeticLoadout => ({
  items: { ...DEFAULT_COSMETIC_LOADOUT.items, ...items },
  dyes: { ...DEFAULT_COSMETIC_LOADOUT.dyes, ...dyes },
});
const HERS = look({ bodyType: 'body_female', hair: 'hair_braids' }, { primary: 'dye_khaki' });

function memoryStorage() {
  const data = new Map<string, string>();
  return { data, getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) };
}

describe('the look book', () => {
  it('takes the ROSTER\'s looks (wire ids), tells its readers only when something changed', () => {
    const book = new LookBook();
    let heard = 0;
    book.subscribe(() => heard++);
    const wire = new Map([
      [2, cosmeticLoadoutWireIds(HERS)],
      [5, cosmeticLoadoutWireIds(DEFAULT_COSMETIC_LOADOUT)],
    ]);
    book.replace(looksFromWire(wire));
    expect(heard).toBe(1);
    expect(book.get(2)).toEqual(HERS);
    expect(book.get(9)).toBeNull();
    expect(book.hashOf(2)).not.toBe(book.hashOf(5));
    book.replace(looksFromWire(wire)); // the same ROSTER again (someone joined elsewhere): nothing to redraw
    expect(heard).toBe(1);
    book.replace(looksFromWire(new Map([[2, cosmeticLoadoutWireIds(HERS)]])));
    expect(heard).toBe(2);
    book.clear();
    expect(book.all().size).toBe(0);
    expect(heard).toBe(3);
  });

  it('training\'s bots wear the looks a room would give them', () => {
    const looks = botLooks(1234, [{ id: 1, name: '[BOT] Kolo' }, { id: 2, name: '[BOT] Ada' }]);
    expect(looks.get(1)).toEqual(botLook(lookSeed(1234, '[BOT] Kolo')));
    expect(looks.get(2)).not.toEqual(looks.get(1));
  });

  it('a room\'s HELLO carries the saved look as wire ids (none saved: none sent)', async () => {
    const storage = memoryStorage();
    expect(savedLookIds(new LocalLoadoutStore(storage))).toBeNull();
    await new LocalLoadoutStore(storage).save(HERS);
    expect(savedLookIds(new LocalLoadoutStore(storage))).toEqual(cosmeticLoadoutWireIds(HERS));
  });
});

describe('the 3D view draws everyone in their look (render3d LoadoutDirectory)', () => {
  it('the room\'s looks for everyone it knows, ours included; placeholders for the rest; a change re-dresses', () => {
    const book = new LookBook();
    const dir = new LoadoutDirectory(null);
    let changes = 0;
    dir.onChange = () => changes++;
    followLooks(book, dir);
    expect(dir.for({ id: 3, isLocal: false })).toEqual(placeholderLoadout(3));
    expect(dir.for({ id: 4, isLocal: true })).toEqual(DEFAULT_COSMETIC_LOADOUT);
    const mine = look({ boots: 'boots_jungle' });
    book.replace([
      [3, HERS],
      [4, mine],
    ]);
    expect(dir.for({ id: 3, isLocal: false })).toEqual(HERS);
    expect(dir.for({ id: 4, isLocal: true })).toEqual(mine); // what the others see us in
    expect(changes).toBe(2); // following, then the ROSTER
    // offline (training): the saved look, owned items only
    book.clear();
    dir.setLocal(look({ eyewear: 'eyewear_gas_mask', gloves: 'gloves_tactical' }));
    expect(dir.for({ id: 4, isLocal: true })).toEqual(look({ gloves: 'gloves_tactical' }));
  });
});

describe('a look saved while playing reaches the room (LoadoutSync.onLook)', () => {
  class FakeApi implements LoadoutApi {
    me: Me | null = null;
    accounts = new Map<string, AccountLoadout>();
    private listeners = new Set<(me: Me) => void>();
    onSignIn(l: (me: Me) => void) {
      this.listeners.add(l);
      return () => this.listeners.delete(l);
    }
    signIn(id: string) {
      this.me = { id, nickname: id, isGuest: true, createdAt: '', nicknameChangeableAt: null, level: 1, xp: 0 };
      for (const l of this.listeners) l(this.me);
    }
    async getLoadout() {
      return this.accounts.get(this.me!.id) ?? null;
    }
    async putLoadout(_slot: number, loadout: AccountLoadout) {
      this.accounts.set(this.me!.id, structuredClone(loadout));
    }
  }

  it('hears a Locker save, and the account\'s look replacing this device\'s at sign-in', async () => {
    const api = new FakeApi();
    api.accounts.set('u1', { look: HERS, guns: ['k47', 'widow'] });
    const sync = new LoadoutSync(api, memoryStorage(), 0);
    const heard: CosmeticLoadout[] = [];
    sync.onLook((l) => heard.push(l));
    await sync.store.save(look({ boots: 'boots_jungle' }));
    expect(heard).toEqual([look({ boots: 'boots_jungle' })]);
    // a fresh device signs in: the account's look comes down (and is heard)
    const fresh = new LoadoutSync(api, memoryStorage(), 0);
    const later: CosmeticLoadout[] = [];
    fresh.onLook((l) => later.push(l));
    api.signIn('u1');
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
    await fresh.flush();
    expect(later).toEqual([HERS]);
  });
});
