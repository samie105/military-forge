/**
 * 2 · Home (the kit's data-screen="home"): the player's name, Play with friends, Join, Training,
 * Locker, Armory, Settings, the soldier and what they spawn with, and a controls reminder from the
 * player's own bindings. Enter starts Play with friends.
 */
import { DEFAULT_LOADOUT, FRAG, weapons } from '@military-forge/content';
import { GAME_NAME } from '@military-forge/shared';
import { useEffect } from 'react';
import { useStore } from 'zustand';
import { Icon, weaponIcon } from '../../ui/Icon';
import { Cap, Kbd } from '../../ui/Kbd';
import { Ping, Screen } from '../../ui/Screen';
import { useCtl, useServerPing } from '../context';
import type { Bindings } from '../controls';
import type { ShellStore } from '../store';

export function Brand() {
  return (
    <div className="brand">
      <Icon name="emblem" className="brand__mark" />
      <span className="brand__name" data-bind="brand.name">
        {GAME_NAME}
      </span>
    </div>
  );
}

/** The controls strip: every main action with the player's first key. */
export function ControlsStrip({ bindings, onChange }: { bindings: Bindings; onChange: () => void }) {
  const k = (id: keyof Bindings) => bindings[id][0];
  const rows: [string, (string | undefined)[]][] = [
    ['Move', [k('left'), k('right')]],
    ['Jet', [k('jet')]],
    ['Crouch', [k('down')]],
    ['Dash', [k('dash')]],
    ['Fire', [k('fire')]],
    ['Reload', [k('reload')]],
    ['Swap', [k('swap')]],
    ['Grenade: tap throws, hold aims', [k('grenade')]],
    ['Melee', [k('melee')]],
    ['Shield', [k('shield')]],
    ['Scores', [k('scoreboard')]],
  ];
  return (
    <footer className="controls-strip" aria-label="Controls reminder">
      <span className="eyebrow">
        <Icon name="keyboard" size="sm" />
        Controls
      </span>
      <ul className="controls-strip__list">
        {rows.map(([what, codes]) => (
          <li key={what}>
            <span className="keys">
              {codes.filter(Boolean).map((c) => (
                <Kbd key={c} code={c} />
              ))}
            </span>
            {what}
          </li>
        ))}
      </ul>
      <button className="btn btn--ghost" onClick={onChange}>
        Change keys
        <Icon name="chev-right" size="sm" />
      </button>
    </footer>
  );
}

export function Home({ store }: { store: ShellStore }) {
  const ctl = useCtl();
  const profile = useStore(store, (s) => s.profile);
  const settings = useStore(store, (s) => s.settings);
  const ping = useServerPing();
  const offline = !!profile?.offline;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Enter is Play with friends only when nothing has focus: on a focused button it presses that button
      if (e.code === 'Enter' && !offline && (document.activeElement === null || document.activeElement === document.body)) {
        e.preventDefault();
        ctl.go({ to: 'create' });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [ctl, offline]);

  const loadout = DEFAULT_LOADOUT.map((i) => weapons[i]).filter((w) => !!w);
  return (
    <Screen name="home" kind="menu" label="Home">
      <header className="topbar">
        <Brand />
        <div className="topbar__spacer"></div>
        {offline ? (
          <span className="status status--warn">
            <Icon name="unplug" />
            Server offline
          </span>
        ) : (
          <Ping ms={ping} label="Server" />
        )}
        <button className="btn btn--secondary btn--icon" aria-label="Settings" onClick={() => ctl.openSettings()}>
          <Icon name="gear" />
        </button>
      </header>

      <div className="screen-body home">
        <div className="home__main">
          <div className="home__id">
            <p className="eyebrow">Soldier</p>
            <div className="home__namerow">
              <h1 className="home__player" data-bind="player.name">
                {profile?.nickname ?? ''}
              </h1>
              {!offline && (
                <button className="btn btn--ghost" onClick={() => ctl.openOverlay('name')}>
                  <Icon name="edit" />
                  Edit name
                </button>
              )}
            </div>
            {offline && (
              <p className="status status--warn">
                <Icon name="warn" />
                The game server can't be reached right now: Training still works.
              </p>
            )}
          </div>

          <button className="cta-main" disabled={offline} onClick={() => ctl.go({ to: 'create' })}>
            <span className="cta-main__icon">
              <Icon name="users-plus" size="xl" />
            </span>
            <span className="cta-main__text">
              <span className="cta-main__title">Play with friends</span>
              <span className="cta-main__sub">Make a room, then share the link on WhatsApp</span>
            </span>
            <Cap lg>Enter</Cap>
            <Icon name="arrow-right" size="lg" />
          </button>

          <div className="home__grid">
            <button className="tile" disabled={offline} onClick={() => ctl.openOverlay('join')}>
              <Icon name="door-in" size="lg" />
              <span className="tile__title">Join with code</span>
              <span className="tile__sub">Type 6 letters or paste a link</span>
            </button>
            <button className="tile" onClick={() => ctl.go({ to: 'training' })}>
              <Icon name="target" size="lg" />
              <span className="tile__title">Training</span>
              <span className="tile__sub">Practice against bots</span>
            </button>
            <div className="tile tile--soon" aria-disabled="true">
              <Icon name="bolt" size="lg" />
              <span className="tile__title">Quick play</span>
              <span className="tile__sub">Jump into a match with anyone</span>
              <span className="badge badge--soon">Coming soon</span>
            </div>
          </div>

          <nav className="home__nav" aria-label="More">
            <button className="navtile" onClick={() => (location.hash = '#/locker')}>
              <Icon name="helmet" size="lg" />
              <span>
                <span className="navtile__title">Locker</span>
                <span className="navtile__sub">Dress your soldier</span>
              </span>
            </button>
            <button className="navtile" onClick={() => location.assign('/armory.html')}>
              <Icon name="armory" size="lg" />
              <span>
                <span className="navtile__title">Armory</span>
                <span className="navtile__sub">Look at the guns</span>
              </span>
            </button>
            <button className="navtile" onClick={() => ctl.openSettings()}>
              <Icon name="gear" size="lg" />
              <span>
                <span className="navtile__title">Settings</span>
                <span className="navtile__sub">Graphics, sound, keys</span>
              </span>
            </button>
          </nav>
        </div>

        <aside className="home__hero" aria-label="Your soldier">
          <div className="home__stage home__stage--emblem">
            <span className="home__stencil" aria-hidden="true">
              Rookie kit
            </span>
            <div className="home__podium" aria-hidden="true"></div>
            <div className="home__soldier" role="img" aria-label="Your soldier in the rookie kit">
              <Icon name="helmet" />
            </div>
            <div className="loadout">
              <p className="eyebrow">You spawn with</p>
              <ul className="loadout__list">
                {loadout.map((w) => {
                  const icon = weaponIcon(w.id);
                  return (
                    <li key={w.id}>
                      {icon && <Icon name={icon} size="wpn" />}
                      <span>{w.name}</span>
                    </li>
                  );
                })}
                <li>
                  <Icon name="g-frag" />
                  <span>Frag ×{FRAG.spawnCount}</span>
                </li>
              </ul>
            </div>
          </div>
        </aside>
      </div>

      <ControlsStrip bindings={settings.bindings} onChange={() => ctl.openSettings('controls')} />
    </Screen>
  );
}
