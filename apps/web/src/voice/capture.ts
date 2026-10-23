/**
 * The microphone (voice chat): asked for once, on a tap (the first push-to-talk, or switching voice
 * on), then 20 ms of mono 48 kHz samples at a time to `onFrame`, with the browser's echo
 * cancelling, noise suppression and gain control on. An AudioWorklet reads it (public/audio/
 * voice-capture.js); browsers without one fall back to a ScriptProcessor.
 *
 * Refused or missing, the player stays listen-only: they hear everyone and send nothing.
 */
import { SAMPLE_RATE } from './codec';

export type MicState = 'off' | 'asking' | 'live' | 'denied' | 'unavailable';

export const FRAME_SAMPLES = SAMPLE_RATE / 50; // 20 ms

export class MicCapture {
  state: MicState = 'off';
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private node: AudioNode | null = null;
  private gain: GainNode | null = null;
  private starting: Promise<MicState> | null = null;

  constructor(
    private readonly onFrame: (pcm: Float32Array) => void,
    private readonly onState: (s: MicState) => void,
  ) {}

  private set(s: MicState): void {
    this.state = s;
    this.onState(s);
  }

  /** Microphone volume, 0…2 (1 = as the browser gives it). */
  setVolume(v: number): void {
    if (this.gain) this.gain.gain.value = Math.max(0, Math.min(2, v));
  }

  /** Opens the mic (asks the first time). Call from a tap: some browsers need one for audio. */
  start(volume = 1): Promise<MicState> {
    if (this.state === 'live') return Promise.resolve('live');
    if (this.starting) return this.starting;
    this.starting = this.open(volume).finally(() => (this.starting = null));
    return this.starting;
  }

  private async open(volume: number): Promise<MicState> {
    const media = typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined;
    if (!media?.getUserMedia || typeof AudioContext === 'undefined') {
      this.set('unavailable');
      return this.state;
    }
    this.set('asking');
    try {
      this.stream = await media.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
    } catch (e) {
      const name = (e as Error).name;
      this.set(name === 'NotFoundError' || name === 'NotReadableError' || name === 'OverconstrainedError' ? 'unavailable' : 'denied');
      return this.state;
    }
    try {
      const ctx = (this.ctx = new AudioContext({ sampleRate: SAMPLE_RATE, latencyHint: 'interactive' }));
      if (ctx.state === 'suspended') await ctx.resume().catch(() => {});
      const src = ctx.createMediaStreamSource(this.stream);
      const gain = (this.gain = ctx.createGain());
      gain.gain.value = volume;
      src.connect(gain);
      if (ctx.audioWorklet) {
        await ctx.audioWorklet.addModule('/audio/voice-capture.js');
        const node = new AudioWorkletNode(ctx, 'mf-voice-capture', { numberOfInputs: 1, numberOfOutputs: 0, processorOptions: { frame: FRAME_SAMPLES } });
        node.port.onmessage = (e: MessageEvent<Float32Array>) => this.onFrame(e.data);
        gain.connect(node);
        this.node = node;
      } else {
        // older browsers: the main thread reads it (2048 samples at a time, cut into 20 ms frames)
        const sp = ctx.createScriptProcessor(2048, 1, 1);
        let buf = new Float32Array(FRAME_SAMPLES);
        let at = 0;
        sp.onaudioprocess = (e) => {
          const ch = e.inputBuffer.getChannelData(0);
          for (let i = 0; i < ch.length; i++) {
            buf[at++] = ch[i]!;
            if (at === FRAME_SAMPLES) {
              this.onFrame(buf);
              buf = new Float32Array(FRAME_SAMPLES);
              at = 0;
            }
          }
        };
        gain.connect(sp);
        // a ScriptProcessor only runs when it reaches the output: through a silent gain
        const mute = ctx.createGain();
        mute.gain.value = 0;
        sp.connect(mute).connect(ctx.destination);
        this.node = sp;
      }
      this.set('live');
    } catch {
      this.stop();
      this.set('unavailable');
    }
    return this.state;
  }

  /** Lets go of the mic (the browser's recording light goes off). */
  stop(): void {
    for (const t of this.stream?.getTracks() ?? []) t.stop();
    this.stream = null;
    this.node?.disconnect();
    this.node = null;
    this.gain = null;
    void this.ctx?.close().catch(() => {});
    this.ctx = null;
    if (this.state === 'live' || this.state === 'asking') this.set('off');
  }
}
