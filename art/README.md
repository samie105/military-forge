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
| Locomotion (loops) | idle 2 s, walk 1 s, run 0.6 s, crouch_idle 2 s, crouch_walk 1 s, slide 0.4 s (held), jet_ascend 0.8 s, jet_hover 1.2 s, fall 0.67 s | the bones each clip keys |
| One-shot | land 0.3 s (dip; play over locomotion) | legs, pelvis, spine1, head |
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

## Milestone B (part 1): the arsenal

![Weapons](screenshots/weapons-sheet.png)
![In hand](screenshots/weapons-in-hand.png)
*Every weapon in the Rookie's hand through the aim layer (machete mid-swing, frag at the throw wind-up).*

`art/pipeline/build_weapons.py` builds 11 original weapons (docs/03 §5 names) as chunky toy guns. They use vertex colours on one material, no textures, and an **orange toy muzzle tip** that reads at gameplay size:

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

- **Frame (docs/04 §9.4):** origin at the grip, +Y toward the muzzle, +Z up, so a weapon attaches to `socket_weapon_R` with an identity transform. Child nodes: `muzzle`, `offhand` (two-handed, ≤ 0.10 m from the grip), `eject`, `mag`; `tip` on the machete; `light` on the mine; `ground` on the frag and mine. `ground` is their frame at rest in the world (local +Y up, origin on the floor): place one with `world = floorPoint × inverse(ground.local)`.
- **Ships to** `apps/web/public/assets/weapons/<id>.glb` (meshopt), with `weapons.json` listing name, family, aimPose, hands, tris, length and node positions.
- **Checks:** `tools/asset-check/check.py --kind weapon` verifies the triangle budget (1,000), one material, the extras, the muzzle direction for every firearm family, the offhand reach and the `ground` node on throwables. All 11 pass ([checks](weapons/checks/)). It also WARNs when a `weaponId` isn't in `packages/content` yet. 8 of the 11 aren't (only `hammer44`, `buzz` and `frag` exist on main), and the ids need W5's confirmation.
- **Dual wield** in the viewer is the classic Hammer + Buzz pair on `socket_weapon_R` / `socket_weapon_L`.

Known gaps:
- The Thumper and Shredder use the rifle hold (`aimPose: rifle`). A shoulder-launcher pose and a hip-held heavy pose would read better; tell W1 if wanted.
- Still to build from docs/03: Rattler, Hornet, Trident, Bullpup, Longbow, Dragon, Arc, Popper, Ripper, Pulse, Riot Shield. Each is ~20 lines in `build_weapons.py`.

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
| **Total so far** | **87.00** |

Phase 0 Higgsfield job IDs: concepts A `160eb90e-41ab-4ecc-a917-1e76c0563b40`, B `b40714aa-ec2f-4d2a-a522-ff5a4ebe57cc`, C `3e234313-6c57-4cd7-9946-22e6cd62b4b3`; 3D `75fc7390-163d-4c95-869c-58e8544bd654`.

## Files

```
art/
  pipeline/        build_character.py, clips.py, dye.py, build_cosmetics.py, build_weapons.py, build_kit.py, build_market_kit.py, compile_map.py, render_views.py, render_weapons.py, split_sheet.py
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
