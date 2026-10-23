# Phase 0 — First playtest notes

> Date: 16 Oct 2026 · Build: Phase 0 debug prototype (canvas 2D, movement test map, Hammer .44 + Buzz + frag, 4 dummies, local + online).
> Method: (1) objective measurements with `pnpm --filter @military-forge/sim feel` (scripted runs against the real sim); (2) a browser session in the Claude app's browser pane, driven with real keyboard/mouse events: local mode against the dummies, then two online tabs through the game server; (3) a server benchmark (`pnpm --filter @military-forge/game-server bench`).
> **Caveat:** this first pass was played by the build agent driving the browser, not by people on a keyboard. Treat the "feel" items as hypotheses for the Phase 0 gate playtest with 5+ humans (docs/12 §2), especially genre veterans.

## 1. What the numbers say (default tuning)

| Measurement | Value | Read |
|---|---|---|
| Time to walk speed (5 m/s) | 117 ms | crisp, as specified |
| Stop distance from walk speed | 0.19 m | crisp |
| Full-tank burn time | 2.63 s | as specified (2.6 s) |
| Full-tank vertical climb | **15.2 m** | ≈ ¾ of the screen height at 1× zoom |
| Airtime, take-off → landing | 4.4 s | |
| Hover above 3 m by feathering the jet | **4.8 s** | long |
| Jet + run, take-off → landing | **39 m** in 6.4 s | more than a full screen width |
| Ground refill 0 → 100 | 3.07 s | as specified |
| Hammer .44 TTK @ 5/12/18 m (grounded) | 1.82 / 1.82 / 2.39 s, 100% hits | matches docs/03 §6 |
| Hammer .44 TTK @ 18 m **airborne** | 2.06 s, 97% hits | barely penalised in the air |
| Buzz TTK @ 5 m | 1.34 s, 94% hits | matches docs/03 §6 |
| Buzz TTK @ 12 m | **4.33 s, 39% hits** | falls off a cliff |
| Buzz TTK @ 18 m | **9.4 s, 26% hits** | unusable |
| Frag at 45°: first bounce / detonation | 11.1 m / 14.8 m | about one screen-half: good |

## 2. What felt wrong → suggested tuning changes

Each change should go in alone, with a blind A/B (docs/02 §19.4). All are live-editable in the panel (`` ` ``) and exportable with "Copy tuning JSON".

| # | Problem | Suggested change | Why |
|---|---|---|---|
| 1 | **Buzz is useless past ~8 m.** ±6° uniform spread puts ~60% of shots off a torso at 12 m; with bloom it's worse | `BUZZ.spread.base` **6 → 3.5°**, `bloomPerShot` **0.5 → 0.3** | target ~60% hits / ~2.4 s TTK at 12 m. The 6° baseline came from a guessed unit conversion |
| 2 | **Too much air time.** 15 m climb, 4.8 s hover and 39 m jet-run per tank make high ground and the ceiling the safe place; fights drift out of the screen | `fuelBurn` **38 → 44** (≈ 2.3 s tank) **or** `jetThrust` **38 → 34** (net climb 14 m/s²) | keeps the "one tank ≈ one screen" rule of thumb. Try burn first: it shortens hovering without making take-off feel weaker |
| 3 | **Hammer .44 is a laser in the air** (97% hits at 18 m while jetting) | Hammer `spread.airMul` **1.5 → 2.5**, or `minAir` **0 → 2.5°** | airborne should be a trade-off; genre classics reward grounded/crouched shooting |
| 4 | **Air regen is easy to farm by feathering** (12 /s after 0.45 s) | `fuelRegenAir` **12 → 6** | makes the hover number above drop sharply; check it doesn't kill jet-dueling |
| 5 | **Ledge corners round off at the capsule radius** (0.32 m). You can't stand at the very lip of a ledge: you slide off | keep for now; revisit with art (a flat "foot" segment under the capsule fixes it) | readability: players see feet on the edge but slide anyway |
| 6 | **Online has no prediction yet.** Your own player is drawn from the newest snapshot (+≤ 50 ms extrapolation). On localhost it's fine; at 100 ms+ RTT it will feel floaty | not tuning: implement prediction + reconciliation (docs/05 §8) next → **done, see §9** | the sim is already deterministic and quantised, so reconciliation can compare states exactly |

## 3. Browser session (what actually happened on screen)

| Check | Result |
|---|---|
| Walk right from spawn | steps over the 0.2 m ledge, **stops at the 0.5 m ledge at x = 9.68** (exactly as the unit tests predict) |
| 0.25 s jet tap | clears the 0.5 m ledge; a 0.55 s burst clears the 1 m and 2 m ledges |
| Hammer .44 at a dummy behind the thin wall | all 4 shots blocked by the wall; the dummy stays at 100 HP |
| Hammer .44 at the Strafer | 3 hits (90 dmg) then auto-reload, as specified (4 hits to kill) |
| Buzz 1 s spray at the strafing dummy (~8 m) | **~1–2 of 10 shots hit** (matches the spread problem in §2 #1) |
| Frag at the Strafer | kill credited, kill feed + explosion ring render |
| Two online tabs (Ade, Kemi) | both joined with 4 dummies; Ade walked to x = 9.43; **Kemi's tab rendered Ade at 9.428**, matching the server; Kemi spawned at the spawn farthest from Ade |
| Online network | RTT ~3 ms (localhost), **29.8 snapshots/s, 6.0 KB/s down, 1.4 KB/s up per client**: inside the docs/05 §12 budget even with full-state snapshots |

**UX issues spotted:**
- **The tuning panel covers ~⅓ of a small window** (800 × 600). Press `` ` `` to hide it. It should start collapsed outside dev, and folders could default closed.
- **A hidden tab or browser pane froze the game**: `requestAnimationFrame` stops when hidden, so the sim and the online input stream stopped. *Fixed*: a watchdog drives frames from a timer once rAF goes quiet (docs/06 §4 "tab-away behaviour").
- Without client prediction, online movement on localhost already feels fine, but there's no visual slack: see §2 #6.
- **Input latency from queueing:** the server's input ack trailed the client by ~6 ticks (~100 ms of buffered inputs). With no clock sync, the client's 60 Hz sender and the server's 60 Hz consumer drift, and bursts pile up in the queue (capped at 8). Implement docs/05 §4: the server reports `inputBufferHealth`, and the client nudges its tick rate ±3% to keep 1–2 ticks buffered. → **Done, see §9.**

## 4. Server performance

`bench` runs N fake clients plus the 4 dummies, sending inputs every tick and encoding real snapshots:

| Room | avg tick | p99 | max | snapshot KB/s per client |
|---|---|---|---|---|
| 2 humans + 4 dummies | 0.03 ms | 0.36 ms | 4 ms | 6.1 |
| 12 humans + 4 dummies | **0.07 ms** | 0.87 ms | 8 ms | 17.0 |

- Profiling showed **~55% of server time was snapshot encoding** (float divisions in the bit writer, and re-encoding the same full snapshot for every client). *Fixed*: integer bit ops + encode once per tick and patch the per-client ack bytes → **5× faster** (12 humans: 0.36 → 0.07 ms avg; p99 3.2 → 0.87 ms). Well inside the docs/02 §18 budget (≤ 0.6 ms for 16 players).
- **Remaining:** occasional 4–8 ms spikes are garbage collection from per-message allocations (decoded input objects, snapshot copies, event arrays). The fix is allocation-free decode into pooled objects plus delta snapshots (docs/05 §11); do it before load testing. → **INPUT decode is now pooled, see §9.3**; delta snapshots remain.
- At 12 players, full-state snapshots cost 17 KB/s per client. Delta compression + AOI (docs/05 §9, §11) should bring this back under ~10 KB/s.

## 5. Things that worked

- Golden replays caught a real geometry change on their first day: two hill angles in the test map were computed by hand and were wrong; fixing them made `slopes` diverge at exactly tick 387, the moment the player reaches that hill.
- The protocol fuzz test (5,000 random packets) found a real crash: malformed UTF-8 in a player name threw a `RangeError` inside the decoder. Fixed; a crafted packet could have crashed a room.
- Step-up, wedge corners, one-way platforms, crouch corridors and corner correction all have tests (docs/02 §10 list) and pass.

## 6. Deviations from the plan (docs/) and why

| Plan said | Built | Reason |
|---|---|---|
| Positions quantised to 1/128 m (docs/02 §15, docs/05 §6) | **1/1024 m** for position and velocity | rounding the absolute position each tick at 1/128 biases speed (5 m/s became ~5.16 m/s) and freezes anything slower than ~0.23 m/s. 1/1024 costs ~3 extra bits per axis. docs/02 §15 and docs/05 §6.2 are updated |
| bitECS for sim storage (docs/06 §3) | plain classes with preallocated arrays | 16 entities in Phase 0; zero-GC was kept where it matters (geometry, contacts). Revisit when entity counts grow (BR, projectiles) |
| zod-validated content | typed TS data | no runtime validation needed yet; add with the content build step |
| Server tick scheduler with `setImmediate` | `setTimeout` + hrtime catch-up | no busy-spinning on dev laptops; ≤ 1 ms wake-up jitter is fine at 60 Hz |
| Snapshot delta compression, AOI, lag compensation | full-state snapshots, no rewind | Phase 0 scope ("prove the pipe") |
| uWebSockets.js as a normal dependency | `pnpm uws:fetch` downloads just this platform's binary (~5 MB) into `apps/game-server/vendor/`; the server falls back to `ws` when it's absent | the GitHub tarball is ~95 MB (every platform's binary). On this connection (~30 KB/s) it stalled `pnpm install` for 25+ minutes. Both transports pass the same two-client pipe test |

## 7. Next steps (in order)

1. Run the Phase 0 gate playtest with ≥ 5 people (including genre veterans) using the tuning panel, then commit the agreed tuning. A first pass from the owner's playtest is in §10; use its A/B plan.
2. ~~Client-side prediction + reconciliation for the local player (docs/05 §8), plus the network conditioner (docs/05 §15.2) to test at 150 ms / 2% loss.~~ Done (§9).
3. ~~Allocation-free protocol decode~~ (INPUT done, §9.3) + delta snapshots (removes the GC spikes in §4).
4. Lag compensation for hitscan (docs/05 §7) once two remote players can shoot each other through the pipe.
5. Start the Three.js renderer behind the same `Frame` view model (`apps/web/src/view.ts`), so the debug renderer stays as an overlay.

## 8. Art pipeline note: Higgsfield + Blender

You have Higgsfield (AI image/3D generation) and Blender. That changes the art plan in docs/04 and docs/11:

- **Concept → model:** Higgsfield character sheets (front/side/back) → Higgsfield 3D generation → GLB. Same for weapons, props and kit pieces. Prompts must describe **original** designs (no likeness to any existing game, docs/01 §12).
- **Blender is the gate:** generated meshes are dense and unrigged. In Blender: retopologise/decimate to the budgets (≤ 4k tris per character, docs/04 §5), rig to the shared ~24-bone skeleton with the socket names from docs/04 §4.1, bake textures to the RGB dye-mask layout, export glTF.
- **Automate the checks:** Blender runs headless (`blender --background --python check.py`), so the asset pipeline (docs/11 §4) can enforce triangle counts, bone names, the cosmetic envelope and texture sizes in CI.
- **Suggested first task:** the Phase 0 art-style test (docs/12 §2): one rigged base soldier with 6 clips and a 20 m map slice. With Higgsfield generating the base mesh and concepts, this is days, not weeks.

## 9. Netcode step 1: clock sync, prediction + reconciliation, conditioner

> Date: 16 Oct 2026. New package `packages/netcode` (pure, runtime-agnostic: time and timers are injected). Protocol v2.
> Same caveat as above: the browser part was driven by the build agent with synthetic key events, not by people.

**What changed**
- **Tick-aligned inputs + clock sync (docs/05 §4).** The client tags every input with the *server* tick it is for and runs ahead of the server. The room keeps a 64-slot tick-indexed buffer per client and takes exactly that tick's input (repeat-last if it is missing; late inputs are dropped). Every snapshot carries `inputBufferHealth` (i8): spare ticks of this client's input that were queued, min over the snapshot interval. The client's `InputPacer` runs its tick rate ×1.03 when health < 1, ×0.97 when it stayed > 2 for 1 s, else eases back to 1.0; beyond 8 ticks off it jumps (fast-forward, or holds still) and ignores reports until the server has seen an input sent after the jump. The start tick comes from the HELLO→WELCOME round trip.
- **Prediction + reconciliation (docs/05 §8).** The client predicts its own player with the shared `Game` (same seed and tick numbering, so seeded spread matches), in a world holding only that player. Each predicted tick stores its input and the exact quantised local state (41 integers, `LocalState` in protocol) in a 128-tick ring. Snapshots now start with a per-client header and a **local-player block** holding every field the movement/weapon/regen sim carries between ticks: position/velocity, ground normal + flags, jetTicks, fuel, fuelRegenDelay, downHeldTicks, dropTicks, hp, regenDelay, both weapon slots (mag, reserve, cooldown, reloadTicks, bloom, ticksSinceShot), active/dual/swapTicks, frags, throwCooldown, shotCounter and prevButtons. Reconciliation is an integer compare; on a mismatch it adopts the server state, replays the recorded inputs, and hides the jump with a visual offset that decays over 80 ms (snaps beyond 3 m: respawns).
- **Network conditioner (docs/05 §15.2):** latency, ± jitter, loss, duplication and optional reordering, per direction. Only INPUT/PING/PONG/SNAPSHOT are dropped; reliable messages are only delayed, in order. Client side: `?online&rtt=150&loss=2&jitter=5` (or `?netsim=up.lat=20,down.lat=120,…`) plus a live "Network conditioner" folder with presets in the debug panel. Server side: `NET_SIM="rtt=150,loss=2" pnpm --filter @military-forge/game-server dev` (or `--net-sim=…`).
- **Net graph (N):** RTT jitter, snapshot loss, input buffer health, rate multiplier, unacked ticks, resyncs, **corrections/min** (replays that moved the player > 1 mm), mispredictions/min (any field, e.g. hp from a hit), last error, conditioner settings.
- Live tuning edits are now broadcast to the other clients (new `TUNING` 0x26 message), so their prediction stays in step.

### 9.1 Measured: browser, two tabs at 150 ms RTT / 2 % loss

Two tabs (Ade, Kemi) on the dev server, client conditioner 75 ± 5 ms and 2 % loss in each direction. Kemi's tab walked/jetted/crouched for 68 s in a loop (right 1.5 s, jet-right 0.6 s, left 1.5 s, jet taps 1.2 s, crouch 0.4 s, idle 0.8 s):

| Measurement | Value |
|---|---|
| RTT (PING median) / jitter | 155 ms / 3.6 ms |
| Snapshot loss | 1–3 % |
| Input buffer health | 2 ticks 69 % of samples, 3 ticks 30 %, 1 tick 1 %; rate ×1.000 |
| Snapshots reconciled in the 68 s run | 1,975: **1,975 exact matches, 0 mispredictions, 0 corrections, 0 resyncs**; max visual offset 0 |
| Key press → local player moving | **5–19 ms** (next predicted tick; the display ran at 120 Hz). Before: ≥ 1 RTT (~155 ms here) |
| Predicted ticks waiting for confirmation | 13–16 |
| Other tab's view | Ade's tab drew Kemi at x = 1.45; Kemi's prediction 1.45, server 1.447 |
| Bandwidth per client (2 humans + 4 dummies) | 7.9 KB/s down (+1.7 KB/s for the local block), 1.7 KB/s up (60 Hz × 4 redundant inputs) |

Background tabs are throttled by the browser (1 Hz timers, no rAF), so a tab that was hidden falls behind and needs 1–3 resyncs when it comes back (also measured in the simulator below). The browser pane was hidden during this session, which throttled both tabs between tool calls; the 68 s window above was measured while the page was running at full rate (119 rAF/s).

### 9.2 Measured: simulated network (`pnpm --filter @military-forge/game-server netsim 130`)

Two NetClients against a real Room through the conditioner on a manual clock (reproducible; ±1 ms server wake-up and ±1.5 ms frame noise; 120 s measured after 10 s warm-up). "Inputs missed" = ticks the server had to repeat an input; they cost nothing here because the repeat equals the real input while a key is held.

| profile | corrections/min | mispredictions/min | inputs missed/min | health 1–2 | mean lead | RTT | snapshot loss |
|---|---|---|---|---|---|---|---|
| LAN (20 ms) | 0.00 | 0.00 | 0.00 | 100% | 2.3 ticks | 20 ms | 0.0% |
| Good (80 ms, 0.5%) | 0.00 | 0.00 | 0.00 | 100% | 4.6 ticks | 80 ms | 0.0% |
| **Target (150 ms, 2%)** | **0.00** | **0.00** | 0.25 | 92% | 7.1 ticks | 150 ms | 1.0% |
| Bad wifi (200 ms, 5%, ±25 ms) | 0.00 | 0.00 | 1.25 | 40% | 9.8 ticks | 205 ms | 4.7% |
| Mobile (300 ms, 3%, ±40 ms) | 0.00 | 0.00 | 1.25 | 47% | 13.3 ticks | 317 ms | 2.0% |
| Bad wifi + reordering | 0.00 | 0.00 | 0.25 | 30% | 10.2 ticks | 193 ms | 11.3% (late = dropped) |

With jitter the pacer settles at a deeper buffer (health mostly 2–4) instead of starving. Start-up needs 0 resyncs on every profile; a 3 s simulated tab sleep needs 1–2, then 0 corrections.

### 9.3 Measured: server GC (`pnpm --filter @military-forge/game-server bench 12`)

INPUT packets are decoded into a pooled object with a reused `BitReader`; inputs go into a preallocated per-client ring (no queue objects); the snapshot body is encoded once into a reused writer without `filter()` copies. The bench's fake clients now encode into reused buffers and it reports GC pauses.

| 12 humans + 4 dummies, 6000 ticks | before (Phase 0) | after |
|---|---|---|
| GC pauses | 49 | 29–30 |
| GC total / longest pause | 56–62 ms / 4.3–4.8 ms | 4.3–4.7 ms / 0.6–0.7 ms |
| tick p99 / max | 1.1–2.2 ms / 6.8–12 ms | 0.05–0.06 ms / 0.17–0.32 ms |

Later runs were noisy because another app on this machine was using ~4.5 cores. Under that same load, a scratch copy of the old allocating INPUT path made 45–46 GC pauses vs 27–29 for the new one, but contention stretched pauses in both to 3–11 ms. Re-run the bench on a quiet machine before quoting the durations. The remaining allocations are sim event objects (packages/sim, untouched here) and one `Uint8Array` per client per snapshot.

### 9.4 Deviations and known gaps
- **Local block is ≤ 58 bytes** (465 bits with both slots armed), not docs/05 §6.2's ≈ 32: it includes the ground normal/flags, fractional cooldown and bloom, ticksSinceShot and a full 32-bit shotCounter, so every predicted field round-trips exactly. It can be trimmed once delta snapshots exist.
- **Buffer band 1–2 ticks** (task brief) instead of docs/05 §4's "slow down above 4"; a slow-down needs the health to stay above 2 for a full second, because jitter makes dips.
- **Not predicted yet:** your own grenade's flight (thrown grenades are removed from the prediction world; the server's arrive in snapshots, so a blast next to you is a correction), damage, knockback, deaths and the respawn point (the client holds its respawn timer until the server says alive). Your own shots draw predicted tracers instantly, and hit markers wait for the server (docs/05 §7.2). Predicted tracers pass through enemies, because the prediction world has no other players.
- Fractional weapon values are exact only on the 1/1024 grid. Default content is (integer cooldowns, bloom 0.5 per shot); weapon tunings off that grid could cause harmless mispredictions.
- Snapshots that arrive after a newer one are dropped and counted as lost.
- The web client still has no reconnect: when `tsx watch` restarts the server, reload the tabs.

**Tests added:** reconciliation exact match over a busy script (walk/jet/crouch/both guns/reload/swap/dual/grenades), mismatch → replay (late input), knockback smoothing, damage-only mispredictions, death/respawn, history miss; local block wire round-trip on every tick; pooled INPUT decode + fuzz; conditioner latency/jitter/order/loss/dup/determinism/spec parsing; pacer nudges, jumps and stale-report filtering; room tick alignment and health; end-to-end NetClient ↔ conditioner ↔ Room at 150 ms/2 %, LAN, heavy jitter with reordering, and a tab sleep.

## 10. Playtest tuning pass (17 Oct 2026)

> Input: the owner's first hands-on playtest, then a target-driven pass: `pnpm --filter @military-forge/sim feel` checks the current values against `scripts/feel-targets.ts`, and `pnpm --filter @military-forge/sim tune` sweeps the knobs and recommends the smallest passing change per system (fewest knobs first). Three reviewers checked the targets and the picks before they were applied.

### 10.1 Bugs found and fixed first (they skewed every number)

| Bug | Symptom | Fix |
|---|---|---|
| Float residue on landing | after a fast diagonal fall, `vy ≈ +1e-12` kept the player "airborne" on the floor: no ground regen, air controls | `UP_EPSILON` in the ground check (f45b0f8) |
| Push-out through ledge corners | jetting up against a wall under a ledge popped the player ~0.6 m through the corner | corner (endpoint) contacts no longer use the "behind the face" push-out (5f96874) |
| Jet kick was free | the 6-tick ignition kick gave 1.35× thrust for 1× fuel, so tapping climbed ~19% higher per tank than holding (18.4 vs 15.5 m) | the kick burns fuel at the same multiplier (525d74c) |

### 10.2 Applied values (ff1db97)

| Knob | Before | After |
|---|---|---|
| `fuelBurn` | 38 | **44** |
| Buzz `spread.base` | 6° | **3.5°** |
| Buzz `spread.dualMul` | 1.4 | **2.4** (dual-wield spread unchanged at 8.4°) |
| Hammer `spread.airMul` | 1.5 | **2.25** (Hammer only; the shared sidearm defaults are untouched) |

Considered and not applied: `jetMaxVy` 6.5 → 6.25 (not needed once the kick costs fuel), Buzz `bloomPerShot` 0.5 → 0.3 (base alone hits the targets), `fuelRegenAir` 12 → 6 (hover is already in range).

### 10.3 Before → after

| Measurement | Target | Before | After |
|---|---|---|---|
| Full-tank burn | 2.2–2.6 s | 2.60 s | **2.25 s** |
| Full-tank climb | 12.2–13.3 m | 15.0 m | **13.0 m** |
| Jet + run, take-off → landing | 15–32 m | 26.4 m | **23.2 m** |
| Best hover above 3 m (13 rhythms) | 2–4.5 s | 4.23 s | **3.63 s** |
| Ground refill from empty | 2.8–3.6 s | 3.07 s | 3.07 s |
| 0.2 s tap hop / time to 2 m | ≥ 1 m / ≤ 0.5 s | 1.17 m / 0.45 s | 1.17 m / 0.45 s |
| Buzz @ 12 m grounded | 50–75% hits, TTK ≤ 2.6 s | 39%, 4.33 s | **58%, 2.54 s** |
| Buzz @ 18 m grounded | ≤ 50% hits | 26% | 37% |
| Hammer @ 18 m airborne | 55–80% hits | 97% | **~77%** (75% at 40 seeds) |
| Hammer @ 18 m grounded | ≥ 95% hits | 100% | 100% |

"Before" already includes the kick fix (it alone cut the climb from 15.2 to 15.0 m). Section 1's numbers predate all of this.

### 10.4 Map heights (for the map lint and level design)

Apex by starting fuel (straight up or jet + run, same height): 25% → 3.3 m, 50% → 6.6 m, 75% → 9.8 m, full → 13.0 m. A jet + run covers ~15 m horizontally by the apex.

- **≤ 6.5 m:** comfortable. Half a tank, so the player arrives with fuel to fight.
- **≤ 11 m:** reachable on one full tank with margin to land.
- **> 11 m:** needs an intermediate ledge or a jump pad. The 12 m tower on the movement-test map is a deliberate edge case (needs ~92% fuel).

### 10.5 A/B plan for the next human playtest

Blind A/B (docs/02 §19.4), one change at a time, in this order; 5+ players, 10 minutes each side, ask "which felt better, and why" before revealing.

1. `fuelBurn` 44 vs 38 (the biggest feel change: shorter flights).
2. Buzz base 3.5 vs 6 (mid-range viability of the SMG).
3. Hammer airMul 2.25 vs 1.5 (air duels vs planted shots).

If 44 feels too short, try 42 next (2.35 s burn, 13.6 m climb, 3.8 s hover: still well under the old 15 m). If the Buzz now beats the Hammer at 12 m, raise `bloomPerShot` before touching the base.

### 10.6 Tool gaps

- The in-game tuning panel (`` ` ``) edits movement only; weapon spreads are changed in `packages/content/src/weapons.ts` (or with `withSpread` in the scripts).
- "Copy tuning JSON" exports only the values that differ from the defaults.
- `CONTENT_HASH` now covers tuning, weapons, grenades, hitboxes and maps (`HASHED_CONTENT` in packages/protocol/src/messages.ts), so a client with different weapon values can't join a server any more.

## 11. Lag compensation for hitscan (W6 milestone A)

> 17 Oct 2026. docs/05 §7, checklist 249 / 263. No protocol version bump: one new dev-only message (DEBUG 0x30). Golden hashes unchanged.

**How it works.** Every INPUT already carries the tick the client is drawing remote players at (`renderTick` + 1/256 fraction). The client now reports the render tick of the last frame it actually drew, quantised to 1/256 so the server can reproduce it exactly. The server keeps a 1 s ring of every player's hit pose (position, crouch, alive) per tick (`LagCompensator`, packages/netcode). When an input fires, the sim's hitscan asks a new `Game.rewind` hook where each target was. The compensator answers with the two snapshot ticks around that render tick, interpolated with the same function the client renders with (`lerpPosition`, teleport rule and discrete fields included). The shooter isn't rewound; damage applies now. Hit markers already come only from the server's `hit` events (docs/05 §7.2). Dev rooms send each shooter a DEBUG message per shot, and with hitboxes on (H) the 2D renderer draws the tested pose dashed, a line to where the target really was, and the rewind in ms.

**Measured** (`pnpm --filter @military-forge/game-server netsim`: shooter on the 12 m tower aims where its screen draws a target walking 5 m/s below; Hammer .44, ~36 shots per run):

| profile | hits with lag comp | hits without | server pose = shooter's screen (< 1 cm) | mean rewind | clamped |
|---|---|---|---|---|---|
| LAN (20 ms) | 100% | 22% | 36/36 | 175 ms | 0 |
| Good (80 ms, 0.5%) | 100% | 17% | 36/36 | 210 ms | 0 |
| **Target (150 ms, 2%)** | **100%** | **8%** | 35/36 | 282 ms | 0 |
| Bad wifi (200 ms, 5%) | 100% | 11% | 1/36 | 330 ms | 36 |
| Mobile (300 ms, 3%) | 50% | 11% | 0/36 | 430 ms | 36 |

Browser (150 ms RTT / 2 % client conditioner, shooting the Strafer dummy): the requested rewind was 288–304 ms; every shot hit, and the overlay showed the tested pose 1.3–1.4 m behind where the Strafer had walked to.

**The cap: 300 ms (decided 17 Oct; docs/05, 10, 13 and 15 updated).** docs/05 used to say "200 ms rewind". In this tick-aligned model a shot needs RTT + input buffer + 100 ms interpolation (≈ 280 ms at our own 150 ms target; 175 ms even on LAN), so a 200 ms cap on the total would clip every shot above ~75 ms RTT. The default reads the cap as **200 ms of latency on top of the 100 ms interpolation delay (300 ms total)**; it's `RoomOptions.lagComp.maxRewindMs`. In a real browser at 150 ms the request sits at 290–305 ms, right at that edge (clipping costs ≈ 2 cm). 350 ms total would give headroom at the target profile. Beyond the cap, players lead their shots, and fake lag gains at most the cap (docs/10). A client drawing at 30 fps adds up to a frame of view age, so at 150 ms RTT its shots (310–372 ms) already exceed the cap and get clamped; that's a frame-rate effect, not a lag-comp error.

**Review fixes (17 Oct).** Poses are tagged with the player that held the id when they were recorded, so a player who joins into a departed player's id is never tested at the old player's poses. Batched inputs (low-bandwidth mode, or a slow frame that samples two ticks) each carry their own render-tick lag: **PROTOCOL_VERSION 4 → 5**, INPUT's 2 padding bits per input become a 6-bit lag in 1/16 tick (0–3.94 ticks), so the server rewinds each input to what was on screen when it was sampled rather than guessing `renderTick − i`.

**Follow-ups (17 Oct, after the merge).** **PROTOCOL_VERSION 6 → 7** (arsenal took 6): the lag is u8 (to 15.9 ticks) and inputs[0] carries none (it's 0 by definition), so a packet is 13/19/25/31 B for 1–4 inputs. v5's 3.94-tick ceiling clipped redundant copies at low frame rates: at 15 fps with 30 % uplink loss only 89.6 % of rewinds were exact, now all are (lagcomp.test). INPUT with trailing bytes is refused. The reused-id guard also covers a leave and a join between the same two ticks (the history's holder must be this target). The client no longer draws a reused id at the leaver's old poses: each ROSTER entry carries `since`, the first server tick whose snapshots show that player, and older snapshot entries for the id are ignored, so the joiner is drawn at its newest pose, which is what lag comp tests. That holds whatever order ROSTER and snapshots arrive in (over WebTransport they travel separately).

**Small glue outside W6's files** (PR description lists them): `packages/sim/src/combat.ts` (the target loop reads the rewound pose when `game.rewind` is set; identical arithmetic otherwise), `packages/sim/src/{game,rewind,index}.ts` (the hook), `apps/game-server/src/room.ts` (records poses, sets views, sends DEBUG), `apps/web/src/{onlineMode,render,view}.ts` (shared interpolation, overlay).

## 12. Delta snapshots, AOI and SOUND events (W6 milestone B, part 1)

> 17 Oct 2026. docs/05 §9, §11. **PROTOCOL_VERSION 2 → 3.** Golden hashes unchanged (no sim change).

- **Per-client snapshots** (`packages/protocol/src/snapshot.ts`): each is encoded against the newest snapshot that client acked (`INPUT.ackSnapshotSeq`). The server keeps the last 32 sent per client, the client the last 64 it decoded; without a usable baseline the snapshot is full. Players carry 8 field groups (position, velocity, aim, state flags, hp, weapons, kills/deaths, respawn timer); only changed groups are sent, and positions under ±4 m from the baseline go as 13-bit deltas. Seq 0 is skipped (it means "nothing acked").
- **The local block** is regrouped into 7 groups and also sent as a delta. Trimmed: no `facing` (recomputed every tick); ground normal/flags zero while airborne (only read when grounded); jetTicks and ticksSinceShot saturate at 63 / 127, past where the sim can tell. Full block 465 → 436 bits (less in the air); a typical delta is the 7-bit mask plus the kinematics (95 bits ≈ 12 B).
- **Other players lost private fields:** remote `SnapshotPlayer`s no longer carry fuel, frags or ammo (velocity at 1/64 m/s, aim at 1/1024 turn). Your own values come from the local block.
- **AOI** (`packages/netcode/src/aoi.ts`): players and grenades outside what the client's camera can show (widest zoom of its weapons, 35 % look-ahead, map-edge clamping, 4:3 worst case: taller screens are letterboxed, keeping the full view width, so the camera never shows more) + 6 m + 0.25 s of velocity are not sent. The camera constants live there now and `apps/web/src/camera.ts` imports them. Other players' shots and explosions outside the view become **SOUND** events with 4 m positions. Hit events go only to the attacker, the victim, and clients that can see the victim. A culled player's shots never arrive as tracers, only as its 4 m SOUND: a clipped tracer still located the shooter to ~4 cm (two tracers cross at the muzzle; a range-exhausted one ends a known distance from it). A visible player's tracer that leaves the view is clipped at the edge and reads as a miss; one aimed at a culled player always reads as a miss with no target, stops 1.5 m (a body's reach) short of the edge so a hitbox poking into the rect isn't marked, and shrinks to a zero-length tracer at the muzzle when none of it is that far inside (so whether a tracer arrives says nothing either). A HIT names its attacker only to the attacker, the victim and clients that can see the attacker; to everyone else its damage is whole HP, because 1/16 HP plus the weapon's linear falloff gave the shot's distance, and two such rings pinned a hidden shooter to ~20 cm. A grenade or blast names its thrower only to clients that can see the thrower (an exact arc and fuse work back to its hand). Culled-player info that remains: SOUND cells (4 m); a visible victim's damage in whole HP, which still gives the hidden shooter's distance to ~1 m (two hits: a position to ~1 m) because falloff is linear (coarser damage buckets would close it, at the cost of the damage numbers); a grenade's arc back to its thrower's position (not who); and the kill feed. Your own shots are no longer echoed back (the client draws them from prediction).

**Measured** (`pnpm --filter @military-forge/game-server bench 12`, fake clients acking 5 snapshots ≈ 150 ms late):

| 12 humans + 4 dummies | down per client | avg snapshot |
|---|---|---|
| before (PR 1) | 18.7 KB/s | — |
| trimmed, full snapshots, no AOI | 13.2 KB/s | 444 B |
| delta, no AOI | 6.6 KB/s | 220 B |
| AOI, no delta | 7.2 KB/s | 240 B |
| **delta + AOI** | **4.0 KB/s** | 131 B |

Tick cost 0.013 → 0.03 ms avg (per-client encodes; budget is 0.6 ms), GC max pause < 1 ms. Prediction and lag comp are unchanged under the conditioner (`netsim`: 0 corrections/min on every profile; 100 % lag-comp hits at 150 ms). Browser at 150 ms / 2 %: 99 % of snapshots were deltas, 0 missing baselines; standing away from the dummies their records stopped (0.5 KB/s), walking back they reappeared with no interpolation pop.

Also fixed: a page loaded while hidden (zero-size canvas) left the 2D camera at NaN forever, so the world never drew.

## 13. Reconnect with a session token (W6 milestone B, part 2)

> 17 Oct 2026. docs/05 §3, §13. **PROTOCOL_VERSION 3 → 4** (WELCOME and HELLO layouts). Golden hashes unchanged.

- WELCOME carries a `sessionToken` (144 random bits) and `resumed`. HELLO may present the token after the name; the decoder treats it as optional, so W3's join ticket can follow it.
- A dropped connection (socket closed, not kicked) leaves its player standing idle in the world for `RoomOptions.reconnectGraceMs` (default 20 s; BR will use 60 s). The player keeps its slot, so a full room stays full. A HELLO with the token takes the player back: same id, the token rotates, the client gets the roster and a **full** snapshot (fresh baselines), and prediction re-anchors on it. A token presented while the old socket still looks alive (common after a network switch) retires the old connection with close code 4005 `DuplicateSession`. Kicked players and unknown/expired tokens join fresh.
- Review fixes (17 Oct): a kick ends the session before closing the socket (uWS runs the close handler, which would otherwise park a resumable session, inside `close()`). After a resume, the token the client presented stays valid until its first INPUT or PING proves the new WELCOME arrived, so a client whose resumed WELCOME is lost retries with the same token instead of hitting RoomFull.
- The web client reconnects by itself: backoff 0.25 → 0.5 → 1 → 2 s for up to 20 s, then shows the error. It doesn't retry after kicks or the version/room-full/bad-message/duplicate codes. Status shows "reconnecting… (code; retry in …)" then "connected (resumed after N s)".
- Measured: simulated 3 s outage at 150 ms / 2 % → same player id, 0 corrections afterwards, buffer back in band. Browser at 150 ms: socket killed → resumed in 0.4 s as the same player; server restarted (session lost) → rejoined as a new player after the backoff, about 4 s. The second case also fixes tabs needing a reload after `tsx watch` restarts.

## 14. Low-bandwidth mode (W6)

> 17 Oct 2026. docs/05 §2.2, §13. A new CMD kind (no version bump of its own); the review fixes moved INPUT to v5 (§11). Golden hashes unchanged.

- `?online&lowbw`, or the panel's **Network → low-bandwidth mode**, or `NetClient.setLowBandwidth()`. The client sends inputs two ticks per packet at 30 Hz (the 4-deep redundancy still covers a lost packet). The server sends that client snapshots every 4th tick (15 Hz), and they still carry the events of the interval it skipped. Remote players are drawn 150 ms back instead of 100. Lag comp mirrors that client's 4-tick snapshot spacing, and its rewind cap grows by the extra view delay (150 ms interpolation + 1 batching tick + 200 ms ≈ 367 ms). The wider cap and the 4-tick spacing apply only after 1 s in the mode and stop the moment it's switched off, so toggling it around a shot earns nothing; CMDs go through a token bucket per connection (20/s, bursts of 20, docs/05 §14); excess ones are dropped, not strikes, since a TCP stall can bunch up honest ones. Right after a switch, snapshots at either rate don't count as lost. Clients start at the room's snapshot interval (it was hard-coded to 2).
- After 5 s of > 10 % snapshot loss the net graph suggests the mode (docs/05 §13). It isn't switched on automatically.
- **Measured** (`netsim`, 150 ms / 2 %; wire bytes include ~70 B WS+TLS+TCP/IP framing per message): up **61 → 31 msgs/s, 5.9 → 3.0 KB/s**; down 31 → 16 msgs/s, 3.2 → 1.7 KB/s (2 humans + 4 dummies). 0 corrections/min either way. Lag-comp poses exact for 34/36 shots (35/36 normal). Browser, 30 s of walking/jetting at 150 ms / 2 %: 15 snapshots/s, 0.86 KB/s up (1.71 normal), 0 corrections, 0 resyncs.

## 15. Arsenal milestone A: weight, K-47, Breacher, Widow, melee (17 Oct 2026)

> Workstream W5 (docs/15). New content and sim mechanics; existing golden hashes unchanged, two new goldens. Numbers from `pnpm --filter @military-forge/sim feel` (20 seeds, idle target re-aimed at the torso every tick, 100 HP, no regen in a 10 s window).

**What changed**
- **Weight:** the held weapon's `moveSpeedMul` (the heaviest of a dual pair) scales walk, crouch, air and jet-air speed caps. K-47 and Breacher 0.97, Widow 0.90, Machete 1.05; Hammer and Buzz stay 1.0, so their code paths and the old goldens are bit-identical.
- **Guns:** K-47 (auto rifle), Breacher (pump shotgun: 5 pellets spread evenly across ±10° with a seeded jitter of up to ±⅛ of the gap between pellets, a 0.6 m/s shove per pellet hit), Widow (bolt sniper: 0° on the ground, 1.5° minimum in the air; a standing headshot is 112.5 = one-shot, crouching denies it). Airborne recoil push (Breacher 3.5 m/s, Widow 2.0 m/s).
- **Melee (V):** 0.12 s lunge (sidearms +4 m/s, heavy +2, others +3 along the facing, added once and capped at that speed above the run cap, so swings can't stack speed and a swing only trims knockback), 0.15 s windup that blocks firing, then 7 rays across a 70° arc (1.1 m; Machete 1.2 m) hit everyone not covered by a wall, with 6 m/s knockback. Damage per weapon (Hammer 25 … Breacher 40); the **Machete** kills in one swing with Fire or V, only while it is the held weapon (docs/03 §11); carried in the other slot it doesn't change the gun's bash; it never dual-wields. Breacher pellets stop at a victim an earlier pellet of the same shot killed. Melee kills have their own kill-feed source (60).
- **Protocol v6** (on top of W6's v5; W6's PR #18 follows as v7): `meleeTicks` appended to the local-player block as its own delta group after slot 1 (prediction needs the lunge and swing timer); nothing in the v5 layout moved. The new weapons are covered by `CONTENT_HASH` through `HASHED_CONTENT.weapons`.
- **Lag compensation:** bullets, Breacher pellets and the melee ray fan all test players in one target loop (`traceTargets` in combat.ts), which consults `Game.rewind`, so W6's lag comp applies to every new weapon. Remote players' swings aren't visible online yet (only their hits); see `w5-arsenal-interfaces.md` in the notes folder.
- **Debug client:** "Give weapon (dev)" folder in the tuning panel (local mode; map spawners are milestone B), melee arc drawing, weight in the HUD. Screenshots in `docs/screenshots/arsenal/`.

### 15.1 Feel table (TTK s · hit rate; pellets count individually)

| Weapon | 5 m ground | 5 m air | 12 m ground | 12 m air | 18 m ground | 18 m air | docs/03 §6 |
|---|---|---|---|---|---|---|---|
| Hammer .44 | 1.82 · 100% | 1.79 · 100% | 1.82 · 100% | 1.52 · 98% | 2.39 · 100% | 3.13 · 79% | 1.8 s |
| Buzz | 1.33 · 100% | 1.34 · 93% | 2.54 · 58% | 3.80 · 43% | 7.17 · 37% | 8.79 · 29% | 1.4 s |
| **K-47** | 0.91 · 100% | 0.96 · 88% | 1.69 · 55% | 2.33 · 40% | 3.39 · 36% | 4.87 · 29% | 0.9 s |
| **Breacher** | 0.78 · 50% | 0.78 · 50% | 7.88 · 20% | 7.88 · 20% | out of range | out of range | instant ≤ 4 m |
| **Widow** | 0.82 · 100% | 0.82 · 100% | 0.82 · 100% | 0.82 · 100% | 0.82 · 100% | 0.78 · 100% | 0.8 s |
| **Machete** | 0.17 · 100% at 1 m | 0.17 · 100% at 1 m | — | — | — | — | 1 hit |

Melee bash with a gun (0.6 s between swings): Breacher and Widow 3 swings, Hammer and K-47 4, Buzz 5.

### 15.2 Read and deviations
- **K-47 spread 5° → 4°** (one knob, the smallest change that passes): at docs/03's ±5° it hit 46% at 12 m for a 2.11 s TTK, over the ≤ 2 s mid-range target. At ±4° it hits 55% for 1.69 s and still sprays wider than the Buzz (3.5°). Sweep: 4.5° → 51% / 1.93 s; 3.5° → 60% / 1.55 s.
- **Breacher:** at 5 m, 3 of 5 pellets land, so it's two pumps (0.78 s); inside ~4 m all 5 land (one-shot, unit-tested). Ground and air rows match because pellet hits are discrete (5 pellets to kill either way). The feel probe steers to hold its range against the recoil push.
- **Widow air-sniping is barely penalised at ≤ 18 m:** the 1.5° minimum air spread is ±0.47 m at 18 m, inside a standing hitbox. If the A/B playtest finds air-sniping too strong, raise `minAir` toward 3° before touching anything else.
- **Machete at 5 m** (4.7 s on the ground, 1.9 s in the air) is the lunge closing the gap swing by swing, not a ranged hit.
- Feel targets for the new weapons are in `scripts/feel-targets.ts`; all rows pass.

## 16. WebTransport (UDP) via a Rust gateway (W6 milestone "Done")

> 17 Oct 2026, hardened after review the same day. docs/05 §2.1–§2.3, docs/09 §8. No protocol change (same messages, new transport). Golden hashes unchanged.

**Are we using UDP?** Yes, now, wherever the browser can. `apps/wt-gateway` (Rust: quinn + web-transport-quinn, rustls/ring) terminates WebTransport and forwards each session to the game server over a Unix socket, so the room sees an ordinary connection. Messages the protocol marks unreliable (INPUT, PING, PONG, SNAPSHOT, DEBUG) travel as **datagrams** (≤ 1000 B; larger ones use the stream). Everything else uses one long-lived bidirectional stream per session. The client tries WebTransport first (2 s to become ready, real datagrams required) and falls back to WebSocket. Only a first connect that looks like a UDP-blocking network (no handshake in 2 s, or no datagrams) is remembered, for an hour, per network type and server host; a refusal or a failure while reconnecting isn't. Reconnects resume the session either way. Once a session has fallen back to WebSocket it stays there until the page reloads (no switching back mid-match).

**Why it matters.** The two transports differ in what happens to a lost packet: a datagram loses only itself, while TCP resends the segment about one round trip later and holds everything behind it.

Simulated, `pnpm --filter @military-forge/game-server netsim` (2 clients walking/jetting, real Room; WebSocket = the conditioner's TCP stream mode; re-run 17 Oct after the review):

| profile | transport | snapshot age p50 / p99 | frames with interpolation stalled | inputs missed/min | corrections/min | resyncs |
|---|---|---|---|---|---|---|
| Good (80 ms, 0.5%) | WebSocket | 41 / 86 ms | 0.3% | 54 | 2.0 | 0 |
| Good (80 ms, 0.5%) | WebTransport | 41 / 45 ms | 0.0% | 0 | 0.0 | 0 |
| **Target (150 ms, 2%)** | **WebSocket** | 76 / **225 ms** | **4.9%** | 386 | **23.5** | 0 |
| **Target (150 ms, 2%)** | **WebTransport** | 75 / **81 ms** | **0.0%** | 1 | **0.0** | 0 |
| Bad wifi (200 ms, 5%) | WebSocket | 108 / 313 ms | 19.5% | 1049 | 83.5 | 183 |
| Bad wifi (200 ms, 5%) | WebTransport | 101 / 125 ms | 0.5% | 2 | 0.0 | 0 |
| Mobile (300 ms, 3%) | WebSocket | 163 / 463 ms | 22.4% | 1148 | 84.0 | 134 |
| Mobile (300 ms, 3%) | WebTransport | 153 / 190 ms | 2.8% | 3 | 0.0 | 0 |

Browser, 40 s of walking/jetting at 150 ms RTT / 2 % loss. A one-off manual measurement (the net graph's numbers, read off by hand with `scripts/udp-impair.ts` in the path); there's no script to re-run it:

| | interpolation stalled | snapshot gap p99 / max | corrections | resyncs |
|---|---|---|---|---|
| **WebTransport, real QUIC through a lossy UDP proxy** (`scripts/udp-impair.ts`: 1.9 % up / 1.6 % down of real packets dropped) | **0.0 %** | **63 / 74 ms** | **0** (1,238 exact matches) | 0 |
| WebSocket, TCP retransmits modelled by the conditioner | 5.2 % | 189 / 204 ms | 14 (≈ 20/min) | 2 |

Caveat: real TCP loss needs kernel-level impairment (dummynet, root), so WebSocket's side is the conditioner's model: a lost message arrives one RTT late and holds up everything behind it. That's a lower bound on TCP's real penalty, since the minimum RTO is ≥ 200 ms. WebTransport's side used real QUIC with real dropped UDP packets.

**Also:**
- The in-app conditioner models the transport in use (TCP stalls on WebSocket), so `?rtt=150&loss=2` now looks worse over WebSocket than before. That's the real cost: earlier numbers in §9 and §11–§14 used the datagram model.
- Fallback verified in the browser: killing the gateway mid-game → "WebTransport session lost" → resumed over WebSocket as the same player in 0.3 s.
- Safari (docs/05 §2.3): the library sends WT_MAX_SESSIONS and accepts the legacy `:protocol = webtransport` that Chrome and Safari send. The client refuses a session without datagrams (Safari's HTTP/2 fallback) and falls back to WebSocket. Reliable messages use one long-lived stream. Not yet tested on a real Safari. The library doesn't accept `webtransport-h3` yet (no browser sends it today; upstream follow-up).
- Tooling: Rust 1.99.1 installed user-level with rustup (`--profile minimal --no-modify-path`, `~/.rustup` + `~/.cargo`, no shell profile edits) plus its clippy and rustfmt components (rust-toolchain.toml); `rustup self uninstall` removes it all. `Cargo.lock` is committed.

**Rooms by code over WebTransport (18 Oct, in two steps).** The gateway's OPEN frame now carries the session's request target after the remote address (`127.0.0.1:50000\n/wt?room=KQMZPT`), so the game server can route a WebTransport session the way it routes a WebSocket URL (`/ws/CODE`). The client puts the room in the query (`?room=CODE`), but only when `/health` advertises `webtransport.rooms: true`. Otherwise a session would land in the default room, so a room by code stays on WebSocket. Step 2 (after rooms by code landed): the bridge opens each session through the room registry's door with that target and the client's IP, exactly like a WebSocket connection. The HELLO deadline, join tickets, per-IP and per-room limits and NoRoom all apply. `/health` now advertises `rooms: true`, and the app's online mode uses `'auto'` for rooms by code. The bridge no longer needs a default room (`DEFAULT_ROOM=0` servers get WebTransport too). Checked with the release gateway and `wt-probe`: `?room=KQMZPT` lands in that room; a session with no code on a server without a default room gets 4006.

**On the trial box (19 Oct 2026; docs/net-trial.md §1.1).** The Johannesburg box had been on WebSocket only, for two reasons. Its cloud-init never set up a gateway. And `index.ts` passed the gateway socket only to servers with a default room, a leftover from before step 2 above, so a `DEFAULT_ROOM=0` server never opened the bridge. Both are fixed: `scripts/net-trial/wt-setup.sh` builds the gateway on the box with the repo's pinned Rust, runs it on UDP 443 with Caddy's certificate (Caddy no longer serves HTTP/3), and checks a real session. The client now waits 4 s for a handshake (was 2 s: ~2 round trips is ~1 s on the 500 ms phones measured that day, and a timeout was remembered as "UDP blocked" for an hour). It gives a silent session 3 s before falling back to WebSocket (was 1.5 s, shorter than a phone's latency spikes).

**Hardening (17 Oct, PR #9 review).** The first version let one browser hurt everyone: a single 65,532-byte reliable message dropped the whole bridge (every WebTransport player), unbounded per-session queues let a client that withheld stream credit stall its session (and its CLOSE), quinn's default limits allowed 100+100 streams per connection (one reached ~162 MB), and a hung gateway stayed advertised for ~9 s of dead air. Now:
- **Per session:** browser messages are capped at 4 KB (the WebSocket limit; more closes that session with 4003), datagrams drop when its queue is full, a reliable backlog over 256 KB or a write not taken within 5 s closes it (1013, it may resume), and the game server's CLOSE never waits behind its writes.
- **Per connection:** 4 bidi + 4 uni streams, 64 KB stream / 256 KB connection windows, 64 KB datagram buffers, 15 s idle timeout. **Per node:** 1000 sessions, 8 per IP (`WT_MAX_SESSIONS`, `WT_MAX_SESSIONS_PER_IP`).
- **Liveness:** the game server pings the gateway every second and drops it after 3 s of silence (its players resume, `/health` stops advertising it). The client drops a WebTransport session silent for 1.5 s and resumes straight over WebSocket.
- **Ops (docs/09 §8):** one gateway per node routes by path (`WT_ROUTES=/wt/1=…/gs1.sock,…`); SIGTERM drains (sessions close with 1001 and resume); SIGHUP or a changed file reloads `WT_CERT`/`WT_KEY`; a self-signed certificate renews a day before its 13 days run out and the servers advertise the new hash. Bad settings (a certificate without a key, a non-https or query-carrying public URL) stop it at startup.
- **Bridge hygiene:** the socket is 0600 in a private 0700 directory (dev default: `$XDG_RUNTIME_DIR` or the temp dir, `military-forge/wt-<port>.sock`, the same path in both programs); only a stale socket is ever removed; INFO is escaped on one side and validated on the other; one gateway at a time; a bridge that can't listen leaves the server WebSocket-only instead of failing to start.
- **Tests:** `apps/wt-gateway/tests/gateway.rs` (real QUIC clients against the gateway code and a fake game server: oversized message, withheld credit, backlog, caps, routes, datagrams, lost server, drain) and `apps/game-server/test/gateway.e2e.test.ts`, the Rust↔TypeScript contract (the release binaries against the real bridge, with `wt-probe` as the browser; CI's wt-gateway job runs it). Against the pre-fix gateway that test fails: the oversized message closes the other player with 1001.

## 17. Blast launches (17 Oct 2026, owner request)

> "If a bomb explodes it throws the player beyond." Before this, a frag 2 m away did 93 damage but only shoved the survivor 3.6 m along the floor: the push was nearly horizontal, so ground friction stopped it within a few frames, and the air drag on extra speed (1.5/s) bled the rest.

| Change | Before | After |
|---|---|---|
| Frag `impulse` (m/s at the centre) | 14 | **26** |
| `minLift` (new): minimum upward share of a level or low blast's push | — | **0.7** (~45° arc; blasts from above still push down) |
| `selfImpulseMul` (new): the thrower's own blast | — | **0.6** (a grenade jump, not a ledge skip) |
| `knockbackCap` | 18 | **26** |
| `launchSpeedX` / `launchDragX` (new) | — | **12 m/s / 0.3 per s**: above 12 m/s horizontal (only blasts get there) the flight bleeds slowly |

| Frag on the floor, standing survivor | Before | After |
|---|---|---|
| 2 m away (93 damage) | 3.6 m shove, 0.5 m high | **16.0 m flight, 5.4 m high** |
| 3 m away (59 damage) | 1.4 m | **6.6 m, 2.3 m high** |
| at your own feet (~49 damage) | — | **5.9 m grenade jump** (straight up; full impulse would be 17 m, more than a full tank) |

- **Lunges are unchanged.** Melee-lunge spam in the air already reaches 10.5 m/s (23.1 m in 3 s vs 18.3 m plain). That is below `launchSpeedX`, so it keeps the normal 1.5/s drag. A global drag cut would have pushed it to 26.3 m. A test pins this.
- **Targets:** in `feel-targets.ts` as BLAST_TARGETS (2 m: 12–22 m flight, peak ≥ 4; 3 m: 4–10 m), and in the `feel` report.
- **Goldens:** match-dm and range-combat re-recorded. The match-dm script now throws P2's second frag after his first frag's grenade jump lands, otherwise he'd be thrown clear of it.
- **Prediction:** knockback is still not predicted (§9.4). Launches arrive as server corrections, smoothed like other knockback. The protocol and encodings are unchanged: the local block carries ±512 m/s and remote velocity carries ±32 m/s, both above the 26 m/s cap.

## 18. Map mechanics: rules, zones and events (17 Oct 2026, owner request)

> "We'll build maps where some things are thwarted, some there's no gravity, some flights are longer, some bullets don't go far, some things just happen that messes with the mechanics." Three data-driven layers in the MapDef. Spec: docs/02 §20; bullets: docs/03 §8; protocol: docs/05 §6.2, §8.

- **Rules** (`MapDef.rules`, map-wide) and **zones** (`MapDef.zones`, rect or polygon) share one set of modifiers: `gravityMul`, `fuelBurnMul`, `fuelRegenMul`, `bulletRangeMul`, `moveSpeedMul`, `knockbackMul`, `drag`, `wind`, `dive`, `jetDisabled`. Zones add `launch` (pads). Multipliers multiply, wind and drag add.
- **Zone kinds** (packages/content `ZONE_KINDS`): zeroG, lowG, reverseG, longFlight, damping (bullet fog), wind, slow (mud), water, jumpPad, boostPad, emp, custom. A kind fills in every effect a zone leaves out, so a JSON zone can be just `{ "id": "pad", "kind": "jumpPad", "rect": [...] }`. The defaults are in CONTENT_HASH.
- **What each applies to:** players by body centre (movement, jetpack, fuel, gravity, knockback), grenades by centre (gravity, wind, drag, pads), bullets by the stretch of ray inside (range and falloff), blasts and hits by where the target stands (knockback).
- **Bullets** spend their weapon range as a budget: 1 per metre in clear air, 1/m per metre in a damping zone, scaled by the map-wide multiplier. Falloff reads the budget used, so fog both shortens and weakens a shot.
- **Pads** are level-triggered ("speed along the launch direction rises to at least its length"), so standing on one bounces you without stacking, with no per-player cooldown state.
- **Down dives** in the air where a zone gives `dive` (zero-g, reversed gravity): the only new use of an existing input. Reversed-gravity pockets got drag 1.5 after a trace: at 0.6 the bob at the pocket's top edge took ~10 s to settle; 1.5 settles in 3.9 s.

| Feel at the kinds' defaults | Measured | Normal |
|---|---|---|
| low-g 0.2 s tap / full-tank climb | 3.5 m / 17.7 m | 1.2 m / 13.0 m |
| zero-g drift 1 s after a tap; Down turns it around in | 4.3 m/s; 0.3 s | — |
| long flight: tank / jet + run | 5.7 s / 55 m | 2.25 s / 23 m |
| fog (10 m of it, 5 m out): Hammer / Widow reach | 12.4 / 41.4 m | 26 / 60 m |
| wind: drift in a 1 s fall | 4.9 m | 0 |
| mud walk / water sink after 1 s | 2.25 m/s / 4.7 m/s | 5 m/s / 16 m/s terminal |
| jump pad apex / boost pad flight from a run | 6.5 m / 11.3 m | — |

- **Targets:** `ZONE_TARGETS` and `FOG_TARGETS` in feel-targets.ts, in the `feel` report.
- **Goldens:** unchanged. A map with no rules or zones compiles to no mechanics (`Game.mech === null`) and runs the old code path; `mechanics.test.ts` replays range-combat, arsenal-guns and oneway under a neutral zone over the whole map and under a zone nobody enters, and gets identical hashes.
- **Prediction:** effects are pure functions of map data and position, so the client's predicted player gets them bit-identical with no protocol change.

### Events ("some things just happen")

- `MapDef.events = { defs, schedule }`. Kinds (`EVENT_KINDS`): gravitySurge, lowGravity, emp, fog, gust (gusting, sometimes the other way), flip (a reversed-gravity pocket at one of several sites), custom. An event applies its modifiers map-wide; zones with `event: "<id>"` switch on only while it runs.
- **The schedule is stateless:** `random` (seeded cycles, weights, chance) or `timeline` (fixed times, optional loop). The occurrence covering a tick is computed from the map, the room seed and the tick alone, so prediction needs nothing new: the client's predictor already has the map (CONTENT_HASH), the seed (WELCOME) and the server's tick numbering.
- **Announcements:** a `mapEvent` sim event on a warning, a start and an end. **Protocol v8** sends it as MAP_EVENT, snapshot event tag 6 (51 bits, never AOI-culled). Tag 7 is the last free one: use it as an escape to a longer tag. Event and zone kinds' defaults are in CONTENT_HASH.
- **Gravity surge tuned to ×1.8** (was 1.7 in the draft): a full tank climbs 8.2 m instead of 13. The climb collapses between ×1.8 and ×2.0 (thrust 38 m/s² against gravity 36–40): ×1.85 gives 5.6 m, ×1.9 3.0 m, ×2.0 0.4 m.

| Feel at the event kinds' defaults | Measured | Normal |
|---|---|---|
| gravity surge: full-tank climb | 8.2 m | 13.0 m |
| low gravity: 0.2 s tap | 3.5 m | 1.2 m |
| fog bank: Hammer reach | 10.4 m | 26 m |
| wind gusts: 1 s fall at a peak | 5.6 m drift | 0 |

- **Test map + goldens:** `mechanics-test` has every zone kind, every event kind on a 49 s loop, map rules, and dummies. New goldens `mech-zones`, `mech-bullets`, `mech-events` (8,000 ticks); the 10 existing goldens are unchanged.
- **Online:** `apps/game-server/test/mapMechanics.test.ts` runs two NetClients against a Room on the mechanics-test map: 0 mispredictions on a clean LAN through every zone and a whole event loop, < 1 correction/min at 150 ms / 2 %. Control (not committed): a client with the mechanics stripped from its predictor mispredicts > 10 times in 30 s.

### Demo maps and the map JSON format

- **Lunar Outpost** (`lunar-outpost`): map rules gravity ×0.45 and fuel burn ×0.75 (docs/01's "Lunar"), a zero-g hab dome, crater jump pads; events: solar flare (EMP), gravity generator (×2.2 on top of the rules: Earth gravity for 15 s).
- **Storm Front** (`storm-front`), authored as **map JSON** through `parseMapJson`: a gale above the rooftops, sea fog over the harbour (bullets ×0.4), deep water; events: squalls, fog rolling in, lightning (EMP).
- **Flux Lab** (`flux-lab`): pads, an updraft shaft (long flight + wind up), an EMP deck, two gravity-pocket sites; events: gravity pocket, surge, low gravity.
- **Playing them:** `/?map=<id>` in local mode (links in the debug bar); online `MAP=<id> pnpm dev` (turbo passes `MAP` and `SEED` through now) or `--map=<id>` on the game server. The web client redraws for the server's map from WELCOME (2D and 3D `setMap`).
- **Map lint in tests:** every registered map compiles (collision, rules, zones, events) and every spawn stands clear where it's put (`packages/sim/test/maps.test.ts`); zones lie inside the bounds (content tests).
- **JSON Schema** for editors: `packages/content/schema/map.schema.json`, generated from the catalogue (`pnpm --filter @military-forge/content schema`; a test fails on drift). Each zone and event kind shows its description and defaults in autocomplete.
- **One-way slabs (18 Oct, from the owner's playtest: "bullets go through buildings"):** every one-way platform is also `BulletPass`, like a railing, and the Street Market's roofs and floors are one-ways.
  - `MapOneWay.blocksBullets: true` (in map JSON too; default false) compiles a one-way without `BulletPass`. It stays one-way for bodies: fly up through it, stand on it, drop through it.
  - Bullets, ricochet legs, blasts, gas, flashes and sight lines stop at it from either side, and grenades bounce off its underside.
  - Everything that already looked past railings through the `BulletPass` mask follows it unchanged: combat, explosions, mines, clouds, the bots' line of fire and the throw preview. Grenade flight (`sweepCircle`) is the one place that tests it.
  - `parseMapJson` now refuses unknown keys on one-ways (a misspelt `blockBullets` must not silently leave a slab see-through).
  - No map sets it yet, so no golden changed. Impacts on a slab still read as wood: one-ways compile as material 2.

### On screen

- **HUD banner hook:** frames carry `mapEvent` from the local or predicted game; `shell.setMapEvent` → store → `MapEventBanner` (under the match clock, kind colour; "in N" during the warning, then the line and time left). `useMapEventBanner(store)` for other HUD code. The kill feed logs warnings, starts and ends.
- **2D overlay (H/B over 3D, always in 2D):** zone tints, outlines, labels and flow chevrons; event zones dotted while off, pulsing while opening.
- **3D:** tinted zone volumes with rims and particles per kind; event zones fade with their event; fog events thicken the scene fog.
- **Checked in the browser pane** (this branch's own servers): Flux Lab in 2D (updraft arrow, EMP field, dotted pocket sites); mechanics-test in 3D (low-g and zero-g volumes, the WIND GUSTS banner, then GRAVITY POCKET: banner "in 1", the picked site opening, the player lifted to hover at its top edge).

## 19. Dash (17 Oct 2026, owner request)

> Owner request (paraphrased): dash physics for fast movement between spaces, brief like a fighting-game dash, but up and down too. Spec: docs/02 §21.

- **An 8-way jetpack burst** on `Shift` (`Btn.Dash`, bit 13): 14 m/s (20 since §27) for 8 ticks along what you hold (A/D, W = up, S = down; nothing = facing), no gravity during it, then back within the walk/air caps and at most 2 m/s up. Normal move-and-slide: walls stop it.
- **Limits:** 1.0 s cooldown, one air dash per flight (reset on landing; a ground dash, even through a platform, isn't the air one), 8 fuel, blocked by EMP (it's a jetpack burst). Straight down on a one-way platform drops through it; straight down on solid ground does nothing and costs nothing.
- **No i-frames:** any knockback ends a dash on the spot.
- **Bug caught by the golden's trace:** a drop-through dash first counted as the air dash, because dropping clears `grounded` before the air-dash check. `startDash` now uses where the dash started; a test pins it.

| Feel (defaults) | Measured | Target |
|---|---|---|
| Ground covered from standing | 2.05 m | 2–2.5 |
| Up from standing | 1.95 m | 1.5–2 |
| Down from a 6 m hover to the ground | 0.40 s (falling: 0.77 s) | 0.3–0.5 |
| At a wall 1 m away | stops at 1.00 m | ≤ 1 |
| Burst | 0.13 s | 0.10–0.17 |

- **Protocol v8 (folded into the map-events bump, as asked):** local block dash group (18 bits), remote `dashing` flag (flags now 8 bits), and snapshot tag 7 is now the escape to extended events, the first of which is DASH. Tuning gained `dashSpeed`, `dashBurstTicks`, `dashCooldown`, `dashFuelCost`, `dashExitUp` (in CONTENT_HASH via the default tuning; the dev panel has a Dash folder).
- **Goldens:** a new closed-loop `dash` replay (ground, up, drop-through, the air dash and a refused second, a refused straight-down on solid floor, a wall stop at the 12 m tower, a slam, down-left along the floor, a press in the cooldown). All earlier goldens unchanged: dash state is hashed only away from rest.
- **Online:** `apps/game-server/test/dash.test.ts`: no mispredictions on a clean LAN over 42 dashes in 30 s (7 directions, 16 in the air); < 1 correction/min at 150 ms / 2 %.
- **Hooks:** the `dash` sim event (player, start, direction) and `PlayerView.dashing` for the animation and render3d streaks; the 2D debug view draws a fading streak. The riot shield plugs into `dashBlocked()` (see the notes folder: mechanics-dash.md).

### Review fixes (17 Oct 2026)

- **H1 bullets:** walls are tested only within the map's reach (fog: a wall past the shortened reach isn't reached; range ×2: walls past the nominal range still stop bullets). Before, the raycast used the nominal range.
- **M1/M5 dash caps:** a push ends a dash from the exit caps, not from 14 m/s (Breacher pellets mid-dash used to leave ~13 m/s and a slow launch-drag glide); the exit never exceeds `launchSpeedX`, even on a ×3 speed map.
- **M3 reversed gravity:** no ceiling bonk while gravity points up (it fired every tick: a 0.7 m/s crawl along the ceiling); the lint refuses reversed gravity without dive.
- **M4 speed limit:** a raised knockback cap stops at 36 m/s. At ×4 (104 m/s) move-and-slide's 4 substeps were 0.43 m, and a 100 m/s sideways launch went through a 0.15 m wall.
- **Dash while flying:** a held jet (burning > 6 ticks) no longer tilts dashes up; a fresh W press still does. `?dashtap` ignores W (jet feathering).
- **Flux Lab pads** launch at 17.5 m/s (7.8 m apex) so they reach the 7 m catwalks (the default 16 peaks at 6.6 m); a test pins it.
- **Kinds** validate with `Object.hasOwn` ("toString" and "constructor" were accepted); no brand string in the map schema; clean-room wording for the dash request.
- No golden changed. Each fix has a test that fails on the old code.

### Thin solids (review follow-up, 17 Oct 2026)

- **Cause:** move-and-slide resolved the deepest contact first. A capsule touching the near face of a solid thinner than its radius (0.32 m) also reaches the far face from behind. That contact (`r + dist`) always won, so the body was pushed out the far side. Dashes, walks, falls and launches all did it. On main, a dash went through every wall up to 0.1 m, a walk through walls up to 0.08 m at some offsets, and a slam through floors up to 0.1 m. A probe counted 1,128 of 3,850 cases through, and 805 of 2,400 for slabs tilted up to 30°. Now both counts are 0.
- **Fix:** a contact in front of a face beats any contact from behind a face (`deepestContact`). Contacts from behind still push out a body that is inside a solid (spawn depenetration).
- **Lint:** the map compiler warns about a solid thinner than 0.3 m between two facing edges (`MIN_THICKNESS`, `thinnestSolid`). Ramps, wedge tips and notches don't count. Shipped maps have no warnings (the thinnest solid is 0.4 m), and a test pins that.
- No golden changed. The new tests fail on the old resolver.

## 20. Riot shield: random pickups, carry modes, ricochet (17 Oct 2026, owner request)

> "You can randomly pick shield and how you can carry it and how bullets bounce off it." Built in four stacked PRs: spawners and carry modes; block, break and ricochet; protocol and rendering; then the slung shield guarding the back (the owner's answers, 17 Oct: ricochets never hit their shooter, a slung shield blocks from behind, keep 300 HP). They landed as one PR rebased onto map mechanics + dash, as **protocol v9** (§20.5). Rules are in docs/03 §9 and §12.

**Shape of the block.** The shield is a vertical segment 0.9 m tall: 0.35–1.25 m standing, 0.12–1.02 m crouched.
- **Raised**, it sits 0.42 m in front of the body and blocks bullets from within ±60° of the facing. Standing, a precise shot can still go over it (the top of the head) or under it (the legs); crouched behind it, almost nothing is exposed.
- **Slung**, it sits 0.40 m behind the body, where the 3D back socket shows it. It blocks bullets from within ±60° of the back (the owner's call, 17 Oct).
- **On its way up** (0.25 s) it blocks neither side.
- Front and back share the one 300 HP pool, which the owner chose to keep.

**Ricochet.** A bullet that strikes the shield, front or back, reflects about its normal. A vertical shield flips the horizontal direction, so a level shot comes straight back.
- The ricochet keeps the range it has left and 60% of its damage.
- It can hit anyone except the shield's owner and **its own shooter**. That was the owner's call (17 Oct), and it matches docs/03 §8, which has no bullet self-damage. Without it, a head-on shot would always hit its own shooter.
- It bounces at most once; the next shield it meets stops it.
- Pellets ricochet one by one.

### 20.1 Feel table: a shooter against a shield carrier (`pnpm --filter @military-forge/sim feel`)
The carrier stands with a Hammer. The shooter, grounded, re-aims at the carrier's torso every tick (no aiming over or under the shield). 10 seeds each.
- **Front:** the carrier faces the shooter with the shield raised.
- **Flank:** it faces away with the shield raised, so its back is bare.
- **Back:** it faces away with the shield slung.

| Weapon @ distance | Front TTK | Shield broke, front (runs, mean time) | Bullets on the shield, front | Flank TTK | Back TTK | Front ÷ flank | Back ÷ flank |
|---|---|---|---|---|---|---|---|
| Hammer .44 @ 5 / 12 m | 10.62 s | 100%, 6.80 s | 71% | 1.82 s | 10.62 s | ×5.8 | ×5.8 |
| Buzz @ 5 m | 6.27 s | 70%, 6.47 s | 75% | 1.34 s | 6.28 s | ×4.7 | ×4.7 |
| Buzz @ 12 m | 9.02 s | never | 35% | 2.73 s | 8.92 s | ×3.3 | ×3.3 |
| K-47 @ 5 m | 3.66 s | 30%, 5.57 s | 73% | 0.90 s | 3.58 s | ×4.1 | ×4.0 |
| K-47 @ 12 m | 6.79 s | 10%, 7.80 s | 34% | 1.59 s | 6.79 s | ×4.3 | ×4.3 |
| Breacher @ 5 m | 5.62 s | 30%, 5.82 s | 39% | 0.78 s | 5.37 s | ×7.2 | ×6.9 |
| Breacher @ 12 m | no kill in 20 s | never | 20% | 7.88 s | no kill in 20 s | — | — |
| Widow @ 5 / 12 m | 5.72 s | 100%, 4.10 s | 67% | 0.82 s | 5.72 s | ×7.0 | ×7.0 |

**Read.**
- Accurate guns (Hammer, Widow) must break the shield first: 300 HP is 10 Hammer or 4 Widow rounds, plus reloads.
- Wild automatics (Buzz, K-47, with bloom) mostly kill *around* it, through the head and legs, long before it breaks.
- From the front, the shield multiplies time to kill by ×3–7. That's a power-item number, paid for by:
  - the ×0.75 speed;
  - no dual;
  - melee, frags and flanks ignoring it;
  - aimed shots over and under it.
- **Slung is as strong from behind as raised is from the front,** and it weighs nothing (×1.0 vs ×0.75 raised). So a rifle carrier with a slung shield gets a free, strong back guard against flankers. If playtests say it's too much, the knob is `RIOT_SHIELD.slungSpeedMul` (e.g. 0.9).
- **Playtest question:** is ×7 against a Breacher too much? Bashing in close should be the answer.

### 20.2 Determinism
- Spawner draws are stateless hashes of (seed, tick, spawner, draw).
- A map without spawners, or a game with pickups off, is bit-identical: every older golden is unchanged (the 10 from before, and mechanics + dash's `mech-zones`, `mech-bullets`, `mech-events` and `dash`).
- The new `shield` golden (841 ticks, 3 players, pickups on; re-recorded for v9, where the shield key moved to bit 14) covers:
  - the spawn and pickup;
  - five pellet ricochets, two of them into a third player;
  - the Buzz through a slung shield;
  - a death with the shield up but turned away, and the drop;
  - another player taking the dropped shield;
  - that player slinging it and turning its back: five ricochets off the back guard;
  - a shield bash;
  - a point-blank break.

### 20.3 Online and on screen (protocol v9)
- **Prediction:** the carry state rides in the local block. A carrier who toggles the shield and swaps to a two-handed weapon predicts with **0 mispredictions** (`apps/game-server/test/shield.test.ts`). Picking a shield up is the server's call, so the first tick after a pickup arrives as a correction.
- **Bandwidth:**
  - Items on the map cost 1 bit per snapshot unless they changed.
  - A ricochet event is ~17 bytes; break and pickup events ~8 bytes.
  - Two more bits of remote flags (bits 8–9), and 19 bits of local block without a shield (25 with one), sent only when they change.
- **Lag compensation:** the pose history records the shield up (front) and slung (back) separately, with the facing, so both are rewound with their owner. No wire change: remote flags already say carried and up.
- **Screenshots:** `docs/screenshots/shield/`, taken with `node apps/web/scripts/shield-shots.mjs`:
  - 3D: an item at its spot; raised; raised with the H overlay (the sim's blocking segment); a ricochet; slung;
  - 2D: raised; ricochet rays; slung.
- **The 3D ricochet spark is a Vfx module** (`RicochetSparks` registered with render3d's `Vfx`): it hears the sim events the 2D renderer forwards (`Renderer.forwardEvents`), so frames carry no event list.
- **The 3D shield is a placeholder.** The model spec and socket offsets for the Forge are in the shared notes (`shield-sockets.md`). The Rookie's short arms hold it ~5 cm inside the sim's line; the H overlay shows the exact segment.

### 20.4 Review fixes (17 Oct)
- **H1:** the shield stack and mechanics + dash both took protocol v8 and the same wire slots (INPUT bit 13, remote flag bit 7, tag-7 ext kind 0, local block 41+). Fixed by the re-allocation in the protocol registry: v9, the shield key at bit 14, flags 256/512, ext kinds 1–3, the shield group at 45–47 (§20.5).
- **M1:** a ricochet from a culled shooter is sent as its spark only. Un-reflecting two ricochet lines placed the hidden shooter within 2 cm.
- **L1:** pellets that shove a carrier through its shield count as an attack, so a pit kill is credited to the shooter, not a suicide.
- **L2:** items on the map are culled by view.
- **L3:** the 0.25 s raise travels and draws as its own state ("raising": dashed in 2D, held low and tipped in 3D), because it guards neither side.
- **L4:** a leaving carrier drops its shield.
- **L5:** a structured fuzz now reaches the item list and tag-7 decoders, and the `shield` golden has 5 ricochets off a back guard (re-recorded: now 841 ticks, 3 players).
- **L6:** the placeholder plate sits 10 cm further out so the hand stays behind it, and the ricochet spark is bigger, warm and drawn on top.

### 20.5 Rebased onto mechanics + dash (protocol v9)
- **Wire (protocol registry):** `Btn.Shield` is INPUT bit 14 (X on the web; Shift stays Dash); the remote shield state is flag bits 8–9 (256/512) in a 10-bit flags field (DASHING keeps 128); ricochet, shield break and pickup are tag-7 ext kinds 1, 2 and 3 (DASH keeps 0; tag 6 is MAP_EVENT); the shield group follows the dash group at 45–47. One bump, to 9, with its line in `messages.ts`.
- **A shield strike pushes like any hit:** `strikeShield` uses `push()`, so the map's knockback multiplier applies and a shove ends a dash.
- **Ricochets fly through the map's air:** the leg after the bounce is cast with the map's bullet reach (`mech.bulletReach`) for the range it has left, and falloff reads the budget used (`mech.bulletCost`), so fog shortens and weakens a ricochet like any shot.
- **Movement then the shield:** the tick runs `stepMovement(…, env)` for everyone, then `stepShield`, before anyone fires.
- **No dashing behind a raised shield:** `dashBlocked()` refuses a dash while the shield is up or coming up; lower it (X) to dash. A slung shield doesn't stop a dash.
- **Maps:** `MapDef.spawners` is in the map JSON format and its schema (`parseMapJson`, `map.schema.json`).
- **CONTENT_HASH** carries both the zone/event defaults and the pickups.

## 21. Touch controls for phones (18 Oct 2026, owner request)

> `apps/web/src/touch/**`, one mount line in main.ts. No protocol change: the controls produce the same `Input` as the keyboard. Golden hashes unchanged.

**Why.** People open the shared link on a phone, and most players in Nigeria and India are on phones. Without touch input they couldn't play at all.

**What a phone gets.**
- **Left stick (floating):** a thumb anywhere on the left half of the game grabs it there. Past 30 % sideways walks; half-way up jets; 60 % down crouches or drops. A quick stroke and lift (≤ 220 ms, ≥ 75 %) dashes that way (a slow stroke is just a step).
- **Right stick (floating):** aims. Hold mode (default) fires while it's pushed past half-way and only aims nearer the centre; release mode aims, then fires once on lift (sliding back to the centre first cancels).
- **Buttons:** grenade (hold = cook, drag = aim the arc and set the strength, release = throw; a tap throws at full strength, like G), next grenade, swap, reload, dash (the way the left stick points), melee, zoom (cycles, wraps back to none), shield (appears once `Btn.Shield` exists), menu (Escape) and scoreboard (held Tab).
- **Aim assist (touch only, on by default, a setting):** friction, never magnetism. While the aim lies on an enemy (±0.9 m, ≤ 40 m) the stick turns it at 45 % per tick, so a sweeping thumb lingers on the target. It always ends up where the stick points and never turns toward anyone.
- **Look and fit:** semi-transparent, left- or right-handed, inside the safe areas (notches, home indicator; viewport-fit=cover while up). No page scroll, pinch zoom, double-tap zoom, long-press menu or text selection while playing. A "turn your phone sideways" prompt in portrait (with "Play full screen" where the browser allows it). Optional vibration when you're hit.
- **The HUD editor** (✎ on the controls, or `openTouchEditor()` from Settings): drag any control, ± size, opacity per control and overall, reset. It's one compact row (dockable top or bottom) that fades while you drag. Saved on the device (`mf.touch.layout.v1`, settings `mf.touch.settings.v1`).

**Device detection.** On automatically when the primary pointer is a finger (`pointer: coarse`), or the first time the screen is touched; a setting forces it on or off. Mouse and keyboard keep working alongside (a tablet with a keyboard): a mouse on the game aims and fires as usual and takes the aim back from the stick; touches never turn into mouse clicks. While the shell's menus are open the controls hide and leave taps to the menus.

**Phones get** the Low preset (already the default) with the DPR cap raised to 1.5 (`Renderer3D.setDprCap`; 1.0 is blurry on a dense 6" screen) and dynamic resolution on. **First load:** the eager part (detection, settings, API) adds 1.7 kB gzip to the main chunk; the HUD (controller 5.3 + layout 1.2 + CSS 1.4 kB gzip) is a separate chunk only touch devices fetch.

**Checked** (`apps/web/scripts/touch-check.mjs`: headless Chrome as an 812×375 phone at DPR 3, real CDP multi-touch): 19/19.
- walk, jet, hold-fire (and a light push only aims), release-fire, two thumbs at once, grenade tap and drag-throw, swap, swipe dash (and a slow stroke doesn't dash), the dash button
- no scroll, zoom or selection afterwards
- the editor (a drag survives a reload), left-handed, the portrait prompt
- Low preset at DPR 1.5

Screenshots are in docs/screenshots/touch. With the CPU throttled ×4 on 3D Low, frames ran at p50 16.7–33 ms and p90 17–50 ms depending on the machine's load, with render CPU 1.9–4 ms; dynamic resolution settled at 0.6. That's software WebGL in headless Chrome (CPU-rasterised), so it's a worst case for the GPU side, not a phone measurement. **Not yet done:** a real phone (iOS Safari especially: fullscreen and orientation lock aren't available there, and its compatibility mouse events are guarded by timing), and tuning the thresholds with players.

## 22. Grenade variety and recoil push (arsenal B, 17 Oct 2026)

> Owner: "some bombs are smokes and entering kills, some are flashbangs that make you not see anything, only white for some time ... and the rebounds physics after shots."
> Numbered after the map mechanics (§18), the dash (§19), the riot shield (§20) and touch controls (§21).

### 22.1 Carrying and cycling; smoke and toxic gas

- **Belt:** grenades by type (`PlayerState.grenadeCounts`, the selected `grenadeType`). `G` throws the selected type, `T` (or mouse 5) cycles to the next type held; throwing your last one of a type brings up the next. Spawn loadout: frag ×3. `addGrenades(player, type, 2)` caps at the type's limit (frag 5, others 2), returns how many it took (0 = leave the pickup lying there) and selects the type if your selection is empty.
- **Grenade pairs on the map** (owner: "a random pair of one type from each spot's pool"): the riot shield's spawners (§20), no second system. Six pair items (`frag_pair` … `emp_pair`, wire ids 1–6) in a `grenades` pool weighted frag 3, smoke 2, flashbang 2, gas 1, mine 1, EMP 1; the seeded pool draw picks the type, touching it is `addGrenades(player, type, 2)`, and with that type full it stays on the floor. Spawners on Lunar Outpost, Storm Front, Flux Lab and the movement-test range (up on the solid platform, the top one-way and the tower).
- **Clouds** sit 1 m above where they popped and never move. Size and density are functions of type and age, so the snapshot only carries id, type, position and age. Walls bound them.
- **Smoke:** R 4 m, 12 s, opaque inside 85% of the radius until it thins out (its last 1.25 s are see-through). Bots don't track players hidden by it; `canSee`/`lineOfSight` are there for aim assist. The server's AOI doesn't send what the smoke hides from a client (§22.5, 05 §9). Walls bound a cloud in the sim and on screen: the 2D view clips it to what its centre reaches, the 3D puffs sample a reach mask, so nothing shows past a thin wall.
- **Gas:** R 3.5 m, 15 s, damage in 0.25 s pulses (4 hit events a second, not 60), 14 dmg/s inside a 1 m core falling linearly to 4 at the edge; the thrower takes half (like flames). Doesn't block vision: it's a hazard, not cover. 2D and 3D tint it a sickly green-yellow with a hazard rim, against smoke's grey.

| Feel (`pnpm --filter @military-forge/sim feel`) | Measured | Target |
|---|---|---|
| Gas, standing at the pop | 14.0 dmg/s, dead in 7.25 s | TTK ≤ 8 s: get out or die |
| Gas, 2 m from the pop | 11.2 dmg/s, dead in 9.25 s | 8–12 dmg/s |
| Gas, 3.5 m (the edge) | 5.2 dmg/s, survives the cloud (69 dmg) | 3–6 dmg/s: crossing it costs a few HP |
| Throw at 45°: first bounce / goes off | frag 11.1 / 14.8 m · smoke, gas 9.7 / 12.1 m | (smoke and gas are a little slower and shorter-fused) |

- **Prediction:** throwing and cycling are predicted (the belt is in the local block). Gas damage isn't, like any damage: it arrives as an HP correction (no position change); the cough timer then counts down exactly.
- **Dev:** `/?grenades` in local mode gives every type at its limit (recorded in replays as `grenadeLoadouts`). `?sandbox&grenades` for free play. Screenshots: `node apps/web/scripts/grenade-screenshots.mjs` against a dev server (docs/screenshots/arsenal-b/).
- **Goldens:** every existing golden is bit-identical (new state is hashed only when it isn't at rest). New: `grenades-variety`.

### 22.2 Flashbang

- **Blind time** = strength × (2.5 s of full white + 1.5 s of fade; the fade is at least 0.3 s). Strength = distance (1 inside 4 m, linear to 0 at 16 m) × facing (1 looking at it, 0.25 looking straight away; linear in the cosine between the aim and the flash) × cover (a wall in the way 0.15, smoke 0.5). Under 0.08: nothing. The thrower is a player like any other: throw it and look away. A longer blindness already running is kept.
- It's sim state (`blindTicks`, `blindFade`), hashed and in the local block: bots aim off target while blind (a deterministic stray of up to ±1.2 rad × intensity, changing every 8 ticks). It arrives online as a server correction (no position change) and then counts down exactly.
- **What the server enforces:** the full white. While a client's blindIntensity is 1 it is sent no other player, their gunfire only as SOUND events, and no grenade but its own, so a client that drops the white-out still sees nothing. The fade (intensity below 1) is drawn by the client and could be skipped by a modified one; that residue is accepted.
- **Screen** (`apps/web/src/fx`, mounted with one line in main.ts): white-out with the photosensitivity limiter (one full-screen onset a second, at most, and no rise of an onset's size in a single long frame; clears no faster than 0.5 s). The frame carries the most blinded the player was over its ticks, so a flash inside a hitch still lands. "Reduce flashes" (localStorage `mf.reduceFlashes`, default from prefers-reduced-motion) swaps it for a dark-out as opaque as the white (≥ 0.96 everywhere at full strength) with a 10 px blur: the setting is no advantage. The 2D burst is a 1 m pop and a ring (grey with the setting on); 3D draws a small star, a glow and a ring (clouds.ts). `onMuffle(listener)` gets 0…1 for the audio system. The UI agent owns the settings toggle: see the shared note arsenal-fx.md.

| Flashbang at eye height (feel report) | White + fade | Target (white) |
|---|---|---|
| 3 m, looking at it | 2.50 + 1.50 s | 2–2.5 s |
| 3 m, looking away | 0.63 + 0.38 s | 0.3–0.9 s |
| 3 m, looking at it, behind a wall | 0.37 + 0.30 s | ≤ 0.5 s |
| 10 m, looking at it | 1.25 + 0.75 s | 0.9–1.6 s |
| 17 m | nothing | nothing |

### 22.3 Proximity mine and EMP

- **Mine** (`packages/sim/src/mines.ts`): a grenade whose `state` walks Flying → Arming → Armed → Triggered, with `fuse` as the ticks left in that state. It flies straight (no gravity) for 0.9 s, then drops, and sticks to the first surface it touches (walls and ceilings too). The map's pads, wind, drag and zone gravity act on it in flight like on any grenade. A thrower keeps 3 out at most (`MineDef.maxLive`): a 4th retires its oldest (`GrenadeState.born`); when every grenade slot is taken, a throw retires the oldest mine of all instead of failing. A player who leaves takes its mines with it (its grenades in flight and its clouds become nobody's). Armed, it beeps for 0.25 s when an enemy's body is within 1.6 m in line of sight; the thrower never sets off their own. Bullets stop at it (hit radius 0.25 m) and empty its 10 HP (whoever empties it gets the kill); blasts set it off 4 ticks later (a chain staggers by 3–4 ticks per mine: grenade slots step in order); a direct hit on a player in flight detonates it. 120 dmg in 3.2 m. Gone 180 s after arming. `DamageSource.Mine = 58`.
- **EMP:** jetpacks dead for 3 s within 4 m of the burst (to the torso, through walls), the thrower's too; a jet in use cuts out at once. Mines in it vanish. No damage. 3D draws a blue ring out to the 4 m (clouds.ts). The state is `PlayerState.jetDisabledTicks`, hashed and in the local block (prediction counts it down exactly). It works alongside the map's EMP fields and storms (`env.jetDisabled`): the jet needs both clear, and so does the dash (`dashBlocked()`), since a dash is a jetpack burst.

| Feel (`feel` report) | Measured | Target |
|---|---|---|
| Mine thrown level: sticks at / after | 13.7 m / 1.20 s | 9–14 m: short range |
| Mine, an enemy 1 m away: blast after / damage | 0.27 s / 100 (dead) | 0.2–0.35 s beep, ≥ 100 dmg |
| EMP beside a player hovering 3 m up | jet off 3.00 s, drops 3.1 m | 3 s, falls out of the sky |

### 22.4 Recoil push ("the rebounds physics after shots")

- Before: only the Breacher (3.5 m/s) and the Widow (2.0 m/s) pushed, and only in the air: a downward Breacher shot gave ~0.3 m of lift, so nobody noticed it.
- Now (combat.ts `recoilPush`): in the air the whole push along −aim; on the ground a horizontal slide for heavy guns (`recoilPushGround`), halved while crouched. Caps: recoil never takes |vx| past 0.9 × launchSpeedX (10.8 m/s), so it never gets the blast-launch drag (§17); a shot fired down never takes the rise past 10 m/s, so chained shells hover instead of rocketing. Speeds already past a cap (a blast launch) are kept.
- Values: Breacher 10 air / 6 ground, Widow 2 / 8.5, K-47 0.3 / 0, everything else 0 (docs/03 §7 has the table, with starting values for the launchers and heavies still to come).
- **Like any push:** the map's knockback multiplier scales it where you stand (docs/02 §20), and it ends a dash (docs/02 §21: the push wins).
- **Goldens:** `arsenal-guns`, `arsenal-melee-sniper` and `mech-bullets` change on purpose (their Breacher and Widow shots now kick). The sniper scenario's last walk goes right instead of left: the shots' kicks leave the player against the thin wall, so walking left could no longer reach the weight-capped speed it checks. The fog-gallery shooter in `mech-bullets` walks back to its spot between Widow shots (the same hits through the fog as before). Every other golden is bit-identical. New: `recoil`.

| Feel (`feel` report) | Measured | Target |
|---|---|---|
| Breacher fired down at the top of a hop: lift | 2.22 m | 2–3 m |
| Breacher fired level at the top of a hop: knocked back | 2.79 m | 2–5 m (a dash, not a launch) |
| Breacher fired level standing: slide | 0.28 m | 0.15–0.5 m |
| Widow fired level standing: slide | 0.59 m | 0.5–1 m |
| Widow fired level crouched: slide | 0.13 m | 0.05–0.4 m |
| Widow fired level at the top of a hop: knocked back | 0.65 m | 0.5–2 m |
| K-47 sprayed level for 1 s in the air: drift | 1.60 m | 0.5–2.5 m |
| Buzz sprayed for 1 s in the air | 0 | 0 |
| Fastest recoil alone carries you sideways | 10.80 m/s | < launchSpeedX (12) |

### 22.5 Smoke hides what's in it and behind it (owner's answer, 17 Oct; review, 18 Oct)

- The owner: "hide players behind smoke too". `SmokeSight` (packages/sim/src/clouds.ts) answers "does smoke hide T from V": all of T in a core V's eyes are outside of, or every sight line from V's eyes to T's head top, chest and feet runs through ≥ 1 m of a core (`SMOKE_BLOCK_CHORD`), or through ≥ 1.5 m of a core both are in (`SMOKE_NEAR_SIGHT`: in a cloud you see who's next to you, not across it). A core a wall cuts through only counts where the sight line is on its centre's side of the wall. Built once per snapshot: with 0–3 clouds it's a few circle–segment tests per pair.
- **One-way at the rim:** eyes within about a metre of a core's edge see out, while a body that is all inside the core is hidden from everyone outside it. Accepted: stepping to the edge to look out is the counterplay smoke is for.
- Used by the AOI (the snapshot encoder) and by local mode (players, tracers and grenades), so offline matches online. The scripted dummies still use the simpler `smokeBlocks` for their aim.
- **What follows from "can this client see that player"** (W6's rules for culled players, review-pr18.md): its gunfire is a SOUND; others' hits on it aren't sent; a HIT where either side is hidden from the client goes in whole HP (the victim of a hidden shooter, a shooter firing into smoke); a grenade it throws comes without its name; a ricochet off its shield isn't sent; an item it takes comes without its name.
- **Tracers** (and ricochet legs) stop where they first enter a core the client is outside of, however little of it they cross, or in the client's own cloud where they get past its near sight; they read as a miss with no target whatever they hit in there. A shot into a hidden player that never touches the smoke (behind it, fired from the far side) goes on past the body to the first wall in the weapon's range (`SmokeSight.carryOn`): a tracer stopping in the open would mark the body.
- **Grenades** in smoke the client can't see into (in a core it's outside of, behind smoke, across its own cloud) aren't sent; its own always are (`SmokeSight.pointHidden`). Residue, as W6 accepted for throwers off the view: once a grenade comes out of the smoke, its exact arc and fuse still work back to where it was thrown.

### 22.6 Protocol v10 and the review (18 Oct)

- Rebased onto the riot shield (v9) as one PR. **v10:** local block 48–57, two groups after the shield group (the belt: u3 selected · u3 × 5 counts; status: u8 blindTicks · u7 blindFade · u6 gasTicks · u8 jetDisabledTicks; 12 delta groups now); grenade records + u3 type · u2 state; a clouds section after the pickups section; EXPLOSION + u3 grenade type. No new tags, ext kinds, remote flags or INPUT bits. The full local block is ~67 bytes; deltas carry what changed.
- **With the shield:** `dashBlocked()` checks the EMP lockout next to the raise rule; a bullet or a ricochet leg that meets a mine stops at it and hurts it (with the falloff over the range used); the ledge-shove and fog-ricochet shield tests account for the Breacher's and the Widow's kick.
- **Goldens:** `shield` is re-recorded twice over: first for the recoil (with the old recoil numbers put back, all 15 of main's goldens are bit-identical), then for the range's grenade spawner (hashed from tick 0; the scenario's inputs and events are unchanged). `grenades-variety` is re-recorded because mines hash the tick they were thrown (`born`); with that left out every golden is unchanged.
- Review items, as fixed: H1 (the Armory reads `explosion` only on blast grenades), H2 and M1–M3 (§22.5), M4–M5 (§22.3), M6 and the flashbang lows (§22.2), M7 (3D pop and EMP ring), M8 (the jet line, `dashBlocked`, `grenadeForces` for mines, `mech.bulletCost` for mine damage, v10), clouds through thin walls (§22.1), one-way smoke (§22.5), mouse 5's release no longer navigates, the feel report's mine row.

## 23. Bots that fill rooms (18 Oct 2026, owner request)

> Owner request (paraphrased): bots, so two-player playtests feel like real matches. Spec: docs/08 §9, built in `packages/bots`.

- **Inside the sim:** a bot is a player with `isBot` and a `brain` (`Brain` in packages/sim/src/bots.ts). `Game.step` calls brains first, while last tick's events are still there, so a bot reacts to the last tick as a human reacts to the last frame. Decisions run at 10 Hz, staggered by id. Movement, aim and trigger run every tick and produce an ordinary Input. Each bot draws from its own seeded `Xoshiro128`, never the sim's spread hashes. A Match freezes bots before GO like humans; bots respawn at spawn points. Dummies are unchanged, and **no golden on main changed**.
- **Replays:** `ReplayFile.bots` lists them; `runReplay(replay, onTick, botReplaySetup(replay))` puts them back after the humans. Their inputs aren't recorded: they come back from the seed. A replay with bots refuses to run without the setup.
- **Navigation:** a graph per map and tuning (88–260 ms to build, cached), described in docs/08 §9. Every link is flown first through the real `stepMovement`, so jets, drops, drop-throughs, pads, wind and low gravity all count. At runtime, bots skip jet links while the jetpack is down (an EMP field or storm, or an EMP grenade's `jetDisabledTicks`), treat zones an event turned into reversed gravity as blocked, fly out of a gravity pocket sideways (but not off an air link that crosses one: its check flew it, and mechanics-test's permanent pocket used to turn bots back mid-flight), and plan from the air when knocked off the graph (heading for a node within 8 m, else 20 m: the middle of Lunar's zero-g dome has none nearer). Before a jet link they refill on the ground to what its check burned plus a margin, but never to more than a full tank (a Hard bot used to wait for 108 of 100 fuel, and a replan restarted its 4 s wait cap). A replan that carries on along the link it was on keeps that link's stall clock, so a body pushing against something gives the link up even when it replans every second; a Match countdown holds the clock instead of failing the link.
- **Combat:** a bot sees what a client is sent (the server's snapshot rules, §22.5 and docs/05 §9): the view rect (a side view, so a wall between two players hides neither), minus whoever smoke hides from it (the sim's `SmokeSight`, which the server's AOI uses), and nobody at all in a flashbang's full white. Its target is re-checked every tick, so it can't track someone into smoke between looks. Gunfire from someone it can't see is a SOUND: on the client's 4 m grid, within 35 m, with no name, so a shooter hidden in smoke isn't given away by its tracers. A hit names who hurt it but places them only by that shot's SOUND. It only fires with a line of fire, and only at a body its bullets reach: the weapon's range, or what a map's fog and range multiplier leave of it (the bullet's range used up getting there, `castBullet` then `bulletCost`, as combat.ts charges a shot). The gun it picks, the range it fights from and the spots it picks all go by that reach; with no spot nearby it can hit from, it closes in around the obstacle. With both guns dry (no rounds in the magazine or reserve), it closes in to bash and never holds Fire at range. Aim is in metres at the target (a fixed-scale side view): a slow drift plus a tremor, a reaction time, a tracking lag and lead. Far off, the error and the fire window grow with the view a human zooms out to (mouse wheel, the loadout's zoom levels) to keep the target on screen: ×1 to about 22 m, ×1.4 at 30 m, ×1.8 at 40 m. The gunner picks the gun for the range, gives semi-autos a fresh press per shot, fires automatics in bursts, reloads between fights and bashes in reach. Grenades are solved with the sim's own grenade physics and never land in the bot's own blast. Below the retreat HP it falls back out of sight to regenerate (a cover it finds no way to, gas between say, is left out for 6 s); Normal and Hard bots dash away from hits, never into gas.
- **Fights that go nowhere:** a spot it couldn't get to, or got to and still couldn't hit its target from, is left out of its picks for 6 s. Three of those in a row against one target and it gives that target up for 8 s, unless it can hit it from where it stands; it then hunts or roams. It replans a fight when its way failed, as hunting and grabbing already did.
- **Shield (v9):** bots remember items they've seen (a client gets an item's kind and place, not a dropped shield's HP) and go for a shield when they have none or theirs is down to half (150 HP). One they stood on and couldn't take (theirs was better), or couldn't get within reach of, is left be. They raise it for a fight (with a one-handed gun) and sling it on the back otherwise, where it guards their back, weighs nothing and doesn't block the dash.
- **Arsenal B (v10):**
  - **Smoke** hides players from bots as above.
  - **Flashbang:** while fully white, a bot loses every contact and starts nothing new ('blind'). As the white fades its aim error grows by up to 5× (`Aim.impair`), and it re-acquires with its reaction time.
  - **Gas** it has seen (clouds are sent by the view rect and their radius, in a flashbang's full white too) is judged as the sim's pulses land: the torso's nearest point to the centre, less the torso's radius, with walls stopping it. The old test from the body's middle said "out" up to 0.3 m inside the pulses. A growing cloud counts at full size.
    - **Paths:** a link into or through gas costs 4–12 s on the way out of the cloud the bot is in. Anywhere else it's closed while the cloud lasts, so paths go around (over the top on a platform, say) and a bot that got out doesn't plan back through it. When gas closes every way on, a roaming bot waits (`'wait'`), pacing its side.
    - **Getting out:** to the node 1.2 m clear of every cloud (by distance: a wall's edge doesn't keep the pulses off a step away) that's cheapest by path, out to 90 s of path (`PathFinder.nearest`, Dijkstra). First with the fuel in the tank, so a drop off a balcony beats a climb to the roof; else by a jet, waiting on the ground for just the fuel it burns. It fights back on the way and doesn't hang about at the rim. An exit it reaches and is still in is left out for 6 s. With no way out at all, it walks straight away from the centre.
    - **What it was (environments review, M3):** the nearest node within ±12 m × ±6 m by straight-line distance. From the Street Market's 8 m balconies the street was outside that box, so every exit was a jet. Getting out of gas skipped the fuel wait, so a bot with 0–10 fuel hopped in the cloud on the trickle (each hop restarts the refill delay) until it died.
  - **EMP:** it closes the jet links, and no hops or dash dodges are tried while the jetpack is dead (`dashBlocked`).
  - **Mines** it has seen (someone else's, stuck, in view and out of smoke, as the server sends grenades) add 10 s to any link into or through their trigger radius plus 0.7 m, with mines.ts's line-of-sight rule. It forgets one when it sees the spot empty.
  - **Grenades:** bots throw frags only for now. The belt goes back to frags (the cycle key) when a pair pickup left it on another type, and the other types are never thrown.
- **Bug the nav graph found:** two Storm Front pockets (spawns 0, 4, 5) were traps. A full tank climbs 13 m and the walls were 16 m and 21 m. Five one-way ledges fix it: one in the left pocket, two in the right, two beside the roof. Every spawn on every map now reaches every other.

| Feel vs a standing target (pinned bot, 30 duels; review fixes) | Easy | Normal | Hard | Human (perfect torso aim) |
|---|---|---|---|---|
| Buzz @ 12 m: hits, TTK | 25%, 2.7× | **43%, 1.9×** | 56%, 1.25× | 59%, 2.50 s |
| K-47 @ 12 m: hits, TTK | 26%, 2.8× | **43%, 2.1×** | 55%, 1.35× | 54%, 1.72 s |
| Hammer @ 12 m: hits, TTK | 51%, 2.3× | 61%, 1.8× | 89%, 1.15× | 100%, 1.82 s |
| Widow @ 30 m: hits, TTK | 38%, 6.1× | 47%, 4.8× | 80%, 1.8× | 100%, 0.82 s |
| Reaction / aim drift + tremor (1σ) | 0.6 s / 1.3 + 1.8 m | 0.4 s / 0.8 + 1.0 m | 0.25 s / 0.35 + 0.4 m | |

Targets: Normal at 12 m lands 35–45% and takes about 2× a human to kill (`test/feel.test.ts` pins both). At 12 m nothing in the review fixes changes the aim: Easy's 25% (from 29%) is noise in 30 duels (150 duels: 26.3% before, 25.0% after). Hard with the Widow landed 96–98% at 25–40 m before the zoom-scaled aim and now 89% at 25 m, 80% at 30 m, 61% at 40 m (`feel.test.ts` keeps it between 60 and 90% at 30 m). The combined aim error at 12 m is about 10° (Easy), 6° (Normal) and 2.5° (Hard), within docs/08's 2–9° cone apart from Easy at the wide end. `pnpm --filter @military-forge/bots feel` prints the table.

| No-stuck soak, 5 min, 6 Normal bots, pickups on (`pnpm --filter @military-forge/bots soak 5 6`; review fixes) | stuck | kills | moved | shots beyond reach | sim + bots |
|---|---|---|---|---|---|
| movement-test | 0.00% | 92 | 234 m/bot/min | 1 of 2,103 | 0.019 ms/tick |
| mechanics-test | 0.00% | 113 | 206 | 4 of 1,731 | 0.015 |
| lunar-outpost | 0.00% | 102 | 229 | 3 of 1,790 | 0.013 |
| storm-front | 0.03% | 70 | 235 | 1 of 1,845 | 0.015 |
| flux-lab | 0.00% | 108 | 239 | 1 of 1,906 | 0.013 |

"Stuck" now counts a fight it can't hit its target from (no line of fire, or out of reach) as trying to get somewhere. No bot ran dry. The few shots past reach are targets moving out of it as the bullet left. Storm Front went from 43 kills to 70: before, most of its fights were across the sea fog.

| Local play's setup: an idle human + 3 bots, 10 min × 6 seeds per map and tier (the review measured this) | Before (review of #70) | Now |
|---|---|---|
| Bot shots at a target its bullets couldn't reach | 8–64% by map | 0.06–0.36% |
| Dry share of alive bot-time, Storm Front | Normal 14.6%, Hard 13.1% (Hard 55% on seed 1234) | 0% (at most 1.8% on any map and seed) |
| Fire held while dry | over 4,000 ticks a minute | 0 |
| Longest stall in a fight without a shot | up to 354 s on Flux Lab (Hard: 151 s) | 2.0–3.5 s on every map |
| Stuck (the soak's rule, with fight stand-offs counted) | not counted | at most 0.37% of a run |

"Stuck" means trying to get somewhere (a plan, roaming, hunting, or a fight it can't hit its target from) and moving under 0.5 m in 3 s; holding a firing spot or cover doesn't count. `test/soak.test.ts` runs two bots of each level per map, and local play's setup (an idle human and three Normal or Hard bots) on every map. Each requires under 1% stuck, nobody stuck over 5 s, kills, under 1% of shots past reach, no Fire held dry and under 5% dry time. A second soak sets arsenal B off around them for 3 minutes (a smoke or gas cloud by a bot every 3 s, a flashbang every 5 s, an EMP lockout every 7 s), 6 runs a map (seeds 31–36, pops 77–82), each held to the same rules. One run's gas deaths move with any change to the bots, since their choices and aim draw from one stream: a fixed "at most 5" flaked at 6–8 on several maps. So it counts deaths per gas cloud: under 0.12 on each map and under 0.07 over every map together. Bootstrapped from 30 runs a map, the code as it is fails those about 6 times in 10,000; main's before the gas fixes failed them about 2 times in 3. It found the fuel wait above and a bot going back and forth at a gas cloud's rim.

| Arsenal soak: gas deaths per gas cloud, 30 runs a map (888 gas clouds each) | Before the gas fixes | Now |
|---|---|---|
| movement-test | 0.075 | 0.045 |
| mechanics-test | 0.084 | 0.042 |
| lunar-outpost | 0.075 | 0.051 |
| storm-front | 0.077 | 0.028 |
| flux-lab | 0.059 | 0.048 |
| **All five** | **0.074** (329 deaths) | **0.043** (190) |
| Street Market (#71's map, measured with its files dropped in) | 0.100 | 0.052 |

Of the 190, 143 were under 40 HP when the cloud popped and 14 were whited out by a flashbang (before: 192 and 61 of 329). The longest stuck stretch in all 150 runs was 3.5 s, at most 0.38% of a run.

- **Tests (95, plus `localBots()` in apps/web):** per behaviour (perception, aim, gunner, grenades, the tree's modes, no shots into walls, shield grab and carry, retreat, dodge, the countdown freeze, spawns, gravity pockets; for v10: smoke in and behind, a shooter in smoke heard but not seen, the full white and its fade, gas seen and remembered, never a shot at someone smoke hides, walking out of gas mid-fight, going around it, EMP, frags only; for the review: no shot across fog it can't reach, a dry bot in for the bash, a stand-off given up, no gun picked when none reaches, mines seen and gone around, a removed player forgotten, a worse shield on the floor left be, a countdown that fails no link, the zoom-scaled aim; for the gas fixes: off a balcony with an empty tank by the cheapest way, a jet-only pit on a low tank, waiting out gas that closes every way on, gas judged where the sim's pulses land, a reversed-gravity crossing kept to its link), nav (every spawn pair on every map, deterministic builds, a body crossing each map), the soaks, feel, and three bot goldens: a bot-vs-bot match on movement-test, one on Flux Lab, and a human plus three bots through a Match with pickups (a bot takes a shield and raises it, then a flashbang pair it never throws). The golden test now checks that every bot moved and fired.
- **Goldens, v10:** the three bot goldens are re-recorded; every golden on main is unchanged. With the bot code as it was (only the grenade solver moved to v10's typed grenades) they diverge first where v10's sim changed: `bots-match` at tick 0 (the range's new grenade spawner, hashed from tick 0, as main's `shield` golden), `bots-movement-test` at tick 143 (a bot's Widow shot now kicks, §22.4), `bots-flux-lab` at tick 418 (a K-47 shot in the air kicks). The v10 rules then move Flux Lab's to tick 235 (a bot whose target leaves its sight now looks where it was last seen).
- **Goldens, review fixes:** re-recorded again, with no sim change, so every golden on main is unchanged. The first differences come from the zoom-scaled aim: a bot tracking someone over 22 m away from its first look, from tick 3 on movement-test, 126 on Flux Lab and 183 in the match. Without it, the fight rules alone make them differ from ticks 58, 144 and 202.
- **Goldens, gas fixes:** none changed (no gas comes up in them).
- **Local play:** `?bots=3&botlevel=normal`. The local match plays three Normal bots by default; `?sandbox` keeps the dummies; `?bots=0` gives the dummies back. Recordings carry the bots.
- **Online rooms (part 2, on #37's rooms by code):**
  - `RoomOptions.fillBots: { target, level }` keeps a room with a human in it at `target` players. Humans count while they wait to reconnect, so a dropped connection brings no bot in.
  - A human coming in takes the place of the lowest-scoring bot (the newest on a tie): the joiner starts from nothing, and the bot keeps its line in the standings as a leaver. A human leaving for good brings a bot in, and the last human out takes them all.
  - Bots join and leave before the tick's step, as a replay puts them back. They're players like any other (roster, snapshots, standings, MATCH_STATE, the `[BOT]` tag), and a human's name can't start with the tag.
  - The host can start a match with only bots for company: they count towards `minPlayers` and never need to ready up.
  - Config: `--bots=<n>` / `BOTS` and `--bot-level=` / `BOT_LEVEL` on the game server (bots take the dummies' place in the default room). `pnpm playtest` fills rooms to 4 Normal bots by default (`--bots`, `--bot-level`).
  - The lobby shows a BOT badge where a person has a ready dot, and its "ready" count is people only.
  - **Replays (review L3):** `ReplayFile.bots` records each bot's seed serial, join tick and leave tick (`botSpecs`). `botReplaySetup` adds and removes them at those ticks through a new per-tick replay hook, so a game whose bots came and went replays bit-identically (`test/rooms.test.ts`). Replays from before these fields: every bot from the start, in order.
  - **Nav graphs (L6):** the cache keeps 4 tunings per map (least recently used out), and `warmNavGraphs(maps)` builds them up front: the game server does it at startup when bots are on, so the first bot doesn't stall every room for 90–270 ms. Since §37, rooms never build one on a tick: builds run between ticks.
  - Checked end to end with `pnpm playtest --local`: a room opened with 3 `[BOT]` players in the lobby (BOT badges), the host started at once, bots fought the warm-up and the match and came for the idle human, with no console errors.
- **Next:** bots throwing smoke, flashbangs, gas, mines and EMP; the host choosing the number of bots and their level in the lobby (a MatchSettings field).


## 24. More guns, weapon crates, longer throws, a bigger tank (18 Oct 2026, owner's playtest)

> Owner, after a playtest with friends: "add more guns I can test and be killing my friends while you build", "the bombs should go far" and "the fuel finishes quick".

### 24.1 Eight more guns

Every gun with a W8 model that fires bullets now has stats (`packages/content/src/weapons.ts`, docs/03 §5 as built): **Hawk .50, Rattler, Hornet, Trident, Bullpup, Longbow, Shredder, Arc** (indices 6–13, after the first six). Their numbers are docs/03's, inside its TTK sheet, except where the feel report showed a gun leaving its role (docs/03 §5 lists each change and why: the Hawk's damage, four spreads, the Trident's and Shredder's tick-exact intervals, the Arc's cell).

- **Fire modes:** `burst` (Trident: 3 rounds 1/15 s apart, bursts 0.5 s apart start to start; a started burst finishes by itself), `spinup` (Shredder: 0.8 s up, 1 s down, Fire2 pre-spins, fires only at full spin) and `beam` (Arc: a 40-tick cell refilling 10 a second after 0.5 s off the trigger, never reloading, no falloff). `heldTrigger(def)` says which modes fire while the trigger is held. Spin and burst are per-slot sim state, hashed only when non-zero, so goldens without these guns don't move.
- **Ticks:** the sim's weapon cooldown counts whole ticks and drops the remainder, so an interval of 4.2 ticks fires every 5. The Trident's rounds and the Shredder are set to exactly 1/15 s (4 ticks); the Hornet's 0.06 s fires every 4 ticks (0.067 s). The feel report's TTKs are the real ones.
- **Recoil push:** pistols, SMGs and the Arc push nothing (the owner's rule); Trident and Bullpup 0.3 m/s per round in the air like the K-47; Longbow 1.5 / 3; Shredder 0.35 / 0.15 per round.

| Feel (`pnpm --filter @military-forge/sim feel`, a standing target, all aimed at the torso) | TTK | Hits |
|---|---|---|
| Hawk .50 @ 12 m | 3.02 s | 100% |
| Rattler @ 12 m | 1.80 s | 74% |
| Hornet @ 5 m / 18 m | 0.89 s / 3.87 s | 100% / 32% |
| Trident @ 12 m / 18 m | 1.03 s / 1.61 s | 96% / 67% |
| Bullpup @ 12 m | 1.58 s | 84% |
| Longbow @ 18 m | 1.15 s | 100% |
| Shredder @ 5 m / 12 m (with its 0.8 s spin-up) | 1.52 s / 1.92 s | 100% / 64% |
| Arc @ any range | 2.42 s | 100% |
| (for scale: K-47 @ 12 m, Buzz @ 12 m) | 1.69 s, 2.54 s | 55%, 58% |

**Launchers and the Dragon:** §25.

### 24.2 Weapon crates and `E`

- **Items:** one per gun, `weapon:<id>`, pickup index 7 + weapon index (kind `weapon`, reach 0.35 m). Pools: `weapons` (every gun; Breacher, Widow, Longbow, Shredder, Arc and Machete weight 1, the rest 3) and a one-item pool per gun (`weapon:<id>`), for fixed spawns and the armory.
- **Taking:** walking over a gun you hold puts the item's rounds (magazine and reserve) into your reserve, up to the gun's reserve, and spends the item; one with nothing to give (an empty dropped gun, or your reserve is full) stays. Any other gun waits for **`E`** (`Btn.Interact`, a press edge): into the slot in hand with the item's ammo, the swap time of its equip, dual-wielding ended, reloads cancelled. The gun you held drops at your feet with its ammo for 30 s (`PickupState.mag/reserve`, hashed only when non-zero), so a friend can pick it up again. **Cooldowns carry over (review H1):** the gun dropped keeps the rest of its interval (`PickupState.readyTick`), and the gun taken can't fire before the gun in hand could have, so fire, E, E (or a rack gun after a shot) never skips an interval: the Breacher stays at 10 pulls in 10 s, not 24. The HUD (the production HUD's pickup prompt, and the debug canvas HUD) says `[E] take Widow (swaps your Hammer .44)` on a gun you don't hold, and close by `Widow: stand on it, E to take` or `Widow: walk over for ammo`; the first-run tips card lists the key (Settings' `interact` binding, E by default); on touch screens an `E` button sits above the grenade cycle button, left of the aim stick.
- **On the maps:** a `weapons` spawner on every map, 3–5 spots on floors and platforms, 2 out at once (3 on Street Market), the first in 3–6 s, the next 12–18 s after one is taken. Its spawner comes **after** each map's existing ones: spawner draws hash the spawner's index, so the shield and grenade spawners' draws don't change. Street Market's spawners and armory are an overlay in `streetMarket.ts` (its JSON is the art pipeline's compiled output). A test checks every spawner spot on every map stands on a floor and isn't in a wall.
- **Views:** 2D draws a crate (gold for power weapons, steel blue otherwise) with the gun's name; 3D (`render3d/weaponItems.ts`) stands the gun's own model upright, its side to the camera (like a rack: the armory's are 0.8 m apart, too close for long guns lying flat), bobbing and turning a little over a disc in the same colour; a rack's 2D names take two rows. Screenshots: `docs/screenshots/more-guns/` (`node apps/web/scripts/weapon-crate-shots.mjs` against a dev server).

### 24.3 The test armory

`GameOptions.armory` (with pickups on): a rack of one of every gun, 0.8 m apart, from the map's `armory: { x, y, dir? }` (by the first spawn without one), each spot back 2 s after it's taken; a gun swapped out at the rack isn't dropped, so it doesn't litter. Its spawners come after the map's. On the game server it's `--armory` or `ARMORY=1` (default room and every room), logged at startup; **`pnpm playtest` turns it on** (`--no-armory` turns it off). Local mode has it on unless `?armory=0`; replays record it.

### 24.4 Longer throws, a bigger tank

- **Grenades** (docs/02 §14): throw speed ×1.15, fuse ×1.12 (the mine's straight flight too), so landing and detonation points are ~30% farther at both strengths; tap is still 70%. Full strength at 45°: frag first bounce 11.1 → 14.3 m, goes off 14.8 → 19.2 m; smoke, gas, flashbang and EMP bounce 9.7 → 12.5 m; a mine thrown level sticks at 17.7 m. The throw preview now runs 2 s ahead (past every fuse), so its arc ends where the grenade goes off. Feel targets: `THROW_TARGETS`, `MINE_TARGETS.sticksAt`.
- **Fuel** (docs/02 §8): `fuelMax` 100 → **140** at the same burn (44/s) and air regen (12/s), so feathering and hovering keep their rhythm and a tank simply lasts 40% longer: burn 2.25 → 3.15 s, full-tank climb 13 → 18.1 m, best hover over 3 m 5.4 s. Ground regen 35 → 49/s, so a refill from empty still takes ~3.1 s. Zone and event targets moved with it (low-g climb 23 m, long-flight burn 7.9 s, a gravity surge's climb 12.8 m). The tallest tower is 12 m, so the tank clears it easily; the 20 m view still shows a full climb. The owner's in-game tuning panel can move both from here.
- **Bots:** with farther throws the bots' gas tests still pass on main's #87 gas handling (an earlier margin tweak on this branch was dropped in the rebase).

### 24.5 Protocol v11 and goldens

- **Wire** (docs/05 §6.2, claimed in the protocol registry): local block 58–61 `spin0 u8 · burst0 u2 · spin1 u8 · burst1 u2` (13 delta groups); pickups `u6 id · u6 def` (were u5 · u4; up to 48 items, defs 0–63, 21 used); PICKUP's item u6. `E` is the existing `Btn.Interact`. The armory is a server option, nothing on the wire.
- **Goldens:** every sim golden (17) and bot golden (3) is re-recorded, all from tick 0: a player spawns with a full tank, and the tank is hashed. **Proof:** main's replays and goldens run through this branch with the old fuel (100, ground regen 35), the old throw speeds and fuses, and every map's weapon crates taken off are bit-identical, all 20. Only `mech-events`' replay file changed (a closed-loop scenario re-generated with the bigger tank).

## 25. Launchers and the flamethrower (18 Oct 2026, the rest of the modelled arsenal)

> Coordinator, after #99: "start the second PR now (launchers: Thumper, Popper, Ripper, Pulse; plus the Dragon), with sim projectiles … deterministic and lag-compensated the same way as grenades".

### 25.1 Projectiles

- **One system, the grenade pool.** Rockets, launcher shells, saw blades, EMP orbs and flames are `GrenadeState`s of type `PROJECTILE_TYPE_BASE (8) + index` (content `projectiles.ts`). `stepGrenade` hands them to `stepProjectile` (sim `projectiles.ts`). So they reach clients in the grenade records with no new snapshot section, are culled by view and smoke like grenades, and run "the same way as grenades": launched on the server's tick when the trigger is pulled, never rewound, hitting what is there on the tick they get there. The client predicts the shooter's ammo, charge and cooldowns, not the projectile: the predictor drops the ones its shots launch (the `launch` event), as it does throws.
- **A step:** forces (gravity × gravityScale, the map's pads, wind and drag), then the move as a swept circle against walls (`sweepCircle`) and players' bodies (one capsule from the shins to the head's centre) in up to three legs. What it touches decides: `walls` explode / bounce / pass, `players` explode / pierce / consume, `expire` explode / vanish. Blasts use `explode()` (credited to the weapon, so the kill feed names the Thumper, not "grenade") or `emp()`.
- **The five:**

  | Projectile | Fired by | Speed | Life | Walls | Players | End |
  |---|---|---|---|---|---|---|
  | rocket | Thumper | 20 m/s, straight | 3 s (60 m) | blows up | 100 direct, then 80 in 3.5 m | blows up |
  | shell | Popper | 17 m/s, lobbed | 1.2 s | bounces (e 0.3) | blows up (70 in 3 m, a knock not a launch) | blows up |
  | saw blade | Ripper (0.4 s charge) | 18 m/s, straight | 5 s | bounces (e 1, no friction) | 100 to each, once between bounces; its owner once it has bounced | blows up (60 in 2.5 m) |
  | EMP orb | Pulse (0.7 s charge) | 8 m/s | 3 s | through | EMP burst 2.5 m (jetpacks 3 s, mines disarmed) | EMP burst |
  | flame | Dragon | 7 m/s, rises (−0.2 g) | 0.8 s | glances off (e 0.3); then it can burn its owner for half | 20 and 2 s burning (4/s), spent | gone |

- **Charge** (`fireMode: 'charge'`): a press starts it, holding fills it (`WeaponSlot.spin` counts the ticks), let go early and it's lost; full, it fires and waits for the next press. Bots press and hold, then let go.
- **The Dragon's tank** is a regenerating magazine like the Arc's: 40 flames (6 s), 8 a second after 0.5 s off the trigger. **Flames put out toxic gas** they touch (not smoke).
- **Bots** never fire a rocket or shell at a body inside its own blast, lob shells only within 10 m (they aim straight), and value straight projectiles less with range (they have to lead). The Pulse is worth nothing to them (no damage).
- **Riot shields** (the follow-up PR after #107's review): a rocket, shell or blade coming at a shield's face (raised in front, slung behind, within the block arc as for bullets: `shieldFace` in shield.ts) goes off there; the shield takes its hit (rocket 100, shell 70, blade 100: three rockets break one) and the blast counts the carrier as covered (`explode(…, shielded)`: no damage, the covered push). A flame is spent on it, and a raised shield shelters the head from flames too (they'd curl over its top). An EMP orb passes it. A shell lobbed under it, at the feet, still gets through.
- **Shredder pre-spin (#107 review Low):** the hold clock starts only when a spin-up starts from rest (a press of the second button, or firing) and only a shot restarts it: pressing the second button again no longer keeps it spun, and once it winds down while held it stays down until pressed again.
- **Charging slows you** like a spinning minigun (`SPINNING_SPEED_MUL` ×0.85 on the weapon's weight, while `spin` > 0), so a charged shot has a cost as well as a tell.
- **Known gaps (follow-ups):** the orb's burst uses the EMP grenade's ring on clients; the wind-up sound waits for the audio system.

| Feel (sim `pnpm feel`, a standing target) | TTK | Hits |
|---|---|---|
| Thumper @ 5 / 12 / 18 m | 0.18 / 0.53 / 0.83 s | 100% |
| Popper @ 5 m | 1.29 s | 38% (a shell knocks: the next may miss) |
| Ripper @ 5 / 12 / 18 m | 0.60 / 0.98 / 1.32 s | 100% |
| Dragon @ 5 m (12 m: never) | 1.12 s | flames and burn |
| Pulse at a player 10 m away | burst after 1.77 s, jetpack dead 2.98 s, 0 damage | |

### 25.2 The #99 review's mediums, in this PR

- **M1, the Shredder's pre-spin:** spun up on the second button alone it winds down after `PRE_SPIN_HOLD` (2 s) without a shot (a fresh press starts the clock again, using `ticksSinceShot`, which the local block carries), and while it spins it weighs more (`SPINNING_SPEED_MUL` 0.85 on its 0.7). The tell: remote flag 2048 "winding up" (a minigun spinning, a Ripper or Pulse charging), drawn in 2D as a pulsing ring at the muzzle. There's no audio yet: whoever adds it plays the spin's whine (and the charge's hum) on `PlayerView.windup`.
- **M2, items in smoke:** the snapshot encoder holds an item a client can't see (smoke it's outside of, behind smoke, or its full white) as that client last had it, present or not, until the spot can be seen; a full snapshot leaves it out, and the PICKUP event isn't sent either. A hidden player's swap no longer shows where he stands.
- **#107 review:** a blast at a spot smoke hides from a client (a rocket on a hidden body) reaches it only as a SOUND, like tracers into smoke; and a projectile hits a body only with nothing solid between them (walls and slabs count, fences and plain one-ways don't): a flame's 0.6 m circle used to reach the player standing on a slab from below.

### 25.3 Protocol v12 and goldens

- **Wire** (claimed in the registry first; docs/05 §6.2): grenade records `type` u4 and `fuse` u9; EXPLOSION's grenade type u4; local block 62 `burnTicks` u7; remote flags 12 bits (1024 burning, 2048 winding up).
- **Online:** `apps/game-server/test/launchers.netcode.test.ts`: a rocket and a charged blade through the real Room and clients with no corrections (ammo and charge predicted to the round), the rocket in the other client's snapshots; a burn counted down on the victim's client from its local block.
- **Goldens:** every sim golden is unchanged. New: `launchers-rockets` (rockets down the range, a rocket jump, lobbed shells), `launchers-blade-flame` (flames up close, then a blade that comes back off the wall for its owner), `launchers-pulse`. `bots-match` is re-recorded: it first differs at tick 355, the first weapon crate's draw, since the crates' pool holds the launchers now. **Proof:** main's replays through this branch with the five new guns taken back out of the pool are bit-identical, all 17 sim and 3 bot goldens.
- **Views:** 2D draws each projectile (a rocket along its flight, a shell, a spinning blade, a glowing orb, flames that grow and fade), burning players' glow and the wind-up ring. In 3D, `render3d/clouds.ts` shapes its grenade balls into placeholders until render3d-b draws the Forge's (`projectiles.glb`, `specials.vfx.json` styles): see the shared note `arsenal-projectiles-render.md`.

## 26. The admin page (18 Oct 2026, owner request)

> Owner: "give me an admin UI where I can tweak the gameplay stuff, to increase or decrease things".

- **Where:** `/admin` on `pnpm playtest`. Each run makes a random token and prints `…/admin#t=<token>` in the owner's terminal only (not in `.playtest-link`). The page keeps the token in its #fragment (never sent to a server), moves it to the tab's session storage and off the address bar, and sends it as `Authorization: Bearer` on every call. The proxy serves `admin.html` at `/admin` and forwards `/admin/api/*` (the token header, the body's type and length, nothing else; no query) to the game server's admin port on 127.0.0.1 (`ADMIN_TOKEN`, `ADMIN_PORT`; `--no-admin`). Without the token: 401, nothing changes.
- **What:** content `admin.ts` lists every field with its range, step and default: all of `TUNING_GROUPS` (movement, jetpack, fuel, dash, blast launch and knockback, grenade throws, health), per gun (damage, seconds between shots, spread, range and falloff, magazine, reserve, reload, equip, recoil push air and ground, move-speed weight, charge, spin-up and down; launchers: projectile speed and life, blast damage and radius, the orb's EMP, the flame's burn), per grenade type (throw speed, fuse, blast radius, damage and push, cloud radius, length, grow and fade, gas damage, flash reach and times, mine arming and trigger, EMP radius and time), pickups (crate weights for everyday and power guns, crate respawn, the armory's respawn), bots (count, level) and the match (time and kill limits). Every range stays inside what the protocol carries (a magazine u8, a fuse u9 ticks, a flashbang's white within the blind ticks, a cloud within its age field, and so on; content `admin.test.ts` checks them).
- **Values** are a flat `{ key: number }` of what differs from the defaults: clamped and rounded by `clampAdmin` (unknown keys and non-numbers dropped), so they're easy to save, copy and diff.
- **Live, deterministic:** the game server holds one set for the whole process (`apps/game-server/src/admin.ts`). Setting it changes the content numbers in place (weapons, grenades, projectiles, pools, crate and armory respawns: every room at once), and each room sets its tuning to the defaults plus the admin's tuning keys (a host's own Tune edits give way), refreshes its crates' weights, takes the admin's bots and match limits where set (else its own) and sends TUNING and OVERRIDES (v13) to its clients. A room opened later starts with them; WELCOME carries them to late joiners and reconnects. Clients apply the content numbers to their own copy (netcode `NetClient.applyOverrides`), so prediction runs on the same numbers; leaving the server puts the shipped ones back. Netsim: a K-47 and tuning change mid-game corrects at most once around the change and never after (game-server `admin.test.ts`).
- **Keeping them:** "Save as defaults" writes `~/.military-forge/admin-defaults.json` (`ADMIN_DEFAULTS`), which the next playtest's game server loads at start. "Copy JSON" copies the values to bake into code. Presets: Classic (the shipped game), Floaty (low gravity, a big tank, slow falls, long fuses) and Chaos (big blasts, fast guns, short respawns, power weapons everywhere).
- **The look:** the kit's tokens and fonts (`ui/kit.css`, `ui/fonts.css`) with plain markup (`apps/web/admin.html`, `src/admin/`): a sticky bar (search, presets, Copy JSON, Save as defaults, Reset all), groups as sections of rows (label with its default, a slider, a number box, a reset), two columns on a laptop, one on a phone. Changes are sent as they're made (debounced, one call per slider drag). Players see a small *Tuned by admin* tag in the HUD (desktop and phone) while anything is changed.
- **Review fixes (#119):** the page and the HUD tag use the round-two kit tokens (#115 renamed them); every maximum is checked against its wire field (`admin.test.ts`: a melee swing's ticks travel as meleeTicks u6, so a swing is at most 1 s; the tuning fields' local-block fields too); a body over 64 KB is answered 413 (it used to be cut off, which the proxy turned into a 502). **One process, one content:** the admin values are process-wide, so in-process tests and the netsim harness share the server's numbers; their clients are made with `NetClient({ ownContent: false })`, which records the values without applying (or clearing) them, so a late OVERRIDES never changes the server's weapons mid-run. Browsers apply them as before.
- **Known limits:** a bot level change reaches new bots only; replays don't record admin values (a recording made under overrides replays with the shipped numbers); the host's Tune panel and the admin page both write a room's tuning, and the admin's latest change wins.

## 27. A longer tank, a longer dash, and respawns keep your guns (18 Oct 2026, owner's playtest)

> Owner: "I want the fuel longer and the dash to go farther; remember gun choice in case of respawn".

- **Fuel** (docs/02 §8): `fuelMax` 140 → **196**, 40% more again at the same burn (44/s) and air regen (12/s), so feathering and hovering keep their rhythm: burn 3.15 → **4.43 s**, full-tank climb 18.1 → 25.4 m, jet + run 31 → 42 m, best hover over 3 m 5.4 → 7.9 s. Ground regen 49 → **69/s**, so a refill from empty still takes ~3.05 s. A full climb now passes the 20 m view (the camera follows you up, as in low-g); the 12 m tallest tower is cleared twice over.
- **Dash** (docs/02 §21): `dashSpeed` 14 → **20 m/s** for the same 8 ticks, so the burst is the same 0.13 s blink and covers 40% more: 2.05 → **2.85 m** along the ground, 1.95 → 2.75 m up (still under half a second storey), up-right 1.97 m high at 2.38 m out, a 6 m slam in 0.35 s. The 1.0 s cooldown, the one air dash per flight, the 8 fuel and the exit caps are unchanged; a wall 1 m away still stops it at 1.00 m (move-and-slide; `dash.test.ts` still pins the 2 cm wall, the air-dash rule and the drop-through case). The admin page and the host's Tune panel edit the distance through `dashSpeed`.
- **Respawns keep your guns:** at a death, a person's two guns in hand are remembered (`PlayerState.keptGuns`) and the respawn gives them back with full magazines and reserves, crate and armory picks included, instead of the loadout (`respawnGuns`, slot by slot: an empty slot falls back to the loadout). The chosen loadout itself is untouched. Grenades come back as the default belt: they're consumables picked up in pairs, so "full" has no meaning for a type you found. **Bots** keep their own loadouts (`keepGuns` skips them). **A new match** (the countdown's respawn) clears the kept guns, so warm-up crate guns don't carry into it; a dev give-weapon (`setLoadout`) clears them too. The server is authoritative for respawns, so nothing changes on the wire.
- **Feel targets** moved with the numbers: burn 4.2–4.7 s, climb 23.5–27.5 m, jet + run 30–46 m, hover 6–9.5 s, dash 2.6–3.1 m along / 2.4–3 m up, low-g climb 28–34 m (31.2), long-flight burn 10–12.5 s (11.1) and jet + run 75–120 m (97), a gravity surge's climb 16–21 m (19.3). All on target.
- **Admin ranges** already cover the new defaults (fuelMax 10–300, ground regen 0–150, dashSpeed 4–30, burst 1–30 ticks). The Floaty preset scaled with them (fuelMax 220 → 300, the range's top; dashSpeed 16 → 23), so it stays bigger than Classic.
- **Goldens:** all 20 sim and 3 bot goldens re-recorded, because fuel is hashed from tick 0 and every replay starts on the default tank. Proof: main's replays run through this branch with the old fuel and dash (140, 49, 14 m/s) reproduce every one of main's 23 goldens bit-for-bit, with the keep-guns rule on and off (no golden has a person die holding picked-up guns).

## 28. The fluid dash: fuel, chains and stick strength (19 Oct 2026, owner request, protocol v14)

> Owner: "the dash, it's not fluid, as far as you have fuel you can dash as many times as you want but it eats from your fuel, i even want to add double dash so it chains dash like dash twice but it can move up twice fast or move sideways it depends on how fast the players are moving their joystick for those motion so it looks like you can actually do some movements in the game so it doesn't feel static".

- **No cooldown, no one-air-dash rule:** a dash costs fuel and you dash whenever the fuel covers it. `dashFuelCost` 8 → **16** (12 full dashes on the 196 tank; a dash also restarts the air regen delay, so dashing about in the air drains it). A **re-trigger gap** of `dashGap` 0.07 s (4 ticks) stops mashed or held keys from machine-gunning; a press inside it costs nothing.
- **Chains:** a dash started within `dashChainWindow` (0.35 s) of the last one's start is the next link (`dashChain`, 0 = a first dash), even mid-burst: the new burst takes over at once in its own direction, so a chain turns without a stop, and every link after the first is `dashChainBonus` ×1.15 faster. A straight up or down dash keeps the sideways speed you had (within the carry), so right-then-up curves instead of cornering, and a run into an up-dash keeps running.
- **It flows on:** at the end of a burst the sideways speed keeps `dashCarry` (0.4) of the burst's (8 m/s after a full dash) when that is more than the walk or air cap, then the ground's friction or the air drag takes it; never above `launchSpeedX`, so it is never a blast launch. A push still ends a dash at the caps (no carry), and it closes the chain.
- **Strength:** `Input.dashStrength` (0–7) scales a dash's speed and fuel from `dashMinStrength` (0.45) to full. Keyboard and bots: always 7. Touch: the move stick's push × how fast it got there (`dashStrength()` in touch/mapping.ts: a flick reaching its push at `dashFlickFull` 6 deflections/s or faster counts in full, a slow push for half); the dash button with the stick idle is a full dash the facing way; the swipe dash reads the same flick.
- **Feel** (all on target): one dash 3.18 m along the ground (2.85 in the burst, the rest is the carry), 2.75 m up, 5.0 m in the 0.5 s after a sideways dash from a hover, a gentle stick push 1.39 m. **Double dash** (the second pressed as the first ends): 6.43 m along the ground, **5.82 m up** (two fast climbs: about a storey), right-then-up 3.16 m high at 4.12 m out (it curves). **Fuel:** 16 a dash, 32 (16 % of the tank) a double dash, 12 dashes a tank.
- **Tunable everywhere:** content `TUNING_GROUPS` → Dash has speed, length, fuel per dash, gap, chain window, chain speed, carry, weakest dash, the touch flick and the exit-up cap, so the admin page and the dev panel ("All values") have them all; the host's Tune panel shows distance, fuel per dash, chain window, gap, weakest dash and full flick (the cooldown row is gone). Presets: Classic is the above; the admin's Chaos makes dashes cost 8, the Tune panel's Floaty 22 and Chaos 8. The admin page's ranges fit the wire (gap ≤ 1 s in u6 ticks, window ≤ 2 s in u7).
- **Protocol v14** (registered first): INPUT + u3 dashStrength; the dash group's 43/44 are now dashGap u6 / dashChain u3; a new group 63–64 (dashChainTicks u7, dashPower u3); DASH ext event + u3 chain. Prediction stays exact: `apps/game-server/test/dash.test.ts` adds a run of chains, every strength and an empty tank with no mispredictions on a clean LAN.
- **HUD:** the dash ring reads the fuel: full while the fuel buys a dash, grey and refilling toward one when it doesn't (the touch button ticks when it's back); the old "Air" pip now counts the dashes in the tank (×12). Browser scripts (hud-states, hud-v2, phone-hud-shots, touch-check) patch fuel and read the chain window instead of the cooldown.
- **The trail:** a chain reads as one streak. The 3D ribbon (render3d-b's `DashTrail`) already keeps sampling the same body across links (nothing changed there); the 2D band ends a link where the next starts and fades the links together.
- **Bots:** they dodge at most once a second (their own `nextDodge`, as the old cooldown did), at full strength.
- **Goldens:** the `dash` sim replay was regenerated (its scenario now also does a refused press inside the gap, a chained air dash, a double dash up, a right-then-up chain, a weak dash, and dashing in the air until the tank is dry) and its hashes re-recorded; the 3 bot goldens re-recorded (their dodges cost 16 and the dash state hashes the new fields). The other 19 sim goldens didn't move: nothing else in them starts a dash.

## 29. Controllers: DualSense, DualShock 4, Xbox and other pads (19 Oct 2026, owner request)

> Owner: "i want people to be able to connect controllers, like ps5 controllers".

- **Where:** `apps/web/src/gamepad` (shared notes: gamepad-interfaces.md). `mountGamepad` in main.ts wraps the sampler's `sample` and `consumeWheel` and the renderer's frames and events, as touch does: the pad ORs the same `Btn` bits into the same `Input`, so the sim, prediction and the wire don't change (no protocol space). The Armory and the standalone Locker call `mountPadMenus()`.
- **Reading pads:** the W3C standard mapping (indices are positions, so one layout fits every pad), polled each frame and again in every sample; a press between samples still reaches the sim (pulses), a tap of the grenade button goes through the keyboard's `ThrowLatch`. The pad last pressed plays. Triggers are analog with a threshold and a little hysteresis; sticks have a round dead zone, rescaled, and a response curve on the aim stick. A pad without the standard mapping is read with the same indices and can be rebound.
- **Default layout** (same positions on PlayStation and Xbox, glyphs differ): R2/RT fire · L2/LT aim (alt fire; held, it zooms out on a gun that zooms) · R1/RB grenade (tap: quick throw; hold: the arc, aimed and powered by the right stick) · L1/LB dash (the left stick picks the 8-way direction; resting = facing) · ✕/A jet, or push the left stick up · L3 or the left stick down: crouch/drop · □/X reload · ○/B swap · △/Y take a gun · R3 melee · D-pad ↑ dual, ↓ shield, ← zoom step, → next grenade · Create/Share/View or the touchpad: scoreboard (hold) · Options/Menu: the menu.
- **Aim:** the right stick's direction, turned toward at the "Aim speed" (all the way: instant), with touch's friction-only aim assist (its own switch); the reticle sits along the aim at the stick's push (3–12 m), which the camera's look-ahead follows. The mouse takes the aim back after 24 px of real movement.
- **Dash strength (v14, the dash agent's field):** on a dash press the pad computes 0..7 from the left stick's push and flick speed (`padDashStrength`: resting = 7, a flick from the centre in ~125 ms = 7, a gentle push ≈ 4) and writes `Input.dashStrength` only where the Input has that field, so it starts working when v14 lands with no change here.
- **Rumble** (`vibrationActuator` dual-rumble; Firefox's haptic pulse where present): own shots (light, at most every 70 ms), hits taken (by damage), deaths, blasts by distance, own dashes; scaled by "Vibration strength", off with "Vibration" or "Reduce flashes", and only while the pad is the device in use.
- **Menus:** the topmost modal, route or menu screen has the pad; the D-pad or left stick moves focus spatially (in line beats nearer diagonals; a held direction repeats), ✕/A presses (a text field takes focus), ○/B and Options send Escape (the shell's back and pause), L1/R1 step a tab strip, the right stick scrolls, sliders move with ←/→. Game screens over play that carry buttons (the warm-up's Ready, the controls card, the folded lobby) are reached with a tap of Create/Share/View. A small hint bar (bottom right) names the buttons while a pad drives a menu. Buttons held when play resumes wait to be let go (the ✕ that pressed Start doesn't jet).
- **Glyphs:** `<html data-input="keys|touch|pad">` follows the last device (trusted events only). While a pad is in use the HUD's keycaps, the controls card and the countdown's tip show its buttons (`Pad<n>` codes through `capText` and `Kbd`): PlayStation's shapes, Xbox's or Nintendo's letters, drawn as plain outlines (no brand art or colours). Settings → Controller can force PlayStation or Xbox glyphs.
- **Phones:** while a pad plays, the touch buttons and the sticks' knobs step aside; the two dials stay as gauges because they carry the phone HUD's HP, fuel and ammo. The first touch brings everything back. The phone's Settings shows a "Pad" tab once a pad has been used.
- **Settings → Controls → Controller** (saved in `settings.v1` as `pad`): use controllers, glyphs, remapping (two buttons per action; a button does one thing; Options can't be rebound), aim speed and response, invert aim, swap sticks, push up to jet, aim assist, both dead zones, both trigger thresholds, vibration and its strength (with a Test), a link to the check page, Reset.
- **Check page:** `/gamepad.html` lists every pad, its mapping, live axes and buttons with their glyphs and actions, the sticks with the dead zones drawn, what the game reads, and rumble buttons.
- **Browser support:** Chrome, Edge and Safari (macOS and iOS 14.5+) give DualSense, DualShock 4 and Xbox pads the standard mapping; Android Chrome too. Pads appear only after a button press, and only on secure origins (https or localhost: a LAN http address shows none). Rumble works in Chrome and Edge (desktop and Android); Safari has no rumble.

- **Layout presets and movement zones (23 Oct 2026, controls spec §5.1–5.3, 5.6; docs/design/controls-research.md).** Owner: "the controllers don't have the best experience when moving around".
  - **Standard is the default layout:** LT jets while held (A jets too), RT fires, LB dashes, RB grenade, B melee, X reload (held 0.3 s: take the gun underfoot, so Y can swap), Y swap, L3 crouch, R3 spin-up / alt fire, the D-pad and the centre buttons as before. **Classic** is the first layout (A jet, LT alt fire, B swap, Y take, R3 melee). Settings → Controller → Layout picks one; a remap shows as Custom.
  - **Old saves:** settings are saved whole, so a pad save from before the presets (no `rev`) whose buttons were the old defaults never chose them: it loads as Standard, and its 0.20 move dead zone as 0.15. Real remaps stay, as Custom.
  - **Sticks:** a round dead zone of 0.15 (slider 0.05–0.35), the outer 0.92 counts as full, linear on the move stick; the move stick snaps level within ±12° of horizontal.
  - **Run** from 0.18 of the shaped push (≈ 0.30 of the raw throw; it was 0.44), held down to 0.12; the y axis never stops a run.
  - **Stick jet** starts only inside 55°–125° with a push ≥ 0.60, then holds while the angle stays within 20°–160° and the push ≥ 0.40: a run that drifts up no longer takes off, and diagonal flight stays easy.
  - **Crouch** only within ±30° of straight down, push ≥ 0.70 (held to 0.55), or L3.
  - **Dash directions** use the same zones: left/right within ±35° of horizontal, up and down within ±35° of vertical (the jet's start cone), diagonals between; under a run's push it dashes the way the soldier faces.
  - **Triggers** press at their threshold (0.30) and let go 0.10 under it (0.20).
  - **Aim:** the angle moves only while the aim stick's raw push is ≥ 0.30; a turn of more than 90° (a turnaround) lands within 3 ticks (it took 8), small corrections keep the 0.35 rad/tick cap.
  - **Checked** with a fake standard pad in headless Chrome, every tick's `Input` recorded (`apps/web/scripts/pad-check.mjs`): run from 0.29 raw, no jet at 25°/40°/50°/54°, jet at 56°/60°/90°/125°, jetting holds to 20°, crouch at −61°…−90° and not at −50°, dashes at 25°/30° right, 50° up-right, 80° up, LT jets at 0.35 and lets go at 0.19, A jets, a 180° flip in 3 ticks, X reloads at once and takes at ≈ 0.3 s. Air reversal while jetting is still 650 ms: that's the sim's `airAccel` (spec §5.8, the owner's call), unchanged here.
- **Aim assist levels (23 Oct 2026, controls spec §4.5, §5.4, item 6).** One core for pads and touch: `apps/web/src/input/assist.ts` (pure) and `input/sight.ts`. The input agent wrote it; the phone agent wires touch to it (shared notes: gamepad-interfaces.md).
  - **Off · Light · Standard (default) · Strong**, in Settings → Controller → Aim assist. Light is the old friction: on a target the stick's turn is taken at 0.45×. Standard adds magnetism, only while the aim stick's raw push is ≥ 0.50: the enemy nearest the stick's line, tested after projecting the line out to his distance (a 0.8 m miss, or 2.5°), pulls the aim 25% of the error per tick, at most 3°; full to 0.7 × the gun's range, nothing past 0.9× (and 40 m); the chosen target sticks unless another misses by 30% less. Strong adds a lock: the stick let go, the aim stays on the chosen target while he's in sight and in reach.
  - **Who counts:** enemies in sight, as the sim's `canSee` decides: a clear line from the eyes to the head or the middle of the torso, through the map's collision world (fences and see-through platforms don't block; walls do) and no opaque smoke (the frame's clouds). The aim point is the torso, or the head over a low wall.
  - **Checked** in headless Chrome with the fake pad (`pad-check.mjs`): the aim stick held 3° off a range dummy 9.5 m away settles 1.7° off (friction plus pull), never moving more than 3° a tick.
  - A turnaround past 90° isn't slowed or pulled back by a target behind it. Mouse aim never gets assist. Old saves: the assist switch on became Standard, off stays Off.
  - `onTarget()` is auto-fire's shared test: a projected miss within 0.45 m, out to 0.8 × the gun's range (40 m at most); dwell and linger timers are the caller's.
  - Not done: the scoreboard doesn't show each pad player's assist level (spec §5.4) yet; it needs a field on the wire.
- **More layouts and the Controller page (23 Oct 2026, controls spec §5.6, item 7).**
  - **Layouts:** Standard (default), Classic, **Bumper Jet** (LB jets, LT dashes, the stick never jets), **Southpaw** (Standard with the sticks swapped and the triggers and bumpers swapped: LT fire, RT jet, RB dash, LB grenade) and **One-stick** (accessibility: move with the left stick; the aim follows the nearest enemy in sight and in the gun's range, otherwise the way you move; the gun fires by itself after 100 ms on target and lingers 150 ms; Strong assist; a held grenade lobs as far as the target; the right stick still takes over while pushed; B swap, Y melee). A layout is its buttons plus its switches; leaving One-stick puts Standard assist back. "Aim for me" and "Fire for me" are switches of their own.
  - **Settings → Controller** is its own tab now (the phone's "Pad" tab is the same page). At its top, a **live check**: each stick in a test circle that draws its dead zone, the 0.92 outer ring, the run lines, the stick-jet cone and its hold zone, the crouch wedge (and on the aim stick where it starts turning and where assist pulls), with the stick's dot live; every action with its buttons lit while held; and what the game reads. "Test the controller" keeps presses from working the menu until Options ends it.
  - **Checked** with the fake pad (`pad-check.mjs`, 21/21): Bumper Jet's stick up doesn't jet, LB jets, LT dashes; Southpaw's right stick moves, LT fires, RT jets; One-stick near a range dummy aims at it and fires on its own after the dwell.

## 30. High ping: what made it feel unresponsive, and the fixes (19 Oct 2026, owner's report)

> "The connection is making the game unplayable… most things aren't responsive." The owner and his friends play from Nigeria on mobile data against the Johannesburg box. The owner's phone measured 513 ms median / 1347 ms p95 with `/probe` (MTN, Port Harcourt). The dev Mac on the same network measured 150 / 221 ms (see the probe PR #138). docs/05 §4, §7, §10, §13.

**Measuring it:** `pnpm --filter @military-forge/game-server netfeel` runs two clients against a real Room through the conditioner, 3 seeds × 120 s per profile. Client 0 plays every action. The conditioner gained loss in bursts (`burstMs`) and latency spikes (`spikeMs`, a phone's upload queue). The MTN profile is +1 s uplink spikes, 2.5 s long, one every ~7 s, which reproduces the phone's 513/1347.

**What was wrong, worst first:**
1. **Latency spikes made the client yo-yo.** Inputs arrived late, the pacer jumped ahead (a lurch: the fast-forward runs the held input), then the queue drained and it jumped back (a freeze). 116 jumps in 6 minutes on the MTN profile (now 1). Now a spike is ridden out: a jump needs 5 s off, or more than 2 s behind (a tab that slept), or more than 30 ticks ahead.
2. **Presses lost.** An input that came after its tick was dropped, and a tap with it: dashes and throws the client showed never happened. Late presses are now applied on the next tick, once.
3. **Own grenades appeared a round trip late**, from where the hand had been. They now fly from the throw (`ownProjectiles.ts`). The 3D view needs its owner to wire `net.ownGrenadeViews()` and `net.predictsGrenade(id)` into `render3d/online.ts`'s timeline; the 2D view has it now.
4. **Lag compensation capped every shot at ≥ 175 ms RTT** (300 ms total). It's now 500 ms by default, and `LAG_COMP_MAX_MS` on a server (the trial box: 900). Since §38: 450 ms, the cover rule, and no `LAG_COMP_MAX_MS`.
5. **Remote players froze** whenever ±40 ms jitter or a lost snapshot outran the fixed 100 ms interpolation delay. It now adapts to 50–200 ms.
6. **Over WebSocket, jitter starved the server of inputs.** The pacer now keeps a cushion of up to 6 ticks after late inputs.

**Before → after** (3 × 120 s; WT = WebTransport datagrams, WS = TCP with retransmits; "presses lost" = predicted by the client and never done by the server):

| Profile | Via | Shots · dashes · throws lost | Own grenade shows after (p50) | Corrections/min | Lurches | Resyncs | Inputs missed/min | Remote players frozen | Hits on a walking target |
|---|---|---|---|---|---|---|---|---|---|
| 150 ms ±40, 3 % | WT | 0 · 0 · 0 → 0 · 0 · 0 | 244 → **0 ms** | 2.5 → 2.5 | 0 → 2 | 0 → 0 | 1 → 1 | 2.9 → **0.0 %** | 100 → 100 % |
| 150 ms ±40, 3 % | WS | 10 · 8 · 0 → 3 · 0 · 0 | 294 → **0 ms** | 19.3 → **3.1** | 2 → 0 | 10 → 0 | 294 → **67** | 11.9 → **3.2 %** | |
| 250 ms, 10 % bursts | WT | 3 · 0 · 0 → 3 · 1 · 0 | 345 → **0 ms** | 5.8 → 4.2 | 0 → 0 | 0 → 0 | 47 → 57 | 3.4 → **0.2 %** | **67 → 100 %** |
| 250 ms, 10 % bursts | WS | 47 · 17 · 15 → **0 · 0 · 0** | 445 → **0 ms** | 96.7 → **4.5** | 119 → **0** | 450 → **0** | 1225 → **47** | 31.7 → 20.0 % | |
| MTN 4G (500 ms, +1 s spikes) | WT | 101 · 24 · 22 → **35 · 11 · 3** | 576 → **0 ms** | 338 → 300 | 64 → **24** | 116 → **1** | 1253 → 1059 | 0 → 0 % | 18 → 38 % (73 → **91 %** at the box's 900 ms cap) |
| Lagos box, est. (90 ms, same spikes) | WT | 71 · 28 · 21 → 33 · 5 · 2 | 171 → 0 ms | 390 → 316 | 107 → 8 | 187 → 1 | 1397 → 1057 | 0 → 0 % | 80 → 92 % |
| Lagos box, est. (90 ms ±25, no spikes) | WT | 0 → 0 | 161 → 0 ms | 2.4 → 2.4 | 0 → 0 | 0 → 0 | 0 → 0 | 0 → 0 % | 100 → 100 % |

The remote players' interpolation delay went from a fixed 100 ms to 167 ms at 150 ms ±40 with 3 % loss, 90 ms on clean paths, and 181–200 ms with bursts.

Snapshot sizes and data are unchanged (a 2-player room: ~1.9 KB/s down, 64–85 B snapshots).

**What it doesn't fix:** a phone whose upload stalls for a second still loses control for that second. The server runs on its last input, and the correction when the inputs arrive is ~1.3 m at p99. No pacer setting avoids this without adding the spike to everyone's input delay. The fix is the path: WebTransport (no TCP stalls on top), and where the box is (docs/09 §4.1). netfeel's "Lagos box, est." rows show that a 90 ms path keeps the same spikes if they come from the phone's own radio. The probe's reference pings tell which it is.

## 31. Sound (19 Oct 2026, owner request)

> Owner: "we haven't even entered sounds". Then, hearing the first pass: "it should sound war like war … hard boiled and detailed … military, serious battle … not joyous".

- **Where:** `apps/web/src/audio`. `index.ts` is all the boot chunk carries (the unlocker and a forwarder); `runtime.ts` (engine, director, music, interface sounds, about 26 kB gzipped: the engine and director 8 kB, the sound recipes and music 18 kB) loads when the page is idle and starts on the first tap or key. Nothing runs in the sim: main.ts hands it the renderer's events (`GameRenderer.onEvents`), each drawn `Frame`, and the shell's store; onlineMode adds the server's off-screen SOUND events and our own predicted throws and launches.
- **Sounds are code:** `sounds/*.ts` has 140-odd sounds (about 270 takes), each a recipe over `dsp.ts` (seeded noise, oscillators, a TPT state-variable filter, envelopes, modal synthesis for metal, saturation and soft clipping, echoes, a small Schroeder reverb, seamless loops). `bank.ts` renders a take at 32 kHz on first use (or warms common ones in idle callbacks), normalises it and trims the silent tail. No files, no paid generation. Rendering everything would hold about 18 MB of decoded audio; a match renders what it hears.
- **The look of the sound (round two):** gunshots are an N-wave crack, a saturated muzzle blast, a sub thump, the action's metal and rattle, an outdoor tail and slap-back, with a family weight each (pistol snap, rifle crack, SMG chatter, LMG chug, shotgun boom, sniper crack and long echo); spent brass tinkles on concrete after nearby shots; far shooters get a distant report layered on. Blasts have a deep sub drop, a low-shelf rumble, debris and a ringing tail; one on top of you muffles the world and rings your ears. Hits are thuds, a headshot a helmet's crack, a kill a body dropping and a radio click. The jetpack is a saturated thruster roar with a turbine whine; the dash a hard burst of air. The interface is muted switch clicks, radio blips and squelch; the countdown a war drum. The music bed is a D drone moving to E-flat and C, war drums, a field snare and a clock at 84 BPM; the stings are low dissonant brass and drums.
- **Engine** (`engine.ts`): buses Master, Effects (`sfx`, through the duck and the flashbang muffler, plus `big` for blasts, not ducked), Music, Interface, Voices, then a limiter and a hidden-tab fader. Voices: buffer → gain → (a distance low-pass) → stereo pan → bus, plus a send to one convolver (a synthesized outdoor impulse: early reflections and a darkening tail), more for farther sounds. Pan by world x from the listener (±16 m), level by distance (6 m reference, a fade over the last fifth of each sound's range). Limits: each sound caps its own voices (the oldest is cut), the engine caps all at 40 (the least important goes, or the new one is refused), a per-sound cooldown (a shotgun's pellets are one bang), and many of one sound play quieter each. Blasts duck the world, music and voices by their size and distance. "Soften loud bursts" (Accessibility) lowers blasts, drops the ear ring, halves the ducking and hardens the limiter. Hidden tab: faded out and the context suspended; back: resumed.
- **Spatial (round three; owner: "far and close and on earbuds, for engineered experiences"):** the mix rules are in `docs/audio-design.md`. Far sounds arrive late (speed of sound, capped 0.15 s), darker, wetter, and guns and blasts layer in a far report or rumble; `acoustics.ts` counts walls between you and a sound from the map's collision geometry (one ray walk per sound start, cached) and muffles it, and three rays from you pick the reverb (open street or under cover, two convolvers cross-faded); Settings → Audio → Headphones (3D sound) switches world sounds to HRTF panners; your own gun dips under close incoming threats, and close enemies' steps and jets are lifted as cues.
- **Unlock** (`unlock.ts`): the context is made inside the first pointer/touch/key gesture with a one-sample silent buffer started in it (iOS), and resumed on any later gesture after an interruption (not while hidden).
- **Director** (`director.ts`): events → shots by weapon family (`families.ts`: fire, reload steps over the weapon's reload time, a bolt or pump after the shot, empty click, draw), impacts, near-miss cracks, hits (panned toward the attacker), headshot and kill confirms, blasts by grenade or projectile type, dashes (a quick second one chains, higher), pickups (shield, grenades, the crate swap), shield hits and breaks, map events, off-screen gunfire. Frames → footsteps by distance walked, landings by fall speed, the jetpack (a feathered key keeps one sound going, quieter), swaps and draws, reloads (cut short by a swap or death), wind-ups (minigun spin, charges), melee swings, the shield going up, burning, grenade bounces, mines arming and triggering, projectiles' flight loops, smoke and gas hissing, launches seen online (attributed to the nearest player holding the launcher), low fuel, an EMP'd jetpack, the empty click (fire held on an empty gun), flashbang deafness and the gas cough.
- **Shell** (`ui.ts`): one click and one hover listener on the document (switches, back buttons, disabled controls told apart; the canvas and touch controls skipped); the store gives toasts, errors, players joining and leaving, Ready, the countdown's flood, sting, 3-2-1 and GO, and the result. Music: the bed in the menus and the lobby, off in a match.
- **Settings:** `AudioSettings` gained Interface and Voices (volumes and mutes), and Settings gained `softBursts`; old saves load with the defaults. Desktop and phone screens have the rows; a volume change plays a short sample at the new level.
- **Audition:** `/sounds.html` (the sound board; also a link in the debug client's bar). Tests: `src/audio/*.test.ts` (every sound renders clean, every weapon and grenade has its sounds, the engine's buses, limits, cooldowns, panning, ducking, softening, the hidden tab and loops on a fake context, the unlocker, the director's mapping and the shell cues).
- **Not done:** surfaces under footsteps, sound through a slab's open ends (occlusion is a straight line), an announcer (the Voices bus is ready), and recorded assets (`docs/audio-asset-wishlist.md`).

## 29. Onboarding and sockets audit fixes (19 Oct 2026)

- **M1, a silent connection.**
  - The WebSocket path had no watchdog and no connect timeout. It now has both: 4 s of silence (3 s on WebTransport, 8 s before WELCOME), and 6 s to open. The watchdog runs on a timer, not the frame loop.
  - The `/health` lookup gets 4 s (was 1.5 s, too short for a fresh TLS connection at 500 ms).
  - Checked in the browser with the server paused for 15 s: dropped at 4.4 s, banner shown, resumed the moment it came back.
  - The server now repeats a silent client's last input for 0.5 s only, then neutral with the aim kept (`MAX_REPEAT_TICKS`). netfeel's MTN profile improved with it: corrections 300 → 226/min, lurches 24 → 9.
- **M2, admin limits.** `applyAdmin` wrote the room's default limits over the match on every admin edit. Now:
  - only limits the admin page changed (set, edited or cleared) move;
  - a running match keeps its limits until it's back in the lobby or counting down;
  - a cleared admin limit returns to the room's own, the host's if it set one.
- **M3, admin credited to the host.**
  - The server sends OVERRIDES before TUNING, so a client knows which tuning keys the admin just moved (`adminTuningKeys` in `shell/tune.ts`). Those show as "Admin changed…" to everyone; the rest stay the host's.
  - "Tuned by host" now compares with the room's own tuning (defaults plus the admin's, `OnlineMode.tuningBase()`), so admin values show only as "Tuned by admin".
- **L4, a host that's gone.** A host disconnected or silent for 5 s (`HOST_AWAY_TICKS`) hands the room to the longest-present player still talking; the others see "Host left: <name> is the host now".
- **L8, the host's Tune panel.**
  - An edit made while disconnected waits and goes out with the next WELCOME.
  - A clamped edit is echoed back to the host.
  - WELCOME refreshes an open Tune panel (the tuning listeners hear it, not as a live change).
- **wt-setup.sh's self-test** said "no WebTransport session" on the live box while browsers connected. The cause was `grep -q` under `pipefail` (the probe's pipe broke after READY); reproduced locally and fixed. `wt-setup.sh gateway` re-runs the gateway setup by hand and reads the host from Caddy's site.


## 32. Remote melee swings on the wire (20 Oct 2026, render3d-b's melee audit, protocol v16)

- **The gap:** a remote player's `meleeTicks` wasn't in the snapshot, so online another player's machete or melee bash showed only when it landed a hit (render3d played it from the strike); misses were invisible.
- **The fix (v16, registered first; v15 is ui-playtest's room bots, claimed and not yet on main):** remote flags 12 → 13 bits, **4096 = swinging**, and while it's set the state group carries a **u6 `meleeTicks`** after the flags. The state group is re-sent while the swing runs (13 + 6 bits a snapshot), nothing at rest.
- **On the client:** `NetClient.remotePose` fills `RemotePose.meleeTicks` from the two snapshots around the render tick (`swingAt`): the later one's swing counted back when it had started by then, else the earlier one's counted on. It is fractional between ticks, so a swing plays smoothly at 2 or 4 ticks per snapshot. `OnlineMode.remoteView` puts it in `PlayerView.meleeTicks`, which render3d's `SwingClock`, the 2D view and the audio director already read. The swing sound plays for remote swings as well.
- **Prediction:** unchanged. The local player's swing was already in the local block (v6), and remote players aren't predicted. No sim change, so no golden moved.
- **Tests:** protocol (a remote machete swinging and missing four times, every tick round-tripped full and delta), netcode (`swingAt`), web (`remoteView` carries it).
- **Shield HP for the HUD:** already there. `PlayerView.shieldHp` is the local player's riot-shield HP in both modes: local mode for every player, online from the predicted local block (it rides the v9 shield group). The HUD's `shieldStatus` reads it (`player.shield.hp` / `.max`, the `v.shield` bar). Remote players' shield HP stays private (only the shield's state travels). Noted for the UI agents in the shared notes (`remote-melee.md`).

## 30. Local rooms: same Wi-Fi, peer to peer (20 Oct 2026, owner request; docs/05 §2.4)

> "Add a feature where people can create a local room with just Wi-Fi if they're connected, so it uses their Wi-Fi."

- **Engine (this step):**
  - The host's browser runs the game server's own Room, in a worker. The room code was made browser-safe: `adminState.ts` and `matchRecorder.ts` hold the parts with no Node imports, and tokens use Web Crypto.
  - Guests connect over WebRTC data channels (`apps/web/src/lan`), set up through the game server's relay (`lanSignal.ts`, `/ws/lan/…`) or offline by packed codes.
  - Nothing is recorded (no results sink).
  - Debug client: `?lanhost[&bots=4]` and `?lanjoin=CODE`.
- **Measured** on this Mac (two tabs, the host hidden): RTT 1.5 ms, jitter 0.4 ms, 60 Hz, 0 corrections. The host leaving ends guests' games in about 2 s (4006).
- **Limits:**
  - The game page must already be loaded; with no service worker, a device with no internet can't load the game.
  - mDNS must pass on the network: Wi-Fi with client isolation blocks it all.
  - There is no host hand-over.
  - The host's tab must not be killed (a phone that locks or switches apps suspends it).
- **Next step:** the screens: a "Local room (same Wi-Fi)" choice, the code with a QR code, and the offline QR exchange.

## 33. The premium in-match HUD (23 Oct 2026, owner request)

> "the ui for the swapping guns and all needs to be premium, the guns on the ground the ui in the game so users have more views, when something is happening like the surge and all we should use a more better ui since it's a game you get me right"

- **Design:** the Pen board "IN-MATCH · premium HUD" in the owner's file (desktop, phone, one treatment per event kind, notes for the Pen agent). Code: `apps/web/src/hud/` (`premium.css`, `eventTemplate.ts`, `worldTags.ts`, model.ts's last section, hud.ts). Shots and strips: `docs/screenshots/hud-premium/` (`apps/web/scripts/hud-premium-shots.mjs`).
- **The swap:** the two slot cards trade places over the gun's real equip time (the sim's `swapTicks`, 0.25–0.6 s), the held one growing from the slung card's corner with one uniform scale (nothing stretched). The incoming gun slides in with two volt ghosts (`--equip-ms`), a draw bar fills the card's top edge from `--equip`, and on landing (`drawn`, 450 ms) the art settles, the name and class chip stamp and the edge flashes volt once. The cue under it says DRAWING then READY, how the gun fires, and which key swaps back (`swap-hint`, 1.2 s). Taking a gun from a crate plays the same landing. Phone: a draw toast above the bottom centre (gun, name, class, ammo, the equip bar) and the swap pill's volt edge and bar.
- **Guns on the ground:** every item wears a world tag (glyph, short name, class chip, mag, distance) that shrinks and fades with distance (`tagFade`: full to 6 m, 0.72× and 45 % at 30 m, gone past 48 m, stepped so it is rewritten only when the step changes); power weapons in brass, grenades in paper, the shield in steel. Tags are pooled and moved by transform; the phone shows the nearest four and keeps off its touch controls. Standing on a gun: the compare card (key ring, verb over name and class, its art, what it replaces, fire mode, mag, five bars that fill in with ▲▼ deltas); close to a grenade pair or the shield: the item card (what it does for your belt, the shield's HP). Phone: a compare chip above the Take button.
- **Map events:** `EventTimeline` (model.ts) turns the frame's warning/active into warning → impact (900 ms) → active → all-clear (1.8 s); a late join skips the impact; a new event takes over at once. The warning has a hazard head, the kind's icon with a gravity arrow, the name, the effect, and a countdown digit that stamps each second in a draining ring; the impact stamps the name between two shock lines in the upper third, then lifts into the strip; the strip shows the effect in a few words, the seconds and a draining bar; the all-clear says what is back. Screen treatments under the plates (`.mf-evfx[data-kind]`): surge pressure lines and a top-heavy vignette, low-gravity motes and a float on the corner plates, EMP static and a HUD flicker (desktop, two dips a second, off with Reduce flashes), fog haze, gust streaks, flip chevrons that turn over at the impact. The warning edges the screen in hazard tape. The audio director ticks the warning's last three seconds (`ui.count`); the siren, the start sting and the end blip were already there.
- **Polish:** the kill confirm (TAKEN OUT, the name stamped again on each kill, a headshot tag, the streak: "2 down" … "Unstoppable"), the respawn digit stamps each second, and the spectator bar's visuals (watching, prev/next, Join next round) are in place, hidden, for when spectating lands with netcode.
- **Rules kept:** transform and opacity only, nothing transitions a per-frame value; Reduce motion stops it all (kit.css); no new backdrop blur on the phone; on phones that drop frames (`mf-glass-off`) and Low graphics the treatments hold still; status is always colour + icon + word.
## 34. Platforms drawn solid now stop bullets (23 Oct 2026, QA's "bullets pass through obstacles")

> The owner still sees "bullets pass through obstacles". QA (qa-bullets-lag-touch.md §1) found one-ways drawn solid that let bullets through: every one-way is `OneWay|BulletPass` unless `blocksBullets`, and maps without a kit draw them as 0.22 m slabs.

- **The rule (owner, 18 Oct):** slabs and roofs block bullets; anything bullets pass must read clearly as passable. Every one-way on every map is drawn as a slab, zinc sheet or canopy, so **all of them now carry `blocksBullets`**:
  - Flux Lab catwalks (4..24, 86..106 at 7 m);
  - Lunar Outpost (20..26 and 94..100 at 6 m, 10..14 and 106..110 at 5 m);
  - Storm Front (the piers at 4 m, the 12, 11 and 18 m ledges);
  - mechanics-test and movement-test;
  - Street Market's stall awnings and umbrella canopies. §18's "One-way slabs" left them see-through as sheet and cloth; they look solid, so they block now. The kit marks the two pieces (`build_market_kit.py`) and `compile_map.py` writes the flag: 21 of 21 one-ways.
- **Kit GLBs:** only the two pieces' extras changed. They were patched into the committed GLBs (art and runtime), and the mesh bytes are identical. A Blender rebuild with the updated script gives the same extras, but its mesh bytes drift (float noise), so it wasn't committed.
- **Bodies are unchanged:** a slab is still one-way. You fly up through it, stand on it, and drop through it.
- **What changes:** bullets, ricochets, blasts, gas, flashes and sight lines stop at these platforms from either side, and grenades bounce off their undersides.
- **Bots:** their line of fire and sight (`BulletPass` masks) now treats these platforms as walls, so they stop shooting at players who stand above or below one; nav is unchanged (bodies). The three bot goldens re-recorded for that; soak and behaviour tests pass. No sim golden moved (no replay shot through a platform).
- **Guard:** content.test.ts fails on any see-through one-way not listed (the list is empty). A future grate or torn canopy needs art that reads as passable first.

## 35. Bullet-only colliders and the Street Market's missing ones (23 Oct 2026, QA's "bullets pass through obstacles")

- **The gap (qa-bullets-lag-touch.md §1):** Street Market kit parts drawn on the gameplay plane had no collider, so bullets flew through them: the minibus underside (0–0.35 m), the catwalk's front plate, the balcony handrails, the stall posts, the tank tower's legs, the umbrella poles and the billboard masts.
- **A new collider kind, `MapDef.bulletOnly`:** polygons that stop bullets (hitscan, ricochet legs, the muzzle guard) and the bots' line of fire, and nothing else.
  - They sit outside the collision grid, so bodies, grenades, projectiles, blasts, gas, sight, nav and the renderers' probes never see them, and movement can't snag on a post.
  - `CollisionWorld.raycastBullet` = `raycast` plus a scan of them (a few dozen edges, brute force); the nearer hit wins.
  - An edge counts only from outside, so a shooter standing at a pole can still shoot out of it.
  - Map JSON and the schema take `bulletOnly` (default material metal).
  - The bots use `raycastBullet` for their line of fire and spot choice, so they don't shoot into poles. Choosing cover still uses walls only, so a thin pole isn't cover.
  - render3d's impact spark looks the surface up with `raycastBullet` (one line in vfx/gunfire.ts), so a hit on a pole sparks as steel.
  - The 2D view outlines bullet-only parts.
- **Street Market:** the kit's new `bulletOnly` extra carries 57 parts: 2 stall posts per stall, the umbrella pole (steel), the tank tower's 2 legs and 2 braces, the billboard's 2 masts and the catwalk's front plate (x −4..4, y 10–10.8), and every balcony's 3 posts and top rail (steel). The minibus body solid now reaches the ground, closing its 0.35 m gap for bullets and rolling grenades; nobody fits under it anyway.
  - The committed GLBs got only the changed extras; the mesh bytes are untouched (a Blender rebuild with the script gives the same extras).
  - compile_map.py writes them. The sightline lint is unchanged: thin parts aren't sight blockers.
- **Probe tests:** `packages/sim/test/bulletOnly.test.ts` covers:
  - the rules: both sides stop a shot, a shot over the top is clear, a shot from inside leaves, the world in front wins, a player walks through, a real shot stops at a post;
  - a ray fired at each Street Market part, which stops on it.
- **Goldens:** none moved (no replay shoots at these parts or rolls a grenade under a bus).

## 36. Tracers fly the sim's ray (23 Oct 2026, QA's "bullets pass through obstacles", L)

- **The gap (qa-bullets-lag-touch.md §1):** render3d drew the tracer from the drawn muzzle to the shot's end. The drawn gun sits below the sim's 1.08 m shoulder line (the ray starts there), so a shot that cleared a 1.0 m crate was drawn cutting through it.
- **The fix:** `vfx/gunfire.ts`:
  - the bolt and its path line now run along the sim's own ray, from the shot's `ox, oy` (the sim muzzle, on the ray) to `ex, ey`, at the drawn gun's depth;
  - the flash stays on the drawn muzzle;
  - a short joiner line in the tracer's tint (0.06 s, like the path) bridges the drawn muzzle to the ray's start, so the streak still reads as leaving the gun;
  - the impact's direction is the sim ray's too.
  
  A drawn path can no longer cross a collider the sim ray didn't. The joiner spans only the gap between the gun and the ray, within the gun's own reach.
- **Not fixed: parallax.** Front faces stand 0.6–1.1 m in front of the gameplay plane, so under the perspective camera they look up to 0.3–0.58 m wider than their colliders near the screen edges. A shot that clears a collider's corner there can still look as if it grazes the front face. A fix would mean drawing the gameplay plane orthographically or pulling front faces back to the plane, and neither is cheap; it's left for render3d-b and art.
- **Test:** `render3d/test/gunfire.test.ts`: with the drawn gun 0.3 m under the sim line, the bolt and the path lie on the sim line and the joiner meets the gun.

## 37. Warm-up draws every effect once (23 Oct 2026, QA's first-use and match-start hitches)

- **The report (qa-bullets-lag-touch.md §2):** in headless software GL, the first dash, grenade, shot and jet each hitched (350, 300, 90 and 83 ms), and long tasks of 346–626 ms showed up in the first ~5 s of a match.
- **The cause, for the GL part:** the load's warm-up only *compiled* programs (`compileAsync`). It didn't *draw*, except for the shadow pass on High. Drivers that build a pipeline, or upload a texture or buffer, on an object's first draw did that work mid-game. A probe that logs every (object, material state) the renderer draws for the first time found these new on first use:
  - the grenade meshes (each type);
  - the particle layers (glow, smoke, decals, the blast flipbooks, the Forge muzzle flashes);
  - the throw arc;
  - the casings;
  - the dash trail.
- **The fix (render3d, hook-shaped):**
  - `Vfx.showForWarmUp(x, y, ghost)` puts every effect on show: the meshes of their own as before, plus a sprite in every particle layer (each blend and depth state), a grenade of each type (`GrenadeRenderer.showForWarmUp`), and an afterimage of a warm-up soldier (`DashGhosts.showForWarmUp`, whatever the tier's `max`, so a later tier with afterimages doesn't build its material mid-game).
  - `Renderer3D.warmUp` then draws one real frame on **every** preset (it used to on High only). `endWarmUp()` takes it all down.
- **Measured** with headless Chrome, first use then second use, local training:

| Run | First dash | First jet | Objects drawn for the first time after the warm-up |
|---|---|---|---|
| Software GL (SwiftShader), HUD hidden, before | 283 ms | — | 19 objects over the first 6 s and the first actions, plus 1 texture and 4 geometries on the dash |
| Software GL (SwiftShader), HUD hidden, after | 67 ms | 17 ms | none |
| Software GL (SwiftShader), HUD shown, before | 333 ms | 317 ms | — |
| Software GL (SwiftShader), HUD shown, after | ~217 ms | 50–150 ms | — |
| **Real GPU** (ANGLE Metal, M2 Pro, High), before | 17 ms | 17 ms | — |
| **Real GPU** (ANGLE Metal, M2 Pro, High), after | 17 ms | 17 ms | — |

  On the real GPU every action, and the first 6 s of a match, is 17 ms frames both before and after, and nothing is drawn for the first time after the warm-up. The QA numbers came from software GL. Phones, whose drivers build pipelines lazily, are where the warm-up should count.
- **Not fixed: the HUD.** With the HUD shown, software GL still pays ~150–200 ms on the first dash and jet. That is the HUD's first animations and composited layers being rasterised in software. Phones raster on the GPU; the UI agents could warm those states during the loading screen if a real phone shows it.
- **Not fixed: the match-start stall in software GL.** With the warm-up, no new objects are drawn in the first 6 s, but dynamic resolution steps the render scale down every second on a slow device, and each step is a `setSize` (a drawing-buffer realloc; 194 ms in QA's software profile). Clean on the real GPU. A smaller first scale for slow devices, or rendering at a viewport inside a fixed buffer, would avoid it.
- **The tier governor (render3d/index.ts):** it doesn't recompile shaders mid-match between Low and Medium. On the real GPU, `setPreset` medium → low → medium cost one 17 ms frame and +0 programs. High → medium (the sun's shadows off) took one 50 ms frame. Medium → high re-linked 3 programs, the shadow variants three had released. Phones' Auto ceiling is below High, so their switches don't recompile.


## 38. Bots' nav graphs build between ticks, never on one (23 Oct 2026, QA: "bullets, lag, touch")

QA found the whole server froze when a bot came in under a tuning the server hadn't built a nav graph for. `fillWithBots` runs inside `Room.tick`, and `addBot` built the graph there, synchronously: 263–330 ms on the shipped maps, during which every room on the process stopped. It happened with the admin page's values (the first room after each restart), a bot refilling a slot in a host-tuned room, a host's map switch, and LRU churn. A grenade-scale change rebuilt too, though it can't change a graph.

- **The key is the movement tuning only** (`navKey`). Health, respawns, the aim origin, grenade throw and blast scales, and the touch flick don't reach the movement code, so they don't rebuild (a test builds both and compares). Every other field does: the probe flies the real movement code with the whole tuning.
- **Builds are steps:** `navGraphSteps` is the same build as a generator (a settle, a walk or a flight per step: p99 0.3–0.8 ms, at most 2.5–3.2 ms cold), and makes the identical graph (the golden tests pass unchanged).
- **Rooms never build:** a room asks with `requestNavGraph`. If the graph isn't ready, the build is queued and the new bot comes in on the map's newest graph meanwhile; with none for the map (a first switch to it), the bot waits. Bots already in keep the graph they came with, as before.
  - The queue runs the most recently asked-for build first: a host dragging a slider wants the last value. It holds at most 8; a room that still wants a dropped build asks again on its next fill.
  - Rooms ask as soon as their tuning or map changes (admin values, a host's Tune edit, bots switched on, a map switch), so the graph is usually ready before a bot needs it.
- **Spare time builds them:** the server's tick loop lends up to 6 ms of each gap between ticks to `workNavBuilds`, and never the last 4 ms before the next tick (`loop.ts` `onIdle`; a local room's worker does the same). The 10 s room report shows `nav builds N ms between ticks`.
- **Startup** builds the rooms' map for the tuning the rooms start on (the admin page's saved values) and for the defaults, before anyone joins, and queues the other maps for spare time.
- **A host's map switch** now takes the bots out and brings them back on the new map's graph. Before, they kept navigating the old map's graph and mechanics.
- **Measured** with a real tick loop on Street Market. The admin page sends a jet-thrust nudge, gravity and fuel (a tuning the server hasn't seen), and the room adds a bot. Three runs each, on a busy Mac (load 13–25):

  | | Longest tick | Longest gap between ticks | Ticks dropped | Graph ready after |
  |---|---|---|---|---|
  | Before (built on the tick) | 333–685 ms | 333–685 ms | 15–36 | the same tick |
  | After (between ticks) | 2.3–2.6 ms | 18–21 ms (no build: 18–27 ms) | 0 | 0.9–1.2 s |

  The new bot came in at once on the previous graph. `test/navBuilds.test.ts` checks that no tick takes over 40 ms of CPU and that no tick finishes a build, while a new tuning arrives and while a map switch waits for its graph. The old code fails it: one tick took 658 ms.


## 39. Lag compensation: a 450 ms cap and the cover rule (23 Oct 2026, QA: "bullets, lag, touch")

QA found players on the trial box being hit after reaching cover. The box rewound shots up to 900 ms (`LAG_COMP_MAX_MS='900'` in cloud-init, chosen for 500 ms phones), so a player could be hit for up to 0.9 s after reaching cover on their own screen: 3.6 m at a walk, more with a dash. From the victim's side it looks like bullets pass through walls.

- **The cap is 250 ms of latency** on top of the most a shooter's view can lag (200 ms of interpolation), so 450 ms of rewind at most (it was 300 + 200). A shot needs RTT + input buffer + interpolation: netfeel's p95 is 130 ms on a LAN, 300 ms at the trial box's 110 ms, 380 ms at 150 ms ±40 and 530 ms at 250 ms. So every shot up to ~250 ms RTT lands where it was aimed, and beyond that players lead their shots.
- **The cover rule** (sim `rewind.ts`): a rewind longer than 150 ms (9 ticks) doesn't count against a target that is behind solid cover now. Cover means level geometry that stops a bullet lies between the shot's origin and the target's head, torso and legs alike. The shot is then tested against where the target is, so the wall takes it. A shorter rewind, or a target still partly in the open, is rewound as usual. `LagCompensator.covers` counts these; the debug log marks them.
- **Tunable:** `LAG_COMP_LATENCY_MS` (0–1000) sets a server's latency cap. The admin page's **Network › Lag compensation** (`net.lagCompMs`) changes it live in every room, and clearing it gives each room its own value back. `LAG_COMP_MAX_MS` (a total) is no longer read: a box that still has it logs that at startup and runs the new cap. cloud-init no longer sets it.
- **Shooting range** (a shooter on a tower taps at a target walking 5 m/s below, aiming where its screen draws it; 3 × 60 s per row). "Moved" is how far the target had gone since the pose its hit was tested at, which is what the target feels as being hit late.

  | profile | 900 ms total (old box) | 300 + view (old default) | **250 + view (new)** | 200 + view |
  |---|---|---|---|---|
  | LAN, trial box 110 ms, 150 ms ±40 | 100% | 100% | **100%** | 100% |
  | Bad (250 ms, 10% in bursts) | 100% · moved p95 2.7 m | 100% | **93% · 2.3 m** | 72% |
  | MTN 4G (500 ms, spikes to 1.3 s) | 88% · moved p95 3.9 m | 22% | **19% · 2.3 m** | 18% |

- **Cover range** (a shooter on an 8 m ledge, a target walking 5 m/s under a slab that hides it from the ledge half the time; 2 × 40 s, 72 shots). The column is how many hits landed on a target that was already behind cover at the server's present:

  | profile | old box (900 ms, no rule) | 250 + view, no rule | **250 + view + cover rule** |
  |---|---|---|---|
  | LAN (20 ms) | 2 of 36 hits | 2 of 36 | **2 of 36** (rewinds under 150 ms) |
  | trial box (110 ms ±15, 5%) | 6 of 28 | 6 of 28 | **1 of 23** |
  | 150 ms ±40, 3% | 9 of 33 | 9 of 33 | **0 of 24** |
  | Bad (250 ms) | 11 of 29 | 11 of 29 | **0 of 18** |
  | MTN 4G | 8 of 21 | 2 of 9 | **0 of 7** |

- **The trade-off:**
  - Players under ~250 ms RTT lose nothing.
  - Players on 500 ms mobile paths (the owner on MTN) hit a walking target 19% of the time instead of 88%, unless they lead it by about 0.3 s (~1.3 m). Their targets are hit at most 2.3 m late instead of 3.9 m.
  - The cover rule costs only the hits on targets already behind cover, at any ping.
  - If high-ping play matters more on a box, raise `net.lagCompMs` on the admin page (500 ms gives 700 ms of rewind). The cover rule still protects players behind cover.


## 40. Latency spikes: remote players carried on, corrections that slide or jump (23 Oct 2026, QA: "bullets, lag, touch")

QA measured two effects of latency spikes in netfeel. Remote players froze 18.9% of frames on the "bad" WebSocket profile: past the newest snapshot they were held, and nothing extrapolated. Corrections on the spike profiles pulled the drawn local player back at up to 32 m/s: rubber-banding.

- **Remote players are carried on** past the newest snapshot (`interpolation.ts` `extrapolationTicks`, `NetClient.remotePose`).
  - They keep the snapshot's velocity (on the wire for this since v1) in full for 50 ms, then slow evenly to a stop at 150 ms (100 ms of motion at most), and are held after that.
  - A carried-on player stops a body's half-width short of a wall and half a body short of a floor or ceiling (the prediction's map), and a dead one isn't carried on.
  - The server's lag compensation tests shots against where the player really was at that render tick, and the carried-on pose is nearer to it than a frozen one.
  - Both views draw remote players through `remotePose`, so the 3D view has it with no render3d change.
- **Corrections slide or jump** (`predictor.ts`):
  - The 80 ms exponential still smooths small errors over several frames, but never pulls the drawn player faster than 8 m/s (`CORRECTION_PULL_MAX`, ~1.6× a walk).
  - An offset past 2 m (`CORRECTION_SNAP`; one correction, or several in a row adding up) is one jump instead of a long drag that would leave the drawn player far from where its shots start.
  - Above 3 m (respawns, teleports) it was always a jump.
- **What doesn't change:** the corrections themselves. On the spike profiles the server runs for half a second on the player's last input and then on none, because the phone's inputs are a second late. That divergence is what gets corrected.
  - Repeating the last input for longer made it worse: on the MTN profile, a 1 s repeat gave 228 corrections/min against 188, and 1.5 s gave 240. A held input goes stale as fast as letting go does.
  - The fix for those players is the path (WebTransport, a nearer box: NOTES §30).
- **netfeel** (3 × 60 s per profile; client 0 plays every action; the other player now in every snapshot, so the new smoothness table can draw it):

  | profile | via | correction pull p99 / max | visible correction p99 / max | corrections shown as a jump /min | other player held still | other player off p99 / max | other player pops /min |
  |---|---|---|---|---|---|---|---|
  | 150 ms ±40, 3% | WS | 0.05 / 4.5 → 0.05 / 4.5 m/s | 0.3 / 32 → 0.3 / 32 cm | 0.4 → 0.4 | **3.2% → 0.0%** | **12 / 64 → 2 / 14 cm** | **7.2 → 0** |
  | 250 ms, 10% bursts | WT | 0.27 / 5.7 → same | 1.9 / 40 → same | 0.4 → 0.4 | 0.2% → 0.0% | 6 / 37 → 6 / 23 cm | 0.4 → 0 |
  | 250 ms, 10% bursts | WS | 0.41 / 11.2 → 0.46 / **8.0** m/s | 3.0 / 81 → 3.3 / 91 cm | 1.2 → 1.2 | **18.9% → 0.0%** | **65 / 145 → 15 / 42 cm** | **63.6 → 2.4** |
  | MTN 4G (500 ms, +1 s spikes) | WT | **15.7 / 32.3 → 8.0 / 8.0** m/s | 111 / 234 → 119 / **187** cm | 6.0 → 13.6 | 0% → 0% | 1 / 11 → same | 0 → 0 |
  | Lagos box, est., same spikes | WT | **13.8 / 32.3 → 8.0 / 8.0** m/s | 99 / 232 → 94 / **181** cm | 1.2 → 7.6 | 0% → 0% | 1 / 7 → same | 0 → 0 |
  | Lagos box, est., no spikes | WT | 0.16 / 25.4 → 0.04 / **6.1** m/s | 1.1 / 184 → 0.3 / **43** cm | 0 → 0.4 | 0% → 0% | 2 / 8 → same | 0 → 0 |

  "Other player held still" is past the newest snapshot and past the extrapolation. Before, every frame past the newest snapshot was held.
- **Hits** on the shooting range are unchanged at every profile (100% up to 250 ms, 22% on MTN at the default cap): the shooter aims where its screen draws the target, carried on or not.
- **The trade-off and the knobs:** on the spike profiles, the 2–3 m corrections that used to be quick drags (up to 32 m/s) are now jumps, 13.6 a minute on MTN instead of 6. Smaller ones slide at no more than 8 m/s. A higher `CORRECTION_SNAP` gives fewer jumps and longer drags: at 2.5 m, MTN had 10 jumps a minute and the drawn player trailed 151 cm at p99. A lower one gives the reverse: at 1.5 m, 18 jumps a minute and 85 cm.

## 41. The title screen and the way in (23 Oct 2026, owner request)
The owner, 23 Oct: "when it's opened, it has an opened screen with a tap anywhere to continue … to enter the game and have a nice experience". The design is card 01 on the Pen file's AGENT BRIDGE board, drawn on the "TITLE SCREEN · tap anywhere" board.
- **The title** (`apps/web/src/shell/screens/Title.tsx`, `title.css`, rules in `shell/title.ts`):
  - **Key art:** the Forge's key art (#185), full-bleed: `apps/web/public/art/key-art/key-art-{desktop,phone}` and their `-fg` soldier layers, served as AVIF with WebP as the fallback. Vite's `virtual:title-info` finds the files at build time, so the page never probes for missing ones; new art needs a rebuild or a dev-server restart. A dark olive fallback shows if the art is missing.
  - **Layout:** the frame is drawn 4 % oversize, with the soldiers' layer on top moving a little more. The lockup sits in the calm smoke of the upper third and the prompt on the dark rubble at the bottom (art/key-art/README.md).
  - **The ambient loop** (`key-art-desktop-loop.{webm,mp4}`) plays on desktop only, with the still as its poster: never on a phone, on Low graphics, with Reduce motion or on a data saver.
  - **Over the art:** the lockup, slow smoke and a light sweep. On desktop the art follows the pointer.
  - **The prompt:** "Press any key · click" on desktop, "Tap anywhere to continue" on phones; any controller button works too. The prompt breathes.
  - **The corners:** the build (git's short hash), and the server's region (the box's `/probe-config.json`, "This computer" in dev) with the live ping. "Sound starts on your first press" sits under the prompt.
- **The press:**
  - It unlocks the sound: the menu music starts with a war-tone hit (`sting.start`, audio/ui.ts).
  - The camera then pushes through the smoke into the screen already drawn underneath: your name the first time, then "Create your soldier" (the creator, docs/04 §6.1), then Home. A returning player goes straight to Home.
  - A press while the app is still booting turns the prompt into a loading line.
  - The key or tap never reaches the screen underneath.
- **When there's no title:**
  - invite links (`/r/CODE`) and local-room joins go straight to the room;
  - the debug client and `?notitle` skip it;
  - so does a browser under automation (`navigator.webdriver`), unless it asks with `?title`, so the end-to-end scripts still start at the name screen.
- **Cheap on phones, gentle on motion:**
  - Phones: one layer drifts, with no sweep and no blur.
  - Reduce motion: nothing drifts or breathes, and leaving is a 220 ms cross-fade.

## 42. Air control 20 → 32, and the stuck bot it showed up (23 Oct 2026, the owner: "use the best")

- **The change:** `airAccel` 20 → 32 m/s² (docs/design/controls-research.md §5.8). Air reversal while jetting (+6.5 → −6.2 m/s) takes **400 ms** instead of 650 (24 ticks, not 39); from rest to the air cap, 0.20 s instead of 0.32. Ground movement is unchanged.
- **Feel report** (`pnpm --filter @military-forge/sim feel`): every target still passes. Jet + run 42.1 → 42.5 m; long flight 96.8 → 97.9 m. Airborne shooters hold their line better against recoil: Breacher at 5 m airborne 1.40 → 0.78 s, Popper at 12 m airborne 4.41 → 2.38 s; other rows move by 0.06 s at most.
- **A sim ground-check bug, fixed (`movement.ts` `sweepDown`):** a body standing at the foot of a step lower than its radius (movement-test's 0.2 m ledge), creeping toward it at about 0.02 m/s, met the step's top corner 0.3 mm before the floor in the ground sweep. That creep is too slow to survive the 1/1024 m position rounding. The corner reads as a steep slope, so the body stayed airborne, at rest on the floor: no ground friction (the creep never died), air regen, the air spread. A bot waits to be grounded before it "arrives", so it hovered there for 25 s. Now, when the first contact is steep and walkable ground lies within 1 cm under it (the wedge rule's tolerance), the body stands on that ground. At air 20 every sim golden is bit-identical with the fix; `movement.test.ts` covers both sides of a step.
- **Bots, approach legs (`navigator.ts`, `graph.ts`):** from the air, a plan starts with a straight flight to the nearest node within 8 m, whatever was between. Falling down the right face of movement-test's tower, the nearest was on the platform behind the tower: the bot hovered against the wall until the stall timeout, and the replan chose the same node. Now the approach goes to the nearest node in a clear line (one-way platforms don't block), then one farther afield, then the nearest whatever's between. The node whose approach gave up is skipped until the bot stands on the graph again.
- **Bots, shots at the edge of reach (`brain.ts`):** reach was checked from where the bodies are when the bot thinks, but the shot leaves after the tick's move. A dash or a step out at the range's edge carried about 0.5% of shots beyond reach on mechanics-test. That was already seed noise at air 20 (3 of 20 seeds over the soak's 1% line). Reach is now the worse of now and one tick on.
- **Measured** (`probe-air`, not committed; the soak test's setups over many seeds; arsenal B: movement-test, game seeds 31+k, pops 77+k; local play: mechanics-test, an idle human and three Hard bots, seeds 1234+k):

  | | Arsenal B, 30 seeds: stuck (mean · worst · seeds over 1%) | Local play, 20 seeds: shots beyond reach (mean · worst · seeds over 1%) |
  |---|---|---|
  | main, air 20 | 0.05% · 0.65% · 0 | 0.46% · 1.81% · 3 |
  | main, air 32 | 0.17% · 2.22% · 2 (both at the 0.2 m step) | 0.60% · 1.63% · 4 |
  | this branch, air 32 | **0.01% · 0.11% · 0** | **0.06% · 0.32% · 0** |
  | this branch, air 20 | 0.05% · 0.49% · 0 | 0.04% · 0.36% · 0 |

- **Goldens:** at air 20, every sim and bot golden and both closed-loop replays are bit-identical with all three fixes, so what moved comes from air control alone. At 32: 19 of 20 sim goldens (shield has no airborne steering), the regenerated `mech-events` and `mech-zones` replays (closed-loop scenarios), and the 3 bot goldens. Replays with dummies diverge at tick 0: the strafing dummy spawns airborne and steers.

## 43. The live box's snapshot gaps after the fixes (23 Oct 2026, QA: "bullets, lag, touch", L)

QA had measured gaps over 250 ms in the live box's WebTransport datagrams 2–8 times a minute, and a 471–539 ms gap mid-match in each of 3 sessions. After §38–§40 went live (01:54), a headless player (`scripts/live-gaps.ts`, docs/net-trial.md §4.1) joined three fresh rooms on the box from the dev Mac (RTT ~100 ms), with the box's bots, for 5 minutes each. Run 2 was cut short at 3.8 minutes when `mf-game` restarted (a deploy).
- **Server:** every 10 s report across all three windows shows 599–601 ticks, a `max` tick of 8.7 ms at most and no dropped ticks. The gateway logged nothing. **No gap lines up with a server stall.**
- **Gaps of 250 ms or more:** 10 in 13.7 minutes (0.73 a minute).
  - **5 were loss bursts** (runs 1 and 2): 11, 14, 15, 20 and 22 snapshots lost in a row (0.4–0.9 s), arriving on time either side. Loss was 1.83% and 1.03% in those runs, mostly in such bursts; run 3 lost 0.07%. That is the path.
  - **5 arrived late with nothing lost** (run 3): 0.26–0.54 s, four of them within 2 s. After each, the held snapshots came in a burst within a few ms, which is a queue on the path (Wi-Fi or radio retransmissions, bufferbloat) or the measuring Mac pausing. The server's ticks ran on time throughout.
- **The startup nav build** (1.1–1.2 s for Street Market) runs before the server accepts players. A restart's other maps then build between ticks: "nav builds 2045 ms between ticks" in the first 10 s, with the tick log unaffected.
- **Fixed with this:** the 10 s report said "nav builds 2 ms between ticks" with nothing to build: it counted the idle hook's own overhead. It now counts only time spent building.

## 44. Onboarding, phase 1: on-device facts and the event log (23 Oct 2026, owner request)
The owner, 23 Oct: "curate an onboarding tour experience per user". The spec is docs/design/onboarding-research.md, and this is its phase 1 (§5 facts, §6.1 events). The design is the Pen board "ONBOARDING · tour and spotlight" plus card 09 on AGENT BRIDGE.
- **`apps/web/src/tour/log.ts`:** an on-device ring buffer of every §6.1 event (`mf.log.v1`, ≤ 50 KB; the oldest are dropped first). Failing storage, as in private mode, keeps the log for the session. `funnel()` gives per-step counts and the median time.
  - **No upload:** `UPLOAD_ENABLED` is false and there's no endpoint. Sending onboarding events to our API is the owner's opt-in decision (§8.2), and there is no holdout.
- **`apps/web/src/tour/facts.ts`:** what Next orders and the hints will read (`mf.facts.v1`): devices, the Briefing answer, tour progress, matches, kills, deaths by cause, moves used, screens visited, rooms, the creator saved, touch counters and cards. `reduceFacts` is pure.
- **`apps/web/src/tour/track.ts` and `tour/index.ts`:** the shell's store and the sim events feed them:
  - a session;
  - each match from GO to its end or a leave (kills, deaths by cause, dash, grenade, melee and gun pickups);
  - the first kill ever, timed from the title press;
  - rooms made, joined or local;
  - the Locker, the Creator, the Armory and Settings tabs;
  - the device (a pad from its first button);
  - "Create your soldier" saved.
- **`?tourlog`:** shows the First flight funnel, the facts and the last events on the page (`tour/readout.ts`). In dev, `window.__tour` holds the memory.

## 45. Onboarding, phase 2: the spotlight (23 Oct 2026, owner request)
The owner's "button clip-paths that circle things and tell you what to use". This is docs/design/onboarding-research.md §4 and §7 phase 2; the design is the Pen board "ONBOARDING · tour and spotlight".
- **What it is:** `apps/web/src/ui/spotlight.ts` (the `Spotlight` class), `ui/spotlight.css` and `ui/useSpotlight.ts` (for React).
- **The dim:** a full-screen layer with an **even-odd `clip-path: path()` hole** per target. The clipped-out hole isn't hit-tested, so:
  - with `block: 'outside'` (menus), the dim blocks every click except in the hole, which reaches the target; focus goes to the target, Tab cycles it and the callout, and Escape skips the pass;
  - with `block: 'none'` (play), the dim takes no pointer at all.
- **The volt range-finder ring:** brass corner ticks, moved by transform, and a 1.4 s pulse that plays 3 times.
- **The Frost callout:**
  - its content: an eyebrow with progress pips, a title, a body line, the player's own key caps, Skip, Skip training and an optional primary;
  - it's placed beside the target and clear of it, flipped and shifted to stay inside the safe box; on phones it prefers top-centre;
  - a polite live region announces each step.
- **Every hole uses the same command list** (`M H A V A H A V A Z`), so the menus' clip-path transition interpolates.
- **Performance:**
  - the path is rewritten only when a hole moves more than 2 px;
  - there's no animation loop: DOM targets re-measure on their ResizeObserver, on window resize or scroll, and when a transition on the target or an ancestor ends; world targets re-measure on `update()` from the game loop.
- **Accessibility:**
  - Reduce motion is opacity only;
  - Reduce transparency and Low graphics get a solid callout;
  - the dim never blurs.
- **Hooks:** the desktop HUD's plates carry `data-tour="fuel|dash|belt|ammo|clock|scores"`.
- **Asked of the phone agent** in touch-interfaces.md: `touchControlRect(id)`, `onTouchAction`, and the phone HUD's `data-tour` hooks.
- **Checks:** `apps/web/scripts/spotlight-check.mjs <dev server> [dir]` runs in headless Chrome on the real app at 1280×720, 2560×1440, 812×375 and on the turned upright phone. It checks:
  - the ring lines up with the target within 1 px;
  - blocking, a click outside reaches nothing and a click inside reaches the target (elementFromPoint and real clicks); not blocking, everything is reachable;
  - no animation frames are requested while it stands still;
  - focus, Tab, Escape and the live region;
  - Reduce motion;
  - at 150 % text the callout stays clear of the hole.

## 46. Character feel: no pose pops, and a switch that dips instead of reaching (23 Oct 2026, the owner: "the 3D rigging … smoother")

Spec: docs/design/character-feel-research.md §3.3, §5.1 A, §9. Animation only: the sim, its goldens and the wire are untouched.

- **Inertialization (`render3d/inertia.ts`):** when what the upper body does changes (the gun in hand, the dual toggle, the aim poses' set, the shield, a melee swing, a switch's phases: `Avatar.poseKey`), every upper-body bone keeps the rotation it had and eases onto its new pose: a spring offset (Holden's critically damped spring, half-life 80 ms) decaying on the final local rotation. A respawn is a teleport and isn't eased. All eased bones are in the avatar's `posed` restore list (the mixer skips unchanged values).
- **An aimed gun stays on the aim.** Its hand eases in world space instead (`WorldEase`), as fast as a 13°-a-frame turn allows (half-life 30–80 ms), then is exact: the barrel within 0.5° of the aim from about 0.3 s after a change.
- **The switch, rebuilt (`Avatar.carry`, `sling.ts`):** chibi arms can't reach the back sling (0.49 m from the shoulder) or the thigh holster (0.39 m; the arm reaches 0.27 m), so the old carry stretched the arm at points it couldn't reach and flipped the elbow (110°+ in one frame). Now the whole gun arm, as the aim layer holds it, turns down about the shoulder in the aim's plane (40° for a 0.25 s pistol draw, up to 65° for slower switches, never below low ready), the guns change over at the dip, and each gun flies the last bit between the hand and the body in 0.1 s (`Handoff`) instead of appearing there. The hand leaves and reaches the aim slowly (smootherstep, biased toward the bent arm).
- **Measured** (`render3d/test/feel.test.ts`; the largest change of any bone's local rotation in one frame at 60 Hz):

  | Change | main | now |
  |---|---|---|
  | K-47 → Hammer switch | `hand_L` 150° in one frame; the carry 40–110°/frame | ≤ 18° (`hand_L` easing off the foregrip) |
  | Hammer → K-47 switch | 150°; carry up to 71°/frame | ≤ 17° |
  | Rifle dropped / picked up | 150° (`hand_L`) | ≤ 17° |
  | Pistol dropped | 99° (`upperarm_R`) | ≤ 11° |
  | Shield up or down | 64° (`upperarm_L`) | ≤ 7° |
  | Dual on | 134° (`hand_L`) | ≤ 16° |

  Every switch in the test matrix (7 weapon pairs × level, up, down and facing left × standing and running) stays under 20°/frame and settles within 0.3 s of its end. Frame strips: docs/screenshots/anim-feel/ (`switch`, `switch-back`, `pickup`, `shield`; the lab scenarios of the same names).
- **Reloads and throws show (`render3d/actions.ts`):** the Forge's `reload_rifle` (two-handed guns), `reload_pistol` (one-handed, dual) and `throw` clips, never played before, now play as overrides sampled straight onto their bones after the mixer. Inertialization eases in and out of them, so there's no cross-fade.
  - **Reload timing:** a reload plays while the gun in hand reloads (remote players: while the snapshot's reloading flag shows), timed to the weapon's reload at 0.75–1.6× speed. A longer reload plays the clip's ends at 0.75× and goes back and forth through its middle.
  - **The throw:** it plays on the sim's throw event (`Avatar.threw()`, wired in `Renderer3D.toVfx`). It's the authored right-arm throw mirrored onto the left arm and the spine (the rig's left and right frames mirror as x, −y, −z, w), so the gun hand stays on the aim. It starts 0.12 s into its clip because the event is the release.
  - **Measured:** the upper body moves ≥ 15° (up to 150°) during every reload, and the barrel is back within 2° of the aim 0.15 s after.
- **The death beat (`render3d/death.ts`):** a soldier no longer vanishes on its death frame.
  - **The collapse:** 0.4 s. The knees give first (the hips drop 17 cm over planted feet), then the torso folds and the head trails, with a small settle. The gun dips muzzle-down. A soldier killed in the air drops to the floor under it.
  - **The fade:** then a 0.25 s ordered-dither dissolve, and it's hidden until the respawn.
  - **The dissolve** is a uniform branch compiled into the dye and outline shaders (`dyeDissolve`), so no new shader program links. A dying soldier gets its own outline copy, which shares the program.
  - **One setting:** `AvatarKit.deathStyle` (`'collapse'` by default, the doc's option (a); `'vanish'` brings back the old instant hide). The owner's call (§6 ask 2) is still open.
  - **Respawns:** the motion and inertia now start afresh at the respawn (`revive()`), not at the death frame.
- **Motion capture (`art/pipeline/mocap.py`, `mocap_clips.py`; the owner approved the free sources on 23 Oct):** a numpy pipeline, not Blender.
  - **Read** BVH, ASF/AMC and glTF.
  - **Retarget** onto shared-v1 by matching each bone's direction and twist frame against the rig's rest.
  - **Plant** the feet by IK (held, or marching like `clips.gait`).
  - **Stylize:** stand the spine and head up, and push arms and spine ×1.3.
  - **Append** LINEAR clips to `rookie_anims.glb`, keeping the other 36 byte for byte.
  - **The clips:** a planted `walk` replaces W8's unplanted one (100STYLE's neutral walk on a 0.4 s cycle, feet down 55% at 1.2 m/s), plus `idle_shift` and `idle_look` (CMU 140_07 and 140_06) for the idle variants.
  - **Licences:** raw data stays out of the repo; sources are in `art/README.md` "Motion capture" and the credits at `/licenses/motion-data.txt`.
  - **Walk-band skate** (contact foot speed / ground speed): 1.0 m/s 81% → 8%, 1.5 m/s 76% → 3%. 2–5 m/s is the run blend, left for the foot-skate PR.
- **The turn step (`locomotion.ts` `TurnClock`, `FootPlanter` step, `motion.ts` `TURN_LEAD`, `inertia.ts` `RollEase`):**
  - **The yaw** eases in and out (smootherstep) over 0.1 s for the full 120° through facing the camera, instead of a constant 1,500°/s. Turning back mid-turn starts from wherever the body is.
  - **The feet, standing (below 0.3 m/s):** each foot steps from where it stood to its new spot within 0.2 s, lifted 4 cm. The foot already toward the new facing stays down while the other steps first, then it steps. The hips dip 1.5 cm.
  - **The chest and head lead the hips:** an underdamped spring on the facing yaw (ω 42, ζ 0.7) gives about 3% overshoot. In the air there's no step, but a roll of up to 6° into the turn.
  - **The gun's roll:** when the facing flips, the gun's top flips side. It now rolls over about the barrel under 20° a frame, while the barrel stays on the aim.
  - **Measured (standing turn):** each foot slid 0.34 m on the floor before; now 0 cm on the floor, each foot moving only while lifted, both down within 0.2 s. The yaw changes 4°/frame at both ends; it was 25°/frame flat out. Aiming across the top, `hand_R` flipped 156° in a frame; now ≤ 17°.
- **Stylized timing (`motion.ts` `TIMING`, `landingDip`, `takeoffDip`; `locomotion.ts` `TAKEOFF`):** anticipation and follow-through on the procedural signals, never on the aim.
  - **Take-off:** a jet take-off dips the hips 3.5 cm over its first 0.1 s as it pushes off. The climb pose then comes in on a fast spring.
  - **The landing attack:** the hips reach the dip over 3 frames at one rate (no knee over 15° a frame), then come up on an underdamped spring (ζ 0.67) with a ~6% rebound. The land clip ramps in over the same 3 frames at up to 0.6 weight.
  - **Follow-through:** the lean settles on an underdamped spring (ζ 0.72), and the head trails the lean and swings through it. A dash coils against its direction for 35 ms, then stretches past its pose and settles (ζ 0.62).
  - **Measured:** the climb pose at 90% came 417 ms after leaving the ground; now 183 ms. A 10 m/s landing's knee turned 31° in one frame; now ≤ 14° a frame, at the bottom in 3 frames, with a 6% rebound.
  - **Trade-off:** that rate limit makes the landing shallower than main's: the hips drop at most 9% of the head's height (main: 14%).

## 47. Looks on the wire, avatars and the VS poster (23 Oct 2026, the owner: "the character card with the face … the profile of the gamer", "a VS and like a poster before the game")

**What the owner sees:** everyone's soldier looks the way its player made it, on every screen. A player's avatar is their own soldier: lobby rows, the scoreboard, results. When a match starts, a VS poster shows every fighter in their real look for about 2 s, inside the usual 5 s countdown, then folds into a strip at the top while 3-2-1 and GO play as before.

- **Looks on the wire (protocol v19, PR #195; docs/05 §6, docs/04 §5):** a look is its cosmetic wire ids. It travels in the join ticket, the HELLO, a SetLook CMD and ROSTER's new tail, never in snapshots. The server holds each look to the body's fit and to what the player has unlocked (content `admitLook`). Bots wear seeded looks (`botLook`).
- **Portraits (`apps/web/src/portrait/`, research §7):**
  - The player's real soldier, rendered on the device through the game's own WebGL context (one assembler shared with the 3D view) into a 4× MSAA render target, read back with `readRenderTargetPixelsAsync`, and kept as WebP.
  - Sizes: 64/128/256 head-and-shoulders, and 512×768 full body for the poster.
  - Cached by look hash in memory (96) and Cache Storage (`mf-portraits-v1`), keyed by the art's manifests too.
  - Rendering runs freely in menus and lobbies, and under the poster. It never runs mid-fight; while dead, one job at a time.
  - A team-tinted silhouette with the initial shows until the picture lands (120 ms cross-fade, none under Reduce motion).
  - `getAvatar(look)` / `peekAvatar` is for the friends list (social).
- **The poster (`apps/web/src/presentation/`, research §8; Pen board "MATCH PRESENTATION · avatars, teams, VS"):**
  - It replaces the map intro and the "Match 1" beat. It comes in as the countdown starts and holds to 1.6 s.
  - It folds by 2.0 s into the strip (map, rules, faces).
  - Any key or tap folds it early.
  - Layouts are data (`vsLayout`): ALL VS ALL in one row (2–8) or two rows (9–16), and a 1v1 duel with a big VS. Team layouts (4v4, 4v4v4, 2v2v2v2) render for when team modes exist.
  - The lobby warms everyone's avatar and poster render (`warmRoomPortraits`), so the countdown only shows pictures.
- **Not yet:** team modes (the sim has free-for-all only), the art pipeline's pre-rendered portrait atlas (the middle fallback), the poster sound (the audio agent's), the female body's own rig (she draws on the male rig until her art lands).
- **Checks:** dev-only `vsposter.html` (`?n=`, `?teams=`, `?state=poster|strip|lobby`, `?phone`). Shots come from `apps/web/scripts/vs-shots.mjs`, `portrait-renders.mjs` and `looks-shots.mjs` (two players through a playtest link: B's lobby wears A's soldier).

- **Foot skate through the run band (`locomotion.ts` `FootPlanter`, `FEET.contact`…`clearance`):** the planter also holds a foot that's on the floor near its stance, whatever the phase says.
  - **Why:** a sprint's foot comes down a frame early, and through the walk-run blend the walk's long stance keeps the foot down after the blended stance ends. Both used to slide while the hold faded.
  - **Where:** flat ground only. Past its stance, a held foot is kept only while the leg reaches it comfortably (a foot left far behind would drag the hips down).
  - **Letting go:** follows the foot's own lift and swing, closing the gap at no more than 1.5 m/s.
  - **Swing clearance:** a swinging foot clears the floor by 3 cm at mid-swing, eased in and out (forward gaits only).
  - **feet.test.ts:** "extra foot motion" now counts only frames off the floor; on the floor a planted foot is meant to stop dead, and `slide` checks that. The held-height check uses firm holds (> 0.9).
  - **Measured** (contact-foot speed / ground speed, the lowest foot within 1.5 cm of the floor in two frames running):

    | Speed (m/s) | 0.5 | 1.0 | 1.5 | 1.8 | 2.0 | 2.5 | 3.5 | 5 |
    |---|---|---|---|---|---|---|---|---|
    | main | 2% | 81% | 76% | — | 44% | 37% | 19% | 20% |
    | now | 0% | 0% | 0% | 1% | 16% | 21% | 4% | 6% |

    2.0 and 2.5 m/s are above §9's 15%: what's left is lift-off and touch-down frames within 1.5 cm of the floor through the walk-run blend.
  - **The walk slot:** the Forge can replace `walk` with a hand-keyed planted cycle (`clips.gait()`); the locomotion measures whatever clip is named `walk`.

## 48. Tall maps, phase 1: tiers, updrafts, a soft ceiling and the vertical test map (23 Oct 2026, the owner: "very big maps with vertical layers")

The owner's 18 Oct decision, green-lit 23 Oct: battle zones stacked higher and higher that players fly up to and drop back down from. Phase 1 is the tech, on a greybox (`vertical-test`); the first real map (Fog Stair, the owner's pick) builds on it. No protocol change: the wire already carries a tall map (below), and everything new is map content, which CONTENT_HASH covers.

- **Tiers (`MapDef.tiers`, bottom to top, at least two):** each is an id, a HUD name and a floor line. `tierIndexAt(map, y)` (content `maps/tiers.ts`) puts feet from 1.5 m under a line up to the next on that tier.
  - **Respawns spread across tiers** (sim `Game.respawn`): only spawns on the tiers with the fewest living players count, then the farthest from everyone as before. A map without tiers takes the old path, so every golden is unchanged.
- **New zone kinds** (content `ZONE_KINDS`; the 2D overlay and 3D volumes draw them like any zone):
  - `updraft`: wind [0, 26] with drag 0.9 (fliers drift up at about 6.7 m/s with no jet, the default gravity being 20) and refuelling at 3×. A free way up, but slow and in plain sight.
  - `thinAir`: the soft ceiling. Jetpacks cut out and wind [0, −14] pushes you back down. The hard ceiling stays a solid.
- **Floor rules:** unchanged. Falling below `bounds.minY + 0.5` kills, credited to the last attacker within the window. A tall map closes its floor (the street is solid), so only a pit you build kills.
- **Pickup pools for tiers:** `common` (everyday guns) and `power` (the power weapons), alongside `weapons` (both).
- **`vertical-test`** (200 × 108 m, symmetric): streets (y 0) with arcades under three towers → rooftops (y 20) with footbridges → five high platforms (y 42) → a sky deck (y 66) with slab wings. Thin air starts at y 82; the ceiling is at y 100.
  - A full tank climbs about 18–25 m, so one tier costs most of it (a test: from the street a full tank reaches the roofs but never the high tier).
  - Perches every 11–12 m make the climb in hops. They also let the bots' air links (≤ 12.5 m up) cross it.
  - Updrafts lift you from the outer streets to the high tier, and from over the bridges past the sky deck's wings.
  - Pickups reward the climb: grenades and everyday guns low, shields on the bridges, power weapons high, and two power spots on the sky deck.
  - Every one-way is a slab (`blocksBullets`). The arcade legs and the platforms' struts are bullet-only posts.
  - Tests: sim `tiers.test.ts` covers slabs from both sides, every solid and post from both sides, the climb, the updraft, thin air and the respawn spread. Content `tallMaps.test.ts` covers the tiers, the zones, the pools and the map's promises.
- **Large-map limits, checked:**
  - Sim: the collision grid is 4 m cells over the bounds (vertical-test: 51 × 27 cells).
  - Positions on the wire are 24-bit at 1/1024 m (±8 km). SOUND events are the limit: 8-bit cells of 4 m, so ±508 m. protocol `bigMaps.test.ts` holds every map to ±500 m and checks a shot heard from each corner of a 1 km map.
- **Nav graph:** nodes on the map's roof (the top of its ceiling, at `bounds.maxY`) are no longer flown to or from: the ceiling seals them off. Every shipped map's graph is byte-identical with and without the change, so no bot golden moved. It cut 25–60% of the probe's steps on the demo maps.
- **Bots on vertical-test** (30 seeds × 3 min, 6 bots, two of each level, pickups on):
  - stuck 0.002% (worst 1 s);
  - 40.6 kills a run;
  - 292 m/bot/min;
  - 1 shot beyond reach in 28,873;
  - time on tiers: streets 30%, rooftops 55%, high 13%, sky deck 3%.



## 49. Tall maps on screen: the minimap, the flight lean, and the nav graph in a worker (23 Oct 2026, the owner: "what of mini maps so people don't get lost")

No protocol change. Everything is client-side, and every map gets the minimap, not only tall ones.

### The minimap (`apps/web/src/minimap`)
- **What it shows:** the whole level side-on, in the HUD's top-left corner.
  - The level: solids, slabs (fly up, drop through), updrafts as volt columns, thin air hatched, and tier bands.
  - **Your tier:** the rail down the left edge, and the header's name plus n/N ("ROOFTOPS 2/4"). Maps without tiers show their name.
  - You as a chevron the way you aim, the rect of what's on your screen, pickups (power weapons brass diamonds, guns squares, items dots), and allies (team modes: `setAllies`).
- **Enemies, only as legitimately known (`EnemyIntel`, no wallhacks):**
  - In sight: on your own screen this frame.
  - **Last seen:** a hollow mark where an enemy left the screen, went into smoke or died. It fades over 5 s and doesn't follow them.
  - **Heard:** a ring for off-screen gunfire and blasts at a 4 m spot, fading over 3 s. Online it's the server's SOUND events (onlineMode → `Renderer.onSounds`). Local play coarsens its exact shots the same way, so the minimap never knows more than an online client.
- **The big map:**
  - Opened by **M** (Settings → Controls → Big map), a **tap** on the minimap on a phone, or a **double tap of View / Share** on a pad (`PadHost.toggleMap`; a single tap still reaches the overlay buttons).
  - Drag pans; the wheel, a pinch, + and − zoom (up to 6×); Fit resets. A key runs along the foot.
- **Phones:**
  - It sits top-left in the safe box, 72 px tall, as wide as the level's shape needs.
  - Every 600 ms it measures the touch controls (`.mf-touch .mf-ctl`) and moves lower or shrinks to 46 px when one is there: the left FIRE, or a player's own layout (`place.ts`, tested).
  - The big map sits between the move dial and the right-hand buttons, pulled clear of any control. Its shade takes no touches, so the thumbs keep playing; Close or the minimap closes it.
  - It dims after 2.5 s with nothing new (the controls' Auto-fade) and lights up on a new tier or a new mark.
- **Accessibility:** Reduce motion stops the rings' pulse. The colour-blind modes recolour enemies and allies, and shapes carry the meaning too. Reduce transparency drops the glass.
- **Cheap:** the level is drawn once per map and size into one canvas; each frame (≤ 30 a second) clears a second canvas and draws the dots.

### The camera leans the way you fly (`camera.ts`)
- **The lean:**
  - Climbing faster than 2 m/s: up, fully at 6 m/s, 45% of the budget.
  - Falling faster than 4 m/s: further down, fully at 14 m/s, 65%.
  - The lean eases at 3/s and follows the Look-ahead setting.
- **The budget (`leanBudget`)** is what the server's AOI covers and this screen doesn't show: the AOI's 35% reticle look-ahead of the 4:3 half-height, plus the height it serves that a wider screen leaves out.
  - On a 4:3 screen that's the reticle look-ahead alone; on a phone in landscape it's about twice that.
  - So nothing new reaches the wire: test/camera.test.ts sweeps every aspect, zoom, view distance, reticle and flight, and steps a climb that turns into a fall frame by frame.
- **Pull-back:** a phone's close view (`viewScale` < 1) eases back out to the zoom level's full view while you climb or fall faster than 5 m/s, then closes in again.

### Training's nav graph in a worker (`navWarm.ts`, `navWorker.ts`)
- While the player is in the menus, a worker builds the training map's graph and posts it back as plain data. The page rebuilds it (bots `navGraphFromData`, about 10 ms) and hands it to the cache (`provideNavGraph`).
- Without workers it builds in idle slices of ≤ 6 ms.
- If training starts first, the bots finish the build there, as before.

### Measured
`apps/web/scripts/tall-map-shots.mjs`; headless Chrome on this Mac's GPU, vertical-test, 6 bots; load 12–20 from other sessions.

| | Desktop 1920×1080 | Phone 812×375, CPU ×4 |
|---|---|---|
| Nav graph before training | worker 519 ms; the page busy ≤ 7.8 ms | worker 410 ms; the page busy ≤ 18 ms |
| Training's start | 232 ms, no long task | 276 ms, one 137 ms task (was **2,857 ms with a 2,001 ms freeze**, `--cold`) |
| Frames, 10–15 s in | p50 16.7 / p90 17.5 ms, 47–49 draws, 76–90K tris | p50 16.5–16.7 / p90 18.8–19.0 ms (Auto → Low), 39 draws, 29–34K tris |
| JS heap | 92 MB | 107–114 MB |

The Street Market under the same phone conditions: p50 16.7 / p90 18.9 ms by 15 s, with long tasks up to 690 ms in its first 5 s (its kit). A tall greybox costs a phone less than the Street Market.

**Snapshots** (`bench-room.ts --map=`, 12 humans): the AOI culls more on a big map.

| Map | Per client | Average snapshot |
|---|---|---|
| movement-test | 4.3 KB/s | 142 B |
| street-market | 3.9 KB/s | 131 B |
| vertical-test | 2.4 KB/s | 79 B |
| fog-stair | 2.3 KB/s | 75 B |

Tick avg 0.05 ms on all four.

## 50. Fog Stair: the first big real map (23 Oct 2026, the owner's pick)

The owner picked **FOG STAIR** from the four places offered (Cloudline, Tin Terraces, Fog Stair, Steel Mirage). It's a mountain city on a river gorge in south-west China: streets where one road's ground floor is the next road's twentieth, long public stairs, a monorail through a tower, rooftop footbridges, and river fog. It's an original place with no real skyline and no lettering; nothing in it is Lagos.

- **The map** (`packages/content/src/maps/fogStair.ts`, 244 × 108 m) is mirrored about the river (x 120), so neither bank holds the high ground.
- **Its four tiers:**
  - **Riverside (y 0):** the quays, the arcades under the two towers, and the river (deep water: slow, floaty; bullets die in it).
  - **The Stairs (y 20):** two 45° public stairs on each bank, and the terrace between them with a shop-house.
  - **Monorail (y 38):** the hilltop lanes, the viaduct over the stairs, a station inside each tower (the track runs through a 5.5 m gap), and the river bridge with a parked car as the only cover over the gorge.
  - **Rooftops (y 62):** the towers' roofs (water tanks, radio masts), the footbridge across the gorge, and the hill pavilions.
  Thin air starts at y 82 and the ceiling is at y 100.
  The painted near towers are hazed 50% toward the fog, so they read as background, never as walls.
- **Getting up:**
  - The stairs are the free way up: slow and in the open.
  - Jets take most of a tank per tier.
  - Balconies every 11–12 m on the towers' faces and a perch on each hill let you climb in hops.
  - Updrafts rise from the river to the monorail bridge and from the hilltops to the pavilions.
- **Pickups pay for the climb:**
  - grenades and everyday guns at the riverside;
  - guns on the terrace and the shop-house roof;
  - shields in the stations, grenades on the hilltops and the monorail car;
  - power weapons on the roof bridge and the pavilions.
- **Its event:** RIVER FOG (`fog`: bullets fall short for 20 s), on a random 75 s cycle at a 60% chance, from 45 s in.
- **Its look** (render3d/environment/places.ts `FOG`, `FOG_STAIR`): kit-less for now (the extruded collision is the play plane, recoloured).
  - Morning overcast from the upper left, weathered concrete, faded tile and brick, green-grey paint, and a dense blue-grey fog.
  - The painted layers come from **the art pipeline at no Forge credit:** `art/pipeline/build_fog_stair_backdrops.py` (Blender, Cycles) renders the far bank (stacked towers up a ridge, a monorail viaduct with a train, a few warm windows) and the near towers (balcony bands, tanks, masts, blank sign boards), both fading into the river fog. `art/pipeline/fog_stair_sky.py` paints the sky. `apps/web/scripts/backdrops.py` grades all three into `assets/backdrops/fog_stair/`.
  - Re-run: render to a raw dir, then `python3 -I apps/web/scripts/backdrops.py apps/web/public/assets/backdrops <raw dir>`.
- **Tests:**
  - content `tallMaps.test.ts`: mirrored, the tiers, the river is water, the fog event, power weapons only on the rooftops, no Lagos words.
  - sim `tiers.test.ts`, for every tall map: every slab from both sides, every solid and post from both sides.
  - bots: the nav and 5-minute soak suites run on it with every registered map.
- **Bots** (30 seeds × 3 min, 6 bots, two of each level):
  - stuck 0.003% (worst 1 s);
  - 34.3 kills a run;
  - 281 m/bot/min;
  - 4 shots beyond reach in 25,960;
  - time on tiers: riverside 25%, stairs 19%, monorail 49%, rooftops 7%.
- **Nav graph:** 832 nodes and 3,864 links, built in 368 ms on this Mac (Street Market: 299 ms, on the same quiet run).
- **Measured** (`tall-map-shots.mjs --map fog-stair`, 6 bots, this Mac's GPU, load 10–17):
  - **Desktop 1920×1080:**
    - The graph was built in a worker (292 ms), and training started in 72 ms.
    - Frames p50 16.7–17.0 / p90 17.7–18.1 ms, 57–108 draws, 89–132K tris.
  - **Phone 812×375, CPU ×4:**
    - Worker 285 ms, and training started in 180 ms.
    - Frames p50 16.7–17.3 / p90 18.3–23.9 ms as Auto steps High → Medium → Low.
    - One 906 ms long task about 10 s in, during Auto's tier changes.
  - **Snapshots:** 2.3 KB/s per client with 12 humans (Street Market: 3.9). The ticks average 0.05 ms.
  - Screenshots: `docs/screenshots/maps-vertical/fog-stair-*`.
- **Next, the art:** a Blender kit for the play plane (the towers, stairs, monorail, station and bridges, like the Street Market's kit) and painted Higgsfield versions of the three layers. Both are asked of the Forge session in the shared notes (`maps-vertical.md`).
