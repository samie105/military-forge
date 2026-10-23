/**
 * Whether the VS poster covers the screen right now (VsPoster sets it). The portrait policy lets renders
 * run under it (the world is hidden and play hasn't started: a training match goes straight into its
 * countdown, with no lobby to warm the pictures in), and never once it folds (3-2-1, GO).
 */
let up = 0;

export function posterUp(): boolean {
  return up > 0;
}

/** Marks the poster as shown; returns the call that marks it gone. */
export function showPoster(): () => void {
  up++;
  return () => void (up = Math.max(0, up - 1));
}
