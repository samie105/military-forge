/**
 * The first-run controls card on a phone (the desktop's TipsCard lists keys and a mouse, which a phone
 * hasn't got): what each thumb does, in the player's own touch settings (which hand, how the aim dial
 * fires, swipe to dash), and the way to Settings → Touch. It shows the first time a player gets into a
 * game (in a room's lobby once they fold it to warm up) and from the in-match menu, like the desktop's.
 *
 * It sits in the gap between the move dial and the aim cluster (mirrored for the left hand), below the
 * warm-up strip and above the take button, so the controls stay in reach while it's up.
 *
 * Motion: the card rises in (P3), its rows after it in a stagger; Got it presses (P8).
 */
import { useEffect, useState } from 'react';
import { Icon } from '../../../ui/Icon';
import { blurAfter } from '../../../ui/Screen';
import { getTouchSettings, onTouchChange, type TouchSettings } from '../../../touch';
import { useCtl } from '../../context';
import { PhoneScreen, rise } from './layout';

export interface TouchTip {
  /** the control, as the player sees it ("Left dial") */
  what: string;
  /** what it does, in a line */
  how: string;
  icon: string;
}

/** The card's rows for these touch settings (pure: the tests and the card share it). */
export function touchTips(s: Pick<TouchSettings, 'handed' | 'fire' | 'swipeDash'>): TouchTip[] {
  const [moveSide, aimSide] = s.handed === 'left' ? ['Right', 'Left'] : ['Left', 'Right'];
  return [
    { what: `${moveSide} dial`, how: `Move. Up flies, down crouches${s.swipeDash ? ', a swipe dashes' : ''}.`, icon: 'jet' },
    { what: `${aimSide} dial`, how: s.fire === 'release' ? 'Aim, then lift to fire.' : 'Aim. Push far to fire.', icon: 'target' },
    { what: 'Grenade', how: 'Hold to aim, let go to throw.', icon: 'g-frag' },
  ];
}

export function PhoneTips() {
  const ctl = useCtl();
  const [s, setS] = useState(getTouchSettings);
  useEffect(() => onTouchChange(() => setS(getTouchSettings())), []);
  return (
    <PhoneScreen name="m-tips" kind="game" label="How to play" states={[s.handed === 'left' ? 'left-handed' : 'right-handed']}>
      <aside className={`pm-tips plate m-p3${s.handed === 'left' ? ' is-left' : ''}`} style={rise(0)} aria-label="How to play">
        <span className="eyebrow">How to play</span>
        <ul className="pm-tips__list">
          {touchTips(s).map((t, i) => (
            <li key={t.what} className="pm-tips__row m-p3" style={rise(i + 1)}>
              <span className="pm-tips__ic" aria-hidden="true">
                <Icon name={t.icon} />
              </span>
              <span className="pm-tips__text">
                <b>{t.what}</b>
                <span>{t.how}</span>
              </span>
            </li>
          ))}
        </ul>
        <div className="pm-tips__actions">
          {/* no autoFocus: the card sits over live play */}
          <button type="button" className="btn btn--volt btn--sm m-p8" onClick={blurAfter(() => ctl.closeTips())}>
            Got it
          </button>
          <button
            type="button"
            className="btn btn--ghost btn--sm btn--icon m-p8"
            aria-label="Touch settings"
            onClick={blurAfter(() => {
              ctl.closeTips();
              ctl.openSettings('touch');
            })}
          >
            <Icon name="touch" />
          </button>
        </div>
      </aside>
    </PhoneScreen>
  );
}
