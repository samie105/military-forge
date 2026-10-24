/**
 * 11 · Settings (the kit's data-screen="settings"): Graphics, Audio, Controls (two keys per action,
 * click then press), Accessibility, Network, and Touch for the phone controls (touch-interfaces.md).
 * Everything saves on this device as it changes; Back (Esc) and Done close it.
 */
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { useStore } from 'zustand';
import { framesPerSecond, netHistory, NET_HISTORY } from '../../stats';
import { getTouchSettings, onTouchChange, openTouchEditor, resetTouchLayout, setTouchPreset, setTouchSettings, type TouchSettings } from '../../touch';
import { ASSIST_HELP, ASSIST_NAMES, DEFAULT_TOUCH_SETTINGS, PRESET_HELP, PRESET_IDS, PRESET_NAMES, type PresetId } from '../../touch/settings';
import { ASSIST_LEVELS, type AssistLevel } from '../../input/assist';
import { canVibrate } from '../../touch/platform';
import { PadControls } from '../../gamepad/PadSettings';
import { DEFAULT_PAD_SETTINGS } from '../../gamepad/settings';
import { Icon } from '../../ui/Icon';
import { FirePicker } from './FirePicker';
import { Kbd, Cap } from '../../ui/Kbd';
import { Screen, Switch, blurAfter, pingQuality } from '../../ui/Screen';
import { moveIndicator } from '../../ui/motion';
import { Slider } from '../../ui/Slider';
import { useCtl, useKeyboardLayout, useTicker } from '../context';
import { ACTIONS, MAX_BINDINGS, defaultBindings, keyLabel, rebind, unbind, type ActionDef, type ActionId } from '../controls';
import { VoiceSettingsSection } from '../../voice/VoiceHud';
import { DEFAULT_AUDIO, DEFAULT_SETTINGS, type AudioSettings, type GraphicsPreset, type Settings, type SettingsTab, type ShellStore } from '../store';
import { Backdrop } from './frame';
import { InstallButton } from '../../pwa/InstallButton';
import { SendReport } from '../../diag/SendReport';

export const TABS: readonly { id: SettingsTab; label: string; icon: string }[] = [
  { id: 'graphics', label: 'Graphics', icon: 'monitor' },
  { id: 'audio', label: 'Audio', icon: 'speaker' },
  { id: 'controls', label: 'Controls', icon: 'keyboard' },
  { id: 'controller', label: 'Controller', icon: 'sliders' },
  { id: 'accessibility', label: 'Accessibility', icon: 'access' },
  { id: 'network', label: 'Network', icon: 'globe' },
  { id: 'touch', label: 'Touch', icon: 'target' },
];

/** What each preset changes (render3d/presets.ts), in words. */
const QUALITY: readonly { id: GraphicsPreset; name: string; text: string }[] = [
  { id: 'low', name: 'Low', text: 'Fastest. Simple shadows, fewer particles, lighter models for far-away players.' },
  { id: 'medium', name: 'Medium', text: 'Smoother edges, more particles and fuller effects. Simple shadows.' },
  { id: 'high', name: 'High', text: 'Sharpest picture, real shadows, full explosions and muzzle light.' },
];

export const TEXT_SIZES = [1, 1.1, 1.2, 1.3, 1.4, 1.5] as const;

const pct = (v: number) => `${Math.round(v * 100)}%`;

// ------------------------------------------------------------------ graphics

/** What Auto picked, in words (Settings → Graphics). */
export function autoText(picked: GraphicsPreset | undefined): string {
  const name = QUALITY.find((q) => q.id === picked)?.name;
  return name ? `Picks the quality for this device: ${name} here. Choose one below to set it yourself.` : 'Picks the quality for this device. Choose one below to set it yourself.';
}

function Graphics({ settings }: { settings: Settings }) {
  const ctl = useCtl();
  useTicker(1000);
  const fps = Math.round(framesPerSecond());
  const picked = settings.graphics;
  const now = picked === 'auto' ? ctl.host.autoGraphics : picked;
  const text = QUALITY.find((q) => q.id === now)?.text ?? '';
  return (
    <div className="tabpanel mf-tabpanel" role="tabpanel" aria-label="Graphics">
      <h2 className="display set__h">Graphics</h2>
      <div className="srow">
        <div className="srow__txt">
          <b id="q-label">Quality</b>
          <span>
            {picked === 'auto' ? autoText(ctl.host.autoGraphics) : text}
            {fps > 0 && ` · ${fps} fps here now`}
          </span>
        </div>
        <div className="srow__ctrl" data-bind="settings.graphics">
          <div className="seg" role="radiogroup" aria-labelledby="q-label">
            {(['auto', ...QUALITY.map((q) => q.id)] as const).map((id) => (
              <button key={id} type="button" className="seg__opt" role="radio" aria-checked={picked === id} onClick={() => ctl.updateSettings({ graphics: id })}>
                {id === 'auto' ? 'Auto' : QUALITY.find((q) => q.id === id)!.name}
              </button>
            ))}
          </div>
          <NameTagPreview mode={settings.colorBlind} />
        </div>
      </div>
      <div className="srow">
        <div className="srow__txt">
          <b>Blood effects</b>
          <span>Off by default. Hits and damage read the same with it off.</span>
        </div>
        <div className="srow__ctrl" data-bind="settings.blood">
          <Switch on={settings.blood} onChange={(blood) => ctl.updateSettings({ blood })} label="Blood effects" />
        </div>
      </div>
      <div className="srow">
        <div className="srow__txt">
          <b>Show FPS</b>
          <span>A small frame counter in the top-left corner.</span>
        </div>
        <div className="srow__ctrl">
          <Switch on={settings.showFps} onChange={(showFps) => ctl.updateSettings({ showFps })} label="Show FPS" />
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ audio

function Volume({ audio, k, label, desc }: { audio: AudioSettings; k: 'master' | 'effects' | 'music' | 'ui' | 'voice'; label: string; desc: string }) {
  const ctl = useCtl();
  const muted = audio[`${k}Muted`];
  const set = (patch: Partial<AudioSettings>) => ctl.updateSettings({ audio: { ...audio, ...patch } });
  return (
    <div className="srow">
      <div className="srow__txt">
        <b>{label}</b>
        <span>{desc}</span>
      </div>
      <div className="srow__ctrl">
        <div className="volrow">
          <button className={muted ? 'iconbtn is-on' : 'iconbtn'} aria-label={muted ? `Unmute ${label.toLowerCase()}` : `Mute ${label.toLowerCase()}`} aria-pressed={muted} onClick={() => set({ [`${k}Muted`]: !muted })}>
            <Icon name="speaker" />
          </button>
          <Slider value={audio[k]} onChange={(v) => set({ [k]: v })} label={`${label} volume`} valueText={pct(audio[k])} />
          <output className="volrow__val num" data-bind={`settings.audio.${k}`}>
            {pct(audio[k])}
          </output>
        </div>
      </div>
    </div>
  );
}

/** Headphones: 3D sound by ear. Browsers can't tell a page what's plugged in, so it's the player's call. */
function Headphones({ audio }: { audio: AudioSettings }) {
  const ctl = useCtl();
  return (
    <div className="srow">
      <div className="srow__txt">
        <b>Headphones (3D sound)</b>
        <span>For headphones or earbuds: you hear enemies left, right, above and below. Off for speakers.</span>
      </div>
      <div className="srow__ctrl">
        <Switch on={audio.headphones} onChange={(headphones) => ctl.updateSettings({ audio: { ...audio, headphones } })} label="Headphones (3D sound)" />
      </div>
    </div>
  );
}

function Audio({ settings }: { settings: Settings }) {
  return (
    <div className="tabpanel mf-tabpanel" role="tabpanel" aria-label="Audio">
      <h2 className="display set__h">Audio</h2>
      <Volume audio={settings.audio} k="master" label="Master volume" desc="Everything the game plays. It goes quiet when you switch tabs." />
      <Volume audio={settings.audio} k="effects" label="Effects" desc="Guns, footsteps, jetpacks, explosions." />
      <Volume audio={settings.audio} k="music" label="Music" desc="Menus, the lobby and the match-start sting." />
      <Volume audio={settings.audio} k="ui" label="Interface" desc="Clicks, the countdown, hit and kill confirms." />
      <Volume audio={settings.audio} k="voice" label="Voices" desc="Soldiers getting hit or coughing in gas." />
      <Headphones audio={settings.audio} />
      {/* voice chat (voice/): its own rows, saved on this device */}
      <VoiceSettingsSection />
    </div>
  );
}

// ------------------------------------------------------------------ controls

type Capture = { action: ActionId; index: number } | null;

function BindButton({ action, index, code, capture, onCapture, layout }: { action: ActionDef; index: number; code: string | undefined; capture: Capture; onCapture: (c: Capture) => void; layout: ReadonlyMap<string, string> | null }) {
  const listening = capture?.action === action.id && capture.index === index;
  if (listening)
    return (
      <button type="button" className="btn btn--volt btn--sm mf-bindbtn m-p8" aria-live="polite" onClick={() => onCapture(null)}>
        Press a key…
      </button>
    );
  if (!code)
    return (
      <button type="button" className="btn btn--ghost btn--sm mf-bindbtn m-p8" aria-label={`Add a key for ${action.label}`} onClick={() => onCapture({ action: action.id, index })}>
        Not set
      </button>
    );
  return (
    <button type="button" className="btn btn--ghost btn--sm mf-bindbtn m-p8" aria-label={`${action.label}: ${keyLabel(code, layout)}. Click to change`} onClick={() => onCapture({ action: action.id, index })}>
      <Kbd code={code} layout={layout} />
    </button>
  );
}

/** The kit's binding list (.binds): each action, its keys (two at most), each a button that listens for a new one. */
function BindList({ actions, settings, capture, onCapture, layout }: { actions: readonly ActionDef[]; settings: Settings; capture: Capture; onCapture: (c: Capture) => void; layout: ReadonlyMap<string, string> | null }) {
  return (
    <ul className="binds" aria-label="Key bindings">
      {actions.map((a) => {
        const codes = settings.bindings[a.id];
        return (
          <li key={a.id}>
            <span>
              {a.label}
              {a.hint && <span className="bindtable__hint">{a.hint}</span>}
            </span>
            {Array.from({ length: MAX_BINDINGS }, (_, i) =>
              // the second key can only be added once the first exists
              i <= codes.length ? <BindButton key={i} action={a} index={i} code={codes[i]} capture={capture} onCapture={onCapture} layout={layout} /> : null,
            )}
          </li>
        );
      })}
    </ul>
  );
}

function Controls({ settings }: { settings: Settings }) {
  const ctl = useCtl();
  const layout = useKeyboardLayout();
  const [capture, setCapture] = useState<Capture>(null);
  const [moved, setMoved] = useState<string | null>(null);
  const bindings = settings.bindings;

  useEffect(() => {
    if (!capture) return;
    const finish = (code: string | null) => {
      setCapture(null);
      if (code === null) return;
      const { bindings: next, took } = rebind(bindings, capture.action, code, capture.index);
      ctl.updateSettings({ bindings: next });
      const from = took && ACTIONS.find((a) => a.id === took);
      setMoved(from ? `${keyLabel(code, layout)} was set for ${from.label}: it moved here, so ${from.label} lost it.` : null);
    };
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.code === 'Escape') finish(null);
      else if (e.code === 'Backspace' || e.code === 'Delete') {
        setCapture(null);
        if (capture.index < bindings[capture.action].length) ctl.updateSettings({ bindings: unbind(bindings, capture.action, capture.index) });
      } else finish(e.code);
    };
    const swallow = (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
    };
    const onMouse = (e: MouseEvent) => {
      swallow(e);
      // the click that follows must not press whatever is under the pointer
      window.addEventListener('click', swallow, true);
      window.addEventListener('auxclick', swallow, true);
      window.setTimeout(() => {
        window.removeEventListener('click', swallow, true);
        window.removeEventListener('auxclick', swallow, true);
      }, 300);
      finish(`Mouse${e.button}`);
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('mouseup', onMouse, true);
    window.addEventListener('contextmenu', swallow, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('mouseup', onMouse, true);
      window.removeEventListener('contextmenu', swallow, true);
    };
  }, [capture, bindings, ctl, layout]);

  return (
    <div className="tabpanel mf-tabpanel" role="tabpanel" aria-label="Controls">
      <div className="tabpanel__head">
        <h2 className="display set__h">Controls</h2>
        <span className="topbar__spacer"></span>
        <Switch on={settings.doubleTapDash} onChange={(doubleTapDash) => ctl.updateSettings({ doubleTapDash })} label="Double-tap a direction to dash" showState={false} />
      </div>
      <p className="mf-set__note">
        Click a key to change it, then press the new key or mouse button. <Cap>Esc</Cap> cancels, <Cap>Backspace</Cap> clears it. Each action can have two keys; <Cap>Esc</Cap> always opens the menu.
      </p>
      <BindList actions={ACTIONS} settings={settings} capture={capture} onCapture={setCapture} layout={layout} />
      {moved && (
        <p className="status status--warn bind-conflict" role="status">
          <Icon name="warn" />
          {moved}
        </p>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ accessibility

/** The team pairs: the kit's blue and orange; blue and yellow (no red-green); red and teal (no blue-yellow). */
export const CB: readonly { id: Settings['colorBlind']; name: string; a: string; b: string }[] = [
  { id: 'standard', name: 'Standard', a: 'var(--c-team-a)', b: 'var(--c-team-b)' },
  { id: 'deutan', name: 'Red-green safe', a: 'var(--c-team-a)', b: 'var(--c-warn)' },
  { id: 'tritan', name: 'Blue-yellow safe', a: 'var(--c-hp)', b: 'var(--c-ev-squall)' },
];

/** "In match:" two name tags in the chosen pair, each with its team's shape (Pen N10). */
export function NameTagPreview({ mode }: { mode: Settings['colorBlind'] }) {
  const c = CB.find((x) => x.id === mode) ?? CB[0]!;
  return (
    <div className="mf-cb__preview" style={{ '--a': c.a, '--b': c.b } as CSSProperties}>
      <span className="label">In match:</span>
      <span className="mf-cb__tag mf-cb__tag--a">
        <i aria-hidden="true">◆</i>
        Kemi
      </span>
      <span className="mf-cb__tag mf-cb__tag--b">
        <i aria-hidden="true">▲</i>
        Tolu
      </span>
    </div>
  );
}

function Accessibility({ settings }: { settings: Settings }) {
  const ctl = useCtl();
  const i = Math.max(0, TEXT_SIZES.findIndex((t) => Math.abs(t - settings.textScale) < 0.01));
  return (
    <div className="tabpanel mf-tabpanel" role="tabpanel" aria-label="Accessibility">
      <h2 className="display set__h">Accessibility</h2>
      <div className="srow">
        <div className="srow__txt">
          <b>Reduce flashes</b>
          <span>Flashbangs dim and blur the screen instead of turning it white.</span>
        </div>
        <div className="srow__ctrl">
          <Switch on={settings.reduceFlashes} onChange={(reduceFlashes) => ctl.updateSettings({ reduceFlashes })} label="Reduce flashes" />
        </div>
      </div>
      <div className="srow">
        <div className="srow__txt">
          <b>Soften loud bursts</b>
          <span>Explosions and flashbangs play quieter, without the ear ring, and nothing gets loud all at once.</span>
        </div>
        <div className="srow__ctrl">
          <Switch on={settings.softBursts} onChange={(softBursts) => ctl.updateSettings({ softBursts })} label="Soften loud bursts" />
        </div>
      </div>
      <div className="srow">
        <div className="srow__txt">
          <b>Reduce transparency</b>
          <span>Menus, panels and the HUD's plates are solid instead of frosted glass. Easier to read, and lighter on slow devices.</span>
        </div>
        <div className="srow__ctrl">
          <Switch on={settings.reduceTransparency} onChange={(reduceTransparency) => ctl.updateSettings({ reduceTransparency })} label="Reduce transparency" />
        </div>
      </div>
      <div className="srow">
        <div className="srow__txt">
          <b>Reduce motion</b>
          <span>No screen shake, no zooming numbers, no pulsing warnings.</span>
        </div>
        <div className="srow__ctrl">
          <Switch on={settings.reduceMotion} onChange={(reduceMotion) => ctl.updateSettings({ reduceMotion })} label="Reduce motion" />
        </div>
      </div>
      <div className="srow mf-srow--stack">
        <div className="srow__txt">
          <b id="cb-label">
            Colour-blind team colours
          </b>
          <span>Teams also get a shape on their name tags, so colour is never the only clue. Team modes aren't in the game yet: your choice is kept for them.</span>
        </div>
        <div className="srow__ctrl">
          <div className="cb" role="radiogroup" aria-labelledby="cb-label">
            {CB.map((c) => (
              <button key={c.id} className="cb__opt" role="radio" aria-checked={settings.colorBlind === c.id} onClick={() => ctl.updateSettings({ colorBlind: c.id })}>
                <span className="cb__sw" aria-hidden="true" style={{ '--a': c.a, '--b': c.b } as CSSProperties}>
                  <i>◆</i>
                  <i>▲</i>
                </span>
                <b>{c.name}</b>
              </button>
            ))}
          </div>
        </div>
      </div>
      <div className="srow">
        <div className="srow__txt">
          <b>Text size</b>
          <span>
            Menus and HUD text. Preview: <span data-bind="settings.textPreview">Respawn in 3 s</span>
          </span>
        </div>
        <div className="srow__ctrl">
          <div className="volrow volrow--text">
            <Slider
              value={i / (TEXT_SIZES.length - 1)}
              step={1 / (TEXT_SIZES.length - 1)}
              onChange={(v) => ctl.updateSettings({ textScale: TEXT_SIZES[Math.round(v * (TEXT_SIZES.length - 1))]! })}
              label="Text size"
              valueText={pct(settings.textScale)}
              min={100}
              max={150}
              ticks={TEXT_SIZES.map((t) => String(Math.round(t * 100)))}
            />
            <output className="volrow__val num" data-bind="settings.textSize">
              {pct(settings.textScale)}
            </output>
          </div>
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ network

function Network({ settings, inRoom }: { settings: Settings; inRoom: boolean }) {
  const ctl = useCtl();
  useTicker(1000);
  const { samples, server, live } = netHistory();
  const last = samples[samples.length - 1];
  const top = Math.max(200, ...samples.map((s) => s.pingMs));
  const median = samples.length ? [...samples].map((s) => s.pingMs).sort((a, b) => a - b)[samples.length >> 1]! : -1;
  const connected = inRoom && live;
  return (
    <div className="tabpanel mf-tabpanel" role="tabpanel" aria-label="Network">
      <h2 className="display set__h">Network</h2>
      <div className="srow">
        <div className="srow__txt">
          <b>Low-bandwidth mode</b>
          <span>Sends fewer updates to save data. Good on mobile data. Other players may move a little less smoothly.</span>
        </div>
        <div className="srow__ctrl">
          <Switch on={settings.lowBandwidth} onChange={(lowBandwidth) => ctl.updateSettings({ lowBandwidth })} label="Low-bandwidth mode" />
        </div>
      </div>
      <div className="srow">
        <div className="srow__txt">
          <b>Net graph</b>
          <span>Shows ping and packet loss in the top-left corner during a match.</span>
        </div>
        <div className="srow__ctrl">
          <Switch on={settings.netGraph} onChange={(netGraph) => ctl.updateSettings({ netGraph })} label="Net graph" />
        </div>
      </div>
      <div className="srow">
        <div className="srow__txt">
          <b>Something went wrong?</b>
          <span>Send us what happened on this device, so we can fix it. A failed room connection sends one by itself.</span>
        </div>
        <div className="srow__ctrl">
          <SendReport context="settings" />
        </div>
      </div>
      <div className="netcard">
        <div className="netgraph" role="img" aria-label={`Last ${NET_HISTORY} seconds of ping`}>
          {Array.from({ length: NET_HISTORY }, (_, k) => {
            const s = samples[k - (NET_HISTORY - samples.length)];
            if (!s) return <i key={k} style={{ '--h': 0 } as CSSProperties}></i>;
            const spike = median > 0 && s.pingMs > median * 1.6 && s.pingMs - median > 40;
            return <i key={k} className={spike ? 'is-spike' : undefined} style={{ '--h': Math.max(0.04, Math.min(1, s.pingMs / top)).toFixed(3) } as CSSProperties}></i>;
          })}
        </div>
        <dl className="netcard__stats">
          <div>
            <dt>Server</dt>
            <dd data-bind="net.region">{server || '–'}</dd>
          </div>
          <div>
            <dt>Ping</dt>
            <dd className={`num ${last ? pingQuality(last.pingMs).cls : ''}`} data-bind="net.ping">
              {last && connected ? `${Math.round(last.pingMs)} ms` : '–'}
            </dd>
          </div>
          <div>
            <dt>Packet loss</dt>
            <dd className="num" data-bind="net.loss">
              {last && connected ? `${last.lossPct.toFixed(1)}%` : '–'}
            </dd>
          </div>
          <div>
            <dt>Status</dt>
            {connected ? (
              <dd className="status status--ok">
                <Icon name="ok" size="sm" />
                Connected
              </dd>
            ) : (
              <dd className="status status--info">
                <Icon name="clock" size="sm" />
                {inRoom ? 'Not connected' : 'Not in a room'}
              </dd>
            )}
          </div>
        </dl>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ touch

function useTouchSettings(): TouchSettings {
  const [s, setS] = useState(getTouchSettings);
  useEffect(() => onTouchChange(() => setS(getTouchSettings())), []);
  return s;
}

function Seg<T extends string>({ value, options, onChange, label }: { value: T; options: readonly [T, string][]; onChange: (v: T) => void; label: string }) {
  return (
    <div className="seg" role="radiogroup" aria-label={label}>
      {options.map(([id, text]) => (
        <button key={id} className="seg__opt" role="radio" aria-checked={value === id} onClick={() => onChange(id)}>
          {text}
        </button>
      ))}
    </div>
  );
}

function Touch() {
  const ctl = useCtl();
  const t = useTouchSettings();
  const set = (patch: Partial<TouchSettings>) => setTouchSettings(patch);
  return (
    <div className="tabpanel mf-tabpanel" role="tabpanel" aria-label="Touch">
      <h2 className="display set__h">Touch</h2>
      <div className="srow">
        <div className="srow__txt">
          <b>Touch controls</b>
          <span>Sticks and buttons on the screen. Auto shows them on phones and tablets, or once you touch the screen.</span>
        </div>
        <div className="srow__ctrl">
          <Seg value={t.mode} label="Touch controls" options={[['auto', 'Auto'], ['on', 'On'], ['off', 'Off']]} onChange={(mode) => set({ mode })} />
        </div>
      </div>
      {/* controls spec §4.2 (item 7): the presets; moving a control in the editor makes it "My layout" there */}
      <div className="srow mf-srow--block">
        <div className="srow__txt">
          <b>Preset</b>
          <span>{PRESET_HELP[t.preset]} Picking one sets its fire mode too.</span>
        </div>
        <Seg value={t.preset} label="Preset" options={PRESET_IDS.map((id) => [id, PRESET_NAMES[id]] as [PresetId, string])} onChange={(preset) => setTouchPreset(preset)} />
      </div>
      {/* the owner, 23 Oct: "a way to fade the buttons" (touch/fade.ts); the pause menu has the slider too */}
      <div className="srow">
        <div className="srow__txt">
          <b>Button fade</b>
          <span>How visible the touch buttons stay when they fade: lower is fainter. Your HP, fuel and ammo never fade.</span>
        </div>
        <div className="srow__ctrl">
          <div className="volrow">
            <Slider value={(t.opacity - 0.15) / 0.85} onChange={(v) => set({ opacity: Math.round((0.15 + v * 0.85) * 100) / 100 })} label="Button fade" valueText={pct(t.opacity)} min={15} max={100} />
            <output className="volrow__val num">{pct(t.opacity)}</output>
          </div>
        </div>
      </div>
      <div className="srow">
        <div className="srow__txt">
          <b>Auto-fade</b>
          <span>Buttons you haven't touched for a moment fade to that level, and light up the moment your thumb gets near. Off: always at it.</span>
        </div>
        <div className="srow__ctrl">
          <Switch on={t.autoFade} onChange={(autoFade) => set({ autoFade })} label="Auto-fade" />
        </div>
      </div>
      <div className="srow mf-srow--block">
        <div className="srow__txt">
          <b>Fire</b>
          <span>How the gun fires on a touch screen. Auto suits most players: aim at someone and it shoots.</span>
        </div>
        <FirePicker value={t.fire} onChange={(fire) => set({ fire, fireChosen: true })} />
      </div>
      <div className="srow">
        <div className="srow__txt">
          <b>Precision weapons fire on release</b>
          <span>In Auto and Pull: snipers, DMRs, charged guns and launchers aim first and fire as you lift.</span>
        </div>
        <div className="srow__ctrl">
          <Switch on={t.precisionRelease} onChange={(precisionRelease) => set({ precisionRelease })} label="Precision weapons fire on release" />
        </div>
      </div>
      {t.fire === 'button' && (
        <div className="srow">
          <div className="srow__txt">
            <b>A second FIRE on the left</b>
            <span>For your left index finger, top left: shoot while your right thumb aims.</span>
          </div>
          <div className="srow__ctrl">
            <Switch on={t.leftFire} onChange={(leftFire) => set({ leftFire })} label="A second FIRE on the left" />
          </div>
        </div>
      )}
      <div className="srow">
        <div className="srow__txt">
          <b>Aim assist</b>
          <span>{ASSIST_HELP[t.assist]} Touch only; a mouse never gets it.</span>
        </div>
        <div className="srow__ctrl">
          <Seg value={t.assist} label="Aim assist" options={ASSIST_LEVELS.map((l) => [l, ASSIST_NAMES[l]] as [AssistLevel, string])} onChange={(assist) => set({ assist })} />
        </div>
      </div>
      <div className="srow">
        <div className="srow__txt">
          <b>Left-handed</b>
          <span>Mirrors the whole layout.</span>
        </div>
        <div className="srow__ctrl">
          <Switch on={t.handed === 'left'} onChange={(on) => set({ handed: on ? 'left' : 'right' })} label="Left-handed" />
        </div>
      </div>
      <div className="srow">
        <div className="srow__txt">
          <b>Push up to jet</b>
          <span>Push the move stick up to fly. Claw turns it off: your left index finger has a JET button.</span>
        </div>
        <div className="srow__ctrl">
          <Switch on={t.stickJet} onChange={(stickJet) => set({ stickJet })} label="Push up to jet" />
        </div>
      </div>
      <div className="srow">
        <div className="srow__txt">
          <b>Extra finger fires</b>
          <span>A second finger on the right half, beside your aiming thumb, fires while it's down. On in Claw.</span>
        </div>
        <div className="srow__ctrl">
          <Switch on={t.tapFire} onChange={(tapFire) => set({ tapFire })} label="Extra finger fires" />
        </div>
      </div>
      {/* only where the browser can buzz (§4.8: iOS Safari can't) */}
      {canVibrate() && (
        <div className="srow">
          <div className="srow__txt">
            <b>Vibrate when hit</b>
            <span>Where the browser allows it.</span>
          </div>
          <div className="srow__ctrl">
            <Switch on={t.vibrate} onChange={(vibrate) => set({ vibrate })} label="Vibrate when hit" />
          </div>
        </div>
      )}
      <div className="srow">
        <div className="srow__txt">
          <b>Flick to dash</b>
          <span>Flick the move stick and lift to dash that way.</span>
        </div>
        <div className="srow__ctrl">
          <Switch on={t.swipeDash} onChange={(swipeDash) => set({ swipeDash })} label="Flick to dash" />
        </div>
      </div>
      <div className="srow">
        <div className="srow__txt">
          <b>Keep aiming after a button</b>
          <span>Back on the aim stick within a moment of a button: your aim carries on, and so does firing.</span>
        </div>
        <div className="srow__ctrl">
          <Switch on={t.keepAim} onChange={(keepAim) => set({ keepAim })} label="Keep aiming after a button" />
        </div>
      </div>
      <div className="srow">
        <div className="srow__txt">
          <b>Layout</b>
          <span>Drag, resize and fade each control. Saved on this device.</span>
        </div>
        <div className="srow__ctrl">
          <div className="seg">
            <button
              className="btn btn--secondary"
              onClick={blurAfter(() => {
                ctl.closeOverlay();
                openTouchEditor();
              })}
            >
              <Icon name="edit" />
              Edit layout
            </button>
            <button className="btn btn--ghost" onClick={blurAfter(() => resetTouchLayout())}>
              <Icon name="refresh" />
              Reset layout
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ the screen

/** "Reset this tab": the defaults for that section only. */
export function resetPatch(tab: SettingsTab): Partial<Settings> | null {
  switch (tab) {
    case 'graphics':
      return { graphics: DEFAULT_SETTINGS.graphics, showFps: DEFAULT_SETTINGS.showFps, blood: DEFAULT_SETTINGS.blood };
    case 'audio':
      return { audio: DEFAULT_AUDIO };
    case 'controls':
      return { bindings: defaultBindings(), doubleTapDash: DEFAULT_SETTINGS.doubleTapDash };
    case 'controller':
      return { pad: DEFAULT_PAD_SETTINGS };
    case 'accessibility':
      return { reduceFlashes: DEFAULT_SETTINGS.reduceFlashes, softBursts: DEFAULT_SETTINGS.softBursts, reduceMotion: DEFAULT_SETTINGS.reduceMotion, reduceTransparency: DEFAULT_SETTINGS.reduceTransparency, colorBlind: DEFAULT_SETTINGS.colorBlind, textScale: DEFAULT_SETTINGS.textScale };
    case 'network':
      return { lowBandwidth: DEFAULT_SETTINGS.lowBandwidth, netGraph: DEFAULT_SETTINGS.netGraph };
    case 'touch':
      return null;
  }
}

export function SettingsScreen({ store }: { store: ShellStore }) {
  const ctl = useCtl();
  const settings = useStore(store, (s) => s.settings);
  const tab = useStore(store, (s) => s.settingsTab);
  const inRoom = useStore(store, (s) => s.screen.name === 'room');
  const reset = () => {
    const patch = resetPatch(tab);
    if (patch) ctl.updateSettings(patch);
    else setTouchSettings(DEFAULT_TOUCH_SETTINGS);
  };
  // the tab indicator slides to the picked tab (P5, vertical)
  const nav = useRef<HTMLElement>(null);
  const bar = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const el = nav.current?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (el && bar.current) moveIndicator(bar.current, el.offsetTop, el.offsetHeight);
  }, [tab]);
  return (
    <Screen name="settings" kind="menu" states={[tab]} label="Settings" modal dialog>
      <Backdrop word="SET" />
      <div className="menu">
        <header className="menu-top">
          <button className="btn btn--ghost btn--icon btn--sm m-p8" type="button" aria-label="Back" onClick={blurAfter(() => ctl.back())}>
            <Icon name="back" />
          </button>
          <h1 className="menu-top__title">Settings</h1>
          <span className="menu-top__spacer"></span>
          <InstallButton />
          <span className="label">Saved on this device</span>
        </header>
        <div className="menu-body set">
          <nav ref={nav} className="tabs tabs--v set__tabs mf-set__tabs" role="tablist" aria-orientation="vertical" aria-label="Settings sections">
            <span ref={bar} className="m-p5 m-p5--y mf-set__bar" aria-hidden="true"></span>
            {TABS.map((t) => (
              <button key={t.id} type="button" className="tab" role="tab" data-tab={t.id} aria-selected={tab === t.id} onClick={() => ctl.setSettingsTab(t.id)}>
                <Icon name={t.icon} />
                {t.label}
              </button>
            ))}
          </nav>
          <div className="set__panel card card--print">
            {tab === 'graphics' && <Graphics settings={settings} />}
            {tab === 'audio' && <Audio settings={settings} />}
            {tab === 'controls' && <Controls settings={settings} />}
            {tab === 'controller' && (
              <div className="tabpanel mf-tabpanel" role="tabpanel" aria-label="Controller">
                <PadControls pad={settings.pad} onChange={(pad) => ctl.updateSettings({ pad })} reduceFlashes={settings.reduceFlashes} />
              </div>
            )}
            {tab === 'accessibility' && <Accessibility settings={settings} />}
            {tab === 'network' && <Network settings={settings} inRoom={inRoom} />}
            {tab === 'touch' && <Touch />}
          </div>
        </div>
        <footer className="menu-hints">
          <button className="btn btn--ghost btn--sm m-p8" type="button" onClick={blurAfter(reset)}>
            <Icon name="refresh" />
            Reset this tab
          </button>
          <span>
            <Cap>Esc</Cap> Back
          </span>
          <span className="menu-hints__end">
            <button className="btn btn--volt m-p8" type="button" onClick={blurAfter(() => ctl.back())}>
              Done
            </button>
          </span>
        </footer>
      </div>
    </Screen>
  );
}
