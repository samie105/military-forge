# 06 — System Architecture

> How the pieces fit: client layers, game servers, backend services, data, the shared sim, and how code moves from a laptop to production.
> Related: 02-physics (sim internals) · 05-netcode (wire protocol) · 07-rooms-matchmaking-social (flows) · 09-infrastructure (where it runs).

---

## 1. Bird's-eye view

```
                                   ┌───────────────────────── Cloudflare ─────────────────────────┐
  Browser (desktop first)          │  DNS · CDN (static client, GLB/KTX2 assets, audio) · WAF/API  │
 ┌──────────────────────────┐      └───────────────┬───────────────────────────────┬──────────────┘
 │ App shell (React UI)     │   HTTPS (REST)       │                               │ WSS (social)
 │  menus · lobby · store   │ ───────────────────▶ │ API service (Hono/Node)       │
 │  party · friends · chat  │                      │  auth · profiles · inventory  │◀──────┐
 ├──────────────────────────┤                      │  store · matchmaking front    │       │
 │ Game runtime             │   WSS                │  rooms registry · moderation  │       │
 │  sim (shared TS)         │ ─────────────────────┼──▶ Social gateway (uWS)       │       │
 │  net · render (Three.js) │                      │     presence · parties · chat │       │
 │  audio · input           │                      └────────┬──────────────────────┘       │
 └──────────┬───────────────┘                               │                              │
            │ WebTransport (datagrams) ▸ fallback WebSocket │   Postgres   Redis/Valkey      │
            │ game traffic goes DIRECT to a region          │   (truth)    (presence, queues,│
            ▼                                               │              room registry,   │
 ┌─────────────────────── Region (e.g. FRA, BOM, LOS/JNB, SIN, IAD) ────────────────┐    │
 │  Game server nodes (N per region)        Fleet agent (heartbeat → Redis)          │────┘
 │   process per core: 8–15 rooms each      Ping beacon (latency probe endpoint)    │
 │   authoritative sim @60 Hz, snaps @30 Hz                                           │
 │   ─▶ match results → Redis Stream → worker → Postgres                              │
 └────────────────────────────────────────────────────────────────────────────────────┘
```

**Key idea:** keep the *control plane* (accounts, matchmaking, social) centralised and simple, and the *data plane* (game servers) regional and stateless. A game server never touches Postgres directly.

---

## 2. Monorepo layout (pnpm workspaces + Turborepo)

```
military-forge/                      # name pending trademark clearance (01 §12); package scope @military-forge/*
├─ apps/
│  ├─ web/                        # Vite + TS. React app shell + game runtime (Three.js)
│  ├─ game-server/                # Node 22 LTS (or Bun) + uWebSockets.js / WebTransport. Rooms.
│  ├─ api/                        # Hono on Node. REST + internal endpoints. Drizzle ORM.
│  ├─ social/                     # uWS gateway: presence, parties, invites, chat (Redis pub/sub)
│  ├─ worker/                     # BullMQ/Redis Streams consumers: match results, stats, emails, moderation
│  ├─ admin/                      # internal dashboard: players, reports, bans, live rooms, economy
│  └─ map-editor/                 # browser map editor (can also be a route inside web/)
├─ packages/
│  ├─ sim/                        # THE shared simulation: ECS, physics, weapons, modes. No DOM. Pure.
│  ├─ protocol/                   # binary schemas, bit-packer, message ids, version constants
│  ├─ content/                    # weapons/cosmetics/maps/tuning JSON + zod schemas + build to binary
│  ├─ netcode/                    # client prediction, interpolation buffers, clock sync, reliability layer
│  ├─ render/                     # Three.js scene graph helpers, character assembler, VFX, materials
│  ├─ ui/                         # shared React components/design tokens
│  ├─ bots/                       # bot AI (behaviour trees). Used for fill-bots, tests, load tests
│  └─ shared/                     # utils: PRNG, math (sim trig), pools, typed events, logger
├─ tools/
│  ├─ asset-pipeline/             # gltf-transform scripts: meshopt, KTX2, atlases, LODs, budgets check
│  ├─ loadtest/                   # headless clients (Node) that speak the real protocol
│  └─ replay-viewer/              # loads .replay files (input logs) and re-simulates
└─ infra/                         # Terraform/Pulumi, Docker, Ansible/Nomad/K8s manifests, Grafana dashboards
```

**Dependency rule (enforced by lint):** `sim` depends only on `shared` and `content`. `protocol` depends on `sim` types. Nothing in `sim` may import `render`, DOM, or Node APIs. That rule is what lets the exact same sim run headless on the server, in the browser, in a Web Worker, and in tests.

---

## 3. Tech stack (initial picks)

| Layer | Pick | Why |
|---|---|---|
| Language | **TypeScript everywhere** | one sim for client + server; one team skillset. Hot paths can be ported to Rust→WASM later without changing the architecture |
| Client build | Vite 8 (Rolldown), ES2022, code-split per route | fast HMR; game chunk lazy-loaded after the menu |
| Rendering | **Three.js r186 `WebGLRenderer`**; `WebGPURenderer` behind a flag (11-rendering §1) | biggest ecosystem/hiring pool; full control; ~155 KB brotli core |
| UI shell | React + Zustand, CSS modules / Tailwind | menus, store, social. **HUD is drawn in a separate lightweight layer** (DOM with transforms or canvas), not React re-rendering at 60 fps |
| ECS | **bitECS 0.4** (SoA typed arrays + serialization) in `sim` | zero-GC, cache-friendly, trivially snapshot-able |
| Game server | Node 22 LTS + **uWebSockets.js**; WebTransport endpoint (see 05-netcode for library choice) | fastest JS socket server; same runtime as the sim |
| API | **Hono** on Node + **Drizzle** ORM + zod | small, typed, edge-portable |
| DB | **PostgreSQL 16+** | relational truth: accounts, inventory, economy, social graph, stats |
| Cache/queues | **Redis/Valkey** | presence, parties, matchmaking queues, room registry, rate limits, leaderboards (ZSETs), Streams for results |
| Analytics | PostHog (self-host or cloud) → later ClickHouse | events, funnels, flags, A/B tests |
| Errors | Sentry (client + servers) | |
| Metrics/logs | Prometheus + Grafana + Loki (or Grafana Cloud free tier) | tick time, CCU, RTT, packet loss per region |
| Object storage | Cloudflare R2 | assets, replays, crash dumps; no egress fees |

---

## 4. Client architecture (layers)

```
┌──────────────────────────────────────────────────────────────────────┐
│ L5  App shell (React)   routes: /, /play, /room/:code, /store, /profile│
├──────────────────────────────────────────────────────────────────────┤
│ L4  Game session        GameSession {connect, join, leave, dispose}   │
│     bridges React ⇄ runtime through a typed event bus + Zustand store │
├──────────────────────────────────────────────────────────────────────┤
│ L3  Presentation        render (Three.js), HUD, audio, VFX, camera    │
│     reads sim state + interpolated remotes; never writes sim state    │
├──────────────────────────────────────────────────────────────────────┤
│ L2  Netcode             transport, clock sync, input send, snapshot   │
│     decode, prediction/reconciliation, interpolation buffers          │
├──────────────────────────────────────────────────────────────────────┤
│ L1  Simulation          packages/sim (identical to server)            │
├──────────────────────────────────────────────────────────────────────┤
│ L0  Platform            input devices, storage, asset loader, workers │
└──────────────────────────────────────────────────────────────────────┘
```

- **Main-thread budget at 60 fps (16.6 ms):** sim ≤ 1 ms, net decode ≤ 0.5 ms, render submit ≤ 6 ms, HUD ≤ 1 ms, everything else ≤ 2 ms. Leave headroom for GC and the browser.
- **Workers:** asset decoding (KTX2/meshopt decoders run in workers natively). **Design single-threaded:** `SharedArrayBuffer` needs COOP/COEP headers, which portal iframes (CrazyGames/Poki) generally don't provide. A transport-in-worker experiment can come later for the `web` build only, with `postMessage` transfer instead of shared memory.
- **Asset loading:** boot chunk < 2 MB (menu + one map + base character). Weapons, cosmetics and maps stream in by manifest with content hashes, cached by a Service Worker (PWA) so return visits load instantly.
- **Tab-away behaviour:** browsers throttle `requestAnimationFrame` in background tabs. The net layer keeps a `setTimeout`-driven input heartbeat (sending "idle" inputs) so the server doesn't time you out, and the game shows an "AFK" badge. The server kicks for idle after a mode-specific timeout.

---

## 5. Game server internals

### 5.1 Process model
- One OS process per **physical core** (`cluster`-style or separate systemd units), each hosting many rooms. No shared memory between processes; each registers independently with the fleet.
- A single **tick scheduler** per process steps all its rooms. If one tick of all rooms exceeds 12 ms (75% budget), the process stops accepting new rooms (`draining_soft`) and alerts.
- Room isolation: an exception in a room's sim kills **that room only** (try/catch per room step). Players get "match error, returning to lobby" plus a Sentry report with the room's last 10 s of inputs attached (= a perfect repro).

### 5.2 Room lifecycle

```
CREATED ─▶ WAITING (lobby, players join, ready-up, host settings)
        ─▶ COUNTDOWN (5 s, spawn assignment, loadout lock)
        ─▶ IN_PROGRESS (60 Hz sim)
        ─▶ ENDING (scoreboard 10 s, results computed, MVP, XP)
        ─▶ POSTGAME (rematch vote 15 s) ─▶ WAITING | CLOSED
CLOSED  ─▶ results pushed to Redis Stream, registry entry removed, memory released
```

### 5.3 Per-tick system order (server)

| # | System | Notes |
|---|---|---|
| 1 | `InputIngest` | pull input for tick T per player from jitter buffer; missing → repeat last, mark `predictedInput` |
| 2 | `Commands` | weapon switch, reload, drop, pickup, emote, dual-wield toggle, grenade cook/throw |
| 3 | `Movement` | 02-physics §9–10 |
| 4 | `WeaponFire` | cooldowns, ammo, spread (seeded), hitscan with **lag compensation**, projectile spawn |
| 5 | `Projectiles` | CCD, bounce, stick, fuse |
| 6 | `Explosions` | radial damage, LOS, impulses, chain reactions |
| 7 | `Damage` | armour, multipliers, friendly-fire rules, assists bookkeeping, death → `Death` event |
| 8 | `Pickups/Triggers` | weapons, health, ammo, nitro, zones, jump pads |
| 9 | `ModeRules` | scoring, respawns, round end, BR storm, objectives |
| 10 | `Quantize` | 02-physics §15 |
| 11 | `History` | ring buffer (1 s) of hitbox poses for lag compensation |
| 12 | `Snapshot` (every 2nd tick) | per-client AOI + delta encode (05-netcode) |
| 13 | `Telemetry` (every 60th tick) | tick time, entity counts, bandwidth, anomaly scores |

The client runs 1–11 for its own player + its own projectiles (prediction) and nothing else.

### 5.4 Deploys without killing matches
- Game server builds are tagged with `protocolVersion`. The matchmaker only places a client into servers with an equal `protocolVersion`.
- Rollout: start new-version processes → mark old ones `draining` (no new rooms) → they exit when empty (max 25 min, after which remaining rooms get a graceful "server restarting" end with XP awarded).
- Clients with an old cached build get an `UPDATE_REQUIRED` response from the API and do a soft reload between matches (never mid-match).

---

## 6. Backend services

| Service | Responsibilities | Scales by |
|---|---|---|
| **api** | auth (guest + OAuth), profiles, inventory, store/IAP webhooks, match history, leaderboards read, reports, room creation/join-by-code, matchmaking enqueue, join-ticket minting | stateless, horizontal |
| **matchmaker** (module of api at first, own service later) | queue per (mode, region, ratingBand, partySize); ticks every 1 s; forms matches; allocates rooms via fleet registry; returns tickets | single leader (Redis lock) per region |
| **social** | WebSocket gateway for presence, party state, invites, friend requests, DMs/party chat, notifications | horizontal + Redis pub/sub fan-out |
| **fleet registry** | Redis hash per game-server process: region, url, capacity, rooms, players, cpu, version, state. TTL 10 s heartbeat | Redis |
| **worker** | consumes `match.results` stream: XP, currency, MMR (OpenSkill), stats, achievements, battle-pass progress, idempotent by `matchId`. Also moderation jobs, email, leaderboard snapshots | horizontal consumers |
| **admin** | search players, view reports + replays, ban/mute, grant items, economy dashboards, room inspector (spectate any live room), feature flags | internal only, behind SSO + IP allowlist |

### Join tickets (no DB calls on the game server)
The API signs a short-lived **Ed25519 JWT**:
```json
{ "sub": "u_8f2…", "nick": "SniperKing", "room": "r_91c…", "gs": "fra-03:2", "team": 1,
  "loadout": "c1.4.17.0.3.9", "party": "p_12…", "mmr": 1530, "flags": 0, "exp": 1760000030, "jti": "…" }
```
The game server verifies with the API's public key, checks that `room` and `gs` match itself, and rejects any `jti` it has already seen (replay protection). Cosmetic ownership was already checked by the API when it signed the ticket.

**Built so far:** `{iss, aud, sub, nick, room, iat, exp, jti, guns?}`.
- `guns` is the player's saved pair from `loadouts` slot 0, by weapon id.
- The API puts it in only when the pair still passes `loadoutGunIndices` from @military-forge/content: two different guns, no melee.
- The game server checks it again, gives it at the player's first spawn and at every match start, and otherwise uses the default pair.
- Respawns within a match keep the guns the player died holding (#125).
- Bots keep their own loadouts.

---

## 7. Data model (Postgres, first cut)

```
users(id, created_at, status[active|banned|deleted], age_band, country, locale)
identities(user_id, provider[guest|google|discord|apple|email], provider_uid, created_at)   -- guest → link later
profiles(user_id, nickname, nickname_norm UNIQUE, level, xp, avatar_loadout jsonb, title, banner, privacy jsonb)
sessions(id, user_id, created_at, expires_at, ua_hash, ip_prefix)                          -- refresh tokens
wallets(user_id, paid, earned, monthly_cap, cap_raise_at, store_locked_until, version)     -- one currency in two pools (17 §2.5); optimistic locking
ledger(id, user_id, pool[paid|earned], delta, balance_after, kind, ref_id, created_at)      -- append-only, double-entry; UNIQUE(kind, ref_id)
forge_slots(user_id, n, look jsonb, look_hash, state[valid|pending|rejected], reasons, updated_at)  PK(user_id,n)   -- 17 §4
forge_uploads(id, user_id, sha256, ai_generated bool, state, reviewer, reason, created_at)
items(id, kind[skin|head|hat|weapon_skin|emote|trail|banner|title|spray], rarity, data jsonb, released_at)
inventory(user_id, item_id, acquired_at, source)  PK(user_id,item_id)
loadouts(user_id, slot, data jsonb)
purchases(id, user_id, provider[stripe|paystack|razorpay|xsolla|portal], provider_ref UNIQUE, sku, amount, currency, status)
matches(id, mode, map, region, started_at, ended_at, server_build, result jsonb)
match_players(match_id, user_id, team, kills, deaths, assists, damage, accuracy, placement, xp_gained, mmr_before, mmr_after)
ratings(user_id, queue, mu, sigma, games, updated_at)                                       -- OpenSkill per queue
stats_lifetime(user_id, weapon_id, kills, shots, hits, headshots, damage, playtime_s)
friends(user_id, friend_id, status[pending|accepted|blocked], created_at)
clans(id, tag UNIQUE, name, owner_id, created_at, settings jsonb) ; clan_members(clan_id, user_id, role)
reports(id, reporter_id, target_id, match_id, reason, note, evidence_ref, status, handled_by)
sanctions(id, user_id, type[mute|ban|shadow_pool|name_reset], reason, starts_at, ends_at, created_by)
battlepass_progress(user_id, season, tier, xp, premium bool) ; missions(user_id, mission_id, progress, completed_at)
feature_flags / remote_config (or delegated to PostHog)
```

**Redis keys (illustrative):**
```
presence:{userId}            → {status, roomId?, partyId?, region, ts}  TTL 60
party:{partyId}              → hash (leader, members, mode, region, state)
mm:queue:{mode}:{region}     → ZSET(ticketId → enqueueTime) ; mm:ticket:{id} → hash
room:{code}                  → {roomId, gsId, region, mode, private, pwHash?}  TTL lifecycle
gs:{gsId}                    → hash heartbeat (state, capacity, rooms, players, cpu, ver)  TTL 10
lb:{board}:{period}          → ZSET(userId → score)
rl:{scope}:{key}             → token buckets (rate limits)
stream: match.results, moderation.events
```

**Built so far** (apps/api, Valkey via `REDIS_URL`, an in-memory stand-in without it for `pnpm dev` and tests):
- `room:{code}`: room codes, with a sliding 6 h TTL.
- `rl:{scope}:{key}`: fixed-window counters, not token buckets yet.
- `presence:{userId}`: `{status: online|in_room, room, ts}`, TTL 60 s, from the web client's 30 s beat (`PUT /me/presence`) and from room create/join.
- `lb:{board}:{all|YYYY-Www}`: leaderboards, rebuilt from Postgres when empty (docs/07 §12).

On a box with Valkey all four outlive an API restart; the trial box's Valkey also keeps an append-only file, so they outlive a reboot too. `KEEP_ROOMS` is only needed with the in-memory stand-in (pnpm playtest). Match results go over a signed HTTP call (`POST /internal/matches`), not `stream: match.results`.

**Tables built so far** (apps/api/src/db/schema.ts, migrations in apps/api/drizzle):
- The identity tables.
- `loadouts` (slots 0–2 of `{look, guns}`).
- `matches`, `match_players` and `stats_lifetime` (the totals in a `*` row, plus kills per source).
- The store (docs/17): `wallets` (paid and earned pools, the spending limit, the mint flag), `ledger` (append-only, `UNIQUE(kind, pool, ref)`), `payments` (Flutterwave; the id is the `tx_ref`), `inventory` (items bought or granted) and `store_audit` (the owner's grants, adjustments and refunds). apps/api/README.md "The store".

---

## 8. Content pipeline (data-driven everything)

```
content/*.json (weapons, grenades, cosmetics, modes, maps meta, tuning, loot tables, battle pass)
   │  zod validate + cross-ref check (ids exist, rarity valid, balance lints)
   ▼
build-content → content.bin (compact, hashed) + types.d.ts
   │                    │
   ▼                    ▼
client bundle      game server         (both refuse to start on hash mismatch with protocol)
```

- Balance changes are **content-only deploys**: no code change, and the `contentHash` bump forces the matching client/server pair.
- Live tweaks without a deploy (careful): remote-config overrides for non-sim values only (store prices, event timers, XP multipliers). Sim values are always version-locked.

---

## 9. Testing strategy

| Layer | How |
|---|---|
| Sim unit tests | Vitest. Movement edge cases (02-physics §10), weapon cooldown math, explosion falloff, quantization round-trips |
| **Golden replays** | recorded input logs → re-simulate → compare per-tick state hashes. Run on every PR touching `sim/`. Bots aren't recorded: `ReplayFile.bots` lists them and `botReplaySetup` puts them back from the seed (packages/bots goldens: bot-vs-bot matches and a human with bots through a Match) |
| Protocol | fuzzing of decoders (random bytes must never crash, only reject), round-trip encode/decode property tests (fast-check) |
| Netcode | **network conditioner** in dev: artificial latency/jitter/loss/duplication per direction (both in the client transport and as a server flag). Test matrix: 50/150/300 ms × 0/2/10% loss |
| Bots | headless bot clients from `packages/bots` play full matches in CI (8 bots × 2 min) |
| Load | `tools/loadtest` spins up 1–5k bot connections against a staging region; watch tick time p99, bandwidth, memory |
| Soak | 24 h staging run with bots: memory leak detection (heap snapshots), room churn |
| E2E UI | Playwright: login as guest → quick play → join → leave; create room → join by code from a 2nd browser |
| Visual | screenshot tests of character customiser + HUD at 3 resolutions |

---

## 10. CI/CD

- GitHub Actions: lint → typecheck → unit → golden replays → build → (main branch) deploy to **staging** → bot smoke match → manual promote to prod.
- Client deploy: immutable hashed assets to R2/CDN + `index.html` with a short TTL. A version manifest endpoint lets the client detect updates.
- Game servers: container images (distroless Node), rolled out per region with draining (§5.4).
- API/social/worker: rolling deploys; DB migrations with Drizzle (expand → migrate → contract, never breaking the previous version).
- Every deploy posts to an internal channel with a changelog plus links to dashboards.

---

## 11. Environments

| Env | Purpose | Notes |
|---|---|---|
| `local` | docker-compose: Postgres, Redis, api, social, 1 game-server, web | `pnpm dev` starts all; seed script creates test accounts/items |
| `staging` | 1 small region, real infra shape | bots run 24/7; feature flags default ON |
| `prod` | multi-region | game servers per region; control plane in one region + read replicas later |
| `playtest` | ad-hoc, branch builds | password-gated; spun up per PR via preview deploys (client) + shared staging servers |
