/**
 * 2 · Home (round two's data-screen="home"): the brand, the tabs (Play, Locker, Armory, Settings),
 * Play with friends (Create room), Join with code, Training, the player's nameplate and what they
 * spawn with, field orders with the player's own keys, and the sitrep ticker of the maps. Enter
 * creates a room. Arriving from name entry, the ID card becomes the player chip (motion P2); the
 * rows rise in turn (P3). The chip is the player's own soldier and level (audit 2 P-09, P-04); the
 * side column ends with the last online match and a personal best once there is one (P-10).
 */
import { FRAG, maps, weapons } from '@military-forge/content';
import { savedGunIndices } from '../../locker/accountSync';
import { GAME_NAME } from '@military-forge/shared';
import { Fragment, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { useStore } from 'zustand';
import { Icon, weaponIcon } from '../../ui/Icon';
import { Cap, Kbd } from '../../ui/Kbd';
import { sharedElement } from '../../ui/motion';
import { Screen } from '../../ui/Screen';
import { useCtl } from '../context';
import type { ShellStore } from '../store';
import { Backdrop, Hint, Hints, NetPill, OFFLINE_LINE, SUSPENDED_LINE, takeCard } from './frame';
import { MAP_CARDS, lobbyMaps } from './Lobby';
import { FriendsButton, SquadCard } from '../../social/SocialLayer';
import { SavedAdsList } from '../../ads/SavedAds';
import { NextOrders } from '../../tour/NextOrders';
import { currentDevice } from '../../gamepad';
import { useInputDevice, useShownControls } from '../../gamepad/react';
import { drillDone, isTouchDevice } from '../../touch';
import { InstallButton } from '../../pwa/InstallButton';
import { ConsentCard, useHomeAsk } from '../../metrics/ConsentCard';
import { HomeSoldier } from '../../presentation/HomeSoldier';
import { PosterImg, QUICK_MATCH_ART } from '../posters';
import { PlayNowBots } from '../../tour/PlayNowBots';
import { Portrait } from '../../portrait/Portrait';
import { useMyLook } from '../../looks/mine';
import { LastMatchCard, LevelLine, LevelTag } from './Progress';
import { KeepName } from './KeepName';

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

/**
 * A name's length for the nameplate's type size (menus.css: the column's width over --chars), in average
 * letters of the display face, uppercase: W and M run wide, I and 1 narrow (UX audit 31 Oct, C-03: a
 * 16-letter name of Ws and Ms ran under Next orders).
 */
export function nameplateChars(name: string): number {
  let n = 0;
  for (const c of name.toUpperCase()) n += /[WM]/.test(c) ? 1.4 : /[I1.,:;'!|]/.test(c) ? 0.5 : 1;
  return Math.max(4, Math.round(n * 10) / 10);
}

/** Focus on a control (Enter presses it), not the page or the poster (Enter is Play now then). */
function onControl(el: Element | null): boolean {
  return !!el && el !== document.body && el.matches('button, a[href], input, select, textarea, [role="button"], [role="tab"], [role="radio"], [role="switch"], [role="slider"], [contenteditable="true"]');
}

export function Home({ store }: { store: ShellStore }) {
  const ctl = useCtl();
  const profile = useStore(store, (s) => s.profile);
  const offline = !!profile?.offline;
  const chip = useRef<HTMLButtonElement>(null);
  // the player's own soldier is their avatar everywhere (owner rule; audit 2 P-09)
  const look = useMyLook();
  // what Next orders know of this device now (tour/orders.ts)
  const [ordersContext] = useState(() => ({ offline, touch: isTouchDevice(), pad: currentDevice().pad !== null, drillDone: drillDone() }));
  // one thing at a time (audit 31 Oct, D-01): the play-data question, then the Home stops, then Next orders
  const ask = useHomeAsk();
  // the controller's buttons in the prompts while one plays (audit 2, N-09)
  const pad = useInputDevice().kind === 'pad';
  const shown = useShownControls(store);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Enter is Play now when no control has focus: on a focused button it presses that button. After a
      // click on the poster or the page (focus on a non-control), still Play now (audit 2, N-16).
      // Not under an overlay (Join, the QR panels), nor when a box took it (a pasted code's Enter: the box
      // may be gone by now, focus on body)
      if (e.code === 'Enter' && !e.defaultPrevented && !store.getState().overlay && !onControl(document.activeElement)) {
        e.preventDefault();
        ctl.playNow();
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
          {/* L1 / R1 step through it with a controller (audit 2, N-11); Play is where you are: no tab stop, no pad stop (N-03, N-16) */}
          <nav className="tabs home__tabs" aria-label="Main" data-pad-tabs>
            <button type="button" className="tab" aria-current="page" tabIndex={-1} data-pad-skip>
              <Icon name="play" />
              Play
            </button>
            <button type="button" className="tab m-p8" data-tour="locker" onClick={() => (location.hash = '#/locker')}>
              <Icon name="shirt" />
              Locker
            </button>
            <button type="button" className="tab m-p8" onClick={() => (location.hash = '#/armory')}>
              <Icon name="rack" />
              Armory
            </button>
            <button type="button" className="tab m-p8" onClick={() => (location.hash = '#/store')}>
              <Icon name="gem" />
              Store
            </button>
            {/* Options / Menu on Home (gamepad/menus.ts data-pad-start) */}
            <button type="button" className="tab m-p8" data-pad-start onClick={() => ctl.openSettings()}>
              <Icon name="gear" />
              Settings
            </button>
          </nav>
          <span className="menu-top__spacer"></span>
          <InstallButton />
          <FriendsButton />
          <NetPill offline={offline} />
          {/* the name chip opens your account (audit N-21: it looked like a button and did nothing) */}
          <button type="button" ref={chip} className="me-chip m-p8" aria-label={`You: ${name}. Your account`} onClick={() => ctl.openAccount()}>
            <span className="avatar avatar--portrait" aria-hidden="true">
              <Portrait look={look} size={64} name={name} />
            </span>
            <b data-bind="player.name">{name}</b>
            <LevelTag />
          </button>
        </header>

        <div className="menu-body home">
          <div className="home__play">
            <span className="eyebrow m-p3" style={row(0)}>
              Ops briefing · Deathmatch with friends
            </span>
            <article className="poster halftone-ink home__poster mf-qm m-p3" style={row(1)}>
              {/* Quick match's key art: a Street Market fight from the game itself (scripts/map-posters.mjs), shaded where the words sit */}
              <span className="mf-qm__art" aria-hidden="true">
                <PosterImg poster={QUICK_MATCH_ART} sizes="(max-width: 900px) 70vw, 820px" className="mf-qm__img" />
                <span className="mf-qm__shade"></span>
              </span>
              <b className="home__poster-no display" aria-hidden="true">
                01
              </b>
              <span className="serial">Op 01 · Quick match</span>
              <h2 className="display home__poster-title">Play now</h2>
              {/* offline: the one place Home says so (audit 28 Oct: it said it four ways) */}
              <p className={offline ? 'home__poster-sub home__poster-sub--off' : 'home__poster-sub'} role={offline ? 'status' : undefined}>
                {offline ? (profile?.suspended ? SUSPENDED_LINE : OFFLINE_LINE) : 'Bots fill the room and the fight starts at once. Others on Play now may join. Friends join by its code.'}
              </p>
              <div className="home__poster-cta">
                {/* one tap to a fight (mobile audit P1-6); Create room is the friends' way in */}
                {/* a controller lands here first: ✕ / A plays (audit 2, N-03) */}
                <button className="btn btn--ink btn--xl home__create m-p8" type="button" data-tour="play" data-pad-first onClick={() => ctl.playNow()}>
                  <Icon name="play" />
                  Play now
                </button>
                {!pad && <Cap lg>Enter</Cap>}
                <button className="btn btn--paper btn--lg m-p8" type="button" data-tour="create" disabled={offline} onClick={() => ctl.go({ to: 'create' })}>
                  <Icon name="users-plus" />
                  Create room
                </button>
                {/* a local room (lan/): this device hosts, friends on the same Wi-Fi or hotspot join; it works with the internet slow or down */}
                <button className="btn btn--paper btn--lg mf-home__local m-p8" type="button" onClick={() => ctl.go({ to: 'local' })} title="Host on this device: friends on the same Wi-Fi or hotspot join. Works without internet.">
                  <Icon name="wifi" />
                  <span className="btn__stack">
                    Local room
                    <span className="btn__sub">Same Wi-Fi · works offline</span>
                  </span>
                </button>
              </div>
              {/* Play now's bots, in plain sight and the player's to change (audit 2 P-01) */}
              {!offline && <PlayNowBots />}
              <span className="hazard" aria-hidden="true"></span>
            </article>
            <div className="home__row">
              <button type="button" className="ticket rivets home__ticket m-p3" style={row(2)} data-tour="join" onClick={() => ctl.openOverlay('join')}>
                <Icon name="link" className="home__ghost" />
                <span className="label">02 · Got a code?</span>
                <b className="display">Join with code</b>
                <span className="home__ticket-sub">6 letters, or paste the link</span>
              </button>
              <button type="button" className="ticket rivets home__ticket m-p3" style={row(3)} onClick={() => ctl.go({ to: 'training' })}>
                <Icon name="target" className="home__ghost" />
                <span className="label">03 · Solo</span>
                <b className="display">Training</b>
                <span className="home__ticket-sub">Practice against bots</span>
              </button>
            </div>
          </div>

          {/* the player's own soldier (presentation/HomeSoldier.tsx; the helmet until it lands): it gives way first when the nameplate needs the room */}
          <div className="home__stage mf-home__stage">
            <span className="brackets" style={{ inset: '20px 40px 120px 90px' }} aria-hidden="true">
              <i></i>
              <i></i>
              <i></i>
              <i></i>
            </span>
            <HomeSoldier store={store} name={name} className="mf-home__soldier">
              <Icon name="helmet" className="mf-home__helmet" />
            </HomeSoldier>
            <div className="home__nameplate mf-home__nameplate" style={{ '--chars': nameplateChars(name) } as CSSProperties}>
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
              {/* the level, a number and a bar (audit 2 P-04): online matches earn it */}
              {!offline && <LevelLine />}
              {!offline && (
                <button type="button" className="btn btn--ghost btn--sm m-p8" onClick={() => ctl.openOverlay('name')}>
                  <Icon name="edit" />
                  Edit name
                </button>
              )}
            </div>
          </div>

          <aside className="home__side">
            {/* a first visit's generated callsign: keep it or change it (one thing at a time: after the other asks) */}
            {ask === null && <KeepName where="home" />}
            <SquadCard />
            <NextOrders
              context={ordersContext}
              held={ask !== null}
              fallback={
            <>
            {/* the last online match and a personal best to beat (audit 2 P-10) */}
            {!offline && <LastMatchCard style={row(5)} />}
            <section className="card card--print home__news m-p3" style={row(5)}>
              <span className="label label--volt">Field orders</span>
              <ul>
                <li>
                  <Icon name="g-frag" className="ic--fill" />
                  <span>
                    <b>Grenade belt</b> · tap <Kbd code={shown.bindings.grenade[0]} /> to throw, hold it to aim the arc
                  </span>
                </li>
                <li>
                  <Icon name="dash" />
                  <span>
                    <b>Dash</b> · <Kbd code={shown.bindings.dash[0]} /> with a direction, 8 ways
                  </span>
                </li>
                <li>
                  <Icon name="sliders" />
                  <span>
                    <b>Tune the game</b> · the host changes gravity, fuel and more, live
                  </span>
                </li>
              </ul>
              <button type="button" className="btn btn--paper btn--sm btn--block m-p8" onClick={() => ctl.openSettings(pad ? 'controller' : 'controls')}>
                <Icon name={pad ? 'sliders' : 'keyboard'} />
                {pad ? 'All the buttons' : 'All the keys'}
              </button>
            </section>
            </>
              }
            />
            {/* the billboard ads the player saved during play (tap-to-save): only what they chose */}
            <SavedAdsList where="home" />
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
        {/* no "Esc Menu": Escape on Home has no menu to open (audit 2, N-09) */}
        <Hints>
          <Hint keys={<Cap>Enter</Cap>}>Play now</Hint>
          <Hint pad="Pad0">Select</Hint>
          <Hint pad={['Pad4', 'Pad5']}>Locker, Armory, Store</Hint>
          <Hint pad="Pad9">Settings</Hint>
        </Hints>
      </div>
      {/* play stats: the one-time choice (docs/16 §6.2) */}
      <ConsentCard where="home" />
    </Screen>
  );
}
