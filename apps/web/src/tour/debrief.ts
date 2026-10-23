/**
 * The Debrief on Results (docs/design/onboarding-research.md §3.2): three lines for the early matches.
 * One thing done, from the match ("6 kills · dash, grenades"); one thing to try, from what didn't happen
 * or what went wrong; and the top Next orders card. Pure. Facts, never blame (§3.6: "the middle kills").
 */
import type { Facts } from './facts';
import type { Move } from './log';
import type { MatchSummary } from './track';
import type { Card } from './orders';

/** Results shows the Debrief for this many finished matches, then leaves the screen to the scores. */
export const DEBRIEF_MATCHES = 5;

export interface Debrief {
  done: string;
  /** null when there's nothing to suggest */
  tryNext: string | null;
  next: { title: string; reason: string } | null;
}

const MOVE_NAMES: Partial<Record<Move, string>> = { dash: 'dash', grenade: 'grenades', take: 'took a gun', melee: 'melee', shield: 'shield', 'aimed-throw': 'aimed throws' };

export function debrief(m: MatchSummary, f: Facts, top: Card | null): Debrief {
  const used = [...new Set(m.moves)].map((x) => MOVE_NAMES[x]).filter((x): x is string => !!x);
  const kills = `${m.kills} ${m.kills === 1 ? 'kill' : 'kills'}`;
  const done = used.length ? `${kills} · ${used.slice(0, 3).join(', ')}` : kills;
  const deaths = Object.values(m.deaths).reduce((a, b) => a + (b ?? 0), 0);
  let tryNext: string | null = null;
  if (deaths >= 8 && m.kills <= 1) tryNext = 'Easier start? Easy bots, or turn aim assist up.';
  else if ((m.deaths.gas ?? 0) >= 2) tryNext = 'Gas: the middle kills. Cross the edge fast, or fly over.';
  else if ((m.deaths.self ?? 0) + (m.deaths.grenade ?? 0) >= 2) tryNext = 'Hold to aim: the arc shows where it lands.';
  else if (!m.moves.includes('dash')) tryNext = "You didn't dash: dashes dodge fire.";
  else if (!m.moves.includes('grenade')) tryNext = 'No grenades: tap to throw, hold to aim.';
  else if (!m.moves.includes('take') && f.moves.take === 0) tryNext = 'No guns taken: walk over one to take it.';
  return { done, tryNext, next: top ? { title: top.title, reason: top.reason } : null };
}
