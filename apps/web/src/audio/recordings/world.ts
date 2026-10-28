/** Public-domain/CC0 field recordings for world and combat cues, encoded as 16 kHz G.711 mu-law.
 * Metal: https://opengameart.org/content/metal-impact-sounds (BMacZero)
 * Cough: https://commons.wikimedia.org/wiki/File:Man_coughing.ogg (stilgar)
 * Turbine: https://freesound.org/people/qubodup/sounds/205581/ (qubodup)
 * The samples are in world.bin (banks.ts loads it); each take is its [byte offset, length] there.
 */
export const WORLD_RECORDING_RATE = 16000;
export const WORLD_RECORDINGS = {
  metal_hit: [0, 5280],
  metal_heavy: [5280, 5760],
  metal_break: [11040, 20000],
  cough_1: [31040, 21280],
  cough_2: [52320, 19412],
  cough_3: [71732, 16800],
  jet_start: [88532, 10400],
  jet_loop: [98932, 35200],
  jet_stop: [134132, 12800],
} as const;
