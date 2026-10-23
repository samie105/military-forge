/**
 * M2 · Phone home (the kit's data-screen="m-home"): the brand, the server's ping and your initial (tap:
 * your name); the Play-with-friends poster with Create room; Join and Training tickets; your soldier's
 * stage with your name; the bottom nav (Play, Locker, Armory, Settings). Same actions as the desktop
 * Home. Motion: the poster's title focus-pulls (P1), the rest rises in a stagger (P3), presses P8.
 */
import { GAME_NAME } from '@military-forge/shared';
import { useStore } from 'zustand';
import { Icon } from '../../../ui/Icon';
import { useCtl, useServerPing } from '../../context';
import type { ShellStore } from '../../store';
import { PhoneScreen, rise } from './layout';
import { initial } from './parts';
import { FriendsButton, PhoneSquad } from '../../../social/SocialLayer';
import { SavedAdsList } from '../../../ads/SavedAds';

export function PhoneHome({ store }: { store: ShellStore }) {
  const ctl = useCtl();
  const profile = useStore(store, (s) => s.profile);
  const ping = useServerPing();
  const offline = !!profile?.offline;
  const name = profile?.nickname ?? '';

  return (
    <PhoneScreen name="m-home" label="Home" word="PLAY" states={[offline ? 'offline' : 'online']}>
      <div className="pm">
        <header className="pm-top m-p3" style={rise(0)}>
          <span className="brand pm-brand">
            <svg className="brand__emblem" aria-hidden="true">
              <use href="#icon-emblem" />
            </svg>
            <b className="display" data-bind="brand.name">
              {GAME_NAME}
            </b>
          </span>
          <span className="menu-top__spacer"></span>
          <FriendsButton phone />
          {offline ? (
            <span className="status status--warn pm-pill">
              <Icon name="unplug" size="sm" />
              Offline
            </span>
          ) : (
            <span className={`net-pill pm-pill${ping < 0 ? ' is-unknown' : ''}`} aria-label={ping >= 0 ? `Server ping ${Math.round(ping)} ms` : 'Server ping not measured yet'}>
              <span className="dot"></span>
              <span className="num">{ping >= 0 ? `${Math.round(ping)} ms` : '– ms'}</span>
            </span>
          )}
          <button type="button" className="avatar pm-av m-p8" aria-label={`You: ${name}. Change your name`} disabled={offline} onClick={() => ctl.openOverlay('name')}>
            {initial(name)}
          </button>
        </header>

        <div className="pm-home">
          <article className="poster halftone-ink pm-poster m-p3" style={rise(1)}>
            <span className="serial">Op 01 · Squad deployment</span>
            <b className="display pm-poster__t m-p1">
              Play with
              <br />
              friends
            </b>
            <button type="button" className="btn btn--ink pm-create m-p8" disabled={offline} onClick={() => ctl.go({ to: 'create' })}>
              <Icon name="users-plus" />
              Create room
            </button>
            {offline && <span className="pm-poster__note">Needs internet · Local room works without it</span>}
            <span className="hazard" aria-hidden="true"></span>
          </article>
          <div className="pm-col">
            <button type="button" className="ticket rivets pm-tk m-p3 m-p8" style={rise(2)} onClick={() => ctl.openOverlay('join')}>
              <span className="label">02 · Got a code?</span>
              <b className="display">Join</b>
            </button>
            <button type="button" className="ticket rivets pm-tk m-p3 m-p8" style={rise(3)} onClick={() => ctl.go({ to: 'training' })}>
              <span className="label">03 · Solo</span>
              <b className="display">Training</b>
            </button>
            {/* a local room (lan/): host it here; friends on the same Wi-Fi or hotspot join by code or QR (P0: lit up offline) */}
            <button type="button" className={`ticket rivets pm-tk pm-tk--local m-p3 m-p8${offline ? ' is-hot' : ''}`} style={rise(3)} onClick={() => ctl.go({ to: 'local' })}>
              <span className="label">
                <Icon name="wifi" size="sm" />
                04 · Same Wi-Fi
              </span>
              <b className="display">Local room</b>
              <span className="pm-tk__sub">Works with no internet</span>
            </button>
          </div>
          <div className="pm-stage m-p3" style={rise(4)} role="img" aria-label={`Your soldier, ${name}`}>
            <span className="brackets" style={{ inset: '6px 8px 26px' }} aria-hidden="true">
              <i></i>
              <i></i>
              <i></i>
              <i></i>
            </span>
            <span className="pm-stage__mark" aria-hidden="true">
              <Icon name="helmet" />
            </span>
            <span className="pm-name display">{name}</span>
          </div>
          {/* friends online (social/), over the top of the stage */}
          <PhoneSquad />
          {/* the billboard ads the player saved during play (tap-to-save), at the stage's foot */}
          <SavedAdsList where="home" variant="dock" />
        </div>

        <nav className="pm-nav m-p3" style={rise(5)} aria-label="Main">
          <button type="button" className="pm-nav__i is-on" aria-current="page">
            <Icon name="play" />
            <span>Play</span>
          </button>
          <button type="button" className="pm-nav__i m-p8" onClick={() => (location.hash = '#/locker')}>
            <Icon name="shirt" />
            <span>Locker</span>
          </button>
          <button type="button" className="pm-nav__i m-p8" onClick={() => location.assign('/armory.html')}>
            <Icon name="rack" />
            <span>Armory</span>
          </button>
          <button type="button" className="pm-nav__i m-p8" onClick={() => ctl.openSettings()}>
            <Icon name="gear" />
            <span>Settings</span>
          </button>
        </nav>
      </div>
    </PhoneScreen>
  );
}
