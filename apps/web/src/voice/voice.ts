/**
 * Voice chat (the owner's "audio support", 23 Oct; protocol v18, docs/05 §17): talk to the soldiers
 * near you, your party and (in team modes) your team, over the game's own connection. No other
 * server, port or service: the game server relays the frames (apps/game-server voice.ts) and decides
 * who hears whom from where the soldiers stand.
 *
 * Talking: push to talk by default (hold V, the controller's talk button, or the phone's mic button,
 * which slides up to lock hands-free), or an open mic behind a noise gate. B talks to your party.
 * Hearing: proximity voices play at the speaker's soldier through the game's 3D sound (falloff from
 * the admin's numbers, walls muffle, headphones mode places them by ear); party and lobby voices are
 * flat; team radio gets a radio filter. A fallen soldier's last words come from where they fell.
 *
 * Every link, not just 4G: quality follows the connection (Auto) or stays at the lowest (Data saver).
 *   saver  16 kbps Opus · 60 ms frames  (weak or lossy links, Data saver)
 *   normal 24 kbps Opus · 40 ms frames
 *   high   40 kbps Opus · 20 ms frames  (Wi-Fi, 5G: low RTT, no loss)
 * Under loss (≥ 3 %) each packet also carries the previous frame (packet-level FEC); the receiver
 * fills a gap with it, and covers anything still missing (playout.ts).
 */
import { VOICE } from '@military-forge/content';
import {
  MsgType,
  PEER_PARTY,
  VoiceChannel,
  VoiceCodec,
  VoiceRoute,
  decodeVoiceDown,
  decodeVoiceState,
  encodeVoiceUp,
  type VoiceChannelId,
  type VoiceDown,
  type VoiceRouteId,
  type VoiceSettingsCmd,
} from '@military-forge/protocol';
import { createStore } from 'zustand/vanilla';
import type { Frame } from '../view';
import { MicCapture, type MicState } from './capture';

/** The microphone as the voice uses it (capture.ts; tests pass a stand-in). */
export interface Mic {
  readonly state: MicState;
  start(volume?: number): Promise<MicState>;
  stop(): void;
  setVolume(v: number): void;
}
import { OpusDecoder, OpusEncoder, SAMPLE_RATE, adpcmDecode, adpcmEncode, dbfs, detectCodecs, levelOf, type CodecSupport } from './codec';
import { Playout } from './playout';
import { voiceSettings, type VoiceSettings } from './settings';

/** What the voice needs from the online game (onlineMode.ts). */
export interface VoiceLink {
  readonly localId: number;
  /** names by player id (the roster) */
  readonly playerNames: ReadonlyMap<number, string>;
  sendVoice(bytes: Uint8Array): void;
  sendVoiceSettings(json: string): void;
  /** VOICE_DOWN and VOICE_STATE come here; returns the stop */
  onVoice(fn: (bytes: Uint8Array) => void): () => void;
  /** after every WELCOME (a join, a reconnect): the voice settings go again */
  onConnected(fn: () => void): () => void;
}

/** What the voice plays through: the game's sound engine (audio/engine.ts), or a context of its own. */
export interface VoiceOutput {
  readonly ctx: AudioContext;
  /** where voices go (the master bus: the master volume applies) */
  readonly destination: AudioNode;
  /** headphones: HRTF panning */
  readonly hrtf: boolean;
  /** walls between the listener and a point (0, 1, 2+), when the map's acoustics are known */
  readonly occluder: ((x: number, y: number) => number) | null;
}

export type Tier = 'saver' | 'normal' | 'high';

export const TIERS: Readonly<Record<Tier, { bitrate: number; frameMs: 20 | 40 | 60 }>> = {
  saver: { bitrate: 16_000, frameMs: 60 },
  normal: { bitrate: 24_000, frameMs: 40 },
  high: { bitrate: 40_000, frameMs: 20 },
};

/** Link quality → tier (Auto), from the game connection's own numbers and the browser's hints. */
export function chooseTier(q: { setting: 'auto' | 'saver'; rttMs: number; lossPct: number; transport?: string | undefined; saveData?: boolean | undefined; effectiveType?: string | undefined; downlinkMbps?: number | undefined }): Tier {
  if (q.setting === 'saver' || q.saveData) return 'saver';
  if (q.effectiveType === 'slow-2g' || q.effectiveType === '2g' || q.effectiveType === '3g') return 'saver';
  if (q.lossPct >= 5 || q.rttMs >= 250) return 'saver';
  const fast = q.rttMs > 0 && q.rttMs < 90 && q.lossPct < 1 && (q.downlinkMbps === undefined || q.downlinkMbps >= 5);
  return fast ? 'high' : 'normal';
}

/** A voice we're hearing: its loudness for the rings, how it reached us, and when it last spoke. */
export interface Speaking {
  level: number;
  route: VoiceRouteId;
  lastWords: boolean;
  at: number;
}

export interface VoiceState {
  /** in an online room with voice on */
  active: boolean;
  mic: MicState;
  support: CodecSupport | null;
  /** we're sending now */
  talking: boolean;
  /** what we're sending on */
  channel: VoiceChannelId;
  /** the phone's hands-free lock */
  locked: boolean;
  /** our own loudness while talking, 0-15 */
  level: number;
  /** others' flags from VOICE_STATE (PEER_*), by player id */
  peers: Readonly<Record<number, number>>;
  /** who's talking to us now, by player id */
  speaking: Readonly<Record<number, Speaking>>;
  /** the room talks in the fallback codec */
  fallback: boolean;
  /** players we muted (this room only) */
  mutes: readonly number[];
  tier: Tier;
}

const SPEAKING_MS = 300;
const IDLE_SPEAKER_MS = 3000;
/** the open mic stays open this long after the voice drops under the gate */
const GATE_HANG_MS = 300;

interface Speaker {
  id: number;
  playout: Playout;
  input: GainNode;
  route: VoiceRouteId | -1;
  /** the route's own nodes (rebuilt when the route changes) */
  nodes: AudioNode[];
  panner: PannerNode | StereoPannerNode | null;
  distance: GainNode | null;
  muffle: BiquadFilterNode | null;
  opus: OpusDecoder | null;
  lastSeq: number;
  lastAt: number;
  /** last known world position (a speaker out of view keeps its last one) */
  x: number;
  y: number;
}

export class VoiceChat {
  readonly store = createStore<VoiceState>(() => ({
    active: false,
    mic: 'off',
    support: null,
    talking: false,
    channel: VoiceChannel.Near,
    locked: false,
    level: 0,
    peers: {},
    speaking: {},
    fallback: false,
    mutes: [],
    tier: 'normal',
  }));
  private link: VoiceLink | null = null;
  private offLink: (() => void)[] = [];
  private readonly mic: Mic;
  private encoder: OpusEncoder | null = null;
  /** the metadata of each frame given to the Opus encoder, in order (its output keeps that order) */
  private readonly pending: { level: number; channel: VoiceChannelId; frameMs: 20 | 40 | 60 }[] = [];
  private seq = 0;
  private prevFrame: Uint8Array | null = null;
  private accum: Float32Array[] = [];
  private accumLevel = 0;
  private gateUntil = 0;
  private held = { key: false, pad: false, touch: false, party: false };
  private readonly speakers = new Map<number, Speaker>();
  private out: VoiceOutput | null = null;
  private chatBus: GainNode | null = null;
  private lossPct = 0;
  private settings: VoiceSettings = voiceSettings.getState();
  /** keyboard codes for push to talk (Settings › Controls: Talk) and party talk */
  talkKeys: readonly string[] = ['KeyV'];
  partyKeys: readonly string[] = ['KeyB'];
  /** controller buttons for push to talk */
  padButtons: readonly number[] = [];
  /** menus over the game take the keyboard (a text field, the menu): no push to talk then */
  blocked = false;
  /** how long a voice still counts as talking after its last frame (ms; screenshot scripts stretch it) */
  speakingHoldMs = SPEAKING_MS;
  /** frames sent and heard since the page opened (the net graph, the e2e check) */
  readonly counters = { sent: 0, heard: 0, opusFrames: 0, fallbackFrames: 0 };
  /** the speaking tags over soldiers (tags.ts), set by the app (none in tests) */
  tags: { update(f: Frame | null, st: VoiceState, toScreen: ((x: number, y: number) => { x: number; y: number }) | null, name: (id: number) => string): void } | null = null;

  constructor(
    /** the sound engine, once the page has one (after the first tap) */
    private readonly output: () => VoiceOutput | null,
    private readonly win: Pick<Window, 'addEventListener'> | null = typeof window === 'undefined' ? null : window,
    makeMic: (onFrame: (pcm: Float32Array) => void, onState: (s: MicState) => void) => Mic = (f, s) => new MicCapture(f, s),
    detect: () => Promise<CodecSupport> = () => detectCodecs(),
  ) {
    this.mic = makeMic(
      (pcm) => this.onMicFrame(pcm),
      (mic) => this.set({ mic }),
    );
    voiceSettings.subscribe((s) => this.applySettings(s));
    this.win?.addEventListener('keydown', (e) => this.onKey(e as KeyboardEvent, true));
    this.win?.addEventListener('keyup', (e) => this.onKey(e as KeyboardEvent, false));
    this.win?.addEventListener('blur', () => this.release());
    void detect().then((support) => {
      this.set({ support });
      this.sendSettings();
    });
  }

  private set(p: Partial<VoiceState>): void {
    this.store.setState(p);
  }

  get state(): VoiceState {
    return this.store.getState();
  }

  // ---------------------------------------------------------------- the room

  /** The online game to talk in (null: none, e.g. training or the menus). */
  attach(link: VoiceLink | null): void {
    if (link === this.link) return;
    for (const off of this.offLink) off();
    this.offLink = [];
    this.link = link;
    this.release();
    this.closeSpeakers();
    this.set({ active: !!link && this.settings.enabled, peers: {}, speaking: {}, mutes: [], fallback: false, locked: false });
    if (!link) {
      this.mic.stop();
      return;
    }
    this.offLink.push(link.onVoice((b) => this.onWire(b)));
    this.offLink.push(link.onConnected(() => this.sendSettings()));
    this.sendSettings();
  }

  private applySettings(s: VoiceSettings): void {
    const was = this.settings;
    this.settings = s;
    this.mic.setVolume(s.micVolume);
    if (this.chatBus) this.chatBus.gain.value = s.chatVolume;
    if (!s.enabled) {
      this.release();
      this.mic.stop();
      this.closeSpeakers();
    }
    this.set({ active: !!this.link && s.enabled });
    // open mic opens the mic now; push to talk waits for the key
    if (was.mode !== s.mode || was.enabled !== s.enabled) this.updateTalking();
    if (was.enabled !== s.enabled || was.proximity !== s.proximity || was.hearOpponents !== s.hearOpponents) this.sendSettings();
  }

  /** The Voice CMD: our whole voice state (the server sends us nothing we turned off). */
  private sendSettings(): void {
    if (!this.link) return;
    const st = this.state;
    const cmd: VoiceSettingsCmd = {
      on: this.settings.enabled,
      mic: this.settings.enabled && st.mic === 'live',
      opus: st.support?.opusDecode ?? false,
      proximity: this.settings.proximity,
      hearOpponents: this.settings.hearOpponents,
      mute: [...st.mutes],
    };
    this.link.sendVoiceSettings(JSON.stringify(cmd));
  }

  private testing = false;

  /** Settings' Test mic: asks for the mic (a tap) and shows its level. */
  async testMic(): Promise<void> {
    this.testing = true;
    await this.mic.start(this.settings.micVolume);
    this.sendSettings();
  }

  /** Settings closed: outside a room the mic goes off again. */
  endTest(): void {
    this.testing = false;
    if (!this.link) {
      this.mic.stop();
      this.set({ level: 0 });
    }
  }

  /** Mute (or unmute) one player for yourself, for this room. */
  setMuted(id: number, muted: boolean): void {
    const mutes = new Set(this.state.mutes);
    if (muted) mutes.add(id);
    else mutes.delete(id);
    this.set({ mutes: [...mutes] });
    if (muted) this.dropSpeaker(id);
    this.sendSettings();
  }

  // ---------------------------------------------------------------- talking

  private onKey(e: KeyboardEvent, down: boolean): void {
    if (e.repeat) return;
    const party = this.partyKeys.includes(e.code);
    if (!party && !this.talkKeys.includes(e.code)) return;
    if (down) {
      const t = e.target as HTMLElement | null;
      if (this.blocked || t?.closest?.('input, textarea, select, [contenteditable="true"]')) return;
    }
    if (party) this.held.party = down;
    else this.held.key = down;
    this.updateTalking();
  }

  /** The phone's mic button: down / up; a slide up locks it on until the next tap. */
  touchDown(): void {
    if (this.state.locked) {
      this.set({ locked: false });
      this.held.touch = false;
    } else this.held.touch = true;
    this.updateTalking();
  }

  touchUp(): void {
    if (!this.state.locked) this.held.touch = false;
    this.updateTalking();
  }

  lock(): void {
    this.held.touch = true;
    this.set({ locked: true });
    this.updateTalking();
  }

  /** Lets go of every push-to-talk (the page lost focus, a menu took the keys). */
  release(): void {
    this.held = { key: false, pad: false, touch: false, party: false };
    this.set({ locked: false });
    this.updateTalking();
  }

  private pttHeld(): boolean {
    return this.held.key || this.held.pad || this.held.touch || this.held.party;
  }

  private updateTalking(): void {
    const want = this.settings.enabled && !!this.link && (this.settings.mode === 'open' || this.pttHeld());
    if (want && this.state.mic !== 'live' && this.state.mic !== 'denied' && this.state.mic !== 'unavailable') {
      // the first press asks for the mic (a tap: browsers want one)
      void this.mic.start(this.settings.micVolume).then(() => this.sendSettings());
    }
    const channel = this.held.party ? VoiceChannel.Party : VoiceChannel.Near;
    const talking = this.settings.mode === 'ptt' ? want && this.pttHeld() && this.state.mic === 'live' : this.state.talking;
    if (this.settings.mode === 'ptt' && !talking) this.flush();
    this.set({ talking: this.settings.mode === 'ptt' ? talking : this.state.talking, channel });
  }

  /** 20 ms from the mic: pass it through the gate (open mic) and on to the encoder. */
  private onMicFrame(pcm: Float32Array): void {
    if (!this.link || !this.settings.enabled) {
      // Settings' Test mic: the meter moves, nothing is sent
      if (this.testing) this.set({ level: levelOf(pcm) });
      return;
    }
    const now = performance.now();
    let talking: boolean;
    if (this.settings.mode === 'open') {
      if (dbfs(pcm) > this.settings.gateDb) this.gateUntil = now + GATE_HANG_MS;
      talking = now < this.gateUntil || (this.pttHeld() && this.held.party);
    } else talking = this.pttHeld();
    const level = levelOf(pcm);
    if (talking !== this.state.talking || (talking && Math.abs(level - this.state.level) > 1)) this.set({ talking, level: talking ? level : 0 });
    if (!talking) {
      this.flush();
      return;
    }
    this.accum.push(pcm);
    this.accumLevel = Math.max(this.accumLevel, level);
    const { frameMs } = TIERS[this.state.tier];
    if (this.accum.length * 20 >= frameMs) this.encodeFrame(frameMs);
  }

  /** Whatever is half-gathered is dropped when talking stops (a 20-40 ms tail). */
  private flush(): void {
    this.accum = [];
    this.accumLevel = 0;
    this.prevFrame = null;
  }

  private useOpus(): boolean {
    return !!this.state.support?.opusEncode && !this.state.fallback;
  }

  private encodeFrame(frameMs: 20 | 40 | 60): void {
    const n = (SAMPLE_RATE * frameMs) / 1000;
    const pcm = new Float32Array(n);
    let at = 0;
    for (const f of this.accum) {
      pcm.set(f.subarray(0, Math.min(f.length, n - at)), at);
      at += f.length;
    }
    const level = this.accumLevel;
    const channel = this.state.channel;
    this.accum = [];
    this.accumLevel = 0;
    if (this.useOpus()) {
      if (!this.encoder) {
        try {
          this.encoder = new OpusEncoder(
            (bytes) => this.sendFrame(VoiceCodec.Opus, bytes),
            () => {
              this.encoder?.close();
              this.encoder = null;
              this.pending.length = 0;
            },
          );
        } catch {
          this.set({ support: { opusEncode: false, opusDecode: this.state.support?.opusDecode ?? false } });
          return;
        }
      }
      this.encoder.configure(TIERS[this.state.tier].bitrate, frameMs);
      this.pending.push({ level, channel, frameMs });
      this.encoder.encode(pcm);
    } else {
      this.pending.push({ level, channel, frameMs });
      this.sendFrame(VoiceCodec.Adpcm, adpcmEncode(pcm));
    }
  }

  private sendFrame(codec: 0 | 1, frame: Uint8Array): void {
    const meta = this.pending.shift();
    if (!meta || !this.link) return;
    // under loss the previous frame rides along (the receiver fills a gap with it)
    const redundant = this.lossPct >= 3 && this.prevFrame && this.prevFrame.length <= 255 ? this.prevFrame : null;
    const bytes = encodeVoiceUp({ seq: this.seq, codec, channel: meta.channel, level: meta.level, frameMs: meta.frameMs, frame, redundant });
    this.seq = (this.seq + 1) & 0xffff;
    this.prevFrame = frame;
    this.counters.sent++;
    this.link.sendVoice(bytes);
  }

  // ---------------------------------------------------------------- hearing

  private onWire(bytes: Uint8Array): void {
    if (bytes[0] === MsgType.VoiceState) {
      try {
        const st = decodeVoiceState(bytes);
        const peers: Record<number, number> = {};
        for (const p of st.peers) peers[p.id] = p.flags;
        const wasFallback = this.state.fallback;
        this.set({ peers, fallback: st.fallback });
        if (st.fallback !== wasFallback) {
          // the room switched codecs: start the encoder over (frames in flight are dropped)
          this.encoder?.close();
          this.encoder = null;
          this.pending.length = 0;
        }
      } catch {
        /* a bad one: keep the last */
      }
      return;
    }
    if (bytes[0] !== MsgType.VoiceDown) return;
    let v: VoiceDown;
    try {
      v = decodeVoiceDown(bytes);
    } catch {
      return;
    }
    if (this.state.mutes.includes(v.speaker) || !this.settings.enabled) return;
    this.counters.heard++;
    if (v.codec === VoiceCodec.Opus) this.counters.opusFrames++;
    else this.counters.fallbackFrames++;
    const now = performance.now();
    this.set({ speaking: { ...this.state.speaking, [v.speaker]: { level: v.level, route: v.route, lastWords: v.lastWords, at: now } } });
    const sp = this.speaker(v.speaker);
    if (!sp) return;
    sp.lastAt = now;
    this.route(sp, v.route);
    // a frame we missed came along with this one: play it first
    if (v.redundant && sp.lastSeq >= 0 && ((v.seq - sp.lastSeq) & 0xffff) === 2) this.decode(sp, v.codec, v.redundant, (v.seq - 1) & 0xffff, v.frameMs);
    this.decode(sp, v.codec, v.frame, v.seq, v.frameMs);
    sp.lastSeq = v.seq;
  }

  private decode(sp: Speaker, codec: number, frame: Uint8Array, seq: number, frameMs: number): void {
    if (codec === VoiceCodec.Adpcm) {
      sp.playout.push(seq, adpcmDecode(frame).subarray(0, (SAMPLE_RATE * frameMs) / 1000));
      return;
    }
    if (!this.state.support?.opusDecode) return;
    if (!sp.opus) {
      try {
        sp.opus = new OpusDecoder(
          (tag, pcm) => sp.playout.push(tag, pcm),
          () => {
            sp.opus?.close();
            sp.opus = null;
          },
        );
      } catch {
        return;
      }
    }
    sp.opus.decode(frame, seq, frameMs);
  }

  /** The speaker's playback chain (made on their first frame, once the page has sound). */
  private speaker(id: number): Speaker | null {
    const have = this.speakers.get(id);
    if (have) return have;
    const out = this.out ?? (this.out = this.output());
    if (!out) return null;
    if (!this.chatBus) {
      this.chatBus = out.ctx.createGain();
      this.chatBus.gain.value = this.settings.chatVolume;
      this.chatBus.connect(out.destination);
    }
    // phones decode only so many voices at once (the server sends no more than this either)
    if (this.speakers.size >= Math.max(1, VOICE.maxSpeakers)) {
      let oldest: Speaker | null = null;
      for (const s of this.speakers.values()) if (!oldest || s.lastAt < oldest.lastAt) oldest = s;
      if (oldest) this.dropSpeaker(oldest.id);
    }
    const input = out.ctx.createGain();
    const sp: Speaker = { id, playout: new Playout(out.ctx, input), input, route: -1, nodes: [], panner: null, distance: null, muffle: null, opus: null, lastSeq: -1, lastAt: performance.now(), x: 0, y: 0 };
    this.speakers.set(id, sp);
    return sp;
  }

  /** Wires a speaker for how they reach us: in 3D (proximity), through a radio (team), or flat. */
  private route(sp: Speaker, route: VoiceRouteId): void {
    if (sp.route === route || !this.out || !this.chatBus) return;
    const ctx = this.out.ctx;
    sp.input.disconnect();
    for (const n of sp.nodes) n.disconnect();
    sp.nodes = [];
    sp.panner = sp.distance = sp.muffle = null;
    sp.route = route;
    if (route === VoiceRoute.Proximity) {
      const muffle = ctx.createBiquadFilter();
      muffle.type = 'lowpass';
      muffle.frequency.value = 12_000;
      const distance = ctx.createGain();
      const panner = this.out.hrtf ? Object.assign(ctx.createPanner(), { panningModel: 'HRTF' as PanningModelType, distanceModel: 'linear' as DistanceModelType, maxDistance: 1e6, refDistance: 1, rolloffFactor: 0 }) : ctx.createStereoPanner();
      sp.input.connect(muffle).connect(distance).connect(panner).connect(this.chatBus);
      sp.nodes = [muffle, distance, panner];
      Object.assign(sp, { panner, distance, muffle });
    } else if (route === VoiceRoute.Team) {
      // a radio: the band of a handset, a little grit
      const hp = Object.assign(ctx.createBiquadFilter(), { type: 'highpass' as BiquadFilterType });
      hp.frequency.value = 500;
      const lp = Object.assign(ctx.createBiquadFilter(), { type: 'lowpass' as BiquadFilterType });
      lp.frequency.value = 3200;
      const shaper = ctx.createWaveShaper();
      shaper.curve = radioCurve();
      sp.input.connect(hp).connect(lp).connect(shaper).connect(this.chatBus);
      sp.nodes = [hp, lp, shaper];
    } else {
      const g = ctx.createGain();
      g.gain.value = route === VoiceRoute.Dead ? 0.7 : 1;
      sp.input.connect(g).connect(this.chatBus);
      sp.nodes = [g];
    }
  }

  private dropSpeaker(id: number): void {
    const sp = this.speakers.get(id);
    if (!sp) return;
    sp.opus?.close();
    sp.input.disconnect();
    for (const n of sp.nodes) n.disconnect();
    this.speakers.delete(id);
  }

  private closeSpeakers(): void {
    for (const id of [...this.speakers.keys()]) this.dropSpeaker(id);
  }

  // ---------------------------------------------------------------- each frame

  /**
   * Once per drawn frame (main.ts): proximity voices follow their soldiers (falloff, walls, pan),
   * the controller's talk button, quiet speakers fade from the rings, and the link's quality picks
   * the tier.
   */
  frame(f: Frame | null, toScreen?: (x: number, y: number) => { x: number; y: number }): void {
    const now = performance.now();
    this.tags?.update(f, this.state, toScreen ?? null, (id) => this.name(id));
    if (f) {
      const me = f.players.find((p) => p.id === f.localId);
      for (const sp of this.speakers.values()) {
        const p = f.players.find((q) => q.id === sp.id);
        if (p) {
          sp.x = p.x;
          sp.y = p.y + 1.4;
        }
        if (sp.route === VoiceRoute.Proximity && me) this.place(sp, me.x, me.y + 1.4);
      }
      if (f.net) {
        this.lossPct = f.net.prediction?.snapshotLossPct ?? 0;
        const conn = (navigator as Navigator & { connection?: { saveData?: boolean; effectiveType?: string; downlink?: number } }).connection;
        const tier = chooseTier({ setting: this.settings.quality, rttMs: f.net.rttMs, lossPct: this.lossPct, transport: f.net.transport, saveData: conn?.saveData, effectiveType: conn?.effectiveType, downlinkMbps: conn?.downlink });
        if (tier !== this.state.tier) this.set({ tier });
      }
    }
    this.pollPad();
    // the rings: a voice counts as talking for a moment after its last frame
    const speaking = this.state.speaking;
    let changed = false;
    const kept: Record<number, Speaking> = {};
    for (const [k, s] of Object.entries(speaking)) {
      if (now - s.at < this.speakingHoldMs) kept[Number(k)] = s;
      else changed = true;
    }
    if (changed) this.set({ speaking: kept });
    for (const sp of [...this.speakers.values()]) if (now - sp.lastAt > IDLE_SPEAKER_MS) this.dropSpeaker(sp.id);
  }

  /** A proximity voice's level, pan and muffling for where it is from us. */
  private place(sp: Speaker, lx: number, ly: number): void {
    if (!this.out || !sp.distance) return;
    const dx = sp.x - lx;
    const dy = sp.y - ly;
    const d = Math.hypot(dx, dy);
    const t = this.out.ctx.currentTime;
    sp.distance.gain.setTargetAtTime(falloff(d), t, 0.05);
    const walls = this.out.occluder ? this.out.occluder(sp.x, sp.y) : 0;
    sp.muffle?.frequency.setTargetAtTime(walls <= 0 ? 12_000 : walls === 1 ? 1600 : 700, t, 0.08);
    if (sp.panner instanceof StereoPannerNode) sp.panner.pan.setTargetAtTime(Math.max(-1, Math.min(1, dx / 14)), t, 0.05);
    else if (sp.panner) {
      const p = sp.panner as PannerNode;
      p.positionX.setTargetAtTime(dx, t, 0.05);
      p.positionY.setTargetAtTime(dy, t, 0.05);
      p.positionZ.setTargetAtTime(-1, t, 0.05);
    }
  }

  private pollPad(): void {
    if (!this.padButtons.length || typeof navigator === 'undefined' || !navigator.getGamepads) return;
    let down = false;
    for (const pad of navigator.getGamepads()) {
      if (!pad) continue;
      for (const b of this.padButtons) if (pad.buttons[b]?.pressed) down = true;
    }
    if (down !== this.held.pad && !(down && this.blocked)) {
      this.held.pad = down;
      this.updateTalking();
    }
  }

  /** What each voice's playout did (played, concealed, late, skipped), by speaker: for checks. */
  playoutStats(): Record<number, { played: number; concealed: number; late: number; skipped: number; delay: number }> {
    const out: Record<number, { played: number; concealed: number; late: number; skipped: number; delay: number }> = {};
    for (const sp of this.speakers.values()) out[sp.id] = { ...sp.playout.stats, delay: sp.playout.target };
    return out;
  }

  /** A player's name (the roster), for the labels. */
  name(id: number): string {
    const n = this.link?.playerNames.get(id);
    return n && n !== 'You' ? n : n === 'You' ? 'You' : `Player ${id + 1}`;
  }

  /** Our own player id in the room (-1: none). */
  get localId(): number {
    return this.link?.localId ?? -1;
  }

  /** Whether a player is a party mate (VOICE_STATE). */
  partyMate(id: number): boolean {
    return ((this.state.peers[id] ?? 0) & PEER_PARTY) !== 0;
  }
}

/** Full volume up to VOICE.falloffStart, then down to nothing at VOICE.radius (an ear-like curve). */
export function falloff(d: number, start = VOICE.falloffStart, radius = VOICE.radius): number {
  if (d <= start) return 1;
  if (d >= radius) return 0;
  const t = (d - start) / Math.max(0.001, radius - start);
  return (1 - t) * (1 - t);
}

let curve: Float32Array<ArrayBuffer> | null = null;
function radioCurve(): Float32Array<ArrayBuffer> {
  if (curve) return curve;
  curve = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    const x = (i / 255) * 2 - 1;
    curve[i] = Math.tanh(2.2 * x) / Math.tanh(2.2);
  }
  return curve;
}
