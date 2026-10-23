/**
 * Auto-fade (the owner, 23 Oct 2026; controls spec §4.7): controls nobody has touched for a while
 * ease down to the Button fade level (settings.opacity), and light up the moment a thumb lands on or
 * near them, staying lit while held. Critical cues keep a control lit whatever the fade: a reload
 * that's needed, the Take button while a gun is underfoot, a grenade that just became ready. The
 * vitals the controls carry (HP, fuel, the ammo ring, counts) never fade at all (touch.css).
 *
 * Pure (no DOM): the controller feeds it touches, cues and the clock, and toggles one class per
 * control when the answer changes (opacity on the plates' own layers; no layout per frame).
 */

/** A control left alone this long fades (ms). */
export const AUTO_FADE_MS = 2500;
/** A touch this close to a control's edge (px, about 15 mm) lights it up too: a thumb heading there. */
export const WAKE_NEAR_PX = 90;

export interface FadeControl {
  /** the control's centre (the page's coordinates) */
  x: number;
  y: number;
  /** its radius (px) */
  r: number;
}

/** The controls a touch at (x, y) lights up: under it, or within WAKE_NEAR_PX of their edge. */
export function nearControls<Id extends string>(x: number, y: number, controls: ReadonlyMap<Id, FadeControl>): Id[] {
  const out: Id[] = [];
  for (const [id, c] of controls) if (Math.hypot(x - c.x, y - c.y) <= c.r + WAKE_NEAR_PX) out.push(id);
  return out;
}

/**
 * The cues that keep a control lit (state tokens: hud.ts and skin.ts phoneTokens): reload while the
 * gun is empty, low or reloading; Take while a gun is underfoot (it only shows then anyway); the
 * shield while it's up.
 */
export function cueLit(id: string, tokens: ReadonlySet<string>): boolean {
  if (id === 'reload') return tokens.has('empty') || tokens.has('low-ammo') || tokens.has('reloading');
  if (id === 'take') return tokens.has('near-crate');
  if (id === 'shield') return tokens.has('shield-up');
  return false;
}

/** When each control was last woken; lit for AUTO_FADE_MS after. */
export class FadeClock<Id extends string = string> {
  private readonly at = new Map<Id, number>();

  wake(id: Id, now: number): void {
    this.at.set(id, now);
  }

  /** Everything at once (the controls coming up, the editor closing). */
  wakeAll(ids: Iterable<Id>, now: number): void {
    for (const id of ids) this.at.set(id, now);
  }

  lit(id: Id, now: number): boolean {
    const t = this.at.get(id);
    return t !== undefined && now - t < AUTO_FADE_MS;
  }
}
