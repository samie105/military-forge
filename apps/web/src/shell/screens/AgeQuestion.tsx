/**
 * The 18+ question (shell/age.ts), the one way the game asks it: on the age gate (AgeGate.tsx),
 * and on "Save your account" when this device reached it without the gate (a link, cleared
 * storage). The year the player was born, nothing picked (docs/10 §7: neutral, young years listed
 * too). Only a player born in the year they turn 18 is also asked whether they've had that
 * birthday, because the year alone can't say (audit 28 Oct: one question, never a second
 * "I am 18 or older" box).
 */
import { birthYears, asksBirthday } from '../age';
import './age.css';

/** `turned18`: null until answered (and only asked for the year they turn 18) */
export type AgeAnswer = { year: string; turned18: boolean | null };

export const NO_AGE_ANSWER: AgeAnswer = { year: '', turned18: null };

/** The question is answered well enough to send (age.ts answerAge still checks the year). */
export const ageAnswered = (a: AgeAnswer): boolean => a.year !== '' && (!asksBirthday(Number(a.year)) || a.turned18 !== null);

/**
 * `idBase`: the select is `${idBase}-year`; `fieldClass`: the field's look where it sits (the
 * gate's card or the account form).
 */
export function AgeQuestion({ idBase, fieldClass, value, onChange }: { idBase: string; fieldClass: string; value: AgeAnswer; onChange: (a: AgeAnswer) => void }) {
  const birthday = value.year !== '' && asksBirthday(Number(value.year));
  return (
    <>
      <div className={fieldClass}>
        <label htmlFor={`${idBase}-year`}>Year you were born</label>
        <select id={`${idBase}-year`} value={value.year} onChange={(e) => onChange({ year: e.target.value, turned18: null })} required>
          <option value="">Choose…</option>
          {birthYears().map((y) => (
            <option key={y} value={y}>
              {y}
            </option>
          ))}
        </select>
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
