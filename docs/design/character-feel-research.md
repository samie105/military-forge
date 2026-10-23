# Character feel research: stylized soldiers that move beautifully

**The owner, 23 Oct 2026:**

- "I want the 3D rigging of the characters to be smoother … do you need anything to achieve the perfect 3D feel for the 3D characters when customizing and what players can use as their avatars."
- A player's customised character's face becomes their avatar card everywhere: lobby, scoreboard, and team panels for 4v4 and 4v4v4.
- A pre-match "VS" poster of the teams' characters.

**The coordinator, 23 Oct:** the soldiers keep their current stylized look (big head, cartoon face). This research aims at making that style move beautifully, not at realism. Avatars and VS posters use our real fighters' faces.

This doc has six parts:

- **What we have:** read from `origin/main` at `71eb379d`, with the creator (#175) and the title (#191).
- **What's rough, measured:** on the real rig and clips.
- **What the research says:** cited. Sources are at the end. Sources that name other games are listed separately, so they can be moved out before this merges.
- **The gaps, ranked by impact on feel, and the plan:** code, clips and the pipeline.
- **What we need from the owner:** only the real asks, each with a free alternative.
- **Specs:** the avatar renderer and the VS poster, with acceptance criteria.

**Ownership** (memory and notes `animation-avatar-split.md`):

- **The animation stream:** `apps/web/src/character/**`, `render3d/locomotion.ts`, `motion.ts`, `character.ts` and `lab.ts`.
- **render3d-b:** the rest of `render3d/**`, including aim, arms, IK, holds and VFX in `avatar.ts`.
- **`art/**`:** the Forge (the art session).

Every code item below names its owner.

**Naming rule.** Sections 3.1 and 3.14 name other games' talks and screens, and a few other lines cite a game-named source, always marked [G]; this doc is internal. Everything we recommend is in our own words.

---

## 0. Summary: the ten recommendations

1. **Add an inertialization pass.** It turns every hard pose change into a short, decaying offset: Holden's spring offsets, the technique behind inertial blending [C18][C19].
   - Today the support hand leaves a two-handed gun with a **148° turn in one frame**, and dropping to unarmed swings the upper arm 77° in one frame.
   - The pass costs a few quaternion operations per bone, only while it decays (≈ 0.25 s).
2. **Stop the walk-band skate.** Between about 0.8 and 2.5 m/s the foot on the ground moves at **66% of the ground speed** (measured at 1.5 m/s), because `walk` has no planted contact and the foot planter barely engages. Fix it with a planted `walk` cycle from the Forge, plus play-rate warping limited to ±15–20% [C26][C27].
3. **Turn with a step.** The facing turn is a constant 1,500°/s through facing the camera (about 5 frames). Standing, **each foot slides 34 cm** as the pivot swivels. Plant the foot on the new side, step the other on a short arc, and ease the yaw in and out over the same time.
4. **Give the style its timing.**
   - Every procedural channel today is a critically damped spring: no overshoot, which reads mechanical.
   - Add **anticipation** (a 2–3 frame dip before take-off and dash) and **follow-through**: 5–10% overshoot on the head, jetpack and lean recovery.
   - The Cartoon Animation Filter is the reference recipe [C44]. Gameplay-readable motion (the aim, the gun) stays exact.
5. **Show the actions we already have.**
   - **12 of the 37 authored clips never play:** both reloads, throw, swap, melee, slide, flail, three dash poses, the hard landing and brake.
   - Reloads and throws show nothing at all, and a dying soldier **vanishes on the death frame**.
   - Play the authored actions as masked upper-body overrides, and add a short stylized death beat.
6. **Bring the upper body and the face to life.**
   - The aim poses are single frames, so an armed soldier's torso is static, and the idle moves 6 bones.
   - Add an additive breathing and sway layer under the aim, idle variants with personality, head look-at, and blinks and eye looks.
   - The eye and jaw bones exist but **no vertex is weighted to them**, so the face needs a small art change first.
7. **Add secondary motion with spring chains** (VRM-style [C42][C43]) on straps, pouches, hair, antennas and jetpack tanks. This needs a few optional bones added to the shared skeleton.
8. **A creator stage that flatters the style.**
   - Auto-frame the camera per tab.
   - A studio key/fill/rim with a soft contact shadow, so the soldier stops floating.
   - A creator-only HD head texture with clean toon face normals. Today a face texel spans **≈ 9 device pixels** at the Face focus on a 2× laptop.
   - Equip reactions, and render only when something changes.
9. **Clips: stylized-friendly sources first.**
   - The CC0 Quaternius Universal Animation Library [L10] first.
   - CMU [L1] and 100STYLE [L14] for timing reference.
   - Retarget in the installed Blender 5.2.1 with the free Retarget extension [B1], then stylize in `clips.py`.
   - Higgsfield is for reference video and VS backdrops, not for motion [H1]–[H3].
10. **Avatars and the VS poster from one renderer.**
    - A portrait renderer on the game's existing WebGL context, cached by the look's hash.
    - The VS poster is DOM cards of those renders, shown at the countdown's start inside today's 5 s countdown. It never delays GO.

---

## 1. What we have

### 1.1 The character

| Part | Today | Source |
|---|---|---|
| Skeleton | `shared-v1`, 34 joints: 25 deform plus sockets (`socket_weapon_L/R`, `socket_offhand_IK`, `socket_jetpack`, `socket_hat`, `socket_back`, `socket_nameplate`, `sling_back`, `holster_thigh`). **No finger and no twist bones.** | `rookie_body.glb` skin |
| Proportions | 1.5 m, head ≈ 35% of the height (chibi), hip 0.46 m, leg 0.35 m | art check, forge notes |
| Mesh | LOD0 body **3,085 vertices / 2,349 triangles**; LOD1 1,448 / 999. The 4,000-triangle cap includes parts. One merged SkinnedMesh per soldier. | measured |
| Skin weights (LOD0) | 640 vertices rigid (one bone ≥ 0.99); 1,681 with 3–4 influences. **No vertex is weighted to `eye_L`, `eye_R`, `jaw`, `toe_L` or `toe_R`.** | measured |
| Textures | Body dye albedo and mask 512² (LOD1 256²), parts 256². The head takes 42% of the used UV area at the **same density as the body: 203 texels per metre** (LOD1: 114). | measured |
| Shading | `DyeMaterial` (MeshToonMaterial, 3-step ramp), an inverted-hull outline of 2 px × DPR, and a toon rim band (`material.rim`, set per map, off in the Locker) | `character/` |
| Clips | **37** in `rookie_anims.glb`, keyed procedurally in Blender by `art/pipeline/clips.py` (not motion capture), 30 fps, linear keys | measured, `clips.py` |

**The clips** (duration in seconds; ✓ = the renderer plays it):

| Group | Clips |
|---|---|
| Ground loops | ✓ idle 2.0 (6 bones), ✓ crouch_idle 2.0, ✓ walk_slow 0.70 (planted), ✓ walk 1.0 (**not planted**), ✓ run 0.333 (planted), ✓ crouch_walk 0.40 (planted), slide 0.40 |
| Air | ✓ jet_ascend 0.80, ✓ jet_hover 1.2, ✓ fall 0.667 |
| One-shots | ✓ land 0.30 (additive dip), land_hard 0.50 |
| Aim poses (single frame) | ✓ `aim_{pistol, dual, rifle}_{down90, down45, level, up45, up90}`: 15 poses |
| Upper-body actions | reload_rifle 1.6, reload_pistol 1.0, swap 0.5, throw 0.6, melee 0.467 |
| Action poses (single frame or loop) | flail 0.6, dash_side, dash_up, dash_down, brake |

So 12 authored clips are unused:

- The motion layer fakes flail, the dash poses, brake and the landing procedurally.
- Melee is `swing.ts` and the weapon switch is `sling.ts` (IK only).
- **Reload and throw show nothing.**

### 1.2 How a soldier animates (per frame, `avatar.ts`)

1. **Restore:** posed bones go back to last frame's animation pose (the mixer skips unchanged values, so procedural offsets would otherwise pile up).
2. **Aim poses** (`holds.ts AimClips`): the held family's 5 poses blended by elevation. **The set switches with a weight jump from 0 to 1.** While they show, `setUpperBody(false)` rebuilds the locomotion layers without upper-body tracks.
3. **Locomotion** (`locomotion.ts LocoLayer`):
   - weights and times driven by hand each frame, through critically damped springs;
   - the ground base pose (idle, crouch_idle) plus the gait cycles as **additive** deltas;
   - every cycle phase-locked to one gait phase;
   - a 1D speed blend: walk_slow → walk → run;
   - the air pose blended by vertical speed;
   - landing as an additive dip.
4. **`mixer.update`**, then the posed bones are saved.
5. **Facing turn:** yaw steps at a constant `TURN_RATE` (π / 0.12 rad/s = 1,500°/s) between ±60° (the 3/4 view), through facing the camera.
6. **Motion layer** (`motion.ts`): lean and bank, landing squash by a hip drop (never scale), launch flail, dash pose, and hit reactions (flinch, head snap, twist, buckle; ≈ 0.25 s).
7. **Feet** (`FootPlanter`): two-bone IK holds a planted foot with 70 ms fades. Up to 3 raycasts per grounded soldier per frame.
8. **The rest:** weapon switch (sling), melee swing, aim (spine pitch, two-bone IK arms, the gun along the aim, the support hand on the foregrip), guns on the body, shield, recoil, jet flame, blob shadow.

**The springs** (critically damped; 90% of a step takes 3.89 / ω):

| Channel | ω (rad/s) | 90% in |
|---|---|---|
| Ground ↔ air pose | 22 | 177 ms |
| Crouch | 14 | 278 ms |
| Step amplitude | 16 | 243 ms |
| Walk ↔ run blend | 10 | 389 ms |
| Jet ascend / fall weights | 10 | 389 ms |
| Lean | 16 | 243 ms |
| Dash pose in / out | 40 / 16 | 97 / 243 ms |
| Hit reactions | 15 | 259 ms |

**Performance shape:**

- Soldiers are never frustum-culled (`frustumCulled = false`, because bind-pose bounds don't follow the pose).
- Every soldier runs its mixer, motion, IK and foot raycasts every frame, whether on screen or not.
- LOD1 is used only for remote soldiers on Low.
- There is no animation LOD.

### 1.3 The creator and the Locker stage (`locker/turntable.ts`)

- Its own `WebGLRenderer` (antialias, DPR ≤ 2), released with `forceContextLoss` on exit.
- Toon material plus outline; hemisphere, key and rim directional lights in three presets (lobby, night, desert).
- A flat background colour, a toon floor disc, **no shadow**.
- **Only the idle clip**, played plainly.
- Camera focus by hand: Full (3.6 m), Face (1.8 m, FOV 28°), Back. Zoom 0.55–1.6×.
- **Renders every frame** at the display rate, even when nothing moves. Uses `Clock`, deprecated in three.js r183 in favour of `Timer` [C16].

### 1.4 Avatars and the pre-match today

- **Avatars:** the player's initial in a `.avatar` disc in the lobby, Results, the HUD scoreboard and Home. Bots get a bot icon.
- **Before a match:**
  1. The map loading screen (tips, ≤ 8 s wait for the map's art).
  2. The lobby warm-up (free play until Ready).
  3. The **5 s countdown**: a 1.6 s map intro, "Match 1" while more than 3 s are left, then 3-2-1 and GO.
- **Modes:** free-for-all deathmatch only (`MAX_PLAYERS` 16). Team modes (4v4, 4v4v4) aren't in the sim yet.
- **Looks on the wire** (protocol v19) are in progress by the match-presentation agent, whose PR 2 (avatars, team cards, VS poster) waits for this spec.

---

## 2. What's rough, measured

**Method.** A throwaway vitest probe (not committed) did the following:

- drove `Avatar` at 60 Hz on the real skeleton and clips (`rookie_anims.glb`, as `render3d/test/rookieRig.ts` loads them);
- used scripted player views on the movement-test map's flat floor, the harness `feet.test.ts` uses;
- decoded the real LOD0/LOD1 body meshes with the meshopt decoder for the mesh numbers.

"°/frame" is the largest change of any bone's local rotation between two frames. For scale:

- a standing idle changes ≤ 0.2°/frame;
- a full 5 m/s run cycle peaks at about 29°/frame (legs).

| What | Measured | Reads as |
|---|---|---|
| Rifle → pistol switch, standing | `hand_L` **148.5°** and `upperarm_L` 40° in **one frame**, then still | The support hand teleports off the foregrip |
| Rifle → unarmed (gun dropped or gone) | `upperarm_R` **76.7°**, `clavicle_R` 35° in one frame | The gun arm snaps to the idle |
| Pistol → unarmed | `hand_R` 95.8° in one frame | The same |
| Facing turn, standing | Yaw 25°/frame for ≈ 5 frames, no ease; **each foot moves 0.34 m** | The soldier swivels on a turntable; the feet skate |
| Contact-foot speed (the lowest foot within 1.5 cm of the floor, with the planter on), as a share of ground speed | 0.5 m/s: **0%** · 1.5 m/s: **66%** · 2.5 m/s: 14% · 3.5 m/s: 5% · 5 m/s: 10% | The walk band skates. The planter holds a foot (weight ≥ 0.9) on only 10% of foot-frames at 1.5 m/s and 2–5% above. |
| Jet take-off | `jet_ascend` reaches 90% weight **517 ms** after leaving the ground with a 12 m/s² climb. With the sim's real thrust (38 m/s² against 20 m/s² gravity, plus the kick) the ω = 10 spring alone still takes ≈ 0.39 s | The pose arrives after the body is already flying. There's no take-off beat. |
| Jet stop | Peak 1.6°/frame; the fall pose blends in over ≈ 0.4 s | Smooth but floaty; no "catch" |
| Landing at 10 m/s | `calf_R` **38°** in the touch-down frame, then 15°, 9°, 4° | A one-frame knee snap; a hard landing wants 2–3 frames of attack |
| Landing at 4 m/s | 7°, 4°, 6° … | Fine |
| Crouch | 14.5°/frame peak (the crouch spring, ω = 14) | Fine |
| Run stop / start | Peaks 11.5° / 30°/frame, no foot slide while planted | Fine (springs) |
| Creator, Face focus | 0.90 m of height in view. Head texels at 203/m: **≈ 9 device px per texel** on a 1,600-device-px stage (a 1080p laptop at 2×), ≈ 3.3 on a 600 px phone stage. Zoomed in (0.55×): ≈ 16 px per texel. | A soft, slightly blurry face, where people look first |
| In game | A soldier is about 80 px tall at 1080p: ≈ 0.26 px per texel | Fine: in play, feel is about motion, not texels |

---

## 3. What the research says

### 3.1 Stylized motion, which is our direction

- **Personality first.** A hero-shooter animator's GDC 2016 Animation Bootcamp talk walks one hero from design to animation and shows how movement is built from the character's personality, along with "traps to avoid" for appealing characters [G1].
  - **For us:** the male and female soldiers should each get one or two signature idles and a run attitude. The base mechanics stay shared.
- **Stylized 3D can feel hand-made.** Arc System Works rebuilt a 2D fighter "within a modern full-3D graphical framework", with custom cel shaders and rigs [G2]. Its slide-level details (limited animation, edited face normals) weren't verifiable from the pages I could open, so this doc doesn't rely on them.
- **The Cartoon Animation Filter** (SIGGRAPH 2006) [C44]:
  - It adds back a smoothed, inverted copy of a motion's acceleration (a Laplacian-of-Gaussian kernel). That produces anticipation, follow-through, exaggeration and squash and stretch from any input curve.
  - It has one strength parameter, and the authors applied it to motion-capture curves among other inputs.
  - A follow-up adds slow-in and slow-out to motion capture [C45].
  - **For us:** apply it to the *procedural* signals (lean, the turn's yaw, the dash pose weight, landing depth), not to the aim.
  - The filter looks ahead in time, so in real time use its causal cousin: a slightly **underdamped spring** on the target.
- **Springs as a toolkit.** Holden's "Spring-It-On" derives exact critically damped and damped springs, spring-based smoothing, and inertialization from the same maths [C18].
  - Our code uses only the critically damped one, deliberately with no overshoot.
  - For stylized follow-through, use a damping ratio of 0.6–0.8 on secondary channels (head lag, jetpack sway, lean recovery). That gives 5–10% overshoot.
- **Big-head specifics** (our own analysis, from the rig):
  - The head is a third of the body, so head motion dominates what reads.
  - The motion layer already counter-rotates the neck to steady the head (`LEAN.neckCounter`). Keep that for aim stability, and add a small lagging overshoot on the head for life.
  - Arms are short: hand-keyed angles miss the gun, which is why `clips.py` solves aim and action poses by IK. Imported clips need the same IK pass.
- **Squash and stretch, within the fairness rules.**
  - docs/04 §1 forbids anything that shrinks the visible body below the hitbox envelope.
  - motion.ts already learned that scaling the root skews the aim (review M1).
  - **Rule:** in play, squash by bending (hips drop, knees take it). Scale only in the creator and the VS poster.
- **Motion capture on chibi proportions.**
  - Copying rotations between skeletons of different proportions doesn't put hands and feet in the same places. It needs constraint- or IK-based retargeting to keep contacts [C46].
  - Short-legged targets show sliding or floating feet [C47].
  - Realistic mocap on a big-headed body also reads heavy. Use mocap for *timing and weight shifts*, then exaggerate the poses (×1.2–1.4 on spine and arm arcs), trim ease-ins and add holds.

### 3.2 What three.js gives us, and what it doesn't

We're on three.js r186 (`0.186.1`).

- **Crossfades are linear and start from 0 or 1.**
  - `fadeIn`/`fadeOut` schedule a two-key `LinearInterpolant` from 0 to 1 (or 1 to 0) [C1][C2].
  - Interrupting a half-done fade snaps the weight. The official walk example works around it with a private `_scheduleFading` from the current weight [C6].
  - Our locomotion avoids all of this by driving weights by hand through springs. That is the right call.
- **Weights below 1 bleed toward the rest pose.** If the summed weight is below 1, the remainder comes from the saved original state [C3]. So weight sets must sum to 1, which the springs do today.
- **Additive clips are parent-local.** `makeClipAdditive` multiplies quaternion keys by the reference's conjugate [C4]. These are not the mesh-space additives engines use for aim offsets [C25], so our aim layer's choice (absolute aim poses plus procedural pitch) stays right.
- **Not built in:** state machines, blend trees, sync groups, inertialization, root-motion extraction, bone masks and eased fades.
  - Masks are done by filtering a clip's tracks by bone name (we do: `filteredClip`).
  - IK exists only as the `CCDIKSolver` add-on: iterative, no pole vector [C7]. Our analytic `solveTwoBone` is better for limbs [C20].
- **Costs:**
  - Each frame `Skeleton.update()` multiplies one matrix per bone and re-uploads the bone texture [C8].
  - At scale the CPU dominates: about 75% of the time goes to the mixer, `updateMatrixWorld` and the skeleton update. Updating every N frames, or sharing skeletons per state, multiplied the count of soldiers at 60 fps [C13].
  - `SkinnedMesh` bounds are computed once at the first pose, which is why we turn culling off [C9].
- **Recent releases:**
  - r183 added `BezierInterpolant` and deprecated `Clock` for `Timer`. `Timer` uses the Page Visibility API to avoid huge deltas after a tab switch, which make mixers jump [C11][C16].
  - Nothing in r172–r186 adds a state machine, blend trees or IK to the core.

### 3.3 Transitions: crossfades versus inertialization

- **Crossfade norms:**
  - 0.2 s is a "normal blend time" [C19];
  - one engine's default transition is 0.25 s [C41];
  - inertial blends work best under 0.4 s and not between extremely different poses [C22].
- **Linear crossfades look floaty.** Two motions are averaged for the whole blend, so their velocities partly cancel and feet slide. Engines offer eased curves (cubic, Hermite, sinusoidal) [C23].
- **Inertialization** (Bollo, GDC 2018 and SIGGRAPH 2017 [G3]):
  - At the switch, record the source pose's difference from the target and its velocity.
  - Fit a decaying curve (quintic) that starts at that difference and velocity and reaches zero.
  - Add the curve to the **target** animation only.
  - The source is never evaluated again. The talk reports 60% less cost than a blend.
- **Holden's spring version** [C18] keeps a per-bone offset and decays it with a critically damped spring of a set half-life. Back-to-back transitions chain naturally.
- **Holden's "dead blending"** [C19] extrapolates the source pose with its velocity and crossfades with a smoothstep. It needs only the current pose.
- **For us:** our weights already move smoothly. The pops come from **discrete pose replacements outside the mixer**: IK targets that jump, aim sets that swap, `setUpperBody` rebuilding layers. Inertialization on the final bone rotations fixes all of them at once, whatever caused them.

### 3.4 Locomotion: phase sync, foot sliding, turns, starts and stops

- **Blend spaces need matched cycles.** Clips must be "of similar nature and timing", with foot contacts "at the same points in normalized time" [C33]. Sync markers keep followers at the same fraction between foot plants [C24]. We already phase-lock every cycle to one gait phase.
- **Foot sliding: distance matching and stride warping** [C26][C27]:
  - advance a clip by the distance actually travelled (play-rate clamp 0.75–1.25 by default);
  - scale the stride by locomotion speed over the authored speed.
  - Practice keeps the adjustment within 15–20% and accepts a little slide beyond that (a search summary of an engine sample [C27]).
  - Our walk band fails here because `walk` has no planted stance: the Forge rebuilt walk_slow, run and crouch_walk with planted feet (#61) but left `walk` as it was.
- **In-place clips for a server-authoritative game.**
  - Root motion is "not suitable for network multiplayer setups" except for montages with a rewindable timeline [C28].
  - Holden's displacement article shows a simulated capsule driving the character, with clamped deviation that "helps with network code" [C21].
  - We are in-place already. Keep it, and warp the play rate within ±15–20%.
- **Turns, starts and stops:** shipped systems use dedicated clips (turn-in-place, starts, stops), motion matching [G4], or procedural steps.
  - An indie GDC talk built a responsive character from 13 keyframes with procedural blending [C48].
  - Our turn lasts about 80 ms (120° through facing the camera). That is shorter than any authored turn clip, so a **procedural step** fits: plant the pivot foot, lift and place the other on an arc, and ease the yaw.

### 3.5 Layers: aim, lean, actions

- Aim offsets are blend spaces of additive mesh-space poses over an aim-forward base. Yaw extremes break while moving, so it's typical to keep pitch only and let the body's facing handle yaw [C25]. That is exactly our split.
- Layering: override layers replace, additive layers stack, and an avatar mask limits a layer to body parts [C37]. In three.js, build masked clips by filtering tracks (we do).
- **For us:**
  - Play reload, throw and swap as masked upper-body overrides (weight 1 on `UPPER_BODY`, eased in and out by inertialization), with the IK hands on top.
  - Add an **additive** breathing and sway clip on spine1/spine2/clavicles/neck under the aim poses, so an armed soldier never freezes.

### 3.6 Secondary motion: spring bones

- **The VRM SpringBone 1.0 spec** [C42]:
  - Per joint: stiffness, gravity power and direction, drag, hit radius.
  - Sphere and capsule colliders.
  - Verlet integration with a length constraint, then push-out from colliders, parents first.
- **`@pixiv/three-vrm-springbone`** (MIT, v3.5.5) builds joints on plain `Object3D`s with no VRM file [C43], so it works on our glTF bones. We can use it as a reference or a dependency.
- **The engine equivalent:** a low-cost box solver with constraints and no collision [C31].
- **For us:**
  - ≤ 6 chains × 3 joints on the local player, in the creator and in the VS poster; off for remote soldiers on Low and at LOD1.
  - Colliders: head and spine capsules.
  - Chain tips must stay inside the docs/04 §1 silhouette envelope.

### 3.7 IK

Analytic two-bone IK [C20][C30]:

1. Clamp the reach.
2. Set the interior angles by the law of cosines.
3. Rotate the root so the end reaches the target.
4. Use a pole for the bend plane.

We already have it (`render3d/ik.ts solveTwoBone`) for feet, arms, the support hand and the shield. The turn step and landing attack reuse it.

### 3.8 Animation LOD on phones

- One engine's update-rate optimisation "will prevent your animations from ticking too often", with 15 Hz or lower at distance [C29].
- Another engine's culling modes skip transform writes or the whole animator when the renderer is off-screen [C39].
- For three.js:
  - skip off-screen mixers and accumulate their time;
  - run distant ones at 10–15 Hz;
  - share clips;
  - for crowds, share skeletons per state [C13].
- **For us:**
  - **Off-screen:** check the pivot against the camera's view box plus a 2 m margin, and skip the mixer, motion, feet and aim.
  - **LOD1 or under 40 px tall:** 30 Hz, foot planter off (its 3 raycasts per frame are the costliest part), springs stepped with the real dt.
  - **Low preset:** remote soldiers at 30 Hz.

### 3.9 Getting better clips: sources and exact licences

Shipping a clip inside our `.glb` makes it fetchable from the browser cache, as with any web game. Licences that forbid redistributing *raw* files target asset packs; shipping inside a game is the use they allow. The table says where a legal read is still wise.

| Source | What | Licence (exact words where they matter) | Usable? |
|---|---|---|---|
| **Quaternius Universal Animation Library** [L10] | 120+ stylized clips (8-way locomotion, jog, sprint, crawl, deaths, "combat and gun"), made for low-poly characters, Mixamo-compatible rig; 45 free, all of them in FBX/GLB for $9.99+, plus `.blend` for $14.99+ | CC0: "Free to use in personal, educational and commercial projects." | **Yes. First choice for style.** |
| Quaternius UAL 2 [L11] | 130+ more; the free tier is mostly melee, knockback and idles | CC0 | Yes |
| **Mesh2Motion** [L13] | Open-source web rigging tool; its human clips come from Quaternius | "The art assets (3d models, rigs, animations) are all licensed under CC0." | Yes |
| Kenney animated characters [L12] | Idle, run, jump only | "public domain licensed (CC0)… even in commercial projects" | Yes, little value |
| **CMU Graphics Lab Motion Capture Database** [L1] | ~2,600 realistic mocap takes (BVH conversions available [L2]); no fingers | Read on mocap.cs.cmu.edu (23 Oct 2026): "This dataset of motions is free for all uses." "You may include this data in commercially-sold products, but you may not resell this data directly, even in converted form." | **Yes, inside the game.** Never sold as a pack. A courtesy credit is requested for publications. |
| CMU on a Quaternius character (RancidMilk) [L3] | 2,000+ CMU clips retargeted to a CC0 character, FBX/glTF; jittery, with root motion | "Free to use/modify/redistribute so long as you don't sell the animations themselves." | Yes (reference) |
| **100STYLE** [L14] | 4M+ frames of BVH at 60 fps, 100 styles × forward/back/sidestep walks and runs, idles, transitions. Shooter-relevant styles include Crouched, Rushed, Swat and Shielded. | "Creative Commons Attribution 4.0 International License" | **Yes, with a credit line** in the game's credits |
| **Mixamo** (Adobe) [L4][L5] | Large mocap library; needs a free Adobe ID | Help page (via search index; it blocks automated fetching): "royalty free for personal, commercial, and non-profit projects". Adobe community FAQ: "the only thing you can't do is distribute the raw character and animation files"; no use for training machine-learning models | Yes, **if the owner signs in himself** |
| **Rokoko** free motion library [L6][L7][L8] | 263 free mocap clips (FBX 30 fps, Mixamo/UE/HumanIK skeletons) behind a registration form | "Use them in any animation, VFX, game, 3D art or other 3D project you want, including for commercial use." Terms §5.3: no redistributing assets beyond their own licence | Yes (the owner fills in the form) |
| Rokoko Vision (video → mocap) [L9] | Free Starter: 30 s per month, FBX only | Commercial use of the output not stated explicitly | Reference only |
| Reallusion ActorCore [L25] | Mocap store with free clips | Games need a separate "Mass Distribution License", and content must not be extractable | **Risky for a web `.glb`.** Avoid. |
| Bandai Namco Research motion dataset [L15] | BVH | "CC BY-NC 4.0" (NonCommercial) | **No** |
| Ubisoft LAFAN1 [L16] | BVH, 4.6 h | "CC BY-NC-ND 4.0" | **No** |
| Fab Standard License [L17][L18] | Marketplace | Summary: "usage is not limited to Unreal Engine", but listings marked "UE-Only Content" are restricted. The binding text wasn't readable. | Case by case |
| Epic's Game Animation Sample [L19] | 500+ mocap clips | Reported "only licensed for use with Unreal Engine" | **No** |
| Unity Asset Store EULA [L20] | Packs such as a free "Basic Motions" | No Unity-only restriction found; users mustn't be able to "sell, transfer, distribute" the assets | Probably yes; legal read per pack |
| DeepMotion [L21] | Video → mocap | "Freemium accounts are available for personal, non-commercial use." | Paid tier only |
| Move One [L22] / Plask [L23] | Video → mocap, credits | Free-tier commercial terms unverified | Paid tier only |
| Radical [L24] | — | Portal closed 6 July 2026 | No |

### 3.10 Retargeting into our skeleton (Blender 5.2.1 LTS is installed)

- **Blender has no built-in retargeting.** None is mentioned in the 5.1 and 5.2 animation release notes [B4].
- Since 4.4, actions have slots ("Slotted Actions"), and scripts that assign actions need updating [B3].
- **Free tools:**
  - **"Retarget"** (KBS-DEV, GPL-3.0-or-later, "COMPATIBLE ONLY WITH BLENDER 5 AND HIGHER"): binds armatures, bakes constrained actions, adds a root bone and transfers root motion, with Mixamo presets [B1];
  - Expy Kit, its ancestor [B2];
  - Rokoko's Blender plugin [B5].
- **Pitfalls to plan for:**
  - **Matching rest poses:** "Both skeletons need to be in the same Rest Pose. They must both be in A-pose or T-pose." [B6]
  - **Bone roll:** a mismatch inverts elbows and knees.
  - **Scale:** Mixamo is in centimetres.
  - **Root:** Mixamo has no root bone (the hips carry translation), so zero the hips' XZ for in-place clips.
  - **Foot contact:** lost when leg lengths differ. Re-plant with IK, as `clips.py gait()` already does.
  - **Fingers:** we have none.
- **Export:** one action per clip, stashed on the NLA. glTF export in "Actions" mode names animations from the actions; tracks with the same name merge [B7].
  - Then `clips.bake_linear`, which keeps each clip keyed only on its own bones. That matters: forced sampling bakes rest keys into upper-body clips (Forge note, 18 Oct).

### 3.11 Higgsfield: what it can and can't do for animation

- **What it is:** image and video generation over 30+ models, camera-move presets, consistent characters from reference photos ("Soul ID"), lip-sync, and 5–15 s clips [H1]. Its Kling-based Motion Control moves the motion of a reference video onto a character image [H4].
- **It doesn't output skeletons, FBX or BVH.**
  - Its Blender plugin has a "Character animation" tab that returns "a fitted, weighted rig plus keyframes on the timeline — standard Blender bones and actions" [H2].
  - Quality, and how that maps to our 34-bone skeleton, are unverified. Treat it as an experiment, not a pipeline.
- **Rights:** "You own your outputs" and Higgsfield "does not restrict the commercial use of outputs"; paid plans are watermark-free [H3]. Higgsfield may train on content.
- **Good uses for us:**
  - reference video for an animator (e.g. a soldier vaulting into a jetpack climb, filmed from the side), which a person then keys or retimes;
  - VS poster and key-art **backdrops** behind our real 3D soldiers (owner decision: posters show our real characters);
  - concept turnarounds.
- **Not a good use:** feeding its video through a video-to-mocap tool for final motion. That adds the mocap tool's licence and cleanup, and generated limbs swap and slide.

### 3.12 The creator stage, for toon soldiers

- **Image-based lighting doesn't reach toon soldiers.** `MeshToonMaterial` doesn't use environment maps, so an HDRI changes nothing on our soldiers. (Poly Haven HDRIs are CC0 [P5] if a background plate ever needs one.) Light the stage with direct lights and the ramp.
- **Three-point light works when the camera is controlled.** Key, fill and rim "pop the foreground from the background", and the creator controls its camera [P12].
  - Use the existing toon rim band (`material.rim`, off in the Locker today), or one back light.
  - Keep the light *types and counts* fixed when switching presets: adding or removing lights or shadows re-links shaders and stutters [P13].
- **Soft contact shadow, cheaply.**
  - Options, cheapest first:
    1. a blob texture;
    2. a depth-from-below contact shadow (an ortho camera from under the floor, a depth pass, two blur passes, 256–512²), rendered once per pose change [P8][P9][P10];
    3. a small PCF shadow map with `autoUpdate = false`.
  - PCSS and VSM cost too much on phones (up to ~51 shadow-map reads per pixel for PCSS) [P6][P7].
  - Note that `PCFSoftShadowMap` is deprecated since r182; PCF is soft now [P7].
- **Backdrop and depth of field.** A bokeh pass re-renders the scene for depth plus a heavy composite [P16][P17]. Fake it with a pre-blurred backdrop plate in the map's palette; a three.js maintainer calls PMREM blur "too blocky" for backgrounds [P19].
- **Faithful dye colours.** For a PBR stage, Khronos PBR Neutral tone mapping reproduces base colours without hue shifts [P18].
  - Our toon stage currently uses no tone mapping, which is right for a ramp-shaded look.
  - Keep sRGB textures tagged correctly [P19].
- **Clean faces on big-headed toon characters.** Transfer normals from a simple sphere onto the face, so the toon ramp draws one clean shadow shape instead of every facet [C49][C50].
  - It is an art-side change (custom normals exported in the glTF).
  - It matters most in close-ups: the creator, avatars and the VS poster.
- **Framing per slot.**
  - Shipped character creators keep per-category camera states. Players even mod them when clothing edits frame the wrong body part [G5].
  - Camera moves of 300–650 ms on a standard ease are the norm (Material motion, via search, unverified).
  - A sensible orbit: polar angle limited, minimum distance about 2.2× the bounding radius [P20].
- **Render on demand.** Continuous rendering wastes battery on portable devices [P21].
  - Render when the camera moves, an item changes or the idle runs.
  - Cap the idle at 30 fps on phones; iOS Low Power Mode throttles rAF to 30 fps anyway [P39].
  - Targeting 60 fps drains about twice the battery of 30 fps [P38].

### 3.13 Avatars from the live character

- **Offscreen render plus readback.**
  - `readRenderTargetPixelsAsync()` (r165) uses a pixel-pack buffer and a fence, so it doesn't stall [P23][P7].
  - The author's desktop numbers at 1024²: about 10–11 ms stalled synchronously, versus about 0.5–1.2 ms for the async read.
  - `gl.readPixels` "tends to be slow especially on mobile devices" [P22].
  - A 256² portrait is 1/16 of that size.
- **Scissor into one canvas** (the `webgl_multiple_elements` example) [P24]: no readback at all, and the right tool for many live 3D views in one list. Our lists are DOM, though, so we need images.
- **OffscreenCanvas plus WebGL in a worker:** Safari 17+ [P26][P27]. But a second context in a worker means a second upload of every soldier asset. That suits batch jobs, not us.
- **Keep the context count low.** Browsers cap live WebGL contexts (about 16; the turntable already calls `forceContextLoss` for this). The game's `Renderer3D.renderer` lives for the whole session, so portraits should render through it, not a new context.
- **Shader variants.** Changing the number or kind of lights, or shadows, links new programs [P13]. A portrait scene must use the same light set as the game, or be warmed once with `compileAsync` [P33].
- **Cache:**
  - by a hash of the look plus a render version;
  - in memory (LRU), with Cache Storage or IndexedDB behind it.
  - Safari can clear script-writable storage after 7 days without use [P31], so a portrait is always regenerable.
- **A platform pattern** [G6]: server-rendered headshots by type and size, with a `Pending` state while rendering, whose URL changes when the outfit changes. Our version: a silhouette until the client render lands.

### 3.14 Pre-match VS screens

| Game | Layout | Shows | Doubles as loading? |
|---|---|---|---|
| A tactical hero shooter [G7] | Mirrored team banners, map removed "so your banners could take up the screen", a "VS" mark | Player card art, title, rank badge; account level can be hidden from non-friends [G8] | A separate loading screen follows |
| A team arena (MOBA) game [G9] | Two rows of splash cards | Name, spells, runes, rank border (opponents' hidden by default) | **Yes**: it is the loading screen; it used to show per-player load % |
| A hero battle royale [G10] | The champion squad's banners | Frame, pose, trackers, badges, a voice "intro quip" | Before the drop |
| A versus fighting game [G11] | Profile facts → a big VS → face close-ups | Interactive "game faces" during the wait | **Yes** |
| A party platform fighter [G12] | One slot per fighter, tinted by player or team colour, 2–8 players | Fighter render, costume, name | **Yes**: "If loading takes long enough, tips will appear" |
| A mobile card battler [G13] | Both players' battle banners | Frame, decoration, three badges | At battle start |
| Three-team modes [G14][G15] | A 4-2-2 three-colour mode; 3 teams of 3 in an opening cutscene | — | — |

**The patterns, in our words:**

- **Mirrored sides with a stamp in the middle.** Three sides for three teams.
- **The players' own customised characters as the hero image.**
- **Name plus one or two earned marks.** Several games hide levels from strangers, because low numbers draw abuse [G8].
- **The VS screen covers loading,** and shows progress if loading runs long.
- **Timing:** no game publishes a duration. Response-time research says about 1 s keeps the flow of thought and 10 s is the limit of attention [P35].

**Warming up during it:**

- `renderer.compileAsync(scene, camera)` (r158) uses `KHR_parallel_shader_compile` where present: Chrome and Safari, **not Firefox** [P33][P34].
- `renderer.initTexture()` uploads textures ahead of their first use [P7].
- Our own known gap (animation notes, review L1): `compileAsync` skips the shadow pass, so the skinned depth program still links at the first spawn.

---

## 4. The gaps, ranked by impact on feel

Impact = how often a player sees it × how wrong it looks. Cost: S ≤ 1 day, M ≤ 3 days, L more.

| # | Gap | Evidence | Fix | Cost | Owner |
|---|---|---|---|---|---|
| 1 | **Pose pops on discrete changes** (switch, pick-up, drop, shield, aim-set swap) | 148°, 77°, 96° in one frame (§2) | Inertialization pass on the final bone rotations (§5.1 A) | M | animation stream (new `render3d/inertia.ts`) + a 2-line call in render3d-b's `avatar.ts` |
| 2 | **Walk-band foot skate** (touch and pad partial sticks live here) | 66% of ground speed at 1.5 m/s | Planted `walk` from the Forge; stride and play-rate warping ±15–20%; planter engages on the walk stance | S code + S art | animation stream + Forge |
| 3 | **Turning swivels on the spot** | 0.34 m per foot per turn, constant-rate yaw | Procedural turn step + eased yaw + spine-leads-hips | M | animation stream (`locomotion.ts`, `FootPlanter`) |
| 4 | **Missing actions and death** | 12 clips unused; reload and throw invisible; the soldier vanishes at death | Masked upper-body actions; a 0.4 s stylized death collapse then fade (or the docs/04 ragdoll; owner decision) | M | render3d-b (aim/arms) + animation stream (death) |
| 5 | **Static armed torso, stiff idle** | Single-frame aim poses; idle animates 6 bones | Additive breathing/sway under aim; 2–3 idle variants per body; head look-at | M | animation stream + Forge clips |
| 6 | **No anticipation or follow-through** | Critically damped everywhere; take-off pose 0.4–0.5 s late; 38° knee snap on hard landings | Take-off dip (2–3 frames) and stretch; landing attack over 2–3 frames with 5–8% rebound; underdamped secondary channels (ζ 0.6–0.8) | S–M | animation stream |
| 7 | **Creator stage undersells the soldier** | Face texel ≈ 9 device px; no contact shadow; flat background; idle only; manual framing; continuous rendering | §5.1 H: stage upgrade, creator-only HD head texture, auto-framing, equip reactions, render on demand | M + art | creator owner (ui-playtest) + Forge |
| 8 | **No secondary motion** | Rig has no strap or hair bones | Spring chains (VRM algorithm) on new optional bones | M + art | animation stream + Forge |
| 9 | **A face that can't move** | Eye and jaw bones unweighted; eyes painted | Eye geometry (or blink texture frames) weighted to eye bones; blinks and eye look in creator, avatars, VS | S code + M art | Forge + animation stream |
| 10 | **No animation LOD** (phones) | Every soldier animates and raycasts every frame, on screen or not | Off-screen skip; 30 Hz and no planter at LOD1 or < 40 px; Low preset remote 30 Hz | S | render3d-b (the loop) + animation stream (the layers) |
| 11 | Wrist pinch risk | No twist bones; IK and `orientSocket` turn hands freely | Check in the creator with weapons; add forearm twist bones only if it shows | S check | Forge |
| 12 | `Clock` → `Timer` | Deprecated in r183; tab-switch deltas | Swap in `Timer` with `connect(document)` in the turntable (the game loop is already fixed-step) | S | creator owner |

---

## 5. The plan

### 5.1 What to build in code

**A. Inertialization pass** (`render3d/inertia.ts`, animation stream; one call at the end of `Avatar.update`, inside an `// --- animation ---` block).

- **Triggers:**
  - the active weapon or dual state changes;
  - the hold family changes;
  - the aim set changes or `setUpperBody` flips;
  - the shield state changes;
  - a swing ends;
  - the weapon is dropped or taken;
  - the death beat starts.
- **Not triggered:** respawns, which are teleports.
- **On a trigger:** after this frame's pose is built, for each bone in the inertia set, `offset = previousFinal × inverse(newFinal)` and `velocity = the previous frame's angular velocity`.
- **Each frame:** decay the offset with a critically damped spring of half-life **60–90 ms** [C18], and set `final = offset × pose`.
- **Bookkeeping:** every bone it writes joins the avatar's `posed` restore list. The mixer skips unchanged values, so offsets would otherwise pile up (see `avatar.ts`).
- **Cost:** ≤ 34 bones × (an exp and two quaternion multiplies) for ≤ 0.3 s after a trigger. Zero otherwise.
- **Test:** no bone turns more than 20°/frame on any switch in the probe's scenarios (§7).

**B. Walk band** (animation stream + Forge).

- A planted `walk` in `clips.py gait()`, like #61's: authored for 1.5 m/s, stance ≈ 55%.
- Measure its stance as `measureCycle` does.
- Clamp the play-rate warp to ±18% around each clip's authored speed, and let the stride stretch take the rest.
- Lower the planter's walk-band fade so a stance at 1.5 m/s holds at weight ≥ 0.9 for most of the stance.

**C. Turn step** (animation stream).

- The yaw follows a smootherstep over a fixed ~100 ms (readability unchanged: still under ~6 frames).
- The foot on the new facing side stays planted (IK) while the other lifts 3–4 cm on an arc and lands at its new stance spot.
- The hips dip 1–2 cm.
- Spine2 and the head lead the hips by one frame, with a 3–5° overshoot (ζ ≈ 0.7). The aim layer keeps the gun exact.
- In the air: no step; a 6° roll into the turn instead.

**D. Upper-body actions and death** (render3d-b for the arms, animation stream for the body).

- **Reload:** play `reload_rifle` / `reload_pistol` as masked overrides while `reloadTicks > 0`, the play rate fitted to the weapon's reload time. The gun stays on the socket, and the support hand follows the clip.
- **Throw:** play `throw` on the grenade release event, 0.6 s, with the aim restored by inertialization.
- **Swap:** keep `sling.ts`'s procedural carry (it matches real equip times). Inertialization removes the pops at its ends.
- **Death:** a 0.4 s stylized collapse (knees, then torso, a final settle), then a 0.25 s fade or dissolve. Alternatively the docs/04 Verlet ragdoll. The owner decides (§6).

**E. Life** (animation stream + Forge).

- An additive `breathe` loop (2.5–3.5 s, spine and clavicles ±1.5°, the head trailing) under the aim poses and the idle.
- 2–3 idle variants per body, switched every 8–15 s with inertialization: weight shift, look around, check the gun, roll the shoulder.
- **Head look-at:**
  - in the creator, toward the pointer, clamped to ±25°;
  - in play, toward the aim, as today.
- **Blinks and eye looks** once the Forge weights the eyes: a 120 ms blink every 2–6 s at random; eyes lead the head by 50 ms.

**F. Spring chains** (`render3d/springs.ts`, animation stream; Verlet + length constraint + capsule colliders, after [C42]).

- On optional bones the Forge adds: `strap_*`, `pouch_*`, `hair_*`, `antenna_*`, `tank_*`.
- They're optional in `shared-v1`'s name list, so bodies and parts without them still assemble.
- Budget:
  - the local player, the creator and VS: all chains;
  - remote soldiers: Medium and High only;
  - never at LOD1.

**G. Animation LOD:**

- **Off-screen skip:** add `Avatar.update(…, lodHint)`; Renderer3D passes `visible`, `pixelHeight` and the preset.
- **Below 40 px, or remote on Low:**
  - update at 30 Hz with the accumulated dt;
  - planter off;
  - springs still exact (they take any dt).

**H. Creator stage** (creator owner; `locker/turntable.ts` is shared with the Locker).

- **Auto-framing per tab**, eased 450 ms on `--ease-travel`. The player can still drag and zoom; a tab change re-frames.

  | Tab | Framing |
  |---|---|
  | Hair, Headwear, Eyewear | Head and shoulders, yaw 20° |
  | Top, Jacket, Gloves | Waist up |
  | Trousers, Boots | Full body, the camera 0.3 m lower |
  | Jetpack, Exhaust, Trail | From behind at 150°. The flame preview runs, and the trail plays a short dash loop. |
  | Body, Colourways | Full body |

- **The studio:**
  - one key, one fill (hemisphere) and the toon rim band at ~0.35;
  - a contact shadow rendered once per pose change at 256² (phone) or 512² (desktop);
  - a backdrop plate: a radial vignette in olive-900 with a soft floor gradient, or a pre-blurred map plate per light preset;
  - no tone mapping change.
- **Equip reactions:** on a slot change, a 0.6–1.0 s one-shot per tab (adjust helmet, flex gloves, stamp boots, shrug the jetpack, look down at the sleeve), then back to idle through inertialization.
- **Quality only here:**
  - **Texture:** a "hero" body albedo and mask at 1024² (or a separate 512² head texture) loaded only in the creator, avatars and VS. The mesh stays the same.
  - **DPR:** up to 2 on phones, 2–3 on desktop.
  - **MSAA** on the canvas (already).
  - **Outline width** scaled with zoom.
- **Render on demand:** render while dragging, easing, an equip reaction or the idle is visible. The idle runs at 30 fps on phones, then rendering stops 3 s after the last input if Reduce motion is on.
- **`Timer`** instead of `Clock`.

**I. Avatar renderer:** §7. **J. VS poster:** §8.

### 5.2 Clips to source, and from where

Everything goes through the same pipeline (§5.3) onto `shared-v1`, then gets a stylize pass. "Hand-key" means `clips.py`, solved by IK as the existing aim and action poses are.

| Clip(s) | First choice | Then | Licence note |
|---|---|---|---|
| Planted `walk` | Hand-key (`clips.py gait()`, as #61) | 100STYLE "Neutral" walk for timing [L14] | CC BY 4.0: credit |
| Turn step | Procedural (§5.1 C) | — | — |
| Take-off dip, jet stop catch, landing attack | Hand-key single poses (additive) | CMU jump take-offs and landings for timing [L1] | CMU: in-game OK, no resale |
| Breathing additive, idle variants (×3 per body) | Quaternius UAL idles [L10] | Rokoko free pack idles [L7]; Mixamo idles [L4] | CC0 / commercial OK / Adobe ID |
| Reload (rifle, pistol), throw | Keep the Forge's IK-solved clips; retime with a reference | Rokoko or Mixamo reloads as timing reference | — |
| Death collapse (2 variants) | Quaternius UAL deaths [L10] | CMU falls [L1] | CC0 / CMU |
| Equip reactions (5) | Hand-key | Mixamo "look at hands"-type clips as reference | — |
| Poster and portrait poses (6 + 1) | Hand-key (single poses, solved like aim poses) | Rokoko free pack as pose reference | — |
| Victory and defeat (results; optional) | Quaternius UAL | Rokoko free pack | CC0 / commercial OK |
| Run start and stop accents (optional) | Procedural (lean + springs already good) | 100STYLE transitions [L14] | CC BY 4.0 |

### 5.3 The clip pipeline (art session)

1. **Collect** the source clip (FBX or BVH) into an untracked `art/source/mocap/<source>/` with a `LICENCE.txt` copied from the source page. The repo records only the licence and the provenance.
2. **Retarget in Blender 5.2.1** with the Retarget extension [B1]:
   - map the source rig onto `shared-v1`, matching rest poses first (A or T);
   - bake;
   - zero the hips' horizontal travel for in-place;
   - fix bone rolls.
3. **Stylize:**
   - exaggerate key poses (spine and arm arcs ×1.2–1.4);
   - cut ease-ins by 20–30% and add 2–4 frame holds on key poses;
   - solve the arms by IK onto the gun sockets (short chibi arms);
   - re-plant feet with `gait()`'s solver.
4. **Bake** linear with `clips.bake_linear`, each clip keyed only on its own bones. Name it in `rookie.json clips`.
5. **Check:**
   - `tools/asset-check`;
   - the animation lab frame strips (`/animlab.html`, `scripts/animation-shots.mjs`);
   - the probe's numbers turned into tests (§9).

---

## 6. What we need from the owner

Only real asks. Each has a free alternative. The first three are decisions; the rest are optional sign-ins or purchases.

| # | Ask | Why | Effort for the owner | Free alternative |
|---|---|---|---|---|
| 1 | **Approve the motion-data sources:** CC0 sets (Quaternius UAL, Mesh2Motion, Kenney), **the CMU database** (in-game use is free; never resold), and **100STYLE** (CC BY 4.0: one credit line in the game's credits) | Licence policy is the owner's call; CC BY needs a visible credit | A yes or no | CC0 only plus hand-keying (slower, still fine) |
| 2 | **Death presentation:** (a) a 0.4 s stylized collapse then fade (recommended, war tone, no gore), (b) the Verlet ragdoll docs/04 planned, or (c) keep today's instant vanish | Today the soldier disappears on the death frame | Pick one | — |
| 3 | **VS poster timing:** inside today's 5 s countdown (≈ 2 s of poster, no change to match flow; recommended), or lengthen the countdown to 7 s for team modes | A longer poster delays every match start | Pick one | — |
| 4 | *Optional:* **Quaternius UAL Pro, $9.99** (all 120+ clips in GLB/FBX; $14.99 adds the `.blend`) | The free tier has 45 clips; Pro covers idles, deaths and gun poses in one licence-clean set | A purchase, about 5 minutes | The free 45 clips |
| 5 | *Optional:* **A Mixamo login on your own Adobe ID**, about 10–15 minutes, to download a list of ~15 clips we give you (idles, reloads, reactions as reference) | Mixamo needs an Adobe account; agents don't create accounts | 10–15 minutes | Quaternius UAL + the Rokoko free pack |
| 6 | *Optional:* **The Rokoko free pack's form** (name and email), about 5 minutes | 263 free commercial-use mocap clips behind a registration form | 5 minutes | Quaternius UAL |
| 7 | *Optional:* **≤ 15 Higgsfield credits** inside the Forge cap for 3–5 VS backdrop plates in the maps' palettes (our real soldiers are rendered on top) | Backdrops only; the posters' characters stay our 3D fighters | Approve the credits | Blender renders of the map kits with a depth blur |

---

## 7. The avatar renderer: spec

**Goal:** every player's portrait is their real, current look (looks on the wire, protocol v19), the same everywhere, cheap on phones, and never a frame hitch in play.

### 7.1 Output

- **Sizes:** 64, 128 and 256 px square (CSS 32/64/128 at 2×). Transparent background. The frame is drawn in CSS: Field Print plate, team-colour edge, bot tag.
- **Pose:** `portrait`, a single-frame pose from the idle with:
  - the head turned 15° toward the camera;
  - a slight chin-down;
  - eyes on the camera once eyes can move.

  Variants: `portrait-win`, `portrait-down` (Results), `poster-1…6` (VS, full body).
- **Camera:** 3/4 front (yaw 20°), FOV 20°, framed from the collarbones to just above the headgear's top. Framing is computed from the head bone and the headgear part's bounds, so tall hats fit. The big head makes head-and-shoulders read well even at 32 px.
- **Light:**
  - the creator studio's key and fill;
  - the toon rim band at 0.35;
  - the outline at 2 px for ≥ 128, 1.5 px below;
  - **the same light types and counts as the game scene, so no new shader program links** (checked with the link logger).
- **Texture:** the hero head texture when loaded (§5.1 H), else the normal one.

### 7.2 API (`apps/web/src/portrait/`; owner: the match-presentation agent)

```ts
export type PortraitPose = 'portrait' | 'portrait-win' | 'portrait-down' | `poster-${1 | 2 | 3 | 4 | 5 | 6}`;

export interface PortraitRequest {
  look: CosmeticLoadout;            // or wire ids → cosmeticLoadoutFromWireIds
  size: 64 | 128 | 256 | 512;       // 512: VS poster full body (512×768)
  pose?: PortraitPose;              // default 'portrait'
}

export interface PortraitImage {
  key: string;                      // cache key (below)
  url: string;                      // blob: URL for <img>, valid while cached
  width: number; height: number;
}

/** Cached portrait now, or null (show the fallback and subscribe). */
export function peekPortrait(req: PortraitRequest): PortraitImage | null;
/** Queues a render if needed; resolves when the image exists. Never rejects: falls back to the atlas image. */
export function getPortrait(req: PortraitRequest, priority?: 'now' | 'idle'): Promise<PortraitImage>;
/** Renders a whole lobby's portraits ahead of time (lobby join, looks changed). */
export function warmPortraits(reqs: readonly PortraitRequest[]): void;

// React: <Portrait look={…} size={64} team="volt" name="Ade" bot={false} />
//  renders the fallback at once (silhouette in the team colour + initial), swaps in the image on resolve
//  (a 120 ms cross-fade; none under Reduce motion), alt="" and aria-hidden (the name is next to it).
```

### 7.3 How it renders

1. **One `PortraitRenderer`** uses the game's `Renderer3D.renderer`: one WebGL context for the whole app, public already.
   - It has its own `Scene` and `PerspectiveCamera`.
   - It pools **one** `CharacterInstance` from the shared `CharacterAssembler`, so the geometry cache is shared.
   - It renders into a `WebGLRenderTarget` with 4 MSAA samples.
2. **Per job:**
   1. `instance.setLoadout(look)` and await the parts (they are usually already loaded: the lobby shows these soldiers).
   2. Pose the skeleton (sample the pose clip at t = 0; `skeleton.update()`).
   3. Set the outline viewport.
   4. Save the renderer state (render target, viewport, scissor, clear colour and alpha, autoClear). **Never toggle `shadowMap.enabled`** (that re-links shaders [P13]).
   5. Render, then restore the state.
   6. `await renderer.readRenderTargetPixelsAsync(…)` [P23].
   7. `ImageData` → `createImageBitmap` → a 2D canvas → `toBlob('image/webp', 0.9)` → a blob URL.
3. **Scheduling:**
   - **In menus:** up to 4 jobs per frame.
   - **In play:** at most one job per frame, and only when the last frame left ≥ 4 ms of budget or the local player is dead, in the scoreboard, or in the lobby. Otherwise the job waits.
   - The job's readback never blocks: it is async.
4. **Cache:**
   - **Key:** `p1:{RENDER_VERSION}:{artVersion}:{cosmeticLoadoutHash(look)}:{pose}:{size}`. The hash covers every slot, skin and dye through the wire ids. `artVersion` is the hash of `rookie.json` plus the parts index.
   - **Memory:** an LRU of 96 entries.
   - **Disk:** Cache Storage (`mf-portraits-v1`), regenerable. Safari eviction is fine [P31].
   - Invalidated when the art version changes.
5. **Fallbacks, in order:**
   1. The cached image.
   2. A **pre-rendered portrait atlas**: per body × skin tone × default headgear, made offline by the art pipeline (`render_views.py` already renders views), a few hundred KB of WebP.
   3. A team-tinted SVG silhouette with the initial.

   The swap to the live render is a 120 ms cross-fade.
6. **Bots** use their seeded looks (`botLook(seed)`, match-presentation PR 1) through the same path.

### 7.4 Where it's used

| Place | Size | Notes |
|---|---|---|
| Home profile, Locker, Creator header | 128 / 256 | The player's own; re-rendered on Save |
| Lobby slots, team panels (4v4, 4v4v4), friends (social) | 64 / 128 | Warmed on lobby join and on every looks change |
| HUD scoreboard, kill feed | 64 (shown at 24–32 CSS px) | Cached only; never rendered mid-fight |
| Results / Debrief | 128 (`portrait-win` / `portrait-down`) | — |
| VS poster | 512 × 768 (`poster-n`) | §8 |

### 7.5 Acceptance criteria

- Portraits match the live look: a dye, skin or part change shows on the next render (key change). Tested with two looks differing in one dye.
- No new shader program links after the first portrait (the link logger), and none during play.
- Cost on a mid phone (Pixel 7 class) and an iGPU laptop, measured with the perf overlay:
  - ≤ 4 ms main-thread per 128 px portrait job, including the encode;
  - no frame over 20 ms caused by portraits in a 16-player lobby warm.
- A cached hit costs 0 renders. After a reload, portraits come from Cache Storage within one frame of the list mounting.
- The fallback silhouette shows at once; nothing pops without the 120 ms cross-fade (none under Reduce motion).
- The context count stays at one game context, plus the creator's only while it's open.

---

## 8. The VS poster: spec

**Goal:** at the start of every match, a poster of the fighters in their real looks, war tone, readable on a phone in landscape. It covers the last loading and never delays GO.

### 8.1 When

- At the **countdown's start**: the `Countdown` phase; 5 s by default (`packages/sim/src/match.ts`).
- The poster replaces today's 1.6 s map intro and the "Match 1" beat:

  | Time into the countdown | What shows |
  |---|---|
  | 0–0.5 s | The poster comes in |
  | 0.5–1.6 s | Hold |
  | 1.6–2.0 s | The poster folds into a slim strip at the top, with the map name |
  | At 3 s left | 3-2-1 and GO play as today |

  With a 7 s countdown (owner decision, §6), the hold grows to 3.6 s.
- **Rematch:** the same, 1.2 s shorter.
- **Training against bots:** the same poster with bot tags.
- **Joining mid-match:** no poster.
- **Dismissing:** any key, tap or button folds the poster early, for the local player only.

### 8.2 Layouts (desktop 16:9 and phone 812×375 landscape, inside the safe areas)

| Mode | Desktop | Phone |
|---|---|---|
| **FFA, 2–8** (today's mode) | A roll call: full-body renders in one row, "you" first and lifted with a volt underline; stamp **ALL VS ALL** and the rules line ("First to 25 · 8 min") | Portrait cards in one row (up to 8 at 88 px wide) |
| **FFA, 9–16** | Two rows of compact portrait cards | Two rows of 8 at 72 px |
| **1v1** | Mirrored halves; each soldier full body in a poster pose, facing the centre; a big stencil **VS** in the middle (P7 stamp) | The same, with renders at 60% of the height |
| **2v2 – 4v4** | Two mirrored squads, staggered (front row 2, back row 2 for 4v4); team names and colours on the outer edges; VS in the middle | Two columns of portrait cards (name + portrait), VS between |
| **4v4v4** | Three columns of 4, with VS marks between them; each column's edge in its team colour | Three columns of compact cards (56 px portraits) |

**Per player:**

- the render (pose chosen from the player's saved poster pose; default by body);
- the name;
- **You**, **Host** and **Bot** tags;
- the party marker once the social agent ships parties.

**No level, rank or K/D:** levels aren't adopted (owner decision, 19 Oct), and showing them to strangers invites abuse [G8].

### 8.3 How it's built

- **DOM, not a live 3D scene.** Cards and images are crisp, cheap on phones, easy to lay out and easy to reduce for accessibility.
- **Renders:** the portrait renderer's `poster-n` (512×768), warmed **during the lobby**, when every player's look is already loaded. At the countdown the poster only shows images. No WebGL work happens during the beat.
- **Backdrop:**
  - per map: a pre-made plate, Blender or Higgsfield (§6 ask 7);
  - a heavy olive vignette;
  - halftone noise in Field Print;
  - team colours as diagonal slashes behind each side.
- **Motion** (ui-motion-spec tokens):
  - sides slide in from their edges (P9 enter, `--m-slow`), staggered 30 ms per card;
  - VS stamps (P7);
  - the fold is a P2 shared-element move into the top strip.
  - **Reduce motion:** a 120 ms cross-fade in and out; no slides or stamp.
  - **Reduce transparency:** solid plates.
- **Sound:** a war-tone hit on the VS stamp (the audio agent's UI bus).
- **Copy:** "ALL VS ALL", "VS", team names, the rules line. Stencil display face, no exclamation marks.

### 8.4 Using the time

**During the lobby:**

1. Warm the portraits and poster renders.
2. `renderer.compileAsync(scene, camera)` for any part materials new to this match [P33].
3. `initTexture` for their textures [P7].
4. Render **one hidden frame with the shadow pass on**, so the skinned depth program links before play (the gap noted in review L1).

**At the countdown,** if something is still loading (a late joiner's parts), the poster holds that player's fallback card and shows a thin per-player progress line under it, a pattern loading screens use [G9]. **GO is never delayed:** the sim's countdown is authoritative.

### 8.5 Acceptance criteria

- The poster never delays the match. GO lands at the same tick as without it (a test on the countdown timing).
- No shader link and no frame over 20 ms during the countdown in an 8-player room with fresh looks (link logger + frame meter), on desktop and a mid phone.
- **Layouts:**
  - FFA 2, 8 and 16; 1v1; 2v2; 4v4; 4v4v4;
  - verified at 1280×720, 1920×1080, 2560×1440 and 812×375, and on the rotated upright phone;
  - nothing under the notch or the home indicator;
  - names truncate cleanly at 16 characters.
- Reduce motion and Reduce transparency variants pass a screenshot check.
- Text scale 1.5 keeps names readable without overlap (compact cards drop to name-only).
- Any key, tap or pad button folds it early for the local player.

---

## 9. Acceptance criteria for the feel work

The probe's scenarios (§2) become tests in `render3d/test/` (animation stream). Each is a pass/fail number:

| Area | Criterion |
|---|---|
| Switches (rifle ↔ pistol, armed ↔ unarmed, shield up and down, aim-set change) | No bone turns more than **20° in one frame**; the pose settles within 0.3 s |
| Walk band | Contact-foot speed ≤ **15% of ground speed** at 0.5, 1.0, 1.5, 2.0, 2.5, 3.5 and 5 m/s |
| Standing turn | Each foot moves ≤ **5 cm** except the stepping foot, which lifts and lands within the turn; yaw has zero velocity at both ends |
| Take-off | `jet_ascend` (or the take-off pose) at ≥ 90% within **200 ms** of leaving the ground at the sim's real thrust; a dip of 2–3 frames precedes it |
| Landing | No knee bend over **15°/frame** at 10 m/s; the dip peaks within 3 frames with a 5–8% rebound |
| Upper body while armed | Spine and clavicles move (breathing) with an amplitude of 0.8–2° and a period of 2.5–3.5 s; the gun's barrel stays within 0.5° of the aim (as today) |
| Actions | Reload and throw are visible (upper-body bones move ≥ 15° during them); the gun returns to the aim within 0.15 s of the action's end |
| Death | Not invisible on the death frame; gone within 0.7 s (or the owner's choice) |
| LOD | Off-screen soldiers cost 0 mixer updates; at LOD1 the planter does 0 raycasts; frame time with 16 bots on a mid phone improves (measured before and after) |
| Creator | At the Face focus on a 1080p 2× laptop a face texel spans ≤ **3 device px** (hero texture); the stage renders 0 frames when idle under Reduce motion and ≤ 30 fps idle on phones; a contact shadow under the feet; per-tab framing |
| Look and feel | The animation lab's frame strips for walk, turn, take-off, landing, switch and reload are reviewed side by side, before and after, by the orchestrator and the owner |

---

## 10. Sources

**Internal:**

- `apps/web/src/character/` (assembler, clipRepair, dyeMaterial, outline);
- `apps/web/src/render3d/` (avatar, locomotion, motion, holds, ik, sling, swing, presets, index);
- `apps/web/src/locker/turntable.ts`, `apps/web/src/creator/`;
- `art/pipeline/clips.py`, `art/character/rookie.check.txt`;
- docs/04 §1, §4, §6.1;
- shared notes `animation-assembler.md`, `animation-avatar-split.md`, `animation-clip-asks.md`, `animation-review-fixes.md`, `forge-animation-reply.md`, `w2-character-interface.md`, `creator-interfaces.md`, `match-presentation.md`, `owner-decisions.md`.

### Engines, animation research and tools (C)

- [C1] three.js `AnimationAction.js`. https://github.com/mrdoob/three.js/blob/dev/src/animation/AnimationAction.js
- [C2] three.js `AnimationMixer.js`. https://github.com/mrdoob/three.js/blob/dev/src/animation/AnimationMixer.js
- [C3] three.js `PropertyMixer.js`. https://github.com/mrdoob/three.js/blob/dev/src/animation/PropertyMixer.js
- [C4] three.js `AnimationUtils.js`. https://github.com/mrdoob/three.js/blob/dev/src/animation/AnimationUtils.js
- [C5] three.js example, additive blending. https://github.com/mrdoob/three.js/blob/dev/examples/webgl_animation_skinning_additive_blending.html
- [C6] three.js example, walk. https://github.com/mrdoob/three.js/blob/dev/examples/webgl_animation_walk.html
- [C7] three.js `CCDIKSolver.js`. https://github.com/mrdoob/three.js/blob/dev/examples/jsm/animation/CCDIKSolver.js
- [C8] three.js `Skeleton.js`. https://github.com/mrdoob/three.js/blob/dev/src/objects/Skeleton.js
- [C9] three.js `SkinnedMesh.js`; issue #14499 (skinned bounds). https://github.com/mrdoob/three.js/blob/dev/src/objects/SkinnedMesh.js · https://github.com/mrdoob/three.js/issues/14499
- [C10] three.js `skinning_pars_vertex.glsl.js`. https://github.com/mrdoob/three.js/blob/dev/src/renderers/shaders/ShaderChunk/skinning_pars_vertex.glsl.js
- [C11] three.js releases (r172–r186). https://github.com/mrdoob/three.js/releases
- [C12] three.js migration guide. https://github.com/mrdoob/three.js/wiki/Migration-Guide
- [C13] three.js forum, "Optimization of large amounts (100–1000) of skinned meshes: CPU bottlenecks". https://discourse.threejs.org/t/optimization-of-large-amounts-100-1000-of-skinned-meshes-cpu-bottlenecks/58196
- [C14] three.js example, multiple animated models. https://github.com/mrdoob/three.js/blob/dev/examples/webgl_animation_multiple.html
- [C15] three.js example, animation retargeting. https://github.com/mrdoob/three.js/blob/dev/examples/webgpu_animation_retargeting.html
- [C16] three.js docs, Timer. https://threejs.org/docs/pages/Timer.html
- [C18] Holden, "Spring-It-On: The Game Developer's Spring-Roll-Call" (2021). https://theorangeduck.com/page/spring-roll-call
- [C19] Holden, "Dead Blending" (2023). https://theorangeduck.com/page/dead-blending
- [C20] Holden, "Simple Two Joint IK" (2017). https://theorangeduck.com/page/simple-two-joint
- [C21] Holden, "Code vs Data Driven Displacement" (2021). https://theorangeduck.com/page/code-vs-data-driven-displacement
- [C22] Unreal Engine, Transition rules (inertialization). https://dev.epicgames.com/documentation/en-us/unreal-engine/transition-rules-in-unreal-engine
- [C23] Unreal Engine, `EAlphaBlendOption`. https://dev.epicgames.com/documentation/unreal-engine/API/Runtime/Engine/EAlphaBlendOption
- [C24] Unreal Engine, Animation sync groups. https://dev.epicgames.com/documentation/unreal-engine/animation-sync-groups-in-unreal-engine
- [C25] Unreal Engine, Aim offset. https://dev.epicgames.com/documentation/en-us/unreal-engine/aim-offset-in-unreal-engine
- [C26] Unreal Engine, Distance matching; Python API play-rate clamp. https://dev.epicgames.com/documentation/en-us/unreal-engine/distance-matching-in-unreal-engine · https://docs.unrealengine.com/PythonAPI/class/AnimDistanceMatchingLibrary.html
- [C27] Unreal Engine, Pose warping; and the engine sample's adaptation note (via search summary). https://dev.epicgames.com/documentation/en-us/unreal-engine/pose-warping-in-unreal-engine · https://www.unrealengine.com/tech-blog/adapting-lyra-animation-to-your-ue5-game
- [C28] Unreal Engine, Root motion; RootMotionMode. https://dev.epicgames.com/documentation/en-us/unreal-engine/root-motion-in-unreal-engine · https://docs.unrealengine.com/5.0/en-US/PythonAPI/class/RootMotionMode.html
- [C29] Unreal Engine, Animation optimization (update rate). https://dev.epicgames.com/documentation/en-us/unreal-engine/animation-optimization-in-unreal-engine
- [C30] Unreal Engine, Two Bone IK. https://dev.epicgames.com/documentation/en-us/unreal-engine/animation-blueprint-two-bone-ik-in-unreal-engine
- [C31] Unreal Engine, AnimDynamics. https://dev.epicgames.com/documentation/en-us/unreal-engine/animation-blueprint-animdynamics-in-unreal-engine
- [C32] Unreal Engine, Physical Animation component. https://docs.unrealengine.com/4.26/API/Runtime/Engine/PhysicsEngine/UPhysicalAnimationComponent/index.html
- [C33] Unity Manual, Blend Trees; 1D; 2D. https://docs.unity3d.com/Manual/class-BlendTree.html · https://docs.unity3d.com/Manual/BlendTree-1DBlending.html · https://docs.unity3d.com/Manual/BlendTree-2DBlending.html
- [C36] Unity Manual, Transitions. https://docs.unity3d.com/Manual/class-Transition.html
- [C37] Unity Manual, Animation layers. https://docs.unity3d.com/Manual/AnimationLayers.html
- [C38] Unity Manual, Root motion. https://docs.unity3d.com/Manual/RootMotion.html
- [C39] Unity Scripting API, AnimatorCullingMode. https://docs.unity3d.com/ScriptReference/AnimatorCullingMode.html
- [C40] Unity Scripting API, QualitySettings.skinWeights. https://docs.unity3d.com/ScriptReference/QualitySettings-skinWeights.html
- [C41] Unity Issue Tracker (default transition duration 0.25). https://issuetracker.unity3d.com/issues/anim-wrong-default-transition-duration-with-empty-states-or-blendshape-clips
- [C42] VRM consortium, VRMC_springBone 1.0 specification. https://github.com/vrm-c/vrm-specification/blob/master/specification/VRMC_springBone-1.0/README.md
- [C43] pixiv, `@pixiv/three-vrm-springbone` (MIT). https://github.com/pixiv/three-vrm/tree/dev/packages/three-vrm-springbone
- [C44] Wang, Drucker, Agrawala, Cohen, "The Cartoon Animation Filter", SIGGRAPH 2006. https://grail.cs.washington.edu/wp-content/uploads/2015/08/wang-2006-tca.pdf
- [C45] White, Loken, van de Panne, "Slow in and slow out cartoon animation filter", SIGGRAPH 2006 poster. https://www.cs.ubc.ca/~van/papers/2006-siggraph-slowin.pdf
- [C46] Gleicher, "Retargetting Motion to New Characters", SIGGRAPH 1998 (preprint). https://research.cs.wisc.edu/graphics/Courses/cs-838-1999/Papers/retarget-preprint.pdf
- [C47] MoCap Online, "What is solving and re-targeting for 3D mocap". https://mocaponline.com/blogs/mocap-news/89905475-q-what-is-solving-and-retargeting-motion-capture-3d-animation
- [C48] Rosen, "An Indie Approach to Procedural Animation", GDC 2014. https://www.gdcvault.com/play/1020583/
- [C49] BNPR, "Normal spherizing using Abnormal". https://bnpr.gitbook.io/bnpr/shaders/toon-shading-nbpr-abnormal-normal-sphering
- [C50] BlenderNation, "Clean toon face shading with object normals" (2021). https://www.blendernation.com/2021/09/06/clean-toon-face-shading-with-object-normals/

### Clip licences (L)

- [L1] CMU Graphics Lab Motion Capture Database (licence text read on the home page, 23 Oct 2026). http://mocap.cs.cmu.edu/
- [L2] CMU BVH conversion README (Bruce Hahne), mirrored in assimp's tests. https://raw.githubusercontent.com/assimp/assimp/master/test/models/BVH/01_nn.bvh.source.txt
- [L3] RancidMilk, free character animations (CMU on a CC0 character). https://rancidmilk.itch.io/free-character-animations
- [L4] Adobe, Mixamo FAQ (blocks automated fetching; quoted from the search index). https://helpx.adobe.com/creative-cloud/faq/mixamo-faq.html
- [L5] Adobe Community, Mixamo FAQ: licensing, royalties, ownership. https://community.adobe.com/questions-696/mixamo-faq-licensing-royalties-ownership-eula-and-tos-589400
- [L6] Rokoko, pricing (Motion Library terms). https://www.rokoko.com/pricing
- [L7] Rokoko, 263 free motion capture assets. https://www.rokoko.com/resources/download-263-rokoko-motion-capture-assets
- [L8] Rokoko, Terms of Use v2.0.1. https://www.rokoko.com/studio-term-of-use
- [L9] Rokoko Vision. https://www.rokoko.com/products/vision
- [L10] Quaternius, Universal Animation Library. https://quaternius.itch.io/universal-animation-library
- [L11] Quaternius, Universal Animation Library 2. https://quaternius.itch.io/universal-animation-library-2
- [L12] Kenney, support and licence. https://kenney.nl/support
- [L13] Mesh2Motion. https://github.com/mesh2motion/mesh2motion-app
- [L14] Mason et al., 100STYLE dataset (CC BY 4.0). https://www.ianxmason.com/100style/ · https://zenodo.org/record/8127870
- [L15] Bandai Namco Research motion dataset. https://github.com/BandaiNamcoResearchInc/Bandai-Namco-Research-Motiondataset
- [L16] Ubisoft La Forge animation dataset (LAFAN1). https://github.com/ubisoft/ubisoft-laforge-animation-dataset
- [L17] Fab EULA (quoted from the search index). https://www.fab.com/eula
- [L18] Unreal forums, Fab "UE-Only" content licensing. https://forums.unrealengine.com/t/fab-ue-only-content-licensing/2082870
- [L19] CG Channel on Epic's free game animation sample (UE-only). https://www.cgchannel.com/2024/06/get-500-free-game-ready-animations-for-use-in-unreal-engine
- [L20] Unity Asset Store Terms of Service and EULA. https://unity.com/legal/as-terms
- [L21] DeepMotion FAQ. https://www.deepmotion.com/faq
- [L22] Move.ai, Move One pricing. https://docs.move.ai/knowledge/move-one-pricing
- [L23] Plask pricing. https://plask.ai/pricing
- [L24] CG Channel on Radical's closure. https://www.cgchannel.com/?p=175200
- [L25] Reallusion forum, game distribution licence. https://forum.reallusion.com/Topic493214.aspx

### Blender (B) and Higgsfield (H)

- [B1] Blender Extensions, "Retarget" (KBS-DEV). https://extensions.blender.org/add-ons/retarget/
- [B2] Expy Kit. https://github.com/pKrime/Expy-Kit
- [B3] Blender 4.4 release notes, animation and rigging (Slotted Actions). https://developer.blender.org/docs/release_notes/4.4/animation_rigging/
- [B4] Blender 5.1 and 5.2 release notes, animation and rigging. https://developer.blender.org/docs/release_notes/5.1/animation_rigging/ · https://developer.blender.org/docs/release_notes/5.2/animation_rigging/
- [B5] Rokoko support, Blender plugin. https://support.rokoko.com/hc/en-us/articles/4410463492241-Install-the-Blender-plugin
- [B6] Rokoko support, retargeting rest pose note. https://support.rokoko.com/hc/en-us/articles/29511401121809-Unreal-Engine-5-4-and-prior-Retarget-a-Rokoko-animation-to-a-Custom-Character
- [B7] Khronos community, glTF export of multiple actions from Blender. https://community.khronos.org/t/gltf-vs-glb-multiple-actions-from-blender/107469
- [H1] Higgsfield. https://higgsfield.ai
- [H2] Higgsfield, Blender plugin. https://higgsfield.ai/plugins/blender
- [H3] Higgsfield help, "Who owns my generations and can I use them commercially?". https://higgsfield.ai/creator-hub/help-center/account-and-privacy/who-owns-my-generations-and-can-i-use-them-commercially
- [H4] Higgsfield help, Kling motion control. https://higgsfield.ai/creator-hub/help-center/ai-models/how-do-i-use-kling
- [H5] Higgsfield, terms of use update (27 Aug 2026). https://higgsfield.ai/blog/terms-of-use-privacy-policy-update

### Presentation, rendering and the web platform (P)

- [P1] three.js docs, PMREMGenerator. https://threejs.org/docs/pages/PMREMGenerator.html
- [P2] three.js `RoomEnvironment.js`. https://raw.githubusercontent.com/mrdoob/three.js/dev/examples/jsm/environments/RoomEnvironment.js
- [P3] three.js docs, Scene (environment, backgroundBlurriness). https://threejs.org/docs/pages/Scene.html
- [P4] three.js docs, HDRLoader. https://threejs.org/docs/pages/HDRLoader.html
- [P5] Poly Haven licence (CC0). https://polyhaven.com/license
- [P6] three.js docs, LightShadow. https://threejs.org/docs/pages/LightShadow.html
- [P7] three.js docs, WebGLRenderer (shadow map types, compile, compileAsync, initTexture, readRenderTargetPixelsAsync). https://threejs.org/docs/pages/WebGLRenderer.html
- [P8] three.js example, contact shadow. https://raw.githubusercontent.com/mrdoob/three.js/dev/examples/webgl_shadow_contact.html
- [P9] pmndrs drei, ContactShadows. https://raw.githubusercontent.com/pmndrs/drei/master/src/core/ContactShadows.tsx
- [P10] Google model-viewer, ground shadow. https://raw.githubusercontent.com/google/model-viewer/master/packages/model-viewer/src/three-components/Shadow.ts
- [P11] pmndrs drei, Stage (lighting presets). https://raw.githubusercontent.com/pmndrs/drei/master/src/core/Stage.tsx
- [P12] The Level Design Book, three-point lighting. https://book.leveldesignbook.com/process/lighting/three-point
- [P13] three.js manual, "How to update things". https://threejs.org/manual/pages/how-to-update-things.html
- [P14] three.js docs, Material (onBeforeCompile, customProgramCacheKey). https://threejs.org/docs/pages/Material.html
- [P15] three.js docs, MeshPhysicalMaterial. https://threejs.org/docs/pages/MeshPhysicalMaterial.html
- [P16] three.js `BokehPass.js`. https://raw.githubusercontent.com/mrdoob/three.js/dev/examples/jsm/postprocessing/BokehPass.js
- [P17] pmndrs postprocessing, DepthOfFieldEffect. https://raw.githubusercontent.com/pmndrs/postprocessing/main/src/effects/DepthOfFieldEffect.js
- [P18] Khronos, PBR Neutral tone mapper. https://github.com/KhronosGroup/ToneMapping/blob/main/PBR_Neutral/README.md
- [P19] three.js manual, Color management; forum, blurred backgrounds. https://threejs.org/manual/pages/color-management.html · https://discourse.threejs.org/t/how-to-blur-a-background-texture/39433
- [P20] Google model-viewer, camera controls. https://raw.githubusercontent.com/google/model-viewer/master/packages/model-viewer/src/features/controls.ts
- [P21] three.js manual, Rendering on demand. https://threejs.org/manual/pages/rendering-on-demand.html
- [P22] MDN, WebGL best practices (readPixels, smaller back buffers). https://developer.mozilla.org/en-US/docs/Web/API/WebGL_API/WebGL_best_practices
- [P23] three.js PR #28291, async render-target readback (r165). https://github.com/mrdoob/three.js/pull/28291
- [P24] three.js example, multiple elements (scissor). https://raw.githubusercontent.com/mrdoob/three.js/dev/examples/webgl_multiple_elements.html
- [P25] three.js manual, tips (drawing buffer and screenshots). https://threejs.org/manual/pages/tips.html
- [P26] MDN browser-compat-data, OffscreenCanvas. https://raw.githubusercontent.com/mdn/browser-compat-data/main/api/OffscreenCanvas.json
- [P27] WebKit, "WebKit Features in Safari 17.0". https://webkit.org/blog/14445/webkit-features-in-safari-17-0/
- [P28] MDN, HTMLCanvasElement.toBlob. https://developer.mozilla.org/en-US/docs/Web/API/HTMLCanvasElement/toBlob
- [P29] MDN, createImageBitmap. https://developer.mozilla.org/en-US/docs/Web/API/Window/createImageBitmap
- [P30] WebKit, "Updates to Storage Policy". https://webkit.org/blog/14403/updates-to-storage-policy/
- [P31] WebKit, "Full Third-Party Cookie Blocking and More" (7-day cap). https://webkit.org/blog/10218/full-third-party-cookie-blocking-and-more/
- [P33] three.js r158 release (compileAsync). https://github.com/mrdoob/three.js/releases/tag/r158
- [P34] MDN browser-compat-data, KHR_parallel_shader_compile. https://raw.githubusercontent.com/mdn/browser-compat-data/main/api/KHR_parallel_shader_compile.json
- [P35] Nielsen, "Response Times: The 3 Important Limits". https://www.nngroup.com/articles/response-times-3-important-limits/
- [P36] W3C, Understanding SC 2.2.2 Pause, Stop, Hide. https://www.w3.org/WAI/WCAG22/Understanding/pause-stop-hide.html
- [P38] Unity, "Best practices for profiling game performance" (frame budget, battery). https://unity.com/how-to/best-practices-for-profiling-game-performance
- [P39] WebKit bug 215745 (rAF at 30 fps in Low Power Mode). https://bugs.webkit.org/show_bug.cgi?id=215745

### Sources that name other games
Kept out of the repo, in the private shared notes (onboarding-3d-research-sources.md), per the owner's rule against naming other games here. The [G] ids above point to that list.
