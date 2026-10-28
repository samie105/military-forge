# 12 — Roadmap, Team, Risks & First Two Weeks

> The assumptions are a **small team (3–4 core people)**, an indie budget, desktop first. Durations are honest estimates for that team. Halve the team and the time roughly doubles; the order stays the same.

---

## 1. Team shape

| Role | Load | Owns |
|---|---|---|
| Gameplay + netcode engineer (TS) | full-time | `sim`, `netcode`, `protocol`, game server, movement and gunfeel |
| Full-stack engineer (TS) | full-time | API, social, matchmaker, accounts, store, admin, infra/CI |
| Client/UI engineer (TS, React, Three.js) | full-time (can be the same person as full-stack early on) | render layer, HUD, menus, locker, VFX integration, audio engine |
| 3D artist / animator | contract → full-time by Alpha | characters, rig, clips, map kits, weapons, VFX textures |
| Sound designer | contract | weapon/impact/jetpack/UI SFX, music |
| Community/QA | part-time from Alpha | playtests, Discord, reports, moderation |

---

## 2. Phases & gates

### Phase 0: Prove the feel (4–6 weeks)
**Goal:** the jetpack + gunfeel is fun with programmer art, then fun online.

- `packages/sim` movement + collision + 3 weapons + grenades, rendered with a **debug 2D canvas** (lines and circles). Starting in 3D here is a trap.
- The tuning panel, the movement test map and golden replays from day 1.
- Netcode spike: 2–4 browsers through a local server with the network conditioner (prediction, interpolation, lag comp on one hitscan gun).
- Art style test in parallel: 1 character (rigged, 6 clips) + a 20 m map slice in Three.js.

**Gate:**
- ≥ 5 blind playtesters (including genre veterans) rate movement ≥ 4/5.
- At a simulated 150 ms / 2% loss: < 1 visible correction per minute and hits "feel fair".
- Art test approved.

### Phase 1: Vertical slice, online (8–10 weeks)
**Goal:** a stranger can open a link and play a real match against friends.

- Three.js render of 1 map, the base character with the aim offset, 5 weapons, frags + mines, Deathmatch.
- Rooms by code + link, guest accounts, one region (FRA), the HUD basics, the results screen, Play again.
- Game server process model, fleet heartbeat, join tickets, Sentry + metrics.
- Simple bots for testing and filling.

**Gate:**
- 12 players in one room across EU + India (via FRA) for 30 minutes.
- Tick p99 < 8 ms.
- Zero crashes.
- Weekly playtest NPS ≥ 30.

### Phase 2: Alpha (10–12 weeks)
**Goal:** all **MVP** items in 13-master-checklist.

- 3 maps, the 9 MVP weapons, TDM, Training/tutorial.
- Quick play matchmaking, groups/parties, regions FRA + BOM + JNB with beacons.
- AOI culling, lag comp polish, low-bandwidth mode.
- XP/levels/stats, settings + rebinding, basic cosmetics (dyes, 10 items), telemetry funnel.
- CI with golden replays + bot matches, staging with 24/7 bots.
- Closed alpha: invite codes, 200 → 1,000 players.
- Billboard groundwork (14 §8.1, 13 #704–707): `AdSlot` entity + lint, billboard structures in the Street Market (the Lagos map) and Mumbai Local kits, shared house-art pools, the array-texture renderer. House art only: no measurement, no sales. Measure the Nigerian and Indian share of web-build CCU in the closed alpha (14 §9.1 #8).

**Gate:**
- D1 ≥ 25% among alpha testers.
- Median matchmaking wait < 30 s at peak.
- Cheating: no successful state-tampering exploit found in an internal red-team day.

### Phase 3: Beta / soft launch (10–12 weeks)
**Goal:** all **L** items. The game is ready for strangers at scale.

- Drop Zone BR (solo), CTF, 7 maps, launch weapons, characters + Locker, store + battle pass S1 (cosmetics only).
- **Store and currency, K-47 pilot first** (17 §9, owner 28 Oct 2026): the ledger, bundles with money prices, spending limits and the 18+ store gate, then **one paid K-47 skin line** (Wrap, Skin, Forged) with the visual-advantage review (17 §3.4) automated for weapons. The other five skin-line guns, character looks, battle pass S1 (with its free track) and the Founder's Pack follow once the pilot's gate holds (ledger reconciles for 4 weeks, no V-check failures in the wild, refunds < 5%, no owner/non-owner K/D gap).
- Payments (Xsolla + regional methods), portal builds (CrazyGames first), compliance pack, 5 languages.
- Anti-cheat detection pipeline + admin review, reports, sanctions.
- Regions + SIN + IAD. Load test 5k bots. Status page.
- Open beta on our site + CrazyGames.
- **Billboard ads thin pilot** (14 §8.1): Nigeria only, Street Market + the Strip, premium units only, hand-sold by one part-time seller at the index rate card; every creative human-reviewed with an ARCON certificate; server-modelled delivery estimates; 20% house-art hold-out. Entry gate: a Nigerian entity + bank account (decision #9). Its own gate (≥ 5 paying advertisers, zero harmful ads, ≥ 50% renewal, no significant D7 drop) doesn't block the game's launch.

**Gate:**
- Load test: 5k CCU on staging with tick p99 < 10 ms.
- Crash-free sessions ≥ 99.5%.
- Legal review done.
- D7 ≥ 8% in beta cohorts.

### Phase 4: Launch (3–4 weeks of hardening + campaign)
Soak tests, a performance pass on low-end laptops and Chromebooks, a creator programme (Hindi and Nigerian creators first), trailer, press kit, a double-XP launch weekend, an on-call rota.

Billboard ads at launch (14 §8.1): hand-selling continues with a published naira + USD index card, Mumbai Local inventory and the Drop Sponsor (warm-up yard). The full ads stack (client measurement, automated proof of play, self-serve portal, dashboard, Map Takeovers) starts only after ≥ 8 paying advertisers, ≥ 50% renewal and ≥ ₦1.5M/month gross.

### Phase 5+: Seasons (every 8–10 weeks)

| Season | Headline | Also |
|---|---|---|
| S1 (launch) | Drop Zone solo, ranked DM | Founder's Pack; skin lines on six guns (17 §3.2) |
| S2 | **Touch controls + mobile web** (the core audience!) + HUD editor | duos/squads with knock/revive; **Forge v1** (K-47 library, SDK/CLI + MCP server, 1 free slot + slot sales, 17 §9) |
| S3 | Voice chat, clans | Gun Game, VIP; Forge uploads through review, then share codes and character looks; the battleground playlist if the owner wants it (17 §5) |
| S4 | Public map editor + community maps | WebTransport (UDP) |
| S5 | Capacitor apps (Play Store first) | Survival co-op, Plant the Bomb |

Billboard ads in the seasons (14 §8.1): mobile-web ads arrive with S2 touch controls. From Phase 5: programmatic fill for non-Nigerian geos (server-side only, every creative pre-approved), India direct sales via an agency (~10k CCU), Motion creatives, Highrise inventory.

**Total to public launch:** ~9–11 months with 3–4 people.

**Note on mobile:** we start desktop first, but the genre's audience is overwhelmingly on phones. **Season 2 mobile web is the most important post-launch milestone.** Everything in this plan (touch input layer, HUD editor, budgets, single-threaded design, portal mobile size limits) is already shaped to make it a feature, not a rewrite.

---

## 3. Decisions still open (owner → by when)

| # | Decision | Default if nobody decides |
|---|---|---|
| 1 | Game name: **Military Forge** chosen (preliminary screen) → full trademark clearance + lawyer opinion | clear before any branding spend (target: end of Phase 1); keep backups ready |
| 2 | Own netcode vs Colyseus 0.18 | own netcode (05 §16); revisit at the end of Phase 0 |
| 3 | Node vs Rust game server long-term | Node until tick p99 or cost forces it (likely Phase 5+) |
| 4 | GameLift vs Agones-on-bare-metal at growth | decide at 3k CCU based on team ops skill |
| 5 | Nakama for social vs custom | custom (small surface); Nakama if the backend engineer prefers off-the-shelf |
| 6 | Art style final (toon ramp vs flat) | decided at the Phase 0 art test |
| 7 | BR player count (32 vs 40) | 32, raise after perf data |
| 8 | Launch languages | EN, HI, PT-BR, ES-LATAM, ID; then Nigerian languages + Pidgin |
| 9 | Company entity/jurisdiction for payments (affects Paystack/Flutterwave, EU rep) | consult an accountant before Phase 3; a Nigerian entity + bank account is also the entry gate for the billboard ads pilot (14 §5.4) |
| 10 | Billboard ads: is the owner's "500 per screen" ₦500, ₦500k or $500? Per week or per month? Per frame or per whole screen? | the index rate card (14 §6.3): ₦500 is rejected; read as ₦500k or $500 per whole screen per month, it matches the card at ~1.3k / ~1.8k average web CCU (14 §6.2). Decide before the pilot's first sales call |
| 11 | The premium currency's name: Brass, Ingots or Tags (17 §2.1) | Brass, after a trademark screen with the game name |
| 12 | Store economics: naira tier, battle pass payback, tier skips, spend cap, premium Forge parts, Armoury creator rewards, the daily spin (17 §8 Q2–Q12) | the 17 §8 defaults; decide before the K-47 pilot opens |
| 13 | Build the battleground playlist (17 §5)? | not before ≥ 2,000 saved Forge looks or 10% of weekly players using one |

---

## 4. Risk register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Movement/gunfeel isn't fun | M | **Critical** | Phase 0 gate with veterans; tuning panel; ship nothing until feel passes |
| Netcode complexity overruns | M | High | spike in Phase 0; Colyseus 0.18 as a fallback; debugging tools first |
| Bandwidth bill grows faster than revenue | M | High | bit-packed snapshots, AOI, flat-bandwidth hosts, cost dashboard per player-hour |
| Cheaters ruin public lobbies | H | High | server authority from day 1 (kills the old mod-APK cheats); detection + shadow pool; reports with replays |
| IP/trademark claim from another game's owners | L–M | High | clean-room rules, original names/art, lawyer review, no other games' names in marketing |
| Mobile players can't play at launch (desktop first) | H | M–High | S2 mobile web; PWA; portals for discovery meanwhile |
| Africa/India latency | M | High | JNB + BOM from soft launch; beacons + data-driven region adds; Lagos bare metal at growth |
| Vendor shutdown (as with Hathora 2026) | M | M | containers + own allocator; no proprietary SDK in the hot path |
| Portal rule changes / rejection | M | M | own site first; SDK adapter layer; meet the requirements list |
| Scope creep (500+ items!) | **H** | High | strict MVP/L/P tags; every new idea goes to P unless it blocks a gate |
| Small-team burnout | M | High | seasons every 8–10 weeks, not 4; automate testing/deploys early |
| Child safety / compliance gaps | M | High | the game is 18+ (owner, 28 Oct 2026) with a gate before the store; safe defaults (quick chat only, voice off, contextual ads), compliance pack before monetisation |
| A paid look reads as pay-to-win (dark, glowing, camouflaged, quieter) | M | High | the 17 §3.4 review (automated + human), worst-case dye checks, owner/non-owner K/D parity telemetry, fix-for-everyone + refund rule (17 §2.5) |
| Forge abuse: hateful, trademarked or sexual decals, rude names | H | M–High | uploads always human-reviewed, F-code rejects, pending looks shown to others without uploads, report-to-hide, upload bans (17 §4.4) |
| Currency treated as money (gambling, payments or gaming-act rules) | L–M | High | no randomness for money, no cash-out, transfer or trading, an append-only ledger, refunds and spend limits, counsel review before the pilot (17 §2) |
| A harmful billboard ad reaches players (the Lagos Life failure) | M | High | human review of every creative before exposure, coded-term lists per language, automatic suspension on reports, kill switch, post-mortems (14 §5.5) |
| ARCON enforcement against in-game ads | M | M | ARCON certificate required for every Nigeria-targeted creative; counsel opinion before the pilot; flights end before approvals expire (14 §7.1) |

---

## 5. First two weeks (concrete)

**Week 1**
1. Create the monorepo skeleton (06 §2): `sim`, `shared`, `content`, `protocol`, `apps/web`, `apps/game-server`. Set up CI with lint, typecheck and test.
2. `shared`: PRNG, sim trig functions, pools, fixed-point/quantisation helpers + tests.
3. `sim`: collision world from a hard-coded polygon map; grid; capsule-vs-segment distance; raycast.
4. `sim`: player movement (walk, crouch, jetpack, fuel) with the 02-physics constants; move-and-slide.
5. `apps/web`: canvas-2D debug renderer + keyboard/mouse input + fixed-timestep loop + tuning panel (Tweakpane).

**Week 2**
6. The movement test map (ledges, slopes, ceilings, one-way platforms) + golden replay harness.
7. Weapons: hitscan (Hammer, Buzz) + seeded spread + muzzle-in-wall guard; frag grenade CCD + explosion.
8. Local "hot-seat" bots (dummies that strafe and jet) to shoot at.
9. `game-server`: uWS echo + tick loop + room with 2 players, raw inputs → server sim → full-state broadcast (no delta yet). Just prove the pipe.
10. First internal playtest (two machines, LAN) → tune → write down what feels wrong.
