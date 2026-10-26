/**
 * The viewer's context for the house-ad rotation (docs/16-player-metrics.md §7, behind the API's
 * ANALYTICS_AD_SEGMENTS flag): a few plain words about how this player plays, set by the play
 * stats only when the flag is on and the player said yes. A house creative may name the audiences
 * it suits (`HouseEntry.prefer`, e.g. ["device:touch", "time:evening"]); each one that matches adds
 * a turn for it within its advertiser's share (at most 3 turns: never more than three times as
 * often). The advertisers' shares don't change, paid manifests never use it, and a finance creative
 * is never weighted up.
 */
export interface AdContext {
  device: 'touch' | 'keyboard' | 'pad' | null;
  sessionBand: 'short' | 'medium' | 'long' | null;
  timeOfDay: 'morning' | 'afternoon' | 'evening' | 'night' | null;
  modePref: 'ffa' | 'team' | 'local' | 'training' | null;
  tenure: 'new' | 'returning' | null;
}

/** The most turns one creative gets for every turn of a creative that matches nothing. */
export const MAX_AFFINITY = 3;

let current: AdContext | null = null;

/** The play stats set it (null: no context: every creative gets one turn, as before). */
export function setAdContext(c: AdContext | null): void {
  current = c;
}

export function adContext(): AdContext | null {
  return current;
}

/** The context as the tags a creative's `prefer` uses: "device:touch", "session:short", "time:evening", "mode:team", "tenure:new". */
export function contextTags(c: AdContext | null): Set<string> {
  const tags = new Set<string>();
  if (!c) return tags;
  if (c.device) tags.add(`device:${c.device}`);
  if (c.sessionBand) tags.add(`session:${c.sessionBand}`);
  if (c.timeOfDay) tags.add(`time:${c.timeOfDay}`);
  if (c.modePref) tags.add(`mode:${c.modePref}`);
  if (c.tenure) tags.add(`tenure:${c.tenure}`);
  return tags;
}

/** A creative's turns (1…MAX_AFFINITY) for this context. */
export function affinity(e: { prefer?: readonly string[]; category?: string }, c: AdContext | null = current): number {
  if (!c || !e.prefer?.length || e.category === 'finance') return 1;
  const tags = contextTags(c);
  return Math.min(MAX_AFFINITY, 1 + e.prefer.filter((t) => tags.has(t)).length);
}
