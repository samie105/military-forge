/**
 * M2 · Phone home (the kit's data-screen="m-home"): the brand, the server's ping and your soldier with your level (tap:
 * your name); the Play-with-friends poster with Create room; Join and Training tickets; your soldier's
 * stage with your name; the bottom nav (Play, Rooms, Locker, Armory, Settings). Same actions as the desktop
 * Home. Motion: the poster's title focus-pulls (P1), the rest rises in a stagger (P3), presses P8.
 */
import { GAME_NAME } from "@military-forge/shared";
import { useStore } from "zustand";
import { Icon } from "../../../ui/Icon";
import { useCtl, useServerPing } from "../../context";
import type { ShellStore } from "../../store";
import { PhoneScreen, rise } from "./layout";
import { FriendsButton, PhoneSquad } from "../../../social/SocialLayer";
import { SavedAdsList } from "../../../ads/SavedAds";
import { InstallToast } from "../../../pwa/InstallToast";
import { ConsentCard, useHomeAsk } from "../../../metrics/ConsentCard";
import { useState } from "react";
import { NextOrders } from "../../../tour/NextOrders";
import { currentDevice } from "../../../gamepad";
import { drillDone, isTouchDevice } from "../../../touch";
import { InstallButton } from "../../../pwa/InstallButton";
import { HomeSoldier } from "../../../presentation/HomeSoldier";
import { OFFLINE_LINE, SUSPENDED_LINE } from "../frame";
import { PosterImg, QUICK_MATCH_ART } from "../../posters";
import { PlayNowBots } from "../../../tour/PlayNowBots";
import { Portrait } from "../../../portrait/Portrait";
import { useMyLook } from "../../../looks/mine";
import { LevelTag, useLoadProgress } from "../Progress";
import { KeepName } from "../KeepName";

export function PhoneHome({ store }: { store: ShellStore }) {
  const ctl = useCtl();
  // one thing at a time (audit 31 Oct, D-01): the play-data question, then the Home stops, then Next orders
  const ask = useHomeAsk();
  const profile = useStore(store, (s) => s.profile);
  const nameAsk = useStore(store, (s) => s.nameAsk === true && !!s.profile && !s.profile.offline);
  const ping = useServerPing();
  const offline = !!profile?.offline;
  const name = profile?.nickname ?? "";
  const look = useMyLook();
  useLoadProgress(); // the level on the avatar (audit 2 P-04): one request per Home visit
  // what Next orders know of this device now (tour/orders.ts), as the desktop Home
  const [ordersContext] = useState(() => ({
    offline,
    touch: isTouchDevice(),
    pad: currentDevice().pad !== null,
    drillDone: drillDone(),
  }));

  return (
    <PhoneScreen
      name="m-home"
      label="Home"
      word="PLAY"
      states={[offline ? "offline" : "online"]}
    >
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
          <InstallButton inTopBar />
          <FriendsButton phone />
          {offline ? (
            <span className="status status--warn pm-pill">
              <Icon name="unplug" size="sm" />
              Offline
            </span>
          ) : (
            <span
              className={`net-pill pm-pill${ping < 0 ? " is-unknown" : ""}`}
              aria-label={
                ping >= 0
                  ? `Server ping ${Math.round(ping)} ms`
                  : "Server ping not measured yet"
              }
            >
              <span className="dot"></span>
              <span className="num">
                {ping >= 0 ? `${Math.round(ping)} ms` : "– ms"}
              </span>
            </span>
          )}
          <button
            type="button"
            className="avatar avatar--portrait pm-av m-p8"
            aria-label={`You: ${name}. Change your name`}
            disabled={offline}
            onClick={() => ctl.openOverlay("name")}
          >
            {/* the player's own soldier (owner rule; audit 2 P-09) and level (P-04) */}
            <span className="pm-av__face">
              <Portrait look={look} size={64} name={name} />
            </span>
            {!offline && <LevelTag />}
          </button>
        </header>

        <div className="pm-home">
          <article
            className="poster halftone-ink pm-poster mf-qm m-p3"
            style={rise(1)}
          >
            {/* Quick match's key art (posters.tsx), shaded where the words sit */}
            <span className="mf-qm__art" aria-hidden="true">
              <PosterImg
                poster={QUICK_MATCH_ART}
                sizes="60vw"
                className="mf-qm__img"
              />
              <span className="mf-qm__shade"></span>
            </span>
            <span className="serial">Op 01 · Quick match</span>
            <b className="display pm-poster__t m-p1">Play now</b>
            {/* one tap to a fight (mobile audit P1-6): a room that bots fill, its countdown at once; offline: training */}
            <button
              type="button"
              className="btn btn--ink pm-create pm-play m-p8"
              data-tour="play"
              data-pad-first
              onClick={() => ctl.playNow()}
            >
              <Icon name="play" />
              Play now
            </button>
            {/* offline, the line says so; online, Play now's bots, in plain sight and the player's to change (audit 2 P-01) */}
            {offline ? <span className="pm-poster__note">{profile?.suspended ? SUSPENDED_LINE : OFFLINE_LINE}</span> : <PlayNowBots phone />}
            <button
              type="button"
              className="btn btn--ghost btn--sm pm-create-room m-p8"
              data-tour="create"
              disabled={offline}
              onClick={() => ctl.go({ to: "create" })}
            >
              <Icon name="users-plus" />
              Create room
            </button>
            <span className="hazard" aria-hidden="true"></span>
          </article>
          <div className="pm-col">
            <button
              type="button"
              className="ticket rivets pm-tk m-p3 m-p8"
              style={rise(2)}
              data-tour="join"
              onClick={() => ctl.openOverlay("join")}
            >
              <span className="label">02 · Got a code?</span>
              <b className="display">Join</b>
            </button>
            <button
              type="button"
              className="ticket rivets pm-tk m-p3 m-p8"
              style={rise(3)}
              onClick={() => ctl.go({ to: "training" })}
            >
              <span className="label">03 · Solo</span>
              <b className="display">Training</b>
            </button>
            {/* a local room (lan/): host it here; friends on the same Wi-Fi or hotspot join by code or QR (P0: lit up offline) */}
            <button
              type="button"
              className={`ticket rivets pm-tk pm-tk--local m-p3 m-p8${offline ? " is-hot" : ""}`}
              style={rise(3)}
              onClick={() => ctl.go({ to: "local" })}
            >
              <span className="label">
                <Icon name="wifi" size="sm" />
                04 · Same Wi-Fi
              </span>
              <b className="display">Local room</b>
              <span className="pm-tk__sub">Works with no internet</span>
            </button>
          </div>
          {/* Next orders (the onboarding's cards) take the soldier's column while there's one to show */}
          <NextOrders
            context={ordersContext}
            held={ask !== null}
            fallback={
              <div
                className="pm-stage m-p3"
                style={rise(4)}
                role="img"
                aria-label={`Your soldier, ${name}`}
              >
                <span
                  className="brackets"
                  style={{ inset: "6px 8px 26px" }}
                  aria-hidden="true"
                >
                  <i></i>
                  <i></i>
                  <i></i>
                  <i></i>
                </span>
                {/* the player's own soldier (presentation/HomeSoldier.tsx), the helmet until it lands */}
                <HomeSoldier store={store} name={name} className="pm-stage__mark" decorative>
                  <Icon name="helmet" />
                </HomeSoldier>
                <span className="pm-name display">{name}</span>
              </div>
            }
          />
          {/* friends online (social/), over the top of the stage */}
          <PhoneSquad />
          {/* the billboard ads the player saved during play (tap-to-save), at the stage's foot */}
          <SavedAdsList where="home" variant="dock" />
        </div>

        {/* a controller: L1 / R1 step through it, it starts on Play now, not here (audit 2, N-03 / N-11) */}
        <nav className="pm-nav m-p3" style={rise(5)} aria-label="Main" data-pad-tabs>
          <button type="button" className="pm-nav__i is-on" aria-current="page" tabIndex={-1} data-pad-skip>
            <Icon name="play" />
            <span>Home</span>
          </button>
          {/* the open rooms and who's on (rooms/) */}
          <button
            type="button"
            className="pm-nav__i m-p8"
            disabled={offline}
            onClick={() => ctl.openOverlay("rooms")}
          >
            <Icon name="globe" />
            <span>Rooms</span>
          </button>
          <button
            type="button"
            className="pm-nav__i m-p8"
            data-tour="locker"
            onClick={() => (location.hash = "#/locker")}
          >
            <Icon name="shirt" />
            <span>Locker</span>
          </button>
          <button
            type="button"
            className="pm-nav__i m-p8"
            onClick={() => (location.hash = "#/armory")}
          >
            <Icon name="rack" />
            <span>Armory</span>
          </button>
          <button
            type="button"
            className="pm-nav__i m-p8"
            onClick={() => (location.hash = "#/store")}
          >
            <Icon name="gem" />
            <span>Store</span>
          </button>
          <button
            type="button"
            className="pm-nav__i m-p8"
            data-pad-start
            onClick={() => ctl.openSettings()}
          >
            <Icon name="gear" />
            <span>Settings</span>
          </button>
        </nav>
      </div>
      {/* install the game, play full screen (the owner, 23 Oct): Android's prompt, or iPhone's two taps */}
      {/* play stats: the one-time choice (docs/16 §6.2); the install toast waits while it or the Home stops are up */}
      {/* a first visit's generated callsign: keep it or change it (KeepName.tsx), before the install toast */}
      {ask === "consent" ? <ConsentCard where="phone" /> : ask === null && (nameAsk ? <KeepName where="phone-home" /> : <InstallToast where="home" />)}
    </PhoneScreen>
  );
}
