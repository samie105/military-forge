You're designing round two of the user interface for **Military Forge**, a fast 2.5D multiplayer shooter that runs in the browser. Round one, the kit `military-forge-ui.html`, is already built into the game. This round adds the screens for everything the team has built since. You also have **full creative freedom on the look**: a bold new visual concept is welcome, as long as the structure and markers below stay. Make something people screenshot and send to their friends.

## The world your UI lives in
The other teams are building this right now. Your concept should feel like it belongs here.
- **Soldiers:** chunky, toy-like 3D soldiers with toon shading and a thin ink outline. They lean when they run, plant their feet, flail when a blast throws them, and flinch when shot. Players dress them in the **Locker**: outfits, dyes and helmets. Nothing a player wears may stick out past the body.
- **Guns:** chunky and toy-like, built from generated concept art, with bright tips. Each one *moves*: pumps slide, bolts cycle, slides kick and cylinders turn, and casings fly out. Gun finishes include gold, chrome and carbon. The unused gun hangs on the soldier's back, and switching plays a visible draw.
  - Pistols: Hawk .50, Hammer .44, Buzz, Rattler.
  - Rifles: K-47, Hornet, Trident, Bullpup, Arc.
  - Shotgun: Breacher. Snipers: Widow, Longbow.
  - Launchers: Thumper, Popper, Ripper, Pulse. Heavies: Shredder, Dragon.
  - Also: the Riot Shield, and the Machete for melee.
- **Grenades:** Frag, Smoke, Toxic gas, Flashbang, Proximity mine and EMP, each with its own shape. Tap G for a quick throw; hold G to aim along an arc.
- **Movement:** jetpacks, an 8-way dash with a glowing trail and sparkles, and blasts that launch soldiers across the map.
- **Maps:**
  - Street Market: a Lagos-inspired market street with billboards, minibuses and street lamps.
  - Lunar Outpost: a moon base with Earth in the sky.
  - Storm Front: a storm over a cold port.
  - Flux Lab: a lab hall where gravity misbehaves.
  - Also: Movement Test and Mechanics Test.
  - More cities and countries will come, one map at a time, and a battle royale mode later.
- **Map events:** banners such as GRAVITY POCKET, SOLAR FLARE, SQUALL, FOG ROLLS IN, LIGHTNING STORM and EMP STORM.
- **How people play:** friends share a room link on WhatsApp, and bots fill empty slots up to 4 players. A match lasts about 5 minutes. Most first players are in Nigeria and India, on desktop and on phones held sideways.

## Concept direction (yours to own)
- We are not giving you a palette. Invent the visual identity: shapes, type, texture, motion and a colour story that fit this world.
- Aim for **tactile, chunky and full of energy**: physical cards, stamped badges, stencil cuts, poster energy, punchy transitions. Menus feel alive, with gentle idle motion behind them, while the HUD stays calm and readable mid-fight.
- **The one colour rule:** blue and orange mean the two teams and nothing else. Never use them for buttons, accents or warnings.

## Screens and states to design
Redesign every round-one screen in your new concept: name entry, home, join with code, lobby (host and guest), connection states, countdown, the HUD with all its states, scoreboard, event banner, results, settings, pause, loading and the phone HUD. Then add these:

1. **Host "Tune the game" panel.** The room's host opens it from the pause menu and changes the match for everyone live.
   - Sliders for: jetpack fuel (max, burn, regen), jet thrust, gravity, run speed, dash (distance, cooldown), blast launch strength, grenade throw speed, and respawn time.
   - Buttons: Reset, Presets (Classic, Floaty, Chaos), and "Copy values".
   - It sits at the screen edge, never over the centre, with a small "Tuned by host" tag that every player sees.
2. **Weapons in the world:**
   - A weapon crate on the map, and its pickup prompt: "[E] Swap Buzz ⇄ Dragon", with a compact stat comparison (damage, fire rate, range, weight, mag).
   - The **test armory** rack near spawn, with all 20 weapons, each with a name tag.
   - An ammo-low cue and an empty-gun cue.
3. **Weapon switch and slung gun.** The HUD shows both slots: the held gun big, the slung gun small, with an icon that shows it is on the back. While switching, an equip-progress ring plays (0.25 to 0.6 s). Also design dual pistols and a melee-only state.
4. **Grenade belt v2:**
   - All 6 types with distinct icons and counts, and the selected type.
   - A throw-strength meter near the reticle while G is held, and a "quick throw" flash when G is tapped.
   - An amber warning when a map event will bend the arc.
5. **Dash v2:** the dash cooldown ring, the air-dash pip, and a tiny direction hint when you double-tap.
6. **Hit feedback v2:**
   - Damage-direction arcs scaled by damage, and stagger feedback for heavy hits.
   - A headshot marker, a ricochet-off-shield marker, and a "launched by blast" marker.
   - A **Blood effects** setting, off by default. The HUD must look complete without blood.
7. **Lobby v2:**
   - **Map picker cards**, each with a thumbnail, the place name, a one-line tagline, and its events.
   - **Time of day:** Day, Dusk, Night or Random.
   - **Bots:** count (0 to 7) and difficulty (Easy, Normal, Hard).
   - Host tools: Add bot, Remove bot, Kick player.
   - Two share links: "Same Wi-Fi" and "Internet", each with a QR code. Sharing stays the loudest thing on the screen.
8. **Map intro card.** A short reveal as the match starts, for example "STREET MARKET · Lagos", with the mode and limits.
9. **Kill feed v2:** icons for all 20 weapons, 6 grenades, melee and the shield. Badges for headshot, ricochet, blast launch, mine, gas, fall and dash kill.
10. **Results v2:**
    - The winner, plus a highlight reel as cards: longest shot, biggest blast launch, most dash kills.
    - A per-weapon breakdown.
    - A **shareable MVP card** sized for WhatsApp.
    - Play again with votes.
11. **Locker v2 (dress your soldier):**
    - A large 3D soldier preview with tabs for Outfit, Helmet, Dyes, **Gun finishes** (gold, chrome, carbon), **Dash trail** (the default glow plus unlockable trails) and **Muzzle-fire colour**.
    - A badge that keeps the rule visible: nothing sticks out past the body.
12. **Armory v2 (look at the guns):**
    - A turntable of each gun with a stat card and an attachment preview (scope, suppressor, foregrip, extended mag, laser).
    - Buttons to preview finishes and to play its mechanism: the pump, the bolt, the casing.
13. **Settings additions:**
    - Graphics: Auto, Low, Medium or High.
    - Blood effects: off by default.
    - Double-tap to dash: on by default.
    - The touch layout editor.
    - Host only: "Allow tuning in my rooms".
14. **Phone HUD v2 (812×375):**
    - Hold the grenade button to aim with the right stick.
    - Tap Dash.
    - Swap shows thumbnails of both guns.
    - A pickup button that appears only near a crate.
    - Every touch target at least 48 px, translucent, and clear of the notch.
15. **Future concept (optional, one page):** a **battle royale** mood board.
    - Drop-in screen, shrinking-zone timer, players-alive count, a loot and inventory strip, and a squad bar.
    - This is concept only; it isn't built yet.

## Data the new screens show (mark each with data-bind)
- `player.slot[0|1]`: `name`, `family`, `mag`, `magSize`, `reserve`, `slung` (bool), `equip` 0–1 (switching), `dual`, `finish`.
- `pickup.weapon`: `name`, plus `stats` (damage, rate, range, weight, mag) for the held gun and the offered gun.
- `grenades.belt`: 6 × {`type`, `count`, `max`}, plus `selected`, `throwStrength` 0–1, `arcWarning` (bool).
- `dash.cooldown` 0–1, `dash.airUsed`.
- `hit.dir` (angle), `hit.amount`, `hit.kind`: bullet, blast, headshot, ricochet or gas.
- `match.tuned` (bool), and `tuning.*` (each slider's value, min, max, default).
- `lobby.map` (`id`, `name`, `place`, `tagline`, `events[]`), `lobby.timeOfDay`, `lobby.bots.count`, `lobby.bots.level`, `lobby.links.lan`, `lobby.links.internet`.
- `results.highlights[]`, `results.byWeapon[]`, `results.mvp`.
- `settings.blood`, `settings.doubleTapDash`, `settings.graphics`.

## Rules (keep these)
1. **Readable over a busy 3D battlefield:** solid backplates or ≥ 85% opacity, a subtle text shadow, and no text under 14 px.
2. **Keep the centre clear.** Only the reticle, hit markers, damage arcs, the throw meter and short banners go in the middle 60%.
3. **Cheap to draw at 60 fps** on low-end laptops and phones:
   - no backdrop-filter, big shadows or animated gradients on the HUD;
   - every bar driven by one CSS number;
   - motion belongs in menus, not the HUD.
4. **Screen sizes:** 1280×720 up to 2560×1440, plus 812×375 phones with notches, inside safe-area margins.
5. **Accessibility:**
   - WCAG AA contrast;
   - full keyboard use with visible focus;
   - Reduce flashes and Reduce motion versions of anything that flashes or moves;
   - text at 150% doesn't break layouts.
6. **Translation-ready:** leave 30–40% extra room for text, with no text baked into images.
7. **Keycaps are data:** every [G], [E] and [Shift] can be rebound.
8. **The brand name appears once,** in `data-bind="brand.name"`.
9. **Original work only.** Don't imitate other games' HUDs, icons, fonts or layouts, and don't name other games anywhere. No real brands either.
10. **No ads in the interface.** Ads live only on in-world billboards.
11. **Sharing grows the game,** so make sharing the most obvious action wherever it appears.

## Deliverable
ONE self-contained HTML file, `military-forge-ui-v2.html`:
- **Format:** inline CSS; plain JavaScript only for a screen picker and state toggles; no frameworks and no external requests, except at most 2 Google Fonts families with system fallbacks. We self-host the fonts.
- **Screens:** each screen is `<section class="screen" data-screen="…">` at 1920×1080. The phone HUD is at 812×375.
- **Tokens:** every colour, font, size, space, radius, shadow and z-layer is a CSS custom property in ONE `:root` block. Our engineers copy them as they are.
- **Icons:** inline SVG in one `<svg>` sprite of `<symbol id="icon-…">`, all original. That includes all 20 weapons, 6 grenades, the shield, melee and the kill-feed badges.
- **Markers:** `data-bind="…"` on every changing value and `data-state="…"` on every state.
- **Sample data:** real names (Ade, Kemi, Raja, Tunde, Zainab, Vikram, plus `[BOT] Kestrel` and `[BOT] Osprey`), the real weapon, grenade and map names above, and real-looking numbers. No lorem ipsum.
- **Header comment:** list the components, what changed from round one, and anything the engineers should know.
