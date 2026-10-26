/**
 * The audio engine (docs/11 §6): buses, voices, loops, positional sound, ducking and muffling.
 *
 *   world sounds ─► duck ─► muffle ─┐
 *   blasts ("big") ─────────────────┴─► Effects ─┐
 *   music ─► duck ─► Music ───────────────────────┤
 *   interface ─► Interface ───────────────────────┼─► Master ─► limiter ─► hidden-tab mute ─► out
 *   voices ─► duck ─► Voices ─────────────────────┘
 *
 * Every voice is a buffer source → gain → (a low-pass when far) → stereo pan → its bus. World
 * sounds pan by where they are across the screen from the listener (the local player) and fall
 * off with distance. Each sound caps its own voices (the oldest is cut), the engine caps them all
 * (the least important goes), and the same sound can't restart within its cooldown, so eight
 * players firing at once stay clean. Buffers are rendered on first use (bank.ts) or warmed ahead
 * in idle time; nothing here runs inside the 60 Hz sim.
 */
import { BANK_RATE, renderSound, variantsOf } from './bank';
import { SOUNDS, type Bus, type SoundId } from './sounds';

/** The volumes (0…1, mutes already applied: 0) the player sets in Settings → Audio. */
export interface Volumes {
  master: number;
  sfx: number;
  music: number;
  ui: number;
  voice: number;
}

export interface PlayOptions {
  /** world position (m): pans and fades from the listener. Absent: plays centred, as your own */
  x?: number;
  y?: number;
  /** an explicit pan −1…1 (overrides the position's) */
  pan?: number;
  /** multiplies the sound's own gain */
  gain?: number;
  /** playback rate (pitch), before the sound's own jitter */
  rate?: number;
  /** seconds from now */
  delay?: number;
  /** added to the sound's priority (your own sounds: +15) */
  priority?: number;
  /** extra metres of distance (muffles and quietens: off-screen cues) */
  far?: number;
  /** connect here instead of the sound's bus (the music bed's own fader) */
  to?: AudioNode;
  /** this take, not a random one (the sound board) */
  variant?: number;
  /** your own sound (your gun, your reload): it dips a little under close incoming threats */
  own?: boolean;
  /** (internal) this is already a far layer: don't layer again */
  noFar?: boolean;
}

/** Where a sound is for the listener, worked out once per start (and per frame for loops). */
interface Spot {
  /** it has a world position (else centred, or an explicit pan) */
  positional: boolean;
  dx: number;
  dy: number;
  d: number;
  pan: number;
  level: number;
  /** walls in between: 0, 1, 2+ */
  occl: number;
}

/** Speed of sound (m/s): a far shot's report arrives late. Capped so gameplay never lags. */
export const SPEED_OF_SOUND = 343;
export const MAX_SOUND_DELAY = 0.15;
/** Behind one wall, behind two: level and the highest frequency that gets through. */
export const OCCLUSION_GAIN = [1, 0.5, 0.3] as const;
export const OCCLUSION_CUTOFF = [20000, 1100, 550] as const;

const smoothstep = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** How much of a sound `d` metres away is its far layer (0 near … 1 far). */
export const farMix = (d: number, from = 25, to = 70): number => smoothstep(from, to, d);

/** A playing sound: stop it early (a reload cut short). */
export interface Voice {
  readonly id: SoundId;
  readonly priority: number;
  readonly startedAt: number;
  stop(fade?: number): void;
  readonly ended: boolean;
}

/** Perceptual volume: the slider's 0…1 to a gain (squared, so 50% sounds like half). */
export const volumeToGain = (v: number): number => (v <= 0 ? 0 : Math.min(1, v) ** 2);

/** Metres across which a sound pans from the centre to one side (about half the screen). */
export const PAN_SPAN = 16;
/** Within this distance a world sound plays at full level. */
export const REF_DISTANCE = 6;

/** The level of a world sound `d` metres away that is audible up to `range`. */
export function distanceGain(d: number, range: number): number {
  if (d >= range) return 0;
  const inv = d <= REF_DISTANCE ? 1 : REF_DISTANCE / (REF_DISTANCE + (d - REF_DISTANCE) * 0.9);
  // a gentle fade to nothing over the last fifth of the range
  const edge = Math.min(1, (range - d) / (range * 0.2));
  return inv * edge;
}

/** Air and walls take the highs away with distance: a low-pass cutoff for `d` metres. */
export const distanceCutoff = (d: number): number => Math.max(700, 18000 * Math.exp(-d / 22));

export interface EngineOptions {
  /** all voices at once (default 40) */
  maxVoices?: number;
  /** renders a variant (tests stub it); default: the sound bank */
  render?: (id: SoundId, variant: number, sr: number) => Float32Array[];
  /** 0…1 random source for variant and pitch picks (tests fix it) */
  random?: () => number;
  /** wall clock, ms: how long a held sound has waited (tests drive it) */
  clock?: () => number;
}

/**
 * Sounds asked for while the context isn't running yet (a phone's first finger: the browser starts
 * the sound only when it lifts; resuming takes a moment; the output restarting) wait, and play once
 * it runs, still in time: a sound later than this (s) past when it was due is dropped, so a burst
 * of stale shots never lands at once.
 */
export const PENDING_LATE = 0.25;
/** at most this many wait (the oldest go first) */
export const MAX_PENDING = 32;

interface Pending {
  id: SoundId;
  o: PlayOptions;
  /** wall clock (ms) when it was asked for */
  at: number;
  voice: HeldVoice;
}

/** A sound waiting for the context: stopping it before it plays cancels it. */
interface HeldVoice extends Voice {
  cancelled: boolean;
  real: Voice | null;
}

interface VoiceRec extends Voice {
  src: AudioBufferSourceNode;
  gain: GainNode;
  filter: BiquadFilterNode | null;
  /** the send into the shared space (convolution reverb) */
  send: GainNode | null;
  panner: StereoPannerNode | PannerNode | null;
  ended: boolean;
  loopKey: string | null;
}

/** A playing loop. */
interface LoopRec {
  voice: VoiceRec;
}

export class AudioEngine {
  readonly ctx: AudioContext;
  /** the five player-facing buses (gain nodes) */
  readonly buses: Record<'master' | 'sfx' | 'music' | 'ui' | 'voice', GainNode>;
  /** inputs per sound bus (where voices connect) */
  private readonly inputs: Record<Bus, AudioNode>;
  private readonly duckSfx: GainNode;
  private readonly duckMusic: GainNode;
  private readonly duckVoice: GainNode;
  private readonly big: GainNode;
  private readonly muffler: BiquadFilterNode;
  readonly limiter: DynamicsCompressorNode;
  /** the world's space: two convolution reverbs on synthesized impulses, the open street and under
   * cover, cross-faded by where the listener stands (null: unsupported) */
  private readonly space: GainNode | null = null;
  private spaceOpen: GainNode | null = null;
  private spaceCover: GainNode | null = null;
  /** your own sounds, dipped under incoming threats */
  private readonly ownGain: GainNode;
  private readonly hiddenGain: GainNode;

  private readonly maxVoices: number;
  private readonly render: (id: SoundId, variant: number, sr: number) => Float32Array[];
  private readonly random: () => number;
  private readonly buffers = new Map<SoundId, (AudioBuffer | undefined)[]>();
  private readonly lastStart = new Map<SoundId, number>();
  private readonly voices: VoiceRec[] = [];
  private readonly loops = new Map<string, LoopRec>();
  private warmQueue: [SoundId, number][] = [];
  private warmTimer = 0;
  private hidden = false;
  /** the context says running but its clock has stopped (unlock.ts's watchdog): sounds wait */
  private stalled = false;
  private pending: Pending[] = [];
  private readonly clock: () => number;
  private suspendTimer: ReturnType<typeof setTimeout> | 0 = 0;

  /** the listener (the local player), m; null in the menus: world sounds play centred */
  listener: { x: number; y: number } | null = null;
  /** "Soften loud bursts": blasts quieter, no ear ring, gentler ducking, a harder limiter */
  soft = false;
  /** headphones: HRTF panning (left, right, above, below by ear); off: equal-power stereo */
  hrtf = false;
  /** walls between the listener and a point (acoustics.ts), or null: none known */
  occluder: ((x: number, y: number) => number) | null = null;
  /** how enclosed the listener is, 0 open … 1 indoors (the reverb's character) */
  enclosure = 0;
  /** the volumes last applied (Settings → Audio) */
  volumes: Volumes = { master: 1, sfx: 1, music: 1, ui: 1, voice: 1 };
  /** voices refused (limits) and stolen since the start: the board shows them */
  readonly counters = { played: 0, refused: 0, stolen: 0, cooled: 0, held: 0, late: 0 };

  constructor(ctx: AudioContext, options: EngineOptions = {}) {
    this.ctx = ctx;
    this.maxVoices = options.maxVoices ?? 40;
    this.render = options.render ?? renderSound;
    this.random = options.random ?? Math.random;
    this.clock = options.clock ?? (() => performance.now());
    const gain = (v = 1): GainNode => {
      const g = ctx.createGain();
      g.gain.value = v;
      return g;
    };
    this.buses = { master: gain(), sfx: gain(), music: gain(), ui: gain(), voice: gain() };
    this.duckSfx = gain();
    this.duckMusic = gain();
    this.duckVoice = gain();
    this.big = gain();
    this.muffler = ctx.createBiquadFilter();
    this.muffler.type = 'lowpass';
    this.muffler.frequency.value = 20000;
    this.muffler.Q.value = 0.5;
    this.limiter = ctx.createDynamicsCompressor();
    this.hiddenGain = gain();

    this.duckSfx.connect(this.muffler).connect(this.buses.sfx);
    this.ownGain = gain();
    this.ownGain.connect(this.duckSfx);
    // the world's space: sounds send to it, more the farther they are, so a close shot is dry and
    // punchy and a far one is mostly its echo off the buildings. Two characters: the open street
    // (a long, dark tail with late reflections) and under cover (short, dense, close walls)
    if (typeof ctx.createConvolver === 'function') {
      try {
        const send = gain();
        const open = ctx.createConvolver();
        open.normalize = true;
        open.buffer = makeImpulse(ctx, 2.4, this.random);
        const cover = ctx.createConvolver();
        cover.normalize = true;
        cover.buffer = makeImpulse(ctx, 0.7, this.random, true);
        this.spaceOpen = gain(0.55);
        this.spaceCover = gain(0);
        send.connect(open).connect(this.spaceOpen).connect(this.muffler);
        send.connect(cover).connect(this.spaceCover).connect(this.muffler);
        this.space = send;
      } catch {
        this.space = null;
      }
    }
    this.big.connect(this.buses.sfx);
    this.duckMusic.connect(this.buses.music);
    this.duckVoice.connect(this.buses.voice);
    for (const b of ['sfx', 'music', 'ui', 'voice'] as const) this.buses[b].connect(this.buses.master);
    this.buses.master.connect(this.limiter).connect(this.hiddenGain).connect(ctx.destination);
    this.inputs = { sfx: this.duckSfx, big: this.big, music: this.duckMusic, ui: this.buses.ui, voice: this.duckVoice };
    this.setSoft(false);
  }

  get now(): number {
    return this.ctx.currentTime;
  }

  /** the context runs and its clock moves: a sound started now is heard */
  get running(): boolean {
    return this.ctx.state === 'running' && !this.stalled;
  }

  /** The watchdog's word on the output (unlock.ts): stopped while "running", or going again. */
  setStalled(stalled: boolean): void {
    this.stalled = stalled;
    if (!stalled) this.wake();
  }

  /** Sounds waiting for the context (they play when it runs). */
  get waiting(): number {
    return this.pending.length;
  }

  /**
   * The context runs again (or for the first time): what was asked for meanwhile plays now, each
   * at the moment it was due (a reload's later steps keep their places), unless it's too late.
   */
  wake(): void {
    if (!this.running || this.pending.length === 0) return;
    const list = this.pending;
    this.pending = [];
    const now = this.clock();
    for (const p of list) {
      if (p.voice.cancelled) continue;
      const waited = Math.max(0, (now - p.at) / 1000);
      const due = (p.o.delay ?? 0) - waited;
      if (due < -PENDING_LATE) {
        this.counters.late++;
        continue;
      }
      p.voice.real = this.start(p.id, { ...p.o, delay: Math.max(0, due) }, null);
    }
  }

  /** Holds a sound until the context runs (null: it won't: closed, or the tab is hidden). */
  private hold(id: SoundId, o: PlayOptions): Voice | null {
    if (this.hidden || this.ctx.state === 'closed') return null;
    const def = SOUNDS[id];
    const voice: HeldVoice = {
      id,
      priority: (def.priority ?? 50) + (o.priority ?? 0),
      startedAt: this.now + Math.max(0, o.delay ?? 0),
      cancelled: false,
      real: null,
      get ended() {
        return voice.cancelled || (voice.real?.ended ?? false);
      },
      stop: (fade?: number) => {
        voice.cancelled = true;
        voice.real?.stop(fade);
      },
    };
    this.pending.push({ id, o, at: this.clock(), voice });
    if (this.pending.length > MAX_PENDING) this.pending.shift();
    this.counters.held++;
    return voice;
  }

  /** Where a bus's voices connect (the music scheduler's oscillators use it). */
  input(bus: Bus): AudioNode {
    return this.inputs[bus];
  }

  // ---------------------------------------------------------------- settings

  setVolumes(v: Volumes): void {
    this.volumes = { ...v };
    const t = this.now;
    for (const k of ['master', 'sfx', 'music', 'ui', 'voice'] as const) {
      const p = this.buses[k].gain;
      p.cancelScheduledValues(t);
      p.setTargetAtTime(volumeToGain(v[k]), t, 0.03);
    }
  }

  /** "Soften loud bursts" (Settings → Accessibility). */
  setSoft(on: boolean): void {
    this.soft = on;
    const l = this.limiter;
    // a limiter at the end either way; softer: it starts earlier and holds harder
    l.threshold.value = on ? -20 : -8;
    l.knee.value = on ? 12 : 6;
    l.ratio.value = on ? 12 : 8;
    l.attack.value = 0.002;
    l.release.value = 0.2;
    this.big.gain.value = on ? 0.6 : 1;
  }

  /** The tab went into the background (or came back): fade out and pause the context, or resume. */
  setHidden(hidden: boolean): void {
    if (hidden === this.hidden) return;
    this.hidden = hidden;
    const t = this.now;
    const g = this.hiddenGain.gain;
    g.cancelScheduledValues(t);
    g.setTargetAtTime(hidden ? 0 : 1, t, hidden ? 0.03 : 0.05);
    if (this.suspendTimer) clearTimeout(this.suspendTimer);
    this.suspendTimer = 0;
    // nothing held for the background plays when the player comes back
    if (hidden) this.pending = [];
    if (hidden) {
      this.suspendTimer = setTimeout(() => {
        this.suspendTimer = 0;
        if (this.hidden && this.ctx.state === 'running') void this.ctx.suspend().catch(() => {});
      }, 250);
    } else if (this.ctx.state !== 'running' && this.ctx.state !== 'closed') void this.ctx.resume().catch(() => {});
  }

  get isHidden(): boolean {
    return this.hidden;
  }

  /** Headphones (Settings → Audio): HRTF panning for world sounds from now on. */
  setHrtf(on: boolean): void {
    this.hrtf = on && typeof this.ctx.createPanner === 'function';
  }

  /** Where the listener stands, 0 open … 1 under cover: the space's character follows, slowly. */
  setEnclosure(e: number): void {
    const v = Math.min(1, Math.max(0, e));
    if (Math.abs(v - this.enclosure) < 0.02) return;
    this.enclosure = v;
    const t = this.now;
    this.spaceOpen?.gain.setTargetAtTime(0.55 * (1 - v * 0.8), t, 0.4);
    this.spaceCover?.gain.setTargetAtTime(0.7 * v, t, 0.4);
  }

  // ---------------------------------------------------------------- big moments

  /** Your own gun dips a little (by `depth`, 0…1) under a close incoming threat, so it reads. */
  duckOwn(depth = 0.35, hold = 0.25): void {
    const t = this.now;
    const p = this.ownGain.gain;
    p.cancelScheduledValues(t);
    p.setTargetAtTime(Math.min(p.value, 1 - Math.min(0.6, depth)), t, 0.01);
    p.setTargetAtTime(1, t + hold, 0.2);
  }

  /**
   * Ducks the world, music and voices under a blast: down by `depth` (0…1) at once, back over
   * about `hold` + 0.6 s. Blasts themselves (the "big" bus) aren't ducked.
   */
  duck(depth: number, hold = 0.15): void {
    const d = Math.min(0.85, Math.max(0, depth)) * (this.soft ? 0.6 : 1);
    if (d <= 0.01) return;
    const t = this.now;
    for (const node of [this.duckSfx, this.duckMusic, this.duckVoice]) {
      const p = node.gain;
      const target = 1 - d * (node === this.duckSfx ? 1 : 0.7);
      p.cancelScheduledValues(t);
      p.setTargetAtTime(Math.min(target, p.value), t, 0.012);
      p.setTargetAtTime(1, t + hold, 0.25);
    }
  }

  /** Muffles the world (a flashbang's deafness): amount 0…1, recovering over `seconds`. */
  muffle(amount: number, seconds: number): void {
    const a = Math.min(1, Math.max(0, amount));
    if (a <= 0.01) return;
    const t = this.now;
    const f = this.muffler.frequency;
    f.cancelScheduledValues(t);
    f.setTargetAtTime(20000 * Math.pow(500 / 20000, a), t, 0.01);
    f.setTargetAtTime(20000, t + seconds * 0.3, seconds * 0.35);
  }

  // ---------------------------------------------------------------- voices

  /**
   * Plays a sound once. Returns its voice, or null when it wasn't played (too far, a limit, a
   * cooldown, a hidden tab). While the context isn't running yet it waits, and plays when it does.
   */
  play(id: SoundId, o: PlayOptions = {}): Voice | null {
    if (this.pending.length) this.wake();
    if (!this.running) return this.hold(id, o);
    return this.start(id, o, null);
  }

  /**
   * Starts a loop under `key`, or updates the one playing (position, gain, rate). Loops stop with
   * stopLoop; the director stops those it no longer refreshes.
   */
  loop(key: string, id: SoundId, o: PlayOptions = {}): void {
    const rec = this.loops.get(key);
    if (rec && !rec.voice.ended && rec.voice.id === id) {
      this.place(rec.voice, id, o, true);
      return;
    }
    if (rec) this.stopLoop(key, 0.05);
    this.start(id, o, key);
  }

  stopLoop(key: string, fade = 0.15): void {
    const rec = this.loops.get(key);
    if (!rec) return;
    this.loops.delete(key);
    rec.voice.stop(fade);
  }

  /** The keys of the loops playing now. */
  loopKeys(): string[] {
    return [...this.loops.keys()];
  }

  /** Voices playing now (scheduled ones too). */
  activeVoices(id?: SoundId): number {
    this.reap();
    return id ? this.voices.filter((v) => v.id === id).length : this.voices.length;
  }

  stopAll(fade = 0.1): void {
    for (const p of this.pending) p.voice.cancelled = true;
    this.pending = [];
    for (const key of [...this.loops.keys()]) this.stopLoop(key, fade);
    for (const v of [...this.voices]) v.stop(fade);
  }

  private start(id: SoundId, o: PlayOptions, loopKey: string | null): VoiceRec | null {
    if (!this.running) return null;
    const def = SOUNDS[id];
    const now = this.now;
    const spot = this.spot(id, o);
    if (!spot) return null;
    // far away, the report arrives late (the speed of sound, capped so play never feels laggy)
    const travel = spot.positional && !loopKey && spot.d > 6 ? Math.min(MAX_SOUND_DELAY, spot.d / SPEED_OF_SOUND) : 0;
    const when = now + Math.max(0, o.delay ?? 0) + travel;
    // the same sound again too soon (an SMG's pellets of one burst, a dozen footsteps)
    const cooldown = def.cooldown ?? 0.02;
    const last = this.lastStart.get(id);
    if (!loopKey && last !== undefined && Math.abs(when - last) < cooldown) {
      this.counters.cooled++;
      return null;
    }
    // near and far: past `farFrom` a shot or a blast also plays its far layer (a low report, a
    // rumble), which takes over as the near one thins out
    let o2 = o;
    if (def.far && spot.positional && !loopKey && !o.noFar) {
      const f = farMix(spot.d, def.farFrom, def.farTo);
      if (f > 0.04) {
        this.start(def.far as SoundId, { ...o, gain: (o.gain ?? 1) * f, noFar: true, delay: Math.max(0, o.delay ?? 0) }, null);
        o2 = { ...o, gain: (o.gain ?? 1) * (1 - 0.8 * f) };
      }
    }
    const priority = (def.priority ?? 50) + (o.priority ?? 0) - spot.d * 0.4;
    this.reap();
    // this sound's own cap: its oldest voice makes room
    const same = this.voices.filter((v) => v.id === id && !v.loopKey);
    const cap = def.maxVoices ?? 4;
    if (!loopKey && same.length >= cap) {
      same.sort((a, b) => a.startedAt - b.startedAt)[0]!.stop(0.02);
      this.counters.stolen++;
    }
    // the engine's cap: the least important (then the oldest) goes, if it matters less than this one
    if (this.voices.length >= this.maxVoices) {
      let victim: VoiceRec | null = null;
      for (const v of this.voices) if (!victim || v.priority < victim.priority || (v.priority === victim.priority && v.startedAt < victim.startedAt)) victim = v;
      if (!victim || victim.priority > priority) {
        this.counters.refused++;
        return null;
      }
      if (victim.loopKey) this.loops.delete(victim.loopKey);
      victim.stop(0.02);
      this.counters.stolen++;
    }
    const buffer = this.buffer(id, o.variant !== undefined ? o.variant % variantsOf(id) : Math.floor(this.random() * variantsOf(id)));
    if (!buffer) return null;
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.loop = !!loopKey;
    const gain = ctx.createGain();
    const panner = this.makePanner(spot.positional || o.pan !== undefined);
    const world = def.bus === 'sfx' || def.bus === 'big';
    const filter = (world && spot.positional && (loopKey || spot.d > 10 || spot.occl > 0)) || (o.far ?? 0) > 0 ? ctx.createBiquadFilter() : null;
    let node: AudioNode = src;
    node = node.connect(gain);
    if (filter) {
      filter.type = 'lowpass';
      node = node.connect(filter);
    }
    if (panner) node = node.connect(panner);
    node.connect(o.to ?? (o.own && def.bus === 'sfx' ? this.ownGain : this.inputs[def.bus]));
    let send: GainNode | null = null;
    if (this.space && !o.to && world) {
      send = ctx.createGain();
      node.connect(send).connect(this.space);
    }
    const voice: VoiceRec = {
      id,
      priority,
      startedAt: when,
      src,
      gain,
      filter,
      panner,
      send,
      ended: false,
      loopKey,
      stop: (fade = 0.03) => this.stopVoice(voice, fade),
    };
    src.onended = () => this.finish(voice);
    this.place(voice, id, o2, false, spot);
    const jitter = def.pitchJitter ?? 0.03;
    src.playbackRate.value = (o.rate ?? 1) * (1 + (this.random() * 2 - 1) * jitter);
    if (loopKey) {
      // loops fade in and start at a random point, so two never phase together
      const target = gain.gain.value;
      gain.gain.value = 0;
      gain.gain.setTargetAtTime(target, when, 0.03);
      src.start(when, this.random() * buffer.duration);
      this.loops.set(loopKey, { voice });
    } else {
      src.start(when);
      this.lastStart.set(id, when);
    }
    this.voices.push(voice);
    this.counters.played++;
    return voice;
  }

  /** Headphones: an HRTF panner; speakers: equal-power stereo; none when the browser has neither. */
  private makePanner(placed: boolean): StereoPannerNode | PannerNode | null {
    const ctx = this.ctx;
    if (placed && this.hrtf) {
      const p = ctx.createPanner();
      p.panningModel = 'HRTF';
      // the engine sets the level by distance itself: the panner only places the sound
      p.distanceModel = 'linear';
      p.refDistance = 1;
      p.maxDistance = 10000;
      p.rolloffFactor = 0;
      return p;
    }
    return typeof ctx.createStereoPanner === 'function' ? ctx.createStereoPanner() : null;
  }

  /** Where a sound is for the listener, or null when it's out of its range. */
  private spot(id: SoundId, o: PlayOptions): Spot | null {
    const def = SOUNDS[id];
    const far = o.far ?? 0;
    if (o.x === undefined || o.y === undefined || !this.listener) return { positional: false, dx: 0, dy: 0, d: far, pan: o.pan ?? 0, level: far > 0 ? distanceGain(far, def.range ?? 50) : 1, occl: 0 };
    const dx = o.x - this.listener.x;
    const dy = o.y - this.listener.y;
    const d = Math.sqrt(dx * dx + dy * dy) + far;
    let level = distanceGain(d, def.range ?? 50);
    if (level <= 0) return null;
    const world = def.bus === 'sfx' || def.bus === 'big' || def.bus === 'voice';
    const occl = world && this.occluder && d > 1.5 ? Math.min(2, this.occluder(o.x, o.y)) : 0;
    level *= OCCLUSION_GAIN[occl as 0 | 1 | 2];
    const pan = o.pan ?? Math.max(-1, Math.min(1, dx / PAN_SPAN)) * 0.85;
    return { positional: true, dx, dy, d, pan, level, occl };
  }

  /** Sets a voice's gain, pan (or 3D position) and filter for where it is now. */
  private place(voice: VoiceRec, id: SoundId, o: PlayOptions, smooth: boolean, known?: Spot): void {
    const def = SOUNDS[id];
    const s = known ?? this.spot(id, o);
    const t = this.now;
    let g = (def.gain ?? 1) * (o.gain ?? 1) * (s?.level ?? 0);
    if (this.soft) g *= def.soft ?? 1;
    // many of the same at once: each a little quieter, so a crowd doesn't clip
    const crowd = this.voices.filter((v) => v.id === id && !v.ended).length;
    g /= Math.sqrt(1 + 0.25 * crowd);
    const set = (p: AudioParam, v: number) => (smooth ? p.setTargetAtTime(v, t, 0.05) : (p.value = v));
    // no two shots alike: a little level jitter on each one-shot
    if (!smooth && !voice.loopKey) g *= 0.88 + this.random() * 0.17;
    // the space: drier up close, wetter far away and behind walls
    if (voice.send && s) set(voice.send.gain, (def.wet ?? (def.loop ? 0.1 : 0.22)) * (0.45 + Math.min(1.2, s.d / 30) + 0.35 * s.occl));
    if (smooth) {
      voice.gain.gain.setTargetAtTime(g, t, 0.05);
      if (o.rate !== undefined) voice.src.playbackRate.setTargetAtTime(o.rate, t, 0.05);
    } else voice.gain.gain.value = g;
    if (voice.panner && s) {
      if ('pan' in voice.panner) set(voice.panner.pan, s.pan);
      else {
        // HRTF: about 16 m to the side is well round to that ear; above and below by height
        const [x, y, z] = s.positional ? [Math.max(-6, Math.min(6, s.dx * 0.25)), Math.max(-4, Math.min(4, s.dy * 0.25)), -1.5] : [s.pan * 3, 0, -1.5];
        const p = voice.panner;
        if (p.positionX) {
          set(p.positionX, x);
          set(p.positionY, y);
          set(p.positionZ, z);
        } else (p as PannerNode & { setPosition(x: number, y: number, z: number): void }).setPosition(x, y, z);
      }
    }
    if (voice.filter && s) set(voice.filter.frequency, Math.min(distanceCutoff(s.d), OCCLUSION_CUTOFF[s.occl as 0 | 1 | 2]));
  }

  private stopVoice(voice: VoiceRec, fade: number): void {
    if (voice.ended) return;
    const t = this.now;
    try {
      voice.gain.gain.cancelScheduledValues(t);
      voice.gain.gain.setTargetAtTime(0, t, Math.max(0.005, fade / 3));
      voice.src.stop(t + Math.max(0.01, fade));
    } catch {
      /* already stopped */
    }
    // it no longer counts against the limits (its fade-out still plays)
    this.finish(voice);
  }

  private finish(voice: VoiceRec): void {
    if (voice.ended) return;
    voice.ended = true;
    const i = this.voices.indexOf(voice);
    if (i >= 0) this.voices.splice(i, 1);
    if (voice.loopKey && this.loops.get(voice.loopKey)?.voice === voice) this.loops.delete(voice.loopKey);
    // disconnect once it has had time to fade
    setTimeout(() => {
      try {
        voice.src.disconnect();
        voice.gain.disconnect();
        voice.filter?.disconnect();
        voice.panner?.disconnect();
        voice.send?.disconnect();
      } catch {
        /* gone */
      }
    }, 500);
  }

  /** Drops voices whose buffers have run out (onended can lag a frame). */
  private reap(): void {
    const t = this.now;
    for (const v of [...this.voices]) {
      if (v.loopKey || v.ended) continue;
      const b = v.src.buffer;
      if (b && t > v.startedAt + b.duration / Math.max(0.05, v.src.playbackRate.value) + 0.05) this.finish(v);
    }
  }

  // ---------------------------------------------------------------- buffers

  /** A variant's AudioBuffer, rendered now if it hasn't been. */
  buffer(id: SoundId, variant: number): AudioBuffer | null {
    let list = this.buffers.get(id);
    if (!list) this.buffers.set(id, (list = []));
    const have = list[variant];
    if (have) return have;
    try {
      const chans = this.render(id, variant, BANK_RATE);
      const b = this.ctx.createBuffer(chans.length, chans[0]!.length, BANK_RATE);
      chans.forEach((c, i) => b.getChannelData(i).set(c));
      list[variant] = b;
      return b;
    } catch (e) {
      console.warn(`audio: couldn't render ${id}`, e);
      return null;
    }
  }

  /** Renders these sounds' variants ahead of time, a few at a time while the page is idle. */
  warm(ids: readonly SoundId[]): void {
    for (const id of ids) for (let v = 0; v < variantsOf(id); v++) if (!this.buffers.get(id)?.[v]) this.warmQueue.push([id, v]);
    this.scheduleWarm();
  }

  private scheduleWarm(): void {
    if (this.warmTimer || this.warmQueue.length === 0) return;
    const step = (): void => {
      this.warmTimer = 0;
      const until = performance.now() + 6;
      while (this.warmQueue.length && performance.now() < until) {
        const [id, v] = this.warmQueue.shift()!;
        this.buffer(id, v);
      }
      this.scheduleWarm();
    };
    const idle = (globalThis as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }).requestIdleCallback;
    this.warmTimer = idle ? idle(step, { timeout: 500 }) : (setTimeout(step, 30) as unknown as number);
  }

  /** Memory held by rendered buffers (bytes) and how many there are. */
  memory(): { buffers: number; bytes: number; seconds: number } {
    let buffers = 0;
    let bytes = 0;
    let seconds = 0;
    for (const list of this.buffers.values())
      for (const b of list)
        if (b) {
          buffers++;
          bytes += b.length * b.numberOfChannels * 4;
          seconds += b.duration;
        }
    return { buffers, bytes, seconds };
  }
}

/**
 * An outdoor impulse response: a few early reflections off nearby walls, then a diffuse tail that
 * darkens as it decays (the highs die first), slightly different left and right.
 */
export function makeImpulse(ctx: BaseAudioContext, seconds: number, random: () => number = Math.random, cover = false): AudioBuffer {
  const sr = ctx.sampleRate;
  const n = Math.max(1, Math.round(sr * seconds));
  const b = ctx.createBuffer(2, n, sr);
  for (let c = 0; c < 2; c++) {
    const d = b.getChannelData(c);
    let lp = 0;
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      // the cutoff falls from bright to dull across the tail: a one-pole whose coefficient grows
      const k = cover ? Math.min(0.9, 0.05 + t * 0.9) : Math.min(0.97, 0.2 + t * 0.6);
      lp = lp * k + (random() * 2 - 1) * (1 - k);
      const env = Math.exp(-t * (6.9 / seconds)) * Math.min(1, t / 0.012);
      d[i] = lp * env * 2.2;
    }
    // early reflections: walls and the ground (under cover: close walls and a ceiling, dense)
    const taps: readonly (readonly [number, number])[] = cover
      ? [
          [3, 0.7],
          [6, 0.55],
          [9, 0.5],
          [13, 0.4],
          [17, 0.35],
          [22, 0.3],
          [29, 0.22],
        ]
      : [
          [7, 0.5],
          [19, 0.35],
          [31, 0.3],
          [47, 0.22],
          [73, 0.16],
        ];
    for (const [ms, g] of taps) {
      const at = Math.round(((ms + random() * 4 + c * 2) / 1000) * sr);
      if (at < n) d[at]! += (random() < 0.5 ? -1 : 1) * g;
    }
  }
  return b;
}

