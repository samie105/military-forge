/**
 * Renders a sound's variant to samples: seeded by its id and variant (the same every time),
 * cleaned of anything non-finite and normalised to the sound's peak.
 */
import { Rng, hashSeed, peak } from './dsp';
import { SOUNDS, type SoundId } from './sounds';

/**
 * The bank's sample rate. 32 kHz keeps everything up to 16 kHz (all a game mix needs) at two
 * thirds of the memory of 48 kHz; the AudioContext resamples on playback.
 */
export const BANK_RATE = 32000;

export const variantsOf = (id: SoundId): number => Math.max(1, SOUNDS[id].variants ?? 1);

/** One variant of a sound as channels of samples (mono: one channel). */
export function renderSound(id: SoundId, variant = 0, sr = BANK_RATE): Float32Array[] {
  const def = SOUNDS[id];
  const out = def.render({ sr, rng: new Rng(hashSeed(`${id}#${variant}`)), v: variant });
  const channels = Array.isArray(out) ? out : [out];
  let p = 0;
  for (const ch of channels) {
    for (let i = 0; i < ch.length; i++) if (!Number.isFinite(ch[i]!)) ch[i] = 0;
    p = Math.max(p, peak(ch));
  }
  const target = def.peak ?? 0.9;
  if (p > 1e-9) for (const ch of channels) for (let i = 0; i < ch.length; i++) ch[i]! *= target / p;
  return def.loop ? channels : trimTail(channels, sr);
}

/** Cuts the inaudible end of a one-shot (under −54 dB of full scale), with a short fade out. */
export function trimTail(channels: Float32Array[], sr: number, floor = 0.002): Float32Array[] {
  let end = 0;
  for (const ch of channels) for (let i = ch.length - 1; i > end; i--) if (Math.abs(ch[i]!) > floor) {
    end = i;
    break;
  }
  const fade = Math.round(sr * 0.02);
  const len = Math.min(channels[0]!.length, end + fade);
  return channels.map((ch) => {
    const out = ch.slice(0, Math.max(1, len));
    for (let i = 0; i < fade && i < out.length; i++) out[out.length - 1 - i]! *= i / fade;
    return out;
  });
}
