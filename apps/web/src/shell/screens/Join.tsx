/**
 * 3 · Join with code (the kit's data-screen="join"): six letter boxes; typing moves along, Backspace
 * moves back, and a pasted link or code (anywhere on the screen) fills them. The API says whether
 * the room exists before the game connects: "No room with that code" stays on this screen.
 */
import { ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH, normalizeRoomCode } from '@military-forge/shared';
import { useEffect, useRef, useState } from 'react';
import { Icon } from '../../ui/Icon';
import { Cap } from '../../ui/Kbd';
import { Screen } from '../../ui/Screen';
import { useCtl } from '../context';

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

  return (
    <Screen name="join" kind="menu" states={[state === 'ready' ? 'pasted' : state]} label="Join with code">
      <header className="topbar">
        <button className="btn btn--ghost" onClick={() => ctl.closeOverlay()}>
          <Icon name="back" />
          Home
        </button>
        <span className="topbar__title">Join with code</span>
      </header>

      <div className="screen-body join">
        <div className="join__main">
          <p className="eyebrow">Room code</p>
          <h1 id="join-title" className="display h1">
            Type your friend's code
          </h1>
          <p className="lead">Six letters. Got a link instead? Paste it into any box and we'll pull the code out of it.</p>

          <div className="codebox" role="group" aria-label="Room code, 6 letters">
            {Array.from({ length: ROOM_CODE_LENGTH }, (_, i) => (
              <input
                key={i}
                ref={(el) => {
                  boxes.current[i] = el;
                }}
                className={i === code.length && state !== 'error' ? 'codebox__cell is-caret' : 'codebox__cell'}
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
          </div>

          <div className="join__status" aria-live="polite">
            {state === 'empty' && (
              <p className="status status--info">
                <Icon name="info" />
                Letters only: codes skip I, L and O
              </p>
            )}
            {state === 'typing' && (
              <p className="status status--info">
                <Icon name="info" />
                <span data-bind="join.progress">
                  {code.length} of {ROOM_CODE_LENGTH} letters
                </span>
              </p>
            )}
            {state === 'pasted' && (
              <p className="status status--ok">
                <Icon name="check-circle" />
                Link pasted. Found code {code}
              </p>
            )}
            {state === 'ready' && (
              <p className="status status--ok">
                <Icon name="check-circle" />
                Code {code}: press Enter to join
              </p>
            )}
            {state === 'error' && (
              <div>
                <p className="status status--bad">
                  <Icon name="x-octagon" />
                  {error}
                </p>
                <p className="join__hint muted">Check the letters with your friend, or ask them to send the link again. A room closes when everyone leaves.</p>
              </div>
            )}
          </div>

          <div className="join__actions">
            <button className="btn btn--primary btn--xl" disabled={code.length !== ROOM_CODE_LENGTH || busy || state === 'error'} onClick={() => void join()}>
              {busy ? 'Joining…' : 'Join room'} {code.length === ROOM_CODE_LENGTH && !busy && state !== 'error' && <Cap>Enter</Cap>}
            </button>
            <button
              className="btn btn--secondary btn--xl"
              onClick={() =>
                void navigator.clipboard
                  ?.readText()
                  .then((t) => fill(t, true))
                  .catch(() => setError('Paste with Ctrl+V (or ⌘V): the browser kept the clipboard to itself'))
              }
            >
              <Icon name="paste" />
              Paste link
            </button>
          </div>
        </div>

        <aside className="join__help" aria-label="Where to find the code">
          <div className="chatmock" aria-hidden="true">
            <div className="chatmock__head">
              <span className="chatmock__avatar">LS</span>
              <span>
                <b>Lagos squad</b>
                <span className="chatmock__sub">Kemi, Raja, Tunde, you</span>
              </span>
            </div>
            <div className="chatmock__body">
              <div className="bubble">
                <span className="bubble__who">Kemi</span>
                Room's up, 5 min deathmatch. Join fast!
                <span className="bubble__link">
                  …/r/<mark>KMTXRA</mark>
                </span>
                <span className="bubble__time">21:04</span>
              </div>
              <div className="bubble bubble--me">
                Coming<span className="bubble__time">21:05</span>
              </div>
            </div>
          </div>
          <p className="join__caption">
            <Icon name="info" />
            The code is the last 6 letters of the room link.
          </p>
        </aside>
      </div>
    </Screen>
  );
}
