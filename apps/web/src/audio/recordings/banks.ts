/**
 * The recorded takes' samples, one binary bank per module (voices, world, foley, ricochet). They used
 * to sit in the sound code as base64 (~740 KB of the music chunk, audit 28 Oct); now the build hashes
 * each bank like any other asset, and the sound code fetches them once with its own code
 * (audio/index.ts waits for both before the runtime starts), so the first sound never renders without them.
 */
import foleyUrl from './foley.bin?url';
import ricochetUrl from './ricochet.bin?url';
import voicesUrl from './voices.bin?url';
import worldUrl from './world.bin?url';

export const BANKS = { voices: voicesUrl, world: worldUrl, foley: foleyUrl, ricochet: ricochetUrl } as const;
export type BankName = keyof typeof BANKS;
/** A take in its bank: [byte offset, byte length]. */
export type Take = readonly [number, number];

const store = new Map<BankName, Uint8Array>();
let loading: Promise<void> | null = null;

/** Fills a bank (the loader below; tests read the files from disk). */
export function setBank(name: BankName, bytes: Uint8Array): void {
  store.set(name, bytes);
}

/** Whether every bank is in. */
export function recordingsLoaded(): boolean {
  return (Object.keys(BANKS) as BankName[]).every((name) => store.has(name));
}

/**
 * Fetches every bank not yet in, once (calls share the promise). A failed fetch (a dropped connection)
 * rejects, and the next call tries again.
 */
export function loadRecordings(get: (url: string) => Promise<Response> = (url) => fetch(url)): Promise<void> {
  if (recordingsLoaded()) return Promise.resolve();
  loading ??= Promise.all(
    (Object.entries(BANKS) as [BankName, string][])
      .filter(([name]) => !store.has(name))
      .map(async ([name, url]) => {
        const res = await get(url);
        if (!res.ok) throw new Error(`recordings: ${name} answered ${res.status}`);
        setBank(name, new Uint8Array(await res.arrayBuffer()));
      }),
  ).then(
    () => {
      loading = null;
    },
    (e: unknown) => {
      loading = null;
      throw e;
    },
  );
  return loading;
}

/** One take's bytes. Throws before the bank is in: the sound code never renders a recorded cue before then. */
export function takeBytes(name: BankName, [offset, length]: Take): Uint8Array {
  const bank = store.get(name);
  if (!bank) throw new Error(`recordings: the ${name} bank isn't loaded (await loadRecordings() first)`);
  return bank.subarray(offset, offset + length);
}
