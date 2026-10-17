# 04 — Characters, Character Select & Customisation

> One fair body, endless looks. **Cosmetics never change hitboxes, silhouettes' readable size, speed, or sound loudness.**

---

## 1. Rules that protect fairness and readability

1. **Hitboxes are fixed** (02-physics §6). Every character, skin and body type uses the same hitboxes.
2. **Silhouette envelope:** every head/hat/backpack must fit within a **cosmetic bounding envelope** (≤ 10% larger than the base body) and must not *shrink* the visual (no "tiny" skins that hide the real hitbox).
3. **Visibility floor:** skins must pass an automated contrast check against each map's palette (§8). There are no full-camo skins.
4. **Team readability:** in team modes an **outline + armband/visor glow** uses the team colour (or the player's chosen enemy-highlight colour), regardless of skin.
5. **Audio parity:** cosmetic footstep/jetpack sounds keep the same loudness and frequency band. Only the timbre changes.

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
| Body type | standard / stocky / slim | same hitbox; mesh variants share one skeleton |
| Skin tone | 12 tones + fantasy tones (robot chrome, zombie) | palette, not textures |
| Face | 10 shapes · eyes · mouth · expression set | expressions animate on emotes, kills, and when hurt |
| Hair / facial hair | 30+ | hidden or cut by headgear via "hair cut masks" |
| Headgear | helmets, caps, berets, bandanas, crowns | a headshot can pop it off (cosmetic, 02-physics §16) |
| Eyewear / mask | goggles, aviators, gas masks, visors | |
| Top / Gloves / Legs / Boots | outfits | |
| **Jetpack** | model + **exhaust colour** + **trail** | big expressive slot: it's on screen all the time |
| Backpack / accessory | radio, flag pole, plushie | within the envelope |
| Weapon skins | per weapon + "universal wraps" | wraps are material-only (cheap to make) |
| Melee skin | knife, bat, machete, frying pan | |
| Grenade skin | | |
| Emotes (6 slots) | dances, taunts, sprays, stickers | |
| Victory pose / Kill effect / Death effect / Spawn effect | | effects are VFX-budgeted (§7) |
| Nameplate / Banner / Title / Avatar frame | profile + kill feed | |
| Voice pack / Lobby music | post-launch | |

---

## 4. Rig & animation

### 4.1 Skeleton (shared by everything)
- About 24 deform bones: `root, pelvis, spine1, spine2, neck, head, clavicle_L/R, upperarm_L/R, forearm_L/R, hand_L/R, thigh_L/R, calf_L/R, foot_L/R, toe_L/R, jaw, eye_L/R`.
- Sockets (non-deform): `socket_weapon_R`, `socket_weapon_L`, `socket_offhand_IK`, `socket_jetpack`, `socket_hat`, `socket_back`, `socket_nameplate`.
- Chibi proportions: head ≈ ⅓ of the height. Model to match the hitbox layout (head circle centre at 1.24 m).

### 4.2 Animation layers

| Layer | Content | Driven by |
|---|---|---|
| Base locomotion (lower body) | idle, walk, run, crouch idle/walk, jet ascend, hover, fall, land (additive dip), slide | velocity + move state |
| Upper-body aim | **aim offset**: 5 poses (−90°, −45°, 0°, +45°, +90°) **per weapon family** (pistol, dual, rifle, shotgun, sniper, launcher, heavy, melee), blended by aim angle | aim angle |
| IK | off-hand to the weapon's `socket_offhand_IK` (two-handed weapons); head look-at the aim point | per frame |
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
2. **Lazy loading:** the client fetches each part's GLB (meshopt-compressed) + KTX2 textures from the CDN. Until loaded, it shows the **default part** and never blocks gameplay.
3. **Merge:** all parts share the skeleton, so merge them into **one `SkinnedMesh`** with one material:
   - textures packed in a **texture array** (WebGL2) or an atlas;
   - each vertex carries a `partIndex` attribute → the shader samples the right layer.
   - Result: **1 draw call per character** (+ weapon + jetpack flame).
4. **Dye system:** each part has `albedo` + `mask` (R = primary, G = secondary, B = accent, A = emissive). The shader computes `color = albedo × lerp(1, dye[channel], mask)`. Dyes are unlockable cosmetics with zero texture cost.
5. **Outline:** inverted-hull or screen-space outline pass in team colour, toggleable and colour-configurable (accessibility).
6. **LOD:** LOD0 ≤ 4k tris, LOD1 ≤ 1.8k tris (when zoomed out with a sniper scope or in BR spectate), shared clip set.
7. **Cache** assembled characters by `loadoutHash` (same skin twice = one build).

Budget per character on screen: ≤ 4k tris, 1–3 draw calls, ≤ 1.5 MB GPU texture memory (KTX2/Basis), ≤ 0.15 ms CPU for skinning/animation per frame (skin on the GPU).

---

## 6. Customisation UX ("Locker")

- 3D turntable preview with drag-rotate, zoom to face/jetpack, and lighting presets (lobby, night map, desert map).
- Slot tabs on the left, a grid of owned items (rarity frame + **shape** for colour-blind players), and locked items shown with how to get them ("Battle pass tier 34", "Store", "Achievement: 100 headshots").
- **Dye picker** per channel (owned dyes) + randomise + "copy from character".
- **3 loadout presets**, plus per-mode overrides (e.g. a BR look).
- "Try on": store items preview on your current loadout, and you can play a **sandbox** to see kill effects/emotes on a dummy.
- Changes are saved to the server (`PUT /me/loadout/{slot}`) and validated against `inventory`.

---

## 7. VFX & effect budgets for cosmetics

| Effect type | Max particles | Max duration | Rules |
|---|---|---|---|
| Jetpack trail | 60 live per player | continuous | must not hide the player or teammates. Low-quality setting = ribbon only |
| Kill effect | 120 | 1.2 s | spawns at the victim; no screen-filling effects |
| Death effect | 80 | 1.5 s | replaces default gore when chosen |
| Spawn effect | 80 | 0.8 s | |
| Emote | — | ≤ 4 s | cancellable by any movement |

Each effect is authored with a **low-quality variant** for the graphics "Low" preset.

---

## 8. Content pipeline for cosmetics

1. **Blender** → glTF (one file per part) with custom properties: `slot`, `bodyTypes`, `hidesHair`, `envelopeOk`.
2. `tools/asset-pipeline` automatically:
   - validates bone names against the skeleton;
   - checks the triangle budget and the cosmetic envelope (bounding box vs the base body);
   - converts to meshopt + KTX2;
   - generates thumbnails (headless render);
   - writes a manifest entry.
3. **Readability lint:** renders the character silhouette over each map's background palette and computes luminance contrast. It fails below a threshold.
4. Items are defined in `content/cosmetics/*.json` (`id`, `slot`, `rarity`, `assets`, `dyeable`, `source`, `releaseSeason`, `tags`).
5. Store and battle pass reference item ids, so new cosmetics ship as content-only deploys (CDN assets + content.bin) without touching the game server.
