/**
 * Voice chat's settings (Settings › Audio › Voice chat, the pause menu's switches), saved on this
 * device and applied at once. Defaults (owner, 23 Oct): voice on, push to talk, proximity voice on,
 * opponents heard; quality Auto.
 */
import { createStore } from 'zustand/vanilla';

export type TalkMode = 'ptt' | 'open';
export type VoiceQuality = 'auto' | 'saver';

export interface VoiceSettings {
  /** voice chat at all (off: you hear nobody and send nothing) */
  enabled: boolean;
  /** push to talk (hold V, a controller button, the phone's mic button), or an open mic with a gate */
  mode: TalkMode;
  /** the open mic's gate, dBFS: quieter than this never leaves the device */
  gateDb: number;
  /** your microphone's level, 0…2 */
  micVolume: number;
  /** everyone you hear, 0…1 */
  chatVolume: number;
  /** hear soldiers near you, out loud */
  proximity: boolean;
  /** hear opponents near you (off: party mates and teammates only; the pause menu's "Mute all opponents") */
  hearOpponents: boolean;
  /** Auto follows the link; Data saver stays at the lowest rate */
  quality: VoiceQuality;
  /** push-to-talk key (KeyboardEvent.code) */
  pttKey: string;
  /** push-to-talk controller button (standard mapping index; 13 = D-pad down) */
  padButton: number;
}

export const DEFAULT_VOICE: VoiceSettings = {
  enabled: true,
  mode: 'ptt',
  gateDb: -45,
  micVolume: 1,
  chatVolume: 0.85,
  proximity: true,
  hearOpponents: true,
  quality: 'auto',
  pttKey: 'KeyV',
  padButton: 13,
};

const KEY = 'voice.settings.v1';

export function sanitizeVoice(raw: unknown): VoiceSettings {
  const s = (typeof raw === 'object' && raw !== null ? raw : {}) as Partial<Record<keyof VoiceSettings, unknown>>;
  const d = DEFAULT_VOICE;
  const flag = (v: unknown, f: boolean) => (typeof v === 'boolean' ? v : f);
  const num = (v: unknown, f: number, lo: number, hi: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : f);
  return {
    enabled: flag(s.enabled, d.enabled),
    mode: s.mode === 'open' || s.mode === 'ptt' ? s.mode : d.mode,
    gateDb: num(s.gateDb, d.gateDb, -70, -15),
    micVolume: num(s.micVolume, d.micVolume, 0, 2),
    chatVolume: num(s.chatVolume, d.chatVolume, 0, 1),
    proximity: flag(s.proximity, d.proximity),
    hearOpponents: flag(s.hearOpponents, d.hearOpponents),
    quality: s.quality === 'saver' || s.quality === 'auto' ? s.quality : d.quality,
    pttKey: typeof s.pttKey === 'string' && /^[A-Za-z0-9]{2,24}$/.test(s.pttKey) ? s.pttKey : d.pttKey,
    padButton: num(s.padButton, d.padButton, 0, 16),
  };
}

function load(): VoiceSettings {
  try {
    return sanitizeVoice(JSON.parse(localStorage.getItem(KEY) ?? 'null'));
  } catch {
    return { ...DEFAULT_VOICE };
  }
}

export const voiceSettings = createStore<VoiceSettings>(() => (typeof localStorage === 'undefined' ? { ...DEFAULT_VOICE } : load()));

/** Changes and saves (applied at once by whoever listens). */
export function setVoiceSettings(patch: Partial<VoiceSettings>): void {
  const next = sanitizeVoice({ ...voiceSettings.getState(), ...patch });
  voiceSettings.setState(next, true);
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* this session only */
  }
}
