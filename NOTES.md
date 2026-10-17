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

**Hardening (17 Oct, PR #9 review).** The first version let one browser hurt everyone: a single 65,532-byte reliable message dropped the whole bridge (every WebTransport player), unbounded per-session queues let a client that withheld stream credit stall its session (and its CLOSE), quinn's default limits allowed 100+100 streams per connection (one reached ~162 MB), and a hung gateway stayed advertised for ~9 s of dead air. Now:
- **Per session:** browser messages are capped at 4 KB (the WebSocket limit; more closes that session with 4003), datagrams drop when its queue is full, a reliable backlog over 256 KB or a write not taken within 5 s closes it (1013, it may resume), and the game server's CLOSE never waits behind its writes.
- **Per connection:** 4 bidi + 4 uni streams, 64 KB stream / 256 KB connection windows, 64 KB datagram buffers, 15 s idle timeout. **Per node:** 1000 sessions, 8 per IP (`WT_MAX_SESSIONS`, `WT_MAX_SESSIONS_PER_IP`).
- **Liveness:** the game server pings the gateway every second and drops it after 3 s of silence (its players resume, `/health` stops advertising it). The client drops a WebTransport session silent for 1.5 s and resumes straight over WebSocket.
- **Ops (docs/09 §8):** one gateway per node routes by path (`WT_ROUTES=/wt/1=…/gs1.sock,…`); SIGTERM drains (sessions close with 1001 and resume); SIGHUP or a changed file reloads `WT_CERT`/`WT_KEY`; a self-signed certificate renews a day before its 13 days run out and the servers advertise the new hash. Bad settings (a certificate without a key, a non-https or query-carrying public URL) stop it at startup.
- **Bridge hygiene:** the socket is 0600 in a private 0700 directory (dev default: `$XDG_RUNTIME_DIR` or the temp dir, `military-forge/wt-<port>.sock`, the same path in both programs); only a stale socket is ever removed; INFO is escaped on one side and validated on the other; one gateway at a time; a bridge that can't listen leaves the server WebSocket-only instead of failing to start.
- **Tests:** `apps/wt-gateway/tests/gateway.rs` (real QUIC clients against the gateway code and a fake game server: oversized message, withheld credit, backlog, caps, routes, datagrams, lost server, drain) and `apps/game-server/test/gateway.e2e.test.ts`, the Rust↔TypeScript contract (the release binaries against the real bridge, with `wt-probe` as the browser; CI's wt-gateway job runs it). Against the pre-fix gateway that test fails: the oversized message closes the other player with 1001.
