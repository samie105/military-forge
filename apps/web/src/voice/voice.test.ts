import { VOICE } from '@military-forge/content';
import {
  CmdKind,
  MsgType,
  PEER_MIC,
  PEER_PARTY,
  PEER_VOICE,
  VoiceChannel,
  VoiceCodec,
  VoiceRoute,
  decodeVoiceUp,
  encodeVoiceDown,
  encodeVoiceState,
  encodeVoiceUp,
  type VoiceSettingsCmd,
} from '@military-forge/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import type { MicState } from './capture';
import { ADPCM_RATE, SAMPLE_RATE, adpcmDecode, adpcmEncode, dbfs, levelOf } from './codec';
import { Playout, seqBefore } from './playout';
import { DEFAULT_VOICE, sanitizeVoice, setVoiceSettings, voiceSettings } from './settings';
import { TIERS, VoiceChat, chooseTier, falloff, type Mic, type VoiceLink, type VoiceOutput } from './voice';

afterEach(() => setVoiceSettings(DEFAULT_VOICE));

const tone = (ms: number, freq = 300, amp = 0.5) => {
  const n = (SAMPLE_RATE * ms) / 1000;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = amp * Math.sin((2 * Math.PI * freq * i) / SAMPLE_RATE);
  return out;
};

describe('the fallback codec (IMA ADPCM, 6 kHz)', () => {
  it('is 24 kbps-ish and gives speech back recognisably', () => {
    const pcm = tone(60, 300);
    const enc = adpcmEncode(pcm);
    // 60 ms: 360 samples at 6 kHz, 4 bits each, + 3 bytes of state ≈ 24 kbps
    expect(enc.length).toBeLessThanOrEqual(184);
    expect(((enc.length * 8) / 60) * 1000).toBeLessThan(25_000);
    const back = adpcmDecode(enc).subarray(0, pcm.length);
    expect(back.length).toBe(pcm.length);
    // compare away from the edges (the interpolation's first samples)
    let err = 0;
    let sig = 0;
    for (let i = 200; i < pcm.length - 200; i++) {
      err += (back[i]! - pcm[i]!) ** 2;
      sig += pcm[i]! ** 2;
    }
    expect(10 * Math.log10(sig / err)).toBeGreaterThan(12); // > 12 dB SNR on a 300 Hz tone
  });

  it('starts each frame afresh (a lost frame costs only itself) and survives silence and junk', () => {
    const a = adpcmEncode(tone(20));
    expect(adpcmDecode(a).length).toBeGreaterThan(0);
    expect(adpcmDecode(adpcmEncode(new Float32Array(960))).every((x) => Math.abs(x) < 1e-3)).toBe(true);
    expect(adpcmDecode(new Uint8Array([1])).length).toBe(0);
    expect(ADPCM_RATE * 8).toBe(SAMPLE_RATE);
  });

  it('levels and dBFS for rings and the gate', () => {
    expect(levelOf(new Float32Array(960))).toBe(0);
    expect(levelOf(tone(20, 300, 0.9))).toBeGreaterThan(12);
    expect(dbfs(tone(20, 300, 0.5))).toBeCloseTo(-9, 0);
  });
});

describe('quality and distance', () => {
  it('Auto follows the link; Data saver stays low', () => {
    expect(chooseTier({ setting: 'auto', rttMs: 40, lossPct: 0, downlinkMbps: 20 })).toBe('high');
    expect(chooseTier({ setting: 'auto', rttMs: 150, lossPct: 0.5 })).toBe('normal');
    expect(chooseTier({ setting: 'auto', rttMs: 300, lossPct: 0 })).toBe('saver');
    expect(chooseTier({ setting: 'auto', rttMs: 60, lossPct: 6 })).toBe('saver');
    expect(chooseTier({ setting: 'auto', rttMs: 40, lossPct: 0, effectiveType: '3g' })).toBe('saver');
    expect(chooseTier({ setting: 'auto', rttMs: 40, lossPct: 0, saveData: true })).toBe('saver');
    expect(chooseTier({ setting: 'saver', rttMs: 20, lossPct: 0 })).toBe('saver');
    // 4G's floor and Wi-Fi's ceiling: 16-40 kbps
    expect(TIERS.saver.bitrate).toBe(16_000);
    expect(TIERS.high.bitrate).toBeLessThanOrEqual(48_000);
  });

  it('a voice is full up close and gone at the radius', () => {
    expect(falloff(0)).toBe(1);
    expect(falloff(VOICE.falloffStart)).toBe(1);
    expect(falloff((VOICE.falloffStart + VOICE.radius) / 2)).toBeCloseTo(0.25, 2);
    expect(falloff(VOICE.radius)).toBe(0);
  });
});

/** A small stand-in for the parts of Web Audio the voice touches. */
function fakeAudio() {
  const started: { at: number; length: number; gain: number }[] = [];
  const node = () => ({ connect: (n: unknown) => n, disconnect: () => {}, gain: { value: 1, setTargetAtTime() {} }, frequency: { value: 0, setTargetAtTime() {} }, pan: { setTargetAtTime() {} }, positionX: { setTargetAtTime() {} }, positionY: { setTargetAtTime() {} }, positionZ: { setTargetAtTime() {} }, type: '', curve: null });
  const ctx = {
    currentTime: 10,
    createGain: node,
    createBiquadFilter: node,
    createStereoPanner: node,
    createPanner: node,
    createWaveShaper: node,
    createBuffer: (_c: number, length: number) => {
      const data = new Float32Array(length);
      return { length, getChannelData: () => data };
    },
    createBufferSource() {
      const src = { buffer: null as { length: number; getChannelData(): Float32Array } | null, connect: () => {}, start: (at: number) => started.push({ at, length: src.buffer!.length, gain: Math.max(...src.buffer!.getChannelData().map(Math.abs)) }) };
      return src;
    },
  };
  return { ctx, started };
}

describe('the playout (jitter buffer)', () => {
  it('plays frames back to back a little behind real time, covers a lost one, drops a late one', () => {
    const { ctx, started } = fakeAudio();
    const p = new Playout(ctx as never, {} as AudioNode);
    const f = () => tone(20);
    p.push(100, f());
    p.push(101, f());
    expect(started.map((s) => s.at)).toEqual([10 + p.target + 0.0005, 10 + p.target + 0.0005 + 0.02].map((x) => expect.closeTo(x, 2)) as never);
    p.push(103, f()); // 102 lost: covered once
    expect(p.stats.concealed).toBe(1);
    expect(started).toHaveLength(4);
    p.push(102, f()); // arrives after we moved on: late
    expect(p.stats.late).toBe(1);
    expect(seqBefore(65535, 0)).toBe(true);
    expect(seqBefore(0, 65535)).toBe(false);
  });
});

function fakeLink(localId = 0) {
  const sent: Uint8Array[] = [];
  const cmds: VoiceSettingsCmd[] = [];
  let voice: ((b: Uint8Array) => void) | null = null;
  let connected: (() => void) | null = null;
  const link: VoiceLink = {
    localId,
    playerNames: new Map([
      [0, 'You'],
      [1, 'Kemi'],
      [2, 'Tunde'],
    ]),
    sendVoice: (b) => sent.push(b),
    sendVoiceSettings: (json) => cmds.push(JSON.parse(json) as VoiceSettingsCmd),
    onVoice: (fn) => ((voice = fn), () => (voice = null)),
    onConnected: (fn) => ((connected = fn), () => (connected = null)),
  };
  return { link, sent, cmds, deliver: (b: Uint8Array) => voice?.(b), welcome: () => connected?.() };
}

function fakeMic() {
  let frame: ((pcm: Float32Array) => void) | null = null;
  let onState: ((s: MicState) => void) | null = null;
  const mic: Mic & { push(pcm: Float32Array): void } = {
    state: 'off',
    async start() {
      (mic as { state: MicState }).state = 'live';
      onState?.('live');
      return 'live';
    },
    stop() {
      (mic as { state: MicState }).state = 'off';
      onState?.('off');
    },
    setVolume() {},
    push: (pcm) => frame?.(pcm),
  };
  const make = (f: (pcm: Float32Array) => void, s: (st: MicState) => void) => ((frame = f), (onState = s), mic);
  return { mic, make };
}

const win = () => {
  const listeners = new Map<string, ((e: unknown) => void)[]>();
  const w = { addEventListener: (type: string, fn: (e: unknown) => void) => listeners.set(type, [...(listeners.get(type) ?? []), fn]) };
  return { win: w as unknown as Window, key: (type: 'keydown' | 'keyup', code: string) => listeners.get(type)?.forEach((fn) => fn({ code, repeat: false, target: null })) };
};

const settle = () => new Promise((r) => setTimeout(r, 0));

describe('VoiceChat', () => {
  it('says its voice state to the room on attach and after every WELCOME, with mutes', async () => {
    const { make } = fakeMic();
    const chat = new VoiceChat(() => null, null, make, async () => ({ opusEncode: false, opusDecode: false }));
    const l = fakeLink();
    chat.attach(l.link);
    await settle();
    expect(l.cmds.at(-1)).toEqual({ on: true, mic: false, opus: false, proximity: true, hearOpponents: true, mute: [] });
    chat.setMuted(2, true);
    expect(l.cmds.at(-1)!.mute).toEqual([2]);
    l.welcome();
    expect(l.cmds.at(-1)!.mute).toEqual([2]);
    setVoiceSettings({ hearOpponents: false });
    expect(l.cmds.at(-1)!.hearOpponents).toBe(false);
  });

  it('push to talk: V opens the mic (asked on the first press), frames go out while held, B talks to the party', async () => {
    const { mic, make } = fakeMic();
    const w = win();
    const chat = new VoiceChat(() => null, w.win, make, async () => ({ opusEncode: false, opusDecode: false }));
    const l = fakeLink();
    chat.attach(l.link);
    await settle();
    mic.push(tone(20)); // not held: nothing
    expect(l.sent).toEqual([]);
    w.key('keydown', 'KeyV');
    await settle();
    expect(chat.state.mic).toBe('live');
    expect(l.cmds.at(-1)!.mic).toBe(true);
    // normal tier: 40 ms frames, so two 20 ms captures make one packet (the fallback codec here: no WebCodecs in tests)
    mic.push(tone(20));
    mic.push(tone(20));
    expect(l.sent).toHaveLength(1);
    const up = decodeVoiceUp(l.sent[0]!);
    expect(up).toMatchObject({ seq: 0, codec: VoiceCodec.Adpcm, channel: VoiceChannel.Near, frameMs: 40 });
    expect(up.level).toBeGreaterThan(8);
    w.key('keyup', 'KeyV');
    mic.push(tone(20));
    mic.push(tone(20));
    expect(l.sent).toHaveLength(1);
    w.key('keydown', 'KeyB');
    mic.push(tone(20));
    mic.push(tone(20));
    expect(decodeVoiceUp(l.sent[1]!)).toMatchObject({ seq: 1, channel: VoiceChannel.Party });
  });

  it('open mic sends only above the gate; a menu or a text field keeps V from talking', async () => {
    const { mic, make } = fakeMic();
    const w = win();
    const chat = new VoiceChat(() => null, w.win, make, async () => ({ opusEncode: false, opusDecode: false }));
    const l = fakeLink();
    setVoiceSettings({ mode: 'open', gateDb: -30 });
    chat.attach(l.link);
    await settle();
    await mic.start();
    for (let i = 0; i < 4; i++) mic.push(tone(20, 300, 0.005)); // −49 dB: under the gate
    expect(l.sent).toEqual([]);
    for (let i = 0; i < 2; i++) mic.push(tone(20, 300, 0.5));
    expect(l.sent).toHaveLength(1);
    setVoiceSettings({ mode: 'ptt' });
    chat.blocked = true;
    w.key('keydown', 'KeyV');
    for (let i = 0; i < 2; i++) mic.push(tone(20));
    expect(l.sent).toHaveLength(1);
  });

  it('under loss each packet carries the previous frame; Data saver uses 60 ms frames', async () => {
    const { mic, make } = fakeMic();
    const chat = new VoiceChat(() => null, null, make, async () => ({ opusEncode: false, opusDecode: false }));
    const l = fakeLink();
    setVoiceSettings({ quality: 'saver' });
    chat.attach(l.link);
    await settle();
    chat.frame({ tick: 0, localId: 0, players: [], grenades: [], net: { rttMs: 300, snapshotsPerSec: 30, kbInPerSec: 0, kbOutPerSec: 0, interpDelayMs: 0, status: '', prediction: { snapshotLossPct: 8 } as never } });
    expect(chat.state.tier).toBe('saver');
    chat.touchDown();
    await settle();
    for (let i = 0; i < 6; i++) mic.push(tone(20));
    expect(l.sent).toHaveLength(2);
    expect(decodeVoiceUp(l.sent[0]!)).toMatchObject({ frameMs: 60, redundant: null });
    expect(decodeVoiceUp(l.sent[1]!).redundant).not.toBeNull();
    // the phone's lock: hands-free until the next tap
    chat.touchUp();
    expect(chat.state.talking).toBe(false);
    chat.lock();
    chat.touchUp();
    expect(chat.state.locked).toBe(true);
    chat.touchDown();
    expect(chat.state.locked).toBe(false);
  });

  it('hears: VOICE_STATE sets the peers and the fallback; a voice plays, rings light, a muted one is ignored', async () => {
    const { make } = fakeMic();
    const audioOut = fakeAudio();
    const out: VoiceOutput = { ctx: audioOut.ctx as never, destination: {} as AudioNode, hrtf: false, occluder: null };
    const chat = new VoiceChat(() => out, null, make, async () => ({ opusEncode: true, opusDecode: true }));
    const l = fakeLink();
    chat.attach(l.link);
    await settle();
    l.deliver(encodeVoiceState(true, [{ id: 1, flags: PEER_VOICE | PEER_MIC | PEER_PARTY }]));
    expect(chat.state.fallback).toBe(true);
    expect(chat.partyMate(1)).toBe(true);
    const up = encodeVoiceUp({ seq: 7, codec: VoiceCodec.Adpcm, channel: VoiceChannel.Near, level: 11, frameMs: 20, frame: adpcmEncode(tone(20)), redundant: null });
    l.deliver(encodeVoiceDown(1, VoiceRoute.Proximity, true, up));
    expect(chat.state.speaking[1]).toMatchObject({ level: 11, route: VoiceRoute.Proximity, lastWords: true });
    expect(audioOut.started).toHaveLength(1);
    expect(chat.name(1)).toBe('Kemi');
    chat.setMuted(1, true);
    l.deliver(encodeVoiceDown(1, VoiceRoute.Proximity, false, encodeVoiceUp({ seq: 8, codec: VoiceCodec.Adpcm, channel: VoiceChannel.Near, level: 11, frameMs: 20, frame: adpcmEncode(tone(20)), redundant: null })));
    expect(audioOut.started).toHaveLength(1);
    // voices off: nothing plays
    chat.setMuted(1, false);
    setVoiceSettings({ enabled: false });
    expect(chat.state.active).toBe(false);
    expect(l.cmds.at(-1)!.on).toBe(false);
  });

  it('settings keep to their shape', () => {
    expect(sanitizeVoice({ mode: 'loud', gateDb: -200, chatVolume: 4, pttKey: '<script>' })).toMatchObject({ mode: 'ptt', gateDb: -70, chatVolume: 1, pttKey: 'KeyV' });
    expect(voiceSettings.getState()).toEqual(DEFAULT_VOICE);
    expect(CmdKind.Voice).toBe(11);
    expect(MsgType.VoiceUp).toBe(0x29);
  });
});
