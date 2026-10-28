/** Tests read the recorded takes' banks from disk (the app fetches them: recordings/banks.ts). */
import { readFileSync } from 'node:fs';
import { BANKS, setBank, type BankName } from './recordings/banks';

export function loadRecordingsFromDisk(): void {
  for (const name of Object.keys(BANKS) as BankName[]) setBank(name, new Uint8Array(readFileSync(new URL(`./recordings/${name}.bin`, import.meta.url))));
}
