# Onboarding research: a personalised first-run tour

**Owner, 23 Oct 2026:** after the title screen, "a normal tour … think of plenty ways to curate an onboarding tour experience per user so it feels more intriguing, you can do research that will make this work and be professional, even those guide recommendations and also those button clip-paths that circle things and tells you what to use".

This doc has five parts:

- **What we have today:** read from `origin/main` at `71eb379d` (23 Oct 2026, after the title screen #191 and the creator #175).
- **What the research says:** cited. Sources are at the end. Sources that name other games are listed separately, so they can be moved out before this merges.
- **The tour we should build:** steps per persona and device, triggers, copy tone and visuals.
- **The spotlight component, the "Next orders" recommendation engine and the metrics:** specs and APIs.
- **A phased build plan with acceptance criteria.**

It joins up with [controls-research.md](controls-research.md) §4.10 (the fire-mode chooser and the five-goal First flight of ≤ 90 s) and [touch-controls-v3.md](touch-controls-v3.md) (first-time hints, the 16-step drill). It doesn't replace them. Motion and tokens follow [ui-motion-spec.md](ui-motion-spec.md).

**Naming rule.** Sections 2.3 and 2.4 describe what other games do and name them; this doc is internal. Everything we recommend (sections 0 and 3–7) is in our own words.

---

## 0. Summary: the ten recommendations

1. **Play inside 60 seconds of the title.** Teach by doing, in the range, one goal at a time. The evidence: in a 45,000-player study, tutorials helped only the most complex game, and players learned more from exploring than from reading [O1]. Hints fade from memory in about 20 seconds [O3].
2. **Pick the path with one question, then watch.** Ask "First time in a firefight?" once (two big answers). Detect the device (touch, keyboard and mouse, controller) instead of asking. Let behaviour correct the answer: a recruit who clears the First flight in under 40 s, or gets 3 kills in the first 2 minutes, is promoted out of the recruit hints. A veteran who struggles is offered help.
3. **One spotlight component for every "circle the thing" moment.** A dim layer with an even-odd `clip-path` hole, a volt range-finder ring and a Frost callout. Per the CSS Masking spec, the clipped-out hole is not hit-tested [O44]. So in menus the hole is the only place a click works, with no extra hit-testing code. In play the dim never blocks input.
4. **Never block play.** In the CHI study, restricting what players could press did not help [O1]. In-game steps dim lightly and point; they never trap input. Blocking is only for 2–3 menu stops.
5. **Five goals, ≤ 90 s, then a real match.** Run, fly, hit the target, dash, throw (controls research §4.10). Each goal is ticked by doing it. Then "Live fire": a short first match against Easy bots.
6. **Contextual help after the tour, triggered by struggle.** About a dozen signals the sim already reports (e.g. died to gas twice, never dashed, dry-fired 3 times, missed taps on the phone). The rules: one hint per life, none in combat, each hint at most twice ever, and every hint can be declined.
7. **"Next orders": a short list of recommended next steps on Home.** One primary card and at most two more, chosen by a small, pure, unit-tested scoring function over on-device facts. Each card says why ("You haven't dashed yet"). Player-started guidance completes about twice as often as pop-ups in vendor data [O7].
8. **War tone, few words.** Titles of 1–3 words, bodies of at most 12, no exclamation marks, no praise words, and keys shown as key caps or controller glyphs. "Confirmed", not "Awesome!".
9. **Accessible by default.** Callouts follow the ARIA dialog pattern only when they block. Steps are announced through a polite live region. The tour honours Reduce motion, Reduce transparency and text scale up to 150%, and never auto-advances on a timer. Touch targets are ≥ 44 pt.
10. **Measure it from day one.** An on-device event log with a per-step funnel, the skip rate per persona, time to first kill, and D1/D7 for finishers, skippers and a 10% holdout. It can be shown on the admin page.

---

## 1. What we have today

### 1.1 The first-run flow

| Step | Where | What happens |
|---|---|---|
| Title | `shell/screens/Title.tsx` (#191) | Key art; "Press any key" or "Tap anywhere", or any controller button. Skipped for invite links, the debug client and automation (`shell/title.ts`). |
| Name | `NameEntry.tsx` / `PhoneNameEntry.tsx` | Asked before anything that needs the API. Offline: training only, with a local name. |
| Create your soldier | `creator/` (#175), opened from `main.ts` | Once per device after the first name screen (`mf-creator-seen`). Skippable. Body first, then the look, on a live turntable. |
| Home | `Home.tsx` / `PhoneHome.tsx` | Create room, Local (same Wi-Fi), Join with code, Training. Tabs for Locker, Armory, Settings. |
| First game | `shell/controller.ts firstTips()` | The **controls card** (`TipsCard`, `PhoneTips`) shows the first time a player gets into any game (`tips.seen.v1`). In a lobby it waits for the warm-up; it never covers the countdown. |
| Map loading | `shell/mapLoading.ts` | Three field tips, at random, in the player's own keys. |
| Training | `localMode.ts`, `localBots.ts` | A deathmatch against 3 Normal bots. `?sandbox` gives the range dummies instead. Bot levels: easy, normal, hard. |

### 1.2 Teaching today

- **The controls card:** 14 rows of actions with key caps, then 6 tips, "Got it" and "Change keys".
  - It is one wall of text, shown once. Research puts the limit at about 3 items in learning mode [O6], and players read at most 20–28% of the words on a page [O2].
  - It is the only teaching on desktop and controller.
- **Touch first-time hints** (`touch/teach.ts HINTS`): 5 chips next to a control the first time it can do something new (swipe to dash, swipe to change grenade, hold for the radial, take a gun, hold the shield). Each shows once per phone, and the matching action clears it.
- **"Learn the controls"** (`touch/teach.ts DRILL`): 16 goals, one at a time, ticked by doing them.
  - The target control pulses (`.mf-teach`).
  - It starts by itself in the first Training on a phone, and again from Settings → Touch.
  - Touch only.
- **Planned, not built:**
  - the fire-mode chooser and the five-goal First flight (controls research §4.10, priority item 8);
  - the Claw suggestion;
  - on-device metrics.

### 1.3 Gaps the tour must close

1. Desktop and controller players get a static card and nothing else.
2. There's no personal path. A veteran sees the same card as a first-timer, and an invited friend lands in a lobby with no help.
3. There's no spotlight component. The only "circle the thing" is the touch drill's pulse, and nothing points at the HUD (fuel, dash ring, belt) or at menus.
4. There's nothing to do after the first game: no recommendations, no checklist, no replay except the touch drill.
5. Nothing is measured. There's no analytics plumbing in the client or the API (`stats.ts` only keeps the FPS and ping readouts).

**What we can build on:**

- `Drill`, a pure, tested step model that ticks by action.
- `TouchAction`, the controller's own report of what the player did.
- `HudInput.toScreen`: world-to-screen positions, already used by `hud/worldTags.ts`.
- `logicalRect`/`logicalPoint`: the rotated phone page's geometry.
- The sandbox range with dummies, bots at three levels, and the device-aware key caps (`useShownControls`, gamepad glyph families).

---

## 2. What the research says

### 2.1 Evidence on tutorials and text

**The CHI 2012 tutorial study [O1].** Andersen et al. ran a multivariate test with more than 45,000 new players across three games of rising complexity. Each tutorial varied by:

- whether it existed at all;
- context-sensitive versus up-front;
- whether it blocked other input ("freedom");
- whether on-demand help was available.

Findings:

- **Tutorials paid off only in the most complex game.** There, context-sensitive tutorials gave 75% more levels and 29% longer play than none, and 40% more levels than an up-front manual. In the two simpler games they made no significant difference, and one even had 3.5% fewer players returning.
- **Restricting freedom didn't help:** "no evidence supporting the practice of restricting player freedom in order to focus player attention on target interface objects."
- **On-demand help was little used.** Only 31% of players who had a help button ever used it, and in one game it lowered completion.
- **The authors' summary:** "players seem to learn more from exploring than from reading text."

Our game is more complex than a puzzle game: 8-way fuel dashes, a jetpack, 6 grenade types, 19 guns and a shield. That puts us where context-sensitive teaching pays.

**How little people read.**

- On the web, users read at most 28% of a page's words, and 20% is more likely [O2].
- Coach-mark information "fades in about 20 seconds", so show each mark "as the user reaches the relevant section" and "focus on a single interaction" [O3].
- Deck-of-cards tutorials "strain user's memory" and are frequently skipped [O4][O5].
- NN/g's distinction [O5]:
  - **push revelations:** shown out of context, which work poorly;
  - **pull revelations:** "help content triggered by some signal", which work better.

**In games.** Celia Hodent's GDC talk on onboarding [O6]:

- players "WON'T read it if there's too much information";
- teach "when they can actually do it" (learning by doing);
- "3 items to process at the same time is THE MAXIMUM";
- "Avoid punishing states during onboarding", because players who die during onboarding are less likely to stay.

**How long a tour can be (vendor data, labelled as such).**

- Across 550M+ in-app tour interactions, "tours beyond five steps lose attention from more than half of users" [O7].
- Tours the user starts complete at 67%, versus 31% for tours that start by themselves [O7].
- Tours started from a checklist complete at 64% [O8].
- The average tour completes at 33.5% [O8].

**Retention benchmarks (vendor).**

- Mobile games: the top 25% reach a little over 30% D1 and the top 10% about 40%; the median D7 is just under 4% [O9]. These figures have no genre split.
- A first-session rule of thumb is that the player should "understand why your app is great within two to three minutes", and every tutorial step should be tracked as a funnel [O10].
- A major studio reports new players dropping off at each step up: tutorial → co-op vs bots → player vs player [G13].
- I found no primary-source "X% quit during the tutorial" figure for a named game. The figures that circulate on vendor blogs have no traceable source, so this doc doesn't use them.

### 2.2 Patterns that work

| Pattern | What it is | When it fits us |
|---|---|---|
| **Spotlight / coach mark** | Dim everything but one control, ring it, explain in one line | One new control at the moment it matters; 2–3 menu stops. Not a tour of every button. |
| **Progressive disclosure** | Show controls and options as they become useful | The touch hints already follow this rule (the grenade-swipe hint only once there are two types; Take only next to a gun), and controls research §4.2 adds a context slot that appears when needed. |
| **Contextual first-encounter hints** | A one-line chip the first time something is possible | Already for 5 touch actions; extend to desktop and pad. |
| **Interactive "do it" steps** | A goal ticked by the action, not by "Next" | Every First flight goal. Better than slides [O1][O6]. |
| **Checklists** | A short visible list of milestones | The "Field manual" (6 items) on Home: tours launched from a checklist complete at about twice the rate [O8]. |
| **Recommended-next-step cards** | "What to try next", with a reason | "Next orders" on Home (§5). Player-started guidance completes about twice as often as auto-started [O7]. |
| **Skip, resume, replay** | Always a way out, a way back, and a way to see it again | Required by accessibility guidance: "Allow all narrative and instructions to be replayed" and "On-demand tutorials" [O32][O34]. |
| **Struggle-triggered help** | Offer help after repeated failure | §3.6. Simple signals beat clever classifiers (below). |

### 2.3 How shooters onboard new players

| Game | First session | Bots | Practice space | Gating | Veterans |
|---|---|---|---|---|---|
| A mobile military shooter | The tutorial runs straight after account creation: "an interactive briefing on the game's basic controls" on a firing range. Players choose **Simple** (auto-fire on target) or **Advanced** controls [G9] | Early matches widely reported as bot-heavy (press only) | Firing range | Battle royale after "a few more" multiplayer matches [G9] | — |
| A tactical hero shooter | Since patch 9.02, "all new players will be required to play through the tutorial", with an optional bot match [G5] | Bot Training Match | The Range, any time | Competitive at account level 20 to "force this learning period" [G3] | Practice menu for replays |
| A team hero shooter | First-time experience with modes and chat unlocking quickly [G2] | "AI-controlled opponents in the first five opening matches of Quick Play" (Jan 2025) [G1] | A practice range (unverified) | Matches needed to unlock modes cut from 10 to 5 [G1] | Accounts with "clearly experienced performance" seeded higher: a skip by **behaviour**, not a question [G1] |
| A hero battle royale | Orientation matches: a full match with AI bots for first-timers, graduating by a win, top 5, or 10 basic challenges [G6] | Yes | A firing range (unverified) | Graduation | — |
| A building battle royale | Bots "behave similarly to normal players"; fewer bots as skill rises; none in competitive [G7] | Yes, by skill | Not researched | — | — |
| A console arena shooter | Academy: a tutorial, weapon drills in tiers, bot training [G8] | Yes | Weapon drills | — | Optional |
| A family team shooter | The ranked mode unlocks at level 10 [G11] | — | A test range (unverified) | Level | — |
| A tactical siege shooter | Situations: 11 offline scenarios [G12] | Offline AI | Situations | (Newcomer playlist later removed) | — |

**The patterns, in our words:**

- The first minute is played, not read.
- The first real matches are softened with bots, and players graduate by doing well.
- A practice space is always one tap away.
- Veterans are recognised by how they play more than by what they say.
- On phones, the fire-control choice is made up front.

### 2.4 Personalisation without a questionnaire

- **Ask little, and don't trust the answer alone.**
  - A language app asks one question: "Start from scratch" or "Find my level", with an adaptive placement test [O13].
  - A study of its users found many pick "beginner" despite years of study (seen only in a search summary; unverified).
  - The shooter in §2.3 seeds experienced new accounts from their play [G1].
  - **Our design:** one question plus behaviour.
- **Struggle-triggered help, with care for pride.**
  - A platformer's assist block appears after a player "has failed to pass a level at least eight times" [G14]. Its designers debated 3, 5, 8 and 10 [G15].
  - A climbing game renamed "Cheat Mode" to "Assist Mode" because the old name felt "judgmental" [G16].
  - An action game added a "Reduced Puzzle Hints" option because companions hinted too early [G17].
  - Racing-game telemetry from 200,000+ players found a model could predict when a player was ready to turn an assist off, with 60–90% precision [G18].
  - Dynamic difficulty adjustment in a shooter goes back to Hunicke's 2004 Hamlet system [O14].
- **Struggle detection is weak.** A real-time struggle detector reached an AUC of 0.635 [O16]. So trigger help on simple, explainable signals (deaths by cause, unused moves), and always let the player decline it.
- **Device-aware glyphs.**
  - Apple: "use labels and glyphs that match the one that the player is actively using" [O17].
  - Steam Deck: "On-screen glyphs must match the inputs being used"; keyboard glyphs are not shown when they are not the active input [O20].
  - On the web, some browsers expose a gamepad only after the user presses a button with the page visible [O21]. `any-pointer` can match coarse and fine together [O22].
  - So a pad is known at its first press, and the device can change mid-tour. We already switch key caps live (`useShownControls`).

### 2.5 Accessibility

| Rule | Source | What it means for the tour |
|---|---|---|
| Modal dialog pattern | APG [O23] | A **blocking** callout (menus only) gets `role="dialog"`, `aria-modal="true"`, a label, focus on its first control, Tab wrapping, Escape to close, and focus back to where it came from. |
| `inert` | MDN [O24] | Inert content gets no clicks or focus and leaves the accessibility tree. **Nothing inside an inert subtree can escape it**, so we inert the *sibling* subtrees along the path to the target, never an ancestor of the target. |
| Top layer | MDN [O25][O26] | A `popover="manual"` element sits above the canvas and the HUD without z-index fights. The Popover API has been Baseline since January 2025. |
| 1.4.3 / 1.4.11 contrast | WCAG 2.2 [O27] | Text 4.5:1; the ring and focus marks 3:1 against what's around them. Volt `#d6ff3b` on ink `#070806` is far above both. |
| 1.4.4 / 1.4.10 | [O27] | Text resizes to 200% without loss, and nothing scrolls two ways at 320 px wide or 256 px high. Our Settings text scale goes to 1.5. |
| 2.2.1 Timing adjustable | [O27] | **No step advances on a timer.** Time-outs only *offer* a skip. |
| 2.3.3 Animation from interactions | [O27] | The ring's pulse and travel turn off under Reduce motion. A zooming spotlight is a known vestibular trigger [O30]. |
| 2.4.11 Focus not obscured | [O27] | The callout never covers the focused target. |
| 2.5.8 Target size | [O28] | At least 24×24 CSS px everywhere; on phones we use 44 pt (below). |
| 4.1.3 Status messages | [O29] | Step changes are announced through a polite live region, without moving focus [O31]. |
| Game Accessibility Guidelines | [O32] | "Include interactive tutorials"; "Allow players to progress through text prompts at their own pace"; "Include a means of practicing without failure"; "Ensure no essential information … is conveyed by text alone"; "Allow all narrative and instructions to be replayed". |
| Xbox Accessibility Guidelines | [O33][O34] | Mobile body text about 18 px at 100 DPI, with text scaling to 200%. Tutorial content "can be replayed at any time from an accessible menu". |

### 2.6 Phone constraints

- **Thumbs own the bottom corners.**
  - "Place frequently used buttons near a player's thumb, avoiding the circular regions where players expect movement and camera input to happen. Place secondary controls, like menus, at the top of the screen" [O17].
  - Avoid the Home indicator and the Dynamic Island [O17].
  - **Callouts and the Skip button therefore sit top-centre, inside the safe area, never over a thumb dial.**
- **Target sizes.**
  - Apple: 44×44 pt for frequent controls and 28×28 pt for minor ones [O17][O18].
  - Android: 48×48 dp with 8 dp gaps [O19].
  - Corner targets need about 12 mm, versus about 7 mm in the centre [O35]. Hoober's studies are portrait; no rigorous landscape two-thumb study was found.
  - Our phone spec already works in mm (controls research §4.1).
- **Notches and safe areas.** Use `env(safe-area-inset-*)` with `viewport-fit=cover` and a `max()` fallback padding [O37][O38]. The landscape page is rotated on an upright phone (`ui/landscape.ts`): every spotlight rectangle comes from `logicalRect()`, or it lands in the wrong place.

### 2.7 Building spotlight cutouts on the web

**How the main tour libraries do it** (source read on GitHub):

| Library | Cutout | Following the target | Click-through |
|---|---|---|---|
| Driver.js [O39] | One full-viewport SVG path, `fill-rule: evenodd`: the viewport rectangle plus a rounded-rect sub-path | Window resize and scroll, coalesced to one refresh per frame; a 400 ms eased transition rewrites the path each frame; MutationObserver for late targets; no ResizeObserver | `.driver-active *` gets `pointer-events: none` and the active element `auto`; capture-phase listeners stop events for its own UI |
| Shepherd [O40] | SVG path: outer rect plus one opening per target (several holes possible), wound opposite so even nonzero fill works | A requestAnimationFrame loop **every frame** while a step is up; holes clipped against scroll parents | Container `pointer-events: none`, the dim path `all`; an option blocks the target too |
| Intro.js [O41] | A helper div with a `box-shadow` spread of 5000 px | Window resize only | A transparent div over the target swallows clicks |
| React Joyride v2 / v3 [O42] | v2: `mix-blend-mode: hard-light` with a grey hole (box-shadow on Safari); v3: SVG path with even-odd fill | v3: ResizeObserver plus passive scroll listeners, debounced 100 ms | v2: hit-tests the mouse position on mousemove, so it's poor on touch; v3: the dim path's `pointer-events` toggles blocking |
| Reactour [O43] | SVG `<mask>`: white window, black hole | Resize only, plus opt-in observers | A separate `<clipPath>` polygon defines the click area |

**Techniques compared:**

| Technique | Hit-testing | Cost | Verdict |
|---|---|---|---|
| `clip-path: path(evenodd, …)` on a full-screen dim `div` | **"pointer-events must not be dispatched on the clipped-out (non-visible) regions"** [O44]: the hole passes clicks; the dim blocks them | One layer; repaints only when the path changes | **Use this.** |
| `mask` / `mask-composite: exclude` | "has no effect on the geometry or hit-testing" [O44]: the transparent hole still blocks | Same paint cost | Needs separate blockers; avoid. |
| SVG `<path>` / `<mask>` overlay | Path fill hit-tests like the visual | The same | Fine too (what most libraries do); more DOM. |
| `box-shadow: 0 0 0 9999px` | The hole isn't real: the element covers the target | Huge paint area; animating it repaints every frame [O50] | Avoid. |

**Performance on phones.**

- Only `transform` and `opacity` are guaranteed to run on the compositor [O47].
- Composited clip-path animation was "slated" in Chrome in 2021 [O48]. In January 2026 a Chromium engineer wrote that it is "getting close to launching" [O49], and WebKit's bug is still open. Whether it has shipped in stable is unverified.
- So assume a clip-path animation repaints the full-screen layer every frame on Safari and probably elsewhere.

**Rules:**

1. Write the path only when the step changes, the viewport resizes, or the target really moves (more than 2 px). Never per frame while static.
2. Move the **ring** with `transform` (composited), and size it only at step changes.
3. Between steps in play: fade the dim out (opacity), travel the ring, write the new path, fade back. In menus on desktop, a 360 ms `clip-path` transition is fine.
4. Build every hole with **the same path commands** (a rounded rectangle: `M H A V A H A V A Z`; a circle is a rounded square with r = w/2). Path interpolation needs matching command lists. I didn't re-verify the spec's interpolation rule, so this is a design rule we test.
5. No `backdrop-filter` on the full-screen dim. Blur only the small callout, and none under Reduce transparency or on Low.

**Following a moving or animated target.**

- **DOM targets:** a `ResizeObserver` on the target, window `resize`/`orientationchange`, and capture-phase passive `scroll`. Run a requestAnimationFrame follow loop **only while the target is moving**: from `transitionrun`/`animationstart` until `transitionend`/`animationend` plus 100 ms.
- **Late targets:** a `MutationObserver`, with a time-out that skips the step gracefully.
- **Targets in the 3D world** (the player, a dummy, a gun on the floor):
  - project the world point through the camera each frame, the same maths as the three.js "align HTML to 3D" guide [O56];
  - hide it when |z| > 1 or off-screen and show an edge arrow instead, as `hud/worldTags.ts` already does through `HudInput.toScreen`.
- **Positioning the callout.**
  - CSS anchor positioning has been Baseline "newly available" since January 2026: Chrome 125, Safari 26, Firefox 147 [O51][O52][O53].
  - But `transform` didn't move the anchor box in the 2025 draft; the CSSWG resolved to change that in July 2025 [O54], and what browsers ship may lag.
  - Our targets move by transform (the HUD, world tags), so **position the callout in JS** with a flip/shift routine. This is what Floating UI's `autoUpdate` does; its own docs warn it can cause "severe performance degradation" if not cleaned up [O55].

**Click-through rules.** Blocking mode lets only the highlighted control work. That is enough for menus. In play, the input isn't DOM clicks at all:

- the keyboard goes to the window;
- the touch controller owns its own layer;
- the pad is polled.

So in-game steps never block. We follow the CHI finding [O1], and the dim layer gets `pointer-events: none`.

---

## 3. The tour we should build

### 3.1 Principles

1. **Play inside 60 s of pressing the title**, 90 s at most with the creator skipped.
2. **Do, don't read.** Every goal ticks by doing it. Text is one line; the ring and the world marker do the pointing.
3. **One thing at a time, three at most on screen.**
4. **Never trap play.** Blocking only for 2–3 menu stops.
5. **Personal without a questionnaire:** one question, device detection, and behaviour.
6. **Always a way out, a way back and a replay:** Skip on every callout, resume after a reload, and replay from Settings and the pause menu.
7. **War tone:** terse, serious, never childish (owner, 19 Oct: "war, not toy").

### 3.2 The flow

```
Title ─▶ Name ─▶ Create your soldier (skippable, exists) ─▶ Briefing (1–2 cards, ≤ 10 s)
   │                                                        │
   │                                   recruit ─────────────┤──────────── veteran
   │                                                        ▼                  │
   │                               First flight (range, 5 goals, ≤ 90 s)       │
   │                                                        ▼                  ▼
   │                               Live fire: first match vs 3 Easy bots   Home (Next orders:
   │                               (contextual hints only)                  "Live fire vs Normal bots",
   │                                                        ▼               "First flight" optional)
   │                               Debrief on Results (3 lines) ─▶ Home: 3 spotlight stops + Next orders
   │
   └─ invite link (/r/CODE, no title) ─▶ Name ─▶ the room's lobby: a 3-goal First flight inside the
      warm-up (move, fly, hit), paused by the countdown, then contextual hints; Home's stops after the match
```

- **Briefing** (new; one screen, two cards on a phone):
  - **Card 1, all devices.** "First time in a firefight?" with two big answers:
    - **Recruit:** "Show me the ropes".
    - **Veteran:** "I know shooters. Skip training".
    - A line under them: "Playing with: Touch · Change". The device is detected; Change cycles Touch / Keyboard and mouse / Controller.
  - **Card 2, phones only.** The fire-mode chooser from controls research §4.10.1. Auto is preselected ("recommended to start"), each mode has a 2 s looping picture, and a line says "Change it any time in Settings → Touch".
  - **Veterans** still see card 2: the fire mode is a preference, not a lesson.
  - **A link "Skip all training"** goes to Home with the Field manual unticked.
- **First flight** (recruits): the sandbox range with dummies, local, offline-capable. It replaces the 16-step drill as the first-Training default. The drill stays under Settings → Touch → "Learn every control". Steps in §3.4.
- **Live fire:** a local deathmatch against **3 Easy bots**, first to 5 kills or 3 minutes. No up-front text, contextual hints only (§3.6). The first kill stamps "First kill · confirmed" (P7).
- **Debrief:** three lines on Results:
  - one thing done well, from the match facts ("6 kills · 2 with grenades");
  - one thing to try ("You didn't dash: dashes dodge fire");
  - the top Next orders card.
- **Home stops** (first arrival on Home after Live fire; blocking, skippable, 3 stops):
  1. **Create room:** "Play with friends. Share the code."
  2. **Join with code:** "Got a code? In here."
  3. **Locker:** "Your kit. Change it any time."

  Then the Next orders panel takes over.

### 3.3 Personas and how each is chosen

| Persona | Chosen by | Path | Behaviour that changes it |
|---|---|---|---|
| **Phone recruit** | Touch detected + "Recruit" | Fire mode → First flight (touch) → Live fire (Easy) → Home stops | First flight < 40 s, or 3 kills in the first 2 min of Live fire → promoted (recruit hints off, Normal bots offered) |
| **Phone veteran** | Touch + "Veteran" | Fire mode → Home; "Live fire vs Normal bots" on top | ≥ 6 missed taps or ≥ 8 deaths with ≤ 1 kill in a first match → offer First flight and the Claw/layout editor |
| **Desktop recruit** | Fine pointer + keyboard + "Recruit" | First flight (keys) → Live fire → Home stops | As phone recruit |
| **Desktop veteran** | Fine pointer + "Veteran" | Home; Live fire vs Normal on top | As phone veteran (without missed taps) |
| **Controller player** (recruit or veteran) | First pad button press, at any step (the tour swaps glyphs live) | As desktop, with glyphs; the controller preset card (Standard / Bumper Jet / Southpaw) offered once | Pad stick hops or long jet-key holds → controller preset card |
| **Invited friend** | Arrived by `/r/CODE` (no title, no briefing) | Name → lobby → 3-goal flight in the warm-up → hints in the match → Briefing card offered on Home after the match | As above once on Home |

**Notes:**

- **Device:** `isTouchDevice()` (`touch/index.ts`, pointer coarse) on first load; a pad from its first button press (§2.4); a fine pointer plus a key press means keyboard and mouse. A tablet with a keyboard follows the last input used.
- **Goal:** inferred, not asked. An invite link means "play with friends", and Home then leads with Create room. Otherwise "quick fight".
- **Experience:** asked once, then corrected by play. A promotion or a help offer is logged, and the player can undo it from Settings → Accessibility → Tips ("Recruit hints: on/off").

### 3.4 First flight: the steps per device

Five goals in the range, about 90 s (controls research §4.10.2). Each goal:

- puts a **non-blocking spotlight** on the control (touch) or the HUD element it uses (desktop, pad), with dim 0.28;
- puts a **world marker** where it matters (a dummy, a ledge);
- shows one line with the input in key caps or glyphs.

It ticks on the action and stamps "Confirmed" (P7, 600 ms).

| # | Goal | Touch: ring on, done when | Keyboard and mouse: ring on, done when | Controller: ring on, done when |
|---|---|---|---|---|
| 1 | **Run** | Move dial; `TouchAction 'move'` held for 1 m of travel | A world marker 6 m ahead; travel 3 m with Left/Right (`A`/`D` caps shown by the soldier) | The left-stick glyph by the soldier; travel 3 m |
| 2 | **Fly** | Move dial (push up), then the **fuel ring** in the HUD with one pulse, no text about fuel | The `.bar--fuel` plate and the Jet key cap; reach the marked ledge 4 m up | The fuel plate and the jet glyph (LT on Standard, A on Classic); reach the ledge |
| 3 | **Hit the target** | Aim dial, in the chosen fire mode; done on 3 hits on a dummy | A ring on the dummy (world target); 3 hits | The right-stick glyph and the dummy; 3 hits |
| 4 | **Dash** | Dash button (swipe any way) or a flick; done on `'dash'` | The `.dash` ring plate and the Dash key, plus "a direction"; done on a dash | The dash glyph; done on a dash |
| 5 | **Throw** | Grenade button (hold, aim, let go); done on `'aimed-throw'` | The `.belt` plate and the Grenade key; done on a throw that lands within 3 m of a dummy | The grenade glyph; done on a throw |

**Rules:**

- **Time-outs only offer help.** After 20 s on one goal, the callout adds a second line ("Push the left dial up and hold") and a "Skip this" link. Nothing auto-advances (WCAG 2.2.1).
- **No punishing states** [O6]. The range has no live enemies, and a fall respawns at the last ledge.
- **Pause and resume.** Opening the menu pauses the tour. The pause menu gets "Skip training" and "Restart First flight".
- **Progress is saved per goal** (`mf.tour.v1`). A reload resumes at the next unticked goal.
- **Invited friends** do goals 1–3 in the lobby warm-up. The countdown pauses the tour; goals 4–5 move into contextual hints.
- **On finishing:** "First flight complete · 74 s" stamps (P7), with a "Live fire" button (volt) and "Later" (ghost). Live fire starts by itself after 3 s only if the player has touched nothing, and the countdown can be cancelled.

### 3.5 Home and lobby stops (blocking mode)

| Where | Stop | Copy | When |
|---|---|---|---|
| Home | Create room | **Play with friends.** Share the code. | First Home after Live fire (or first Home for veterans) |
| Home | Join with code | **Got a code?** In here. | Same pass |
| Home | Locker tab | **Your kit.** Change it any time. | Same pass |
| Lobby | Ready | **Ready up.** The match starts when all are set. | Idle 20 s in a first lobby, not ready |
| Lobby | Invite / code | **Bring a squad.** Share this code. | First lobby you host |
| Results | Play again / Next orders | (the Debrief lines) | First Results |

Each pass is at most 3 stops, with "Skip" on every callout and Escape or the pad's B to skip the pass.

### 3.6 Contextual help: the triggers

Signals come from the sim events and frames the HUD already reads. The trigger engine is pure and unit-tested (`tour/hints.ts`), and extends `touch/teach.ts` HINTS to every device.

| Signal (per player, on device) | Help offered | Where it points | Max |
|---|---|---|---|
| Died in toxic gas twice in one match | "**Gas.** The middle kills. Cross the edge fast, or fly over." | Ring on the gas cloud's edge (world) for 2 s | 2 ever |
| Ran out of fuel in the air and fell twice | "**Fuel.** Refills on the ground, faster than in the air." | The fuel plate, one pulse | 2 |
| No dash in 2 matches | "**Dash.** Dodges fire. Costs fuel." + key cap / glyph / swipe | Dash ring or dash button | 2 |
| No grenade in 2 matches | "**Grenade.** Tap to throw, hold to aim." | Belt or grenade button | 2 |
| Killed by own grenade | "**Hold to aim.** The arc shows where it lands." | Belt or grenade button | 1 |
| Fired an empty magazine 3 times | "**Reload early.**" + key | Ammo plate or reload button | 2 |
| Stood near a gun 3 times, never took one | "**Take it.**" + key (the touch hint exists) | The world tag of the nearest gun | 2 |
| Phone: ≥ 6 missed taps in a match (a touch within 4 mm of a button's edge on empty space; controls research §4.10.4) | Next orders card: "**Bigger buttons?** Try the Claw layout or move them." | Home card, not in play | 1 per 7 days |
| Phone: ≥ 20 right-thumb hops in each of 3 matches | Claw suggestion (controls research §4.10.3) | Home card | 1 |
| ≥ 8 deaths and ≤ 1 kill in a first match | Debrief: "**Easier start?** Easy bots, or turn aim assist up." | Results | 1 per 3 matches |
| 3 kills in the first 2 min, or First flight < 40 s | Promotion: recruit hints off; "**Ready for more.** Normal bots or a real room." | Results / Home | once |
| 14+ days since the last session | "**Refresher?** Replay First flight." | Home card | once per return |

**Rules** (all unit-tested):

- One hint per life.
- None in the first 5 s after a spawn.
- None within 3 s of taking or dealing damage.
- None in the countdown.
- Each hint at most the "Max" in the table.
- Every hint has "Don't show tips" (Settings → Accessibility → Tips) and is listed in the pause menu's Field manual for replay.
- Hints never blame: "The middle kills", not "You keep dying to gas".

### 3.7 Copy and tone

- Titles are verbs or nouns, 1–3 words, in the stencil display face: **Fly.** **Dash.** **Your kit.**
- Bodies are ≤ 12 words, imperative, present tense: "Hold Jet. Watch the fuel ring."
- No exclamation marks, emoji, "Awesome", "Great job" or "Let's". Success is a stamp: **Confirmed**.
- Briefing register, kept plain: Briefing, Orders, Debrief, Field manual.
  - Avoid radio slang that a new or non-native player won't parse ("Copy that", "Roger").
  - Buttons say what they do: Continue, Skip training, Live fire, Later.
- Inputs as key caps (the player's own bindings via `capText`), glyphs for pads, and pictograms for touch gestures. Never "press the button".
- Numbers as numerals: "3 hits", "74 s".
- All copy in one table (`tour/copy.ts`), ready for translation.

| Don't | Do |
|---|---|
| "Awesome! You did it! Now let's learn how to fly!" | **Fly.** Hold `Space`. |
| "Tap here to customise your character's look!" | **Your kit.** Change it any time. |
| "Oops, you keep dying to gas. Try to avoid it." | **Gas.** The middle kills. Cross the edge fast. |
| "Congratulations on your first kill!!" | **First kill** · confirmed |

### 3.8 Visuals (Field Print with Frost)

- **Dim:** `--c-ink-950` at 60% (menus, blocking), 28% (play) or none (hint chips).
- **Ring, "range-finder":**
  - a 2 px `--c-volt` (`#d6ff3b`) stroke following the hole's shape (circle for dials and the dash ring, rounded rect for plates and buttons, 6 px padding);
  - four short brass (`--c-brass`) corner ticks outside it, like a scope's reticle;
  - an 8 px volt glow at 30%.
  - **Pulse:** scale 1 → 1.06 and opacity 1 → 0.6 over 1.4 s, three times, then still. Off under Reduce motion.
- **Callout:** a Frost card (`--frost-fill`, `--blur-frost` 20 px, `--frost-line`, corner shape `--r-frost-sm`).
  - It contains:
    - a brass stencil eyebrow ("ORDERS · 2/5");
    - a display title in paper;
    - one body line in the UI face at `--fs-16` × text scale (phone at least 14 px);
    - key caps (`Kbd`);
    - Skip (ghost) and an optional primary (volt).
  - A stencil chevron points from the callout to the ring.
  - Under Reduce transparency the fill is solid (`ui/frost.css` already does this).
- **Progress:** five pips; the ticked ones fill volt with the P7 stamp.
- **Motion (ui-motion-spec tokens):**
  - the callout enters with P1 focus pull (`--m-slow`, `--ease-arrive`);
  - the ring travels between targets on `--m-scene`, `--ease-travel`;
  - "Confirmed" uses P7;
  - the callout leaves with P9's exit (`--ease-leave`).
  - Under Reduce motion everything becomes an opacity change of ≤ 120 ms.
- **Placement:** desktop beside the target (flip/shift inside the safe box). Phone top-centre in the safe area, never over a thumb dial. The chevron reaches down to the ring.

---

## 4. The spotlight component: spec and API

A tour-agnostic UI part, usable from the React shell, the plain-DOM HUD and the touch overlays.

- **Files:** `apps/web/src/ui/spotlight.ts` (vanilla class), `ui/spotlight.css`, and `ui/useSpotlight.ts` (React hook).
- **Owner:** the desktop UI agent, with the phone agent for touch targets.

### 4.1 Structure

```
<div class="mf-spot" popover="manual">          top layer: above the canvas, the HUD and the touch layer
  <div class="mf-spot__dim" />                   full-viewport; clip-path: path(evenodd, "outer + holes")
  <div class="mf-spot__ring" />                  positioned by transform; one per hole
  <section class="mf-spot__callout frost" role="dialog | group" aria-labelledby=… aria-describedby=…>
    eyebrow · title · body · keys · [Skip] [primary]
  </section>
  <p class="sr-only" aria-live="polite" />       "Step 2 of 5. Fly. Hold Space."
</div>
```

### 4.2 Behaviour

| Mode | Dim | Pointer | Keyboard and pad | Use |
|---|---|---|---|---|
| `block: 'outside'` | 60% | The dim blocks; the hole passes (clip-path hit-testing [O44]); the callout is live | Focus on the target; sibling subtrees `inert`; Tab cycles target ↔ callout; Escape skips the pass | Menus (Home, lobby, results) |
| `block: 'none'` | 0–28% | Dim `pointer-events: none`; nothing is blocked | The game keeps every key and button; the callout's Skip by pointer, or the pause menu; the pad's View held 1 s skips the step | In play |

- **Shapes:** `circle`, `rect` (rounded, radius from the target's computed `border-radius`), `pill`, or `auto`. Several targets at once means several holes in one path (e.g. the fuel plate and the dash ring together).
- **Geometry:** from `logicalRect()` (the rotated phone page), inflated by `padding` (default 6 px), then clamped to the safe box.
- **Following:** as in §2.7.
  - Static targets cost nothing per frame.
  - A moving target runs one rAF loop until it settles; the loop rewrites the path only when the hole moved more than 2 px.
  - World targets are polled from the game loop through a provider, with an edge arrow when off-screen.
  - Hidden targets fade the ring; after `timeoutMs` the step offers Skip.
- **Transitions:**
  - in menus on desktop, `transition: clip-path var(--m-slow) var(--ease-travel)`, safe because every hole uses the same command list;
  - in play and on phones, a fade of the dim, a ring travel by transform, and a fade back;
  - under Reduce motion, opacity only.
- **Performance budget:**
  - 0 rAF callbacks while static;
  - ≤ 0.2 ms of script per frame while following;
  - one path write per step change.
  - No `backdrop-filter` on the dim. On Low graphics the callout's blur is off.

### 4.3 API

```ts
export type SpotTarget =
  | { kind: 'element'; el: Element | (() => Element | null) }
  | { kind: 'selector'; selector: string }                 // e.g. '[data-tour="fuel"]'
  | { kind: 'touch'; control: ControlId }                   // the touch controller's control rect
  | { kind: 'world'; point: () => { x: number; y: number } | null } // logical px, null = off screen
  | { kind: 'rect'; rect: () => DOMRectReadOnly | null };

export interface SpotStep {
  id: string;
  target: SpotTarget | readonly SpotTarget[];
  shape?: 'auto' | 'circle' | 'rect' | 'pill';
  padding?: number;                 // px, default 6
  eyebrow?: string;                 // "ORDERS · 2/5"
  title: string;                    // 1–3 words
  body?: string;                    // ≤ 12 words
  keys?: readonly ActionId[];       // shown as the player's own caps or glyphs (live device switch)
  place?: 'auto' | 'above' | 'below' | 'left' | 'right' | 'top-centre';
  block?: 'outside' | 'none';       // default 'none'
  dim?: number;                     // 0..1, default 0.28 ('none') / 0.6 ('outside')
  primary?: { label: string; run(): void };
  skippable?: boolean;              // default true
  timeoutMs?: number;               // offer Skip after this long (never auto-advance)
}

export class Spotlight {
  constructor(opts?: { root?: HTMLElement; reducedMotion?: () => boolean; safeBox?: () => Box });
  show(step: SpotStep): void;       // first show, or move to a new step (animated per §4.2)
  update(): void;                   // the game loop calls this when a world target moved
  hide(): Promise<void>;            // leaves with P9's exit
  readonly current: SpotStep | null;
  onSkip: ((id: string, all: boolean) => void) | null;  // Skip, or Skip training
  onPrimary: ((id: string) => void) | null;
  dispose(): void;
}
```

**The tour model** is pure and unit-tested, like `touch/teach.ts Drill`:

```ts
export interface TourStep extends SpotStep {
  done: readonly TourEvent[];   // what ticks it: 'move' | 'jet' | 'hit-dummy' | 'dash' | 'throw' | 'ui:create' | …
  needs?: (f: Facts) => boolean; // skipped by itself when not possible
}
export class Tour {
  constructor(id: TourId, steps: readonly TourStep[], saved?: TourProgress);
  get step(): TourStep | null; get finished(): boolean;
  act(e: TourEvent, facts: Facts): boolean;   // ticks the current step
  skip(all?: boolean): void;
  toJSON(): TourProgress;                     // persisted per goal: mf.tour.v1 (resume)
}
```

**Integration points (no render3d edits needed):**

- **The HUD:** stable `data-tour="fuel|dash|belt|ammo|clock|scores"` attributes on the template's plates (`hud/template.ts`, `templatePhone.ts`).
- **Touch:**
  - `TouchController.controlRect(id)`, a new read-only method;
  - the existing `onAction` stream for ticks;
  - the drill's `.mf-teach` pulse is retired in favour of the ring.
- **World points:** `HudInput.toScreen`, already used by world tags.
- **Ticks from play:**
  - sim events (`hit` on a dummy, `dash`, `throw`);
  - the frame (`jetting`, distance travelled);
  - shell actions.

---

## 5. "Next orders": the recommendation engine

**Goal:** after the first session, Home always shows the one most useful next thing, plus at most two more. Each says why. All of it runs on the device, deterministic, with no server.

**Facts** (`tour/facts.ts`, kept in `mf.facts.v1`, later synced to the account):

- device(s) used, the experience answer and promotions;
- tour progress;
- matches played (local and online) and kills;
- deaths by cause (gas, fall, grenade, self, melee, gun);
- moves used: dash, grenade, swap, shield, take, zoom, melee, aimed throw;
- screens visited: Locker, Creator, Armory, Settings tabs, layout editor;
- rooms created, joined and hosted locally;
- fire mode, preset and aim-assist level;
- touch counters (missed taps, right-thumb hops);
- last session date;
- dismissed cards with dates.

**The catalogue** (each card: title, one line, reason, action, eligibility, priority):

| Card | Eligible when | Base priority |
|---|---|---|
| Finish First flight | Started, not finished | 100 |
| Live fire vs Easy bots | Recruit, first flight done, < 1 match | 95 |
| Live fire vs Normal bots | Veteran or promoted, < 3 matches | 90 |
| Play with friends: create a room | ≥ 1 match, never created or joined a room | 70 |
| Join with a code | Arrived by invite before, never joined since | 40 |
| Customise your soldier | Creator skipped or never saved | 60 |
| Try dashing / grenades / taking guns | The move was never used in ≥ 2 matches | 55 |
| Pick your fire mode (phone) | Default Auto kept and ≥ 3 matches with low hit rate | 45 |
| Try the Claw layout (phone) | The hops or missed-taps signal (§3.6) | 65 |
| Tune your controller | Pad used, preset never opened | 50 |
| Learn every control | Touch, ≥ 3 matches, drill never finished | 35 |
| Headphones mode | Audio settings never opened, ≥ 3 matches | 20 |
| Refresher: replay First flight | 14+ days away | 80 |
| Harder bots | Won 2 matches in a row vs Normal | 60 |
| Host on Wi-Fi (Local) | Offline profile, or ≥ 2 rooms created | 25 |

**Scoring:** `recommend(facts, now): Card[]` is a pure function.

```
score = basePriority × relevance(facts) × novelty × (dismissed in the last 7 days ? 0 : 1)
relevance: 1, raised up to 1.5 by the triggering signal's strength (e.g. 2× the missed-tap threshold)
novelty:   1 for an unseen card, 0.6 shown 3+ times without a tap, 0.3 shown 6+ times
```

- Hard gates come first (offline hides room cards; no pad means no controller card).
- Show the top 1 as the primary card (volt) and up to 2 secondary.
- "Not now" sets a 7-day cool-down; acting on a card retires it.

**The Field manual:** a 6-item checklist on Home. It folds away and can be hidden from Settings.

1. First flight.
2. First kill.
3. First match finished.
4. Your soldier saved.
5. Played with a friend.
6. Every control (optional).

A completed item stamps (P7). With everything done, it folds into a small "Field manual" link.

**Why this shape:**

- Player-started guidance completes about twice as often as auto-started in vendor data [O7][O8].
- Cards with a reason are pull revelations [O5].
- A pure function is testable and explainable, and needs no server.

---

## 6. Metrics

### 6.1 Events (on device first)

| Event | Fields |
|---|---|
| `tour.step` | tour id, step id, persona, device, status (`shown` / `done` / `skipped` / `timeout-offered` / `abandoned`), ms on step |
| `tour.end` | tour id, finished / skipped-all / abandoned, total ms |
| `briefing.answer` | recruit / veteran / skipped; detected device; changed device |
| `promotion` / `help.offered` / `help.accepted` | reason signal |
| `hint.shown` / `hint.acted` | hint id, seconds to act (≤ 30 s counts as acted) |
| `card.shown` / `card.tapped` / `card.dismissed` | card id, rank, score |
| `first.kill` | seconds since the title press; seconds since the first match start |
| `match.end` | local/online, bots level, kills, deaths by cause, moves used |
| `session.start` | days since the first session (for D1/D7 locally) |

**How it's stored and sent:**

- **Storage:** a ring buffer in localStorage (`mf.log.v1`, ≤ 50 KB, try/catch for private mode), plus a dev readout at `?tourlog`.
- **Upload (needs the owner's OK):** opt-in, batched at session end to a new endpoint on **our existing API**. No third party, no IP stored, an anonymous install id.
- **The admin page** (#119) gets an "Onboarding" tab with the funnel per persona and device.

### 6.2 What we watch, and the first targets

| Measure | Target for v1 |
|---|---|
| First flight: started → finished | ≥ 70% |
| First flight median time | ≤ 75 s (cap 90 s) |
| Drop-off per goal | ≤ 10% each; a goal above it gets redesigned |
| Briefing skip rate, by device | Watched, not targeted |
| Time from title press to first kill, recruits | Median ≤ 3 min |
| First session: a match finished | ≥ 60% of new installs |
| Hint acted within 30 s | ≥ 40% per hint; below 20% → rewrite or drop |
| Next orders tap rate | Watched; cards under 5% over 2 weeks are replaced |
| D1 / D7 by path | Finished vs skipped vs **holdout** |

**Experiment design.** Skippers choose themselves, so comparing them with finishers proves nothing, a limitation the CHI paper notes [O1]. Assign **10% of new installs to a holdout**: today's controls card only, no tour. Compare D1, D7, first-session matches and time to first kill between tour and holdout. The 10% is the owner's call (§8).

---

## 7. Build plan

Each phase lands as one PR with tests. Phases 2 and 3 can run in parallel once phase 1 is in.

| Phase | What | Owner | Size |
|---|---|---|---|
| 1 | Facts and event log (`tour/facts.ts`, `tour/log.ts`), `?tourlog` readout | desktop UI agent | S |
| 2 | Spotlight component (`ui/spotlight.ts`), `data-tour` hooks on the HUD, `TouchController.controlRect` | desktop UI agent + phone agent | M |
| 3 | Briefing + First flight on 3 devices; the drill moves under Settings; fire-mode card (controls research item 3) | phone agent (touch), input agent (pad), desktop UI agent (keys, shell) | M |
| 4 | Live fire (Easy bots, first to 5 / 3 min), Debrief lines, Home stops, Next orders + Field manual, the invited-friend lobby path | desktop UI agent + phone agent; bots agent for the Easy settings | M |
| 5 | Contextual hints engine across devices (`tour/hints.ts`), replacing `touch/teach.ts HINTS` | phone agent + desktop UI agent | M |
| 6 | Opt-in upload, the admin funnel and the holdout (after the owner's OK) | API agent + admin page owner | S |

**Acceptance criteria:**

- **Phase 1:**
  - every §6.1 event is recorded with the listed fields;
  - the log stays ≤ 50 KB and survives private mode (writes fail silently);
  - unit tests cover the facts reducer.
- **Phase 2:**
  - the hole and the ring line up within 1 px with their target at 1280×720, 2560×1440, 812×375 landscape and the rotated upright phone;
  - in `block: 'outside'`, a click outside the hole reaches nothing, and inside it reaches the target (a test with `elementFromPoint` and dispatched pointer events);
  - in `block: 'none'`, keyboard, pad and touch play is unaffected (the drill's touch-check harness);
  - zero rAF callbacks while static;
  - Reduce motion means opacity only;
  - text scale 1.5 reflows without overlap;
  - focus order and the live-region announcement are checked in a DOM test;
  - Safari iOS and Chrome Android device check.
- **Phase 3:**
  - every goal can be done without reading the body line (a playtest with the line hidden);
  - median completion ≤ 75 s in a 5-person playtest per device;
  - skip and resume work across a reload;
  - nothing auto-advances;
  - the pad glyphs switch mid-step when a pad is picked up;
  - the drill is still reachable from Settings → Touch.
- **Phase 4:**
  - `recommend()` is deterministic, with table tests for every card;
  - at most 3 cards;
  - "Not now" hides a card for 7 days;
  - Home stops show once and replay from Settings;
  - an invited friend gets the 3-goal flight in the lobby and it pauses at the countdown.
- **Phase 5:**
  - the rules in §3.6 are unit-tested;
  - in a 3-minute bot soak replayed through the engine, no hint fires within 3 s of damage or in the countdown;
  - each hint's cap holds across sessions.
- **Phase 6:**
  - nothing leaves the device without the opt-in;
  - the holdout assignment is random and sticky;
  - the admin tab shows the funnel per persona and device.

## 8. Decisions for the owner

1. **The first match for recruits:** 3 Easy bots, first to 5 kills or 3 minutes (recommended), or today's 3 Normal bots?
2. **Opt-in onboarding analytics** sent to our own API (no third party, anonymous install id), and a **10% holdout** to measure the tour honestly? Yes or no.
3. **The first question's wording:** "First time in a firefight?" with "Show me the ropes" / "I know shooters. Skip training", or the owner's preference.

---

## 9. Sources

**Internal:** [controls-research.md](controls-research.md) §3.9, §4.10, §6; [touch-controls-v3.md](touch-controls-v3.md); [ui-motion-spec.md](ui-motion-spec.md); `apps/web/src/touch/teach.ts`, `shell/screens/Tips.tsx`, `shell/controller.ts`, `creator/`, `shell/screens/Title.tsx`, `hud/worldTags.ts`.

### Research, guidelines and the web platform (O)

- [O1] Andersen, O'Rourke, Liu, Snider, Lowdermilk, Truong, Cooper, Popović, "The Impact of Tutorials on Games of Varying Complexity", CHI 2012. https://grail.cs.washington.edu/projects/game-abtesting/chi2012/chi2012.pdf
- [O2] Nielsen, "How Little Do Users Read?", NN/g, 2008. https://www.nngroup.com/articles/how-little-do-users-read/
- [O3] Harley, "Instructional Overlays and Coach Marks for Mobile Apps", NN/g, 2014. https://www.nngroup.com/articles/mobile-instructional-overlay/
- [O4] Kendrick, "Mobile-App Onboarding: An Analysis of Components and Techniques", NN/g, 2020. https://www.nngroup.com/articles/mobile-app-onboarding/
- [O5] Laubheimer, "Onboarding Tutorials vs. Contextual Help", NN/g, 2023. https://www.nngroup.com/articles/onboarding-tutorials/
- [O6] Hodent, "The Gamer's Brain" onboarding talk write-up (GDC 2016). https://celiahodent.com/gamers-brain-ux-onboarding/
- [O7] Chameleon, Benchmark Report 2025 (vendor data). https://chameleon.io/benchmark-report
- [O8] Chameleon, Benchmark Report 2024 (vendor data). https://www.chameleon.io/benchmark-report-24
- [O9] GameAnalytics 2026 benchmarks, summarised by Game Dev Reports (vendor data). https://gamedevreports.substack.com/p/gameanalytics-mobile-and-pc-game
- [O10] GameAnalytics, "Tips for a great FTUE in F2P games" (vendor). https://gameanalytics.com/blog/tips-for-a-great-first-time-user-experience-ftue-in-f2p-games
- [O11] GameAnalytics, progression events. https://docs.gameanalytics.com/events-metrics-and-filtering/event-types/progression-events/
- [O12] A game platform's creator docs (onboarding funnel analytics); link in the private notes.
- [O13] Duolingo, "Duolingo 101" (placement choice). https://blog.duolingo.com/duolingo-101-how-to-learn-a-language-on-duolingo
- [O14] Hunicke and Chapman, "AI for Dynamic Difficulty Adjustment in Games", 2004. https://users.cs.northwestern.edu/~hunicke/pubs/Hamlet.pdf
- [O15] Unity, Funnel Analyzer (legacy docs). https://docs.unity3d.com/2018.2/Documentation/Manual/UnityAnalyticsFunnels.html
- [O16] A real-time struggle detector (CHI PLAY companion 2023). https://learninganalytics.upenn.edu/ryanbaker/chiplaycompanion23-48.pdf
- [O17] Apple HIG, Game controls. https://developer.apple.com/design/human-interface-guidelines/game-controls
- [O18] Apple HIG, Buttons. https://developer.apple.com/design/human-interface-guidelines/buttons
- [O19] Android accessibility, touch target size. https://support.google.com/accessibility/android/answer/7101858
- [O20] Steamworks, Steam Deck compatibility review. https://partner.steamgames.com/doc/steamdeck/compat
- [O21] MDN, Using the Gamepad API. https://developer.mozilla.org/en-US/docs/Web/API/Gamepad_API/Using_the_Gamepad_API
- [O22] MDN, any-pointer. https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/At-rules/@media/any-pointer
- [O23] W3C WAI-ARIA APG, Dialog (Modal) pattern. https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/
- [O24] MDN, inert. https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Global_attributes/inert
- [O25] MDN, `<dialog>`. https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/dialog
- [O26] MDN, Popover API. https://developer.mozilla.org/en-US/docs/Web/API/Popover_API
- [O27] W3C, WCAG 2.2. https://www.w3.org/TR/WCAG22/
- [O28] W3C, Understanding SC 2.5.8 Target Size (Minimum). https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html
- [O29] W3C, Understanding SC 4.1.3 Status Messages. https://www.w3.org/WAI/WCAG22/Understanding/status-messages.html
- [O30] MDN, prefers-reduced-motion. https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/At-rules/@media/prefers-reduced-motion
- [O31] MDN, aria-live. https://developer.mozilla.org/en-US/docs/Web/Accessibility/ARIA/Reference/Attributes/aria-live
- [O32] Game Accessibility Guidelines, full list. https://gameaccessibilityguidelines.com/full-list/
- [O33] Microsoft, Xbox Accessibility Guideline 101: Text display. https://learn.microsoft.com/en-us/gaming/accessibility/xbox-accessibility-guidelines/101
- [O34] Microsoft, Xbox accessibility feature tags ("On-demand tutorials"). https://devdocs.xbox.com/build/game-principles/accessibility/accessibility-feature-tags.md
- [O35] Hoober, "Design for Fingers, Touch, and People, Part 1", UXmatters, 2017. https://www.uxmatters.com/mt/archives/2017/03/design-for-fingers-touch-and-people-part-1.php
- [O36] Hoober, "How Do Users Really Hold Mobile Devices?", UXmatters, 2013. https://www.uxmatters.com/mt/archives/2013/02/how-do-users-really-hold-mobile-devices.php
- [O37] MDN, env(). https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Values/env
- [O38] WebKit, "Designing Websites for iPhone X". https://webkit.org/blog/7929/designing-websites-for-iphone-x/
- [O39] Driver.js source (`packages/driver/src/overlay.ts`, `stage.ts`, `events.ts`, `click.ts`, `driver.css`). https://github.com/kamranahmedse/driver.js
- [O40] Shepherd source (`shepherd.js/src/utils/overlay-path.ts`, `components/shepherd-modal.ts`). https://github.com/shipshapecode/shepherd
- [O41] Intro.js source (`src/packages/tour/components/HelperLayer.ts`, `DisableInteraction.ts`). https://github.com/usablica/intro.js
- [O42] React Joyride source (v2 `src/styles.ts`, v3 `src/components/Overlay.tsx`, `src/hooks/useTargetPosition.ts`). https://github.com/gilbarbara/react-joyride
- [O43] Reactour source (`packages/mask/Mask.tsx`). https://github.com/elrumordelaluz/reactour
- [O44] W3C, CSS Masking Module Level 1 (clip-path hit-testing; mask-image hit-testing). https://www.w3.org/TR/css-masking-1/
- [O45] MDN, clip-path. https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/clip-path
- [O46] MDN, mask-composite. https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/mask-composite
- [O47] web.dev, "Stick to compositor-only properties and manage layer count". https://web.dev/articles/stick-to-compositor-only-properties-and-manage-layer-count
- [O48] Chrome for Developers, "Hardware-accelerated animation capabilities". https://developer.chrome.com/blog/hardware-accelerated-animations
- [O49] WebKit bug 185816, "Run clip-path animations on the compositor" (Chromium status comment, Jan 2026). https://bugs.webkit.org/show_bug.cgi?id=185816
- [O50] Ahlin, "How to animate box-shadow with silky smooth performance". https://tobiasahlin.com/blog/how-to-animate-box-shadow/
- [O51] WebKit, "WebKit Features in Safari 26.0". https://webkit.org/blog/17333/webkit-features-in-safari-26-0/
- [O52] MDN, Firefox 147 release notes. https://developer.mozilla.org/en-US/docs/Mozilla/Firefox/Releases/147
- [O53] web.dev, "New to the web platform in January 2026". https://web.dev/blog/web-platform-01-2026
- [O54] W3C, CSS Anchor Positioning (WD 2025-05-09) and the CSSWG resolution on transforms (Jul 2025). https://www.w3.org/TR/2025/WD-css-anchor-position-1-20250509/ · https://lists.w3.org/Archives/Public/public-css-archive/2025Jul/0680.html
- [O55] Floating UI, autoUpdate. https://floating-ui.com/docs/autoUpdate
- [O56] three.js manual, "Aligning HTML Elements to 3D". https://threejs.org/manual/pages/align-html-elements-to-3d.html

### Sources that name other games
Kept out of the repo, in the private shared notes (onboarding-3d-research-sources.md), per the owner's rule against naming other games here. The [G] ids above point to that list.
