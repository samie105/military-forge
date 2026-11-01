/**
 * A friend request that arrived while you were elsewhere (audit C-26): a small toast in the invite
 * toast's look, with Accept, Block (a quiet one, asked once: audit-2 L-02) and Later (×). It sits where the invite toast does (social.md: top centre in
 * the menus; mid-match top left under the net plate, clear of the HUD's middle) and gives way to an
 * invite, which can't wait. The request stays in Friends whatever you do; the toast puts itself away
 * after a while (sooner mid-match). It never takes the keyboard.
 */
import { MatchPhase } from '@military-forge/sim';
import { useEffect } from 'react';
import { usePhoneLayout } from '../shell/screens/phone/layout';
import { Icon } from '../ui/Icon';
import { Avatar } from './FriendsPanel';
import { secondsLeft, useSel, type SocialController } from './social';

/** How long a request's toast stays (mid-match it goes sooner: the fight comes first). */
export const REQUEST_TOAST_MS = 12_000;
export const REQUEST_TOAST_PLAY_MS = 6_000;

export function RequestToast({ social }: { social: SocialController }) {
  const toasts = useSel(social.store, (s) => s.requestToasts);
  const busy = useSel(social.store, (s) => s.busy);
  const inviteUp = useSel(social.store, (s) => s.invites.some((i) => !s.hidden[i.id] && secondsLeft(i) > 0));
  const covered = useSel(social.store, (s) => s.panel.open || s.picker);
  const screen = useSel(social.shell.store, (s) => s.screen.name);
  const overlay = useSel(social.shell.store, (s) => s.overlay);
  const phase = useSel(social.shell.store, (s) => s.match?.phase ?? null);
  const phone = usePhoneLayout();
  const person = toasts[0];
  const inPlay = (screen === 'room' || screen === 'training') && (phase === MatchPhase.Countdown || phase === MatchPhase.InProgress);
  const playing = inPlay && overlay === null;
  const shown = !!person && !inviteUp && !covered;
  useEffect(() => {
    if (!shown || !person) return undefined;
    const t = setTimeout(() => social.hideRequestToast(person.id), playing ? REQUEST_TOAST_PLAY_MS : REQUEST_TOAST_MS);
    return () => clearTimeout(t);
  }, [shown, person, playing, social]);
  if (!shown || !person) return null;
  const waiting = busy[person.id] === true;
  return (
    <div className={`mf-fit ${phone ? 'mf-fit--phone ' : ''}kit-v2 mf-social-toast`}>
      <section className={`screen screen--game sx-tscreen${phone ? ' screen--phone sx-tscreen--phone' : ''}`} data-screen="request-toast" aria-label="Friend request">
        <div className={`sx-toast sx-toast--req m-p9${playing ? ' sx-toast--play' : ''}`} role="alertdialog" aria-labelledby={`sx-req-${person.id}`} key={person.id}>
          <span className="sx-toast__edge" aria-hidden="true"></span>
          <div className="sx-toast__top">
            <Avatar name={person.nickname} look={person.look} />
            <span className="sx-toast__text">
              <span className="label label--volt sx-toast__label">Friend request</span>
              <b id={`sx-req-${person.id}`} className="sx-toast__title">
                {person.nickname} wants to be friends
              </b>
              {!phone && toasts.length > 1 && <span className="sx-toast__sub">{toasts.length - 1} more waiting in Friends</span>}
            </span>
            <span className="sx-toast__acts">
              <button
                type="button"
                className="btn btn--volt btn--sm sx-act"
                data-pad-y="Accept"
                disabled={waiting}
                onClick={() => {
                  social.hideRequestToast(person.id);
                  void social.accept(person);
                }}
              >
                <Icon name="check" />
                Accept
              </button>
              <button
                type="button"
                className="btn btn--ghost btn--sm sx-act"
                disabled={waiting}
                onClick={() => {
                  social.hideRequestToast(person.id);
                  social.openPlayer({ name: person.nickname, id: person.id, look: person.look, place: 'request' }, 'block');
                }}
              >
                Block
              </button>
              <button type="button" className="btn btn--ghost btn--icon btn--sm sx-act" aria-label="Later: keep it in Friends" onClick={() => social.hideRequestToast(person.id)}>
                <Icon name="close" />
              </button>
            </span>
          </div>
        </div>
      </section>
    </div>
  );
}
