/**
 * Prefixed, time-ordered ids (`u_01jb…`): the ULID layout (48-bit millisecond timestamp, then
 * 80 random bits) in lowercase Crockford base32. Sortable by creation time, so primary-key
 * inserts stay append-mostly, and the prefix says what an id is in logs and tickets.
 */
import { randomBytes } from 'node:crypto';

/** u: user, s: session, t: an emailed link (email_tokens), pay: a checkout (the provider's tx_ref), ord: an item bought */
export type IdPrefix = 'u' | 's' | 't' | 'pay' | 'ord';

const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';

export function newId(prefix: IdPrefix, nowMs: number = Date.now()): string {
  let time = '';
  let t = Math.floor(nowMs);
  for (let i = 0; i < 10; i++) {
    time = ALPHABET[t % 32] + time;
    t = Math.floor(t / 32);
  }
  // 10 random bytes = 80 bits = 16 base32 digits
  const bytes = randomBytes(10);
  let rand = '';
  let acc = 0;
  let bits = 0;
  for (const byte of bytes) {
    acc = (acc << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      rand += ALPHABET[(acc >> bits) & 31];
    }
    acc &= (1 << bits) - 1;
  }
  return `${prefix}_${time}${rand}`;
}
