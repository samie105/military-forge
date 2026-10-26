/**
 * The music bed for the menus and the lobby, made live (no file): low and tense, military. A drone
 * on D through a dark filter, its chords moving between D, E-flat (Phrygian dread) and C, war drums
 * in a marching pattern, a dry field snare, a clock ticking, and a struck steel plate now and then,
 * at 84 BPM. Notes are scheduled a little ahead on the audio clock (a lookahead timer), so the beat
 * holds whatever the page is doing. In a match it fades out; the match-start sting takes over.
 */
import { mtof } from './dsp';
import type { AudioEngine } from './engine';

export type MusicMode = 'off' | 'menu' | 'lobby';

const BPM = 84;
const STEP = 60 / BPM / 4; // a sixteenth
const LOOKAHEAD = 0.35;
/** two bars per chord: a low pedal and the notes over it (MIDI), all minor or worse */
const CHORDS: readonly (readonly number[])[] = [
  [26, 38, 45, 50], // D5
  [26, 38, 45, 53], // Dm (F on top)
  [27, 39, 46, 51], // Eb5 against the D: the dread
  [24, 36, 43, 51], // C5 with Eb: dark
  [26, 38, 45, 50],
  [26, 38, 44, 50], // D with a flat fifth
  [22, 34, 41, 50], // Bb5
  [21, 33, 40, 49], // A5 with C#: back to D
];
/** war drums: sixteenth steps in a bar and their weight */
const DRUMS: readonly (readonly [step: number, gain: number])[] = [
  [0, 1],
  [6, 0.55],
  [8, 0.85],
  [14, 0.4],
];
const LEVEL: Record<MusicMode, number> = { off: 0, menu: 1, lobby: 0.75 };

export class MusicBed {
  private readonly out: GainNode;
  private mode: MusicMode = 'off';
  private timer: ReturnType<typeof setInterval> | 0 = 0;
  private next = 0;
  private step = 0;
  private stopAt = 0;

  constructor(private readonly engine: AudioEngine) {
    this.out = engine.ctx.createGain();
    this.out.gain.value = 0;
    this.out.connect(engine.input('music'));
  }

  get current(): MusicMode {
    return this.mode;
  }

  setMode(mode: MusicMode): void {
    if (mode === this.mode) return;
    const was = this.mode;
    this.mode = mode;
    const ctx = this.engine.ctx;
    const t = ctx.currentTime;
    const g = this.out.gain;
    g.cancelScheduledValues(t);
    g.setTargetAtTime(LEVEL[mode], t, mode === 'off' ? 0.35 : 1);
    if (mode !== 'off' && !this.timer) {
      if (was === 'off' && t > this.stopAt) {
        this.step = 0;
        this.next = t + 0.1;
      }
      this.timer = setInterval(() => this.tick(), 90);
      this.tick();
    }
    if (mode === 'off') this.stopAt = t + 2.5;
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = 0;
    this.out.disconnect();
  }

  private tick(): void {
    const ctx = this.engine.ctx;
    const now = ctx.currentTime;
    if (this.mode === 'off' && now > this.stopAt) {
      if (this.timer) clearInterval(this.timer);
      this.timer = 0;
      return;
    }
    // not running (or its clock stopped): nothing is scheduled into a clock that doesn't move
    if (!this.engine.running) return;
    // behind (the tab slept): pick up again from now
    if (this.next < now - 0.2) this.next = now + 0.05;
    while (this.next < now + LOOKAHEAD) {
      this.schedule(this.step, this.next);
      this.step = (this.step + 1) % (16 * 16);
      this.next += STEP;
    }
  }

  /** One sixteenth: the drone moves every two bars, drums, snare, the clock, a steel hit. */
  private schedule(step: number, t: number): void {
    const bar = Math.floor(step / 16);
    const s = step % 16;
    const chord = CHORDS[Math.floor(bar / 2) % CHORDS.length]!;
    const delay = Math.max(0, t - this.engine.now);
    const lobby = this.mode === 'lobby';
    const play = (id: 'music.drum' | 'music.snare' | 'music.tick' | 'music.hit', gain: number, rate = 1) => {
      this.engine.play(id, { delay, gain, rate, to: this.out });
    };
    if (s === 0 && bar % 2 === 0) this.pad(chord, t, STEP * 32);
    if (s % 4 === 0) this.bass(chord[0]!, t, s === 0 ? 0.3 : 0.16);
    // drums: sparse in the menus at first, the full march in the lobby
    for (const [ds, g] of DRUMS) if (ds === s && (lobby || bar % 8 >= 2 || ds === 0)) play('music.drum', g, ds === 6 || ds === 14 ? 1.12 : 1);
    if ((s === 4 || s === 12) && (lobby || bar % 8 >= 4)) play('music.snare', s === 12 ? 0.8 : 0.5);
    // a snare roll into every fourth bar's turn
    if (bar % 4 === 3 && s >= 12 && (lobby || bar % 8 === 7)) play('music.snare', 0.25 + (s - 12) * 0.12);
    if (s % 4 === 2) play('music.tick', s === 2 ? 1 : 0.6);
    if (s === 0 && bar % 2 === 0) play('music.hit', 1, mtof(chord[2]!) / mtof(50));
  }

  /** A dark drone: two detuned saws per note through a low, slowly breathing low-pass. */
  private pad(chord: readonly number[], t: number, len: number): void {
    const ctx = this.engine.ctx;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.Q.value = 0.8;
    filter.frequency.setValueAtTime(260, t);
    filter.frequency.linearRampToValueAtTime(620, t + len * 0.5);
    filter.frequency.linearRampToValueAtTime(300, t + len);
    const env = ctx.createGain();
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(0.09, t + 1.5);
    env.gain.setValueAtTime(0.09, t + len - 0.6);
    env.gain.linearRampToValueAtTime(0, t + len + 1.4);
    filter.connect(env).connect(this.out);
    const oscs: OscillatorNode[] = [];
    for (const n of chord.slice(1))
      for (const cents of [-7, 6]) {
        const o = ctx.createOscillator();
        o.type = 'sawtooth';
        o.frequency.value = mtof(n);
        o.detune.value = cents;
        o.connect(filter);
        o.start(t);
        o.stop(t + len + 1.5);
        oscs.push(o);
      }
    oscs[0]!.onended = () => {
      filter.disconnect();
      env.disconnect();
    };
  }

  /** A low sine pulse under the drone (a heartbeat on the beat). */
  private bass(root: number, t: number, level: number): void {
    const ctx = this.engine.ctx;
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.value = mtof(root + 12);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(level, t + 0.012);
    g.gain.setTargetAtTime(0, t + 0.04, 0.09);
    o.connect(g).connect(this.out);
    o.start(t);
    o.stop(t + STEP * 2 + 0.2);
    o.onended = () => g.disconnect();
  }
}
