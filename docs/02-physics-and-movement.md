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

Polygon rules enforced by the map compiler: no self-intersections, no edges shorter than 0.05 m, merge collinear edges, wind CCW so normals point outward. Concave polygons are fine because we collide against **edges**, not convex hulls. The compiler also warns about a solid thinner than **0.3 m** between two facing edges (`MIN_THICKNESS`; ramps and wedge tips don't count). A thin floor should be a `ONE_WAY` platform. Bodies don't pass through thin solids (§10), but a stray line in a layout usually means a wall that was meant to be thicker. Shipped maps compile without warnings (the thinnest solid is 0.4 m).

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
| `DASH_SPEED` / `DASH_BURST_TICKS` | 14 m/s for 8 ticks (0.13 s) | an 8-way jetpack burst (§21): 2.05 m along the ground, 1.95 m up |
| `DASH_COOLDOWN` / `DASH_FUEL_COST` | 1.0 s / 8 fuel | one air dash per flight; EMP blocks it |
| `DASH_EXIT_UP` | 2 m/s | the most upward speed a dash leaves you with; sideways it leaves you within the walk/air caps |

---

## 9. Per-tick player update (shared sim)

```ts
function stepPlayer(p: Player, input: Input, w: CollisionWorld, t: Tuning) {
  // 0. Status
  if (p.state === DEAD) return;
  p.aim = dequantAngle(input.aim);
  p.facing = simCos(p.aim) >= 0 ? 1 : -1;                 // sim trig, never Math.cos (§15)
  wantCrouch(p, input.down && p.grounded, w);                 // includes stand-up clearance check

  // env = what the map does here (§20): rules × zones at the body centre; null on plain maps
  // 0. Dash (§21): a press starts an 8-way burst if allowed; during it, step 3b sets the velocity
  if (pressed(DASH) && canDash(p, env)) startDash(p, input);
  // 1. Horizontal intent (every cap × weapon weight × env.moveSpeedMul)
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

  // 1b. Map mechanics (§20): pads, then (airborne) dive, wind and drag
  if (env) applyEnvironment(p, env, input);

  // 2. Jetpack (off under env.jetDisabled; burn × env.fuelBurnMul, refill × env.fuelRegenMul)
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

  // 3. Gravity (not while grounded on walkable ground: prevents slope creep); × env.gravityMul (§20)
  if (!p.grounded) p.vy = Math.max(t.TERMINAL_VY, p.vy - t.GRAVITY * DT);
  // 3b. Dash burst (§21): velocity = direction × DASH_SPEED, no gravity; the jetpack is off meanwhile
  if (p.dashTicks > 0) dashVelocity(p);

  // 4. External impulses queued this tick (explosions, melee, recoil): already added to vx/vy, capped
  //    (the cap × env.knockbackMul where that is above 1)
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
   3. **Resolve** up to 4 iterations. Push out along the contact normal by `(r − dist) + SKIN` (`SKIN = 0.002 m`), using the deepest contact first. A contact in front of a face always comes before a contact from behind a face (the core inside a solid, pushed out by `r + dist` along the face normal). A capsule touching the near face of a solid thinner than its radius also reaches the far face from behind, and that contact is always the deeper one, so taking it pushed the body out the far side.
   4. **Clip velocity** against each contact normal: `v -= n * min(0, dot(v, n))` (remove the inward component only, keeping tangential slide).
   5. **Classify the contact:** `n.y ≥ cos(MAX_WALK_SLOPE)` is ground; `n.y ≤ −0.7` is ceiling (bonk); otherwise it is a wall.
3. **Step-up:** if walking into a wall while grounded, try the move again from `y + STEP_HEIGHT`, then snap down. Accept it if the result is grounded and further along.
4. **Ground snap:** if the player was grounded last tick, is not jetting, and `vy ≤ 0`, cast down `GROUND_SNAP`. If it hits walkable ground, place the player on it so walking down ramps doesn't turn into tiny falls.
5. **Moving along the ground:** project horizontal velocity onto the ground tangent so speed is the same on slopes and flat ground.
6. **Corner correction (feel):** if a ceiling contact is within 0.12 m of the capsule's horizontal edge while flying up, nudge sideways instead of bonking. Without this, flying up past ledges feels sticky.

Edge cases to test (each gets a unit test with a fixed seed and an expected final state):
- wedge corners (two walls at < 90°) → must not jitter
- flying into a ceiling at full thrust → no tunnelling, no sticking
- dashing, walking, falling or being launched (36 m/s) into a solid thinner than the capsule radius, down to 1 cm → stops at the near face
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
- **Recoil push** (the "rebound" after a shot): in the air, `v −= aimDir × weapon.recoilPushAir` (so a shotgun fired down is a jump, ~2.5 m from the top of a hop); on the ground, a horizontal slide `vx −= aimDir.x × weapon.recoilPushGround` for the heavy guns only (crouching braces: ×0.5). Two caps keep it a movement trick, not a launcher: recoil never takes |vx| past 0.9 × `launchSpeedX` (so the low launch drag of NOTES §17 stays the blasts'), and a shot fired down never takes the rise past 10 m/s (shells chained downward hover, they don't rocket). Speeds already past either cap (a blast launch) are kept, not cut. Values per weapon: 03 §7; feel targets: NOTES §22.4. Like any push it ends a dash (§21) and the map's knockback multiplier scales it (§20).

---

## 13. Projectiles

Two classes, chosen by weapon data (03-weapons):

### 13.1 Hitscan (rifles, SMGs, pistols, snipers, shotgun pellets)
- Origin: the **shoulder pivot**, not the muzzle. Then:
  - **Muzzle-in-wall guard:** cast shoulder → muzzle. If it hits solid, the shot starts at that hit point. This stops players shooting through walls they are pressed against.
- Ray vs world (grid DDA), then ray vs **lag-compensated** hitboxes (05-netcode §7). The first hit wins.
- Max range per weapon. Damage falloff curve from `falloffStart` to `falloffEnd` (lerp to `minDamageMul`). On maps with mechanics (§20.4), a bullet's range is what the map leaves of it: a map-wide multiplier, and damping zones it crosses use the range up faster.
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

| | Frag | Smoke | Gas | Flashbang | Proximity mine | EMP grenade |
|---|---|---|---|---|---|---|
| Throw speed | 14 m/s + 40% player vel | 13 m/s | 13 m/s | 13 m/s | 11 m/s, **no gravity** for its 0.9 s fuse (flies straight, ~10 m), then it drops; the map's wind, pads and drag act on it like on any grenade | 13 m/s |
| Gravity scale | 1.0 | 1.0 | 1.0 | 1.0 | 0 | 1.0 |
| Restitution `e` | 0.45 (bouncy, longest throw) | 0.35 | 0.35 | 0.4 | 0 (**sticks** to any surface) | 0.4 |
| Fuse | **1.6 s** from throw; optional cook mode in custom rooms | 1.4 s, then a **12 s cloud** | 1.4 s, then a **15 s cloud** | 1.5 s | arms 2.0 s after it **sticks** to the first surface it touches. State colours: green = flying, yellow = arming, flashing red = armed. An enemy body within 1.6 m **in line of sight** starts a 0.25 s beep (the thrower never sets off their own). A direct hit on a player in flight detonates it. **Can be shot (10 HP; whoever empties it gets the kill; a shield's ricochet too), set off by explosions (after 4 ticks: chains stagger), disarmed by EMP.** Despawns 180 s after arming. **3 live per thrower:** a 4th retires its oldest; a player who leaves takes its mines with it | 1.2 s |
| Effect | 110 dmg max, R = 4.0 m, full-damage core 0.8 m, impulse **26 m/s** with a minimum lift of 0.7 (blasts launch in an arc, NOTES §17), the thrower's own blast at 0.6 of it. A crouched victim at full HP survives unless it's directly underneath (crouch → torso-only exposure + 25% blast reduction) | **Blocks vision**, no damage: R = 4 m, opaque inside 85% of it. Grows in from 30% over 1.2 s, thins out and shrinks to 60% over its last 2.5 s (see-through for the last 1.25 s). Bots and aim assist can't see through it. The server doesn't send a player or grenade inside it, behind it or across it to clients that can't see it (inside a cloud you see 1.5 m), and tracers stop at it (05 §9); local mode does the same | DoT strongest at the centre: 14 dmg/s inside a 1 m core → 4 dmg/s at the edge (linear), R = 3.5 m, in 0.25 s pulses. Standing in the middle kills in ~7 s. Grows in from 35% over 1 s, shrinks to 70% over its last 1.5 s. Doesn't block vision. **Flamethrower fire clears the cloud** | **Blinds**, no damage. Per player, strength = distance (full inside 4 m, linear to 0 at 16 m) × facing (1 looking at it, 0.25 looking straight away, by the cosine) × cover (a wall 0.15, smoke 0.5); under 0.08 nothing. Then 2.5 s × strength of **full white** and 1.5 s × strength (at least 0.3 s) of fading out. A longer blindness already running is kept. The blind state is sim state (bots aim off target); during the full white the server sends the victim no other player (05 §9) | 120 dmg, R = 3.2 m (core 0.6 m, impulse 24 m/s, otherwise like the frag) | **Disables jetpacks for 3 s** in R = 4 m to the torso, **through walls** (affects the thrower too; a jet in use cuts out at once; the dash is a jetpack burst, so it is blocked too). Disarms mines (they vanish). 0 dmg |
| Self/team damage | yes (team damage per mode rules) | n/a | yes (the thrower takes 50%) | blinds the thrower too | yes (the thrower takes 50%) | n/a |
| Carry (default) | 3 (spawn loadout), max 5 | max 2 | max 2 | max 2 | max 2 | max 2 |

**Carrying & cycling:** one grenade key (`G`) throws the selected type; a cycle key (`T` / mouse 5) switches to the next type you hold, skipping empty ones and wrapping round. Throwing your last grenade of a type brings up the next type you hold. You spawn with frag ×3 (selected). Map pickups give grenades in pairs (a genre convention): a spawner on the `grenades` pool puts out a pair of one type, picked by the seeded pool draw (frags most often, docs/03 §12), and touching it is `addGrenades(player, type, 2)`: it tops the type up to its carry limit (a full type leaves the pair on the floor) and selects it if your selection is empty.

**Clouds** (smoke, gas): a cloud sits 1 m above where its grenade popped (below any ceiling) and doesn't move. Its radius and density are pure functions of its type and age, so clients draw it from the snapshot (id, type, position, age) exactly as the server sees it. Walls bound every cloud: a point on the far side of a wall from the cloud's centre is not inside it, and the 2D and 3D views stop drawing it there too.

**Flashbang on screen** (client, `apps/web/src/fx`): the local player's blindness (sim state, in the local block) drives a full-screen white-out over the 3D and 2D views, and a muffled-audio hook. Photosensitivity: never more than one full-screen flash per second (other rises ramp in over a second, never by a flash's worth in one frame, and it never clears faster than in half a second), and a **"Reduce flashes"** setting replaces the white with a dark-out just as opaque (≥ 0.96), blurred, so the setting is no advantage. The flashbang's own burst is a small pop and a ring in both views, never a screen-sized flash.

**Throw strength:** desktop is quick-throw (tap = 70% strength) or hold-to-aim (an arc preview shows the predicted path, simulated client-side with the same sim code for 1.5 s ahead). Mobile later: a dedicated grenade button with drag-to-aim.

**Explosion resolution** (server, one tick):
1. Gather players and destructibles within R from the dynamic hash.
2. For each, take the **damage point** = closest point on its torso capsule to the centre.
3. LOS: raycast centre → damage point. If blocked, try the head point. If both are blocked, deal 0 damage (walls protect fully; impulse still applies at 35%).
4. `damage = max × (d ≤ core ? 1 : 1 − ((d − core)/(R − core))^1.5)`.
5. Apply impulses (§12), chain-react barrels after 4 ticks (staggered for drama and for CPU).
6. Emit an `Explosion` event (pos, radius, owner, grenade type) so clients play VFX and screen shake by distance. Smoke and gas don't explode: their cloud appears in the snapshot instead.

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
| Jump pad | **built (§20.2):** a zone with a `launch`; raises your speed along it to at least its length, keeps the rest of your velocity; no cooldown needed (touching it again never stacks) |
| Moving platform / elevator | kinematic segments whose position is a pure function `f(tick)`, so they're deterministic with no network sync; players on top inherit velocity |
| Teleporter pair | zone → set position, keep velocity rotated by exit orientation; 1 s cooldown |
| Water | **built (§20.2)** as the `water` zone: speed caps ×0.6, gravity ×0.45, drag 1.5/s, bullets ×0.4 range. (Jetpack off and no firing below the surface remain options: `jetDisabled` exists; a no-fire zone doesn't yet) |
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

---

## 20. Map mechanics: rules, zones and events

> Owner request: "we'll build maps where some things are thwarted, some there's no gravity, some flights are longer, some bullets don't go far, some things just happen that messes with the mechanics." Built as data in the `MapDef` (packages/content `maps/types.ts`), run by the shared 60 Hz sim (`packages/sim/src/mechanics.ts`, `mapEvents.ts`):
> 1. **Rules** (`MapDef.rules`): map-wide modifiers, e.g. low gravity everywhere on a moon base.
> 2. **Zones** (`MapDef.zones`): areas that change the rules for whatever is inside them.
> 3. **Events** (`MapDef.events`): things that just happen to the whole map for a while, on a seeded schedule (§20.7).

### 20.1 Modifiers

One set of optional fields, used by rules, zones and events alike. Absent = neutral. The map compiler refuses values outside the limits (packages/content `MODIFIER_FIELDS`, which the map editor also reads).

| Field | Effect | Applies to | Limits |
|---|---|---|---|
| `gravityMul` | gravity × this: `0` zero-g, `0.35` low-g, negative pulls **up** (a grounded player lifts off; terminal speed applies in the direction of the pull; resting against a ceiling costs no sideways speed). Reversed gravity needs `dive` > 0, or players are pinned to the ceiling: the map lint refuses it | players, grenades | −2…3 |
| `fuelBurnMul` | jet fuel burned per second: below 1, flights last longer | players | 0…4 |
| `fuelRegenMul` | fuel refill speed, ground and air | players | 0…5 |
| `bulletRangeMul` | map-wide: every hitscan range (and falloff) × this. In a zone: each metre a bullet flies inside it uses up 1/m metres of its range (§20.4) | bullets, pellets | 0.05…4 |
| `moveSpeedMul` | walk, crouch, air and jet speed caps (on top of weapon weight, docs/03 §9) | players | 0.1…3 |
| `knockbackMul` | pushes from blasts, bullets and melee, measured where the target stands; above 1 it also raises the 26 m/s knockback cap, up to the 36 m/s speed limit (§20.3) | players | 0…4 |
| `drag` (1/s) | airborne velocity decays at e^(−drag·t) (water, mud, thick air) | airborne players, grenades | 0…10 |
| `wind` (m/s², [x, y]) | a steady acceleration; walkers keep their footing | airborne players, grenades | ±40 |
| `dive` (m/s²) | holding Down in the air pushes you down, to at most −6.5 m/s: how you get down in zero-g or against reversed gravity | airborne players | 0…60 |
| `jetDisabled` | jetpacks cut out (EMP) | players | true/false |

**Combining.** Multipliers multiply (rules × the running event × every zone the body is in, in map order), drag and wind add, `dive` takes the strongest, `jetDisabled` wins if anything sets it.

### 20.2 Zones

A zone is `{ id, kind, rect: [minX, minY, maxX, maxY] }` or `{ id, kind, points: [x0, y0, …] }` (either winding), plus any modifier fields and, for pads, `launch: [x, y]` (m/s). **`kind` fills in every effect the zone leaves out** from `ZONE_KINDS` (packages/content `maps/mechanics.ts`, part of CONTENT_HASH), and picks its colour. Fields you give override the kind's.

**Who is inside:** a player when its body centre (feet + half its current height) is inside the outline; a grenade by its centre; a bullet for the part of its ray inside (§20.4). Rects are inclusive; polygons use the even-odd rule.

| Kind | Defaults | Feel (`pnpm --filter @military-forge/sim feel`) |
|---|---|---|
| `zeroG` | gravity 0, drag 0.4, dive 14 | a 0.2 s tap drifts on at 4.3 m/s; Down turns it around in 0.3 s |
| `lowG` | gravity 0.35 | a 0.2 s tap hops 3.5 m (1.2 m normally); a full tank climbs 17.7 m (13.0) |
| `reverseG` | gravity −0.6, dive 30, drag 1.5 | you rise and hover at the pocket's top edge (settles in 3.9 s); Down pulls you out |
| `longFlight` | fuel burn 0.4 | a tank lasts 5.7 s (2.25 s); jet + run 55 m on one tank (23 m) |
| `damping` (bullet fog) | bullet range 0.35 | Hammer reach 12.4 m through 10 m of fog (26 m clear); Widow 41 m (60) |
| `wind` | wind [12, 0] | a 1 s fall drifts 4.9 m; grenade arcs bend |
| `slow` (mud) | speed 0.45, drag 3 | walk 2.25 m/s |
| `water` | speed 0.6, gravity 0.45, drag 1.5, bullet range 0.4 | sinks at 4.7 m/s after 1 s; bullets die in it |
| `jumpPad` | launch [0, 16] | 6.5 m apex from standing, no fuel |
| `boostPad` | launch [16, 9] | an 11 m throw from a run |
| `emp` | jetDisabled | no jetpack inside; it cuts out as you fly in |
| `custom` | nothing | only the fields you set |

**Pads** are level-triggered: each tick a body touches one, its speed along the launch direction rises to at least the launch speed, and its velocity across that direction is kept (run onto a jump pad and you keep running). Standing on one bounces you; it can never stack speed, so pads need no per-player cooldown state. A launch with an upward part over 0.2 unsticks a grounded player; grenades get launched too. Up to 4 pads count at once.

### 20.3 In the tick

- **Players** (`stepMovement`, §9): the body's environment is read once, at the body centre, before it moves. Speed caps × `moveSpeedMul` → pads, then, airborne only, dive, wind and drag → jetpack (`jetDisabled`, `fuelBurnMul`, `fuelRegenMul`) → gravity × `gravityMul` → knockback cap (raised by `knockbackMul` > 1, but never past the **36 m/s speed limit**: move-and-slide takes at most 4 substeps, each under half the capsule radius, or launches tunnel through thin walls) → move-and-slide (no ceiling bonk while gravity is reversed).
- **Grenades** (`stepGrenade`): pads, wind, drag, then gravity × `gravityMul` (terminal ±30 m/s), then the swept move.
- **Knockback** (`push` for bullets and melee, `explode` for blasts): the impulse × `knockbackMul` where the target is.
- **Bullets:** §20.4.

### 20.4 Bullets through rules and zones

Each bullet (and pellet) has its weapon's range as a budget of "range metres". Flying a metre in clear air costs 1; inside a damping zone it costs `1 / bulletRangeMul` (overlapping zones multiply); a map-wide `bulletRangeMul` scales the budget. The bullet stops where the budget runs out, and walls count only up to there: one inside the shortened reach stops it, one past it is never reached, and under a multiplier above 1 walls past the weapon's nominal range still stop it. **Damage falloff reads the range used up, not the metres flown**, so fog both shortens a shot and weakens what gets through. The maths is a sweep over the ray's crossings with the zone outlines (`MapMechanics.castBullet` / `bulletReach` / `bulletCost`): exact piecewise-linear, no stepping, a few multiplications per pellet. Tracers end where the bullet died, so fog visibly eats them.

### 20.5 Determinism and prediction

- A map with no rules, zones or events compiles to **no** mechanics (`Game.mech === null`): the sim runs exactly the code it ran before, so every existing golden replay keeps its hashes. Where a map does have mechanics, neutral values multiply by 1 and add nothing (exact in IEEE arithmetic), and zero wind, drag and dive are skipped; tests replay three goldens under a neutral zone over the whole map, and under a zone nobody enters, and get identical hashes.
- Effects are pure functions of map data and position: no new player state, nothing hashed, nothing quantised beyond what was. Everything they change is quantised at tick end as before.
- **Prediction stays exact for free.** A client predicts its player with a Game built from the same `MapDef` (CONTENT_HASH, which also covers the zone and event kinds' defaults, refuses mismatched builds), so zone and rule effects come out bit-identical. Events too (§20.7). The protocol only gained the MAP_EVENT announcement (v8, 05-netcode §6.2).
- Only + − × ÷, comparisons and `simExp` (drag) in the sim: the lint rule against `Math.sin/exp/random` holds.

### 20.6 Authoring

The compiled map format (the `MapDef` JSON, like `art/maps/street_market/street_market.map.json`) carries rules and zones as plain data:

```json
"rules": { "gravityMul": 0.45, "fuelBurnMul": 0.7 },
"zones": [
  { "id": "dome", "kind": "zeroG", "rect": [-6, 4, 6, 16], "label": "zero-g dome" },
  { "id": "fog-bank", "kind": "damping", "points": [20, 0, 34, 0, 34, 9, 27, 12, 20, 9] },
  { "id": "pad-west", "kind": "jumpPad", "rect": [-30, 0, -28, 1.2], "launch": [3, 17] }
]
```

Zone ids are unique per map. The compiler (`checkMechanics`) lists every problem at once (unknown kind, both or neither shape, out-of-range values, a zero launch) and the Game refuses to build the map until they're fixed, like a self-intersecting solid.

**Editor support.** `packages/content/schema/map.schema.json` is the map JSON format as JSON Schema, generated from `ZONE_KINDS`, `EVENT_KINDS` and `MODIFIER_FIELDS` (`pnpm --filter @military-forge/content schema`; a test fails if the committed file drifts). Add `"$schema": "<path>/map.schema.json"` to a `.map.json` and an editor offers every zone and event kind with its description and defaults, and flags values out of range. `parseMapJson` loads such a file: it refuses unknown keys in rules, zones and events (a misspelt `"gravitymul"` must not silently do nothing) and lists every problem with its JSON path. The Storm Front demo map is authored this way (`packages/content/src/maps/stormFront.map.json`). The art pipeline's `compile_map.py` can pass `rules`, `zones` and `events` from a layout straight through to its `.map.json`.

**Trying maps.** Local mode: `/?map=lunar-outpost` (or `storm-front`, `flux-lab`, `mechanics-test`); the debug bar links them. Online: `MAP=flux-lab pnpm dev`, or `--map=flux-lab` on the game server; clients take the map from WELCOME and redraw for it.

### 20.7 Events: "some things just happen"

`MapDef.events = { defs, schedule }`. An event def has an `id`, a `kind` that fills in everything it leaves out (`EVENT_KINDS`), a banner `name` and `description`, `duration` and `warning` (s), any modifiers (applied **map-wide** while it runs), and for wind `gustPeriod` (the wind swells from nothing to full and back: 0.5 − 0.5·cos(2πt/T)) and `windFlip` (some occurrences blow the other way). Zones with `event: "<id>"` are **event zones**: off until that event runs; `pickOneZone` switches on one of them per occurrence instead of all (a reversed-gravity pocket that appears at one of several sites).

| Kind | Defaults | Feel |
|---|---|---|
| `gravitySurge` | gravity ×1.8, 15 s, 3 s warning | a full tank climbs 8.2 m (13.0): fights drop to the floor. Above ×1.85 the jet stops lifting at all (thrust 38 vs gravity 37) |
| `lowGravity` | gravity ×0.35, 15 s | a 0.2 s tap hops 3.5 m, map-wide |
| `emp` | jetDisabled, 8 s, 4 s warning | no jetpacks anywhere |
| `fog` | bullet range ×0.4, 20 s | Hammer reach 10.4 m (26) |
| `gust` | wind [16, 0], gusting every 3 s, windFlip, 15 s | a 1 s fall at a peak drifts 5.6 m |
| `flip` | pickOneZone, 15 s, 4 s warning | one of its event zones (reverseG) switches on |
| `custom` | 10 s, 3 s warning | only what you set (e.g. the test map's MOLASSES: drag 2, knockback ×0.5, speed ×0.8) |

**Schedule.** Two kinds, both pure functions of the map, the room seed and the tick:
- `random`: `{ start, cycle, chance?, weights? }`. From `start` (s), time splits into cycles of `cycle` s. Each cycle holds at most one event: with probability `chance` (default 1), one picked by weight (default 1 each, 0 leaves one out), its warning starting at a seeded moment chosen so warning + duration fit inside the cycle. Hashes: `hash4(seed, cycle, salt, n)`; nothing is stored.
- `timeline`: `{ start?, loop?, entries: [{ at, event }] }`. Each entry's event starts `at` s after `start`, its warning before that; with `loop` the whole timeline repeats. Entries (warnings included) may not overlap.

Because only one occurrence can cover a tick and it is found from the tick alone, the server, a predicting client (same seed from WELCOME, same tick numbering), a client that joined late, a re-simulation of old ticks and a replay all agree. Each tick `MapMechanics.beginTick` finds the occurrence, sets the map-wide modifiers (rules × the event while it is past its warning) and switches event zones, and pushes a `mapEvent` sim event (`event, phase: 0 warning | 1 start | 2 end, occurrence, zone, flip, ticks`) on the ticks a warning starts, an event starts and an event ends. Those reach every client as MAP_EVENT (05-netcode §6.2); the HUD banner reads the client's own copy of the schedule, so a lost snapshot never loses a banner.

**Limits.** At most 32 events and 255 zones per map (the wire sizes). Duration 1 tick–600 s, warning 0–30 s, gust period 0–60 s. A random schedule refuses an event whose warning + duration don't fit its cycle; a timeline refuses overlapping entries and a loop shorter than its entries.

**Test map.** `mechanics-test` (packages/content `maps/mechanicsTest.ts`): a 240 m strip with every zone kind and a 49 s timeline of every event kind, map rules (fuel refill ×1.25), dummies behind the fog and in a knockback ×2 pit, and two pocket sites. Golden replays `mech-zones` (a walk across every zone with hops, dives and frags), `mech-bullets` (Hammer shots that die in the fog, Widow shots that get through except during the fog event) and `mech-events` (a whole loop of events, frags into the pit, a stand in the picked pocket).

### 20.8 On screen

- **Banner (HUD hook).** Each frame carries `mapEvent` (apps/web `mapEventView`), read from the game's own copy of the schedule: the local game, or online the predictor's, so the banner flips on exactly the tick the physics do and a lost snapshot can't lose it. `shell.setMapEvent(view)` feeds the shell store (it changes at most once a second); React shows `MapEventBanner` under the match clock in the event kind's colour: "EMP STORM in 3 · Jetpacks offline" during the warning, then "EMP STORM · Jetpacks offline · 6 s". Other HUDs read it with `useMapEventBanner(store)`. The canvas HUD adds a debug line, and the kill feed logs each warning, start and end (from the `mapEvent` sim events, or MAP_EVENT online).
- **2D (debug view, and the overlay on 3D with H or B):** zones tinted by kind with a dashed outline and a label; wind and pads show a drifting chevron along their push. Event zones are a faint dotted outline while off ("(off)"), pulse during their event's warning ("(opening)": the client knows which pocket site will open), then fill.
- **3D (render3d `zones.ts`):** each zone is a tinted volume through the gameplay band (z −1…+1, no depth writes) with a rim on the front face, plus particles that show what it does: dust drifting in zero-g and low-g, streaks along wind and pad launches, bubbles rising in water and up the long-flight shaft, sparks in EMP fields. Event zones fade in and out with their event; their rim pulses during the warning. A fog event (any event that cuts bullet range) thickens the scene fog while it runs.

---

## 21. Dash

> Owner request (paraphrased): dash physics for fast movement between spaces, brief like a fighting-game dash, but up and down too, with nice controls.

A dash is a **brief 8-way jetpack burst**: for `dashBurstTicks` (8 ticks, 0.13 s) your velocity is `dashSpeed` (14 m/s, × weapon weight × the map's `moveSpeedMul`) along the dash direction, with no gravity, so up and down dashes are crisp. Then it lets go: sideways speed drops back within the walk cap (on the ground) or the air cap (in the air), × weapon weight and the map's speed but never above `launchSpeedX`, so a dash never flings like a blast (NOTES §17), and upward speed is capped at `dashExitUp` (2 m/s) so an up-dash can't become a free jet launch. The burst moves with the normal move-and-slide: walls stop it (no tunnelling, even through a 2 cm wall), small steps are climbed, slopes are followed.

**Controls.** `Btn.Dash` (bit 13, `Shift`). The direction is what you hold: `A`/`D` sideways, `W` (jet) up, `S` (down) down, so 8 ways; none held = along your facing. A tap shorter than a tick still dashes (the client latches the press with the direction held at that moment). Double-tapping `A`, `D` or `S` is an optional binding for the same input (`InputSampler.doubleTapDash`; `?dashtap` until the settings screen offers it). Not `W`: tapping the jet key is how you feather the jetpack, so a double-tap there would fire dashes mid-hover; dash up with `Shift` + `W`.

**Dashing while flying.** `W` counts as "up" for a dash only when it is fresh: pressed with the dash, or burning for at most 6 ticks (~0.1 s, `DASH_UP_FRESH_TICKS`). A jet that has been carrying you longer is ignored, so a flying player dashes flat. The sim decides it from `jetTicks`, which is already in the local block, so prediction stays exact.

**Where you are matters.**
- On the ground, down only means something with a direction: down-left/right dash along the floor (crouched, it's a slide under things). Straight down on a **one-way platform** drops through it, dashing down; straight down on solid ground does nothing and costs nothing.
- In the air, down is a quick drop: from a 6 m hover you land in 0.40 s (0.77 s falling). Landing ends a down-dash on the spot (a slam).

**Limits.** A 1.0 s cooldown (a press during it does nothing; refused presses never restart it). One air dash per airborne period, given back on landing; a dash that starts on the ground (an up-dash, a drop through a platform) isn't the air dash. Each dash costs `dashFuelCost` (8) fuel and needs that much, and restarts the air fuel-regen delay.

**Interactions.**
- **No invulnerability frames.** Any knockback (a bullet's hit impulse, melee, a blast) ends the dash on the spot: the burst's speed first drops to the exit caps, then the push adds, so a pellet's small push never leaves you flying on at dash speed.
- **EMP:** a dash is a jetpack burst, so anything that cuts the jetpack blocks it: EMP zones and storms (`jetDisabled`, §20), and the EMP grenade's 3 s jetpack lockout (§14) when it lands. The check is one function, `dashBlocked()` in movement.ts.
- **Riot shield** (03-weapons §9): no dash while the shield is up or coming up; lower it (`X`) to dash. Slung on the back, it doesn't stop a dash. The same `dashBlocked()` check; pellets on the shield push its carrier like any hit, so they end a dash.
- **Map mechanics (§20):** the burst ignores pads, wind and gravity while it lasts; zones act on what's left after it. A dash in zero-g keeps drifting at its exit speed; mud slows the burst through `moveSpeedMul`.

**State and prediction.** `PlayerState.dashTicks`, `dashDir` (0 = right, counter-clockwise in 45° steps), `dashCooldown`, `airDashUsed` are in the local-player block (protocol v8), so your dashes predict exactly (`apps/game-server/test/dash.test.ts`: no mispredictions on a clean LAN while dashing 8 ways). They are hashed only away from rest, so replays that never dash keep their hashes.

**Events.** A `dash` sim event (player, start position, direction) on the tick it starts: the animation poses the body from it, render3d draws the streak. Other clients get it as the extended event DASH (snapshot tag 7, 05-netcode §6.2) when they can see the dasher; your own is drawn from prediction. Remote players also carry a `dashing` flag.

**Feel** (`pnpm --filter @military-forge/sim feel`, all on target): 2.05 m along the ground from standing (target 2–2.5), 1.95 m up (1.5–2), up-right 1.41 m high at 1.82 m out, the slam above, a wall 1 m away stops it at 1.00 m.
