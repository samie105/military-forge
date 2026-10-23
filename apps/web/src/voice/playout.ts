/**
 * One speaker's voice, played on time (voice chat). Frames arrive with sequence numbers, sometimes
 * late, out of order or not at all (4G); each is scheduled as an AudioBuffer right after the last,
 * a little behind real time (the jitter buffer, 60-250 ms, growing when frames come late and
 * shrinking again when they don't). A missing frame is covered once by the last one, quieter
 * (concealment), then silence; a late one is dropped; a backlog is skipped so the delay never builds.
 */
import { SAMPLE_RATE } from './codec';

const MIN_DELAY = 0.06;
const MAX_DELAY = 0.25;
/** more than this behind the target: skip ahead */
const SLACK = 0.15;
/** quiet this long: the next frame starts a new talk spurt (a fresh delay) */
const SPURT_GAP = 0.5;

/** a < b for 16-bit wrapping sequence numbers */
export const seqBefore = (a: number, b: number): boolean => ((a - b) & 0xffff) >= 0x8000;

export interface PlayoutStats {
  played: number;
  concealed: number;
  late: number;
  skipped: number;
}

export class Playout {
  private nextSeq = -1;
  private nextTime = 0;
  private delay = 0.08;
  private lastPcm: Float32Array | null = null;
  private lastAt = -Infinity;
  readonly stats: PlayoutStats = { played: 0, concealed: 0, late: 0, skipped: 0 };

  constructor(
    private readonly ctx: Pick<BaseAudioContext, 'currentTime' | 'createBuffer' | 'createBufferSource'>,
    private readonly out: AudioNode,
  ) {}

  /** The current jitter-buffer delay, s. */
  get target(): number {
    return this.delay;
  }

  /** A decoded frame (48 kHz mono), in sequence order as far as the network allows. */
  push(seq: number, pcm: Float32Array): void {
    const now = this.ctx.currentTime;
    const dur = pcm.length / SAMPLE_RATE;
    if (this.nextSeq < 0 || now - this.lastAt > SPURT_GAP) {
      // a new talk spurt
      this.nextSeq = seq;
      this.nextTime = now + this.delay;
    } else if (seqBefore(seq, this.nextSeq)) {
      this.stats.late++;
      this.delay = Math.min(MAX_DELAY, this.delay + 0.02);
      return;
    } else if (seq !== this.nextSeq) {
      // frames missing in between: cover the first with the last one, quieter; then silence
      const missing = (seq - this.nextSeq) & 0xffff;
      if (missing > 50) {
        this.nextTime = now + this.delay;
      } else {
        if (this.lastPcm) {
          this.schedule(this.lastPcm, 0.5);
          this.stats.concealed++;
        }
        this.nextTime += (missing - (this.lastPcm ? 1 : 0)) * dur;
      }
      this.nextSeq = seq;
    }
    if (this.nextTime < now) {
      // we ran dry: start again a little further back
      this.delay = Math.min(MAX_DELAY, this.delay + 0.02);
      this.nextTime = now + this.delay;
    } else if (this.nextTime - now > this.delay + SLACK) {
      // too far behind real time: drop this frame to catch up
      this.stats.skipped++;
      this.nextSeq = (seq + 1) & 0xffff;
      this.lastAt = now;
      return;
    } else {
      // steady: let the delay come back down, slowly
      this.delay = Math.max(MIN_DELAY, this.delay - 0.0005);
    }
    this.schedule(pcm, 1);
    this.lastPcm = pcm;
    this.lastAt = now;
    this.nextSeq = (seq + 1) & 0xffff;
    this.stats.played++;
  }

  private schedule(pcm: Float32Array, gain: number): void {
    const buf = this.ctx.createBuffer(1, pcm.length, SAMPLE_RATE);
    const ch = buf.getChannelData(0);
    if (gain === 1) ch.set(pcm);
    else for (let i = 0; i < pcm.length; i++) ch[i] = pcm[i]! * gain * (1 - i / pcm.length);
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.out);
    src.start(this.nextTime);
    this.nextTime += pcm.length / SAMPLE_RATE;
  }

  /** The next frame we're waiting for (a redundant copy of it is worth decoding). */
  get expecting(): number {
    return this.nextSeq;
  }
}
