/**
 * Voice chat on screen (board "VOICE + HUD EDITOR · landscape-first"; the owner, 24 Oct: one voice
 * control, not a mic in every corner):
 * - VoiceHud: in a room, the radio (Radio.tsx: hold to talk, tap for comms, who's talking beside it)
 *   on the top bar of a phone or over the desktop's vitals, and the comms sheet when it's open. The
 *   lobbies carry the radio inline in their top bars (PhoneLobby.tsx, Lobby.tsx).
 * - VoiceSettingsSection: Settings › Audio's voice rows (desktop and phone): set once, out of the way.
 * The scoreboard's rows light up for whoever is talking (`#hud .sb tr[data-pid]`, hud.ts).
 */
import { MatchPhase } from '@military-forge/sim';
import { useContext, useEffect, useRef, useState, useSyncExternalStore, type ReactNode, type RefObject } from 'react';
import { ControllerContext } from '../shell/context';
import type { StoreApi } from 'zustand/vanilla';
import { usePhoneLayout } from '../shell/screens/phone/layout';
import type { ShellStore } from '../shell/store';
import { Icon } from '../ui/Icon';
import { Slider } from '../ui/Slider';
import { Switch } from '../ui/Screen';
import { voiceChat } from './index';
import { CommsRadio, CommsSheet, MicMeter, useCommsOpen, useVoice, useVoiceSettings } from './Radio';
import { setVoiceSettings } from './settings';
import { closeComms, openComms } from './sheet';
import type { VoiceChat } from './voice';

export { CommsButton, CommsRadio, routeLabel, useVoice, useVoiceSettings } from './Radio';

function useStoreSel<T, U>(store: StoreApi<T>, select: (s: T) => U): U {
  const get = () => select(store.getState());
  return useSyncExternalStore(store.subscribe, get, get);
}

/**
 * A dialog, an alert or a coach card is drawn over `near` (the radio's box, with a finger's margin):
 * the radio steps aside, so a tap meant for the card can't land on it (the mobile audit, P0-4). A tip
 * strip elsewhere on the screen leaves it be. No box: any card on screen counts.
 */
export function dialogUp(doc: Document = document, near: DOMRect | null = null): boolean {
  for (const el of doc.querySelectorAll<HTMLElement>("[role='dialog'], [role='alertdialog'], .mf-spot")) {
    if (el.closest('.mf-voice') || !el.getClientRects().length) continue;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) continue;
    if (!near) return true;
    // a coach card (ui/spotlight.ts) spans the screen: its callout and its rings are what's drawn
    const parts = el.classList.contains('mf-spot') ? [...el.querySelectorAll<HTMLElement>('.mf-spot__callout, .mf-spot__ring')] : [el];
    const m = 12;
    for (const part of parts) {
      const r = part.getBoundingClientRect();
      if (r.width && r.height && r.right > near.left - m && r.left < near.right + m && r.bottom > near.top - m && r.top < near.bottom + m) return true;
    }
  }
  return false;
}

/** dialogUp over the radio, looked at four times a second (cards come and go without telling the voice layer). */
function useDialogUp(box: RefObject<HTMLElement | null>): boolean {
  const [up, setUp] = useState(false);
  useEffect(() => {
    const look = () => {
      const btn = box.current?.querySelector('.vc-radio__btn');
      setUp(dialogUp(document, btn ? btn.getBoundingClientRect() : null));
    };
    look();
    const t = window.setInterval(look, 250);
    return () => window.clearInterval(t);
  }, [box]);
  return up;
}

/** how long the first-voice note stays if it isn't put away */
export const FIRST_NOTE_MS = 12_000;
export const FIRST_NOTE_TEXT = 'You can hear players near you, opponents too. Hold a name to mute them, or open Comms to turn voices off.';

/**
 * The first time a voice plays on this device (audit-2 L-10): one quiet line saying what it is and how
 * to stop it, once. It goes by itself.
 */
function FirstVoiceNote({ chat, phone }: { chat: VoiceChat; phone: boolean }) {
  const up = useVoice((s) => s.firstNote, chat);
  useEffect(() => {
    if (!up) return undefined;
    const t = window.setTimeout(() => chat.dismissFirstNote(), FIRST_NOTE_MS);
    return () => window.clearTimeout(t);
  }, [up, chat]);
  if (!up) return null;
  return (
    <div className={`mf-fit ${phone ? 'mf-fit--phone ' : ''}kit-v2 mf-voice mf-voice--note`}>
      <section className={`screen screen--game vc-notewrap${phone ? ' screen--phone' : ''}`} aria-label="Voice chat note">
        <p className="vc-firstnote" role="status">
          <Icon name="radio" size="sm" />
          <span>{FIRST_NOTE_TEXT}</span>
          <button
            type="button"
            className="btn btn--ink btn--sm"
            onClick={() => {
              chat.dismissFirstNote();
              openComms();
            }}
          >
            Comms
          </button>
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => chat.dismissFirstNote()}>
            OK
          </button>
        </p>
      </section>
    </div>
  );
}

/** This device or account said under 18 (audit-2 L-03): no voice at all. */
function useMinor(): boolean {
  const ctl = useContext(ControllerContext);
  const get = () => !!ctl?.store?.getState().profile?.minor;
  return useSyncExternalStore(ctl?.store ? ctl.store.subscribe : () => () => {}, get, get);
}

/** The match is over: Results is the screen (shell/App.tsx). */
const ENDED: ReadonlySet<MatchPhase> = new Set([MatchPhase.Ending, MatchPhase.Postgame, MatchPhase.Closed]);

/** The room's voice: the radio in a match, the comms sheet when open. Nothing outside online rooms, or with voice chat off. */
export function VoiceHud({ shell, chat = voiceChat }: { shell: ShellStore; chat?: VoiceChat }) {
  const minor = useMinor();
  const active = useVoice((s) => s.active, chat);
  const talking = useVoice((s) => s.talking, chat);
  const screen = useStoreSel(shell, (s) => s.screen.name);
  const phase = useStoreSel(shell, (s) => s.match?.phase ?? null);
  // the match is over and Results is up: the radio moves out of the debrief's way (UX-40)
  const results = useStoreSel(shell, (s) => !!s.match?.results) && phase !== null && ENDED.has(phase);
  const overlay = useStoreSel(shell, (s) => s.overlay);
  const open = useCommsOpen();
  const phone = usePhoneLayout();
  const box = useRef<HTMLElement>(null);
  const covered = useDialogUp(box);
  // the scoreboard's rows: who's talking (a class on the row; hud.ts gives rows data-pid)
  const speaking = useVoice((s) => s.speaking, chat);
  useEffect(() => {
    const rows = document.querySelectorAll<HTMLElement>('#hud .sb tr[data-pid]');
    for (const r of rows) r.classList.toggle('vc-talking', Number(r.dataset.pid) in speaking);
  }, [speaking]);
  // the sheet closes with the room (or voice turned off)
  const here = active && screen === 'room';
  useEffect(() => {
    if (!here && open) closeComms();
  }, [here, open]);
  // someone to talk to: another human in the room (bots don't listen)
  const humans = useStoreSel(shell, (s) => (s.lobby?.players ?? []).filter((p) => !p.isBot && !p.you).length);
  if (!here || minor) return null;
  // the lobby (Waiting) has the radio in its own top bar; the match has it on the HUD
  const radio = humans > 0 && phase !== null && phase !== MatchPhase.Waiting && overlay === null && !open;
  return (
    <>
      {radio && (
        <div className={`mf-fit ${phone ? 'mf-fit--phone ' : ''}kit-v2 mf-voice`}>
          {/* a card over the radio: it stays (measured), hidden and untouchable, until the card goes */}
          <section ref={box} className={`screen screen--game vc-screen${phone ? ' screen--phone vc-screen--phone' : ''}${results ? ' vc-screen--results' : ''}${covered && !talking ? ' is-covered' : ''}`} data-screen="voice" aria-label="Voice chat">
            <CommsRadio chat={chat} phone={phone} />
          </section>
        </div>
      )}
      {open && <CommsSheet shell={shell} chat={chat} phone={phone} />}
      {!open && <FirstVoiceNote chat={chat} phone={phone} />}
    </>
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

export function VoiceSettingsSection({ chat = voiceChat }: { chat?: VoiceChat }) {
  const minor = useMinor();
  if (minor) return null;
  return <VoiceSettingsRows chat={chat} />;
}

function VoiceSettingsRows({ chat }: { chat: VoiceChat }) {
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
      <Row phone={phone} label="How you talk" desc="Push to talk sends only while you hold the key (V), the controller's talk button or the radio. Open mic sends whenever you're louder than the mic level you set.">
        <Seg phone={phone} label="How you talk" value={s.mode} options={[['ptt', phone ? 'Hold mic' : 'Push to talk'], ['open', 'Open mic']]} onChange={(mode) => setVoiceSettings({ mode })} />
      </Row>
      {s.mode === 'open' && (
        <Row phone={phone} label="Open-mic level" desc="Your mic sends only when you're louder than this line. Anything quieter never leaves your device (the bar is your mic, live).">
          <Slider value={(s.gateDb + 70) / 55} onChange={(v) => setVoiceSettings({ gateDb: Math.round(v * 55 - 70) })} label="Open-mic level" valueText={`${s.gateDb} dB`} />
        </Row>
      )}
      <Row phone={phone} label="Mic volume" desc="How loud you are to others.">
        <Slider value={s.micVolume / 2} onChange={(v) => setVoiceSettings({ micVolume: Math.round(v * 40) / 20 })} label="Mic volume" valueText={pct(s.micVolume)} />
      </Row>
      <Row phone={phone} label="Voice chat volume" desc="Everyone you hear. Mute one player from the radio's comms: it stays muted in every room.">
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
      {support && !support.opusEncode && <p className="vc-note">This browser uses a backup voice format: clear, a little thinner. Everyone still hears you.</p>}
    </div>
  );
}
