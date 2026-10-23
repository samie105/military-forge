/**
 * Name entry on a phone (the kit has no m-* frame for it: built from round two's name-entry parts, the
 * ID card, the input, the status and the suggestions, at 812×375). The first visit, and Edit name on
 * Home. Same live check and actions as the desktop NameEntry (its nameState, NAME_MIN/NAME_MAX).
 *
 * A phone's keyboard covers the lower half of a landscape screen, so what typing needs (the name, the
 * check, Continue) sits in the top band, and the keyboard's own Go key submits. The input isn't focused
 * on arrival: the keyboard would hide the screen before the player has seen it.
 *
 * Motion: the ID card focus-pulls in (P1) and stamps "Cleared" when the name is free (P7); the form's
 * parts rise in a stagger (P3); buttons press (P8).
 */
import { useEffect, useState } from 'react';
import { useStore } from 'zustand';
import { Icon } from '../../../ui/Icon';
import { blurAfter } from '../../../ui/Screen';
import { NICKNAME_REASONS, type NicknameCheck } from '../../api';
import { useCtl } from '../../context';
import type { ShellStore } from '../../store';
import { joiningLine, useJoining } from '../joining';
import { NAME_MAX, NAME_MIN, enterSubmits, nameState } from '../NameEntry';
import { PhoneScreen, rise, useRotated } from './layout';

/** The upright-phone tip on the name screen was seen (once a phone). */
export const TURN_TIP_KEY = 'mf.phone.turnTip.v1';

function turnTipSeen(): boolean {
  try {
    return localStorage.getItem(TURN_TIP_KEY) === 'seen';
  } catch {
    return false;
  }
}

/**
 * The first screen on an upright phone: the page plays turned onto its side (ui/landscape.ts), and the
 * phone's keyboard would open along the glass, under a sideways form. Once, a card that reads upright
 * asks to turn the phone (the game itself never asks: it just plays sideways).
 */
function TurnTip({ onDone }: { onDone: () => void }) {
  return (
    <div className="pm-turn" role="dialog" aria-label="Turn your phone sideways">
      <div className="pm-turn__card plate">
        <Icon name="rotate" />
        <b className="display">Turn your phone sideways</b>
        <p>Military Forge plays in landscape, and your name is easier to type that way too.</p>
        <button type="button" className="btn btn--ghost btn--sm" onClick={blurAfter(onDone)}>
          Keep it upright
        </button>
      </div>
    </div>
  );
}

export function PhoneNameEntry({ store, first }: { store: ShellStore; first: boolean }) {
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

  // the live check, debounced while typing (as the desktop's)
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
  const pick = (s: string) => {
    setName(s);
    setError(null);
    setSuggestions([]);
  };

  const rotated = useRotated();
  const [turnSeen, setTurnSeen] = useState(turnTipSeen);
  const turnTip = first && rotated && !turnSeen;
  const doneTurn = () => {
    try {
      localStorage.setItem(TURN_TIP_KEY, 'seen');
    } catch {
      /* private mode: it shows again next time */
    }
    setTurnSeen(true);
  };

  return (
    <PhoneScreen name="m-name" label="Your name" word="RECRUIT" modal={!first} dialog={!first} states={[state, turnTip ? 'turn-tip' : null]}>
      <form
        className="pm pm-ne"
        onSubmit={(e) => {
          e.preventDefault();
          if (enterSubmits(state, canContinue, busy)) void submit(name.trim());
        }}
      >
        <div className="pm-ne__card m-p1" aria-hidden="true">
          <div className="pm-id paper">
            <div className="pm-id__photo halftone-ink">
              <Icon name="helmet" />
            </div>
            <span className="serial">Field ID</span>
            <span className="label">Callsign</span>
            <b className="pm-id__name display" data-bind="nameEntry.preview">
              {preview}
            </b>
            <span className="pm-id__meta">
              <span className="label">Rank</span>
              <b>Recruit</b>
            </span>
            {state === 'available' && <span className="stamp stamp--brass pm-id__stamp m-p7">Cleared</span>}
          </div>
        </div>

        <div className="pm-ne__form">
          <header className="pm-ne__head m-p3" style={rise(0)}>
            <span className="eyebrow" data-bind="nameEntry.joining">{joining ? joiningLine(joining) : first ? 'New recruit' : 'Your callsign'}</span>
            <h1 className="display pm-h">What do we call you?</h1>
          </header>

          <div className="pm-ne__row m-p3" style={rise(1)}>
            <label className="input pm-ne__input">
              <input
                className="pm-ne__field"
                data-bind="nameEntry.value"
                value={name}
                maxLength={32}
                autoComplete="nickname"
                autoCorrect="off"
                spellCheck={false}
                enterKeyHint="go"
                placeholder="Your name"
                aria-label="Your name"
                aria-describedby="pm-ne-check"
                // the keyboard's Go while the name is still being checked: the browser skips a form whose
                // submit button is disabled, so the field submits itself (NameEntry's enterSubmits; #167)
                onKeyDown={(e) => {
                  if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
                  e.preventDefault();
                  if (enterSubmits(state, canContinue, busy)) void submit(name.trim());
                }}
                onChange={(e) => {
                  setName(e.target.value);
                  setError(null);
                  setSuggestions([]);
                }}
              />
              <span className="input__count num" data-bind="nameEntry.length">
                {length}/{NAME_MAX}
              </span>
            </label>
            <button type="submit" className="btn btn--volt btn--sm m-p8" disabled={!canContinue}>
              {joining ? 'Join room' : first ? 'Continue' : 'Save'}
              <Icon name="arrow-right" />
            </button>
          </div>

          <div id="pm-ne-check" className="pm-ne__check m-p3" style={rise(2)} role="status" aria-live="polite">
            {state === 'available' && (
              <span className="status status--ok">
                <Icon name="ok" />
                Free to use
              </span>
            )}
            {(state === 'taken' || (state === 'invalid' && shown.length > 0)) && (
              <span className="status status--bad">
                <Icon name="bad" />
                {error ?? NICKNAME_REASONS.taken}
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
                Names need {NAME_MIN} or more characters
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
                Couldn't check it just now: Continue tries it
              </span>
            )}
            {state === 'same' && (
              <span className="status status--busy">
                <Icon name="info" />
                That's your name now
              </span>
            )}
            {state === 'empty' && (
              <span id="pm-ne-help" className="pm-ne__help">
                {NAME_MIN} to {NAME_MAX} characters: letters, numbers, spaces and _ - .
              </span>
            )}
          </div>

          {(state === 'taken' || state === 'invalid') && shown.length > 0 && (
            <div className="pm-ne__sugg m-p3" style={rise(3)} role="group" aria-label="Suggestions">
              {shown.slice(0, 3).map((s) => (
                <button type="button" key={s} className="btn btn--paper btn--sm m-p8" onClick={() => pick(s)}>
                  {s}
                </button>
              ))}
            </div>
          )}

          <div className="pm-ne__more m-p3" style={rise(4)}>
            {first ? (
              <button type="button" className="btn btn--ghost btn--sm m-p8" disabled={busy} onClick={blurAfter(() => void submit(null))}>
                <Icon name="dice" />
                Pick one for me
              </button>
            ) : (
              <button type="button" className="btn btn--ghost btn--sm m-p8" onClick={blurAfter(() => ctl.closeOverlay())}>
                Cancel
              </button>
            )}
            {changeable && changeable.getTime() > Date.now() && !first ? (
              <span className="pm-ne__help">Name changes are once a week: next on {changeable.toLocaleDateString()}.</span>
            ) : (
              <span className="pm-ne__help">Friends see it in the room, the kill feed and the scores.</span>
            )}
          </div>
        </div>
      </form>
      {turnTip && <TurnTip onDone={doneTurn} />}
    </PhoneScreen>
  );
}
