# 14 — In-World Advertising (Billboards)

> Sell billboard space **inside the city maps** to businesses, the way Lagos Life does, without breaking pillar 3 (Fair), pillar 5 (Readable chaos) or the child-safety defaults (10 §7).
> Researched 17 Oct 2026: Lagos Life press coverage and ad page, the IAB/MRC in-game measurement guidelines, ad-vendor docs, ARCON/ASCI/NDPA/DPDP/COPPA/DSA, Lagos and India price benchmarks, plus our own camera-exposure model (§6.1). Revised the same day after a multi-reviewer pass (pricing, privacy, readability, rendering budgets, ad ops). Numbers marked *model* or *assumption* are estimates; replace them with measured delivery once the pilot runs. FX: ₦1,332 = $1 (NFEM, 13 Oct 2026); ₹96.5 = $1 (undated converter, unverified; replace with the RBI reference rate and its date). Lagos Life audience figures are self-reported.
> **CCU in this doc** means the 24 h **average** of concurrent players on the **web build** (portal builds show no ads, rule 10), unless a number is labelled *peak*. Peaks typically run 1.5–2× the average.

---

## 1. Concept, goals and hard rules

### 1.1 The idea

The owner's brief: *"running ads like how Lagos Life did it in billboards and selling a frame for like 500 per screen"*. The currency and period of "500" aren't stated, so §6.2 models every reading.

What Lagos Life (Vatar Inc.; browser life-sim launched 1 Oct 2026) proved:
- Nigerian businesses **buy in-game billboards directly**. Brands asked to advertise about 2 days after launch, and billboards became its **most profitable revenue line** (currency top-ups were the least).
- Rotating digital boards work: each ad shows for 15 s in turn. Prices rose from **₦5k/week** (one of 38 road billboards, 1 Oct) to **₦50k** (~5 Oct) and **₦250k/week for a 15-s slot on 20 digital boards** (9 Oct), so the product changed along with the price. Airport boards are ₦500k per 7 days (the page doesn't say per board or per set); lagoon plots are ₦18k.
- Buyers included Salary Index (the biggest sponsor), Leadway Lifestyle Fair (an event), MyDecorTrade, ONErpm, Elev8 Media (a real Lagos outdoor firm) and small businesses. Musicians paid ~₦50k for song plays in the in-game clubs, and Chowdeck partnered as an app on the in-game phone (terms not public).

What it didn't prove:
- **Demand at our scale.** Lagos Life sold directly because it had 100k+ concurrent players (self-reported) and national press coverage. Smaller Lagos-themed games (Aboki Run, Gidi Run, Kuluya) earned little from ads, and Maliyo pivoted to brand-commissioned work (technext24). We found no Indian or African game that sold self-serve in-world frames to small businesses at small scale. The pilot (§8.1) measures willingness to pay before we build for it.

What went wrong, and what we design against:
- **No pre-publication review.** Ads go live as soon as payment clears (ad page). Posters for an illegal sex-work site ran within 6 days, in a game whose 18+ terms aren't age-verified. They were pulled less than 24 h after an FIJ exposé.
- **Overcrowded boards.** The 43-ad Ikeja Road board was its most crowded (MarketingEdge), at ≈ 2.3% of the airtime per ad.
- **No delivery measurement or guarantee.** Advertisers got player counts and tap counts (one self-reported campaign: 3,686 taps from 9,826 app opens), not impressions or viewability, and the terms promise no minimum views.

### 1.2 Goals

| # | Goal | Measure |
|---|---|---|
| G1 | Ads help pay for the servers once there is scale | **The pilot is for validation:** ≥ 5 paying advertisers, ≥ 50% renewal, zero harmful ads. Ad revenue ≥ the hosting bill (09 §7) **net of sales cost** from launch + 3 months at ≥ 1k CCU; ≥ 3× gross at 10k CCU (§8.2) |
| G2 | Local businesses can buy without an agency | ≤ 15 min to book for an advertiser with an approved creative; first booking ≤ 10 business days end to end (review + ARCON, §5.2); naira prices, local payment methods |
| G3 | Honest delivery | viewable impressions and viewable seconds measured following IAB/MRC IIG 2.0 (**self-reported, not MRC-accredited**), a delivery guarantee, make-goods |
| G4 | Players don't pay for it | no change in readability, fps or retention vs a hold-out cohort (§8.2); ad bytes per match on the player-impact dashboard; no ad downloads on Save-Data or slow connections (§4.5) |
| G5 | Safe for minors, legal in Nigeria and India | 100% human review before exposure, programmatic included (§6.6); contextual only; ARCON/ASCI checks |

### 1.3 Hard rules (non-negotiable; enforced by editor lint and review)

1. **Never on the gameplay plane or in front of it.** Ad surfaces live only in the mid-depth band, `z = −9 … −4` (11 §2). Nothing collidable, interactive, gameplay-kinematic or in the foreground layer carries an ad. Ads cannot occlude anything players fight on, by construction.
2. **Never a gameplay signal.** No ads on pickups, crates, supply drops (body, canopy, flare, marker), weapons, characters, HUD markers, objectives, hazard telegraphs, jump pads, the Mumbai Local gameplay train, **the BR deploy plane and its path, or anything that delivers or telegraphs a supply drop**.
3. **Size and count limits.** Each surface covers **2.5–8% of the screen** at 1× zoom. There are **≤ 2 ad surfaces** in any 1× view (≤ 4 at the map's highest zoom), and the mean ad area across sampled views is ≤ 5% of the screen (≤ 8% at the highest zoom). IAB 2024 suggests 2 to 4–5 placements on screen and a cap of 3–5 impressions per user per day; we cap placements at 2 for readability. We **don't** run a per-user daily cap, because it would need a cross-session identifier (rule 6). Frequency is bounded instead by the 6-frame rotation and by counting one viewable impression per creative per session; IAB lets takeovers and sponsorships exceed its cap anyway.
4. **Readability grade.** Every creative is graded into the map's own mid-depth palette (§3.4), and an automated gate checks every skin, dye extreme, team outline and enemy-highlight colour against the graded creative (§3.5) before a human sees it. Players stay the highest-contrast thing on screen (01 §7, 11 §4).
5. **No sound, no flashing, no video at launch.** Creative content is static. Rotation changes on one shared 10 s beat with a 0.5 s crossfade (§4.4). A surface may move slowly in the far background (the Wrap, the sky airship) under lint limits (§2.6). Motion creatives come later, under the photosensitivity rule (≤ 3 flashes/s, 11 §5).
6. **Contextual only.** The only targeting keys are geo (country from IP), map, mode and week. No accounts, ages, interests, device IDs or cross-session identifiers. Assume minors play (10 §7). The house-art hold-out cohort (§8.1) is assigned by a salted hash of the account id for measurement only: it never selects creatives, and the privacy policy discloses it.
7. **Clearly in-world and clearly paid.** Paid frames carry an **"AD" chip** on the screen bezel; house art doesn't. No creative may imitate game UI, items, effects or players (§3.2).
8. **Never clickable in a match.** The mouse is for aiming and firing. No click-outs, URLs, QR codes or phone numbers (§3.2).
9. **A human reviews every creative before anyone sees it.** Every creative, every advertiser, every time, programmatic included (§6.6 condition 7). Paying never buys exposure on its own.
10. **Off in portal builds.** CrazyGames, Poki and Playgama allow only their own SDK ads. `portal` builds show house art and make no ad requests (11 §8).
11. **No paid influence on gameplay.** No branded weapons, stats, spawns, map geometry, loot or audio. Sponsorship changes paint, never collision or rules.
12. **Nobody pays to change what billboards show.** No purchase, subscription, pass or supporter status changes billboards. If an opt-out ever ships, it is a free accessibility setting for every player, and those sessions aren't counted.

### 1.4 Non-goals

Interstitial or video ads during play (rewarded ads stay opt-in, 01 §10) · personalised targeting · audio ads or in-world radio · branded weapons, characters or cosmetics (a separate review if ever) · ads on menus, the store, loading screens, results screens or the HUD (the only possible exception, after the pilot: a text-only "Drop Zone presented by {trading name}" line inside a Drop Sponsor, §2.1) · ads on non-city maps.

---

## 2. Inventory

### 2.1 Surface types

| Type | Size | Format | Frames | Sold as | Viewable up to |
|---|---|---|---|---|---|
| **Screen** (rotating LED) | 8 × 6 m at z −6 | 4:3 | 6 × 10 s loop (60 s) | Frame (1/6 of airtime), Screen Owner (6/6), Map Pack; on the Strip only as **Strip Packs** (§2.4) | 5× zoom |
| **Hoarding** (static: flyover, footbridge, rooftop) | 18 × 3 m at z −6 | 6:1 | 1 | single owner per flight | 6× zoom |
| **Wrap** (moving: Mumbai background train) | 18 × 3 m at z −6; scaled to 20 × 3.3 m at z −9 (MU-W1) | 6:1 | 1 | single owner | 6× zoom |
| **Warm-up yard Screens** (BR lobby, 08 §4) | 8 × 6 m | 4:3 | 1 | **Drop Sponsor** | 5× zoom |
| **Sky airship** (optional, Phase 5+) | 21 × 3.5 m panel at z −8 | 6:1 | 1 | inside Drop Sponsor; no forecast credit until measured | 7× zoom |
| **House-only** surfaces | any | any | — | never sold | not measured |

- **The BR deploy plane is never branded** (rule 2). Players ride it, read its path to choose a landing and jump from it (08 §4), so it is a gameplay object and a gameplay signal. The airship is a separate background blimp with a clearly different silhouette: slow (≤ 3 m/s), at z −8, only in the y ≈ 105–118 band, never in the plane's altitude band (y ≈ 120–140) and never involved in supply drops (lint #8).
- **No loading card at launch.** A sponsored loading screen would break the "0 B before first spawn" load rule (§4.5) and the ≤ 20 s click-to-falling promise (08 §1), and players hated ads and endless loading in genre classics (01 §1). If sponsors insist after the pilot, the only allowed form is a text-only line, "Drop Zone presented by {trading name}", drawn from the manifest string with no image and no extra bytes, shown only if the manifest has already arrived, never extending loading, and labelled "Sponsored" (the single named exception in §1.4).

House-only surfaces are danfo side panels, stall posters, shop signs, awnings and anything on or near the play plane. They're dressed with **fictional local businesses** ("Mama Put", "Iya Basira's Buka", a Dadar chai stall), community notices and safety tips. They never carry our own store promos either: "buy the pass now" aimed at kids is a direct exhortation (§7.3).

Share of the screen by zoom level (03 §10; FOV 35°, 16:9):

| Zoom | 1× | 2× | 3× | 4× | 5× | 6× | 7× |
|---|---|---|---|---|---|---|---|
| Screen 8 × 6 m (z −6) | 4.7% | 3.4% | 2.6% | 2.1% | 1.7% | 1.4% ✗ | 1.1% ✗ |
| Hoarding 18 × 3 m (z −6) | 5.3% | 3.9% | 2.9% | 2.3% | 1.9% | 1.55% | 1.2% ✗ |
| Wrap MU-W1 20 × 3.3 m (z −9) | 5.5% | 4.1% | 3.2% | 2.6% | 2.1% | 1.7% | 1.4% ✗ |
| Airship / LM-H1 panel 21 × 3.5 m (z −8) | 6.5% | 4.8% | 3.7% | 2.9% | 2.4% | 2.0% | 1.6% |

✗ = under the IAB 1.5% minimum, so not viewable. These impressions are measured and lost, not chased: sniper zoom is a minority of play time, and smaller surfaces read better. At 1080p and 1× a Screen draws ≈ 360 × 270 px and a Hoarding ≈ 810 × 135 px.

For other sizes and depths: `share = A / [(36·m)(20.25·m) · ((32.1·m + |z|) / (32.1·m))²]`, where `m` is the **view-width multiplier** from 03 §10 (1.00 at 1×, 1.20, 1.40, 1.60, 1.80, 2.00, 2.30 at 7×), **not** the zoom level, and 32.1 m is the camera distance at 1×. Deeper surfaces must be bigger: staying ≥ 1.5% at 5× needs 41 m² at z −4, 43 m² at −6 and 47 m² at −9.

### 2.2 Which maps carry ads

City maps only, where billboards belong in the fiction:

| Map | Ads | Ship |
|---|---|---|
| Lagos Market | yes (the home map for Nigerian advertisers) | Launch (pilot map) |
| Drop Zone Strip | yes (surface POIs, metro, warm-up yard) | Launch (pilot map) |
| Mumbai Local | yes | Launch (after the pilot) |
| Highrise | yes (rooftop LED towers) | Post |
| Outpost, Catacombs, Snowblind, Lunar, Pyramid, Bottleneck, Crossfire, Training | no | — |

Custom rooms on ad maps show ads (counted only with ≥ 2 humans, §4.8). **Ranked shows house art to every player** until the automated readability gate (§3.5) is live. Without it, opponents in one ranked fight can see different backgrounds (one geo's creative, another geo's, the hold-out's house art), which is fair only if every creative reads like house art. After that, Ranked shows ads like other modes: in-world ads don't interrupt play, and the rewarded-ad rules in 01 §10 are a separate system.

### 2.3 Placements

**Premium is priced on calm dwell** (high vantage points, metro platforms, the warm-up yard), never on fight density. The most attention-grabbing content must not sit behind the most combat (pillar 5), and lint #7 enforces that.

**Lagos Market** (120 × 60 m; dense rooftops, danfo park, stalls):

| Slot | Type | Where | Depth |
|---|---|---|---|
| LM-S1 | Screen | "junction" screen on a 5-storey building behind the west stalls, facing the high west rooftops (a calm vantage). Premium (+25%) only if it passes lint #7 | z −6 |
| LM-S2 | Screen | tower behind the central rooftops | z −7 |
| LM-S3 | Screen | above the danfo park; moves if lint #7 finds it behind the street-level combat hotspot | z −5 |
| LM-S4 | Screen | east rooftop gantry | z −6 |
| LM-H1 | Hoarding | flyover across the upper background (scaled to 21 × 3.5 m for its depth) | z −8 |
| LM-H2 | Hoarding | rooftop sign spanning two east buildings | z −6 |
| house | — | danfos, stall posters, awnings (breakable one-way platforms), shop signs | play plane / near |

**Mumbai Local** (train yard; the gameplay train passes every 45 s):

| Slot | Type | Where | Depth |
|---|---|---|---|
| MU-S1 | Screen | station facade behind platform 1 | z −6 |
| MU-S2 | Screen | signal gantry, west | z −6 |
| MU-S3 | Screen | yard-office rooftop, east | z −5 |
| MU-H1 | Hoarding | foot-over-bridge across the background (21 × 3.5 m) | z −8 |
| MU-H2 | Hoarding | platform-roof hoarding | z −5 |
| MU-W1 | Wrap | a local train on a far track (20 × 3.3 m panel) every 90 s, never within 15 s of the gameplay train. Different livery, no horn, no lights, so nobody mistakes it for the moving platform (lint #8) | z −9 |

**Drop Zone Strip** (480 × 140 m, 08 §3):

| Area | Surfaces |
|---|---|
| Docks | 2 Screens (port LED), 1 Hoarding (container crane) |
| Old town | 4 Screens (market junctions), 1 Hoarding |
| Factory | 3 Screens, 1 Hoarding (rooftop sign) |
| Airbase | 3 Screens (hangar walls), 1 Hoarding (hangar roof) |
| Metro line (underground, y ≈ 25) | 4 Screens on platform back walls (z −4). The acid flood reaches y ≥ 25 in phase 5 and counts as an occluder (§4.6) |
| Forest, mountain, cliff fort, sewer, mine shafts | none (ad-free quiet zones) |
| Warm-up yard | 4 Screens (Drop Sponsor) |
| Sky | the optional Drop Sponsor airship (Phase 5+); never the deploy plane |

The deploy plane, its path, supply drops (crate, canopy, flare, minimap marker) and anything that delivers or telegraphs them are never branded (rule 2). Supply drops arrive exactly as 08 §6.2 specifies.

### 2.4 Inventory per geo

| Map | Screens | Units on sale at launch | Pilot (Phase 3, premium only) |
|---|---|---|---|
| Lagos Market | 4 | 24 frames + 2 Hoardings | 12 frames (3 per Screen; the rest show house art) + 2 Hoardings |
| Mumbai Local | 3 | 18 frames + 2 Hoardings + 1 Wrap | — (from launch) |
| Strip | 16 | 6 Strip Packs (one per frame index: the same creative on all 16 Screens) + 4 Hoardings | 3 Strip Packs |
| BR warm-up yard | 4 | Drop Sponsor | — (house art; its delivery is measured to build the forecast) |
| **Total** | 23 (+4 yard) | **42 frames + 6 Strip Packs + 9 single-owner surfaces + Drop Sponsor** | **12 frames + 3 Strip Packs + 2 Hoardings** |

- **Strip Screens aren't sold one at a time.** 96 separate Strip creatives would blow the texture and download budgets (§4.9). Strip Packs cap unique Strip creatives at 6 per geo-week.
- **Scarcity in the pilot.** At realistic demand most inventory would show house art, which signals abundance to buyers. So the pilot puts only premium units on sale, and a demand rule raises the index when a map fills (§5.2).
- Every geo has its own copy of this inventory. A Lagos player and a Mumbai player in the same match see different creatives on the same screen at the same moment (geo-split, §4.3).

### 2.5 Seasonal and event takeovers

- **Map Takeover (72 h):** one sponsor gets every surface of one map in one geo (all frames, Hoardings, Wrap). Paint only: no themed dressing in brand colours, and no changes to collision, lighting, audio or rules (rule 11). Bookable only on days with no paid bookings for those surfaces (§5.1). Sold from the full-stack phase (§8.1).
- **Seasonal skins** (08 §3: snow, Halloween and monsoon skins on the same collision, which also change loot tables) can carry a "presented by" sponsor only if the skin's loot-table changes ship identically without the sponsor. The sponsor is never named in loot, rewards or event text.
- Calendar hooks:
  - **Nigeria:** Independence Day (1 Oct), Detty December (Lagos Market), Easter/Sallah.
  - **India:** IPL (Mar–May, Mumbai Local), Diwali, Independence Day (15 Aug).
  - **Global:** school holidays, AFCON, the World Cup.
- Takeovers never stack: one per map per geo at a time, booked ≥ 3 weeks ahead (for review).

### 2.6 Editor lint for `AdSlot` (blocks map export)

1. `z ∈ [−9, −4]`. Not parented to collidable or gameplay-kinematic nodes (the deploy plane and the gameplay train included). Not inside darkness pockets or fog volumes. No exceptions.
2. Share of the screen at 1× between 2.5% and 8%, and ≥ 1.5% up to at least 4×.
3. Facing within ±20° of the camera axis, so the IAB 55° angle check always passes.
4. Sampled camera views (every spawn point plus navmesh samples): at 1×, ≤ 2 ad surfaces per view and a mean ad area ≤ 5%; at the map's highest available zoom, ≤ 4 ad surfaces and ≤ 8% total ad area per view.
5. No screen-space overlap (at 1×, sampled views) with hazard stripes, pit fog, jump-pad arrows, flag bases, BR POI signage, the storm walls, the storm ceiling or the flood surface (at every phase position).
6. Every slot draws from the map's shared house pool, so the map looks finished with zero ads sold: ≥ 2 images per slot, and ≤ 8 house images per format per map (to fit the fixed layer pools in §4.5).
7. No `AdSlot` whose 1× screen footprint overlaps the top 20% of cells in the map's playtest combat/death heatmap (01 §9, 13 #622). Re-run after every layout change.
8. Moving surfaces have no lights or audio. The Wrap never runs within 15 s of the gameplay train. The airship stays out of y 120–140, keeps ≥ 40 m horizontally from any supply drop in flight, and never crosses the deploy plane's path.

---

## 3. Creative spec

### 3.1 Formats

| Format | Upload master | Runtime texture | IAB guidance |
|---|---|---|---|
| Screen 4:3 | 2048 × 1536 px | 512 × 384, KTX2 **ETC1S** with a full mip chain (UASTC is also encoded and kept for a later High option) | 4:3, minimum 512 × 384 ✓ |
| Hoarding / Wrap / airship 6:1 | 2304 × 384 px | 1152 × 192, same encodings | 6:1, minimum 1024 × 170 ✓ |

- **Deliberate deviations from IAB 2024:** IAB recommends ≥ 256 px and power-of-two sizes for desktop games. We keep 192 px for the 6:1 runtime texture to save memory (a Hoarding draws ≤ 135 px tall at 1080p and 1×, so 192 px already over-samples), and non-power-of-two sizes are fine with mips in WebGL2.
- **Upload rules:** PNG, JPG or WebP. sRGB (other colour profiles are converted). ≤ 5 MB. Exact ratio ±1%. Opaque (alpha is flattened on black).
- **Pipeline** (`tools/asset-pipeline`, 11 §4) runs in an **isolated container with no network and no secrets**. Dimensions and file size are checked before decoding, image libraries are kept patched (libwebp CVE-2023-4863 was exploited through WebP files), and the output is re-encoded from decoded pixels with metadata stripped. Then: resize, light sharpen, the grade preview (§3.4), encode both KTX2 variants with `basisu`, hash with SHA-256 (the public id is the first 128 bits, base64url), and upload to R2 at `ads/{id}.{etc1s|uastc}.ktx2`. Typical sizes: ETC1S ≈ 30–60 KB, UASTC + zstd ≈ 100–200 KB.
- Masters are kept, so we can re-encode at higher runtime resolution later.

### 3.2 Layout

- **Safe area:** the bezel hides 3% at each edge. Keep text and logos inside the central 90% × 85%.
- **Legibility:** text cap height ≥ 7% of the creative's height (≈ 19 px on screen at 1080p, 1×); bold headlines; text contrast ≥ 3:1 **measured after the grade** (§3.4; the WCAG large-text level, because the grade compresses contrast); headline ≤ 7 words; ≤ 3 visual elements (IAB 2024 gaming creative guidelines).
- **Allowed text:** brand name, headline, and optionally a short CTA such as "Search <brand>" or a social handle of ≤ 24 characters that belongs to the KYC-verified advertiser (checked at review, §5.5). **Not allowed:** URLs (IAB 2024 §4.3.1.3 says intrinsic display should avoid web addresses and QR codes), QR codes, phone or WhatsApp numbers, countdown prices, and "click", "tap" or "scan" calls to action.
- **No imitation of the game:** no crosshairs, hit markers, health or fuel bars, weapon or item icons, rarity colours or rarity shapes (circle, square, diamond, hexagon, star, 08 §6.1) used as frames, fake buttons, explosions, gore or real firearms.
- **People and figures:** no full-body human, character or soldier figures between 15% and 60% of the creative's height. (A ~2.1 m figure at z −6 reads at player size, about 36% of a Screen's height, so it could be mistaken for a player or camouflage one.) People appear as head-and-shoulders crops or larger close-ups. No flying or jetpack poses, and nobody holding objects that read as weapons.
- **Children:** no direct exhortation ("Buy now!", "Ask your parents"), and no mascots presented as game characters.

### 3.3 Animation

- **Launch:** static only.
- **Post (Motion add-on):** ≤ 4 still keyframes, each shown ≥ 1.5 s, crossfades ≤ 0.3 s, no flashes, muted. Delivered as KTX2 layers and measured under the IAB 2-second rule for video and dynamic ads.

### 3.4 What the engine does to every creative

- **Palette-relative grade.** After grading, the creative's luminance range and saturation must sit inside the p5–p95 range of the map's surrounding mid-depth kit: contrast compressed to ~60%, the luminance ceiling at the kit's maximum, saturation clamped to the kit's p95, plus the map's atmospheric tint. Text legibility (§3.2) is measured on the graded result.
- The bezel and "AD" chip, mipmaps, and 4× anisotropic filtering on High.
- An unlit, non-emissive material excluded from bloom (§4.5).
- The review preview (and later the portal preview, §5.3) renders exactly this, so what the advertiser approves is what players see.

### 3.5 Automated checks (before human review)

| Check | Rule | On failure |
|---|---|---|
| Format | ratio, size, colour space, file type | auto-reject with a fix hint |
| Text size and contrast | OCR: smallest cap height ≥ 7%; contrast ≥ 3:1 after the grade | warning → reviewer |
| URL, QR code, phone number | OCR + QR detector | auto-reject |
| **Readability gate** | composite every approved skin, dye extreme, team outline and enemy-highlight colour (04 §1.4) over the graded creative and apply the same luminance-contrast threshold the 04 §8 lint uses for map palettes | auto-reject (R09) |
| Signal hues | > 15% of pixels, or any connected region > 5% of the creative, within ±15° of any gameplay signal hue at saturation > 0.4: team blue/orange, every enemy-highlight option, storm purple, gas green, the rarity tiers, damage and low-HP red, the headshot hit-marker orange (03 §13) | reviewer checks readability in the live preview |
| Glare | mean relative luminance > 0.6, or > 10% pure white, before the grade | auto-darkened in the preview → reviewer |
| Figures | person/figure detector: full-body figures 15–60% of the creative's height | reviewer |
| Flashing (Motion only) | luminance flash count | auto-reject |
| Nudity / violence | image classifier | reviewer, always |
| Known bad actors | blocklist of domains, handles, business names and the per-language coded-term lists (§5.5) | auto-reject |
| Repeat attempt | perceptual hash vs previously rejected creatives | reviewer |

### 3.6 Review and rejection reasons

| Code | Reason |
|---|---|
| R01 | Format or spec |
| R02 | Illegible at in-game size |
| R03 | Prohibited category, surrogate or brand extension (§3.7) |
| R04 | Sexual, violent, hateful or shocking content |
| R05 | Misleading, unsubstantiated or unfair comparative claims |
| R06 | Missing or expired ARCON approval (Nigeria-targeted) |
| R07 | No rights to the logos, people, music or trademarks shown |
| R08 | Exhortation aimed at children |
| R09 | Readability conflict (readability gate, signal hues, glare) |
| R10 | Flashing or motion rules |
| R11 | URL/QR/phone/call-to-action rules |
| R12 | ARCON local-talent rule (Nigeria-targeted creatives use Nigerian models and voices) |
| R13 | Political, electoral, issue or religious-recruitment content |
| R14 | Imitates game UI, items, effects or players |
| R15 | Advertiser identity not verified |
| R16 | Other, including no reviewer or translator for the creative's language (written reason required) |
| R17 | Handle or brand destination unsuitable for minors |

Every decision stores the code, a note and the reviewer ID. This is the audit trail, and it follows the "statement of reasons" practice in 10 §4.

### 3.7 Categories

| Status | Categories |
|---|---|
| **Prohibited** (all geos) | betting, sports betting, lotteries, casinos, fantasy sports with stakes; **real-money gaming** (advertising it has been an offence in India since 1 May 2026); alcohol; tobacco, vapes, nicotine, cannabis, drugs; real weapons, ammunition, knives, fireworks; adult or sexual content, dating, escorts; **loan apps, BNPL, payday and digital lending**; crypto, NFTs, forex, investment schemes, MLM, "earn money" offers; political, electoral, issue and government-campaign ads; religious recruitment; prescription drugs, weight loss, skin lightening, unregistered herbal cures; game accounts, boosting, cheats, currency resellers; games rated above PEGI 12 / Teen; **surrogate and brand-extension ads for any prohibited category**, including sister brands or apps of betting, alcohol, tobacco and lending firms (sports-news, TV or "free predictions" apps; non-alcoholic drinks under an alcohol brand); anything illegal in the target geo |
| **Restricted** (extra review) | food and drink (brand-led; **no identifiable less-healthy (HFSS) products in any geo**); banks and payment apps (no credit offers); insurance (licensed insurers only; no investment-linked or credit products); over-the-counter health (NAFDAC or equivalent regulator number required in Nigeria); other games (rated ≤ ours, no real money); events (none 18+); charities (registered only); education (no guaranteed-result claims) |
| **Allowed** | consumer brands, retail, fashion, delivery and mobility apps, telecoms, electronics, music releases without explicit or parental-advisory content, artwork or titles, media, local shops and services |

The counsel opinion (13 #719) also checks the ARCON code's children's provisions against this list.

---

## 4. Technical design

### 4.1 Components

| Piece | Where |
|---|---|
| `AdSlot` entity + lint | `packages/content` (map schema), `apps/map-editor` |
| Rotation function + IAB thresholds (shared constants) | `packages/shared/src/ads/` |
| Ad renderer + measurement | `apps/web/src/ads/**` (built on `packages/render`) |
| Delivery tokens (minted at join, carried in the join ticket) | `apps/api` (matchmaker and rooms) |
| Exposure bounds → separate ads stream | `apps/game-server/src/ads-bounds.ts` |
| Manifest service, delivery collector (queue), portal API | `apps/api/src/ads/**` |
| Validation, aggregation, proof of play | `apps/worker` |
| Creative pipeline (isolated container, §3.1) | `tools/asset-pipeline` (ads job) |
| Self-serve portal (full-stack phase, §8.1) | `apps/ads-portal` (Vite + React, its own origin `ads.<domain>` for CSP and cookie separation) |
| Review queue, takedowns, ad reports | `apps/admin` |

**No change to the bit layouts.** The manifest travels over HTTPS, rotation runs off the synced match clock (05 §4), and revocations ride the social gateway. The only game-channel addition is a backup revocation sent as an `EVENT_R` `sys` code (msgpackr-encoded, §4.3), which W6 reviews like any additive protocol change (15 §1 rule 4). The server bound needs no new data from the client (§4.7).

### 4.2 `AdSlot` (compiled map format)

```ts
interface AdSlot {
  slotId: string;                       // stable, e.g. "lagos-market/S1"
  kind: 'screen' | 'hoarding' | 'wrap' | 'airship' | 'yard';
  format: '4:3' | '6:1';
  frames: 1 | 6;                        // rotation capacity
  dwellMs: 10_000;
  phaseIdx: 0 | 1 | 2 | 3 | 4 | 5;      // frame offset; Screens that share a view get different offsets
  pos: [x: number, y: number, z: number]; // z ∈ [−9, −4]
  size: [w: number, h: number];         // metres
  yawDeg: number;                       // |yaw| ≤ 20
  pathId?: string;                      // moving surfaces (wrap, airship)
  houseSet: string[];                   // ids in the map's shared house pool
  tags: ('premium' | 'junction' | 'metro' | 'lobby')[];
}
```

### 4.3 Ad manifest

```
match allocated ─▶ mm.found (07 §6.2), POST /rooms and POST /rooms/{code}/join carry
                   adManifestUrl(map, geo, week, version) + a signed, match-scoped delivery token
client ─▶ CDN GET /a/m/{map}/{geo}/{week}/{version}.json      (Cloudflare, cached 60 s)
       ─▶ verify Ed25519 signature (ad key, separate from the join-ticket key)
       ─▶ fetch each creative from ads/{id}.etc1s.ktx2 ─▶ check its SHA-256 starts with the id
       ─▶ upload into the pre-allocated layer pool at a safe moment (§4.5)
       ─▶ swap house art for the creative, frame by frame
```

```json
{ "id": "lm-NG-2027W14-v3", "map": "lagos-market", "geo": "NG",
  "validFrom": "2027-04-05T00:00+01:00", "validTo": "2027-04-12T00:00+01:00",
  "slots": [
    { "slot": "lagos-market/S1", "frames": [
      { "c": "qZ8f3kT1mV0bXw2LpR7s9A", "adv": 1042, "paid": true },
      { "c": "house:lm-buka-02", "paid": false } ] } ],
  "sig": "ed25519:…" }
```

- **Compact by design.** Creative URLs are derived from the id, and advertisers are referenced by number. Their names live in a per-geo-week sponsors file (`/a/s/{geo}/{week}.json`) that the About-ads page and the website Sponsors page also read. A fully sold Lagos Market manifest is ≈ 2 KB; CI fails any manifest over 4 KB.
- **Geo** = country from `CF-IPCountry` at the API, which is already our only location signal (10 §7). Unknown and unsold geos get the `XX` manifest (house art; programmatic later).
- **Why signed:** a poisoned cache or a leaked R2 key can't put unreviewed art on screen (Lagos Life's failure), and the collector can verify schedule claims without a database lookup.
- **Revocation:** an admin kill switch (by creative, advertiser or category) bumps the manifest version and pushes `ads.revoke{creativeIds}` on the social gateway (an event to add to the 07 §11 list). As a backup for clients whose social WS is down, the game server also sends `EVENT_R {e:'sys', code:'ADS_REVOKE', ids}` to every running match on that map and geo. Clients swap to house art within 1 s; matches that start afterwards get the new manifest.
- **Ad blockers:** we don't evade them. A blocked manifest means house art and no measurement.

### 4.4 Rotation

Rotation is deterministic from the synced match clock. Every player in a match sees the same frame index at the same moment, and the server can compute it too:

```ts
frameIndex(slot, matchTimeMs) = (Math.floor(matchTimeMs / slot.dwellMs) + slot.phaseIdx) % slot.frames
```

- **One beat per map.** Every Screen changes on the same 10 s beat, so a player sees at most one change per 10 s, never a stream of staggered cuts in peripheral vision. `phaseIdx` offsets keep one creative off two Screens in the same view (Map and Strip Packs).
- **Crossfade, never a hard cut.** Changes take 0.5 s, and the AD chip fades with its frame.
- **Chip size:** 6% of the Screen's height, ≈ 16 px at 1080p and 1× and ≈ 10 px at 5×, so it stays legible wherever the Screen is viewable.

### 4.5 Rendering

- **Fixed pools, one material per format.** Each format uses a `CompressedArrayTexture` pre-allocated at map load with a fixed layer pool: **32 Screen layers** (≤ 24 paid creatives + the shared house pool) and **8 6:1 layers**, all ETC1S, ≈ 5.1 MB per map on every preset (§4.9). Each layer is sampled with a per-instance layer index. All surfaces of one format on a map are one `InstancedMesh`/`BatchedMesh`, so **all ads cost ≤ 2 draw calls**. Rotation is a per-instance index update plus a crossfade uniform.
- **Uploads at safe moments.** Arriving creatives are uploaded one layer per frame, only while the local player is dead or respawning, in the warm-up yard or on the plane, at ≤ 0.5 ms per upload frame. Otherwise they wait for the next window, and the frame shows house art until its creative is resident. This keeps compressed uploads and mip chains away from fights on the UHD 620 reference iGPU.
- KTX2 transcoding runs in the existing decoder worker (11 §1). Mips are always on; anisotropy is 4× on High.
- **Material.** Ad and house-art surfaces use an unlit, non-emissive material on a layer excluded from the bloom pass (High post, 11 §2). The LED look comes from the bezel mesh, never from emissive creative pixels.
- **Load policy:**
  - Each map ships with its house pool. Creatives download **after first spawn** at the lowest network priority, never inside the loading-screen budget (≤ 10 s to gameplay, 11 §3).
  - The one exception: while a player is queued for Drop Zone, the Drop Sponsor's yard creative (≤ 200 KB ETC1S) prefetches at the lowest priority (11 §7 step 5) and is cancelled on match found if incomplete. Otherwise the yard would show house art for much of the window the sponsor is sold on.
  - **No ad downloads** when `navigator.connection.saveData` is true, `effectiveType` is `slow-2g`/`2g`/`3g`, or low-bandwidth mode is on (05 §2.2, §13). A "Download billboard images" setting (default off on metered or Save-Data connections) also controls it. Those sessions show house art and aren't counted.
  - Impressions start only after the creative is resident (IAB: the ad must be loaded and rendering).
- **Fallback chain:** paid creative for the player's geo → programmatic (Phase 5+, pre-approved creatives only) → house pool → baked texture.
- The bezel and "AD" chip are part of the Screen/Hoarding mesh. `paid: true` turns the chip on.
- Ad shader variants are compiled in the loading-screen `compileAsync` pass (11 §3) like every other material.

### 4.6 Measurement (IAB/MRC IIG 2.0, computed from our camera)

Built in the full-stack phase (§8.1, 13 #730). The pilot reports server-modelled estimates instead (§4.7).

| IAB/MRC rule (display) | Our implementation |
|---|---|
| Impression = creative loaded and begins to render | texture resident and ≥ 1 visible pixel in the mask (below), at least once in the session |
| Viewable needs ≥ 50% of the creative's pixels visible | visible px ÷ projected px ≥ 0.5. Off-screen, occluded and HUD-covered pixels all count as not visible |
| Visible part ≥ 1.5% of the screen | visible px ÷ viewport px ≥ 0.015 |
| Angle ≤ 55° on any axis | angle between the slot normal and the camera ray to the visible part's centroid. Worst case ≈ 49° horizontally (29° half-FOV + 20° yaw from lint rule 3) and ≈ 22.5° vertically (17.5° + 5° tilt), so each axis passes; checked anyway |
| ≥ 1 continuous second (2 s for video/dynamic) | 5 consecutive passing checks at 200 ms (10 for Motion). We don't use the optional 3-of-5 majority rule |
| Poll every 200 ms | every 12 sim ticks (60 Hz) |
| At most one viewable impression per ad per user session | session = page load → close, or a 30 min gap without input. Deduplicated per (session, creative) on the client and on the server |
| Occlusion includes UI; low light and contrast count | the mask includes level geometry, foreground props (dither α ≥ 0.5), player proxies, smoke/gas volumes, the BR storm walls, ceiling and flood surface, and every HUD rect. Full-screen obstructions (pause, scoreboard, death fade, the inside-storm vignette, menus) make everything non-viewable. Lint bans slots in dark zones |
| Exclude idle players | no input for 30 s in a match (60 s in warm-up/lobby, 30 s while spectating), or the server's AFK flag → counting stops |
| Exclude backgrounded apps | `visibilityState !== 'visible'` or window unfocused → not viewable |
| Report Viewable / Non-viewable / Undetermined | §5.6. Checks within ±15% of a threshold count as Undetermined |

Each check (every 200 ms, only while at least one slot is inside the frustum):

```ts
// areas from exact geometry (the 2.5D perspective camera); occlusion from a 320×180 two-channel mask
for (const s of slotsInFrustum) {
  const quad = projectCorners(s, camera);                   // NDC, exact
  const projPx = polyArea(quad) * VIEW_PX;                  // full projected area, unclipped
  const onPx = polyArea(clipToViewport(quad)) * VIEW_PX;    // the on-screen part
  const f = mask.visible[s.index] / Math.max(1, mask.drawn[s.index]); // share not occluded or under the HUD
  const r50 = (onPx * f) / projPx, r15 = (onPx * f) / VIEW_PX;
  if (nearThreshold(r50, 0.5, 0.15) || nearThreshold(r15, 0.015, 0.15)) { s.undeterminedMs += 200; s.run = 0; continue; }
  const ok = pageVisible && focused && !idle && !screenObstructed
          && r50 >= 0.5 && r15 >= 0.015 && angleDeg(s, camera) <= 55 && s.creative === s.runCreative;
  s.run = ok ? s.run + 1 : 0;  s.runCreative = s.creative;
  if (ok) acc(s.creative).viewMs += 200;
  if (s.run === 5) acc(s.creative).onViewable();     // first per session = viewable impression; later = exposures
}
```

**Mask pass:** a 320 × 180 RGBA8 render target.
- Draws: the ad quads in their slot-index colour **without** a depth test into channel G (pixels drawn); occluders depth-only (one merged static occluder mesh per map, baked at export; player proxies as one instanced draw; smoke, gas and BR hazard surfaces as one draw); the ad quads again **with** the depth test into channel R (pixels visible); then the HUD rects painted 0. That's ≤ 8 draw calls, counted in the 11 §3 budget.
- Areas come from the quad analytically; the mask only supplies the visible fraction. At the 1.5% threshold (864 px) worst-case quantisation is ≈ ±7% for 4:3 and ±10% for 6:1 (it would be ±14% / ±19% at 160 × 90), which is why checks within ±15% of a threshold are Undetermined.
- It's read back with `readRenderTargetPixelsAsync` (WebGL2 PBO + fence; never a synchronous `readPixels`), and the CPU counts 57,600 px in ~80 µs.

### 4.7 Reporting pipeline

```
API at join: delivery token dt = random 128 bits + expiry, HMAC-signed ─▶ join response / mm.found + inside the join ticket
client accumulators (per session, memory only)
   ──match end / pagehide (sendBeacon, no auth header)──▶ POST /v1/ads/delivery ─▶ queue (Redis Stream or Cloudflare Queue)
     {dt, sessionNonce, manifestId, entries[{slot, creative, rendered, viewable, exposures, viewMs, maxScreenPct}]}
game server ──separate ads stream (never stored with match results)──▶ candidate runs keyed by dt
worker: verify dt + manifest + schedule ─▶ apply server bound ─▶ dedup ─▶ IVT rules ─▶ ad_delivery_hourly ─▶ reports
```

- **Server bound.** It's a pure upper bound that needs no new client data. Every 12 ticks the game server takes the player's AOI view rect from 05 §9: camera bounds at the equipped weapon's `zoomMax`, plus the margin and the look-ahead. A slot "could be viewable" when ≥ 50% of it is inside that rect and its share of the screen at **1×** (the largest it can appear) is ≥ 1.5%. Five consecutive samples make a candidate run. The server doesn't know the client's actual zoom (INPUT carries only the zoom-toggle bit, 05 §6.1) and doesn't need to. Cost: ≤ 32 players × 30 slots × 5 Hz rect tests per match, which is negligible. If a tighter bound is ever needed, it becomes an additive message reviewed by W6.
- **Validation.** A client claim counts only if the server has a candidate run for that token, slot and frame, and the claimed `viewMs` is capped at the candidate time. Clients can under-report (blockers, lost batches) but can't invent delivery.
- **Estimated and modelled delivery.** During the pilot (before the client mask exists) every flight is reported as **estimated viewable impressions (server-modelled, unaudited)**. Later, for players who send nothing (no consent where it's required, blocked, crashed), the server bound gives an *Undetermined (modelled)* figure that is never billed.
- **Data handling: no account in the pipeline.**
  - The delivery token is random, signed and match-scoped. The API never stores it with the account, and it carries no match id.
  - The client posts batches with that token only, unauthenticated, so `sendBeacon` works. A random per-session nonce, held in memory only (no cookie, no localStorage), lets the server deduplicate across matches in one session.
  - The game server keeps the token-to-player link in memory for the match only and writes exposure bounds keyed by the token to a separate ads stream that is never stored with match results (06 §1).
  - The worker joins token to bound, aggregates, and deletes the token mapping within 24 h. The collector and its edge logs drop IP addresses.
  - Pseudonymised raw rows (no token, nonce or match id) are kept until flight end + 90 days for disputes (§5.9). Hourly aggregates are kept 2 years for invoicing.
- **Proof of play, in privacy mode.** Screenshots and clips come from a replay-viewer mode (06 §2) with the HUD, nameplates, kill feed, chat, clan tags and emotes off, and players drawn as default-skin proxies. They carry no match id, no timestamp finer than the hour and no region or room code, and a reviewer checks each one before release. **Pilot:** staff capture 3 screenshots and one 10–15 s clip per slot per flight-week in this mode, which advertisers may repost. **Full stack:** the worker renders them from replays (a small GPU instance, or a weekly run on a dev machine; add it to the 09 §7 budget).

### 4.8 Fraud and invalid traffic (IVT)

| Threat | Control |
|---|---|
| Server bots | they have no client, and the bounds skip `isBot` players |
| Scripted or headless clients | claims must match the server bounds of a real match with plausible inputs (the 10 §3 feature vectors); Turnstile on risky guest paths; per-session claim caps (no more than the creatives that could physically be seen) |
| AFK and idle farming | 30 s idle rule; matches where the server flags the player AFK for > 50% are voided; rooms flagged for XP farming are voided |
| Hidden tabs, minimised windows | not counted (visibility + focus) |
| Bot-only and one-human rooms, Training, replays, dev and staging builds | not counted |
| Replayed or duplicate batches | idempotency key `(dt, sessionNonce)`; a Redis hash `ad:s:{nonce}` (fields = creative ids) with a 6 h TTL. At 10k CCU that's ≈ 150k keys and ≈ 3M fields per 6 h (≈ 150–300 MB): add it to the Valkey sizing in 09 §7, or give it a small instance of its own |
| We inflate our own numbers (we have the incentive) | published methodology (self-reported, not MRC-accredited), raw hourly CSV on request, privacy-mode proof of play, a dispute process (§5.9), and a third-party methodology review before agency sales (§9.1 #12). House art runs through the same code, so we can check ourselves against replays |
| Bad sessions | a session with > 10% of claims outside the bounds is IVT in full; IVT % is shown per flight |

### 4.9 Performance budget

| Item | Budget |
|---|---|
| Draw calls | ≤ 2 (shared with house art), plus ≤ 8 in the 5 Hz mask pass; both counted in the 11 §3 budget |
| GPU texture memory | fixed pools: 32 Screen layers × 128 KB + 8 6:1 layers × 144 KB ≈ **5.1 MB per map** on every preset (ETC1S transcoded to 4 bpp, with mips). CI fails any manifest whose resident set exceeds the pool. A UASTC option for High (≈ 10 MB pool, 100–200 KB per creative) is a post-launch decision |
| Layer uploads | ≤ 0.5 ms per upload frame, never during active combat (§4.5) |
| Download | 0 B before first spawn, except the ≤ 200 KB Drop Sponsor prefetch while queued. After spawn, ≤ 1.6 MB per map at full sell-through (Lagos Market: 26 creatives × ≤ 60 KB), usually far less; cached by the Service Worker, so only the first match of the week pays it; 0 B on Save-Data, slow connections and low-bandwidth mode. Ad bytes per match go on the G4 dashboard |
| Measurement | 5 Hz; CPU ≤ 0.05 ms per frame on average; the mask frame ≤ 0.5 ms CPU+GPU at p99 on the Low reference iGPU, measured separately from the average (a spike every 12th frame wouldn't trigger dynamic resolution, 11 §3); async readback only |
| Rotation | per-instance index update + crossfade uniform, no uploads |
| Network | manifest ≤ 4 KB (CI check); one delivery batch per match, ≤ 2 KB, sent only at match end or pagehide |
| Server bounds | ≤ 0.05 ms per tick per BR match |
| Total frame cost on the Low reference iGPU | ≤ 0.2 ms on average. If a device sits at the dynamic-resolution floor (0.6) and still misses 60 fps, the measurement pass stops and that session isn't counted |

### 4.10 Build targets and settings

| Target | Ads |
|---|---|
| `web` | full |
| `portal` (CrazyGames, Poki, GameDistribution, Playgama) | house art only; no manifest, no batches, no external requests |
| `app` (Capacitor, later) | full; re-check store ad and kids-category policies |
| `dev` | test creatives and a measurement debug overlay (mask view, per-slot %, run counters); never counted |

Streamer mode (13 #379, post-launch) gets a "house art on billboards" option, and that player's delivery isn't counted. Any wider billboard opt-out would be a free setting for every player (rule 12).

---

## 5. Ad operations

### 5.1 Data model

```
advertisers(id, legal_name, trading_name, country, cac_or_gstin, tax_id, contact, kyc_status, kyc_docs_ref, risk_flags, created_at)
agency_authorisations(agency_id, advertiser_id, brand, letter_ref, valid_to)
campaigns(id, advertiser_id, name, category, status)
flights(id, campaign_id, product, geo, start_week, weeks, price_minor, currency, guarantee, guarantee_unit, payment_terms, status)
creatives(id, advertiser_id, format, master_url, hashes, language, handle, review_status, reviewer_ids, arcon_cert_no, arcon_valid_to, last_review_at, reasons[])
bookings(flight_id, slot_id, frame_idx, geo, day)   UNIQUE(slot_id, frame_idx, geo, day)
ad_delivery_hourly(creative_id, slot_id, geo, hour, rendered, viewable, exposures, view_ms, ivt_removed, modelled)
invoices(id, advertiser_id, flight_ids, subtotal, vat, wht_expected, total, currency, provider, provider_ref, terms, due_at, status)
make_goods(flight_id, shortfall, unit, extra_days, credit_minor, reason)
disputes(id, invoice_id, opened_at, evidence_refs, outcome, credit_minor)
```

- **The inventory unit is (slot, frame, geo, day).** A weekly flight books 7 day-rows. A 72 h Map Takeover books 3 day-rows for every (slot, frame) it covers, and is bookable only where none of them is taken. Weeks run Monday 00:00 to Sunday 24:00 in the geo's time zone (WAT for Nigeria, IST for India).
- **Make-good reserve.** About 10% of frames per map, geo and week are held back for make-goods and released for sale at T−7 days, so free extensions never collide with future bookings.
- **KYC data** (tax IDs, identity documents, sole traders' phone numbers) is encrypted at rest, access-logged, kept for the legal retention period and then deleted, and covered by an advertiser privacy notice.

### 5.2 Allocation, targeting and share of voice

- **Targeting:** geo (country), map, mode family (standard or BR), week. Nothing else (rule 6).
- **Priority:** Map Takeover > Drop Sponsor > Screen Owner / Hoarding / Wrap > Packs > Frames > programmatic > house art. A higher-priority product can only take days that are still free (§5.1); it never displaces a paid booking.
- **Share of voice:** at most 6 frames per Screen, so each frame gets 1/6 of the airtime and returns every 60 s. An advertiser holds ≤ 2 frames on one Screen unless they buy Screen Owner.
- **Separation:** two advertisers in the same category never share a Screen. Category exclusivity (+25%) extends that to the whole map.
- **Lead time:** ≥ 2 business days with a valid ARCON certificate; otherwise ≥ 10 business days (standard ARCON vetting takes 7 working days) or ≥ 3 (expedited, ₦70k).
- **Book now, certify later.** A Nigerian advertiser can book before the certificate exists. If the creative isn't approved (our review + ARCON) by T−1 business day, the flight slides one week if inventory allows; otherwise it is refunded in full. Days that show house art for this reason are never billed. A flight can't run past its creative's ARCON approval expiry.
- **Demand rule:** if a map's sell-through exceeds 60% for 2 consecutive months, its index rises +25% at the next re-rate.

### 5.3 Self-serve portal (`ads.<domain>`, full-stack phase)

Built only after the thin-pilot gate (§8.1). Until then the same steps run by hand: WhatsApp and email, Paystack payment links, and the `apps/admin` review queue.

```
1 Sign up (business email, legal name, country, CAC number (NG) or GSTIN (IN), tax ID, phone;
  agencies upload a brand authorisation letter)
    ─▶ identity check (payment-provider KYC + a manual check before the first booking)
2 Pick product · map · geo · weeks ─▶ availability calendar + price from the current rate card
3 Upload the creative ─▶ automated checks (§3.5) ─▶ fix hints
4 Live preview: a real Three.js render of the actual map with the graded creative on the chosen slot,
  HUD overlay on, Low and High presets, zoom 1×/3×/5×, camera flying typical play paths,
  plus the delivery forecast
5 Accept terms (warranties, category rules, the refund matrix in §5.7) ─▶ pay (first flight: settled payment, §5.4)
6 Review queue ─▶ approved, or rejected (reason code; edit or full refund)
7 Upload the ARCON certificate (Nigeria) any time before T−1 business day (§5.2)
8 Dashboard · invoices · proof of play · make-goods · disputes
```

- **Creative help.** Many Lagos SMEs have no designer who can meet a 2048 × 1536, ≤ 7-word spec. We provide 3 approved Screen and Hoarding templates, and a "creative + ARCON filing" bundle through our partner agency (≈ ₦25–40k, estimate; get a quote before the pilot).
- **Security.** `apps/ads-portal`, the creative pipeline and the delivery collector are in the pre-monetisation pen-test scope (10 §6).

### 5.4 Payments and invoices

| Buyer | Provider | Currency | Notes |
|---|---|---|---|
| Nigeria | **Paystack** (primary), Flutterwave (backup) | NGN | cards, bank transfer, USSD; payment links for the hand-sold pilot |
| India | **Razorpay** | INR | needs an Indian entity or an agency partner (§9.1); GSTIN required at checkout (§7.5) |
| Everyone else | **Stripe** | USD / EUR | card or invoice |

- **Two payment terms.** SMEs prepay (Paystack link or bank transfer). KYC'd corporates and ARCON-registered agencies can get net-30 invoices with a credit limit (starting at ₦2M). The rate card is **gross**: it has a published 15% agency commission built in.
- **Fraud and chargebacks.** A first-time advertiser's flight starts only after the payment has settled (bank transfer, or card past the provider's risk hold). The paying account or card name must match the KYC legal name. A chargeback webhook suspends the advertiser's flights through the kill switch and adds them to the blocklist.
- Webhooks are signature-verified and idempotent (10 §6). Ads are B2B services we sell directly, not through Xsolla.
- Invoices are PDFs with the legal entity, TIN, VAT line, a withholding-tax (WHT) note and a sequential invoice number. Nigerian e-invoicing (NRS MBS) is integrated before 1 Jul 2027 (§7.5).
- **Cash planning.** Model cash received as invoice × (1 − WHT rate) until WHT credit notes arrive. Hosting is billed in USD (09 §7), so plan the NGN→USD conversion through a domiciliary account, or pay Lagos/JNB hosting in NGN where possible. Naira prices are fixed per flight; the index re-rates monthly, and early if the naira moves > 10% within a month.
- **Entity gate.** Paystack NGN settlement needs a Nigerian-registered business, so the Nigerian entity and bank account are a hard entry gate for the pilot (§9.1 #3, 12 §3 #9).

### 5.5 Review, takedown and reports

- **A human reviews every creative**, within ≤ 1 business day (same day in the pilot). A new advertiser's first creative gets **two reviewers**.
- **Language coverage.** A creative is reviewed only by someone who reads its language (English, Pidgin, Yoruba, Igbo, Hausa, Hindi, Hinglish and so on). Otherwise it goes to a paid translator or is rejected (R16). Coded slang is how betting, sex-work and loan ads slip through, so we keep a **coded-term list per language**, updated after every takedown and fed to the automated blocklist (§3.5).
- **Separation of duties.** Whoever sold a deal can never approve its creatives; `apps/admin` enforces it.
- **What the reviewer sees:** the automated checks, the live preview, the ARCON certificate, the advertiser's KYC (CAC number or GSTIN, and the brand authorisation letter for agencies) and any prior rejections.
- **Handles and brand searches.** The reviewer visits the handle (or searches the "Search <brand>" term) and checks that the landing content suits minors. The worker re-fetches it weekly during the flight. A change of owner, redirect target or content category revokes the creative automatically (kill switch) until it is re-reviewed (R17). Handles must belong to the KYC-verified advertiser.
- **Re-review** on renewal and at least every 12 weeks.
- **Reports.** Players and parents can report an ad from Settings → About ads (which lists today's advertisers in your region and explains contextual ads) and from the Sponsors page on the website.
- **Automatic suspension.** A creative swaps to house art through the kill switch when ≥ 3 distinct accounts report it within 30 min, or when one trusted flagger (staff, a verified parent, a regulator) reports it. A human reviews within 24 h, restores it if the reports were unfounded (with a make-good, §5.7), and down-weights report abusers (07 §10).
- **Takedown SLA: ≤ 1 h to suspension (automatic); ≤ 24 h to a human decision.** Ads are on the on-call rota (13 #598). Any harmful ad that reached players gets a post-mortem.
- Ads removed for breaking terms the advertiser warranted get no refund (Lagos Life applies the same rule).

### 5.6 Reporting to advertisers (never user-level)

- **Pilot:** a weekly PDF per flight with unique sessions reached, *estimated* viewable impressions and viewable seconds (server-modelled, unaudited, §4.7), and privacy-mode screenshots plus one clip.
- **Full stack:** an hourly dashboard with the metrics below, CSV export, and a public methodology page.

| Metric | Definition |
|---|---|
| Rendered impressions | sessions where the creative loaded and drew at least once (the IAB "impression") |
| **Viewable impressions** | sessions meeting §4.6, following IAB/MRC IIG 2.0 display (self-reported, not MRC-accredited). **The billing and guarantee metric for Frames, Packs and the Drop Sponsor** |
| Viewable rate | viewable ÷ rendered |
| Viewable exposures | ≥ 1 s viewable runs, including repeats within a session (frequency) |
| **Viewable seconds** | airtime on screen while viewable (the outdoor-style metric). **The guarantee metric for Screen Owner, Hoarding, Wrap and Map Takeover** |
| Non-viewable; Undetermined (incl. modelled) | the IAB split. Modelled delivery is never billed |
| IVT removed | invalid traffic filtered out (§4.8) |
| Delivery vs guarantee | running total against the guarantee (§5.7) |
| Breakdowns | map, slot, day, mode, geo, platform (desktop, plus mobile from S2) |
| Proof of play | 3 privacy-mode screenshots per slot per week |

### 5.7 Guarantees, make-goods, refunds

- **Guarantee.**
  - **Pilot:** 50% of the model forecast (§6.1), made good by extension only (no credit notes), with actual delivery reported.
  - **From Phase 4:** 70% of the trailing 28-day measured forecast for that slot and geo.
  - Frames, Packs and the Drop Sponsor are guaranteed in viewable impressions; Screen Owner, Hoarding, Wrap and Map Takeover in viewable seconds.
- **Shortfall at flight end:** we **extend the flight free** on the same or equivalent slots (from the make-good reserve, §5.1) until the guarantee is met (up to +100% duration). If it's still short (Phase 4+), we issue a pro-rata credit note. A game outage > 4 h triggers an automatic extension.
- **Refund and make-good matrix:**

| Case | Outcome |
|---|---|
| Advertiser violation (terms they warranted) | no refund |
| Rejected at review | edit, or a full refund if nothing is resubmitted within 72 h |
| Not approved (review + ARCON) by T−1 business day | slide one week if inventory allows, otherwise a full refund (§5.2) |
| Our error, or a suspension later overturned | make-good of the lost viewable impressions or seconds, plus an extension |
| Regulator objection (ARCON, ASCI) with no advertiser fault | pro-rata refund |
| A map patch would move or remove a slot | slot geometry is frozen for booked weeks; otherwise an equivalent slot or a pro-rata credit |
| Service shutdown, or the map is removed | pro-rata refund of unserved weeks |
| Chargeback | the advertiser's flights are suspended immediately and the advertiser is blocklisted |
| Cancellation by the advertiser | > 7 days before the start, full refund; ≤ 7 days, 50% credit; after the start, none |

- The rate card is re-rated monthly; booked flights keep their price.

### 5.8 Staffing

- **Pilot:** 1 part-time seller (WhatsApp and email, Lagos-based; ≈ $150–300/month base + ~10% commission, estimate). Reviews by the community/QA lead (12 §1), with a second reviewer from the team; the seller never approves their own deals. Night and weekend safety reports are covered by automatic suspension (§5.5), not by staff.
- **From 10k CCU:** 1 full-time ad-ops person (review, scheduling, reporting, on-call) and 1–2 sellers (≈ $1.5–3k/month together, estimate; get Lagos salary quotes). India through an agency partner.

### 5.9 Disputes

- Advertisers may dispute delivery within 30 days of an invoice.
- We provide the CSV, the methodology, proof of play and a replay-based recount of sampled slots (privacy mode), and resolve disputes by credit note.
- Pseudonymised raw rows are kept until flight end + 90 days, so every week of a 12-week flight can be rechecked (§4.7).
- Measurement accuracy is gated per format (4:3 and 6:1, §8.2). A third-party methodology review comes before selling to agencies at scale (§9.1 #12).

---

## 6. Pricing

### 6.1 Exposure model (*model*; replace with pilot data)

The model is a Monte Carlo simulation of camera paths with IAB rules applied, re-run on 17 Oct 2026 with the §2.3 placements:
- **Players:** random-walk movement, 35 s mean life, 5 s dead per life (not counted). BR players survive a random share of the match, drift toward a random zone centre, and split 80% surface / 20% underground.
- **Zoom mix:** 60% 1×, 20% 2×, 10% 3×, 10% 6×.
- **Occlusion:** a flat 10% haircut.
- **Not modelled:** the drop phase, storm geometry, and real players clustering at fights (lint #7 keeps slots away from those).

Volume assumptions:
- **CCU:** the 24 h average on the web build (portal traffic excluded). Peaks typically run 1.5–2× higher.
- **Play mix:** 60% standard / 40% Drop Zone matches, with 7 standard maps in rotation.
- **Match cycles:** 7 min standard; 6 min BR (*assumption*: 08 §2 gives ~7 min solo plus a 30 s lobby, but early eliminations requeue sooner). **Sessions:** 25 min (≈ 3.8 matches).
- **Player-hour shares:** Nigeria 30%, India 45%, others 25%. These are *unsourced planning numbers*. The game is desktop-only until S2 (12 §2), while Nigerian and Indian web traffic is mostly mobile (roughly 75–85%; verify with StatCounter), so the real Nigerian share of web-build CCU at launch could be much lower. See the sensitivity table below and §9.1 #8.
- **Deliverable share** (*assumption until telemetry*): the share of Nigerian web-build CCU we can bill. It excludes the hold-out, ad-blocked manifests, Save-Data and slow connections, low-bandwidth mode, streamer mode, and sessions that stop measuring at the dynamic-resolution floor. Planning value **0.71** after launch (5% hold-out × ~0.75), range 0.6–0.8; **0.6** in the pilot (20% hold-out).
- **Billable NG CCU** = web-build CCU × NG share × (1 − hold-out) × (1 − lost share) ≈ **0.21 × CCU** after launch and **0.18 × CCU** in the pilot. Pilot guarantees use this netted figure.

**Derivation:** weekly viewable impressions (IAB: one per creative per session) = billable NG CCU × (168 × 60 / 25 sessions per CCU-week) × P_session, where P_session = 1 − (1 − mode share × map share × p_match)^3.8 and p_match comes from the table below.

| Per player-match | Standard map (Lagos Market layout: 4 Screens, 2 Hoardings) | Strip (§2.3 placements: 12 surface + 4 metro Screens, 4 Hoardings) |
|---|---|---|
| Time with ≥ 1 Screen on screen | 67% | 35% |
| Time each Screen is on screen | 19% | 3.2% |
| A given frame seen viewable (≥ 1 s) | 67% (1.5 exposures, 8 viewable s) | 15% (0.22 exposures); not sold one Screen at a time |
| Screen Owner (all 6 frames) seen | 77% (4.7 exposures, 46 s) | not sold |
| Hoarding seen | 89% (5.2 exposures, 57 s) | 29% (0.8 exposures, 9 s) |
| Same frame on every Screen (Pack) | 82% | 76% |
| Warm-up yard (Drop Sponsor: 4 Screens, one creative) | — | 65% with 20% hot-joiners, 47% with 40% (planning: 60%; 8–11 viewable s) |

Standard rows use the Lagos Market layout of §2.3. Prices use p_match = 64% for a standard-map frame, a blend of this layout (67%) and a generic 6-Screen layout (62%); Mumbai Local (3 Screens) isn't modelled separately. Strip rows use the §2.3 POI clusters, metro and quiet zones. The yard model is an 80 × 40 m arena where players stay 5–30 s with no deaths; hot-joiners skip it (08 §4.8). Re-run all of this with real paths once playtest telemetry exists.

IAB viewable impressions, **Nigeria only, billable**, per week:

| Product | Pilot (500 CCU) | 1k CCU | 10k CCU | 50k CCU |
|---|---|---|---|---|
| Frame, standard map | 7.0k | 16.3k | 163k | 817k |
| Map Pack (frame × 4 Screens) | 8.8k | 20.5k | 205k | 1.02M |
| Screen Owner, standard | 8.3k | 19.4k | 194k | 968k |
| Hoarding, standard | 9.4k | 21.9k | 219k | 1.10M |
| Hoarding, Strip | 13.6k | 31.7k | 317k | 1.58M |
| Strip Pack (frame × 16 Screens) | 27.1k | 63.3k | 633k | 3.17M |
| City Pass (frame × 23 Screens) | 32.4k | 75.6k | 756k | 3.78M |
| Drop Sponsor (warm-up yard, p = 60%) | 23.5k | 54.8k | 548k | 2.74M |
| Map Takeover, Lagos Market (per 72 h) | 4.2k | 9.8k | 98k | 491k |

IAB counting is reach-like (one per session). Owning a whole Screen adds only ~18% impressions, but gives ~3× the exposures and ~6× the airtime (46 vs 8 viewable seconds per player-match). So whole-surface products are priced and guaranteed on airtime (§6.3), and reports show all three metrics.

**Sensitivity.** Every number above scales linearly with the Nigerian share and the deliverable share:

| NG share of web-build CCU | 30% (plan) | 20% | 10% |
|---|---|---|---|
| Frame impressions per week at 1k CCU | 16.3k | 10.9k | 5.4k |
| Pilot (500 CCU): the ₦25k floor as a viewable CPM | ₦3,570 ($2.68) | ₦5,360 ($4.02) | ₦10,700 ($8.04) |

**There is a lot of space.** At 10k CCU the launch units produce ≈ 1.9M billable Nigerian viewable impressions a day. Sales capacity, not space, limits revenue.

### 6.2 What is "500 per screen" worth?

Effective viewable CPM of one standard-map frame (16.3k billable Nigerian viewable impressions per week per 1k CCU), and the CCU at which each reading is fair:

| Reading of "500" | CPM at 1k CCU | at 10k | at 50k | Fair (₦1,500 CPM), per frame | Whole screen, on the 3.5× airtime card | Whole screen at ₦1,500 viewable CPM |
|---|---|---|---|---|---|---|
| ₦500 / week | ₦31 | ₦3 | ₦0.6 | ~20 CCU | ~6 CCU | ~17 CCU |
| ₦500 / month | ₦7 | ₦0.7 | ₦0.14 | ~5 CCU | ~1 CCU | ~4 CCU |
| ₦500k / week ("500" as Lagos shorthand) | ₦30,600 ($23) | ₦3,060 ($2.30) | ₦612 ($0.46) | ~20k CCU | ~5.8k CCU | ~17k CCU |
| ₦500k / month | ₦7,040 ($5.29) | ₦704 ($0.53) | ₦141 ($0.11) | ~4.7k CCU | ~1.3k CCU | ~4.0k CCU |
| $500 / week (≈ ₦666k) | ₦40,800 ($30.60) | ₦4,080 ($3.06) | ₦815 ($0.61) | ~27k CCU | ~7.8k CCU | ~23k CCU |
| $500 / month | ₦9,380 ($7.04) | ₦938 ($0.70) | ₦188 ($0.14) | ~6.3k CCU | ~1.8k CCU | ~5.3k CCU |

Month = 4.345 weeks. The whole-screen columns use Screen Owner (19.4k billable viewable impressions per week per 1k CCU). On the 3.5× airtime card a whole screen works out to ≈ ₦4,430 per 1,000 viewable impressions.

Benchmarks:
- **Meta in Nigeria:** ≈ ₦2,000 CPM ($1.50).
- **Lagos LED screens:** ≈ ₦330–1,400 CPM, based on vendors' unaudited audience claims.
- **General mobile ads:** $0.25–0.80 CPM in Nigeria.
- **Intrinsic in-game:** $3–15 (Bidstack, 2021), ~$6 average (Anzu, 2022); 2026 tier-1 direct quotes $8–25 (low confidence). All are US/EU-weighted, and no Nigeria or India intrinsic data exists.
- **Lagos Life:** ₦5k → ₦250k per week, with the product changing too (§1.1).

**Verdict:**
- **₦500, in any period: no.**
  - It's a tenth of Lagos Life's day-one price, and at ₦500 the advertiser's ₦7,500 ARCON fee is 15× the media cost, so compliant buyers can't make it pay. (Lagos Life's sex-work posters ran when its prices were ₦18k–₦500k/week. Its failure was publishing on payment with no pre-review, which rule 9 addresses whatever the price.)
  - It works out to ₦0.14–31 CPM. At best that's ~11× below the cheapest Lagos LED CPM (₦330) and ~65× below Meta Nigeria; at 10k–50k CCU it's ~100× to ~14,000× below.
  - It would anchor a price we could never raise.
- **"500 per screen" works if it means ₦500k or $500 per whole screen per month.** That's the rate card for a whole screen (Screen Owner, priced on airtime) at ~1.3k (₦) or ~1.8k ($) CCU, about 2–3.5× the soft-launch ceiling in 09 §7 (≤ 1k peak ≈ 500–670 average). Sold on viewable impressions at ₦1,500 CPM, the same prices need ~4.0k and ~5.3k CCU. Per frame per week, ₦500k needs ~20k CCU and $500 needs ~27k. ₦500 never works.
- **At realistic soft-launch traffic (~500 CCU) the floor sets every price:** a frame is ₦25k/week (≈ ₦109k/month, $82), a Hoarding ₦75k/week (≈ ₦326k/month, $245) and a whole screen ₦87.5k/week (≈ ₦380k/month, $285).
- **So keep the idea and drop the fixed number.** Publish a naira rate card indexed to measured traffic (§6.3) and re-rate it monthly. Lagos Life raised prices as demand grew; we re-rate from measured delivery, plus the demand rule in §5.2.

### 6.3 Recommended rate card (Nigeria)

**Index:** `Frame/week = max(₦25,000, ₦1,500 × forecast billable NG viewable impressions per frame per week ÷ 1,000)`, rounded to ₦5k. It's re-rated on the 1st of each month from the trailing 28 days of measured delivery. Until there's data, use ≈ **₦117 × billable NG CCU** (§6.1), which is ≈ ₦24.5 × CCU at the planning shares.

The ₦25k floor is a **minimum weekly order**: it covers review, the ARCON check and reporting. Below ~1,020 CCU (~214 billable NG CCU) it means an above-index CPM: ≈ ₦3,570 at 500 CCU, and more if the Nigerian share is lower (§6.1 sensitivity).

| CCU (28-day average, web build) | 500 (pilot) | 1k | 2.5k | 5k | 10k | 25k | 50k |
|---|---|---|---|---|---|---|---|
| **Frame / week** | ₦25k (floor) | ₦25k (floor) | ₦60k | ₦125k | ₦245k | ₦615k | ₦1.23M |

Products (multiplier × the Frame index, per week unless stated):

| Product | × | @1k CCU | @10k | @50k | USD @1k / @10k | Viewable CPM | What you get |
|---|---|---|---|---|---|---|---|
| Frame (standard map) | 1 | ₦25k | ₦245k | ₦1.23M | $19 / $184 | ₦1,500 | 1 of 6 rotation slots on one Screen |
| Map Pack | 2 | ₦50k | ₦490k | ₦2.45M | $38 / $368 | ≈ ₦2,400 | the same frame on every Screen of one map; sold on frequency |
| Strip Pack | 4 | ₦100k | ₦980k | ₦4.9M | $75 / $736 | ≈ ₦1,550 | the same frame on all 16 Strip Screens (the only way to buy Strip Screens) |
| Hoarding / Wrap | 3 | ₦75k | ₦735k | ₦3.68M | $56 / $552 | ≈ ₦3,350 (standard map), ≈ ₦2,300 (Strip) | static, 100% of one surface; sold on airtime |
| Screen Owner | 3.5 | ₦87.5k | ₦857.5k | ₦4.29M | $66 / $644 | ≈ ₦4,430 | all 6 frames of one Screen (standard maps); sold on airtime: ~6× a frame's viewable seconds for 3.5× the price |
| City Pass | 6 | ₦150k | ₦1.47M | ₦7.35M | $113 / $1,104 | ≈ ₦1,950 | the same frame on every Screen of every ad map (Lagos Market, Mumbai Local and one Strip Pack slot) |
| Drop Sponsor | 5 | ₦125k | ₦1.23M | ₦6.13M | $94 / $920 | ≈ ₦2,250 | 100% of the 4 warm-up yard Screens (plus the sky airship from Phase 5, with no forecast credit) |
| Map Takeover (72 h) | 6 | ₦150k | ₦1.47M | ₦7.35M | $113 / $1,104 | n/a (≈ ₦15,000 on reach) | every surface on one map for 3 days, ≈ 16× a frame-week's viewable seconds; sold as an event sponsorship |

**Whole surfaces are sold on airtime.** Screen Owner, Hoarding, Wrap and Map Takeover are sold and guaranteed on viewable seconds and share of voice, the units outdoor buyers already use, and reports still show their viewable CPM honestly. If pilot buyers won't pay airtime prices, the fallback is to cut Screen Owner and Hoarding to ~1.5× so their viewable CPM stays ≤ ₦2,000 (§9.1 #11).

**Add-ons and discounts:**
- Premium slots (tagged `premium`: a calm-dwell vantage that passes lint #7, or a metro platform): +25%.
- Category exclusivity: +25%.
- 4-week booking: −10%. 12-week booking: −20%.
- **Founding sponsors (pilot only): full price plus added value**, not a price cut: +2 bonus weeks, a founding-sponsor listing on the Sponsors page and in launch social posts, and the first creative designed free. A −50% founding rate would anchor buyers at half price, the same problem that rules out ₦500.
- **Stacking rules:** discounts multiply, apply after the floor, and are capped at −55% combined. Minimum order: ₦100k per flight before discounts (one frame for 4 weeks at the floor).

Prices exclude VAT. Naira prices are fixed per flight, and the index re-rates monthly (§5.4). The card is gross, with a 15% commission for ARCON-registered agencies built in.

ARCON costs for the buyer: ₦7,500 per standard application (2023 schedule; whether one fee covers one concept or several is unconfirmed). Accelerated tiers cost ₦70,000 / ₦100,000 (16 h / 8 h per MarketingEdge; 2 days / 1 day per Nairametrics). Online approvals reportedly last ~3 months and outdoor (OOH) approvals 12 months; which applies to in-game boards is open (§9.1 #4). If the online rule applies, one approval covers a 12-week flight, so we suggest booking ≥ 4 weeks.

Other geos:

| Geo | Direct CPM (standard / premium) | When |
|---|---|---|
| India | ₹100 / ₹150 (≈ $1.04 / $1.55). A frame is ≈ ₹2.5k/week at 1k CCU and ≈ ₹25k at 10k | Phase 5+, from ~10k CCU, agency-led for brands. Ludo King lists banner campaigns from ~₹20k (a low-confidence marketplace listing). No Indian precedent exists for self-serve in-world frames sold to small businesses |
| Tier-1 (US/EU/UK) | $4–6 | programmatic first; direct only for global brands |
| Everyone else | programmatic or house art | — |

### 6.4 Sanity check against the proven local market

- **Lagos Life:** ₦250k/week buys one 15-s rotation slot. The 43-ad Ikeja Road board was its most crowded (MarketingEdge). TechCabal's unverified count was 244 ads on 40 boards (≈ 6 per board), and many ads were bought at ₦5k–₦50k before the ₦250k price. A board-week is therefore worth ≈ ₦1.5M at average fill (the upper bound is ₦10.75M for the busiest board, if all 43 ads paid ₦250k). At ~110k peak CCU (self-reported; press figures range from ~70k to ~145k) that's **≈ ₦14–98 per peak CCU**.
- **Us:** a Screen Owner at 10k CCU costs ₦857.5k. Only Nigerian players see Nigerian creatives (≈ 3k Nigerian average CCU, ≈ 2.1k billable), so that's ≈ ₦290 per Nigerian average CCU, ≈ ₦410 per billable one, or **≈ ₦140–190 per Nigerian peak CCU**. **Per player, we are ~1.5–14× more expensive than Lagos Life.** The premium rests entirely on capped share of voice (6 frames, not 43), measured delivery and the guarantee. The sales pitch leads with those, and the pilot must test whether buyers pay for them (§8.1).
- **CPM position:** a Frame is priced at ≈ ₦1,500 per 1,000 viewable impressions. That's under Meta Nigeria (~₦2,000) and just above the top of the unaudited Lagos LED range (₦330–1,400). Whole-surface products cost more per viewable impression (Map Pack ≈ ₦2,400, Drop Sponsor ≈ ₦2,250, Hoarding ≈ ₦3,350, Screen Owner ≈ ₦4,430), because they're sold on airtime and frequency, not CPM. At pilot scale, the ₦25k floor puts even a Frame at ≈ ₦3,570, above Meta.

### 6.5 Inventory and revenue scenarios

Revenue is modelled bottom-up as a deals funnel, because sales capacity, not inventory, is the constraint: **revenue = active advertisers × average monthly spend × net factor**. Every input is an *assumption* until the pilot measures it.

| | Pilot (≈ 500 CCU, ≤ 1k peak) | 1k CCU (launch) | 10k CCU | 50k CCU |
|---|---|---|---|---|
| Billable NG CCU (§6.1) | 90 | 210 | 2,100 | 10,500 |
| Frame price / week | ₦25k (floor) | ₦25k (floor) | ₦245k | ₦1.23M |
| NG units on sale | 12 Lagos Market frames + 3 Strip Packs + 2 Hoardings | 42 frames + 6 Strip Packs + 9 single-owner surfaces + Drop Sponsor | same | same |
| Billable NG viewable impressions / day (all units on sale) | 26k | 194k | 1.9M | 9.7M |
| Ceiling: value at 100% sell-through / month | ₦3.3M ($2.4k) | ₦10.6M ($8.0k) | ₦104M ($78k) | ₦522M ($392k) |
| Active advertisers (*assumption*) | 4–8: one part-time seller closes 2–4 a month; 4-week flights; 50% renew | 5–10 | 10–20 | 15–30 brands or agencies |
| Average spend per advertiser / month (*assumption*) | ₦100–200k | ₦100–250k | ₦1–1.5M | ₦3–6M |
| **Gross direct NG revenue / month** | **₦0.4–1.6M ($300–1.2k)** | **₦0.5–2.5M ($380–1.9k)** | **₦10–30M ($7.5–23k)** | **₦45–180M ($34–135k)** |
| Zero-demand case | ₦0: the pilot may sell nothing | ₦0 | — | — |
| Net factor | ×0.75: −15% agency commission where used, ~1.5% Paystack, ~10% seller commission | ×0.75 | ×0.75 | ×0.75 |
| Sales and ad-ops cost / month (estimate) | $150–300 seller base + reviewer hours | $150–300 + reviewer hours | ≈ $1.5–3k (1 ad-ops + 1–2 sellers; get Lagos salary quotes) | ≈ $4–8k |
| Programmatic, non-NG only (§6.6) | n/a | n/a: no live partner until Phase 5; partner minimums are unpublished and depend on DAU in key ad markets, not CCU | ≈ $2k–9k; could be ~$0 | ≈ $10k–46k; could be ~$0 |
| Hosting bill | $350–800 (09 Stage 1: ≤ 1k peak) | $600–1,200 (estimate: 1k average ≈ 1.5–2k peak, above Stage 1) | $3–6k (09 Stage 2) | $12–25k (09 Stage 3) |

- **Basis.** Month = 4.345 weeks. Gross is before discounts (4-week −10%, 12-week −20%), agency commission and fees. The ceiling row covers all units on sale, including the Drop Sponsor.
- **Eligible buyers.** Assuming minors play rules out betting, lending, crypto and alcohol, a large share of Nigerian digital ad spend that Lagos Life (18+ terms) could take. The bands assume telcos, FMCG (brand-led), delivery and mobility apps, music labels and distributors, fashion and retail, payment apps (no credit), insurance and edtech. The pilot target list is built from these.
- **Programmatic** never serves Nigerian traffic (ARCON s.54 needs approval for every creative shown to Nigerians). Conservative case: India 5% fill at $0.30 and others 15% at $0.50, 40% net. Planning case: India 10% fill at $0.40 (inside the §6.6 floor) and others 30% at $1, 50% net. No public intrinsic CPM or fill data exists for India, so only a live test will tell. Programmatic is left out of every G1 and hosting-coverage comparison until a live test shows fill.
- **What this means.** At pilot and 1k scale, direct sales cover anywhere from nothing to about one hosting bill, so the pilot's job is validation, not paying for servers (G1). From ~10k CCU, modest direct sales cover hosting several times over. At every scale the constraint is how many advertisers one or two people can sell to and review.

### 6.6 Programmatic fill: when and with whom

| Partner | Web / Three.js support | Status |
|---|---|---|
| **Anzu via Playgama Bridge** | JS SDK in beta (Anzu–Playgama partnership announced 19 Nov 2025; access by support ticket); Three.js examples listed; the game reports angle, coverage and viewability, which §4.6 already computes; a self-hosted path exists | integration spike after the full-stack gate (§8.1); revenue share and minimums unpublished |
| Adverty | web-game product (May 2025); tech not named | ask |
| Frameplay | only the legacy Unity v2 SDK lists WebGL | no |
| Gadsme, AdInMo | no WebGL support found | no |
| Bidstack | went into administration (Mar 2024); site down | no |

Programmatic switches on in a geo only when **all** of these hold:
1. The partner confirms raw Three.js support, a COPPA/contextual-only mode (`isCoppaRegulated: true`) that has real demand, and **non-exclusive** coexistence with our direct frames on the same surfaces.
2. Its creatives respect our category list (partner-side blocking).
3. Traffic meets the partner's minimum. These are unpublished; as a proxy, Bidstack used to require ≥ 10k DAU in key ad markets.
4. Direct sell-through in that geo has been < 50% for 2 months, or we don't sell direct there.
5. Floors are $0.30–0.50 in India and ~$2 in tier-1. Below the floor, show house art.
6. EU/UK players have given consent through the consent banner (13 #636) before any partner call. Never in portal builds.
7. **Per-creative pre-approval.** Every new partner creative waits in our `apps/admin` queue and serves only after a human approves it (rule 9, G5). If the partner can't do this, there's no programmatic.
8. **Server-side or self-hosted integration only.** No partner script in the game page (the strict CSP in 10 §6), and no player IP or device data sent to the partner. Otherwise programmatic stays off for unknown-age and under-18 players in India (DPDP s.9(1) parental consent) and the US (COPPA third-party disclosure). Any partner domain goes through the CSP review.
9. **Never Nigeria.** Programmatic never serves NG traffic.

**Timeline:** an integration spike (no live demand) once the full-stack gate is met; live for non-Nigerian geos in Phase 5+ (§8).

---

## 7. Compliance

### 7.1 Nigeria

**ARCON pre-exposure approval.**
- **The law:** ARCON Act 2022 s.54 makes it an offence for anyone (sponsor, beneficiary, or whoever places the ad) to expose an ad "in any medium" to Nigerians without Advertising Standards Panel (ASP) approval.
- **The courts:**
  - *Digi Bay v AGF* (Apr 2025) confirmed that ARCON can regulate ads on any platform.
  - Fines can follow only a conviction (*Digi Bay*; *Facebook Nigeria v ARCON*, Jul 2026).
  - *Massilia Motors* and *GODEC Power* (both Nov 2025) conflict on whether prior approval is constitutional. *Massilia* concerned outdoor ads and local-government powers, not prior approval of all media.
- **Live enforcement:** ARCON still issues ₦1m notices for unapproved online ads (BusinessDay, Mar 2026). They are likely void without a conviction, but takedown demands and prosecution risk remain.
- **The gaps:** no rule mentions in-game ads, and no report says Lagos Life obtained approval.

**Our rules:**
- Every Nigeria-targeted creative needs an **ASP Certificate of Approval** number. We check it and keep a copy for 2 years. Flights end before the approval expires. Online approvals reportedly last ~3 months and OOH approvals 12 months (on a different fee schedule); which applies to in-game boards is open (§9.1 #4).
- Fees (2023 schedule, still the latest found): ₦7,500 per standard application (7 working days; whether it covers one concept or several is unconfirmed). Accelerated tiers: ₦70,000 / ₦100,000 (16 h / 8 h per MarketingEdge; 2 days / 1 day per Nairametrics).
- Advertisers without approval go through an ARCON-registered agency partner (the creative + filing bundle, §5.3). Nigerian counsel must say whether we can file for them, and whether we need to register as a media owner (§9.1).
- Nigerian talent only in Nigeria-targeted creatives (ARCON's 2022 rule) → R12.

**Other Nigerian law:**
- **Category laws:** tobacco ads are banned outright (Tobacco Control Act 2015). Promoting unregistered crypto schemes is an offence under the ISA 2025. Digital lenders fall under the FCCPC 2025 rules, and gaming ads under the ARCON–state regulators code (from 1 Apr 2026). All of these are prohibited categories for us anyway (§3.7).
- **NDPA 2023 + GAID 2025:** children's data needs parental consent; direct marketing and cookies or similar trackers need consent.
  - **Ad measurement uses pseudonymous, match-scoped tokens that are never linked to accounts and are deleted within 24 h** (§4.7): no profiling, no cookies, a memory-only session nonce, no stored IP addresses, aggregation within 24 h.
  - Counsel to confirm that this keeps ad measurement outside the consent requirement (13 #719).
  - We'll likely need NDPC registration as a data controller of major importance anyway, because of player accounts.
- **FCCPA:** no misleading ads; paid placements are disclosed (the AD chip).

### 7.2 India

- **ASCI Code:** covers the internet; minors are under 18; ads must not harm or exploit them.
- **CCPA Misleading Ads Guidelines 2022:** penalties of ₹10–50 lakh, no surrogate ads (we prohibit surrogates and brand extensions, §3.7), and limits on junk-food ads aimed at children (we show no identifiable HFSS products anywhere). The CCPA's **dark-patterns guidelines** also ban disguised ads (the AD chip and R14 cover this).
- **Promotion and Regulation of Online Gaming Act 2025** (in force 1 May 2026): advertising online money games is an offence (up to 2 years and/or ₹50 lakh), with no knowledge defence, so it's a prohibited category. Our cosmetics-only game is an "online social game", so it can advertise itself and run ads.
- **COTPA** bans tobacco ads, and alcohol and surrogate ads are restricted: both prohibited for us.
- **DPDP Act s.9** bans tracking, behavioural monitoring and targeted ads directed at under-18s, with penalties up to ₹200 crore.
  - **Timing:** the main obligations apply from ~May 2027, but MeitY has proposed bringing the deadline forward to ~13–14 Nov 2026. That was still unconfirmed at 17 Oct 2026 (check the Gazette). **Plan India on the November 2026 date.**
  - A contextual-only design with account-free measurement should comply. Indian counsel must confirm whether per-session viewability counting for under-18s is "tracking or behavioural monitoring" under s.9(3) (13 #719).
  - Programmatic would need s.9(1) parental consent unless it's server-side (§6.6 condition 8).

### 7.3 Minors, everywhere

- **Contextual only** (rule 6).
  - **US COPPA:** contextual ads and frequency capping count as "support for internal operations", so no parental consent is needed. The amended rule (compliance from 22 Apr 2026) requires separate consent for third-party targeted ads, which we never run.
  - **FTC native-ads guide:** virtual-world billboards that players recognise as ads need no extra label. We add the AD chip anyway (CARU: ads must be distinguishable from content).
- **No direct exhortation to children** (EU UCPD Annex I no. 28; also ASCI and CARU) → R08. This binds our own house art too.
- **No click-outs in matches**, no URLs, QR codes or phone numbers; handles are checked for minor-safe destinations (§5.5).
- **Proof of play never shows players' names, chat or clan tags** (§4.7).
- **UK:**
  - The less-healthy food ad ban covers paid in-game ads from 5 Jan 2026. We go further: no identifiable HFSS products in any geo (§3.7).
  - The Children's Code wants profiling off; we never profile.
  - Gambling ads are banned for us everywhere.

### 7.4 EU, UK and the DSA

- **DSA ad rules:** Art. 26 (ad labels, who paid) and Art. 28 (no profiling-based ads to minors) likely don't apply to us. Micro and small enterprises are exempt (Art. 19), and with chat off by default we may not be an "online platform" at all. We meet both anyway: the AD chip, advertiser names on the Sponsors page, and no profiling.
- **Political ads** are a banned category for us. (EU Regulation 2024/900 applies wherever the provider is based.)
- **Storage and access on the device:**
  - **EU:** ePrivacy Art. 5(3) as read in EDPB Guidelines 2/2023: client-side measurement may count as accessing information on the device.
  - **UK:** PECR reg. 6 as amended by the Data (Use and Access) Act 2025. Counsel to confirm whether aggregate ad measurement falls under a consent exemption.
  - Until then, in the EU and UK the client sends delivery batches only with analytics consent; otherwise delivery is modelled (§4.7). Programmatic runs only with consent.

### 7.5 Tax and invoicing

| Item | Rule | Our handling |
|---|---|---|
| Nigeria VAT | 7.5% (Nigeria Tax Act 2025, from 1 Jan 2026). Small-business relief applies at turnover ≤ ₦100m **and** fixed assets ≤ ₦250m, excluding professional services (whether ad sales count is unconfirmed). ₦50m is KPMG's reading of the income-tax small-company definition, not the VAT threshold | register voluntarily before the pilot: corporate buyers want VAT invoices, and input VAT is claimable |
| Nigeria WHT | advertisers may deduct it (the rate for ad services is unverified); small-company payers are exempt if we have a TIN and the payment is ≤ ₦2m/month | TIN on invoices; accept WHT credit notes; model cash as invoice × (1 − WHT) until they arrive (§5.4); prices exclude VAT |
| Nigeria e-invoicing | NRS MBS mandatory for < ₦1bn turnover from 1 Jul 2027 | invoices integrated by then |
| Offshore seller | foreign suppliers of digital ad services must register for Nigerian VAT, or the buyer withholds it | choose the legal entity first (§9.1) |
| India GST | online ads are an OIDAR service: GST-registered buyers self-assess 18% IGST (reverse charge); sales to unregistered buyers need our own registration (REG-10) | require a GSTIN in self-serve until we register; the 6% equalisation levy was abolished on 1 Apr 2025 |
| EU VAT | B2B reverse charge | collect the buyer's VAT ID |

### 7.6 Platforms

- **CrazyGames:** only ads requested through its SDK.
- **Poki:** its SDK only, and no unapproved promotions.
- **Playgama:** no third-party ads in the games it distributes.

So billboards show house art in every `portal` build (rule 10), including the open beta on CrazyGames (12 §2). App stores (later): re-check their ad and kids-category policies.

### 7.7 Who is responsible for what

| Area | Advertiser | Studio (us) | Others |
|---|---|---|---|
| Truthful, lawful creative; substantiated claims | **owns** (warranty + indemnity) | reviews | — |
| Rights to logos, people and music in the creative | **owns** | checks obvious issues (R07) | — |
| ARCON approval (Nigeria) | **obtains** | verifies the certificate; blocks if missing or expired | ARCON-registered agency partner if needed |
| ASCI/CCPA compliance (India) | **owns** | reviews | agency partner |
| Category eligibility | declares | **decides** (§3.7) | — |
| Handle and brand destination | declares; must own the handle | checks at review and weekly (§5.5) | — |
| Placement safety, readability, size, labels | — | **owns** (rules 1–12, lint, readability gate) | — |
| Review before exposure; takedowns | — | **owns** | — |
| Programmatic creatives | — | **pre-approves every one** (§6.6) | partner blocks categories |
| Measurement accuracy, reports, make-goods, disputes | raises disputes within 30 days | **owns** (§5.9) | programmatic partner for its own demand |
| Data protection (account-free measurement) | — | **owns** (controller) | payment providers for card data |
| Payments, KYC, chargebacks | pays | merchant | Paystack / Flutterwave / Razorpay / Stripe |
| VAT/GST invoices; WHT certificates | provides tax IDs and WHT credit notes | **issues invoices**, files VAT | accountant |
| Legal opinions (ARCON scope, licensing, NDPA, DPDP s.9) | — | commissions them | Nigerian and Indian counsel |

---

## 8. Rollout and success metrics

### 8.1 Phases (12 §2, 15 §2)

**Why a thin pilot.** The full stack (client mask pass, bounds validation, signed manifests with push revocation, automated proof of play, self-serve portal, dashboard) is roughly 2–4 engineer-months (estimate), against pilot revenue of about $0–1.2k a month. Scope creep is already rated High (12 §4), so ad work stays off the alpha critical path and the full stack waits for proof of demand.

| Phase | Ads work | Gate to move on |
|---|---|---|
| **Phase 2 — Alpha** (Wave 2 builds Lagos Market + Mumbai Local) | `AdSlot` entity + lint (lint #7 once playtest heatmaps exist); billboard structures (junction tower, flyover, gantry) with `AdSlot` placeholders in the Lagos Market and Mumbai Local kits; shared house pools; the array-texture renderer on house art (late Wave 2). No measurement and no sales | ≤ 0.2 ms frame cost on the reference iGPU; in a blind A/B, testers rate readability equal (≥ 4/5) with and without boards |
| **Phase 3 — Beta / soft launch: thin pilot** (the Wave 3 item) | **Entry gate:** a Nigerian entity and bank account (Paystack settlement) and counsel opinions under way. **Nigeria only, 2 maps, premium units only** (12 Lagos Market frames, 3 Strip Packs, 2 Hoardings); hand-sold by one part-time seller; full price + founding added value; 4-week minimum; ARCON certificate required. Signed weekly manifest + manual kill switch; review in `apps/admin` (two reviewers for first creatives, language coverage, seller ≠ approver); automatic suspension on reports; server bounds reported as **estimated viewable impressions (server-modelled, unaudited)**; Paystack payment links + invoice template; weekly PDF with privacy-mode clips; guarantee = 50% of the model, made good by extension only. **20% house-art hold-out**, pre-registered as a non-inferiority test with a 1-point D7 margin; readability survey; Ranked on house art | ≥ 5 paying advertisers; zero harmful ads reach players; ≥ 50% renew; delivery reported on 100% of flights; server estimate within ±25% of a sampled replay recount; hold-out: no statistically significant D7 drop at the achieved sample size (confidence interval reported), plus readability-survey and K/D parity; willingness to pay measured (the share of pitched businesses that buy at the index price, and their objections) |
| **Phase 4 — Launch** | Hand-selling continues. Published index card (naira + USD); Mumbai Local inventory; Drop Sponsor (yard) with the ≤ 200 KB queued prefetch; Stripe for USD buyers; hold-out drops to 5%; guarantee becomes 70% of measured. **The full stack starts only after ≥ 8 paying advertisers, ≥ 50% renewal and ≥ ₦1.5M/month gross:** client mask measurement, automated privacy-mode proof of play, self-serve portal, dashboard, Map Takeovers | review SLA met 95% of the time; ≤ 1 h to automatic suspension and ≤ 24 h to a human decision; Nigerian sell-through ≥ 10% of units on sale; ads ≥ hosting net of sales cost by launch + 3 months (G1) |
| **Phase 5+ — Seasons** | programmatic spike, then live for non-Nigerian geos (§6.6, server-side only); India direct via an agency (~10k CCU); Motion creatives and the sky airship; mobile web (S2: the touch HUD's rects feed the mask automatically); Highrise inventory | the §6.6 conditions |

- **Hold-out sizing.** With D7 ≈ 8%, 80% power and α = 0.05, detecting a 1-point difference needs ≈ 7.2k hold-out users and ≈ 36k new web-build users in total at a 20% hold-out (≈ 121k at 5%). Most pilot inventory shows house art anyway, so a large hold-out costs little. If the pilot falls short of that sample, report the confidence interval and don't claim parity.
- **Cross-plan follow-ups.** The Wave 2 queue (15 §5) should list 13 #704–707 next to the Lagos Market and Mumbai Local maps, and W8 should model the billboard structures with `AdSlot` placeholders while building the Lagos Market kit, so they aren't retrofitted.

### 8.2 Success metrics

| Metric | Target |
|---|---|
| Ad revenue ÷ hosting bill | ≥ 0.5× gross during the pilot; ≥ 1× **net of sales cost** by launch + 3 months (at ≥ 1k CCU); ≥ 3× gross at 10k CCU. Programmatic excluded until a live test shows fill |
| Nigerian sell-through (units on sale) | ≥ 10% by launch + 3 months; ≥ 20% by S2 |
| Advertiser renewal | ≥ 50% |
| Harmful ads seen by players | 0 (any → post-mortem) |
| Review SLA / takedown SLA | ≥ 95% within 1 business day / ≤ 1 h to automatic suspension, ≤ 24 h to a human decision |
| Flights meeting the guarantee without an extension | pilot: delivery reported on 100% of flights; from Phase 4: ≥ 90% |
| Measurement accuracy | pilot: server estimate within ±25% of a sampled replay recount. Full stack: ±5% vs replay ground truth **per format** (4:3 and 6:1); < 0.5% of claims rejected by server bounds |
| IVT removed | < 5% |
| Player impact (hold-out) | no statistically significant D7 drop (CI reported); ≤ 10% say "ads bother me" in surveys; no shift in K/D or readability ratings |
| Frame cost | ≤ 0.2 ms on average on the Low reference machine; mask frame ≤ 0.5 ms at p99 |
| Ad bytes per match | ≤ 1.6 MB on the first match of the week, ~0 after (Service Worker cache); 0 on Save-Data and slow connections |

### 8.3 Checklist

The checklist lives in **docs/13 §Y** (items 704–739: 4 MVP, 22 L, 10 P). The review draft's AD codes map as follows: AD01 → 704, AD02 → 706, AD03 → 707, AD04 → 730, AD05 → 711, AD06 → 708, AD07 → 714–715, AD08 → 717–718, AD09 → 716, AD10 → 719, AD11 → 732, AD12 → 733, AD13 → 720, AD14 → 721, AD15 → 735, AD16 → 736–738. The other items (705, 709–710, 712–713, 722–729, 731, 734, 739) are new from the review.

---

## 9. Open questions and sources

### 9.1 Open questions for the owner

| # | Question | Why it matters | Default if nobody decides |
|---|---|---|---|
| 1 | Is "500" ₦500, ₦500k or $500? Per week or per month? Per frame or per whole screen? | changes the price by ~1,000× (₦500 vs ₦500k) to ~1,300× (₦500 vs $500), and by more once the period is factored in | the index card (§6.3); ₦500 rejected. Read as ₦500k or $500 per whole screen per month, it's the card at ~1.3k / ~1.8k CCU (§6.2) |
| 2 | Who sells, for how many hours a week, with what Lagos presence and WhatsApp line? | sales capacity limits revenue (§6.5) | 1 part-time seller in the pilot |
| 3 | Legal entity: Nigerian company, offshore, or both? | Paystack settlement, VAT, ARCON standing, Razorpay | a Nigerian entity and bank account before the pilot (a hard gate, §5.4; 12 §3 #9) |
| 4 | ARCON: do in-game ads count as online media (~3-month approvals) or outdoor (12 months)? Is vetting per creative or per placement? Do we need a media-owner licence? Can we file for advertisers? | compliance cost and pilot design | require advertiser certificates; counsel opinion before the pilot |
| 5 | India: an entity or an agency for Razorpay and GST? ASCI membership? | India is ~45% of players in the model | house art in India until Phase 5 |
| 6 | Click-throughs ever (e.g. for age-confirmed adults, or on the website Sponsors page)? | advertisers value clicks; risk for minors | no in-game clicks; Sponsors page on the website |
| 7 | A player opt-out for billboards? | players hated ads in genre classics (01 §1) | no toggle (streamer mode only); if surveys exceed 10%, a free setting for every player, never a paid perk (rule 12) |
| 8 | What are the real Nigerian and Indian shares of **web-build** CCU, and the deliverable share? | every forecast and price scales linearly with them | measure them during the Phase 2 closed alpha and re-base before quoting any price; until then 30% Nigeria and 0.71 deliverable, with the §6.1 sensitivity table |
| 9 | Music or club sponsorships like Lagos Life's ₦50k song plays? | audio is a gameplay channel (footsteps, gunfire) | no |
| 10 | Pilot inventory: premium units only, or more? | visible scarcity vs supply | premium only (§2.4) |
| 11 | Will buyers pay airtime prices for whole surfaces (Screen Owner 3.5×, Hoarding 3×)? | their viewable CPM is 1.7–2.2× Meta's | test in the pilot; fallback ~1.5× (§6.3) |
| 12 | Before brand and agency sales at scale: an independent methodology review, or a vendor whose measurement agencies already accept? | agencies expect IAS/DoubleVerify-style verification, which doesn't support a custom Three.js renderer | an independent methodology review first |

### 9.2 Sources

**Lagos Life and comparable games**
- Lagos Life ad page (read 17 Oct 2026): https://lagoslife.app/advertise
- Techpoint, 1M players and launch pricing: https://techpoint.africa/news/lagos-life-1m-players/ · valuation and revenue: https://techpoint.africa/news/lagos-life-10m-valuation/
- TechCabal, ad counts and running costs (from search extracts; direct fetch returned 403): https://techcabal.com/2026/10/12/lagos-life-advertising-revenue-running-costs/
- Zikoko (billboards the most profitable line): https://www.zikoko.com/?p=385538 · WeeTracker: https://weetracker.com/?p=91086 · Condia (Vatar raise): https://thecondia.com/vatar-lagos-life-raises-500000-pre-seed
- TechCityNG: https://www.techcityng.com/lagos-life-game-explained/ · TechScribe: https://techscribeng.wordpress.com/2026/10/07/lagos-life-sim-style-web-game-crosses-1m-players-in-3-days-as-virtual-billboards-foot-the-bill/ · MarketingEdge (the 43-ad Ikeja Road board): https://marketingedge.com.ng/lagos-life-turns-virtual-lagos-into-a-new-frontier-for-brand-marketing/
- FIJ, the illegal ads and their removal: https://fij.ng/article/spotted-viral-lagos-life-game-hosts-illegal-website-pimping-sex-workers/ · https://fij.ng/article/after-fijs-story-lagos-life-game-scrubs-off-illegal-pimping-website-ad/
- Innovation Village (terms, 18+, no view guarantee): https://innovation-village.com/lagos-life-game-draws-scrutiny-over-virtual-currency-payments-and-player-data/
- Elev8 Media buys in: https://brandcom.ng/2026/10/12/elev8-media-takes-ads-to-lagos-lifes-virtual-city/ · Chowdeck: https://www.techloy.com/lagos-life-nigerian-browser-games/
- Earlier Nigerian games' monetisation (Aboki Run, Gidi Run, Kuluya, Maliyo): https://technext24.com/3en1 · Nairobi X: https://www.standardmedia.co.ke/amp/entertainment/article/2000166847/n-a
- Ludo King × Tata (AnyMind): https://anymindgroup.com/tata-ace-pro · Ludo King ad rates (low confidence): https://www.themediaant.com/digital/ludo-king-app-advertising · BGMI integrations: https://www.storyboard18.com/gaming-news/exclusive-krafton-india-tests-user-appetite-for-in-game-advertising-push-amid-bgmi-brand-integrations-88328.htm · Real Cricket × Bidstack: https://www.pocketgamer.biz/news/74589/bidstack-nautilus-mobile-in-game-ads-real-cricket/

**Standards**
- IAB/IAB Tech Lab/MRC Intrinsic In-Game Measurement Guidelines 2.0 (Aug 2022): https://www.iab.com/wp-content/uploads/2022/08/In-Game-Advertising-Measurment-Guidelines_08.31.2022.pdf
- IAB creative guidelines for advertising in gaming (Mar 2024; §4.3.1.3 on web addresses and QR codes, placement counts, frequency caps, minimum sizes): https://www.iab.com/wp-content/uploads/2024/03/IAB_Creative_Guidelines_Best_Practices_Advertising_Gaming_March_2024.pdf
- MRC field-of-view thresholds reused in AR/OOH standards: https://ppc.land/field-of-view/

**Vendors and platforms**
- Anzu × Playgama (announced 19 Nov 2025): https://gamesbeat.com/playgama-and-anzu-bring-real-world-ads-to-web-games/ · Playgama intrinsic ads: https://wiki.playgama.com/playgama/guides/monetization/intrinsic-ads.md · JS integration: https://wiki.playgama.com/playgama/guides/monetization/intrinsic-ads/javascript.md · payouts: https://wiki.playgama.com/playgama/faq/payments-and-statistics.md
- Anzu without web support (Oct 2024): https://adexchanger.com/gaming/the-in-game-ad-market-is-expanding-one-sdk-at-a-time · placement guide: https://www.anzu.io/blog/in-game-ad-placements-guide
- Frameplay: https://docs.frameplay.gg/unity/unityLegacy/ · https://docs.frameplay.gg/guide/ · Adverty web games: https://www.mfn.se/a/adverty/adverty-leder-vagen-forst-med-in-game-losning-for-webbspel
- Bidstack administration: https://www.exchangewire.com/blog/2024/03/25/acquisition-of-bidstack-ltd-all-operating-subsidiaries/ · DAU minimum: https://create.unity.com/bidstack
- Portal ad rules: https://developers.poki.com/guide/requirements-quality · https://docs.crazygames.com/requirements/ads/
- Image-decoder risk (libwebp CVE-2023-4863): https://nvd.nist.gov/vuln/detail/CVE-2023-4863

**Price benchmarks**
- Meta CPM in Nigeria: https://grey.co/blog/facebook-ads-cost-nigeria · app CPMs by country: https://www.monetizemore.com/blog/how-much-ad-revenue-can-apps-generate/ · AdMob tier-3 eCPMs: https://www.revenuelab.fyi/blog/admob-ecpm-benchmarks-2026
- Intrinsic CPMs (Bidstack 2021, Anzu 2022): https://www.marketingbrew.com/stories/2021/04/14/brands-turned-ingame-advertising-pandemic-f04e · https://www.marketingbrew.com/stories/2022/04/04/anzu-says-it-s-making-it-easier-for-brands-to-advertise-in-games. The 2026 tier-1 direct quotes ($8–25) are low-confidence vendor and advisor figures from the review pass
- Lagos LED and billboard rates: https://viradsmedia.wordpress.com/2025/01/22/affordable-digital-billboard-advertising-rates-in-lagos-outdoor-led-screen-advertising-cost/ · https://oxbillboards.com/blog/how-much-does-a-billboard-cost-in-lagos-2026/ · https://alternativeadverts.com/led-billboards/
- FX: https://techeconomy.ng/dollar-to-naira-exchange-rate-today-october-14-2026 · Google non-personalised ads (coarse geo allowed): https://support.google.com/admanager/answer/9005435
- Desktop vs mobile web share by country (to verify the Nigeria/India assumption): https://gs.statcounter.com/

**Regulation**
- ARCON Act synopsis (Templars): https://www.templars-law.com/app/uploads/2022/11/Advertising-in-Nigeria-A-Synopsis-of-Recent-Regulatory-Developments-VS-edits.pdf · *Digi Bay v AGF*: https://www.mondaq.com/nigeria/social-media/1693214/the-powers-of-the-advertising-regulatory-council-of-nigeria-to-regulate-social-media-posts-a-review-of-the-federal-high-courts-decision-in-digi-bay-limited-2-others-v-attorney-general-of-the-federation-anor-unreported-suit-no-fhclcs12622024-judgment-delivered-on-29-april-2025 · *Facebook Nigeria v ARCON*: https://www.arise.tv/court-voids-arcons-n60bn-sanction-against-facebook-nigeria-over-fair-hearing-breach/ · *Massilia*/*GODEC*: https://brandcom.ng/2025/11/21/just-in-federal-high-court-rules-arcon-has-powers-to-approve-outdoor-advertisement/
- ARCON vetting fees: https://nairametrics.com/2023/05/11/nigerians-to-pay-more-for-social-media-ads-as-arcon-releases-vetting-rates/ · MarketingEdge on the accelerated tiers (16 h / 8 h) and BusinessDay on ₦1m notices for unapproved online ads (Mar 2026): cited in the review pass, links still to add · 2025 directive: https://techpoint.africa/insight/arcon-fight-digital-advertising-nigeria/ · gaming ad code: https://thesun.ng/arcon-regulators-align-to-enforce-single-advertising-code-for-gaming-industry/
- Nigeria tobacco: https://www.tobaccocontrollaws.org/legislation/nigeria/advertising-promotion-sponsorship · digital lending: https://www.thisdaylive.com/2026/04/15/court-stops-fccpc-from-enforcing-digital-lending-regulations-pending-determination-of-suit/
- NDPA 2023: https://www.dataguidance.com/sites/default/files/data_protection_act_2023.pdf · GAID 2025: https://ndpc.gov.ng/wp-content/uploads/2025/07/NDP-ACT-GAID-2025-MARCH-20TH.pdf
- Nigeria tax: VAT https://www.forvismazars.com/ng/en/services/tax/nigeria-s-tax-reform-in-focus/2025-nta-vat-key-business-changes · WHT https://aluko-oyebode.com/insights/deduction-of-tax-at-source-regulations-2024/ · e-invoicing https://www.fonoa.com/resources/blog/nigeria-releases-phased-rollout-plan-for-e-invoicing · non-resident VAT https://guardian.ng/business-services/nigeria-introduces-stricter-vat-rules-for-digital-services-foreign-suppliers/
- India: Online Gaming Act 2025 https://www.indiacode.nic.in/bitstream/123456789/22148/1/a2025-32.pdf · ASCI Code https://iprmentlaw.com/wp-content/uploads/2018/03/ASCI-Code.pdf · CCPA guidelines https://khaitanco.com/thought-leaderships/CCPA-releases-guidelines-for-Prevention-of-Misleading-Advertisements-and-Endorsements-for-Misleading-Advertisements-2022 · DPDP Schedule https://dpdpa.com/theschedule.html · DPDP timeline (and the proposed Nov 2026 deadline) https://india-briefing.com/news/india-dpdp-compliance-timeline-enforcement-2026-27-44740.html · GST/OIDAR https://www.india-briefing.com/news/oidar-compliance-india-gst-registration-ntor-rules-gstr5a-digital-tax-43951.html/ · equalisation levy https://yourstory.com/2025/03/equalisation-levy-online-advertisements-abolished-google-meta-x-ads
- US: COPPA 16 CFR 312.2 https://www.law.cornell.edu/cfr/text/16/312.2 · 2025 amendments https://jonesday.com/en/insights/2025/05/ftc-finalizes-amendments-to-coppa--rule · FTC native advertising guide https://www.ftc.gov/business-guidance/resources/native-advertising-guide-businesses
- UK and EU: HFSS ad ban https://www.iabuk.com/news-article/less-healthy-food-and-drink-ad-ban-what-it-how-it-works · DSA Art. 19 https://prighter.com/resources/laws/dsa/articles/article-19 · Art. 26 https://www.springlex.eu/en/packages/dsa/dsa-regulation/article-26/ · Art. 28 https://www.springlex.eu/en/packages/dsa/dsa-regulation/article-28/ · political ads regulation https://cm.twobirds.com/en/insights/2025/the-eu-political-advertising-regulation-what-you-need-to-know · EDPB 2/2023 https://edpb.europa.eu:443/system/files/2024-10/edpb_guidelines_202302_technical_scope_art_53_eprivacydirective_v2_en_0.pdf · UCPD and children https://schoenherr.eu/content/advertising-directed-at-children · UK PECR as amended by the Data (Use and Access) Act 2025 (counsel to confirm the exemptions)

**Our model:** the exposure simulation (camera random walk + IAB rules) and the pricing maths behind §6, run and re-run on 17 Oct 2026 (§2.3 placements, warm-up yard, billable-CCU netting). The assumptions are listed in §6.1 so the model can be rebuilt under `tools/` and re-run on pilot telemetry.
