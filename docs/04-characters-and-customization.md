# 04 — Characters, Character Select & Customisation

> One fair body, endless looks. **Cosmetics never change hitboxes, silhouettes' readable size, speed, or sound loudness.**

---

## 1. Rules that protect fairness and readability

1. **Hitboxes are fixed** (02-physics §6). Every character, skin and body type uses the same hitboxes.
2. **Silhouette envelope:** every cosmetic part must fit within a **cosmetic bounding envelope** and must not *shrink* the visual (no "tiny" skins that hide the real hitbox). **No cosmetic sticks out past the body**:
   - the envelope is the bounding box of the **base body alone** (rest pose, LOD0, no parts), grown **10%** about its centre;
   - its bottom is the floor (y = 0), or the body's lowest point if that is lower. The body stands on the floor, so footwear fills the gap below a bare body's calves;
   - it is the same box for **every slot, default parts included**. No part widens it for another: not the default jetpack, not the default helmet;
   - every LOD is measured against the LOD0 body;
   - **locality:** a part must also stay near where it is worn. That is the box of the body vertices skinned to its slot's bones, plus the slot's default part, grown 10% and kept inside the body box. The bones are head, jaw, eyes and neck for headgear and eyewear; calves, feet and toes for boots; hands for gloves; spine1 and spine2 for the jetpack. A 1 m-wide hat fits the body box but not the head's.

   `tools/asset-check --kind part` measures this (§9.7), and the part's `envelopeOk` extra records the measured result.
3. **Visibility floor:** skins must pass an automated contrast check against each map's palette (§8). There are no full-camo skins.
4. **Team readability:** in team modes an **outline + armband/visor glow** uses the team colour (or the player's chosen enemy-highlight colour), regardless of skin.
5. **Audio parity:** cosmetic footstep/jetpack sounds keep the same loudness and frequency band. Only the timbre changes.
6. **Paid looks read the same** (owner, 28 Oct 2026): everything sold, and every Forge look, passes the visual-advantage review in [17 §3.4](17-store-currency-and-forge.md#34-the-visual-advantage-review-checklist), and the dark-look check runs on the **worst-case dye** a player could pick, not just the defaults. A look that fails in the wild is fixed for everyone and its buyers may refund it (17 §2.5).

---

## 2. Characters ("Character select")

Genre classics have one soldier with customisable parts. We keep that and add **named characters**. These are *cosmetic presets with personality*: a model look, voice lines, idle/emote style and a bio. There is **no gameplay difference** in core modes.

| # | Working name | Vibe | Unlock |
|---|---|---|---|
| 1 | Rookie | the classic soldier, fully customisable | default |
| 2 | Gunny | grizzled veteran, cigar-free (age rating), big moustache | default |
| 3 | Pixel | gamer kid with VR visor & hoodie | level 5 |
| 4 | Mama Ade | street-food queen turned militia boss | level 10 |
| 5 | Raja | stunt pilot, scarf & aviators | level 15 |
| 6 | Volt | cyborg engineer, glowing jetpack | battle pass S1 |
| 7 | Nyx | stealthy ninja medic | battle pass S1 |
| 8 | Boomer | demolition expert, oversized helmet | store |

These are **original IPs**. Design them for the core audience (India, Nigeria, SE Asia, LATAM) so they reflect those players, with localised voice lines over time.

**Optional later mode: "Classes"** (a separate playlist, never in core/ranked): characters get one small perk each (e.g. +10% fuel regen, faster revive). Keep it out of the main game to preserve skill purity.

---

## 3. Cosmetic slots

| Slot | Examples | Notes |
|---|---|---|
| Body type | standard / stocky / slim (male) · female (owner, 22 Oct) | same hitbox; every body type is built on a base body (`body`: male or female), and all share one skeleton, sockets and clips |
| Skin tone | 12 tones + fantasy tones (robot chrome, zombie) | palette, not textures |
| Face | 10 shapes · eyes · mouth · expression set | expressions animate on emotes, kills, and when hurt |
| Hair / facial hair | 30+ | the `hair` slot (22 Oct): `hair_body` is the body's own hair; styles name the bodies they're made for (`fits`), and a part made for another body falls back to the slot default. Hidden or cut by headgear via "hair cut masks" (`hidesHair`) |
| Headgear | helmets, caps, berets, bandanas, crowns | a headshot can pop it off (cosmetic, 02-physics §16) |
| Eyewear / mask | goggles, aviators, gas masks, visors | |
| Top / Gloves / Legs / Boots | outfits | |
| **Jetpack** | model + **exhaust colour** + **trail** | big expressive slot: it's on screen all the time |
| Backpack / accessory | radio, flag pole, plushie | within the envelope |
| Weapon skins | per weapon + "universal wraps" | wraps are material-only (cheap to make). Paid lines on six guns only, in three tiers (Wrap, Skin, Forged), 17 §3.2–3.3; mastery skins are earned, never sold |
| **Forge look** | a player-designed gun look (parts, dyes, decals, FX) | a JSON spec in a Forge slot: 1 slot free, more bought (17 §4) |
| Melee skin | knife, bat, machete, frying pan | |
| Grenade skin | | |
| Emotes (6 slots) | dances, taunts, sprays, stickers | |
| Victory pose / Death effect / Spawn effect | | effects are VFX-budgeted (§7) |
| Kill effect | comes with a gun skin line's top tier (owner, 28 Oct 2026), plays where the victim falls on kills with that gun, seen by everyone | 17 §3.7; budgeted in §7 |
| Nameplate / Banner / Title / Avatar frame | profile + kill feed | |
| Voice pack / Lobby music | post-launch | |

---

## 4. Rig & animation

### 4.1 Skeleton (shared by everything)
- About 24 deform bones: `root, pelvis, spine1, spine2, neck, head, clavicle_L/R, upperarm_L/R, forearm_L/R, hand_L/R, thigh_L/R, calf_L/R, foot_L/R, toe_L/R, jaw, eye_L/R`.
- Sockets (non-deform): `socket_weapon_R`, `socket_weapon_L`, `socket_offhand_IK`, `socket_jetpack`, `socket_hat`, `socket_back`, `socket_nameplate`. The body also carries `sling_back` and `holster_thigh` (§9.3); cosmetic parts built before them may not, and parts merge by their deform bones.
- Chibi proportions: head ≈ ⅓ of the height. Model to match the hitbox layout (head circle centre at 1.24 m).

### 4.2 Animation layers

| Layer | Content | Driven by |
|---|---|---|
| Base locomotion (lower body) | idle, walk, run, crouch idle/walk, jet ascend, hover, fall, land (additive dip), slide | velocity + move state |
| Upper-body aim | **aim offset**: 5 poses (−90°, −45°, 0°, +45°, +90°) **per weapon family** (pistol, dual, rifle, shotgun, sniper, launcher, heavy, melee), blended by aim angle | aim angle |
| IK | left hand to the weapon's `offhand` node, or to the rig's `socket_offhand_IK` if the weapon has none (two-handed weapons); head look-at the aim point | per frame |
| Actions (override upper body) | fire recoil (additive), reload per family, swap, throw, melee ×2, heal, revive, interact | events |
| Full-body | emotes, victory poses, knocked crawl, hit reactions (additive), spawn-in | events / state |
| Ragdoll | client Verlet ragdoll on death (02-physics §16) | death event |

**Facing:** when the aim crosses vertical, the character **turns** (Y rotation 0 → 180° over 120 ms), not a mirror flip, so asymmetric skins stay correct. The camera's 3/4 view keeps both sides readable.

**Remote players** are animated from interpolated velocity + state flags + aim (05-netcode §10). The server never runs skeletal animation.

### 4.3 Clip budget (MVP)
~45 clips: locomotion 10, aim offsets 8 families × 5 poses, reloads 6, actions 8, emotes 6, victory 2, knocked 3. Each is retargeted to the shared skeleton. Source: an animator (best), or Mixamo/purchased packs retargeted as placeholders.

---

## 5. Runtime character assembly (performance)

1. The player's loadout is a compact list of item ids (in the join ticket and spawn records).
   - As built (protocol v19, 23 Oct): a look travels as its cosmetic wire ids (`cosmeticLoadoutWireIds`, 15 u16 today) in the join ticket (`look`, with the player's level `lvl`), the HELLO, the SetLook CMD and every ROSTER entry, never per snapshot. The game server holds each look to the body's fit and to what the player has unlocked (content `admitLook`, `cosmeticUnlocked`); a slot that fails falls back to its default. Bots wear seeded looks (content `botLook`: both bodies, earnable items, curated colourways). The client keeps everyone's look in `apps/web/src/looks/book.ts`; the 3D view draws each soldier in it (render3d `LoadoutDirectory.setLooks`). docs/05 §6 has the bits.
2. **Lazy loading:** the client fetches each part's GLB (meshopt-compressed) + KTX2 textures from the CDN. Until loaded, it shows the **default part** and never blocks gameplay.
3. **Merge:** all parts share the skeleton, so merge them into **one `SkinnedMesh`** with one material:
   - textures packed in a **texture array** (WebGL2) or an atlas;
   - each vertex carries a `partIndex` attribute → the shader samples the right layer.
   - Result: **1 draw call per character** (+ weapon + jetpack flame).
   - As built (`apps/web/src/character`): W8's body (512²) and parts (256²) differ in size, so instead of an array texture each art slot has its own sampler pair (albedo + mask, 6 layers incl. the body) and the per-vertex `texLayer` picks one. Every soldier shares one shader program and one draw call; part textures are loaded once and shared by everyone wearing the part.
4. **Dye system:** each part has `albedo` + `mask` (R = primary, G = secondary, B = accent, A = emissive). The shader computes `color = albedo × lerp(1, dye[channel], mask)`. Dyes are unlockable cosmetics with zero texture cost.
   - The **default dyes are per part** (each part's `dyeDefaults`), because every part is painted differently.
   - The **player's dye is one colour per channel**, shared by every part: picking a primary colour replaces each part's default primary.
   - The shipped `albedo` (the dye albedo) is neutral grey in the mask core and the exact inverse of the shader on soft mask edges, so the default dyes give back the painted look everywhere.
5. **Outline:** inverted-hull or screen-space outline pass in team colour, toggleable and colour-configurable (accessibility).
   - As built (`apps/web/src/character/outline.ts`): an inverted hull, the soldier's own skinned mesh drawn again from the back and pushed out a fixed 2 CSS px in screen space, so it reads the same at 1× gameplay zoom (~80 px soldiers) and in the Locker. It costs one extra draw call per soldier and follows part swaps and LOD changes. Today it's warm near-black; team colours are a uniform away.
6. **LOD:** LOD0 ≤ 4k tris, LOD1 ≤ 1.8k tris (when zoomed out with a sniper scope or in BR spectate), shared clip set.
7. **Cache** assembled characters by `loadoutHash` (same skin twice = one build).

Budget per character on screen: ≤ 4k tris, 1–3 draw calls, ≤ 1.5 MB GPU texture memory (KTX2/Basis), ≤ 0.15 ms CPU for skinning/animation per frame (skin on the GPU).

---

## 6. Customisation UX ("Locker")

- 3D turntable preview with drag-rotate, zoom to face/jetpack, and lighting presets (lobby, night map, desert map).
- Slot tabs on the left, a grid of owned items (rarity frame + **shape** for colour-blind players), and locked items shown with how to get them ("Battle pass tier 34", "Store", "Achievement: 100 headshots").
- **Dye picker** per channel (owned dyes) + randomise + "copy from character".
- **3 loadout presets**, plus per-mode overrides (e.g. a BR look). A Forge look (17 §4.6) is equipped on its gun in any preset without using another Forge slot.
- "Try on": store items preview on your current loadout, and you can play a **sandbox** to see kill effects/emotes on a dummy.
- Changes are saved to the server (`PUT /me/loadout/{slot}`) and validated against `inventory`.

### 6.1 The character creator (owner, 22 Oct: "the 3D setup")
- **Where:** `#/creator` (`apps/web/src/creator`).
  - First-time players get it once, after the name screen ("Skip for now" counts).
  - The Locker's **Create your soldier** opens it again.
- **Step 1, the body:**
  - Male soldier or female soldier;
  - then the body's builds (body types with that `body`) and the skin tone.
- **Step 2, the look:** tabs of what fits the body, read from content at run time.
  - **Which slots show:** a slot shows when at least two of its items fit.
  - **The tabs:** Hair (the female body's hairstyles), Headwear, Outfit, Gear and Colourways.
  - New slots and items appear as content adds them.
- **The turntable:** large and live. Drag to turn, scroll or pinch to zoom, with view and light presets.
- **Actions:**
  - Randomise keeps the body.
  - Save writes the look to the account.
  - Locked items try on and say how to get them.
- **Assembly:** each base body has its own rig, `BODY_MANIFESTS` in `character/assembler.ts`.
  - A loadout on another body swaps the instance's bind pose in place: the same bones, mesh and mixer.
  - A body whose art isn't in yet is drawn on the male rig, and the creator says so ("Stand-in body").

---

## 7. VFX & effect budgets for cosmetics

| Effect type | Max particles | Max duration | Rules |
|---|---|---|---|
| Jetpack trail | 60 live per player | continuous | must not hide the player or teammates. Low-quality setting = ribbon only |
| Kill effect | 80 (+1 draw call) | 1.0 s | plays at the victim on kills with the skinned gun only, inside the body envelope (§1.2), under dropped items, players and tracers; no flash, shake or light past the envelope; a still variant under Reduce flashes/motion (17 §3.7) |
| Death effect | 80 | 1.5 s | replaces default gore when chosen |
| Spawn effect | 80 | 0.8 s | |
| Emote | — | ≤ 4 s | cancellable by any movement |

Each effect is authored with a **low-quality variant** for the graphics "Low" preset.

---

## 8. Content pipeline for cosmetics

1. **Blender** → glTF (one file per part) with custom properties (§9.5). The W8 source builds live in `art/pipeline/` (Blender scripts, art/README.md).
2. `tools/asset-check` (Blender, headless) validates every source and runtime GLB:
   - bone names against the skeleton;
   - the triangle budget per slot;
   - the cosmetic envelope (§1.2);
   - the dye textures (§5.4).
3. `tools/asset-pipeline` (W1's export stage, docs/11 §4):
   - converts to meshopt + KTX2;
   - generates thumbnails (headless render);
   - writes a manifest entry.
4. **Readability lint:** renders the character silhouette over each map's background palette and computes luminance contrast. It fails below a threshold.
5. Items are defined in `content/cosmetics/*.json` (`id`, `slot`, `rarity`, `assets`, `dyeable`, `source`, `releaseSeason`, `tags`).
6. Store and battle pass reference item ids, so new cosmetics ship as content-only deploys (CDN assets + content.bin) without touching the game server.
7. **Weapon skins** are items with `slot: "weapon_skin"`, the base `weaponId` and a `tier`; their GLB keeps the base gun's `muzzle`, `offhand` and `eject` nodes within 1 cm (17 §3.3).
   - **Forged (blueprint) skins reshape parts** (receiver, stock, handguard, muzzle device, magazine, grip, charm), authored per slot and merged into one GLB. `tools/asset-check --kind weapon --blueprint-of <base.glb>` adds the 17 §3.6 checks: length and height ±3%, side-silhouette IoU ≥ 0.85 at gameplay zoom, `mag` within 2 cm, moving parts unchanged, no part over the head at any aim pose, glow only on allowed areas.
   - **Kill effects** live in `content/cosmetics/kill-effects.json` (id, flipbook atlas, dissolve params, still variant, sound) and are checked against the §7 row; a skin's top tier names one (`killEffect`).
8. **Forge looks are not content items:** they're player data (a `ForgeLook` JSON per slot), validated by the API and an isolated render worker, and reviewed when they carry uploads or a new name (17 §4.3–4.4). The Forge part library is content, built and checked like any part.

---

## 9. Asset conventions (from the Phase 0 art test)

These are the rules every character, cosmetic, weapon and kit asset follows. `tools/asset-check` enforces the checkable ones; `art/README.md` has the worked example (the Rookie).

### 9.1 Units, axes and scale
- Metres. glTF axes: **+Y up, the character faces +Z**, feet on y = 0, centred on x = z = 0 under the pelvis.
- Standing height 1.50 m to the top of the headgear. The head's centre sits on the head hitbox centre (1.24 m, docs/02 §6).
- In game the character faces ±X: the renderer turns it about Y (§4.2), never mirrors it.

### 9.2 Bone axes
- Every bone's local **+Y runs along the bone**, toward its child.
- Local **+Z points forward** (the facing direction) for bones that run up, down or sideways. For bones that already point forward (`foot`, `toe`, `eye_L/R`, the weapon sockets), +Z points **up**.
- So clips can share one sign convention: **+X rotation flexes any vertical bone forward** (spine bends forward, a thigh swings forward). Calves bend back with −X. Raising an arm sideways is +Z on `upperarm_L` and −Z on `upperarm_R`.
- Skinning: at most **4 influences per vertex** (three.js reads `JOINTS_0`/`WEIGHTS_0` only), weights normalised. Sockets carry no weights.

### 9.3 Sockets
Rest positions are for the Rookie (glTF metres, character at the origin facing +Z). Other bodies may differ; code must read the socket nodes, not these numbers.

| Socket | Parent | Rest position | Local axes | Use |
|---|---|---|---|---|
| `socket_weapon_R` | `hand_R` | (−0.40, 0.54, −0.02) | **+Y muzzle**, +Z up, +X the gun's right | main weapon grip: a weapon GLB attaches with an **identity** transform |
| `socket_weapon_L` | `hand_L` | (0.40, 0.54, −0.02) | same | second pistol (dual wield) |
| `socket_offhand_IK` | `socket_weapon_R` | 0.07 m along +Y, 0.02 m along +Z | same | default left-hand IK target, within the off-hand reach (§9.4); a weapon's own `offhand` node overrides it |
| `socket_jetpack` | `spine2` | (0, 0.73, −0.17), on the back surface | +Y up, +Z forward, +X the character's left | jetpack flame and VFX anchor; not a parent for the jetpack part (see below) |
| `socket_back` | `spine2` | (0, 0.86, −0.40), behind the top of the jetpack | same | rigid props that aren't cosmetic parts (radio, flag pole, plushie) |
| `socket_hat` | `head` | (0, 1.42, −0.01), 8 cm below the top of the helmet | same | hat-mounted VFX anchor (e.g. a lamp); not a parent for headgear parts |
| `socket_nameplate` | `root` | (0, 1.75, 0) | same | UI anchor; parented to `root` so it doesn't bob with the head |
| `sling_back` | `spine2` | (0, 0.80, −0.42), between the jetpack's back face (−0.35) and the slung riot shield | **+Y muzzle** up over the left shoulder (0.57, 0.82, 0), +X the gun's right side against the back (0, 0, 1), +Z the gun's top towards the right shoulder (−0.82, 0.57, 0) | a slung long gun (rifles, shotguns, snipers, launchers, heavies) mounts here with an **identity** transform, like `socket_weapon_R` |
| `holster_thigh` | `thigh_R` | (−0.31, 0.42, −0.02), on the outer right thigh | **+Y muzzle** down, +Z the gun's top (slide) forward, +X the gun's right side out | a holstered pistol or SMG, or the machete; identity transform |

**Cosmetic parts are skinned, not parented to sockets.** Every part GLB is authored in **character space** (the same origin as the body) and **carries the shared skeleton**, so the renderer can merge it into the body's single `SkinnedMesh` (§5.3):
- rigid parts (headgear, eyewear, jetpack) are weighted **100% to one bone**, named in the `attachBone` extra (`head`, `head`, `spine2`);
- boots blend from `foot_*` into `calf_*`; gloves are rigid to `hand_*`;
- the `socket` extra names the socket the part sits next to, for VFX and tooling only. Adding a part under that socket would apply the offset twice.

`tools/asset-check --kind part` fails a part with no skin. Weapons are the only GLBs attached at a socket.

### 9.4 Weapons
- Origin at the **main grip**, oriented like `socket_weapon_R`: **+Y toward the muzzle, +Z up**. Attaching is `socket.add(weapon)` with no extra rotation.
- Named child nodes:
  - `muzzle`: flash and tracer origin, required for every firearm family;
  - `offhand`: left-hand IK target, on two-handed weapons. It must be **within 0.10 m of the grip** (the weapon check enforces this). The rifle aim poses are solved so the left hand reaches it, and `socket_offhand_IK`, in every pose (the character build asserts this);
  - `eject`: casing spawn;
  - optional: `mag` (reload), `tip` (melee hit point, e.g. the machete), `light` (blinking LED, e.g. the mine);
  - the special weapons' effect anchors (`specials.vfx.json`): `pilot` (the Dragon's pilot flame) and `charge` (where the Ripper's blade and the Pulse's orb build up);
  - `ground` on throwables and deployables (frag, mine): the frame of the item **at rest in the world**. Its local +Y (glTF) is world up and its origin is the point that touches the floor. To place it, set `world = floorPoint × inverse(ground.local)`. The GLB itself stays in the hand frame.
- Moving parts: child mesh nodes `part_slide`, `part_pump`, `part_bolt`, `part_cylinder` and `part_mag`, each with its pivot at the node and its motion in extras (§9.5). The renderer animates one only when it carries `cutClean: true` (its cut is capped and its shell closed); any other is baked into the gun, standing still.
- **The riot shield** (family `shield`) is modelled in **shield space**, not the weapon frame: origin on the arm strap, +Y up the long edge, +Z out of the strike face (`frame: "shield"`). Its nodes are `grip` (the left hand's hold, 0.09 m above the strap, where the Rookie's fist closes), `face` (the strike face's centre, `halfSize` [w/2, h/2]) and `ground`.
- Budget: **≤ 1,000 tris**, one mesh, one material (moving parts share it), ≤ 256² texture per weapon. Weapons have no LOD1, except the riot shield: it is big on screen and on the back, so `riot_shield_lod1.glb` carries the same nodes and extras at about a quarter of the triangles.
- Node names are exact: the renderer looks them up by name, so a Blender clash suffix (`grip.001`, which three.js reads as `grip001`) fails the weapon check.

### 9.5 Node extras
Blender custom properties export as glTF `extras` (`export_extras`):
- **Characters and cosmetic parts:**
  - `slot` and `bodyTypes`;
  - `envelopeOk`: the measured result of §1.2;
  - `hidesHair`;
  - `dyeDefaults` {primary, secondary, accent}: §5.4 default dye colours (sRGB hex);
  - `dyeMask`: the mask texture file name (RGBA = primary/secondary/accent/glow, linear data, same UVs);
  - `dyeAlbedo`: the stem of the albedo with the dyeable texels turned neutral grey (§5.4). `dyeAlbedo × lerp(1, dyeDefaults, mask)` gives back the painted albedo;
  - `attachBone` and `socket` (§9.3), on rigid parts;
  - the Locker manifest also carries `name` and `cosmeticId`.
- **Weapons:**
  - `weaponId`, matching `packages/content`;
  - `family`: the §4.2 weapon family (pistol, dual, rifle, shotgun, sniper, launcher, heavy, melee, plus `thrown` for grenades and deployables and `shield` for the riot shield);
  - `aimPose`: the aim-pose set the clips provide for it today (`pistol` or `rifle`; dual wield uses `dual`). Families without their own poses map to the nearest set until those clips exist. The character manifest's `aimPoseFallback` holds the same mapping per family;
  - `hands` (1 or 2), `name` and `archetype` (the docs/03 role);
  - `casings`: false on weapons that throw no casing per shot (fuel, cells, orbs, blades, drum rounds); they have no `eject` node;
  - `attach`: the rig socket it mounts on when not `socket_weapon_R` (the riot shield: `socket_shield`), and `slungAttach` where it hangs when carried (`socket_shield_back`);
  - `frame`: `shield` for shield space (above); absent means the weapon frame;
  - `source`: `scan` on weapons rebuilt from generated models (`build_gun_scan.py`), which the head-clearance check gates;
  - on moving parts: `axis` (unit, weapon frame), `travel` (m: slide, pump, bolt, mag) or `angle` (degrees a shot: cylinder), `lift` (degrees a bolt handle turns up first, default 60) and `cutClean`.
- **Kit pieces:** `kitPiece` and `layer` (gameplay, mid or far, docs/11 §2). Gameplay pieces also carry collision in piece-local metres, which the map compiler turns into a MapDef:
  - `terrain` [[x0, x1, h]];
  - `solids` [[x, y, …]];
  - `oneWays` [[ax, ay, bx, by]], with `blocksBullets: true` on a piece whose one-ways are floor slabs (balconies, decks, catwalks: they stop bullets, docs/11 §2); the compiler writes it onto those one-ways;
  - `material` (the sim material id).

### 9.6 Map kit pieces
- Pivot on the **walkable top surface** (ground blocks, platforms) or on the **bottom** (props).
- Width and height on a **0.25 m grid**; where a piece carries collision extras, it is the collision that must snap (to 0.05 m). Gameplay-plane pieces are 2 m deep (z −1…+1, docs/11 §2).
- Baked AO and colour in vertex colours or a shared atlas: **one material per kit**, so pieces instance cleanly.

### 9.7 Validation
```bash
blender -b --factory-startup --python-exit-code 1 --python tools/asset-check/check.py -- <a.glb[,b.glb...]> \
    [--kind character|part|weapon|kit] [--lod 1] [--base body.glb[,default_part.glb...]]
blender -b --factory-startup --python-exit-code 1 --python tools/asset-check/selftest.py
```
- Several comma-separated files are checked **as one assembled character**, because the §5 budgets apply per character on screen.
- `--base` gives the base body for the part envelope (§1.2). Only meshes whose `slot` is `body` (or that have no slot) count: default parts listed there are ignored. Pass the LOD0 body for every LOD.
- It reads the hitboxes from `packages/content/src/hitboxes.ts` and the weapon ids from `packages/content/src/{weapons,grenades}.ts`.
- It prints PASS/WARN/FAIL lines and **exits 1 on any FAIL** (2 if the check itself crashed), so CI can gate on it.
- Keep `--python-exit-code 1`: without it Blender exits 0 even when the script raises.
