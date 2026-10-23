# Key art: the title screen ("tap anywhere to continue")

![Desktop](../../apps/web/public/art/key-art/key-art-desktop.webp)

The owner, 23 Oct: realistic key art for the new title screen, on web and phone ("we might have a poster … make it more realistic").
- **Subject:** the game's two soldiers, the male (bowl helmet, goggles) and the female (short natural afro), as realistic people in the Field Print gear:
  - olive fatigues and chest rigs, brass fittings;
  - the twin-tank jetpacks;
  - volt-lime (`#d6ff3b`) armbands and tank stripes, the only saturated accent.
- **Setting:** a war-torn city at dusk with smoke, dust, embers, fires and distant muzzle light. The tone is gritty and serious, never toy.
- **Clean room:** original IP; no text, insignia, flags or other games' looks.
- **Layout:** the soldiers sit in the centre. The upper third is calm smoke for the logo, and the bottom strip is dark rubble for the "TAP ANYWHERE" line.

## Files (`apps/web/public/art/key-art/`)

| File | Size | What |
|---|---|---|
| `key-art-desktop.{webp,avif}` | 2560×1440 | 16:9, desktop |
| `key-art-phone.{webp,avif}` | 2340×1080 | 19.5:9 phone landscape: the 21:9 outpaint below, centre-cropped; the soldiers whole, the logo space kept |
| `poster-portrait.{webp,avif}` | 1600×2400 | 2:3 poster for sharing |
| `poster-portrait-phone.{webp,avif}` | 1080×1620 | the same, phone-sized |
| `key-art-desktop-fg.{webp,avif}`, `key-art-phone-fg.{webp,avif}` | as their frames | the two soldiers alone (alpha), pixel-aligned with their frame, for parallax |
| `key-art-desktop-loop.{mp4,webm}` | 1280×720, 5 s, 24 fps, silent | ambient loop: smoke drift, embers, fire and exhaust flicker, a slow push in and back. Its first and last frames are the desktop frame, so it loops. Use `key-art-desktop.webp` as its poster. |

Every phone-sized file is under 400 KB: the phone frames are 96–128 KB, the phone poster 118–175 KB, and the phone foreground 55–116 KB.
- **Format:** AVIF is about 35 % smaller than WebP, so serve AVIF with WebP as the fallback.
- **The foreground layers:** these are background-removed cutouts of the soldiers, without the exhaust plumes. Drawn on their own frame they add nothing. For parallax, draw the frame (a few % larger), then the foreground on top, moving it slightly more than the frame.

Sources (`art/key-art/`): the full-resolution frames as JPEG q93 (desktop 3840×2160, phone 21:9 3168×1344, poster 2336×3504), the mattes as lossless WebP, and the loop as delivered.

## How it was made (Higgsfield)

1. **Desktop:** 2 variants (GPT Image 2.5, high, 4k, 16:9), with the two soldiers' concept sheets (Rookie sheet A and the female sheet) as gear references only.
   - Jobs `040bbcdd-0c72-4c2c-9bf6-a046a449c4c3` (picked: the calmest logo space) and `4c318052-2992-4ac5-8bc2-ae8f4a060e6b`.
2. **Phone:** outpaint of the pick to 21:9, job `f7426c0f-5329-4b8e-9f0b-a68e2c309943`. It extends the city to both sides, so the 19.5:9 crop keeps the soldiers' feet; a vertical crop of the 16:9 frame would have cut them.
3. **Poster:** GPT Image 2.5 high 4k, 2:3, with the pick as the reference: job `94d422a1-5320-4087-893a-2459234ff103`.
4. **Mattes:** background removal on the desktop frame (`dcc93084-3eb9-4cb8-887f-5e1c59110091`) and the 21:9 frame (`aefc3001-49b7-4fb6-a290-1b235975685d`).
5. **Loop:** Kling 3.0 std, 5 s, sound off, the pick as both start and end frame: job `8f64408b-0c91-4f10-b232-d9501fc3f8c9`.
6. **Encoding:** Pillow (Lanczos; WebP q72–80, AVIF q50–55), and ffmpeg (H.264 crf 26 faststart, VP9 crf 38).

<details><summary>Prompts (exact text)</summary>

Desktop: "Cinematic key art for an original video game, as a realistic, gritty war-film still: photographic, real adult human proportions, real fabric, metal and dust, dramatic film lighting, shallow depth of field; absolutely NOT cartoon, NOT toy, NOT chibi. The two reference images are only a guide to the characters' gear and look: a male soldier in a rounded bowl helmet with aviator goggles pushed up on it, and a female soldier with short natural black hair, bare-headed; both wear olive-drab field fatigues with rolled sleeves, olive chest rigs with three pouches, brass buckles and fittings, and a compact jetpack of two short rounded fuel tanks side by side with stubby flared nozzles. Their armbands and a thin stripe on each tank are a vivid volt-lime green (#d6ff3b), the only saturated accent. She is clearly a capable, serious soldier, feminine but never glamorous or sexualised. SCENE: a war-torn city at dusk, ruined concrete apartment blocks and a broken overpass, columns of dark smoke, drifting dust and glowing embers, distant muzzle flashes and fires, a low orange sun bleeding through the smoke, cold blue-grey shadows. ACTION: the two soldiers rise together from the rubble on jetpack thrust, hot exhaust and heat shimmer below them, rifles held ready, looking up and ahead, in the CENTRE of the frame and the middle-lower half. COMPOSITION for a title screen: keep the upper third mostly calm dark smoky sky as clean negative space for a game logo, and a calmer darker strip of rubble along the bottom for a line of text; nothing important near the left and right edges or the very top and bottom, so a wider crop that trims the top and bottom still holds both soldiers. Original design: no text, no letters, no logos, no insignia, no national flags, no recognisable real-world uniforms or weapons, nothing from any other game."

Poster: "A vertical cinematic poster made from the reference image: the same two soldiers (the male soldier in the rounded bowl helmet with goggles, the female soldier with short natural black hair), the same olive fatigues, chest rigs, brass fittings, twin-tank jetpacks and vivid volt-lime armbands and tank stripes, the same war-torn city at dusk with smoke, dust, embers, fires and a low orange sun. Realistic, gritty war-film photography, real adult proportions, dramatic lighting; never cartoon or toy. Reframe it as a tall 2:3 poster: the two soldiers rising on jetpack thrust fill the middle of the frame, larger, full figures with the exhaust below them; a tall band of dark smoky sky at the top kept clean for a game logo, and darker rubble at the bottom kept clean for a line of text. No text, no letters, no logos, no insignia, no flags, nothing from any other game."

Loop: "A seamless ambient loop of this exact frame for a game's title screen. The camera is completely locked, no zoom, no pan. Only subtle ambient motion: dark smoke columns drift slowly, glowing embers float upward, fires in the ruined buildings flicker, distant muzzle flashes blink, the jetpack exhaust flames flicker and the dust beneath them swirls. The two soldiers hover in place on their jetpacks with only a slight breathing bob, keeping their poses and faces exactly as they are. Gritty, serious war tone; no new objects, no text."

</details>

## Spend: 24.25 credits

| Step | Credits |
|---|---|
| 2 desktop variants, GPT Image 2.5 high 4k (4.25 each) | 8.50 |
| poster, GPT Image 2.5 high 4k | 4.25 |
| 21:9 outpaint | 2.00 |
| 2 background removals (1 each) | 2.00 |
| ambient loop, Kling 3.0 std 5 s silent | 7.50 |
