/**
 * <Portrait look={…} size={64} name="Ade" tint="none" />: a player's soldier as their avatar (§7.2). The
 * silhouette shows at once (the team tint and the initial); the live render cross-fades in over 120 ms
 * when it lands (at once when it was cached; no fade under Reduce motion). Decorative: alt="" and
 * aria-hidden, since the name is always next to it.
 *
 * <PlayerPortrait id={3} name="Ade" />: the same for a player in the room, from the look book (protocol
 * v19's looks); a player whose look isn't known wears the 3D view's placeholder (render3d placeholderLoadout).
 */
import { cosmeticLoadoutHash, type CosmeticLoadout } from '@military-forge/content';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { lookBook } from '../looks/book';
import { silhouetteUrl, type PortraitTint } from './fallback';
import { getPortrait, peekPortrait, portraits, type PortraitImage } from './index';
import type { PortraitPose, PortraitSize } from './key';
import './portrait.css';

export interface PortraitProps {
  look: CosmeticLoadout | null;
  size?: PortraitSize;
  pose?: PortraitPose;
  /** the initial on the silhouette */
  name?: string;
  tint?: PortraitTint;
  className?: string;
}

export function Portrait({ look, size = 64, pose = 'portrait', name = '', tint = 'none', className }: PortraitProps) {
  const hash = look ? cosmeticLoadoutHash(look) : null;
  const request = look ? { look, size, pose } : null;
  const [img, setImg] = useState<{ image: PortraitImage; cached: boolean } | null>(() => {
    const hit = request && peekPortrait(request);
    return hit ? { image: hit, cached: true } : null;
  });
  useEffect(() => {
    if (!request) {
      setImg(null);
      return undefined;
    }
    const hit = peekPortrait(request);
    if (hit) {
      setImg((now) => (now?.image.key === hit.key ? now : { image: hit, cached: true }));
      return undefined;
    }
    setImg(null);
    let live = true;
    // asked before the renderer is installed (the game's 3D still loading): the silhouette until it is
    void portraits.whenInstalled().then(() =>
      live
        ? getPortrait(request, 'now').then((image) => {
            if (live && !image.fallback) setImg({ image, cached: false });
          })
        : undefined,
    );
    return () => {
      live = false;
    };
    // the look's hash stands for the look
  }, [hash, size, pose]);
  const tall = pose.startsWith('poster-');
  return (
    <span className={['pt', tall ? 'pt--tall' : '', className ?? ''].filter(Boolean).join(' ')} data-tint={tint} aria-hidden="true">
      <img className="pt__base" src={silhouetteUrl(name, tint, tall)} alt="" draggable={false} />
      {img && <img key={img.image.key} className={img.cached ? 'pt__img is-cached' : 'pt__img'} src={img.image.url} alt="" draggable={false} />}
    </span>
  );
}

/** A room's player (online: the ROSTER's look; training: the bots' seeded looks and our saved one). */
export function PlayerPortrait({ id, name, size = 64, pose = 'portrait', tint = 'none', className }: { id: number; name: string } & Omit<PortraitProps, 'look' | 'name'>) {
  useSyncExternalStore(
    (fn) => lookBook.subscribe(fn),
    () => lookBook.version,
    () => null,
  );
  // a player in the room whose look isn't known (an older page) wears the 3D view's placeholder here too
  return <Portrait look={lookBook.drawn(id)} size={size} pose={pose} name={name} tint={tint} {...(className ? { className } : {})} />;
}
