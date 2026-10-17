# 02 — Physics & Movement Spec

> Scope: everything that moves on the gameplay plane: players, jetpacks, bullets, rockets, grenades, explosions, hitboxes, ragdolls.
> Decision recap: **2.5D**. Everything is rendered in 3D, but all gameplay happens on the plane `z = 0`. Collision and simulation are **2D**.
> Every number here is a **starting tuning value**. They live in `packages/content/tuning.json`, can be hot-reloaded in dev, and are versioned with the protocol.

---

## 1. Principles

1. **One simulation, two runtimes.** The same TypeScript sim package (`packages/sim`) runs on the server (authoritative) and in the browser (prediction). The sim has no DOM, no `Math.random`, no `Date.now`, and no allocation in the hot path.
2. **Fixed timestep.** The sim only advances in whole ticks. Rendering interpolates between ticks.
3. **Custom kinematic physics, not a general rigid-body engine,** for anything gameplay-relevant (players, projectiles, grenades). Movement feel *is* the game, and a custom controller gives exact control, tiny size and cheap rewinds. A general engine (Rapier 2D/3D) is used **client-side only** for cosmetic debris if wanted.
4. **Quantize at the end of every tick.** Authoritative state is snapped to network precision on both client and server, so a client re-simulating from a server snapshot starts from bit-identical numbers (see §15).
5. **Server is the only judge.** Clients send *inputs*, never positions, hits or damage.

---

## 2. Units & coordinate system

| Thing | Convention |
|---|---|
| Length | 1 unit = 1 metre |
| Time | seconds in config, **ticks** in the sim |
| Axes | +X right, +Y up, +Z toward the camera (Three.js right-handed) |
| Gameplay plane | `z = 0`. Collision geometry is 2D; render geometry is extruded/decorated in Z |
| Angles | radians in the sim; aim angle sent over the network as `u16` (0..65535 ↔ 0..2π, ≈0.0055° resolution) |
| Map bounds | ≤ 512 m × 256 m (standard maps ~120×60 m; BR map ~480×140 m); positions are quantised to 1/1024 m (§15), i.e. ~19–20 bits per axis on the wire |

Character scale is chibi: big head, short body.

---

## 3. Simulation clock

```
TICK_RATE      = 60 Hz        // sim step, client + server
DT             = 1/60 s       // 16.667 ms
SNAPSHOT_RATE  = 30 Hz        // server → client (rooms); 20 Hz in BR with AOI
INPUT_SEND     = 60 Hz        // client → server, each packet carries last 3 inputs (redundancy)
MAX_CATCHUP    = 5 ticks      // client: never run more than 5 sim steps per frame (spiral-of-death guard)
```

Client loop (render-rate independent):

```ts
accumulator += frameDeltaSeconds * timeScale;      // timeScale ∈ [0.95, 1.05] for clock-sync nudging (see 05-netcode)
let steps = 0;
while (accumulator >= DT && steps < MAX_CATCHUP) {
  const input = inputSampler.sample(currentTick);  // sampled ONCE per tick, stored in input ring buffer
  sim.step(input);                                  // predicted local player + predicted projectiles
  net.sendInput(currentTick, input);
  accumulator -= DT; currentTick++; steps++;
}
const alpha = accumulator / DT;                     // render interpolation factor for the local player
renderer.render(alpha);
```

Server loop: a high-resolution loop (`setImmediate` + `process.hrtime.bigint()` drift correction; *not* plain `setInterval`) steps **every room on the process** once per tick, then serializes snapshots on every 2nd tick.

---

## 4. World collision representation

Maps are authored as **closed polygons** (solid regions) in the map editor (see 01-game-design §7 and 11-rendering §2), then compiled to:

```ts
interface CollisionWorld {
  segments: Float64Array;   // [ax, ay, bx, by] * N   (world-space edges of solid polygons)
  normals:  Float64Array;   // [nx, ny] * N           (outward unit normal, precomputed)
  flags:    Uint8Array;     // per segment: SOLID | ONE_WAY | NO_GRAPPLE | BULLET_PASS | KILL | BOUNCY ...
  material: Uint8Array;     // per segment: concrete, metal, wood, dirt, glass → impact VFX/SFX, penetration cost
  grid:     UniformGrid;    // broadphase (§5)
  zones:    Zone[];         // axis-aligned/convex trigger volumes: kill, hurt, storm, jump-pad, spawn, no-build
}
```

Segment flags:

| Flag | Behaviour |
|---|---|
| `SOLID` | blocks players, projectiles, grenades, LOS |
| `ONE_WAY` | platform you can fly up through from below; solid only when moving down onto it *and* the feet were above it last tick. Holding **down** for 0.15 s drops through |
| `BULLET_PASS` | chain-link fences, railings: block bodies, not bullets |
| `GLASS` | breakable; HP pool; when destroyed it is removed from the grid (server event) |
| `BOUNCY` | restitution override for grenades (fun maps) |
| `KILL` | instant death on contact (pits, crushers, lava) |

Polygon rules enforced by the map compiler: no self-intersections, no edges shorter than 0.05 m, merge collinear edges, wind CCW so normals point outward. Concave polygons are fine because we collide against **edges**, not convex hulls.

---

## 5. Broadphase

- **Static:** uniform grid, `CELL = 4 m`. Each cell stores segment indices (a segment spanning multiple cells is listed in each). Built once at map load.
- **Ray traversal:** Amanatides–Woo DDA through grid cells. Test segments in each visited cell and stop at the first cell whose nearest hit is inside that cell. Use a per-query `stamp` to avoid testing a segment twice.
- **Dynamic (players, grenades, pickups):** separate spatial hash rebuilt every tick (≤ 100 entities, so a rebuild is cheaper than incremental updates). It is also used for AOI/interest management (05-netcode §9).

Budget: ≤ 0.05 ms per player per tick for movement and ≤ 0.01 ms per hitscan ray on a mid-range server core.

---

## 6. Character body

The collision shape is a **vertical capsule**, which in 2D is a "stadium": a segment plus a radius.

| | Standing | Crouched |
|---|---|---|
| Radius `r` | 0.32 m | 0.32 m |
| Total height `h` | 1.50 m | 1.05 m |
| Feet origin | `(x, y)` = bottom of capsule | same |
| Shoulder / aim pivot | `y + 1.08` | `y + 0.74` |
| Eye (camera focus) | `y + 1.25` | `y + 0.90` |

Standing back up requires a clearance check: a shape-cast of the standing capsule. If it is blocked, the player stays crouched.

### Hitboxes (separate from the collision capsule, used for damage only)

| Zone | Shape | Standing centre | Size | Damage multiplier |
|---|---|---|---|---|
| Head | circle | `(x, y+1.24)` | r = 0.24 | **×1.5** (+50%; a sniper's 75 becomes 112 = one-shot headshot) |
| Torso | capsule | `y+0.45 → y+0.95` | r = 0.30 | ×1.0 |
| Legs | capsule | `y+0.10 → y+0.45` | r = 0.22 | ×1.0 (a separate zone only for telemetry and hit VFX) |

Hitboxes follow the **animation-independent** pose, so the server never needs skeletal animation. They shift with crouch and flip with facing. The chibi head is large on purpose: a big head target rewards precision.

**Crouch rule (a signature genre mechanic):** while crouched, the head tucks down and the **head zone is removed**. Hits there count as torso (×1.0), so crouching denies headshots, which is why crouch-sniping duels feel the way they do. The original also let a crouched head block shots from above. That was a quirk; we keep it only as an optional `classicCrouchCover` custom-room rule.

---

## 7. Movement state machine

```
            ┌──────────────┐  jet pressed & fuel ≥ MIN   ┌──────────────┐
            │   GROUNDED   │ ──────────────────────────▶ │  JETPACKING  │
            │ (walk/crouch)│ ◀── landed ──┐              └──────┬───────┘
            └──────┬───────┘              │      jet released │ fuel = 0
       left ground │                      │                    ▼
            ┌──────▼───────┐              └──────────── ┌──────────────┐
            │   AIRBORNE   │ ◀───────────────────────── │   FALLING    │
            └──────────────┘                            └──────────────┘
Any state ──hp ≤ 0──▶ DEAD (ragdoll, respawn timer) ──▶ SPECTATING/RESPAWNING
BR squads: hp ≤ 0 with alive teammate ──▶ KNOCKED (crawl 1.2 m/s, bleed-out 30 s, revive 5 s)
```

`AIRBORNE` and `FALLING` share physics; the split exists only for animation and audio.

---

## 8. Movement constants (initial tuning)

| Constant | Value | Notes |
|---|---|---|
| `GRAVITY` | 20 m/s² | heavier than real (9.81) for snappy arcs |
| `TERMINAL_VY` | −16 m/s | |
| `WALK_MAX` | 5.0 m/s | |
| `CROUCH_MAX` | 2.2 m/s | crouch = accuracy bonus (03-weapons) |
| `GROUND_ACCEL` | 45 m/s² | reach max speed in ~0.11 s |
| `GROUND_DECEL` | 55 m/s² | no input |
| `GROUND_REVERSE` | 80 m/s² | input opposite to velocity, for crisp turns |
| `AIR_ACCEL` | 20 m/s² | |
| `AIR_MAX_X` | 6.0 m/s | input-driven cap; impulses (explosions, recoil) may exceed it |
| `AIR_DRAG_X` | 1.5 /s | exponential decay of excess horizontal speed above the cap |
| `JET_THRUST` | 38 m/s² | net +18 m/s² against gravity |
| `JET_KICK` | ×1.35 thrust for first 6 ticks | responsive ignition |
| `JET_MAX_VY` | 6.5 m/s | thrust tapers linearly over the last 1.5 m/s before the cap |
| `JET_AIR_MAX_X` | 6.5 m/s | slightly faster sideways while flying |
| `FUEL_MAX` | 100 | the "nitro" bar |
| `FUEL_BURN` | 38 /s | ≈ 2.6 s of continuous flight |
| `FUEL_MIN_IGNITE` | 10 | stops micro-tap hover exploits |
| `FUEL_REGEN_GROUND` / `FUEL_REGEN_DELAY_GROUND` | 35 /s after 0.20 s | full refill in ~2.9 s (the genre feels like ~3–4 s) |
| `FUEL_REGEN_AIR` / `FUEL_REGEN_DELAY_AIR` | 12 /s after 0.45 s | rewards gliding/falling, keeps air fights going |
| `MAX_WALK_SLOPE` | 50° | steeper: slide, no ground accel |
| `STEP_HEIGHT` | 0.20 m | auto step-up for small ledges |
| `GROUND_SNAP` | 0.12 m | stick to the ground when walking down slopes |
| `CEILING_BONK` | `vy = min(vy, 0)` and lose 30% vx | |
| `FALL_DAMAGE` | none | genre convention; maps rely on vertical play. Falling below the map = instant death (`KILL` zone) |
| `HEALTH_MAX` | 100 | |
| `HEALTH_REGEN` | 6 HP/s after 4.0 s without damage | full in ~16 s (passive regen is a genre staple); mode setting, off in BR |
| `RESPAWN_DELAY` | 3.0 s (mode setting 0–10 s) | spawn point chosen away from enemies and armed mines (§17) |
| `KNOCKBACK_CAP` | 18 m/s | applied velocity magnitude cap |
| `RECOIL_PUSH_AIR` | per weapon (e.g. shotgun 3.5 m/s) | airborne only, opposite the aim direction. Enables "shotgun jumps" as a skill expression |

---

## 9. Per-tick player update (shared sim)

```ts
function stepPlayer(p: Player, input: Input, w: CollisionWorld, t: Tuning) {
  // 0. Status
  if (p.state === DEAD) return;
  p.aim = dequantAngle(input.aim);
  p.facing = simCos(p.aim) >= 0 ? 1 : -1;                 // sim trig, never Math.cos (§15)
  wantCrouch(p, input.down && p.grounded, w);                 // includes stand-up clearance check

  // 1. Horizontal intent
  const ix = (input.right ? 1 : 0) - (input.left ? 1 : 0);
  if (p.grounded) {
    const max = p.crouched ? t.CROUCH_MAX : t.WALK_MAX;
    const target = ix * max;
    const reversing = ix !== 0 && Math.sign(p.vx) === -ix;
    const a = ix === 0 ? t.GROUND_DECEL : reversing ? t.GROUND_REVERSE : t.GROUND_ACCEL;
    p.vx = approach(p.vx, target, a * DT);
  } else {
    const cap = p.jetting ? t.JET_AIR_MAX_X : t.AIR_MAX_X;
    const underCap = Math.abs(p.vx) < cap;
    const steeringAgainst = ix !== 0 && Math.sign(p.vx) !== ix;
    if (ix !== 0 && (underCap || steeringAgainst))
      p.vx = approach(p.vx, ix * cap, t.AIR_ACCEL * DT);   // never accelerates past the cap
    if (Math.abs(p.vx) > cap) p.vx *= Math.exp(-t.AIR_DRAG_X * DT);   // bleed impulse excess
  }

  // 2. Jetpack
  const canIgnite = p.fuel >= t.FUEL_MIN_IGNITE || p.jetting;
  p.jetting = input.jet && canIgnite && p.fuel > 0;
  if (p.jetting) {
    p.jetTicks++;
    let thrust = t.JET_THRUST * (p.jetTicks <= 6 ? t.JET_KICK : 1);
    const headroom = t.JET_MAX_VY - p.vy;
    if (headroom < 1.5) thrust *= Math.max(0, headroom / 1.5);  // taper near the cap
    p.vy += thrust * DT;
    p.fuel = Math.max(0, p.fuel - t.FUEL_BURN * DT);
    p.fuelRegenDelay = t.FUEL_REGEN_DELAY_AIR;           // re-armed while burning
    p.grounded = false;
  } else {
    p.jetTicks = 0;
    if (p.grounded) p.fuelRegenDelay = Math.min(p.fuelRegenDelay, t.FUEL_REGEN_DELAY_GROUND);
    if (p.fuelRegenDelay > 0) p.fuelRegenDelay -= DT;
    else p.fuel = Math.min(t.FUEL_MAX, p.fuel + (p.grounded ? t.FUEL_REGEN_GROUND : t.FUEL_REGEN_AIR) * DT);
  }

  // 3. Gravity (not while grounded on walkable ground: prevents slope creep)
  if (!p.grounded) p.vy = Math.max(t.TERMINAL_VY, p.vy - t.GRAVITY * DT);

  // 4. External impulses queued this tick (explosions, melee, recoil): already added to vx/vy, capped
  clampVelocity(p, t.KNOCKBACK_CAP);

  // 5. Integrate with collision
  moveAndSlide(p, p.vx * DT, p.vy * DT, w, t);              // §10

  // 6. Hazards & triggers
  applyZones(p, w);                                          // kill/hurt/jump-pad/storm

  // 7. Quantize (§15)
  quantizePlayer(p);
}
```

---

## 10. Move-and-slide (the core of game feel)

Per tick:

1. **Substep** so that no substep moves more than `0.5 × r` (0.16 m). At the 16 m/s cap that means at most 2 substeps per tick, and usually 1.
2. For each substep:
   1. Advance the position by the substep displacement.
   2. **Collect contacts:** for every segment in nearby grid cells, compute the closest distance between the capsule's inner segment and the edge (segment–segment distance). A contact exists if `dist < r` (with `ONE_WAY` rules applied).
   3. **Resolve** up to 4 iterations. Push out along the contact normal by `(r − dist) + SKIN` (`SKIN = 0.002 m`), using the deepest contact first.
   4. **Clip velocity** against each contact normal: `v -= n * min(0, dot(v, n))` (remove the inward component only, keeping tangential slide).
   5. **Classify the contact:** `n.y ≥ cos(MAX_WALK_SLOPE)` is ground; `n.y ≤ −0.7` is ceiling (bonk); otherwise it is a wall.
3. **Step-up:** if walking into a wall while grounded, try the move again from `y + STEP_HEIGHT`, then snap down. Accept it if the result is grounded and further along.
4. **Ground snap:** if the player was grounded last tick, is not jetting, and `vy ≤ 0`, cast down `GROUND_SNAP`. If it hits walkable ground, place the player on it so walking down ramps doesn't turn into tiny falls.
5. **Moving along the ground:** project horizontal velocity onto the ground tangent so speed is the same on slopes and flat ground.
6. **Corner correction (feel):** if a ceiling contact is within 0.12 m of the capsule's horizontal edge while flying up, nudge sideways instead of bonking. Without this, flying up past ledges feels sticky.

Edge cases to test (each gets a unit test with a fixed seed and an expected final state):
- wedge corners (two walls at < 90°) → must not jitter
- flying into a ceiling at full thrust → no tunnelling, no sticking
- landing on a 49° vs 51° slope
- standing on a `ONE_WAY` platform while another player stands below
- teleport/respawn into overlap → depenetration routine pushes to nearest free point; fall back to spawn safety volume
- 1-tick `ONE_WAY` drop-through then immediate jet
- crouch-walking off a ledge (stays crouched in air? **No**: auto-stand if clearance allows)

---

## 11. Jetpack details beyond thrust

- **Visual/audio states:** `ignite` (first 6 ticks, kick flare), `sustain`, `sputter` (fuel < 15%: flicker VFX + warning beep), `empty` (click sound).
- **Fuel bar UI** shows the regen delay as a faded segment, so players learn the timing.
- **Exploit guards:** `FUEL_MIN_IGNITE` stops toggling between 0 and 1 for infinite hover. Input-rate limits on the server (10-security-and-anticheat) stop macro spam.
- **Mode modifiers** (match settings): `infiniteFuel`, `lowGravity` (g = 10), `noJetpack` (ground-only arenas).
- **Pickup:** "Nitro Boost" refills fuel and grants +50% thrust for 6 s (BR loot / arcade mode).

---

## 12. Impulses, knockback, melee

```
explosionImpulse(p, center, R, maxImpulse):
  d = distance(center, p.torsoCenter)
  if d > R: return
  if raycastSolid(center, p.torsoCenter): impulse *= 0.35     // partial cover softens the blast
  k = 1 − (d / R)²                                             // quadratic falloff
  dir = normalize(p.torsoCenter − center + (0, 0.3))           // slight upward bias = satisfying launches
  p.vx += dir.x * maxImpulse * k ; p.vy += dir.y * maxImpulse * k
  p.grounded = false (if dir.y > 0.2)
```

- **Melee** (dedicated key): a 0.15 s windup, an arc hit test (sector 70°, radius 1.1 m), and 6 m/s knockback. **Damage depends on the weapon held**: pistols 15–25, rifles 30, heavy weapons/sniper 35, shotgun/flamer/laser/saw 40, EMP 50, **machete 100 (one-hit)** (see 03-weapons). Melee bypasses riot shields. Melee kills get their own kill-feed icon.
- **Melee lunge:** each swing adds a short 0.12 s burst of +3.0 m/s in the facing direction (+4.0 with sidearms, +2.0 with heavy weapons), with a 0.6 s cooldown. In older games this was an exploit ("melee to go faster"). Players loved it, so we make it an intentional, bounded movement tech.
- **Recoil push:** applied only when airborne, along `−aimDir × weapon.recoilPushAir`.

---

## 13. Projectiles

Two classes, chosen by weapon data (03-weapons):

### 13.1 Hitscan (rifles, SMGs, pistols, snipers, shotgun pellets)
- Origin: the **shoulder pivot**, not the muzzle. Then:
  - **Muzzle-in-wall guard:** cast shoulder → muzzle. If it hits solid, the shot starts at that hit point. This stops players shooting through walls they are pressed against.
- Ray vs world (grid DDA), then ray vs **lag-compensated** hitboxes (05-netcode §7). The first hit wins.
- Max range per weapon. Damage falloff curve from `falloffStart` to `falloffEnd` (lerp to `minDamageMul`).
- **Penetration (optional per weapon):** each material has a `penetrationCost` (e.g. wood 0.3, metal 1.0, concrete ∞). The weapon has a `penetrationPower`. The ray continues after a wall with damage scaled by `1 − cost/power`.
- **Tracers:** a client cosmetic, drawn from the visual muzzle to the hit point.

### 13.2 Simulated projectiles (rockets, grenades, saw blades, flames, bouncing lasers)
State: `pos, vel, ownerId, weaponId, spawnTick, bounces, fuseTicks, flags`.

Per tick:
1. Apply gravity × `gravityScale` (rocket 0, grenade 1, flame −0.2 so flames float up, saw 0.3).
2. Apply drag.
3. **CCD**: swept circle vs segments, solved analytically (ray vs the segment's Minkowski-inflated capsule). Find the earliest time of impact `t ∈ [0,1]`.
4. On a world hit: `explode | bounce | stick | die` per data.
   - Bounce: `v' = v − (1 + e)(v·n)n`, then scale the tangential part by `(1 − μ)`. Typical grenade `e = 0.45`, `μ = 0.25`. If the post-bounce speed is < 0.6 m/s on a near-floor normal, it **rests/rolls** with rolling friction 6 m/s².
5. On a player hit: swept circle vs hitboxes. Rockets use **current** positions (no rewind) plus "spawn advance" (05-netcode §7.3).
6. Lifetime / fuse / range → expire (and explode if `explodeOnExpire`).

Projectile caps per room: 256 live projectiles. Flamethrower particles are aggregated: one sim projectile per 3 ticks, and the rendered flame is a cosmetic particle system around it.

---

## 14. Grenades & explosions

| | Frag | Proximity mine | Gas | EMP grenade |
|---|---|---|---|---|
| Throw speed | 14 m/s + 40% player vel | 11 m/s, **no gravity** (flies straight, short range: 0.9 s flight) | 13 m/s | 13 m/s |
| Gravity scale | 1.0 | 0 | 1.0 | 1.0 |
| Restitution `e` | 0.45 (bouncy, longest throw) | 0 (**sticks** to any surface) | 0.35 | 0.4 |
| Fuse | **1.6 s** from throw; optional cook mode in custom rooms | arms after 2.0 s. State colours: green = flying, yellow = stuck/arming, flashing red = armed. Triggers on an enemy within 1.6 m (0.25 s beep). A direct hit on a player in flight detonates it. **Can be shot (10 HP), set off by explosions, disarmed by EMP.** Despawns after 180 s | 1.4 s, then a **15 s cloud** | 1.2 s |
| Effect | 110 dmg max, R = 4.0 m, full-damage core 0.8 m, impulse 14 m/s. A crouched victim at full HP survives unless it's directly underneath (crouch → torso-only exposure + 25% blast reduction) | 120 dmg, R = 3.2 m | DoT strongest at the centre: 14 dmg/s core → 4 dmg/s edge, R = 3.5 m. **Flamethrower fire clears the cloud** | **Disables jetpacks for 3 s** in R = 4 m (affects the thrower too). Disarms mines. 0 dmg |
| Self/team damage | yes (team damage per mode rules) | yes | yes | n/a |
| Carry (default) | 3 (spawn loadout), max 5 | 2 | 2 | 2 |

**Carrying & cycling:** one grenade key throws the selected type; a cycle key switches between types you hold. Map pickups give grenades in pairs (a genre convention).

**Throw strength:** desktop is quick-throw (tap = 70% strength) or hold-to-aim (an arc preview shows the predicted path, simulated client-side with the same sim code for 1.5 s ahead). Mobile later: a dedicated grenade button with drag-to-aim.

**Explosion resolution** (server, one tick):
1. Gather players and destructibles within R from the dynamic hash.
2. For each, take the **damage point** = closest point on its torso capsule to the centre.
3. LOS: raycast centre → damage point. If blocked, try the head point. If both are blocked, deal 0 damage (walls protect fully; impulse still applies at 35%).
4. `damage = max × (d ≤ core ? 1 : 1 − ((d − core)/(R − core))^1.5)`.
5. Apply impulses (§12), chain-react barrels after 4 ticks (staggered for drama and for CPU).
6. Emit an `Explosion` event (pos, radius, type) so clients play VFX and screen shake by distance.

---

## 15. Determinism, precision & quantization (the nitty-gritty that saves weeks)

We do **not** need lockstep determinism (the server corrects clients), but we want **client prediction to match the server ~100% of the time**. Every mismatch is a visible correction ("rubber-banding"). Rules:

1. **No transcendental `Math.*` in the sim.** `Math.sin/cos/atan2/exp/pow` may differ in the last bits across V8 (Chrome, Node), JavaScriptCore (Safari, **Bun**) and SpiderMonkey (Firefox). The sim uses its own `simSin/simCos/simAtan2/simExp` (polynomial/minimax + lookup tables). `+ − × ÷` and `Math.sqrt` are IEEE-754 exact everywhere, so they're safe.
2. **Seeded PRNG only** (`xoshiro128**`), seeded per room. Weapon spread uses `hash(roomSeed, tick, shooterId, shotIndex)`, so the client predicts the *exact* same spread pattern as the server. No "my bullet went left, the server's went right" moments.
3. **Quantize the authoritative state at tick end** to the same precision we send:
   - position: **1/1024 m** (≈ 19 bits over a 512 m map). *Changed in Phase 0:* the original 1/128 m rounded the absolute position every tick, which biased walk speed (5 → ~5.16 m/s) and froze anything slower than ~0.23 m/s
   - velocity: **1/1024 m/s** (≈ 20 bits signed)
   - fuel / HP: 1/1024 units (17 bits). A coarse u8 scale distorted burn/regen rates when rounded every tick
   - aim: `u16`
   Quantizing on both sides means a snapshot reconstructs the server's state exactly, so re-simulation is bit-exact.
4. **Iteration order is stable**: entities are processed in ascending ID order, and contacts are sorted by (depth desc, segment index asc).
5. **No floating `-0`/`NaN` leakage**: assertions in debug builds, plus a NaN guard that resets the entity to its last valid state and logs to telemetry.
6. **Desync telemetry**: the client hashes its predicted local state per tick. The server echoes its hash for that tick in the snapshot. We measure the mismatch rate per build (target < 0.5% of ticks outside of collisions with other players).

---

## 16. Ragdolls, gibs & cosmetic physics (client-only)

- On death, the server sends `Death{victim, killer, weapon, impulseDir, impulseMag, hitZone}`.
- The client spawns a **2D Verlet ragdoll**: 11 particles (head, neck, pelvis, 2× elbow, 2× hand, 2× knee, 2× foot) with distance and angle constraints, 4 solver iterations, colliding with world segments. It is mapped onto the 3D skeleton bones each frame. It's cheap, stable and gives classic floppy deaths.
- Headshot kills: helmet/hat pops off as a separate rigid prop (cosmetic flair).
- Shell casings, debris, glass shards: client particles with simple bounce against segments, capped at 300 live, oldest recycled.
- Gore toggle: `off | low | full` (default low; it matters for age ratings and web portals).
- Bodies fade after 4 s (BR: replaced by a loot crate, 08-battle-royale).

---

## 17. Other world objects (post-MVP but designed now)

| Object | Sim treatment |
|---|---|
| Explosive barrel | static body with HP 40; explodes R = 3.5 m, 90 dmg; respawns after 30 s |
| Breakable glass | `GLASS` segments with HP; removal event; rebuilds after round end |
| Jump pad | trigger zone; sets `vy = 14` and keeps vx; 0.3 s cooldown per player |
| Moving platform / elevator | kinematic segments whose position is a pure function `f(tick)`, so they're deterministic with no network sync; players on top inherit velocity |
| Teleporter pair | zone → set position, keep velocity rotated by exit orientation; 1 s cooldown |
| Water | zone: gravity ×0.35, drag 3/s, jetpack disabled, guns can't fire below the surface (optional) |
| Storm (BR) | damage zone with time-varying bounds (08-battle-royale) |

---

## 18. Performance budgets

| | Target |
|---|---|
| Server sim, 16-player room, 60 Hz | ≤ 0.6 ms/tick (≈ 3.6% of one core, **sim only**). Socket I/O and serialization dominate, so real density is **4–8 such rooms/core** (09 §3) |
| Server sim, 40-player BR, 60 Hz | ≤ 2.0 ms/tick sim only → **2–4 BR matches/core** including I/O (09 §3) |
| Client sim (prediction + re-sim of up to 12 ticks on correction) | ≤ 1.0 ms/frame worst case |
| Allocations in the hot path | **zero** (pools, SoA typed arrays) |

Implementation hints: store components as Structure-of-Arrays (`Float64Array` per field, bitECS/Koota style), keep the dynamic hash in flat arrays, and pre-size everything at room creation.

---

## 19. Tuning workflow

1. All constants live in `tuning.json` (zod-validated), and the build stamps `tuningHash` into the protocol handshake. A client with a different hash is refused with "update available".
2. Dev builds have an **in-game tuning panel** (Tweakpane/lil-gui) bound to the live sim, plus "copy JSON" and "replay last 30 s with new values".
3. **Movement test map** with labelled ledges (0.2/0.5/1/2/4 m), slope ramps (30/45/50/55°), corridors, ceilings and one-way platforms. Every PR that touches the sim runs a **golden replay** suite: recorded inputs go in, final states must match the hashes or the PR must update them intentionally.
4. Playtest rule: change one variable at a time, and blind A/B test feel changes with 4+ players.
