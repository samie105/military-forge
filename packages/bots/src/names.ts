/** Bot names: a curated list (docs/08 §9), marked so nobody mistakes a bot for a person. */

export const BOT_TAG = '[BOT] ';

/** Animal call signs: ≤ 10 letters so the tagged name fits the 16-character name limit. */
export const BOT_NAMES: readonly string[] = [
  'Badger',
  'Kestrel',
  'Mantis',
  'Jackal',
  'Osprey',
  'Lynx',
  'Bison',
  'Gecko',
  'Marten',
  'Heron',
  'Ibex',
  'Puma',
  'Raven',
  'Shrike',
  'Tapir',
  'Wren',
  'Coyote',
  'Otter',
  'Stoat',
  'Moose',
];

/** The n-th bot's tagged name (n counts from 0 per game). */
export function botName(n: number): string {
  const base = BOT_NAMES[n % BOT_NAMES.length]!;
  const round = Math.floor(n / BOT_NAMES.length);
  return BOT_TAG + (round > 0 ? `${base}${round + 1}` : base);
}
