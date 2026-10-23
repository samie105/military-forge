/**
 * Settings → Touch → Fire (controls spec §4.4; the owner's "shooting styles"): the four fire modes,
 * each with its little moving picture (touch/fireArt.ts, the first-run chooser's too). Picking one
 * applies at once and is saved; it also counts as the first-run choice (the chooser won't ask again).
 */
import { FIRE_MODES, type FireMode } from '../../touch/settings';
import { FIRE_MODE_TEXT, fireArt } from '../../touch/fireArt';
import './firePicker.css';

export function FirePicker({ value, onChange, compact = false }: { value: FireMode; onChange: (fire: FireMode) => void; compact?: boolean }) {
  return (
    <div className={`mf-firepick${compact ? ' mf-firepick--compact' : ''}`} role="radiogroup" aria-label="Fire">
      {FIRE_MODES.map((m) => (
        <button key={m} type="button" role="radio" aria-checked={value === m} className={`mf-firepick__opt m-p8${value === m ? ' is-on' : ''}`} onClick={() => onChange(m)}>
          <span className="mf-firepick__art" dangerouslySetInnerHTML={{ __html: fireArt(m) }} />
          <b>{FIRE_MODE_TEXT[m].name}</b>
          {!compact && <span className="mf-firepick__line">{FIRE_MODE_TEXT[m].line}</span>}
        </button>
      ))}
    </div>
  );
}
