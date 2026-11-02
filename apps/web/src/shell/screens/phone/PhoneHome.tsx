/**
 * M2 · Phone home (the kit's data-screen="m-home"): the brand, the server's ping and your soldier with your level (tap:
 * your name); the Play-with-friends poster with Create room; Join and Training tickets; your soldier's
 * stage with your name; the bottom nav (Play, Rooms, Locker, Armory, Settings). Same actions as the desktop
 * Home. Motion: the poster's title focus-pulls (P1), the rest rises in a stagger (P3), presses P8.
 * Every player state has one primary action (shell/homeState.ts, UX atlas 1 Nov batch 3): Play now, or
 * Training under 18, offline and for a suspended account. Install app is a 44 px icon chip like Friends,
 * and its toast docks over the bottom nav, never over the poster (UX-14).
 */
import { GAME_NAME } from "@military-forge/shared";
import { useStore } from "zustand";
import { Icon } from "../../../ui/Icon";
import { useCtl, useServerPing } from "../../context";
import type { ShellStore } from "../../store";
import { PhoneScreen, rise } from "./layout";
import { FriendsButton, LobbyButton, PhoneSquad } from "../../../social/SocialLayer";
import { SavedAdsList } from "../../../ads/SavedAds";
import { InstallToast } from "../../../pwa/InstallToast";
import { ConsentCard, useHomeAsk } from "../../../metrics/ConsentCard";
import { useState, type CSSProperties } from "react";
import { NextOrders } from "../../../tour/NextOrders";
import { currentDevice } from "../../../gamepad";
import { drillDone, isTouchDevice } from "../../../touch";
import { InstallButton } from "../../../pwa/InstallButton";
import { HomeSoldier } from "../../../presentation/HomeSoldier";
import { homePrimary, useHomePlan } from "../../useHomePlan";
import { nameplateChars } from "../Home";
import type { HomePlan } from "../../homeState";
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
  const plan = useHomePlan(store);
  const training = plan.primary === "training";
  const name = profile?.nickname ?? "";
  const look = useMyLook();
  useLoadProgress(); // the level on the avatar (audit 2 P-04): one request per Home visit
  // what Next orders know of this device now (tour/orders.ts), as the desktop Home
  const [ordersContext] = useState(() => ({
    offline,
    minor: plan.state === "minor",
    suspended: plan.state === "suspended",
    touch: isTouchDevice(),
    pad: currentDevice().pad !== null,
    drillDone: drillDone(),
  }));

  return (
    <PhoneScreen
      name="m-home"
      label="Home"
      word="PLAY"
      states={offline ? ["offline"] : ["online", plan.state]}
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
          <InstallButton inTopBar icon />
          <LobbyButton phone />
          <FriendsButton phone />
          {plan.tag?.tone === "warn" ? (
            <span className="status status--warn pm-pill" role="status">
              <Icon name={profile?.suspended ? "lock" : "unplug"} size="sm" />
              {plan.tag.text}
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
            className={`poster halftone-ink pm-poster mf-qm m-p3${training ? " pm-poster--training" : ""}`}
            style={rise(1)}
            data-home-poster=""
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
            <span className="serial">{training ? "Op 01 · Training" : "Op 01 · Quick match"}</span>
            <b className="display pm-poster__t m-p1">{training ? "Training" : "Play now"}</b>
            {/* the one primary action (UX-01, UX-15): Play now (a room that bots fill, its countdown at once), or Training */}
            <button
              type="button"
              className="btn btn--ink pm-create pm-play m-p8"
              data-tour="play"
              data-pad-first
              data-home-primary=""
              onClick={() => homePrimary(ctl, plan)}
            >
              <Icon name={training ? "target" : "play"} />
              {training ? "Training" : "Play now"}
            </button>
            {/* online, Play now's bots, in plain sight and the player's to change (audit 2 P-01); else the one line saying why it's Training */}
            {plan.bots ? <PlayNowBots phone /> : <span className="pm-poster__note" role={offline ? "status" : undefined}>{plan.line}</span>}
            {plan.create.show !== "none" && (
              <button
                type="button"
                className="btn btn--ghost btn--sm pm-create-room m-p8"
                data-tour="create"
                disabled={plan.create.show === "off"}
                aria-description={plan.create.show === "off" ? plan.create.why : undefined}
                onClick={() => ctl.go({ to: "create" })}
              >
                <Icon name="users-plus" />
                Create room
              </button>
            )}
            <span className="hazard" aria-hidden="true"></span>
          </article>
          <div className="pm-col">
            {plan.tickets.map((t, i) => (
              <PhoneTicket key={t} kind={t} n={i + 2} plan={plan} />
            ))}
            {/* a local room (lan/): host it here; friends on the same Wi-Fi or hotspot join by code or QR (P0: lit up offline) */}
            {plan.local.show !== "none" && (
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
            )}
            {/* under 18: the one quiet line that says why Home is Training (honest, no "change your answer") */}
            {plan.tag?.tone === "paper" && <p className="pm-state-note m-p3" style={rise(4)}>{plan.tag.text}</p>}
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
                <span className="pm-name display" style={{ "--chars": nameplateChars(name) } as CSSProperties}>{name}</span>
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
          {plan.rooms.show !== "none" && (
            <button
              type="button"
              className="pm-nav__i m-p8"
              disabled={plan.rooms.show === "off"}
              onClick={() => ctl.openOverlay("rooms")}
            >
              <Icon name="globe" />
              <span>Rooms</span>
            </button>
          )}
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
      {/* one ask at a time (tour/homeQueue.ts): play stats (docs/16 §6.2), then a first visit's generated callsign
          (KeepName.tsx), then the install toast (the owner, 23 Oct: Android's prompt, or iPhone's two taps); none while the Home stops run */}
      {ask === "consent" ? <ConsentCard where="phone" /> : ask === null && (nameAsk ? <KeepName where="phone-home" /> : <InstallToast where="home" />)}
    </PhoneScreen>
  );
}

const PHONE_TICKETS = {
  join: { label: "Got a code?", title: "Join" },
  training: { label: "Solo", title: "Training" },
  flight: { label: "Learn the moves", title: "First flight" },
  "live-fire": { label: "First fight", title: "Live fire" },
} as const;

/** One of the column's tickets (what they are is the state's: homeState.ts). */
function PhoneTicket({ kind, n, plan }: { kind: HomePlan["tickets"][number]; n: number; plan: HomePlan }) {
  const ctl = useCtl();
  const t = PHONE_TICKETS[kind];
  const run = () => {
    if (kind === "join") ctl.openOverlay("join");
    else if (kind === "training") ctl.go({ to: "training" });
    else if (kind === "flight") ctl.startFlight();
    else ctl.train("live-fire");
  };
  return (
    <button
      type="button"
      className="ticket rivets pm-tk m-p3 m-p8"
      style={rise(n)}
      disabled={kind === "join" && plan.join.show === "off"}
      {...(kind === "join" ? { "data-tour": "join" } : {})}
      onClick={run}
    >
      <span className="label">
        {String(n).padStart(2, "0")} · {t.label}
      </span>
      <b className="display">{t.title}</b>
    </button>
  );
}
