/**
 * Join with code on a phone (the Pen board's P1; the desktop Join's boxes and keys: useJoinCode). The
 * six boxes sit in the top band, where a landscape phone's keyboard doesn't reach, and the keyboard's
 * Go joins; Join room, Watch (the room as a spectator) and Paste below for a thumb. A Frost card on the right is the way in with no
 * internet: the host's QR (PhoneLanJoin). No box takes focus on arrival: the keyboard would cover the
 * screen before the player has seen it.
 */
import { ROOM_CODE_LENGTH } from '@military-forge/shared';
import { Icon } from '../../../ui/Icon';
import { blurAfter } from '../../../ui/Screen';
import { useCtl } from '../../context';
import { useJoinCode } from '../Join';
import { PhoneScreen, rise } from './layout';

export function PhoneJoin() {
  const ctl = useCtl();
  const { code, state, error, busy, pending, complete, boxes, join, watch, onKey, onType, pasteLink } = useJoinCode({ autoFocus: false });
  const blocked = !complete || busy || state === 'error';

  return (
    <PhoneScreen name="m-join" label="Join with code" word="CODE" dialog states={[state === 'ready' ? 'pasted' : state]}>
      <div className="pm">
        <header className="pm-top">
          <button type="button" className="btn btn--ghost btn--icon btn--sm m-p8 pm-back" aria-label="Back to home" onClick={blurAfter(() => ctl.closeOverlay())}>
            <Icon name="back" />
          </button>
          <span className="pm-titles">
            <span className="pm-eyebrow">Got a code?</span>
            <b className="display pm-h">Join with code</b>
          </span>
        </header>
        <div className="pm-join">
          <div className="pm-join__main m-p3" style={rise(1)}>
            <div className="pm-codebox" role="group" aria-label="Room code, 6 letters">
              {Array.from({ length: ROOM_CODE_LENGTH }, (_, i) => (
                <input
                  key={i}
                  ref={(el) => {
                    boxes.current[i] = el;
                  }}
                  className={['pm-codebox__cell', code[i] ? 'mf-filled' : 'is-empty', state === 'error' ? 'is-bad' : ''].filter(Boolean).join(' ')}
                  maxLength={ROOM_CODE_LENGTH}
                  inputMode="text"
                  enterKeyHint="go"
                  autoCapitalize="characters"
                  autoComplete="off"
                  autoCorrect="off"
                  spellCheck={false}
                  aria-label={`Letter ${i + 1}`}
                  value={code[i] ?? ''}
                  onKeyDown={(e) => onKey(i, e)}
                  onChange={(e) => onType(i, e.target.value)}
                />
              ))}
            </div>
            <p className={`pm-join__status${state === 'error' ? ' is-bad' : state === 'ready' || state === 'pasted' ? ' is-ok' : ''}`} role="status" aria-live="polite">
              {state === 'error' ? (
                <>
                  <Icon name="bad" size="sm" />
                  {error}. Check the letters with your friend.
                </>
              ) : state === 'ready' || state === 'pasted' ? (
                <>
                  <Icon name="ok" size="sm" />
                  Code {code}: tap Join room, or Go
                </>
              ) : state === 'typing' ? (
                `${code.length} of ${ROOM_CODE_LENGTH} letters`
              ) : (
                '6 letters · the end of the room link'
              )}
            </p>
            <div className="pm-join__acts">
              <button type="button" className="btn btn--volt m-p8 pm-join__go" disabled={blocked} aria-disabled={blocked} onClick={blurAfter(() => void join())}>
                <Icon name="door-out" />
                {pending === 'join' ? 'Joining…' : 'Join room'}
              </button>
              {/* the room as a spectator (Paste's size: phone.css) */}
              <button type="button" className="btn btn--ghost m-p8 pm-join__paste pm-join__watch" data-hook="watch" disabled={blocked} aria-disabled={blocked} onClick={blurAfter(() => void watch())}>
                <Icon name="eye" />
                {pending === 'watch' ? 'Watching…' : 'Watch'}
              </button>
              <button type="button" className="btn btn--paper m-p8 pm-join__paste" onClick={pasteLink}>
                <Icon name="paste" />
                Paste
              </button>
            </div>
          </div>
          <aside className="card pm-join__lan m-p3" style={rise(2)} aria-labelledby="pm-join-lan">
            <span id="pm-join-lan" className="label label--volt">
              <Icon name="unplug" size="sm" />
              No internet?
            </span>
            <p>On the same Wi-Fi as the host? Swap two QR codes and you're in.</p>
            <button type="button" className="btn btn--paper btn--block m-p8 pm-join__scan" onClick={blurAfter(() => ctl.openOverlay('lan-join'))}>
              <Icon name="qr" />
              Scan host's QR
            </button>
          </aside>
        </div>
      </div>
    </PhoneScreen>
  );
}
