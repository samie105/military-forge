# Copy audit, 24 Oct 2026

The owner, 24 Oct: "I'm seeing some texts telling the users it's a 2.5D or stuff like that, please do all those clean-ups across codes, run audits, it's a professional platform already."

This page records every player-facing string that changed, grouped by screen, and the rules for new copy (at the end). Two PRs carry the changes:

- **Public pages, content and server** (`ws/copy-public`): the landing and its SEO tags, the manifest, map names, map banners, the host's tuning labels and the game server's join refusals.
- **In-game UI** (`ws/copy-ui`): Settings, the HUD, Tune the game, the creator, the Armory, the minimap, controller settings, invites and the First flight copy.

## How the audit was run

1. **Source sweep.** A TypeScript AST pass pulled every string literal, template and JSX text from `apps/web/src`, `apps/game-server/src`, `apps/api/src`, `packages/content`, `packages/protocol` and the bot names. That gave 16,405 strings; about 3,900 of them read like prose and were checked by hand. HTML templates were read for their text nodes and their `aria-label`, `title`, `alt` and `placeholder` attributes. Code comments, `docs/`, `NOTES.md` and test names were left alone.
2. **Crawl.** A production build ran on a local playtest stack. Headless Chrome walked it twice: on a 1440×900 desktop, and on a 780×360 landscape phone with touch. The walk covered the landing, About, title, name, creator, briefing, Home, Join, every Settings tab, lobby, countdown, match, scoreboard, pause, Tune the game, invites, controls, training, Locker and Armory. It also opened `armory.html`, `locker.html`, `gamepad.html`, `probe.html` and a room that doesn't exist. Each screen's visible text and attributes were collected: about 1,350 unique strings.
3. **Out of scope:** the owner's admin page, the dev-only debug client (`?online` and the Phase 0 bar, `render.ts`'s 2D overlay, the tweakpane dev panel), the sound board (`sounds.html`, a noindex tool page) and server logs.

## Counts

- **80 distinct strings changed:** 22 in the public, content and server PR, and 58 in the UI PR (one row per string in the tables below).
- **Test expectations updated** only where they asserted the old copy (`hud.test.ts`, `mapLoading.test.ts`, `creator/model.test.ts`, `tour/flight.test.ts`, `app.test.ts`, `rooms.test.ts`). Some test fixtures carried the old copy as input, and those were updated too (`shell.test.tsx`). `scripts/playtest-two-players.mjs` reads the connection readout, so its patterns follow the new words.

## The ten worst, before the fix

1. **"2.5D" in the pitch.** Players saw "Military Forge is a free **2.5D** multiplayer shooter" in the landing pitch, the About sheet, the meta description, Open Graph, Twitter, JSON-LD and the web manifest (7 places).
2. **The HUD's "Tuned by admin" tooltip:** "The **owner** changed gameplay numbers on this server (**the admin page**)".
3. **The creator's female body**, when her model can't load: "**Her 3D art is being made**: shown on the male body for now", "**Art coming**", "**Stand-in body**", "Until **it lands** she is shown, and plays, on the male body".
4. **The Armory's stat card:** "**Art only so far**: the model is ready, its stats come with **the arsenal**."
5. **Test maps under their working names**, on Home, in the lobby and on the scoreboard: "Deathmatch · **Movement Test** · first to 20", "**Vertical Test**".
6. **The connection readout's tag and tooltip:** "**WT**" / "**WS**", "**WebTransport** (UDP)", "30 **snap/s** · **interp** 100 ms · **buffer** 2 · ×1.000".
7. **The Armory's mounts panel:** "**Sockets** · where parts and effects attach", with raw keys "**rail_top**" / "**rail_bottom**" and "**left-hand IK**".
8. **Settings → Accessibility:** "**Team modes aren't in the game yet**: your choice is kept for them." This is stale, because team deathmatch ships.
9. **Controller aim assist:** "(at most 3° a **tick**, within your gun's range). **You always win a disagreement.**"
10. **UI jargon for players:** "Friends get a **toast** wherever they are", "0 online · they get a **toast**", and on the phone "hold the gun **pill** for a **radial**".

Other changes in the same vein: the in-world "Test armory" sign, and the join refusal "invalid **join ticket**: open the room link again".

## Before → after, by screen

### Landing, About, loading screen and manifest (`apps/web/index.html`, `apps/web/seo.ts`)

| Where | Before | After |
|---|---|---|
| `<meta name="description">` | %GAME_NAME% is a free 2.5D multiplayer jetpack shooter for your browser, … | %GAME_NAME% is a free multiplayer jetpack shooter for your browser, … |
| `og:description` | A free 2.5D jetpack shooter in your browser. Open the link, … | A free jetpack shooter in your browser. Open the link, … |
| `twitter:description` | A free 2.5D jetpack shooter in your browser. Send a link: … | A free jetpack shooter in your browser. Send a link: … |
| JSON-LD `VideoGame.description` | A free 2.5D multiplayer jetpack shooter you play in a browser tab, … | A free multiplayer jetpack shooter you play in a browser tab, … |
| Landing pitch | A free 2.5D jetpack shooter you play in a browser tab. … | A free jetpack shooter you play in a browser tab. … |
| About, first paragraph | %GAME_NAME% is a free 2.5D multiplayer shooter. … | %GAME_NAME% is a free multiplayer shooter. … |
| Loading screen, tip 1 | Hold jet to fly. | Hold Jet to fly. |
| Loading screen, tip 2 | Hold crouch on a yellow platform to drop through it. | Hold Crouch on a yellow platform to drop through it. |
| `manifest.webmanifest` description | Military Forge: a free 2.5D multiplayer jetpack shooter you play in your browser. | Military Forge: a free multiplayer jetpack shooter you play in your browser. |

### Maps: Home, the lobby's map list, the scoreboard and banners (`packages/content`)

| Where | Before | After |
|---|---|---|
| Map name (`movement-test`) | Movement Test | Proving Ground |
| Map name (`vertical-test`) | Vertical Test | Vertical Range |
| Map name (`mechanics-test`, dev list only) | Mechanics Test | Mechanics Range |
| Proving Ground, in-world sign | overhang (corner correction) | overhang |
| Zone "Long flight" (map JSON schema too) | Jet fuel burns at 40%: flights last 2.5× longer. | Fuel burns at 40%: flights last 2.5× longer. |
| Event banner, Gravity surge | Everything is heavier: jets climb slowly | Everything is heavier: jetpacks climb slowly |
| Tune the game → All values, Jetpack | Kick length (ticks) | Kick length (1/60 s) |
| Tune the game → All values, Dash | Length (ticks) | Length (1/60 s) |

Map names are content, so this changes the content hash. An old tab meets the new server with "New version available", as it would with any content change.

### Join refusals, shown as "Couldn't get in · The server said: …" (`apps/game-server/src/tickets.ts`)

| Case | Before | After |
|---|---|---|
| No pass | this room needs an invite from the game: open the room link again | this room takes players from its link only: open the room link again |
| Bad pass (3 cases) | invalid join ticket: open the room link again | your pass for this room didn't check out: open the room link again |
| Expired | join ticket expired: open the room link again | your pass for this room expired: open the room link again |
| Wrong room | that ticket is for another room: open the room link again | that pass is for another room: open the room link again |
| Used | join ticket already used: open the room link again | that pass was already used: open the room link again |

### Settings (desktop `Settings.tsx`, phone `PhoneSettings.tsx`, key bindings `controls.ts`)

| Where | Before | After |
|---|---|---|
| Accessibility → Colour-blind team colours | Teams also get a shape on their name tags, so colour is never the only clue. Team modes aren't in the game yet: your choice is kept for them. | Teams also get a shape on their name tags, so colour is never the only clue. |
| Network (both) | Low-bandwidth mode | Data saver |
| Network (both), and the N key binding | Net graph | Connection stats |
| Touch → Fire (both) | A second FIRE on the left | A second Fire button on the left |
| Touch (desktop, phone, controller) | Push up to jet | Push up to fly |
| Touch, its help (desktop) | … Claw turns it off: your left index finger has a JET button. | … Claw turns it off: your left index finger has a Jet button. |
| Touch, its help (phone) | The move stick flies. Off in Claw: JET is a button. | The move stick flies. Off in Claw: Jet is a button. |
| Touch → Camera shake (phone) | Blasts and recoil in the 3D view. | Blasts and recoil shake the view. |
| Touch → Button gestures (phone) | Swipe the grenade to change it, hold the gun pill for a radial, swipe the dash. Off: plain taps. | Swipe Grenade to change it, hold the gun button for quick-select, swipe Dash. Off: plain taps. |
| Controls → Jet (hold), hint | The ↑ arrow jets too, unless you bind it to something else | The ↑ arrow flies too, unless you bind it to something else |
| Controls → Dash, hint | Alone: the way you face. With a direction held: 8 ways, up (jet) and down included | Alone: the way you face. With a direction held: 8 ways, up and down included |

### Controller settings (`gamepad/PadSettings.tsx`, `gamepad/settings.ts`, `gamepad/PadLive.tsx`)

| Where | Before | After |
|---|---|---|
| Aim assist, Light | … so a sweep lingers on him. It never pulls. | … so a sweep lingers on them. It never pulls. |
| Aim assist, Standard | Light, plus a gentle pull toward an enemy near your aim line while you aim (at most 3° a tick, within your gun's range). You always win a disagreement. | Light, plus a gentle pull toward an enemy near your aim line while you aim, within your gun's range. The stick always wins. |
| Push up to fly, help | Pushing the move stick steeply up jets, as the jet buttons do. … | Pushing the move stick steeply up flies, as Jet does. … |
| Jet (hold), hint | Pushing the move stick steeply up jets too (unless you turn that off below) | Pushing the move stick steeply up flies too (unless you turn that off below) |
| Layout Standard | Jet, fire, dash and grenade on the shoulders: … | Jet, Fire, Dash and Grenade on the shoulders: … |
| Layout Classic | The first layout: A jets, LT is alt fire, B swaps, Y takes, R3 melees. | The original layout: A is Jet, LT alt fire, B swaps, Y takes, R3 strikes. |
| Layout Bumper Jet | LB jets, LT dashes, and the move stick never jets: … | LB is Jet, LT dashes, and the move stick never flies: … |
| Live check legend | Jet starts in the steep cone (55°–125°), keeps going in the wide one | Flight starts in the steep cone (55°–125°), keeps going in the wide one |

### In-match HUD (`hud/hud.ts`, `hud/template.ts`, `hud/worldTags.ts`, `minimap/minimap.ts`)

| Where | Before | After |
|---|---|---|
| "Tuned by admin" tag, tooltip | The owner changed gameplay numbers on this server (the admin page) | This server runs its own gameplay settings |
| Launched cue | Launched by … · jet to recover | Launched by … · fly to recover |
| Fuel bar, `aria-label` | Jet fuel | Fuel |
| Connection stats tag | WT / WS / LAN | UDP / TCP / LAN |
| Connection stats tag, tooltip | WebTransport (UDP) / WebSocket (TCP) | Fast connection (UDP) / Standard connection (TCP) |
| Connection stats detail, line 1 | ping … · loss …% · 30 snap/s · WebTransport | ping … · loss …% · 30 updates/s · fast connection |
| Connection stats detail, line 2 | ↓ … KB/s · ↑ … KB/s · interp 100 ms | ↓ … KB/s · ↑ … KB/s · smoothing 100 ms |
| Connection stats detail, line 3 | buffer 2 · ×1.000 · corrections …/min | input queue 2 · clock ×1.000 · corrections …/min |
| Connection stats detail, hint | heavy packet loss: try Low-bandwidth mode (Settings) | heavy packet loss: turn on Data saver (Settings → Network) |
| Connection stats detail, offline | local match · no network | local match · no connection |
| Armory rack sign (servers with the rack on) | Test armory | Weapon rack |
| Minimap legend | Slab: fly up, drop through | Platform: fly up, drop through |
| Minimap legend | Thin air: jets cut out | Thin air: jetpacks cut out |

### Tune the game (`shell/tune.ts`, `shell/screens/Tune.tsx`)

| Before | After |
|---|---|
| Jet fuel · max | Fuel · max |
| Jet fuel · burn | Fuel · burn |
| Jet fuel · regen | Fuel · refill |
| Jet thrust | Jetpack thrust |
| `aria-label`: The changed values as JSON | The changed values, as text |

### Loading, controls and Home

| Where | Before | After |
|---|---|---|
| Map loading line (`mapLoading.ts`) | Loading the map's art · 1 of 4 files · 1.5 MB | Loading the map · 1 of 4 · 1.5 MB |
| How to play (`Tips.tsx`) | Hold jet to fly. … | Hold Jet to fly. … |
| How to play (`Tips.tsx`) | Hold crouch on a yellow platform to drop through it. | Hold Crouch on a yellow platform to drop through it. |
| Home, card 04 | Quick play · Match with anyone · Coming soon | Matchmaking · Match with anyone · Coming soon |

The card was renamed because "Quick play" clashed with Op 01's "Quick match", which is a different thing. "Coming soon" stays: it is an intentional roadmap card.

### Invites (`social/Invites.tsx`)

| Before | After |
|---|---|
| Friends get a toast wherever they are, in the menus or mid-match. An invite lasts 2 minutes. | Friends get your invite wherever they are, in the menus or mid-match. An invite lasts 2 minutes. |
| N online · they get a toast | N online · they're alerted anywhere |
| They get a toast, anywhere | They're alerted anywhere |

### Create your soldier, when the female model can't load (`creator/index.ts`)

| Before | After |
|---|---|
| Not in the game yet | Not available yet |
| Her 3D art is being made: shown on the male body for now | Deploys on the standard body for now |
| Tag: Art coming | Tag: Soon |
| Stamp: Stand-in body | Stamp: Standard body |
| On the male body until her art lands | Deploys on the standard body for now |
| Female soldier: her 3D art is being made. Until it lands she is shown, and plays, on the male body. | Female soldier: arriving soon. Until then she deploys on the standard body. |

### Armory (`armory/index.ts`, also `armory.html`)

| Before | After |
|---|---|
| Art only so far: the model is ready, its stats come with the arsenal. | Not issued in matches yet: no stats to show. |
| Sockets (toggle) | Mounts |
| Sockets · where parts and effects attach | Mounts · where attachments and effects sit |
| rail_top / rail_bottom (raw keys) | rail top / rail bottom (matching the attachment titles) |
| offhand: left-hand IK | offhand: support hand |

Left for the owner or the design agent: the mount markers on the gun are **on by default**, and they read as a modelling aid. Consider starting them off (`socketsOn` in `armory/index.ts`).

### First flight (`tour/copy.ts`)

| Before | After |
|---|---|
| Hold FIRE, drag to aim. | Hold Fire, drag to aim. |
| Hold JET. | Hold Jet. |
| Tap DASH. | Tap Dash. |

## Left for other agents: files mid-change, strings not edited

These files belong to agents working right now (shared notes, `touch-interfaces.md`). Please carry these rewrites when you next touch them.

**Voice (design agent, `apps/web/src/voice/**`)**

| File | Before | Suggested |
|---|---|---|
| `VoiceHud.tsx` | This browser talks in the backup voice codec (clear, a little thinner). Everyone still hears you. | This browser uses a backup voice format: clear, a little thinner. Everyone still hears you. |
| `VoiceHud.tsx` | Reporting is coming / Report NAME (coming) | Hide the report button until reporting ships, or say "Report: soon". |

**Touch controls (phone agent, `apps/web/src/touch/**`; the editor block in `controller.ts` is the design agent's)**

| File | Before | Suggested |
|---|---|---|
| `layout.ts` | Move: push up to jet, down to crouch; swipe and lift to dash | Move: push up to fly, down to crouch; swipe and lift to dash |
| `layout.ts` | Swap guns: tap or swipe; hold for a radial with both guns and melee | Swap guns: tap or swipe; hold for quick-select: both guns and melee |
| `teach.ts` | Tap or swipe the gun pill. | Tap or swipe the gun button. |
| `teach.ts` | Pick from the radial | Pick from quick-select |
| `teach.ts` | Hold the gun pill, slide to melee, let go. | Hold the gun button, slide to melee, let go. |
| `teach.ts` | … Or hold the gun pill and slide to melee. | … Or hold the gun button and slide to melee. |
| `teach.ts` | Hold JET (or push the left stick up) to fly. … / Hold JET to fly. … | Hold Jet (or push the left stick up) to fly. … / Hold Jet to fly. … |
| `teach.ts` | Hold FIRE. Drag it to aim while you shoot. | Hold Fire. Drag it to aim while you shoot. |
| `teach.ts` | Push the left dial up to fire the jetpack. … | Push the left dial up to fly. … |
| `fireArt.ts` | The stick only aims. Hold FIRE to shoot; … | The stick only aims. Hold Fire to shoot; … (the SVG's FIRE / AUTO glyph labels can stay caps: they're art) |
| `settings.ts` | The aim slows a little on an enemy, so a sweep lingers on him. It never pulls. | … so a sweep lingers on them. It never pulls. |

**Ads (`apps/web/src/ads/**`):** nothing to change.

## Kept on purpose

- **"build abc123"** in the title corner: a version tag players can quote.
- **Ping, ms, packet loss, KB/s, UDP/TCP and FPS**, but only in Connection stats, Show FPS, the lobby's ping and the scoreboard. These are readouts players turn on or expect.
- **The controller check page** (`gamepad.html`: axes, button numbers, mapping) and **the ping test** (`probe.html`: cloud regions, ASN): they are diagnostic tools, and their words are the point.
- **"Coming soon"** on Home's Matchmaking card: an intentional roadmap card.
- **The Proving Ground's in-world signs** ("0.5 m", "wedge 60°", "crouch corridor 1.25 m"): range markings, in the fiction.
- **The admin page** (owner only) and the dev-only debug client: technical by design.

## Voice and style guide (for every agent writing copy)

**Tone**
- War, not toy: terse, confident, military. Short imperatives ("Hold Jet to fly.", "Cross the edge fast, or fly over.").
- Never childish, never cute, no exclamation marks. "Saved, thank you!" on the ping test is the lone exception, and it isn't in the game.
- Speak to the player as "you". The game is "the game", never "we built…".
- Never explain how the game is made: no engines, models, art pipelines, servers' internals, tick rates or "3D art is being made". Say what the player gets ("Deploys on the standard body for now").
- No internal references: owner, admin page, agents, PR or issue numbers, docs sections, TODO, test, debug or placeholder. "Tuned by admin" is the one sanctioned mention of an admin, as a tag.
- No other games' names, ever. Platform names are fine (PlayStation, Xbox, Nintendo, WhatsApp, iPhone, Android).
- "Coming soon" only where a feature is deliberately teased. Otherwise hide what isn't there.

**One name per thing**

| Use | Not |
|---|---|
| jetpack (the gear) | jet, jets (as the gear) |
| **Jet** (the control: button, key, binding) | JET, jet button |
| fly (the verb) | jet (as a verb), "jets" |
| fuel | jet fuel |
| dash; chain dashes | boost |
| grenade; Frag, Smoke, Toxic gas, Flashbang, Proximity mine, EMP | nade |
| gun (a firearm you carry); weapon (the category, melee and shield included) | — |
| take (a gun from the ground) | pick up (except the key binding "Pick up / use") |
| quick-select (hold Swap) | radial, wheel, pill |
| room; local room (same Wi-Fi) | lobby (for the room), server room |
| match; training (solo vs bots); First flight (the onboarding) | game session |
| host; bots; soldier; callsign or name | player avatar, dummy |
| connection | WebSocket, WebTransport, socket, transport |
| Connection stats; Data saver | net graph, low-bandwidth mode |
| updates/s; smoothing | snapshots, snap/s, interp, interpolation |
| your pass for this room | join ticket, token |
| map names as in `packages/content` (Street Market, Proving Ground, Vertical Range, …) | working names (Movement Test) |

**Capitalisation**
- Buttons, tabs, settings and screen titles take sentence case: "Create room", "Join with code", "Leave match", "Push up to fly", "Data saver". The CSS sets any uppercase, so write it in sentence case.
- In prose, a control takes an initial capital when it means the button, key or binding: "Hold Jet", "Tap Dash", "Hold Fire", "tap Take", "Hold Crouch". Lower case when it's just the action: "dash any way", "fly up to the marker".
- Settings paths use arrows: "Settings → Touch → Learn the controls".
- British spelling, as the rest of the game: colour, centre, randomise, armour.

**Form**
- Fit a landscape phone: labels ≤ ~24 characters, phone help lines ≤ ~80. When the desktop has a longer sentence, give the phone its own short one (as `PhoneSettings.tsx` does).
- Numbers are digits with a space before the unit: 5 s, 20 m, 100 ms, 2.5×.
- Separators: "·" between facts on one line; ":" for cause → effect or label → detail ("Thin air: jetpacks cut out").
- Errors say what happened and what to do next, in one breath: "No room with that code", "Check your data or Wi-Fi, then rejoin."
- Technical words (ping, ms, packet loss, KB/s, UDP/TCP, dead zone, FPS) belong only in readouts the player opts into, and on the controller check and ping test pages.
