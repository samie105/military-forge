/**
 * Shell screens over the game canvas (docs/06 §4 L5, docs/07 §2): home, name entry, rooms (lobby,
 * countdown, match status, results), training, settings, the in-game menu, and errors. They read
 * the shell store and call the controller; nothing here runs per frame.
 */
import { maps } from '@military-forge/content';
import { ROOM_SETTING_LIMITS } from '@military-forge/protocol';
import { GAME_NAME } from '@military-forge/shared';
import { MatchPhase, TICK_RATE, type MatchResults } from '@military-forge/sim';
import { createContext, useContext, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { useStore } from 'zustand';
import { NICKNAME_REASONS, type NicknameCheck } from './api';
import { ACTIONS, MAX_BINDINGS, defaultBindings, keyLabel, rebind, unbind, type ActionId } from './controls';
import type { ShellController } from './controller';
import { roomLink } from './controller';
import type { MapEventBanner as MapEventBannerView } from './mapEventBanner';
import { END_REASON, formatClock, kdRatio, placeholderXp, resultHeadline, type MatchView } from './matchView';
import type { LobbyView } from './onlineView';
import { encodeQr, qrSvgPath } from './qr';
import { closeRoute, runCleanup, type ConnectionView, type Settings, type ShellActions, type ShellRoute, type ShellStore } from './store';

const Ctl = createContext<ShellController | null>(null);
/** for tests: screens that call the controller */
export const ControllerContext = Ctl;
const useCtl = (): ShellController => {
  const c = useContext(Ctl);
  if (!c) throw new Error('no shell controller');
  return c;
};

/** Buttons over a running game give focus back, so Space (jet) never re-presses them. */
function blurAfter(fn: () => void) {
  return (e: { currentTarget: HTMLElement }) => {
    e.currentTarget.blur();
    fn();
  };
}

export function App({ store, controller = null }: { store: ShellStore; controller?: ShellController | null }) {
  const match = useStore(store, (s) => s.match);
  const route = useStore(store, (s) => s.route);
  const actions = useStore(store, (s) => s.actions);
  const banner = useMapEventBanner(store);
  if (route) return <RouteView route={route} />;
  const event = banner && <MapEventBanner key={banner.key} banner={banner} />;
  // the debug client (no controller): match overlays for local mode only, as before
  if (!controller)
    return (
      <>
        {event}
        {match && <MatchScreens view={match} actions={actions} />}
      </>
    );
  // the app's HUD (hud/) shows the map event under its clock; the debug client has no HUD
  return (
    <Ctl.Provider value={controller}>
      <AppScreens store={store} />
    </Ctl.Provider>
  );
}

function AppScreens({ store }: { store: ShellStore }) {
  const ctl = useCtl();
  const screen = useStore(store, (s) => s.screen);
  const overlay = useStore(store, (s) => s.overlay);
  const notice = useStore(store, (s) => s.notice);
  const tips = useStore(store, (s) => s.tips);
  const touchWarning = useStore(store, (s) => s.touchWarning);
  const settings = useStore(store, (s) => s.settings);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code === 'Escape' && !location.hash) {
        e.preventDefault();
        ctl.toggleMenu();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [ctl]);

  let body: ReactNode;
  switch (screen.name) {
    case 'boot':
      body = <Centered><Spinner label="Loading…" /></Centered>;
      break;
    case 'name':
      body = (
        <Backdrop>
          <section className="sh-card sh-name-card">
            <Brand small />
            <h2>What should we call you?</h2>
            <NameForm store={store} first />
          </section>
        </Backdrop>
      );
      break;
    case 'home':
      body = <Home store={store} />;
      break;
    case 'finding':
      body = (
        <Backdrop>
          <section className="sh-card sh-center">
            <Spinner label={screen.label} />
            <button className="sh-btn sh-ghost" onClick={() => ctl.go({ to: 'home' })}>
              Cancel
            </button>
          </section>
        </Backdrop>
      );
      break;
    case 'error':
      body = (
        <Backdrop>
          <ErrorCard title={screen.title} message={screen.message}>
            {screen.retry && (
              <button className="sh-btn sh-primary" onClick={() => ctl.go(screen.retry!)}>
                Try again
              </button>
            )}
            <button className="sh-btn" onClick={() => ctl.go({ to: 'home' })}>
              Home
            </button>
          </ErrorCard>
        </Backdrop>
      );
      break;
    case 'room':
      body = <RoomScreen store={store} code={screen.code} />;
      break;
    case 'training':
      body = <TrainingScreen store={store} />;
      break;
  }
  return (
    <>
      {body}
      {tips && (screen.name === 'room' || screen.name === 'training') && !overlay && <TipsCard bindings={settings.bindings} />}
      {overlay && <OverlayView store={store} />}
      {touchWarning && <TouchWarning />}
      {notice && (
        <div className="sh-notice" role="status">
          {notice}
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------- building blocks

function Brand({ small = false }: { small?: boolean }) {
  return (
    <div className={small ? 'sh-brand sh-brand-small' : 'sh-brand'}>
      <span className="sh-brand-mark" aria-hidden="true" />
      <span>{GAME_NAME}</span>
    </div>
  );
}

function Centered({ children }: { children: ReactNode }) {
  return <div className="sh-fill sh-centered">{children}</div>;
}

function Backdrop({ children }: { children: ReactNode }) {
  return <div className="sh-fill sh-backdrop">{children}</div>;
}

function Spinner({ label }: { label: string }) {
  return (
    <div className="sh-spinner" role="status">
      <span className="sh-spinner-ring" aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}

function ErrorCard({ title, message, children }: { title: string; message: string; children: ReactNode }) {
  return (
    <section className="sh-card sh-center" role="alert">
      <h2>{title}</h2>
      <p className="sh-dim">{message}</p>
      <div className="sh-row sh-row-center">{children}</div>
    </section>
  );
}

// ---------------------------------------------------------------- home

function Home({ store }: { store: ShellStore }) {
  const ctl = useCtl();
  const profile = useStore(store, (s) => s.profile);
  const settings = useStore(store, (s) => s.settings);
  return (
    <div className="sh-fill sh-home">
      <header className="sh-home-head">
        <Brand />
        {profile && (
          <button className="sh-chip" onClick={() => ctl.openOverlay('name')} title="Change your name">
            <span className="sh-chip-dot" aria-hidden="true" />
            {profile.nickname}
            <span className="sh-dim"> ✎</span>
          </button>
        )}
      </header>
      <nav className="sh-menu" aria-label="Main menu">
        <MenuButton primary icon="▶" title="Play with friends" hint="Make a room and send the link" onClick={() => ctl.go({ to: 'create' })} disabled={profile?.offline} />
        <MenuButton icon="#" title="Join with code" hint="Got a 6-letter code?" onClick={() => ctl.openOverlay('join')} disabled={profile?.offline} />
        <MenuButton icon="◎" title="Training" hint="Practice against bots" onClick={() => ctl.go({ to: 'training' })} />
        <MenuButton icon="▣" title="Locker" hint="Dress your soldier" onClick={() => (location.hash = '#/locker')} />
        <MenuButton icon="⚙" title="Settings" hint="Graphics, network" onClick={() => ctl.openOverlay('settings')} />
      </nav>
      {profile?.offline && <p className="sh-warn">The game server can't be reached right now: Training still works.</p>}
      <footer className="sh-home-foot">
        <Controls bindings={settings.bindings} />
      </footer>
    </div>
  );
}

function MenuButton({ icon, title, hint, onClick, primary = false, disabled = false }: { icon: string; title: string; hint: string; onClick: () => void; primary?: boolean; disabled?: boolean | undefined }) {
  return (
    <button className={primary ? 'sh-menu-btn sh-menu-primary' : 'sh-menu-btn'} onClick={onClick} disabled={disabled}>
      <span className="sh-menu-icon" aria-hidden="true">
        {icon}
      </span>
      <span className="sh-menu-text">
        <b>{title}</b>
        <small>{hint}</small>
      </span>
    </button>
  );
}

/** The controls at a glance, from the player's own bindings (home, menu, first-run tips). */
export function Controls({ bindings }: { bindings: Settings['bindings'] }) {
  const first = (id: ActionId) => bindings[id][0];
  const pair = (a: ActionId, b: ActionId) => [first(a), first(b)].filter(Boolean).map((c) => keyLabel(c!)).join(' ');
  const rows: [string, string][] = [
    [pair('left', 'right'), 'move'],
    [first('jet') ? keyLabel(first('jet')!) : '–', 'jetpack'],
    [first('down') ? keyLabel(first('down')!) : '–', 'crouch'],
    ...(first('dash') ? ([[keyLabel(first('dash')!), 'dash']] as [string, string][]) : []),
    ['Mouse', 'aim'],
    [first('fire') ? keyLabel(first('fire')!) : '–', 'fire'],
    [first('reload') ? keyLabel(first('reload')!) : '–', 'reload'],
    [first('swap') ? keyLabel(first('swap')!) : '–', 'swap'],
    [first('grenade') ? keyLabel(first('grenade')!) : '–', 'grenade'],
    [first('melee') ? keyLabel(first('melee')!) : '–', 'melee'],
    ['Wheel', 'zoom'],
    [first('scoreboard') ? keyLabel(first('scoreboard')!) : '–', 'scores'],
    ['Esc', 'menu'],
  ];
  return (
    <ul className="sh-keys" aria-label="Controls">
      {rows.map(([k, what]) => (
        <li key={what}>
          <kbd>{k}</kbd> {what}
        </li>
      ))}
    </ul>
  );
}

/** The first-run card: every main control (from the player's bindings) and a few tips. */
export function TipsCard({ bindings }: { bindings: Settings['bindings'] }) {
  const ctl = useCtl();
  const keys = (id: ActionId) => bindings[id].slice(0, 2).map((c) => keyLabel(c));
  const rows: [string, string[]][] = [
    ['Move', [...keys('left').slice(0, 1), ...keys('right').slice(0, 1)]],
    ['Jetpack', keys('jet').slice(0, 2)],
    ['Crouch, drop', keys('down').slice(0, 1)],
    ['Dash + direction', keys('dash').slice(0, 1)],
    ['Aim', ['Mouse']],
    ['Fire', keys('fire').slice(0, 1)],
    ['Reload', keys('reload').slice(0, 1)],
    ['Melee', keys('melee').slice(0, 1)],
    ['Grenade', keys('grenade').slice(0, 1)],
    ['Next grenade', keys('cycleGrenade').slice(0, 1)],
    ['Swap', keys('swap').slice(0, 1)],
    ['Take a gun', keys('interact').slice(0, 1)],
    ['Shield', keys('shield').slice(0, 1)],
    ['Dual', keys('dual').slice(0, 1)],
    ['Scores', keys('scoreboard').slice(0, 1)],
    ['Menu', ['Esc']],
  ];
  return (
    <aside className="sh-tips sh-panel" aria-label="How to play">
      <div className="sh-kicker">How to play</div>
      <dl className="sh-tips-keys">
        {rows.map(([what, ks]) => (
          <div key={what}>
            <dt>{what}</dt>
            <dd>
              {ks.length ? ks.map((k) => <kbd key={k}>{k}</kbd>) : <span className="sh-dim">unbound</span>}
            </dd>
          </div>
        ))}
      </dl>
      <ul className="sh-tips-list">
        <li>Hold the jetpack to fly. Fuel refills on the ground, faster than in the air.</li>
        <li>Hold crouch on a yellow platform to drop through it.</li>
        <li>Two one-handed guns? Dual wield them and both fire.</li>
        <li>Guns lie around the map: stand on one and press {keys('interact')[0] ?? 'E'} to swap it for the one in your hand.</li>
        <li>Change any key in Settings → Controls.</li>
      </ul>
      <button className="sh-btn sh-primary sh-tips-ok" onClick={blurAfter(() => ctl.closeTips())}>
        Got it
      </button>
    </aside>
  );
}

/** Phones and tablets: the game needs a keyboard and mouse (touch controls come later). */
function TouchWarning() {
  const ctl = useCtl();
  return (
    <div className="sh-fill sh-modal sh-touch">
      <section className="sh-card sh-center" aria-label="Best on a computer">
        <Brand small />
        <h2>Best on a computer</h2>
        <p className="sh-dim">This game is played with a keyboard and mouse. On this device you can look around, but you can't play yet: touch controls are coming.</p>
        <p className="sh-dim sh-small">Send yourself this link and open it on a laptop or desktop.</p>
        <div className="sh-row sh-row-center">
          <button className="sh-btn sh-primary" onClick={() => void navigator.clipboard?.writeText(location.href).then(() => ctl.notify('Link copied'), () => {})}>
            Copy link
          </button>
          <button className="sh-btn sh-ghost" onClick={() => ctl.dismissTouchWarning()}>
            Continue anyway
          </button>
        </div>
      </section>
    </div>
  );
}

// ---------------------------------------------------------------- names

function NameForm({ store, first = false }: { store: ShellStore; first?: boolean }) {
  const ctl = useCtl();
  const profile = useStore(store, (s) => s.profile);
  const [name, setName] = useState(profile?.nickname ?? '');
  const [check, setCheck] = useState<NicknameCheck | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => input.current?.focus(), []);
  // the live check (docs/07 §3), debounced while typing
  useEffect(() => {
    setCheck(null);
    const trimmed = name.trim();
    if (!trimmed || trimmed === profile?.nickname || profile?.offline) return;
    let live = true;
    const timer = window.setTimeout(() => {
      ctl.checkName(trimmed).then(
        (c) => live && setCheck(c),
        () => live && setCheck(null),
      );
    }, 300);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [name, ctl, profile]);

  const submit = async (value: string | null) => {
    setBusy(true);
    setError(null);
    const res = await ctl.setName(value);
    setBusy(false);
    if (!res.ok) {
      setError(res.error ?? 'Try another name');
      setSuggestions(res.suggestions ?? []);
    }
  };

  const verdict = check; // reset on every keystroke, so it is always about the current text
  let status: ReactNode = <span className="sh-dim">3–16 letters, digits, spaces, _ - .</span>;
  if (error) status = <span className="sh-bad">{error}</span>;
  else if (verdict && !verdict.valid) status = <span className="sh-bad">{NICKNAME_REASONS[verdict.reason ?? ''] ?? 'Not allowed'}</span>;
  else if (verdict && !verdict.available) status = <span className="sh-bad">{NICKNAME_REASONS.taken}</span>;
  else if (verdict) status = <span className="sh-good">✓ Available</span>;
  const shown = suggestions.length ? suggestions : (verdict?.suggestions ?? []);
  const changeable = profile?.changeableAt ? new Date(profile.changeableAt) : null;

  return (
    <form
      className="sh-name-form"
      onSubmit={(e) => {
        e.preventDefault();
        void submit(name.trim());
      }}
    >
      <input
        ref={input}
        className="sh-input sh-input-big"
        value={name}
        maxLength={32}
        placeholder="Your name"
        aria-label="Your name"
        autoComplete="nickname"
        spellCheck={false}
        onChange={(e) => {
          setName(e.target.value);
          setError(null);
          setSuggestions([]);
        }}
      />
      <div className="sh-name-status" aria-live="polite">
        {status}
      </div>
      {shown.length > 0 && (
        <div className="sh-suggest">
          Try:{' '}
          {shown.slice(0, 4).map((s) => (
            <button type="button" key={s} className="sh-link" onClick={() => setName(s)}>
              {s}
            </button>
          ))}
        </div>
      )}
      {changeable && changeable.getTime() > Date.now() && <p className="sh-dim sh-small">Name changes are once a week: next on {changeable.toLocaleDateString()}.</p>}
      <div className="sh-row">
        <button className="sh-btn sh-primary" type="submit" disabled={busy || !name.trim() || (verdict ? !verdict.valid || !verdict.available : false)}>
          {first ? 'Continue' : 'Save'}
        </button>
        {first && (
          <button type="button" className="sh-btn sh-ghost" disabled={busy} onClick={() => void submit(null)}>
            Pick one for me
          </button>
        )}
      </div>
    </form>
  );
}

// ---------------------------------------------------------------- overlays

function OverlayView({ store }: { store: ShellStore }) {
  const ctl = useCtl();
  const overlay = useStore(store, (s) => s.overlay);
  const screen = useStore(store, (s) => s.screen);
  const settings = useStore(store, (s) => s.settings);
  let body: ReactNode = null;
  if (overlay === 'menu') {
    body = (
      <section className="sh-card sh-menu-card" aria-label="Menu">
        <h2>Paused</h2>
        <p className="sh-dim sh-small">The match keeps running.</p>
        <div className="sh-stack">
          <button className="sh-btn sh-primary" onClick={() => ctl.closeOverlay()}>
            Resume
          </button>
          {screen.name === 'room' && (
            <button className="sh-btn" onClick={() => void ctl.copyLink(screen.code)}>
              Copy invite link
            </button>
          )}
          <button className="sh-btn" onClick={() => ctl.showTips()}>
            Controls &amp; tips
          </button>
          <button className="sh-btn" onClick={() => ctl.openOverlay('settings')}>
            Settings
          </button>
          <button className="sh-btn sh-danger" onClick={() => ctl.leave()}>
            {screen.name === 'room' ? 'Leave room' : 'Quit training'}
          </button>
        </div>
        <Controls bindings={settings.bindings} />
      </section>
    );
  } else if (overlay === 'settings') body = <SettingsCard settings={settings} />;
  else if (overlay === 'join') body = <JoinCard />;
  else if (overlay === 'name')
    body = (
      <section className="sh-card sh-name-card">
        <h2>Your name</h2>
        <NameForm store={store} />
        <button className="sh-btn sh-ghost sh-close" onClick={() => ctl.closeOverlay()} aria-label="Close">
          ✕
        </button>
      </section>
    );
  return (
    <div className="sh-fill sh-modal" onMouseDown={(e) => e.target === e.currentTarget && ctl.closeOverlay()}>
      {body}
    </div>
  );
}

function SettingsCard({ settings }: { settings: Settings }) {
  const ctl = useCtl();
  const [tab, setTab] = useState<'general' | 'controls'>('general');
  return (
    <section className="sh-card sh-settings" aria-label="Settings">
      <div className="sh-settings-head">
        <h2>Settings</h2>
        <div className="sh-tabs" role="tablist">
          <button role="tab" aria-selected={tab === 'general'} className="sh-tab" onClick={() => setTab('general')}>
            General
          </button>
          <button role="tab" aria-selected={tab === 'controls'} className="sh-tab" onClick={() => setTab('controls')}>
            Controls
          </button>
        </div>
      </div>
      {tab === 'general' ? (
        <div className="sh-settings-body">
          <label className="sh-field">
            <span>Graphics</span>
            <select className="sh-select" value={settings.graphics} onChange={(e) => ctl.updateSettings({ graphics: e.target.value as Settings['graphics'] })}>
              <option value="low">Low (fastest)</option>
              <option value="medium">Medium</option>
              <option value="high">High (shadows)</option>
            </select>
          </label>
          <Toggle checked={settings.netGraph} onChange={(netGraph) => ctl.updateSettings({ netGraph })} title="Net graph" hint="Ping, packet loss and bandwidth on screen" />
          <Toggle checked={settings.lowBandwidth} onChange={(lowBandwidth) => ctl.updateSettings({ lowBandwidth })} title="Low-bandwidth mode" hint="For a weak connection: fewer, bigger updates" />
          <Toggle checked={settings.reduceFlashes} onChange={(reduceFlashes) => ctl.updateSettings({ reduceFlashes })} title="Reduce flashes" hint="Flashbangs dim and blur the screen instead of turning it white" />
        </div>
      ) : (
        <ControlsEditor settings={settings} />
      )}
      <div className="sh-row sh-settings-foot">
        <button className="sh-btn sh-primary" onClick={() => ctl.closeOverlay()}>
          Done
        </button>
      </div>
    </section>
  );
}

function Toggle({ checked, onChange, title, hint, disabled = false }: { checked: boolean; onChange: (on: boolean) => void; title: string; hint?: string; disabled?: boolean }) {
  return (
    <label className={disabled ? 'sh-toggle sh-disabled' : 'sh-toggle'}>
      <span className="sh-toggle-text">
        <b>{title}</b>
        {hint && <small>{hint}</small>}
      </span>
      <input type="checkbox" role="switch" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span className="sh-switch" aria-hidden="true" />
    </label>
  );
}

type KeyboardWithLayout = Navigator & { keyboard?: { getLayoutMap?: () => Promise<ReadonlyMap<string, string>> } };

/** navigator.keyboard's layout map (Chromium), so keys show what the player's keyboard prints. */
function useKeyboardLayout(): ReadonlyMap<string, string> | null {
  const [layout, setLayout] = useState<ReadonlyMap<string, string> | null>(null);
  useEffect(() => {
    let live = true;
    (navigator as KeyboardWithLayout).keyboard
      ?.getLayoutMap?.()
      .then((m) => live && setLayout(m))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);
  return layout;
}

function ControlsEditor({ settings }: { settings: Settings }) {
  const ctl = useCtl();
  const layout = useKeyboardLayout();
  /** the binding being captured: action + index (index = length → a new one) */
  const [capture, setCapture] = useState<{ action: ActionId; index: number } | null>(null);
  const bindings = settings.bindings;

  useEffect(() => {
    if (!capture) return;
    const finish = (code: string | null) => {
      setCapture(null);
      if (code === null) return;
      const { bindings: next, took } = rebind(bindings, capture.action, code, capture.index);
      ctl.updateSettings({ bindings: next });
      if (took) ctl.notify(`${keyLabel(code, layout)} was “${ACTIONS.find((a) => a.id === took)!.label}”: that action lost it`);
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

  const groups = ['Move', 'Combat', 'Weapons', 'Interface'] as const;
  return (
    <div className="sh-settings-body sh-controls">
      {groups.map((group) => (
        <div key={group} className="sh-control-group">
          <h3>{group}</h3>
          {ACTIONS.filter((a) => a.group === group).map((a) => {
            const codes = bindings[a.id];
            const soon = a.bit === 0;
            return (
              <div key={a.id} className="sh-control-row">
                <span className="sh-control-label">
                  {a.label}
                  {soon && <span className="sh-badge sh-soon">SOON</span>}
                  {a.hint && <small>{a.hint}</small>}
                </span>
                <span className="sh-keycaps">
                  {codes.map((code, i) => {
                    const capturing = capture?.action === a.id && capture.index === i;
                    return (
                      <button key={code} className={capturing ? 'sh-keycap sh-capturing' : 'sh-keycap'} onClick={() => setCapture({ action: a.id, index: i })} title="Click, then press a key or mouse button (Backspace clears, Esc cancels)">
                        {capturing ? 'Press a key…' : keyLabel(code, layout)}
                      </button>
                    );
                  })}
                  {codes.length < MAX_BINDINGS &&
                    (capture?.action === a.id && capture.index === codes.length ? (
                      <button className="sh-keycap sh-capturing">
                        Press a key…
                      </button>
                    ) : (
                      <button className="sh-keycap sh-keycap-add" onClick={() => setCapture({ action: a.id, index: codes.length })} aria-label={`Add a key for ${a.label}`}>
                        +
                      </button>
                    ))}
                </span>
              </div>
            );
          })}
          {group === 'Move' && (
            <Toggle checked={settings.doubleTapDash} onChange={(doubleTapDash) => ctl.updateSettings({ doubleTapDash })} title="Double-tap a direction to dash" hint="Left, right or down twice, quickly. Up is dash + jet" />
          )}
        </div>
      ))}
      <div className="sh-control-row">
        <span className="sh-control-label">
          Menu
          <small>Always Esc</small>
        </span>
        <span className="sh-keycaps">
          <span className="sh-keycap sh-keycap-fixed">Esc</span>
        </span>
      </div>
      <div className="sh-row">
        <button className="sh-btn sh-ghost" onClick={() => ctl.updateSettings({ bindings: defaultBindings(), doubleTapDash: false })}>
          Reset to defaults
        </button>
      </div>
    </div>
  );
}

function JoinCard() {
  const ctl = useCtl();
  const [code, setCode] = useState('');
  const clean = code.replace(/[^A-Za-z]/g, '').toUpperCase();
  const ok = /^[ABCDEFGHJKMNPQRSTUVWXYZ]{6}$/.test(clean);
  return (
    <section className="sh-card sh-join" aria-label="Join with code">
      <h2>Join with code</h2>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (ok) ctl.go({ to: 'join', code: clean });
        }}
      >
        <input
          className="sh-input sh-code-input"
          value={clean}
          autoFocus
          maxLength={6}
          placeholder="KQXMZP"
          aria-label="Room code"
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => setCode(e.target.value)}
          onPaste={(e) => {
            // a pasted link works too
            const text = e.clipboardData.getData('text');
            const m = /(?:\/r\/|room=)([A-Za-z]{6})/.exec(text);
            if (m) {
              e.preventDefault();
              setCode(m[1]!);
            }
          }}
        />
        <p className="sh-dim sh-small">6 letters. A pasted link works too.</p>
        <div className="sh-row">
          <button className="sh-btn sh-primary" type="submit" disabled={!ok}>
            Join
          </button>
          <button type="button" className="sh-btn sh-ghost" onClick={() => ctl.closeOverlay()}>
            Cancel
          </button>
        </div>
      </form>
    </section>
  );
}

// ---------------------------------------------------------------- rooms

const CLOSE_MESSAGES: Record<number, [string, string]> = {
  4001: ['New version available', 'The game was updated. Reload the page to get the new version.'],
  4002: ['Room is full', 'This room already has the most players it can take.'],
  4003: ['Disconnected', 'The server could not read what this browser sent.'],
  4004: ['Disconnected', 'Too many messages too fast.'],
  4005: ['Opened somewhere else', 'You joined this room from another tab or window.'],
  4006: ["Can't open the room", 'The server could not open this room right now. Try again in a minute.'],
  1011: ['Match error', 'Something went wrong in this room and it was closed.'],
};

function RoomScreen({ store, code }: { store: ShellStore; code: string }) {
  const ctl = useCtl();
  const connection = useStore(store, (s) => s.connection);
  const match = useStore(store, (s) => s.match);
  const lobby = useStore(store, (s) => s.lobby);
  const actions = useStore(store, (s) => s.actions);

  if (!connection || connection.state === 'connecting' || connection.state === 'joining' || (connection.state === 'connected' && !match)) {
    return (
      <Backdrop>
        <section className="sh-card sh-center">
          <Spinner label={`Joining room ${code}…`} />
          <button className="sh-btn sh-ghost" onClick={() => ctl.leave()}>
            Cancel
          </button>
        </section>
      </Backdrop>
    );
  }
  if (connection.state === 'failed') return <ConnectionFailed connection={connection} />;
  return (
    <>
      {connection.state === 'reconnecting' && (
        <div className="sh-banner" role="status">
          <span className="sh-spinner-ring sh-spinner-small" aria-hidden="true" /> Connection lost: reconnecting…
        </div>
      )}
      {match && match.phase === MatchPhase.Waiting && lobby ? (
        <RoomLobby lobby={lobby} />
      ) : match ? (
        <MatchScreens view={match} actions={actions} online={{ isHost: lobby?.isHost ?? false, leave: () => ctl.leave() }} />
      ) : null}
    </>
  );
}

function ConnectionFailed({ connection }: { connection: ConnectionView }) {
  const ctl = useCtl();
  const [title, message] = CLOSE_MESSAGES[connection.code] ?? ['Connection lost', 'The connection to the game server dropped and could not be restored.'];
  return (
    <Backdrop>
      <ErrorCard title={title} message={connection.code === 4006 && connection.detail ? `${message} (${connection.detail})` : message}>
        {connection.code === 4001 ? (
          <button className="sh-btn sh-primary" onClick={() => location.reload()}>
            Reload
          </button>
        ) : (
          <button className="sh-btn sh-primary" onClick={() => ctl.rejoin()}>
            Rejoin
          </button>
        )}
        <button className="sh-btn" onClick={() => ctl.go({ to: 'home' })}>
          Home
        </button>
      </ErrorCard>
    </Backdrop>
  );
}

const TIME_OPTIONS = [60, 120, 180, 300, 480, 600, 900, 1200, 0];
const KILL_OPTIONS = [5, 10, 15, 20, 25, 30, 50, 0];

function RoomLobby({ lobby }: { lobby: LobbyView }) {
  const ctl = useCtl();
  const online = ctl.host.online;
  const link = roomLink(lobby.code);
  const enough = lobby.players.length >= lobby.minPlayers;
  // bots never ready up (the match doesn't wait for them): "ready" counts the people
  const people = lobby.players.filter((p) => !p.isBot);
  const [collapsed, setCollapsed] = useState(false);
  if (collapsed) {
    return (
      <div className="sh-lobby-mini sh-panel" aria-label="Room lobby">
        <span className="sh-kicker">Room</span>
        <b className="sh-code-mini">{lobby.code}</b>
        <span className="sh-dim">
          {people.filter((p) => p.ready).length}/{people.length} ready
        </span>
        <button className={lobby.ready ? 'sh-btn sh-small-btn sh-ready-on' : 'sh-btn sh-small-btn sh-primary'} onClick={blurAfter(() => online?.setReady(!lobby.ready))}>
          {lobby.ready ? '✓ Ready' : 'Ready'}
        </button>
        <button className="sh-btn sh-small-btn sh-ghost" onClick={blurAfter(() => setCollapsed(false))} aria-label="Show the lobby">
          Lobby ▸
        </button>
      </div>
    );
  }
  const qr = useMemo(() => qrSvgPath(encodeQr(link)), [link]);
  const times = TIME_OPTIONS.filter((t) => t === 0 || (t >= ROOM_SETTING_LIMITS.timeLimit.min && t <= ROOM_SETTING_LIMITS.timeLimit.max));
  const kills = KILL_OPTIONS.filter((k) => k === 0 || (k >= ROOM_SETTING_LIMITS.killLimit.min && k <= ROOM_SETTING_LIMITS.killLimit.max));
  // one map per room for now: another map needs the room to swap its Game and every client to follow
  const roomMap = maps[lobby.mapId];
  return (
    <>
      <aside className="sh-lobby sh-panel" aria-label="Room lobby">
        <div className="sh-lobby-head">
          <div>
            <div className="sh-kicker">Room</div>
            <div className="sh-code" aria-label={`Room code ${lobby.code}`}>
              {lobby.code.slice(0, 3)}
              <span>{lobby.code.slice(3)}</span>
            </div>
          </div>
          <div className="sh-row sh-lobby-tools">
            <button className="sh-btn sh-ghost sh-small-btn" onClick={blurAfter(() => setCollapsed(true))} title="Hide the lobby to warm up" aria-label="Hide the lobby">
              ◂ Hide
            </button>
            <button className="sh-btn sh-ghost sh-small-btn" onClick={blurAfter(() => ctl.leave())}>
              Leave
            </button>
          </div>
        </div>
        <div className="sh-invite">
          <div className="sh-invite-text">
            <button className="sh-btn sh-primary sh-copy" onClick={blurAfter(() => void ctl.copyLink(lobby.code))}>
              Copy link
            </button>
            <p className="sh-dim sh-small">Send it to a friend: they open it and they're in.</p>
            <code className="sh-link-text">{link}</code>
          </div>
          <svg className="sh-qr" viewBox={qr.viewBox} role="img" aria-label="QR code of the room link">
            <rect width="100%" height="100%" fill="#fff" />
            <path d={qr.path} fill="#0f141c" />
          </svg>
        </div>

        <h3>
          Players <span className="sh-dim">({lobby.players.length})</span>
        </h3>
        <ul className="sh-players">
          {lobby.players.map((p) => (
            <li key={p.id} className={p.you ? 'sh-you' : ''}>
              {p.isBot ? <span className="sh-badge sh-bot">BOT</span> : <span className={p.ready ? 'sh-dot sh-dot-on' : 'sh-dot'} title={p.ready ? 'Ready' : 'Not ready'} />}
              <span className="sh-pname">
                {p.name}
                {p.you && <small className="sh-dim"> (you)</small>}
              </span>
              {p.host && <span className="sh-badge">HOST</span>}
              <span className="sh-ping">{p.pingMs >= 0 ? `${p.pingMs} ms` : ''}</span>
            </li>
          ))}
        </ul>
        {!enough && <p className="sh-dim sh-small">Waiting for at least {lobby.minPlayers} players…</p>}

        <h3>Match</h3>
        <div className="sh-settings-grid">
          <label>
            <span>Time</span>
            <select className="sh-select" disabled={!lobby.isHost} value={lobby.timeLimit} onChange={(e) => online?.setMatchSettings({ timeLimit: Number(e.target.value) })}>
              {(times.includes(lobby.timeLimit) ? times : [...times, lobby.timeLimit]).map((t) => (
                <option key={t} value={t} disabled={t === 0 && lobby.killLimit === 0}>
                  {t === 0 ? 'No limit' : `${t / 60} min`}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>Kills</span>
            <select className="sh-select" disabled={!lobby.isHost} value={lobby.killLimit} onChange={(e) => online?.setMatchSettings({ killLimit: Number(e.target.value) })}>
              {(kills.includes(lobby.killLimit) ? kills : [...kills, lobby.killLimit]).map((k) => (
                <option key={k} value={k} disabled={k === 0 && lobby.timeLimit === 0}>
                  {k === 0 ? 'No limit' : k}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>Map</span>
            <select className="sh-select" disabled value={lobby.mapId} title="Rooms play the server's map for now">
              <option value={lobby.mapId}>{roomMap?.name ?? lobby.mapId}</option>
            </select>
          </label>
        </div>
        {!lobby.isHost && <p className="sh-dim sh-small">The host picks the settings.</p>}

        <div className="sh-row sh-lobby-actions">
          <button className={lobby.ready ? 'sh-btn sh-ready-on' : 'sh-btn sh-primary'} onClick={blurAfter(() => online?.setReady(!lobby.ready))}>
            {lobby.ready ? '✓ Ready' : 'Ready'}
          </button>
          {lobby.isHost && (
            <button className="sh-btn" disabled={!enough} onClick={blurAfter(() => online?.startMatch())} title={enough ? 'Start the countdown now' : `Needs ${lobby.minPlayers} players`}>
              Start now
            </button>
          )}
        </div>
      </aside>
      <div className="sh-warmup" role="status">
        <b>Warm-up</b> · move and shoot freely: nothing counts until the match starts. Everyone ready → it starts.
      </div>
    </>
  );
}

// ---------------------------------------------------------------- training

function TrainingScreen({ store }: { store: ShellStore }) {
  const match = useStore(store, (s) => s.match);
  const actions = useStore(store, (s) => s.actions);
  const ctl = useCtl();
  return (
    <>
      {match && <MatchScreens view={match} actions={actions} training={{ leave: () => ctl.leave() }} />}
      <div className="sh-corner-hint">Esc · menu</div>
    </>
  );
}

// ---------------------------------------------------------------- match screens (local and online)

interface OnlineExtras {
  isHost: boolean;
  leave(): void;
}

function MatchScreens({ view, actions, online, training }: { view: MatchView; actions: ShellActions; online?: OnlineExtras; training?: { leave(): void } }) {
  switch (view.phase) {
    case MatchPhase.Waiting:
      return <Lobby view={view} actions={actions} />;
    case MatchPhase.Countdown:
      return <Countdown view={view} />;
    case MatchPhase.InProgress:
      // the app's HUD (hud/) shows the clock and score; the debug client keeps this panel
      return online || training ? null : <MatchStatus view={view} />;
    default:
      return view.results ? <Results view={view} results={view.results} actions={actions} online={online} training={training} /> : null;
  }
}

/** The HUD banner hook (docs/02 §20.7): the map event to announce, null when none. */
export function useMapEventBanner(store: ShellStore): MapEventBannerView | null {
  return useStore(store, (s) => s.mapEvent);
}

/** "EMP STORM in 3 · Jetpacks offline", then "EMP STORM · Jetpacks offline · 6 s". */
export function MapEventBanner({ banner }: { banner: MapEventBannerView }) {
  const warning = banner.phase === 'warning';
  return (
    <div className={`mm-event${warning ? ' mm-event-warning' : ''}`} style={{ '--mm-event': banner.color } as CSSProperties} role="status" aria-live="polite">
      <div className="mm-event-title">
        {banner.title}
        {warning && <span className="mm-event-in"> in {banner.seconds}</span>}
      </div>
      <div className="mm-event-line">
        {banner.line}
        {!warning && <span className="mm-dim"> · {banner.seconds} s</span>}
      </div>
    </div>
  );
}

function RouteView({ route }: { route: ShellRoute }) {
  const el = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code === 'Escape') closeRoute();
    };
    window.addEventListener('keydown', onKey);
    const cleanup = route.mount(el.current!, closeRoute);
    return () => {
      window.removeEventListener('keydown', onKey);
      runCleanup(cleanup);
    };
  }, [route]);
  return (
    <div className="sh-route" aria-label={route.title}>
      <div ref={el} className="sh-route-body" />
      {!route.ownExit && (
        <button className="sh-btn sh-route-back" onClick={closeRoute}>
          ← Back
        </button>
      )}
    </div>
  );
}

/** Local warm-up bar (training and the debug client). */
export function Lobby({ view, actions }: { view: MatchView; actions: ShellActions }) {
  return (
    <div className="sh-lobby-bar sh-panel">
      <div>
        <b>Warm-up</b> · nothing counts until the match starts
      </div>
      <button className="sh-btn sh-primary" disabled={view.ready} onClick={blurAfter(actions.ready)}>
        {view.ready ? 'Ready · waiting for players' : 'Ready'}
      </button>
    </div>
  );
}

export function Countdown({ view }: { view: MatchView }) {
  return (
    <div className="sh-countdown" role="status">
      <div className="sh-kicker">
        Match {view.number} · Deathmatch{view.killLimit > 0 ? ` · first to ${view.killLimit}` : ''}
      </div>
      <div key={view.secondsLeft} className="sh-countdown-n">
        {view.secondsLeft}
      </div>
    </div>
  );
}

export function MatchStatus({ view }: { view: MatchView }) {
  return (
    <div className="sh-status sh-panel" role="status">
      <div className="sh-clock" title={view.untimed ? 'Time played (no time limit)' : 'Time left'}>
        {formatClock(view.untimed ? view.secondsElapsed : view.secondsLeft)}
      </div>
      <div className="sh-scoreline">
        You <b>{view.myScore}</b> · Leader <b>{view.leaderScore}</b>
        {view.killLimit > 0 && <span className="sh-dim"> / {view.killLimit}</span>}
      </div>
    </div>
  );
}

function Headline({ text, win }: { text: string; win: boolean }) {
  return <h1 className={win ? 'sh-win' : ''}>{text}</h1>;
}

export function Results({
  view,
  results,
  actions,
  online,
  training,
}: {
  view: MatchView;
  results: MatchResults;
  actions: ShellActions;
  online?: OnlineExtras | undefined;
  training?: { leave(): void } | undefined;
}) {
  // ids are slots: after a leave, the leaver's row can carry your id, so skip departed rows
  const me = results.standings.find((s) => s.id === view.localId && !s.left);
  const head = me ? resultHeadline(me, results.standings) : null;
  const voting = view.phase === MatchPhase.Ending || view.phase === MatchPhase.Postgame;
  const note =
    view.phase === MatchPhase.Closed
      ? 'Room closed'
      : `Rematch ${view.votes}/${view.humans}${view.phase === MatchPhase.Postgame ? ` · ${view.secondsLeft} s` : ''}`;
  return (
    <div className="sh-fill sh-backdrop sh-results-wrap">
      <section className="sh-results sh-panel" aria-label="Match results">
        <header>
          <div className="sh-kicker">
            Match {results.number} · {END_REASON[results.reason]} · {formatClock(Math.round(results.durationTicks / TICK_RATE))}
          </div>
          {me && head && (
            <>
              <Headline {...head} />
              <dl className="sh-mine">
                <div><dt>K/D</dt><dd>{kdRatio(me)}</dd></div>
                <div><dt>Damage</dt><dd>{me.damageDealt}</dd></div>
                <div><dt>Best streak</dt><dd>{me.bestStreak}</dd></div>
                <div><dt>XP</dt><dd>+{placeholderXp(me, head.win)} <small>preview</small></dd></div>
              </dl>
            </>
          )}
        </header>
        <table className="sh-table">
          <thead>
            <tr>
              <th>#</th><th className="sh-name">Player</th><th>Score</th><th>K</th><th>D</th><th>A</th><th>K/D</th><th>Dmg</th>
            </tr>
          </thead>
          <tbody>
            {results.standings.map((s) => (
              <tr key={s.key} className={s.id === view.localId && !s.left ? 'sh-me' : s.left ? 'sh-left' : ''}>
                <td>{s.placement}</td>
                <td className="sh-name">
                  {s.name}
                  {s.mvp && <span className="sh-badge sh-mvp">MVP</span>}
                  {s.isBot && <span className="sh-badge">BOT</span>}
                  {s.left && <span className="sh-badge">LEFT</span>}
                </td>
                <td>{s.score}</td><td>{s.kills}</td><td>{s.deaths}</td><td>{s.assists}</td><td>{kdRatio(s)}</td><td>{s.damageDealt}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <footer>
          <button className="sh-btn sh-primary" disabled={!voting || view.voted} onClick={blurAfter(actions.playAgain)}>
            {view.voted ? 'Waiting for others…' : 'Play again'}
          </button>
          {(!online || online.isHost) && (
            <button className="sh-btn" disabled={view.phase === MatchPhase.Closed} onClick={blurAfter(actions.backToLobby)}>
              Back to lobby
            </button>
          )}
          {(online || training) && (
            <button className="sh-btn sh-ghost" onClick={blurAfter(() => (online ?? training)!.leave())}>
              {online ? 'Leave room' : 'Home'}
            </button>
          )}
          <span className="sh-dim">{note}</span>
        </footer>
      </section>
    </div>
  );
}
