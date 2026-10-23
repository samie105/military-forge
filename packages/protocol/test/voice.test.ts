import { describe, expect, it } from 'vitest';
import {
  DecodeError,
  MAX_VOICE_FRAME,
  MIN_PROTOCOL_VERSION,
  MsgType,
  PROTOCOL_VERSION,
  VoiceChannel,
  VoiceCodec,
  VoiceRoute,
  decodeVoiceDown,
  decodeVoiceState,
  decodeVoiceUp,
  encodeVoiceDown,
  encodeVoiceState,
  encodeVoiceUp,
  isUnreliableMessage,
  parseVoiceSettings,
  protocolSupported,
} from '../src';

const bytes = (n: number, v = 7) => new Uint8Array(n).fill(v);

describe('voice on the wire (v18)', () => {
  it('v18 or later (v19 added looks), and v17 pages still admitted', () => {
    expect(PROTOCOL_VERSION).toBeGreaterThanOrEqual(18);
    expect(MIN_PROTOCOL_VERSION).toBe(17);
    expect(protocolSupported(17)).toBe(true);
    expect(protocolSupported(18)).toBe(true);
    expect(protocolSupported(16)).toBe(false);
    expect(protocolSupported(PROTOCOL_VERSION + 1)).toBe(false);
  });

  it('VOICE_UP round-trips its header and frames, with and without the redundant copy', () => {
    const up = encodeVoiceUp({ seq: 65535, codec: VoiceCodec.Adpcm, channel: VoiceChannel.Party, level: 15, frameMs: 60, frame: bytes(120), redundant: bytes(90, 3) });
    expect(up.length).toBe(5 + 1 + 90 + 120);
    const back = decodeVoiceUp(up);
    expect(back).toMatchObject({ seq: 65535, codec: VoiceCodec.Adpcm, channel: VoiceChannel.Party, level: 15, frameMs: 60 });
    expect([...back.frame]).toEqual([...bytes(120)]);
    expect([...back.redundant!]).toEqual([...bytes(90, 3)]);
    const plain = decodeVoiceUp(encodeVoiceUp({ seq: 2, codec: VoiceCodec.Opus, channel: VoiceChannel.Near, level: 3.6, frameMs: 20, frame: bytes(40), redundant: null }));
    expect(plain).toMatchObject({ seq: 2, level: 4, frameMs: 20, redundant: null });
  });

  it('VOICE_DOWN carries the speaker, the route and last words around the client bytes, unchanged', () => {
    const up = encodeVoiceUp({ seq: 300, codec: VoiceCodec.Opus, channel: VoiceChannel.Near, level: 8, frameMs: 40, frame: bytes(64), redundant: bytes(60) });
    const down = encodeVoiceDown(5, VoiceRoute.Proximity, true, up);
    expect(down[0]).toBe(MsgType.VoiceDown);
    expect(down.length).toBe(up.length + 2);
    expect(decodeVoiceDown(down)).toMatchObject({ speaker: 5, route: VoiceRoute.Proximity, lastWords: true, seq: 300, level: 8, frameMs: 40 });
    expect(decodeVoiceDown(encodeVoiceDown(31, VoiceRoute.Dead, false, up))).toMatchObject({ speaker: 31, route: VoiceRoute.Dead, lastWords: false });
  });

  it('goes as datagrams on WebTransport (unreliable), VOICE_STATE on the stream', () => {
    expect(isUnreliableMessage(new Uint8Array([MsgType.VoiceUp]))).toBe(true);
    expect(isUnreliableMessage(new Uint8Array([MsgType.VoiceDown]))).toBe(true);
    expect(isUnreliableMessage(new Uint8Array([MsgType.VoiceState]))).toBe(false);
    // the biggest VOICE_UP still fits a datagram (1000 B)
    const max = encodeVoiceUp({ seq: 0, codec: VoiceCodec.Opus, channel: VoiceChannel.Near, level: 0, frameMs: 60, frame: bytes(MAX_VOICE_FRAME), redundant: bytes(255) });
    expect(max.length).toBeLessThan(1000);
  });

  it('refuses malformed frames', () => {
    const bad = (b: number[]) => () => decodeVoiceUp(new Uint8Array(b));
    expect(bad([MsgType.VoiceUp, 0, 0, 0])).toThrow(DecodeError); // too short
    expect(bad([MsgType.VoiceUp, 0, 0, 0, 3, 1])).toThrow(DecodeError); // frame length code 3
    expect(bad([MsgType.VoiceUp, 0, 0, 2, 0, 1])).toThrow(DecodeError); // codec 2
    expect(bad([MsgType.VoiceUp, 0, 0, 12, 0, 1])).toThrow(DecodeError); // channel 3
    expect(bad([MsgType.VoiceUp, 0, 0, 0, 4, 9, 1])).toThrow(DecodeError); // redundant runs past the end
    expect(() => decodeVoiceUp(new Uint8Array([MsgType.VoiceUp, 0, 0, 0, 0, ...bytes(MAX_VOICE_FRAME + 1)]))).toThrow(DecodeError);
    expect(() => decodeVoiceUp(new Uint8Array([MsgType.Ping, 0, 0, 0, 0, 1]))).toThrow(DecodeError);
  });

  it('VOICE_STATE round-trips', () => {
    const st = decodeVoiceState(encodeVoiceState(true, [{ id: 3, flags: 5 }, { id: 30, flags: 255 }]));
    expect(st).toEqual({ type: MsgType.VoiceState, fallback: true, peers: [{ id: 3, flags: 5 }, { id: 30, flags: 255 }] });
    expect(() => decodeVoiceState(new Uint8Array([MsgType.VoiceState, 0, 2, 1, 1]))).toThrow(DecodeError);
  });

  it('the Voice CMD keeps to its shape', () => {
    expect(parseVoiceSettings('{"on":true,"mic":true,"opus":true,"mute":[1,1,40,-1,2.5,"x",7],"evil":1}')).toEqual({ on: true, mic: true, opus: true, proximity: true, hearOpponents: true, mute: [1, 7] });
    expect(parseVoiceSettings('[]')).toBeNull();
    expect(parseVoiceSettings('nope')).toBeNull();
    expect(parseVoiceSettings('{}')).toMatchObject({ on: false, mic: false });
  });
});
