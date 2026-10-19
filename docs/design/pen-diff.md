# Pen file vs the built game (19 Oct 2026)

What the owner's pen.dev file (`military-forge .pen`) holds that the game doesn't have yet, or has in a different form. It was read through the Pen MCP tools only, and nothing in it was changed. The game baseline is `origin/main` at f4a744dc: UI round two (Field Print), phases 1 to 6, desktop and phone.

PNG exports of every board and screen are in [`pen/`](pen/). Desktop screens are at half size (960×540), phone screens are at 1:1 (812×375, or 812×424 with their label), and boards are reduced. All are 256-colour PNGs.

## 0. What is in the file

| Board (Pen id) | What it is | Screens | Exports |
| --- | --- | --- | --- |
| `GBfLq` SYSTEM · Frost design system | Recipe, components, overlay rule, tokens and skin cards for **Frost** | 1 sheet | [`overview/frost-design-system.png`](pen/overview/frost-design-system.png), [`overview/system-frost-board.png`](pen/overview/system-frost-board.png) |
| `TuSWL` DESKTOP · 1920×1080 | **Frost** desktop screens, each titled "vNN v2 · …" | 14 | [`frost-desktop/`](pen/frost-desktop/), [`overview/desktop-frost-board.png`](pen/overview/desktop-frost-board.png) |
| `ZAc68` MOBILE · 812×375 landscape | **Frost** phone screens. The HUD frame is named "Concept B · Thumb Dials". | 3 | [`frost-mobile/`](pen/frost-mobile/), [`overview/mobile-frost-board.png`](pen/overview/mobile-frost-board.png) |
| `oHuFc` V2 · FIELD PRINT · military kit | Round two, "imported from military-forge-ui-v2.html": **what is built** | 21 desktop + 8 phone | [`field-print/`](pen/field-print/), [`field-print-mobile/`](pen/field-print-mobile/), [`overview/v2-field-print-board.png`](pen/overview/v2-field-print-board.png) |

**The "other build" is Frost.** The Field Print board holds the same screens as `docs/design/military-forge-ui-v2.html`: name entry, home, join, settings, lobby, connection, loading, map intro, countdown, HUD and HUD states, scoreboard, map event, pause, tune, results, kill feed, weapons in the world, locker, armory, battle royale, plus the six phone screens. I spot-checked Home, HUD v2 states and the phone HUD against the built screenshots. The only visible difference: the Pen Home shows the 3D soldier render, where the build shows its own hero art. **Field Print adds nothing new.** Everything below is about Frost.

The file has no `note`, `context` or `prompt` nodes, so it carries **no motion notes, no annotations and no specs**. The `context` values on Field Print nodes are only the HTML tag names left over from the import. Every behaviour described below is read from the drawn states.

## 1. Screens and states in Pen that the game doesn't have yet

| # | Screen / state | Where | What's new |
| --- | --- | --- | --- |
| N1 | **Desktop HUD on thumb dials** | [`frost-desktop/07-hud-thumb-dials.png`](pen/frost-desktop/07-hud-thumb-dials.png) | The phone's dial HUD is brought to desktop:<br>• **Bottom left:** a round HP and fuel gauge (red HP arc, teal fuel arc, "82 HEALTH · 64 FUEL" in the disc), with a dash chip next to it ("SHIFT Dash", a chevron icon on a cooldown ring).<br>• **Bottom right:** an ammo dial with one segment per round, "HAMMER 4/6 · 30 RESERVE" in the disc, and the six grenades fanned around it as round chips with counts, captioned "G Throw · T Next".<br>• **Bottom centre:** a two-row weapon plate (slot 1 Hammer with R Reload; slot 2 Buzz 40/250 with Q Swap).<br>• **Top:** the clock plate at the centre, a net pill (ping and loss) at the left, the kill feed at the right.<br>The built desktop HUD uses horizontal bars and plates. |
| N2 | **Map loading with real progress and field tips** | [`frost-desktop/13-loading.png`](pen/frost-desktop/13-loading.png) | A big stencil map name, the rules row ("Deathmatch · first to 10 · 5:00 · 6 players, 2 bots"), **64% with "Downloading the map · 2.1 of 3.3 MB"**, a progress bar, and a **"Field tip 1 / 3"** card that pages (dots), with the next two tips listed. Today the build has only the boot splash (`index.html`, "Gearing up", with a slow-connection line after 20 s) and the "Loading the map" step on the connection card. Neither shows byte progress or gameplay tips. |
| N3 | **Reconnecting with an attempt counter** | [`frost-desktop/05-connection-lost-reconnecting.png`](pen/frost-desktop/05-connection-lost-reconnecting.png) | **State 1:** the HUD stays live, a frosted toast says "Reconnecting… Attempt 2 of 5. The match keeps going." with 5 pips and "2 / 5", and the net pill turns to "– ms · no reply".<br>**State 2:** after 5 failed tries, a "Connection lost" modal with a 5-of-5 failed pip row, "Code CONNECTION_LOST", and **Rejoin** and **Home** buttons.<br>The build already has the "Connection dropped. Reconnecting · try N" banner and the lost card. New here are the **pip counter, the error code line and Rejoin**. |
| N4 | **Scoreboard: per-player moderation** | [`frost-desktop/08-scoreboard-tab.png`](pen/frost-desktop/08-scoreboard-tab.png) | Each row gets **mute** and **report** icon buttons (a muted player's button is red). The footer reads "Mute voice + chat · Report". The board also gains a **Score** column (kills minus self-kills), **ping coloured by quality**, a "Kemi leads 8/10 · you're 2 kills behind" leader bar and a ring clock. The built board has rank, name, K, D and ping only. The game has no voice or text chat, so mute and report need a product decision first. |
| N5 | **Home: squad, What's new, kit, level** | [`frost-desktop/02-home.png`](pen/frost-desktop/02-home.png) | Top tabs **Play · Locker · Armory · Training**, with Settings moved to a gear icon. A **profile chip with "LVL 4" and an XP bar**. The 3D soldier sits in the centre on a teal base ring.<br>A **Squad 1/8** panel with "Invite a friend" slots and **Invite on WhatsApp**. A **What's new** card ("Riot shields now spawn on every map"). A **Rookie kit · spawn** card (Hammer, Hawk, ×3 grenades) that links to the Locker. A version stamp.<br>The build has no levels or XP, no pre-room squad, and no What's new. |
| N6 | **Locker v3: slots, rarity, unlock sources, loadouts** | [`frost-desktop/15-locker.png`](pen/frost-desktop/15-locker.png), [`frost-mobile/15-locker.png`](pen/frost-mobile/15-locker.png) | **12 slots in 4 groups:** Character (Body, Skin), Outfit (Headgear, Eyewear, Top, Gloves, Legs, Boots), Flight (Jetpack, Exhaust, Trail), Colour (Dyes).<br>**Three named loadouts** (Desert Rookie, Night Ops, Parade), **Randomise**, and camera presets **Full · Face · Jetpack**. **Light** presets **Lobby · Night · Desert**. "Rookie · LV 7".<br>Item cards carry rarity colour and shape, plus **how to get** the locked ones: "Reach level 10", "Store · 1,200 credits", "Season 1 · Tier 30", "Achievement · 100 headshots".<br>A **three-channel dye** row (Primary, Secondary, Accent) with swatches and Reset colours.<br>The phone version has an icon rail, presets 1/2/3, Random, Full/Face/Pack, a 3×2 item grid and a "New" tag. |
| N7 | **Armory v3: weapon skins and acquisition** | [`frost-desktop/16-armory.png`](pen/frost-desktop/16-armory.png) | **List:** all 18 weapons grouped (Sidearms 2, SMGs 3, Rifles 3, Marksman 2, Shotgun 1, Heavy & Special 5, Melee & Off-hand 2), each tagged **Spawn loadout** or **Map pickup**.<br>**Centre:** a hero name and tagline, a skin preview, and **stat bars marked against the "Armory average"** ("Identical in every skin").<br>**Right:** a **Skins** list ("5 of 8 owned"; Standard, Rare, Epic, Legendary) with locked skins and their challenges ("Win 10 matches with Widow", "Land 25 one-shot kills", "Reach player level 30"), and **Equip**.<br>Keys: W/S weapon, A/D skin. |
| N8 | **Results hero** | [`frost-desktop/10-results.png`](pen/frost-desktop/10-results.png) | A **winner name in giant stencil with the winner's 3D soldier**, and a "Kill limit reached · 10 kills" chip. A **"You placed 2ND of 8"** ring with kills, deaths, damage and the MVP. A final-standings table with a **DMG** column. **Play again** with rematch pips ("2/6 want a rematch"), then Back to lobby (host) and Leave room. The footnote says "bots don't count toward rank rewards", which again assumes progression. |
| N9 | **Countdown ring with stepper** | [`frost-desktop/06-countdown.png`](pen/frost-desktop/06-countdown.png) | The number sits in a ring that drains, under "Get ready". A rules pill below it, and a **step row "Match 1 → 3 → 2 → 1 → GO"**. "Hold Tab to see who's in". |
| N10 | **Accessibility: colour-blind preview** | [`frost-desktop/11-settings.png`](pen/frost-desktop/11-settings.png) | Three colour-blind cards (Standard, Red-green safe, Blue-yellow safe), each pairing team shapes with colours, and an **"In match:" name-tag preview**. A **text-size slider with tick labels 100–150**. "Saved on this device" and "Match still running · 3:12" in the header. The build has these settings; the live **in-match preview** and the **tick labels** are new. |

## 2. Screens in both, but different

All Frost screens share these differences, so they are not repeated per screen:

- **Colour.** Round one's dark slate and teal replace Field Print's olive ink, volt, paper and brass (see §3).
- **Overlays are frosted glass** over the blurred live world.
- **Asymmetric corners.** Panels and buttons use radius `[0, 28, 0, 28]` / `[0, 18, 0, 18]` (square top-left and bottom-right).
- **Type.** Barlow Semi Condensed for UI text replaces Archivo, and there are no spray-offset stencil headlines.
- **No Field Print decoration:** no camo, halftone, tape, tickets, stamps, rivets, giant outlined word or sitrep ticker. Sand "eyebrow" labels with a leading dash take their place.

| Screen | Built (Field Print) | Frost | Notable differences |
| --- | --- | --- | --- |
| 01 Name entry ([Frost](pen/frost-desktop/01-name-entry.png) / [FP](pen/field-print/01-name-entry.png)) | Taken + suggestions, Pick one for me | Same flow | **Layout:** 3D soldier on the left with a "Callsign · Rank Recruit · Kit Rookie" ID plate; the form on the right in a frost panel. **Copy:** "New recruit / What should we call you?" The behaviour is already built. |
| 02 Home ([Frost](pen/frost-desktop/02-home.png) / [FP](pen/field-print/02-home.png)) | Volt "Play with friends" poster, Join and Training tickets, Field orders, last match, sitrep | Teal-outlined featured card "01 Featured mode", Join and Training cards with large line icons, Quick play "Coming soon" | **Layout and components** differ. The squad, What's new, level and kit panels are new (N5). Field orders, Last match and the ticker are **gone**. Training becomes a tab. |
| 03 Join ([Frost](pen/frost-desktop/03-join-with-code.png) / [FP](pen/field-print/03-join-with-code.png)) | Six code boxes, error, paste | Same, plus a **"Where to find it"** panel: a mock group chat with the link and the code highlighted | **Layout:** the help panel is new. **Copy:** "The code is the last 6 letters of the room link." |
| 04 Lobby, host ([Frost](pen/frost-desktop/04-room-lobby-host.png) / [FP](pen/field-print/04-lobby-host.png)) | Map cards with brass thumbs, time of day, bots and level, host tools, **two links (Same Wi-Fi + Internet) each with a QR** | Three columns: **Bring your squad** (code, Copy link with Ctrl C, WhatsApp, **"What your friends see"** message preview, one QR) · **Squad 5/8** (ping, Ready/Not ready per row, "3 of 5 ready", open slots, Add a bot) · **Match settings** (mode, **time-limit segmented 1–20/None**, **kill-limit stepper 5–100 + No limit**, 5 map cards) | **Fewer controls:** only one link, and no time of day or bot level. **New:** the "Warm-up live" pill, the share-text preview, and "Guests see these read-only". **Start now** is the primary action instead of sharing. |
| 06 Countdown ([Frost](pen/frost-desktop/06-countdown.png) / [FP](pen/field-print/07-countdown.png)) | Big number, P-motion | Ring + stepper (N9) | **Components** differ. The map intro card (FP 06) has no Frost equivalent. |
| 07/08 HUD ([Frost](pen/frost-desktop/07-hud-thumb-dials.png) / [FP](pen/field-print/08-hud-normal.png)) | Bars, plates, belt row, slot plates, shield box, dash ring with 8-way rose | Dials (N1) | **Missing from Frost:** riot-shield HP, melee/dual states, crate compare, cues, damage arcs, the tuned tag. Frost has **one HUD state** only, against the nine-plus in FP 08b. |
| 08 Scoreboard ([Frost](pen/frost-desktop/08-scoreboard-tab.png) / [FP](pen/field-print/09-scoreboard.png)) | Plate table | Frost sheet, ring clock, leader bar, mute/report (N4) | Layout, components, copy. |
| 10 Results ([Frost](pen/frost-desktop/10-results.png) / [FP](pen/field-print/11-results-debrief.png)) | Debrief: highlights with medals, per-weapon table, MVP share card, vote pips | Winner hero + placement ring + standings (N8) | **Frost drops** the highlight medals, per-weapon table and **MVP share card**, and **adds** the winner's 3D soldier and placement ring. |
| 11 Settings ([Frost](pen/frost-desktop/11-settings.png) / [FP](pen/field-print/12-settings.png)) | Tabs Graphics, Audio, Controls, Accessibility, Network, **Touch** | Tabs Graphics, Audio, Controls, Accessibility, Network (desktop, so no Touch) | Only **Accessibility** is drawn. Its additions are in N10. |
| 12 Pause ([Frost](pen/frost-desktop/12-pause-frosted.png) / [FP](pen/field-print/13-pause-host.png)) | Resume, Settings, Invite, Tune (host), Leave + confirm | **Menu** column, a **match card** (time left, you vs leader, progress bar, "2 kills behind · plenty of time"), **Bring a friend in** (code, slots, Copy link, WhatsApp), and a **Leave this match?** modal ("your 6 kills won't count") | **Not in Frost:** Tune the game. **New:** the match-progress card and the leave modal's consequence copy. The phone pause ([`frost-mobile/12-pause-menu.png`](pen/frost-mobile/12-pause-menu.png)) is the same split. |
| 13 Loading ([Frost](pen/frost-desktop/13-loading.png) / [FP](pen/field-print/15-loading.png)) | FP 15 exists in the kit; the build uses it as the boot splash | N2 | Progress in MB and paging tips are new. |
| 05 Connection ([Frost](pen/frost-desktop/05-connection-lost-reconnecting.png) / [FP](pen/field-print/05-connection-room-full.png)) | 8 connection states as cards | Two states only (N3) | Pips, error code, Rejoin. |
| 15 Locker, 16 Armory | Locker v2 tabs (Outfit, Helmet, Dyes, Gun finishes, Dash trail, Muzzle fire); Armory v2 turntable, stat card, attachments, mechanism buttons | N6, N7 | Frost is **slot-based with an economy**. Frost's Armory has **no attachment preview and no mechanism buttons**. |
| Phone HUD ([Frost](pen/frost-mobile/14-hud-thumb-dials.png) / [FP](pen/field-print-mobile/m1-hud-thumb-dials.png)) | Thumb dials with the button fan, swap pill, crate pick | Thumb dials with **seven round buttons**: Shield, Swap, Reload, **Dash (move icon, cooldown ring)**, Grenade (count 3), Next grenade, **Melee (sword)**; a pause button and ping at the top right | Close to the build; only the colours differ. Frost gives **Shield and Melee their own buttons** on the phone. |

Frost has no version of these Field Print screens: map intro, map event, Tune the game, kill-feed reference, weapons in the world, battle royale, phone home, phone lobby, phone results.

## 3. Frost vs `apps/web/src/ui/kit.css`

`get_style` lists pen.dev's generic style archetypes only (Aerial Gravitas, Optical Glass and the rest). **None is Frost**, so Frost's tokens are quoted from the document's own variables (`GetVariables`) and its components.

**Frost tokens (Pen variables, verbatim):**

```
bg #0f141c · bg-deep #0a0e14 · panel #161d28 · panel-2 #1c2533 · panel-3 #243042
line #2a3442 · line-strong #3b4759 · text #e8edf3 · muted #8d99a8 · muted-strong #aab5c2
accent #3fb6a8 · accent-ink #03201c · accent-soft #3fb6a824
sand #cdb98e · sand-ink #241d0e · sand-soft #cdb98e22
hp #ef5157 · danger-text #ff8a8f · warn #f2b632 · ok #86d45f · shield #cfd8e3
whatsapp #25d366 · whatsapp-ink #052a12 · team-blue #3f8cf2 · team-orange #f28a30
ev-gravity #b49dfb · ev-toxic #b4d453
plate #0c1118e6 · plate-strong #0c1118f5 · plate-line #e8edf324 · track #e8edf31f
rarity-common #c3ccd6 · rarity-uncommon #86d45f · rarity-rare #b49dfb · rarity-legendary #ead061
frost-fill #0c111873 (45%) · frost-strong #0c1118b3 (70%) · frost-line #ffffff33 · frost-hi #ffffff26
scrim #0a0e14a6 (65%) · r-frost 28 · blur-frost 20
font-ui "Barlow Semi Condensed" · font-display "Big Shoulders Stencil"
```

**The Frost recipe** (Frost Panel `XEjWW`, used by the secondary and danger buttons, icon button, segmented, modal and toast):

- **Fill:** `$frost-fill`, plus a radial highlight from `#ffffff26` to `#ffffff05`.
- **Stroke:** a 1.2 px vertical gradient from `#ffffff66` to `#ffffff14`.
- **Effects:** `background_blur 20`, an inner 1 px `#ffffff1a` top light, and an outer shadow 0/12/32 `#00000066`.
- **Corners:** `[0, 28, 0, 28]`; buttons use `[0, 18, 0, 18]` at 64 px tall.
- **Primary button:** `$accent` fill, a `#ffffffcc` stroke and a teal glow shadow (`#3fb6a84d`, 0/8/20).
- **Overlay rule:** live game sharp → an overlay at blur 20 + scrim 65% → a modal on that overlay at blur 28 + scrim 80%.

**Against the kit:**

| | kit.css (Field Print, built) | Frost |
| --- | --- | --- |
| Palette | `--c-ink-900 #0e100b`, `--c-volt #d6ff3b`, `--c-paper #ece3c8`, `--c-brass #d9b25f`, olive and camo ramps | **Exactly round one's palette** (`docs/design/military-forge-ui.html`: `--c-bg #0f141c`, `--c-accent #3fb6a8`, `--c-sand #cdb98e` …), plus frost, scrim and rarity tokens |
| Action colour | Volt | Teal |
| Fonts | `--f-display` Big Shoulders Stencil Display, `--f-ui` Archivo (width axis) | Big Shoulders Stencil (shared with the build) + **Barlow Semi Condensed** (round one's UI font); the dial uses Inter |
| Surfaces | Opaque plates and paper cards; HUD forbids `backdrop-filter` and big shadows | Translucent blurred glass and big shadows on menus. The HUD dials use plates without blur, so the HUD rule still holds. |
| Texture | Camo, halftone, tape, rivets, stamps, outlined word | None, apart from a faint grid |
| Rarity | `packages/content/src/cosmetics.ts` `RARITY_STYLE`: 5 tiers (common `#9aa4ad` circle, uncommon `#4cc38a` triangle, rare `#4c9cf0` diamond, epic `#b57cf2` pentagon, legendary `#f0b43c` star) | 4 tokens (no epic token, though the Armory screen shows Epic). Rare is **violet** `#b49dfb`, not blue, and uncommon reuses ok-green. The shapes match (circle, triangle, diamond, star). |
| Motion | `ui-motion-spec.md` tokens in kit.css | **None in Pen** |

**Verdict: a whole-skin replacement direction, not a variant and not a set of extra components.** The reasons:

- It swaps every colour, the UI font, the surface model and the decoration.
- Its palette is round one's palette word for word. The v2 kit's own header says round two replaced it: "teal/sand frost became STREET PRINT".
- It brands itself as a round-two alternative ("Military Forge · V2 'Thumb Dials'", the phone HUD's "Concept B").

**Frost does not replace round two on its own authority.** The owner's decision of 18 Oct ("`military-forge-ui-v2.html` is the source of truth for every screen") still stands. The 19 Oct note lists both boards as a "shared design source" without choosing between them. Frost covers about 17 screens and one HUD state, against round two's 27 screens and many states. **Whether to reskin is the owner's call.** Until the owner decides, the safe reading is: keep Field Print as the look, and port Frost's new features (§1) into Field Print's components.

Only three Frost components are not already covered by kit classes in some form: the **dial gauge** (`v1jj64`; the phone `.dial` is close), the **skin card with rarity frame and state** (`lIein`), and the **frosted toast** (`v4zy4`; the kit has `.status`, but not a pill toast).

## 4. What Pen says about the owner's open asks

| Ask (owner, 19 Oct) | In Pen | Gap |
| --- | --- | --- |
| **Onboarding (first run)** | Frost name entry (identity plate, taken + suggestions, Pick one for me), loading-screen **field tips** (3 pages), Home **What's new** and **Rookie kit · spawn**, and "Hold Tab to see who's in" on the countdown. | **No tutorial, no first-match coach marks, and no controls card.** The build's first-run controls card (`shell/screens/Tips.tsx`) is beyond anything in Pen. The loading tips are the one new onboarding surface worth building. |
| **Loading states** | N2 (map download % and MB), N3 (reconnect attempts), "Saved on this device" on Settings and Locker, and the "Warm-up live" pill. | Pen has no skeletons and no states for "joining room…", "saving…", a failed save or a rollback. Those still need designing. |
| **Sound and settings** | Only the **"Audio" tab label** in Frost Settings and the system sheet's tab list. No audio page, volumes, mixer or music. | **Nothing to build from.** The build's Audio tab saves values but the game has no sound. A sound settings page needs a design: master, music, effects, UI, voice, mute in background. |
| **Melee and shield effects** | Phone Frost HUD: separate **Shield** and **Melee (sword)** buttons. The Armory lists Machete and Riot Shield under "Melee & off-hand". The kill-feed component has weapon and badge slots. | **No hit, swing, block or shield-HP visuals** anywhere in Frost. The desktop Frost HUD shows **no shield HP and no melee state** at all. Field Print's `.shieldbox` and melee ammo states, which are built, remain the only HUD design. World-space FX are not in Pen. |
| **The dash** | Desktop: a dash chip **with a cooldown ring** next to the fuel dial ("SHIFT Dash"). Phone: a Dash button with a teal cooldown ring. Field Print: the dash ring, the air pip and the 8-way rose. | **Both directions predate the 19 Oct rework** (no cooldown; each dash eats fuel; dashes chain). Neither shows a per-dash fuel cost. Frost's placement, the dash chip **beside the fuel arc**, is the better fit. Draw a dash-cost notch on the fuel arc or bar, and retire the cooldown ring and the air pip. |

## 5. Build list for a UI agent (priority order)

These are in **Field Print's components and tokens**, unless the owner picks Frost. Items 1–5 serve the owner's current asks; 6–9 are Frost features that need no economy; 10–12 wait on decisions.

1. **Dash HUD for the fuel dash.** Remove `--dash` cooldown and `dash.airUsed` from the HUD (desktop `.dash` ring and air pip; phone dial button ring). Show the cost of the next dash as a notch on the fuel bar or arc, and dim the dash cap when fuel is below one dash. Keep the 8-way hint. *(No Pen design; follow Frost's "dash next to fuel" placement.)*
2. **Map loading screen (N2).** After joining, show the map name, rules row, real download % and MB, and a paging field-tips card (3 tips in the player's own keys, as in `Tips.tsx`). Reuse FP 15 `.load`, which the build already uses for the boot splash.
3. **Reconnect counter (N3).** Add attempt pips "N / 5" to the existing reconnect banner. On the lost card, add the error code line and **Rejoin**, which goes to the same room with the session token.
4. **Melee and shield on the HUD.** Make sure the built `.shieldbox` and melee states actually show in 3D online games. On the phone, split Shield and Melee into their own dial buttons as in Frost (`touch/layout.ts`). Ask render3d-b for swing and block FX; Pen has nothing for them.
5. **Sound settings: design first.** Pen has no Audio page. Ask the owner, or draft in Field Print: master, music, effects, UI and voice sliders, mute when unfocused, and a test-sound button. Wire it to the existing Audio tab state once the sound pass lands.
6. **Scoreboard (N4), safe part only.** Add the Score column (kills minus self-kills), ping colour bands and the leader bar ("X leads 8/10 · you're 2 behind"). **Skip mute and report** until chat or voice exists.
7. **Countdown stepper (N9).** Add the "Match 1 → 3 → 2 → 1 → GO" step row under the number, plus "Hold Tab to see who's in".
8. **Lobby additions.** Add the **"What your friends see"** share-text preview, the "Warm-up live" pill, "N of M ready", and "Guests see these read-only". Keep both links and the QRs.
9. **Pause match card.** Add a "Time left · you vs leader" card with its progress bar and "N kills behind" line, and put the consequence copy ("your N kills won't count") in the leave confirm.
10. **Settings → Accessibility (N10).** Add the live colour-blind name-tag preview and tick labels on the text-size slider.
11. **Owner decisions first, then build:**
    - Home's squad panel (N5);
    - player level and XP;
    - Locker v3 slots, unlock sources, credits and seasons (N6);
    - weapon skins with challenges (N7);
    - the Results winner hero (N8);
    - rarity colours (Pen's violet rare against content's blue rare and epic).
12. **Only if the owner picks Frost:** reskin. Replace the `:root` block with round one's palette plus the frost tokens, add `backdrop-filter` to menu overlays (never the HUD), swap Archivo for Barlow Semi Condensed, and move the desktop HUD to dials (N1). That is a round-three-sized job, and Frost would first need the missing screens and HUD states listed in §2.
