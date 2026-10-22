import { RECORDED_VOICE_RATE, RECORDED_VOICES } from './voices';
import { FOLEY, FOLEY_RATE } from './foley';
import { RICOCHETS, RICOCHET_RATE } from './ricochet';
import { WORLD_RECORDINGS, WORLD_RECORDING_RATE } from './world';

const decoded = new Map<string, Float32Array>();

/** Decode a recorded cue once, then resample for the sound bank. */
function recorded(key: string, take: string, sourceRate: number, sr: number, muLaw = false): Float32Array {
  let source = decoded.get(key);
  if (!source) {
    const bytes = atob(take);
    source = new Float32Array(bytes.length / (muLaw ? 1 : 2));
    for (let i = 0; i < source.length; i++) {
      if (muLaw) {
        const code = (~bytes.charCodeAt(i)) & 0xff;
        const magnitude = (((code & 15) << 3) + 0x84) << ((code >> 4) & 7);
        source[i] = ((code & 0x80) ? -(magnitude - 0x84) : magnitude - 0x84) / 32768;
        continue;
      }
      let value = bytes.charCodeAt(i * 2) | (bytes.charCodeAt(i * 2 + 1) << 8);
      if (value >= 0x8000) value -= 0x10000;
      source[i] = value / 32768;
    }
    decoded.set(key, source);
  }
  if (sr === sourceRate) return source.slice();
  const out = new Float32Array(Math.ceil(source.length * sr / sourceRate));
  for (let i = 0; i < out.length; i++) {
    const x = i * sourceRate / sr;
    const a = Math.floor(x);
    out[i] = source[a]! * (1 - (x - a)) + (source[Math.min(a + 1, source.length - 1)] ?? 0) * (x - a);
  }
  return out;
}

export function recordedVoice(kind: keyof typeof RECORDED_VOICES, variant: number, sr: number): Float32Array {
  const takes = RECORDED_VOICES[kind];
  const index = ((variant % takes.length) + takes.length) % takes.length;
  return recorded(`${kind}:${index}`, takes[index]!, RECORDED_VOICE_RATE, sr);
}

export function recordedFoley(kind: keyof typeof FOLEY, sr: number): Float32Array {
  return recorded(`foley:${kind}`, FOLEY[kind], FOLEY_RATE, sr);
}

export function recordedRicochet(variant: number, sr: number): Float32Array {
  const index = ((variant % RICOCHETS.length) + RICOCHETS.length) % RICOCHETS.length;
  return recorded(`ricochet:${index}`, RICOCHETS[index]!, RICOCHET_RATE, sr);
}

export function recordedWorld(kind: keyof typeof WORLD_RECORDINGS, sr: number): Float32Array {
  return recorded(`world:${kind}`, WORLD_RECORDINGS[kind], WORLD_RECORDING_RATE, sr, true);
}
