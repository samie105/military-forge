/** CC0 field-recorded bullet ricochets by cedarstudios, edited into four takes (16 kHz, 16-bit PCM).
 * https://freesound.org/people/cedarstudios/sounds/148840/
 * The samples are in ricochet.bin (banks.ts loads it); each take is its [byte offset, length] there.
 */
export const RICOCHET_RATE = 16000;
export const RICOCHETS = [
  [0, 9600],
  [9600, 11520],
  [21120, 14400],
  [35520, 13120],
] as const;
