/** Public-domain human grunts from stilgar, “Male pain grunts.ogg” (PDSounds / Wikimedia Commons).
 * https://commons.wikimedia.org/wiki/File:Male_pain_grunts.ogg
 * Edited into short mono 16 kHz PCM takes (16-bit little-endian) for immediate, deterministic game
 * playback. The samples are in voices.bin (banks.ts loads it); each take is its [byte offset, length] there. */
export const RECORDED_VOICE_RATE = 16000;
export const RECORDED_VOICES = {
  hurt: [
    [0, 13670],
    [13670, 21760],
    [35430, 20160],
    [55590, 30080],
  ],
  death: [
    [85670, 84800],
    [170470, 42560],
    [213030, 71360],
  ],
} as const;
