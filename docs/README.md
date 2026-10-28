# MILITARY FORGE — Game Plan

> Name chosen 16 Oct 2026, **pending trademark clearance** (see [01 §12](01-game-design.md#12-naming-ip-and-clean-room-rules)).

A 3D, browser-based, online jetpack shooter built for the browser: rooms with friends, groups, quick play, and a drop-in battle royale.
This folder is the full pre-production plan, researched on **16 Oct 2026**, down to physics constants, bit layouts and server costs.

---

## Locked decisions

| Decision | Choice |
|---|---|
| Perspective | **2.5D**: 3D rendering, gameplay on a 2D plane (side view), like the genre classics |
| Platforms at launch | **Desktop browser first** (keyboard/mouse + gamepad); touch/mobile web in Season 2 |
| Budget | **Indie, scale later**: ~$50–110/mo in dev, ~$350–800/mo at soft launch; the architecture grows to 50k+ concurrent players |
| Language | TypeScript everywhere; one shared simulation for client + server |
| Client | Three.js r186 (`WebGLRenderer`), custom 2D kinematic physics, bitECS, Vite 8 |
| Netcode | authoritative server, 60 Hz sim, 30 Hz snapshots (20 Hz BR), prediction + reconciliation, interpolation, 300 ms lag-comp cap (200 ms latency + 100 ms interpolation) |
| Transport | WebSocket (uWebSockets.js) now; WebTransport datagrams in Phase 2 (all browsers since Safari 26.4) |
| Backend | Hono API + Postgres (Neon) + Redis/Valkey + own matchmaker + social WebSocket gateway |
| Hosting | Cloudflare (CDN/R2) + own allocator on flat-bandwidth VMs: FRA + Mumbai + Johannesburg first |
| Audience | **18+** (owner, 28 Oct 2026) |
| Monetisation | cosmetics only, same stats always; one premium currency (no cash-out or trading); gun skins on six guns; player-designed gun looks in the Forge with paid loadout slots; no paid random items; regional pricing ([17](17-store-currency-and-forge.md)) |

---

## Documents

| # | Doc | What's inside |
|---|---|---|
| 01 | [Game design](01-game-design.md) | pitch, pillars, core loop, controls, camera, modes, maps, HUD, progression, monetisation, IP rules, success metrics |
| 02 | [Physics & movement](02-physics-and-movement.md) | units, 60 Hz clock, collision world, broadphase, capsule controller, every movement constant, jetpack, move-and-slide algorithm, projectiles, grenades, explosions, determinism rules, ragdolls |
| 03 | [Weapons & combat](03-weapons-and-combat.md) | data schema, the 20-weapon arsenal with stats, TTK sheet, spread model, damage rules, dual-wield, zoom system, special mechanics, spawns, feedback |
| 04 | [Characters & customisation](04-characters-and-customization.md) | fairness rules, 8 launch characters, cosmetic slots, rig/animation layers, single-draw-call assembly, dyes, Locker UX, cosmetic pipeline |
| 05 | [Netcode & protocol](05-netcode-and-protocol.md) | transports, handshake, clock sync, message catalogue, **bit layouts**, lag compensation, prediction, AOI, interpolation, delta compression, bandwidth, debugging tools |
| 06 | [Architecture](06-architecture.md) | system diagram, monorepo, stack, client layers, game-server internals and tick order, services, join tickets, DB schema, Redis keys, testing, CI/CD |
| 07 | [Rooms, groups, matchmaking & social](07-rooms-matchmaking-social.md) | identity, parties, room codes, host settings, room browser, quick-play algorithm, OpenSkill ratings, friends, chat safety, API surface |
| 08 | [Battle royale "Drop Zone"](08-battle-royale.md) | 2D storm (walls + ceiling + flood), drop, loot and rarity, inventory, knocks/revives, bots, hot-join, phase table |
| 09 | [Infrastructure & hosting](09-infrastructure-and-hosting.md) | the 2026 hosting landscape, bandwidth math, machine sizing, region latencies (Lagos/Mumbai), providers per role, costed stages 0–3 |
| 10 | [Security & anti-cheat](10-security-and-anticheat.md) | threat model (incl. mod-APK cheats), architectural defences, statistical detection, sanctions, web security checklist |
| 11 | [Rendering, art & audio](11-rendering-art-audio.md) | engine picks + rejections, scene layers, performance and download budgets, art direction, asset pipeline, VFX catalogue, audio graph, boot sequence, build targets |
| 12 | [Roadmap](12-roadmap.md) | team shape, phases with go/no-go gates, open decisions, risk register, **first two weeks task list** |
| 13 | [Master checklist](13-master-checklist.md) | **778 tagged items** (MVP / Launch / Post-launch) across 26 areas, ready to paste into a tracker |
| 14 | [In-world advertising](14-in-world-advertising.md) | billboard ads on city maps (the Lagos Life model): hard readability and child-safety rules, surfaces and placements, creative spec, renderer and IAB/MRC measurement, account-free reporting, ad ops, the "500 per screen" pricing analysis and rate card, ARCON/DPDP/NDPA compliance, the thin Nigeria pilot |
| – | [Net trial](net-trial.md) | a hosted game server in the AWS Lagos Local Zone from one pasted cloud-init script: console clicks, links, the ping probe, results, costs |
| 16 | [Player metrics](16-player-metrics.md) | first-party play stats: the versioned event vocabulary, client batching and the game server's signed match stats, day-partitioned storage and rollups with measured cost, the owner's dashboard on /admin, consent (opt-in, GPC), Delete my data, ad segments, NDPA/POPIA/GDPR notes |
| 17 | [Store, currency & the Forge](17-store-currency-and-forge.md) | the owner's 28 Oct decisions: 18+, one premium currency (ledger, refunds, spend limits), which guns get paid skins, the visual-advantage review checklist with cited cases, the Forge (look spec, validation, review queue, SDK/CLI + MCP server for AI-made looks, paid loadout slots), the battleground playlist, red lines, open questions, the K-47 pilot rollout |
| 99 | [Sources](99-sources.md) | research links by topic |

---

## Cheat sheet: key numbers

| | Value |
|---|---|
| Sim / snapshots / inputs | 60 Hz / 30 Hz (BR 20) / 60 Hz × 3–4 redundancy |
| Interp delay · lag-comp cap | ~70–100 ms adaptive · 300 ms (200 ms latency + 100 ms interpolation) |
| Bandwidth per player | rooms 8–12 KB/s down, BR 12–20 KB/s; 2–4 KB/s up |
| Gravity · jet thrust · fuel | 20 m/s² · 38 m/s² · ~2.6 s burn, ~2.9 s ground refill |
| Health · headshot · regen | 100 · ×1.5 (none while crouched) · 6 HP/s after 4 s |
| Auto-weapon TTK | ~0.8–1.4 s (dual-wield ~0.7 s) |
| BR | 32 players, 480 × 140 m, ~7 min, storm walls + ceiling + flood |
| Server density (Node, estimate) | 8–15 eight-player rooms per core |
| Download | boot ≤ 2 MB, first playable ≤ 8 MB, gameplay ≤ 10 s |
| Lagos latency | Johannesburg ~75 ms · London ~105 ms · Frankfurt ~122 ms · Cape Town 240 ms |

## 2026 facts that changed the plan

- **Hathora shut down** game hosting (May 2026), and **Unity Multiplay** is deprecated. So: portable containers + our own allocator.
- **AWS GameLift made bandwidth free** on gen-6+ instances (Jun 2026). That's the managed option at growth stage.
- **Hetzner cloud prices ~2.5×** (Jun 2026). Flat-bandwidth providers still win.
- **WebTransport is in every major browser** (Safari 26.4, Mar 2026), with quirks (05 §2.3).
- **Colyseus 0.18** (Aug 2026) shipped prediction + lag compensation. It's our fallback if our own netcode overruns.
- **Portal iframes block COOP/COEP**, so the client is designed single-threaded.
- Loot-box laws tightened (Brazil 2026, Australia ratings): cosmetics only, no paid randomness.

## Where to start

Read **01 → 02 → 05**, then do **[12 §5 First two weeks](12-roadmap.md#5-first-two-weeks-concrete)**. The Phase 0 gate (is the movement fun?) decides everything else.
