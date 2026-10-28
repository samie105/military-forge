/**
 * Before/after clips of a weapon skin line's sounds (the K-47 Galaxy Relic), rendered straight from the sound
 * bank, as 32 kHz mono WAVs for the PR and the owner's ear:
 *   cd apps/web && npx tsx scripts/skin-sound-clips.ts <out dir>
 * Each clip plays the base then the skin, a second apart: a 4-shot burst at the K-47's pitch and fire interval,
 * the whole reload at its step times, the draw; then the Locker's inspect chime, and the Stardust Shatter next to
 * the death voice at their mix levels.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { K47 } from '@military-forge/content';
import { BANK_RATE, renderSound } from '../src/audio/bank';
import { SOUNDS, type SoundId } from '../src/audio/sounds';
import { weaponSounds } from '../src/audio/families';

const out = process.argv[2] ?? 'skin-sounds';
mkdirSync(out, { recursive: true });
const sr = BANK_RATE;

/** `id`'s take `v` at playback `rate` (resampled: a lower rate is deeper and longer, as the engine plays it). */
function take(id: SoundId, v: number, rate = 1, gain = 1): Float32Array {
  const x = renderSound(id, v)[0]!;
  const n = Math.floor(x.length / rate);
  const y = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i * rate;
    const a = Math.floor(t);
    y[i] = ((x[a] ?? 0) * (1 - (t - a)) + (x[a + 1] ?? 0) * (t - a)) * gain;
  }
  return y;
}

/** Clips placed at times (s) on one track. */
function track(len: number, parts: readonly [number, Float32Array][]): Float32Array {
  const y = new Float32Array(Math.ceil(len * sr));
  for (const [t, x] of parts) for (let i = 0; i < x.length && Math.round(t * sr) + i < y.length; i++) y[Math.round(t * sr) + i]! += x[i]!;
  return y;
}

function wav(name: string, x: Float32Array): void {
  const b = Buffer.alloc(44 + x.length * 2);
  b.write('RIFF', 0);
  b.writeUInt32LE(36 + x.length * 2, 4);
  b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(sr, 24);
  b.writeUInt32LE(sr * 2, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36);
  b.writeUInt32LE(x.length * 2, 40);
  for (let i = 0; i < x.length; i++) b.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(x[i]! * 32767))), 44 + i * 2);
  writeFileSync(join(out, `${name}.wav`), b);
  console.log(`  ${name}.wav ${(x.length / sr).toFixed(2)} s`);
}

const ws = weaponSounds(K47.index)!;
const burst = (fire: SoundId) => track(4 * K47.interval + 0.8, [0, 1, 2, 3].map((i) => [i * K47.interval, take(fire, i % 3, ws.rate, ws.gain)]));
const reload = (ids: readonly SoundId[]) => track(K47.reload + 0.5, ws.reload.map((s, i) => [K47.reload * s.at, take(ids[i]!, 0, 1, SOUNDS[ids[i]!].gain ?? 1)]));
const pair = (a: Float32Array, b: Float32Array, gap = 0.6) => track(a.length / sr + gap + b.length / sr, [[0, a], [a.length / sr + gap, b]]);

for (const [name, base, skin] of [
  ['fire', burst('rifle.fire'), burst('relic.fire')],
  ['reload', reload(['rifle.magout', 'rifle.magin', 'rifle.bolt']), reload(['relic.magout', 'relic.magin', 'relic.bolt'])],
  ['draw', take('rifle.draw', 0, 1, 0.55), take('relic.draw', 0, 1, 0.55)],
] as const) {
  wav(`${name}-base`, base);
  wav(`${name}-relic`, skin);
  wav(`${name}-base-then-relic`, pair(base, skin));
}
wav('inspect', take('relic.inspect', 0, 1, SOUNDS['relic.inspect'].gain));
wav('death-voice-then-shatter', pair(take('voice.death', 0, 1, SOUNDS['voice.death'].gain), take('stardust.shatter', 0, 1, SOUNDS['stardust.shatter'].gain), 0.3));
wav('shatter', take('stardust.shatter', 0, 1, SOUNDS['stardust.shatter'].gain));
