# 13 — Master Checklist

> Everything we need to build, decide or check, so nothing gets missed. Tags: **MVP** = first playable / closed alpha · **L** = public launch · **P** = post-launch.
> Each item links back to the spec that details it (01–14). Copy sections into your issue tracker as epics.

**Totals: 739 items** — MVP 257 · Launch 362 · Post-launch 120

| Section | Items |
|---|---|
| A. Foundations & repository | 20 |
| B. Simulation & physics (02) | 45 |
| C. Weapons & combat (03) | 45 |
| D. Characters, animation & customisation (04) | 35 |
| E. Rendering, art & VFX (11) | 37 |
| F. Audio | 20 |
| G. Input & controls | 20 |
| H. Camera | 10 |
| I. Netcode & protocol (05) | 45 |
| J. Game server (06 §5) | 25 |
| K. Backend, API & data (06, 07) | 30 |
| L. Identity & accounts (07 §3) | 15 |
| M. Rooms, groups & matchmaking (07, 08) | 35 |
| N. Social & communication (07 §7–10) | 24 |
| O. Battle royale "Drop Zone" (08) | 41 |
| P. Modes, maps & editor (01 §6–7) | 23 |
| Q. UI/UX, menus, HUD & settings (01 §8) | 47 |
| R. Progression, economy & monetisation (01 §9–10) | 30 |
| S. Security, anti-cheat & abuse (10) | 30 |
| T. Infrastructure, DevOps & observability (09) | 34 |
| U. Analytics & live ops | 20 |
| V. Compliance, legal, accessibility & localisation | 26 |
| W. QA & testing (06 §9) | 20 |
| X. Launch, distribution, community & marketing | 26 |
| Y. In-world advertising (14) | 36 |

## A. Foundations & repository

- [ ] `001` **MVP** pnpm + Turborepo monorepo with `apps/` and `packages/` layout (06 §2)
- [ ] `002` **MVP** TypeScript strict mode, shared tsconfig, path aliases
- [ ] `003` **MVP** ESLint + Prettier + dependency-boundary lint (sim may not import render/DOM/Node)
- [ ] `004` **MVP** Vitest workspace config; coverage for `sim`, `protocol`, `netcode`
- [ ] `005` **MVP** docker-compose for Postgres, Redis, API, social, game-server, web
- [ ] `006` **MVP** `pnpm dev` starts everything with hot reload
- [ ] `007` **MVP** Seed script: test users, items, rooms
- [ ] `008` **MVP** Shared logger (pino) with request/room/match correlation ids
- [ ] `009` **MVP** Seeded PRNG (`xoshiro128**`) in `shared`
- [ ] `010` **MVP** Sim math library: `simSin/simCos/simAtan2/simExp` deterministic implementations (02 §15)
- [ ] `011` **MVP** Object pools and SoA component storage helpers
- [ ] `012` **MVP** Typed event bus between game runtime and React shell
- [ ] `013` **MVP** Content package with zod schemas and build-to-binary step
- [ ] `014` **MVP** `contentHash` + `protocolVersion` constants stamped at build
- [ ] `015` **MVP** Environment config loader with validation (no undefined env vars at runtime)
- [ ] `016` **MVP** Conventional commits + changelog generation
- [ ] `017` **L** Renovate/Dependabot for dependencies
- [ ] `018` **L** CODEOWNERS and PR template (incl. "touches sim? run golden replays")
- [ ] `019` **L** Architecture decision records (ADR) folder
- [ ] `020` **P** Public modding docs for maps/content format

## B. Simulation & physics (02)

- [ ] `021` **MVP** Fixed 60 Hz timestep loop with accumulator and catch-up cap
- [ ] `022` **MVP** Render interpolation alpha for the local player
- [ ] `023` **MVP** Collision world: polygons → segments, normals, flags, materials
- [ ] `024` **MVP** Map compiler validation (no self-intersections, merge collinear, CCW winding)
- [ ] `025` **MVP** Uniform grid broadphase (4 m cells)
- [ ] `026` **MVP** Grid DDA raycast (Amanatides–Woo) with per-query stamps
- [ ] `027` **MVP** Capsule (stadium) vs segment distance query
- [ ] `028` **MVP** Move-and-slide with substeps and up to 4 resolve iterations
- [ ] `029` **MVP** Velocity clipping against contact normals
- [ ] `030` **MVP** Ground/wall/ceiling classification by normal
- [ ] `031` **MVP** Step-up for small ledges (0.2 m)
- [ ] `032` **MVP** Ground snap on slopes (0.12 m)
- [ ] `033` **MVP** Max walkable slope (50°) and sliding beyond it
- [ ] `034` **MVP** Ceiling bonk + corner correction while flying up
- [ ] `035` **MVP** One-way platforms (pass from below, drop through with down)
- [ ] `036` **MVP** Walk/crouch acceleration, deceleration, reverse accel
- [ ] `037` **MVP** Air control with caps and excess-speed drag
- [ ] `038` **MVP** Jetpack thrust, ignition kick, ascent taper, fuel burn
- [ ] `039` **MVP** Fuel regen with ground/air rates and delays; min-ignite threshold
- [ ] `040` **MVP** Crouch with stand-up clearance check
- [ ] `041` **MVP** Hitboxes: head circle, torso capsule, legs capsule; crouch removes head zone
- [ ] `042` **MVP** Health, passive regen with delay
- [ ] `043` **MVP** Death, respawn timer, spawn point scoring
- [ ] `044` **MVP** KILL zones (void below map) and HURT zones
- [ ] `045` **MVP** Impulses: explosions (with LOS softening), melee knockback, air recoil push
- [ ] `046` **MVP** Knockback cap
- [ ] `047` **MVP** Simulated projectiles with swept-circle CCD
- [ ] `048` **MVP** Bounce with restitution and tangential friction; rest/roll detection
- [ ] `049` **MVP** Sticky projectiles (proximity mine)
- [ ] `050` **MVP** Explosion resolution: radial falloff, LOS to torso/head, chain reactions
- [ ] `051` **MVP** Quantize state at tick end (positions 1/1024 m, velocity 1/1024 m/s; see 02 §15)
- [ ] `052` **MVP** Stable entity iteration order; deterministic contact sorting
- [ ] `053` **MVP** NaN/Infinity guards with last-valid-state recovery + telemetry
- [ ] `054` **MVP** Movement test map with labelled ledges/slopes/corridors
- [ ] `055` **MVP** Golden replay test suite (input logs → state hashes)
- [ ] `056` **MVP** In-game tuning panel (dev builds) bound to live sim
- [ ] `057` **L** Melee lunge movement tech with cooldown
- [ ] `058` **L** Jump pads
- [ ] `059` **L** Breakable glass segments with HP and rebuild
- [ ] `060` **L** Explosive barrels with respawn
- [ ] `061` **L** Kinematic moving platforms as pure functions of tick
- [ ] `062` **L** Water/slow/ice zones (gravity, drag, friction modifiers)
- [ ] `063` **L** Gas cloud volumes with centre-weighted DoT, cleared by fire
- [ ] `064` **P** Teleporter pairs
- [ ] `065` **P** Ziplines

## C. Weapons & combat (03)

- [ ] `066` **MVP** Weapon content schema + validation + lints (DPS sanity per class)
- [ ] `067` **MVP** Two weapon slots + melee + grenade belt
- [ ] `068` **MVP** Fire modes: semi, auto, burst
- [ ] `069` **MVP** Hitscan with muzzle-in-wall guard (shoulder → muzzle check)
- [ ] `070` **MVP** Damage falloff (50% range → 50% damage)
- [ ] `071` **MVP** Headshot ×1.5; crouch removes head zone
- [ ] `072` **MVP** Seeded spread with move/air/crouch/dual modifiers + bloom
- [ ] `073` **MVP** Pellet weapons with even-distributed cone + jitter
- [ ] `074` **MVP** Reload (manual, auto on empty, cancel on swap, partial keep)
- [ ] `075` **MVP** Swap timings (sidearms faster)
- [ ] `076` **MVP** Weapon pickup/swap with current-held, drop with ammo, 30 s ground lifetime
- [ ] `077` **MVP** Ammo top-up by walking over same weapon
- [ ] `078` **MVP** Dual-wield toggle for two one-handed weapons
- [ ] `079` **MVP** Melee with per-weapon damage and arc hit test
- [ ] `080` **MVP** Frag grenade (bounce, 1.6 s fuse)
- [ ] `081` **MVP** Proximity mine (straight flight, stick, arm, trigger, shootable)
- [ ] `082` **MVP** Gas grenade cloud
- [ ] `083` **MVP** Grenade type cycling and pickups in pairs
- [ ] `084` **MVP** Rocket launcher projectile + splash + self-damage
- [ ] `085` **MVP** Sniper with 7× zoom; one-shot headshot
- [ ] `086` **MVP** Zoom levels → camera view width; zoom-on-pickup setting
- [ ] `087` **MVP** Default spawn loadout (mode-configurable)
- [ ] `088` **MVP** Map weapon spawners with pools and timers
- [ ] `089` **MVP** Health pack pickup
- [ ] `090` **MVP** Friendly-fire rules (bullets no; explosives/flames/melee yes)
- [ ] `091` **MVP** Kill credit, assists (≥ 25 dmg in 10 s), environmental kill credit (5 s)
- [ ] `092` **MVP** Scoring: +1 kill, −1 suicide/teamkill
- [ ] `093` **MVP** MVP weapon set: Hawk, Hammer, Buzz, Hornet, K-47, Trident, Widow, Breacher, Thumper
- [ ] `094` **L** Launch weapons: Rattler, Bullpup, Longbow, Dragon, Arc, Ripper, Machete, Riot Shield
- [ ] `095` **L** Flamethrower burn DoT + gas clearing + wall reflection
- [ ] `096` **L** Beam laser continuous ticks + cell regen
- [ ] `097` **L** Saw blade bounce + pierce + 5 s self-destruct
- [ ] `098` **L** Riot shield frontal block arc + HP + speed penalty
- [ ] `099` **L** Power Boost pickup (unlimited fuel 20 s, no crouch)
- [ ] `100` **L** EMP grenade (disables jetpacks, disarms mines)
- [ ] `101` **L** Power-weapon pickup announcements
- [ ] `102` **L** Heavy weapons can't reload while jetting
- [ ] `103` **L** Teamkill auto-kick threshold
- [ ] `104` **L** "Classic" ruleset (no falloff, crouch head-cover quirk)
- [ ] `105` **P** Popper grenade launcher
- [ ] `106` **P** Pulse EMP gun
- [ ] `107` **P** Shredder minigun with spin-up/down and pre-spin
- [ ] `108` **P** Weapon mastery tracks (cosmetic)
- [ ] `109` **P** Weapon inspect animations
- [ ] `110` **P** Balance dashboard per weapon (pick/kill share, TTK in practice)

## D. Characters, animation & customisation (04)

- [ ] `111` **MVP** Shared skeleton (~24 bones + sockets), naming convention doc
- [ ] `112` **MVP** Base character model (chibi, matches hitbox layout)
- [ ] `113` **MVP** Locomotion clips: idle, walk, run, crouch idle/walk, jet up, hover, fall, land
- [ ] `114` **MVP** Aim offset blend (5 poses) for pistol, dual, rifle families
- [ ] `115` **MVP** Off-hand IK on two-handed weapons; head look-at
- [ ] `116` **MVP** Facing turn (Y rotation) when aim crosses vertical
- [ ] `117` **MVP** Reload/swap/throw/melee upper-body actions
- [ ] `118` **MVP** Remote animation driven by interpolated velocity + state flags
- [ ] `119` **MVP** Client Verlet ragdoll on death mapped to bones
- [ ] `120` **MVP** Weapon attachment to sockets; dual-wield both hands
- [ ] `121` **MVP** Team colour outline + armband/visor channel
- [ ] `122` **MVP** Nameplates (team-coloured; enemies only on hover in BR)
- [ ] `123` **L** Aim offsets for shotgun, sniper, launcher, heavy, melee families
- [ ] `124` **L** Modular parts: head, hair, headgear, eyewear, mask, top, gloves, legs, boots, jetpack, backpack
- [ ] `125` **L** Body types (3) sharing the skeleton and hitboxes
- [ ] `126` **L** Runtime merge to single SkinnedMesh + texture array (1 draw call per character)
- [ ] `127` **L** Dye system with RGB mask channels
- [ ] `128` **L** Lazy cosmetic loading with default fallbacks
- [ ] `129` **L** Assembled-character cache by loadout hash
- [ ] `130` **L** LOD1 meshes for zoomed-out views
- [ ] `131` **L** 8 named characters (cosmetic presets with voice lines + bios)
- [ ] `132` **L** Locker UI: turntable, slot tabs, dye picker, presets (3), try-on
- [ ] `133` **L** Emote system (6 slots, wheel, cancel on move)
- [ ] `134` **L** Kill/death/spawn effects with budgets and low-quality variants
- [ ] `135` **L** Jetpack exhaust colour + trail cosmetics
- [ ] `136` **L** Headgear pop-off on headshot kills
- [ ] `137` **L** Knocked crawl, revive, heal animations (BR)
- [ ] `138` **L** Victory poses on results screen
- [ ] `139` **L** Cosmetic envelope check in asset pipeline
- [ ] `140` **L** Silhouette contrast lint vs map palettes
- [ ] `141` **L** Auto thumbnails for items
- [ ] `142` **P** Voice packs and lobby music cosmetics
- [ ] `143` **P** Facial expressions on events (kill, hurt, emote)
- [ ] `144` **P** "Classes" optional playlist with small perks (never in ranked)
- [ ] `145` **P** Sprays/stickers placed in world

## E. Rendering, art & VFX (11)

- [ ] `146` **MVP** Renderer bootstrap (WebGL2 baseline; WebGPU path behind flag)
- [ ] `147` **MVP** Scene layers: far background, mid depth, gameplay plane, foreground (dither-fade)
- [ ] `148` **MVP** Lighting preset per map (hemisphere + directional + baked light/AO in textures)
- [ ] `149` **MVP** Shadows: cheap blob/contact shadows on low; one cascaded/directional on high
- [ ] `150` **MVP** Muzzle flash, tracers, impact particles, explosions
- [ ] `151` **MVP** Decals for bullet impacts per material (pooled, capped)
- [ ] `152` **MVP** Jetpack flame VFX states (ignite, sustain, sputter)
- [ ] `153` **MVP** Graphics presets: Low / Medium / High / Auto
- [ ] `154` **MVP** Resolution scale + FPS cap settings
- [ ] `155` **MVP** Asset pipeline: glTF → meshopt + KTX2 (gltf-transform)
- [ ] `156` **MVP** Asset budget checker in CI (tris, textures, file size)
- [ ] `157` **MVP** Instancing for repeated props
- [ ] `158` **MVP** Texture atlases per map
- [ ] `159` **MVP** WebGL context loss handling + recovery + telemetry
- [ ] `160` **L** Map art for 7 launch maps with distinct palettes
- [ ] `161` **L** Gas cloud volumetric-ish sprite VFX
- [ ] `162` **L** Storm wall shader (BR) with distortion
- [ ] `163` **L** Screen-space effects on High only (bloom, colour grading LUT)
- [ ] `164` **L** Low-HP desaturation and vignette
- [ ] `165` **L** Hit-stop (2 frames) on melee hits
- [ ] `166` **L** Trauma-based camera shake with reduced-motion option
- [ ] `167` **L** Shell casings and debris particles with caps
- [ ] `168` **L** Water/lava/acid surfaces
- [ ] `169` **L** Weather variants (rain, snow) as cheap particles
- [ ] `170` **L** Day/night lighting variants per map
- [ ] `171` **L** Gore setting (off/low/full)
- [ ] `172` **L** Dynamic resolution scaling when FPS drops
- [ ] `173` **L** GPU timing via `EXT_disjoint_timer_query` in debug overlay
- [ ] `174` **L** Seasonal map skins pipeline (same collision, new art)
- [ ] `175` **P** WebGPU renderer as default where supported
- [ ] `176` **P** OffscreenCanvas rendering in a worker (evaluate; low value on 4-core devices)
- [ ] `177` **P** Destructible soft terrain regions (marching squares, integer crater events)
- [ ] `178` **L** Shader warm-up with `compileAsync` during loading (no first-shot hitch)
- [ ] `179` **L** Device pixel ratio cap per preset
- [ ] `180` **L** Auto quality detection over the first 300 frames
- [ ] `181` **P** Replay/killcam cinematic camera
- [ ] `182` **P** Photo mode

## F. Audio

- [ ] `183` **MVP** Web Audio graph: master → music / SFX / voice / UI buses
- [ ] `184` **MVP** Autoplay unlock on first user gesture
- [ ] `185` **MVP** Weapon fire sounds layered (mechanical + body + tail)
- [ ] `186` **MVP** Footsteps per material, jetpack loop with pitch by thrust
- [ ] `187` **MVP** Hit, headshot, kill confirm sounds
- [ ] `188` **MVP** Explosion with distance attenuation
- [ ] `189` **MVP** Stereo panning by screen position (2.5D)
- [ ] `190` **MVP** Volume sliders + mute when tab hidden
- [ ] `191` **L** Sound occlusion approximation (walls between → low-pass)
- [ ] `192` **L** Coarse off-screen gunfire audio cues from server sound events
- [ ] `193` **L** Reverb tail presets per map
- [ ] `194` **L** Voice limit / priority system (max simultaneous voices)
- [ ] `195` **L** Music: menu, lobby, match intensity layers, results
- [ ] `196` **L** Announcer lines (multikill, flag events, last alive)
- [ ] `197` **L** Character voice lines (quick chat, kills, hurt)
- [ ] `198` **L** Audio compression format (Opus/WebM + AAC fallback for Safari)
- [ ] `199` **L** Visual sound indicators (accessibility)
- [ ] `200` **L** Ear-ring effect on close explosions (reduced-motion aware)
- [ ] `201` **P** Proximity voice in custom rooms
- [ ] `202` **P** Lobby music packs as cosmetics

## G. Input & controls

- [ ] `203` **MVP** Keyboard + mouse mapping (01 §4)
- [ ] `204` **MVP** World-space reticle from mouse; aim angle quantisation
- [ ] `205` **MVP** Input sampled once per sim tick into ring buffer
- [ ] `206` **MVP** Edge-triggered actions derived in sim (replay-safe)
- [ ] `207` **MVP** Key rebinding UI with conflict detection
- [ ] `208` **MVP** Hold vs toggle options for crouch, zoom, jet
- [ ] `209` **MVP** Prevent browser shortcuts mid-match (e.g. Ctrl+W warning, Space scrolling, right-click menu)
- [ ] `210` **MVP** Focus loss handling (release all keys on blur)
- [ ] `211` **L** Gamepad API support + glyph switching
- [ ] `212` **L** Mouse sensitivity for reticle (and confine cursor option)
- [ ] `213` **L** Grenade aim mode with predicted arc preview
- [ ] `214` **L** Emote wheel, heal wheel, quick-chat wheel radial menus
- [ ] `215` **L** Keyboard layout awareness (AZERTY/QWERTZ via `KeyboardEvent.code`)
- [ ] `216` **L** Input latency measurement in debug overlay
- [ ] `217` **P** Touch twin-stick controls
- [ ] `218` **P** Mobile HUD layout editor (drag/resize/opacity, saved layouts)
- [ ] `219` **P** Touch aim assist (casual only)
- [ ] `220` **P** Gyro aim option
- [ ] `221` **P** Haptics (Vibration API / gamepad rumble)
- [ ] `222` **P** Left-handed touch preset

## H. Camera

- [ ] `223` **MVP** Perspective camera on gameplay plane, FOV ~35°
- [ ] `224` **MVP** Spring follow + look-ahead toward reticle
- [ ] `225` **MVP** Zoom transitions per weapon zoom level
- [ ] `226` **MVP** Camera clamped to map bounds
- [ ] `227` **L** Velocity lead while jetting
- [ ] `228` **L** Foreground occluder dither fade
- [ ] `229` **L** Spectator camera (follow / free in custom rooms)
- [ ] `230` **L** Killcam playback camera
- [ ] `231` **L** Death camera (orbit ragdoll then pan to killer)
- [ ] `232` **P** Cinematic map intro flythrough at match start

## I. Netcode & protocol (05)

- [ ] `233` **MVP** Transport abstraction (`GameTransport`) with WS implementation
- [ ] `234` **MVP** uWebSockets.js server, permessage-deflate off, TCP_NODELAY
- [ ] `235` **MVP** BitWriter/BitReader over pre-allocated buffers
- [ ] `236` **MVP** Message catalogue + IDs (HELLO, WELCOME, PING/PONG, INPUT, SNAPSHOT, EVENT_R…)
- [ ] `237` **MVP** Handshake with version/content hash checks and typed close codes
- [ ] `238` **MVP** Join ticket verification (Ed25519 JWT, jti replay protection)
- [ ] `239` **MVP** Clock sync (min-RTT offset, median RTT)
- [ ] `240` **MVP** Client tick lead + input buffer health feedback + time dilation
- [ ] `241` **MVP** INPUT packets with 3–4× redundancy
- [ ] `242` **MVP** Server input jitter buffer; repeat-last on missing input
- [ ] `243` **MVP** Snapshot local-player block (exact quantised state)
- [ ] `244` **MVP** Entity delta encoding vs acked baseline (32-snapshot history)
- [ ] `245` **MVP** Client prediction history ring (128 ticks)
- [ ] `246` **MVP** Reconciliation (exact compare → rewind & replay) + visual error smoothing
- [ ] `247` **MVP** Remote entity interpolation buffer with adaptive delay
- [ ] `248` **MVP** Extrapolation cap (100 ms) and reconvergence
- [ ] `249` **MVP** Lag compensation hitbox history (1 s) + rewind cap 300 ms (200 ms latency + 100 ms interpolation)
- [ ] `250` **MVP** Server-confirmed hit markers
- [ ] `251` **MVP** Predicted projectiles + server adoption + spawn fast-forward
- [ ] `252` **MVP** Projectile NEW/FIX/END records with redundancy
- [ ] `253` **MVP** Unreliable cosmetic events with redundancy + dedupe
- [ ] `254` **MVP** Reliable events (kills, scores, match state) via msgpackr
- [ ] `255` **MVP** Backpressure: skip snapshots when WS buffer > 16 KB
- [ ] `256` **MVP** Disconnect grace (20 s rooms / 60 s BR) + resume token + full resync
- [ ] `257` **MVP** Hard resync on large drift (tab sleep)
- [ ] `258` **MVP** Strict decoders: size/range checks, strikes, disconnect
- [ ] `259` **MVP** Per-connection token bucket rate limits
- [ ] `260` **MVP** Net graph overlay (RTT, jitter, loss, KB/s, corrections, interp delay)
- [ ] `261` **MVP** Network conditioner (client + server, per direction)
- [ ] `262` **MVP** Protocol fuzz tests + encode/decode property tests
- [ ] `263` **MVP** Server hitbox debug overlay + rewind visualiser
- [ ] `264` **MVP** Desync hash telemetry (local state hash echo)
- [ ] `265` **L** AOI view-rect culling at weapon max zoom (anti zoom/ESP)
- [ ] `266` **L** Coarse SOUND events for out-of-view gunfire
- [ ] `267` **L** Low-bandwidth mode (2 inputs per packet, lower snapshot rate)
- [ ] `268` **L** Per-build message-ID/field-order rotation
- [ ] `269` **L** Packet recorder and replay decoder tool
- [ ] `270` **L** Bandwidth regression check in CI (p95 snapshot size)
- [ ] `271` **L** BR AOI tiers + priority accumulator, ≤ 1000-byte snapshots
- [ ] `272` **L** Desync heatmap per map
- [ ] `273` **P** WebTransport transport via Rust gateway (quinn + web-transport)
- [ ] `274` **P** WT connection selection with 2 s timeout + reliability check + per-network memory
- [ ] `275` **P** Safari WT quirks handled (WT_MAX_SESSIONS, flow control, single bidi stream)
- [ ] `276` **P** Network transport + decode in a Web Worker (`web` build only; no SharedArrayBuffer in portal iframes)
- [ ] `277` **P** Rust port of server loop if tick p99 / cost requires

## J. Game server (06 §5)

- [ ] `278` **MVP** Process-per-core model with a shared tick scheduler per process
- [ ] `279` **MVP** hrtime drift-corrected loop (not setInterval)
- [ ] `280` **MVP** Room lifecycle state machine (WAITING → … → CLOSED)
- [ ] `281` **MVP** Per-tick system order (ingest → … → snapshot → telemetry)
- [ ] `282` **MVP** Room isolation: exceptions kill only the room, with input dump to Sentry
- [ ] `283` **MVP** Fleet agent heartbeat to Redis (capacity, rooms, players, cpu, version, state)
- [ ] `284` **MVP** Room allocation endpoint (internal) with atomic reservation
- [ ] `285` **MVP** Match results → Redis Stream (idempotent by matchId)
- [ ] `286` **MVP** Server-side input log per match (gzip) → R2 for replays
- [ ] `287` **MVP** Graceful drain on deploy (no new rooms, finish matches)
- [ ] `288` **MVP** Health/readiness endpoints
- [ ] `289` **MVP** Prometheus metrics (tick p50/p99, overruns, ELU, GC, bytes in/out)
- [ ] `290` **MVP** Idle/AFK detection and kicks
- [ ] `291` **MVP** Spawn point scoring (enemies, LOS, recent deaths, mines)
- [ ] `292` **L** Soft draining when tick budget > 75%
- [ ] `293` **L** Bots (behaviour trees at 10 Hz, staggered) in packages/bots
- [ ] `294` **L** Bot difficulty tiers (reaction, aim error, jet skill)
- [ ] `295` **L** Backfill support for DM/TDM rooms
- [ ] `296` **L** Host controls via CMD messages (kick, lock, settings)
- [ ] `297` **L** Spectator slots
- [ ] `298` **L** Anti-cheat feature vectors per player per match (10 §3)
- [ ] `299` **L** Kill leader / streak tracking
- [ ] `300` **P** Room migration between processes (live) for maintenance
- [ ] `301` **P** Dev "room inspector" spectate from admin
- [ ] `302` **P** Server-side killcam generation from history buffer

## K. Backend, API & data (06, 07)

- [ ] `303` **MVP** Hono API skeleton with zod validation and error envelope
- [ ] `304` **MVP** Drizzle schema + migrations (users, identities, profiles, sessions…)
- [ ] `305` **MVP** Rooms API: create, join by code (+password), browse
- [ ] `306` **MVP** Matchmaking ticket API + Redis queue
- [ ] `307` **MVP** Join ticket minting (Ed25519) and key rotation plan
- [ ] `308` **MVP** `/version` endpoint (minClient, protocol, contentHash, motd, maintenance)
- [ ] `309` **MVP** Worker: consume match results → matches, match_players, XP, stats
- [ ] `310` **MVP** Rate limiting (Redis token buckets) per IP and user
- [ ] `311` **MVP** Social gateway WS: presence, party state, mm events
- [ ] `312` **MVP** Regions endpoint + beacon URLs
- [ ] `313` **L** Inventory, loadouts, wallets with optimistic locking
- [ ] `314` **L** Append-only economy ledger
- [ ] `315` **L** Store catalogue + rotation scheduler
- [ ] `316` **L** Purchase flow + idempotent webhooks (per provider)
- [ ] `317` **L** Refund/chargeback handling → revoke + flag
- [ ] `318` **L** Battle pass progression + missions engine
- [ ] `319` **L** Leaderboards (Redis ZSET + periodic Postgres snapshots)
- [ ] `320` **L** Achievements engine
- [ ] `321` **L** Ratings (OpenSkill per queue) updates in worker
- [ ] `322` **L** Friends graph + requests + blocks
- [ ] `323` **L** Reports API with evidence references
- [ ] `324` **L** Sanctions table + enforcement at login, queue and chat
- [ ] `325` **L** Admin API (separate auth, audit log)
- [ ] `326` **L** GDPR/DPDP export + delete jobs
- [ ] `327` **L** Email service (magic links, receipts) via Resend/Postmark
- [ ] `328` **L** Remote config / feature flags (PostHog or self-hosted)
- [ ] `329` **P** Clans tables + API
- [ ] `330` **P** Gifting with anti-fraud limits
- [ ] `331` **P** Read replicas for profile/leaderboard reads
- [ ] `332` **P** Public API for stats (rate-limited) for community sites

## L. Identity & accounts (07 §3)

- [ ] `333` **MVP** Guest account creation on first visit
- [ ] `334` **MVP** Refresh token cookie + localStorage fallback in iframes
- [ ] `335` **MVP** Nickname rules + profanity/impersonation filter + normalisation
- [ ] `336` **L** Better Auth integration (anonymous plugin + linking)
- [ ] `337` **L** Google, Discord OAuth linking (Apple for iOS later)
- [ ] `338` **L** Email magic link and/or passkeys
- [ ] `339` **L** Account merge flow (choose progress to keep; never merge purchases silently)
- [ ] `340` **L** Portal identity adapters (CrazyGames, Poki) verified server-side
- [ ] `341` **L** Guest cleanup policy (30 days inactive, no purchases)
- [ ] `342` **L** Nickname change cooldown (7 days)
- [ ] `343` **L** Session list + log out everywhere
- [ ] `344` **L** New-device login alerts (linked accounts)
- [ ] `345` **L** Neutral age gate before chat / account linking
- [ ] `346` **P** 2FA for accounts with purchases
- [ ] `347` **P** QR code friend add / profile share

## M. Rooms, groups & matchmaking (07, 08)

- [ ] `348` **MVP** 6-char unambiguous room codes + share link `/r/CODE`
- [ ] `349` **MVP** Optional room password (Argon2id)
- [ ] `350` **MVP** Host settings: mode, map, players, time/kill limits, teams, bots
- [ ] `351` **MVP** Room lobby with ready-up and warm-up (no-damage) yard
- [ ] `352` **MVP** Rematch keeps room and players
- [ ] `353` **MVP** Quick play: region auto-select from beacons + manual override
- [ ] `354` **MVP** Matchmaker loop with MMR window widening
- [ ] `355` **MVP** Never create matches with 1 human; bot fill
- [ ] `356` **MVP** Estimated wait + cancel queue
- [ ] `357` **MVP** Parties (groups) up to 4 with leader, invite link, ready check
- [ ] `358` **MVP** Party queues as one ticket, never split
- [ ] `359` **MVP** Party persists between matches
- [ ] `360` **L** Weapon allow-lists and gameplay toggles (FF, infinite fuel, low gravity, regen, respawn delay)
- [ ] `361` **L** Host transfer on leave; host kick with room ban; lock room
- [ ] `362` **L** Team drag/shuffle; auto-balance option
- [ ] `363` **L** Public room browser with filters
- [ ] `364` **L** Join mid-round rules per mode
- [ ] `365` **L** Custom rooms excluded from ranked/missions; XP capped
- [ ] `366` **L** Room expiry (idle 10 min, hard 2 h)
- [ ] `367` **L** Backfill into running DM/TDM rooms
- [ ] `368` **L** Team balancing by MMR keeping parties together
- [ ] `369` **L** Region fallback to 2nd-best when queue thin
- [ ] `370` **L** Exclude regions > 250 ms
- [ ] `371` **L** No-show handling with requeue + penalty
- [ ] `372` **L** BR queue with hot-join onto plane
- [ ] `373` **L** Brute-force protection for room codes
- [ ] `374` **L** Ranked queue gating (level 15 + 10 wins)
- [ ] `375` **L** OpenSkill hidden MMR + visible ranks + season soft reset
- [ ] `376` **L** Party MMR blend (0.7 max + 0.3 mean)
- [ ] `377` **L** Leaver penalties in ranked
- [ ] `378` **P** Friends-only rooms
- [ ] `379` **P** Streamer mode (hide codes, names)
- [ ] `380` **P** Tournaments / brackets for custom rooms
- [ ] `381` **P** Clan-only rooms
- [ ] `382` **P** Community map rotation in custom rooms

## N. Social & communication (07 §7–10)

- [ ] `383` **MVP** Quick chat wheel (localised presets)
- [ ] `384` **MVP** Lobby/room text chat with filter and rate limit
- [ ] `385` **MVP** Mute player (local) and block
- [ ] `386` **L** Friends list with presence states
- [ ] `387` **L** Recent players list
- [ ] `388` **L** Join friend's joinable game
- [ ] `389` **L** In-app invites with expiry
- [ ] `390` **L** Web Push invites (opt-in)
- [ ] `391` **L** Team/all/party chat channels
- [ ] `392` **L** Chat off by default for under-13/unknown age; portal chat-disable respected
- [ ] `393` **L** Multi-language profanity normalisation (confusables, leetspeak) + allowlist
- [ ] `394` **L** Async AI moderation vendor integration
- [ ] `395` **L** Contextual pings (enemy, loot, go, danger)
- [ ] `396` **L** Emotes with cooldowns; mute hides emotes
- [ ] `397` **L** Report flow from scoreboard/kill feed/chat/profile/results
- [ ] `398` **L** "Action taken" feedback to reporters
- [ ] `399` **L** Privacy: appear offline, friends-only invites
- [ ] `400` **L** Profile page (level, rank, banner, title, stats, recent matches)
- [ ] `401` **P** Voice chat (LiveKit SFU) party/team, push-to-talk, per-player volume
- [ ] `402` **P** Voice off for minors; voice report buffer (on-device, upload on report)
- [ ] `403` **P** Clans: create, roles, tag, chat, XP, leaderboard
- [ ] `404` **P** Clan wars
- [ ] `405` **P** Discord rich presence / community bot
- [ ] `406` **P** Share clip to social (MediaRecorder WebM)

## O. Battle royale "Drop Zone" (08)

- [ ] `407` **L** Strip map 480 × 140 m with surface/underground/sky layers
- [ ] `408` **L** 8–10 POIs with loot density tiers
- [ ] `409` **L** Plane path (random direction), jump window, auto-eject
- [ ] `410` **L** Drop physics (unlimited fuel, capped fall, dive, steering)
- [ ] `411` **L** Landing protection (first shot or 1.5 s)
- [ ] `412` **L** Storm: left/right walls + ceiling + flood phases (data table)
- [ ] `413` **L** Storm schedule message; client-side storm sim
- [ ] `414` **L** Storm DPS ramp beyond heal rate late game
- [ ] `415` **L** Storm visuals, sounds, off-screen arrow, countdown
- [ ] `416` **L** Loot tables per container/POI tier (weighted, hierarchical)
- [ ] `417` **L** Rarity colour + shape coding
- [ ] `418` **L** Rarity stat multipliers (damage, mag, reload; never fire rate)
- [ ] `419` **L** Floor loot, crates, safes (channelled), supply drops (phases 2 & 4)
- [ ] `420` **L** Death crate with full inventory grid
- [ ] `421` **L** Armour vest/helmet tiers
- [ ] `422` **L** Heals: bandage, medkit, shield cell, adrenaline
- [ ] `423` **L** Ammo types per weapon family
- [ ] `424` **L** Backpack tiers (stack caps)
- [ ] `425` **L** Scopes tied to zoom/AOI
- [ ] `426` **L** Inventory UI + auto-pickup for ammo/heals
- [ ] `427` **L** Heal wheel + quick keys + cancel rules
- [ ] `428` **L** Alive counter, kill counter, placement
- [ ] `429` **L** Top-strip minimap with zone, drops, teammates, pings
- [ ] `430` **L** Spectate killer/teammate after elimination
- [ ] `431` **L** Results screen (placement, kills, damage, survival, XP)
- [ ] `432` **L** Kill leader crown (≥ 3 kills)
- [ ] `433` **L** Bots fill policy (new players, thin regions; none in ranked)
- [ ] `434` **L** Bot BR behaviours (loot, roam, fight, heal, flee storm)
- [ ] `435` **L** Hot-join onto plane while slots free
- [ ] `436` **L** Simultaneous-death tie rules
- [ ] `437` **L** BR AOI + loot entity streaming (static until touched)
- [ ] `438` **L** Teaming detection heuristic (solos)
- [ ] `439` **L** Disconnected player inventory crate after 60 s
- [ ] `440` **P** Duos and squads with knock/revive
- [ ] `441` **P** Jump-together for squads
- [ ] `442` **P** Redeploy beacon
- [ ] `443` **P** Arcade BR LTM (16 players, 1 respawn)
- [ ] `444` **P** Seasonal Strip skins (snow, Halloween, monsoon)
- [ ] `445` **P** Smoke grenade (BR)
- [ ] `446` **P** Nitro cans and deployable jump pads
- [ ] `447` **P** 40-player cap after performance validation

## P. Modes, maps & editor (01 §6–7)

- [ ] `448` **MVP** Deathmatch
- [ ] `449` **MVP** Team Deathmatch
- [ ] `450` **MVP** Training: tutorial (move, jet, aim, pick up, grenade, melee), firing range, bot skirmish
- [ ] `451` **MVP** 3 maps: Outpost, Catacombs, Highrise (placeholder names)
- [ ] `452` **MVP** Spawn points ≥ 12 per map with scoring
- [ ] `453` **MVP** Map format: collision polygons + render glTF + spawners + zones + metadata
- [ ] `454` **MVP** Map compiler CLI
- [ ] `455` **L** Capture the Flag (flag as melee weapon, takes a slot)
- [ ] `456` **L** 4 more maps (Lagos Market, Mumbai Local, Snowblind, Lunar) + Crossfire for CTF
- [ ] `457` **L** Map rotation and vote (3 options, avoid splitting playerbase: vote only in custom/long sessions)
- [ ] `458` **L** Map readability palettes and hazard telegraphing
- [ ] `459` **L** In-browser map editor (internal): polygon tool, props, spawners, zones, lighting presets
- [ ] `460` **L** Editor "playtest now" with local bot room
- [ ] `461` **L** Editor lints: layers, dead ends, sightlines, spawn safety, loot budgets
- [ ] `462` **P** Gun Game
- [ ] `463` **P** One Shot (snipers, 1 HP)
- [ ] `464` **P** VIP
- [ ] `465` **P** Plant the Bomb
- [ ] `466` **P** Survival co-op vs robot waves
- [ ] `467` **P** Infection
- [ ] `468` **P** Public map editor + community map publishing + moderation
- [ ] `469` **P** Map voting for community maps in custom rooms
- [ ] `470` **P** Limited-time modes framework (rules presets via content)

## Q. UI/UX, menus, HUD & settings (01 §8)

- [ ] `471` **MVP** Boot/loading screen with progress and tips
- [ ] `472` **MVP** Home screen: Quick Play, Drop Zone, Custom Rooms, Training
- [ ] `473` **MVP** First visit straight into tutorial-lite → bot match
- [ ] `474` **MVP** HUD: health, fuel (with regen segment), weapons/ammo, grenades, timer, score
- [ ] `475` **MVP** Kill feed with weapon icons and badges
- [ ] `476` **MVP** Hit markers (body/head), kill marker
- [ ] `477` **MVP** Directional damage indicator
- [ ] `478` **MVP** Scoreboard (Tab) with ping and mute/report
- [ ] `479` **MVP** Pickup prompts with key glyphs
- [ ] `480` **MVP** Death screen: killer, weapon, respawn timer
- [ ] `481` **MVP** Results screen + Play again + Back to lobby
- [ ] `482` **MVP** Settings: graphics, audio, controls, gameplay, accessibility, network
- [ ] `483` **MVP** Pause/menu overlay mid-match (game keeps running)
- [ ] `484` **MVP** Connection error and reconnecting UI
- [ ] `485` **MVP** "Update available" soft reload between matches
- [ ] `486` **L** Death recap (damage taken last 10 s, by whom)
- [ ] `487` **L** Killcam (server replay snippet)
- [ ] `488` **L** Low ammo / low HP cues
- [ ] `489` **L** Network problem icon + low-bandwidth suggestion
- [ ] `490` **L** Streak/multikill banners
- [ ] `491` **L** Optional damage numbers
- [ ] `492` **L** Party bar on home screen with invite link
- [ ] `493` **L** Friends panel (slide-out)
- [ ] `494` **L** Room lobby UI (teams, settings, ready, chat, spectators)
- [ ] `495` **L** Room browser UI
- [ ] `496` **L** Matchmaking status toast with ETA
- [ ] `497` **L** Store UI with real-money price display
- [ ] `498` **L** Battle pass UI (track, tiers, claim)
- [ ] `499` **L** Missions panel
- [ ] `500` **L** Profile & stats UI
- [ ] `501` **L** Leaderboards UI (global/region/friends; daily/weekly/season)
- [ ] `502` **L** News / MOTD panel and patch notes
- [ ] `503` **L** Maintenance banner with countdown
- [ ] `504` **L** Tooltips and contextual tips (first-time feature unlocks)
- [ ] `505` **L** Settings synced to account
- [ ] `506` **L** UI scale setting
- [ ] `507` **L** Reduced motion setting (shake, flashes)
- [ ] `508` **L** Crosshair customisation (shape, colour, size)
- [ ] `509` **L** Enemy outline colour setting
- [ ] `510` **L** Colour-blind modes (protanopia, deuteranopia, tritanopia)
- [ ] `511` **L** Subtitles/captions for announcer and key SFX
- [ ] `512` **L** Gamepad-navigable menus
- [ ] `513` **L** Fullscreen toggle + pointer confine
- [ ] `514` **P** Streamer mode
- [ ] `515` **P** Replay viewer UI (timeline, speed, camera)
- [ ] `516` **P** Clip export UI
- [ ] `517` **P** In-game event calendar

## R. Progression, economy & monetisation (01 §9–10)

- [ ] `518` **MVP** XP and account level (100 levels)
- [ ] `519` **MVP** Lifetime stats (kills, deaths, accuracy, per weapon)
- [ ] `520` **L** Level-up rewards (cosmetics/currency)
- [ ] `521` **L** First win of the day bonus
- [ ] `522` **L** Daily missions (3) + weekly challenges; reroll; stockpile up to 3
- [ ] `523` **L** Achievements with tiers
- [ ] `524` **L** Soft currency (Coins) earn rates + sinks
- [ ] `525` **L** Hard currency (Gems) packs with local prices; buy-what-you-need amounts
- [ ] `526` **L** Rotating store (daily, featured, bundles)
- [ ] `527` **L** Battle pass: free + premium, 8–10 weeks, retroactive unlocks, catch-up XP
- [ ] `528` **L** Founder's Pack (cosmetic supporter pack)
- [ ] `529` **L** No paid random boxes (legal) — enforce in content lint
- [ ] `530` **L** Payment providers: Xsolla (global MoR) + Stripe; evaluate Razorpay (UPI) and Paystack/Flutterwave (NG) approvals for virtual goods
- [ ] `531` **L** Regional price tiers (not FX conversions)
- [ ] `532` **L** Purchase confirmation with real price, seller identity, consumer rights
- [ ] `533` **L** EU 14-day withdrawal/refund policy flow
- [ ] `534` **L** Spend limits and parental controls for minors
- [ ] `535` **L** Rewarded ads: opt-in, server-side grant with nonce, daily caps
- [ ] `536` **L** Portal SDK adapter (CrazyGames, Poki, GameDistribution)
- [ ] `537` **L** gameplayStart/Stop, commercialBreak only between matches, mute during ads
- [ ] `538` **L** Works with ad blockers (no crash, no forced ads)
- [ ] `539` **L** Seasonal ranked rewards
- [ ] `540` **L** Economy dashboards (sources/sinks, inflation, conversion)
- [ ] `541` **P** Weapon mastery skins
- [ ] `542` **P** Gifting
- [ ] `543` **P** Creator codes (support-a-creator)
- [ ] `544` **P** Clan cosmetics
- [ ] `545` **P** Limited-time event shops and event currencies
- [ ] `546` **P** Subscription (ad-free + monthly cosmetic), evaluate. "Ad-free" covers rewarded and portal ads only, never in-world billboards (14 §1.3 rule 12)
- [ ] `547` **P** Native app store builds (Capacitor) with store IAP compliance

## S. Security, anti-cheat & abuse (10)

- [ ] `548` **MVP** Inputs-only protocol; server owns movement, ammo, fuel, damage, pickups
- [ ] `549` **MVP** Server loads its own content; client hash must match
- [ ] `550` **MVP** Input tick window check (reject far-ahead ticks)
- [ ] `551` **MVP** Fire rate enforcement server-side
- [ ] `552` **MVP** TLS everywhere; CSP; secure cookies; CORS allow-list
- [ ] `553` **MVP** No secrets in client; secret manager
- [ ] `554` **L** AOI-based anti-ESP/zoom
- [ ] `555` **L** Per-match anomaly features (snap velocity, reaction time, hit rate vs distance, tracking smoothness, fire timing entropy)
- [ ] `556` **L** Rolling account risk score
- [ ] `557` **L** Review queue with server replays + overlays in admin
- [ ] `558` **L** Sanction ladder (warn, mute, cooldown, shadow pool, temp, perm, name reset)
- [ ] `559` **L** Shadow pool matchmaking
- [ ] `560` **L** Ban waves process
- [ ] `561` **L** Ban evasion stack (identities, payment token, careful IP/ASN, soft fingerprint for security only)
- [ ] `562` **L** Appeals with statement of reasons
- [ ] `563` **L** Turnstile on risky endpoints
- [ ] `564` **L** Account takeover protections (breached password check, new device alerts)
- [ ] `565` **L** Webhook signature verification
- [ ] `566` **L** Admin behind SSO + 2FA + allow-list; audit log
- [ ] `567` **L** Minified/mangled bundle; private source maps; per-build protocol rotation
- [ ] `568` **L** Light integrity signals feeding risk score only
- [ ] `569` **L** Report abuse detection (down-weight bad reporters)
- [ ] `570` **L** XP farming prevention (custom rooms, AFK)
- [ ] `571` **L** Teaming detection in solo BR
- [ ] `572` **L** Smurf mitigation (ranked gating, fast MMR correction)
- [ ] `573` **L** Pen test before monetisation
- [ ] `574` **L** Incident response runbook (maintenance mode, key rotation, breach notification 72 h)
- [ ] `575` **P** WASM-compiled client sim/netcode (obfuscation)
- [ ] `576` **P** Bug bounty programme
- [ ] `577` **P** Native wrapper option for ranked integrity (evaluate)

## T. Infrastructure, DevOps & observability (09)

- [ ] `578` **MVP** Stage 0 single box (Frankfurt) running all services via Compose
- [ ] `579` **MVP** Neon Postgres + PITR
- [ ] `580` **MVP** Cloudflare DNS + CDN + R2 for client and assets
- [ ] `581` **MVP** Cache headers: immutable hashed assets, short TTL index.html
- [ ] `582` **MVP** GitHub Actions: lint, typecheck, test, golden replays, build
- [ ] `583` **MVP** Staging environment with 24/7 bots
- [ ] `584` **MVP** Container images (distroless, non-root)
- [ ] `585` **MVP** Sentry (client + servers) with private source maps
- [ ] `586` **MVP** Grafana Cloud (metrics + logs) free tier
- [ ] `587` **MVP** Uptime checks for API, social, each region beacon
- [ ] `588` **L** Regions: FRA/LON + BOM + JNB at soft launch; SIN + IAD at launch
- [ ] `589` **L** Game servers behind Cloudflare proxy (WS) to hide IPs
- [ ] `590` **L** Per-IP connection limits on game servers
- [ ] `591` **L** Region beacons (WS echo)
- [ ] `592` **L** Ansible/cloud-init node bootstrap; add region in ~1 h
- [ ] `593` **L** Terraform/Pulumi for cloud resources
- [ ] `594` **L** Rolling deploys with drain; version-routed matchmaking
- [ ] `595` **L** DB migrations expand → migrate → contract
- [ ] `596` **L** Dashboards: fleet, tick health, network quality, matchmaking, business, errors
- [ ] `597` **L** Alerts: tick p99, capacity, allocation failures, API latency, DB connections, error spikes
- [ ] `598` **L** On-call rotation + runbooks (region outage, DDoS, bad deploy, DB failover)
- [ ] `599` **L** Nightly logical backup to R2 + monthly restore drill
- [ ] `600` **L** Load test: 1–5k bot clients against staging
- [ ] `601` **L** 24 h soak test with heap snapshots
- [ ] `602` **L** Public status page
- [ ] `603` **L** Cost dashboard (bandwidth per region, per player-hour)
- [ ] `604` **L** Security headers check in CI
- [ ] `605` **L** Preview deploys for client branches
- [ ] `606` **P** Stage 2 orchestration: Agones on k3s or GameLift (+ Anywhere for Lagos)
- [ ] `607` **P** Regions: São Paulo, Lagos bare metal, Delhi/Bangalore, Gulf (re-evaluate)
- [ ] `608` **P** UDP DDoS protection (OVH Game / Path.net) for WebTransport
- [ ] `609` **P** Read replicas (SIN, GRU)
- [ ] `610` **P** Multi-region control plane failover plan
- [ ] `611` **P** Chaos testing (kill nodes, drop Redis)

## U. Analytics & live ops

- [ ] `612` **MVP** Versioned telemetry event schema
- [ ] `613` **MVP** Session start/end, match start/end, kill/death events
- [ ] `614` **MVP** Client performance samples (FPS, frame time, GPU tier, RAM)
- [ ] `615` **MVP** Network samples (RTT, loss, transport type, corrections)
- [ ] `616` **L** Funnel: load → first input → tutorial → first match → second match → link account → purchase
- [ ] `617` **L** Retention cohorts (D1/D7/D30) by region and portal
- [ ] `618` **L** A/B testing with stable bucketing + guardrails
- [ ] `619` **L** Feature flags + kill switches per feature
- [ ] `620` **L** Remote config (non-sim values: prices, XP multipliers, event timers, ad frequency, bot fill)
- [ ] `621` **L** Weapon balance dashboard
- [ ] `622` **L** Death/kill heatmaps per map
- [ ] `623` **L** Matchmaking health dashboard (wait times, bot ratio)
- [ ] `624` **L** Economy dashboard
- [ ] `625` **L** Patch notes pipeline
- [ ] `626` **L** In-game news / MOTD CMS
- [ ] `627` **L** Support ticketing linked to account ids
- [ ] `628` **P** Seasonal events calendar and tooling
- [ ] `629` **P** Limited-time mode scheduler
- [ ] `630` **P** Player surveys in-game (NPS after N matches)
- [ ] `631` **P** ClickHouse for high-volume event analytics

## V. Compliance, legal, accessibility & localisation

- [ ] `632` **MVP** IP clean-room rules: no original names, assets, sounds, layouts (01 §12)
- [ ] `633` **MVP** "Military Forge" full trademark clearance (US/EU/UK/India/Nigeria) + lawyer opinion; then domain + social handles
- [ ] `634` **L** Lawyer IP review of marketing copy ("inspired by")
- [ ] `635` **L** Terms of Service + Privacy Policy (versioned, localised, re-accept on change)
- [ ] `636` **L** Cookie/consent banner with equal "Reject all"; TCF v2.2 if programmatic ads
- [ ] `637` **L** Neutral age gate; under-13/16/18 branches
- [ ] `638` **L** COPPA compliance (separate parental consent for 3rd-party sharing; retention schedule; security programme)
- [ ] `639` **L** India DPDP readiness (parental consent < 18; no tracking/targeted ads at children; 72 h breach notice; log retention)
- [ ] `640` **L** Nigeria NDPA (parental consent, child-friendly notices, registration if designated)
- [ ] `641` **L** UK Online Safety Act children's access/risk assessments; ICO Children's Code DPIA
- [ ] `642` **L** EU DSA: notice-and-action form, statement of reasons, EU legal representative if needed
- [ ] `643` **L** GDPR: data map, processor agreements, rights handling, transfer safeguards
- [ ] `644` **L** Loot box law compliance (no paid random items; review Brazil/Belgium/Australia/UK/NL)
- [ ] `645` **L** Consumer law: real-money price display for virtual currency, refunds, seller identity
- [ ] `646` **L** European Accessibility Act check for store/checkout/chat (or microenterprise exemption documented)
- [ ] `647` **L** Age rating (IARC) for portals/app stores; gore setting defaults for PEGI 12
- [ ] `648` **L** Accessibility: remapping, hold/toggle, colour-blind, no colour-only info, UI scale, captions, visual sound cues, reduced motion, photosensitivity
- [ ] `649` **L** Localisation framework (ICU MessageFormat, plurals, externalised strings)
- [ ] `650` **L** Launch languages: English, Hindi, Portuguese (BR), Spanish (LATAM), Indonesian
- [ ] `651` **L** Fonts: Noto families incl. Devanagari, extended Latin (Yoruba/Igbo/Hausa diacritics)
- [ ] `652` **L** Pseudo-localisation tests (length, diacritics)
- [ ] `653` **L** Locale formats (numbers, dates, currency)
- [ ] `654` **P** Hausa, Yoruba, Igbo, Nigerian Pidgin, Bengali, Tamil
- [ ] `655` **P** Arabic with RTL layout + text shaping in canvas/WebGL
- [ ] `656` **P** Screen-reader friendly menus
- [ ] `657` **P** Contributor/translation community programme

## W. QA & testing (06 §9)

- [ ] `658` **MVP** Sim unit tests (movement edge cases, weapons math, explosions)
- [ ] `659` **MVP** Golden replays on every sim PR
- [ ] `660` **MVP** Protocol fuzzing + property tests
- [ ] `661` **MVP** Headless bot matches in CI (8 bots × 2 min)
- [ ] `662` **MVP** Netcode test matrix (50/150/300 ms × 0/2/10% loss)
- [ ] `663` **MVP** Playtest cadence: weekly internal sessions with feedback form
- [ ] `664` **L** Playwright E2E: guest → quick play → join/leave; create room → join by code
- [ ] `665` **L** Visual regression for locker and HUD (3 resolutions)
- [ ] `666` **L** Browser matrix: Chrome, Edge, Firefox, Safari (macOS); low-end laptop with iGPU
- [ ] `667` **L** Performance budgets enforced (bundle size, boot time, FPS on reference machines)
- [ ] `668` **L** Load + soak tests before each major release
- [ ] `669` **L** Security tests (OWASP ZAP baseline on API)
- [ ] `670` **L** Closed beta with region diversity (India, Nigeria, EU)
- [ ] `671` **L** Bug tracker triage SLAs; crash reproduction via input logs
- [ ] `672` **L** Localisation QA per language
- [ ] `673` **L** Accessibility QA pass (keyboard-only menus, colour-blind sims)
- [ ] `674` **P** Mobile browser test matrix (low-end Android Chrome, iOS Safari)
- [ ] `675` **P** Community test server (PTS) for balance patches
- [ ] `676` **P** Automated balance simulations with bots
- [ ] `677` **P** Replay-based regression suite from real matches

## X. Launch, distribution, community & marketing

- [ ] `678` **MVP** Closed alpha with invite codes
- [ ] `679` **L** Landing page with instant "Play" (no download)
- [ ] `680` **L** SEO basics (title, OG image, schema.org VideoGame)
- [ ] `681` **L** PWA manifest + install prompt + service worker cache
- [ ] `682` **L** Boot size budget (≤ 2 MB menu chunk; first match ≤ 10 s on broadband)
- [ ] `683` **L** CrazyGames build (≤ 50 MB first load, ≤ 20 MB for mobile homepage later, gameplay < 20 s, 4 GB Chromebook test, instant multiplayer flow, SDK integrations)
- [ ] `684` **L** Build targets: `web` (PWA), `portal` (no SW, relative paths, SDK adapter), `dev` (debug tools)
- [ ] `685` **L** Poki build (SDK, ad rules)
- [ ] `686` **L** itch.io / Newgrounds page for community reach
- [ ] `687` **L** Discord server with roles, bug reports, LFG channels
- [ ] `688` **L** Press kit (logo, screenshots, GIFs, fact sheet)
- [ ] `689` **L** Trailer (45 s gameplay)
- [ ] `690` **L** Creator programme (YouTube/TikTok, esp. Hindi and Nigerian creators)
- [ ] `691` **L** Social channels (TikTok, X, Instagram, YouTube Shorts)
- [ ] `692` **L** Launch event (double XP weekend, launch cosmetic)
- [ ] `693` **L** Feedback widget in-game
- [ ] `694` **L** Roadmap page for the community
- [ ] `695` **P** Community tournaments with custom rooms
- [ ] `696` **P** School/college LAN-party style events (the genre's roots)
- [ ] `697` **P** Native app builds via Capacitor (Play Store first)
- [ ] `698` **P** Steam page via Electron/Tauri wrapper (evaluate)
- [ ] `699` **P** Localised marketing for India, Nigeria, Brazil, Indonesia
- [ ] `700` **P** Esports-lite seasonal cups
- [ ] `701` **P** User-generated map spotlights
- [ ] `702` **P** Referral rewards (invite a friend cosmetic)
- [ ] `703` **P** Merch (evaluate)

## Y. In-world advertising (14)

- [ ] `704` **MVP** `AdSlot` map entity + editor lint rules 1–8: mid-depth only, size and count limits incl. highest zoom, hazard overlap, combat-heatmap check, moving-surface rules (14 §2.6)
- [ ] `705` **MVP** Billboard structures with `AdSlot` placeholders in the Lagos Market and Mumbai Local kits (junction tower, flyover, gantry, foot-over-bridge), so ads aren't retrofitted
- [ ] `706` **MVP** Shared house-art pools (≤ 8 images per format per map: fictional local businesses, notices, safety tips) for Lagos Market, Mumbai Local and the Strip
- [ ] `707` **MVP** Array-texture ad renderer: fixed ETC1S layer pools (≈ 5.1 MB per map), ≤ 2 draw calls, unlit and excluded from bloom, one 10 s beat with 0.5 s crossfades (14 §4.4–4.5)
- [ ] `708` **L** Signed ad manifest per map/geo/week (≤ 4 KB, hash-derived URLs); `adManifestUrl` in `mm.found` and room join responses; manual kill switch with `ads.revoke` + `EVENT_R` backup (14 §4.3)
- [ ] `709` **L** Creative pipeline in an isolated container (no network, no secrets): format, OCR, URL/QR/phone, signal-hue, glare and figure checks; KTX2 encode (14 §3.1, §3.5)
- [ ] `710` **L** Palette-relative creative grade + automated readability gate reusing the 04 §8 lint (skins, dye extremes, team outlines, enemy-highlight colours) → R09
- [ ] `711` **L** Game-server exposure bounds (05 §9 AOI rect, share at 1×) on a separate ads stream; reported as server-modelled estimates in the pilot (14 §4.7)
- [ ] `712` **L** Account-free delivery pipeline: signed match-scoped tokens in join tickets, unauthenticated batches at match end/pagehide → queue → async validation; no IPs stored; token mapping deleted ≤ 24 h
- [ ] `713` **L** Ad load policy: downloads after first spawn, layer uploads only while dead/in the yard/on the plane, ≤ 200 KB Drop Sponsor prefetch, none on Save-Data/2g/3g/low-bandwidth; "Download billboard images" setting
- [ ] `714` **L** Admin review queue: reason codes R01–R17, two reviewers for first creatives, language coverage + coded-term lists, seller ≠ approver, handle checks, re-review every 12 weeks
- [ ] `715` **L** Ad takedowns: automatic suspension (≥ 3 accounts in 30 min, or one trusted flagger), human decision ≤ 24 h, post-mortems, ads on the on-call rota
- [ ] `716` **L** Ads data model: advertisers with KYC (CAC/GSTIN, encrypted documents), flights, day-granular bookings, 10% make-good reserve, disputes (14 §5.1)
- [ ] `717` **L** Ads pilot ops: Paystack payment links, settled payment before a first flight, invoice template (VAT, WHT), chargeback → suspend + blocklist
- [ ] `718` **L** Weekly delivery PDF per flight: estimated viewable impressions and seconds + privacy-mode screenshots and clips (no names, HUD or chat)
- [ ] `719` **L** Counsel opinions: ARCON scope, filing and media-owner registration; NDPA treatment of ad measurement; DPDP s.9(3) on viewability counting for under-18s; ARCON children's provisions
- [ ] `720` **L** Settings → About ads, report-an-ad, website Sponsors page (per-geo-week sponsors file)
- [ ] `721` **L** House-art hold-out (20% in the pilot, 5% after launch; salted account hash) + readability survey + K/D parity check
- [ ] `722` **L** Ranked shows house art to everyone until the readability gate (`710`) is live
- [ ] `723` **L** Published ad rate card: index on billable Nigerian CCU, ₦25k floor, discount-stacking rules, monthly re-rate, demand rule, USD column (14 §6.3)
- [ ] `724` **L** Nigerian entity + bank account for Paystack settlement, VAT registration, WHT credit-note handling (ads pilot entry gate)
- [ ] `725` **L** Ad guarantees (50% of the model in the pilot, 70% of measured after), refund/make-good matrix, disputes process (14 §5.7, §5.9)
- [ ] `726` **L** Drop Sponsor on the warm-up yard Screens; deploy plane and supply drops never branded (lint)
- [ ] `727` **L** Mumbai Local ad inventory, incl. the MU-W1 wrap lint (never within 15 s of the gameplay train)
- [ ] `728` **L** Ads player-impact dashboard: frame cost, mask-frame p99, ad bytes per match, hold-out deltas (14 G4)
- [ ] `729` **L** Pen-test scope adds `apps/ads-portal`, the creative pipeline and the delivery collector; advertiser privacy notice
- [ ] `730` **P** Client IAB/MRC measurement: 320 × 180 two-channel mask, analytic areas, HUD rects, idle/visibility rules, Undetermined band (after the full-stack gate, 14 §8.1)
- [ ] `731` **P** Automated proof of play rendered from replays in privacy mode, reviewed before release
- [ ] `732` **P** Self-serve ads portal (`ads.<domain>`) with live map preview and book-now-certify-later flow
- [ ] `733` **P** Advertiser dashboard + public methodology page + CSV export
- [ ] `734` **P** Map Takeovers (72 h) and City Pass booking
- [ ] `735` **P** Programmatic adapter (Anzu via Playgama) behind the 14 §6.6 conditions: server-side only, per-creative pre-approval, never Nigeria
- [ ] `736` **P** India direct ad sales (agency-led; Razorpay + GST), from ~10k CCU
- [ ] `737` **P** Motion creatives (IAB 2 s rule) and the Drop Sponsor sky airship
- [ ] `738` **P** Highrise ad inventory; mobile-web ads (the touch HUD's rects feed the mask)
- [ ] `739` **P** Independent measurement-methodology review before agency and brand sales at scale
