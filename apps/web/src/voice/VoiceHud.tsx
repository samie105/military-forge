/**
 * Voice chat on screen (board "SOCIAL", S4/S5/P3/P4):
 * - VoiceHud: in a room, the push-to-talk plate (desktop, in play: "V · Hold to talk", volt while
 *   talking, with the channel), the phone's mic button (hold to talk, slide up to lock hands-free)
 *   and the strip of who's talking (their channel: Nearby, Party, Team, Last words, Lobby, Dead).
 * - VoiceSettingsSection: Settings › Audio's voice rows (desktop and phone).
 * - VoicePauseCard: the pause menu's comms card: mute a player, Mute all opponents, Report (soon).
 * The scoreboard's rows light up for whoever is talking (`#hud .sb tr[data-pid]`, hud.ts).
 */
import { MatchPhase } from '@military-forge/sim';
import { VoiceChannel, VoiceRoute, PEER_MIC, PEER_PARTY, PEER_VOICE } from '@military-forge/protocol';
import { useEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import type { StoreApi } from 'zustand/vanilla';
import { usePhoneLayout } from '../shell/screens/phone/layout';
import type { ShellStore } from '../shell/store';
import { Icon } from '../ui/Icon';
import { Slider } from '../ui/Slider';
import { Switch } from '../ui/Screen';
import { keyLabel } from '../shell/controls';
import { voiceChat } from './index';
import { setVoiceSettings, voiceSettings, type VoiceSettings } from './settings';
import type { Speaking, VoiceChat, VoiceState } from './voice';

function useStoreSel<T, U>(store: StoreApi<T>, select: (s: T) => U): U {
  const get = () => select(store.getState());
  return useSyncExternalStore(store.subscribe, get, get);
}

export const useVoice = <U,>(select: (s: VoiceState) => U, chat: VoiceChat = voiceChat): U => useStoreSel(chat.store, select);
export const useVoiceSettings = (): VoiceSettings => useStoreSel(voiceSettings, (s) => s);

/** How a voice reached you, in words. */
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

const IN_PLAY = new Set<number>([MatchPhase.Countdown, MatchPhase.InProgress]);

/** The room's voice HUD. Nothing outside online rooms, or with voice chat off. */
export function VoiceHud({ shell, chat = voiceChat }: { shell: ShellStore; chat?: VoiceChat }) {
  const active = useVoice((s) => s.active, chat);
  const screen = useStoreSel(shell, (s) => s.screen.name);
  const phase = useStoreSel(shell, (s) => s.match?.phase ?? null);
  const overlay = useStoreSel(shell, (s) => s.overlay);
  const phone = usePhoneLayout();
  // the scoreboard's rows: who's talking (a class on the row; hud.ts gives rows data-pid)
  const speaking = useVoice((s) => s.speaking, chat);
  useEffect(() => {
    const rows = document.querySelectorAll<HTMLElement>('#hud .sb tr[data-pid]');
    for (const r of rows) r.classList.toggle('vc-talking', Number(r.dataset.pid) in speaking);
  }, [speaking]);
  // someone to talk to: another human in the room (bots don't listen)
  const humans = useStoreSel(shell, (s) => (s.lobby?.players ?? []).filter((p) => !p.isBot && !p.you).length);
  if (!active || screen !== 'room') return null;
  const inPlay = phase === null || IN_PLAY.has(phase);
  return (
    <div className={`mf-fit ${phone ? 'mf-fit--phone ' : ''}kit-v2 mf-voice`}>
      <section className={`screen screen--game vc-screen${phone ? ' screen--phone vc-screen--phone' : ''}`} data-screen="voice" aria-label="Voice chat">
        <TalkingStrip chat={chat} phone={phone} />
        {phone ? overlay === null && humans > 0 && <PhoneMic chat={chat} /> : inPlay && overlay === null && <PttPlate chat={chat} />}
      </section>
    </div>
  );
}

function TalkingStrip({ chat, phone }: { chat: VoiceChat; phone: boolean }) {
  const speaking = useVoice((s) => s.speaking, chat);
  const mic = useVoice((s) => s.mic, chat);
  const warn = mic === 'denied' || mic === 'unavailable';
  // phones: two rows at most (the vitals are just below)
  const entries = Object.entries(speaking).slice(0, phone ? (warn ? 1 : 2) : 4);
  return (
    <div className="vc-strip" aria-live="polite">
      {warn && (
        <span className="vc-chip vc-chip--warn">
          <Icon name="sx-mic-off" size="sm" />
          {mic === 'denied' ? 'Mic blocked · listening only' : 'No mic · listening only'}
        </span>
      )}
      {entries.map(([id, s]) => (
        <span key={id} className={`vc-chip vc-chip--talk${s.lastWords ? ' is-last' : ''}${s.route === VoiceRoute.Party ? ' is-party' : ''}`} style={{ '--lvl': s.level / 15 } as CSSProperties}>
          <span className="avatar vc-av" aria-hidden="true">
            {([...chat.name(Number(id)).trim()][0] ?? '?').toUpperCase()}
          </span>
          <span className="vc-chip__who">
            <b>{chat.name(Number(id))}</b>
            <span>{routeLabel(s)}</span>
          </span>
          <i className="vc-bars" aria-hidden="true">
            <i></i>
            <i></i>
            <i></i>
          </i>
        </span>
      ))}
    </div>
  );
}

/** Desktop: the push-to-talk plate, bottom left over the vitals. */
function PttPlate({ chat }: { chat: VoiceChat }) {
  const talking = useVoice((s) => s.talking, chat);
  const channel = useVoice((s) => s.channel, chat);
  const level = useVoice((s) => s.level, chat);
  const mic = useVoice((s) => s.mic, chat);
  const settings = useVoiceSettings();
  if (mic === 'denied' || mic === 'unavailable') return null;
  const key = keyLabel(chat.talkKeys[0] ?? 'KeyV');
  return (
    <div className={`vc-ptt${talking ? ' is-on' : ''}`} style={{ '--lvl': level / 15 } as CSSProperties}>
      <span className="vc-ptt__mic">
        <Icon name="sx-mic" />
      </span>
      {talking ? (
        <span className="vc-ptt__text">
          <b>Talking · {channel === VoiceChannel.Party ? 'party' : 'nearby'}</b>
          <span>{settings.mode === 'open' ? 'Open mic' : `Let go of ${key} to stop`}</span>
        </span>
      ) : (
        <span className="vc-ptt__text">
          <b>{settings.mode === 'open' ? 'Open mic' : `Hold ${key} to talk`}</b>
          <span>{settings.mode === 'open' ? 'Talk: it opens when you do' : `${keyLabel(chat.partyKeys[0] ?? 'KeyB')}: your party only`}</span>
        </span>
      )}
    </div>
  );
}

/** Phone: hold the mic to talk; slide it up to lock it on (tap again to stop). */
/**
 * The phone's push-to-talk (the owner, 23 Oct: "see where the mic is"): a mic button on the top edge
 * beside the menu button, clear of both thumbs, with a word under it for its state. Hold to talk; slide
 * down to lock it on (a tap stops). Blocked or missing, it stays and says so (a tap says how to fix it).
 */
/** A dialog, an alert or a coach card is on screen (drawn, not just in the page): the mic steps aside. */
export function dialogUp(doc: Document = document): boolean {
  for (const el of doc.querySelectorAll<HTMLElement>("[role='dialog'], [role='alertdialog'], .mf-spot")) {
    if (el.closest('.vc-mic') || !el.getClientRects().length) continue;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) continue;
    return true;
  }
  return false;
}

/** dialogUp, looked at four times a second (cards come and go without telling the voice layer). */
function useDialogUp(): boolean {
  const [up, setUp] = useState(false);
  useEffect(() => {
    const look = () => setUp(dialogUp());
    look();
    const t = window.setInterval(look, 250);
    return () => window.clearInterval(t);
  }, []);
  return up;
}

export function PhoneMic({ chat }: { chat: VoiceChat }) {
  const talking = useVoice((s) => s.talking, chat);
  const locked = useVoice((s) => s.locked, chat);
  const mic = useVoice((s) => s.mic, chat);
  const start = useRef<{ y: number; id: number } | null>(null);
  const [sliding, setSliding] = useState(false);
  const [help, setHelp] = useState(false);
  const blocked = mic === 'denied' || mic === 'unavailable';
  // never over a card: a tap meant for its button can't land on the mic (the mobile audit, P0-4)
  const covered = useDialogUp();
  useEffect(() => {
    if (!help) return undefined;
    const t = window.setTimeout(() => setHelp(false), 4000);
    return () => window.clearTimeout(t);
  }, [help]);
  const down = (e: ReactPointerEvent) => {
    e.preventDefault();
    if (blocked) {
      setHelp(true);
      return;
    }
    e.currentTarget.setPointerCapture(e.pointerId);
    start.current = { y: e.clientY, id: e.pointerId };
    chat.touchDown();
  };
  const move = (e: ReactPointerEvent) => {
    if (!start.current || locked) return;
    const dy = e.clientY - start.current.y;
    setSliding(dy > 16);
    if (dy > 48) {
      start.current = null;
      setSliding(false);
      chat.lock();
    }
  };
  const up = () => {
    if (blocked) return;
    start.current = null;
    setSliding(false);
    chat.touchUp();
  };
  if (covered && !talking) return null;
  const state = blocked ? 'blocked' : locked ? 'locked' : talking ? 'talking' : mic === 'asking' ? 'asking' : 'idle';
  const word = { blocked: mic === 'denied' ? 'Mic blocked' : 'No mic', locked: 'On · tap to stop', talking: 'Talking', asking: 'Allow the mic', idle: 'Talk' }[state];
  const label = {
    blocked: mic === 'denied' ? 'Microphone blocked: allow it in the browser\'s site settings' : 'No microphone found',
    locked: 'Talking, locked on: tap to stop',
    talking: 'Talking: let go to stop',
    asking: 'Allow the microphone to talk',
    idle: 'Hold to talk; slide down to lock it on',
  }[state];
  return (
    <div className={`vc-mic is-${state}${sliding ? ' is-sliding' : ''}`}>
      <button
        type="button"
        className="vc-mic__btn"
        aria-label={label}
        aria-pressed={talking}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={up}
        onContextMenu={(e) => e.preventDefault()}
      >
        <Icon name="sx-mic" />
        <span className="vc-mic__word" aria-hidden="true">
          {word}
        </span>
      </button>
      {(talking || sliding) && !locked && (
        <span className="vc-mic__lock" aria-hidden="true">
          <Icon name="chev-down" size="sm" />
          <Icon name="lock" size="sm" />
        </span>
      )}
      {help && (
        <span className="vc-mic__help" role="status">
          {mic === 'denied' ? 'The browser blocked the mic. Allow it in the site settings (the icon left of the address), then come back.' : 'No microphone on this device.'}
        </span>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- Settings › Audio › Voice chat

function Row({ phone, label, desc, children }: { phone: boolean; label: string; desc: string; children: ReactNode }) {
  return phone ? (
    <div className="pm-set">
      <div className="pm-set__text">
        <b>{label}</b>
      </div>
      <div className="pm-set__ctl">{children}</div>
    </div>
  ) : (
    <div className="srow">
      <div className="srow__txt">
        <b>{label}</b>
        <span>{desc}</span>
      </div>
      <div className="srow__ctrl">{children}</div>
    </div>
  );
}

function Seg<T extends string>({ value, options, onChange, label, phone }: { value: T; options: readonly [T, string][]; onChange: (v: T) => void; label: string; phone: boolean }) {
  return (
    <div className={`seg${phone ? ' pm-seg' : ''}`} role="radiogroup" aria-label={label}>
      {options.map(([id, text]) => (
        <button type="button" key={id} className="seg__opt" role="radio" aria-checked={value === id} onClick={() => onChange(id)}>
          {text}
        </button>
      ))}
    </div>
  );
}

/** A live meter of your mic (Test mic), with the open-mic gate's line. */
function MicMeter({ chat, gateDb }: { chat: VoiceChat; gateDb: number }) {
  const level = useVoice((s) => s.level, chat);
  const gate = Math.max(0, Math.min(1, (gateDb + 60) / 54));
  return (
    <span className="vc-meter" style={{ '--lvl': level / 15, '--gate': gate } as CSSProperties} aria-hidden="true">
      <i></i>
    </span>
  );
}

export function VoiceSettingsSection({ chat = voiceChat }: { chat?: VoiceChat }) {
  const s = useVoiceSettings();
  const mic = useVoice((v) => v.mic, chat);
  const support = useVoice((v) => v.support, chat);
  const phone = usePhoneLayout();
  // the Test mic's mic goes off with Settings (outside a room)
  useEffect(() => () => chat.endTest(), [chat]);
  const pct = (v: number) => `${Math.round(v * 100)} %`;
  const micLine =
    mic === 'live'
      ? 'Allowed and on'
      : mic === 'denied'
        ? 'Blocked by the browser: tap the lock or aA by the address › Microphone › Allow, then Try again. You still hear everyone.'
        : mic === 'unavailable'
          ? 'No microphone found: you can listen.'
          : 'The browser asks the first time you talk.';
  return (
    <div className="vc-settings" aria-label="Voice chat">
      <h3 className={phone ? 'label label--volt vc-settings__h' : 'display set__h vc-settings__h'}>Voice chat</h3>
      <Row phone={phone} label="Voice chat" desc="Talk to soldiers near you, your party, and your team in team modes. Off: you hear nobody and send nothing.">
        <Switch on={s.enabled} onChange={(enabled) => setVoiceSettings({ enabled })} label="Voice chat" />
      </Row>
      <Row phone={phone} label="Microphone" desc={micLine}>
        <span className="vc-microw">
          {mic === 'live' && <MicMeter chat={chat} gateDb={s.gateDb} />}
          <span className={`tag ${mic === 'live' ? 'tag--ok' : mic === 'denied' ? 'tag--warn' : 'tag--ghost'}`}>{mic === 'live' ? 'Allowed' : mic === 'denied' ? 'Blocked' : mic === 'unavailable' ? 'None' : 'Not asked'}</span>
          {mic !== 'live' && mic !== 'unavailable' && (
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => void chat.testMic()}>
              <Icon name="sx-mic" />
              {mic === 'denied' ? 'Try again' : 'Test mic'}
            </button>
          )}
        </span>
      </Row>
      <Row phone={phone} label="How you talk" desc="Push to talk sends only while you hold the key (V), the controller's talk button or the phone's mic. Open mic sends when you're louder than the gate.">
        <Seg phone={phone} label="How you talk" value={s.mode} options={[['ptt', phone ? 'Hold mic' : 'Push to talk'], ['open', 'Open mic']]} onChange={(mode) => setVoiceSettings({ mode })} />
      </Row>
      {s.mode === 'open' && (
        <Row phone={phone} label="Open-mic gate" desc="Sound under the line never leaves your device (the bar is your mic, live).">
          <Slider value={(s.gateDb + 70) / 55} onChange={(v) => setVoiceSettings({ gateDb: Math.round(v * 55 - 70) })} label="Open-mic gate" valueText={`${s.gateDb} dB`} />
        </Row>
      )}
      <Row phone={phone} label="Mic volume" desc="How loud you are to others.">
        <Slider value={s.micVolume / 2} onChange={(v) => setVoiceSettings({ micVolume: Math.round(v * 40) / 20 })} label="Mic volume" valueText={pct(s.micVolume)} />
      </Row>
      <Row phone={phone} label="Voice chat volume" desc="Everyone you hear. Mute one player from the pause menu.">
        <Slider value={s.chatVolume} onChange={(chatVolume) => setVoiceSettings({ chatVolume })} label="Voice chat volume" valueText={pct(s.chatVolume)} />
      </Row>
      <Row phone={phone} label="Proximity voice" desc="Anyone near your soldier hears you, enemies too, from where you stand. Your party hears you anywhere (B).">
        <Switch on={s.proximity} onChange={(proximity) => setVoiceSettings({ proximity })} label="Proximity voice" />
      </Row>
      <Row phone={phone} label="Hear opponents" desc="Off: only your party and team. The pause menu has Mute all opponents too.">
        <Switch on={s.hearOpponents} onChange={(hearOpponents) => setVoiceSettings({ hearOpponents })} label="Hear opponents" />
      </Row>
      <Row phone={phone} label="Voice quality" desc="Auto rises on Wi-Fi and 5G and drops on a weak signal. Data saver stays at the lowest.">
        <Seg phone={phone} label="Voice quality" value={s.quality} options={[['auto', 'Auto'], ['saver', 'Data saver']]} onChange={(quality) => setVoiceSettings({ quality })} />
      </Row>
      {support && !support.opusEncode && <p className="vc-note">This browser talks in the backup voice codec (clear, a little thinner). Everyone still hears you.</p>}
    </div>
  );
}

// ---------------------------------------------------------------- the pause menu's comms card

export function VoicePauseCard({ shell, chat = voiceChat }: { shell: ShellStore; chat?: VoiceChat }) {
  const active = useVoice((s) => s.active, chat);
  const mutes = useVoice((s) => s.mutes, chat);
  const peers = useVoice((s) => s.peers, chat);
  const speaking = useVoice((s) => s.speaking, chat);
  const players = useStoreSel(shell, (s) => s.lobby?.players ?? null);
  const settings = useVoiceSettings();
  const phone = usePhoneLayout();
  if (!active || !players) return null;
  const me = chat.localId;
  const people = players.filter((p) => !p.isBot && !p.you && p.id !== me);
  return (
    <aside className={`vc-pause m-p3${phone ? ' vc-pause--phone' : ''}`} aria-label="Voice: mute players">
      <header className="vc-pause__head">
        <span className="label label--volt">Comms</span>
        <span className="menu-top__spacer"></span>
        <Switch on={!settings.hearOpponents} onChange={(on) => setVoiceSettings({ hearOpponents: !on })} label="Mute all opponents" showState={false} />
      </header>
      {people.length === 0 && <p className="vc-note">Nobody else here talks yet: bots don't.</p>}
      <ul className="vc-pause__list">
        {people.map((p) => {
          const flags = peers[p.id] ?? 0;
          const muted = mutes.includes(p.id);
          const talking = p.id in speaking;
          return (
            <li key={p.id} className={`vc-pause__row${talking ? ' is-talking' : ''}`}>
              <span className="avatar vc-av" aria-hidden="true">
                {([...p.name.trim()][0] ?? '?').toUpperCase()}
              </span>
              <span className="vc-chip__who">
                <b>{p.name}</b>
                <span>{!(flags & PEER_VOICE) ? 'Voice off' : !(flags & PEER_MIC) ? 'Listening only' : flags & PEER_PARTY ? 'Your party' : 'Has a mic'}</span>
              </span>
              <button type="button" className={`btn btn--sm btn--icon ${muted ? 'btn--paper' : 'btn--ghost'}`} aria-pressed={muted} aria-label={muted ? `Unmute ${p.name}` : `Mute ${p.name}`} onClick={() => chat.setMuted(p.id, !muted)}>
                <Icon name={muted ? 'sx-vol-x' : 'sx-vol'} />
              </button>
              {/* reporting comes later: the hook is here */}
              <button type="button" className="btn btn--ghost btn--sm btn--icon" disabled data-hook="report" title="Reporting is coming" aria-label={`Report ${p.name} (coming)`}>
                <Icon name="sx-flag" />
              </button>
            </li>
          );
        })}
      </ul>
    </aside>
  );
}
