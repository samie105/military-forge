/**
 * 2 · Home (round two's data-screen="home"): the brand, the tabs (Play, Locker, Armory, Settings),
 * Play with friends (Create room), Join with code, Training, the player's nameplate and what they
 * spawn with, field orders with the player's own keys, and the sitrep ticker of the maps. Enter
 * creates a room. Arriving from name entry, the ID card becomes the player chip (motion P2); the
 * rows rise in turn (P3). The kit's "Last match" card waits for match history (not kept yet).
 */
import { FRAG, maps, weapons } from '@military-forge/content';
import { savedGunIndices } from '../../locker/accountSync';
import { GAME_NAME } from '@military-forge/shared';
import { Fragment, useEffect, useLayoutEffect, useRef, type CSSProperties } from 'react';
import { useStore } from 'zustand';
import { Icon, weaponIcon } from '../../ui/Icon';
import { Cap, Kbd } from '../../ui/Kbd';
import { sharedElement } from '../../ui/motion';
import { Screen } from '../../ui/Screen';
import { useCtl } from '../context';
import type { ShellStore } from '../store';
import { Backdrop, Hint, Hints, NetPill, takeCard } from './frame';
import { MAP_CARDS, ROOM_SLOTS, lobbyMaps } from './Lobby';
import { FriendsButton, SquadCard } from '../../social/SocialLayer';

/** The brand: the emblem and the name, once in the whole UI (round two's .brand on Home). */
export function Brand() {
  return (
    <span className="brand">
      <svg className="brand__emblem" aria-hidden="true">
        <use href="#icon-emblem" />
      </svg>
      <span className="brand__words">
        <b className="display" data-bind="brand.name">
          {GAME_NAME}
        </b>
      </span>
    </span>
  );
}

/** The sitrep ticker: the maps a room can play, each with its line (decoration; aria-hidden). */
function sitrep(): string[] {
  return lobbyMaps('').map((id) => [maps[id]?.name, MAP_CARDS[id]?.blurb].filter(Boolean).join(' · '));
}

export function Home({ store }: { store: ShellStore }) {
  const ctl = useCtl();
  const profile = useStore(store, (s) => s.profile);
  const settings = useStore(store, (s) => s.settings);
  const offline = !!profile?.offline;
  const chip = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Enter is Play with friends only when nothing has focus: on a focused button it presses that button.
      // Not under an overlay (Join, the QR panels), nor when a box took it (a pasted code's Enter: the box
      // may be gone by now, focus on body)
      if (e.code === 'Enter' && !e.defaultPrevented && !store.getState().overlay && !offline && (document.activeElement === null || document.activeElement === document.body)) {
        e.preventDefault();
        ctl.go({ to: 'create' });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [ctl, offline, store]);

  // from name entry: the ID card becomes the player chip (motion P2)
  useLayoutEffect(() => {
    const from = takeCard();
    if (from && chip.current) sharedElement(from, chip.current);
  }, []);

  const name = profile?.nickname ?? '';
  // the two guns this player spawns with (the Locker's Guns tab, the Armory's Equip; the default pair until then)
  const loadout = savedGunIndices().map((i) => weapons[i]).filter((w) => !!w);
  const ticker = sitrep();
  const row = (i: number) => ({ '--i': i }) as CSSProperties;
  return (
    <Screen name="home" kind="menu" label="Home">
      <Backdrop word="PLAY" />
      <div className="menu">
        <header className="menu-top home__top">
          <Brand />
          <nav className="tabs home__tabs" aria-label="Main">
            <button type="button" className="tab" aria-selected="true">
              <Icon name="play" />
              Play
            </button>
            <button type="button" className="tab m-p8" aria-selected="false" onClick={() => (location.hash = '#/locker')}>
              <Icon name="shirt" />
              Locker
            </button>
            <button type="button" className="tab m-p8" aria-selected="false" onClick={() => location.assign('/armory.html')}>
              <Icon name="rack" />
              Armory
            </button>
            <button type="button" className="tab m-p8" aria-selected="false" onClick={() => ctl.openSettings()}>
              <Icon name="gear" />
              Settings
            </button>
          </nav>
          <span className="menu-top__spacer"></span>
          <FriendsButton />
          <NetPill offline={offline} />
          <span ref={chip} className="me-chip">
            <span className="avatar" aria-hidden="true">
              {([...name.trim()][0] ?? '?').toUpperCase()}
            </span>
            <b data-bind="player.name">{name}</b>
          </span>
        </header>

        <div className="menu-body home">
          <div className="home__play">
            <span className="eyebrow m-p3" style={row(0)}>
              Ops briefing · Deathmatch with friends
            </span>
            <article className="poster halftone-ink home__poster m-p3" style={row(1)}>
              <span className="btn__sticker" style={{ top: -16, right: 40 }}>
                The host can tune the game
              </span>
              <b className="home__poster-no display" aria-hidden="true">
                01
              </b>
              <span className="serial">Op 01 · Squad deployment</span>
              <h2 className="display home__poster-title">
                Play with
                <br />
                friends
              </h2>
              <p className="home__poster-sub">Make a room, send the link to your group chat, and fight. Bots fill empty slots.</p>
              <div className="home__poster-cta">
                <button className="btn btn--ink btn--xl home__create m-p8" type="button" disabled={offline} onClick={() => ctl.go({ to: 'create' })}>
                  <Icon name="users-plus" />
                  Create room
                </button>
                <Cap lg>Enter</Cap>
                {/* a local room (lan/): this device hosts, friends on the same Wi-Fi or hotspot join; it works with the internet slow or down */}
                <button className="btn btn--paper btn--lg mf-home__local m-p8" type="button" onClick={() => ctl.go({ to: 'local' })} title="Host on this device: friends on the same Wi-Fi or hotspot join. Works without internet.">
                  <Icon name="wifi" />
                  <span className="btn__stack">
                    Local room
                    <span className="btn__sub">Same Wi-Fi · works offline</span>
                  </span>
                </button>
                <span className="home__poster-meta">Up to {ROOM_SLOTS} · link + QR</span>
              </div>
              <span className="hazard" aria-hidden="true"></span>
            </article>
            {offline && (
              <p className="status status--warn">
                <Icon name="warn" />
                The game server can't be reached right now: Training and Local room still work.
              </p>
            )}
            <div className="home__row">
              <button type="button" className="ticket rivets home__ticket m-p3" style={row(2)} onClick={() => ctl.openOverlay('join')}>
                <Icon name="link" className="home__ghost" />
                <span className="label">02 — Got a code?</span>
                <b className="display">Join with code</b>
                <span className="home__ticket-sub">6 letters, or paste the link</span>
              </button>
              <button type="button" className="ticket rivets home__ticket m-p3" style={row(3)} onClick={() => ctl.go({ to: 'training' })}>
                <Icon name="target" className="home__ghost" />
                <span className="label">03 — Solo</span>
                <b className="display">Training</b>
                <span className="home__ticket-sub">Practice against bots</span>
              </button>
            </div>
            <div className="home__soon m-p3" style={row(4)} aria-disabled="true">
              <span className="label">04</span>
              <b className="display">Quick play</b>
              <span>Match with anyone</span>
              <span className="tag tag--soon">Coming soon</span>
            </div>
          </div>

          {/* the helmet stands in for the kit's soldier (a gap): it gives way first when the nameplate needs the room */}
          <div className="home__stage mf-home__stage">
            <span className="brackets" style={{ inset: '20px 40px 120px 90px' }} aria-hidden="true">
              <i></i>
              <i></i>
              <i></i>
              <i></i>
            </span>
            <Icon name="helmet" className="mf-home__helmet" />
            <div className="home__nameplate mf-home__nameplate" style={{ '--chars': Math.max(4, name.length) } as CSSProperties}>
              <span className="stamp stamp--volt m-p7">Ready</span>
              <b className="display" data-bind="player.name">
                {name}
              </b>
              <span className="home__loadout">
                {loadout.map((w, i) => {
                  const icon = weaponIcon(w.id);
                  return (
                    <Fragment key={w.id}>
                      {i > 0 && <span className="sep">/</span>}
                      <span className="mf-loadout__item">
                        {icon && <Icon name={icon} className="ic--kf" />}
                        <span data-bind={`player.slot.${i}.name`}>{w.name}</span>
                      </span>
                    </Fragment>
                  );
                })}
                <span className="sep">/</span>
                <span className="mf-loadout__item">
                  <Icon name="g-frag" className="ic--fill" />
                  <span>Frag ×{FRAG.spawnCount}</span>
                </span>
              </span>
              {!offline && (
                <button type="button" className="btn btn--ghost btn--sm m-p8" onClick={() => ctl.openOverlay('name')}>
                  <Icon name="edit" />
                  Edit name
                </button>
              )}
            </div>
          </div>

          <aside className="home__side">
            <SquadCard />
            <section className="card card--print home__news m-p3" style={row(5)}>
              <span className="label label--volt">Field orders</span>
              <ul>
                <li>
                  <Icon name="g-frag" className="ic--fill" />
                  <span>
                    <b>Grenade belt</b> · tap <Kbd code={settings.bindings.grenade[0]} /> to throw, hold it to aim the arc
                  </span>
                </li>
                <li>
                  <Icon name="dash" />
                  <span>
                    <b>Dash</b> · <Kbd code={settings.bindings.dash[0]} /> with a direction, 8 ways
                  </span>
                </li>
                <li>
                  <Icon name="sliders" />
                  <span>
                    <b>Tune the game</b> · the host changes gravity, fuel and more, live
                  </span>
                </li>
              </ul>
              <button type="button" className="btn btn--paper btn--sm btn--block m-p8" onClick={() => ctl.openSettings('controls')}>
                <Icon name="keyboard" />
                All the keys
              </button>
            </section>
          </aside>
        </div>
        <div className="ticker home__ticker" aria-hidden="true">
          <span className="ticker__tag">
            <Icon name="radio" />
            Sitrep
          </span>
          <div className="ticker__run">
            {[...ticker, ...ticker].map((t, i) => (
              <span key={i}>{t}</span>
            ))}
          </div>
        </div>
        <Hints>
          <Hint keys={<Cap>Enter</Cap>}>Create room</Hint>
          <Hint keys={<Cap>Esc</Cap>}>Menu</Hint>
        </Hints>
      </div>
    </Screen>
  );
}
