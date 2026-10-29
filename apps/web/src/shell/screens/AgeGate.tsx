/**
 * The 18+ step (shell/age.ts): before this device's first online room, the year the player was
 * born, asked once (AgeQuestion.tsx; audit 28 Oct: a year and an "I am 18 or older" box asked the
 * same thing twice). Neutral (docs/10 §7): no year picked, young years listed too. An under-18
 * answer gets a polite no, and keeps getting it on this device.
 *
 * One card for desktop and phone (`phone`: the compact sizes): a dialog (role on the card, the form
 * inside it, focus kept in it), with the Terms and the privacy note as full-size links.
 */
import { GAME_NAME } from '@military-forge/shared';
import { useRef, useState, type FormEvent } from 'react';
import { useFocusTrap } from '../../ui/focusTrap';
import { PRIVACY_URL } from '../../metrics/ConsentCard';
import { Icon } from '../../ui/Icon';
import { blurAfter } from '../../ui/Screen';
import { useCtl } from '../context';
import { TERMS_URL } from '../pages';
import { AgeQuestion, NO_AGE_ANSWER, ageAnswered } from './AgeQuestion';
import './age.css';

export function AgeGate({ refused, phone = false }: { refused: boolean; phone?: boolean }) {
  const ctl = useCtl();
  const [answer, setAnswer] = useState(NO_AGE_ANSWER);
  const [error, setError] = useState<string | null>(null);
  const card = useRef<HTMLElement>(null);
  useFocusTrap(card, true);
  const cls = `age-gate${phone ? ' age-gate--phone' : ''}`;
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
      <div className={cls}>
        <section ref={card} className="age-card" role="dialog" aria-modal="true" aria-labelledby="age-title" tabIndex={-1} data-state="refused">
          <p className="age-card__eyebrow">{GAME_NAME} · 18+</p>
          <h1 id="age-title" className="display age-card__title">
            Sorry, online play is for adults
          </h1>
          <p className="age-card__lead">{GAME_NAME} is for players 18 and over, so online rooms stay closed on this device. Thanks for telling us honestly.</p>
          <div className="age-card__actions">
            <button type="button" className="btn btn--ghost" onClick={blurAfter(() => ctl.go({ to: 'home' }))}>
              <Icon name="back" />
              Back
            </button>
          </div>
          {legal}
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
    <div className={cls}>
      <section ref={card} className="age-card" role="dialog" aria-modal="true" aria-labelledby="age-title" aria-describedby="age-lead" tabIndex={-1}>
        <form className="age-card__form" onSubmit={submit} noValidate>
          <p className="age-card__eyebrow">{GAME_NAME} · 18+</p>
          <h1 id="age-title" className="display age-card__title">
            Online play is 18+
          </h1>
          <p id="age-lead" className="age-card__lead">
            Online rooms are for adults. Tell us the year you were born: we keep the year only, never your birthday.
          </p>
          <AgeQuestion
            idBase="age"
            fieldClass="age-card__field"
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
          <div className="age-card__actions">
            <button type="submit" className="btn btn--volt" disabled={!ageAnswered(answer)}>
              Continue
              <Icon name="arrow-right" />
            </button>
            <button type="button" className="btn btn--ghost" onClick={blurAfter(() => ctl.go({ to: 'home' }))}>
              Not now
            </button>
          </div>
        </form>
        {legal}
      </section>
    </div>
  );
}
