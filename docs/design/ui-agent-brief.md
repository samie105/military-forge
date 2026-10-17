You are designing the user interface for **Military Forge**, a fast 2.5D multiplayer shooter that runs in the web browser. Soldiers fly with jetpacks, fight with guns, grenades, melee and riot shields, and dash in 8 directions. The world is rendered in 3D but played on a flat side-view plane. Matches last about 5 minutes. Friends play together by sharing a room link (often on WhatsApp). The first players are in Nigeria and India. Desktop with keyboard and mouse comes first; phones in landscape follow soon.

## What to deliver

ONE self-contained HTML file named `military-forge-ui.html`:
- **Code:**
  - Inline CSS. Plain JavaScript only to switch screens and states: a small screen picker at the top of the page, plus toggles for the states listed below.
  - No frameworks, no build step, no external requests. The only exception is up to 2 Google Fonts families, each with a system-font fallback.
- **Screens:** each screen is a `<section class="screen" data-screen="…">` laid out at 1920×1080. The in-match HUD is also shown at 812×375, phone landscape.
- **Design tokens:** every colour, font, type size, spacing step, radius, shadow and z-index layer is a CSS custom property in ONE `:root` block at the top. Our engineers will copy these tokens as they are.
- **Icons:** inline SVG in one `<svg>` sprite of `<symbol id="icon-…">` elements, all original drawings.
- **Sample data:** realistic content (player names like Ade, Kemi, Raja, Tunde, Zainab, Vikram; real-looking numbers). No lorem ipsum.
- **Markers for us:** mark every changing value with `data-bind="…"` (for example `data-bind="player.hp"`) and every state with `data-state="…"` (for example `data-state="reloading"`), so we can wire it up.
- **Header comment:** a short comment at the top listing the components and anything we should know.

## Screens

1. **Name entry (first visit):** "What should we call you?", a text field (3–16 characters), a live check ("Available" / "Someone already has that name" with 2–3 suggestions), and "Pick one for me".
2. **Home:**
   - the player's name with an edit button;
   - Play with friends (creates a room), Join with code, Quick play (show as "coming soon"), Training (practice against bots), Locker (dress your soldier), Armory (look at the guns), Settings;
   - a compact controls reminder.
3. **Join with code:** 6 large letter boxes (the codes use letters only). Pasting a full link also works. Show an error state ("No room with that code").
4. **Room lobby,** in two variants: host view and guest view.
   - The room code, big.
   - A very prominent **Copy link** button, a **Share on WhatsApp** button, and a QR code area of about 160 px.
   - The player list, up to 8: name, HOST badge, BOT badge, ready tick, ping in ms.
   - Host-only settings: time limit (1, 2, 3, 5, 8, 10, 15, 20 min, or none), kill limit (5–100, or none), map (Movement Test, Street Market, Lunar Outpost, Storm Front, Flux Lab).
   - Guests see the settings read-only, with "The host picks the settings".
   - A **Ready** button, plus **Start now** for the host.
   - A note: "Warm-up: move and shoot freely, nothing counts until the match starts."
5. **Connection states:** Connecting…; Reconnecting… (as a banner over the game); and error screens with Rejoin / Home buttons for: room full, room not found, new version available (with Reload), server full, kicked by host, connection lost.
6. **Countdown overlay:** "MATCH 1", then 3 – 2 – 1 – GO, with the mode and limits shown ("Deathmatch · first to 10 · 5:00").
7. **In-match HUD.** This is the most important screen; the full data list is below. Show these states:
   - normal;
   - low HP (under 30);
   - reloading;
   - shield up;
   - EMP (jetpack disabled);
   - blinded by a flashbang: full white, plus the "Reduce flashes" version, which is a dark grey vignette with blur and is never white;
   - in toxic gas;
   - dash on cooldown;
   - spectating while respawning: "Respawn in 3 s".
8. **Scoreboard (Tab):** rank, name, kills, deaths, score, ping, HOST and BOT badges, mute and report buttons. Highlight your own row.
9. **Map event banner:** for example "GRAVITY POCKET: Gravity flips over a catwalk · 4 s", plus a warning variant ("in 5 s").
10. **Results:**
    - the winner and the reason ("Kill limit reached" / "Time's up · 5:00");
    - your placement, kills, deaths, damage, MVP;
    - the full standings;
    - **Play again** (with votes, for example 2/4), **Back to lobby** (host only), **Leave room**.
11. **Settings,** with five tabs:
    - **Graphics:** Low / Medium / High, plus an FPS display toggle.
    - **Audio:** master, effects, music sliders.
    - **Controls:** a rebinding table for every action (move, jet, crouch, dash, fire, reload, swap, grenade, cycle grenade, melee, shield, zoom, scoreboard), each with two bindings plus "Double-tap a direction to dash".
    - **Accessibility:** Reduce flashes, Reduce motion, colour-blind team colours, text size 100–150%.
    - **Network:** low-bandwidth mode, net graph.
12. **Pause / Esc menu:** Resume, Settings, Leave match.
13. **Loading screen:** tips that rotate ("Crouch hides your head from headshots", "A frag 2 m away throws you 16 m", "Sling your shield to cover your back").
14. **Phone landscape HUD (812×375):**
    - a left stick bottom-left (move; push up to jet, down to crouch);
    - a right stick bottom-right (aim and fire);
    - an arc of buttons: grenade, cycle, swap, reload, dash, melee, shield;
    - translucent, every touch target at least 48 px, thumb-reachable, clear of the notch;
    - the HUD info compressed to fit above the sticks.

## Data the HUD can show (exact fields)

- **Player:**
  - `hp` 0–100, which regenerates after 4 s without damage;
  - `fuel` 0–100, with a regen-delay segment;
  - `shield` with `state` none / slung / raising / up and `hp` 0–300;
  - `dashCooldown` 0–1 s, plus `airDashUsed`;
  - `jetDisabled` in seconds (EMP);
  - `blind` 0–1 (flashbang);
  - `inGas` (taking toxic damage).
- **Weapons:** two slots, each with `name`, `mag` / `magSize`, `reserve`, `reload` 0–1 progress, and `dual` on/off; plus `zoom` 1×–7×.
- **Grenade belt:** frag, smoke, gas, flashbang, mine, EMP, each with a count (frag max 5, the others max 2), plus the selected type (cycled with T).
- **Match:** mode (Deathmatch), time left, kill limit, your score, the leader's score.
- **Kill feed:** killer, victim, a weapon icon, and badges for headshot, ricochet (off a shield), blast, fall, suicide.
- **Feedback:** hit marker, kill marker, damage-direction arcs, low-HP and low-ammo cues.
- **Pickup prompt** when standing on an item ("Riot Shield: walk over to take").
- **Network:** ping in ms, packet loss %, and the connection state.

## Visual direction

**"Military field kit, clean."** A dark slate base built from the palette already used in the game's Locker screen. Extend it rather than replace it:

| Token | Value |
|---|---|
| background | #0f141c |
| panel | #161d28 |
| line | #2a3442 |
| text | #e8edf3 |
| muted | #8d99a8 |
| accent (teal) | #3fb6a8 |

Use firm, readable type. Stencil-flavoured headings are fine if they stay legible. No neon "gamer" gradients, no fake scanlines, no glassmorphism.

## Rules (please follow them closely)

1. **Readable over a busy 3D battlefield.** HUD text sits over bright sky and dark walls. Use solid backplates (or at least 85% opacity) and a subtle text shadow, with no text thinner or smaller than 14 px.
2. **Keep the centre clear.** Nothing permanent in the middle 60% of the screen except the reticle, hit markers, damage arcs and short-lived banners.
3. **Team colours are reserved.** BLUE and ORANGE mean teams and nothing else: never use them for buttons, accents or warnings. Make health red, warning amber and OK green distinguishable for colour-blind players by pairing colour with shape or icon.
4. **Cheap to draw at 60 fps on low-end laptops and phones.**
   - No `backdrop-filter`, no large shadows, no animated gradients on HUD elements, and no images except small SVGs.
   - Every bar should be drawable from one number, for example a CSS variable `--hp: 0.72` driving a width or a transform.
5. **Screen sizes:** desktop 1280×720 up to 2560×1440, and phone landscape 812×375 with notches. Anchor the HUD to the screen corners inside safe-area margins.
6. **Accessibility:**
   - WCAG AA contrast for all text, and visible keyboard focus in menus; menus must be fully usable by keyboard;
   - Reduce flashes and Reduce motion versions of anything that flashes or moves;
   - text at 150% must not break layouts.
7. **Translation-ready:** English now, other languages later. Leave 30–40% extra room for longer strings, and bake no text into images.
8. **Rebindable key glyphs:** show keys as keycaps (for example [G] next to the grenade). Every glyph can change with the player's bindings, so treat glyphs as data.
9. **The brand name appears only once,** in an element with `data-bind="brand.name"`, so it can change in one place.
10. **Original work only.** Don't imitate any other game's HUD, icons, fonts or layouts, and don't mention other games anywhere in the file.
11. **No ads in the interface.** Ads exist only on in-world billboards. Never add banner or ad slots to menus or the HUD.
12. **Sharing grows the game.** Make Copy link, Share on WhatsApp and the QR code the most obvious actions in the lobby.

## Handoff

Return the single HTML file. Our engineers will turn the menus into React components and the HUD into a lightweight DOM layer. You don't need to wire anything; focus on clear layouts, every state listed above, and tokens we can copy.
