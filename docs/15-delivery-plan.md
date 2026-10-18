# 15 — Delivery Plan: Phases 1–3 as Parallel Workstreams

> How the roadmap (docs/12 §2) is executed: who builds what, in which files, in what order, and how work merges.
> Started 17 Oct 2026, after Phase 0 (NOTES.md) and the netcode step (NOTES.md §9). Audit baseline: 69 / 63 / 121 of 253 MVP checklist items done / partial / missing.

---

## 1. Ground rules for every workstream

1. **Own your files.** Each workstream has an ownership list (§3). Edit outside it only for small, additive glue (an export, a route, a field). Say so in your PR description.
2. **Branch + worktree per workstream:** `ws/<name>`, cut from `main`. Rebase on `main` often (at least before each PR).
3. **PRs, small and green.** Open a PR to `main` at every milestone. Keep PRs under ~1,500 changed lines where possible. `pnpm lint && pnpm typecheck && pnpm test` must pass. Golden replay hashes may only change with an explicit explanation in the PR.
4. **Protocol changes are additive.** New message types or appended fields only. `PROTOCOL_VERSION` lives in one constant. The netcode workstream owns encoding layouts and reviews every protocol change.
5. **Determinism is sacred.** No `Math.random`/`Math.sin`/wall-clock time in `packages/sim` (lint enforces it). Every new sim feature gets unit tests and, when it changes outcomes, a golden replay.
6. **The game name lives only in** `packages/shared/src/brand.ts` (`GAME_NAME`, `GAME_SLUG`) and the `@military-forge/*` scope (trademark pending, docs/01 §12).
7. **Coordinate through notes.** Interface decisions others depend on go in the shared notes folder *and* in the PR description. The orchestrator session merges, resolves cross-stream conflicts and keeps this file current.
8. **Stop and ask the user** for anything needing accounts, money or legal choices: hosting providers, domains, payment providers, Higgsfield credits above ~25 per batch.

---

## 2. Waves

| Wave | Roadmap phase | Starts | Goal |
|---|---|---|---|
| **1** | Phase 1 (vertical slice online) + Locker pulled forward | now | A stranger opens a link, customises their soldier, joins a room by code, plays a real 3D-rendered deathmatch with the full arsenal, sees results, plays again |
| **2** | Phase 2 (alpha) | as soon as W3 (backend) and W4 (shell/match flow) land their first milestones | 3 maps, TDM, tutorial, quick play matchmaking, parties, regions + beacons, XP/levels/stats, settings, cosmetics (10+ items), telemetry, CI with bot matches, staging |
| **3** | Phase 3 (beta / soft launch) | when Wave 2 is in alpha playtests | Drop Zone BR (solo), CTF, 7 maps, store + battle pass (cosmetics), payments, portals, compliance, 5 languages, anti-cheat pipeline + admin, load tests, in-world billboard ads pilot (docs/14) |

---

## 3. Wave 1 workstreams

| ID | Name | Delivers | Owns (files) | Depends on |
|---|---|---|---|---|
| **W1** | `render3d` | Three.js renderer behind the `Frame` view model: extruded map geometry + depth layers, the Rookie GLB with aim offset and facing turn, animation state machine, weapon sockets, VFX (muzzle, tracers, impacts, explosions, jet flame), perspective side camera, graphics presets and budgets (docs/11). The 2D debug renderer stays as a toggleable overlay | `apps/web/src/render3d/**`, `tools/asset-pipeline/**`, `apps/web/public/assets/**` (runtime GLB/KTX2 outputs) | W2's character assembler interface (stub first) |
| **W2** | `locker` | **The Locker** (character customisation, docs/04 §6): 3D turntable, slot tabs, dye picker (RGB mask shader), 3 presets, try-on; cosmetics content; loadout encoding sent at join and shown to others in-game; local persistence now, API persistence when W3 lands | `apps/web/src/locker/**`, `apps/web/src/character/**` (assembler + dye material, used by W1), `packages/content/src/cosmetics.ts` | Art (W8) for dye masks + starter parts; W3 for saving to an account |
| **W3** | `backend` | `apps/api` (Hono + Drizzle + Postgres + Redis, docker-compose), guest accounts, **rooms by code + share links** (`/r/CODE`), Ed25519 join tickets verified by the game server, fleet registry + heartbeat, multi-room game server, env validation, pino logging | `apps/api/**`, `docker-compose.yml`, `apps/game-server/src/{rooms,tickets,fleet,config,log}.ts` + room routing in `server.ts` | — |
| **W4** | `shell` | React app shell: home, create/join room UI, lobby + ready, production HUD, **results screen + Play again**, settings + key rebinding; match lifecycle (WAITING → COUNTDOWN → IN_PROGRESS → ENDING → POSTGAME) with DM time/kill limits; bots that move and fight | `apps/web/src/shell/**`, `apps/web/src/hud/**`, `packages/sim/src/match.ts`, `packages/bots/**`, per-room match state inside `apps/game-server/src/room.ts` | W3 API (mock until ready) |
| **W5** | `arsenal` | The full docs/03 roster: pistols, SMGs, rifles, shotgun, sniper, heavies, melee + machete, weight (`moveSpeedMul`), proximity mine, gas, EMP, weapon spawners + pickups | `packages/content/src/{weapons,grenades}.ts`, `packages/sim/src/{combat,grenades,projectiles}.ts` | — |
| **W6** | `netcode` | Lag compensation (300 ms rewind cap: 200 ms latency + 100 ms interpolation), delta snapshots + AOI, reconnect with session token, **WebTransport (UDP) gateway** with WebSocket fallback, low-bandwidth mode | `packages/netcode/**`, `packages/protocol/**` (owner of all encodings), `apps/game-server/src/transports.ts`, `apps/wt-gateway/**` | — |
| **W7** | `ops` | GitHub Actions CI (lint, typecheck, test, golden, uWS fetch on Linux), Dockerfiles (game-server, api, web), Prometheus `/metrics`, Sentry wiring, staging deploy scripts (provider chosen by the user) | `.github/**`, `infra/**`, `**/Dockerfile`, `apps/game-server/src/metrics.ts` | user: hosting account |
| **W8** | `art` | Runtime assets for W1/W2: real animation clips + aim offsets, dye-mask textures, 10 starter cosmetics, weapon models for the arsenal, first map kit (Street Market, the Lagos map), meshopt + KTX2 exports | `art/**` (sources), exports via W1's pipeline into `apps/web/public/assets/**` | Higgsfield credits (ask above ~25 per batch) |

**Hot spots and who decides:** `packages/protocol` → W6 · `apps/web/src/main.ts` → W4 (others add one-line hooks) · `apps/game-server/src/room.ts` → W4 for match state, W3 for routing · `packages/content/src/index.ts` → additive exports only.

---

## 4. Wave 1 milestones (what "landed" means)

| ID | Milestone A (first PR) | Milestone B | Done |
|---|---|---|---|
| W1 | movement-test map + Rookie rendered in 3D in local mode | online mode, VFX, presets | 60 fps on the reference iGPU laptop at Low; debug overlay toggle |
| W2 | assembler + dye shader + Locker route with the base Rookie | presets, try-on, loadout over the wire | other players see your dyes/parts in-game |
| W3 | api + docker-compose + guest accounts | rooms by code + links + join tickets | two browsers join the same room from a link |
| W4 | match lifecycle + results + Play again (local) | shell screens wired to W3 | full loop: home → room → match → results → play again |
| W5 | weight + 3 new guns + melee | full roster + mines/gas/EMP | every weapon usable online; feel table in NOTES |
| W6 | lag compensation | delta + AOI + reconnect | WebTransport path with fallback, measured on lossy profiles |
| W7 | CI green on PRs | Dockerfiles + /metrics | staging deploy (after the user picks a host) |
| W8 | clips + dye masks | starter cosmetics + 5 weapon models | Street Market kit |

---

## 5. Wave 2 and 3 queue (started by the orchestrator as dependencies land)

**Wave 2:** maps 2–3 (Street Market, Mumbai Local) · TDM · tutorial + training · quick play matchmaking + region beacons · parties (groups) · XP/levels/stats · telemetry (PostHog) · staging + bot matches in CI · low-end performance pass.

**Wave 3:** Drop Zone BR (solo) · CTF · maps 4–7 · store + battle pass (cosmetics only) · payments (Paystack/Flutterwave/Razorpay/Xsolla) · CrazyGames/Poki builds · compliance pack · localisation (5 languages) · anti-cheat detection + admin console · load + soak tests · billboard ads pilot (docs/14).

---

## 6. Integration cadence

- The orchestrator merges green PRs into `main` in dependency order, re-runs the full suite after each merge and pushes.
- Any merge that changes golden hashes or `PROTOCOL_VERSION` gets a one-line entry in `NOTES.md`.
- A weekly snapshot of progress against docs/13 is posted in `NOTES.md` (done / partial / missing counts).
