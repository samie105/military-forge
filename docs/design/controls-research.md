# Controls research: phones and controllers

**Owner, 22 Oct 2026:** "The mobile controls are terrible, people on mobile can't play the game, we need to engineer a better experience … do in-depth research, proper research on the web, to make every gamer's experience awesome. And the controllers don't have the best experience when moving around, and that's terrible."

This doc has four parts:

- **What's wrong today:** measured on `origin/main` at `2ed28942`, 23 Oct 2026.
- **What the research says:** cited.
- **A spec for phones and a spec for controllers:** the phone and input agents build from these.
- **The order to build it in.**

It extends [touch-controls-v3.md](touch-controls-v3.md), which covers gestures, the drill and the camera. It doesn't replace it.

The body names no other game. Where a source is about a particular game, the text describes the pattern, and the source list gives the title as published.

**Units.** "px" means CSS px. Phones run at about 6 CSS px per mm:

| Phone | CSS px per inch | px per mm |
|---|---|---|
| iPhone (460 ppi at 3×) | 153 | 6.0 |
| Pixel 7 class | 158 | 6.2 |

Thumbs don't grow with screens, so the spec gives sizes and distances in **mm** and converts at **6 px/mm**.

---

## 0. Summary

**Why phones are hard to play today:**

- **Thumbs near an edge do the wrong thing.** The floating dials can't follow a thumb into the edge band, so the thumb lands already "pushed".
  - On the left: an instant run to the left, or a crouch.
  - On the right: an instant shot that also turns the soldier to face right.
- **One thumb has three jobs.** The right thumb aims, fires and works nine buttons. Every button press stops the gun. Coming back, the gun doesn't fire again until the thumb has dragged 39 px.
- **Firing is tied to aiming.** Firing starts only 6.5 mm out from where the thumb lands. Any aim correction past that point fires. Auto-fire is off, and there's no fire button.
- **The buttons are small and tightly packed.** They are 8–8.7 mm across with 0.5–1.2 mm gaps, and they touch on a 667 px wide phone. Two of them have near-identical icons.
- **Quick nudges dash.** Any full push lifted within 220 ms is a dash, and it costs 16 fuel.

**Why controllers feel bad moving around:**

- **The jet button needs the aiming thumb.** Jet is on A, which the right thumb can't reach while it aims.
- **Pushing the stick up jets too easily.** Any push of 30° or more above horizontal jets, so a run that drifts slightly up takes off.
- **Running needs a big push.** The stick must travel 44% of its throw before the soldier runs.
- **Turning in the air is slow.** Reversing while flying takes 650 ms; on the ground it takes 117 ms.

**The fix, in order** (§6 has the full list):

1. **Phones:** sticks that start exactly where the thumb lands, with lower thresholds.
2. **Controllers:** a Standard preset: hold LT to jet, a steeper stick-jet cone, running from 30% of the throw.
3. **Phones:** fire modes chosen at first run: Auto (the default), Pull, Fire button and Release, with per-weapon release.
4. **Phones:** a corner-anchored right-hand cluster with fewer buttons that are bigger and better spaced.
5. **Phones:** gesture fixes: no accidental dashes; a third finger never cancels a thumb; aim and fire resume after a button press.

---

## 1. How this was measured

**Builds tested:**

- The worktree's own `vite` dev server on port 5247, in training's sandbox (`?sandbox&render=2d`).
- Headless Chrome through puppeteer, sending real multi-touch events (CDP `Input.dispatchTouchEvent`). This is the same method as `apps/web/scripts/touch-check.mjs`.
- Gestures whose timing matters (flicks, nudges) were sent with the events' own timestamps, as the controls read `e.timeStamp`.

**Instrumentation:**

- Every sim tick's sampled `Input`, with the player's x, vx, vy, fuel and dash state, came from a wrapper on `__game.mode.sampler.sample`.
- Every pointer event came from a capturing listener.

**Phones tested** (each with touch emulation and a coarse pointer):

| Size | Class |
|---|---|
| 667×375 | small iPhone |
| 812×375 | iPhone X / mini class |
| 844×390 | iPhone 12–16 |
| 915×412 | Pixel 7 class |
| 932×430 | Pro Max |
| 375×812 | upright, played on the turned page |

**Controller:** a fake standard-mapping pad, made by replacing `navigator.getGamepads` before the page loads, as the gamepad tests do. It ran in the same sandbox on a 1280×720 desktop page.

**Limits:**

- Headless frames ran at about 50 ms (software WebGL, Mac load 10–20). Wall-clock timings from that run aren't phone timings. Every latency number below is either structural (ticks, px, same-frame) or comes from timestamped events.
- Real devices weren't available: no iPhone Safari, no Android Chrome. Items that need them are marked **(device check)** in the verification lists.
- The probe scripts were temporary and are not committed. They lived in `apps/web/scripts/`, beside `touch-check.mjs`, and their method is above.

---

## 2. What's wrong today (ranked, measured)

### 2.1 The top ten

| # | Problem | Measured | Why it matters |
|---|---|---|---|
| 1 | **A thumb near an edge acts by itself.** The dial's centre is clamped inside the safe box (`controller.ts onDown`: `cx = clamp(at.x, rect.left + radius, …)`), so a thumb landing outside that line starts already pushed. | **Left thumb:** at x = 60 it runs left (push 0.86, angle −165°); at y = 340 (35 px from the bottom) it crouches. **Right thumb:** at x = 755 or 790 it **fires** and the aim swings to −9…−14° (the soldier turns right); at (700, 345) it fires straight down. Run starts for any left landing within 14.4 mm of the edge; fire for any right landing within 12.3 mm. | The fastest band for a thumb starts at the corner [S1]. Players observed by Li et al. put the stick's centre about 15.9 mm from the left edge, with 95% of first touches inside a 15.6 mm circle [S1]. If players land there, about **1 in 3 left-thumb landings** would start a run to the left (estimate: normal distribution, σ ≈ 3.2 mm). A right thumb resting near the edge fires and gives the player's position away. |
| 2 | **The right thumb aims, fires and presses every button.** Nine controls sit around the aim dial: grenade, next grenade, dash, melee, reload, shield, zoom, swap and the menu. | Thumb travel from the aim dial's rest: about 22–24 mm to reload, dash, grenade, melee and shield; 32 mm to next grenade; 39.5 mm to swap (812×375). Measured from the bottom-right corner, every button sits **44–65 mm** away, beyond the fastest band of 27.5–41.3 mm [S1]. On all six buttons tried, a thumb coming back to aim **did not fire again until it dragged ≥ 39 px**. | Each press is a lift, a hop, a tap, a hop back and a 39 px drag with the gun silent, most likely 0.5 s or more (estimate). A thumb on a stick can't press other buttons [S19]. Movement and aim regions should stay clear of buttons [S2]. |
| 3 | **Firing is coupled to aiming, and starts far out.** The default fire mode is "hold": fire past half the aim dial's push. Auto-fire is off by default, and there is no fire button. | Fire starts at **39 px (6.5 mm)** from the landing point. Aiming without firing works only between 8 and 39 px. A light 20 px push only aims. | Any correction past 6.5 mm fires, wasting ammo and showing the player. The first shot from rest needs 6.5 mm of travel. Mobile shooters offer auto-fire for newcomers and a fire button for experts [S20][S6]. |
| 4 | **Controller: the jet button needs the aiming thumb.** The default is A (South), and Settings' hint says "or push the move stick up". | A can't be held while the right thumb aims. Stick-up jet turns on at **35° above horizontal** on a full push (32° on touch); 30° is the line. Jet covers **a third of the stick's circle** (30°–150°). | A run that drifts up takes off and burns fuel. Aim-time actions belong on the triggers and bumpers [C12]. Most competitive players turn tap-jump off [C13]. |
| 5 | **Controller: running needs a big push.** Dead zone 0.2, then a run threshold of 0.3 on the rescaled value. | The run starts at **0.44 of the raw throw**. | Usual dead zones are 0.10–0.25 [C1][C5][C7]. Running is digital anyway (`Btn.Left/Right`), so a big threshold only adds travel. |
| 6 | **Buttons are small and tightly packed.** | 48–52 px (**8.0–8.7 mm**) at 812×375. Gaps are **3–7 px (0.5–1.2 mm)**; at 667×375 dash, reload, grenade, next grenade, zoom and shield **touch (0 px)**. Reload and next grenade have **near-identical circular-arrow icons** (`reload` and `refresh`; the screenshots show the same shape). | 90% accuracy needs ≥ 9 mm for a main button and ≥ 8 mm for others [S1]. Edge targets need 9–10 mm [S16]. Spacing should be ≥ 8 dp (≈ 1.3 mm) [S14] or about 2 mm [S17]. Xbox asks for 15 mm on phones [S6]. Two controls that look the same are ambiguous. |
| 7 | **Quick nudges dash.** "Swipe to dash" counts any full push lifted within 220 ms (`SWIPE = { maxMs: 220, minMag: 0.75 }`). | Full pushes lifted after **100, 150 and 200 ms all dashed** (16 fuel each). 260 ms didn't. | A small step to dodge or line up a shot spends a dash. It's the kind of accidental activation Xbox's guidelines warn about [S6]. |
| 8 | **Turning in the air is slow** (sim: `airAccel 20 m/s²`, `jetAirMaxX 6.5`). Every input device feels it; a stick makes it most obvious. | Air reversal while jetting, +6.5 → −6.2 m/s: **650 ms (39 ticks)**. Ground reversal: **117 ms (7 ticks)**. | A 2D platformer's air turnaround is about 0.28 s, with air acceleration about 0.65× ground [C8]. Ours is 5.6× slower than our own ground turn. |
| 9 | **A third finger stops a thumb.** A second finger landing on the same half within 300 ms turns the first finger's stick into a pinch: `startCamera` releases the stick. After 300 ms, an extra finger on empty space does nothing. | Read from the code (`controller.ts onDown → startCamera`). A three-finger tap on a button (the claw grip) was measured: the dash went through and the gun kept firing. | Claw grips put fingers on the screen at any moment [S20]. A stray finger shouldn't take aim or movement away. |
| 10 | **The layout scales with screen width, not with thumbs. iPhones get no haptics.** Placements are fractions of the safe box. | Dash sits **20.0 mm** from the aim rest at 667 wide and **26.8 mm** at 932 wide; the cluster touches on small phones and spreads on big ones. iOS Safari has no `navigator.vibrate` [W11], so "Vibrate when hit" and "Button haptics" do nothing on iPhones. | Comfort and reach depend on distance from the corner in mm, not on screen fractions [S1][S36]. A setting that does nothing is noise. |

### 2.2 Other findings

- **Thresholds on the move dial** (radius 68 px = 11.3 mm):

  | Action | Distance from the landing point | Notes |
  |---|---|---|
  | Run | 26 px (4.3 mm) | |
  | Jet (straight up) | 36 px (6.0 mm) | A full push jets at ≥ 30° |
  | Crouch (straight down) | 41 px (6.8 mm) | |

  A thumb that lands low on a clamped dial already sits below its centre. It then needs up to 20 px more travel to jet.
- **Dash direction and jet use different zones.**
  - The pad's dash is 8-way with 22.5° sectors, but jet starts at 30°. A stick 25° up runs without jetting, yet dashes diagonally up.
  - Touch uses `moveButtons` for its dash, so it takes the 30° jet line.
- **A dash-button tap waits for the lift** when the move stick is idle, to allow a swipe. The dash goes out a tap's length (≈ 80–120 ms) late. With the stick pushed, it goes out at once.
- **The training drill is 16 steps.** It starts by itself the first time a phone opens Training. A tutorial helps only when the game is complex and unconventional, and just-in-time hints did as well with less cost [S29]. Players skip text [S30].
- **Controller aim turns at a capped rate.** A 180° flip takes **133 ms (8 ticks)**. That is fine for small corrections but slow for turning round (§5.3).
- **Controller melee is on R3**, a stick click under the aiming thumb. A hard push can click it by accident. Stick clicks should be remappable [S6].
- **Controller shield, dual wield and next grenade are on the d-pad.** Pressing them takes the left thumb off movement.
- **The ✎ (edit layout) button sits at the top centre of the play HUD.** It's a target that can be hit by accident in a fight. Settings already opens the editor.

### 2.3 What works (keep it)

- **Input reaches the sim in the same frame.**
  - A `pointermove` that crosses the run threshold was in the next sim tick's `Input` within **0–0.1 ms** of the event. Chrome dispatches moves just before `requestAnimationFrame` [W4], and the local sim samples in that same frame.
  - Button presses use pulses, so a tap shorter than a tick still counts.
- **Multi-touch works.** A third finger tapping dash while both thumbs move and fire sent the dash with fire held on every tick around it.
- **The upright (turned) phone plays.** A drag on the turned page walked the soldier 4.28 m to the right.
- **Flick chains work.** Two 120 ms move-stick flicks 100 ms apart gave dash, dash, chain.
- **Controller basics are right.**
  - Aim is kept when the stick is let go: the aim stayed at 180° after release.
  - RT fires at 0.30.
  - The ground turnaround is crisp (117 ms).
  - The rumble table is sensible, with a 70 ms cap between shot rumbles.
- **OS gesture defences are mostly in place while the controls are up:**
  - `touch-action: none` and `overscroll-behavior: none`
  - non-passive `touchmove` `preventDefault`
  - `gesturestart`, `contextmenu` and `dblclick` blocked
  - `viewport-fit=cover`
  - inputs released on `blur` and when the page is hidden
  - fullscreen and orientation lock on Android
  - The gaps are in §4.9.

---

## 3. What the research says

Sources are numbered in §7.

- **[S#]:** touch and HCI
- **[W#]:** web platform
- **[C#]:** controllers

"(secondary)" marks a fan wiki, a press report, or a source seen only through another page.

### 3.1 Thumb zones and reach (landscape, two thumbs)

- **Li et al. 2021** [S1]: 18 participants; a 110.7 × 62.3 mm phone, about the size of an 812×375 phone, held in two hands.
  - **The fastest zone for each thumb is 27.5–41.3 mm from the bottom corner. The next is 13.8–27.5 mm.** At 41.3–55 mm the thumb can still reach but covers the screen, so only rare buttons belong there.
  - **Stick centre:** recommended 9.8–19.4 mm from the left and bottom edges. Observed first touches centred **15.9 mm from the left and 13.9 mm from the bottom**, with 95% inside a **15.6 mm** circle and 99% inside 25.4 mm.
  - While steering, the thumb moved within a 30 mm circle (95%) to 41.5 mm (99%).
  - **Button sizes:** the main attack button needs more than 9 mm and the other buttons more than 8 mm for 90% accuracy. Competing games used 11–15 mm for the main button and 7–11 mm for the others, spaced 7.6–10.25 mm apart.
- **Apple** [S2][S4]:
  - Put frequent buttons near the thumbs, but **keep them out of the round areas where players expect movement and camera input.** Put menus at the top.
  - Make the movement and camera areas as large as possible.
  - Apple's 2026 touch session lets a stick answer anywhere on its half of the screen, because players can't feel where a control is.
- **Microsoft Touch Adaptation Kit** [S5]:
  - Usually only two inputs happen at once, one per thumb.
  - The top zone is for rare actions, and the top-left corner for system buttons.
  - **Place aim-and-fire toward the centre** so a swipe doesn't run out of room.
- **Grip** [S36]: thumbs rest at the sides, and the top and bottom edges are hard to reach.
- **Outside players hold phones differently from the team.** One mobile studio found outside playtesters held the phone in ways its developers didn't expect, and changed its layout after testing [S22]. Log real players' first touches and design to the 95th and 99th percentiles, as Li et al. did [S1].

### 3.2 Virtual sticks: floating, fixed, dynamic; dead zones

**Origin:**

- Floating or dynamic sticks centred where the thumb lands are the common recommendation [S2][S8][S9][S12].
- When a fixed stick lets the thumb drift off, players lose control and must re-seat the thumb. Moving the origin along with a thumb that passes the radius fixes this [S9].
- **"Play to the border":** centre the stick on the touch even at the screen's edge [S8]. Our clamp does the opposite (problem 1).

**Dead zones** are small:

| Source | Dead zone |
|---|---|
| Microsoft Touch Adaptation Kit sample | 0.05 |
| A widely used web stick library | 0.1 (secondary) |
| One study's stick | half speed past 25% of the radius, full speed at the rim [S10] |

**The evidence is mixed:**

- Floating sticks cut glances at the device but were unfamiliar to some players [S10].
- Without looking, players can't feel the stick's centre or direction [S11]. Visuals at touch-down matter.
- No study compares fixed and floating sticks head to head on phones (agent report, §7 notes).

**What engines expose:**

- A dynamic-origin mode with its range (Unity) [S12].
- Re-centre time and active and inactive opacity (Unreal) [S13].

### 3.3 Target sizes and spacing

| Source | Minimum | ≈ CSS px |
|---|---|---|
| WCAG 2.2 2.5.8 (AA) [S15] | 24 px, or spacing | 24 |
| WCAG 2.2 2.5.5 (AAA) [S15] | 44 px | 44 |
| Apple, frequent game controls [S2] | 44 pt (menus 28 pt) | 44 |
| Android / Material [S14] | 48 dp, 8 dp apart | 48 |
| Hoober [S16] | 7 mm at the centre, **9–10 mm at edges, 12 mm in corners** | 42 / 54–60 / 72 |
| NN/g [S17] | 1 × 1 cm, about 2 mm apart | 60 |
| Li et al. [S1] | main attack > 9 mm (11–15 mm in shipped games); other buttons > 8 mm | 54 (66–90) / 48 |
| Game Accessibility Guidelines [S18] | 9.6 mm on phones, 24 mm ideal; buttons close together should be bigger | 58 |
| Xbox guidelines, XAG 107 [S6] | **15 mm on phones**, with empty space around each | 90 |

- **Decouple the hit area from the art.** One leading battle royale's HUD editor has separate "size" (the touch area) and "display scale" (the icon) settings [S23].
- **Our buttons:** at 8–8.7 mm with 0.5–1.2 mm gaps, they sit at the bottom of every range.

### 3.4 Fire modes in mobile shooters

| Pattern | What it is | Who uses it |
|---|---|---|
| **Auto-fire** ("simple mode") | The gun fires while the crosshair is on an enemy | **Offered by every leading mobile shooter we found.** A leading mobile FPS has a Simple mode with auto-fire plus a setting to limit its range [S20]. A leading battle royale asks at first run: auto-fire, tap anywhere, or a dedicated button; it reportedly recommends auto-fire to newcomers and doesn't apply it to snipers, melee or explosives (secondary, via [S6]). A mobile arena shooter's developers call aim assist plus auto-fire their breakthrough [S21]. |
| **Fire button** ("advanced mode") | A fire button; the right side of the screen aims. In the leading FPS the fire button can be **dragged to aim while firing** and can follow the finger. Players can add a second fire button on the left. | The same FPS's Advanced mode [S20]. Claw players (secondary guides). |
| **Pull to fire** | The aim stick fires once pushed past a threshold | The twin-stick standard. Microsoft's touch kit calls it `pullAction`: aim on press, fire by pulling outward [S5]. This is our "hold". |
| **Aim and release** | Drag to aim (with a preview), lift to fire, drag back to the centre to cancel; a tap auto-aims at the nearest target | Top-down mobile brawlers (secondary guides). Apple's 2026 session shows hold, drag to aim, release to fire [S4]. |

- **Fire on press is allowed.** WCAG's "act on release" rule exempts timing-critical actions; its own example is a shooting game [S15]. Xbox prefers release for most touch actions [S6].
- **Skill ceiling.** A brawler developer warns that auto-aim carries a player only so far before manual aim wins (secondary). That argues for **auto-fire as the start**, with an easy way up.

### 3.5 Aim assist and auto-fire

- **What assists exist:**
  - **friction / slowdown:** the aim turns slower over a target;
  - **magnetism:** the aim is pulled toward the target;
  - **bullet magnetism:** near misses bend toward the target;
  - **snap-to-target:** the aim jumps to a target, for example on aiming down sights.

  A twin-stick console shooter snapped the aim to an enemy within a small angle of the stick and held it while the stick stayed on it (secondary) [S33].
- **Players barely notice light assist.** Low-to-moderate sticky targets go unnoticed; bullet magnetism is noticed when it hits the wrong target [S34].
- **Projection fix:** test the angle **after projecting the stick direction out to the target's distance**. A raw-angle test makes assist useless up close and present everywhere at range [C12].
- **Visible snaps work in co-op; hidden nudges don't.** A co-op shooter's visible ≤ 30° snap worked. Its hidden nudge felt like the gun moving by itself [C12].
- **PvP games keep cutting assist strength** (secondary) [C18]:
  - magnetism cut from 50% to 35%;
  - assist window cut to 60%;
  - controller strength around 0.4 on PC and 0.6 on console.
- **Per-weapon circles:** assist circles grow with range up to the weapon's effective range, then **drop off sharply** [C17].
- **Target choice:** a robot shooter scores each candidate (aim offset, distance, HP, cover) and keeps the current target sticky [S35]. Opt-in auto-aim was tried by 18% of players, and 80% of those kept it.
- **No source publishes cone angles for touch assist.** The numbers in §4.5 are starting points to tune.

### 3.6 Gestures and timings

| Source | Long press | Movement allowed | Other |
|---|---|---|---|
| Android [S25] | 400 ms | 8 dp touch slop | Tap timeout 100 ms, double tap 300 ms |
| iOS [S26] | 0.5 s | 10 pt | |

- **Radial menus** open after about 150–500 ms. Longer delays mean more expert flicks but more errors (§7, S-notes).
- **Make aim-and-release cancellable** (drag back, or onto a cancel zone). Avoid holds longer than 2–3 s, rapid taps and presses that need two buttons at once [S6].
- **Combine actions on one control.** Use double-tap or hold for variants, and hide controls that can't act [S2].

### 3.7 Custom layouts and presets

- **Xbox guidelines** [S6]: let players set the size, spacing and position of every touch target; ship several presets; make the editor itself accessible; offer simpler schemes (auto pick-up, auto-fire).
- **Players split across layouts.** In one mobile game, each of four layouts was used by about 25% of players [S18].
- **Most players never open settings.** In one postmortem, 95% changed nothing and 2% changed the touch controls [S24]. **The default layout carries the game.**
- **No reliable data on claw grip** (three or four fingers). Only guides say "many" or "pros" use it (agent report).

### 3.8 Haptics

- **Use haptics as a complement, and sparingly** [S27]: pair them with sound and visuals, with clear cause and effect. Use short ones for discrete events. Let players turn them off.
- **Android timings** [S28]: a key click is **10–20 ms**. Actuators keep ringing for another 20–50 ms. If the only choice is buzzy haptics or none, choose none.
- **Web support** [W11]:
  - **Only Android Chrome (and Samsung Internet) vibrate.** It needs a user gesture first, and DND or silent mode may block it.
  - **iOS Safari has no Vibration API in any version.**
  - A haptic switch trick in iOS 18 now needs a real tap (WebKit bug 285120). It's reported broken from iOS 26.5 (unverified).
- **Gamepad rumble** [W12]: `vibrationActuator.playEffect('dual-rumble')` works in Chrome and Edge, and in Safari on macOS only.

### 3.9 Onboarding

- **Tutorials:**
  - A study of 45,000+ players: tutorials helped only the complex, unconventional game; just-in-time hints did as well there and nothing in simpler games [S29].
  - A text tutorial was understood by 2 of 10 players; prompts inside play by about 10 of 10 [S30].
  - Let people play as soon as possible, and teach by playing [S3].
- **Reveal controls as they become useful.** A streaming touch layout starts with basic controls and adds a button when its weapon is picked up [S5].

### 3.10 Latency

**What players notice:**

| Action | Noticed difference | Source |
|---|---|---|
| Dragging | ~2–11 ms | [S31] |
| Tapping | ~64–69 ms | [S31] |

Top mobile games measured 78–95 ms from tap to screen (2019) [S32].

**What it means for a web game:**

- **Moves arrive just before the frame; presses arrive at once** [W4]. Chrome dispatches `pointermove` and `touchmove` just before `requestAnimationFrame`. It dispatches `pointerdown` and `touchstart` immediately.
- **iOS Safari runs `requestAnimationFrame` at 60 Hz by default**, and pages can't opt in to 120 Hz [W13]. UIKit delivers touches at about 60 Hz and coalesces the faster samples [W19].
- **The bigger delay is thumb travel to a threshold, not the pipeline.** At a deliberate 100 mm/s, today's 6.5 mm to fire takes ~65 ms; the proposed 4.5 mm takes ~45 ms (estimate).

### 3.11 The browser platform (OS gestures, fullscreen, orientation, wake lock)

**Touch handling** [W1][W2][W3]:

- `touch-action` must be set **before** a gesture starts. Cancelling pointer events can't stop pan or zoom.
- `pointercancel` fires on an app switch, an orientation change, palm rejection, or **too many pointers**.

**iPhone:**

- About 5 simultaneous touches; a 6th cancels all of them (community reports, old) [W20].
- iOS reserves three-finger gestures.
- iOS ignores `user-scalable=no`; `touch-action` is what stops zoom, and `manipulation` or `none` removes the double-tap delay [W6].
- **Edge-swipe back can't be turned off in Safari** [W5]. Calling `preventDefault` on a `touchstart` within about 16–20 px of the side edges helps but isn't reliable.
- **The home indicator can't be deferred from the web** [W5].
- **No element fullscreen and no orientation lock on iPhone.** The manifest's `orientation` is ignored. On iOS 26, any site added to the Home Screen opens as a web app [W8][W9][W10].

**Android Chrome:**

- `requestFullscreen({ navigationUI: 'hide' })` and `screen.orientation.lock('landscape')` work, after a tap [W9][W10].
- **The edge back gesture can't be stopped by a page.** In fullscreen, the first back press leaves fullscreen [W15][W16].
- A `CloseWatcher` can catch one back press per user activation and open a pause menu [W16].
- `overscroll-behavior-x: none` keeps Chrome's own swipe-to-navigate off [W17].

**Wake lock** [W14]:

- `navigator.wakeLock.request('screen')` works in Chrome 84+ and Safari 16.4+.
- It works in iOS Home Screen apps from 18.4.
- It is released when the page is hidden, so re-request it on `visibilitychange`.

### 3.12 Controllers

**Dead zones:**

- **Scaled radial is the standard** [C1][C2][C3]. Rescale `(mag − inner) / (outer − inner)`.
- **Typical values:**

  | Source | Inner | Outer |
  |---|---|---|
  | Unity | 0.125 | 0.925 [C7] |
  | XInput | left 0.24, right 0.265 | [C5] |
  | UWP example | 0.1 | [C6] |
  | Others | 0.1–0.25 | [C1][C2] |
- **Pads at rest read about 0.05–0.15** [C12][C24], and worn pads drift.
- **Browsers apply no dead zone** [W12]; the game must apply its own.
- **Angular dead zones** snap the stick to pure left and right, so a run stays horizontal [C3][C2].

**Response curves:**

- Movement can be linear, because running is digital (§5.2).
- A curve helps fine aim [C2][C5].
- **Smoothing adds delay at close range** [C18]. If you smooth, use a speed-adaptive filter (1€: about 1 Hz cut-off, beta tuned up from 0.001) [C19].

**Running, acceleration and leniency:**

- **Precision 2D platformers run digitally** at full speed [C8][C10].
- **Typical speeds and times:**

  | Source | Time to max speed | Turnaround | In the air |
  |---|---|---|---|
  | A 2D platformer [C8] | 0.09 s | 0.18 s | 0.65× ground (0.28 s turnaround) |
  | Another [C10] | none (instant) | | |
- **Leniency:** coyote time 0.10 s [C8]; jump buffering [C9][C11].

**Jet on a button or on stick-up:**

- **Platform fighters make tap-jump optional**, and competitive players mostly turn it off: accidental jumps during up-attacks (secondary) [C13].
- **Similar games:**
  - A side-view levitation shooter levitates on **LT** and fires on **RT** (secondary) [C14].
  - A 2D sandbox game flies on a held jump button, with "up" only boosting some wings, and has a hover toggle (secondary) [C15].
- **With both sticks in use, only the triggers and bumpers are free.** Use two of them, or three or four at most [C12]. Console "bumper jumper" layouts exist for the same reason (secondary) [C16].

**Aim on the right stick in 2D:**

- **Fire along the stick's direction.** Use a radial dead zone of about **0.3** [C12].
- **Don't snap; rotate at a capped rate.** About 12° per frame at 60 fps (720°/s) beats a snap, which looks jumpy [C12].
- **Keep the facing when the stick is centred** [C8].
- **Some 2D games limit aim to 8 directions** (secondary, fan wiki).

**Aim assist on pads:** see §3.5. In mixed lobbies, magnetism is often controller-only and weaker for mouse players [C17] (secondary for the PvP numbers).

**Human factors:**

- **A stick aims far less precisely than a mouse:** 1.48 vs 3.78 bits/s throughput [C21]. That gap is the case for pad aim assist.
- **Treat 2D movement and aim as one circular stick**, not two independent axes [C20].
- **Pad latency:** Chrome polls gamepads at 250 Hz [C22]; wired pads add about 8–13 ms (secondary) [C23].

**Triggers:**

- **Hysteresis:** press above 0.6 and release below 0.4, or relative thresholds: press at the lowest value seen plus 0.3, release at the highest seen minus 0.2. Relative thresholds allow fast semi-auto taps [C4].
- **Unity** presses at 0.5 and releases at 0.375 [C7]. **XInput's** threshold is 30/255 ≈ 0.12 [C5].
- **Fire on press, not release** [S6].

**Rumble:**

- Give an off switch and an intensity slider. **Never make haptics the only cue** [S7].
- The left motor is heavy and the right light [C6].
- Browser effects may be capped (5 s recommended). A new effect replaces the running one [W12].

**Layouts:**

- Remap actions, not just buttons. Update the prompts after a remap. Allow toggles for holds. Make stick clicks remappable. Allow per-stick sensitivity of ±50% [S6].
- Ship named presets (default, southpaw, bumper jumper and so on) (secondary) [C16].

---

## 4. Phone spec

### 4.1 Units and anchoring

**Anchor every control to a corner of the safe box in mm.** Today's controls are fractions of the box, and that has to change.

Safe box:

| Edge | Inset |
|---|---|
| Sides | `max(env(safe-area-inset-left/right), 32 px)` |
| Bottom | `max(env(safe-area-inset-bottom), 16 px)` |
| Top | `max(env(safe-area-inset-top), 8 px)` |

- **Safe-area insets need `viewport-fit=cover`** (set while the controls are up) [W7].
- **The side gutter keeps drawn controls out of the edge-swipe band** [W5][W15]. Its width is a design choice, not a sourced number.
- **Touches that start in the gutter still drive the sticks** (§4.3).
- **The coordinate tables below use today's kit insets** (44 / 21 / 10 px), as measured. Real devices substitute their own insets.

**Zones** (right-handed; left-handed mirrors x):

| Zone | Where | What it does |
|---|---|---|
| Top band | top 15 mm (90 px) | menu, scores, the claw buttons; no sticks start here |
| Move zone | left 45% of the width, below the top band | the floating move stick |
| Aim zone | right 55%, below the top band, outside every button's hit area | the floating aim stick |

### 4.2 Layouts and presets

**Sizes:**

| Kind | Hit area | Art |
|---|---|---|
| Primary (dash, grenade, FIRE) | 12 mm (72 px) | 10–11 mm |
| Secondary (swap, the context slot) | 10 mm (60 px) | 8.5–9 mm |
| Top bar (menu, scores) | 8 mm (48 px) | |

- Hit areas never overlap, and the gap between them is **≥ 2 mm (12 px)** [S1][S6][S14][S16][S17][S23].
- The editor can shrink nothing below 9 mm (54 px) and nothing primary below 10 mm (60 px).

**Fewer right-thumb buttons:**

- **Gone from the default HUD:**
  - **Next grenade:** the swipe ↑/↓ on the grenade button already does it.
  - **Melee:** it's in the swap pill's hold radial, plus the context slot when an enemy is within 2.5 m.
  - **Reload:** the sim already reloads an empty magazine (`combat.ts`). Reload shows in the context slot once the magazine is ≤ 40%.
  - **Zoom:** shows in the context slot while a scoped gun is in hand.
  - **Shield:** shows in the context slot while one is carried.
  - **✎ edit:** it lives in Settings and the pause menu.
- **The editor can still add any of them** for players who want them.
- **The context slot** shows one control at a time, in this priority order:
  1. Take (a gun underfoot)
  2. Melee (an enemy within 2.5 m)
  3. Shield (while carried; a second context slot if both apply)
  4. Reload (magazine ≤ 40%)
  5. Zoom (scoped gun)
- **Every control has a distinct icon shape.** No two controls look alike: different ids aren't enough.

#### Classic (the default: two thumbs)

The action arc sits **42 mm** from the bottom-right corner:

- outside the aim stick's landing spread: its edges are 15–20 mm from the aim rest;
- in the edge of the fastest band [S1];
- 21° apart, which leaves 15.4 mm between centres and 3.4 mm between 12 mm hit areas.

Anchors are in mm. BL and BR are measured from the bottom-left and bottom-right safe corners (dx in from the side, dy up). TL and TR are measured from the top corners (dx in from the side, dy down).

| Control | Anchor (mm) | Hit | 667×375 | 812×375 | 844×390 | 915×412 | 932×430 |
|---|---|---|---|---|---|---|---|
| Move stick rest (drawn when idle) | BL 16, 15 | Ø 22 mm base, 11 mm knob travel | (140, 264) | (140, 264) | (140, 279) | (140, 301) | (140, 319) |
| Aim stick rest | BR 16, 15 | same | (527, 264) | (672, 264) | (704, 279) | (775, 301) | (792, 319) |
| Grenade (drag button) | BR 41.1, 8.7 | 12 mm | (376, 302) | (521, 302) | (553, 317) | (624, 339) | (641, 357) |
| Dash | BR 35.2, 22.9 | 12 mm | (412, 217) | (557, 217) | (589, 232) | (660, 254) | (677, 272) |
| Swap pill (hold: radial with melee) | BR 24.7, 34.0 | 10 mm high | (475, 150) | (620, 150) | (652, 165) | (723, 187) | (740, 205) |
| Context slot | BR 10.9, 40.6 | 10 mm | (558, 110) | (703, 110) | (735, 125) | (806, 147) | (823, 165) |
| Scores (hold) | TL 4, 4 | 8 mm | (68, 34) | (68, 34) | (68, 34) | (68, 34) | (68, 34) |
| Menu | TR 4, 4 | 8 mm | (599, 34) | (744, 34) | (776, 34) | (847, 34) | (864, 34) |

Compared with today at 812×375:

| | Thumb travel from the aim rest | Distance from the corner | Gaps |
|---|---|---|---|
| Today | dash 23.0 mm, reload 22.7 mm, swap 39.5 mm | 44–65 mm | 0.5–1.2 mm |
| Classic | dash 20.8 mm, swap 20.9 mm, grenade 25.9 mm, context 26.1 mm | 42 mm, all controls | 3.4 mm |

On a 667 px wide phone nothing touches.

#### Claw (three or four fingers)

- **Index fingers** work the top corners.
- **Thumbs** only move and aim.
- **Stick-up jet is off by default** in Claw, because the left index finger jets. That removes accidental jets entirely.

| Control | Anchor (mm) | Hit | 667×375 | 812×375 | 844×390 | 915×412 | 932×430 |
|---|---|---|---|---|---|---|---|
| JET (left index, hold) | TL 20, 14 | 12 mm | (164, 94) | (164, 94) | (164, 94) | (164, 94) | (164, 94) |
| DASH (left index; the move stick picks the way) | TL 42, 12 | 12 mm | (296, 82) | (296, 82) | (296, 82) | (296, 82) | (296, 82) |
| FIRE (right index, hold) | TR 20, 14 | 12 mm | (503, 94) | (648, 94) | (680, 94) | (751, 94) | (768, 94) |
| GRENADE (right index) | TR 42, 12 | 12 mm | (371, 82) | (516, 82) | (548, 82) | (619, 82) | (636, 82) |

- The right arc keeps only the swap pill and the context slot; its grenade and dash move to the index fingers.
- **Menu and scores move to the top centre**, one each side of the middle, 24 px apart.
- **The aim stick only aims** in Claw (Fire button mode, §4.4). FIRE is the right index finger.
- **Any extra finger on empty aim-zone space also fires while held.** This "tap anywhere to fire" for claw players is optional and on by default in Claw.

#### One-thumb assist (accessibility; one hand, or a first-time player)

Xbox guidelines say even twin-stick games can offer a single-stick mode [S6].

| Control | Anchor (mm) | Hit | 812×375 |
|---|---|---|---|
| Move stick (push up to jet) | BL 16, 15 | Ø 22 mm | (140, 264) |
| DASH | BR 16, 14 | **15 mm** (90 px) | (672, 270) |
| GRENADE (auto-aimed lob at the nearest visible enemy; drag to aim it yourself) | BR 34, 14 | 15 mm | (564, 270) |
| SWAP | BR 16, 32 | 15 mm | (672, 162) |

- **Aim is automatic:**
  - the nearest visible enemy within the weapon's range (§4.5);
  - otherwise, where the soldier faces.
- **Fire is automatic** (Auto mode).
- **A drag on empty right-side space takes over the aim** for as long as the finger stays down.

#### Preset rules

- **The editor's first row** offers Classic, Claw, One-thumb assist and "My layout".
- **Each preset is a full placement set plus the settings it implies:** fire mode, stick-jet, tap-anywhere.
- **Editing a preset forks it into "My layout".** Today's per-control move, resize and opacity editor stays.
- **The editor shows each control's hit circle** as well as its art. A "Reach" toggle tints the 27.5–41.3 mm comfort arcs [S1].

### 4.3 Sticks: origin, dead zones, thresholds, follow

These rules apply to both sticks.

**Origin:**

- **The origin is exactly where the thumb lands.** Never clamp it.
- Draw the base clamped inside the safe box if it must be, but measure the knob offset from the true touch point.
- *(Fixes problem 1.)* [S8]

**Radius:** knob travel **11 mm (66 px)**, the same feel as today's 68 px.

**Dead zone:** **8% of the radius (5 px)**, scaled radial: `t = (r − 0.08) / (0.90 − 0.08)`, with the outer edge at 0.90. The curve is linear on the move stick; on the aim stick, the curve only sets the reticle's reach. [S5][C1]

**Dynamic follow:**

- When the thumb goes beyond **1.2 × radius (79 px)**, the origin slides along so the thumb stays at 1.2 × radius.
- Reversing then costs the same travel as starting from the centre.
- [S9][S12]

**On release:** the base glides home, as today.

**Move stick thresholds** (fractions of the radius after the dead zone; px at 66 px radius):

| Action | Start | Stop (hysteresis) | Today |
|---|---|---|---|
| Run left/right | \|x\| ≥ 0.20 (16 px, 2.7 mm) | \|x\| < 0.14 | 26 px |
| Jet | the stick's angle within **45°–135°** and push ≥ 0.45 (30 px) | stops when the angle leaves **15°–165°** or the push drops below 0.30 | any push with y ≥ 0.5 (30° on a full push) |
| Crouch / drop through | angle within ±30° of straight down and push ≥ 0.60 (38 px) | push < 0.45 | y ≤ −0.6 (37° below horizontal) |

- Jet keeps today's "push up to jet" on the stick, with an angular start cone and hysteresis.
- On a full push the run zone covers ±78° of pure left or right, so "up-right" is jet plus run once jetting.

**Aim stick:**

- **Direction:** the angle of the shaped vector. It updates only while the push is ≥ 0.15 (no wobble at the dead zone's rim).
- **Lifting keeps the aim**, as today.
- **Fire thresholds** depend on the fire mode (§4.4).

**Timings** (unchanged except as noted):

| Timing | Value |
|---|---|
| Hold | 300 ms |
| Swipe | within 240 ms, ≥ 22 px |
| Still | < 8 px |

These match the platform defaults [S25][S26].

### 4.4 Fire modes (a player option; the coordinator's ask)

Settings → Touch → **Fire** has four choices, each with a little moving picture. A first-run chooser shows them too (§4.10).

| Mode | How it works | Who prefers it | Placement and size | What the best mobile shooters do |
|---|---|---|---|---|
| **Auto** (default for new phone players) | The aim stick aims. **The gun fires by itself** while the aim, after assist, lies on a visible enemy within the weapon's effective range (§4.5). Pushing the aim stick to the rim (≥ 0.90) fires anyway: at mines, barrels, around a corner. One-shot weapons use Release (per-weapon rule below). | New players, casual players, one-handed and accessibility players, anyone struggling with two thumbs. | No extra button. The aim stick as in Classic. A small "AUTO" tag on the aim dial while it's on. | Leading FPS: "Simple mode" with an auto-fire range limit [S20]. Leading battle royale: a first-run choice that reportedly recommends auto-fire to newcomers and excludes snipers, melee and explosives (secondary, via [S6]). Arena shooter: auto-fire plus assist was the breakthrough [S21]. |
| **Pull** (today's "Hold", renamed) | The aim stick fires while pushed past **0.40 (27 px, 4.5 mm)** and stops below 0.30. Inside that, it only aims. The ring shows the fire line. | Twin-stick veterans; players who want one thumb for aim and fire. | As Classic. Draw the fire ring on the dial so the line is visible. | Microsoft's touch kit `pullAction` [S5]. The common twin-stick touch pattern. |
| **Fire button** | The aim stick **only aims**. A **FIRE** button fires while held: on `pointerdown`, with no delay. **Drag from FIRE to aim while firing**: the FIRE press is a floating stick anchored where the thumb landed, so one touch both fires and steers. A touch elsewhere aims without firing. | Players who want to aim without firing (aim, then commit), snipers, claw players (FIRE on the right index finger in Claw). | Classic: FIRE **14 mm (84 px)** at the aim rest (BR 16, 15). The aim-only stick starts anywhere else in the aim zone. Optional second FIRE on the left (TL 20, 14), for the left index finger or a hop of the left thumb. | Leading FPS "Advanced mode": a fire button you can drag to aim, an optional left fire button, and an editor to move both [S20]. Claw guides (secondary). |
| **Release** | Drag to aim, with the trace drawn. **Lift to fire one shot.** Drag back inside the dead zone and lift to cancel. Charge weapons charge while held. | Precision shots and slow semi-automatic guns; players coming from top-down brawlers. | As Classic. The dial shows a cancel ring in its centre while aiming. | Top-down brawlers: drag, release, drag back to cancel (secondary). Apple's touch session: hold, drag, release [S4]. |

**Default for a 2D jetpack shooter: Auto, chosen at first run, with Pull one tap away.** Why:

- **The owner's problem is that mobile players can't play at all.** Every leading mobile shooter offers an auto-fire scheme for exactly that player [S20][S21][S6].
- **It removes aiming and firing from one thumb's job list.** Flying already takes the left thumb.
- **Most players never change settings** [S24]. The default must be the one that works for newcomers.
- **The rim override keeps manual fire available** without switching modes.
- **The game shows when an auto-fire player could do better.** After a player's first five matches, if they made many rim-overrides or stood still a lot, a one-time card suggests Pull.

**Per-weapon overrides** (Settings → Touch → "Precision weapons fire on release", on by default):

| Classes | Fire mode | Why |
|---|---|---|
| `sniper`, `dmr` | Release | Aiming then committing is the whole skill; lift-to-fire stops auto-fire wasting a slow shot |
| `charge` fire mode (ripper, pulse) | Release | Hold charges, lift fires |
| Launchers (thumper, popper) | Release | Splash weapons shouldn't auto-fire at a target hugging the player |
| `shotgun` | Auto, at ≤ 0.6 × its range (≈ 8 m) | Past that the pellets do little |
| Everything else | The player's mode | |

The override applies in Auto and Pull. Fire button mode needs none: the button already separates aiming from firing.

### 4.5 Aim assist and auto-fire parameters (touch)

Assist levels (Settings → Touch → Aim assist):

| Level | What it does |
|---|---|
| Off | Nothing. |
| Light | Today's friction: while the aim lies on a target, it turns at 0.45× toward the stick. A target counts within 0.9 m of its centre, out to 40 m. |
| **Standard (default)** | Light, plus magnetism (below). |
| Strong (One-thumb assist) | Standard, plus a lock: with the aim stick idle, the aim stays on the chosen target while it's visible and in range. |

**Magnetism** (new):

- **When:** only while the aim stick is held with a push ≥ 0.30, or while Auto is firing.
- **Candidates:**
  - visible enemies (none behind smoke or walls, as the sight rules already decide);
  - in the weapon's range × 0.9, never over 40 m.
- **Cone:** project the stick's direction out to each candidate's distance d [C12]. The candidate is in the cone when the miss distance is ≤ **0.45 m (body half-width) + 0.35 m slack**, or within 2.5°, whichever is wider.
- **Pick:** the smallest projected miss. Keep the current target unless another is 30% better (stickiness) [S35].
- **Pull:** turn the aim toward the target's centre by **25% of the angular error per tick**, at most **3° per tick** (180°/s). That is far slower than a thumb, so the player always wins a disagreement.
- **Range falloff:** full strength to 0.7 × the weapon's range, then a linear fall to zero at 0.9× [C17].

**Auto-fire's on-target test:**

- **Hit test:** the same projection, with the miss ≤ 0.45 m. Today's test is a fixed 6° cone or the body half-width, out to 22 m.
- **Range:** the weapon's range × 0.8. Today it is a fixed 22 m, so a 48 m rifle auto-fires only to 22 m.
- **Line of sight:** required.
- **Dwell:** the first shot only after **100 ms** on target, so the gun doesn't twitch at passers-by.
- **Linger:** firing continues for **150 ms** after the target leaves the test, so bursts don't stutter.

**Mouse and keyboard never get assist.** That is unchanged.

**Pads** use the same code with their own levels (§5.4).

### 4.6 Gesture rules

**Flick to dash on the move stick** *(fixes problem 7)*. A lift is a dash only when all of these hold:

- the thumb lifted within **180 ms** of landing;
- the peak push was ≥ 0.85;
- the push rose from < 0.3 to its peak within **90 ms**;
- **the thumb was still moving outward at lift**: speed over the last ≥ 32 ms of events ≥ **0.4 px/ms (≈ 65 mm/s)**.

A nudge that stops and then lifts is not a flick. The dash strength mapping (`dashStrength`) is unchanged. The chain via two flicks must still work.

**Dash button:**

- **With the move stick pushed:** dash on `pointerdown`, as today.
- **With the stick idle:** decide within **90 ms or 22 px of travel**, whichever comes first.
  - A swipe dashes that way.
  - Otherwise the button dashes the way the soldier faces, without waiting for the lift.

**A second finger never cancels a thumb** *(fixes problem 9)*:

- **A pinch starts only if both:**
  - the first finger is **still inside its dead zone** (it hasn't moved);
  - the second finger lands within 300 ms on the same side and **at least 20 mm away**.
- **Otherwise the second finger is a claw finger:**
  - on a button, it presses it;
  - on empty aim-zone space, it fires while held in Claw or Fire button mode;
  - anywhere else, it is ignored.

**Resume after a button** (Pull and Fire button modes; Settings → Touch → "Keep aiming after a button", on by default) *(softens problem 2)*:

- **When:** the right thumb lifted off the aim stick ≤ **700 ms** ago, and a button was pressed since.
- **What happens:** the next aim-zone landing starts with its origin set at `landing − lastOffset`. The previous aim and push carry on.
- **In Pull mode, if the thumb was firing, fire resumes on the first tick.**
- **Verify** (§4.11): the hop test's silent gap is only the hop itself.

**Buttons act on press** for timing-critical actions:

- **On press:** fire, dash (as above), jet (Claw), shield raise, and a grenade tap's latch press, which throws on lift as today.
- **On lift** (or later), where a hold or swipe variant must be told apart: swap and the grenade's throw.
- [S15][S6]

**Every gesture keeps a plain tap** (touch-controls-v3 rule).

### 4.7 Idle fading (the coordinator's ask)

- **Stick bases (the dial plates):**
  - full opacity while touched;
  - **1.5 s** after the thumb lifts, fade to **40%** over 300 ms;
  - **never below 30%**, so the home position stays findable without looking [S11];
  - back to 100% within one frame on any touch in the zone.
- **Action buttons:**
  - **never below 70%** during a match;
  - a context control **grows in at 100%** over 150 ms when it can act, and leaves 300 ms after it can't (today's "leave on lift" rule stays).
- **Never fade:**
  - HP, the jet-fuel ring, ammo and the reload ring;
  - the grenade count, the dash-fuel tick;
  - damage-direction marks, low-fuel and low-ammo warnings;
  - the Take button while a gun is underfoot;
  - the FIRE button in Fire button mode;
  - the menu button (at least 60%).
- **Contrast floor:** any faded control keeps at least **3:1** contrast against the scene behind it (WCAG 1.4.11's floor for controls that must be recognisable). The skin's glass plate already handles busy backgrounds.
- **Setting:** Settings → Touch → **Fade idle controls**, on by default. The global opacity slider multiplies on top, as today.
- **Evidence:**
  - Hide the floating stick until it's touched and fade it when idle [S2].
  - Engines expose "time until inactive" and "inactive opacity" knobs for exactly this [S13]. A widely used web stick fades in 250 ms (secondary).
  - Players can't find the stick's centre without looking [S11], hence the floor.
  - Haptics or visuals must not be the only cue for vital state [S7], hence vitals never fade.

### 4.8 Haptics

**Android (Chrome, Samsung Internet):**

| Event | Buzz |
|---|---|
| Gesture commits (radial pick, grenade type change, pinch step) | **12 ms**, up from 6–8 ms, which may not register [S28] |
| Swap | 12 ms |
| Dash swipe | 15 ms |
| Throw | 18 ms |
| Hit | 22 ms |
| Shield break | 40 ms |
| Death | 90 ms |
| Firing, jetting, any per-frame event | never |

- At most one buzz per 70 ms, as today.

**iOS Safari:** there is no Vibration API [W11].

- **Hide** both haptic toggles when `'vibrate' in navigator` is false, rather than showing switches that do nothing.
- Don't use the checkbox-switch trick for gameplay: it fires only from a direct tap and may be patched.

**Pads:** keep the current rumble table (§5.7).

### 4.9 Preventing OS gestures and the platform

The following are already in place (keep them):

- `touch-action: none`;
- `overscroll-behavior: none`;
- non-passive `touchmove` `preventDefault`;
- `gesturestart`, `contextmenu` and `dblclick` blocked;
- `user-select: none`;
- `-webkit-touch-callout: none`;
- `viewport-fit=cover`;
- release on `blur` and on the page being hidden;
- fullscreen plus `orientation.lock('landscape')` on Android after a tap.

**Add:**

1. **iOS edge swipes.** Add a non-passive `touchstart` listener on the game root. It calls `preventDefault()` when the touch starts within **24 px of the left or right physical edge** [W5]. It is not reliable during momentum scrolling, but the game page never scrolls.
   - On the turned (upright) page, the physical edges are the logical top and bottom. Compute the band in screen coordinates.
   - Buttons must act on `pointerup` or `pointerdown`, never `click`. This listener kills synthetic clicks.
2. **Expect a back gesture and make it harmless:**
   - No history entries during a match.
   - On Android, after the match-start tap, create a `CloseWatcher`; its `cancel` opens the pause menu [W16]. Fall back to a `pushState` sentinel plus `popstate`.
   - On `fullscreenchange` (exit), pause and show "Tap to go back to full screen".
   - On iOS, keep the room's rejoin token in `sessionStorage` and rejoin on `pageshow` (back/forward cache).
3. **Wake lock.** Call `navigator.wakeLock?.request('screen')` at match start from a tap. Re-request it on `visibilitychange` when visible, and release it at match end [W14].
4. **Touch budget.** Design for at most 3 simultaneous fingers (two thumbs and one claw finger). Read `navigator.maxTouchPoints` [W20]. A `pointercancel` for every pointer means the OS took the touches: release everything (today's handler does).
5. **iPhone guidance.**
   - Show an "Add to Home Screen for full screen" tip once, after the first match on iOS Safari [W8].
   - The turned-page fallback stays for phones held upright with the orientation lock on.
6. **Edge-to-edge on Android.** Use `env(safe-area-inset-bottom)` for the bottom inset, not a fixed padding [W18].
7. **Latency.**
   - Fire, dash and jet act on `pointerdown`.
   - The reticle and muzzle flash draw on the same frame as the sim tick (they do now).
   - Don't use `desynchronized` canvases (DOM HUD over WebGL, no Safari support).
   - Skip `getCoalescedEvents`: the sticks need only the latest point.

### 4.10 Onboarding

1. **First run on a phone** (before the first Training or match, ≤ 10 s):
   - one card, "How do you want to shoot?", with **Auto** (preselected, "recommended to start"), **Pull**, **Fire button** and **Release**;
   - each choice has a 2-second looping picture;
   - one line under the cards: "Change it any time in Settings → Touch".
2. **First flight** replaces the 16-step drill as the default. It has five goals, ticked off by doing them, ≤ 90 s:
   1. run;
   2. fly (the fuel ring explained by a pulse, not text);
   3. shoot the dummy (in the chosen fire mode);
   4. dash;
   5. throw a grenade.

   Skippable, and replayable from Settings. The full 16-step drill stays under Settings → Touch → "Learn every control" [S29][S30][S3].
3. **Just-in-time hints** (touch-controls-v3), plus:
   - the context slot's first appearance ("Tap to take it", "Tap to reload");
   - the first Claw suggestion: after **3 matches with ≥ 20 right-thumb hops**, a card offers "Try the Claw layout?" with a picture.
4. **Measure** (logged on the device, sent with match stats if the player opted in):
   - first-touch positions per side (to re-fit the 95th and 99th percentiles [S1]);
   - right-thumb hops per minute;
   - missed taps: touches within 4 mm of a button's edge that landed on empty space;
   - time to first kill for new players;
   - the share of players per fire mode and preset.

### 4.11 How to verify each phone item

Extend `apps/web/scripts/touch-check.mjs` (headless, real CDP touches, timestamped strokes) and the unit tests. Items marked **(device check)** need a real iPhone (Safari) and an Android phone (Chrome).

| Item | Check | Pass when |
|---|---|---|
| 4.3 origin | Touch at (60, 300), (128, 340), (755, 300), (790, 300), (700, 345) at 812×375 and hold 250 ms | No `Left`, `Down` or `Fire` bits; the aim angle unchanged |
| 4.3 thresholds | 1 px sweeps from rest (as the probe did) | Run at 16 ± 1 px; jet at 30 ± 1 px straight up; crouch at 38 ± 1 px; Pull fires at 27 ± 1 px |
| 4.3 jet cone | Full pushes at 25°, 40°, 50°; then sweep a jetting thumb from 80° down to 10° | No jet at 25° or 40°; jet at 50°; once jetting, keeps jetting down to 16° |
| 4.3 follow | Push 120 px right, then reverse | `Left` within 16 px + dead zone of reversing |
| 4.2 geometry | Rects at the five sizes | Every hit Ø ≥ 60 px (primaries ≥ 72 px); gaps ≥ 12 px; arc centres 42 ± 1 mm from the corner; nothing in the top band but the menu, the scores and the claw buttons |
| 4.2 icons | The screenshot set at 812×375, every preset | No two controls share an icon shape (a reviewer's check) |
| 4.4 Auto | A dummy in range in front: aim near it; then aim 10° off | Fires after ≥ 100 ms on target; stops ≤ 150 ms after leaving; with a sniper in hand nothing fires until the lift |
| 4.4 Fire button | Press FIRE and drag 40 px up | Fire on the first tick; the aim follows the drag |
| 4.4 Release | Drag 30 px, lift; drag 30 px, back to the centre, lift | One shot; then none |
| 4.5 magnetism | Unit test (pure): a target at 10 m, a stick 3° off | The aim moves ≤ 3° per tick toward it; zero pull with the stick idle (Standard) |
| 4.6 flicks | Timestamped strokes: a full push held, then lifted after 100/150/200 ms (stopped); a 120 ms flick still moving at lift | No dashes for the nudges; a dash for the flick; two flicks 100 ms apart chain |
| 4.6 dash button | A stick-idle tap of 120 ms | A `Dash` bit ≤ 90 ms after `pointerdown` |
| 4.6 second finger | Right thumb aiming and firing, then a second finger on empty right space after 50 ms | Fire continues; no camera mode |
| 4.6 resume | The probe's hop test (fire, lift, tap dash, re-land) | `Fire` back on the first tick after re-landing (today: never until a 39 px drag) |
| 4.7 fading | Opacity after 2 s idle | Bases 40%; buttons ≥ 70%; vitals 100% |
| 4.8 haptics | iOS UA without `navigator.vibrate` | Both toggles hidden **(device check: iPhone)** |
| 4.9 gestures | Swipe in from each edge mid-match; pull down from the top; pinch | No navigation, no zoom; Android back opens the pause menu **(device check: both)** |
| 4.9 wake lock | 3 min idle in the respawn screen | Screen stays on **(device check)** |
| 4.10 onboarding | A fresh profile on a phone | Chooser, then five goals, then a match in ≤ 90 s of play |

---

## 5. Controller spec

All of this is in `apps/web/src/gamepad` (`mapping.ts`, `settings.ts`, `manager.ts`). The pad still produces the same `Input` bits as the keyboard.

### 5.1 Stick processing

| Setting | Value | Today | Source |
|---|---|---|---|
| Dead zone type | Scaled radial, then an angular snap to pure horizontal within ±12° (move stick only) | Scaled radial, no snap | [C1][C2][C3] |
| Inner dead zone (both sticks) | **0.15** (slider 0.05–0.35) | move 0.20, aim 0.15 | [C7][C1][C5] |
| Outer dead zone | **0.92** (pushes beyond count as full) | 0.95 | [C7][C2] |
| Move curve | Linear (running is digital) | Linear | [C8] |
| Aim curve | 1.5 (only sets the reticle's reach) | 1.5 | |

### 5.2 Movement: run, jet, crouch, dash

**Run:**

- Starts at rescaled \|x\| ≥ **0.18**, about **0.30 of the raw throw**. Today it needs 0.44.
- Stops below 0.12 rescaled.
- The y axis never blocks running.

**Jet (three ways, one bit):**

1. **Hold LT** (Standard preset). The trigger presses at 0.30 and releases at 0.20.
2. **A**, kept as a second binding: it is the "jump" button players reach for.
3. **Stick-up** (on in Standard and Classic, off in Bumper Jet):
   - starts when the stick's angle is within **55°–125°** and the push is ≥ **0.60**;
   - keeps going while the angle stays within **20°–160°** and the push ≥ 0.40.

   The steep start cone stops a running stick from taking off. The wide sustain zone keeps diagonal flight easy. Today's line is 30° [C13][C14][C12].

**Hover toggle** (Settings, off by default): a tap of the jet input latches jet on until the next tap or until fuel is empty [C15][S6].

**Crouch / drop through:** the angle within ±30° of straight down and push ≥ 0.70, or L3. Today: y ≤ −0.6.

**Dash: LB** (unchanged):

- **The direction uses the same zones as movement:**
  - left or right within ±35° of horizontal;
  - up within ±35° of vertical (55°–125°), the same as the stick-jet's start cone;
  - down within ±35° of vertical;
  - the diagonals in between (35°–55° from horizontal).
- A stick at rest dashes the way the soldier faces.
- A second press within the sim's 0.35 s window chains.
- Today's 22.5° sectors make a slightly-up run dash diagonally.

**Leniency:** buffer one dash press for **100 ms** when it lands in the sim's 0.07 s dash gap. Today it is dropped. This is a sim change (`player.ts`), so it affects every input device; flag it in the PR [C9][C11].

### 5.3 Aim

- **Direction:** `atan2` of the processed stick. It updates only while the raw push is ≥ **0.30**; below that the last angle holds [C12].
- **Facing flips:** a change of more than 90° completes in **≤ 3 ticks (50 ms)**. Today a 180° flip takes 8 ticks (133 ms).
- **Small corrections** keep today's turn cap: 0.35 rad/tick ≈ 1200°/s, already above the 720°/s floor [C12].
- **Smoothing:** off by default. If a player turns it on, use the 1€ filter (cut-off ≈ 1 Hz, beta from 0.001) [C19][C18].
- **Optional snapping** (Settings): Off, 16-way or 8-way.
- **Releasing the stick keeps the aim** (unchanged).

### 5.4 Aim assist (pad)

| Level | What it does |
|---|---|
| Off | Nothing. |
| Light | Friction only: the aim turns at 0.45× while on a target (today's). |
| **Standard (default)** | Friction, plus magnetism as in §4.5 (25% of the error per tick, at most 3° per tick, projected cone, weapon-range falloff), active only while the right stick's push is ≥ 0.50. |
| Strong (One-stick preset) | Standard, plus a lock: the aim holds the chosen target while the stick is centred. |

- **Never** for mouse aim.
- **Show the level in the scoreboard** next to each pad player.

### 5.5 Triggers

- **RT fire:** press at **0.30**, release at **0.20**, or relative mode [C4]: press at the lowest value seen + 0.25, release at the highest seen − 0.15. This allows fast semi-auto taps.
- **"Hair trigger" option:** 0.10 / 0.05 [C5].
- **Fire on press** [S6].
- **LT** (jet in Standard): press 0.30, release 0.20.
- **Digital triggers** (some pads and browsers report only `pressed`): keep today's special case.

### 5.6 Presets

Settings → Controls → Controller → **Layout**: Standard, Classic, Bumper Jet, Southpaw, One-stick. Then the full remap (unchanged), with prompts following the remap. Xbox names below; PlayStation positions are the same.

| Input | **Standard** (new default) | **Classic** (today's) | **Bumper Jet** | **One-stick** (accessibility) |
|---|---|---|---|---|
| LS | move; stick-up jet (steep cone) | move; stick-up jet (steep cone) | move only | move; stick-up jet (steep cone) |
| RS | aim | aim | aim | optional aim override |
| LT | **jet (hold)** | aim / spin-up (Fire2) | dash | jet (hold) |
| RT | fire | fire | fire | fire (auto-fire on as well) |
| LB | dash | dash | **jet (hold)** | dash |
| RB | grenade (tap: throw; hold: aim the arc) | grenade | grenade | grenade (auto-aimed lob) |
| A | jet (second binding) | jet | jet | jet |
| B | **melee** | swap | melee | swap |
| X | reload (hold 0.3 s: take the gun underfoot) | reload | reload / take | reload / take |
| Y | **swap** | take a gun | swap | melee |
| L3 / R3 | crouch / spin-up (Fire2) | crouch / melee | crouch / Fire2 | crouch / — |
| D-pad ↑ ↓ ← → | dual wield, shield, zoom, next grenade | same | same | same |
| View / Menu | scoreboard / menu | same | same | same |

- **Southpaw** = Standard with the sticks swapped (the existing "Swap sticks"), plus LT/RT and LB/RB swapped.
- **One-stick** turns on aim assist Strong and Auto fire. The aim follows the nearest visible enemy within weapon range, otherwise the movement direction.

**Why Standard:**

- **All four actions used mid-fight are on the shoulders:** jet, fire, dash and grenade [C12][C14][C16].
- **Melee moves off R3** to a face button [S6].
- **Take moves to a hold on X** so Y can swap. The prompt shows "Hold X" when a gun is underfoot.
- **Existing players keep Classic.** Saved bindings that differ from Classic's defaults load as "Custom", untouched. The new default applies only to pads that never saved a layout.

### 5.7 Rumble

Keep the current table: a light shot (45 ms, at most every 70 ms), hits by damage, blasts by distance, dash, death, scaled by the 0–1 strength slider with an off switch.

Add:

- **Stop all effects on pause and when the page is hidden.** Effects reject while hidden [W12].
- **Combine events in a tick by keeping the strongest**, since a new effect replaces the running one. That is already the code's rule.
- **No rumble for jetting.**
- [S7][C6]

### 5.8 Movement feel to A/B (sim tuning, every input device)

**The proposal:**

- Air acceleration `airAccel` from **20 to 32 m/s²**. Air reversal while jetting drops from 650 ms to about 410 ms, and from rest to the air cap takes 0.19 s.
- Ground stays as it is (crisp at 117 ms).
- This is still slower than a precision platformer's 0.28 s, which suits a jetpack game's floatier feel [C8].

**How to run it:**

- Try it in a playtest through the admin page, which already exposes "Air control (m/s²)".
- Then keep or revert. It changes keyboard and bot movement too, so the owner decides.
- The sim feel report and the bots' soak must be re-run if it's kept.

### 5.9 How to verify each controller item

**Unit tests** (pure functions in `gamepad/mapping.ts`):

| Input | Expected |
|---|---|
| Raw (0.30, 0) | `Right` |
| Raw (0.25, 0) | nothing |
| Full push at 40° | `Right`, no `Jet` |
| Full push at 60° | `Jet` (+`Right`) |
| Jetting, then the stick at 25° | still `Jet` |
| Full push at 15° below horizontal | `Right`, no `Down` |
| Full push at −80° | `Down` |
| Dash at 25° and 30° | `Right` only |
| Dash at 50° | `Right\|Jet` |
| Dash at 80° | `Jet` |
| LT 0.35 | `Jet`; it releases at 0.19 |
| Aim from 0° to 180° | arrives in ≤ 3 ticks |
| Aim stick at 0.25 raw | the angle doesn't move |

**In-browser fake pad** (the method in §1): the same jet-angle table, the run threshold and the air reversal (after any 5.8 change). Check the Standard preset's prompts in the HUD and Settings.

**Device checks** with a real Xbox pad and a DualSense on Chrome desktop, Android Chrome, and iPad/iPhone Safari (no rumble there):

- the presets;
- rumble on and off;
- hover toggle;
- B/Circle reaching menus (Safari 26.1 fixed a focus bug [W12]).

---

## 6. Priority order

Ranked by how much each unblocks phone and pad players, against cost.

1. **Phone sticks: origin at the touch point, new thresholds, dynamic follow** (§4.3).
   - *Fixes problem 1; part of 3 and 5.*
   - **Small:** `touch/stick.ts`, `controller.ts onDown/moveStick`, plus tests.
2. **Pad Standard preset and movement mapping** (§5.1–5.3, 5.6).
   - LT jet, a steep stick-jet cone with hysteresis, run from 0.30 raw, a crouch cone, dash zones matching movement, fast facing flips.
   - *Fixes problems 4 and 5.*
   - **Small:** `gamepad/mapping.ts`, `settings.ts`, plus tests.
3. **Phone fire modes and the first-run chooser** (§4.4, 4.10.1).
   - Auto (default), Pull at 27 px, Fire button with drag-to-aim, Release; per-weapon release for precision weapons; auto-fire at weapon range with dwell.
   - *Fixes problem 3; eases 2.*
   - **Medium:** new `FireMode` values, a FIRE control, chooser UI.
4. **Phone right-thumb cluster** (§4.2).
   - Corner-anchored mm layout; 12/10 mm hit areas with ≥ 2 mm gaps; the context slot; next grenade, melee, reload, zoom and shield off the permanent HUD; unique icons; ✎ off the play HUD.
   - *Fixes problems 6 and 10; eases 2.*
   - **Medium:** `touch/layout.ts` defaults (a layout version bump), skin, editor.
5. **Gesture fixes** (§4.6).
   - Flicks need release speed; a dash tap decides within ≤ 90 ms; a second finger never cancels a thumb; aim and fire resume after a button.
   - *Fixes problems 7 and 9; eases 2.*
   - **Small to medium:** `controller.ts`, `stick.ts`.
6. **Aim assist upgrade, touch and pad** (§4.5, 5.4).
   - Magnetism with levels, projected cones, weapon-range falloff; auto-fire's new on-target test.
   - **Medium:** a shared pure module (`touch/mapping.ts` → `input/assist.ts`), plus tests.
7. **Presets** (§4.2, 5.6).
   - Claw and One-thumb assist on phones; Bumper Jet, Southpaw and One-stick on pads.
   - **Medium.**
8. **Onboarding** (§4.10).
   - Five-goal First flight; the 16-step drill moves under Settings; Claw suggestion; on-device metrics.
   - **Medium:** `touch/teach.ts`, shell.
9. **Platform hardening** (§4.7–4.9).
   - Idle fading rules; iOS edge `touchstart` guard; back gesture → pause (`CloseWatcher` / sentinel) and resume; wake lock; hide haptic toggles on iOS; Android buzzes ≥ 10 ms.
   - **Small each.**
10. **Air-control A/B** (§5.8): `airAccel` 20 → 32 m/s² in a playtest via the admin page; the owner decides. Also the dash-press buffer (§5.2), if wanted.
    - **Tiny** to try; a sim change if kept.

Items 1, 2 and 5 can land in parallel: phone agent, input agent, phone agent. Item 3 needs item 1's thresholds. Item 4 needs item 3's FIRE control.

---

## 7. Sources

Opened and read unless marked "(secondary)": fan wiki, press, third-party summary, or only search snippets.

The research was gathered on 22–23 Oct 2026. Three parallel research passes covered mobile touch, the web platform and controllers. Li et al.'s numbers were re-checked against the PDF's text.

### Touch, HCI and design guidance (S)

- **S1** Li, Zeng, Peng, Ma. *Understanding Players' Interaction Patterns with Mobile Game App UI via Visualizations.* Chinese CHI 2021. https://arxiv.org/abs/2110.08753
- **S2** Apple. *Human Interface Guidelines: Game controls.* https://developer.apple.com/design/human-interface-guidelines/game-controls
- **S3** Apple. *Human Interface Guidelines: Designing for games.* https://developer.apple.com/design/human-interface-guidelines/designing-for-games
- **S4** Apple. *TouchController* framework docs. https://developer.apple.com/documentation/touchcontroller
  - WWDC26 session 358 (touch controls for games). https://developer.apple.com/videos/play/wwdc2026/358/
- **S5** Microsoft. *Touch Adaptation Kit designer's guide* (Xbox cloud gaming). https://devdocs.xbox.com/build/core-features/common/game-streaming/building-touch-layouts/game-streaming-tak-designers-guide.md
- **S6** Microsoft. *Xbox Accessibility Guideline 107: Input.*
  - https://learn.microsoft.com/en-us/gaming/accessibility/xbox-accessibility-guidelines/107
  - Deep dive: https://devdocs.xbox.com/build/game-principles/accessibility/xag-deep-dives/xag-107-input.md
  - Includes the battle-royale auto-fire and preset examples cited as secondary.
- **S7** Microsoft. *XAG 110: Haptic feedback.* https://devdocs.xbox.com/build/game-principles/accessibility/xag-deep-dives/xag-110-haptic-feedback
- **S8** McAllister. *A Guide to iOS Twin Stick Shooter Usability.* Game Developer, 2011. https://www.gamedeveloper.com/design/a-guide-to-ios-twin-stick-shooter-usability
- **S9** Microsoft. US patent 9937416B2, *Adaptive touch input controls* (2013/2018). https://patents.google.com/patent/US9937416B2/en
- **S10** Baldauf et al. *Investigating On-Screen Gamepad Designs for Smartphone-Controlled Video Games.* ACM TOMM, 2015. https://matthiasbaldauf.com/publications/Baldauf15a.pdf
- **S11** Shirane et al. OzCHI 2025 (tactile cues for virtual sticks). https://www.iplab.cs.tsukuba.ac.jp/~thonda/paper/3764687.3769934.pdf
- **S12** Unity. *Input System OnScreenStick behaviours* (dynamic origin). https://docs.unity3d.com/Packages/com.unity.inputsystem@1.11/api/UnityEngine.InputSystem.OnScreen.OnScreenStick.Behaviour.html
- **S13** Epic. *Unreal TouchInterface* (time until deactive, inactive opacity, re-centre). https://dev.epicgames.com/documentation/en-us/unreal-engine/python-api/class/TouchInterface
- **S14** Google. *Android accessibility help: touch target size* (48 dp, 8 dp spacing). https://support.google.com/accessibility/android/answer/7101858
- **S15** W3C. *WCAG 2.2 Understanding* documents:
  - 2.5.8 Target Size (Minimum): https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html
  - 2.5.5 Target Size (Enhanced): https://www.w3.org/WAI/WCAG22/Understanding/target-size-enhanced.html
  - 2.5.2 Pointer Cancellation: https://www.w3.org/WAI/WCAG22/Understanding/pointer-cancellation.html
- **S16** Hoober. *Design for Fingers, Touch, and People, Part 3.* UXmatters, 2017. https://www.uxmatters.com/mt/archives/2017/07/design-for-fingers-touch-and-people-part-3.php
- **S17** Harley. *Touch Targets on Touchscreens.* Nielsen Norman Group, 2019. https://www.nngroup.com/articles/touch-target-size/
- **S18** *Game Accessibility Guidelines:*
  - Large, well-spaced virtual controls: https://gameaccessibilityguidelines.com/ensure-interactive-elements-virtual-controls-are-large-and-well-spaced-particularly-on-small-or-touch-screens/
  - Rearrangeable interfaces: https://gameaccessibilityguidelines.com/allow-interfaces-to-be-rearranged/
  - Sensitivity: https://gameaccessibilityguidelines.com/include-an-option-to-adjust-the-sensitivity-of-controls/
  - Holds: https://gameaccessibilityguidelines.com/avoid-provide-alternatives-to-requiring-buttons-to-be-held-down/
- **S19** Teather, Roth, MacKenzie. Entertainment Computing, 2017 (touch versus physical game controls). https://yorku.ca/mack/ec2017.html
- **S20** A game-specific source: a developer write-up, press report or fan wiki about another game. Its title and link are in the private shared notes (controls-research-sources.md), per the owner's rule against naming other games in the repo.
- **S21** A game-specific source: a developer write-up, press report or fan wiki about another game. Its title and link are in the private shared notes (controls-research-sources.md), per the owner's rule against naming other games in the repo.
- **S22** A game-specific source: a developer write-up, press report or fan wiki about another game. Its title and link are in the private shared notes (controls-research-sources.md), per the owner's rule against naming other games in the repo.
- **S23** AbleGamers. *Accessible Player Experiences: Personal Interface* (touch size versus display scale). https://accessible.games/accessible-player-experiences/access-patterns/personal-interface/
- **S24** Hassey. Postmortem stats on settings use, 2012. https://www.philhassey.com/blog/?p=1202
- **S25** Android. `ViewConfiguration.java` (long press 400 ms, touch slop 8 dp). https://android.googlesource.com/platform/frameworks/base/+/refs/heads/main/core/java/android/view/ViewConfiguration.java
- **S26** Apple. `UILongPressGestureRecognizer.minimumPressDuration` (0.5 s). https://developer.apple.com/documentation/uikit/uilongpressgesturerecognizer/minimumpressduration
- **S27** Apple. *Human Interface Guidelines: Playing haptics.* https://developer.apple.com/design/human-interface-guidelines/playing-haptics
- **S28** Android. *Haptics design principles* (10–20 ms key clicks). https://developer.android.com/develop/ui/views/haptics/haptics-principles
- **S29** Andersen et al. *The Impact of Tutorials on Games of Varying Complexity.* CHI 2012. https://grail.cs.washington.edu/projects/game-abtesting/chi2012/chi2012.pdf
- **S30** Sarangi. *No one reads text in a tutorial.* Game Developer, 2015. https://www.gamedeveloper.com/business/no-one-reads-text-in-a-tutorial
- **S31** Ng et al. *In the Blink of an Eye.* CHI 2014 (including Jota et al. 2013's 64 ms tap result). https://sites.ualberta.ca/~wfb/publications/C-2014-SIGCHI-Latency.pdf
- **S32** GameBench. Touch latency benchmarks, 2019. https://blog.gamebench.net/touch-latency-benchmarks-iphone-xs-max-galaxy-note-10
- **S33** A game-specific source: a developer write-up, press report or fan wiki about another game. Its title and link are in the private shared notes (controls-research-sources.md), per the owner's rule against naming other games in the repo.
- **S34** Kostić et al. *Aim Assistance in Video Games* (review), BISEC 2025. https://bisec.metropolitan.ac.rs/wp-content/uploads/2026/04/Rad-19-Aim-Assistance-in-Video-Games.pdf
- **S35** Sharikov. *How to create a fair auto-aiming system in a robot shooter.* Game Developer, 2024. https://www.gamedeveloper.com/design/how-to-create-a-fair-auto-aiming-system-in-a-robot-shooter-
- **S36** Clark. *How We Hold Our Gadgets.* A List Apart, 2015. https://alistapart.com/article/how-we-hold-our-gadgets/

**S-notes.** Radial-menu timing comes from Kurtenbach and Buxton's marking-menu work (https://billbuxton.com/MMUserLearn.html) and Lewis and Vogel (ACM TOCHI, doi 10.1145/3418196) (secondary). The claw-grip, brawler-control and auto-fire-recommendation details come from third-party guides (secondary). No study compares fixed and floating sticks on phones directly; the one large sensitivity study found (MIG '23, doi 10.1145/3623264.3624461) found no significant effect (secondary).

### Web platform (W)

- **W1** MDN. *touch-action.* https://developer.mozilla.org/en-US/docs/Web/CSS/touch-action
- **W2** W3C. *Pointer Events Level 3.* https://www.w3.org/TR/pointerevents3/
- **W3** MDN. *pointercancel.* https://developer.mozilla.org/en-US/docs/Web/API/Element/pointercancel_event
- **W4** Chrome for Developers. *Aligned input events*, 2017. https://developer.chrome.com/blog/aligning-input-events
- **W5** Edge-swipe navigation in Safari:
  - WebKit bug 240892: https://bugs.webkit.org/show_bug.cgi?id=240892
  - w3c/manifest issue 1041, "Add option to disable built-in navigation gestures": https://github.com/w3c/manifest/issues/1041
- **W6** WebKit blog:
  - *More Responsive Tapping on iOS*: https://webkit.org/blog/5610/more-responsive-tapping-on-iOS/
  - *New Interaction Behaviors in iOS 10*: https://webkit.org/blog/7367/new-interaction-behaviors-in-ios-10/
- **W7** WebKit. *Designing Websites for iPhone X* (safe areas). https://webkit.org/blog/7929/designing-websites-for-iphone-x/
- **W8** Firtman. *PWA on iOS notes*, updated Oct 2026. https://firt.dev/notes/pwa-ios/
- **W9** Fullscreen:
  - MDN *requestFullscreen*: https://developer.mozilla.org/en-US/docs/Web/API/Element/requestFullscreen
  - WebKit, Safari 16.4 features: https://webkit.org/blog/13966/webkit-features-in-safari-16-4/
- **W10** MDN. *ScreenOrientation.lock.* https://developer.mozilla.org/en-US/docs/Web/API/ScreenOrientation/lock
- **W11** Vibration:
  - MDN *Navigator.vibrate*: https://developer.mozilla.org/en-US/docs/Web/API/Navigator/vibrate
  - caniuse: https://caniuse.com/vibration
  - WebKit bug 285120: https://bugs.webkit.org/show_bug.cgi?id=285120
- **W12** Gamepad:
  - W3C *Gamepad*: https://www.w3.org/TR/gamepad/
  - web.dev *Gamepad*: https://web.dev/articles/gamepad
  - Chromium `gamepad_pad_state_provider.cc`: https://chromium.googlesource.com/chromium/src/+/main/device/gamepad/gamepad_pad_state_provider.cc
- **W13** WebKit bug 294338 (requestAnimationFrame near 60 fps by default). https://bugs.webkit.org/show_bug.cgi?id=294338
- **W14** Wake lock:
  - Chrome for Developers *Screen Wake Lock*: https://developer.chrome.com/docs/capabilities/web-apis/wake-lock
  - WebKit, Safari 18.4 features: https://webkit.org/blog/16574/webkit-features-in-safari-18-4/
- **W15** Android. *Gesture navigation.* https://developer.android.com/develop/ui/views/touch-and-input/gestures/gesturenav
- **W16** WHATWG HTML. *Close requests and close watchers.* https://html.spec.whatwg.org/multipage/interaction.html#close-requests-and-close-watchers
- **W17** Chrome for Developers. *overscroll-behavior.* https://developer.chrome.com/blog/overscroll-behavior
- **W18** Chrome for Developers. *Edge-to-edge migration guide*, 2025. https://developer.chrome.com/docs/css-ui/edge-to-edge
- **W19** Apple. *Getting high-fidelity input with coalesced touches.* https://developer.apple.com/documentation/uikit/getting-high-fidelity-input-with-coalesced-touches
- **W20** Apple Developer Forums thread 17606 (simultaneous touch limits; community answers, old: secondary). https://developer.apple.com/forums/thread/17606

### Controllers (C)

- **C1** Sutphin. *Doing Thumbstick Dead Zones Right.* Game Developer, 2013. https://www.gamedeveloper.com/business/doing-thumbstick-dead-zones-right
- **C2** Pérez Ramil. *thumbstick-deadzones*, 2017. https://github.com/Minimuino/thumbstick-deadzones
- **C3** Juckett. *Interpreting Analog Sticks*, 2016. https://blog.hypersect.com/interpreting-analog-sticks/
- **C4** Juckett. *Analog to Digital Input Translation*, 2016. https://blog.hypersect.com/analog-to-digital-input-translation/
- **C5** Microsoft. *Getting Started with XInput* (dead zones 7849/8689, trigger threshold 30). https://learn.microsoft.com/en-us/windows/win32/xinput/getting-started-with-xinput
- **C6** Microsoft. *Gamepad and vibration* (UWP). https://learn.microsoft.com/en-us/windows/uwp/gaming/gamepad-and-vibration
- **C7** Unity. Input System source: `InputSettings.cs` and `StickDeadzoneProcessor.cs` (0.125/0.925; press 0.5, release 0.375). https://github.com/Unity-Technologies/InputSystem
- **C8** A game-specific source: a developer write-up, press report or fan wiki about another game. Its title and link are in the private shared notes (controls-research-sources.md), per the owner's rule against naming other games in the repo.
- **C9** A game-specific source: a developer write-up, press report or fan wiki about another game. Its title and link are in the private shared notes (controls-research-sources.md), per the owner's rule against naming other games in the repo.
- **C10** A game-specific source: a developer write-up, press report or fan wiki about another game. Its title and link are in the private shared notes (controls-research-sources.md), per the owner's rule against naming other games in the repo.
- **C11** Brown (GMTK). *Platformer Toolkit: Behind the code*, 2022. https://gmtk.itch.io/platformer-toolkit/devlog/395523/behind-the-code
- **C12** Venturelli. *Everything I Learned About Dual-Stick Shooter Controls.* Game Developer, 2015. https://www.gamedeveloper.com/design/everything-i-learned-about-dual-stick-shooter-controls
- **C13** A game-specific source: a developer write-up, press report or fan wiki about another game. Its title and link are in the private shared notes (controls-research-sources.md), per the owner's rule against naming other games in the repo.
- **C14** A game-specific source: a developer write-up, press report or fan wiki about another game. Its title and link are in the private shared notes (controls-research-sources.md), per the owner's rule against naming other games in the repo.
- **C15** A game-specific source: a developer write-up, press report or fan wiki about another game. Its title and link are in the private shared notes (controls-research-sources.md), per the owner's rule against naming other games in the repo.
- **C16** A game-specific source: a developer write-up, press report or fan wiki about another game. Its title and link are in the private shared notes (controls-research-sources.md), per the owner's rule against naming other games in the repo.
- **C17** A game-specific source: a developer write-up, press report or fan wiki about another game. Its title and link are in the private shared notes (controls-research-sources.md), per the owner's rule against naming other games in the repo.
- **C18** A game-specific source: a developer write-up, press report or fan wiki about another game. Its title and link are in the private shared notes (controls-research-sources.md), per the owner's rule against naming other games in the repo.
- **C19** Casiez, Roussel, Vogel. *1€ Filter.* CHI 2012. https://gery.casiez.net/1euro/
- **C20** Hargreaves. *Gamepads suck*, 2007. https://www.shawnhargreaves.com/blog/gamepads-suck.html
- **C21** Natapov, Castellucci, MacKenzie. Graphics Interface 2009 (stick versus mouse throughput). https://www.yorku.ca/mack/gi2009.html
- **C22** W3C public-webapps list, Sep 2024 (Chrome polls gamepads at 250 Hz). https://lists.w3.org/Archives/Public/public-webapps-github/2024Sep/0225.html
- **C23** Gamepadla. Pad latency and centring comparison (secondary; its comparison module is "in testing"). https://gamepadla.com/versus/sony-dualsense_vs_xbox-core-controller.html
- **C24** Godot docs. *Controllers, gamepads and joysticks* (resting noise ≈ 0.06). https://docs.godotengine.org/en/stable/tutorials/inputs/controllers_gamepads_joysticks.html
