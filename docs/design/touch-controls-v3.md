# Touch controls v3: gestures, the drill, the camera

**Owner, 19 Oct 2026:** "I need the controls to have a nice and creative user experience… I can't even understand the controls myself, some things aren't explained. Make the buttons swipeable, like the frags for example, and for other buttons research ways to make it creative so gamers can enjoy doing things with the buttons", plus camera controls.

This note covers three things: what touch shooters and platform fighters do on phones in general, what fits Military Forge (a 2.5D jetpack shooter played sideways with two thumbs), and what v3 builds.

It describes patterns, not any one game's UI. Everything here is our own design in the round-two kit's look.

## 1. What works on a phone (the patterns)

| Pattern | What it is | Good for | Watch out |
|---|---|---|---|
| **Floating sticks** | The stick appears under the thumb, anywhere on its half of the screen | Movement and aim without looking | Needs a clear home position to return to |
| **Drag-to-aim, release-to-act** | Hold a button, drag to aim a ghost line or arc, lift to commit; drag back to the centre to cancel | Throws, skill shots | Must show the aim (an arc) while dragging, and must allow a cancel |
| **Swipe on a button** | A quick flick across a button picks a variant (next item, a direction) instead of the plain action | Cycling items, aiming a dash, quick choices | Only works if it's discoverable: a hint the first time, and a visible result (a fan or list) |
| **Hold for a radial** | Holding a button opens a small ring of choices; slide to one and lift | Weapon wheels, emotes, item picks | Must not delay the plain tap: the ring opens only after ~0.3 s |
| **Hold-and-release (momentary)** | Holding keeps a state on (block, shield, sprint); lifting ends it. A tap toggles it | Shields, guard | Tap and hold must both be useful, never fighting |
| **Contextual buttons** | A button appears only when it can act (pick up, open, revive) and leaves when it can't | Interaction without clutter | Should grow in where the thumb can reach, never under a stick |
| **Stick flicks** | A fast flick of the move stick triggers a dodge or dash in that direction | Movement tech without another button | Must ignore slow pushes (a run is not a dash) |
| **Auto-fire on target** | The gun fires by itself while the aim lies on an enemy | Accessibility, one-thumb play | Optional, off by default; it costs ammo, so only within range and a narrow cone |
| **Haptics** | Short taps of vibration on a commit (a throw, a swap, a pick) | Confirming a gesture without looking | Keep them short (8–20 ms), never on every frame, and with a setting to turn them off |
| **Pinch and two-finger taps for the camera** | Pinch zooms the view; a two-finger double tap resets it | Seeing more of a big map | Must never trigger during normal two-thumb play |
| **Learn by doing** | A short drill with one goal per step that ticks off when the player does it, plus first-time hints in play | Teaching gestures without a manual | It must be skippable, replayable, and never block a real match |

**Rules that come out of this:**

- **Every gesture has a plain tap.** Nobody has to learn a gesture to play: tap throws, tap swaps, tap dashes, tap reloads.
- **A gesture shows what it did.** The grenade fan shows the belt, the radial shows its choices, and the swipe dashes leave the dash ring's tick.
- **Teach in context.** A hint appears the first time something becomes possible (two grenade types on the belt, a second gun, a crate underfoot), then never again.

## 2. What fits Military Forge

The game is played sideways with two thumbs:

- the left thumb lives on the move dial (run, jet up, crouch down);
- the right thumb lives on the aim dial;
- the right thumb also hops to the action fan around the aim dial (shield, reload, dash, grenade, melee) and to the gun pill at the top right.

So the gestures belong on the right-hand action fan, and every one starts and ends on its own button.

| Control | Tap | Gesture | Why |
|---|---|---|---|
| **Grenade** | Quick throw (70 %) | **Swipe ↑ or ↓**: change grenade type, with the belt fanning out beside the button. **Hold, then drag**: aim the arc (strength by distance); **let go** to throw; drag back to the centre and let go to cancel | The owner asked for this one by name. A quick swipe and a hold-then-drag can't be confused: the swipe happens in the first 0.2 s |
| **Gun pill (swap)** | Swap guns | **Swipe across**: swap. **Hold**: a radial with your two guns and melee; slide to one and lift | A one-thumb way to reach melee and to see both guns |
| **Dash** | Dash where the move stick points (or where you face) | **Swipe in any of 8 directions**: dash that way, even with the left thumb busy | Dash without moving the stick: jet up, then dash down |
| **Move dial** | — | **Flick and lift**: dash that way (existing; Settings → Swipe to dash) | Movement tech for the left thumb |
| **Reload** | Reload | **Swipe ↓**: reload (the same action, so a thumb sliding off the dash still reloads) | Forgiving |
| **Shield** | Raise or sling | **Hold**: raised while held, slung when you let go | A guard you hold, like a real shield |
| **Take** | Take the gun underfoot | Contextual: it grows in only when there's a gun to take | Already in v2 |
| **Aim dial** | — | Push past half-way to fire (or lift to fire). **Auto-fire** (Settings, off by default) fires while the aim lies on an enemy in range | Accessibility |

**Camera (phones):**

- **Closer by default.** At 812×375 the game's own view makes a soldier about 25 px tall: too small to read on a phone (render3d-b's audit). A phone shows 62 % of the zoom level's view, so soldiers are about 40 px tall: `Camera.viewScale`. It's never wider than the level, so the server's area of interest still covers it. Settings → Touch → **View distance** sets it (Close, Mid, Wide).
- **Pinch** with two fingers on the same side to sit closer or wider, between half the view and the full one. The setting keeps it. A scoped gun's zoom levels stay on the zoom button.
- **Two-finger double tap** recentres the view and resets the distance and the zoom.
- **Look-ahead** (on by default): the view leans toward where you aim. When it's off, the view stays on your soldier.
- **Camera shake** (0–100 %): how hard blasts and recoil shake the 3D view. render3d-b owns the 3D camera, so the app calls an optional `setShakeScale(k)` on the 3D view. It's a no-op until render3d-b adds it; the ask is in the shared notes (touch-interfaces.md).

Two fingers landing on opposite halves are the two thumbs playing. A pinch is two fingers landing on the **same** half within 0.3 s, so normal play never zooms.

**Haptics** (Settings → Button haptics, on by default where the phone can vibrate):

- 8 ms on a radial pick and a grenade type change;
- 12 ms on a swap;
- 15 ms on a dash swipe;
- 18 ms on a throw.

Being hit still buzzes as before (Vibrate when hit).

## 3. Explaining it

**Learn the controls** is a drill in Training. One goal at a time sits in a plate at the top, and the control it's about pulses. A goal ticks off when the player does it:

1. Run: push the left dial.
2. Fly: push it up. The green arc is jet fuel, and it refills on the ground.
3. Aim and fire: push the right dial past half-way.
4. Dash: swipe the dash button any way (or flick the left dial). Each dash costs fuel.
5. Chain: dash twice, quickly.
6. Change grenade: swipe ↑ on the grenade button.
7. Throw: hold the grenade, drag to aim, let go.
8. Swap: tap or swipe the gun pill.
9. Radial: hold the gun pill and pick melee.
10. Reload: tap (or swipe ↓) the reload button.
11. Melee: tap the blade.
12. Shield: hold the shield button. Skipped when you carry no shield.
13. Zoom: tap the magnifier with a scoped gun. Skipped when the gun in hand doesn't zoom.
14. Take: stand on a gun on the ground and tap Take.
15. Scores: hold the trophy.
16. Camera: pinch with two fingers on one side.

How it runs:

- **Start:** the drill starts by itself the first time a phone player opens Training. It can also be started from the controls card ("Show me") and from Settings → Touch → **Learn the controls**, which also replays it.
- **Skip:** each step can be skipped, and the whole drill closed.

**First-time hints** are small chips beside a control, each shown once and saved on the phone. Settings → Touch → **Show hints again** brings them back. They appear:

- when you first carry two grenade types: "Swipe ↑↓ to change grenade";
- when you first carry a second gun: "Hold for guns and melee";
- when you first stand on a crate: "Tap to take it";
- when you first carry a shield: "Hold to raise";
- at your first spawn: "Swipe to dash any way".

## 4. Coordination

- **Fluid dash** (#141, protocol v14) is on main: dashes cost fuel and chain, and `Input.dashStrength` follows the stick's flick (`dashStrength()` in `touch/mapping.ts`). v3 builds on it:
  - a dash-button swipe sets its direction and its strength as a full push at the swipe's speed;
  - a dash-button tap with the stick idle is a full dash the way you face;
  - the drill's "Chain" goal ticks on the sim's own chain (`dash` events with `chain > 0`).
  v3 doesn't touch the dash's fuel reading on the HUD.
- **render3d-b:** the shake scale ask (above). Nothing in `render3d/**` changes.
- **Gamepad** (the input agent) is unaffected: touch gestures only OR the same `Btn.*` bits into the `Input`.
