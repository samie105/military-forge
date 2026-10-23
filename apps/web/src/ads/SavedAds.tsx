/**
 * "Saved ads": the billboards a player chose to save while playing (tap-to-save), as small cards
 * with Visit and Remove. The owner's explicit ask, and the only place an ad ever shows outside the
 * in-world billboards. Mounted on the results screen and Home (desktop and phone); renders nothing
 * when the list is empty.
 *
 * Visit is a real link (target _blank, rel noopener noreferrer): only the player's own tap or Enter
 * opens it, never the game. Every card is reachable by keyboard and pad (links and buttons).
 */
import { useEffect, useId, useSyncExternalStore } from 'react';
import { Icon } from '../ui/Icon';
import { noteFor, savedAds, type SavedAd, type SavedAds as Queue } from './saved';
import './ads.css';

/**
 * - `full`: the desktop screens' card (a column of cards);
 * - `strip`: the phone results (one row that scrolls sideways);
 * - `dock`: the phone Home's stage corner (narrow: no pictures, a card at a time).
 */
export type SavedAdsVariant = 'full' | 'strip' | 'dock';

export function SavedAdsList({ where, variant = 'full', queue = savedAds() }: { where: 'results' | 'home'; variant?: SavedAdsVariant; queue?: Queue }) {
  const list = useSyncExternalStore(
    (fn) => queue.subscribe(fn),
    () => queue.list(),
    () => queue.list(),
  );
  const titleId = useId();
  useEffect(() => queue.prune(), [queue]);
  if (!list.length) return null;
  return (
    <section className={`card mf-saved mf-saved--${variant}`} aria-labelledby={titleId} data-where={where}>
      <div className="mf-saved__top">
        <span className="label" id={titleId}>
          Saved ads
        </span>
        <span className="tag tag--ghost">{list.length}</span>
      </div>
      <p className="mf-saved__why">You saved {list.length === 1 ? 'this' : 'these'} during play. Nothing opens until you choose; each stays a day.</p>
      <ul className="mf-saved__list">
        {list.map((ad) => (
          <SavedCard key={ad.url} ad={ad} queue={queue} />
        ))}
      </ul>
    </section>
  );
}

function SavedCard({ ad, queue }: { ad: SavedAd; queue: Queue }) {
  const note = noteFor(ad);
  const wide = /-wide/.test(ad.creative);
  return (
    <li className="mf-saved__card">
      {ad.image ? <img className={`mf-saved__img${wide ? ' mf-saved__img--wide' : ''}`} src={ad.image} alt="" loading="lazy" decoding="async" /> : <span className="mf-saved__img" aria-hidden="true"></span>}
      <span className="mf-saved__text">
        <b className="mf-saved__name">{ad.name}</b>
        {ad.title && <span className="mf-saved__title">{ad.title.replace(/^[^:]*:\s*/, '')}</span>}
        {note && <span className="mf-saved__note">{note}</span>}
      </span>
      <span className="mf-saved__act">
        <a
          className="btn btn--volt btn--sm"
          href={ad.url}
          target="_blank"
          rel="noopener noreferrer"
          // counted and taken off the list once the browser has the click (never before: the link must open)
          onClick={() => setTimeout(() => queue.visited(ad.url), 0)}
        >
          Visit
          <span className="mf-sr"> {ad.name} (opens in a new tab)</span>
          <Icon name="arrow-right" />
        </a>
        <button type="button" className="btn btn--ghost btn--sm mf-saved__remove" aria-label={`Remove the ${ad.name} ad`} onClick={() => queue.remove(ad.url)}>
          <Icon name="close" />
        </button>
      </span>
    </li>
  );
}
