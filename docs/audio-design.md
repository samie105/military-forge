# Audio design: the mix rules

How Military Forge's sound is mixed, so changes keep the same feel. The code is `apps/web/src/audio` (NOTES §28); the sounds themselves are recipes in `sounds/`, and the sound board (`/sounds.html`) plays any of them from anywhere around you.

**Tone:** war, not a toy. Close gunfire is a hard, dry crack with a body you feel; blasts are deep and long with debris; hits are thuds; the interface is muted clicks and radio blips; the music is drones and drums in minor keys. Nothing bright, bouncy or major-key.

## 1. Where a sound is

The listener is the local player's chest. Every world sound has a position, and the engine works out four things from it once when it starts (every frame for loops: jets, flames, hiss, flight).

| Rule | What it does | Numbers (`engine.ts`) |
|---|---|---|
| **Level by distance** | Full level within 6 m, then falls off (inverse), fading to nothing over the last fifth of the sound's own range | `REF_DISTANCE` 6 m; ranges per sound, e.g. footsteps 18 m, rifles 70 m, blasts 110 m |
| **Air takes the highs** | A low-pass that closes with distance: a far shot is thinner and darker | `distanceCutoff`: 18 kHz × e^(−d/22), never under 700 Hz |
| **Speed of sound** | A far report arrives late, so a distant firefight sounds distant | d / 343 m/s, capped at 0.15 s so play never feels laggy |
| **Near and far layers** | Guns and blasts have a far layer (`distant.gun`, a low report off buildings; `distant.boom`, a rumble). Past `farFrom` it fades in and the near sound thins out; by `farTo` the far layer carries it | guns 25 → 70 m; blasts 35 → 100 m (rockets 40 → 110) |
| **More space with distance** | Every world sound sends to the reverb, more the farther it is (and behind walls): close is dry and punchy, far is mostly echo | send = wet × (0.45 + d/30, at most +1.2, + 0.35 per wall) |

## 2. Walls and spaces (from the map)

`acoustics.ts` reads the map's collision geometry; no per-frame raycasts for every sound.

- **Occlusion:** one walk along one ray from you to a sound when it starts (cached 0.15 s per metre cell; loops reuse the cache). A solid's two faces count as one wall, a slab as one; fences and railings bullets pass don't count. One wall: half the level and nothing above 1.1 kHz. Two or more: 0.3 and 550 Hz. Plus more reverb.
- **The space you're in:** three rays from you three times a second (up 10 m, left and right 9 m). A roof counts most, walls on both sides the rest: 0 is the open street, 1 is indoors. Two convolution reverbs on synthesized impulses cross-fade by it: the street (2.4 s, a dark tail with late reflections off far walls) and under cover (0.7 s, dense close reflections).

## 3. Speakers and headphones

Settings → Audio → **Headphones (3D sound)**, off by default (browsers don't tell a page what's plugged in).

- **Off (speakers):** equal-power stereo panning by how far left or right a sound is (full to one side at 16 m, 85% at most so nothing is in one ear only).
- **On (headphones, earbuds):** an HRTF panner per world sound, so left, right, above and below are placeable by ear. A sound 16 m to the side is well round to that ear; height sets elevation. The engine still sets the level by distance itself (the panner only places).

## 4. Priorities and ducking

- **Voice limits:** each sound caps its own voices (the oldest is cut), the engine caps all at 40 (the least important goes, or the new one is refused), and a per-sound cooldown stops one event sounding twice (a shotgun's pellets are one bang). Many of one sound at once each play quieter (1/√(1 + 0.25n)).
- **Priority** = the sound's own (blasts 90, your hits 88, guns 70–75, footsteps 15) + 15 for your own sounds + 12 for an enemy cue − 0.4 per metre away.
- **Blasts duck the rest:** the world, music and voices dip by the blast's size × its closeness and come back over about half a second. The blast itself is on its own bus and isn't ducked.
- **Your gun under incoming threats:** your own sounds sit on their own sub-bus that dips 20–50% (and recovers in a quarter second) when you're hit, a round cracks past you, an enemy fires within 12 m, or a blast goes off within 15 m. Your gun stays loud; the threat still reads over it.
- **Directional cues:** enemies within 18 m have their footsteps and jetpack lifted 30% (and up the priority) so you can place them; beyond that they sit in the mix like anything else. Being hit pans toward the attacker; a near miss cracks past from the shooter's side.
- **A blast on top of you:** within 7 m, the world is muffled for a second or two and the ears ring (no ring with Soften loud bursts). A flashbang muffles and rings by how blinded you are.
- **Soften loud bursts** (Accessibility): blasts at about half level, no ear ring, gentler ducking, and the limiter starts earlier and holds harder.

## 5. Buses and the end of the chain

Master → Effects (the world through the duck and the flashbang muffler, your own sub-bus, blasts beside it), Music (ducked too), Interface, Voices (ducked) → a limiter (−8 dB threshold, −20 with Soften) → a hidden-tab fader (the context suspends when the tab is hidden) → out. Volumes are squared from the sliders, so 50% sounds about half as loud.

## 6. What the music does

The bed plays in the menus and the lobby only, and fades out when a match counts down; the match-start sting takes over. It never plays during a fight.

## 7. Weapon skins' own sounds

A skin line can swap its gun's sounds (packages/content `weapon-skins.json` → `sounds`: base id → its own; the recipes are `sounds/skins.ts`). The K-47 Galaxy Relic swaps the fire, the three reload steps and the draw, and has a Locker inspect chime; its kill effect (Stardust Shatter) has its own sound.

- **Built on the base:** each skin sound renders the base sound's own take (the same seed, through the bank's path), adds its timbre after the base's first 4 ms (the crack), is cut to the base's exact length and levelled to the base's loudness (BS.1770, `analysis.ts`), never above the base's peak. It plays with the base's range, far layer, voices, priority, pitch and level, so it's heard exactly as far and reads as the same gun (docs/17 V11; `skins.test.ts` holds every take to it).
- **Who hears it:** everyone. The director looks up the shooter's look (main.ts hands it the look directory every player's soldier is drawn from), so a skinned K-47 fires its own sound for the shooter and every listener, and only on that gun.
- **The kill effect's sound** plays at the victim with the full effect only (the renderer's kill-effect module calls it), on top of the death voice, quieter than it at its loudest, within the effect's time, and above 2.8 kHz, out of the footsteps' and the jetpack's way (docs/17 §3.7).
- **Memory:** a line's sounds render only when someone in the match wears it; they have their own budget (1.25 MB per line, `bank.test.ts`) beside the bank's 20 MB.
- **Audition:** the sound board's "Skins" group; before/after clips and spectrograms in `docs/audio/galaxy-relic/` (`apps/web/scripts/skin-sound-clips.ts` renders them).

