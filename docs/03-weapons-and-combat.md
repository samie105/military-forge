# 03 — Weapons & Combat

> Baseline numbers are our own starting point, chosen for ~1-second time-to-kill and readable roles. We tune them with feel targets and telemetry.
> Health = 100. Headshot = ×1.5. Crouching removes the head zone (02-physics §6). Health regenerates (02-physics §8).

---

## 1. Combat pillars

1. **~1-second time-to-kill (TTK) for most automatic weapons.** It's long enough to react, jet away, or turn the fight with a grenade. Fast enough that aim decides fights.
2. **Every weapon has a job:** close (shotgun, flamer, machete), mid (SMGs, rifles), long (DMR, sniper, laser), area/denial (rockets, grenades, gas, mines, saw).
3. **Dual wielding is a power fantasy and a skill.** It doubles damage output but makes aim harder and limits zoom.
4. **Movement is the defence.** There's no armour in core modes. Jetpack, crouch and cover do the job. Battle royale adds armour (08).
5. **All weapons are available to everyone.** Genre classics gated dual wield and power weapons behind paid unlocks, and later sold weapon upgrades in crates. Players hated the pay-to-win. **We only sell cosmetics.**

---

## 2. Naming & legal note

Real gun names like Desert Eagle, Uzi, Tavor and MP5 are manufacturer trademarks, and other games' names and weapon names belong to their owners. **We ship original names**, so weapons stay recognisable by role and silhouette rather than by brand. The "Archetype" column below is internal only.

---

## 3. Units

We think in metres: a pistol's range = 20 m ≈ the edge of the default screen (the default view is ~36 m wide). Tune with the feel targets (`pnpm --filter @military-forge/sim feel`).

---

## 4. Weapon data schema (`packages/content/weapons/*.json`)

```ts
interface WeaponDef {
  id: string;                    // 'smg_buzz'
  name: string;                  // localisation key
  class: 'sidearm'|'smg'|'rifle'|'dmr'|'sniper'|'shotgun'|'heavy'|'special'|'melee';
  hands: 1 | 2;                  // 1 = dual-wield capable
  fire: { mode: 'semi'|'auto'|'burst'|'beam'|'charge'|'spinup';
          interval: number;      // s between shots (or bursts)
          burstCount?: number; burstInterval?: number;
          chargeTime?: number;   // saw/EMP
          spinUp?: number; spinDown?: number; };
  projectile: { kind: 'hitscan'|'pellets'|'beam'|'sim';
                pellets?: number; simId?: string;   // → projectile def (02-physics §13.2)
                penetration?: number; };
  damage: { base: number; headMul?: number;        // default 1.5
            falloffStart: number; falloffEnd: number; minMul: number;  // metres, 0.5 default
            splash?: { radius: number; core: number; max: number; selfMul: number }; };
  range: number;                 // metres
  spread: { base: number; moveMul: number; airMul: number; crouchMul: number;
            bloomPerShot: number; bloomMax: number; recoverPerSec: number; dualMul: number; minAir?: number };
  ammo: { mag: number; reserve: number; reload: number; autoReloadWhenEmpty: boolean; regen?: number };
  handling: { equip: number; moveSpeedMul: number; recoilPushAir: number; recoilPushGround: number; meleeDamage: number };
  zoomMax: 1|2|3|4|5|6|7;
  spawn: { tier: 'common'|'power'; respawn: number; mapsOnly?: string[] };
  presentation: { model: string; muzzle: string; sfx: { fire: string; reload: string; tail: string }; tracer?: string; kickCam: number; shake: number };
}
```

The schema is zod-validated and lint-checked (e.g. a `dps` sanity range per class, no `hands:1` heavy weapons).

---

## 5. Arsenal

`Dmg` = per bullet/pellet/tick. `Int` = seconds between shots. Range is in metres. MVP = in the first playable; L = at launch; P = post-launch.

| Our name | Archetype | Class | Hands | Dmg | Int | Mag / Reserve | Reload | Range | Spread ±° | Zoom | Melee | Move | Ship |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| **Hawk .50** | heavy pistol (default sidearm) | sidearm | 1 | 8 | 0.25 | 15 / 60 | 1.25 | 20 | 3 | 2× | 15 | 1.0 | MVP |
| **Hammer .44** | magnum revolver (default primary) | sidearm | 1 | 30 | 0.60 | 6 / 30 | 2.0 | 26 | 1.5 | 3× | 25 | 1.0 | MVP |
| **Buzz** | compact SMG | smg | 1 | 7 | 0.10 | 40 / 250 | 1.5 | 20 | 6 | 3× | 20 | 1.0 | MVP |
| **Rattler** | machine pistol | smg | 1 | 10 | 0.15 | 40 / 250 | 1.5 | 24 | 4 | 3× | 25 | 1.0 | L |
| **Hornet** | high-RPM SMG | smg | 2 | 7 | 0.06 | 50 / 250 | 1.75 | 28 | 5 | 3× | 30 | 1.0 | MVP |
| **K-47** | assault rifle (hard-hitting, wild) | rifle | 2 | 10 | 0.10 | 35 / 210 | 2.0 | 32 | 5 | 4× | 30 | 0.97 | MVP |
| **Trident** | 3-round burst rifle | rifle | 2 | 14 ×3 | 0.50/burst | 24 / 240 | 2.0 | 40 | 1.5 | 5× | 30 | 0.97 | MVP |
| **Bullpup** | bullpup rifle (rare spawn) | rifle | 2 | 9 | 0.12 | 35 / 175 | 1.5 | 30 | 3 | 4× | 30 | 1.0 | L |
| **Longbow** | marksman rifle | dmr | 2 | 36 | 0.55 | 6 / 30 | 2.25 | 48 | 0 (air 1.5) | 6× | 35 | 0.95 | L |
| **Widow** | bolt sniper | sniper | 2 | 75 | 0.80 | 3 / 15 | 2.5 | 60 | 0 (air 1.5) | **7×** | 35 | 0.90 | MVP |
| **Breacher** | pump shotgun | shotgun | 2 | 20 ×5 pellets | 0.75 | 5 / 20 | 2.5 | 13 | 10 (cone) | 2× | 40 | 0.97 | MVP |
| **Dragon** | flamethrower | heavy | 2 | 20/tick | 0.15 | 125 fuel, auto-refill 5 s | — | 6 | 8 | 2× | 40 | 0.92 | L |
| **Arc** | continuous beam laser | special | 2 | 6/tick | 0.15 | 200 cell (+regen 10/s when not firing) | 4 (auto) | 52 | 0, **no falloff** | 5× | 40 | 0.95 | L |
| **Thumper** | rocket launcher | heavy | 2 | 100 direct + splash 80 (R 3.5) | 1.25 | 3 / 6 | 4.0 | rocket self-destructs at 60 | 0 | 6× | 35 | 0.85 | MVP |
| **Popper** | grenade launcher | heavy | 2 | splash 70 (R 3.0) | 0.25 | 6 / 18 | 3.75 | arcs | 2 | 4× | 35 | 0.90 | P |
| **Ripper** | saw-blade launcher | special | 2 | 100 | 1.0 (0.4 charge) | 1 / 8 | 2.5 | bounces, explodes after 5 s | 0 | 4× | 40 | 0.95 | L |
| **Pulse** | EMP orb gun | special | 2 | 0 (disables jetpack 3 s) | 0.7 charge | 1 / 12 | 2.5 | slow orb, **passes through walls** | 0 | 4× | 50 | 0.95 | P |
| **Shredder** | minigun | heavy | 2 | 9 | 0.07 after 0.8 s spin-up | 120 / 240 | 4.25 | 26 | 6 | 3× | 35 | **0.70** | P |
| **Machete** | melee pickup | melee | 1 | **100** (one-hit) | 0.55 swing | — | — | 1.2 | — | 1× | 100 | 1.05 | L |
| **Riot Shield** | off-hand pickup | special | off-hand | blocks frontal bullets (±60°), 300 HP | — | — | — | — | — | — | 25 (bash) | 0.75 | L |

**Default spawn loadout** (core modes; host-configurable): Hammer .44 + Hawk .50 + 3 frags. Everything else is picked up from map spawners.

**Cosmetic variants, not stat upgrades:** genre classics sold golden guns with extra power. Ours is a **gold skin** for the Hawk with no stat change.

---

## 6. Time-to-kill sheet (100 HP, all shots hit, no regen during the fight)

| Weapon | Body shots → TTK | Headshots → TTK | Notes |
|---|---|---|---|
| Hawk .50 | 13 → 3.0 s | 9 → 2.0 s | weakest gun; dual 1.5 s |
| Hammer .44 | 4 → 1.8 s | 3 → 1.2 s | consistent, accurate |
| Buzz | 15 → 1.4 s | 10 → 0.9 s | **dual: 0.7 s** but very wild |
| Rattler | 10 → 1.35 s | 7 → 0.9 s | dual 0.68 s |
| Hornet | 15 → 0.84 s | 10 → 0.54 s | the fastest-firing gun |
| K-47 | 10 → 0.90 s | 7 → 0.60 s | |
| Trident | 8 rounds → ~1.0 s (3 bursts) | 5 → 0.5 s (2 bursts) | headshot burst + 1 shot |
| Bullpup | 12 → 1.32 s | 8 → 0.84 s | |
| Longbow | 3 → 1.1 s | 2 → 0.55 s | |
| Widow | 2 → 0.8 s | **1 → instant** | crouching victims deny the one-shot |
| Breacher | 1 (all 5 pellets) → instant | — | inside ~4 m |
| Dragon | 5 ticks → 0.6 s | — | area; hurts the user near walls |
| Arc | 17 ticks → 2.4 s | — | perfect accuracy, huge range: a zoning tool |
| Thumper | 1 direct hit | — | splash kills crouched victims too |
| Machete | 1 hit | — | |

**Targets for balance reviews:** auto-weapon median TTK in real matches (with misses) should be 1.2–2.0 s. If any weapon's kill share exceeds 1.5× its pick share for two consecutive weeks, it goes up for review.

---

## 7. Accuracy model

```
spread = base
       × (grounded ? (moving ? moveMul : 1) : (jetting ? airMul*1.07 : airMul))
       × (crouched ? crouchMul : 1)
       × (dual ? dualMul : 1)
       + bloom                                 // grows bloomPerShot each shot, capped at bloomMax
spread = max(spread, grounded ? 0 : minAir)    // snipers/DMR: tiny air penalty keeps air-sniping a flex, not a default
bloom -= recoverPerSec × dt  (after 0.1 s without firing)
shotAngle = aim + spread × (2·rand(seed) − 1)  // seeded: hash(roomSeed, tick, shooterId, shotIndex) → client predicts it exactly
```

Defaults: `moveMul 1.25 · airMul 1.5 · crouchMul 0.6 · dualMul 1.4 · bloomPerShot 0.5° · bloomMax 4° · recoverPerSec 10°/s`.

- **Pellets:** for the Breacher, the 5 pellets are evenly distributed across the cone, with a small seeded jitter. That's more consistent than pure random and feels fairer.
- **Recoil:** visual only on the aim (camera kick + weapon kick). There's no aim displacement, since a 2D mouse aim plus aim displacement feels like input lag. Recoil gameplay comes from bloom and the **recoil push** (02 §12): `recoilPushAir` along −aim in the air, `recoilPushGround` as a horizontal slide on the ground (heavy guns only). Light guns don't push.

| Weapon | Air push (m/s) | Ground slide (m/s) | Feel |
|---|---|---|---|
| Hawk, Hammer, Buzz, Rattler, Hornet, Machete | 0 | 0 | light guns never push |
| K-47, Bullpup, Trident | 0.3 per round | 0 | spraying in the air drifts you back ~1.6 m a second |
| Longbow (DMR) | 1.5 | 3 | a nudge |
| **Widow** | **2** | **8.5** | standing: kicked back ~0.6 m (crouched ~0.1 m); in the air ~0.7 m |
| **Breacher** | **10** | **6** | fired down at the top of a hop: a ~2.2 m shotgun jump; fired level in the air: a ~2.8 m dash; standing: a 0.3 m slide |
| Thumper (rocket launcher) | 6 | 4 | a launcher kicks hard (rocket jumps come from its blast) |
| Popper (grenade launcher) | 2.5 | 1.5 | |
| Ripper (saw launcher) | 3 | 2 | |
| Shredder (minigun) | 0.35 per round | 0.15 per round | a long burst pushes you back steadily |
| Dragon, Arc, Pulse | 0 | 0 | streams and orbs don't kick |

  (Bold rows are in the game; the rest are the starting values for when those weapons land.)
- **Aim aids:** a reticle at the cursor + a faint **aim line** (accessibility option, available to everyone). Other games sell a laser sight; for us it's a free setting. **No aim assist on desktop.** Touch (later) gets an optional light slowdown-near-target assist, only in casual queues.

---

## 8. Damage model

```
dmg = base × falloff(dist) × zoneMul × rarityMul(BR) × modeMul
falloff: 1.0 until falloffStart (= 50% range), linear to minMul (0.5) at range. Beyond range: no hit.
         "Classic" custom-room rule: no falloff for anything. The beam laser never falls off.
dist:    the range used up, not the metres flown, on maps with mechanics (02-physics §20.4): a map-wide
         bulletRangeMul scales every range ("bullets don't go far": 0.5 halves them); damping zones
         (fog, water) use it up 1/m times faster per metre inside. Same metres on plain maps.
zoneMul: head 1.5 (not available while crouched), body/legs 1.0
armour (BR only): vest absorbs X% of body damage into armour HP; helmet reduces the head multiplier (08 §6)
```

| Rule | Value |
|---|---|
| Friendly fire (team modes) | **bullets: no** · explosives / flames / melee / saw: **yes** (a genre convention). Host can set it to all/none |
| Teamkill | −1 score; 3 teamkills in public matches → auto-kick and a short matchmaking cooldown |
| Self-damage | explosives 50%, toxic gas 50%, flames 50%, saw 100% (it's famous for killing its owner), EMP self-stun yes, a flashbang blinds its thrower too (look away) |
| Mines | a mine's blast is credited to its thrower, unless someone shot it empty: then to the shooter |
| Kill credit for environmental deaths | if a player dies to a pit/hazard within **5 s** of being damaged, the last damager gets the kill ("knocked into the void"). Knockback weapons make this a skill |
| Assists | ≥ 25 damage within 10 s before the death |
| Scoring (DM/TDM) | +1 kill, −1 suicide/teamkill. K/D tracked separately |
| Regen | 6 HP/s after 4 s without damage (mode setting; off in BR, Gun Game optional) |

---

## 9. Handling rules

- **Slots:** 2 weapon slots + melee + grenade belt. Swap = `Q` / mouse wheel (0.35 s; sidearms 0.25 s).
- **Pickup:** stand on a weapon + `E` swaps it with the **currently held** weapon (the old one drops with its ammo and stays 30 s). Walking over a weapon you already hold **tops up ammo automatically**. Picking up a power weapon shows a short banner to nearby players ("Widow picked up"), which builds map-control play.
- **Dual wield** (the signature move): when **both** slots hold one-handed weapons (Hawk, Hammer, Buzz, Rattler), press `F` to toggle dual. Both guns fire together with one fire input, each on its own cooldown and ammo. Spread ×1.4, zoom max = the lower of the two, reload = both reload in sequence. The classic combo is Buzz + Hammer.
- **Reload:** `R` or automatic when empty (setting). Swapping cancels a reload. Partial reloads keep the remaining mag. Heavy weapons can't reload while jetting (keeps air power in check).
- **Melee:** `V` / mouse button 4. Damage depends on the held weapon (§5). Lunge (02-physics §12). Bypasses the riot shield.
- **Riot shield:** occupies the off-hand. You can only use one-handed weapons with it (no dual). It blocks bullets within ±60° of your facing until its 300 HP is gone, and gives no protection from flames, explosions, melee or saws.
  - **Carry modes** (built: `packages/sim/src/shield.ts`, numbers in `packages/content/src/shield.ts`):
    - **Raised** in front of the body: it blocks from the front, and it weighs ×0.75 (the heaviest item in hand sets the speed).
    - **Slung** on the back: it blocks from **behind** (the owner's call, 17 Oct), and it weighs nothing.
    - It takes 0.25 s to come up and blocks neither side on the way.
  - It comes up by itself with a one-handed weapon (or a Machete) in hand. A two-handed weapon or going dual slings it, and it comes back up when that ends. The shield key (`X`) slings it on purpose and raises it again; raising it ends a dual pair (like pressing `F`). With a two-handed weapon in hand, the key chooses whether it comes up with your next one-handed weapon.
  - **Pick-up rules:**
    - One shield at a time. Touching a shield while yours is more damaged tops yours up to the item's HP.
    - Dying drops it on the floor below you with the HP it had left, for 30 s (§12). So does leaving the game.
    - Pellets that shove a carrier through its shield count as an attack: knocked into a pit, it's the shooter's kill (§8).
  - **Blocking:** the shield is a vertical segment 0.9 m tall (0.35–1.25 m standing, 0.12–1.02 m crouched).
    - Raised, it sits 0.42 m in front of the body and blocks bullets from within ±60° of the facing.
    - Slung, it sits 0.40 m behind the body and blocks bullets from within ±60° of the back. A raised shield never guards the back, and a slung one never guards the front.
    - A bullet that strikes it takes shield HP instead of health, with the usual falloff; pellets still shove the carrier. Front and back share the one 300 HP pool.
    - Shots over it (the top of the head) or under it (the legs) still land. The bullet that breaks it is stopped by it.
  - **Ricochet:** a bullet that strikes the shield, front or back, reflects about the shield's normal.
    - It flies on with the range it has left and ×0.6 damage, and bounces at most once (a second shield stops it). The range left is spent the way the map spends any bullet's (02-physics §20): fog shortens the ricochet and its falloff counts the fog.
    - It can hit anyone except the shield's owner and **never its own shooter** (bullets never hurt their shooter, §8; the owner's call, 17 Oct).
    - Lag compensation applies: the shield, raised or slung, is rewound with its owner.
    - Pellets ricochet one by one.
  - **Shield bash:** melee with the shield up does 25 (a melee weapon still swings as itself).
  - **Dash** (02-physics §21): no dash while the shield is up or coming up; lower it (`X`) to dash. Slung, it doesn't stop a dash. Pellets on the shield push its carrier like any hit, so they end a dash too.
- **Movement speed** is multiplied by `moveSpeedMul` of the held weapon (the heaviest of dual pair).
- **Zoom:** see §10.

---

## 10. Zoom & scope system

Zoom makes the camera pull **out** so you see more of the map (1×–7×). In 2.5D, zoom = camera distance:

| Zoom level | 1× | 2× | 3× | 4× | 5× | 6× | 7× |
|---|---|---|---|---|---|---|---|
| View width multiplier | 1.00 | 1.20 | 1.40 | 1.60 | 1.80 | 2.00 | 2.30 |
| Visible width (default 36 m) | 36 m | 43 m | 50 m | 58 m | 65 m | 72 m | 83 m |

- **Mouse wheel / `Z`** cycles up to the weapon's `zoomMax`. "Zoom on pickup" setting: last-used / max / smart (smart = per-class preference). These are genre-standard options.
- When zoomed, camera look-ahead shifts toward the cursor (camera spec in 01-game-design §5).
- **Anti-zoom-hack:** the server's AOI view rect is the **weapon's max zoom** + margin (05-netcode §9). A hacked camera sees nothing extra.

---

## 11. Special weapon mechanics

| Weapon | Mechanic |
|---|---|
| Breacher | 5 pellets; each pellet hit applies 0.6 m/s of knockback (point-blank = a big shove); pellets don't penetrate |
| Dragon | spawns a flame projectile every 0.15 s (sim projectile: 7 m/s initial speed, gravity −0.2, life 0.8 s, radius grows 0.15 → 0.6 m). Hits apply 20 dmg + a **burn** of 4 dmg/s for 2 s. Flames reflect weakly off walls → user damage when close. **Clears gas clouds** it touches. Passes around riot shields |
| Arc | a continuous beam: one ray per 0.15 s tick from the shoulder; hitscan with lag comp; perfectly accurate; draws a persistent beam VFX; cell regenerates when not firing |
| Thumper | sim projectile 20 m/s, no gravity, smoke trail; explodes on contact or at 60 m; splash per 02-physics §14; huge knockback (rocket jumps possible: self-damage 50%) |
| Popper | arcing grenades (gravity 1.0, e = 0.3); explodes on player contact or after 1.2 s |
| Ripper | needs a 0.4 s charge; the blade travels 18 m/s, **bounces off walls** (e = 1.0, no friction), **passes through players** (damaging each once per bounce segment), explodes after 5 s; deadly to its owner |
| Pulse | slow orb (8 m/s) passes through walls; on a player hit or at end of life → EMP burst R 2.5 m: jetpacks disabled for 3 s, mines disarmed, no damage |
| Shredder | 0.8 s spin-up (audible to nearby enemies, a fair warning), spin-down 1 s; can pre-spin with the secondary button; −30% move speed |
| Machete | one-hit melee; replaces the default knife while held; the dual pair only swings one |
| Grenades | 02-physics §14 (frag, smoke, toxic gas, flashbang, proximity mine, EMP): one key throws the selected type, `T` cycles. Smoke is cover (bots and the AOI can't see through it); gas is area denial (stay in the middle and you die); a flashbang whites out everyone looking at it for up to 2.5 s (a "Reduce flashes" setting swaps the white for a dark blur) |

---

## 12. Map weapon spawns

- Maps define **spawner nodes** with a pool (`common` or `power`) and a respawn timer (common 20 s, power 45 s, health pack 25 s, Power Boost 40 s, grenade pairs 20 s). These are estimates, tuned by mode.
- **Built** (`MapDef.spawners`, `packages/sim/src/pickups.ts`): a spawner owns one or more **spots** and one timer. When the timer fires, the game's seeded PRNG picks a free spot and an item from the spawner's pool (weighted), so items appear at random places and times. Timers are random too: `first` (seconds before the first item) and `respawn` (seconds after an item is taken), each a [min, max] range. `maxActive` caps how many of its items are out at once. A spawner with one spot is a classic fixed spawn. Spawners start over when a match starts. Players take items by touching them. Dropped items stay 30 s. The riot shield is the first item (pool `shield`); the movement-test map has a shield spawner with three spots in front of the shooting range. Map JSON (02-physics §20.6) carries spawners too: `spawners: [{ id, pool, spots: [{x, y}], first: [min, max], respawn: [min, max], maxActive? }]`, in `map.schema.json`.
- Placement guidelines (map editor lint): power weapons in **contested, exposed** spots (the top of a tower, the middle of a bridge), never next to a spawn point. Health packs away from weapon spawns. No spawner reachable without leaving cover for at least 1.5 s.
- **Pickups:** **Health pack** (instant full heal, only if hurt), **Power Boost** (unlimited jetpack fuel for 20 s; can't crouch; you *can* fly off the top of the map), **Riot Shield**, **Grenade pair**, **Ammo box** (refills both slots).
- **Grenade pairs (built, arsenal B):** six items, a pair of one type each (frag, smoke, gas, flashbang, mine, EMP), in the `grenades` pool: frag 3, smoke 2, flashbang 2, gas 1, mine 1, EMP 1 (weights). The seeded pool draw picks the type each time, so a spot gives a random pair. Touching one puts the pair on your belt up to the type's carry limit (docs/02 §14); with that type full it stays on the floor. On Lunar Outpost, Storm Front, Flux Lab and the movement-test range (up on its platforms and tower), 18–24 s respawns (8–14 s on the range).
- Some weapons are map-specific (rare guns only on certain maps), which gives maps identity.

---

## 13. Feedback & juice (where the fun lives)

| Event | Feedback |
|---|---|
| Fire | muzzle flash (light pulse + sprite), tracer, shell casing (client particle), weapon kick, small camera kick, layered sound (mechanical + body + reverb tail by map) |
| Hit (server-confirmed) | crosshair hit marker (white body / **orange head**), hit sound (distinct for headshots), optional damage numbers |
| Kill | kill marker (X), kill sound, kill-feed entry (icon per weapon, headshot badge, wallbang/environment badges), multikill and streak banners (Double/Triple/Rampage) |
| Taking damage | directional red arc at the screen edge, low-HP heartbeat + desaturation below 30 HP, regen shimmer when healing |
| Explosion | screen shake by distance, ear-ring audio filter when very close, debris |
| Impact | decals + particles per material (concrete dust, metal sparks, wood splinters, dirt puffs, glass shards) |
| Melee | hit-stop of 2 frames (client-only visual pause), whoosh + thud |

All of it is client-side and cosmetic, and can be scaled down by the graphics preset and the reduced-motion setting.

---

## 14. Balance process

1. Weapon stats live in content JSON, hot-reloadable in dev and versioned in prod (06-architecture §8).
2. Telemetry per weapon: pick rate, kill share, win rate when held, accuracy, headshot %, median engagement distance, TTK in practice, by skill band.
3. Weekly balance review, with **one change per weapon per patch** and patch notes explaining why.
4. A "classic" ruleset (no falloff, crouch head-cover quirk, original carry limits) is available in custom rooms for nostalgia players.
