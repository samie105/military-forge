import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { createStore } from 'zustand/vanilla';
import type { MicState } from './capture';
import type { VoiceChat, VoiceState } from './voice';
import { PhoneMic, VoicePauseCard } from './VoiceHud';
import { createShellStore } from '../shell/store';

/** A stand-in chat: only its store is read when rendering. */
const chat = (p: Partial<VoiceState>) => ({ localId: 0, store: createStore<VoiceState>(() => ({ active: true, mic: 'live' as MicState, talking: false, locked: false, mutes: [], peers: {}, speaking: {}, ...p }) as VoiceState) }) as unknown as VoiceChat;

describe('the phone mic (top edge, beside the menu)', () => {
  it('a labelled pill: Talk, Talking, On (locked), Allow the mic', () => {
    expect(renderToString(<PhoneMic chat={chat({})} />)).toMatch(/is-idle[\s\S]*>Talk</);
    expect(renderToString(<PhoneMic chat={chat({ talking: true })} />)).toMatch(/is-talking[\s\S]*Talking/);
    expect(renderToString(<PhoneMic chat={chat({ talking: true, locked: true })} />)).toMatch(/is-locked[\s\S]*On · tap to stop/);
    expect(renderToString(<PhoneMic chat={chat({ mic: 'asking' })} />)).toMatch(/Allow the mic/);
  });

  it('blocked or missing, it stays on screen and says so (it used to vanish)', () => {
    const denied = renderToString(<PhoneMic chat={chat({ mic: 'denied' })} />);
    expect(denied).toMatch(/is-blocked[\s\S]*Mic blocked/);
    expect(denied).toMatch(/aria-label="Microphone blocked: allow it in the browser(&#x27;|')s site settings"/);
    expect(renderToString(<PhoneMic chat={chat({ mic: 'unavailable' })} />)).toMatch(/No mic/);
  });

  it('in the lobby it sits inline (the roster header), not on the top bar', () => {
    expect(renderToString(<PhoneMic chat={chat({})} inline />)).toMatch(/class="vc-mic is-idle vc-mic--inline"/);
  });
});

describe('the pause card: my own mic', () => {
  const shell = () =>
    createShellStore({ lobby: { players: [{ id: 0, name: 'Ade', isBot: false, you: true }, { id: 1, name: 'Kemi', isBot: false, you: false }] } as never });
  it('how I talk (hold or open), and Try again when the browser blocked the mic', () => {
    const live = renderToString(<VoicePauseCard shell={shell()} chat={chat({})} />);
    expect(live).toMatch(/My mic/);
    expect(live).toMatch(/role="radiogroup" aria-label="My mic"/);
    const blocked = renderToString(<VoicePauseCard shell={shell()} chat={chat({ mic: 'denied' })} />);
    expect(blocked).toMatch(/Blocked by the browser/);
    expect(blocked).toMatch(/Try again/);
  });
});
