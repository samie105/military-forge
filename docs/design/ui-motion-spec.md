# Military Forge motion system (one system, desktop and phone)

The owner's words: "the UI should have nice motion … the desktop too … the same nice motion … and use cases for each of them." This file is that one system. Both UI agents (desktop and phone) build from it, so every screen moves the same way. It sits on top of the round-two kit (`military-forge-ui-v2.html`) and its wiring brief (`ui-v2-wiring-brief.md`). The kit decides how things look; this file decides how they move.

## 1. Principles

1. **Every move has weight.** Nothing moves linearly. Arrivals decelerate hard; departures accelerate away; settles overshoot by 2% or less. No bouncing UI.
2. **Overlap, never lockstep.** Groups stagger from their cause, such as the button pressed or the row that changed. Cap the stagger so the last element lands within 300 ms of the first.
3. **Objects hand off.** When a screen changes, something carries the eye across:
   - the map card becomes the map intro;
   - the room code becomes the lobby header;
   - the MVP row becomes the share card.

   Use whole-screen crossfades and generic slide-left page changes only as the last resort.
4. **Outgoing leaves before incoming arrives** in the same space. Text that swaps in place gets its own exit and enter.
5. **Focus pulls, not flashes.** Big titles arrive through a short blur-to-sharp, scale 1.04 → 1. Never a white flash, which also breaks Reduce flashes.
6. **Numbers roll.** Scores, timers, ammo and counts change with a short vertical roll and a small motion blur, using tabular figures.
7. **The battlefield comes first.** The in-match HUD is calm. It gives feedback, short and only when something happens: no idle loops, no drifting, nothing that competes with the fight. Menus are where the motion shows off.
8. **Interruptible, never blocking.** No input waits for an animation. A new state takes over from wherever the old one is, with no queued animations and no locked buttons.
9. **Owner taste:** blur and focus pulls, zooms, keyframed motion, fast punchy type, liquid smoothness. **Never:** dots or particle motifs in the UI, bouncing UI, glitch, spin transitions, shake in menus, lens flares.

## 2. Tokens

Add these to the ONE `:root` block in `ui/kit.css`, next to the kit's tokens. The desktop agent adds them in phase 1; the phone agent only uses them.

```css
/* durations */
--m-instant: 90ms;   /* press feedback, hit markers */
--m-fast: 160ms;     /* HUD feedback, toggles, chips */
--m-base: 240ms;     /* most menu enters and exits */
--m-slow: 360ms;     /* panels, cards, title focus pulls */
--m-scene: 520ms;    /* a whole-screen handoff: the longest anything takes */
--m-stagger: 30ms;   /* per item; cap the total at 300ms */
/* easings */
--ease-arrive: cubic-bezier(0.16, 1, 0.3, 1);   /* things landing */
--ease-travel: cubic-bezier(0.7, 0, 0.16, 1);   /* things moving across */
--ease-leave: cubic-bezier(0.7, 0, 0.84, 0);    /* things going away (accelerate out) */
--ease-settle: linear(0, 0.42 12%, 0.78 26%, 0.96 42%, 1.015 58%, 1.004 76%, 1); /* ≤1.5% overshoot */
/* distances */
--m-rise: 14px;       /* enter offset; the phone uses 10px */
--m-pull-blur: 8px;   /* focus-pull start blur (titles only) */
--m-press: 0.96;      /* press scale */
```

- **Reduce motion** (`html.reduce-motion` and `prefers-reduced-motion`): every move becomes an opacity change of 120 ms or less. No scale, blur, rolls or travel; loops stop.
- **Reduce flashes** (`html.reduce-flashes`): no brightness steps above about 20% in a frame, and no blinking faster than 3 Hz.

## 3. Building blocks (named patterns)

| ID | Pattern | Motion |
|---|---|---|
| P1 | **Focus pull** | Opacity 0 → 1, blur `--m-pull-blur` → 0, scale 1.04 → 1, over `--m-slow` on `--ease-arrive`. Titles, map names, MATCH 1, the winner. |
| P2 | **Shared element** | Measure the outgoing element's rect, render the incoming one there, animate its transform to its own rect over `--m-scene` on `--ease-travel` (FLIP via the Web Animations API). Content inside fades in once the shell is about 90% there. |
| P3 | **Stagger rows** | Each row rises `--m-rise` and fades in over `--m-base` on `--ease-arrive`, with delay `min(i, 10) × --m-stagger`. Lists, standings, settings rows, player slots. |
| P4 | **Roll counter** | The old digit leaves upward and the new one arrives from below, 60–120 ms with a 2 px vertical blur, per digit, tabular figures. |
| P5 | **Two-spring indicator** | A tab underline or toggle knob whose leading edge moves on `--ease-arrive` and trailing edge on `--ease-settle` 40 ms later, so it stretches and catches up. |
| P6 | **Flood** | A circle grows from the trigger (the GO button, the Ready tick) past the farthest corner in 300–350 ms (never faster: it would read as a flash), then contracts onto the next screen's anchor. Big moments only: GO, a match won. |
| P7 | **Stamp** | Scale 1.18 → 1 with `--ease-settle` and a 1 px press-in shadow over `--m-fast`. Badges: READY, MVP, HOST, "Fits the body", and the new-gun label. |
| P8 | **Press** | Scale to `--m-press` in `--m-instant`, then back with `--ease-settle`. Desktop hover lifts 1 px with a slightly brighter edge; no hover on touch. |
| P9 | **Edge banner** | Enters from its screen edge on `--ease-arrive` over `--m-base`, leaves accelerating on `--ease-leave`. Map events, the reconnecting banner, toasts. |
| P10 | **Meter fill** | A bar or ring driven by one CSS variable: `transition: --var var(--m-fast) var(--ease-arrive)` where the change is player-visible (HP, fuel, the equip ring). Never a transition on a value updated every frame; those are written raw. |

## 4. Use cases

### 4.1 Desktop (keyboard and mouse, 1280×720 up to 2560×1440). Owner: the desktop UI agent.

| Screen or element | Trigger | Motion |
|---|---|---|
| Loading | App start | Emblem P1 focus pull; tip text cycles every 4 s (outgoing leaves, incoming arrives); the progress bar is P10. |
| Name entry | Open | Field card P1; then the name check chip P7 when "Available", or a 2-frame nudge ±3 px for taken. |
| Home | Arrive from name entry | The ID card shares into the home's player chip (P2); menu rows P3; Play with friends is the first and the loudest. |
| Join with code | Typing | Each letter box P7 as it fills; on error the boxes shake ±4 px once (the only shake allowed in menus, because it means "no"). |
| Lobby | Enter | The room code P1; the share card arrives first (the most important action); players P3. |
| Lobby | A player joins or leaves | Their row P3 in or out; the count P4. |
| Lobby | Ready | The tick P7. When everyone is ready, the Start button gets a slow 1.2 s glow pulse (stops under Reduce motion). |
| Lobby | Copy link or Share | Button P8, then the label swaps to "Copied ✓" (outgoing leaves first), and back after 1.6 s. |
| Map card select | Click | The card lifts (P8) and the selection ring travels to it (P5-style). |
| Countdown | Start | P6 flood from the Start button into the countdown; "MATCH 1" P1; 3-2-1 each as a P1 at 0.8 s; GO is a stamp (P7) that clears in `--m-fast`. |
| Map intro card | Match start | The map card shares into the intro (P2); the place name P1 ("STREET MARKET · Lagos"); it leaves to the top edge after 1.6 s. |
| HUD: kill feed | A kill | The row slides in from the right edge (`--m-fast`), badges P7 at small scale; it leaves accelerating after 5 s. |
| HUD: hit marker | A hit | Scale 1.3 → 1 in `--m-instant`, then fades; a kill marker adds a P7. No shake on the HUD. |
| HUD: damage arcs | Taking damage | Fade in `--m-instant`, hold, fade over 600 ms; heavy hits a little wider, never a flash. |
| HUD: HP and fuel bars | Change | P10 with a ghost bar trailing 300 ms behind on damage. Low HP: the HP plate takes a slow 1.4 s pulse of its edge only (static under Reduce motion). |
| HUD: weapon switch | Swap | The two slot cards cross (the slung card shrinks to its small place, the held card grows) on `--ease-travel` over the gun's real equip time (0.25–0.6 s); the equip ring is P10 at the same pace. |
| HUD: ammo | A shot or reload | P4 roll on the mag count; empty: the count turns red with a P7. |
| HUD: grenade belt | Cycle (T) | The selection P5 slides to the next type; the count P4. |
| HUD: throw meter | Hold G | It arrives by P1 at small scale and follows `--throw` raw (no transition); a tap shows a 120 ms "quick" stamp. |
| HUD: dash ring | Dash used | The ring empties at once and refills raw; when ready, a single P7 tick. |
| HUD: pickup prompt | A crate in reach | P9 from the bottom; the gun icon P7; it leaves when out of reach. |
| HUD: map event banner | Warning, then start | P9 from the top; the countdown P4; start is a stamp; end leaves accelerating. |
| Scoreboard (Tab) | Hold | The panel P1 at `--m-fast` (fast: it's a peek); rows P3 with a 20 ms stagger; your row highlighted. |
| Results | Match end | P6 flood from the last kill or the timer; the winner P1; highlight cards P3; MVP P7; standings P3; the vote pips P7 as votes land. |
| Settings | Tab change | The tab indicator P5; the content: outgoing leaves 8 px left, incoming arrives 8 px from the right; sliders follow the pointer raw and the value P4. |
| Pause (Esc) | Open | The game behind dims over `--m-fast`; the menu P1; items P3. |
| Tune the game | Open | The panel slides in from the right edge (P9); rows P3; a changed value P4; "Tuned by host" P7 for everyone in the room. |
| Locker | Tab, item | The 3D soldier turns to show what changed; the item card P8; the "Fits the body" stamp P7. |
| Armory | Gun pick | The turntable eases to face the new gun (`--ease-travel`); the stat bars P10 from the old values to the new; the mechanism buttons play the real part motion. |
| Connection | Reconnecting | The top banner P9; the attempt count P4; on reconnect it leaves and a green "Back" chip P7 shows for 1.2 s. |

### 4.2 Phone (landscape 812×375, thumbs, notch). Owner: the phone UI agent.

The same tokens and patterns, with these phone rules:
- distances × 0.7 (`--m-rise: 10px`);
- no hover states;
- every press gives P8 within one frame;
- nothing animates under a thumb that is holding a control.

| Screen or element | Trigger | Motion |
|---|---|---|
| Phone HUD dials | Start of match | HP and fuel arcs draw in from 0 over `--m-slow` (P10). |
| Move and aim sticks | Touch down | The base fades to full and the knob follows the thumb raw; release springs the knob home on `--ease-settle`. |
| Arc buttons (shield, reload, dash, grenade, melee) | Press | P8 at once; cooldown buttons show a sweep (P10) and a P7 tick when ready. |
| Grenade (hold) | Hold, aim | The throw ring around the aim stick fills raw from `--throw`; the arc appears in the world; a tap shows the quick stamp. |
| Swap pill | Swap | Both gun thumbnails cross like the desktop slot cards over the equip time; the ring is P10. |
| Take button (near a crate) | Crate in reach | The button grows in from 0.6 scale at its arc place (P7); it leaves by shrinking when out of reach. |
| Kill feed (compact) | A kill | Enters from the right inside the safe area, one line, `--m-fast`. |
| Phone menus (home, lobby, pause, results, Locker) | Navigation | The same P1, P2 and P3 as desktop at phone distances; bottom sheets rise on `--ease-arrive` and drop on `--ease-leave`. |
| Layout editor | Drag a control | The control lifts (scale 1.06 plus shadow) and follows the finger raw; drop settles with `--ease-settle`; snapping guides fade in at `--m-fast`. |
| Share (phone) | Tap Share | P8, then `navigator.share`; on return, a P7 "Shared" chip. |

## 5. Implementation rules

- **CSS first.** Transitions and keyframes on `transform`, `opacity` and `filter` only; never on `width`, `height`, `top` or `left` (the reticle and arcs already move by transform). Use `will-change` only while an animation runs.
- **One helper module**, `apps/web/src/ui/motion.ts`, owned by the desktop agent (phase 1):
  - `stagger(el, i)` sets `--i`;
  - `sharedElement(from, to)` does a FLIP via `element.animate`;
  - `rollText(el, next)` does P4 on a text node, with a tabular-figure span per digit;
  - `reduced()` reads Reduce motion.
  - No animation library: the Web Animations API covers it, and the bundle stays small.
- **React screens** use the patterns through class names (`.m-p1`, `.m-p3 [style="--i:3"]`, …) defined once in `kit.css`. The phone agent uses the same classes.
- **The HUD** never transitions values written every frame, such as `--throw`, the reticle or `--dash` while it fills. Only discrete changes get motion.
- **Budgets:**
  - menus hold 60 fps on the Low reference laptop;
  - the HUD's motion costs under 0.1 ms a frame;
  - at most one P6 flood on screen.
- **Checks for every PR:**
  - a frame strip (headless Chrome screenshots every 16 ms) of each new transition, committed as WebP;
  - Reduce motion and Reduce flashes checked;
  - no animation on a value updated every frame;
  - `pnpm check` passes.

## 6. Who owns what

| Area | Desktop UI agent | Phone UI agent |
|---|---|---|
| `ui/kit.css` tokens and pattern classes, `ui/motion.ts` | **Owns** (phase 1) | Uses; asks for additions in the notes |
| `hud/template.ts` desktop section, `hud/hud.ts`, `hud/model.ts` | **Owns** | Reads |
| Phone HUD markup | — | **Owns.** Moves it into `hud/templatePhone.ts` as its first step, coordinated in the notes |
| `touch/**` (sticks, buttons, layout editor) | — | **Owns** |
| `shell/screens/*.tsx` (desktop menus) | **Owns** | — |
| Phone menus (`shell/screens/phone/*`) | — | **Owns** |
| Tune panel, Locker, Armory, world labels | **Owns** | Phone variants of the Locker and pause only |

Shared notes: `ui-playtest-interfaces.md` (desktop) and `touch-interfaces.md` (phone). Post any change to a shared class, token or helper there before using it.
