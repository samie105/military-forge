# 01 — Game Design

> Game name: **MILITARY FORGE** (chosen 17 Oct 2026 after a preliminary screen; full trademark search before filing, see §12).
> A 2.5D online jetpack shooter for the browser: the chaos and feel of classic 2D jetpack shooters, rebuilt in 3D, playable in a tab, with rooms, groups and a drop-in battle royale.

---

## 1. One-liner & pitch

**"Jetpack warfare for the web, in 3D. Jetpacks, dual-wield, rooms with friends, and a drop-in battle royale. Click a link and you're in the fight in 10 seconds."**

What players love about the classic mobile jetpack shooters:
- Chaotic matches with friends over Wi-Fi.
- Jetpack plus dual wield.
- It ran on cheap phones.
- A $1 unlock, not a store.

What they hated:
- Hackers.
- Lag and endless loading.
- Pay-to-win crates and weapon levels.
- Losing LAN mode and Capture the Flag.
- Hosts kicking good players.
- Ads.

We keep the first list and design against the second.

---

## 2. Pillars

| # | Pillar | Means | Doesn't mean |
|---|---|---|---|
| 1 | **Feel first** | movement and gunfeel tuned for the classic genre feel; 60 Hz sim; prediction that never rubber-bands | realism, slow tactical play |
| 2 | **Instant in, instant again** | a link opens straight into a room; ≤ 10 s to the first spawn on broadband; "Play again" keeps the group together | long lobbies, mandatory sign-up |
| 3 | **Fair, always** | server-authoritative everything; cosmetics-only monetisation; same hitbox for everyone; looks that read the same (17 §3.4) | pay-to-win, perks for money, paid looks that hide you |
| 4 | **Friends make it** | groups, room codes, custom rules, a room browser, clan tags | solo-only design |
| 5 | **Readable chaos** | 2.5D side-view; strong silhouettes; team outlines; colour + shape coding | realistic camo, screen-filling VFX |

---

## 3. Core loop

```
            ┌─────────── 30 s ─────────────┐
 spawn ──▶ grab weapon ──▶ fight (jet, dual, grenade) ──▶ die/kill ──▶ respawn 3 s
   ▲                                                                   │
   └──────────── match 5–10 min ─▶ results (XP, missions, rank) ─▶ Play again (same group)
                                          │
                                 meta: level up → unlock cosmetics → customise → show off
```

- **Micro (seconds):** jet, aim, shoot, dodge, melee lunge, throw.
- **Meso (minutes):** control power-weapon spawns, health packs and high ground; streaks; team plays.
- **Macro (days/weeks):** levels, missions, battle pass, ranks, clans, seasonal events, new maps.

---

## 4. Controls (desktop first)

| Action | Keyboard + mouse | Gamepad (Gamepad API) |
|---|---|---|
| Move | `A` / `D` | left stick X |
| Jetpack (thrust) | `W` or `Space` (hold) | L2 (LT) hold, or ✕ (A), or the left stick pushed steeply up (55°–125°) |
| Crouch / drop through platforms | `S` (hold) | left stick straight down (±30°) / L3 |
| Dash (8-way with `A`/`D`/`W`/`S`; none = facing) | `Shift` (tap), or double-tap a direction (setting) | L1 (LB) + left stick; a flick dashes harder |
| Aim | mouse cursor (world-space reticle) | right stick, reticle at the stick's reach (optional light aim assist, as touch's) |
| Fire | LMB (hold) | R2 (RT), analog threshold |
| Zoom cycle / secondary fire | RMB / wheel | R3 hold: spin-up / alt fire + zoom out · D-pad ← steps zoom |
| Reload | `R` | □ (X) |
| Swap weapon | `Q` / wheel | △ (Y) |
| Dual-wield toggle | `F` | D-pad ↑ |
| Melee | `V` / mouse 4 | ○ (B) |
| Grenade throw (tap) / aim (hold) | `G` | R1 (RB); hold aims the arc with the right stick |
| Cycle grenade type | `T` / mouse 5 | D-pad → |
| Pick up / interact | `E` | hold □ (X) |
| Heal wheel (BR) | `H` (hold) | to place when BR lands (D-pad ↓ is the shield) |
| Ping (BR/team) | `Z` / MMB | to place with team modes |
| Shield up / sling | `X` | D-pad ↓ |
| Scoreboard | `Tab` | Create / Share / View or touchpad (hold) |
| Menu | `Esc` | Options (Menu) |
| Chat / team chat / quick chat | `Enter` / `Y` / `C` (wheel) | to place (Options is the menu) |
| Emote wheel | `B` | — |

Everything is **rebindable** and has hold/toggle options. Mouse uses raw input with the pointer **not** locked (the reticle is a world-space cursor, like a mobile aim stick). There's a "confine cursor" option for multi-monitor setups. **Touch:** floating twin sticks (left: move, push up to jet, down to crouch, swipe and lift to dash; right: aim, firing past half-way or on release, a setting) plus buttons for grenade (hold and drag to aim the arc), next grenade, swap, reload, dash, melee, zoom and shield, a left-handed mirror, and a HUD editor (drag/resize/opacity per button, saved on the device). Optional light aim assist (a slowdown while the aim is on an enemy, never a pull), on by default for touch only. The controls produce the same input as the keyboard (`apps/web/src/touch`). **Controllers** (DualSense, DualShock 4, Xbox and other standard-mapping pads, through the Gamepad API): the same positions on every pad, prompts in its own glyphs, the menus driven by the D-pad or left stick (✕/A select, ○/B back, L1/R1 tabs), rumble, and Settings → Controller for layouts (Standard, the default above; Classic, Bumper Jet, Southpaw, One-stick), a live stick and button check, aim assist levels, remapping, sticks, triggers and vibration (`apps/web/src/gamepad`, NOTES §29; the zones are docs/design/controls-research.md §5).

---

## 5. Camera

- **Perspective camera**, FOV ≈ 35°, looking down −Z at the gameplay plane `z = 0`, slight downward tilt (5°) for depth.
- **Follow:** critically-damped spring on the player, plus **look-ahead toward the reticle** (up to 35% of the half-view), plus velocity lead while jetting.
- **Zoom:** camera distance from the weapon zoom level (03-weapons §10). Smooth 0.25 s transitions.
- **Shake:** trauma-based (adds to a trauma value, shake = trauma²), capped, with a reduced-motion setting.
- **Occlusion rule:** nothing in front of `z = 0` may hide the gameplay plane. Foreground props dither-fade when a player is behind them.
- **Spectator/killcam:** the same camera rig attached to another player's interpolated state, or the server replay.

---

## 6. Modes

| Mode | Players | Rules | Ship |
|---|---|---|---|
| **Deathmatch (FFA)** | 2–12 | most kills in 6 min or first to 30 | MVP |
| **Team Deathmatch** | 2 teams, up to 6v6 | team to 50 kills / 8 min | MVP |
| **Capture the Flag** | 2 teams, up to 6v6 | the flag takes a weapon slot and can be used as a melee weapon; dropped on death; first to 3 | Launch |
| **Drop Zone (BR)** | 32 (solo/duo/squad) | see 08-battle-royale | Launch (solo first) |
| **Training** | 1 + bots | tutorial, firing range, bot skirmish | MVP |
| **Custom rooms** | 2–16 | every mode + full rule control (07-rooms §5) | MVP |
| **Gun Game** | 2–12 | weapon upgrades on each kill; machete kill to win | Post-launch |
| **One Shot** | 2–12 | snipers only, 1 HP | Post-launch |
| **VIP** | 2 teams | protect your VIP | Post-launch |
| **Plant the Bomb** | 2 teams | attack/defend, no respawns per round | Post-launch |
| **Survival (co-op)** | 1–4 vs waves of robots | a genre staple; ours is co-op | Post-launch |
| **Ranked** | DM/TDM/BR queues | unlock at level 15 + 10 wins; OpenSkill | Launch+1 season |

---

## 7. Maps

Standard maps are about **120 × 60 m** (fit for 6–12 players); BR uses the 480 × 140 m Strip (08). Each standard map has a distinct gimmick and a distinct palette, so screenshots are instantly recognisable.

| # | Working name | Inspired by (archetype) | Layout | Gimmick | Ship |
|---|---|---|---|---|---|
| 1 | **Outpost** | classic base map | multi-level base with bushes | bushes hide crouched players (rendering only, never collision) | MVP |
| 2 | **Catacombs** | underground tombs | long corridors, sniper lanes | rare Ripper spawn; darkness pockets | MVP |
| 3 | **Highrise** | tower map | vertical skyscraper shaft + rooftops | the Widow spawns on the roof (race for it) | MVP |
| 4 | **Street Market** (the Lagos map) | original | dense rooftops, danfo buses, stalls | breakable awnings (one-way platforms) | Launch |
| 5 | **Mumbai Local** | original | train yard + moving train (kinematic platform) | the train passes every 45 s and pushes players | Launch |
| 6 | **Snowblind** | snow map | open slopes, ice caves | slippery ice (lower ground friction) | Launch |
| 7 | **Lunar** | moon base | low gravity everywhere | jet fuel lasts longer (built as map rules, 02-physics §20; the Lunar Outpost demo below) | Launch |
| 8 | **Pyramid** | desert ruins | central pyramid, tunnels | sand traps (slow zones) | Post |
| 9 | **Bottleneck** | chokepoint map | two bases + middle bridge | breakable glass bridge | Post |
| 10 | **Crossfire** | CTF symmetric | mirrored | built for CTF | Launch (CTF) |

**Map mechanics** (02-physics §20): any map can change the rules. **Rules** apply map-wide (low gravity, longer flights, shorter bullet range, slower movement, harder knockback). **Zones** are areas that do it locally: zero-g, low-g, reversed gravity, long flight, bullet fog, wind, mud, deep water, jump pads, boost pads, EMP fields. **Events** just happen, on a seeded schedule: a gravity surge, low gravity, an EMP storm, fog rolling in, wind gusts, a reversed-gravity pocket. Every event is announced with a banner a few seconds ahead. Three small demo maps show them off; play them locally with `/?map=<id>`, online with `MAP=<id> pnpm dev` (or the server's `--map=<id>`):

| Demo map | Rules | Zones | Events (seeded, about every 35–45 s) |
|---|---|---|---|
| **Lunar Outpost** (`lunar-outpost`) | gravity ×0.45, fuel burn ×0.75 | a zero-g hab dome, jump pads in two craters | solar flare (EMP), gravity generator (Earth gravity) |
| **Storm Front** (`storm-front`), authored as map JSON | — | a gale over the rooftops, sea fog that eats bullets, deep water in the harbour | squalls (gusts that turn around), fog rolling in, lightning (EMP) |
| **Flux Lab** (`flux-lab`) | — | jump and boost pads, an updraft shaft (long flight + wind up), an EMP field over a deck | gravity pockets over a catwalk, gravity surge, containment failure (low gravity) |

The `mechanics-test` map lines up every zone and event kind for golden replays and playtests.

**Map design rules** (enforced by the editor lint and playtests):
- 3 vertical layers minimum; no dead ends without a jetpack escape; sightlines ≤ the Widow's range.
- Spawn points ≥ 12 per map, scored at runtime: distance from enemies, line of sight to enemies, recent deaths nearby, armed mines nearby. Pick the best of 3 random candidates (anti-spawn-camping).
- Pits and void edges are clearly telegraphed (hazard stripes + fog).
- Each map has a **readability palette**: background desaturated, gameplay plane mid, players highest contrast.

**Map editor** (in-browser, ships for modders post-launch): polygon collision tool, prop placement in 3D depth layers, spawner nodes, zones, one-way platforms, a lighting preset picker, a "playtest now" button (local bot room), export to the compiled map format. Zones and events already have their editor data: `ZONE_KINDS`, `EVENT_KINDS` and `MODIFIER_FIELDS` (labels, defaults, colours, value ranges) in packages/content, and the map JSON Schema generated from them (`packages/content/schema/map.schema.json`, 02-physics §20.6). Genre communities have always made mod maps. Ours targets that creativity, with published community maps in custom rooms.

---

## 8. HUD (desktop)

```
┌───────────────────────────────────────────────────────────────────────────────┐
│ ♥ 100 ███████████   ⛽ ██████▒▒▒          06:12        Kill feed:              │
│ [Hammer .44 6/30] [Hawk .50 15/60]       BLUE 12 – 9 ORANGE   Ade ▸⌖▸ Raja ★  │
│ 💣×3 (frag)  ⊕×1 (mine)                                        You ▸⌖▸ Kemi   │
│                                                                               │
│                              (world)        ⊕ reticle                         │
│                                                                               │
│ [minimap strip in BR]                       ping 48 · fps 144 (toggle)        │
│ chat (fades)                                 hit markers · damage arcs        │
└───────────────────────────────────────────────────────────────────────────────┘
```

Elements:
- **Health** with a regen shimmer.
- **Fuel bar** showing the regen-delay segment.
- **Weapon cards:** ammo, dual indicator, reload ring.
- **Grenade belt.**
- **Timer and score.**
- **Kill feed:** icons plus headshot, wallbang and void badges.
- **Hit markers** and **directional damage arcs**.
- **Low-ammo and low-HP cues.**
- **Ping/FPS** (toggle).
- **Network-problem icon.**
- **Pickup prompts** with key glyphs.
- **Scoreboard (Tab):** kills, deaths, assists, score, ping, and mute/report buttons.

---

## 9. Progression (overview, details in 13-master-checklist §R)

- **Account level** from XP (match completion, kills, wins, missions). There are 100 levels, and each level grants a cosmetic, with a small currency drop every 5 levels (17 §2.3).
- **Ranks** are a separate competitive ladder, with seasonal soft resets.
- **Missions:** 3 dailies + weekly challenges (never require custom rooms).
- **Battle pass:** 8–10 week seasons, free + premium tracks, finishable in ~45 min/day, retroactive unlocks on late purchase.
- **Weapon mastery** (cosmetic only): kills with a weapon unlock skins, kill-feed badges and inspect animations.
- **Stats:** lifetime + seasonal, per-weapon, heatmaps of your own deaths per map (fun and educational).

---

## 10. Monetisation (cosmetics only)

> The owner, 28 Oct 2026: the game is **18+**; it has **its own premium currency** (no cash-out, no trading for money); gun skins and looks are sold on some guns, **always with the same stats as the base gun**; players design custom gun looks (with their own AI if they like) and we sell **loadout space**: one custom look free, more slots bought. The full spec is [17](17-store-currency-and-forge.md).

- **18+.** The game is for adults. The store, the currency and the Forge need an account that passed the 18+ gate (17 §2.6); guests can play. 18+ relaxes none of the rules below.
- **One premium currency** (name to pick: Brass, Ingots or Tags, 17 §2.1). It's bought in bundles sized to item prices and earned in small fixed amounts (battle pass tracks, levels). It never leaves the game: no cash-out, no transfers, no trading. Every price is also shown in local money (naira, USD). This replaces the earlier Coins + Gems plan.
- **What's sold:** gun skins on six guns (K-47, Hammer .44, Hawk .50, Widow, Breacher, Hornet; never on power weapons, the machete, the shield or grenades), character looks, named characters, the battle pass (with a **free track**), Forge slots, and the Founder's Pack. Every look passes the visual-advantage review (17 §3.4): no darker, glowier, quieter or smaller-than-base looks. Top-tier skins reshape the gun's parts inside its footprint (17 §3.6) and add a kill effect everyone sees, ≤ 1 s, inside the victim's body envelope, never hiding the dropped weapon, the killer or the kill feed (17 §3.7).
- **The Forge:** custom gun looks from our part library, dyes, decals and FX, as a JSON spec validated on the server; never player code (17 §4).
- **Store:** a rotating daily/featured shop, bundles, character packs, and the battle pass. **No paid random items of any kind** (Belgium bans them, Brazil bans them for under-18s from 17 Mar 2026, and Australia rates them M or higher).
- **Spending limits** on by default, refunds, and an append-only ledger (17 §2.5–2.6).
- **Rewarded ads** (opt-in only): a free daily spin, double XP for a match, a store reroll. Never mid-match, never in ranked queues. They never grant currency; whether the spin becomes a fixed daily reward is open (17 Q9).
- **Portal builds** (CrazyGames/Poki) use their SDKs for ads, user identity and purchases where supported.
- **In-world billboard ads** (city maps only; see [14](14-in-world-advertising.md)): businesses buy frames on rotating mid-depth billboard screens, the way Lagos Life sells them. They're direct-sold, and a human reviews every creative before anyone sees it. Targeting is contextual only (country, map, mode, week), never personal. Readability rules keep ads off the gameplay plane and off every gameplay signal, cap them at ≤ 2 surfaces in view, and grade them into the map's background palette so players stay the highest-contrast thing on screen. No purchase changes what billboards show. Portal builds show house art. It starts as a hand-sold Nigeria pilot at soft launch.
- **Regional pricing** + local payment methods (UPI in India; Paystack/Flutterwave in Nigeria; Xsolla as the global merchant of record).
- Supporter pack ("Founder's Pack", a one-time ~$2.99, launch season only): a cosmetic set, a profile badge and an extra Forge slot. Players in this genre love a small one-time unlock; ours never gates gameplay.

---

## 11. Differentiation vs. the genre's mobile classics

| | Typical mobile jetpack shooter | Our game |
|---|---|---|
| Platform | mobile app | **browser, instant join by link** (desktop first, touch later) |
| Visuals | 2D sprites | **3D 2.5D**: lighting, depth parallax, character models |
| Anti-cheat | client-trusting (mod APKs everywhere) | **server-authoritative from day 1** |
| Monetisation | paid unlocks → crates (pay-to-win backlash) | **cosmetics only** |
| Social | LAN + online rooms | groups, room codes/links, browser, friends, clans, quick chat |
| Modes | DM/TDM/CTF/Survival | + **drop-in battle royale**, ranked, custom rules, map editor |
| Servers | limited regions | **regional servers incl. Mumbai + Johannesburg (for Nigeria)** from soft launch |

---

## 12. Naming, IP and clean-room rules

- **Do not** use any other game's name, branding, character names, map names verbatim, UI art, sounds, or any ripped assets. Game mechanics aren't copyrightable; trade dress and assets are.
- Our maps reuse **archetypes** (tower, tombs, base), never copied layouts. The working map names above (Outpost, Catacombs, Pyramid, Bottleneck, Crossfire) are **placeholders to rename** before launch.
- Weapons use original names (03-weapons §2).
- **Name: "Military Forge".** Chosen 17 Oct 2026 after a preliminary screen (web, app stores, US trademark mirrors) found no game or game-software mark with that name. Before spending on branding:
  1. Run full clearance searches: USPTO (TSDR), EUIPO, UK IPO, **India IP office**, Nigeria's trademark registry, and the WIPO Global Brand Database, in classes 9 and 41.
  2. Get a short written opinion from a trademark lawyer.
  3. Keep the name in a single config constant (`GAME_NAME`, package scope, domain) so a rebrand stays cheap.
  4. Never use other games' names in ads, store keywords or metadata.
- Register the domain and social handles once the name clears.
- Get a short IP review from a lawyer before any comparative marketing.

---

## 13. Success metrics (first 90 days after launch)

| Metric | Target |
|---|---|
| Time from landing to first match | p50 ≤ 15 s |
| First-match completion | ≥ 80% |
| D1 / D7 / D30 retention | ≥ 30% / 10% / 4% (2026 mobile top-quartile benchmarks are ~30% / 6–7% / 1.6–1.8%; web .io games skew lower, so this is ambitious) |
| Prediction corrections | < 1 per minute per player at ≤ 150 ms RTT |
| Crash-free sessions | ≥ 99.5% |
| Tick p99 | < 10 ms |
| Cheater reports per 1k matches | trending down month over month |
| Group play share | ≥ 35% of matches have a 2+ person group |
