/**
 * The local room's QR panels on a phone (the Pen board's P3, P4 and P5; the desktop's are L2 and L3 in
 * LanPanels.tsx, with the same flows: useLanAdd, useLanJoin). At 812×375 the code to scan takes the
 * left: a paper card with the QR as big as the height allows (about 200 px) and Copy as text; the
 * right is the step on Frost glass, one big action (64 px) and the paste row (48 px targets).
 *
 * The guest's panel opens the camera straight away where the browser can read QR codes (they came
 * here by tapping "Scan host's QR"); elsewhere it's the paste row. A stepper says where they are:
 * Scan → Reply → In.
 */
import { useCallback, useState } from 'react';
import { Icon } from '../../../ui/Icon';
import { blurAfter } from '../../../ui/Screen';
import { useCtl } from '../../context';
import { CodeQr, CopyCode, OFFER_PREFIX, PasteRow, QrPending, REPLY_PREFIX, Stepper, UsedQr, Viewfinder, Waiting, canScan, useLanAdd, useLanJoin } from '../LanPanels';
import { PhoneScreen, rise } from './layout';

function Top({ eyebrow, title, tag }: { eyebrow: string; title: string; tag: string }) {
  const ctl = useCtl();
  return (
    <header className="pm-top">
      <button type="button" className="btn btn--ghost btn--icon btn--sm m-p8 pm-back" aria-label="Back" onClick={blurAfter(() => ctl.closeOverlay())}>
        <Icon name="back" />
      </button>
      <span className="pm-titles">
        <span className="pm-eyebrow">{eyebrow}</span>
        <b className="display pm-h">{title}</b>
      </span>
      <span className="menu-top__spacer"></span>
      <span className="tag tag--ghost pm-lan__tag">
        <Icon name="wifi" />
        {tag}
      </span>
    </header>
  );
}

/** The paper card on the left: the QR to scan, its step, Copy as text. */
function QrCard({ step, text, label, pending, used = false }: { step: string; text: string; label: string; pending: React.ReactNode; used?: boolean }) {
  return (
    <section className="paper pm-lan__card m-p3" style={rise(1)} aria-label={step}>
      <span className="label">{step}</span>
      <span className="pm-lan__qrbox">
        {text ? (
          <UsedQr used={used}>
            <CodeQr text={text} label={label} />
          </UsedQr>
        ) : (
          <QrPending>{pending}</QrPending>
        )}
      </span>
      {text && !used && <CopyCode text={text} className="btn btn--ink btn--block m-p8 pm-lan__copy" />}
    </section>
  );
}

/** P3 · the host adds a player: their code on the left, their reply scanned (or pasted) on the right. */
export function PhoneLanAddPlayer() {
  const ctl = useCtl();
  const { lan, offer, status, error, take, again } = useLanAdd();
  const [scanning, setScanning] = useState(false);
  const scan = canScan();
  const got = useCallback(
    (reply: string) => {
      setScanning(false);
      take(reply);
    },
    [take],
  );

  return (
    <PhoneScreen name="m-lan" label="Add a player" word="WI-FI" dialog states={[status, scanning ? 'scanning' : null]}>
      <div className="pm pm-lanp">
        <Top eyebrow="Local room · no internet" title="Add a player" tag="Same Wi-Fi" />
        {!lan ? (
          <p className="status status--warn">
            <Icon name="warn" />
            Only the room's host can add players this way.
          </p>
        ) : (
          <div className="pm-lan">
            <QrCard step="1 · They scan this" text={offer} label="Connection code for the new player" used={status === 'joined'} pending={status === 'error' ? 'No code' : <Waiting>Making a code…</Waiting>} />
            <section className="card pm-lan__panel m-p3" style={rise(2)} aria-labelledby="pm-lan-2">
              <span className="label">2 · On this phone</span>
              {scanning ? (
                <Viewfinder live prefix={REPLY_PREFIX} onCode={got} className="pm-lan__vf" />
              ) : (
                <>
                  <b id="pm-lan-2" className="display pm-lan__h">
                    {status === 'joined' ? "They're in" : 'Scan their reply'}
                  </b>
                  {status === 'offer' && <p className="pm-lan__sub">On their phone: Join → No internet? → Scan host's QR. Then they show you a reply.</p>}
                </>
              )}
              {status === 'offer' &&
                scan &&
                (scanning ? (
                  <button type="button" className="btn btn--ghost btn--block m-p8 pm-lan__stop" onClick={() => setScanning(false)}>
                    <Icon name="close" />
                    Stop the camera
                  </button>
                ) : (
                  <button type="button" className="btn btn--volt btn--block m-p8 pm-lan__big" disabled={!offer} onClick={() => setScanning(true)}>
                    <Icon name="qr" />
                    Scan their reply
                  </button>
                ))}
              {status === 'offer' && !scan && (
                <p className="pm-lan__note">
                  <Icon name="info" size="sm" />
                  This browser can't read QR codes: paste their reply.
                </p>
              )}
              {status === 'offer' && !scanning && <PasteRow want={REPLY_PREFIX} placeholder="…or paste their reply" action="Let in" onCode={got} busy={!offer} compact />}
              {status === 'connecting' && (
                <div className="pm-lan__result">
                  <Waiting>Connecting over the Wi-Fi…</Waiting>
                </div>
              )}
              {status === 'joined' && (
                <div className="pm-lan__result">
                  <p className="pm-lan__sub">They're in your room. One code per player: Add another makes a new one.</p>
                  <span className="pm-lan__acts">
                    <button type="button" className="btn btn--volt m-p8 pm-lan__big" onClick={again}>
                      <Icon name="users-plus" />
                      Add another
                    </button>
                    <button type="button" className="btn btn--ghost m-p8 pm-lan__big" onClick={blurAfter(() => ctl.closeOverlay())}>
                      <Icon name="back" />
                      Lobby
                    </button>
                  </span>
                </div>
              )}
              {status === 'error' && (
                <div className="pm-lan__result">
                  <span className="status status--bad" role="alert">
                    <Icon name="bad" />
                    {error}
                  </span>
                  <button type="button" className="btn btn--volt btn--block m-p8 pm-lan__big" onClick={again}>
                    <Icon name="refresh" />
                    Try again
                  </button>
                </div>
              )}
            </section>
          </div>
        )}
      </div>
    </PhoneScreen>
  );
}

/** P4 / P5 · a guest joins: the camera (or the paste row) for the host's code, then the reply to show. */
export function PhoneLanJoin() {
  const { reply, status, error, take, retry } = useLanJoin();
  const scan = canScan();
  // they tapped "Scan host's QR" to get here: the camera opens with the panel (Stop closes it)
  const [camera, setCamera] = useState(scan);
  const at = status === 'connecting' ? 3 : status === 'reply' ? 2 : 1;
  const scanStep = status === 'scan' || status === 'error';
  const got = useCallback((offer: string) => take(offer), [take]);

  return (
    <PhoneScreen name="m-lan" label="Join a local room" word="WI-FI" dialog states={[status, camera ? 'camera' : null]}>
      <div className="pm pm-lanp">
        <Top eyebrow="No internet needed" title="Join a local room" tag="Same Wi-Fi" />
        <div className={`pm-lan${scanStep ? ' pm-lan--vf' : ''}`}>
          {scanStep ? (
            <section className="pm-lan__card pm-lan__card--vf m-p3" style={rise(1)} aria-label="The host's QR">
              {scan ? (
                <Viewfinder live={camera && status === 'scan'} prefix={OFFER_PREFIX} onCode={got} className="pm-lan__vf">
                  {camera && status === 'scan' ? (
                    <span className="mf-vf__hint mf-vf__hint--low">Point at the host's QR</span>
                  ) : (
                    status === 'scan' && (
                      <button type="button" className="btn btn--volt m-p8 pm-lan__big" onClick={() => setCamera(true)}>
                        <Icon name="qr" />
                        Open the camera
                      </button>
                    )
                  )}
                </Viewfinder>
              ) : (
                <span className="mf-vf pm-lan__vf">
                  <span className="mf-vf__in">
                    <span className="mf-vf__hint">
                      <Icon name="qr" size="xl" />
                      This browser can't read QR codes: paste the host's code.
                    </span>
                  </span>
                </span>
              )}
              {scan && camera && status === 'scan' && (
                <button type="button" className="btn btn--ghost btn--icon btn--sm m-p8 pm-lan__close" aria-label="Stop the camera" onClick={() => setCamera(false)}>
                  <Icon name="close" />
                </button>
              )}
            </section>
          ) : (
            <QrCard step="2 · The host scans this" text={reply} label="Your reply code for the host" pending={<Waiting>Making your reply…</Waiting>} />
          )}
          <section className="card pm-lan__panel m-p3" style={rise(2)} aria-labelledby="pm-lan-j">
            <Stepper at={at} />
            {status === 'scan' && (
              <>
                <b id="pm-lan-j" className="display pm-lan__h">
                  Scan the host's QR
                </b>
                <p className="pm-lan__sub">The host taps Add a player by QR in their lobby. Hold your phone so the whole code fits the frame.</p>
                <PasteRow want={OFFER_PREFIX} placeholder="…or paste the host's code" action="Use" onCode={got} busy={false} compact />
              </>
            )}
            {(status === 'reply' || status === 'connecting') && (
              <>
                <span className="status status--ok pm-lan__got">
                  <Icon name="ok" size="sm" />
                  Got the host's code
                </span>
                <b id="pm-lan-j" className="display pm-lan__h">
                  Show the host this
                </b>
                <p className="pm-lan__sub">Turn your screen to the host's camera, brightness up. You're in the moment they scan it.</p>
                <div className="pm-lan__waitbox">{status === 'connecting' ? <Waiting done>Connected: joining the room…</Waiting> : <Waiting>Waiting for the host to scan it…</Waiting>}</div>
              </>
            )}
            {status === 'error' && (
              <div className="pm-lan__result">
                <b id="pm-lan-j" className="display pm-lan__h">
                  That didn't connect
                </b>
                <span className="status status--bad" role="alert">
                  <Icon name="bad" />
                  {error}
                </span>
                <button type="button" className="btn btn--volt btn--block m-p8 pm-lan__big" onClick={retry}>
                  <Icon name="refresh" />
                  Try again
                </button>
              </div>
            )}
          </section>
        </div>
      </div>
    </PhoneScreen>
  );
}
