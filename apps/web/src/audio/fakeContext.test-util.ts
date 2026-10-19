/**
 * A stand-in AudioContext for tests: just enough of the node graph to see what the engine builds,
 * what it starts and stops, and where its gains land. Time moves only when a test says.
 */

export class FakeParam {
  value: number;
  readonly events: { kind: string; value: number; time: number }[] = [];
  constructor(v: number) {
    this.value = v;
  }
  setValueAtTime(v: number, t: number) {
    this.events.push({ kind: 'set', value: v, time: t });
    this.value = v;
    return this;
  }
  linearRampToValueAtTime(v: number, t: number) {
    this.events.push({ kind: 'linear', value: v, time: t });
    this.value = v;
    return this;
  }
  exponentialRampToValueAtTime(v: number, t: number) {
    this.events.push({ kind: 'exp', value: v, time: t });
    this.value = v;
    return this;
  }
  /** the fake jumps straight to the target (tests read where a value is headed) */
  setTargetAtTime(v: number, t: number) {
    this.events.push({ kind: 'target', value: v, time: t });
    this.value = v;
    return this;
  }
  cancelScheduledValues() {
    return this;
  }
}

export class FakeNode {
  readonly outputs: FakeNode[] = [];
  constructor(
    readonly ctx: FakeContext,
    readonly kind: string,
  ) {
    ctx.nodes.push(this);
  }
  connect<T extends FakeNode>(n: T): T {
    this.outputs.push(n);
    return n;
  }
  disconnect() {
    this.outputs.length = 0;
  }
}

export class FakeGain extends FakeNode {
  readonly gain = new FakeParam(1);
  constructor(ctx: FakeContext) {
    super(ctx, 'gain');
  }
}

export class FakeBuffer {
  private readonly data: Float32Array[];
  constructor(
    readonly numberOfChannels: number,
    readonly length: number,
    readonly sampleRate: number,
  ) {
    this.data = Array.from({ length: numberOfChannels }, () => new Float32Array(length));
  }
  get duration() {
    return this.length / this.sampleRate;
  }
  getChannelData(i: number) {
    return this.data[i]!;
  }
}

export class FakeSource extends FakeNode {
  buffer: FakeBuffer | null = null;
  loop = false;
  readonly playbackRate = new FakeParam(1);
  startedAt: number | null = null;
  stoppedAt: number | null = null;
  onended: (() => void) | null = null;
  constructor(ctx: FakeContext) {
    super(ctx, 'source');
  }
  start(when = 0) {
    this.startedAt = when;
    this.ctx.started.push(this);
  }
  stop(when = 0) {
    this.stoppedAt = when;
  }
}

export class FakeContext {
  currentTime = 0;
  sampleRate = 48000;
  state: 'suspended' | 'running' | 'closed' | 'interrupted' = 'running';
  readonly nodes: FakeNode[] = [];
  readonly started: FakeSource[] = [];
  readonly destination = new FakeNode(this, 'destination');
  resumes = 0;
  suspends = 0;
  createGain() {
    return new FakeGain(this);
  }
  createBufferSource() {
    return new FakeSource(this);
  }
  createBuffer(ch: number, len: number, sr: number) {
    return new FakeBuffer(ch, len, sr);
  }
  createStereoPanner() {
    const n = new FakeNode(this, 'panner') as FakeNode & { pan: FakeParam };
    n.pan = new FakeParam(0);
    return n;
  }
  createBiquadFilter() {
    const n = new FakeNode(this, 'filter') as FakeNode & { type: string; frequency: FakeParam; Q: FakeParam };
    n.type = 'lowpass';
    n.frequency = new FakeParam(350);
    n.Q = new FakeParam(1);
    return n;
  }
  createDynamicsCompressor() {
    const n = new FakeNode(this, 'compressor') as FakeNode & Record<'threshold' | 'knee' | 'ratio' | 'attack' | 'release', FakeParam>;
    for (const k of ['threshold', 'knee', 'ratio', 'attack', 'release'] as const) n[k] = new FakeParam(0);
    return n;
  }
  createPanner() {
    const n = new FakeNode(this, 'hrtf') as FakeNode & Record<'positionX' | 'positionY' | 'positionZ', FakeParam> & Record<string, unknown>;
    n.positionX = new FakeParam(0);
    n.positionY = new FakeParam(0);
    n.positionZ = new FakeParam(0);
    return n;
  }
  createConvolver() {
    const n = new FakeNode(this, 'convolver') as FakeNode & { buffer: unknown; normalize: boolean };
    n.buffer = null;
    n.normalize = true;
    return n;
  }
  createOscillator() {
    const n = new FakeSource(this) as FakeSource & { type: string; frequency: FakeParam; detune: FakeParam };
    n.type = 'sine';
    n.frequency = new FakeParam(440);
    n.detune = new FakeParam(0);
    return n;
  }
  resume() {
    this.resumes++;
    if (this.state !== 'closed') this.state = 'running';
    return Promise.resolve();
  }
  suspend() {
    this.suspends++;
    this.state = 'suspended';
    return Promise.resolve();
  }
  /** what the started sources were connected through to (kinds along the first path) */
  pathOf(src: FakeNode): string[] {
    const out: string[] = [];
    let n: FakeNode | undefined = src;
    while (n && out.length < 12) {
      out.push(n.kind);
      n = n.outputs[0];
    }
    return out;
  }
  asAudioContext(): AudioContext {
    return this as unknown as AudioContext;
  }
}
