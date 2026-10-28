# 17 — Store, Currency & the Forge

> The owner's decisions, 28 Oct 2026, after research on pay-to-win backlash, loot-box law and creator economies:
> - **The game is 18+.**
> - **It has its own premium currency.** No cash-out, no transfers, no trading for money.
> - **Gun skins and looks are sold on some guns the way the big military shooters sell them,** always with the same stats as the base gun. Maybe a separate "battleground" playlist for them.
> - **Custom guns:** every gun's stats stay the same, but a player (with their AI, e.g. Claude Code) designs the **look**. We sell **loadout space**: one custom look is free, more slots are bought.
> - **No paid random packs. No player code is ever executed. No real gun trademarks.**
>
> And the first thing to try: "let's try a gun skin to see if we can, a nice k-47 that looks fictionistic and magical" (owner, 28 Oct 2026).
>
> Later the same day, after the first K-47 mock-ups:
> - **Paid skins can reshape the gun, blueprint style:** "maybe the gun look changes but it's the same gun you know how cod does it". Floating particles and smoke around the gun were "too much"; glow stays subtle (seams, a magazine window). Rules in §3.6.
> - **Kill effects everyone sees:** "when they kill someone the kill animation too so everyone can see". A skin line's top tier carries a kill effect that plays where the victim falls. Rules in §3.7.

This doc is the spec for all of that. It replaces the two-currency plan (Coins + Gems) in the old 01 §10. **Cosmetics never change stats** (01 §2 pillar 3, 03 §1, 04 §1) is unchanged; this doc adds the rules that keep *looks* fair too.

The 18+ gate and the terms page are built in a separate session (apps code and docs/10 are not touched here).

---

## 1. Principles

| # | Principle | Means |
|---|---|---|
| 1 | **Same gun, every time** | a skin, a Forge look or a paid character never changes damage, rate, spread, range, reload, handling, hitbox, speed or fuel. The sim never reads a cosmetic id |
| 2 | **Same read, every time** | an enemy sees and hears the same gun and the same soldier whatever it wears: silhouette, muzzle flash, tracer, sound and contrast pass the §3.4 review |
| 3 | **You know what you pay** | every price shows the local money price next to the currency price. No random items for money, ever |
| 4 | **Money stays money** | currency never leaves the game: no cash-out, no transfer, no trading, no marketplace for money |
| 5 | **Data, not code** | a custom look is a JSON spec of our parts, dyes, decals and FX. Nothing a player sends is ever run |
| 6 | **Skill can't be bought** | mastery, rank and event looks are earned only. Gold is for mastery (03 §5) |

---

## 2. The currency

### 2.1 One currency

There is **one premium currency**. It is bought with money and also earned in small, fixed amounts by playing. There is **no second "soft" currency**: earned unlocks (levels, mastery, missions) grant items directly, so there is one balance to explain and one ledger to audit (open question Q2).

**Name options** (in the game's voice: forge, brass, the armoury). Each still needs a screen against other games' currency names and trademarks (Q1).

| Option | Shown as | Why | Against |
|---|---|---|---|
| **Brass** *(recommended)* | `1,000 Brass` · icon: a spent casing | it's what every gun in the game leaves on the floor; soldier slang for money and for officers | "brass" also means rank, which is fine for a military game |
| **Ingots** | `1,000 Ingots` · icon: a stamped bar | ties straight to *Forge*; reads as "raw material you make looks from" | longer word on small buttons; less soldier-voiced |
| **Tags** | `1,000 Tags` · icon: a dog tag | soldier-voiced, short, iconic | dog tags also mean kills/deaths in many shooters; could confuse with kill confirms |

The rest of this doc says **Brass** as a placeholder.

### 2.2 Prices always in money too

- Every price in the store, the battle pass and the Forge shows **the currency price and the local money price**: `1,050 Brass (≈ ₦X / $9.99)`. Naira for Nigeria, USD as the default, local currency where the payment provider supports it (13 #531, #653). This follows the EU CPC key principles on in-game currencies ([99](99-sources.md#store-currency--the-forge-17)).
- The money shown for an item is what that item would cost from the **cheapest bundle that covers it**, rounded, and marked "≈".
- Regional price tiers, not FX conversions (13 #531). A tier change never changes what a player already owns.

### 2.3 Bundles (draft, USD tier)

Item prices are set **on bundle sizes**, so a player can buy exactly what an item costs and is not left with an unusable remainder (the "buy-what-you-need" rule, 13 #525).

| Bundle | Brass | USD | Bonus | Notes |
|---|---|---|---|---|
| Starter | 250 | $2.49 | — | the price of one Wrap |
| Small | 500 | $4.99 | — | one Skin, or one Forge slot |
| Medium | 1,050 | $9.99 | +5% | the premium battle pass |
| Large | 2,200 | $19.99 | +10% | |
| Crate | 5,750 | $49.99 | +15% | the largest; no bigger bundle (spend limits, §2.6) |

The naira tier is set from local price research before the pilot (Q3).

**How Brass is earned (fixed, published amounts):**

| Source | Amount | Notes |
|---|---|---|
| Battle pass, free track | ~250 per season | a taste, so free players can buy a Wrap a season |
| Battle pass, premium track | ~700 per season | less than the pass costs (1,050): the pass doesn't pay for the next one (Q4) |
| Account levels | 25 every 5 levels | 500 over 100 levels |
| First win of the day | no Brass | XP only: no grind incentive for currency |
| Rewarded ads | no Brass | ads grant XP, a reroll or a fixed daily item, never currency (§7) |

### 2.4 No cash-out, no transfer, no trading

- Brass **can't be withdrawn, sold, converted, or sent** to another account. Items can't be traded or listed. There is no marketplace for money.
- **Gifting** (13 #542, P) gives an **item**, paid at the moment by the giver in money or their own Brass, to a friend of ≥ 30 days; the item is bound to the receiver. Never a balance transfer.
- The terms say Brass is a **licence to use content**, has no money value outside the game, and isn't property (another session writes the terms page). This also keeps the game clear of India's 2025 online-gaming act (no stakes, no winnings) and of gambling law (no randomness, no cash-out).
- Accounts can't be sold; selling one is a terms breach (10 handles account abuse).

### 2.5 The ledger

Every Brass movement is a row in an **append-only, double-entry ledger** in Postgres (06 §7):

| Field | Meaning |
|---|---|
| `id`, `at` | row id and server time |
| `account`, `delta`, `balanceAfter` | signed amount and the running balance |
| `pool` | `paid` or `earned`: the two are kept apart for refunds, tax and revenue recognition |
| `kind` | `purchase`, `grant` (battle pass, level), `spend`, `refund`, `chargeback`, `makegood`, `adjust` (staff, needs a reason and a second approver) |
| `ref` | the provider transaction id, the item id or the ticket id. **Unique per kind**: replaying a webhook can't grant twice |

- **Spend order:** earned Brass first, then paid. That keeps paid Brass refundable longest.
- **Server-authoritative:** the client shows a balance; only the API spends it, in one transaction with the item grant. The game server never touches the wallet.
- **Reconciliation:** a nightly job checks the ledger sum against each provider's settlement report; a mismatch pages the on-call (13 #598).
- **Wallet cap:** 20,000 Brass. A purchase that would pass it is refused with a clear message.
- **Never expires** while the account exists.

**Make-good rules:**

| Case | Outcome |
|---|---|
| Paid but not delivered (provider success, grant failed) | automatic grant on the next reconcile, ≤ 15 min, plus a note in the inbox |
| An item is changed after sale because it failed the §3.4 review in the wild | the fix ships for everyone; owners may **refund it for the Brass it cost** for 30 days, or keep it (the precedent in §3.5) |
| An item is withdrawn for legal or rights reasons | full Brass refund to every owner |
| A store or pricing error in our favour | refund the difference in Brass |
| Outage during a timed sale | the sale is extended by the outage length |

### 2.6 Refunds, 18+ and spending limits

**Refunds:**
- **Unspent paid Brass:** refundable to the original payment method within 14 days of purchase (the EU withdrawal period, applied everywhere for simplicity; 13 #533).
- **Items:** a self-serve **"Return"** within 48 h if the item hasn't been used in a match (not equipped in any match that started). 3 returns per rolling 12 months. Returned items give the Brass back to the pools it came from.
- **Battle pass:** no refund once a premium tier has been claimed.
- **Chargeback:** the purchased items and the disputed Brass are locked (not the account), a negative balance is allowed, and the player can settle it to unlock. Repeated chargebacks close the store for that account. Fraud goes to 10.

**18+ stance:**
- The game is **18+**. The store, the Forge and Brass need a **signed-in account that passed the 18+ gate** (built in another session). Guests can play, and see the store, but can't buy.
- 18+ doesn't relax any rule here: no paid randomness, real-money prices, refunds and limits stay. Some of our players' countries will still treat a teen who lies at the gate as a minor, and the rules hold up either way.
- Payment providers' own age and KYC checks apply on top.

**Spending limits (on by default):**

| Limit | Default | Change |
|---|---|---|
| Monthly spend cap | **$100** (tier-equivalent in naira) | lower: instant. Higher (up to $500): takes effect after **72 h** and needs re-entering the password |
| Purchase cool-off | after 5 purchases in 24 h, a 1 h pause with a summary of today's spend | can't be turned off |
| Spend history | every purchase, refund and grant with money amounts, last 24 months, CSV export | always on |
| Self-exclusion | lock the store for 30 / 90 / 365 days | can't be undone early |

There is no "spend more" nudging: no fake timers, no "only N left" on items that aren't limited, no notifications about the store unless the player turned them on.

---

## 3. What's sold

### 3.1 The catalogue

| Product | Price (draft) | Where it comes from | Notes |
|---|---|---|---|
| **Gun skins** on the skin-line guns (§3.2) | Wrap 250 · Skin 500 · Forged 1,050 · **Forged + kill effect 2,200** (1,050 to add the effect to a Forged skin you own) | store rotation and bundles | §3.3 tiers; Forged reshapes the gun (§3.6); the top tier adds a kill effect (§3.7); all pass §3.4 |
| **Character looks**: outfits, headgear, jetpacks + trails, backpacks, emotes, victory poses, death and spawn effects, nameplates, banners (kill effects come with gun skin lines, §3.7) | 250–1,050 per item, sets as bundles | store | 04 §3 slots, 04 §7 VFX budgets, §3.4 |
| **Named characters** sold in the store (04 §2, e.g. Boomer) | 1,050 | store | presets only, no gameplay difference |
| **Battle pass** (8–10 weeks) | premium 1,050 | season | **free track for everyone** (cosmetics + ~250 Brass); premium track ~70 tiers; retroactive unlocks on a late purchase (01 §9) |
| **Founder's Pack** | ~$2.99, money only, launch season only | store | a cosmetic set + a profile badge + **1 extra Forge slot** (§4.6). Never sold again |
| **Forge slots** (§4.6) | 1 slot 500 · 3 slots 1,050 | Forge | the first slot is free |
| **Battle pass tier skips** | 250 for 2 tiers | battle pass | cosmetic progress only; never account levels, ranks or mastery (Q5) |

**Never sold:** weapons, stats, XP boosts, ranks, mastery looks (gold and its tiers), ranked rewards, event looks earned by playing, matchmaking priority, anything random (§7).

### 3.2 Which guns get paid skin lines

Skins are sold on **the guns players hold the longest and see the most**, and not on the guns whose look *is* a gameplay signal.

| Gun | Paid skins? | Why |
|---|---|---|
| **K-47** | ✅ **pilot** (§9) | the iconic assault rifle, MVP gun, in every crate; the owner's first ask |
| **Hammer .44** | ✅ | default primary: on every soldier at every spawn (03 §5) |
| **Hawk .50** | ✅ (but its **gold** skin is mastery only) | default sidearm: on every soldier |
| **Widow** | ✅ | the prestige sniper; a big, slow, readable gun with time on screen |
| **Breacher** | ✅ | the close-range staple |
| **Hornet** | ✅ | the most-picked SMG in playtests (check against 16 metrics before committing) |
| Buzz, Rattler, Trident, Bullpup, Longbow | later (P) | mastery skins first (13 #541); paid lines once the six above prove the review |
| Thumper, Popper, Dragon, Arc, Ripper, Pulse, Shredder | ❌ | power and special weapons: their rocket, flame, beam, saw blade and orb **are** the warning. A reskin risks hiding the threat, and they're held for seconds |
| Machete | ❌ | a one-hit weapon: its swing must read the same on every soldier |
| Riot Shield | ❌ | its face and HP state are gameplay signals |
| Grenades and deployables | ❌ | throwables' arcs, timers and mine LEDs must look identical (02 §14) |

Unsold guns still get **free mastery skins** (04 §3 "universal wraps" apply to every gun except the ❌ rows).

### 3.3 Skin tiers

| Tier | What it may change | What it can't | Cost to make |
|---|---|---|---|
| **Wrap** | the material only: albedo pattern, dye channels, finish (matte, satin, metal, anodised) on the base mesh | mesh, FX | cheap (04 §3) |
| **Skin** | the texture + dye mask of the base mesh, plus up to 2 decals and a charm | silhouette, nodes, FX | medium |
| **Forged** (blueprint) | **reshaped parts**, blueprint style: receiver, stock, handguard/barrel shroud, muzzle device, magazine, grip and charm swapped for the line's own (§3.6), inside the base gun's footprint; subtle glow on seams and a magazine window; a custom inspect animation; a reload *sound timbre* | the gun's size and footprint, muzzle, grip and magazine positions, sight read, muzzle flash, the tracer's core (shape, colour, brightness), fire loudness, sound and animation timing, kill-feed icon; **no particles or smoke around the gun** | high; the K-47 pilot's "fictionistic and magical" line is Forged |
| **Forged + kill effect** | everything in Forged, plus the line's **kill effect** (§3.7) on kills with that gun | everything above; the §3.7 limits | Forged + one effect; sold as the line's premium bundle, never on its own |

A skin is content: an item in `content/cosmetics/*.json` with `slot: "weapon_skin"`, the base `weaponId`, `tier`, and its assets, shipped as a content-only deploy (04 §8.6). Its GLB passes `tools/asset-check --kind weapon` against the base gun's nodes (`muzzle`, `offhand`, `eject`: same positions, ≤ 1 cm off), and a Forged skin also passes the blueprint checks (§3.6, `--blueprint-of`). A kill-effect tier names its effect (`killEffect`, an id in `content/cosmetics/kill-effects.json`).

### 3.4 The visual-advantage review checklist

Every paid skin, character look and Forge look passes this before it can be sold or used. **Automated** rows block the build or the Forge submit; **Human** rows are checked by a reviewer in the live preview.

| # | Check | Pass rule | How |
|---|---|---|---|
| V1 | **Stats** | the item has no stat fields; the sim build has no cosmetic imports (dependency lint, 13 #003) | Automated |
| V2 | **Weapon silhouette** | the gun's mesh stays inside the base gun's bounding box +5% on every axis, and fills ≥ 90% of it; the muzzle node is where the base's is (an enemy sees a K-47 as a K-47, and a longer barrel can't poke past cover first). Forged (reshaped) guns meet the tighter §3.6 footprint | Automated (`asset-check`) |
| V3 | **Character silhouette** | the 04 §1.2 envelope and locality rules; no shrinking | Automated |
| V4 | **Muzzle flash** | the base gun's flash shape, scale, light radius and duration. **Hue only** may change, within the allowed set (V7) | Automated (FX params are not in the skin schema) |
| V5 | **Tracers** | the bolt's bright **core** is exactly the base tracer's: its colour, width, length, speed and luminance. A skin may only add a **coloured glow around the core and colour its path line**: a gradient of 2–3 saturated stops (the Galaxy Relic's violet → magenta → aquamarine, head to muzzle), each ΔE ≥ 15 from the reserved colours (V7) and dimmer than the core, the glow at most 2.5× the core's width and empty down its middle (it adds no light where the core draws), the same length and speed (owner, 28 Oct: "yes upgrade it"; until then a skin could only shift the hue within ±10% luminance). A dimmer core hides the shooter; a brighter or wider one blinds the target | Automated |
| V6 | **Sight clutter** | the reticle, zoom view, sniper aim line (03 §5) and HUD can't be skinned. Gun parts can't sit in the line from the shoulder to the reticle at any zoom | Automated (no schema field) + Human |
| V7 | **Reserved colours** | no emissive, tracer or flash hue within ΔE 15 of the team colours, the player's enemy-highlight options, the low-HP and damage cues, pickup glow, grenade warnings, EMP and storm colours | Automated |
| V8 | **Dark looks** | the 04 §8 readability lint against every map palette, run on the **worst-case dye** the player could pick, not just the default. No all-black or near-background combinations | Automated |
| V9 | **Glow** | emissive area ≤ 15% of the gun's (or 10% of the soldier's) screen area at 1× zoom, on seams, glyphs and magazine windows only; intensity capped below the bloom threshold that would wash out a nearby soldier; never *less* visible than the base. **No particles, smoke or shimmer around a gun** (owner, 28 Oct) | Automated |
| V10 | **Camouflage** | no pattern that matches a map palette (foliage greens on Outpost's bushes, snow whites on Snowblind) | Automated per map + Human |
| V11 | **Sound parity** | a skin's fire, reload, draw and footstep sounds against the base's, take by take: loudness (BS.1770 K-weighted, over the whole sound) within **±1 LU**, peak within **±1 dB**, the same frequency band (each octave band holding ≥ 2 % of the energy within ±3 dB of its share, spectral centroid within ±15 %), the **same length to the sample** (so the same tail) and the same timing (reload steps at the same fractions of the reload, the same pitch and level in the mix), the first 4 ms (the crack) the base's own samples at one level, and the same playback (range, far layer, voices, priority), so it is heard exactly as far. Only the timbre changes, and it still reads as that gun by ear (owner, 28 Oct; apps/web `audio/skins.test.ts`) | Automated (loudness, peak, band, length, transient, playback) + Human (identity) |
| V12 | **Animation timing** | reload, swap and inspect animations last exactly the sim's time; recoil kick and camera shake are the base gun's | Automated |
| V13 | **Kill and death effects** | the §3.7 limits and 04 §7 budgets: ≤ 1 s, inside the victim's body envelope, drawn under the dropped weapon, pickups, players and tracers; no full-screen flash, no light past the envelope, no shake; a Reduce flashes / Reduce motion fallback; never looks like a hit marker or a damage arc | Automated (size, time, budget, draw order) + Human |
| V14 | **Kill feed** | the kill feed always shows the base gun's icon | Automated |
| V15 | **Live parity** | after release, the K/D and win rate of owners vs non-owners of the same skill band (16 metrics). A gap above 3% for two weeks reopens the review | Telemetry |

A failed check in the wild follows §2.5's make-good rule: fix it for everyone, offer refunds.

### 3.5 What others got wrong (research, 28 Oct 2026)

Other games are named here only as cited research (01 §12 keeps their names out of everything players see). Each case became a rule above.

| Case | What happened | Our rule |
|---|---|---|
| Call of Duty: Warzone, the "Roze" operator skin (2021) | a near-black battle-pass skin was hard to see in shadows; players called it pay-to-win and Raven raised its contrast in Season 3 ([Charlie Intel](https://www.charlieintel.com/call-of-duty-warzone/warzones-frustrating-roze-skin-finally-nerfed-in-season-3-update-95591/), [NME](https://www.nme.com/news/warzone-community-says-pay-to-win-roze-skin-is-causing-issues-again-3085133)) | V8, V10 |
| Call of Duty: MW2, Dark Rituals III bundle (2023) | a store blueprint carried a thermal optic stronger than the normal one, only available in that paid bundle ([GGRecon](https://www.ggrecon.com/articles/cod-fans-slam-pay-to-win-blueprint-with-op-thermal-optic/)) | V1, V6: skins carry no attachments or sights |
| Call of Duty: Warzone, MAC-10 "Gallantry" blueprint | a paid blueprint was reported to deal ~30% more damage than the base gun until patched ([MeinMMO](https://mein-mmo.de/en/pay2win-in-cod-warzone-paid-weapon-skin-deals-30-more-damage,636539)) | V1: the sim never reads a cosmetic id |
| Call of Duty, paid tracer packs | players said bright paid tracers obscured their view ([Dexerto FR](https://www.dexerto.fr/call-of-duty/des-joueurs-de-warzone-se-plaignent-dun-element-pay-to-win-1260188/), [MeinMMO](https://mein-mmo.de/cod-mw-wz-play-2-win-skin/)) | V5 |
| Fortnite, "Plastic Patroller" (2019) | a green toy-soldier skin hid in foliage; Epic repainted it with mud and a brighter outline and offered buyers a refund ([SVG summary](https://www.svg.com/332345/the-real-reason-these-game-skins-were-banned-or-removed/), [Sportskeeda](https://www.sportskeeda.com/fortnite/fortnite-update-changes-accused-pay-to-win-skin-following-player-outrage)) | V10; the make-good rule (§2.5) |
| Fortnite, "Superhero" custom skins (2021) | a player-coloured all-black variant hid in bushes; Epic changed it, then disabled it ([The Loadout](https://www.theloadout.com/fortnite/superhero-skin-nerf), [GGRecon history](https://www.ggrecon.com/articles/pay-to-win-cosmetics-in-fortnite/)) | V8 on the **worst-case dye**: player-picked colours are the risk in the Forge |
| Valorant's skin rules | Riot keeps the base muzzle flash shape and scale, matches the base silhouette and screen size, keeps sounds no louder or quieter, and lets cosmetic sound yield to gameplay cues ([Riot dev blog](https://playvalorant.com/en-us/news/dev/the-craft-and-fantasy-of-valorant-weapon-skins)) | V2, V4, V11: the model we follow |
| Valorant, a Vandal skin with a longer muzzle | players reported its barrel showed around corners before the base gun's would ([Gfinity](https://www.gfinityesports.com/article/valorant-players-report-new-vandal-skin-is-causing-them-to-die-pc)) | V2: the muzzle node stays put |
| Valorant, the Xenohunter Phantom | players said a radar part on the gun model blocked important angles ([ONE Esports](https://www.oneesports.gg/valorant/xenohunter-phantom-blocks-enemies/)) | §3.6: a reshaped part never grows past the base footprint or over the soldier's head |
| Call of Duty: MW3, bundle death effects (2024) | paid weapon bundles come with death effects; players said one comic-book blurb could be heard "across the map" and that effects blocked the screen, and asked for an off switch ([Dexerto](https://www.dexerto.com/call-of-duty/mw3-players-divided-over-obnoxious-death-effect-animations-2567127/)) | §3.7: inside the body envelope, ≤ 1 s, no louder than the base death sound, a "Show others' kill effects" setting |
| Valorant, Finisher Cam (Patch 10.11, June 2025) | Riot added a camera for deaths by finisher guns to "help combat visual clutter" and photosensitivity concerns ([patch notes](https://playvalorant.com/en-us/news/game-updates/valorant-patch-notes-10-11)); players had asked for a way to turn skin effects off ([Ask VALORANT #4](https://playvalorant.com/en-us/news/dev/ask-valorant-4)) | §3.7: no full-screen effect, the Reduce flashes fallback, the death cam shows the effect without zooming into it |
| Call of Duty, finishing moves | executions are long, can't be cancelled and leave the attacker exposed; players asked to cancel them ([Charlie Intel](https://www.charlieintel.com/black-ops-cold-war/black-ops-cold-war-players-call-for-the-ability-to-cancel-finishing-moves-105588/)) | §3.7: no finishing moves or animation locks: a kill effect never takes control of either player |
| Fortnite, elimination effects | we found no documented complaints; its weapon wraps are material swaps, and elimination effects are a creator tool in custom islands, not a sold cosmetic in the core modes ([UEFN device](https://uefncentral.com/fr/verse-library/manager_eliminations)) *(single secondary source)* | — |
| Call of Duty: MW3, the Gaia operator | pulled from sale for a time to make it easier to see after complaints ([Hitmarker](https://hitmarker.net/news/modern-warfare-3s-notorious-groot-skin-is-being-removed-temporarily-513794)) | V8, V10 |

### 3.6 Blueprint skins: reshaped parts, the same gun

A Forged skin may **change the gun's parts**, not just repaint them: a carved receiver, a skeleton stock, a sculpted barrel shroud, a new muzzle device, a restyled magazine. It's still the same gun: same stats, same size, and an enemy still reads a K-47 at a glance.

**What can be swapped** (the blueprint slots; the same slots the Forge uses, §4.2):

| Slot | Can be | Must keep |
|---|---|---|
| `receiver` | reshaped and re-detailed | the grip origin, the `eject` node (≤ 1 cm), the moving parts' names and motion (`part_bolt`, `part_slide`, … with the same `axis` and `travel`) |
| `stock` | any shape | inside the base stock's box ±10%; never past the base's rear end |
| `handguard` (incl. barrel shroud) | any shape | the `offhand` node (≤ 1 cm); the barrel line |
| `muzzle` device | any shape | the `muzzle` node exactly (≤ 1 cm); no longer than the base muzzle device; never shaped like a suppressor on a gun that isn't one, or a brake that looks like a launcher |
| `mag` | restyled, with an optional glowing window | the `mag` node (≤ 2 cm) and the base magazine's type and box ±10% (a box stays a box: a drum on a 35-round rifle would misread its ammo) |
| `grip` | any shape | the grip origin (the attach point) |
| `charm` | any small hanging piece | ≤ 6 cm, below the barrel line |

**The footprint rules** (stricter than V2, because the shape changes):
- **Length and height** of the assembled gun: the base's ±3%. Depth (toward the camera): ≤ +10%. Our camera sees the gun from the side, so the side outline is what matters.
- **Side silhouette:** rendered at 1× gameplay zoom against the base, the outlines overlap ≥ 85% (IoU). A K-47 still reads as a rifle, never as a sniper, launcher or SMG.
- **No part over the soldier:** at every aim pose (−90° to +90°), no part covers the head or crosses the shoulder-to-reticle line (V6). That's where a tall radar-style part blocks the view (§3.5).
- **Sights:** a blueprint may add a sight-looking part, flat to the receiver, but **nothing reads clearer than the base gun**: no lens glow, glint, laser, red dot that projects, or forward light. Our aim is the world-space reticle and the zoom (03 §10), which skins never touch, and the sniper's aim line is never skinnable.
- **Sound and timing:** the same fire, reload and bolt timings (V12) and loudness (V11). A new magazine shape changes the reload *look*, never its length or its sound cues. A line may have **its own sounds** (the K-47 Galaxy Relic's, owner 28 Oct: a dark crystalline fire, crystal clicks and a hum on the reload, a chime on the draw and in the Locker): each is built on the base sound's own take and changes only its timbre, held to V11; everyone in the match hears the shooter's skin's sounds (they follow the look, like the mesh). The muzzle's far layer (what a distant listener hears) stays the base's.
- **Muzzle flash and tracer:** the base's (V4, V5). The muzzle flash: hue only. The tracer: the base's core exactly; the skin's colour goes only into a glow around the core and the path line, at the same length and speed (V5, owner 28 Oct: "yes upgrade it").
- **Glow:** subtle only: seams, glyphs, a magazine window (V9). **No floating particles, smoke, embers or shimmer** around the gun (owner, 28 Oct: "too much").
- **Dropped and slung guns:** a gun on the floor (a crate, a drop, BR loot) always draws the **base** look, so a skin can't disguise a pickup. Slung on the back (04 §9.3) it keeps the skin, inside the same footprint.

**Content pipeline (04 §8):**
- Blueprint parts are authored in Blender per gun and slot, in the weapon frame (04 §9.4), sharing the gun's one material and atlas. Extras: `weaponId`, `blueprintSlot`, and on moving parts the base's `axis`/`travel`/`cutClean`.
- A Forged skin ships as **one assembled GLB** (the pipeline merges its parts), so the renderer still draws one mesh and one draw call per gun.
- `tools/asset-check --kind weapon --blueprint-of <base.glb>` adds the blueprint checks: footprint ±3%, the side-silhouette IoU render, node tolerances (`muzzle`, `offhand`, `eject` ≤ 1 cm, `mag` ≤ 2 cm, grip origin exact), moving-part names and motion unchanged, the no-part-over-the-head sweep over the aim poses, ≤ 1,000 triangles assembled, one material, ≤ 256² texture, the emissive mask only on the allowed areas. It exits 1 on any FAIL, like every other check.
- The readability lint (04 §8.4) renders the reshaped gun in a soldier's hands over every map palette.

### 3.7 Kill effects (everyone sees them)

A skin line's premium tier carries a **kill effect**: when its owner kills someone **with that skinned gun**, the effect plays where the victim falls, for everyone who can see that spot. Example, the K-47 pilot's **Galaxy Relic** ("Stardust Shatter", owner 28 Oct): the body breaks into small glowing violet, magenta and teal crystal shards with a touch of gold and star sparkles, which drift and fade into a little stardust swirl, in 0.9 s.

| Rule | |
|---|---|
| **Trigger** | the kill event's weapon is the skinned gun, and the killer has that line's kill-effect tier equipped on it. Every other kill (another gun, grenades, melee, blasts, the void, a fall, a suicide, a team kill) plays the default death. In battle royale it plays on the elimination, not on a knock |
| **Who sees it** | everyone whose view contains the spot: the killer, the victim (in the death cam), both teams, spectators and killcams. It's part of the world, not a screen effect |
| **Duration** | ≤ **1.0 s**, starting on the kill event: nothing waits for it |
| **Size** | inside the victim's **body envelope** (04 §1.2, the base body box +10%). It replaces the ragdoll's visuals; it never spreads past the envelope |
| **Draw order** | under the dropped weapon, pickups, loot, players (incl. teammates), tracers, nameplates and the HUD. Those always draw on top, at full brightness |
| **Light and flash** | no full-screen flash, no camera shake, no post-processing, no light past the envelope, no more than 3 flashes a second (11 §5: the photosensitivity rule), luminance ≤ the victim's lit body |
| **Sound** | plays with the full effect only (never the still variant, nor when the effect is off for that viewer), from the victim's spot, on top of the base death voice (which still plays); ≤ the effect's duration (≤ 1 s); **no louder than the base death voice**: its loudest 400 ms (BS.1770 momentary) ≥ 1 dB under the death voice's quietest take, at their mix levels; the same range (not heard further than a normal death); and outside the footstep and jetpack bands so it never masks them: ≥ 95 % of its energy above 2.8 kHz, where neither the footsteps' thump and scuff nor the jetpack's roar sit (each ≥ 85 % below it). The Galaxy Relic's: a glassy shatter into a sparkling whoosh, 0.85 s (apps/web `audio/skins.test.ts`) |
| **Information** | it never hides or delays the dropped weapon, the killer's position or tracer, the kill feed (base icon, V14), the respawn timer or a teammate. There is **no finishing move, hit-stop or slow motion**, and neither player loses control |
| **Death cam** | the victim's death cam (05 §18) follows the killer, so the victim sees the killer's skin and the effect in the world. The camera never cuts to or zooms into the effect |
| **Accessibility** | under **Reduce flashes** or **Reduce motion** (13 #507) every kill effect plays its **still** variant: the body fades with a flat tint over the same time, no particles, no light. Settings → Effects → **Show other players' kill effects**: On (default) / Off (Off draws the default death for others' kills) |
| **Teammates** | a teammate's kill effect follows the same limits; the victim's teammates see the same thing as everyone else: where the body fell, the dropped weapon, the killer |

**Wire cost: nothing per kill.**
- The killer's look already rides in the join ticket, HELLO, SetLook and every ROSTER entry (04 §5.1, 05 §6). Weapon skins join it as **one wire id per skin-line gun** (6 slots, inside the ≤ 31 limit); the skin item says whether it carries an effect (the "+ kill effect" tier is its own wire id, so a player can equip the plain Forged skin and turn the effect off).
- The EVENT_R kill event already names the weapon (`{ e: 'kill', killer, victim, weapon, … }`, 05 §6.3). The client looks up the killer's skin for that weapon and plays its effect. Replays and killcams do the same from the recorded roster.
- The game server never knows about effects; it still checks that the killer owns what they wear (`admitLook`).

**Budgets** (per effect; the 04 §7 kill-effect row now matches):

| Budget | Limit |
|---|---|
| Particles | ≤ 80, GPU-instanced |
| Draw calls | ≤ 1 extra (instanced quads from one shared kill-effect atlas); the dissolve runs in the victim's own draw call (a uniform) |
| Textures | ≤ 256 KB per effect, in the shared atlas |
| CPU | ≤ 0.05 ms a frame per live effect |
| Live at once | ≤ 4; a fifth plays the still variant |
| Low-quality preset | the still variant |

**Pricing:** a kill effect is never sold on its own. It's the top tier of a skin line: **Forged + kill effect 2,200**, or **1,050** to add it to a Forged skin the player already owns (§3.1).

---

## 4. The Forge (custom looks)

The Forge lets a player design **the look** of a gun (and later a soldier) from our part library, dyes, decals and FX. The gun's stats never change. A player can do it in the in-game Forge screen, or with their own AI (Claude Code or any other) through the SDK, CLI and MCP server (§4.5).

### 4.1 The look spec

A Forge look is **one JSON document**, validated by a zod schema in `packages/content` (`ForgeLook`), shared by the web client, the SDK and the API.

```jsonc
{
  "schema": 1,
  "kind": "weapon",                 // "weapon" first; "character" in Forge v2
  "base": "k47",                    // a weaponId with a Forge part library (§4.2)
  "name": "Ember Choir",            // ≤ 24 chars, reviewed (§4.4)
  "parts": {                        // slot → part id from the library; omitted = the base part
    "handguard": "k47.handguard.ribbed",
    "stock": "k47.stock.skeleton",
    "mag": "k47.mag.ribbed_window",
    "charm": "charm.lantern"
  },
  "finish": { "body": "anodised", "parts": "satin" },
  "dyes": { "primary": "#2B1C3F", "secondary": "#C8A15A", "accent": "#FF7A2E" },
  "decals": [                       // ≤ 4
    { "src": "lib:sigil.flame_03", "anchor": "receiver.left", "scale": 0.8, "rot": 0, "tint": "accent" },
    { "src": "upl:7f3a…",          "anchor": "stock.left",    "scale": 1.0, "rot": 15 }   // an upload (§4.4)
  ],
  "fx": [                           // "magic": total cost ≤ the FX budget (§4.3)
    { "kind": "emissive_seam",   "on": "handguard", "color": "accent", "intensity": 0.6, "pulse": 1.2 },
    { "kind": "emissive_window", "on": "mag",       "color": "secondary", "intensity": 0.4 }
  ]
}
```

- **Only references, never content:** parts, decals and FX are ids from our library, or `upl:` ids of reviewed uploads. No URLs, no shaders, no scripts, no model files, no free-form numbers outside the schema's ranges.
- **FX kinds** are ours and few, and all of them are subtle glow on the gun itself: `emissive_seam`, `emissive_glyphs`, `emissive_window` (a magazine window). Each is a fixed shader path with parameter ranges. **No particles, smoke or shimmer** around a gun (owner, 28 Oct). Muzzle flash, tracers and sound are not in the schema at all (V4, V5, V11), apart from a hue (the flash) or a glow gradient around the base core (the tracer) from the allowed set. **Kill effects** aren't in a Forge look: they come only with store skin lines (§3.7), so a player can't design one.
- The renderer draws a look exactly like a store skin: parts merged into the gun's one mesh, dyes through the 04 §5.4 mask, decals into the gun's 256² atlas, so a Forge look costs the same as any other gun on screen.

### 4.2 The part library

- Per Forge-enabled gun, we author **visual parts** for the blueprint slots (`receiver`, `stock`, `handguard`, `muzzle`, `mag`, `grip`, `charm`) in Blender, each passing the §3.6 rules. A look can swap any of them; whatever it picks, the assembled gun must pass the §3.6 footprint, silhouette and node checks, which the validator runs on every save. A part can look like anything that fits the gun's class: it can't make a K-47 look like a sniper or a launcher.
- Parts that look like optics are allowed only flat to the receiver, below the shoulder-to-reticle line (V6), and never imply a zoom the gun doesn't have.
- The library starts with the **K-47** (~6 options per slot) and grows to the six skin-line guns (§3.2).
- **Library parts, dyes, finishes and library decals are free** to every player in the Forge. What's sold is the space to keep looks (§4.6), plus Forged store skins (§3.3). Whether premium library parts are ever sold is Q7.

### 4.3 Validation (server-side, every save)

The API runs the same code the SDK runs, and **only the API's verdict counts**:

1. **Schema:** `ForgeLook.parse` (zod); unknown fields fail.
2. **Ownership:** the base gun is Forge-enabled; every `upl:` id belongs to this account (or is approved and shared, §4.7).
3. **Visual budget:**

   | Budget | Limit |
   |---|---|
   | Triangles (base + parts) | ≤ 1,000 (04 §9.4) |
   | Decals | ≤ 4, packed into the 256² atlas |
   | FX points | ≤ 100: `emissive_seam` 20, `emissive_glyphs` 25, `emissive_window` 15; × intensity |
   | Footprint | the assembled gun passes §3.6 (length and height ±3%, side-silhouette IoU ≥ 0.85, nodes, no part over the head) |
   | Emissive area | V9 |

4. **Readability:** an isolated render worker (no network, no secrets, the same container pattern as the ads creative pipeline, 14 §3.1) renders the look on the base soldier over every map palette and runs V2, V5, V7, V8, V9, V10 on the **worst case** (darkest dye picks, strongest pulse frame). It returns PASS/FAIL per check with the rendered frames.
5. Result: `valid` (library-only looks: usable at once), `pending` (has uploads or a new name: §4.4) or `rejected` (reasons listed).

### 4.4 The review queue

| Content | Automated first | Then |
|---|---|---|
| Library-only look, default or previously approved name | §4.3 | **live at once**, no human |
| New look **name** | profanity and slur lists per language (the 14 §5.5 coded-term lists), brand and trademark list, real-person list | human review if flagged; otherwise live |
| **Uploaded decal or texture** (incl. AI-generated, §4.5) | re-encoded to PNG, metadata stripped, ≤ 256²; OCR for text; image hash against known logos and hate symbols; nudity, gore and extremist-symbol classifiers | **always a human**, ≤ 2 business days |

**Reject reasons** (F-codes, the 14 §3.6 style):

| Code | Reason |
|---|---|
| F01 | real gun maker or model names, logos or markings (the 03 §2 rule) |
| F02 | other brands, other games' names, characters or art, sports clubs |
| F03 | real people, likeness or names |
| F04 | hate symbols, extremist, terrorist or genocidal insignia, incl. real military unit insignia used as such |
| F05 | sexual content, nudity |
| F06 | gore beyond the game's own art |
| F07 | political, religious or national symbols used to provoke |
| F08 | slurs, harassment, coded terms (any language) |
| F09 | text or links that advertise, sell or direct off-platform (handles, URLs, QR codes) |
| F10 | fails a readability check (§3.4) |
| F11 | impersonates game UI, ranks, mastery or staff marks |
| F12 | not the uploader's to use (rights doubt) |

- **Until approved, everyone else sees the look without its uploads** (the library parts, dyes and FX only). The owner sees it all in the Forge and in training, with a "Pending review" tag.
- Reports from players (07 §10) put an approved look back in the queue; 3 reports from distinct accounts in 30 min hide its uploads at once.
- Two upheld rejections for F01–F08 in 90 days lock uploads for that account for 90 days.
- The queue lives in `apps/admin` next to the ads review (14 §5.5), with the same separation-of-duties and language-coverage rules.

### 4.5 The Forge SDK, CLI and MCP server

The owner wants players to design looks **with their own AI**. We give the AI a narrow, safe surface that produces a spec, never code.

| Piece | What it does |
|---|---|
| `@military-forge/forge-sdk` (npm, MIT) | the `ForgeLook` schema, the budget calculator and the validator (the same code as the API), the part catalogue as typed data, and `toJsonSchema()` for any tool |
| `forge` CLI | `forge init k47` (a starter spec) · `forge parts k47` · `forge validate look.json` · `forge preview look.json` (a local turntable in the browser, drawn by the game's own renderer from our CDN assets, with the map-palette lint overlays) · `forge submit look.json` |
| `@military-forge/forge-mcp` (stdio MCP server) | tools: `list_bases`, `list_parts(base, slot?)`, `get_budget`, `validate_look(spec)`, `render_preview(spec, view?)` (returns turntable PNGs and the lint report), `upload_decal(png)` (goes to review), `submit_look(spec, slot?)`. Works in Claude Code and any MCP client |

- **Auth:** `forge login` opens the browser and issues a **personal token scoped to `forge:*` only**: it can't buy, spend Brass, read the wallet, chat or touch the account. Revocable from Settings; expires in 90 days; rate-limited (60 validations and 10 submits an hour).
- **Previews are local**: `render_preview` and `forge preview` run on the player's machine; only `submit` and `upload_decal` reach our API.
- **Nothing runs on our side** but our validator and renderer over the JSON. An AI that writes a shader, a model or a script has nothing to send it to.
- Docs: a short "Forge with your AI" page with a sample prompt, the schema and the budget table.

**AI-generated decals and textures** are welcome, but only as uploads through §4.4: always human-reviewed, flagged "AI-generated" by the uploader (a checkbox; C2PA data is kept if present), and the uploader attests they have the rights (F12). An AI-made image never goes live without review.

### 4.6 Loadout slots (what we sell)

- **1 Forge slot free** per account (Founder's Pack adds 1, §3.1). A slot holds one saved look.
- **More slots:** 1 for 500 Brass, 3 for 1,050. Cap: **30 slots**. Slots are permanent.
- Editing a look in a slot is free and unlimited; library-only changes are live at once, new uploads or a new name go back to review (§4.4).
- Deleting a look frees its slot. A look can be **equipped** on its gun in any of the Locker's 3 presets (04 §6) without using more slots.
- Bought slots are refundable under §2.6 while empty.

### 4.7 Sharing and selling looks (later)

| Stage | What | Money |
|---|---|---|
| **Share codes** (Forge v2) | a player shares a look as a short code; another player copies it into **their own slot** (so it costs them a slot, not the look) | none |
| **The Armoury** (curated, post-launch) | we pick looks from share codes, polish them with the creator, put them through §3.4 and sell them as store items. curated by us, like the best creator workshops, never an open marketplace | the creator is credited on the item; their reward is decided in Q8 |

There is never a player-to-player sale, a player-set price, or a creator payout in Brass that can be cashed out.

---

## 5. The "battleground" playlist (optional)

The owner floated a separate playlist for paid and custom looks. Our proposal:

| | Core playlists and ranked | **Battleground** (optional playlist) |
|---|---|---|
| Stats | identical everywhere | identical |
| Paid skins and Forge looks | shown, at the **standard FX budget** (100 points) | shown at a **showcase budget** (200 points: brighter seams, more glyphs; still no particles or smoke) |
| Readability rules (§3.4) | all | all (V7, V8, V9 still bind: the showcase budget is more *flourish*, not less visibility) |
| Kill effects (§3.7) | on, with the §3.7 limits | the same: the limits don't loosen |
| Uploaded decals | shown once approved | shown once approved |
| Local "Plain looks" setting (everyone else's guns drawn as base) | available | available |
| Modes | all | TDM and FFA on a rotating map, casual XP |

It costs a playlist's worth of matchmaking population, so it ships **only when the Forge has demand** (Q6): ≥ 2,000 saved looks, or 10% of weekly players with a non-default Forge look.

---

## 6. Interfaces (sketch)

| Surface | Where |
|---|---|
| `GET /store`, `POST /store/buy {itemId, expectedPrice}` (the price check refuses a stale price) | API (06), store UI (13 #497) |
| `POST /wallet/checkout {bundleId}` → provider session; `POST /webhooks/<provider>` → ledger `purchase` (idempotent on the provider id) | API |
| `GET /wallet` (balance by pool, history), `PUT /wallet/limits` | API, Settings → Spending |
| `GET/PUT/DELETE /forge/slots/:n` (a `ForgeLook`), `POST /forge/uploads` | API + forge-sdk |
| Loadout | a Forge look travels like any look: its slot id joins the cosmetic wire ids in the join ticket and ROSTER (04 §5.1, 05 §6), and clients fetch the spec once per player from the CDN by its content hash. The game server only checks that the account owns the slot and the look is `valid` or approved |

---

## 7. Red lines

1. **No paid random items**: no loot boxes, packs, spins, gacha or mystery bundles bought with money or Brass, in any country, ever. A battle pass tier is a known item.
2. **No stats for money**: nothing sold changes a number the sim reads (V1).
3. **No visibility for money**: nothing sold makes a soldier, gun, tracer or flash harder to see or hear (§3.4).
4. **No cash-out, transfer, trading or marketplace for money**; no Brass for creators that can be cashed out.
5. **No player code is executed**: specs are data; uploads are images, re-encoded; no shaders, scripts, models, WASM or URLs from players.
6. **No real gun trademarks** (makers, models, markings), no other brands or games' IP in sold items, library parts or approved uploads.
7. **No selling of earned prestige**: mastery, rank, event and Founder's looks are never sold later.
8. **No dark patterns**: real money shown next to every price; no fake scarcity or countdowns; no store pushes during a match; spending limits on by default.
9. **No store for guests or for anyone who hasn't passed the 18+ gate.**
10. **No random rewards that grant Brass** from ads or anywhere else.
11. **No kill effect may hide or delay information:** the dropped weapon, the killer's position and tracer, the kill feed, a teammate, the respawn timer. No finishing moves, hit-stop or slow motion (§3.7).
12. **No reshaped gun may change its footprint or read:** same size, muzzle, grip and magazine positions, sight read, flash, tracer and sound timing as the base (§3.6).

---

## 8. Open questions for the owner

| # | Question | Default if nobody decides |
|---|---|---|
| Q1 | The currency's name: **Brass**, Ingots or Tags (§2.1)? | Brass, after a quick trademark screen with the game name (01 §12) |
| Q2 | One currency only, or keep an earn-only soft currency (the old Coins) for some items? | one currency; earned unlocks grant items directly |
| Q3 | Naira price tier for the bundles (₦ per 1,000 Brass) | set from local price research before the pilot; never a plain FX conversion |
| Q4 | Should the premium battle pass pay back its own price in Brass (the "buy once, pass forever" model)? | no: ~700 of 1,050 back |
| Q5 | Sell battle pass tier skips at all? | yes, 250 Brass for 2 tiers, cosmetic tiers only |
| Q6 | Build the battleground playlist (§5)? | not before the Forge demand threshold |
| Q7 | Sell premium Forge library parts, or keep the whole library free and sell only slots? | library free; only slots and store skins are sold |
| Q8 | Armoury creators (§4.7): credit only, Brass (non-cashable), or a real-money licence contract per curated look (a commission, not a cash-out; needs KYC and tax)? | credit + a fixed Brass reward; revisit contracts with a lawyer |
| Q9 | 01 §10's rewarded "free daily spin": a spin is random. Replace with a fixed daily reward? | yes: a fixed daily item or XP, never Brass |
| Q10 | Monthly spend cap: $100 default / $500 max right? | yes |
| Q11 | Character looks in the Forge (Forge v2), or guns only? | guns first; characters after the gun review has run a season |
| Q12 | Founder's Pack: include the extra Forge slot? | yes |
| Q13 | Kill effects in ranked: shown, or ranked draws default deaths for everyone? | shown, under the §3.7 limits; revisit with the V15 parity data |
| Q14 | "Show other players' kill effects" default: On, or On with an Off switch only in Settings? | On, with the switch in Settings → Effects |
| Q15 | Kill effects on the default guns (Hammer, Hawk): sold like the others, or only on guns you pick up? | sold like the others (the defaults are where they'd be seen most) |

---

## 9. Rollout

**The money path (28 Oct 2026):** the wallet and append-only ledger, Flutterwave checkout in naira and dollars (test keys first), verify-before-credit, the webhook, refunds of unspent currency, the spending limit, cool-off and wallet cap, the 18+ saved-account gate, the Store screen (`#/store`) and the admin page's Store (look up, grant, adjust, refund). Items bought land in `inventory` and unlock exactly like the grants below. apps/api/README.md "The store".

**Built ahead of the store (28 Oct 2026):** the K-47 Galaxy Relic line's Forged skin (`skin_k47_galaxy_relic`) and its Forged + kill effect tier (`skin_k47_galaxy_relic_fx`, the Stardust Shatter effect), with the blueprint checks (`--blueprint-of`), the tracer glow, the line's own sounds (V11) and the kill effect and its sound in game, and the Settings switch (art/README.md "Weapon skins"). Besides buying them in the Store (live once the Flutterwave keys are set), they can be owned by an **owner grant**: the API's `COSMETIC_GRANTS="<accountId>:<itemId>,…"` (an account's id is `id` in `GET /me`). The API then accepts the skin in a saved loadout, lists it in `/me` `grants` (the Locker shows it owned) and vouches for it in the join ticket, so the game server admits it and everyone in the room sees it. A dev build (vite) also takes `?grant=<itemId>` for offline previews; online it unlocks nothing.


| Step | Ships | Gate to the next step |
|---|---|---|
| **1. K-47 pilot** (Phase 3, beta) | the ledger, one payment provider (**Flutterwave**, the owner's choice on 28 Oct; built: apps/api/src/store/), bundles, the store page with money prices and limits, 18+ store gate, **one paid K-47 skin line**: 1 Wrap, 1 Skin, 1 Forged blueprint ("fictionistic and magical", reshaped parts, §3.6) and its **Galaxy Relic** kill-effect bundle (§3.7), the blueprint asset checks, §3.4 V1–V14 automated for weapons, V15 telemetry | ledger reconciles to the cent for 4 weeks; zero V-check failures in the wild; refund rate < 5%; no parity gap (V15) |
| **2. Launch store** (Phase 3–4) | skin lines on Hammer, Hawk, Widow, Breacher, Hornet; character looks; battle pass S1 with the free track; Founder's Pack; regional tiers + Paystack/Flutterwave, UPI | 13 R items for launch |
| **3. Forge v1** (S2) | K-47 part library, the Forge screen, `forge-sdk`, CLI and MCP server, 1 free slot + slot sales, library-only looks (no uploads) | ≥ 95% of submits validate on first try with the SDK; render worker p95 < 10 s |
| **4. Forge v1.1** | decal and texture uploads (incl. AI-generated) through the review queue; libraries for the other five guns | review SLA held for 4 weeks; zero F04 looks live |
| **5. Forge v2** (S3+) | share codes; character looks; the battleground playlist if Q6 says yes | |
| **6. The Armoury** (post-launch) | curated creator looks in the store | Q8 decided |

### 9.1 The launch gift, then a 7-day streak (owner, 28 Oct 2026)

> "make it claimable, for now" … "later we'll make users have it if they grind the game for 7 days straight" (owner, 28 Oct 2026)

**Now: a launch gift.** The Galaxy Relic + Stardust (`skin_k47_galaxy_relic_fx`, which includes the plain Forged skin) is **free to claim**, while Flutterwave isn't keyed yet and after it is.
- The API's `STORE_CLAIMABLE` lists the claimable items (empty = none). An optional `STORE_CLAIM_UNTIL` ends the gift. `POST /store/claim` is in apps/api/src/store/claims.ts.
- **Once per account.** A claim is an `inventory` row (source `promo`) and a `store_audit` line. It never touches currency or the ledger. Claiming again, or claiming something already owned, changes nothing.
- **18+ (#311's rule):** a saved account uses the answer it was saved with. A guest sends its device's answer, which is checked like an account save and kept on the account. Under 18 is refused.
- A guest's claim stays on the guest account, and **saving the account keeps it** (the same account).
- **Buying** still needs a saved 18+ account (red line 9). The free gift is open to guests who passed the 18+ step: nothing is paid, so nothing could be lost with an unsaved device except the gift itself.
- The Store shows "Claim free" on both cards, under a **Launch gift** tag, until the item is owned. "Get Brass" says *Coming soon* until the keys are set; then the paid path returns as in §2, and the gift still shows Claim. The Locker links to the Store from its header and from a locked store skin.
- **Items claimed during the gift are kept for good.** When the gift ends they stay owned and wearable, like a bought item. They're not refundable (nothing was paid) and can't be returned for Brass.

**Later: earned by a 7-day play streak.** When the streak ships, unset `STORE_CLAIMABLE`: new players earn the line by playing, and gift claimers keep theirs. Draft rules for the owner to settle:

| Rule | Draft |
|---|---|
| **Qualifying day** | A **UTC** calendar day on which the account completes **at least one online match against at least one other real player**, *or* plays **20 minutes** of such matches in total (N to tune with docs/16 metrics). |
| **Completed** | Present at the match's end (`match_players.left = false`) and actually playing: some damage dealt or taken, or moving and firing for at least half the time alive. |
| **The streak** | **7 qualifying days in a row**. A missed UTC day starts it again from zero ("7 days straight": no grace day). Progress ("Day 3 of 7") shows in the Store and on Results. |
| **What counts** | Only the game server's **signed match results** (`POST /internal/matches`): never the client's word. The streak is worked out from `matches` + `match_players`. |
| **Anti-farm** | Bot-only rooms, training and the tour never count. An AFK player (no meaningful input for most of the match, from the server's input stream) doesn't qualify that match. A custom room counts only with **≥ 2 real accounts** that aren't the same device. |
| **One account per device** | Each device sends a random device id with its joins. The reward goes to one account per device id. Several accounts on one device or address prefix finishing streaks together are held for review (docs/10's multi-accounting). |
| **18+** | The same rule as the gift: a guest's device answer, or the saved account's. |
| **The reward** | `skin_k47_galaxy_relic_fx` into `inventory` (source `streak`). Someone who already owns it (gift, purchase or grant) gets nothing more for this line; a later line may reward a different item. |
