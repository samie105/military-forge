/**
 * 1 · Name entry (the kit's data-screen="name-entry"): the first visit, and Edit name on Home.
 * The live check is the API's (docs/07 §3): available, taken with suggestions, too short, checking,
 * or another rule broken (the API's reason, in words). When the check itself fails (the API down, a
 * 5xx, a 429, a tunnel hiccup) the name is unchecked and Continue lets the API decide on submit.
 */
import { useEffect, useRef, useState } from 'react';
import { useStore } from 'zustand';
import { Cap } from '../../ui/Kbd';
import { Icon } from '../../ui/Icon';
import { Screen } from '../../ui/Screen';
import { NICKNAME_REASONS, type NicknameCheck } from '../api';
import { useCtl } from '../context';
import type { ShellStore } from '../store';

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

/** A stable "No." for the ID card, from the name (decoration, the same every time for a name). */
function cardNumber(name: string): string {
  let h = 2166136261;
  for (const ch of name) h = Math.imul(h ^ ch.codePointAt(0)!, 16777619);
  const n = (h >>> 0) % 100_000_000;
  const s = String(n).padStart(8, '0');
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}

export function NameEntry({ store, first }: { store: ShellStore; first: boolean }) {
  const ctl = useCtl();
  const profile = useStore(store, (s) => s.profile);
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

  useEffect(() => input.current?.focus(), []);
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
    <Screen name="name-entry" kind="menu" states={[state]} label="Your name">
      <form
        className="ne"
        onSubmit={(e) => {
          e.preventDefault();
          if (canContinue) void submit(name.trim());
        }}
      >
        <div className="ne__cardwrap" aria-hidden="true">
          <div className="idcard">
            <div className="idcard__head">
              <span className="idcard__stencil">Field ID</span>
              <span className="num">No. {cardNumber(preview)}</span>
            </div>
            <div className="idcard__photo">
              <Icon name="helmet" />
            </div>
            <div className="idcard__strip">
              <span className="idcard__label">Callsign</span>
              <span className="idcard__name" data-bind="nameEntry.preview">
                {preview}
              </span>
            </div>
            <div className="idcard__meta">
              <span>Rank · Recruit</span>
              <span>Kit · Rookie</span>
            </div>
            {state === 'available' && <span className="idcard__stamp">Cleared</span>}
          </div>
        </div>

        <div className="ne__form">
          <p className="eyebrow">{first ? 'New recruit' : 'Your callsign'}</p>
          <h1 id="ne-title" className="display h1">
            What should we call you?
          </h1>
          <p className="lead">Friends see this name in the room, the kill feed and the scoreboard. You can change it later on Home.</p>

          <div className="field">
            <label className="field__label" htmlFor="ne-input">
              Your name
            </label>
            <div className="ne__inputwrap">
              <input
                ref={input}
                id="ne-input"
                className="input"
                data-bind="nameEntry.value"
                value={name}
                maxLength={32}
                autoComplete="nickname"
                spellCheck={false}
                aria-label="Your name"
                aria-describedby="ne-help ne-check"
                onChange={(e) => {
                  setName(e.target.value);
                  setError(null);
                  setSuggestions([]);
                }}
              />
              <span className="ne__count num" data-bind="nameEntry.length">
                {length}/{NAME_MAX}
              </span>
            </div>
            <p id="ne-help" className="small muted">
              {NAME_MIN} to {NAME_MAX} characters: letters, numbers, spaces and _ - .
            </p>
          </div>

          <div id="ne-check" className="ne__check" aria-live="polite">
            {state === 'available' && (
              <p className="status status--ok">
                <Icon name="check-circle" />
                Available
              </p>
            )}
            {(state === 'taken' || (state === 'invalid' && shown.length > 0)) && (
              <div className="ne__taken">
                <p className="status status--bad">
                  <Icon name="x-octagon" />
                  {error ?? NICKNAME_REASONS.taken}
                </p>
                {shown.length > 0 && (
                  <div className="ne__suggest">
                    <span className="small muted">Try one of these:</span>
                    <div className="chip-row">
                      {shown.slice(0, 3).map((s) => (
                        <button type="button" key={s} className="chip" onClick={() => setName(s)}>
                          {s}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
            {state === 'invalid' && shown.length === 0 && (
              <p className="status status--bad">
                <Icon name="x-octagon" />
                {error ?? NICKNAME_REASONS[check?.reason ?? ''] ?? 'Not allowed'}
              </p>
            )}
            {state === 'too-short' && (
              <p className="status status--warn">
                <Icon name="warn" />
                Too short: use at least {NAME_MIN} characters
              </p>
            )}
            {state === 'checking' && !profile?.offline && (
              <p className="status status--info">
                <span className="spinner" aria-hidden="true"></span>
                Checking…
              </p>
            )}
            {state === 'unchecked' && (
              <p className="status status--info">
                <Icon name="info" />
                Couldn't check the name just now: Continue tries it
              </p>
            )}
            {state === 'same' && (
              <p className="status status--info">
                <Icon name="info" />
                That's your name now
              </p>
            )}
            {changeable && changeable.getTime() > Date.now() && !first && (
              <p className="small muted">Name changes are once a week: next on {changeable.toLocaleDateString()}.</p>
            )}
          </div>

          <div className="ne__actions">
            <button type="submit" className="btn btn--primary btn--xl" disabled={!canContinue}>
              {first ? 'Continue' : 'Save'} {canContinue && <Cap>Enter</Cap>}
            </button>
            {first ? (
              <button type="button" className="btn btn--secondary btn--xl" disabled={busy} onClick={() => void submit(null)}>
                <Icon name="dice" />
                Pick one for me
              </button>
            ) : (
              <button type="button" className="btn btn--ghost btn--xl" onClick={() => ctl.closeOverlay()}>
                Cancel
              </button>
            )}
          </div>
        </div>
      </form>
    </Screen>
  );
}
