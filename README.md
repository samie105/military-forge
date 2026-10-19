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
| `?online&transport=ws` / `wt` | force WebSocket / WebTransport (default: WebTransport when the server has a gateway, else WebSocket) |
| `?online&rtt=150&loss=2&jitter=5` | network conditioner in the client (also live in the panel). Server side: `NET_SIM="rtt=150,loss=2" pnpm --filter @military-forge/game-server dev` |

**Controls:** A/D move · W or Space jetpack · S crouch (hold on a yellow platform to drop through) · mouse aim · LMB fire · R reload · Q swap · F dual-wield · G frag grenade · wheel zoom · H hitboxes · B grid · N net graph · K respawn · \` toggle panel · P record replay · O download replay.

### WebTransport (UDP), optional

The game server also accepts WebTransport sessions through a small Rust gateway (`apps/wt-gateway`, docs/05 §2). It needs a Rust toolchain ([rustup](https://rustup.rs); the version is pinned in `apps/wt-gateway/rust-toolchain.toml`):

```bash
cd apps/wt-gateway && cargo run --release
```

In dev the game server listens for the gateway on `military-forge/wt-<port>.sock` in a private directory under `$XDG_RUNTIME_DIR` or the temp dir, and the gateway looks there by default. The gateway serves UDP 4433 with a 13-day self-signed certificate (renewed before it expires) and tells the server its SHA-256, which `/health` advertises. Browsers then pin that hash, so no certificate setup is needed. Clients use WebTransport automatically and fall back to WebSocket when there's no gateway, no browser support, or no datagrams (Safari over HTTP/2). Env: `WT_ADDR`, `WT_PUBLIC_URL`, `WT_SOCKET` (or `WT_ROUTES` for several game servers, docs/09 §8), `WT_CERT`/`WT_KEY` (a real certificate), `WT_MAX_SESSIONS`, `WT_MAX_SESSIONS_PER_IP`. `cargo test` runs its own tests; with the release build present, `pnpm --filter @military-forge/game-server exec vitest run test/gateway.e2e.test.ts` runs the real binary against the game server's bridge.

`pnpm --filter @military-forge/game-server exec tsx scripts/udp-impair.ts --listen 4434 --target 4433 --rtt 150 --loss 2` puts real packet loss between the browser and the gateway (start the gateway with `WT_PUBLIC_URL=https://127.0.0.1:4434/wt`).

## Play with a friend over the internet

```bash
brew install cloudflared   # once (no Cloudflare account needed)
pnpm playtest
```

`pnpm playtest` builds the web app for production, starts the API and the game server on this machine, puts them behind one local port, and opens a [Cloudflare quick tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/do-more-with-tunnels/trycloudflare/) to it. It prints a link like `https://some-random-words.trycloudflare.com/r/KQXMZP`: open it yourself and send it to a friend. You both pick a name, land in the same room's lobby, ready up and play; the results screen has **Play again**. The lobby's **Copy link** (and QR code) invites more people, up to 8 per room. **Bots** (`[BOT]` names) keep each room at 4 players, so two of you still get a real match: someone joining takes a bot's place, and the host can start with the bots alone.

- **The link changes every run** and dies when you press **Ctrl-C**: quick tunnels are throwaway addresses. It **survives short internet outages** (the tunnel reconnects to Cloudflare by itself, and the game reconnects players). If the tunnel has to be recreated (a long outage, cloudflared giving up), it comes back on a **new address**: the script prints the new link in a box again and writes it to `.playtest-link`, so send that one. The API, the game server and the rooms keep running throughout; only Ctrl-C stops them. If the API or the game server stops anyway (a crash, a stray kill), it's restarted and **the room code and link stay the same**: the API gets the rooms in play back and keeps everyone's account, and players rejoin by themselves. The services show up as `military-forge-playtest-api` and `military-forge-playtest-game-server`; stop them by PID or with Ctrl-C, never with a pattern like `pkill -f "tsx src/index.ts"`.
- **This Mac is the server:** keep it awake and online while you play. The script stops it from idle-sleeping, but closing the lid on battery still sleeps it.
- **The admin page (yours only):** under the room link, the playtest prints an **Admin page** link (`…/admin#t=<this run's secret>`); keep it to yourself. It changes every gameplay number for every room at once, live: movement and jetpack, dash, blasts, every gun (damage, fire rate, spread, range, magazine, reload, recoil, weight, charge and spin), every grenade, crate weights and respawns, the armory, bots and match limits, each with a slider, a number box, its default and a reset. **Presets** (Classic, Floaty, Chaos), **Copy JSON** (to bake into the code) and **Save as defaults** (`~/.military-forge/admin-defaults.json`: the next playtest starts with them). Players see a small *Tuned by admin* tag. `--no-admin` turns it off.
- **Sound:** the game's sound starts on your first tap or key (browsers allow it only then) and goes quiet when you switch tabs. Settings → Audio has Master, Effects, Music, Interface and Voices, and **Headphones (3D sound)** for earbuds (enemies placed left, right, above and below by ear); Accessibility has **Soften loud bursts**. Far gunfire sounds far (late, dark, echoing), walls muffle, and rooms sound like rooms (`docs/audio-design.md`). **`/sounds.html`** (the sound board) lists every sound with a play button and a button per take, so you can audition them all: the bar sets the volumes and where a sound comes from, and runs a firefight stress test. Every sound is made in code (no files); `docs/audio-asset-wishlist.md` lists which ones would gain most from recorded or generated assets, with prompts, if you want to pay for them.
- **Tuning the game (on by default):** the room's host opens the menu (Esc) and picks **Tune the game**: jetpack, fuel, gravity, dash, blast push and grenade throw speed, live for everyone in the room. **Copy values** copies what you changed as JSON (send it over to make it the new defaults). Only the host can tune; `--no-tune` turns it off.
- Production settings: no Vite dev server, no dev commands or debug messages (only the host's tuning above); the API's rate limits stay on, its keys are generated fresh per run and never leave the server, and everything listens on `127.0.0.1` only (the tunnel reaches it locally). Players get into a room with a **join ticket** from the API (signed, good for one join within 30 s, carrying their checked nickname), so only people who came through the site can open or join rooms; a connection that doesn't say hello within 5 s is dropped.
- `pnpm playtest --local` skips the tunnel (this machine only); `--no-build` reuses `apps/web/dist`; `--port`, `--api-port`, `--game-port` pin the local ports; `--map flux-lab` (or `lunar-outpost`, `storm-front`, …) picks the rooms' map; `--bots 6` keeps rooms at 6 players (`--bots 0`: none) and `--bot-level easy|normal|hard` sets how good they are (default normal); `--no-tune` takes the host's tuning panel away; the tunnel uses QUIC (UDP; lower and steadier latency) and switches to HTTP/2 by itself on networks that block UDP (`--tunnel-protocol http2|quic` forces one). `pnpm --filter @military-forge/playtest run ping <link>` measures the round trip to the game server through the link, the way the game's ping does.

In the dev setup (`pnpm dev`), the same app is at http://localhost:5173/?app (Vite forwards `/api` and `/ws` to the API and the game server; without ticket keys the dev game server's rooms are open); `/` stays the Phase 0 debug client.

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

## Local checks before pushing

GitHub Actions can't run right now (an account billing lock), so this repo checks locally instead. Turn the hook on once per clone:

```bash
git config core.hooksPath .githooks
```

Then every `git push` first runs lint and typecheck (about 25 s) and stops on a failure. Use `git push --no-verify` to skip it once. The full suite (`pnpm check`) still runs before every merge.
