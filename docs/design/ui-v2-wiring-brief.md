# UI round two: wiring brief for the building agent

Wire the round-two design kit into `apps/web` the same way round one was wired. The design is final; your job is to port it, bind it to real game data, and keep every rule the kit bakes in.

## Sources (in this folder)

| File | What it is |
| --- | --- |
| `military-forge-ui-v2.html` | **Source of truth.** One `:root` token block, one SVG sprite, 27 screens with `data-bind` / `data-state` markers. Open it in a browser: the bar at the top switches screens and states. URL options: `#screen/state+state`, `?text` (150 % text), `?motion` (reduce motion), `?flashes` (reduce flashes), `?shot` (no picker, 1:1). Read its header comment first. |
| `v2-shots/*.jpg` | Reference renders of every screen and the key states (desktop 1920×1080, phone 812×375). Compare your build against these. |
| `ui-agent-brief-v2.md` | The design brief the kit answers (screens, data list, rules). |
| `military-forge-ui.html` | Round one, already shipped. Useful to see how its markers map to the current code. |

The pen.dev canvas is a visual copy of the same screens for the owner. You don't need it.

## How round one is wired (reuse this, don't invent a new system)

- `apps/web/src/ui/kit.css`: the kit's stylesheet copied as is, with the scoped exceptions listed in its header (base rules under `:where(.mf)`, no `.dev-*`, no preview images, fonts from `fonts.css`).
- `apps/web/src/ui/sprite.ts`: the kit's `<svg>` sprite, put on the page once. `Icon.tsx` uses it.
- `apps/web/src/ui/fonts.css`: the kit's two font families, self-hosted from `@fontsource`.
- `apps/web/src/hud/template.ts`: the HUD markup (desktop + phone) copied from the kit.
- `apps/web/src/hud/bind.ts`: `data-bind` (text), `data-bind-attr`, `data-bind-var` (CSS variables), `data-bind-state`, `data-bind-show`. Writes are cached.
- `apps/web/src/hud/state.ts`: `data-active-state` tokens on the root; `data-state="a b+c"` show/hide.
- `apps/web/src/hud/model.ts` + `hud.ts`: game state → `{ key: string }` values and tokens.
- `apps/web/src/shell/screens/*.tsx`: the menu screens in React (`App.tsx`, `store.ts`).
- Also involved: `touch/` (phone controls + layout editor), `hostTuning.ts` / `tuningPanel.ts` (host panel), `mapEvent.ts` + `shell/mapEventBanner.ts`, `throwPreview.ts`, `locker/`, `armory/`, `render3d/` (world-space labels such as the crate and the rack).

## What's different in the v2 kit (code changes you must make)

1. **Negation in state specs.** v2 uses `data-state="!a"` ("shown while `a` is **not** active"), combinable with `+` (`"!switching+!melee-only+!dual"`). Extend `stateMatches` in `hud/state.ts`: a token starting with `!` matches when the token is absent. Add a unit test.
2. **CSS variables live on the screen root.** The kit sets bars and rings through inline style on the `<section class="screen">` (the picker does `el.style.setProperty`). In `template.ts`, put one `data-bind-var` on the HUD root listing them: `--hp --hp-ghost --fuel --fuel-delay --shield-hp --dash --reload --equip --throw --blind --respawn` (+ `--event`, `--load`, `--count` on their screens). Each is a number from 0 to 1 except `--blind`, which is opacity. Damage arcs take `--amt` (0..1) and `--rot` (deg) per arc; sliders take `--v` (value) and `--d` (default) as 0..1; the Tune rows read `--t-<key>`.
3. **Icon ids changed.** Weapons are `#icon-wpn-<id>` (was `#wpn-<id>`), grenades `#icon-g-<type>`, kill-feed badges `#icon-b-<kind>` (headshot ricochet launch mine gas fall dash self blast). New: `#icon-emblem` (64×64 brand mark), `icon-ev-*`, `icon-tod-*`, `icon-att-*`, `icon-mech-*`, `icon-rank`, `icon-medal`, `icon-dogtag`, `icon-radio`, `icon-backpack`. Weapon glyphs paint the body with `currentColor` and the bright tip with `var(--c-tip)`; grenades cut details with `var(--c-cut)`. Replace `sprite.ts` wholesale and update every `href` in TS/TSX.
4. **Token names changed.** `--c-accent` → `--c-volt`, sand → `--c-paper`/`--c-brass`, new `--c-olive-*`, `--c-camo-*`, `--c-print`, `--c-ribbon-*`, `--sh-*`, `--z-*`. Replace the whole `:root` block in `kit.css`; then grep the app for any old token still referenced (`--c-accent`, `--c-sand`, `--font-ui`, `--font-stencil`, …) and move it to the new name.
5. **Fonts.** v2 uses **Big Shoulders Stencil Display** (800/900) and **Archivo** with its width axis (500–800, `wdth` 62–125). Swap `@fontsource/barlow-semi-condensed` and `@fontsource/saira-stencil-one` for the matching `@fontsource` / `@fontsource-variable` packages (check the exact package names and that the Archivo package includes the `wdth` axis). Keep `font-src 'self'` and copy the OFL licences to `/licenses/` like round one.
6. **Brand.** The brand name appears once (`data-bind="brand.name"` on Home), next to `#icon-emblem`.

## Order of work

Do one phase per PR. Run `pnpm check` after each phase and compare against `v2-shots/`.

1. **Foundation.** Replace `ui/kit.css` with v2's stylesheet using the same exceptions as round one (the kit's last `<style id="preview-images">` and `.dev-*` stay out). Replace `ui/sprite.ts` and `ui/fonts.css`. Add `!` support to `hud/state.ts`. Fix icon hrefs and old token names. *Done when:* the app builds, nothing references a missing icon or token, and the existing screens render in the new look.
2. **Desktop HUD.** Port the kit's `section[data-screen="hud"]` into `template.ts`. Wire the new values in `model.ts`:
   - both weapon slots: `player.slot.0|1.{name,family,mag,magSize,reserve,slung,equip,dual,finish}`; `--equip` runs 0→1 over the gun's draw time (0.25–0.6 s);
   - states `single | switching | dual | melee-only | reloading | low-ammo | empty`;
   - grenade belt: `grenades.belt.N.{type,count,max}`, `grenades.selected`, `--throw` while G is held, tokens `aiming | arc-warning | quick-throw` (`throwPreview.ts` already knows the arc; `arc-warning` is on when a map event bends it);
   - dash: `--dash` (1 = ready), `dash.cooldown` (seconds left), tokens `dash-cooldown | air-used | dash-hint` with `dash.hintDir`;
   - hit feedback: per arc `--rot` (from `hit.dir`) and `--amt` (from `hit.amount`), class by `hit.kind`; tokens `hit | headshot | ricochet | launched | kill | heavy-hit`;
   - crate pickup: `pickup.weapon.name`, `pickup.held.name`, `pickup.{held,weapon}.stats.{damage,rate,range,weight,mag}` from `@military-forge/content` weapons, token `pickup-crate`;
   - `tuned` token + `match.tunedSummary` when the room's tuning differs from defaults (`changedTuning`);
   - `blood-on` only when `settings.blood` is on (default **off**).
   `hud.test.ts` already checks that every bound key gets a value: extend it for the new keys.
3. **Phone HUD (thumb dials).** Port `section[data-screen="m-hud"]` (812×375). It replaces round one's phone HUD and the kit's old "20 Phone HUD".
   - HP arc reads `--hp`, fuel arc reads `--fuel`, the aim ring has one segment per round in the mag, and `.dial__throw` reads `--throw`.
   - The arc buttons (shield, reload, dash, grenade, melee), the swap pill (both guns + the `--equip` ring) and `.pt-pick` (only near a crate) map to the existing `touch/layout.ts` controls.
   - Keep the layout editor working: positions stay fractions of the safe area, and every target stays ≥ 48 px and clear of the notch.
   - States: `idle | grenade-aim | near-crate | swap | low-hp`.
4. **Menus.** Restyle `shell/screens/*.tsx` to the kit: name entry, home, join, lobby (host + guest), connection (all 8 states), countdown, results, settings, pause, loading. New screens:
   - **Map intro** card, shown as the match starts.
   - **Lobby v2:** map cards from the content maps, time of day, bot count and level, host tools (add bot, remove bot, kick), and two share links (`lobby.links.lan`, `lobby.links.internet`), each with a QR (`shell/qr.ts`). Sharing stays the loudest element, and Share uses `navigator.share`.
   - **Results v2:** highlights, a per-weapon table, the MVP share card (square image) and the vote pips.
   - **Settings additions:** Graphics `Auto | Low | Medium | High` (`gfxAuto.ts`), Blood (off), Double-tap to dash (on), the Touch layout tab (`touch/`), and Host "Allow tuning in my rooms".
   - **Phone menus** (`m-home`, `m-lobby`, `m-pause`, `m-results`, `m-locker`): show them when the viewport is a landscape phone.
5. **Tune the game.** The kit's `.tune` panel docks at the right edge, never over the centre. Either restyle the tweakpane panel to match, or build the kit's panel and keep tweakpane as the dev-only full panel. Map the kit's rows to the real `TUNING_GROUPS` keys in `@military-forge/content` (`tuning.ts`) and use **their** min, max and step, not the kit's sample ranges:

   | Kit row | Real key(s) |
   | --- | --- |
   | Jet fuel · max / burn / regen | `fuelMax` / `fuelBurn` / `fuelRegenGround` (+ `fuelRegenAir`) |
   | Jet thrust | `jetThrust` |
   | Gravity | `gravity` |
   | Run speed | `walkMax` |
   | Dash · distance | `dashSpeed` × `dashBurstTicks` (show as metres; edit `dashSpeed`) |
   | Dash · cooldown | `dashCooldown` |
   | Blast launch | `blastImpulseScale` |
   | Grenade throw speed | `grenadeThrowScale` |
   | Respawn time | `respawnDelay` |

   Presets Classic / Floaty / Chaos are partial `Tuning` objects; Classic = `defaultTuning`. "Copy values" keeps today's behaviour (JSON of what differs).
6. **Gear and world.**
   - Locker v2 (`locker/`) tabs: Outfit, Helmet, Dyes, Gun finishes, Dash trail, Muzzle fire, plus the "Fits the body" stamp.
   - Armory v2 (`armory/`): turntable, stat card, attachment preview and mechanism buttons (pump, bolt, casing).
   - World-space labels in `render3d/` for the crate (`.crate-tag`) and the test-armory rack name tags.
   - The kill feed with all weapon, grenade, melee and shield icons and the badges.

## Data the kit expects (from the brief)

`player.slot[0|1]` · `pickup.weapon` + stats · `grenades.belt` / `selected` / `throwStrength` / `arcWarning` · `dash.cooldown` / `dash.airUsed` · `hit.dir` / `amount` / `kind` · `match.tuned` + `tuning.*` · `lobby.map` / `timeOfDay` / `bots.count` / `bots.level` / `links.lan` / `links.internet` · `results.highlights[]` / `byWeapon[]` / `mvp` · `settings.blood` / `doubleTapDash` / `graphics`.

If the sim or server doesn't produce a value yet (for example the results highlights, per-weapon stats or time of day), don't fake it in the UI. List each gap in the PR, hide that element with `data-bind-show`, and keep going.

## Rules (from the kit; don't break them)

- HUD plates ≥ 85 % opaque, text-shadow on HUD text, nothing under 14 px.
- Centre 60 % holds only the reticle, markers, damage arcs, the throw meter and short banners.
- HUD: no backdrop-filter, no big shadows, no animated gradients, no idle motion; one CSS number per bar.
- Blue and orange are team colours only (`--c-team-a`, `--c-team-b`).
- Every keycap is bound data (`data-bind="bind.<action>.0"`); never bake a key letter into copy.
- `--text-scale` 1–1.5 must not break layouts; `html.reduce-motion` and `html.reduce-flashes` must work.
- No raw colours outside the token block. No ads in the UI. The brand name appears once.

## Done checklist (per phase)

- `pnpm check` passes; new tests cover `!` state specs and the new HUD keys.
- Side-by-side with the matching `v2-shots/*.jpg` at 1920×1080 and 812×375: same layout, colours and type.
- At 1280×720 and 2560×1440 the screens fit; on a phone the controls sit inside the safe area.
- Text 150 %, Reduce motion and Reduce flashes all checked.
- No console errors, no missing `#icon-*`, no unbound `data-bind` keys.

## Known gaps in the kit

- QR codes are placeholders: render real ones from the links with `shell/qr.ts`.
- `.world-*` / `.art-*` are preview screenshots; the live game is drawn behind the UI.
- In the touch-layout editor preview, the Jet button overlaps the Move stick; place them apart in the real editor.
- The kit's sample tuning ranges are illustrative; the real ranges come from `TUNING_GROUPS`.
