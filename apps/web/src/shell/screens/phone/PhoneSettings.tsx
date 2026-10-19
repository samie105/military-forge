/**
 * Phone Settings (the kit has no phone frame for it; built from its phone menus' parts): the same
 * settings as the desktop screen at phone sizes, Touch first (the controls, Edit layout, Reset
 * layout), then Graphics, Audio, Accessibility and Network. Key bindings stay on the desktop screen:
 * a phone has no keyboard. Everything saves on this device as it changes; Back and Done close it.
 *
 * Motion: the rail's rows and each section's rows rise in a stagger (P3); presses are P8.
 */
import { useEffect, useState } from 'react';
import { useStore } from 'zustand';
import { getTouchSettings, onTouchChange, openTouchEditor, resetTouchLayout, setTouchSettings, type TouchSettings } from '../../../touch';
import { DEFAULT_TOUCH_SETTINGS } from '../../../touch/settings';
import { Icon } from '../../../ui/Icon';
import { Switch, blurAfter } from '../../../ui/Screen';
import { Slider } from '../../../ui/Slider';
import { useCtl } from '../../context';
import type { AudioSettings, Settings, SettingsTab, ShellStore } from '../../store';
import { TEXT_SIZES, autoText, resetPatch } from '../Settings';
import { PhoneScreen, rise } from './layout';

/** The phone's sections: Touch first; no key bindings (Controls) on a phone. */
export const PHONE_TABS: readonly { id: SettingsTab; label: string; icon: string }[] = [
  { id: 'touch', label: 'Touch', icon: 'touch' },
  { id: 'graphics', label: 'Graphics', icon: 'monitor' },
  { id: 'audio', label: 'Audio', icon: 'speaker' },
  { id: 'accessibility', label: 'Access', icon: 'access' },
  { id: 'network', label: 'Network', icon: 'globe' },
];

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
  const set = (patch: Partial<TouchSettings>) => setTouchSettings(patch);
  return (
    <>
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
      <Row i={2} label="Fire" desc="Hold: past half-way fires. On release: lift to fire once.">
        <Seg value={t.fire} label="Fire" options={[['hold', 'Hold'], ['release', 'Release']]} onChange={(fire) => set({ fire })} />
      </Row>
      <Row i={3} label="Aim assist" desc="The aim lingers on a target it crosses.">
        <Switch on={t.aimAssist} onChange={(aimAssist) => set({ aimAssist })} label="Aim assist" />
      </Row>
      <Row i={4} label="Left-handed" desc="Mirrors the whole layout.">
        <Switch on={t.handed === 'left'} onChange={(on) => set({ handed: on ? 'left' : 'right' })} label="Left-handed" />
      </Row>
      <Row i={5} label="Vibrate when hit">
        <Switch on={t.vibrate} onChange={(vibrate) => set({ vibrate })} label="Vibrate when hit" />
      </Row>
      <Row i={6} label="Swipe to dash" desc="Swipe the move stick and lift.">
        <Switch on={t.swipeDash} onChange={(swipeDash) => set({ swipeDash })} label="Swipe to dash" />
      </Row>
      <Row i={7} label="Opacity" desc="How solid the controls' plates look.">
        <div className="pm-set__slider">
          <Slider value={(t.opacity - 0.15) / 0.85} onChange={(v) => set({ opacity: Math.round((0.15 + v * 0.85) * 100) / 100 })} label="Touch controls opacity" valueText={pct(t.opacity)} min={15} max={100} />
          <output className="num">{pct(t.opacity)}</output>
        </div>
      </Row>
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
    </>
  );
}

function Audio({ settings }: { settings: Settings }) {
  const ctl = useCtl();
  const audio = settings.audio;
  const rows: ['master' | 'effects' | 'music', string][] = [
    ['master', 'Master'],
    ['effects', 'Effects'],
    ['music', 'Music'],
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
      <Row i={3} label="Colour-blind teams">
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
      <Row i={0} label="Low-bandwidth mode" desc="Fewer updates for a weak connection.">
        <Switch on={settings.lowBandwidth} onChange={(lowBandwidth) => ctl.updateSettings({ lowBandwidth })} label="Low-bandwidth mode" />
      </Row>
      <Row i={1} label="Net graph" desc="Ping and loss in the corner.">
        <Switch on={settings.netGraph} onChange={(netGraph) => ctl.updateSettings({ netGraph })} label="Net graph" />
      </Row>
    </>
  );
}

export function PhoneSettings({ store }: { store: ShellStore }) {
  const ctl = useCtl();
  const settings = useStore(store, (s) => s.settings);
  const tab = phoneTab(useStore(store, (s) => s.settingsTab));
  const reset = () => {
    const patch = resetPatch(tab);
    if (patch) ctl.updateSettings(patch);
    else setTouchSettings(DEFAULT_TOUCH_SETTINGS);
  };
  const label = PHONE_TABS.find((t) => t.id === tab)!.label;
  return (
    <PhoneScreen name="m-settings" label="Settings" word="SET" modal states={[tab]}>
      <div className="pm pm--set">
        <header className="pm-top">
          <button type="button" className="btn btn--ghost btn--icon btn--sm" aria-label="Back" onClick={blurAfter(() => ctl.back())}>
            <Icon name="back" />
          </button>
          <b className="display pm-h">Settings</b>
          <span className="menu-top__spacer"></span>
          <button type="button" className="btn btn--ghost btn--sm" onClick={blurAfter(reset)}>
            <Icon name="refresh" />
            Reset {label}
          </button>
          <button type="button" className="btn btn--volt btn--sm" onClick={blurAfter(() => ctl.back())}>
            <Icon name="check" />
            Done
          </button>
        </header>
        <div className="pm-set-body">
          <nav className="pm-rail" role="tablist" aria-orientation="vertical" aria-label="Settings sections">
            {PHONE_TABS.map((t, i) => (
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
          </section>
        </div>
      </div>
    </PhoneScreen>
  );
}
