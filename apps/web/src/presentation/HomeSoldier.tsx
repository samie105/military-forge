/**
 * Home's stage: the player's own soldier (the owner, 24 Oct: "isn't the player avatar supposed to be
 * here"), their real look rendered full-body in its poster pose (the same picture the VS poster uses,
 * so it is cached once for both). The helmet glyph holds the place until the picture lands, then gives
 * way; on a page that can't render (no WebGL) it stays.
 *
 * The render waits for the title to go (main.ts keeps heavy work off the title: docs NOTES, the
 * web-quality agent's lazy loading); a look cached on this device shows at once. A new look (the
 * Locker, the creator, the account at sign-in) renders again (looks/mine.ts).
 */
import { useStore } from 'zustand';
import type { ReactNode } from 'react';
import { Portrait } from '../portrait/Portrait';
import { defaultPosterPose } from '../portrait/key';
import { useMyLook } from '../looks/mine';
import type { ShellStore } from '../shell/store';
import './homeSoldier.css';

/** `decorative`: its container already says "Your soldier" (the phone's stage). */
export function HomeSoldier({ store, name, className, decorative = false, children }: { store: ShellStore; name: string; className?: string; decorative?: boolean; children: ReactNode }) {
  const look = useMyLook();
  const titleGone = useStore(store, (s) => s.title !== 'on');
  return (
    <span className={['mf-soldier', className ?? ''].filter(Boolean).join(' ')} {...(decorative ? { 'aria-hidden': true } : { role: 'img', 'aria-label': `Your soldier, ${name}` })}>
      <span className="mf-soldier__mark" aria-hidden="true">
        {children}
      </span>
      {titleGone && <Portrait look={look} size={512} pose={defaultPosterPose(look)} name={name} className="mf-soldier__pt" />}
    </span>
  );
}
