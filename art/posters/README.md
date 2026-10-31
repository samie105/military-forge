# Map posters and the Quick match key art

Every map a room can pick has a poster, and Home's Quick match has key art. They are frames from the game itself, not drawings or generated pictures: each map runs a real local match against bots in the debug client, using the map's own geometry, light, backdrops, soldiers and effects, on the High preset and this machine's GPU. Only the 3D view shows. The HUD, the 2D layer (names and damage numbers) and the debug bars are hidden.

| File | Size | Used by |
|---|---|---|
| `art/posters/<id>.webp` | 2560×1440 master | posts, a later re-crop |
| `apps/web/public/assets/posters/<id>-card[@2x].webp` | 2:1, 400 / 800 wide | the desktop lobby's map cards, the phone's map choice and room line |
| `apps/web/public/assets/posters/<id>-wide[@2x].webp` | 16:9, 960 / 1920 wide | the map loading screen, the countdown's map intro, behind the VS poster |
| `apps/web/public/assets/posters/quick-match[@2x].webp` | 2:1, 760 / 1520 wide | Home's Play now poster (desktop and phone) |

The app picks the file through `srcset` / `sizes` (`apps/web/src/shell/posters.tsx`). A map with no poster yet gets a neutral ink plate, never another map's picture. `apps/web/test/posters.test.tsx` fails if a selectable map has no shot, no files, or a file of the wrong size or weight.

## Remaking them (a map changed, or a new map)

1. Start the dev server, which has the dev-only `__game` hook:
   ```bash
   cd apps/web && pnpm exec vite --port 5451 --strictPort
   ```
2. For a new map, add a shot to `shots.json`: its `region` (where the camera may stand, in the map's metres), `w` (the view's width in m; the game shows 18 to 36), the bots, and optionally `gatherAt` points and `cropY`. Then search for the best frame:
   ```bash
   lockf -k /tmp/military-forge-heavy.lock node apps/web/scripts/map-posters.mjs --only <id> --search --keep /tmp/poster-candidates
   ```
   The match runs on a stepped clock, so every run gives the same frames. Every `gatherEvery` seconds the bots are brought back into the region, and the camera centres on the soldiers there. Each 0.2 s step is scored: soldiers in frame, in the air and jetting count up, grenades in flight count up, and lit billboards in view count down, because the poster is the map's and not an ad's. The script prints the best frame's `"at"`. `--keep` saves every better frame it finds on the way, so you can choose one by eye. Put the chosen second into `at`.
3. Render the files from `at` (all shots, or `--only a,b`):
   ```bash
   lockf -k /tmp/military-forge-heavy.lock node apps/web/scripts/map-posters.mjs
   ```
4. Add a new map's id to `POSTER_MAPS` in `apps/web/src/shell/posters.tsx`, then run `pnpm --filter @military-forge/web exec vitest run test/posters.test.tsx`.
5. Check every surface at phone, tablet and desktop sizes:
   ```bash
   lockf -k /tmp/military-forge-heavy.lock node apps/web/scripts/map-poster-surfaces.mjs --out <dir>
   ```

**Needs:** Google Chrome. It runs headless with `--use-angle=metal`, and the script refuses to run on software GL. It also needs `cwebp` (`brew install webp`).

**The grade:** one light grade for the whole set (`shots.json` → `grade`): a touch of contrast, colour and brightness, plus a soft ink vignette in the corners. The render stays first. There is no tint and no baked text; the UI adds the poster frame, the shade and the halftone.

**Training ranges** (Proving Ground, Vertical Range) are greybox by design. Their shots frame what makes them training grounds: the target row and the stepped yellow platforms, and soldiers fighting in the air between the tiers. Nothing is added.
