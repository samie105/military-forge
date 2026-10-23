/**
 * Warms the room's pictures ahead of time (research §8.3, §8.4): whenever the room's looks change (a
 * ROSTER, a training match), every fighter's lobby avatar and VS poster render are queued, so the
 * countdown only shows images and does no WebGL work. The portrait service's policy keeps the renders
 * out of the fight (they wait), so this can run whenever.
 */
import type { LookBook } from '../looks/book';
import { defaultPosterPose, warmPortraits, type PortraitRequest } from '../portrait';

/** What a room needs rendered: avatars first (the lobby shows them now), then the posters. */
export function roomPortraits(book: Pick<LookBook, 'fighters' | 'drawn'>): PortraitRequest[] {
  const looks = book.fighters().flatMap((f) => {
    const look = book.drawn(f.id);
    return look ? [look] : [];
  });
  const big = looks.length > 8; // 9–16: the poster's compact cards
  return [
    ...looks.map((look): PortraitRequest => ({ look, size: 64, pose: 'portrait' })),
    ...looks.map((look): PortraitRequest => (big ? { look, size: 128, pose: 'portrait' } : { look, size: 512, pose: defaultPosterPose(look) })),
  ];
}

/** Follows the book; returns the unsubscribe. */
export function warmRoomPortraits(book: LookBook): () => void {
  const warm = () => warmPortraits(roomPortraits(book));
  warm();
  return book.subscribe(warm);
}
