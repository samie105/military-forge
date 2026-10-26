/**
 * 1 · Name entry (round two's data-screen="name-entry"): the first visit, and Edit name on Home.
 * The live check is the API's (docs/07 §3): available, taken with suggestions, too short, checking,
 * or another rule broken (the API's reason, in words). When the check itself fails (the API down, a
 * 5xx, a 429, a tunnel hiccup) the name is unchecked and Continue lets the API decide on submit.
 */
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { useStore } from 'zustand';
import { Cap } from '../../ui/Kbd';
import { Icon } from '../../ui/Icon';
import { Screen } from '../../ui/Screen';
import { NICKNAME_REASONS, type NicknameCheck } from '../api';
import { useCtl } from '../context';
import type { ShellStore } from '../store';
import { joiningLine, useJoining } from './joining';
import { Backdrop, Hint, Hints, NetPill, rememberCard } from './frame';

export const NAME_MIN = 3;
export const NAME_MAX = 16;

export type NameState = 'available' | 'taken' | 'too-short' | 'checking' | 'unchecked' | 'invalid' | 'empty' | 'same';

/** The kit's state for what's typed and what the API said about it (`failed`: the check couldn't be made). */
export function nameState(name: string, check: NicknameCheck | null, current: string | null, pending: boolean, failed = false): NameState {
  const t = name.trim();
  if (!t) return 'empty';
  if (current !== null && t === current) return 'same';
  if ([...t].length < NAME_MIN) return 'too-short';
  if (pending) return 'checking';
  if (!check) return failed ? 'unchecked' : 'checking';
  if (!check.valid) return check.reason === 'too_short' ? 'too-short' : 'invalid';
  return check.available ? 'available' : 'taken';
}

/**
 * Enter submits whenever Continue would, and also while the name is still being checked (typing
 * then Enter at once): the server's answer decides, and a taken name comes back with suggestions.
 * The browser's own Enter-to-submit skips a form whose submit button is disabled, so the field
 * handles Enter itself.
 */
export function enterSubmits(state: NameState, canContinue: boolean, busy: boolean): boolean {
  return canContinue || (!busy && state === 'checking');
}

/** A stable "No." for the ID card, from the name (decoration, the same every time for a name). */
function cardNumber(name: string): string {
  let h = 2166136261;
  for (const ch of name) h = Math.imul(h ^ ch.codePointAt(0)!, 16777619);
  const s = String((h >>> 0) % 1_000_000).padStart(6, '0');
  return `${s.slice(0, 3)} ${s.slice(3)}`;
}

export function NameEntry({ store, first }: { store: ShellStore; first: boolean }) {
  const ctl = useCtl();
  const profile = useStore(store, (s) => s.profile);
  // an invite link: whose room this leads into (P1-3)
  const joining = useJoining(store);
  const current = first ? null : (profile?.nickname ?? null);
  const [name, setName] = useState(profile?.nickname ?? '');
  const [check, setCheck] = useState<NicknameCheck | null>(null);
  const [pending, setPending] = useState(false);
  /** the live check failed (not the name: the request) */
  const [failed, setFailed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const card = useRef<HTMLElement>(null);

  // no scroll jump on a phone: the field is where it is, the keyboard comes up under it
  useEffect(() => input.current?.focus({ preventScroll: true }), []);
  // the live check, debounced while typing
  useEffect(() => {
    setCheck(null);
    setFailed(false);
    const t = name.trim();
    if (!t || t === current || [...t].length < NAME_MIN || profile?.offline) {
      setPending(false);
      return;
    }
    setPending(true);
    let live = true;
    const timer = window.setTimeout(() => {
      ctl.checkName(t).then(
        (c) => {
          if (!live) return;
          setCheck(c);
          setPending(false);
        },
        () => {
          if (!live) return;
          setPending(false);
          setFailed(true);
        },
      );
    }, 300);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [name, ctl, current, profile?.offline]);

  const submit = async (value: string | null) => {
    setBusy(true);
    setError(null);
    // the card's place, for Home's player chip to grow out of (motion P2)
    if (first) rememberCard(card.current);
    const res = await ctl.setName(value);
    setBusy(false);
    if (!res.ok) {
      setError(res.error ?? 'Try another name');
      setSuggestions(res.suggestions ?? []);
    } else if (!first) ctl.closeOverlay();
  };

  const state = error ? 'invalid' : nameState(name, check, current, pending, failed);
  const shown = suggestions.length ? suggestions : (check?.suggestions ?? []);
  const canContinue = !busy && (state === 'available' || state === 'unchecked' || (state === 'checking' && !!profile?.offline) || (!first && state === 'same'));
  const length = [...name.trim()].length;
  const changeable = profile?.changeableAt ? new Date(profile.changeableAt) : null;
  const preview = name.trim() || '—';

  return (
    <Screen name="name-entry" kind="menu" states={[state]} label="Your name" dialog={!first}>
      <Backdrop word="RECRUIT" />
      <div className="menu">
        <header className="menu-top">
          <span className="eyebrow" data-bind="nameEntry.joining">{joining ? joiningLine(joining) : first ? 'Enlistment · first time here' : 'Your callsign'}</span>
          <span className="menu-top__spacer"></span>
          <NetPill offline={!!profile?.offline} />
        </header>
        <form
          className="menu-body ne"
          onSubmit={(e) => {
            e.preventDefault();
            if (enterSubmits(state, canContinue, busy)) void submit(name.trim());
          }}
        >
          {/* the ID card: a live preview of the name; it focus-pulls in (P1) and stamps once the name is free (P7) */}
          <figure ref={card} className="idcard paper m-p1" aria-label="Your soldier card">
            <span className="tape" style={{ left: 300, top: -14 }} aria-hidden="true"></span>
            <div className="idcard__photo halftone-ink" aria-hidden="true">
              <Icon name="helmet" className="mf-idcard__helmet" />
            </div>
            <div className="idcard__body">
              <span className="serial">Field ID · No. {cardNumber(preview)}</span>
              <span className="label">Callsign</span>
              <b className="idcard__name display" data-bind="nameEntry.preview">
                {preview}
              </b>
              <div className="idcard__meta">
                <span>
                  <span className="label">Rank</span>
                  <b>Recruit</b>
                </span>
                <span>
                  <span className="label">Card no.</span>
                  <b className="num">{cardNumber(preview)}</b>
                </span>
                <span>
                  <span className="label">Kit</span>
                  <b>Rookie</b>
                </span>
              </div>
            </div>
            {state === 'available' && <span className="stamp stamp--brass stamp--lg idcard__stamp m-p7">Cleared</span>}
            <div className="dogtag" aria-hidden="true">
              <span>{preview}</span>
              <small>Recruit · {cardNumber(preview)}</small>
            </div>
          </figure>

          <div className="ne__form">
            <h1 id="ne-title" className="display display--print ne__title">
              What do we
              <br />
              call you?
            </h1>
            <p className="lead">Friends see this name in the room, the kill feed and the scoreboard. You can change it later on Home.</p>

            <div className="field">
              <label className="label" htmlFor="ne-input">
                Your name
              </label>
              <div className="input">
                <input
                  ref={input}
                  id="ne-input"
                  className="mf-input__field"
                  data-bind="nameEntry.value"
                  value={name}
                  maxLength={32}
                  autoComplete="nickname"
                  spellCheck={false}
                  aria-label="Your name"
                  aria-describedby="ne-help ne-status"
                  onChange={(e) => {
                    setName(e.target.value);
                    setError(null);
                    setSuggestions([]);
                  }}
                  onKeyDown={(e) => {
                    if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
                    e.preventDefault();
                    if (enterSubmits(state, canContinue, busy)) void submit(name.trim());
                  }}
                />
                <span className="input__count num" data-bind="nameEntry.length">
                  {length}/{NAME_MAX}
                </span>
              </div>
              <p id="ne-help" className="ne__help">
                {NAME_MIN} to {NAME_MAX} characters: letters, numbers, spaces and _ - .
              </p>
              <div id="ne-status" role="status" aria-live="polite">
                {state === 'available' && (
                  <span className="status status--ok m-p7" key="ok">
                    <Icon name="ok" />
                    Free to use
                  </span>
                )}
                {(state === 'taken' || (state === 'invalid' && shown.length > 0)) && (
                  <span className="status status--bad">
                    <Icon name="bad" />
                    {error ?? NICKNAME_REASONS.taken}
                    {shown.length > 0 && ' Try one of these:'}
                  </span>
                )}
                {state === 'invalid' && shown.length === 0 && (
                  <span className="status status--bad">
                    <Icon name="bad" />
                    {error ?? NICKNAME_REASONS[check?.reason ?? ''] ?? 'Not allowed'}
                  </span>
                )}
                {state === 'too-short' && (
                  <span className="status status--warn">
                    <Icon name="warn" />
                    One more letter: names need {NAME_MIN} or more
                  </span>
                )}
                {state === 'checking' && !profile?.offline && (
                  <span className="status status--busy">
                    <span className="spinner" aria-hidden="true"></span>
                    Checking the name…
                  </span>
                )}
                {state === 'unchecked' && (
                  <span className="status status--busy">
                    <Icon name="info" />
                    Couldn't check the name just now: Continue tries it
                  </span>
                )}
                {state === 'same' && (
                  <span className="status status--busy">
                    <Icon name="info" />
                    That's your name now
                  </span>
                )}
              </div>
              {(state === 'taken' || state === 'invalid') && shown.length > 0 && (
                <div className="ne__sugg" role="group" aria-label="Suggestions">
                  {shown.slice(0, 3).map((s, i) => (
                    <button type="button" key={s} className="btn btn--paper btn--sm m-p8 m-p3" style={{ '--i': i } as CSSProperties} onClick={() => setName(s)}>
                      {s}
                    </button>
                  ))}
                </div>
              )}
              {changeable && changeable.getTime() > Date.now() && !first && <p className="ne__help">Name changes are once a week: next on {changeable.toLocaleDateString()}.</p>}
            </div>

            <div className="ne__actions">
              <button type="submit" className="btn btn--volt btn--xl m-p8" disabled={!canContinue} aria-disabled={!canContinue}>
                {joining ? 'Join room' : first ? 'Continue' : 'Save'}
                <Icon name="arrow-right" />
              </button>
              {first ? (
                <>
                  <button type="button" className="btn btn--ghost btn--xl m-p8" disabled={busy} onClick={() => void submit(null)}>
                    <Icon name="dice" />
                    Pick one for me
                  </button>
                  {/* a saved account on a new computer: sign in instead of starting over */}
                  <button type="button" className="btn btn--ghost btn--xl m-p8" data-act="sign-in" disabled={busy} onClick={() => ctl.openAccount({ mode: 'signin' })}>
                    <Icon name="user" />
                    Sign in
                  </button>
                </>
              ) : (
                <button type="button" className="btn btn--ghost btn--xl m-p8" onClick={() => ctl.closeOverlay()}>
                  Cancel
                </button>
              )}
            </div>
          </div>
        </form>
        <Hints>
          <Hint keys={<Cap>Enter</Cap>}>{first ? 'Continue' : 'Save'}</Hint>
          {!first && <Hint keys={<Cap>Esc</Cap>}>Cancel</Hint>}
        </Hints>
      </div>
    </Screen>
  );
}
