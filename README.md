# Military Forge

> The name lives in exactly two places, `GAME_NAME`/`GAME_SLUG` in `packages/shared/src/brand.ts` and the `@military-forge/*` package scope, so a rebrand is a search-and-replace, not a refactor. A full trademark search comes before filing (docs/01 §12).

A 2.5D web jetpack shooter: chaotic, fast, and playable in a browser tab. This repo is at **Phase 0**: prove the movement and gunfeel with programmer art, then prove the online pipe.

The full plan lives in [docs/](docs/README.md). Start with [docs/12-roadmap.md](docs/12-roadmap.md) §2 (Phase 0 gate) and [NOTES.md](NOTES.md) (first playtest findings).

## Run it

Requires Node ≥ 22.12 and pnpm 11.

```bash
pnpm install
pnpm uws:fetch   # optional but recommended: uWebSockets.js for your platform (~5 MB)
pnpm dev
```

`pnpm dev` starts:
- **web** at http://localhost:5173: canvas-2D debug client
- **game-server** at ws://localhost:9001: authoritative 60 Hz room (health check at http://localhost:9001/health shows the transport)
- **api** at http://localhost:8787: guest accounts and sessions on embedded Postgres (PGlite), no Docker needed. `docker compose up -d` gives it real Postgres + Valkey; see [apps/api/README.md](apps/api/README.md)

The game server uses **uWebSockets.js** when `pnpm uws:fetch` has downloaded it into `apps/game-server/vendor/` (gitignored). It downloads only the one native binary your platform and Node version need, instead of the ~95 MB GitHub tarball. Without it the server falls back to the `ws` package, so `pnpm install` / `pnpm dev` never block on GitHub.

| URL | What |
|---|---|
| http://localhost:5173/ | **Local mode**: the sim runs in your browser against strafing/jetting/crouching dummy targets: a deathmatch (5 min, first to 10), then results and **Play again**. Live tuning panel on the right |
| `?time=60&kills=5&countdown=3` · `?sandbox` | local match rules (0 = no limit) · free play with no match |
| http://localhost:5173/?online | **Online mode**: joins the server's dev room. Open it in **two tabs** to play each other |
| `?server=ws://host:9001&name=Ade` | explicit server and player name |
| `?online&rtt=150&loss=2&jitter=5` | network conditioner in the client (also live in the panel). Server side: `NET_SIM="rtt=150,loss=2" pnpm --filter @military-forge/game-server dev` |

**Controls:** A/D move · W or Space jetpack · S crouch (hold on a yellow platform to drop through) · mouse aim · LMB fire · R reload · Q swap · F dual-wield · G frag grenade · wheel zoom · H hitboxes · B grid · N net graph · K respawn · \` toggle panel · P record replay · O download replay.

## Test it

```bash
pnpm test              # all packages: unit tests, golden replays, protocol fuzzing, server pipe
pnpm typecheck
pnpm lint              # includes the "sim may not touch DOM/Node/non-deterministic maths" rules
pnpm golden:update     # after an INTENTIONAL change to movement/combat outcomes
pnpm replays:generate  # regenerate the scripted golden scenarios

pnpm --filter @military-forge/sim feel                # feel report: jet height, airtime, TTKs, hit rates…
pnpm --filter @military-forge/game-server bench 12     # server tick cost + GC pauses with 12 clients + dummies
pnpm --filter @military-forge/game-server netsim       # prediction/clock-sync stats under simulated network profiles
```

Recorded playtests (P → play → P → O to download) can be dropped into `packages/sim/test/replays/` to become golden tests.

## Layout

```
apps/web           Vite + TypeScript debug client (canvas 2D, Tweakpane)
apps/game-server   Room (inputs → sim → snapshots) over uWebSockets.js, `ws` fallback
apps/api           Hono + Drizzle API: guest accounts, sessions, nicknames (Postgres/PGlite, Redis/Valkey)
packages/shared    seeded PRNG, deterministic sin/cos/atan2/exp, quantisation, pools, UTF-8
packages/content   tuning, weapons (Hammer .44, Buzz), frag grenade, hitboxes, movement test map
packages/sim       collision world + grid, capsule controller, weapons, grenades, bots, Game, match lifecycle, replays
packages/protocol  bit-packed messages (hello, input, snapshot + local-player block, …)
packages/netcode   client prediction + reconciliation, clock sync/input pacing, server input buffer, network conditioner
docs/              the pre-production plan
```

The same `packages/sim` runs in the browser, on the server and in tests. It is deterministic: identical inputs give bit-identical state on every JS engine (no `Math.sin`/`Math.random` in the sim, quantised state at tick end).
