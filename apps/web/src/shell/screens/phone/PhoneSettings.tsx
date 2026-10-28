/**
 * Phone Settings (the kit has no phone frame for it; built from its phone menus' parts): the same
 * settings as the desktop screen at phone sizes, Touch first (the controls, Edit layout, Reset
 * layout), then Graphics, Audio, Accessibility, Network and Account (save this soldier, sign in). Key bindings stay on the desktop screen:
 * a phone has no keyboard. Everything saves on this device as it changes; Back and Done close it.
 *
 * Motion: the rail's rows and each section's rows rise in a stagger (P3); presses are P8.
 */
import { useEffect, useState } from 'react';
import { useStore } from 'zustand';
import { getTouchSettings, onTouchChange, openTouchEditor, requestDrill, resetTouchHints, resetTouchLayout, setTouchPreset, setTouchSettings, type TouchSettings } from '../../../touch';
import { ASSIST_HELP, ASSIST_NAMES, DEFAULT_TOUCH_SETTINGS, autoView, PRESET_HELP, PRESET_IDS, PRESET_NAMES, STICK_MODES, STICK_MODE_HELP, STICK_MODE_NAMES, type PresetId, type StickMode } from '../../../touch/settings';
import { ASSIST_LEVELS, type AssistLevel } from '../../../input/assist';
import { canVibrate } from '../../../touch/platform';
import { Icon } from '../../../ui/Icon';
import { FIRE_MODE_TEXT } from '../../../touch/fireArt';
import { FirePicker } from '../FirePicker';
import { Switch, blurAfter } from '../../../ui/Screen';
import { Slider } from '../../../ui/Slider';
import { useCtl } from '../../context';
import type { AudioSettings, Settings, SettingsTab, ShellStore } from '../../store';
import { VoiceSettingsSection } from '../../../voice/VoiceHud';
import { TEXT_SIZES, autoText, resetPatch } from '../Settings';
import { PhoneScreen, rise } from './layout';
import { PadControls } from '../../../gamepad/PadSettings';
import { useInputDevice } from '../../../gamepad/react';
import { InstallButton } from '../../../pwa/InstallButton';
import { SendReport } from '../../../diag/SendReport';
import { AccountPanel } from '../../account/AccountPanel';
import { PrivacySettings } from '../../../metrics/PrivacySettings';

/** The phone's sections: Touch first; no key bindings (Controls) on a phone. */
export const PHONE_TABS: readonly { id: SettingsTab; label: string; icon: string }[] = [
  { id: 'touch', label: 'Touch', icon: 'touch' },
  { id: 'graphics', label: 'Graphics', icon: 'monitor' },
  { id: 'audio', label: 'Audio', icon: 'speaker' },
  { id: 'accessibility', label: 'Access', icon: 'access' },
  { id: 'network', label: 'Network', icon: 'globe' },
  { id: 'account', label: 'Account', icon: 'user' },
  { id: 'privacy', label: 'Privacy', icon: 'eye' },
];

/** A controller's section ("Pad"), once a pad has been used on this phone (gamepad/). */
const PAD_TAB = { id: 'controller', label: 'Pad', icon: 'sliders' } as const satisfies (typeof PHONE_TABS)[number];

/** The tab a phone shows: the store's, unless it's one the phone leaves to the desktop (Controls). */
export function phoneTab(tab: SettingsTab): SettingsTab {
  return PHONE_TABS.some((t) => t.id === tab) ? tab : 'touch';
}

const pct = (v: number) => `${Math.round(v * 100)}%`;

function Row({ i, label, desc, children }: { i: number; label: string; desc?: string; children: React.ReactNode }) {
  return (
    <div className="pm-set m-p3" style={rise(i)}>
      <div className="pm-set__text">
        <b>{label}</b>
        {desc && <span>{desc}</span>}
      </div>
      <div className="pm-set__ctl">{children}</div>
    </div>
  );
}

function Seg<T extends string>({ value, options, onChange, label }: { value: T; options: readonly [T, string][]; onChange: (v: T) => void; label: string }) {
  return (
    <div className="seg pm-seg" role="radiogroup" aria-label={label}>
      {options.map(([id, text]) => (
        <button type="button" key={id} className="seg__opt" role="radio" aria-checked={value === id} onClick={() => onChange(id)}>
          {text}
        </button>
      ))}
    </div>
  );
}

function useTouchSettings(): TouchSettings {
  const [s, setS] = useState(getTouchSettings);
  useEffect(() => onTouchChange(() => setS(getTouchSettings())), []);
  return s;
}

function Touch() {
  const ctl = useCtl();
  const t = useTouchSettings();
  // the view: sized to the screen until the player sets it (touch/settings.ts autoView)
  const view = t.viewAuto ? autoView(typeof window === 'undefined' ? 780 : Math.max(window.innerWidth, window.innerHeight)) : t.view;
  const viewWord = `${view <= 0.66 ? 'Close' : view >= 0.9 ? 'Wide' : 'Mid'}${t.viewAuto ? ' · auto' : ''}`;
  const set = (patch: Partial<TouchSettings>) => setTouchSettings(patch);
  const [hintsReset, setHintsReset] = useState(false);
  // "Learn the controls": in a game, at once; from the menus, in Training
  const learn = () => {
    const screen = ctl.store.getState().screen.name;
    requestDrill();
    ctl.closeOverlay();
    if (screen !== 'training' && screen !== 'room') ctl.go({ to: 'training' });
  };
  return (
    <>
      <Row i={0} label="Learn the controls" desc="A short drill in Training, one move at a time. Hints: the first-time tips again.">
        <button type="button" className="btn btn--volt btn--sm" onClick={blurAfter(learn)}>
          <Icon name="play" />
          Start
        </button>
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          aria-label="Show the hints again"
          onClick={blurAfter(() => {
            resetTouchHints();
            setHintsReset(true);
          })}
        >
          <Icon name={hintsReset ? 'check' : 'info'} />
          {hintsReset ? 'Back on' : 'Hints'}
        </button>
      </Row>
      <Row i={0} label="Layout" desc="Drag, pinch and fade each control. Saved on this phone.">
        <button
          type="button"
          className="btn btn--volt btn--sm"
          onClick={blurAfter(() => {
            ctl.closeOverlay();
            openTouchEditor();
          })}
        >
          <Icon name="edit" />
          Edit
        </button>
        <button type="button" className="btn btn--ghost btn--sm" onClick={blurAfter(() => resetTouchLayout())}>
          <Icon name="refresh" />
          Reset
        </button>
      </Row>
      <Row i={1} label="Touch controls" desc="Auto: on phones and tablets, or once you touch the screen.">
        <Seg value={t.mode} label="Touch controls" options={[['auto', 'Auto'], ['on', 'On'], ['off', 'Off']]} onChange={(mode) => set({ mode })} />
      </Row>
      {/* the owner, 23 Oct: "a way to fade the buttons" (touch/fade.ts); the pause menu has the slider too */}
      <Row i={1} label="Button fade" desc="How faded the buttons get. HP, fuel and ammo never fade.">
        <div className="pm-set__slider">
          <Slider value={(t.opacity - 0.15) / 0.85} onChange={(v) => set({ opacity: Math.round((0.15 + v * 0.85) * 100) / 100 })} label="Button fade" valueText={pct(t.opacity)} min={15} max={100} />
          <output className="num">{pct(t.opacity)}</output>
        </div>
      </Row>
      <Row i={1} label="Auto-fade" desc="Untouched buttons fade; a thumb near one lights it up.">
        <Switch on={t.autoFade} onChange={(autoFade) => set({ autoFade })} label="Auto-fade" />
      </Row>
      <div className="pm-set pm-set--block m-p3">
        <span className="pm-set__text">
          <b>Aim assist</b>
          <span>{ASSIST_HELP[t.assist]}</span>
        </span>
        <Seg value={t.assist} label="Aim assist" options={ASSIST_LEVELS.map((l) => [l, ASSIST_NAMES[l]] as [AssistLevel, string])} onChange={(assist) => set({ assist })} />
      </div>
      {/* the owner, 25 Oct: fixed sticks by default; "Follow thumb" for players who want them to move */}
      <Row i={4} label="Sticks" desc={STICK_MODE_HELP[t.sticks]}>
        <Seg value={t.sticks} label="Sticks" options={STICK_MODES.map((m) => [m, STICK_MODE_NAMES[m]] as [StickMode, string])} onChange={(sticks) => set({ sticks })} />
      </Row>
      <Row i={4} label="Left-handed" desc="Mirrors the whole layout.">
        <Switch on={t.handed === 'left'} onChange={(on) => set({ handed: on ? 'left' : 'right' })} label="Left-handed" />
      </Row>
      {/* iOS Safari can't buzz: no switches that do nothing (§4.8) */}
      {canVibrate() && (
        <Row i={5} label="Vibrate when hit">
          <Switch on={t.vibrate} onChange={(vibrate) => set({ vibrate })} label="Vibrate when hit" />
        </Row>
      )}
      <Row i={8} label="View distance" desc="Close: soldiers big and clear. Wide: more of the map. A pinch sets it too.">
        <div className="pm-set__slider">
          <Slider value={(view - 0.5) / 0.5} onChange={(v) => set({ view: Math.round((0.5 + v * 0.5) * 100) / 100, viewAuto: false })} label="View distance" valueText={viewWord} min={0} max={100} />
          <output>{viewWord}</output>
        </div>
      </Row>
      <Row i={8} label="Pinch to zoom" desc="Two fingers on one side: closer or wider. Two-finger double tap: recentre.">
        <Switch on={t.pinchZoom} onChange={(pinchZoom) => set({ pinchZoom })} label="Pinch to zoom" />
      </Row>
      <Row i={8} label="Look-ahead" desc="The view leans toward where you aim.">
        <Switch on={t.lookAhead} onChange={(lookAhead) => set({ lookAhead })} label="Look-ahead" />
      </Row>
      <Row i={9} label="Camera shake" desc="Blasts and recoil shake the view.">
        <div className="pm-set__slider">
          <Slider value={t.shake} onChange={(v) => set({ shake: Math.round(v * 20) / 20 })} label="Camera shake" valueText={pct(t.shake)} min={0} max={100} />
          <output className="num">{pct(t.shake)}</output>
        </div>
      </Row>
      {/* the mobile audit (P0-5, P2-7): a stranger sees the few settings that matter; the fire modes,
          the presets and the expert switches wait under Advanced (Auto fire and Classic are the defaults) */}
      <details className="pm-adv m-p3">
        <summary className="pm-adv__sum">
          <b>Advanced</b>
          <span>Fire modes, layouts and gestures</span>
        </summary>
        <div className="pm-set pm-set--block m-p3">
          <span className="pm-set__text">
            <b>Fire</b>
            <span>{FIRE_MODE_TEXT[t.fire].line}</span>
          </span>
          <FirePicker value={t.fire} onChange={(fire) => set({ fire, fireChosen: true })} compact />
        </div>
        <Row i={2} label="Precision weapons fire on release" desc="Auto and Pull: snipers, DMRs, charged guns and launchers fire as you lift.">
          <Switch on={t.precisionRelease} onChange={(precisionRelease) => set({ precisionRelease })} label="Precision weapons fire on release" />
        </Row>
        {t.fire === 'button' && (
          <Row i={2} label="A second Fire button on the left" desc="Top left, for your left index finger.">
            <Switch on={t.leftFire} onChange={(leftFire) => set({ leftFire })} label="A second Fire button on the left" />
          </Row>
        )}
        {/* controls spec §4.2 (item 7): the presets; moving a control in the editor makes it "My layout" there */}
        <div className="pm-set pm-set--block m-p3">
          <span className="pm-set__text">
            <b>Preset</b>
            <span>{PRESET_HELP[t.preset]}</span>
          </span>
          <Seg value={t.preset} label="Preset" options={PRESET_IDS.map((id) => [id, id === 'oneThumb' ? 'One-thumb' : PRESET_NAMES[id]] as [PresetId, string])} onChange={(preset) => setTouchPreset(preset)} />
        </div>
        <Row i={4} label="Push up to fly" desc="The move stick flies. Off in Claw: Jet is a button.">
          <Switch on={t.stickJet} onChange={(stickJet) => set({ stickJet })} label="Push up to fly" />
        </Row>
        <Row i={4} label="Extra finger fires" desc="A second finger on the right fires while it's down.">
          <Switch on={t.tapFire} onChange={(tapFire) => set({ tapFire })} label="Extra finger fires" />
        </Row>
        <Row i={6} label="Flick to dash" desc="Flick the move stick and lift.">
          <Switch on={t.swipeDash} onChange={(swipeDash) => set({ swipeDash })} label="Flick to dash" />
        </Row>
        <Row i={6} label="Keep aiming after a button" desc="Back on the aim stick soon after a button: your aim and fire carry on.">
          <Switch on={t.keepAim} onChange={(keepAim) => set({ keepAim })} label="Keep aiming after a button" />
        </Row>
        <Row i={6} label="Button gestures" desc="Swipe Grenade to change it, hold the gun button for quick-select, swipe Dash. Off: plain taps.">
          <Switch on={t.gestures} onChange={(gestures) => set({ gestures })} label="Button gestures" />
        </Row>
        {canVibrate() && (
          <Row i={7} label="Button haptics" desc="A short buzz on a throw, a swap, a dash swipe.">
            <Switch on={t.haptics} onChange={(haptics) => set({ haptics })} label="Button haptics" />
          </Row>
        )}
      </details>
    </>
  );
}

function Graphics({ settings }: { settings: Settings }) {
  const ctl = useCtl();
  return (
    <>
      <Row i={0} label="Quality" desc={settings.graphics === 'auto' ? autoText(ctl.host.autoGraphics) : 'Lower it if the game feels slow.'}>
        <Seg
          value={settings.graphics}
          label="Quality"
          options={[
            ['auto', 'Auto'],
            ['low', 'Low'],
            ['medium', 'Med'],
            ['high', 'High'],
          ]}
          onChange={(graphics) => ctl.updateSettings({ graphics })}
        />
      </Row>
      <Row i={1} label="Blood effects" desc="Off by default.">
        <Switch on={settings.blood} onChange={(blood) => ctl.updateSettings({ blood })} label="Blood effects" />
      </Row>
      <Row i={2} label="Show FPS" desc="A frame counter in the corner.">
        <Switch on={settings.showFps} onChange={(showFps) => ctl.updateSettings({ showFps })} label="Show FPS" />
      </Row>
      <Row i={3} label="Others' kill effects" desc="Off: their kills show the normal death.">
        <Switch on={settings.showKillEffects} onChange={(showKillEffects) => ctl.updateSettings({ showKillEffects })} label="Show other players' kill effects" />
      </Row>
    </>
  );
}

function Audio({ settings }: { settings: Settings }) {
  const ctl = useCtl();
  const audio = settings.audio;
  const rows: ['master' | 'effects' | 'music' | 'ui' | 'voice', string][] = [
    ['master', 'Master'],
    ['effects', 'Effects'],
    ['music', 'Music'],
    ['ui', 'Interface'],
    ['voice', 'Voices'],
  ];
  const set = (patch: Partial<AudioSettings>) => ctl.updateSettings({ audio: { ...audio, ...patch } });
  return (
    <>
      {rows.map(([k, label], i) => {
        const muted = audio[`${k}Muted`];
        return (
          <Row key={k} i={i} label={label}>
            <div className="pm-set__slider">
              <button type="button" className={`btn btn--sm btn--icon ${muted ? 'btn--paper' : 'btn--ghost'}`} aria-label={muted ? `Unmute ${label.toLowerCase()}` : `Mute ${label.toLowerCase()}`} aria-pressed={muted} onClick={() => set({ [`${k}Muted`]: !muted })}>
                <Icon name="speaker" />
              </button>
              <Slider value={audio[k]} onChange={(v) => set({ [k]: v })} label={`${label} volume`} valueText={pct(audio[k])} />
              <output className="num">{pct(audio[k])}</output>
            </div>
          </Row>
        );
      })}
      <Row i={rows.length} label="Headphones (3D sound)" desc="Earbuds: enemies placed by ear. Off for speakers.">
        <Switch on={audio.headphones} onChange={(headphones) => set({ headphones })} label="Headphones (3D sound)" />
      </Row>
      {/* voice chat (voice/): its own rows, saved on this device */}
      <VoiceSettingsSection />
    </>
  );
}

function Accessibility({ settings }: { settings: Settings }) {
  const ctl = useCtl();
  const i = Math.max(0, TEXT_SIZES.findIndex((t) => Math.abs(t - settings.textScale) < 0.01));
  return (
    <>
      <Row i={0} label="Text size">
        <div className="pm-set__slider">
          <Slider value={i / (TEXT_SIZES.length - 1)} step={1 / (TEXT_SIZES.length - 1)} onChange={(v) => ctl.updateSettings({ textScale: TEXT_SIZES[Math.round(v * (TEXT_SIZES.length - 1))]! })} label="Text size" valueText={pct(settings.textScale)} />
          <output className="num">{pct(settings.textScale)}</output>
        </div>
      </Row>
      <Row i={1} label="Reduce motion" desc="Fades instead of moves.">
        <Switch on={settings.reduceMotion} onChange={(reduceMotion) => ctl.updateSettings({ reduceMotion })} label="Reduce motion" />
      </Row>
      <Row i={2} label="Reduce flashes" desc="No bright flashes or fast blinking.">
        <Switch on={settings.reduceFlashes} onChange={(reduceFlashes) => ctl.updateSettings({ reduceFlashes })} label="Reduce flashes" />
      </Row>
      <Row i={3} label="Soften loud bursts" desc="Quieter blasts, no ear ring.">
        <Switch on={settings.softBursts} onChange={(softBursts) => ctl.updateSettings({ softBursts })} label="Soften loud bursts" />
      </Row>
      <Row i={4} label="Colour-blind teams">
        <Seg
          value={settings.colorBlind}
          label="Colour-blind teams"
          options={[
            ['standard', 'Off'],
            ['deutan', 'Red-green'],
            ['tritan', 'Blue-yellow'],
          ]}
          onChange={(colorBlind) => ctl.updateSettings({ colorBlind })}
        />
      </Row>
    </>
  );
}

function Network({ settings }: { settings: Settings }) {
  const ctl = useCtl();
  return (
    <>
      <Row i={0} label="Data saver" desc="Fewer updates for a weak connection.">
        <Switch on={settings.lowBandwidth} onChange={(lowBandwidth) => ctl.updateSettings({ lowBandwidth })} label="Data saver" />
      </Row>
      <Row i={1} label="Connection stats" desc="Ping and loss in the corner.">
        <Switch on={settings.netGraph} onChange={(netGraph) => ctl.updateSettings({ netGraph })} label="Connection stats" />
      </Row>
      <div className="pm-set pm-set--block m-p3" style={rise(2)}>
        <span className="pm-set__text">
          <b>Something went wrong?</b>
          <span>Send us what happened on this phone, so we can fix it. A failed room connection sends one by itself.</span>
        </span>
        <SendReport context="settings" />
      </div>
    </>
  );
}

export function PhoneSettings({ store }: { store: ShellStore }) {
  const ctl = useCtl();
  const settings = useStore(store, (s) => s.settings);
  const padSeen = useInputDevice().pad !== null;
  const tabs = padSeen ? [...PHONE_TABS, PAD_TAB] : PHONE_TABS;
  const stored = useStore(store, (s) => s.settingsTab);
  const tab = padSeen && stored === 'controller' ? 'controller' : phoneTab(stored);
  const reset = () => {
    const patch = resetPatch(tab);
    if (patch) ctl.updateSettings(patch);
    else if (tab === 'touch') setTouchSettings(DEFAULT_TOUCH_SETTINGS);
  };
  const label = tabs.find((t) => t.id === tab)!.label;
  return (
    <PhoneScreen name="m-settings" label="Settings" word="SET" modal dialog states={[tab]}>
      <div className="pm pm--set">
        <header className="pm-top">
          <button type="button" className="btn btn--ghost btn--icon btn--sm" aria-label="Back" onClick={blurAfter(() => ctl.back())}>
            <Icon name="back" />
          </button>
          <b className="display pm-h">Settings</b>
          <span className="menu-top__spacer"></span>
          <InstallButton />
          {tab !== 'account' && (
            <button type="button" className="btn btn--ghost btn--sm" onClick={blurAfter(reset)}>
              <Icon name="refresh" />
              Reset {label}
            </button>
          )}
          <button type="button" className="btn btn--volt btn--sm" onClick={blurAfter(() => ctl.back())}>
            <Icon name="check" />
            Done
          </button>
        </header>
        <div className="pm-set-body">
          <nav className="pm-rail" role="tablist" aria-orientation="vertical" aria-label="Settings sections">
            {tabs.map((t, i) => (
              <button type="button" key={t.id} role="tab" aria-selected={tab === t.id} className={`pm-rail__i m-p3${tab === t.id ? ' is-on' : ''}`} style={rise(i)} onClick={() => ctl.setSettingsTab(t.id)}>
                <Icon name={t.icon} />
                <span>{t.label}</span>
              </button>
            ))}
          </nav>
          {/* keyed by the tab, so a section's rows rise in when it opens */}
          <section key={tab} className="card card--print pm-set-panel" role="tabpanel" aria-label={label}>
            {tab === 'touch' && <Touch />}
            {tab === 'graphics' && <Graphics settings={settings} />}
            {tab === 'audio' && <Audio settings={settings} />}
            {tab === 'accessibility' && <Accessibility settings={settings} />}
            {tab === 'network' && <Network settings={settings} />}
            {tab === 'account' && <AccountPanel store={store} variant="phone" />}
            {tab === 'privacy' && <PrivacySettings phone />}
            {tab === 'controller' && <PadControls phone pad={settings.pad} onChange={(pad) => ctl.updateSettings({ pad })} reduceFlashes={settings.reduceFlashes} />}
          </section>
        </div>
      </div>
    </PhoneScreen>
  );
}
