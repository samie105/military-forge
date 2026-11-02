/**
 * "Keep this name?" (gradual engagement, 1 Nov): a first visit through the title plays at once under a callsign
 * the API made up (controller.ts enlist); after the first match (Results) or on Home, this asks once whether to
 * keep it. Keep it: the question goes. Change: Edit name opens (the question goes too: it was answered).
 * Not for an offline name (it can't be changed there) or before there's a profile.
 */
import { useContext } from 'react';
import { useStore } from 'zustand';
import { Icon } from '../../ui/Icon';
import { ControllerContext } from '../context';
import type { ShellController } from '../controller';
import './keepName.css';

type Where = 'home' | 'results' | 'phone' | 'phone-home';

/** Drawn under the shell's controller only (a screen drawn alone, as in a test, has no account to ask about). */
export function KeepName({ where }: { where: Where }) {
  const ctl = useContext(ControllerContext);
  return ctl ? <KeepNameCard ctl={ctl} where={where} /> : null;
}

function KeepNameCard({ ctl, where }: { ctl: ShellController; where: Where }) {
  const store = ctl.store;
  const ask = useStore(store, (s) => s.nameAsk === true);
  const profile = useStore(store, (s) => s.profile);
  if (!ask || !profile || profile.offline) return null;
  // on Home the poster keeps the one volt button (UX atlas 1 Nov, UX-11): the question's answers are paper and ghost there
  const onHome = where === 'home' || where === 'phone-home';
  return (
    <section className={`mf-keepname mf-keepname--${where}${where === 'phone-home' ? ' mf-keepname--phone' : ''} m-p3`} aria-labelledby="mf-keepname-q">
      <span className="label label--volt">Your callsign</span>
      <p id="mf-keepname-q" className="mf-keepname__q">
        You're playing as <b className="display">{profile.nickname}</b>. Keep this name?
      </p>
      <div className="mf-keepname__acts">
        <button type="button" className={`btn ${onHome ? 'btn--paper' : 'btn--volt'} btn--sm m-p8`} data-act="keep-name" onClick={() => ctl.keepName()}>
          <Icon name="ok" />
          Keep it
        </button>
        <button type="button" className={`btn ${onHome ? 'btn--ghost' : 'btn--paper'} btn--sm m-p8`} data-act="change-name" onClick={() => ctl.changeName()}>
          <Icon name="edit" />
          Change
        </button>
      </div>
    </section>
  );
}
