# 08 — Battle Royale: "Drop Zone"

> A drop-in battle royale designed for a **2.5D side-view** world: people click **Play** and are falling out of a cargo plane within seconds.
> Reference values come from survev (the open-source surviv.io remake), Fortnite, Battlelands Royale, Brawl Stars Showdown and Mini Royale. All numbers are starting points for playtests.

---

## 1. Design goals

1. **≤ 20 s from click to falling.** Lobbies start on a timer and are topped up with bots; new arrivals can join a match while the plane is still flying.
2. **6–8 minute matches.** Short enough for "one more", long enough for a loot → fight → rotate arc.
3. **Vertical play matters.** The jetpack is the identity of the game, so the zone also closes **vertically** in late phases (no one wins by hovering at the ceiling or hiding in a tunnel).
4. **Readable in 2D.** Everything must be legible on one horizontal strip: the storm walls, loot rarity, and where enemies are coming from.
5. **No pay-to-win.** Loot is found, never bought.

---

## 2. Format

| | Solo | Duos | Squads | Arcade (LTM) |
|---|---|---|---|---|
| Players | 32 (target 40 after perf tests) | 16 × 2 | 8 × 4 | 16 solo |
| Match length | ~7 min | ~7.5 min | ~8 min | ~4 min |
| Bots | fill to min 24 humans+bots when the queue is thin; never in Ranked | same | same | allowed |
| Knock/revive | no | yes | yes | no |
| Respawn | no | redeploy beacon (post-MVP) | redeploy beacon | 1 respawn |

Why 32 and not 100: a side-view screen shows ~40 × 22 m of world. Thirty-two players on a 480 m strip gives about the same encounter density as 100 on a Fortnite island. More players need a wider map, which means a longer early game where nothing happens.

---

## 3. The map ("Strip")

- **Size:** 480 m wide × 140 m tall. Positions are quantised to 1/1024 m, so ~19 bits per axis on the wire (02-physics §15, 05-netcode §6).
- **Vertical layers:**

```
y 140 ┤ ░ sky (plane path y≈132) ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░
y 100 ┤      ▄▄ sky islands / radio tower tops / crane ▄▄            ▄▄ cliff fort ▄▄
y  60 ┤ ▓▓ docks ▓▓  ▓▓ old town ▓▓  ▓ forest ▓  ▓▓ factory ▓▓  ▓ mountain ▓  ▓▓ airbase ▓▓   (surface)
y  25 ┤ ═══ sewer ═══ ═ metro line ═══════════  ═ mine shafts ═══  ═══ bunker ═══            (underground)
y   0 ┤ ■■■■■■■■■■■■■■■■■■■■■■■■■■■ bedrock / flood zone ■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■
```

- **8–10 named POIs** with loot density tiers: hot drops (factory vault, airbase hangar) vs quiet edges. The map editor validates POI loot budgets.
- **Traversal:** jump pads between layers, ziplines (post-MVP), breakable floors in 2–3 spots, ladders (cosmetic only, the jetpack covers it).
- **Map variants:** seasonal skins of the same collision (snow, Halloween, monsoon) change art and loot tables, not geometry. That's cheap live-ops (survev does the same).

---

## 4. Deploy (the drop)

1. **Lobby:** a 30 s timer *or* full, whichever comes first. A pre-match "warm-up yard" lets players fly around and shoot each other with no damage while they wait.
2. **Plane path:** fixed altitude (y ≈ 132), flying left→right or right→left (random), crossing in **40 s**.
3. **Jump** any time with the jet key. Auto-eject at the end of the path.
4. **Drop physics:** the jetpack has unlimited fuel while dropping, fall speed is capped at 9 m/s (or 18 m/s holding *down* for a fast "dive"), and horizontal steering goes up to 10 m/s. The drop ends on touching ground or when the player is below y = 70.
5. **Landing protection:** invulnerable until the first shot or 1.5 s after landing, whichever comes first.
6. **Squads:** a "jump together" toggle (leader controls the drop and followers trail with an offset); otherwise free drop.
7. **Spawn spacing:** n/a for plane drops; for Arcade respawns use survev-style rules (min 25 m from enemies, teammates within 5 m).
8. **"Hot join" (the drop-in requirement):** while the plane is still crossing and slots are free, the matchmaker places newly queued players straight onto the plane (they get the remaining jump window). This keeps waits near zero at low population.

---

## 5. The storm (2D zone)

The safe zone is an **interval** `[L, R]` on the x-axis, plus vertical limits in late phases:
- **Walls:** left and right storm walls move inward toward the next safe interval.
- **Ceiling:** from phase 3 a "static ceiling" descends, so sky camping isn't safe.
- **Flood:** from phase 4 acid water rises from the bottom, so tunnel camping isn't safe either.

Each next safe interval is chosen randomly but **always inside the current one** (1D version of the classic circle rule), and biased away from map edges in phases 1–2.

| Phase | Wait (s) | Shrink (s) | Safe width | Ceiling | Flood | Storm DPS |
|---|---|---|---|---|---|---|
| 0 Drop | 40 (plane) | — | 100% (480 m) | — | — | — |
| 1 | 75 | 30 | 60% (~288 m) | — | — | 2 |
| 2 | 50 | 25 | 35% (~168 m) | — | — | 4 |
| 3 | 40 | 20 | 18% (~86 m) | y ≤ 105 | — | 7 |
| 4 | 30 | 15 | 9% (~43 m) | y ≤ 85 | y ≥ 15 | 12 |
| 5 | 20 | 15 | 4% (~19 m) | y ≤ 75 | y ≥ 25 | 18 |
| 6 Final | 10 | 20 | 0 | closes | rises | 25 |

Total ≈ 6.3 min after the drop, plus early fights ≈ 7 min. Rules:
- The storm DPS ramps so that **healing can't outheal it** from phase 4 onward.
- The final phase closes completely, so matches always end.
- **Simultaneous last deaths** share the placement (both get "#1"). The tie-break for XP is the most damage.
- The client simulates the storm locally from the `STORM` schedule message (05-netcode §5). Zero per-tick bandwidth.

**Readability:**
- The walls are animated purple energy curtains, with a distortion shader.
- Inside the storm: desaturated, a vignette, a heartbeat SFX, a damage tick sound, and a visual indicator for players who rely on captions.
- The HUD shows a top strip minimap with the current and next interval, a countdown, and an off-screen arrow plus distance.

---

## 6. Loot

### 6.1 Rarity (colour **and** shape so it's colour-blind safe)

| Tier | Colour | Icon frame | Weapon damage mul | Spawn weight (floor loot) |
|---|---|---|---|---|
| Common | grey | circle | ×1.00 | 45 |
| Uncommon | green | square | ×1.05 | 30 |
| Rare | blue | diamond | ×1.10 | 16 |
| Epic | purple | hexagon | ×1.15 | 7 |
| Legendary | gold | star | ×1.20, +1 mag size step | 2 |

Rarity changes **damage, mag size and reload slightly**. It never changes fire rate (so weapon sounds stay recognisable).

### 6.2 Containers
- **Floor spawns:** weighted tables per POI tier.
- **Crates:** breakable (2 melee hits or 30 dmg) → 2–3 items.
- **Safes:** 2 s channelled open, interrupted by damage → guaranteed rare+.
- **Supply drops:** at phases 2 and 4, announced with a map marker and a flare. They contain epic/legendary items plus a guaranteed armour piece.
- **Death crates:** a dead player's whole inventory goes into one crate with a grid UI. No item spray in 2D, because it clutters the screen.

### 6.3 Items

| Category | Items |
|---|---|
| Weapons | the full arsenal from 03-weapons, with rocket launcher / minigun / laser restricted to supply drops |
| Ammo | Light (pistols, SMGs), Heavy (rifles, LMG), Shells, Sniper, Special (rockets, fuel, cells) |
| Armour — vest | T1/T2/T3: absorbs 30/45/60% of body damage, armour HP 50/75/100 |
| Armour — helmet | T1/T2/T3: headshot multiplier reduced by 20/35/50% |
| Heals | Bandage +15 HP, 2 s, capped at 75 HP · Medkit → 100 HP, 5 s · Shield cell +25 armour HP, 2 s · Adrenaline: +2 HP/s for 20 s, +10% move speed |
| Mobility | Nitro can: refills fuel + 6 s of 1.5× thrust · Jump-pad deployable (rare) |
| Throwables | Frag, Gas, Proximity mine, Smoke (blocks rendering of players inside, not bullets) |
| Backpack | T1/T2/T3: raises ammo and heal stack caps |
| Scopes | tie into the zoom system: 1.5×/2×/3× unlock wider camera views on compatible weapons. **Server AOI follows the equipped scope** (05-netcode §9) |

### 6.4 Inventory
- 2 weapon slots + melee + throwable belt (4 types) + 4 consumable stacks.
- **Dual-wield:** same rule as core modes (03-weapons §9). When both weapon slots hold one-handed guns, toggle dual with `F`. In BR this is a deliberate loot choice: two sidearms that dual-wield vs. one rifle and one backup.
- Ammo and heals are auto-picked-up by walking over them. Weapons need explicit pickup or a hold-to-swap prompt.
- Healing is cancelled by firing, jetting, or taking more than 25 damage in one hit. Walking is allowed at 50% speed.
- Heal wheel (hold `Q`) + quick keys `5–8`.

---

## 7. Knocks, revives, squads

| | Value |
|---|---|
| On "death" with a living teammate | **KNOCKED**: crawl at 1.2 m/s, can't shoot, can ping |
| Bleed-out | 30 s. Damage taken while knocked shortens it. Each further knock in the same match is 25% faster |
| Revive | 5 s channel within 1.5 m, either player can cancel → revived with 30 HP |
| Credit | the knocker gets "knock" and the elimination credit (the finisher gets an assist) |
| Squad wipe | all members knocked or dead → the whole squad is eliminated |
| Redeploy beacon (post-MVP) | pick up a fallen teammate's tag within 60 s, take it to a beacon (8 s) → teammate redeploys by air, before phase 4 only |

---

## 8. Spectating & end of match

- On elimination: death recap (who, weapon, damage taken in the last 10 s, distance), then auto-spectate the killer after 2 s (squads: a living teammate first).
- Spectator controls: next/prev player, follow-killer toggle, free cam (custom rooms only).
- "Play again" (keeps the party) and "Return to lobby" are always visible, so leaving early is never punished.
- Results screen: placement, kills, damage, survival time, XP breakdown, mission progress, a "share clip" button (MediaRecorder WebM of the killcam buffer).
- **Kill leader** gets a crown marker once they have ≥ 3 kills and the most kills.

---

## 9. Bots

- Server-side behaviour trees (`packages/bots`) ticking at **10 Hz**. They use the same input interface as humans, so the sim can't tell the difference and bots can't cheat by accident.
- Behaviours: `loot → roam toward safe zone → engage (aim error model) → heal when < 50 → flee storm → third-party fights`.
- Difficulty tiers set reaction time (250–600 ms), aim error (cone 2–9°), and jetpack competence.
- **Fill policy:** more bots for new players (first 10 matches) and in thin regions/hours. **None in Ranked.** Bots never join human parties. Bots are flagged in all analytics. Fill drops off automatically when the queue is healthy (e.g. ≥ 30 humans waiting in region).
- Names come from a curated list. Server-side `isBot` is never sent to clients in normal modes (it's hidden in the kill feed); results screens do reveal them.

**As built (Phase 0, deathmatch; NOTES §23).** `packages/bots`: a bot is a player with a `Brain` the sim calls at the start of `Game.step`. It acts through the same Input as a human, decides at 10 Hz (staggered by id), and uses its own seeded randomness, so replays and goldens include bots.
- **Navigation:** a graph per map built from the collision world. Nodes are where a probe body comes to rest. Each walk, jet, drop and pad link is first flown through the real movement code, so map mechanics are part of every link. At runtime the bot avoids jet links while its jetpack is dead (EMP fields, storms, EMP grenades), event hazards (gravity pockets), and gas and mines it has seen (a cost on links into or through them; gas it isn't in closes them while it lasts).
- **Perception:** what the server sends a client: the view rect (a side view, so walls don't hide players) minus whoever smoke hides (the sim's `SmokeSight`, as the AOI uses), nothing in a flashbang's full white, gunfire from anyone it can't see only as a SOUND (4 m grid, no name, within 35 m), and who hit it. Items by kind and place (not a dropped shield's HP). It shoots only with a line of fire, at a body its bullets reach (the gun's range, or what a map's fog leaves of it), and goes around obstacles to get a shot; a target it can't get one at is given up for a while.
- **Aim:** in metres at the target, with a drift and a tremor plus reaction time, tracking lag and lead. A flashbang's fade makes it up to 5× worse; far off, it grows with the zoom a human would use (×1.4 at 30 m).
- **Tiers:**

  | Tier | Reaction | Aim error at 12 m | Avoids routes over |
  |---|---|---|---|
  | Easy | 600 ms | ~10° | 70% of a tank |
  | Normal | 400 ms | ~6° | 90% |
  | Hard | 250 ms | ~2.5° | none |

- **Behaviours** (deathmatch):
  - get out of gas it's in, the cheapest way by path (a drop before a climb; for a jet out, it waits on the ground for the fuel);
  - wait out a flashbang's white;
  - fall back to regenerate when hurt;
  - fight what it sees from a spot at its gun's range and reach (dry, it closes in to bash);
  - throw frags now and then (frags only, for now);
  - dash away from hits;
  - grab a better shield it has seen (raised in a fight, slung otherwise);
  - hunt what it heard;
  - roam (or wait, when gas closes every way on).
- **Names:** for Phase 0 playtests, names carry `[BOT] `; the hidden-`isBot` rule above applies when BR ships.
- **Rooms by code (Phase 0):** the game server keeps a room with a human in it at a number of players (`RoomOptions.fillBots`, `--bots=`); a joiner takes the lowest-scoring bot's place, and bots leave with the last human. `pnpm playtest` fills rooms to 4.

---

## 10. Matchmaking for Drop Zone

```
Player/party clicks "Drop Zone" (solo|duo|squad) ─▶ ticket(region ping vector, party, mmr)
  matchmaker per (region, teamSize):
    1. if an IN_PROGRESS match is still in phase 0 (plane flying) with free team slots → HOT JOIN
    2. else join the oldest LOBBY in region (timer starts when the first human joins: 30 s)
    3. lobby full OR timer done → fill with bots to the min count → start
  skill: soft (MMR bands widen every 10 s); ranked queue uses OpenSkill (Plackett-Luce) per teamSize
```

---

## 11. Server & bandwidth notes

- 32–40 players + ~20 bots max + ~600 loot items + projectiles. Loot is **static until touched**: sent once in AOI as a spawn record, then only on pickup/despawn. No per-snapshot cost.
- 20 Hz snapshots with AOI tiers (05-netcode §9). Datagrams stay ≤ 1000 B via the priority accumulator.
- Sim budget ≤ 2 ms/tick → **2–4 BR matches per core** including network I/O (09 §3). Bots run at 10 Hz in a staggered schedule (1/6 of bots each tick).

---

## 12. Fairness & abuse specific to BR

- **Teaming in solos:** heuristic (two players within 15 m for > 60 s, no damage between them, both shooting others) → auto-flag + report shortcut. Repeat offenders go to the shadow pool.
- **Stream sniping:** streamer mode hides the queue timer and region; optional delay for live spectators.
- **Hot-join exploits:** hot joiners land last, never get supply-drop priority, and late joiners' MMR changes are dampened.
- **Leaving with loot to deny teammates:** a disconnected player's inventory stays in a crate at their last position after 60 s.

---

## 13. Rewards & progression hooks
- XP: survival time (per minute), placement (top 50% / top 10 / win), kills, damage, revives, supply drops opened.
- Missions: "Win a Drop Zone match", "Land at Factory and get 2 kills", "Revive 3 teammates", "Deal 500 damage with dual-wield".
- Win rewards: a victory pose/banner, seasonal "crown" counter, and first win of the day ×2 XP.
