# Art (W8)

Sources and authoring scripts for the game's art: the Rookie (base soldier), its parts and clips, and map kits. Runtime exports go to `apps/web/public/assets/` (docs/15 §3, W8). Conventions every asset follows are in [docs/04 §9](../docs/04-characters-and-customization.md).

| Milestone (docs/15 §4) | Status |
|---|---|
| Phase 0 art-style test | done (concept → 3D → rigged glTF, viewer, asset check) |
| A: clips + dye masks | #3: 30 clips incl. aim poses for 3 weapon families, jetpack as its own part, dye masks |
| B: starter cosmetics + 5 weapons | weapons: 11 models (#5); cosmetics: 11 items + 3 default parts (#8) |
| Done: Street Market kit | #10: 24-piece kit + compiled 128 × 62 m map (120 m of play between edge walls), collision from the kit's extras, 6 ad surfaces |
| **Hero cosmetics from Higgsfield** | **this branch**: 5 of the 11 starter items rebuilt from generated models (3 more drafted, waiting for 3D) |

## Hero cosmetics from Higgsfield

![Before / after](screenshots/hero-cosmetics.png)
*Top: the procedural items from #8. Bottom: the same item ids rebuilt from Higgsfield-generated models, in the Rookie's painted vinyl style.*

The procedural starter items read cleaner and flatter than the painted Rookie (#8, gaps). Five of the most visible ones now come from generated models instead: **Combat Helmet, Field Cap, Beret, Bandana, Rocket Pack**. Ids, slots, budgets and manifests are unchanged, so the Locker and W2's renderer don't change.

**Pipeline** (sources in [cosmetics/source/](cosmetics/source/): the raw Tripo GLBs are the build inputs; the concept sheets are kept as 1600 px JPEGs for the record. The full-res sheets are on Higgsfield under the job ids below, and `split_sheet.py` regenerates the views):
1. **Concept turnaround** (GPT Image 2.5, high, 2k): front / left / back of the item alone, with concept A (the Rookie sheet) as the style reference. All are original designs: no insignia, logos or real brands.
2. **Split** with `split_sheet.py`. It now merges a pair's two pieces per view (boots).
3. **3D:** `tripo_h3_1_multiview_to_3d`, about 29k tris with a 2048² texture → `source/<id>_tripo_raw.glb`.
4. **`build_cosmetics.py`** uses a generated source whenever `source/<id>_tripo_raw.glb` exists (`--procedural` ignores them, `--only id,...` rebuilds a few):
   - **Fit:** the procedural item is still built first, and the generated model is scaled into its bounding box. Hats sit on the brim line; the beret's line is lowered onto the brow. Jetpacks go into the default jetpack's box.
   - **Strict envelope (docs/04 §1.2):** then the same `fit_envelope` as the procedural items runs. Overhangs are squeezed in: Field Cap front 4.3 / top 2.4 cm, Beret top 6.1, Bandana top 5.7 / back 0.2, Combat Helmet top 0.8. Jetpacks would be scaled about their backplate; the Rocket Pack already fits inside the (fitted) default jetpack's box.
   - **Head clearance:** after the envelope fit, crown vertices that dip into the hair cap are pushed back out, so a squeezed crown never sinks into the hair. The hat's underside stays: it is hidden inside the head, and a closed mesh decimates cleanly. Pinholes are filled.
   - **LODs:** LOD0 decimates the source to the slot budget (450 headgear / 550 jetpack). LOD1 decimates LOD0 (200 / 250), is clamped to LOD0's bounds, and falls back to a voxel remesh when the generator's non-manifold fins stall collapse decimation (the beret).
   - **Bake:** fresh UVs, then the generated albedo is baked with metallic zeroed (badges and lenses), like the Rookie's body. LOD1 bakes from LOD0.
   - **Dye masks:** per-item colour rules (`rules_*`). Texels the bake didn't reach are never dyed. The Combat Helmet came out sand-coloured like the default Brim Helmet, so its default primary dye is overridden to olive drab and its albedo repainted to match.

| Item | LOD0 / LOD1 tris | Default dyes (primary / secondary / accent) |
|---|---|---|
| Combat Helmet | 449 / 199 | olive drab / brown strap / teal lens |
| Field Cap | 450 / 200 | olive / dark peak / gold badge |
| Beret | 448 / 200 | maroon / dark band / gold badge |
| Bandana | 448 / 200 | red / dark hem |
| Rocket Pack | 550 / 250 | cream / navy / brass |

Every item passes `--kind part` at both LODs (slot budget, skin, strict envelope, dye round trip), and so do the worst-case outfits ([checks](cosmetics/checks/)). Measured against the bare body, all 28 parts are inside.

**Not built yet: Drum Pack, Jungle Boots, Sneakers.** Their concept sheets are done and paid for (in `source/concepts/`), but this session's permission check blocked the Tripo step as a purchase. Each needs one more `tripo_h3_1_multiview_to_3d` run (9 credits, 27 in total), and then `build_cosmetics.py --only ...` picks them up with no code changes. Until then they stay procedural. Eyewear and gloves stay procedural on purpose: at 150 tris there's nothing a generated model would add.

**Spend: 69.75 credits.** That's 9 concept images × 2.75 (8 items plus a re-roll of the sneakers, whose first side view showed the two shoes pointing opposite ways) and 5 Tripo models × 9. The Higgsfield balance went from 786.28 to 716.53. Job ids:
- concepts: helmet `e6008b0f…`, cap `5a172851…`, beret `ac3fa9be…`, bandana `8591f551…`, rocket `fa5a003f…`, drum `9873d27e…`, jungle `71c181ad…`, sneakers `b60a2a0c…` (first try `a9bc5f67…`);
- 3D: helmet `e8020e60…`, cap `625d8296…`, beret `e2ccc5a6…`, bandana `3bfac805…`, rocket `b49a88ec…`.

## Street Market: map kit + map (docs/01 §7, map 4)

A generic market street (no real place: invented, region-neutral signage, a plain two-tone minibus), built for the same collision workflow as the movement-test map. The gameplay layout is docs/01 §7's map 4: dense rooftops, minibuses, stalls, awnings.

![Overview](screenshots/market-overview-7x.png)
*The centre ~83 m at 7× (the widest zoom): stalls and minibuses on the ground, balconies and 12 m roofs, the tank tower and the billboard catwalk in the middle; behind, the ad Screens and Hoardings (mid layer) and the far blocks.*

| | |
|---|---|
| ![Centre](screenshots/market-centre-1x.png) *1×, centre: minibuses, tank tower (deck 4 m, tank top 5.4 m), catwalk at 10 m under the solid billboard panel (2 m headroom)* | ![Collision](screenshots/market-west-collision.png) *1×, west side with `hitboxes=1`: terrain skyline and edge wall (white), one-ways (yellow), solids* |

**Render = collision (docs/11 §2).** Each kit piece carries its gameplay collision in glTF extras, in piece-local metres. `art/pipeline/compile_map.py` places the pieces from a layout and writes a `packages/content` **MapDef** (`types.ts` shape) and the map's **AdSlot list** (docs/14 §4.2), so the sim, the renderer and the ad system read the same numbers:

| Extra | Meaning | In the MapDef |
|---|---|---|
| `terrain: [[x0, x1, h]]` | a rectangle standing on y = 0 (ground blocks, houses, edge blocks) | merged with the ground into **one terrain polygon** whose top is the skyline, like `movementTest` (no internal edges to snag on) |
| `solids: [[x, y, …]]` | free-standing CCW polygons (stall counters, minibus bodies, tank, billboard panel) | one solid each |
| `oneWays: [[ax, ay, bx, by]]` | drop-through ledges (awnings, balconies, tower deck, catwalk, the umbrella's two 15° slopes) | `oneWays` |
| `layer` | `gameplay` / `mid` / `far` (docs/11 §2) | only `gameplay` pieces collide; `mid`/`far` go in the layout's `decor` |
| `material` | sim material id (0 concrete, 1 metal, 2 wood, 3 dirt) | solid `material` |
| `noFlip` | the piece has lettering | the layout may not mirror it |
| `adSlot` | on Screen / Hoarding bezels: `kind`, `format`, `size`, `frames`, `centre` of the creative | one AdSlot per bezel placed with a `slotId` |

**Kit** (`art/pipeline/build_market_kit.py` → [kits/street_market/kit_street_market.glb](kits/street_market/)): one node per piece, one shared vertex-colour material, single-sided (`doubleSided: false`). Within 0.35 m of the gameplay plane (the capsule radius) nothing is drawn outside the collision: luggage, produce and sacks sit behind the plane, balconies have a front handrail instead of end plates across the walkway, parapet lips are at the back.

| Piece | Layer | Tris | Collision |
|---|---|---|---|
| `sm_ground_4m` | gameplay | 336 | terrain 4 m at y 0 |
| `sm_stall_4m` | gameplay | 1,544 | counter solid 1.0 m, awning one-way 3.05 m |
| `sm_umbrella_stall` | gameplay | 360 | counter solid 0.8 m, canopy one-ways 2.65 → 3.05 → 2.65 m (it follows the cone) |
| `sm_minibus` | gameplay | 884 | body solid from 0.35 m with the sloped front drawn to match, roof 2.3 m |
| `sm_crates` | gameplay | 260 | one stepped solid, 1.0 / 1.6 m |
| `sm_tank_tower` | gameplay | 332 | deck one-ways at 4 m either side of the tank solid (top 5.4 m) |
| `sm_billboard` | gameplay | 550 | catwalk one-way at 10 m; panel solid 12–15.2 m with a 51° gable to 20.2 m (too steep to stand on). House-only (never sold) |
| `sm_house_2f` / `_3f` / `_3f_blue` | gameplay | 976 / 1,356 / 1,356 | terrain roof 8 / 12 m, balcony one-ways at 4 / 8 m |
| `sm_edge_block` | gameplay | 872 | terrain 54 m: the map's side walls, up to the ceiling |
| `sm_screen_8x6`, `sm_hoarding_18x3`, `sm_hoarding_21x3_5` | mid | 232 each | none; `adSlot` (docs/14 §2.1: Screen 4:3 × 6 frames, Hoarding 6:1) |
| `sm_junction_block`, `sm_screen_tower`, `sm_screen_mast`, `sm_flyover`, `sm_east_block` | mid | 324 / 220 / 212 / 264 / 588 | none: the structures the bezels hang on |
| `sm_signboard` (noFlip), `sm_power_pole` | mid | 215 / 156 | none |
| `sm_far_block_a` / `_b` | far | 216 / 168 | none |

**Map** ([maps/street_market/layout.json](maps/street_market/layout.json) → [street_market.map.json](maps/street_market/street_market.map.json) + [street_market.adslots.json](maps/street_market/street_market.adslots.json)): id `street-market`, bounds 128 × 62 m: 120 m of play between the edge walls, and the top 2 m of the bounds is a ceiling slab. Mirrored halves: houses at the edges, then stalls, the blue 3-storey, crates and minibuses toward the middle, with the tank tower and billboard in the centre. 50 gameplay pieces + 31 decor (81 placements, 35,876 tris; 30 piece/flip pairs, so 30 instanced draws), 14 spawns, walkable heights 0 → 12 m. Palette: sky `#c9c1b0`, fog `#cbbfa8`.

**Ad surfaces** (docs/14 §2.3 placements, z per the table there): S1 junction Screen (x −57, z −6), H1 flyover Hoarding 21 × 3.5 (x −47, z −8), S3 mast Screen over the west minibus (x −12, z −5), S2 tower Screen (x 14, z −7), H2 rooftop Hoarding across two buildings (x 47, z −6) and S4 gantry Screen next to it (x 58, z −6). Positions were searched against compile_map's view lints, below; screens get phase offsets 0–3.

```bash
B=/Applications/Blender.app/Contents/MacOS/Blender
$B -b --factory-startup --python-exit-code 1 --python art/pipeline/build_market_kit.py -- \
   art/kits/street_market/kit_street_market.glb --runtime apps/web/public/assets/kits/street_market/kit_street_market.glb
python3 art/pipeline/compile_map.py art/maps/street_market/layout.json
$B -b --factory-startup --python-exit-code 1 --python tools/asset-check/check.py -- art/kits/street_market/kit_street_market.glb --kind kit
```

Checks:
- **asset-check `--kind kit`:** 83 pass, 0 warn, 0 fail on the source and the runtime GLB ([report](kits/street_market/kit_street_market.check.txt)). New rows: **render = collision on the gameplay plane** (samples every triangle within 0.35 m of the plane and fails on any region ≥ 0.15 m drawn more than 0.1 m outside the piece's collision; thin, shallow poles are allowed), **team-colour contrast** (gameplay vertex colours ≥ 25 ΔE from team blue `#2f7dff` and orange `#ff7a1a`; the old orange billboard measured 16) and **ad surface off the gameplay plane**. The previous version of this kit fails 10 of these rows (luggage, produce, sacks, umbrella canopy, billboard, balcony end plates, the orange panel); this kit passes all. The yard kit passes 13/13; selftest 30/30 (3 new kit cases).
- **`compile_map.py`** fails the build on:
  - unknown pieces, non-gameplay pieces in `pieces`, gaps in the ground;
  - a play space open at either edge (the skyline must reach the ceiling);
  - overlapping solids, solids sunk into terrain or reaching the ceiling, one-ways inside solids;
  - spawns not standing on a walkable edge (terrain top, a solid edge ≤ 50°, a one-way) or whose 0.32 × 1.5 m capsule overlaps terrain or a solid;
  - < 12 spawns, < 3 vertical layers;
  - any clear eye-to-eye line ≥ 60 m between standing spots (docs/01 §7: sightlines ≤ the Widow's range). This map: 0 of 195 spots;
  - a flipped `noFlip` piece;
  - AdSlot lints (docs/14 §2.6): z ∈ [−9, −4], no collision, not mirrored, unique `street-market/<slot>` ids (1); 2.5–8% of the screen at 1× and ≥ 1.5% at 4× (2); from every standing spot, with the camera clamped to the bounds, ≤ 2 surfaces in a 1× view and ≤ 4 / ≤ 8% at 7× (4; a surface counts when ≥ 50% of it is on screen, the IAB rule §4.6 measures with). This map: ≤ 2 at 1×, ≤ 4 and 3.9% at 7×.
- **In the sim** (W6's code on main, run locally, not committed): the review's fuzz harness, 8 players × 15 sim-minutes of random input: **0 deaths by falling out of the map** (61 per hour before the walls), 0 player-ticks out of bounds, 0 ticks with solid penetration. Every one-way lands and drops through; the umbrella slopes hold a standing player at 2.86 m.
- **Viewer:** `?map=street_market&zoom=1&cx=-46&cy=9&hitboxes=1` draws the kit from the layout with the collision on top. The map path is the reference for W1: one `InstancedMesh` per (piece, flip), mirrored pieces get their own geometry with the winding reversed (no DoubleSide).

To ship it in the game, the content owner imports `street_market.map.json` into `packages/content/src/maps/` and the AdSlot list wherever the map schema gets `adSlots` (this branch stays out of `packages/`); the renderer instances `kits/street_market/kit_street_market.glb` nodes from the same layout. docs/01 §7 and docs/14 §2.3/§2.4 still call this map "Lagos Market" and its slots `LM-*`; they need the rename.

Gaps:
- **Breakable awnings** (docs/01 §7) need a sim feature; the awning one-ways are separate segments, so they can be removed individually once there is one.
- The ad bezels show a grey placeholder where the creative goes; the house pool and the array-texture renderer are W1's (docs/14 §4.5). Lint 3 (facing) holds by construction (every slot faces the camera); lints 5–8 need the playtest heatmap and other systems.
- No props pass yet (bunting, generators, crowd cut-outs); the decor layer has room for them.

## Milestone A: clips, aim poses, jetpack part, dye masks

![Rifle aim, default dyes](screenshots/m-a-rifle-aim.png)

| | |
|---|---|
| ![Dual, dyed](screenshots/m-a-dual-dyed.png) *Dual pistols aimed −30°, dyed navy / bone / red: the dye masks recolour uniform + helmet, gear + jetpack tanks, and goggles + armband* | ![Pistol, dyed](screenshots/m-a-pistol-dyed.png) *Pistol aimed −10°, dyed olive / black / yellow* |

![Aim poses](screenshots/rookie-aim-poses.png)
*Aim poses (profile + three-quarter): rifle, pistol and dual at down90 / down45 / level / up45 / up90. The renderer blends the two poses around the aim angle.*

![Clips](screenshots/rookie-clips.png)
*idle, walk, run, crouch_idle, crouch_walk, jet_ascend, jet_hover, fall, land, reload_rifle, reload_pistol, swap, throw (wind-up, release), melee.*

![Gameplay 1x](screenshots/m-a-gameplay-1x.png)
*1× zoom at 1080p: every soldier is armed and aiming through the aim layer; flames on the jet clips.*

### What ships (`apps/web/public/assets/`)

```
characters/rookie/
  rookie.json              manifest: LODs, anims, dye textures + default dyes, clip list, upper-body bones, aim angles
  rookie_body.glb          LOD0 body: 3,300 tris, 512² albedo; no jetpack, no clips
  rookie_body_lod1.glb     LOD1 body: 1,450 tris, 256²
  rookie_anims.glb         shared skeleton + 30 clips (no mesh)
  textures/                rookie_body[_lod1]_dye_mask.png, _dye_albedo.webp
cosmetics/jetpack/
  jetpack_twin_tank.json   slot jetpack, attachBone spine2, socket_jetpack
  jetpack_twin_tank[_lod1].glb   600 / 300 tris, 256² / 128²
  textures/
```

- **Compression:** GLBs use `EXT_meshopt_compression` and `EXT_texture_webp` (the loader needs `setMeshoptDecoder`). **KTX2 isn't done:** it needs KTX-Software's `toktx` installed on this machine (a user install), so textures ship as WebP/PNG until then.
- **Parts (docs/04 §9.3):** every part GLB is authored in character space and carries the shared skeleton; it is **not** parented to a socket. Rigid parts (the jetpack now; headgear and eyewear later) are weighted 100% to one bone (`attachBone`), so they bind to the body's skeleton or merge into one SkinnedMesh (docs/04 §5.3). The viewer's `assemble()` is the 10-line reference.
- **Dye masks (docs/04 §5.4):** R = primary (sand uniform + helmet), G = secondary (olive webbing, pouches, jetpack tanks), B = accent (teal goggles + armband), A = team glow (armband). `*_dye_albedo` has the dyeable texels neutralised so `albedo × lerp(1, dye, mask)` with the default dyes (in the mesh extras and `rookie.json`) gives back the painted look. The GLB's own albedo stays the undyed original. The asset check verifies that round trip on every part (review fix: the first WebP exports went through Blender's AgX view transform, so dyed areas came out ~40% darker). The viewer's `dyeMaterial()` is a 10-line reference shader.

### Clips (`rookie_anims.glb`, 30 fps, in place)

| Kind | Clips | Tracks |
|---|---|---|
| Locomotion (loops) | idle 2 s, walk 1 s, slide 0.4 s (held), jet_ascend 0.8 s, jet_hover 1.2 s, fall 0.67 s | the bones each clip keys |
| Locomotion with planted feet (loops) | crouch_idle 2 s, walk_slow 0.7 s (0.5 m/s), run 0.33 s (5 m/s), crouch_walk 0.4 s (2.2 m/s) | pelvis, legs, spine, arms |
| One-shots | land 0.3 s (dip; play over locomotion), land_hard 0.5 s (falls over ~10 m/s) | legs, pelvis, spine, head (land_hard: arms too) |
| Action poses | flail 0.6 s (blast-launch loop), dash_side, dash_up, dash_down, brake (single-frame poses) | full body |
| Aim poses | `aim_<pistol|dual|rifle>_<down90|down45|level|up45|up90>` | upper body only: spine1/2, neck, head, clavicle/upperarm/forearm/hand _L/_R |
| Upper-body actions | reload_rifle 1.6 s, reload_pistol 1.0 s, swap 0.5 s (swap the mesh at 50%), throw 0.6 s (release ≈55%), melee 0.47 s (hit ≈45%) | upper body only |

Aim poses exist for 3 of the 8 docs/04 §4.2 families. Until the others get their own, `rookie.json` `aimPoseFallback` maps shotgun, sniper, launcher and heavy to the rifle set, and melee and thrown to the pistol hold. Weapons also carry `aimPose` directly.

How to layer them (what the viewer does): when armed, play locomotion with its upper-body tracks removed; weight the two aim poses around the angle by (1 − t, t) × (1 − actionWeight); fade actions in over 0.08 s and out over 0.12 s; time-scale reloads to the weapon's reload time.

Aim poses and actions are **solved, not hand-keyed**: each key says where the grip goes and where the gun points, and two-bone IK places the arms. Chibi arms reach only ~0.32 m from shoulder to grip, so the holds centre on one point just in front of the chest pouches with both shoulders protracted. That has two consequences for other workstreams:
- **W5/W1:** a weapon's `offhand` node must sit **within 0.10 m of the grip** (docs/04 §9.4, enforced by the weapon check). The default `socket_offhand_IK` sits 0.07 m ahead.
  - The rifle aim poses are solved per angle (`clips.RIFLE_HOLD`) so the left hand can actually reach those targets. Chibi arms reach 0.27 m from the shoulder to the wrist.
  - `build_character.py` asserts the reach in every rifle pose and fails the build if it breaks. Worst margins today: 1.2 cm to `socket_offhand_IK`, and 2.7–3.4 cm to the offhand nodes of the K-47, Breacher, Widow, Thumper and Shredder.
  - The review measured the old poses 3.4–7.5 cm out of reach, with the left arm locked straight.
- **W1:** the guns sit at ~0.76 m (chest) while the sim's aim pivot is 1.08 m (docs/02 §6). Draw tracers from the weapon's `muzzle` node to the hit point.

### Clips for the animation stream (18 Oct 2026, animation-clip-asks.md)

![Clips](screenshots/clips-sheet.png)

- **The wobble fix:** the old export wrote CUBICSPLINE samplers whose quaternion tangents were identity quaternions (1,789 of 1,874), so bones wobbled between keys; the idle's pelvis bowed ±11°.
  - `clips.bake_linear` now resamples every clip at each frame (Blender's own curves, quaternions renormalised) as LINEAR keys, and the exporter writes LINEAR samplers. All 444 samplers in the 37 clips are LINEAR, and the client's `clipRepair.ts` becomes a no-op.
  - Each clip still carries only the bones it keys, so upper-body clips keep layering. Constant channels keep two keys. The runtime file grows from 183 KB to 218 KB, mostly from the seven new clips.
  - Every pre-existing clip is unchanged at its key times, checked against a rebuild of the previous code. That includes all aim holds and actions, and the reach margins above.
- **Sign continuity (M4 review):** the exporter derives each bone's quaternion from a matrix per key, so its sign came out arbitrary: 12 consecutive key pairs had a negative dot, in crouch_walk, flail, land_hard, melee and throw. `build_character.sign_continuous_rotations` negates those keys in the exported GLB, so no track turns the long way when an engine blends or lerps component-wise. Every key keeps the same rotation (all 431 tracks match up to sign). The clips are no longer meshopt-compressed, because meshopt made them larger (218 → 179 KB).
- **Planted feet** (`clips.gait`, leg IK in `clips.LegSolver`): `walk_slow`, `run` and `crouch_walk` are solved, not hand-keyed, and keyed at every frame.
  - `crouch_idle` (`clips.crouch_hold`) holds both feet flat at 0.12 m for the whole loop (measured: zero slide), with a slow weight shift from foot to foot and breathing in the back.
  - The phase starts with the left foot touching down.
  - During the stance the ankle stays at its rest height (0.12 m) and slides back at exactly the sim speed. In the swing it lifts and eases forward.
  - The pelvis drops so the short legs (hip 0.46 m, leg 0.35 m) reach the stride.

  | Clip | Speed | Cycle | Stance per foot | Planted slide (measured) | Stride |
  |---|---|---|---|---|---|
  | walk_slow | 0.5 m/s | 21 frames (1.43/s) | 60 % | 0.48–0.51 m/s, 13 frames at 0.120 m | 0.21 m |
  | run | 5 m/s | 10 frames (3/s) | 22 %, with a flight phase | 4.98–5.01 m/s | 0.36 m |
  | crouch_walk | 2.2 m/s | 12 frames (2.5/s) | 50 % | 2.19–2.22 m/s | 0.44 m (was ~5 cm) |

  At 5 m/s a chibi stance lasts only about 2 frames at 30 fps; the client's foot IK keeps it planted between samples.
- **Action poses:**
  - `flail`: arms windmilling out of phase, legs kicking;
  - `dash_side`: stretched along the dash, arms back;
  - `dash_up`: reaching forward and up (straight up hides behind the helmet);
  - `dash_down`: knees tucked, fists up for the slam;
  - `land_hard`: a deep squat;
  - `brake`: leaning back, front foot planted, arms out for balance.
- **Authoring order matters:** each finished clip goes onto an NLA track, and the IK-solved upper-body clips are solved against that stack. The new clips are authored after them, so every shipped hold stays identical. Moving them earlier changed the holds by up to 24°.

### Skin weight in the dye albedo (18 Oct 2026, animation-clip-asks.md §4)

![Skin](screenshots/skin-weight.png)

- **The face is out of the dye mask.** Nothing above the collar takes a dye any more.
  - Before, face texels (cheek highlights, around the mouth and eyes) shared the sand hue and landed in primary (R). They showed as pale specks under dark skin tones.
  - Skin texels that fell in a dye channel went from 7,869 to 348; the rest are soft borders at the cuffs.
- **Skin weight in `rookie_body*_dye_albedo` alpha** (`dye.rookie_body_skin`):
  - Which texels count: on the head, every warm light texel (skin, lips, and the sand the source baked along the hairline and ears); on the hands, only skin hues, so the sleeve cuffs stay cloth.
  - Skin texels store the painted colour divided by **skin_04 `#da9f75`**, per channel and in linear space. `dyeAlbedo × lerp(1, skinTone, alpha)` gives back the painted skin with skin_04, and any other tone keeps the lips' and cheeks' warmth.
  - The weight softens outward only, so a skin texel at partial weight can't keep a bright neutral colour and show as a pale outline. It also extends 3 texels into the atlas gutter, so UV seams don't fringe.
- **Alpha is floored at 1/255:** lossy WebP rewrites the colour under fully transparent texels. At the darkest tone the floor tints a non-skin texel by under 0.4 %. The runtime WebP keeps its alpha (minimum 1).
- **Flags:**
  - `rookie.json`: `dye.lod0/lod1.skin: "alpha"` and `skinNeutral: "#da9f75"`;
  - glTF extras on the body: `dyeSkin: "alpha"` and `skinNeutral`.
  - The asset check's dye round trip counts the skin weight like a dye channel; both LODs pass (dyed mean 0.003, undyed exact).
- **Defaults shift:** with the face gone, the primary's median moves slightly: `#b99664` → `#b29161` (LOD0).

### Budgets (assembled outfit: body + default jetpack)

| | Target (docs/04 §5) | LOD0 | LOD1 |
|---|---|---|---|
| Triangles | ≤ 4,000 / ≤ 1,800 | **3,900** | **1,750** |
| Draw calls | 1–3 | **2** (body, jetpack) | **2** |
| GPU textures (KTX2 estimate, albedo + dye masks) | ≤ 1.5 MB | **0.62 MB** | **0.16 MB** |
| Download (meshopt GLB + WebP + PNG masks) | — | body 461 KB, jetpack 67 KB, anims 176 KB, textures ≈ 0.6 MB | |

Reports: [rookie_outfit.check.txt](character/rookie_outfit.check.txt) (**40/40**), [rookie_outfit_lod1.check.txt](character/rookie_outfit_lod1.check.txt) (**40/40**), [jetpack_twin_tank.check.txt](cosmetics/checks/jetpack_twin_tank.check.txt) (**18/18**). The shipped runtime files pass the same check. `tools/asset-check/selftest.py`: **18/18**.

How the dye albedo is built (`dye.finish`):
- Dye defaults keep each channel's median hue at its 98th-percentile brightness, so the neutral grey (`lum / lum(default)`) stays ≤ 1 for all but the brightest 2% and highlights survive. A median default clipped them. On soft edges where the exact inverse would need a value above 1 (a bright colour next to a dark channel), the mask is capped so the default look is still reproduced exactly.
- In the mask core the dye albedo is that neutral grey.
- On the soft mask edges it is the exact inverse of the shader in linear space, `albedo / Π lerp(1, default, mask)`. A grey blend there rendered every island border 1.2–1.7× too bright.
- Undyed texels keep the albedo.
- With the default dyes, the round trip is now p95 0.005–0.007 linear luminance on dyed texels and exact on undyed ones.

`art/character/rookie.glb` and `rookie_lod1.glb` (the Phase 0 export) stay in place. W1 and W2 build against them until they switch to `characters/rookie/`, which will be a coordinated change later.

### Rebuild

```bash
blender -b --factory-startup --python art/pipeline/build_character.py -- \
  art/character/source/rookie_tripo_raw.glb art/character --name rookie --facing +x --runtime apps/web/public/assets
```

About 10 s on this machine. `blender` is `/Applications/Blender.app/Contents/MacOS/Blender` (5.2.1). Steps:
1. **Normalise:** face glTF +Z, 1.50 m tall, feet on y = 0.
2. **Landmarks → skeleton:** measure the full-res mesh and place the shared skeleton + 7 sockets ([rookie_rig.json](character/rookie_rig.json)).
3. **Split the jetpack:** generated meshes are a soup of closed shells; a shell is jetpack when ≥ 80% of it sits behind the back and it ends below the neck.
4. **LODs:** per part, collapse-decimate, fresh UVs, then bake the original albedo (decimation wrecks generated UVs). Tripo marks the goggles metallic, so metallic is zeroed before baking.
5. **Skin:** the body gets distance-to-bone weights gated by body region (rigid head, boots); the jetpack goes rigidly to `spine2`.
6. **Clips:** [pipeline/clips.py](pipeline/clips.py).
7. **Dye masks:** [pipeline/dye.py](pipeline/dye.py) classifies the baked albedo by colour, plus position via a baked position map (sand is cloth on the legs but skin on the hands), then closes and softens the mask.
8. **Export:** art sources (plain GLB + `rookie_preview.glb` with everything for quick looks) and, with `--runtime`, the web build.

Every Blender script here imports `pipeline/guard.py` first, so a crash exits 1 even without `--python-exit-code 1` and can't leave stale outputs that look fresh.

The Blender authoring scripts moved from `tools/asset-pipeline/` to `art/pipeline/` (`build_character.py`, `clips.py`, `dye.py`, `build_kit.py`, `render_views.py`, `split_sheet.py`), so `tools/asset-pipeline/` is free for W1's export stage (gltf-transform/KTX2).

## Milestone B (part 2): starter cosmetics

![Cosmetics](screenshots/cosmetics-sheet.png)
*Default Rookie, then each starter item on him: field cap, beret, bandana, combat helmet, aviators, gas mask, sneakers, jungle boots, tactical gloves, rocket pack, drum pack.*

![Dressed](screenshots/m-c-closeup.png)

**The Rookie is now body + 3 default parts:** `headgear_brim_helmet`, `boots_combat` and `jetpack_twin_tank`, so every slot can be swapped. `build_character.py` splits them off the generated mesh:
- it tags faces by part before splitting, because face indices shift after each split;
- it welds the glTF seam-split vertices so the parts decimate;
- the generator never modelled a skull under the helmet, so the body gets a **short-hair cap** in its place.

**11 starter items** (`art/pipeline/build_cosmetics.py`) are original toy-style designs, built procedurally on the Rookie's landmarks:

| Slot | Items | Skinning |
|---|---|---|
| headgear | Field Cap, Beret, Bandana, Combat Helmet (+ default Brim Helmet) | rigid to `head` |
| eyewear | Aviators, Gas Mask | rigid to `head` |
| boots | Sneakers, Jungle Boots (+ default Combat Boots) | rigid per foot; shafts blend into the calves |
| gloves | Tactical Gloves (inflated copies of each body LOD's hands) | the skin's own hand/forearm weights |
| jetpack | Rocket Pack, Drum Pack (+ default Twin Tank) | rigid to `spine2` |

- **Same path as the body:** each item is authored with vertex colours `Col` and `Dye` (mask). Both are baked to textures on fresh UVs (256² LOD0, 128² LOD1), so W2's dye shader treats cosmetics and body parts identically. Default dyes live in each item's extras and manifest.
- **Slot budgets** (LOD0 / LOD1): body 2,350 / 1,000; headgear 450 / 200; eyewear 150 / 70; boots 300 / 130; gloves 150 / 70; jetpack 550 / 250. Any full outfit therefore stays within docs/04 §5.6.
- **Checks:** every item passes `--kind part` at both LODs ([checks](cosmetics/checks/)): slot budget, skin, skeleton, weights, dye round trip and the **strict cosmetic envelope** (docs/04 §1.2: the body alone ×1.10, from the floor up, for every slot including the default parts). The envelope check caught the first Drum Pack 1 cm too deep. Under the strict rule, `build_character.py` and `build_cosmetics.py` fit every part with [pipeline/envelope.py](pipeline/envelope.py): the Gas Mask was redesigned slimmer, and the rest are scaled or squeezed. `envelopeOk` in each item's extras is the measured result.

  How far each part stuck out past the strict envelope before the fit, and after (LOD0; LOD1 is within 0.5 cm of LOD0):

  | Part | Before | After | How |
  |---|---|---|---|
  | Brim Helmet (default) | front 7.0, top 1.3 cm | inside | brim and crown squeezed |
  | Twin Tank (default) | back 4.3 cm | inside | scaled about its backplate |
  | Combat Boots (default), Sneakers, Jungle Boots | inside (the envelope reaches the floor) | inside | none |
  | Gas Mask | front 8.4 cm | inside | **redesigned**: a flat mouth plate with twin cheek filters instead of one front canister |
  | Field Cap | front 9.9 cm | inside | visor squeezed shorter |
  | Bandana | back 0.2 cm | inside | knot squeezed |
  | Combat Helmet | front 0.1 cm | inside | squeezed |
  | Rocket Pack | back 6.5 cm | inside | scaled about its backplate |
  | Drum Pack | back 6.0 cm | inside | scaled about its backplate |
  | Beret, Aviators, Tactical Gloves | inside | inside | none |

| Outfit | Tris | Draw calls after merge | GPU textures |
|---|---|---|---|
| Default Rookie (LOD0) | 3,648 / 4,000 | 1 (4 before merging) | 0.88 MB |
| Fully dressed worst case: combat helmet + gas mask + gloves + jungle boots + rocket pack | 3,937 / 4,000 | 1 (6 before) | 1.17 MB / 1.5 |
| Same, LOD1 | 1,711 / 1,800 | 1 | 0.29 MB |

- **Ships to** `apps/web/public/assets/cosmetics/<slot>/<id>[_lod1].glb`, plus a manifest per item and `cosmetics/index.json`.
  - `index.json` is an **asset map** (id → manifest by slot). **`packages/content/src/cosmetics.ts` (W2) is the catalogue**: it owns display names, rarity and unlocks, and the asset check WARNs when an item id is missing from it.
  - The `name` in the manifests is a placeholder. The GLB extras carry only `cosmeticId`.
- **One schema** for default parts and starter items:
  - manifests: `id, slot, name, default, lods, dye, tris`, plus `attachBone`/`socket` on rigid parts and `nozzles` on jetpacks;
  - GLB extras: `slot, cosmeticId, hidesHair, bodyTypes, envelopeOk, dyeDefaults, dyeMask, dyeAlbedo`, plus the same rigid/jetpack keys.
- **Jetpack nozzles:** every jetpack part lists its nozzle exits (`nozzles`, glTF character space): the Twin Tank 2, the Rocket Pack 2, the Drum Pack 1. The viewer draws one flame per nozzle in `socket_jetpack`'s frame.
- **Boot tops:** the generated Rookie's boot leather was fused into the trouser shells, so it stayed on the body and poked through every non-default boot. `build_character.py` now moves the dark-brown faces below the trouser cuff (z < 0.255 m) into the default boots: 719 faces.
- **Gloves:**
  - Each glove vertex copies the skin weights of the hand vertex it was made from, and each LOD is built from that body LOD's own hands.
  - The build runs a pose sweep: rest plus 11 frames of idle, walk, run, rifle and pistol aims, reload, melee and throw. It fails if skin pokes more than 6 mm through the glove.
  - Today the worst is 5.5 mm at one wrist vertex while running (LOD0) and 0.0 mm at LOD1. The review measured 22–39 mm before.
- **Viewer:** Locker-style slot pickers for the hero, plus a different outfit on every other soldier. Each part keeps its own default dyes; the dye pickers recolour every part's channel once touched.

Gaps:
- **Tops** (shirts/jackets) aren't in this batch: the shirt is part of the body and there's no torso underneath. They need either a body-region hide mask or overlay shells; that's W2's call.
- The procedural items are **cleaner and flatter than the painted Rookie**. Five of them are now rebuilt from Higgsfield models (see "Hero cosmetics from Higgsfield" above).

## Weapon fire VFX: muzzle flashes, tracers, casings (Weapons Forge 2)

![Fire VFX](screenshots/weapons-fire-fx.png)
*Each weapon frozen mid-shot in the viewer (`?fire=1`): its flash style at `muzzle`, the light pop, the tracer, and casings in flight from `eject`.*

![Gameplay](screenshots/fx-gameplay-1x.png)
*The same at 1× (the gameplay zoom).*

Everything ships in `apps/web/public/assets/vfx/` and is described by **`weapons.vfx.json`**:

| | What | Built by |
|---|---|---|
| `flash_atlas.webp` | 1024², 28 frames in cells of 256 × 128. Each frame's muzzle point sits at the same spot in its cell, so one quad shape fits all. Additive, 188 KB | `art/pipeline/build_vfx.py` from the Higgsfield sheets in `art/vfx/source/` |
| flash styles | `pistol`, `smg`, `rifle`, `shotgun`, `sniper`, `launcher`, `heavy`: 4 frames each, a quad size in metres, a light pop (colour, intensity, range) and a duration. Per shot: a random frame, scale 0.85–1.15, roll ±6°, a vertical flip | `build_vfx.py` |
| `tracer.webp` + tracer styles | white streak, head at +U, tinted per style: width, length, on-screen speed, one per N shots, per-pellet (shotgun), a fading smoke trail (sniper) | `build_vfx.py` |
| `casings.glb` + casing types | `casing_pistol` / `_rifle` / `_shotgun` (72–144 tris, about 4× real so they read at 1×): ejection speed, cone, spin, lifetime; 32 live at most | `art/pipeline/build_casings.py` (Blender) |
| `weapons` | per weapon: flash style (+ scale), tracer style, casing type and when it ejects (`shot`, `reload` ×6 for the revolver, `pump` / `bolt` after a delay, every 2nd shot for the minigun) | `build_vfx.py`; it fails if a weapon in `sockets.json` has no entry or an entry needs a socket the weapon lacks |

Colours are white to lemon-yellow (the launcher bloom has a golden rim), so a flash never reads as a team colour. Tracer and flash colours are the hook for cosmetic tracer and flash tints later; those are store-safe cosmetics.

```bash
B=/Applications/Blender.app/Contents/MacOS/Blender
$B -b --factory-startup --python-exit-code 1 --python art/pipeline/build_casings.py -- art/vfx --runtime apps/web/public/assets
python3 art/pipeline/build_vfx.py --runtime apps/web/public/assets
```

**Flash sources (Higgsfield, GPT Image 2.5, medium, 1k, transparent background; 0.5 credits each):** one 2×2 sheet per style. The prompt pattern was "Sprite sheet for a side-view cartoon shooter game: four variations of a <STYLE> muzzle flash: <shape>. Arranged in a 2x2 grid … Each flash starts at one point at the left-middle of its quarter and blasts to the RIGHT: every flame petal fans forward to the right like a cone, none point back to the left. Hot white core fading to bright lemon yellow … Flat-shaded toon style … No gun, no smoke, no sparks, no text. Transparent background." Job ids:
- pistol `82b12661…`
- smg `3b78a8a3…`
- rifle `8785f752…` (a first rifle test `e83ddef1…` swept its petals backward and was not used)
- shotgun `dac431db…`
- sniper `72059270…`
- launcher `5617a462…`
- heavy `2b345da1…`

## Impact VFX and decals (Weapons Forge 3)

![Impacts](screenshots/impacts-sheet.png)
*Viewer `?impacts=1`: one block per sim surface, each with a burst on its top and its side face, frozen particles and bullet-hole decals; the non-gory hit marker on a character.*

`art/pipeline/build_impacts.py` ships to `apps/web/public/assets/vfx/`, described by **`impacts.vfx.json`**:
- **`impact_atlas.webp`** (1024 × 1536, 24 cells of 256²): `concrete`, `metal`, `wood`, `dirt`, `glass`, plus `player`, 4 variants each.
  - A surface burst's hit point sits at the bottom-middle of its cell, and +V is the surface normal. The renderer rotates the quad to the normal.
  - `player` is a centred comic pop: white star, pale yellow ring, no blood (age rating). Its soft glow is faded radially so it never ends in a square.
  - Keyed by the sim's `Material` ids (`packages/content` maps: 0 concrete, 1 metal, 2 wood, 3 dirt, 4 glass).
- **Per style:** quad size, life (pop in over the first 25 %, fade over the last 50 %), and **particles**.
  - Particle kinds are chips, dust or sparks, each with count, tint, size, speed, cone, gravity and life. Sparks are additive and stretch along their velocity.
  - The particle sprites are in `particles.webp` (256 × 64: spark, dust, chip; white, tinted per use).
- **Decals:** `decal_atlas.webp` (512 × 256, cells of 128²). Concrete chip, metal dent, wood hole, dirt pock, glass crack, plus `scorch` for explosions.
  - Each decal lives 8 s and fades over the last 1 s. At most 64 live (oldest first).
  - Decals go on map surfaces only, never on characters.

```bash
python3 art/pipeline/build_impacts.py --runtime apps/web/public/assets
```

**Sources (Higgsfield, GPT Image 2.5, medium, 1k, transparent; 0.5 credits each):**
- Six 2×2 impact sheets: "… four variations of a bullet impact on <SURFACE> … each burst starts at one point at the BOTTOM-middle of its quarter and sprays UPWARD … Flat-shaded toon style … No wall, no ground, no bullet, no text".
- The player sheet: "… a non-gory HIT MARKER … a white star-shaped pop with a thin pale yellow ring … No blood, no wound".
- One 3×2 decal sheet.

Job ids:
- concrete `f888893e…`
- metal `0cf3fd38…`
- wood `a92dc810…`
- dirt `9b09ad7f…`
- glass `fc9e21cd…`
- player `73499fc6…`
- decals `5a0efc56…`

## Explosion VFX for blast launches (Weapons Forge 4)

![Explosions](screenshots/explosions-sheet.png)
*Viewer `?boom=1`: a frag at its peak (shockwave growing to the 4 m blast radius, debris, dust, scorch), a rocket mushroom, and the puff trail of a blast-launched player; below, both flipbooks.*

Blasts now throw players up to 16 m (NOTES §17), so an explosion has to show its reach and make the flight read as a launch. `art/pipeline/build_explosions.py` ships **`explosions.vfx.json`** with:
- **Flipbooks** in `explosion_atlas.webp` (2048 × 1024, 16 frames of 256² each):
  - `frag` (flash → fireball → smoke, 18 fps): anchored on the fireball centre;
  - `rocket` (a mushroom with a base ring, 16 fps): anchored on the base, on the surface it hit.
  
  A flipbook keeps its frames' positions relative to each other (one crop and scale per sheet), so the anchor holds still through the animation.
- **Styles sized from `packages/content`:** `frag` reads the 4 m radius from `grenades.ts`. `rocket` (3.5 m) and `grenade_launcher` (3.0 m, frag flipbook) take docs/03 §5's splash radii and are marked `provisional` until their content entries exist; their fireballs scale with the radius. Each style has:
  - a **shockwave ring** (`shockwave.webp`) growing to the blast radius in 220 ms;
  - a light flash;
  - debris chips and ground dust (from `particles.webp`);
  - a `scorch` decal;
  - a **camera-shake suggestion** (amplitude, 14 Hz, 420 ms decay, full within the radius, zero at 3.5 × it).
- **`launchTrail`:** puffs behind a player while a blast throws them faster than `launchSpeedX` (12 m/s), so a 16 m flight reads as a launch, not a teleport.

```bash
python3 art/pipeline/build_explosions.py --runtime apps/web/public/assets
```

**Sources (Higgsfield, GPT Image 2.5, high, 2k, transparent; 2.75 credits each):**
- frag `a0ca5559…`: "a 16-frame animation of a GRENADE EXPLOSION laid out in a 4x4 grid … white-hot star flash … round puffy fireball … turning into dark grey smoke … faint wisps";
- rocket `984b39d4…`: "a big ROCKET EXPLOSION … a large mushrooming fireball … a ring of smoke puffs around its base".

The fireballs are yellow to amber and last under a second, so they don't compete with the team-orange outline the way a static prop would.

## Special-weapon VFX and projectiles (Weapons Forge 8c)

![Specials](screenshots/specials-sheet.png)

`art/pipeline/build_specials.py` ships **`specials.vfx.json`**: what the six non-bullet weapons fire, how it moves and what it leaves. `weapons.vfx.json` points to it with a per-weapon `special` key.

| Style | Kind | What it draws |
|---|---|---|
| `dragon` | flame | flame puffs from the muzzle every 0.15 s (3 per spawn, so the stream reads continuous). They play the flame flipbook over their 0.8 s life and grow 0.15 → 0.6 m like the sim. Also a pilot flame on `pilot`, a flickering light, a burn on the victim and a wall scorch |
| `arc` | beam | a camera-facing strip from the muzzle to the hit (`beam.webp`, tileable, scrolling), a glow at the muzzle, a spinning flare and sparks at the hit |
| `pulse` | orb | a charge glow and shrinking ring on `charge` (0.7 s), the orb flicker flipbook flying at 8 m/s through walls with a glow trail, and the EMP burst: a blue shockwave to R 2.5, a flash, a light, and crackle at a stunned jetpack |
| `ripper` | blade | charge sparks at the blade hub (0.4 s), the blade spinning at 14 turns/s with a faint trail, sparks on every bounce, and a half-size frag explosion after 5 s |
| `popper` | grenade | the grenade round with a dust trail, arcing under 1 g, then the `grenade_launcher` explosion (R 3.0) |
| `thumper` | rocket | the rocket with a flame flipbook at its nozzle and a smoke trail, then the `rocket` explosion (R 3.5) |
| `riot_shield` | shield | a metal impact and a ring ripple per hit, three cumulative crack decals by HP, and chips when it breaks |

- **Textures:**
  - `flame_atlas.webp`: the Higgsfield flame puff, cropped once per sheet so it stays centred;
  - `specials_atlas.webp`: the orb flicker ×4, pilot flame, beam flare, glow, ring and shield cracks, drawn procedurally so they size and tile exactly;
  - `beam.webp`.
- **Projectiles** (`art/pipeline/build_projectiles.py` → `vfx/projectiles.glb` + `projectiles.json`): the rocket (148 tris), the grenade round (144) and the saw blade (280), in the muzzle frame, so a renderer spawns one at the weapon's `muzzle` with the weapon's rotation. Each has a trail point and a spin axis.
- **`vfx/manifest.json`:** the index of every VFX file, written by the last builder from the files actually present. It lists the builder, what each file holds, and texture sizes. The format note for the renderer is in the shared notes (forge-vfx-manifest.md).
- Speeds, ranges and timings are docs/03 §7's and marked `provisional` until packages/content has these weapons. The Armory doesn't preview these effects yet; that's next on the Forge list.

```bash
blender -b --factory-startup --python-exit-code 1 --python art/pipeline/build_projectiles.py -- art/vfx --runtime apps/web/public/assets
python3 art/pipeline/build_specials.py --runtime apps/web/public/assets
```

**Source (Higgsfield, GPT Image 2.5, medium, 2k, transparent; 1.0 credit):** flame `b30b0079…`, prompt: "Sprite sheet for a side-view cartoon shooter game: a 16-frame animation of ONE FLAMETHROWER FIRE PUFF laid out in a 4x4 grid, read left to right, top to bottom. Frame 1 is a small, tight, bright ball of flame; it quickly swells into a big rolling, billowing cloud of fire with curling tongues of flame (frames 4 to 9), then breaks up and darkens into puffy dark grey smoke (frames 10 to 14) and fades to faint wisps (frames 15 and 16). Every frame is centred in its own cell with clear empty space around it, and no frame touches another. Flat-shaded toon style with crisp cel shading: hot white-yellow core, bright orange body, deep red-orange edges, then charcoal grey smoke. No gun, no sparks, no ground, no text, no numbers, no borders. Transparent background."

## Armory: the 3D weapon viewer (Weapons Forge 5)

![Armory](screenshots/armory-sheet.png)
*`/armory.html`: K-47 with its sockets (Lobby); the Widow at Night (scope marked built-in); the Thumper firing in the Desert (art only, no stats yet); the Breacher zoomed to its muzzle, firing.*

`apps/web/src/armory/` (linked from the debug bar, next to the Locker) shows every model in `assets/weapons/`:
- **Turntable:** drag to rotate and tilt, scroll to zoom.
- **Focus:** Whole or Muzzle; click a socket in the list to zoom to it.
- **Sockets toggle:** gizmos in the sheet's colours, rails drawn along their usable length.
- **Fire:** pops the weapon's muzzle flash and light (`vfx/weapons.vfx.json`).
- **Lighting:** the Locker's Lobby / Night / Desert presets.
- **Stats card from `packages/content`:** damage (per pellet for the shotgun), fire rate, range and falloff, time to kill 100 HP, move speed, magazine, reload, zoom. Grenades show blast radius, launch, fuse and carry count. Models with no content entry yet say so.

It mounts like the Locker (`mountArmory(el)` / `mountArmoryRoute(el)` for W4's shell). The standalone page takes deep-link params: `?weapon=k47&focus=muzzle&light=night&fire&hold=<ms>`.

## Attachments: "things you can add" (Weapons Forge 6)

![Attachments](screenshots/attachments-sheet.png)
*Armory with attachments mounted:*
- *K-47: long scope, foregrip and laser sharing the bottom rail, suppressor (the flash leaves its tip), drum;*
- *Widow at night: suppressor, foregrip, long mag;*
- *Hawk: dot sight, suppressor, laser, long mag;*
- *Buzz in the desert: dot sight, drum.*

`art/pipeline/build_attachments.py` (Blender, the arsenal's toy style, 0 credits) builds 7 parts. They ship in `apps/web/public/assets/attachments/<id>.glb` and `attachments.json`:

| id (content) | Name | Mount | Tris | Fits |
|---|---|---|---|---|
| `sight_dot` | Dot Sight | rail_top | 112 | any unoccupied top rail: Hawk, Hammer, Buzz, K-47, Breacher, Thumper, Shredder |
| `sight_long` | Long Scope | rail_top | 572 | top rails ≥ 0.10 m: Hammer, K-47, Breacher, Thumper, Shredder (the Widow's scope is built in) |
| `suppressor` | Hush Can | muzzle | 316 | bores ≤ 0.02 m, not the launcher or heavy: Hawk, Hammer, Buzz, K-47, Breacher, Widow. Scaled to the bore; the flash moves to its tip at 0.4 × size |
| `foregrip` | Grip Stub | rail_bottom | 152 | two-handed with a bottom rail: K-47, Widow |
| `laser` | Laser Pointer | rail_bottom | 140 | any bottom rail: Hawk, Hammer, Buzz, K-47, Widow. A `beam` node; the beam is green, never a team colour |
| `mag_ext` | Long Mag | mag | 88 | box mags pointing down: Hawk, Buzz, K-47, Widow |
| `mag_drum` | Drum Mag | mag | 236 | K-47, Buzz |

- **Mounting:** each part is modelled in its mount frame, which is the weapon frame moved to the socket.
  - Rail parts sit above or below the rail centre. A foregrip and a laser share a bottom rail at −¼ / +¼ of its length.
  - Mag parts turn their −Z onto the mag socket's `dir`.
  - The fits are computed from `weapons/sockets.json`.
- **Data model:** `packages/content/src/attachments.ts` holds identity and fit only (id, name, kind, mount, sight level); the arsenal stream adds stats. The builder fails if its ids or mounts drift from content.
- **Fairness default** (pending the owner's confirmation): every attachment is `acquisition: 'pickup'`, `sellable: false`, an in-match pickup that is never sold, and a content test pins that. Cosmetic skins, charms and flash/tracer colours can be store items.
- **Armory:** the side panel lists the attachments that fit the selected weapon. Mount one per socket (the bottom rail takes two), see the whole kit framed, and Fire from the suppressor. Deep link: `?weapon=k47&attach=sight_long,foregrip,laser,suppressor,mag_drum`.

## Weapon camos (Weapons Forge 7)

![Camos](screenshots/camos-sheet.png)
*Armory: K-47 in Forest Patch, Thumper in Dune, Widow in Snowline, Shredder in Pixel. Grips, barrels, the scope and the orange toy tips keep their colours.*

The weapons have no UVs (vertex colours on one material), so a camo works like the characters' dye mask, but in object space:
- **Mask:** `build_weapons.py` writes a `_CAMO` vertex attribute: 1 on body panels (gunmetal, olive polymer, wood, sand), 0 on grips, steel, the toy muzzle tip and blades. A camo therefore never hides a weapon's role, its silhouette or where it points.
- **Patterns:** `art/pipeline/build_camos.py` makes 6 tileable patterns as periodic noise, built in the frequency domain so they tile exactly. They are quantised into 3–4 levels and stored as indices in `weapons/camo_patterns.png` (1024 × 512, 31 KB).
- **`weapons/camos.json`:** a palette per camo, one tile per 0.30 m. The build fails if a palette colour is within 25 ΔE of a team colour.

| id | Name | Palette |
|---|---|---|
| `forest_patch` | Forest Patch | black, olive, brown, moss |
| `dune` | Dune | tan, sand, pale sand |
| `concrete` | Concrete | three greys |
| `snowline` | Snowline | grey-blue to white |
| `stripe` | Stripe | black, brown, olive: horizontal stripes |
| `pixel` | Pixel | four greens in 1.9 cm blocks |

- **Shader:** `apps/web/src/armory/camo.ts` is the reference. It projects the pattern triplanar in the weapon's frame, picks the dominant face for crisp edges, uses nearest sampling without mipmaps, and sets the palette colour on `_CAMO` panels; the toon lighting shades it.
- **Armory:** a camo picker (Factory plus the 6). The choice stays when you switch weapons. Deep link `?camo=forest_patch`.

Camos are cosmetic (no gameplay effect), so they are store-safe. W2's cosmetics catalogue can list them as weapon skins.

## Milestone B (part 1): the arsenal

![Weapons](screenshots/weapons-sheet.png)
![In hand](screenshots/weapons-in-hand.png)
*Every weapon in the Rookie's hand through the aim layer (machete mid-swing, frag at the throw wind-up).*

`art/pipeline/build_weapons.py` builds 22 original weapons (docs/03 §5 names) as chunky toy guns. They use vertex colours on one material, no textures, and an **orange toy muzzle tip** that reads at gameplay size:

| id | Name | Family (docs/04 §4.2) | Aim pose | Hands | Tris | Length |
|---|---|---|---|---|---|---|
| hawk50 | Hawk .50 | pistol | pistol | 1 | 268 | 0.28 m |
| hammer44 | Hammer .44 | pistol | pistol | 1 | 520 | 0.36 m |
| buzz | Buzz | pistol | pistol | 1 | 404 | 0.42 m |
| k47 | K-47 | rifle | rifle | 2 | 492 | 0.92 m |
| breacher | Breacher | shotgun | rifle | 2 | 496 | 0.95 m |
| widow | Widow | sniper | rifle | 2 | 880 | 1.15 m |
| thumper | Thumper | launcher | rifle | 2 | 616 | 1.08 m |
| shredder | Shredder | heavy | rifle | 2 | 740 | 0.73 m |
| machete | Machete | melee | pistol | 1 | 312 | 0.58 m |
| frag | Frag grenade | thrown | pistol | 1 | 448 | 0.09 m |
| mine | Proximity mine | thrown | pistol | 1 | 472 | 0.20 m |
| rattler | Rattler | pistol | pistol | 1 | 348 | 0.31 m |
| hornet | Hornet | rifle | rifle | 2 | 616 | 0.58 m |
| trident | Trident | rifle | rifle | 2 | 704 | 0.91 m |
| bullpup | Bullpup | rifle | rifle | 2 | 472 | 0.63 m |
| longbow | Longbow | sniper | rifle | 2 | 892 | 1.04 m |
| dragon | Dragon | heavy | rifle | 2 | 968 | 0.90 m |
| arc | Arc | rifle | rifle | 2 | 876 | 0.87 m |
| popper | Popper | launcher | rifle | 2 | 756 | 0.80 m |
| ripper | Ripper | launcher | rifle | 2 | 960 | 0.89 m |
| pulse | Pulse | launcher | rifle | 2 | 888 | 0.78 m |
| riot_shield | Riot Shield | shield (off-hand) | pistol | 1 | 652 | 0.59 m tall |

- **Frame (docs/04 §9.4):** origin at the grip, +Y toward the muzzle, +Z up, +X to the weapon's right, so a weapon attaches to `socket_weapon_R` with an identity transform.
- **Sockets** (child nodes; all in [`weapons/sockets.json`](weapons/sockets.json), which the renderer reads). Each socket has `pos`, and a unit `dir` in the weapon frame (all but `offhand`):

  ![Sockets](screenshots/weapons-sockets.png)

  | Socket | What it's for | dir | On |
  |---|---|---|---|
  | `grip` | the main hand (the origin) | +Y | every weapon |
  | `muzzle` | flash and tracer origin, suppressor mount; `boreRadius` sizes both | +Y | every firearm |
  | `offhand` | left-hand IK target, ≤ 0.10 m from the grip (chibi arms) | — | two-handed |
  | `eject` | casings leave here | right, up, a little back (Shredder: down-right) | every firearm but the Thumper (Hammer: spent cases on reload) |
  | `mag` | magazine / loading point for reload VFX | the way the mag drops or a round goes in | every firearm: the cylinder (Hammer), the loading port (Breacher), the breech (Thumper), the ammo box (Shredder) |
  | `rail_top` | scope / sight mount; `lengthM` of usable rail; `occupied: "scope"` on the Widow (built-in scope) | +Z | every firearm |
  | `rail_bottom` | foregrip / laser mount, `lengthM` | −Z | Hawk, Hammer, Buzz, K-47, Widow |
  | `backblast` | launcher exhaust | −Y | Thumper |
  | `tip` / `pin` / `light` / `ground` | machete tip; frag pin ring; mine light; frag and mine rest frame in the world (`world = floorPoint × inverse(ground.local)`) | | machete / frag / mine |
  | `pilot` | the flamethrower's pilot light | +Y | Dragon |
  | `charge` | where a charge weapon's wind-up shows: the blade hub, the orb | +Y | Ripper, Pulse |
  | `face` | the shield's front face centre (what it blocks); `halfSize` [w/2, h/2] | +Y | Riot Shield |

- **Ships to** `apps/web/public/assets/weapons/<id>.glb` (meshopt), with `weapons.json` (name, family, aimPose, hands, tris, length, node positions) and `sockets.json`.
- **Weapon extras:** `casings: false` on weapons that throw no casing per shot (Dragon fuel, Arc cell, Popper drum, Ripper blade, Pulse orb): they need no `eject` socket and take no suppressor or long mag. `attach: "socket_weapon_L"` on the Riot Shield, which goes in the off hand next to a one-handed weapon. `shield` is a new family beside docs/04's list (plus `thrown`).
- **Glow:** energy parts (the Arc's lens and cell, the Pulse's coils and orb, the Dragon's pilot ring) carry a `_GLOW` vertex attribute. `apps/web/src/armory/glow.ts` adds their vertex colour as emission, so they read lit in any lighting, and a camo keeps the glow.
- **Checks:** `tools/asset-check/check.py --kind weapon` verifies the triangle budget (1,000), one material, the extras, the muzzle direction, the offhand reach, the `ground` node on throwables, and the sockets: the set each family needs, unit directions, every socket within 3 cm of the mesh, the muzzle firing along +Y with a bore radius, casings ejecting to the right, and the rails above / below the bore facing up / down. All 22 pass ([checks](weapons/checks/)). The shield's `face` must sit ahead of the hand facing +Y, and `casings: false` drops the `eject` requirement. The selftest has six socket probes: casings ejecting to the left, a missing top rail, the Dragon passing without `eject`, the Dragon failing when marked as throwing casings, the Riot Shield passing, and the shield failing without its `face`. It also WARNs when a `weaponId` isn't in `packages/content` yet: `hawk50`, `thumper`, `shredder` and `mine` still aren't.
- **Dual wield** in the viewer is the classic Hammer + Buzz pair on `socket_weapon_R` / `socket_weapon_L`.

Known gaps:
- The Thumper and Shredder use the rifle hold (`aimPose: rifle`). A shoulder-launcher pose and a hip-held heavy pose would read better; tell W1 if wanted.
- **Weapons Forge 8, batch 1** added the Rattler (machine pistol), Hornet (high-rate SMG), Trident (burst rifle), Bullpup and Longbow (marksman rifle).
  - Each follows concept → model → sockets → VFX hook-up. The concept sheet (Higgsfield GPT Image 2.5 medium 2k, job `bb746034…`, 1.0 credit) was removed from the repo at merge: it echoed real-world rifles (a carry-handle sight, a bullpup stock), which breaks the clean-room rule. The shipped models are original; new concept prompts must ask for invented silhouettes.
  - The models are blocky toy reads, not copies of the concept's real-world-looking details.
  - All pass asset-check, carry sockets and `_CAMO`, have VFX hook-ups, and fit attachments.
  - They WARN until `packages/content` has their ids.
- **Weapons Forge 8, batch 2** added the Dragon (flamethrower), Arc (beam laser), Popper (grenade launcher), Ripper (saw-blade launcher), Pulse (EMP orb gun) and the Riot Shield.
  - Concept sheet (Higgsfield GPT Image 2.5 medium 2k, job `61403d16…`, 1.0 credit): not kept in the repo. Its six-shot drum grenade launcher echoed a real-world design, which breaks the clean-room rule, like batch 1. The shipped models are original toy reads; the Popper is a generic hex drum in a frame.
  - Prompt, for the record (future prompts add "invented silhouettes, not based on any real-world firearm"): "Concept sheet for a stylised toy-soldier video game arsenal: six chunky, low-poly, blocky toy weapons, each in a flat side view facing right … No text, no labels, no logos. … 1) a chunky flamethrower: a fat nozzle with a small pilot-light ring, a rounded fuel tank slung under the body, a short hose loop, a side handle; 2) a sci-fi continuous beam laser rifle: a long box body with a glowing cyan crystal lens at the front, cooling fins, a glowing power cell slot on the side; 3) a stubby grenade launcher with a fat revolving drum cylinder and a wide short barrel; 4) a saw-blade launcher …; 5) a bulky EMP orb gun: … three claw prongs holding a glowing blue energy sphere, coils around the barrel; 6) a rectangular riot shield seen from the front …"
  - In the Armory ([screenshot](screenshots/weapons-c-armory.png)): the Arc at Night, the Pulse in Dune, the Dragon in Forest Patch, and the Ripper.
  - All pass asset-check, carry sockets, `_CAMO` and (energy weapons) `_GLOW`, and fit the attachments that make sense: sights on all five guns, the foregrip and laser on the Arc's bottom rail, no suppressor on a beam or launcher.
  - **Their fire VFX is the next step:** flame stream, beam, EMP orb and burst, blade sparks, shield hits, and projectile models (rocket, grenade round, blade). Until then the Armory's Fire button stays off for them.
  - The Riot Shield is all edge from the side-view camera, so it's 6 cm thick to read as a slab. Turning it ~30° toward the camera when held would show its face; that's a renderer call.
  - They WARN until `packages/content` has their ids.
- **Armory framing:** the whole-weapon view now aims at the weapon's centre rather than its grip, and backs off on narrow stages. Long guns used to run under the side panel at 1280 px.

---

## Phase 0 art-style test (16 Oct 2026)

The art-style test from [docs/12](../docs/12-roadmap.md) §2: one rigged chibi soldier and a 20 m map slice, viewed in Three.js at the gameplay camera. Concepts and the base mesh come from Higgsfield; Blender (headless) does the rest. **17.25 credits.**

![Gameplay view, 1× zoom, 1080p](screenshots/gameplay-1x.png)
*1× zoom (36 m wide) at 1920×1080: the real on-screen size. Each soldier is about 80 px tall.*

| | |
|---|---|
| ![Hitboxes](screenshots/closeup-hitboxes.png) *Damage hitboxes (red) from `packages/content`* | ![Inverted hull](screenshots/gameplay-1x-hull-outline.png) *Inverted-hull team outline tints the whole soldier at gameplay size; the viewer's default is a screen-space silhouette* |

![Turnaround](screenshots/rookie-turnaround.png)

### Concepts (Higgsfield, GPT Image 2.5)

Three original directions, each a front/side/back sheet. **You picked A.**

| | Sheet | Direction |
|---|---|---|
| **A** ✅ | [concepts/A-vinyl-rookie.png](concepts/A-vinyl-rookie.png) | **Vinyl Rookie**: soft vinyl toy, bowl helmet + goggles, twin-tank jetpack, sand/olive with a teal accent |
| B | [concepts/B-doodle-grunt.png](concepts/B-doodle-grunt.png) | **Sketchbook Grunt**: painted sketchbook look, beanie under a dented half-helmet, extinguisher jetpack |
| C | [concepts/C-tin-trooper.png](concepts/C-tin-trooper.png) | **Tin Trooper**: painted tin wind-up toy, dome helmet with a glowing visor, rocket jetpack |

Settings: `gpt_image_2_5`, quality `high`, `2k`, 16:9. No reference images were used, and the prompts name no existing game, character or brand (docs/01 §12).

Each prompt is the direction paragraph below followed by this shared layout paragraph:

> Layout: the SAME character shown three times side by side at identical scale and height — front view, left side view (profile), back view — orthographic, full body, neutral A-pose with arms angled about 30 degrees down and away from the body, feet shoulder-width apart, empty hands (no weapon, holding nothing). Chibi proportions: the head including helmet is one third of the total height; short stubby limbs; chunky mitten hands with a separate thumb; big boots. Bold, simple, instantly readable silhouette. Clean flat light-grey background, soft even studio lighting, no cast shadows, no text, no labels, no logos, no watermarks, no insignia or national flags.

<details><summary>Direction paragraphs (exact text)</summary>

**A:** Character turnaround reference sheet for a 3D game model. Stylised 3D render, soft vinyl designer-toy look with a light toon-shaded ramp and subtle hand-painted texture detail. An original cheerful rookie jetpack soldier: rounded bowl helmet with a wide brim and chin strap, oversized aviator goggles pushed up on the helmet, big round face with simple dot eyes and a small confident grin, sand-khaki fatigues with rolled sleeves, olive chest webbing with three chunky pouches, a bright teal armband on the left upper arm, dark brown boots. On the back: a compact jetpack made of two short rounded fuel tanks side by side on a strap frame, each ending in a stubby flared nozzle pointing down. Palette: sand, olive, warm brown, with teal as the only saturated accent (armband and goggle lenses).

**B:** Character turnaround reference sheet for a 3D game model. Stylised 3D render that looks hand-painted, like a sketchbook doodle brought to life: visible painterly brush strokes and slightly wobbly ink-like outlines painted into the textures, light toon shading. An original stocky, scrappy jetpack grunt: a knitted beanie under a dented half-shell helmet, a bandana around the neck, square jaw with a little stubble patch, determined eyebrows, large expressive eyes, a patched olive-green jacket with a big zip and elbow pads, mustard cargo shorts over dark leggings, oversized lace-up boots, an orange armband on the left upper arm. On the back: a jetpack built from a repurposed brick-red extinguisher-style cylinder strapped vertically, with a single wide nozzle at the bottom and two small stabiliser fins. Palette: olive, mustard, brick red, off-white, with orange as the accent.

**C:** Character turnaround reference sheet for a 3D game model. Stylised 3D render of a painted tin wind-up toy soldier: smooth rounded forms, glossy enamel paint with a few tiny chips at the edges, small rivets and seam lines, light toon ramp. An original plucky jetpack trooper: a round dome helmet with a flip-up visor that has a glowing cyan visor strip, a friendly face with simple oval eyes, a rounded torso like a tin can with a brass belt, short tube-like arms and legs with ball joints at the shoulders and knees, big rounded boots, a cyan band around the left upper arm. On the back: a retro rocket-style jetpack — a single bullet-shaped tank with three small tail fins and twin nozzles at its base, plus a small decorative wind-up key on top that stays close to the body. Palette: navy blue, cream, brass, with cyan as the accent.

</details>

### 3D model (Higgsfield → Tripo H3.1 multiview)

- **Input:** sheet A split into [front / left / back](concepts/A-views/) by `art/pipeline/split_sheet.py`.
- **Model:** `tripo_h3_1_multiview_to_3d`, `face_limit: 30000`, `texture: true`, `pbr: true`.
- **Output:** [character/source/rookie_tripo_raw.glb](character/source/rookie_tripo_raw.glb): 29,860 tris, 2048² maps, A-pose, facing +X, 1 m tall. It fails the asset check, as expected for raw output.

### Map-slice kit (`kit/kit_yard.glb`)

`art/pipeline/build_kit.py` builds three toy-like bevelled pieces with baked vertex colours and one shared material: `ground_4m` (walkable top at y = 0), `platform_2m` (hazard-yellow drop-through), `crate_1m` (bottom at y = 0). [Check](kit/kit_yard.check.txt): **10/10**.

### Findings that still stand

1. **Outline:** use a screen-space silhouette, not the inverted hull (the hull tints the whole soldier at ~80 px). The viewer implements the silhouette pass.
2. **Palette contrast:** without outlines the sand/olive soldier sinks into the yard; the dye system now makes saturated defaults a one-line change.
3. **Crouch vs hitbox:** the crouch puts the head centre at 0.89 m (crouched hitbox 0.84 m); the helmet top sits 13 cm above the crouched hitbox.
4. **Helmet brim radius** ≈ 0.35 m vs the 0.24 m head hitbox.

## Viewer (`tools/art-preview/`)

```bash
python3 tools/art-preview/serve.py      # http://localhost:8123/tools/art-preview/
```

It loads the **shipped runtime files** (meshopt GLB + WebP) with three.js r186, using the docs/01 §5 camera (perspective, 35° FOV, 5° tilt, zoom by visible width per docs/03 §10). `?map=street_market` switches to map mode (kit + layout + spawns as soldiers; `cx`/`cy` centre the camera). Panel: zoom (portrait / close-up / 1×–7×), hero clip, hero weapon (rifle / pistol / dual / none), hero aim angle, action buttons, shading (toon + dye mask / toon / flat / PBR), dye colour pickers, LOD, how far the soldiers turn toward the camera, outline style, hitboxes. **Save screenshot** writes to `art/screenshots/`. URL params: `zoom, clip, family, aim, shading, lod, outline, hitboxes, focus=<roster index>, dyeP/dyeS/dyeA=<hex>, action=<reload|swap|throw|melee>, t=<seconds>, shot=<name>`. `shot` renders deterministically and saves, so it works in a hidden tab.

## Asset check (`tools/asset-check/`)

```bash
blender -b --factory-startup --python-exit-code 1 --python tools/asset-check/check.py -- art/character/rookie_body.glb,art/character/parts/headgear_brim_helmet.glb,art/character/parts/boots_combat.glb,art/character/parts/jetpack_twin_tank.glb
blender -b --factory-startup --python-exit-code 1 --python tools/asset-check/check.py -- <part.glb> --kind part --base art/character/rookie_body.glb,art/character/parts/headgear_brim_helmet.glb,art/character/parts/boots_combat.glb,art/character/parts/jetpack_twin_tank.glb
blender -b --factory-startup --python-exit-code 1 --python tools/asset-check/check.py -- art/weapons/k47.glb --kind weapon
blender -b --factory-startup --python-exit-code 1 --python tools/asset-check/check.py -- art/kit/kit_yard.glb --kind kit
blender -b --factory-startup --python-exit-code 1 --python tools/asset-check/check.py -- art/kits/street_market/kit_street_market.glb --kind kit
blender -b --factory-startup --python-exit-code 1 --python tools/asset-check/selftest.py
```

It exits 0 on PASS, 1 on any FAIL and 2 if the check itself crashed. Keep `--python-exit-code 1`, or Blender exits 0 when a script raises.

What it checks:
- Comma-separated files are checked as one assembled character, because the docs/04 §5 budgets are per character on screen.
- **Parts:**
  - They must be skinned in character space (docs/04 §9.3), with exactly the shared joints.
  - The bind pose must equal the base body's (≤ 1 mm, 0.1°), and weights must be normalised. Stray bones FAIL.
  - Each part has one mesh and one material, and textures of at most 256² (LOD0) or 128² (LOD1).
  - A missing or unknown `slot` FAILs, as do missing `bodyTypes`, `envelopeOk` or dye extras (or an explicit `dyeable: false`).
- The cosmetic envelope is **strict** (docs/04 §1.2): no cosmetic sticks out past the body.
  - The box is the body alone, ×1.10, from the floor up, for every slot including default parts. Default parts listed in `--base` are ignored.
  - Pass the LOD0 body for every LOD.
  - The `envelopeOk` extra must match the measurement.
  - Builders fit parts with [pipeline/envelope.py](pipeline/envelope.py): jetpacks scale about their backplate, while brims, visors, crowns and soles are squeezed in.
- **Locality** (docs/04 §1.2): a part must also stay inside the box of the body vertices skinned to its slot's bones, plus the slot's default part, ×1.10. A 1 m-wide hat, or eyewear hanging to the shins, fits the body box but fails here.
- **Dye round trip** on every texel the mesh's UVs cover:
  - dyed texels: `dyeAlbedo × Π lerp(1, default, mask)` vs the albedo, linear luminance, mean ≤ 0.012 and p95 ≤ 0.04;
  - undyed texels: `dyeAlbedo` = albedo, mean ≤ 5/255 and p95 ≤ 16/255 (WebP/JPEG loss);
  - textures of 128² or smaller get 1.25–2× those limits, because WebP loss is heavier there. A tone-mapped dye albedo still fails by far;
  - one texel in from every UV-island border is skipped, as is a class with fewer than 2% of the texels;
  - art/ sources compare against the lossless `<stem>_albedo.png`;
  - missing dye files FAIL.
- Dye masks named in the extras count toward the texture budget at the KTX2 mask rate (docs/11 §4: ETC1S albedo 0.5 B/px, UASTC masks 1 B/px). Images are classified by role, not by name.
- **Weapons:** `family` must be a §4.2 family (or `thrown`), and `aimPose` one of the clip sets (pistol, dual, rifle).

## Open questions

1. **Toon ramp or flat** (docs/12 decision #6)? The viewer has both; the screenshots use toon.
2. **Default dyes:** keep the sand Rookie, or ship a more saturated default for contrast (Phase 0 finding 2)?
3. **Aim pivot:** lower the sim's aim pivot toward the chibi's hold height (~0.8 m), or keep 1.08 m and accept tracers starting ~0.3 m under the sim line?
4. **KTX2:** OK to install KTX-Software (`brew install ktx-software` or the GitHub release) so the pipeline can write KTX2?

## Cost

| Step | Credits |
|---|---|
| Phase 0: 3 concept sheets + 1 multiview 3D model | 17.25 |
| Milestone A (Blender only) | **0** |
| Milestone B part 1: weapons (Blender only) | **0** |
| Milestone B part 2: cosmetics (Blender only) | **0** |
| Street Market kit + map (Blender only) | **0** |
| Hero cosmetics: 9 concept images + 5 multiview 3D models | **69.75** |
| Weapons Forge 2: 8 muzzle-flash sheets (7 used + 1 test), GPT Image 2.5 medium | **4.00** |
| Weapons Forge 3: 6 impact sheets + 1 decal sheet, GPT Image 2.5 medium | **3.50** |
| Weapons Forge 4: 2 explosion flipbooks, GPT Image 2.5 high 2k | **5.50** |
| Weapons Forge 8: concept sheet for 5 new weapons, GPT Image 2.5 medium 2k | **1.00** |
| Weapons Forge 8, batch 2: concept sheet for 6 new weapons, GPT Image 2.5 medium 2k | **1.00** |
| Weapons Forge 8c: flame puff flipbook, GPT Image 2.5 medium 2k | **1.00** |
| **Total so far** | **103.00** |

Phase 0 Higgsfield job IDs: concepts A `160eb90e-41ab-4ecc-a917-1e76c0563b40`, B `b40714aa-ec2f-4d2a-a522-ff5a4ebe57cc`, C `3e234313-6c57-4cd7-9946-22e6cd62b4b3`; 3D `75fc7390-163d-4c95-869c-58e8544bd654`.

## Files

```
art/
  pipeline/        build_character.py, clips.py, dye.py, build_cosmetics.py, build_weapons.py, build_vfx.py, build_casings.py, build_impacts.py, build_explosions.py, build_projectiles.py, build_specials.py, build_attachments.py, build_camos.py, build_kit.py, build_market_kit.py, compile_map.py, render_views.py, render_weapons.py, split_sheet.py
  concepts/        A/B/C sheets + A-views/ (the 3D inputs)
  character/       rookie_body[_lod1].glb, rookie_anims.glb, rookie_preview.glb, rookie_rig.json, *.check.txt|json
    parts/         default parts: headgear_brim_helmet, boots_combat, jetpack_twin_tank [_lod1].glb
    textures/      baked albedo, dye mask and dye albedo per part and LOD
    source/        rookie_tripo_raw.glb (Higgsfield output), rookie.blend
  weapons/         <id>.glb ×11, weapons.json, checks/
  cosmetics/       <slot>/<id>[_lod1].glb ×11 items, textures, cosmetics.json, checks/
  kit/             kit_yard.glb (+ check)
  kits/            street_market/kit_street_market.glb (+ check)
  maps/            street_market/layout.json → street_market.map.json (MapDef) + street_market.adslots.json
  screenshots/     viewer captures + Blender sheets
tools/
  asset-check/     check.py, selftest.py
  art-preview/     index.html, main.js, serve.py
apps/web/public/assets/   runtime exports (see above)
```
