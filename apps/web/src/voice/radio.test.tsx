import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { createStore } from 'zustand/vanilla';
import { PEER_MIC, PEER_VOICE, VoiceRoute, type VoiceRouteId } from '@military-forge/protocol';
import type { MicState } from './capture';
import type { VoiceChat, VoiceState } from './voice';
import { CommsButton, CommsRadio, CommsSheet, LobbyRadio, radioState, withVoice } from './Radio';
import { CLICK_WAIT_MS, HOLD_MS, LOCK_PX, LongPress, MUTE_HOLD_MS, RadioPress, type PressClock } from './press';
import { createShellStore } from '../shell/store';

/** A stand-in chat: its store, names and keys are all the views read. */
const chat = (p: Partial<VoiceState>) =>
  ({
    localId: 0,
    talkKeys: ['KeyV'],
    name: (id: number) => ['Ade', 'Kemi', 'Tunde'][id] ?? '?',
    store: createStore<VoiceState>(() => ({ active: true, mic: 'live' as MicState, talking: false, locked: false, level: 0, mutes: [], peers: {}, speaking: {}, ...p }) as VoiceState),
  }) as unknown as VoiceChat;

describe('the radio: one voice control', () => {
  it('looks like what it does: idle, on air, locked, open mic, blocked', () => {
    expect(radioState({ mic: 'live', talking: false, locked: false }, 'ptt')).toBe('idle');
    expect(radioState({ mic: 'live', talking: true, locked: false }, 'ptt')).toBe('talking');
    expect(radioState({ mic: 'live', talking: true, locked: true }, 'ptt')).toBe('locked');
    expect(radioState({ mic: 'live', talking: false, locked: false }, 'open')).toBe('open');
    expect(radioState({ mic: 'denied', talking: false, locked: false }, 'ptt')).toBe('blocked');
    expect(radioState({ mic: 'unavailable', talking: false, locked: false }, 'ptt')).toBe('blocked');
  });

  it('says hold to talk and tap for comms (a label, not a paragraph on screen)', () => {
    const idle = renderToString(<CommsRadio chat={chat({})} phone />);
    expect(idle).toMatch(/class="vc-radio is-idle/);
    expect(idle).toMatch(/aria-label="Voice: hold to talk, tap for comms"/);
    expect(idle).toMatch(/#icon-radio/);
    expect(renderToString(<CommsRadio chat={chat({})} />)).toMatch(/hold V to talk, click for comms/);
    const talking = renderToString(<CommsRadio chat={chat({ talking: true })} phone />);
    expect(talking).toMatch(/is-talking[\s\S]*#icon-sx-onair[\s\S]*vc-radio__lock[\s\S]*On air/);
    expect(renderToString(<CommsRadio chat={chat({ talking: true, locked: true })} phone />)).toMatch(/is-locked[\s\S]*vc-radio__badge[\s\S]*Live/);
    expect(renderToString(<CommsRadio chat={chat({ mic: 'denied' })} phone />)).toMatch(/is-blocked[\s\S]*#icon-sx-mic-off/);
  });

  it('counts the others on voice (muted ones drop out)', () => {
    expect(withVoice({ 1: PEER_VOICE | PEER_MIC, 2: PEER_VOICE, 3: 0 }, [])).toBe(2);
    expect(withVoice({ 1: PEER_VOICE, 2: PEER_VOICE }, [2])).toBe(1);
    expect(renderToString(<CommsRadio chat={chat({ peers: { 1: PEER_VOICE } })} phone />)).toMatch(/vc-radio__n[^>]*>1</);
  });

  it('who is talking pops out beside it; two at most on a phone, then +N', () => {
    const sp = (route: number) => ({ level: 8, route: route as VoiceRouteId, lastWords: false, at: 0 });
    const html = renderToString(<CommsRadio chat={chat({ speaking: { 1: sp(VoiceRoute.Proximity), 2: sp(VoiceRoute.Party), 3: sp(VoiceRoute.Proximity) } })} phone />);
    expect(html).toMatch(/vc-chips__more">\+<!-- -->1/);
    expect(html.match(/class="vc-chip[ "]/g)).toHaveLength(2);
    expect(html).toMatch(/aria-label="Kemi, Nearby, talking. Hold to mute"/);
    expect(html).toMatch(/vc-chip is-party/);
    // a muted voice never shows
    expect(renderToString(<CommsRadio chat={chat({ speaking: { 1: sp(0) }, mutes: [1] })} phone />)).not.toMatch(/class="vc-chip[ "]/);
  });

  it('the lobbies carry it only with another human in the room', () => {
    expect(renderToString(<LobbyRadio chat={chat({})} players={[{ isBot: false, you: true }, { isBot: true, you: false }]} />)).toBe('');
    expect(renderToString(<LobbyRadio chat={chat({})} players={[{ isBot: false, you: true }, { isBot: false, you: false }]} phone />)).toMatch(/vc-radio--inline/);
    expect(renderToString(<LobbyRadio chat={chat({ active: false })} players={[{ isBot: false, you: false }]} />)).toBe('');
  });
});

describe('the comms sheet: everything else voice, in one place', () => {
  const shell = () =>
    createShellStore({ lobby: { players: [{ id: 0, name: 'Ade', isBot: false, you: true }, { id: 1, name: 'Kemi', isBot: false, you: false }, { id: 2, name: 'Bot', isBot: true, you: false }] } as never });
  it('how you talk, voices, opponents, and each human with a one-tap mute', () => {
    const html = renderToString(<CommsSheet shell={shell()} chat={chat({ peers: { 1: PEER_VOICE | PEER_MIC } })} phone />);
    expect(html).toMatch(/role="dialog"/);
    expect(html).toMatch(/aria-label="How you talk"/);
    expect(html).toMatch(/Hold to talk[\s\S]*Open mic/);
    expect(html).toMatch(/aria-label="Mute Kemi"/);
    expect(html).not.toMatch(/Mute Bot/);
    expect(html).toMatch(/Opponents nearby/);
  });
  it('a blocked mic: the three taps that fix it, and Try again', () => {
    const html = renderToString(<CommsSheet shell={shell()} chat={chat({ mic: 'denied' })} phone />);
    expect(html).toMatch(/Listening only/);
    expect(html).toMatch(/vc-fix__steps[\s\S]*aA[\s\S]*Mic[\s\S]*Allow/);
    expect(html).toMatch(/Try again/);
  });
  it('a muted player reads Muted with an unmute button', () => {
    const html = renderToString(<CommsSheet shell={shell()} chat={chat({ mutes: [1] })} />);
    expect(html).toMatch(/is-muted[\s\S]*Muted[\s\S]*aria-label="Unmute Kemi"/);
  });
  it("the desktop pause menu's way in: one Comms button, only with voice on", () => {
    expect(renderToString(<CommsButton className="btn" chat={chat({})} />)).toMatch(/Comms/);
    expect(renderToString(<CommsButton className="btn" chat={chat({ active: false })} />)).toBe('');
  });
});

/** A clock the test moves by hand. */
function fakeClock() {
  let now = 0;
  let timers: { at: number; fn: () => void; id: number }[] = [];
  let next = 1;
  const clock: PressClock = {
    set: (fn, ms) => {
      timers.push({ at: now + ms, fn, id: next });
      return next++;
    },
    clear: (h) => {
      timers = timers.filter((t) => t.id !== h);
    },
  };
  const advance = (ms: number) => {
    now += ms;
    const due = timers.filter((t) => t.at <= now);
    timers = timers.filter((t) => t.at > now);
    for (const t of due) t.fn();
  };
  return { clock, advance };
}

describe('what a press on the radio means', () => {
  const setup = () => {
    const talker = { touchDown: vi.fn(), touchUp: vi.fn(), lock: vi.fn(), warmMic: vi.fn() };
    const sheet = vi.fn();
    const { clock, advance } = fakeClock();
    return { talker, sheet, advance, press: new RadioPress(talker, sheet, clock) };
  };
  it('a quick tap opens comms and never talks (the mic is asked for at once, inside the tap)', () => {
    const { talker, sheet, advance, press } = setup();
    press.down(100, false, true);
    expect(talker.warmMic).toHaveBeenCalledTimes(1);
    advance(HOLD_MS - 20);
    press.up();
    // on the click that follows (so that click can't land on the sheet and shut it)
    expect(sheet).not.toHaveBeenCalled();
    press.click();
    expect(sheet).toHaveBeenCalledTimes(1);
    expect(talker.touchDown).not.toHaveBeenCalled();
    advance(CLICK_WAIT_MS);
    expect(sheet).toHaveBeenCalledTimes(1);
  });
  it('no click after a tap (a browser that eats it): the sheet opens anyway; a stray click alone opens nothing', () => {
    const { sheet, advance, press } = setup();
    press.click();
    expect(sheet).not.toHaveBeenCalled();
    press.down(100, false, true);
    press.up();
    advance(CLICK_WAIT_MS);
    expect(sheet).toHaveBeenCalledTimes(1);
    press.click(true);
    expect(sheet).toHaveBeenCalledTimes(2);
  });
  it('a hold talks from HOLD_MS until the finger lifts, and opens nothing', () => {
    const { talker, sheet, advance, press } = setup();
    press.down(100, false, true);
    advance(HOLD_MS);
    expect(talker.touchDown).toHaveBeenCalledTimes(1);
    expect(press.talking).toBe(true);
    press.up();
    expect(talker.touchUp).toHaveBeenCalledTimes(1);
    expect(sheet).not.toHaveBeenCalled();
  });
  it('sliding down onto the lock keeps it on; the next press stops it', () => {
    const { talker, sheet, advance, press } = setup();
    press.down(100, false, true);
    advance(HOLD_MS);
    expect(press.move(100 + LOCK_PX / 2)).toBeCloseTo(0.5);
    expect(press.move(100 + LOCK_PX)).toBe(1);
    expect(talker.lock).toHaveBeenCalledTimes(1);
    press.up();
    expect(talker.touchUp).not.toHaveBeenCalled();
    // locked: a press unlocks at once (touchDown toggles the lock off), the lift lets go, no sheet
    press.down(100, true, true);
    expect(talker.touchDown).toHaveBeenCalledTimes(2);
    press.up();
    expect(talker.touchUp).toHaveBeenCalledTimes(1);
    expect(sheet).not.toHaveBeenCalled();
  });
  it('open mic or a blocked mic: every press is a tap (comms)', () => {
    const { talker, sheet, advance, press } = setup();
    press.down(100, false, false);
    advance(HOLD_MS * 4);
    press.up();
    advance(CLICK_WAIT_MS);
    expect(talker.touchDown).not.toHaveBeenCalled();
    expect(sheet).toHaveBeenCalledTimes(1);
  });
  it('a busy page that ran the hold timer late still reads a short press as a tap (the events\' clock)', () => {
    const { talker, sheet, advance, press } = setup();
    press.down(100, false, true, 1000);
    advance(HOLD_MS);
    expect(talker.touchDown).toHaveBeenCalledTimes(1);
    press.up(1000 + HOLD_MS - 60);
    expect(talker.touchUp).toHaveBeenCalledTimes(1);
    press.click();
    expect(sheet).toHaveBeenCalledTimes(1);
  });
  it('a cancelled touch (the browser took it) stops talking and opens nothing', () => {
    const { talker, sheet, advance, press } = setup();
    press.down(100, false, true);
    advance(HOLD_MS);
    press.cancel();
    expect(talker.touchUp).toHaveBeenCalledTimes(1);
    expect(sheet).not.toHaveBeenCalled();
  });
  it('a long press on a voice mutes it; a short one does nothing', () => {
    const { clock, advance } = fakeClock();
    const mute = vi.fn();
    const lp = new LongPress(mute, clock);
    lp.down();
    advance(MUTE_HOLD_MS - 100);
    lp.up();
    advance(1000);
    expect(mute).not.toHaveBeenCalled();
    lp.down();
    advance(MUTE_HOLD_MS);
    expect(mute).toHaveBeenCalledTimes(1);
  });
});
