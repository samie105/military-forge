/**
 * The title screen (the owner, 23 Oct: "when it's opened, it has an opened screen with a tap anywhere
 * to continue … to enter the game and have a nice experience"; card 01 on the Pen file's AGENT BRIDGE
 * board, drawn on the "TITLE SCREEN · tap anywhere" board). The Forge's key art full-bleed (a dark
 * olive fallback until it lands), the lockup, slow smoke, a light sweep and a little parallax; "Press
 * any key" (desktop) or "Tap anywhere" (phone), any controller button too. The press unlocks the
 * sound (the music starts with a war-tone hit, audio/ui.ts) and the camera pushes through into the
 * next screen, already drawn underneath: your name the first time, else Home. Phones keep it cheap:
 * one layer moves, no blur. Reduce motion: no drift, a short cross-fade out.
 */
import { useEffect, useRef, useState } from 'react';
import { useStore } from 'zustand';
import { GAME_NAME } from '@military-forge/shared';
import { buildId, keyArt } from 'virtual:title-info';
import { landingOwns, onPlay } from '../../ui/landing';
import { reduced } from '../../ui/motion';
import { Screen } from '../../ui/Screen';
import { useServerPing } from '../context';
import { usePhoneLayout } from './phone';
import { TITLE_LEAVE_MS, TITLE_LEAVE_REDUCED_MS, continuesTitle, regionLabel } from '../title';
import type { ShellStore } from '../store';
import './title.css';

const artUrl = (file: string) => `${import.meta.env.BASE_URL}art/key-art/${file}`;
const MIME: Readonly<Record<string, string>> = { avif: 'image/avif', webp: 'image/webp', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webm: 'video/webm', mp4: 'video/mp4' };
const extOf = (file: string) => file.slice(file.lastIndexOf('.') + 1);

/** A key-art picture in every format it comes in: AVIF first, WebP (or JPEG/PNG) as the fallback. */
function Picture({ files, className }: { files: readonly string[]; className: string }) {
  const fallback = files.find((f) => extOf(f) !== 'avif') ?? files[0]!;
  return (
    <picture>
      {files
        .filter((f) => f !== fallback)
        .map((f) => (
          <source key={f} type={MIME[extOf(f)]} srcSet={artUrl(f)} />
        ))}
      <img className={className} src={artUrl(fallback)} alt="" draggable={false} />
    </picture>
  );
}

/**
 * The desktop's ambient loop plays only where it's cheap and welcome: not on a phone, Low graphics,
 * Reduce motion or a data saver. Its first and last frames are the still (its poster).
 */
function loopWelcome(phone: boolean): boolean {
  if (phone || !keyArt.desktopLoop.length || reduced()) return false;
  if (document.documentElement.classList.contains('gfx-low')) return false;
  return !(navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData;
}

/** Leaves the title: the press now, the push once the app is ready (still booting: a loading line). */
export function pressTitle(store: ShellStore): void {
  const s = store.getState();
  if (s.title !== 'on') return;
  store.setState({ titleHit: performance.now(), title: s.screen.name === 'boot' ? 'pressed' : 'leaving' });
}

/**
 * The click that ends the tap or click which left the title: it must not land on the screen
 * underneath (a slow tap lifts after the title has gone). Swallowed once, for a moment.
 */
function swallowNextClick(): void {
  const swallow = (e: MouseEvent) => {
    e.preventDefault();
    e.stopImmediatePropagation();
    done();
  };
  const done = () => {
    window.removeEventListener('click', swallow, true);
    window.clearTimeout(timer);
  };
  window.addEventListener('click', swallow, true);
  const timer = window.setTimeout(done, 1500);
}

export function TitleScreen({ store }: { store: ShellStore }) {
  const state = useStore(store, (s) => s.title);
  const booting = useStore(store, (s) => s.screen.name === 'boot');
  const phone = usePhoneLayout();
  const ping = useServerPing();
  const [region, setRegion] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);

  // the server's region (the box's probe config), else "This computer" / the host
  useEffect(() => {
    let live = true;
    fetch(`${import.meta.env.BASE_URL}probe-config.json`)
      .then((r) => (r.ok && r.headers.get('content-type')?.includes('json') ? r.json() : null))
      .catch(() => null)
      .then((c: unknown) => live && setRegion(regionLabel(location.hostname, c as { regions?: { name?: string }[] } | null)));
    return () => {
      live = false;
    };
  }, []);

  // any key, click, tap or controller button continues (the key never reaches the screen underneath)
  useEffect(() => {
    if (state !== 'on') return undefined;
    const onKey = (e: KeyboardEvent) => {
      // the About sheet and the link into it (ui/landing.ts) keep their keys
      if (landingOwns(e.target) || !continuesTitle(e)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      pressTitle(store);
    };
    const onPointer = (e: PointerEvent) => {
      if (e.button > 0 || landingOwns(e.target)) return;
      e.preventDefault();
      swallowNextClick();
      pressTitle(store);
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('pointerdown', onPointer, true);
    // a controller: a button that goes down while the title shows (not one already held)
    let frame = 0;
    const held = new Set<string>();
    const pads = () => (typeof navigator.getGamepads === 'function' ? [...navigator.getGamepads()] : []);
    for (const p of pads()) p?.buttons.forEach((b, i) => b.pressed && held.add(`${p.index}:${i}`));
    const poll = () => {
      frame = requestAnimationFrame(poll);
      for (const p of pads()) {
        p?.buttons.forEach((b, i) => {
          const key = `${p.index}:${i}`;
          if (!b.pressed) held.delete(key);
          else if (!held.has(key)) {
            held.add(key);
            pressTitle(store);
          }
        });
      }
    };
    frame = requestAnimationFrame(poll);
    root.current?.focus({ preventScroll: true });
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('pointerdown', onPointer, true);
      cancelAnimationFrame(frame);
    };
  }, [state, store]);

  // the landing's Play now (index.html): pressed while the page loaded, or on the About sheet
  useEffect(() => (state === 'on' ? onPlay(() => pressTitle(store)) : undefined), [state, store]);

  // pressed while the app was getting ready: go as soon as it is
  useEffect(() => {
    if (state === 'pressed' && !booting) store.setState({ title: 'leaving' });
  }, [state, booting, store]);

  // the push into the next screen, then gone
  useEffect(() => {
    if (state !== 'leaving') return undefined;
    const t = window.setTimeout(() => store.setState({ title: 'off' }), reduced() ? TITLE_LEAVE_REDUCED_MS : TITLE_LEAVE_MS);
    return () => window.clearTimeout(t);
  }, [state, store]);

  // desktop parallax: the art and its foreground layer follow the pointer a little (a rAF per move)
  useEffect(() => {
    const el = root.current;
    if (!el || phone || reduced()) return undefined;
    let frame = 0;
    const onMove = (e: PointerEvent) => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        el.style.setProperty('--px', ((e.clientX / innerWidth) * 2 - 1).toFixed(3));
        el.style.setProperty('--py', ((e.clientY / innerHeight) * 2 - 1).toFixed(3));
      });
    };
    window.addEventListener('pointermove', onMove);
    return () => {
      window.removeEventListener('pointermove', onMove);
      cancelAnimationFrame(frame);
    };
  }, [phone]);

  // the loop: decided once mounted (the graphics and motion settings are on <html> by then)
  const [loop, setLoop] = useState(false);
  useEffect(() => setLoop(loopWelcome(phone)), [phone]);

  if (state === 'off') return null;
  const back = phone && keyArt.phone.length ? keyArt.phone : keyArt.desktop;
  const front = phone && keyArt.phone.length ? keyArt.phoneFg : keyArt.desktopFg;
  const still = back.find((f) => extOf(f) !== 'avif') ?? back[0];
  const hasArt = back.length > 0;
  const waiting = state === 'pressed';
  return (
    <div ref={root} className={`mf-title is-${state}${phone ? ' is-phone' : ''}${hasArt ? ' has-art' : ''}`} tabIndex={-1}>
      <Screen name="title" kind="game" modal states={[state, phone ? 'phone' : 'desktop', hasArt ? 'art' : 'fallback', loop ? 'loop' : '']} label={GAME_NAME}>
        <div className="mf-title__world" aria-hidden="true">
          {hasArt ? <Picture files={back} className="mf-title__art" /> : <div className="mf-title__fallback" />}
          {loop && still && (
            <video className="mf-title__art mf-title__loop" autoPlay muted loop playsInline preload="auto" poster={artUrl(still)} disablePictureInPicture>
              {keyArt.desktopLoop.map((f) => (
                <source key={f} src={artUrl(f)} type={MIME[extOf(f)]} />
              ))}
            </video>
          )}
          <div className="mf-title__smoke mf-title__smoke--a" />
          <div className="mf-title__smoke mf-title__smoke--b" />
        </div>
        {front.length > 0 && (
          <div className="mf-title__fg" aria-hidden="true">
            <Picture files={front} className="mf-title__art" />
          </div>
        )}
        <div className="mf-title__sweep" aria-hidden="true" />
        <div className="mf-title__vignette" aria-hidden="true" />
        <div className="mf-title__lockup">
          <span className="mf-title__name">
            <svg className="mf-title__emblem" aria-hidden="true">
              <use href="#icon-emblem" />
            </svg>
            <b className="display" data-bind="brand.name">
              {GAME_NAME}
            </b>
          </span>
          <span className="mf-title__sub">
            <i aria-hidden="true" />
            Jetpack warfare · online
          </span>
        </div>
        <div className="mf-title__prompt" role="status" aria-live="polite">
          {waiting ? (
            <>
              <span className="mf-title__press">Getting ready…</span>
              <span className="mf-title__loading" aria-hidden="true">
                <i />
              </span>
            </>
          ) : phone ? (
            <>
              <span className="mf-title__press">Tap anywhere to continue</span>
              <small>Sound starts with your tap</small>
            </>
          ) : (
            <>
              <span className="mf-title__press">
                <kbd className="kbd kbd--lg">Any key</kbd>
                Press any key · click
              </span>
              <small>or any controller button · sound starts on your first press</small>
            </>
          )}
        </div>
        {/* the landing's About sheet (index.html, public/boot.js): what the game is, for anyone curious */}
        <a className="mf-title__about" href="#about">
          About the game
        </a>
        <span className="mf-title__corner mf-title__corner--build">build {buildId}</span>
        <span className="mf-title__corner mf-title__corner--net">
          <i className={ping >= 0 ? 'is-live' : ''} aria-hidden="true" />
          {region ?? 'Server'}
          {ping >= 0 ? ` · ${Math.round(ping)} ms` : ' · …'}
        </span>
      </Screen>
    </div>
  );
}
