# 11 — Rendering, Art Pipeline, VFX, Audio & Client Tech

> Client stack for the **2.5D** variant (3D rendering, 2D gameplay plane), **desktop browser first**, touch later.
> Versions were checked on 16 Oct 2026 (npm registry). Re-check before pinning.

---

## 1. Engine & library picks

| Concern | Pick | Why / notes |
|---|---|---|
| Renderer | **Three.js r186, `WebGLRenderer`** as the shipping baseline | Largest ecosystem/hiring pool (~21M weekly npm downloads). ~155 KB brotli core. The leading web-native .io shooters (Krunker, Deadshot, Kirka, ev.io) are Three.js + custom netcode |
| WebGPU | `WebGPURenderer` + TSL behind a flag, **later** | It auto-falls back to WebGL2, but there are no public low-end benchmarks yet. Custom shaders written with `onBeforeCompile` would need TSL rewrites, so **use stock/node-friendly materials** to keep the switch cheap |
| Gameplay physics | **Custom 2D kinematic sim** (02-physics) | Jetpack feel is design-driven, not rigid-body. Tiny, exact, shared with the server |
| Cosmetic physics | none at first (Verlet ragdolls in-house). If needed later: **Box2D v3 WASM** (~122 KB brotli) or Rapier2D (~657 KB), lazy-loaded, client-only | Never on the gameplay path. Rapier is f32 inside WASM vs JS f64, so don't mix authoritative state across that boundary |
| ECS | **bitECS 0.4** (SoA typed arrays + serialization module) | Zero-GC, snapshot-friendly, works headless on the server |
| Assets | glTF/GLB → **gltf-transform 4.5** → **meshopt** (decoder ~6 KB) + **KTX2/Basis** (transcoder ~210 KB, worth it for GPU memory) | Prefer meshopt over Draco (faster decode, better for skinned meshes) |
| Particles | **three.quarks 0.17** (batched) or a small in-house instanced particle system | |
| Audio | **Thin in-house Web Audio wrapper** | Howler is stagnant (last release 2023) and has iOS quirks |
| UI shell | React 19 + Zustand | Menus/store/social. HUD in a separate lightweight layer |
| Build | **Vite 8** (Rolldown), pnpm, Turborepo | |
| Touch | custom Pointer Events twin-stick (`apps/web/src/touch`, lazy-loaded on touch devices: ~8 kB gzip) | |

**Rejected for this project:**
- **Unity:** 8 MB+ empty builds, and CrazyGames disables Unity games on iOS by default.
- **Godot:** no WebGPU, and C# can't export to the web.
- **Babylon:** a fine runner-up with everything built in (Shell Shockers uses it), but it's heavier and we don't need its physics.
- **PlayCanvas:** choose it only if a collaborative visual editor matters more than code-first control (Venge.io uses it).

---

## 2. Scene structure (2.5D)

```
z = −40 … −10   FAR BACKGROUND   skybox/gradient, distant skyline cards (unlit, atlas), parallax for free via perspective
z = −10 … −1    MID DEPTH        3D level dressing behind the play plane (buildings, cliffs), instanced kit pieces
z =  −1 … +1    GAMEPLAY PLANE   collision-matching level meshes (extruded polygons + trims), players, pickups, projectiles, VFX
z =  +1 … +6    FOREGROUND       grass tufts, railings, pipes. Dither-fades when a player is behind (never hides gameplay)
```

- **Level geometry generation:** the map editor extrudes collision polygons into front faces (earcut triangulation) + side walls + bevelled trims. Artists then dress them with kit meshes. This guarantees **render = collision** at the play plane, which is critical for fairness.
- **What looks solid stops bullets (owner's playtest, 18 Oct: "bullets go through buildings"):**
  - Solids stop bodies and bullets. A one-way is a railing by default: bullets, blasts, gas and sight pass it. A floor or roof slab sets `blocksBullets` ([02](02-physics-and-movement.md), map JSON) and stops them while staying one-way for bodies. **Every one-way drawn as a slab, sheet or canopy blocks** (owner, 18 Oct; QA 23 Oct): today that is every one-way on every map, the Street Market's zinc awnings and umbrella canopies included. Anything bullets pass must read as passable (a mesh grate, a torn canopy with a visible gap, a thin railing); content.test.ts fails on a see-through one-way that isn't listed. Thin parts drawn on the gameplay plane (posts, poles, masts, rails, plates) get **bullet-only** colliders (`MapDef.bulletOnly`, the kit's `bulletOnly` extra): bullets stop on them, bodies don't snag.
  - Anything drawn near the play plane without collision has to read as background: the kit's mid layer is hazed toward the map's air by the look's grade (at least 40% at its nearest building), and painted layers nearer than z −16 by the look's `backdropHaze`.
  - Audit: `apps/web/scripts/environment-shots.mjs --only audit`, then `scripts/bullet-audit.py` marks solids, see-through one-ways, slabs and decoration on the shots.
- **Batching:** `InstancedMesh` / `BatchedMesh` for kit pieces, pickups, decals, shell casings. Target **≤ 80 draw calls** in a busy 12-player fight.
- **Lighting:**
  - Baked AO/light in textures + vertex colours.
  - One hemisphere light + one directional light.
  - **Low:** blob/contact shadows under players only.
  - **High:** one 1024² directional shadow map limited to the gameplay plane frustum.
  - Muzzle flashes are emissive cards + a brief light-probe tint, never real-time point lights on Low/Medium.
- **Post (High only):** bloom, colour-grading LUT, subtle vignette. On Medium only the LUT is baked into materials.
- **Billboard ad slots** (city maps only; details in [14 §4.5](14-in-world-advertising.md#45-rendering)):
  - **Layer:** `AdSlot` surfaces sit only in the mid-depth band (z −9…−4), never on or in front of the gameplay plane. They are graded into the map's background palette.
  - **Material:** unlit and non-emissive, on a layer excluded from bloom.
  - **Budget:** one `InstancedMesh` and one KTX2 (ETC1S) `CompressedArrayTexture` per format, so ≤ 2 draw calls. The fixed layer pools take ≈ 5.1 MB of GPU memory per map. A 5 Hz measurement mask adds ≤ 8 draws, and both count against the budgets in §3.
  - **Fallback:** each map ships a shared pool of house ads (fictional local businesses, notices). It's what shows when nothing is sold, before a creative arrives, on Save-Data or slow connections, and in every `portal` build.
  - **Loading:** creatives download after first spawn, never inside the loading budget, and are uploaded only while the player is dead, in the warm-up yard or on the plane.

---

## 3. Performance budgets

**Desktop first: reference machines.**
- **Min:** an Intel UHD 620-class iGPU laptop with 8 GB RAM at 1080p, Low preset, steady **60 fps**.
- **Recommended:** a GTX 1650 / M1 class machine, High preset, 120+ fps.
- **Portal requirement:** a 4 GB Chromebook must run it (CrazyGames tests this).

| Budget | Low | High |
|---|---|---|
| Draw calls | ≤ 80 | ≤ 150 |
| Visible triangles | ≤ 150K | ≤ 400K |
| Triangles per character | ≤ 4K (LOD0), 1.8K (LOD1) | same |
| GPU texture memory | ≤ 64 MB | ≤ 160 MB |
| Live particles | ≤ 1.5K | ≤ 5K |
| Device pixel ratio cap | 1.0 (phones: 1.5, since 1.0 is blurry on a small dense screen; dynamic resolution still drops to 0.6) | 2.0 on a desktop (a Retina screen at full sharpness while the frame budget holds; dynamic resolution steps it down to 1.2), 1.5 on touch devices |
| Main-thread frame budget | sim ≤ 1 ms, net ≤ 0.5 ms, render submit ≤ 6 ms, HUD ≤ 1 ms | |

- **Auto quality:** measure the first 300 frames, then pick a preset. **Dynamic resolution** steps the render scale (0.6–1.0) when the p90 frame time exceeds budget.
- **Shader warm-up:** `renderer.compileAsync(scene, camera)` during the loading screen for every material variant on the map, so there are no first-shot hitches.
- **Download budgets:**

| | Target |
|---|---|
| Boot chunk (menu + engine) | ≤ 2 MB brotli |
| First playable (menu + 1 map + base character + MVP weapons) | ≤ 8 MB |
| Per additional map | ≤ 4 MB |
| CrazyGames mobile-homepage eligibility (later) | ≤ 20 MB initial |
| CrazyGames desktop hard cap | ≤ 50 MB initial, ≤ 250 MB total, ≤ 1,500 files |
| Time to gameplay | ≤ 10 s on broadband (portals require < 20 s) |

- **Threads:** **design single-threaded.**
  - `SharedArrayBuffer` needs COOP/COEP headers, which **portal iframes generally don't provide**.
  - Chrome's `Document-Isolation-Policy` is desktop-only so far.
  - Decoders (meshopt/KTX2) already use workers.
  - OffscreenCanvas rendering isn't worth it by default.

---

## 4. Art direction

- **Style:** stylised "toy-soldier" 3D. Chunky chibi characters, bold shapes, hand-painted-looking textures with a light toon ramp, saturated players over a desaturated background. Readable at a glance, cheap to render, and it ages well.
  - **One look everywhere** (as built): soldiers, guns and the gameplay plane share one three-step toon ramp (`characterToonRamp`). Soldiers use the same assembler and dye material in game and in the Locker, with a 2 px ink outline (docs/04 §5.5). In game they also get a toon rim light in the colour of the Locker preset their map matches (`render3d/lighting.ts` `rim`; the yard uses the lobby's #7fb8ff), so they pop like the Locker preview. The Locker uses a real rim light instead.
- **Palette discipline per map** (04 §8): the background is low-saturation and low-contrast; the gameplay plane is mid; players, pickups and projectiles are the highest contrast. Teams are blue/orange with an outline, plus shape cues for colour-blind players.
- **Original IP only** (01 §12): no traced or copied assets, sprites or sounds.
- **Kitbash:** a modular kit per biome (urban/market, industrial, desert, snow, moon, tombs) → 7 launch maps from ~6 kits.

### Asset pipeline (`tools/asset-pipeline`)

1. Blender (or Maya) → glTF with custom properties (docs/04 §9.5). W8's Blender source builds and the `tools/asset-check` validator feed this stage (docs/04 §8).
2. `gltf-transform`: dedup → prune → weld → resample animations → quantize → **meshopt** → textures to **KTX2** (ETC1S for albedo, **UASTC for dye masks** (ETC1S block artefacts bleed between the mask channels) and normals).
3. Budget checks: tris, texture size, file size, bone count, envelope (cosmetics). CI fails over budget.
   - **Painted map art (backdrops, house billboards):** WebP is the download. An ETC1S KTX2 copy ships only where it costs at most 1.2× the WebP's bytes (players on mobile data, owner 18 Oct), at the best basisu quality that fits, the WebP's size rounded to block-aligned, and the block-aligned mips.
   - In practice that's the mid layers and the billboards, which carry most of the GPU memory. Smooth skies and thin far layers compress far better as WebP and stay WebP.
   - The runtime loads the copies only where GPU memory matters: touch devices and phones, and the Low preset. It falls back to the WebP if transcoding fails. Desktops on Medium or High keep the WebPs and never fetch the transcoder (≈ 217 KB). Scripts: `apps/web/scripts/backdrops.py`, `house-ads.py`; tests: `render3d/environment/test/ktx2.test.ts`.
   - **The transcoder runs under the strict CSP** (`script-src 'self' 'wasm-unsafe-eval'`, no `'unsafe-eval'`). The vendored `public/assets/vendor/basis/basis_transcoder.js` is three's with embind's callers built as closures instead of with `new Function` (Emscripten's `DYNAMIC_EXECUTION=0` path). Three's own copy threw EvalError in the worker on the trial box (QA, 23 Oct 2026). Updating three means re-applying that change: `apps/web/test/basisTranscoder.test.ts` fails until it is.
4. Thumbnails (headless render) + manifest entry with content hash.
5. Upload to R2 under content-hashed paths. The client loads by manifest.

### Animation tech

- `AnimationMixer` per character, with a small blend-tree layer of our own (1D locomotion blend by speed; state machine for air/jet/crouch). As built (`apps/web/src/render3d/locomotion.ts`):
  - **Ground:** a base pose (idle, or crouch_idle) with the gait cycle on top as an additive layer, every cycle phase-locked to one gait phase:
    - the Forge's careful steps (walk_slow) up to 0.5–0.9 m/s, then W8's walk, then the run from 1.4–2.8 m/s;
    - crouched, crouch_walk over crouch_idle.
  - **Gait:** amplitude and cadence come from the ground speed and each clip's measured stance (how far a planted foot travels per cycle, and for how long it's down).
    - Tiny speeds take small steps at ≥ 1.25 cycles/s instead of a slow-motion walk.
    - The run never steps slower than 2.4 cycles/s; below its stride's speed it shortens its stride. At 5 m/s it plays at its authored cadence.
    - The blend follows an eased speed, so a wall stopping a run fades it out.
    - Backpedalling runs the cycle backwards.
  - **Upper body:** while W8's aim poses show (render3d-b's `AimClips`, holds.ts), they own the upper body and the locomotion drops its upper-body tracks (`setUpperBody(false)`).
  - **Air:** jet_ascend, jet_hover and fall, blended by vertical speed. `land` plays as an additive dip scaled by the impact.
  - **Planted feet:** while the gait says a foot is down, two-bone IK holds it where it stopped moving with the body.
    - The hold fades in and out over ≥ 70 ms (4 frames).
    - A held foot stands at the clip's own height over the floor under it (raycast per plant; on a step's edge, the highest floor under the sole), turned onto its slope, and never inside the ground.
    - The hips dip (≤ 8 cm) as far as the most demanding held leg needs. A target still out of reach is pulled in, so no knee snaps straight.
    - Swinging feet are only lifted out of the ground.
    - On a slope the body comes down onto the ground the capsule stands over.
    - Holds let go when stopping, dashing, turning round, after a teleport, or when the body climbs away from a foot.
    - Tests: `render3d/test/feet.test.ts`. Held feet slide 1–11 % of the ground speed, depending on the cycle (the clips alone slide 3–34 %). The planted knee turns no more sharply than the clip's.
  - **Clip repair** (`apps/web/src/character/clipRepair.ts`): rebuilds tangents and resamples cubic-spline clips, and keeps quaternion keys in one hemisphere. The Forge now exports linear, sign-continuous tracks (#61, #75), so this is a safety net for older files.
  - **Body motion** (`render3d/motion.ts`), after the mixer and before the aim layer:
    - *Lean:* the body tilts in the gameplay plane with speed and acceleration through critically damped springs. It's ~13° forward at a 5 m/s run, upright at a stroll, back about 10° for a moment when braking or reversing, and banked into a facing turn. In the air it leans with the velocity, a little more into the jet's horizontal direction. The spine's share gives way to a hold's own lean into the gun, so the two don't add up.
    - *Landing squash* scaled by the impact speed (none under 2.5 m/s; at 16 m/s the head drops 14 % of its height). The hips drop and the knees take it, with the feet on the ground. Nothing is scaled, so the aim stays exact.
    - *Launch flail* above `launchSpeedX` in the air (a blast launch, not a dash): arms out and flapping, legs kicking, a slow tumble with the velocity. It recovers on landing and resets on respawn.
    - *Dash pose* for the sim's 8-way dash: stretched along a sideways dash, tucked for an up-dash, a slam for a down-dash, mixed on diagonals. The streak and afterimages are render3d-b's (`vfx/dash.ts`).
    - *Hit reactions* from the sim's hit events, for every drawn player, remote ones included (`hitReactions`, wired in `Renderer3D`'s event path, so online they play on the remote timeline):
      - the torso flinches along the shot, sized by the damage and what dealt it: a Hammer twitches about 5°, a Breacher or a Widow staggers up to 22°;
      - a headshot snaps the head, a hit from behind twists the torso, the knees give on a hard hit;
      - in the air the whole body takes it, 1.6× bigger.
      - Each reaction peaks in ~35 ms and is gone in ~0.25 s. It's render only, so control is never taken.
      - Arms holding a gun keep their aim.
      - Under Reduce motion (`setReducedMotion`, or the OS preference until it's called) reactions play at 30 %.
    - *Held arms:* arms the aim layer holds a gun or the shield with keep the world direction the aim pose gave them through every lean, flail, dash and reaction, so the gun and its muzzle stay on the stand.
  - **Look at it frame by frame:** `/animlab.html` (dev only) runs the real renderer with a scripted player moving along the movement-test map's flat floor. `node apps/web/scripts/animation-shots.mjs --set strips` saves the frame strips.
- **Aim:** the additive aim-offset pose by angle **or** procedural spine/chest/upper-arm rotation after the mixer update. Prototype both and keep the one that reads best.
- **Two-bone analytic IK** for the off-hand (cheaper than `CCDIKSolver`).
- Retarget placeholder clips with `SkeletonUtils.retargetClip` (Mixamo) until the animator's clips land.

---

## 5. VFX catalogue (MVP → Launch)

| Effect | Technique | Notes |
|---|---|---|
| Muzzle flash | 2–3 emissive cards, random rotation, 2 frames | per weapon family |
| Tracers | stretched billboard quad, fades in 60 ms | skip on Low for SMGs (every 3rd) |
| Bullet impacts | pooled instanced decals + material particle burst | concrete/metal/wood/dirt/glass |
| Shell casings | instanced meshes with simple bounce | capped at 300 |
| Jetpack flame | animated cone mesh + flipbook + heat shimmer (High) | ignite/sustain/sputter states |
| Explosions | flipbook fireball + debris + smoke puffs + shockwave ring + shake | sized by radius |
| Gas cloud | soft sprites with noise scroll, tinted green | the cloud volume matches the sim radius |
| Flames | additive flipbooks along flame projectiles | |
| Beam laser | a ribbon with scrolling noise + impact glow | |
| Storm wall (BR) | full-height plane with a distortion/noise shader | |
| Spawn/teleport | rising ring + particles | cosmetic variants |
| Pickups | idle bob + rim glow by type/rarity | rarity shape icon |
| Hit flash | a white additive flash on the hit character (60 ms) | server-confirmed only |
| Blood/gore | sprite puffs (Low = sparks/"stuffing" mode) | gore setting |

All VFX respect the presets and **reduced motion**: no flashes > 3 per second (photosensitivity).

---

## 6. Audio

> **Built (19 Oct 2026):** `apps/web/src/audio` (NOTES §28). Every sound is synthesized in code (no files yet; `docs/audio-asset-wishlist.md` ranks what to record or generate). The buses are Master, Effects (the world, with blasts on their own un-ducked sub-bus), Music, Interface and Voices, each a setting. The plan below is what it follows; the differences: panning is by world position from the listener (the local player; HRTF with headphones), occlusion counts walls along one ray per sound start (cached), the voice cap is 40, and the space is two convolution reverbs on synthesized impulses (open street, under cover). The mix rules: `docs/audio-design.md`.

**Graph:**
```
sources → [per-voice gain + StereoPanner] → category bus (weapons, impacts, movement, UI, announcer, music, voice)
        → master compressor/limiter → destination
```

- **Unlock:** create/resume the `AudioContext` on the first `pointerup`/`keydown`, and resume again after interruptions (portals require this; iOS later).
- **Mute** when the tab is hidden, and during portal ad breaks.
- **2.5D spatialisation:**
  - pan by screen-space x (−1..1);
  - gain by distance from the camera focus;
  - a low-pass filter when a solid segment lies between (approximate occlusion, one ray per sound start).
- **Voice management:** 24 voices max with priority stealing (own gun > enemy gun near > explosions > footsteps > ambience). Each weapon has a "same-sound cooldown" so SMG spam stays clean.
- **Formats:** Opus/WebM with an AAC/M4A fallback for older Safari. Sprite packs per category to reduce requests.
- **Off-screen awareness:** coarse server SOUND events (05 §9) are played as directional cues at the edge.
- **Accessibility:** visual sound indicators (edge pips for gunfire/footsteps/explosions) + captions for the announcer and key cues.

---

## 7. Client boot sequence

```
1. index.html (tiny) → inline critical CSS + splash
2. boot chunk: React shell + Three core + netcode + sim (≤ 2 MB)
3. parallel: /version check · guest auth · region beacons · asset manifest
4. menu interactive (≤ 3 s broadband)        ← user can queue NOW
5. while queued: prefetch the likely map + MVP weapons + equipped cosmetics
6. match found → finish loading the map → compileAsync shaders → LOADED → first snapshot → spawn
```

A Service Worker (web build only) caches hashed assets. Return visits boot from cache.

---

## 8. Build targets

| Target | Differences |
|---|---|
| `web` (our site) | PWA (service worker, install prompt), our auth, our payments, Web Push |
| `portal` (CrazyGames, Poki, GameDistribution) | no service worker, relative paths, portal SDK adapter (ads/user/purchases), portal identity, **no external requests unless allowed** (Poki), chat-disable respected, `gameplayStart/Stop` hooks |
| `app` (later) | Capacitor 8 wrapper (or a Trusted Web Activity for Play), native IAP plugin, haptics. Watch Apple's 4.2 "minimum functionality" rule |
| `dev` | tuning panel, net graph, debug overlays, cheats (god mode, give weapon, spawn bots) |

---

## 9. Destructible terrain (post-launch option)

It's a great 3D-era differentiator for some maps and LTMs:
- An integer occupancy bitmap per chunk (e.g. 0.125 m cells) → **marching squares** → contour polygons → collision segments + extruded meshes.
- Explosions broadcast reliable crater events `{x, y, r, seq}`. Integer carving keeps every client and the server bit-identical.
- Restricted to designated "soft" regions of specific maps, to protect competitive layouts.
