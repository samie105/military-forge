/**
 * 11 · Settings (the kit's data-screen="settings"): Graphics, Audio, Controls (two keys per action,
 * click then press), Accessibility, Network, and Touch for the phone controls (touch-interfaces.md).
 * Everything saves on this device as it changes; Back (Esc) and Done close it.
 */
import { useEffect, useState, type CSSProperties } from 'react';
import { useStore } from 'zustand';
import { framesPerSecond, netHistory, NET_HISTORY } from '../../stats';
import { getTouchSettings, onTouchChange, openTouchEditor, resetTouchLayout, setTouchSettings, type TouchSettings } from '../../touch';
import { DEFAULT_TOUCH_SETTINGS } from '../../touch/settings';
import { Icon } from '../../ui/Icon';
import { Kbd, Cap } from '../../ui/Kbd';
import { Screen, Switch, blurAfter, pingQuality } from '../../ui/Screen';
import { Slider } from '../../ui/Slider';
import { useCtl, useKeyboardLayout, useTicker } from '../context';
import { ACTIONS, MAX_BINDINGS, defaultBindings, keyLabel, rebind, unbind, type ActionDef, type ActionId } from '../controls';
import { DEFAULT_AUDIO, DEFAULT_SETTINGS, type AudioSettings, type GraphicsPreset, type Settings, type SettingsTab, type ShellStore } from '../store';

export const TABS: readonly { id: SettingsTab; label: string; icon: string }[] = [
  { id: 'graphics', label: 'Graphics', icon: 'monitor' },
  { id: 'audio', label: 'Audio', icon: 'speaker' },
  { id: 'controls', label: 'Controls', icon: 'keyboard' },
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
  const auto = settings.graphics === 'auto';
  // Auto shows the preset it picked as the checked card
  const current = auto ? (ctl.host.autoGraphics ?? null) : settings.graphics;
  return (
    <div className="tabpanel" role="tabpanel" aria-label="Graphics">
      <h2 className="display h2">Graphics</h2>
      <div className="setrow">
        <div>
          <p className="setrow__label">Automatic quality</p>
          <p className="setrow__desc">{autoText(ctl.host.autoGraphics)}</p>
        </div>
        <Switch on={auto} onChange={(on) => ctl.updateSettings({ graphics: on ? 'auto' : (current ?? 'medium') })} label="Automatic quality" />
      </div>
      <div className="setrow setrow--stack">
        <div>
          <p className="setrow__label" id="q-label">
            Quality
          </p>
          <p className="setrow__desc">Lower it if the game feels slow; raise it if it runs smoothly. It changes at once (smoother edges after a reload).</p>
        </div>
        <div className="quality" role="radiogroup" aria-labelledby="q-label">
          {QUALITY.map((q) => (
            <button key={q.id} className="quality__opt" role="radio" aria-checked={current === q.id} onClick={() => ctl.updateSettings({ graphics: q.id })}>
              <b>{q.name}</b>
              <span>{q.text}</span>
              {current === q.id && fps > 0 && <span className="quality__fps num">{fps} fps here now</span>}
            </button>
          ))}
        </div>
      </div>
      <div className="setrow">
        <div>
          <p className="setrow__label">Blood effects</p>
          <p className="setrow__desc">Blood when soldiers are hit. Off by default.</p>
        </div>
        <Switch on={settings.blood} onChange={(blood) => ctl.updateSettings({ blood })} label="Blood effects" />
      </div>
      <div className="setrow">
        <div>
          <p className="setrow__label">Show FPS</p>
          <p className="setrow__desc">A small frame counter in the top-left corner.</p>
        </div>
        <Switch on={settings.showFps} onChange={(showFps) => ctl.updateSettings({ showFps })} label="Show FPS" />
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ audio

function Volume({ audio, k, label, desc }: { audio: AudioSettings; k: 'master' | 'effects' | 'music'; label: string; desc: string }) {
  const ctl = useCtl();
  const muted = audio[`${k}Muted`];
  const set = (patch: Partial<AudioSettings>) => ctl.updateSettings({ audio: { ...audio, ...patch } });
  return (
    <div className="setrow">
      <div>
        <p className="setrow__label">{label}</p>
        <p className="setrow__desc">{desc}</p>
      </div>
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
  );
}

function Audio({ settings }: { settings: Settings }) {
  return (
    <div className="tabpanel" role="tabpanel" aria-label="Audio">
      <h2 className="display h2">Audio</h2>
      <p className="status status--info">
        <Icon name="info" />
        The game has no sound yet: these are saved for when it does.
      </p>
      <Volume audio={settings.audio} k="master" label="Master volume" desc="Everything the game plays." />
      <Volume audio={settings.audio} k="effects" label="Effects" desc="Guns, footsteps, jetpacks, explosions." />
      <Volume audio={settings.audio} k="music" label="Music" desc="Menus, countdown and results." />
    </div>
  );
}

// ------------------------------------------------------------------ controls

type Capture = { action: ActionId; index: number } | null;

function BindButton({ action, index, code, capture, onCapture, layout }: { action: ActionDef; index: number; code: string | undefined; capture: Capture; onCapture: (c: Capture) => void; layout: ReadonlyMap<string, string> | null }) {
  const listening = capture?.action === action.id && capture.index === index;
  if (listening)
    return (
      <button className="bindbtn bindbtn--listen" aria-live="polite" onClick={() => onCapture(null)}>
        Press a key…
      </button>
    );
  if (!code)
    return (
      <button className="bindbtn bindbtn--empty" aria-label={`Add a key for ${action.label}`} onClick={() => onCapture({ action: action.id, index })}>
        Not set
      </button>
    );
  return (
    <button className="bindbtn" aria-label={`${action.label}: ${keyLabel(code, layout)}. Click to change`} onClick={() => onCapture({ action: action.id, index })}>
      <Kbd code={code} layout={layout} />
    </button>
  );
}

function BindTable({ actions, settings, capture, onCapture, layout }: { actions: readonly ActionDef[]; settings: Settings; capture: Capture; onCapture: (c: Capture) => void; layout: ReadonlyMap<string, string> | null }) {
  return (
    <table className="bindtable">
      <thead>
        <tr>
          <th scope="col">Action</th>
          <th scope="col">Key 1</th>
          <th scope="col">Key 2</th>
        </tr>
      </thead>
      <tbody>
        {actions.map((a) => {
          const codes = settings.bindings[a.id];
          return (
            <tr key={a.id}>
              <th scope="row">
                {a.label}
                {a.hint && <span className="bindtable__hint small muted">{a.hint}</span>}
              </th>
              {Array.from({ length: MAX_BINDINGS }, (_, i) => (
                <td key={i}>
                  {/* the second key can only be added once the first exists */}
                  {i <= codes.length && <BindButton action={a} index={i} code={codes[i]} capture={capture} onCapture={onCapture} layout={layout} />}
                </td>
              ))}
            </tr>
          );
        })}
      </tbody>
    </table>
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

  const half = Math.ceil(ACTIONS.length / 2);
  return (
    <div className="tabpanel" role="tabpanel" aria-label="Controls">
      <div className="tabpanel__head">
        <h2 className="display h2">Controls</h2>
        <span className="topbar__spacer"></span>
        <Switch on={settings.doubleTapDash} onChange={(doubleTapDash) => ctl.updateSettings({ doubleTapDash })} label="Double-tap a direction to dash" showState={false} />
      </div>
      <p className="setrow__desc">
        Click a key to change it, then press the new key or mouse button. <Cap>Esc</Cap> cancels, <Cap>Backspace</Cap> clears it. Each action can have two keys; <Cap>Esc</Cap> always opens the menu.
      </p>
      <div className="binds">
        <BindTable actions={ACTIONS.slice(0, half)} settings={settings} capture={capture} onCapture={setCapture} layout={layout} />
        <BindTable actions={ACTIONS.slice(half)} settings={settings} capture={capture} onCapture={setCapture} layout={layout} />
      </div>
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

const CB: readonly { id: Settings['colorBlind']; name: string; a: string; b: string }[] = [
  { id: 'standard', name: 'Standard', a: 'var(--c-team-a)', b: 'var(--c-team-b)' },
  { id: 'deutan', name: 'Red-green safe', a: 'var(--c-team-a)', b: 'var(--c-team-b)' },
  { id: 'tritan', name: 'Blue-yellow safe', a: 'var(--c-team-a)', b: 'var(--c-team-b)' },
];

function Accessibility({ settings }: { settings: Settings }) {
  const ctl = useCtl();
  const i = Math.max(0, TEXT_SIZES.findIndex((t) => Math.abs(t - settings.textScale) < 0.01));
  return (
    <div className="tabpanel" role="tabpanel" aria-label="Accessibility">
      <h2 className="display h2">Accessibility</h2>
      <div className="setrow">
        <div>
          <p className="setrow__label">Reduce flashes</p>
          <p className="setrow__desc">Flashbangs dim and blur the screen instead of turning it white.</p>
        </div>
        <Switch on={settings.reduceFlashes} onChange={(reduceFlashes) => ctl.updateSettings({ reduceFlashes })} label="Reduce flashes" />
      </div>
      <div className="setrow">
        <div>
          <p className="setrow__label">Reduce motion</p>
          <p className="setrow__desc">No screen shake, no zooming numbers, no pulsing warnings.</p>
        </div>
        <Switch on={settings.reduceMotion} onChange={(reduceMotion) => ctl.updateSettings({ reduceMotion })} label="Reduce motion" />
      </div>
      <div className="setrow setrow--stack">
        <div>
          <p className="setrow__label" id="cb-label">
            Colour-blind team colours
          </p>
          <p className="setrow__desc">Teams also get a shape on their name tags, so colour is never the only clue. Team modes aren't in the game yet: your choice is kept for them.</p>
        </div>
        <div className="cb" role="radiogroup" aria-labelledby="cb-label">
          {CB.map((c) => (
            <button key={c.id} className="cb__opt" role="radio" aria-checked={settings.colorBlind === c.id} onClick={() => ctl.updateSettings({ colorBlind: c.id })}>
              <span className="cb__sw" style={{ '--a': c.a, '--b': c.b } as CSSProperties}>
                <i>◆</i>
                <i>▲</i>
              </span>
              <b>{c.name}</b>
            </button>
          ))}
        </div>
      </div>
      <div className="setrow">
        <div>
          <p className="setrow__label">Text size</p>
          <p className="setrow__desc">
            Menus and HUD text. Preview: <span data-bind="settings.textPreview">Respawn in 3 s</span>
          </p>
        </div>
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
    <div className="tabpanel" role="tabpanel" aria-label="Network">
      <h2 className="display h2">Network</h2>
      <div className="setrow">
        <div>
          <p className="setrow__label">Low-bandwidth mode</p>
          <p className="setrow__desc">Sends fewer updates to save data. Good on mobile data. Other players may move a little less smoothly.</p>
        </div>
        <Switch on={settings.lowBandwidth} onChange={(lowBandwidth) => ctl.updateSettings({ lowBandwidth })} label="Low-bandwidth mode" />
      </div>
      <div className="setrow">
        <div>
          <p className="setrow__label">Net graph</p>
          <p className="setrow__desc">Shows ping and packet loss in the top-left corner during a match.</p>
        </div>
        <Switch on={settings.netGraph} onChange={(netGraph) => ctl.updateSettings({ netGraph })} label="Net graph" />
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
    <div className="tabpanel" role="tabpanel" aria-label="Touch">
      <h2 className="display h2">Touch</h2>
      <div className="setrow">
        <div>
          <p className="setrow__label">Touch controls</p>
          <p className="setrow__desc">Sticks and buttons on the screen. Auto shows them on phones and tablets, or once you touch the screen.</p>
        </div>
        <Seg value={t.mode} label="Touch controls" options={[['auto', 'Auto'], ['on', 'On'], ['off', 'Off']]} onChange={(mode) => set({ mode })} />
      </div>
      <div className="setrow">
        <div>
          <p className="setrow__label">Fire</p>
          <p className="setrow__desc">Hold: fire while the aim stick is pushed past half-way. On release: lift your thumb to fire once.</p>
        </div>
        <Seg value={t.fire} label="Fire" options={[['hold', 'Hold'], ['release', 'On release']]} onChange={(fire) => set({ fire })} />
      </div>
      <div className="setrow">
        <div>
          <p className="setrow__label">Aim assist</p>
          <p className="setrow__desc">The aim stick leans gently toward a target near where you point. Touch only.</p>
        </div>
        <Switch on={t.aimAssist} onChange={(aimAssist) => set({ aimAssist })} label="Aim assist" />
      </div>
      <div className="setrow">
        <div>
          <p className="setrow__label">Left-handed</p>
          <p className="setrow__desc">Mirrors the whole layout.</p>
        </div>
        <Switch on={t.handed === 'left'} onChange={(on) => set({ handed: on ? 'left' : 'right' })} label="Left-handed" />
      </div>
      <div className="setrow">
        <div>
          <p className="setrow__label">Vibrate when hit</p>
          <p className="setrow__desc">Where the browser allows it.</p>
        </div>
        <Switch on={t.vibrate} onChange={(vibrate) => set({ vibrate })} label="Vibrate when hit" />
      </div>
      <div className="setrow">
        <div>
          <p className="setrow__label">Swipe to dash</p>
          <p className="setrow__desc">Swipe the move stick and lift to dash that way.</p>
        </div>
        <Switch on={t.swipeDash} onChange={(swipeDash) => set({ swipeDash })} label="Swipe to dash" />
      </div>
      <div className="setrow">
        <div>
          <p className="setrow__label">Opacity</p>
          <p className="setrow__desc">How solid the controls look.</p>
        </div>
        <div className="volrow">
          <Slider value={(t.opacity - 0.15) / 0.85} onChange={(v) => set({ opacity: Math.round((0.15 + v * 0.85) * 100) / 100 })} label="Touch controls opacity" valueText={pct(t.opacity)} min={15} max={100} />
          <output className="volrow__val num">{pct(t.opacity)}</output>
        </div>
      </div>
      <div className="setrow">
        <div>
          <p className="setrow__label">Layout</p>
          <p className="setrow__desc">Drag, resize and fade each control. Saved on this device.</p>
        </div>
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
    case 'accessibility':
      return { reduceFlashes: DEFAULT_SETTINGS.reduceFlashes, reduceMotion: DEFAULT_SETTINGS.reduceMotion, colorBlind: DEFAULT_SETTINGS.colorBlind, textScale: DEFAULT_SETTINGS.textScale };
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
  return (
    <Screen name="settings" kind="menu" states={[tab]} label="Settings" modal>
      <header className="topbar">
        <button className="btn btn--ghost" onClick={blurAfter(() => ctl.back())}>
          <Icon name="back" />
          Back <Cap>Esc</Cap>
        </button>
        <span className="topbar__title">Settings</span>
        <div className="topbar__spacer"></div>
        <span className="small muted">Saved on this device</span>
      </header>

      <div className="screen-body settings">
        <div className="tabs" role="tablist" aria-orientation="vertical" aria-label="Settings sections">
          {TABS.map((t) => (
            <button key={t.id} className="tab" role="tab" data-tab={t.id} aria-selected={tab === t.id} onClick={() => ctl.setSettingsTab(t.id)}>
              <Icon name={t.icon} />
              {t.label}
            </button>
          ))}
        </div>

        <div className="settings__panel panel">
          {tab === 'graphics' && <Graphics settings={settings} />}
          {tab === 'audio' && <Audio settings={settings} />}
          {tab === 'controls' && <Controls settings={settings} />}
          {tab === 'accessibility' && <Accessibility settings={settings} />}
          {tab === 'network' && <Network settings={settings} inRoom={inRoom} />}
          {tab === 'touch' && <Touch />}
        </div>
      </div>

      <footer className="settings__bar">
        <button className="btn btn--ghost" onClick={blurAfter(reset)}>
          <Icon name="refresh" />
          Reset this tab
        </button>
        <span className="topbar__spacer"></span>
        <button className="btn btn--primary btn--xl" onClick={blurAfter(() => ctl.back())}>
          Done
        </button>
      </footer>
    </Screen>
  );
}
