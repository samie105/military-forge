/** CC0 weapon-handling recordings, edited for short game cues (16 kHz, 16-bit little-endian PCM).
 * BMacZero: https://opengameart.org/content/gun-reload-sound-effects
 * SpringySpringo: https://opengameart.org/content/gun-reload-sounds
 * The samples are in foley.bin (banks.ts loads it); each take is its [byte offset, length] there.
 */
export const FOLEY_RATE = 16000;
export const FOLEY = {
  mag_release: [0, 6080],
  mag_seat: [6080, 7040],
  round: [13120, 3840],
  pistol_action: [16960, 19520],
  rifle_release: [36480, 6720],
  rifle_action: [43200, 14400],
  shotgun_action: [57600, 13760],
  dry_click: [71360, 5120],
} as const;
