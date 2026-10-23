# Mobile audit: a first-time player on a phone (23 Oct 2026)

The owner tried the game on his Samsung phone and said: *"on mobile the experience is crappy … the swipe to shoot will always be there, the fire is an extra button … it was too unplayable for me"*. This audit walks the whole game as a stranger on a phone, ranks every problem, and gives each fix and the code area that owns it. The audit itself changes no game code.

- **Build:** main `b6203811`, built with `vite build`. It ran through `pnpm playtest --local --no-build` (the API, the game server and 4 bots).
- **Live:** https://40-123-240-224.sslip.io serves build `75f0d58` (the #252 blink head, the same content as main). I only read the live site: I loaded the title and checked the headers, and created no names or rooms there.

**How:**
- **Browser:** headless Chrome through puppeteer-core, with real touch events (CDP `Input.dispatchTouchEvent`), `pointer: coarse` and `hover: none`.
- **Main profile:** a Samsung Galaxy S23 at 360×780 CSS px, DPR 3, with the Chrome Android user agent `SM-S911B`, held upright and in landscape (780×360).
- **Second player:** joined from the invite link with the Samsung Internet user agent (`SamsungBrowser/26.0`).
- **Other screens:** 844×390, 812×375 and 640×360 (a small Android), plus 780×304 (Chrome's address bar showing).
- **Throttling:** 4× CPU throttle and a 4G profile (85 ms RTT, 9 Mbps down, 1.5 Mbps up) on every page.
- **Screenshots:** `docs/screenshots/mobile-audit/` (1.5× CSS px, JPEG).
- **Driver:** `apps/web/scripts/mobile-audit-driver.mjs`, kept in the audit's worktree only (not committed).

**Limits of the method:**
- Headless Chrome has no real address bar, notch or keyboard. I measured what the page *asks* of the browser (fullscreen, orientation lock, scrolling, overflow, page loads) and simulated the bar by shortening the viewport.
- The frame rates come from SwiftShader (software WebGL). They show where the CPU goes, not a real phone's fps.

---

## The verdict in one paragraph

On a phone, the game puts **too many things between "I opened the link" and "I'm shooting someone"**, and then **too many things on top of the match**:
- **Before the first real match:**
  - 9 screens;
  - 5 separate teaching systems: the fire-mode chooser, First flight's orders, the "How to play" card, the gesture tips and the Home tour;
  - 4 abstract fire modes to choose from before the player has ever fired.
- **In the match:**
  - the soldier often stands **under a thumb** (the camera stops at the map's edge);
  - the **mic button floats in the middle of the left half**, over the "Got it" button of the tips card;
  - tips and modals **cover the top-centre of the screen while bots are already shooting the player**.
- **Two hard bugs the owner hit:** clothes don't change on the creator's preview, and full screen is lost on Armory and back-gesture paths, so the address bar comes back.

The fixes are mostly *removal*: one fire mode, one teaching system, a mic out of the thumb zones, a camera that keeps the soldier clear of the controls, and no full page loads.

---

## Ranked findings

P0 = blocks play or breaks a promise · P1 = a new player gets confused or loses time · P2 = polish.
In the **Owner** column, "phone agent" covers `touch/**`, `shell/screens/phone/**` and `hud/templatePhone.ts`.

### P0: blocks play

| # | Screen | Shot | Problem | Exact fix | Owner |
|---|---|---|---|---|---|
| P0-1 | Creator › Look › Outfit | `08-creator-outfit-does-not-update.jpg` (after `07-creator-hat-updates.jpg`) | **Picking clothes doesn't change the soldier.** "Field Tee" shows **✓ ON**, but the preview still wears Rookie Fatigues and the vest. Headwear does update (Field Cap). The owner's complaint reproduces on main `b6203811`. | Apply outfit/top/bottom/gear slot changes to the preview avatar (the same path headwear uses). Add a test: change each slot and assert the preview's slot mesh id changes. A `ws/creator-clothes-fix` worktree exists; make sure it covers *outfit* and *gear*, not only hats. | creator agent (`creator/**`, `character/**`) |
| P0-2 | In play (First flight and matches) | `13-player-under-aim-dial.jpg`, `12-first-flight-hud.jpg`, `40-hud-780x304-url-bar-shown.jpg` | **Your soldier stands under your thumbs.** `camera.ts` clamps the view to `map.bounds`, so near a map edge the soldier slides to the screen edge. There it sits under the aim dial and swap pill (right) or the move dial (left). On a phone that edge *is* the control zone. Seen in First flight, at a match spawn and at 780×304. | On touch, let the camera overrun the map bounds by the control inset. The inset is `halfW × 0.30` horizontally (the dial and arc column) and `halfH × 0.25` downward. In practice: `tx = clamp(tx, b.minX + halfW − padX, b.maxX − halfW + padX)` with `padX = touchActive ? halfW*0.3 : 0`, and the backdrop drawn past the edge. The soldier then never enters the outer 30 % of either side. | `camera.ts` (phone agent with the render3d owner for the backdrop beyond bounds) |
| P0-3 | Match start (host and guest) | `21-tips-card-mic-over-got-it.jpg`, `22-guest-two-modals-while-killed.jpg` | **Modals during a live match.** At 4:58 on the clock the host gets "How to play" (3 rows and 2 buttons) over the top-centre. The guest from the invite link gets **the 4-mode fire chooser plus "How to play" stacked on top of each other** while the bots play: the kill feed shows "Kestrel → You" before they've closed either. | No blocking card once the clock runs. Teach in the countdown or in First flight only. In a running match, at most one non-blocking line at the screen's top edge (see P1-1). The fire chooser goes away entirely (P0-5). | tour agent (`tour/**`, Tips), phone agent (`touch/overlays.ts`) |
| P0-4 | Lobby, countdown, in play | `16-lobby-mic-over-link.jpg`, `20-countdown-mic.jpg`, `21-tips-card-mic-over-got-it.jpg`, `25-in-play-fire-button-mode.jpg` | **The mic button is unlabelled, sits in the playfield and covers other buttons.** `.vc-mic` is at `left: safe-l + 226px; bottom: safe-b + 66px` (54×54) on every phone screen in a room: <br>• In the lobby it sits on the QR / room-link card. <br>• In play it is 38 px right of the move dial's edge (screen 259–313 × 223–277 at 780×360), where a following left thumb drifts. <br>• On the tips card, `elementFromPoint` at the **Got it** button's centre returns `vc-mic__btn`: the player's tap goes to the mic. A mis-tap opened the mic permission prompt mid-match. | Move push-to-talk to the **top bar, left of ❚❚ pause** (a 44 px pill "🎙 Talk", hold; slide down to lock), out of both thumb zones. Show it only in rooms with another human (not with bots only). Never over a dialog: hide it while any `[role=dialog]` or overlay is up. In the lobby, put it in the roster header as "🎙 Hold to talk". See "Voice" below. | voice owner (`voice/VoiceHud.tsx`, `voice/voice.css`) |
| P0-5 | Before the first shot | `11-fire-chooser.jpg` | **"How do you want to shoot?" with 4 modes (Auto, Pull, Fire button, Release) on first run.** A stranger can't judge them before firing once. This is the root of the owner's "swipe to shoot is always there and the fire is an extra button": Pull fires from the aim stick, Fire-button mode adds FIRE (`25-in-play-fire-button-mode.jpg`), and he can't tell which he's in. | Delete the first-run chooser (`settings.fireChosen` defaults to true). Ship **Auto** as the only default: the right stick aims, it fires itself on a target, and pushing to the rim fires anyway. Keep the other modes in Settings › Touch › Advanced. The Briefing's planned "card 2" fire-mode card should not ship either. | phone agent (`touch/settings.ts`, `touch/overlays.ts`); tour agent (Briefing) |
| P0-6 | Home › Armory (and Armory › Try) | `38-armory-leaves-fullscreen.jpg` | **A full page load drops full screen, so the address bar comes back.** PhoneHome's Armory tab is `location.assign('/armory.html')`. Measured: fullscreen goes `true → false` and the URL is `/armory.html`. Going back reloads the whole app (a cold boot, state lost). The Armory's Try is `location.assign('/?app&try=…')`, another reload. | Host the Armory as a `#/armory` route like the Locker (`locker/route.ts` is the pattern), or open it as an in-app overlay. Never `location.assign` within the game. | phone agent (`PhoneHome.tsx:198`), armory owner (`armory/index.ts:119`, `armory/main.ts`) |
| P0-7 | Any menu after full screen is lost | (code) | **Full screen is asked for only once.** `ui/landscape.ts startLandscape()` arms one `pointerup`, then removes it. After a back gesture, an app switch, the notification shade or the Armory reload, menus stay windowed with the bar showing until the next tap *in play* (`controller.refullscreen`). | On a phone with no standalone display mode, request fullscreen on **every** `pointerup` while `!document.fullscreenElement`. Throttle it to once a second and skip it when `matchMedia('(display-mode: fullscreen), (display-mode: standalone)')` matches. It is cheap and needs a gesture, which a tap is. | phone agent (`ui/landscape.ts`) |
| P0-8 | Every room on a `pnpm playtest` link | `23-tip-card-mic-blocked.jpg` | **The mic can never work on playtest links.** `scripts/playtest/src/proxy.ts:131` sends `Permissions-Policy: … microphone=()`. The console says *"Permissions policy violation: microphone is not allowed"*, and the HUD shows "Mic blocked · listening only" for good. The live box (Caddy) doesn't send it, so live is fine. | Change it to `microphone=(self)` (keep `camera=()` etc.). Add a proxy test so the policy allows the mic. | playtest owner (`scripts/playtest/src/proxy.ts`) |

### P1: confusing or slow

| # | Screen | Shot | Problem | Exact fix | Owner |
|---|---|---|---|---|---|
| P1-1 | In play | `12-first-flight-hud.jpg`, `23-tip-card-mic-blocked.jpg`, `25-in-play-fire-button-mode.jpg` | **Coach cards cover the top-centre of the battlefield.** Orders and TIP cards are about 380×190 px on a 360 px tall screen, more than half the height. They hide enemies and the swap pill ("…mer .44" cut off). | Use a slim one-line strip at the top edge (36 px tall, under the clock), auto-hidden after 4 s. Spotlight rings stay. Never more than one card or strip at a time. | tour agent (`tour/**`) |
| P1-2 | Pause after the match ended | `32-match-over-pause-says-running.jpg` | **The match ended while the host was in pause/settings. Results never showed.** Pause still says "MATCH STILL RUNNING · PAUSED", the clock reads "–" and the lead "KESTREL 20". Resume drops the player into the lobby with no results. | When `match.phase` leaves InProgress, close the pause and settings overlays and show Results (or turn the pause into "Match over · See results"). | phone agent (`PhonePause.tsx`), shell (`shell/controller.ts`) |
| P1-3 | Invite link (`/r/CODE`), brand new player | `18-invite-link-upright.jpg` | **No context: you don't know whose room you're joining.** The name screen says "What do we call you?" with no "WildCobra535 invited you to room YZEJFR · 3 players waiting". | Add a line over the name field: "Joining **{host}**'s room · {n} in the lobby". The API already has the room on the intent. Make Continue read "Join room →". | phone agent (`PhoneNameEntry.tsx`), shell (intent) |
| P1-4 | Name entry | `05-pick-name-jumps-to-creator.jpg` | **"Pick one for me" picks a name and leaves the screen at once.** The player never sees the name they got ("WildCobra535" turned up later in the lobby). | Pick fills the field and plays the "Cleared" stamp; Continue stays the only way forward. | phone agent (`PhoneNameEntry.tsx`) |
| P1-5 | Home, after any match | `30-home-tour-after-match.jpg` | **The Home tour (3 coach marks) fires after the player's first match and blocks taps.** The first tap on Join went to the tour ("Next"), not to Join; after Skip, the next tap on Join was swallowed too (it needed 2 taps). The same "first tap eaten" happened on lobby Start after closing the rules sheet. | Run the Home tour only on a first *idle* Home, never right after a match. Let a tap on the ringed control **do** that control and finish the tour step. Make sure overlays release pointer capture on close. | tour agent (`tour/homeStops.ts`, `ui/spotlight.ts`) |
| P1-6 | Home | `15-home.jpg` | **No one-tap "Play now".** The biggest button is CREATE ROOM, which needs friends. A stranger wants a match *now* (bots fill rooms anyway). "PLAY" in the bottom bar is only the current tab but looks like the main button. | Make the hero button **PLAY NOW** (quick match: create a room with bots and start the countdown at once). Move Create room / Join / Training into the ticket column. Rename the "PLAY" tab "HOME" or drop the bottom bar's active fill. | phone agent (`PhoneHome.tsx`), shell |
| P1-7 | First flight › Dash | `14-dash-order-not-ticking.jpg` | **Dash didn't tick in 2 tries** (a 60 ms and a 150 ms tap on the dash button, once after running left). The player then threw a grenade and lost 37 HP to their own frag while still on "4/5 Dash". *Headless touch: confirm on a device.* | Check that the dash goal ticks from a plain tap with the stick idle (`dashed()` decides at 90 ms). If the soldier faces a wall at the map edge (P0-2), tick on the attempt. | tour agent (`tour/flight.ts`), phone agent (`touch/controller.ts` dash path) |
| P1-8 | Creator (780×360) | `06-creator-look.jpg`, `09-creator-mistap-back.jpg` | Item cards' second row hides under the sticky action bar (Randomise / ← / Save). A tap on a half-hidden card ("Street Hoodie", centre at y 346) hit **← Back to body**. Tile icons are the same generic helmet or shirt for every item, so you can't see what you're picking. "SAVE A…" is cut off on the Body step. The COLOURWAYS tab runs off-screen (x 760–935 on a 780 screen). | Give the scroller `padding-bottom` equal to the action bar's height and `scroll-padding`. Use real item thumbnails (render the slot's mesh once into a sprite). Button label "Save" on phones. Make the tabs scroll horizontally with a fade, or use icon-only tabs. | creator agent (`creator/creator.css`, `creator/**`) |
| P1-9 | Lobby rules sheet | `33-rules-sheet-cut-off.jpg` | The sheet's top (map choice, title, close) sits **above the screen** (map options at y −30). There is no visible close; you tap outside, and that tap is swallowed. | `max-height: calc(100dvh - safe insets)`; scroll inside; add a header with "Match rules" and ✕ (44 px). | phone agent (`PhoneLobby.tsx`, `phone.css`) |
| P1-10 | In play (all sizes) | `40-hud-780x304-url-bar-shown.jpg`, `43-hud-640x360.jpg` | **Overlaps:** <br>• At 780×304 (bar showing): zoom (641–701, 9–69) overlaps ❚❚ pause (688–736), and the minimap sits on the 🏆 scores button. <br>• At 640×360: the swap pill (343–552 × 105–169) overlaps zoom (501–560 × 66–125) and covers the "Respawn in 1 s" card. <br>• Everywhere: the kill feed is drawn over the 🏆 button, and HP/fuel labels sit on the move dial's rim. <br>• The pickup banner ("RIOT SHIELD … walk over to take", "HAWK .50 … then tap Take") covers the grenade button and its count. | Place by the safe box's *real* size with collision checks at runtime (not only in the 812×375 test). Drop zoom from the HUD (pinch already zooms). Put the kill feed under the clock, centred. Move pickup banners to the top centre. Add a test that places the layout at 640×360, 780×304 and 915×412 with no overlaps. | phone agent (`touch/layout.ts`, `hud/templatePhone.ts`, `hud/phone.css`) |
| P1-11 | In play | `24-in-play-auto.jpg` | **Too many things on screen at once:** <br>• 2 dials (163 px each), dash, grenade, a 209×64 swap pill, zoom/context, ❚❚, 🏆; <br>• plus the minimap, the mic, the "Mic blocked" toast, the kill feed, the clock, the HP and fuel labels, the AUTO tag, ammo, and coach rings. | See the proposed default layout below: 6 controls at rest. | phone agent |
| P1-12 | Results | `34-results.jpg` | The biggest button is **Share the result** (after a loss with 0 kills). The obvious next action, *play again*, is a small "VOTE 0/2". "✓ 0 kills" carries a success tick. Results leave for the lobby on their own after about 25 s. | Primary **Play again** (volt, full width); Share is secondary. No tick on a zero stat. Keep results until the player taps, or show a visible countdown ring on Lobby. | phone agent (`PhoneResults.tsx`), tour agent (DebriefLines) |
| P1-13 | Pause | `26-pause-toast-over-resume.jpg` | The "Mic blocked · listening only" toast sits **over RESUME** (and over the lobby and results). It never goes away. The mic button then disappears, with no "Try again" outside Settings › Audio. LEAVE spills past the card's edge. | Show the toast once for 3 s, then a small 🎙̸ icon in the top bar that opens the permission retry. Keep it in the `.vc-strip` area, not at a fixed `top`. Fix the LEAVE width. | voice owner, phone agent |
| P1-14 | Every phone, upright | `04-upright-turn-tip.jpg`, `19-invite-lobby-upright.jpg`, `44-hud-upright-turned.jpg` | Held upright (how everyone opens a link), the page plays turned 90°. That works, but on Samsung Internet or iOS Safari the bottom toolbar then runs along the game's **right edge, under the aim thumb**, and the name keyboard opens along the glass. Android Chrome fixes this on the first tap (fullscreen plus `orientation.lock('landscape')`, measured on the title tap), but only if the first tap happens on a phone-shape page. | Keep the owner's "always landscape". When the lock fails, size the turned box from `visualViewport` (not `innerWidth/innerHeight`) and add the bar's inset to the right safe edge. Show the "turn your phone" card on the *title* (first screen) as well, not only on the name screen. | phone agent (`ui/landscape.ts`, `public/boot.js`) |
| P1-15 | Lobby | `16-lobby-mic-over-link.jpg`, `17-invite-drawer.jpg` | Two ways to invite on one card: **Share room link** and **Invite friends ›**, and the second opens Copy / Share / WhatsApp again. Host sees READY, START and WARM UP (3 different "go" actions). Guests see "WAIT" chips that read like an instruction. | One **Invite** button (`navigator.share`, else a sheet with Copy / WhatsApp / friends). Host: START only (Ready is implied). Warm up becomes a small link. The roster chips say "Not ready" / "Ready". | phone agent (`PhoneLobby.tsx`), social (`sx-invblock`) |
| P1-16 | Title | `03-title.jpg` | "ABOUT THE GAME" sits on top of "TAP ANYWHERE TO CONTINUE" (the first word is hidden). The ping chip says "**This computer** · 807 ms" on a phone (807 ms measured while the page was still loading). | Move About up to the top-left corner (44 px). Word the chip "This device" or "Server". Don't show a ping until 3 samples after load. | web-quality / title (`shell/screens/Title.tsx`, `title.css`) |
| P1-17 | Load | `39-live-title.jpg` | Live, 4G plus 4× CPU: load 14.6 s, LCP 11.1 s, 99 requests, 4.8 MB. Locally there was a first long task of 2.4–2.9 s, and the title ran 100–190 ms tasks back to back for 2.5 s (under 10 fps on a low-end phone). | Defer the 3D title backdrop on `mf-lowend` (static key art). Split the main chunk (vite warns about >500 kB chunks). Preload only the title's critical CSS and fonts. | web-quality agent, render3d (title backdrop) |

### P2: polish

| # | Screen | Shot | Problem | Fix | Owner |
|---|---|---|---|---|---|
| P2-1 | HUD | `24-in-play-auto.jpg` | Map name "Movement Test" in the minimap at 6.8–8.8 px; the countdown tip line at about 8 px; the "AUTO" tag at 10.7 px. | 12 px minimum on phones; drop the map name from the minimap. | phone agent, minimap owner |
| P2-2 | Friends | `37-friends.jpg` | Friends / Requests / Blocked tabs are 38 px tall. | 44 px. | social agent |
| P2-3 | Local room loading | `35-local-room-loading.jpg` | CANCEL is 88×26. | 44 px tall. | phone agent (`PhoneLan.tsx`) |
| P2-4 | Join with code | `31-join-code.jpg` | "SCAN HOST'S QR" is cut off at the right. | Shorter label ("Scan QR") or wrap. | phone agent (`PhoneJoin.tsx`) |
| P2-5 | Pause | `26-pause-toast-over-resume.jpg` | The Button fade slider is 27 px tall. | Track hit area 44 px. | phone agent (`ButtonFade.tsx`) |
| P2-6 | Briefing | `10-briefing.jpg` | "Save and play" leads to a question, not play; "I know shooters" and "Skip all training" do the same thing. | Creator button reads "Save"; drop "Skip all training". | creator agent, tour agent |
| P2-7 | Settings | `27-settings-opens-graphics.jpg`, `28-settings-touch.jpg` | Opens on Graphics, not Touch. Touch has 17 switches at the same level. | Open on Touch on phones. Top level: Layout preset, Button fade, Aim assist, Left-handed, Vibrate. The rest go under "Advanced". | phone agent (`PhoneSettings.tsx`) |
| P2-8 | Menus | (code) | Menus have `touch-action: auto` and `overscroll-behavior: auto` on `html/body`. Only play sets `none` (`touch.css`). Chrome Android's pull-to-refresh can reload the game from a menu, and double-tap can zoom. | `html, body { overscroll-behavior: none; touch-action: manipulation; }` always; `none` in play stays. | web-quality agent (`index.html` inline style) |
| P2-9 | Home | `15-home.jpg` | The right column shows a placeholder helmet and "WILDCOB…" (truncated) instead of the player's own soldier. | Show the soldier's portrait (the avatar card the owner asked for); wrap or scale the name. | phone agent (`PhoneHome.tsx`) |

---

## Address bar and full screen: what the page does today, and the exact fix

**Measured:**

| Check | Result |
|---|---|
| `html, body` | `height: 100%; overflow: hidden`. The document is never taller than the window (`scrollHeight` = `innerHeight` on every screen). There are 0 scroll events in the whole walkthrough. **Scrolling does not bring the bar back.** |
| `100vh` / `dvh` | No layout uses `100vh` (only fallbacks in the turned-body rule). The turned box uses `innerWidth/innerHeight`, which *changes* when the bar shows. `dvh` and `svh` are not used. |
| First tap | The title tap calls `requestFullscreen({ navigationUI: 'hide' })` then `screen.orientation.lock('landscape')` (`ui/landscape.ts`). In Chrome emulation full screen stayed on across every SPA route. ✓ |
| What drops full screen | <br>• `location.assign('/armory.html')` (Home › Armory) and `location.assign('/?app&try=…')` (Armory › Try): full page loads (P0-6); <br>• the Android back gesture or edge swipe: in play this pauses and re-asks on the next tap in play, but in menus nothing re-asks (P0-7); <br>• the Connection screen's Reload. |
| iPhone Safari | No element fullscreen on iPhone. With `overflow: hidden` Safari never collapses its bars. **Only a home-screen install removes them.** |
| Manifest | `display: fullscreen`, `display_override: [fullscreen, standalone]`, `orientation: landscape`, 192/512 and maskable icons, `id: /`. ✓ |
| Installability | **No service worker** (none in `src/` or `public/`), **no `beforeinstallprompt` handler**, no install UI. |
| iOS meta | `apple-mobile-web-app-capable` ✓, `apple-mobile-web-app-title` ✓, `apple-touch-icon` ✓. **Missing:** `apple-mobile-web-app-status-bar-style` (use `black-translucent`) and the standard `mobile-web-app-capable`. |
| Viewport meta | `width=device-width, initial-scale=1, viewport-fit=cover` ✓ (zoom is locked only in a game; that's good for accessibility). |

**Fix list, in order** (the phone agent is building the install toast; these are the numbers and rules to build to):
1. **No full page loads in the app** (P0-6). The Armory becomes a route.
2. **Re-ask full screen on any tap while it's off** (P0-7), on phones, outside standalone.
3. **`overscroll-behavior: none; touch-action: manipulation`** on `html, body` always (P2-8). This stops pull-to-refresh and double-tap zoom in menus.
4. **Size the turned box from `visualViewport`** and listen to `visualViewport.resize`, so the bar's appearance doesn't push controls under it. Use `height: 100dvh` as the CSS fallback where `innerHeight` is read.
5. **Install as the real answer on every browser:**
   - **Android (Chrome, Samsung Internet):** add a minimal service worker (`/sw.js`: cache the shell, network-first for `/api` and `/ws`, registered after the first match so it never slows the first load). Catch `beforeinstallprompt`, `preventDefault()` it, and show the **designed toast after the first match's Results**: "Play full screen: add Military Forge to your home screen" with [Install] [Not now]. Snooze it 7 days after "Not now"; never show it during a match.
   - **iOS:** a sheet with the Share icon and "Add to Home Screen", shown once after the first match on Safari when not `navigator.standalone`.
   - **Launched installed:** `display: fullscreen` plus `orientation: landscape` already gives a bar-free landscape game.
6. Add `<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">` and `<meta name="mobile-web-app-capable" content="yes">`.
7. **When the install toast lands, audit it:** it must not cover the top bar or the dials, it needs one primary button (≥ 48 px), and it must never show twice in a session.

---

## The in-game layout today (780×360, Galaxy S23 landscape, Auto fire)

| Control | Where (CSS px) | Size | Does |
|---|---|---|---|
| Move dial | left, 58–221 × 167–330 | 163 | Run; push up to jet, down to crouch; flick to dash |
| Aim dial ("AUTO", ammo 6/6) | right, 558–721 × 167–330 | 163 | Aims; fires itself on a target; the rim fires |
| Dash | 489–561 × 166–238 | 72 | Dash (tap, or swipe a direction) |
| Grenade (count badge) | 453–525 × 251–323 | 72 | Tap: throw; swipe: change type; hold and drag: aim the arc |
| Swap pill ("Hammer .44 · 🔋 · rifle") | 483–692 × 105–169 | 209×64 | Swap; hold for a radial with melee |
| Context slot (zoom here) | 641–701 × 65–125 | 60 | One of take / melee / shield / reload / zoom |
| ❚❚ Menu | 688–736 × 10–58 | 48 | Pause |
| 🏆 Scores | 44–92 × 10–58 | 48 | Hold for the scoreboard |
| Minimap | 50–142 × 136–180 | 92×44 | Opens the big map |
| 🎙 Mic | 259–313 × 223–277 | 54 | Hold to talk (rooms only) |
| HP / fuel labels | on the move dial's top rim | — | Read-outs |
| Kill feed | top left, over 🏆 | — | Read-out |
| Clock and score | top centre | — | Read-out |
| Coach card / tip | top centre, about 380×190 | — | Teaching (P1-1) |
| Fire-button mode | FIRE 84 px replaces the aim dial's look; a drag on it aims | — | Only when chosen (P0-5) |

**Against the best mobile shooters:** they show **one stick each side, one fire answer and three or four action buttons**, with everything else hidden until it's needed. Here a new player sees 9 controls plus 5 read-outs plus a coach card, and the same "fire" is reachable three ways depending on a mode they picked blind.

## Proposed ONE default layout (Classic, the only preset a new player sees)

```
 812×375 (scales by the safe box; mirrored when left-handed)
┌──────────────────────────────────────────────────────────────────────────────┐
│ 🏆(44)  kill feed ·· 4:12  YOU 3 | KESTREL 5 ··        🎙 Talk(44)  ❚❚(44)    │ ← top bar: read-outs centre,
│ minimap(when map>1 screen)                                                    │   system buttons in corners
│                                                                              │
│                        [the soldier is kept in the centre band:              │
│                         the camera never pushes him under a thumb]           │
│                                                                              │
│ ♥100 ▮▮▮▮▮ fuel                                         ⇄ gun pill (48 tall) │
│    ╭──────────╮                                   ⇢ DASH(64)                  │
│   │   MOVE    │                              💣 NADE(64)    ╭──────────╮       │
│   │ (dynamic, │                                           │   AIM    │       │
│   │ push up = │                                 [context] │ fires by │       │
│   │   jet)    │                                  (64, only │  itself  │       │
│    ╰──────────╯                                  when needed)╰──────────╯ 6/30│
└──────────────────────────────────────────────────────────────────────────────┘
```

**Shown at rest (6):**
- **Move stick (left):** dynamic origin anywhere in the left 40 %; push up to jet, down to crouch.
- **Aim stick (right):** aims; **Auto fire** fires by itself on a target in sight; the rim fires anyway.
- **DASH:** 64 px, on the arc above the aim stick.
- **GRENADE:** 64 px, inside the arc. Tap throws; hold and drag aims the arc.
- **Gun pill:** 48 px tall, top right of the arc. Tap swaps; hold opens the radial with melee.
- **❚❚ pause:** top-right corner.

**Shown only when relevant:** the context slot (Take near a gun, Reload at ≤ 40 %, Shield when carried, Melee near an enemy), 🎙 Talk (a room with another human), the minimap (maps wider than about 2 screens).

**Hidden behind Settings › Touch › Advanced:**
- the Pull, Fire button and Release fire modes; Extra finger fires;
- the Claw and One-thumb presets;
- swipe gestures on buttons; Flick to dash;
- precision weapons fire on release; Keep aiming after a button;
- zoom on the HUD (pinch does it);
- the next-grenade button.

**Rules:** no control or read-out over another (runtime check, not just the 812×375 test); targets ≥ 48 px (64 for actions); nothing at all in the centre band; one coach strip at most.

## Voice and the mic

- **Today:** a 54 px unlabelled 🎙 circle at the left third of the screen, in the lobby, the countdown and play (P0-4). Its settings are in Settings › Audio › Voice chat ("How you talk: Hold mic / Open mic"). Pause has a COMMS card for muting others but no "my mic". On a playtest link the mic is blocked by the proxy's Permissions-Policy (P0-8).
- **Where players expect it:** top of the screen, beside the menu (party-chat icons sit in the top bar), with a label the first time, and never in a thumb zone.
- **Recommendation:**
  - In play: a **"🎙 Talk" pill 44 px tall, top bar, immediately left of ❚❚**. Hold to talk; slide down to lock it on; a tap while locked turns it off.
  - The first time a room has another human, a one-line hint: "Hold 🎙 Talk to speak".
  - The lobby: the same pill in the roster header.
  - Pause: a "My mic: Hold to talk · Open · Off" row in COMMS.
  - Mic blocked: the pill shows 🎙̸, and a tap opens the permission retry.

## Human UI parity (screen by screen)

| Expectation | Here | Mismatch? |
|---|---|---|
| Android back = "go back one level" | In play, back opens pause (good, via CloseWatcher). In menus, back exits full screen and leaves the page on some routes; the Armory's back reloads the app | **Yes** (P0-6/7) |
| Pause top right | ❚❚ top right | ✓ |
| Leave a match: pause › Leave › confirm | "Leave" › "Leave this match?" › "Leave match" | ✓ |
| Leave a lobby as host warns others | ← leaves at once, no confirm, while a friend is inside | P2: confirm when another human is present |
| Settings from Home and from pause | Both ✓; opens on Graphics, not Touch | P2-7 |
| One obvious "Play" on the main menu | Create room is the hero; no quick match | **Yes** (P1-6) |
| A tutorial that you play, once | First flight is good, but 4 more teaching systems repeat it in matches | **Yes** (P0-3, P1-1, P1-5) |
| Voice beside the menu, labelled | Unlabelled circle in the playfield | **Yes** (P0-4) |
| Results › Play again is the big button | Share is big, Play again is a vote chip | **Yes** (P1-12) |
| Invite link says who invited you | No | **Yes** (P1-3) |
| Character preview reflects every choice | Hats yes, clothes no | **Yes** (P0-1) |
| Full screen stays full screen | Lost on Armory and after back | **Yes** (P0-6/7) |

## Zoom: how much world a phone shows (owner: "the zoom is too close")

From `camera.ts`:
- `viewWidth = 36 m × zoomMultiplier × viewScale`, and `ppm = screenWidth / viewWidth`;
- the visible height is `min(screenH / ppm, 0.75 × viewWidth)`;
- phones use `TouchSettings.view = 0.62` by default;
- a standing soldier is 1.5 m (`content/tuning.ts`).

The screenshots confirm the numbers: the soldier is about 52–55 CSS px tall in `24-in-play-auto.jpg`.

| Screen | view | Across | Up | px / m | Soldier (px) | Soldier on the glass |
|---|---|---|---|---|---|---|
| Laptop 1280×720 | 1.0 | **36.0 m** | **20.3 m** | 35.6 | 53 px (7.4 % of height) | ≈ 12 mm on a 13″ |
| Galaxy S23 780×360 (today) | 0.62 | **22.3 m** | **10.3 m** | 34.9 | 52 px (14.5 %) | ≈ 9.8 mm |
| Galaxy A-series 915×412 (today) | 0.62 | 22.3 m | 10.0 m | 41.0 | 62 px | ≈ 10 mm |
| S23 at view **0.80** | 0.80 | 28.8 m | 13.3 m | 27.1 | 41 px (11 %) | ≈ 7.6 mm |
| S23 at view 1.0 | 1.0 | 36.0 m | 16.6 m | 21.7 | 33 px | ≈ 6.1 mm |

- **Today:** a phone sees **62 % of the laptop's width and 51 % of its height, about a third of the area.** The dials cover a further third of that (the bottom 60 % of both outer quarters).
- **Recommendation:**
  - default `view = 0.80` (28.8 m across, 13.3 m up, soldier about 41 px or 7.5 mm);
  - pinch range 0.70–1.0;
  - never below 0.70 by default on any phone.
- **On large phones:** pick the view so the soldier is about 7.5 mm tall on the glass. The soldier's height in mm is `1.5 × screenWidthMm / (36 × view)`, so `view = clamp(screenWidthMm / 180, 0.70, 1.0)`. That is 0.81 on a 6.1″ S23 (about 146 mm across in landscape) and 0.86 on a 6.6″ A-series (about 155 mm). The browser doesn't report mm, so estimate it from `screen.width` and the DPR, or just use 0.80 below 6.4″ and 0.85 above.
- **Pair it with P0-2:** the camera must keep the soldier out of the control columns, or a wider view just shows more of the map edge.

## Network feel (from the client's side)

- **Local server, 4G profile (85 ms RTT), about 25 minutes, 2 players and bots:**
  - no reconnect overlay, freeze or "returning" screen appeared in the lobby, the countdown, two matches, results or the join by code mid-room;
  - the Home chip read 90–95 ms throughout;
  - the title's chip read "This computer · 807 ms" during load (a CPU-starved sample, P1-16).
- **Live:** not played (read-only), so the owner's "keeps returning and returning" was **not reproduced here**. It needs the real phone network; the net agent has it.

## The first 2 minutes, the way they SHOULD go

1. **0 s:** Open the link held upright. One full-screen card reads upright: the key art, "Turn your phone sideways", with a rotating phone animation. The first tap anywhere goes full screen and locks landscape (Android); on iOS the page turns itself.
2. **5 s:** **Title** in landscape: "Tap to play" (About sits in a corner, not over the prompt). Sound starts with the tap.
3. **8 s:** **Name:** the field is focused only after a tap; "Pick one for me" fills the field and stamps Cleared. One button: **Continue** (or, from an invite: "Join WildCobra's room →").
4. **15 s:** **Soldier:** body and look in one screen, a preview that changes with *every* tap (clothes included), big **Save**. "Skip" is fine: a default soldier.
5. **25 s:** **First flight** (no question first, no fire-mode menu): Auto fire is on. Five orders in a slim top strip: Run → Fly → Fire (it fires itself) → Dash → Throw, with the ring on the control to use. The soldier is centred and never under a thumb.
6. **75 s:** "Nice. Ready for a real match?" One button: **Play now** (a room with Easy bots starts its countdown at once). "Home" is a small link.
7. **80 s:** **Countdown 5 s** with the VS strip. *This* is the only place a single tip shows ("Push to the rim to fire anytime").
8. **85 s:** **Match:** 6 controls, nothing over the centre, no cards. A kill gets a hit marker and a short buzz.
9. **~4 min:** **Results:** big **Play again**, then the Install toast once ("Play full screen: add to your home screen"), Share as secondary.
10. **Home:** Play now is the hero. Invite / Join with code / Training are tickets. The Home tour shows only if the player lingers 5 s on a first idle Home, and a tap on a ringed control just does that control.
