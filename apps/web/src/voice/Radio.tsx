/**
 * The radio (board "VOICE + HUD EDITOR · landscape-first", R1–R6): the one voice control. The owner,
 * 24 Oct: "you just put mic everywhere, you're not being creative". So there is one round radio, in
 * one place, and only when someone else in the room can hear you:
 * - phones: on the top bar, left of the menu button (the right thumb already goes there);
 * - desktop: bottom left over the vitals, with its key (V) under it;
 * - the lobby: inline in the lobby's top bar.
 * Hold it to talk (slide down onto the lock: hands-free), tap it for the comms sheet. Whoever is
 * talking pops out beside it as a chip; a long press on a chip mutes that player.
 */
import { MatchPhase } from '@military-forge/sim';
import { PEER_MIC, PEER_PARTY, PEER_VOICE, VoiceRoute } from '@military-forge/protocol';
import { useEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react';
import type { StoreApi } from 'zustand/vanilla';
import { keyLabel } from '../shell/controls';
import type { ShellStore } from '../shell/store';
import { Icon } from '../ui/Icon';
import { Switch } from '../ui/Screen';
import { Slider } from '../ui/Slider';
import { voiceChat } from './index';
import { LongPress, RadioPress } from './press';
import { setVoiceSettings, voiceSettings, type VoiceSettings } from './settings';
import { closeComms, commsSheet, openComms } from './sheet';
import type { Speaking, VoiceChat, VoiceState } from './voice';

function useStoreSel<T, U>(store: StoreApi<T>, select: (s: T) => U): U {
  const get = () => select(store.getState());
  return useSyncExternalStore(store.subscribe, get, get);
}

export const useVoice = <U,>(select: (s: VoiceState) => U, chat: VoiceChat = voiceChat): U => useStoreSel(chat.store, select);
export const useVoiceSettings = (): VoiceSettings => useStoreSel(voiceSettings, (s) => s);
export const useCommsOpen = (): boolean => useStoreSel(commsSheet, (s) => s.open);

/** How a voice reached you, in words (a chip's second line, the sheet's rows). */
export function routeLabel(s: Pick<Speaking, 'route' | 'lastWords'>): string {
  if (s.lastWords) return 'Last words';
  switch (s.route) {
    case VoiceRoute.Proximity:
      return 'Nearby';
    case VoiceRoute.Lobby:
      return 'Lobby';
    case VoiceRoute.Team:
      return 'Team radio';
    case VoiceRoute.Party:
      return 'Party';
    default:
      return 'Fallen';
  }
}

const initial = (name: string): string => ([...name.trim()][0] ?? '?').toUpperCase();

/** Others in the room with voice on (their VOICE_STATE flags): the radio's small count. */
export function withVoice(peers: Readonly<Record<number, number>>, mutes: readonly number[]): number {
  return Object.entries(peers).filter(([id, f]) => f & PEER_VOICE && !mutes.includes(Number(id))).length;
}

/** The radio's look right now. */
export type RadioState = 'blocked' | 'locked' | 'talking' | 'open' | 'idle';
export function radioState(st: Pick<VoiceState, 'mic' | 'talking' | 'locked'>, mode: VoiceSettings['mode']): RadioState {
  if (st.mic === 'denied' || st.mic === 'unavailable') return 'blocked';
  if (st.locked) return 'locked';
  if (st.talking) return 'talking';
  return mode === 'open' ? 'open' : 'idle';
}

const SEEN_KEY = 'voice.radio.seen.v1';
/** The radio's two-word caption ("Hold · talk") shows the first few times it appears on a device. */
function useCaption(): boolean {
  const [show] = useState(() => {
    try {
      const n = Number(localStorage.getItem(SEEN_KEY) ?? '0') || 0;
      localStorage.setItem(SEEN_KEY, String(n + 1));
      return n < 3;
    } catch {
      return false;
    }
  });
  return show;
}

export function CommsRadio({ chat = voiceChat, inline = false, phone = false }: { chat?: VoiceChat; inline?: boolean; phone?: boolean }) {
  const talking = useVoice((s) => s.talking, chat);
  const locked = useVoice((s) => s.locked, chat);
  const mic = useVoice((s) => s.mic, chat);
  const level = useVoice((s) => s.level, chat);
  const peers = useVoice((s) => s.peers, chat);
  const mutes = useVoice((s) => s.mutes, chat);
  const settings = useVoiceSettings();
  const caption = useCaption();
  const press = useRef<RadioPress | null>(null);
  press.current ??= new RadioPress(chat, openComms);
  const [slide, setSlide] = useState(0);
  const [holding, setHolding] = useState(false);
  useEffect(() => () => press.current?.cancel(), []);
  const state = radioState({ mic, talking, locked }, settings.mode);
  const blocked = state === 'blocked';
  const n = withVoice(peers, mutes);
  const key = keyLabel(chat.talkKeys[0] ?? 'KeyV');
  const down = (e: ReactPointerEvent<HTMLButtonElement>) => {
    if (e.button > 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    setHolding(true);
    press.current!.down(e.clientY, locked, settings.mode === 'ptt' && !blocked && settings.enabled, e.timeStamp);
  };
  const move = (e: ReactPointerEvent) => setSlide(press.current!.move(e.clientY));
  const up = (e: ReactPointerEvent) => {
    press.current!.up(e.timeStamp);
    setSlide(0);
    setHolding(false);
  };
  const cancel = () => {
    press.current!.cancel();
    setSlide(0);
    setHolding(false);
  };
  // a tap's own click opens the sheet (press.ts); the keyboard's and a pad's (no pointer) too
  const click = (e: ReactMouseEvent) => press.current!.click(e.detail === 0);
  const keyDown = (e: ReactKeyboardEvent) => {
    if (e.key === 'Escape') closeComms();
  };
  const label = {
    blocked: mic === 'denied' ? 'Voice: the browser blocked the mic. Tap for comms' : 'Voice: no microphone. Tap for comms',
    locked: 'Talking, locked on. Tap to stop',
    talking: 'Talking. Let go to stop',
    open: 'Voice: open mic. Tap for comms',
    idle: phone || inline ? 'Voice: hold to talk, tap for comms' : `Voice: hold ${key} to talk, click for comms`,
  }[state];
  const onAir = state === 'talking' || state === 'locked';
  return (
    <div
      className={`vc-radio is-${state}${inline ? ' vc-radio--inline' : ''}${holding ? ' is-holding' : ''}${slide > 0 ? ' is-sliding' : ''}`}
      style={{ '--lvl': level / 15, '--slide': slide } as CSSProperties}
      data-voice="radio"
    >
      <SpeakerChips chat={chat} max={phone || inline ? 2 : 4} />
      <span className="vc-radio__stack">
        <button
          type="button"
          className="vc-radio__btn"
          data-voice="talk"
          aria-label={label}
          aria-pressed={onAir}
          onPointerDown={down}
          onPointerMove={move}
          onPointerUp={up}
          onPointerCancel={cancel}
          onClick={click}
          onKeyDown={keyDown}
          onContextMenu={(e) => e.preventDefault()}
        >
          <Icon name={blocked ? 'sx-mic-off' : onAir ? 'sx-onair' : 'radio'} />
          {n > 0 && !onAir && !blocked && (
            <b className="vc-radio__n" aria-hidden="true">
              {n}
            </b>
          )}
          {locked && (
            <span className="vc-radio__badge" aria-hidden="true">
              <Icon name="lock" size="sm" />
            </span>
          )}
        </button>
        {state === 'talking' && (
          <span className="vc-radio__lock" aria-hidden="true">
            <Icon name="chev-down" size="sm" />
            <Icon name="lock" size="sm" />
          </span>
        )}
        {!phone && !inline && !onAir && (
          <span className="vc-radio__key" aria-hidden="true">
            {key}
          </span>
        )}
        {caption && !onAir && !blocked && (phone || inline) && (
          <span className="vc-radio__cap" aria-hidden="true">
            Hold · talk
          </span>
        )}
      </span>
      {onAir && (
        <span className="vc-radio__air" aria-live="polite">
          <i></i>
          {locked ? 'Live' : 'On air'}
        </span>
      )}
    </div>
  );
}

/** Who's talking, beside the radio: a chip each (two on a phone, then +N); a long press mutes. */
export function SpeakerChips({ chat = voiceChat, max }: { chat?: VoiceChat; max: number }) {
  const speaking = useVoice((s) => s.speaking, chat);
  const mutes = useVoice((s) => s.mutes, chat);
  const all = Object.entries(speaking).filter(([id]) => !mutes.includes(Number(id)));
  const shown = all.slice(0, max);
  return (
    <span className="vc-chips" aria-live="polite">
      {all.length > max && <span className="vc-chips__more">+{all.length - max}</span>}
      {shown.map(([id, s]) => (
        <SpeakerChip key={id} chat={chat} id={Number(id)} s={s} />
      ))}
    </span>
  );
}

function SpeakerChip({ chat, id, s }: { chat: VoiceChat; id: number; s: Speaking }) {
  const [muting, setMuting] = useState(false);
  const hold = useRef<LongPress | null>(null);
  hold.current ??= new LongPress(() => {
    setMuting(false);
    chat.setMuted(id, true);
  });
  useEffect(() => () => hold.current?.up(), []);
  const name = chat.name(id);
  const kind = s.lastWords ? ' is-last' : s.route === VoiceRoute.Party ? ' is-party' : s.route === VoiceRoute.Team ? ' is-team' : '';
  return (
    <button
      type="button"
      className={`vc-chip${kind}${muting ? ' is-muting' : ''}`}
      style={{ '--lvl': s.level / 15 } as CSSProperties}
      aria-label={`${name}, ${routeLabel(s)}, talking. Hold to mute`}
      onPointerDown={(e) => {
        e.preventDefault();
        setMuting(true);
        hold.current!.down();
      }}
      onPointerUp={() => {
        setMuting(false);
        hold.current!.up();
      }}
      onPointerCancel={() => {
        setMuting(false);
        hold.current!.up();
      }}
      onPointerLeave={() => {
        setMuting(false);
        hold.current!.up();
      }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <span className="avatar vc-av" aria-hidden="true">
        {initial(name)}
      </span>
      <b>{name}</b>
      <i className="vc-bars" aria-hidden="true">
        <i></i>
        <i></i>
        <i></i>
      </i>
    </button>
  );
}

// ---------------------------------------------------------------- the comms sheet

/** A live meter of your mic, with the open-mic gate's line. */
export function MicMeter({ chat = voiceChat, gateDb }: { chat?: VoiceChat; gateDb: number }) {
  const level = useVoice((s) => s.level, chat);
  const gate = Math.max(0, Math.min(1, (gateDb + 60) / 54));
  return (
    <span className="vc-meter" style={{ '--lvl': level / 15, '--gate': gate } as CSSProperties} aria-hidden="true">
      <i></i>
    </span>
  );
}

const IN_PLAY = new Set<number>([MatchPhase.Countdown, MatchPhase.InProgress]);

/**
 * The one place for everything voice besides talking (R5/R6): how you talk, your mic, voice volume,
 * opponents on or off, and everyone in the room with a one-tap mute. A side sheet from the right edge
 * (landscape: never a bottom sheet); its list scrolls inside it, with a fade at the edge.
 */
export function CommsSheet({ shell, chat = voiceChat, phone = false }: { shell: ShellStore; chat?: VoiceChat; phone?: boolean }) {
  const mic = useVoice((s) => s.mic, chat);
  const mutes = useVoice((s) => s.mutes, chat);
  const peers = useVoice((s) => s.peers, chat);
  const speaking = useVoice((s) => s.speaking, chat);
  const settings = useVoiceSettings();
  const players = useStoreSel(shell, (s) => s.lobby?.players ?? null);
  const phase = useStoreSel(shell, (s) => s.match?.phase ?? null);
  const closeBtn = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    closeBtn.current?.focus({ preventScroll: true });
    // Escape closes the sheet, not the menu under it
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== 'Escape' && e.key !== 'Escape') return;
      e.stopImmediatePropagation();
      e.preventDefault();
      if (e.type === 'keydown') closeComms();
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('keyup', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('keyup', onKey, true);
    };
  }, []);
  const me = chat.localId;
  const people = (players ?? []).filter((p) => !p.isBot && !p.you && p.id !== me);
  const blocked = mic === 'denied' || mic === 'unavailable';
  const n = withVoice(peers, mutes);
  const sub = blocked ? 'Listening only' : n === 0 ? 'Nobody else on voice' : `${n} on voice${phone || phase === null || !IN_PLAY.has(phase) ? '' : ' · nearby hear you'}`;
  const pct = (v: number) => `${Math.round(v * 100)} %`;
  return (
    <div className={`mf-fit ${phone ? 'mf-fit--phone ' : ''}kit-v2 mf-voice mf-voice--sheet`}>
      <section className={`screen screen--game vc-sheetwrap${phone ? ' screen--phone' : ''}`} role="dialog" aria-modal="true" aria-label="Comms" data-screen="comms">
        <button type="button" className="vc-scrim" aria-label="Close comms" tabIndex={-1} onClick={closeComms}></button>
        <aside className="vc-sheet">
          <header className="vc-sheet__head">
            <Icon name="radio" />
            <span className="vc-sheet__t">
              <b className="display">Comms</b>
              <span>{sub}</span>
            </span>
            <button ref={closeBtn} type="button" className="btn btn--ghost btn--icon btn--sm" aria-label="Close comms" onClick={closeComms}>
              <Icon name="close" />
            </button>
          </header>
          <div className="vc-sheet__body">
            {blocked ? (
              <div className="vc-fix" role="status">
                <span className="vc-fix__t">{mic === 'denied' ? 'The browser blocked the mic' : 'No microphone on this device'}</span>
                {mic === 'denied' && (
                  <span className="vc-fix__steps" aria-label="Tap the lock or aA by the address, then Microphone, then Allow">
                    <span className="vc-fix__step">
                      <Icon name="lock" size="sm" />
                      aA
                    </span>
                    <Icon name="chev-right" size="sm" />
                    <span className="vc-fix__step">
                      <Icon name="sx-mic" size="sm" />
                      Mic
                    </span>
                    <Icon name="chev-right" size="sm" />
                    <span className="vc-fix__step">
                      <Icon name="check" size="sm" />
                      Allow
                    </span>
                  </span>
                )}
                {mic === 'denied' && (
                  <button type="button" className="btn btn--paper btn--sm btn--block" onClick={() => void chat.testMic()}>
                    <Icon name="refresh" />
                    Try again
                  </button>
                )}
              </div>
            ) : (
              <div className="vc-sheet__mode">
                <div className="seg vc-seg" role="radiogroup" aria-label="How you talk">
                  {(
                    [
                      ['ptt', 'sx-hand', 'Hold to talk'],
                      ['open', 'sx-mic', 'Open mic'],
                    ] as const
                  ).map(([id, icon, text]) => (
                    <button type="button" key={id} className="seg__opt" role="radio" aria-checked={settings.mode === id} onClick={() => setVoiceSettings({ mode: id })}>
                      <Icon name={icon} size="sm" />
                      {text}
                    </button>
                  ))}
                </div>
                {mic === 'live' && <MicMeter chat={chat} gateDb={settings.gateDb} />}
              </div>
            )}
            <div className="vc-sheet__row">
              <Icon name="speaker" size="sm" />
              <Slider value={settings.chatVolume} onChange={(chatVolume) => setVoiceSettings({ chatVolume })} label="Voices" valueText={pct(settings.chatVolume)} />
            </div>
            <div className="vc-sheet__row">
              <Switch on={settings.hearOpponents} onChange={(hearOpponents) => setVoiceSettings({ hearOpponents })} label="Opponents nearby" showState={false} />
            </div>
            {people.length === 0 && <p className="vc-note">Bots don't talk: invite a friend.</p>}
            <ul className="vc-people">
              {people.map((p) => {
                const flags = peers[p.id] ?? 0;
                const muted = mutes.includes(p.id);
                const talk = speaking[p.id];
                const what = muted ? 'Muted' : talk ? `${routeLabel(talk)} · talking` : !(flags & PEER_VOICE) ? 'Voice off' : !(flags & PEER_MIC) ? 'Listening' : flags & PEER_PARTY ? 'Party' : 'On voice';
                return (
                  <li key={p.id} className={`vc-person${talk && !muted ? ' is-talking' : ''}${muted ? ' is-muted' : ''}`}>
                    <span className="avatar vc-av" aria-hidden="true">
                      {initial(p.name)}
                    </span>
                    <span className="vc-person__who">
                      <b>{p.name}</b>
                      <span>{what}</span>
                    </span>
                    <button type="button" className={`btn btn--sm btn--icon ${muted ? 'btn--danger' : 'btn--ghost'}`} aria-pressed={muted} aria-label={muted ? `Unmute ${p.name}` : `Mute ${p.name}`} onClick={() => chat.setMuted(p.id, !muted)}>
                      <Icon name={muted ? 'sx-vol-x' : 'sx-vol'} />
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        </aside>
      </section>
    </div>
  );
}

/** The desktop pause menu's way to the sheet (mouse, keyboard, a controller's focus): one button. */
export function CommsButton({ className, chat = voiceChat }: { className: string; chat?: VoiceChat }) {
  const active = useVoice((s) => s.active, chat);
  const peers = useVoice((s) => s.peers, chat);
  const mutes = useVoice((s) => s.mutes, chat);
  if (!active) return null;
  const n = withVoice(peers, mutes);
  return (
    <button type="button" className={className} onClick={openComms}>
      <Icon name="radio" />
      <span className="btn__stack">
        Comms
        <span className="btn__sub">{n === 0 ? 'How you talk, voice volume' : `${n} on voice · mute, volume`}</span>
      </span>
    </button>
  );
}

/** The lobbies' radio (top bar, and the folded warm-up strip): inline, with another human in the room. */
export function LobbyRadio({ players, phone = false, chat = voiceChat }: { players: readonly { isBot: boolean; you: boolean }[]; phone?: boolean; chat?: VoiceChat }) {
  const active = useVoice((s) => s.active, chat);
  if (!active || !players.some((p) => !p.isBot && !p.you)) return null;
  return <CommsRadio chat={chat} inline phone={phone} />;
}
