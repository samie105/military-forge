/**
 * 3 · Join with code (round two's data-screen="join"): six letter boxes; typing moves along, Backspace
 * moves back, and a pasted link or code (anywhere on the screen) fills them. The API says whether
 * the room exists before the game connects: "No room with that code" stays on this screen.
 */
import { ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH, normalizeRoomCode } from '@military-forge/shared';
import { useEffect, useRef, useState } from 'react';
import { Icon } from '../../ui/Icon';
import { Cap } from '../../ui/Kbd';
import { Screen } from '../../ui/Screen';
import { useCtl } from '../context';
import { Backdrop, Hint, Hints, NetPill } from './frame';

export type JoinState = 'empty' | 'typing' | 'pasted' | 'ready' | 'error';

const LETTERS = new RegExp(`[^${ROOM_CODE_ALPHABET}]`, 'g');

/** What a box accepts from typed text: the code's letters only, upper case. */
export function codeLetters(text: string): string {
  return text.toUpperCase().replace(LETTERS, '');
}

export function joinState(code: string, pasted: boolean, error: string | null): JoinState {
  if (error) return 'error';
  if (code.length === 0) return 'empty';
  if (code.length < ROOM_CODE_LENGTH) return 'typing';
  return pasted ? 'pasted' : 'ready';
}

export function Join() {
  const ctl = useCtl();
  const [code, setCode] = useState('');
  const [pasted, setPasted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const boxes = useRef<(HTMLInputElement | null)[]>([]);

  const focus = (i: number) => boxes.current[Math.max(0, Math.min(ROOM_CODE_LENGTH - 1, i))]?.focus();
  useEffect(() => focus(0), []);

  const fill = (text: string, fromPaste: boolean) => {
    const found = normalizeRoomCode(text) ?? codeLetters(text).slice(0, ROOM_CODE_LENGTH);
    setCode(found);
    setPasted(fromPaste && found.length === ROOM_CODE_LENGTH);
    setError(null);
    focus(found.length);
  };

  // a link pasted anywhere on the screen fills the boxes
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const text = e.clipboardData?.getData('text') ?? '';
      if (!text) return;
      e.preventDefault();
      fill(text, true);
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  });

  const state = joinState(code, pasted, error);
  const join = async () => {
    if (code.length !== ROOM_CODE_LENGTH || busy) return;
    setBusy(true);
    const result = await ctl.joinByCode(code);
    setBusy(false);
    if (result === 'not_found') setError('No room with that code');
    else if (result === 'rate_limited') setError('Too many wrong codes: wait a minute, then try again');
  };

  const onKey = (i: number, e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Backspace') {
      e.preventDefault();
      const at = code.length > i ? i : i - 1;
      if (at < 0) return;
      setCode(code.slice(0, at) + code.slice(at + 1));
      setError(null);
      setPasted(false);
      focus(at);
    } else if (e.key === 'ArrowLeft') focus(i - 1);
    else if (e.key === 'ArrowRight') focus(i + 1);
    else if (e.key === 'Enter') void join();
  };

  const pasteLink = () =>
    void navigator.clipboard
      ?.readText()
      .then((t) => fill(t, true))
      .catch(() => setError('Paste with Ctrl+V (or ⌘V): the browser kept the clipboard to itself'));

  return (
    <Screen name="join" kind="menu" states={[state === 'ready' ? 'pasted' : state]} label="Join with code">
      <Backdrop word="CODE" />
      <div className="menu">
        <header className="menu-top">
          <button className="btn btn--ghost btn--icon btn--sm m-p8" type="button" aria-label="Back to home" onClick={() => ctl.closeOverlay()}>
            <Icon name="back" />
          </button>
          <span className="label">Home</span>
          <span className="menu-top__spacer"></span>
          <NetPill />
        </header>
        <div className="menu-body join">
          <div className="join__main">
            <span className="eyebrow">Private room</span>
            <h1 id="join-title" className="display display--print join__title m-p1">
              Join with code
            </h1>
            <p className="lead">Type the 6 letters, or paste the whole link: we pull the code out of it.</p>
            <div className="codebox" role="group" aria-label="Room code, 6 letters">
              {Array.from({ length: ROOM_CODE_LENGTH }, (_, i) => (
                <input
                  key={i}
                  ref={(el) => {
                    boxes.current[i] = el;
                  }}
                  className={['codebox__cell', code[i] ? 'mf-filled' : 'is-empty', i === code.length && state !== 'error' ? 'is-caret' : ''].filter(Boolean).join(' ')}
                  maxLength={ROOM_CODE_LENGTH}
                  inputMode="text"
                  autoCapitalize="characters"
                  autoComplete="off"
                  spellCheck={false}
                  aria-label={`Letter ${i + 1}`}
                  data-bind={`join.code.${i}`}
                  value={code[i] ?? ''}
                  onKeyDown={(e) => onKey(i, e)}
                  onChange={(e) => {
                    const typed = codeLetters(e.target.value);
                    if (!typed) return;
                    // typing into a box replaces from there on; several letters (autofill) spill over
                    const next = (code.slice(0, i) + typed).slice(0, ROOM_CODE_LENGTH);
                    setCode(next);
                    setPasted(false);
                    setError(null);
                    focus(Math.min(next.length, ROOM_CODE_LENGTH - 1));
                  }}
                />
              ))}
              {state === 'pasted' && (
                <span className="stamp stamp--ok stamp--lg codebox__stamp m-p7">
                  <Icon name="check" />
                  Link pasted
                </span>
              )}
              {state === 'error' && (
                <span className="stamp stamp--bad stamp--lg codebox__stamp m-p7">
                  <Icon name="close" />
                  No room
                </span>
              )}
            </div>
            <div className="join__status" role="status" aria-live="polite">
              {state === 'empty' && (
                <span className="status status--busy">
                  <Icon name="keyboard" />
                  Type or paste: letters only (codes skip I, L and O)
                </span>
              )}
              {state === 'typing' && (
                <span className="status status--busy">
                  <span data-bind="join.progress">
                    {code.length} of {ROOM_CODE_LENGTH} letters
                  </span>
                </span>
              )}
              {state === 'pasted' && (
                <span className="status status--ok">
                  <Icon name="ok" />
                  Link pasted: code {code}
                </span>
              )}
              {state === 'ready' && (
                <span className="status status--ok">
                  <Icon name="ok" />
                  Code {code}: press Enter to join
                </span>
              )}
              {state === 'error' && (
                <span className="status status--bad">
                  <Icon name="bad" />
                  {error}. Check the letters with your friend, or ask for the link again.
                </span>
              )}
            </div>
            <div className="join__actions">
              {/* a local room's host with no internet: swap QR codes instead (LanPanels) */}
              <button className="btn btn--volt btn--xl m-p8" type="button" disabled={code.length !== ROOM_CODE_LENGTH || busy || state === 'error'} aria-disabled={code.length !== ROOM_CODE_LENGTH || busy || state === 'error'} onClick={() => void join()}>
                <Icon name="door-out" />
                {busy ? 'Joining…' : 'Join room'}
              </button>
              <button className="btn btn--paper btn--xl m-p8" type="button" onClick={pasteLink}>
                <Icon name="paste" />
                Paste link
              </button>
            </div>
            <button className="btn btn--ghost btn--sm m-p8 mf-join__lan" type="button" onClick={() => ctl.openOverlay('lan-join')}>
              <Icon name="wifi" />
              No internet? Join a local room with the host's QR
            </button>
          </div>
          <aside className="ticket join__help" aria-label="Where to find the code">
            <span className="label">Where to find it</span>
            <b className="display join__help-title">At the end of the link</b>
            <div className="chatmock" aria-hidden="true">
              <div className="chatmock__head">
                <span className="avatar">S</span>
                <span>
                  <b>Squad night</b>
                  <br />
                  <span className="chatmock__sub">Kemi, Raja, Tunde, you</span>
                </span>
              </div>
              <div className="chatmock__msg">
                <b>Kemi</b>
                <p>Room's up: deathmatch, 4 slots left, get in fast</p>
                <p className="chatmock__link">
                  …/r/<mark>KMTXRA</mark>
                </p>
                <span className="chatmock__time">21:04</span>
              </div>
            </div>
            <div className="ticket__perf"></div>
            <p className="join__note">
              <Icon name="info" />
              The code is the last 6 letters of the room link. A room closes when everyone leaves.
            </p>
          </aside>
        </div>
        <Hints>
          <Hint keys={<Cap>Enter</Cap>}>Join</Hint>
          <Hint keys={<Cap>Ctrl V</Cap>}>Paste</Hint>
          <Hint keys={<Cap>Esc</Cap>}>Back</Hint>
        </Hints>
      </div>
    </Screen>
  );
}
