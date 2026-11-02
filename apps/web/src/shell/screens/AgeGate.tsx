/**
 * The 18+ card (shell/age.ts, UX-02): before this device's first online room, the year the player was
 * born, asked once (AgeQuestion.tsx; audit 28 Oct: a year and an "I am 18 or older" box asked the same
 * thing twice). Neutral (docs/10 §7): no year picked, young years too. An under-18 answer gets a polite
 * no, and keeps getting it on this device.
 *
 * One card for the question and both refusals (the device's answer, and the account's: the API's
 * adults_only), so the rule has one look: the kit's paper card, stamped, with no code line. It's drawn
 * over a dimmed Home when it was asked from there (`overHome`), else over the game's key art, with the
 * room's host and code as its eyebrow for a room link (the 1 Nov atlas: a bare form on black read as a
 * gate, not a game). Desktop and phone (`phone`: the compact sizes); a dialog that keeps the focus;
 * the Terms and the privacy note as full-size links. Motion: the card rises from the bottom (P9), the
 * title focus-pulls (P1), the refusal's stamp lands (P7); under Reduce motion, fades only.
 */
import { GAME_NAME } from '@military-forge/shared';
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { useFocusTrap } from '../../ui/focusTrap';
import { PRIVACY_URL } from '../../metrics/ConsentCard';
import { Icon } from '../../ui/Icon';
import { blurAfter } from '../../ui/Screen';
import { useCtl } from '../context';
import { TERMS_URL } from '../pages';
import { PosterImg, QUICK_MATCH_ART } from '../posters';
import type { Intent } from '../store';
import { AgeQuestion, NO_AGE_ANSWER, ageAnswered } from './AgeQuestion';
import './age.css';

/** The room a link leads into: its code, and its host's name once the API says (null: not known). */
function useLinkRoom(then: Intent | undefined): { code: string; host: string | null } | null {
  const ctl = useCtl();
  const code = then && (then.to === 'join' || then.to === 'watch') ? then.code : null;
  const [host, setHost] = useState<{ code: string; host: string | null } | null>(null);
  useEffect(() => {
    if (!code || typeof ctl.peekRoom !== 'function') return undefined;
    let live = true;
    void ctl.peekRoom(code).then((r) => live && setHost(r));
    return () => {
      live = false;
    };
  }, [ctl, code]);
  if (!code) return null;
  return { code, host: host?.code === code ? host.host : null };
}

/** The card's eyebrow: whose room a link leads into, else the game and the rule. */
export function ageEyebrow(room: { code: string; host: string | null } | null): string {
  if (!room) return `${GAME_NAME} · 18+`;
  return room.host ? `${room.host}'s room · ${room.code}` : `Room ${room.code} · 18+`;
}

export function AgeGate({
  refused,
  phone = false,
  then,
  overHome = false,
  account = false,
}: {
  refused: boolean;
  phone?: boolean;
  /** where the answer leads (a room link names the room on the card) */
  then?: Intent;
  /** asked from Home: Home shows dimmed under the card; else the game's key art does */
  overHome?: boolean;
  /** the refusal is the account's (the API's adults_only), not this device's answer just now */
  account?: boolean;
}) {
  const ctl = useCtl();
  const [answer, setAnswer] = useState(NO_AGE_ANSWER);
  const [error, setError] = useState<string | null>(null);
  const card = useRef<HTMLElement>(null);
  const room = useLinkRoom(refused ? undefined : then);
  useFocusTrap(card, true);
  const cls = ['age-gate', phone ? 'age-gate--phone' : '', overHome ? 'age-gate--over-home' : ''].filter(Boolean).join(' ');
  // Home under the card listens for Enter as Play now: the card's Enter is the card's own
  const keepEnter = (e: KeyboardEvent) => {
    if (e.key === 'Enter') e.stopPropagation();
  };
  const backdrop = (
    <>
      {!overHome && <PosterImg poster={QUICK_MATCH_ART} sizes="100vw" className="age-gate__art" />}
      <div className="age-gate__scrim" aria-hidden="true"></div>
    </>
  );
  const legal = (
    <p className="age-card__links">
      <a href={TERMS_URL} target="_blank" rel="noopener">
        Terms
      </a>
      <a href={PRIVACY_URL} target="_blank" rel="noopener">
        Privacy
      </a>
    </p>
  );

  if (refused) {
    return (
      <div className={cls} onKeyDown={keepEnter}>
        {backdrop}
        <section ref={card} className="age-card m-p9 m-p9--bottom" role="alertdialog" aria-modal="true" aria-labelledby="age-title" aria-describedby="age-lead" tabIndex={-1} data-state="refused">
          <span className="tape age-card__tape" aria-hidden="true"></span>
          <Icon name="lock" className="age-card__ghost" />
          <span className="stamp stamp--bad stamp--lg age-card__stamp m-p7">18+ only</span>
          <h1 id="age-title" className="display age-card__title m-p1">
            {account ? 'Online play is for adults' : 'Sorry, online play is for adults'}
          </h1>
          <p id="age-lead" className="age-card__lead">
            {account
              ? 'Online rooms, friends and voice are for players 18 and over. Training against bots is open to everyone.'
              : `${GAME_NAME} is for players 18 and over, so online rooms, friends and voice stay closed on this device. Training against bots is open to everyone. Thanks for telling us honestly.`}
          </p>
          <div className="age-card__foot">
            <div className="age-card__actions">
              <button type="button" className="btn btn--volt m-p8" data-pad-first onClick={blurAfter(() => ctl.go({ to: 'training' }))}>
                <Icon name="play" />
                Training
              </button>
              <button type="button" className="btn btn--ghost m-p8" data-pad-back onClick={blurAfter(() => ctl.go({ to: 'home' }))}>
                <Icon name="back" />
                Home
              </button>
            </div>
            {legal}
          </div>
        </section>
      </div>
    );
  }

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!ageAnswered(answer)) return;
    if (ctl.answerAge(Number(answer.year), answer.turned18 ?? undefined) === 'invalid') setError("That year doesn't look right");
  };
  return (
    <div className={cls} onKeyDown={keepEnter}>
      {backdrop}
      <section ref={card} className="age-card m-p9 m-p9--bottom" role="dialog" aria-modal="true" aria-labelledby="age-title" aria-describedby="age-lead" tabIndex={-1}>
        <span className="tape age-card__tape" aria-hidden="true"></span>
        <form className="age-card__form" onSubmit={submit} noValidate>
          <p className="age-card__eyebrow" data-bind="age.room">
            {ageEyebrow(room)}
          </p>
          <h1 id="age-title" className="display age-card__title m-p1">
            Online play is 18+
          </h1>
          <p id="age-lead" className="age-card__lead">
            Online rooms are for adults. Tell us the year you were born: we keep the year only, never your birthday.
          </p>
          <AgeQuestion
            idBase="age"
            fieldClass="age-card__field"
            padFirst
            value={answer}
            onChange={(a) => {
              setAnswer(a);
              setError(null);
            }}
          />
          {error && (
            <p className="age-card__error" role="alert">
              <Icon name="warn" size="sm" />
              {error}
            </p>
          )}
          <div className="age-card__foot">
            <div className="age-card__actions">
              <button type="submit" className="btn btn--volt m-p8" disabled={!ageAnswered(answer)}>
                Continue
                <Icon name="arrow-right" />
              </button>
              {/* a controller's B (gamepad/menus.ts) */}
              <button type="button" className="btn btn--ghost m-p8" data-pad-back onClick={blurAfter(() => ctl.go({ to: 'home' }))}>
                Not now
              </button>
            </div>
            {legal}
          </div>
        </form>
      </section>
    </div>
  );
}
