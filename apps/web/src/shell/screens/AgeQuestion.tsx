/**
 * The 18+ question (shell/age.ts), the one way the game asks it: on the 18+ card (AgeGate.tsx), and
 * on "Save your account" when this device reached it without the card (a link, cleared storage). The
 * year the player was born, nothing picked (docs/10 §7: neutral, young years too). Only a player born
 * in the year they turn 18 is also asked whether they've had that birthday, because the year alone
 * can't say (audit 28 Oct: one question, never a second "I am 18 or older" box).
 *
 * The year is the kit's stepper (UX-02: the native select drew the OS's own widget): ◀ year ▶ around a
 * field that takes the four digits typed (a phone's number pad), steps with the arrow keys, and with a
 * controller's left and right (L1 / R1: ten years). From nothing, a step shows the youngest year first.
 */
import { asksBirthday, birthYears, stepBirthYear, yearDigits } from '../age';
import { PadKbd, useInputDevice } from '../../gamepad/react';
import { Icon } from '../../ui/Icon';
import './age.css';

/** `turned18`: null until answered (and only asked for the year they turn 18) */
export type AgeAnswer = { year: string; turned18: boolean | null };

export const NO_AGE_ANSWER: AgeAnswer = { year: '', turned18: null };

/** The question is answered well enough to send (a whole year; age.ts answerAge still checks it). */
export const ageAnswered = (a: AgeAnswer): boolean => /^\d{4}$/.test(a.year) && (!asksBirthday(Number(a.year)) || a.turned18 !== null);

/**
 * `idBase`: the year field is `${idBase}-year`; `fieldClass`: the field's look where it sits (the 18+
 * card or the account form); `padFirst`: a controller lands on the year first (the card).
 */
export function AgeQuestion({ idBase, fieldClass, value, onChange, padFirst = false }: { idBase: string; fieldClass: string; value: AgeAnswer; onChange: (a: AgeAnswer) => void; padFirst?: boolean }) {
  const whole = /^\d{4}$/.test(value.year);
  const birthday = whole && asksBirthday(Number(value.year));
  const pad = useInputDevice().kind === 'pad';
  const years = birthYears();
  const newest = years[0]!;
  const oldest = years[years.length - 1]!;
  const setYear = (year: string) => {
    if (year !== value.year) onChange({ year, turned18: null });
  };
  const step = (key: string) => {
    const year = stepBirthYear(value.year, key, years);
    if (year !== null) setYear(year);
  };
  const n = Number(value.year);
  return (
    <>
      <div className={`${fieldClass} age-year`}>
        <label id={`${idBase}-year-label`} htmlFor={`${idBase}-year`}>
          Year you were born
        </label>
        <div className="age-year__row">
          {/* the arrows are for a finger or a mouse; the keyboard and a controller step the field itself */}
          <button type="button" className="btn btn--ink btn--icon age-year__step m-p8" tabIndex={-1} data-pad-skip aria-label="One year earlier" aria-controls={`${idBase}-year`} disabled={whole && n <= oldest} onClick={() => step('ArrowLeft')}>
            <Icon name="chev-left" />
          </button>
          <input
            id={`${idBase}-year`}
            className="age-year__val num"
            type="text"
            role="spinbutton"
            inputMode="numeric"
            autoComplete="off"
            enterKeyHint="done"
            spellCheck={false}
            maxLength={4}
            placeholder="YYYY"
            value={value.year}
            aria-valuemin={oldest}
            aria-valuemax={newest}
            aria-valuenow={whole ? n : undefined}
            aria-valuetext={value.year === '' ? 'Not picked' : value.year}
            data-pad-first={padFirst || undefined}
            aria-describedby={pad ? `${idBase}-year-pad` : undefined}
            onChange={(e) => setYear(yearDigits(e.target.value))}
            onKeyDown={(e) => {
              if (stepBirthYear(value.year, e.key, years) === null) return;
              e.preventDefault();
              step(e.key);
            }}
            required
          />
          <button type="button" className="btn btn--ink btn--icon age-year__step m-p8" tabIndex={-1} data-pad-skip aria-label="One year later" aria-controls={`${idBase}-year`} disabled={whole && n >= newest} onClick={() => step('ArrowRight')}>
            <Icon name="chev-right" />
          </button>
        </div>
        {pad && (
          <span id={`${idBase}-year-pad`} className="age-q__pad">
            <PadKbd code="Pad14" />
            <PadKbd code="Pad15" /> one year · <PadKbd code="Pad4" />
            <PadKbd code="Pad5" /> ten years
          </span>
        )}
      </div>
      {birthday && (
        <fieldset className="age-q__birthday">
          <legend>Have you had your 18th birthday yet?</legend>
          <div className="age-q__opts">
            <label>
              <input type="radio" name={`${idBase}-birthday`} checked={value.turned18 === true} onChange={() => onChange({ ...value, turned18: true })} required />
              Yes
            </label>
            <label>
              <input type="radio" name={`${idBase}-birthday`} checked={value.turned18 === false} onChange={() => onChange({ ...value, turned18: false })} />
              Not yet
            </label>
          </div>
        </fieldset>
      )}
    </>
  );
}
