/**
 * Voice chat for the app (main.ts attaches it to the online game, the social layer draws it): one
 * VoiceChat, playing through the game's own sound engine (its master volume, headphones mode and
 * the map's walls apply).
 */
import { audio } from '../audio';
import { SpeakingTags } from './tags';
import { VoiceChat } from './voice';

export const voiceChat = new VoiceChat(() => {
  const e = audio.engine();
  if (!e) return null;
  return {
    get ctx() {
      return e.ctx;
    },
    get destination(): AudioNode {
      return e.buses.master;
    },
    get hrtf() {
      return e.hrtf;
    },
    get occluder() {
      return e.occluder;
    },
  };
});

// the speaking tags over soldiers (a page with a document: not in tests)
if (typeof document !== 'undefined') voiceChat.tags = new SpeakingTags();
// dev builds: the console and the screenshot scripts can look at it (window.__voice)
if (import.meta.env.DEV && typeof window !== 'undefined') Object.assign(window, { __voice: voiceChat });

export { VoiceChat, chooseTier, falloff, TIERS, type Speaking, type Tier, type VoiceLink, type VoiceState } from './voice';
export { voiceSettings, setVoiceSettings, DEFAULT_VOICE, type VoiceSettings } from './settings';
