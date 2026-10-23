/**
 * Voice codecs (v18, docs/05 §17).
 *
 * - **Opus** through WebCodecs (AudioEncoder / AudioDecoder): Chrome and Edge 94+, Android Chrome,
 *   Samsung Internet, Firefox 130+ on desktop, and Safari 26+ (iOS 26). Mono, 48 kHz, voice
 *   tuning, 16-40 kbps by link quality (voice.ts), 20/40/60 ms frames.
 * - **Fallback (IMA ADPCM)** where a browser has no Opus in WebCodecs (Safari before 26, Firefox
 *   on Android): 4-bit ADPCM at 6 kHz, 24 kbps, narrowband but clear speech, plain JavaScript, no
 *   download. Every frame starts its own predictor, so a lost packet costs only itself. A room
 *   where anyone can't decode Opus talks in the fallback (VOICE_STATE's flag), so everyone hears
 *   everyone.
 */
export const SAMPLE_RATE = 48_000;
/** the fallback's rate: 48 kHz / 8 */
export const ADPCM_RATE = 6_000;
const DOWN = SAMPLE_RATE / ADPCM_RATE;

export interface CodecSupport {
  opusEncode: boolean;
  opusDecode: boolean;
}

type AudioEncoderCtor = typeof AudioEncoder;
type AudioDecoderCtor = typeof AudioDecoder;

const opusConfig = (bitrate: number) => ({ codec: 'opus', sampleRate: SAMPLE_RATE, numberOfChannels: 1, bitrate });

/** What this browser can do with Opus (WebCodecs), asked once. */
export async function detectCodecs(g: { AudioEncoder?: AudioEncoderCtor; AudioDecoder?: AudioDecoderCtor } = globalThis as never): Promise<CodecSupport> {
  const ask = async (f: () => Promise<{ supported?: boolean }> | undefined) => {
    try {
      return (await f())?.supported === true;
    } catch {
      return false;
    }
  };
  const [opusEncode, opusDecode] = await Promise.all([
    ask(() => g.AudioEncoder?.isConfigSupported(opusConfig(24_000) as AudioEncoderConfig)),
    ask(() => g.AudioDecoder?.isConfigSupported({ codec: 'opus', sampleRate: SAMPLE_RATE, numberOfChannels: 1 })),
  ]);
  return { opusEncode, opusDecode };
}

// ---------------------------------------------------------------- IMA ADPCM (the fallback)

const STEPS = [
  7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45, 50, 55, 60, 66, 73, 80, 88, 97, 107, 118, 130, 143, 157, 173, 190, 209, 230, 253, 279, 307, 337, 371, 408, 449, 494, 544, 598,
  658, 724, 796, 876, 963, 1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066, 2272, 2499, 2749, 3024, 3327, 3660, 4026, 4428, 4871, 5358, 5894, 6484, 7132, 7845, 8630, 9493, 10442, 11487, 12635, 13899, 15289,
  16818, 18500, 20350, 22385, 24623, 27086, 29794, 32767,
];
const INDEX_STEP = [-1, -1, -1, -1, 2, 4, 6, 8];

/**
 * 48 kHz float → one fallback frame: [i16 first sample (LE) · u8 step index · 4-bit codes, two per
 * byte]. A 2-pole average before taking every 8th sample keeps most of the aliasing out.
 */
export function adpcmEncode(pcm: Float32Array): Uint8Array {
  const n = Math.floor(pcm.length / DOWN);
  const s = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    let acc = 0;
    for (let k = 0; k < DOWN; k++) acc += pcm[i * DOWN + k]!;
    s[i] = Math.max(-32768, Math.min(32767, Math.round((acc / DOWN) * 32767)));
  }
  const out = new Uint8Array(3 + Math.ceil((n - 1) / 2));
  let pred = s[0] ?? 0;
  let index = 0;
  out[0] = pred & 0xff;
  out[1] = (pred >> 8) & 0xff;
  // start the step from the first difference, so a loud frame isn't smeared while it adapts
  if (n > 1) {
    const d = Math.abs(s[1]! - pred);
    while (index < 88 && STEPS[index]! < d / 2) index++;
  }
  out[2] = index;
  for (let i = 1; i < n; i++) {
    const step = STEPS[index]!;
    let diff = s[i]! - pred;
    let code = 0;
    if (diff < 0) {
      code = 8;
      diff = -diff;
    }
    let delta = step >> 3;
    if (diff >= step) {
      code |= 4;
      diff -= step;
      delta += step;
    }
    if (diff >= step >> 1) {
      code |= 2;
      diff -= step >> 1;
      delta += step >> 1;
    }
    if (diff >= step >> 2) {
      code |= 1;
      delta += step >> 2;
    }
    pred = Math.max(-32768, Math.min(32767, code & 8 ? pred - delta : pred + delta));
    index = Math.max(0, Math.min(88, index + INDEX_STEP[code & 7]!));
    const at = 3 + ((i - 1) >> 1);
    out[at] = (i - 1) & 1 ? out[at]! | (code << 4) : code;
  }
  return out;
}

/** One fallback frame → 48 kHz float (linear interpolation back up). */
export function adpcmDecode(bytes: Uint8Array): Float32Array {
  if (bytes.length < 3) return new Float32Array(0);
  const codes = (bytes.length - 3) * 2;
  const n = codes + 1;
  const s = new Float32Array(n);
  let pred = (bytes[0]! | (bytes[1]! << 8)) << 16 >> 16;
  let index = Math.min(88, bytes[2]!);
  s[0] = pred;
  for (let i = 1; i < n; i++) {
    const byte = bytes[3 + ((i - 1) >> 1)]!;
    const code = (i - 1) & 1 ? byte >> 4 : byte & 15;
    const step = STEPS[index]!;
    let delta = step >> 3;
    if (code & 4) delta += step;
    if (code & 2) delta += step >> 1;
    if (code & 1) delta += step >> 2;
    pred = Math.max(-32768, Math.min(32767, code & 8 ? pred - delta : pred + delta));
    index = Math.max(0, Math.min(88, index + INDEX_STEP[code & 7]!));
    s[i] = pred;
  }
  const out = new Float32Array(n * DOWN);
  for (let i = 0; i < n; i++) {
    const a = s[i]! / 32768;
    const b = (i + 1 < n ? s[i + 1]! : s[i]!) / 32768;
    for (let k = 0; k < DOWN; k++) out[i * DOWN + k] = a + ((b - a) * k) / DOWN;
  }
  return out;
}

// ---------------------------------------------------------------- Opus (WebCodecs)

/** Opus encoding: 48 kHz mono frames in, encoded chunks out (in order). */
export class OpusEncoder {
  private readonly enc: AudioEncoder;
  private bitrate = 0;
  private frameMs = 0;
  private ts = 0;

  constructor(onChunk: (bytes: Uint8Array) => void, onError: (e: Error) => void, Ctor: AudioEncoderCtor = AudioEncoder) {
    this.enc = new Ctor({
      output: (chunk) => {
        const b = new Uint8Array(chunk.byteLength);
        chunk.copyTo(b);
        onChunk(b);
      },
      error: (e) => onError(e instanceof Error ? e : new Error(String(e))),
    });
  }

  /** Bitrate (bits/s) and frame length; reconfigures only on a change. */
  configure(bitrate: number, frameMs: number): void {
    if (bitrate === this.bitrate && frameMs === this.frameMs && this.enc.state === 'configured') return;
    this.bitrate = bitrate;
    this.frameMs = frameMs;
    const config = {
      ...opusConfig(bitrate),
      bitrateMode: 'variable',
      opus: { frameDuration: frameMs * 1000, complexity: 5, signal: 'voice', application: 'voip', usedtx: false, useinbandfec: false, format: 'opus' },
    } as unknown as AudioEncoderConfig;
    this.enc.configure(config);
  }

  /** One frame of mono 48 kHz samples (exactly frameMs long). */
  encode(pcm: Float32Array): void {
    if (this.enc.state !== 'configured') return;
    const data = new AudioData({ format: 'f32-planar', sampleRate: SAMPLE_RATE, numberOfFrames: pcm.length, numberOfChannels: 1, timestamp: this.ts, data: pcm as Float32Array<ArrayBuffer> });
    this.ts += Math.round((pcm.length / SAMPLE_RATE) * 1e6);
    this.enc.encode(data);
    data.close();
  }

  close(): void {
    if (this.enc.state !== 'closed') this.enc.close();
  }
}

/**
 * Opus decoding, one decoder per speaker. Output comes back asynchronously but in the order put
 * in, so each decode carries a tag (the frame's seq) that comes back with its samples.
 */
export class OpusDecoder {
  private readonly dec: AudioDecoder;
  private readonly tags: number[] = [];
  private ts = 0;

  constructor(onFrame: (tag: number, pcm: Float32Array) => void, onError: (e: Error) => void, Ctor: AudioDecoderCtor = AudioDecoder) {
    this.dec = new Ctor({
      output: (data) => {
        const tag = this.tags.shift() ?? -1;
        const pcm = new Float32Array(data.numberOfFrames);
        data.copyTo(pcm, { planeIndex: 0, format: 'f32-planar' });
        data.close();
        onFrame(tag, pcm);
      },
      error: (e) => onError(e instanceof Error ? e : new Error(String(e))),
    });
    this.dec.configure({ codec: 'opus', sampleRate: SAMPLE_RATE, numberOfChannels: 1 });
  }

  decode(bytes: Uint8Array, tag: number, frameMs: number): void {
    if (this.dec.state !== 'configured') return;
    this.tags.push(tag);
    this.dec.decode(new EncodedAudioChunk({ type: 'key', timestamp: this.ts, data: bytes as Uint8Array<ArrayBuffer> }));
    this.ts += frameMs * 1000;
  }

  close(): void {
    if (this.dec.state !== 'closed') this.dec.close();
  }
}

/** RMS of a frame as the wire's 4-bit level (0 silent … 15 shouting). */
export function levelOf(pcm: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < pcm.length; i++) sum += pcm[i]! * pcm[i]!;
  const rms = Math.sqrt(sum / Math.max(1, pcm.length));
  const db = 20 * Math.log10(Math.max(1e-6, rms));
  // −60 dB → 0, −6 dB → 15
  return Math.max(0, Math.min(15, Math.round(((db + 60) / 54) * 15)));
}

/** RMS in dBFS (the open-mic gate compares this to its threshold). */
export function dbfs(pcm: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < pcm.length; i++) sum += pcm[i]! * pcm[i]!;
  return 20 * Math.log10(Math.max(1e-6, Math.sqrt(sum / Math.max(1, pcm.length))));
}
