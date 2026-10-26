/**
 * Billboard ad delivery for the play stats (docs/16 §3.1, after docs/14 §4.6's rules, simplified):
 * every 200 ms during a match, each lit board in view counts as viewable when at least half of it is
 * on screen, it takes at least 1.5 % of the view, the page is visible and focused and no menu covers
 * the game. A creative earns its impression after one continuous second viewable; its viewable time
 * adds up for the match. When the match ends (or the page hides), each creative with an impression
 * becomes one `ad.view` event: an anonymous count, never tied to the player.
 */
export const CHECK_MS = 200;
/** consecutive viewable checks for an impression (1 s) */
export const RUN_FOR_IMPRESSION = 5;
export const MIN_VISIBLE = 0.5;
export const MIN_SHARE = 0.015;

export interface BoardView {
  creative: string;
  advertiser: string;
  visible: number;
  share: number;
}

interface Acc {
  advertiser: string;
  ms: number;
  run: number;
  counted: boolean;
  /** the most of the view it took, ‰ */
  share: number;
}

export interface AdViewEvent {
  k: 'ad.view';
  c: string;
  adv: string;
  ms: number;
  share: number;
}

/** Pure accumulator: `check` per 200 ms with what's in view and whether viewing is possible; `drain` per match. */
export class AdViewCounter {
  private readonly acc = new Map<string, Acc>();

  check(boards: readonly BoardView[], canView: boolean, stepMs = CHECK_MS): void {
    const seen = new Set<string>();
    if (canView) {
      for (const b of boards) {
        if (b.visible < MIN_VISIBLE || b.share < MIN_SHARE || seen.has(b.creative)) continue;
        seen.add(b.creative);
        let a = this.acc.get(b.creative);
        if (!a) this.acc.set(b.creative, (a = { advertiser: b.advertiser, ms: 0, run: 0, counted: false, share: 0 }));
        a.ms += stepMs;
        a.run++;
        a.share = Math.max(a.share, Math.round(b.share * 1000));
        if (a.run >= RUN_FOR_IMPRESSION) a.counted = true;
      }
    }
    for (const [c, a] of this.acc) if (!seen.has(c)) a.run = 0;
  }

  /** The match's impressions (creatives viewable for a continuous second at least once), and starts over. */
  drain(): AdViewEvent[] {
    const out: AdViewEvent[] = [];
    for (const [c, a] of this.acc) if (a.counted) out.push({ k: 'ad.view', c, adv: a.advertiser, ms: a.ms, share: Math.min(1000, a.share) });
    this.acc.clear();
    return out;
  }
}
