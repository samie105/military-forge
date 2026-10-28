/**
 * The recorded takes live in binary banks (recordings/*.bin, audit 28 Oct), no longer as base64 in the
 * sound code: each take is byte for byte the old one, decodes to the same samples, and the sound
 * code starts only once its banks are in.
 */
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BANKS, loadRecordings, recordingsLoaded, setBank, takeBytes, type BankName, type Take } from './recordings/banks';
import { FOLEY } from './recordings/foley';
import { recordedFoley, recordedRicochet, recordedVoice, recordedWorld } from './recordings/render';
import { RICOCHETS } from './recordings/ricochet';
import { RECORDED_VOICES } from './recordings/voices';
import { WORLD_RECORDINGS } from './recordings/world';
import { loadRecordingsFromDisk } from './recordings.test-util';

/** sha256 (first 16 hex) of each take as the old base64 decoded */
const OLD_TAKES: Record<string, string> = {
  'voices:hurt.0': '6839fd851666c1fb',
  'voices:hurt.1': '70b5a25760d1f996',
  'voices:hurt.2': '643199fc4edcff7f',
  'voices:hurt.3': 'bbbf6618583a4456',
  'voices:death.0': '6118eb5b5f50a13c',
  'voices:death.1': '1231df4b4b2eb1e3',
  'voices:death.2': '28a0354c5287b713',
  'world:metal_hit': '7845a2627dda2617',
  'world:metal_heavy': '5b7b5353346bd629',
  'world:metal_break': '8a72eceac5933017',
  'world:cough_1': 'e8c32e65019d9964',
  'world:cough_2': '1e3a67e4357411b5',
  'world:cough_3': '9ca4dd4fbb595b02',
  'world:jet_start': '633f567dce175a32',
  'world:jet_loop': 'b2f50556a112f2fd',
  'world:jet_stop': '12283f6d079ceb23',
  'foley:mag_release': 'd71fcfde66d8a701',
  'foley:mag_seat': '84b603d07cad8b18',
  'foley:round': '6a4472362e34aeb2',
  'foley:pistol_action': 'd51bf920d9522e69',
  'foley:rifle_release': '17fc3430e38fcda3',
  'foley:rifle_action': 'cfd4c650d8514e28',
  'foley:shotgun_action': 'ae474738858d2b40',
  'foley:dry_click': '5eec96673e20a760',
  'ricochet:0': '43c33f05c0b19732',
  'ricochet:1': '231d346de4f05521',
  'ricochet:2': 'f2c97c4f5664e4ee',
  'ricochet:3': 'a4990460475db094',
};

const takes = (bank: BankName, tree: unknown, path = ''): [string, Take][] => {
  if (Array.isArray(tree) && typeof tree[0] === 'number') return [[`${bank}:${path}`, tree as unknown as Take]];
  const entries = Array.isArray(tree) ? tree.map((t, i) => [String(i), t] as const) : Object.entries(tree as object);
  return entries.flatMap(([k, t]) => takes(bank, t, path ? `${path}.${k}` : k));
};

/** [length, sum, sum of |x|] of a render, as the old code gave it */
const shape = (a: Float32Array) => {
  let s = 0;
  let q = 0;
  for (const x of a) {
    s += x;
    q += Math.abs(x);
  }
  return [a.length, s, q] as const;
};

describe('the recorded takes', () => {
  it('are the old takes, byte for byte, in every bank', () => {
    loadRecordingsFromDisk();
    const all = [...takes('voices', RECORDED_VOICES), ...takes('world', WORLD_RECORDINGS), ...takes('foley', FOLEY), ...takes('ricochet', RICOCHETS)];
    expect(all.map(([k]) => k).sort()).toEqual(Object.keys(OLD_TAKES).sort());
    for (const [key, take] of all) expect(createHash('sha256').update(takeBytes(key.split(':')[0] as BankName, take)).digest('hex').slice(0, 16), key).toBe(OLD_TAKES[key]);
  });

  it('decode and resample to the same samples as before (PCM and mu-law)', () => {
    loadRecordingsFromDisk();
    const near = (got: readonly number[], want: readonly number[]) => {
      expect(got[0]).toBe(want[0]);
      expect(got[1]).toBeCloseTo(want[1]!, 6);
      expect(got[2]).toBeCloseTo(want[2]!, 6);
    };
    near(shape(recordedVoice('hurt', 1, 48000)), [32640, -0.010894742021268833, 2445.1196187329515]);
    near(shape(recordedWorld('jet_loop', 48000)), [105600, -2.8417952297677402, 23919.73022529563]);
    near(shape(recordedWorld('metal_hit', 16000)), [5280, -0.175048828125, 202.276123046875]);
    near(shape(recordedFoley('round', 44100)), [5292, 0.06532748075687561, 92.95515947461172]);
    near(shape(recordedRicochet(2, 48000)), [21600, -0.0009153640212389291, 857.1868285897262]);
  });
});

describe('loadRecordings', () => {
  it('fetches each bank once, shares the wait, and tries again after a failure', async () => {
    vi.resetModules();
    const banks = await import('./recordings/banks');
    let fail = true;
    const asked: string[] = [];
    const get = (url: string) => {
      asked.push(url);
      return Promise.resolve(fail ? new Response(null, { status: 503 }) : new Response(new Uint8Array([1, 2, 3, 4])));
    };
    await expect(banks.loadRecordings(get)).rejects.toThrow(/503/);
    expect(banks.recordingsLoaded()).toBe(false);
    fail = false;
    asked.length = 0;
    const a = banks.loadRecordings(get);
    const b = banks.loadRecordings(get);
    expect(a).toBe(b);
    await a;
    expect(banks.recordingsLoaded()).toBe(true);
    expect(asked.sort()).toEqual(Object.values(BANKS).sort());
    await banks.loadRecordings(get);
    expect(asked).toHaveLength(Object.keys(BANKS).length);
  });

  it('throws a clear error for a take whose bank is not in', async () => {
    vi.resetModules();
    const banks = await import('./recordings/banks');
    expect(() => banks.takeBytes('world', [0, 4])).toThrow(/world bank isn't loaded/);
  });

  it('leaves the banks it was given (tests fill them from disk)', () => {
    setBank('ricochet', new Uint8Array(8));
    expect(takeBytes('ricochet', [2, 4])).toHaveLength(4);
    loadRecordingsFromDisk();
    expect(recordingsLoaded()).toBe(true);
    return expect(loadRecordings(() => Promise.reject(new Error('no fetch when loaded')))).resolves.toBeUndefined();
  });
});

describe('the sound code', () => {
  afterEach(() => {
    vi.doUnmock('./recordings/banks');
    vi.doUnmock('./runtime');
    vi.resetModules();
  });

  it('starts only once the recordings are in, not when its code arrives', async () => {
    vi.resetModules();
    let release!: () => void;
    const recordings = new Promise<void>((r) => (release = r));
    vi.doMock('./recordings/banks', () => ({ loadRecordings: () => recordings }));
    vi.doMock('./runtime', () => ({ AudioRuntime: class {} }));
    const { loadSound } = await import('./index');
    let done = false;
    const loading = loadSound().then((m) => {
      done = true;
      return m;
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(done).toBe(false);
    release();
    expect(typeof (await loading).AudioRuntime).toBe('function');
    expect(done).toBe(true);
  });
});
