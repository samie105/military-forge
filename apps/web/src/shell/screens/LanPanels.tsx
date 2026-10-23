/**
 * Local rooms with no internet (lan/; the owner's request, 20 Oct 2026): the two devices swap
 * connection codes, shown as QR codes or copied as text. The design is the Pen file's "LOCAL ROOMS ·
 * same Wi-Fi" board (docs/design/pen/local-rooms: L2 and L3 here, P3 to P5 in phone/PhoneLan.tsx).
 *
 * - LanAddPlayer (the host, from its lobby): its code for one more player, then that player's
 *   reply, scanned or pasted, and the player is in. Online, players just type the room code instead.
 * - LanJoin (a guest, from Join or Home): scan or paste the host's code, show the reply, wait for
 *   the host to take it, then into the room.
 *
 * The two steps sit side by side: the code to scan on paper (a QR reads best dark on light), the
 * other side's step on Frost glass, one loud action each. The flows live in useLanAdd / useLanJoin
 * so the phone panels share them.
 *
 * Scanning uses the camera through the browser's BarcodeDetector where there is one (Chrome on
 * Android and macOS); everywhere else, the text codes are pasted.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { LanGuest } from '../../lan/host';
import type { Peer } from '../../lan/peer';
import { Icon } from '../../ui/Icon';
import { Cap } from '../../ui/Kbd';
import { Screen } from '../../ui/Screen';
import { useCtl } from '../context';
import { encodeQr, qrSvgPath } from '../qr';
import { Backdrop, Hint, Hints } from './frame';

/** The host's code starts with this; the guest's reply with REPLY_PREFIX (lan/sdp.ts packParts). */
export const OFFER_PREFIX = 'L1.o.';
export const REPLY_PREFIX = 'L1.a.';

interface Detector {
  detect(source: CanvasImageSource): Promise<{ rawValue: string }[]>;
}
type DetectorCtor = new (options: { formats: string[] }) => Detector;

/** The browser's QR reader, if it has one. */
function qrDetector(): Detector | null {
  const Ctor = (globalThis as { BarcodeDetector?: DetectorCtor }).BarcodeDetector;
  try {
    return Ctor ? new Ctor({ formats: ['qr_code'] }) : null;
  } catch {
    return null;
  }
}

export const canScan = (): boolean => typeof (globalThis as { BarcodeDetector?: unknown }).BarcodeDetector === 'function' && !!navigator.mediaDevices?.getUserMedia;

/** The lan module's reasons read as a sentence ("could not reach…" → "Could not reach…."). */
export function sentence(text: string): string {
  const t = text.trim();
  if (!t) return 'Something went wrong.';
  const s = t[0]!.toUpperCase() + t.slice(1);
  return /[.?!…]$/.test(s) ? s : `${s}.`;
}

/**
 * What's wrong with a pasted or scanned code before the lan module sees it: the other kind of code
 * (the commonest slip: the host pasting its own code back), or not a code at all. Null: it looks right.
 */
export function codeProblem(text: string, want: typeof OFFER_PREFIX | typeof REPLY_PREFIX): string | null {
  const t = text.trim();
  if (t.startsWith(want)) return null;
  if (want === REPLY_PREFIX && t.startsWith(OFFER_PREFIX)) return "That's this room's own code. Paste the reply from their device.";
  if (want === OFFER_PREFIX && t.startsWith(REPLY_PREFIX)) return "That's a reply code. Paste the host's code from Add a player by QR.";
  return `That isn't a local room code: it starts with ${want}`;
}

/** A connection code drawn as a QR code (byte mode; ~200 characters is a version 9–10 code). */
export function CodeQr({ text, label, className }: { text: string; label: string; className?: string }) {
  const qr = useMemo(() => qrSvgPath(encodeQr(text), 2), [text]);
  return (
    <span className={['qr mf-lan__qr', className].filter(Boolean).join(' ')} role="img" aria-label={label} data-code={text}>
      <svg viewBox={qr.viewBox} shapeRendering="crispEdges" aria-hidden="true">
        <path fill="var(--c-qr-dark)" d={qr.path} />
      </svg>
    </span>
  );
}

/** A code that has done its job (the player it was for is in): faded under a stamp, so nobody scans it again. */
export function UsedQr({ used, children }: { used: boolean; children: ReactNode }) {
  return (
    <span className={`mf-lan__qrwrap${used ? ' is-used' : ''}`}>
      {children}
      {used && (
        <span className="stamp stamp--ok stamp--lg mf-lan__used m-p7">
          <Icon name="check" />
          Used
        </span>
      )}
    </span>
  );
}

/** Where a QR code will be: the same square, dashed, with what it's waiting for. */
export function QrPending({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={['mf-lan__qr mf-lan__qr--pending', className].filter(Boolean).join(' ')}>{children}</span>;
}

/**
 * The camera's frame: volt corners, and while `live` the camera's picture with a scan line, reading
 * QR codes until one starts with `prefix`. Not live: `children` sit in the frame (a hint, a stamp, a
 * status). The camera only shows here: nothing is recorded or sent.
 */
export function Viewfinder({ live, prefix, onCode, children, className }: { live: boolean; prefix: string; onCode: (text: string) => void; children?: ReactNode; className?: string }) {
  const video = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState('');
  const [rolling, setRolling] = useState(false);
  useEffect(() => {
    if (!live) return undefined;
    setError('');
    setRolling(false);
    const detector = qrDetector();
    let stream: MediaStream | null = null;
    let timer = 0;
    let stopped = false;
    void (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
        if (stopped) return stream.getTracks().forEach((t) => t.stop());
        video.current!.srcObject = stream;
        await video.current!.play();
        setRolling(true);
        const look = async () => {
          if (stopped || !detector || !video.current) return;
          try {
            for (const code of await detector.detect(video.current)) {
              if (code.rawValue.startsWith(prefix)) return onCode(code.rawValue);
            }
          } catch {
            /* the next frame */
          }
          timer = window.setTimeout(() => void look(), 250);
        };
        void look();
      } catch {
        setError("The camera isn't available (or wasn't allowed): paste the code instead.");
      }
    })();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [live, prefix, onCode]);
  return (
    <div className={['mf-vf', live ? 'is-live' : '', rolling ? 'is-rolling' : '', className].filter(Boolean).join(' ')}>
      {live && <video ref={video} className="mf-vf__video" muted playsInline aria-label="Camera" />}
      <span className="mf-vf__corners" aria-hidden="true">
        <i></i>
        <i></i>
        <i></i>
        <i></i>
      </span>
      {live && rolling && <span className="mf-vf__line" aria-hidden="true"></span>}
      {live && error ? (
        <span className="mf-vf__in">
          <span className="status status--warn" role="status">
            <Icon name="warn" />
            {error}
          </span>
        </span>
      ) : (
        children && <span className="mf-vf__in">{children}</span>
      )}
    </div>
  );
}

/**
 * The paste way in: a one-line box for the code, Paste (the clipboard, where the browser allows it)
 * and the action. Enter (a phone keyboard's Go) acts too. A code of the wrong kind says so here and
 * goes no further.
 */
export function PasteRow({ want, placeholder, action, actionIcon = 'check', onCode, busy, compact = false }: { want: typeof OFFER_PREFIX | typeof REPLY_PREFIX; placeholder: string; action: string; actionIcon?: string; onCode: (text: string) => void; busy: boolean; compact?: boolean }) {
  const [text, setText] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const send = (value: string) => {
    const v = value.trim();
    if (!v || busy) return;
    const p = codeProblem(v, want);
    setProblem(p);
    if (!p) onCode(v);
  };
  return (
    <div className={`mf-paste${compact ? ' mf-paste--compact' : ''}`}>
      <div className="mf-paste__row">
        <input
          className="mf-paste__text"
          type="text"
          spellCheck={false}
          autoCapitalize="off"
          autoComplete="off"
          autoCorrect="off"
          enterKeyHint="go"
          aria-label={placeholder}
          aria-invalid={problem ? true : undefined}
          placeholder={placeholder}
          value={text}
          onChange={(e) => {
            setText(e.target.value.trim());
            setProblem(null);
          }}
          onKeyDown={(e) => {
            if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
            // the box is gone once the code is taken: keep this Enter from Home's (Create room) too
            e.preventDefault();
            e.stopPropagation();
            send(text);
          }}
        />
        <button
          className={`btn btn--paper m-p8 mf-paste__paste${compact ? ' btn--icon' : ''}`}
          type="button"
          aria-label={compact ? 'Paste' : undefined}
          onClick={() =>
            void navigator.clipboard
              ?.readText()
              .then((t) => {
                const v = t.trim();
                setText(v);
                // the right kind of code pasted: that's the tap that sends it
                if (v.startsWith(want)) send(v);
                else setProblem(v ? codeProblem(v, want) : 'The clipboard is empty: copy the code first.');
              })
              .catch(() => setProblem('The browser kept the clipboard to itself: long-press the box and paste.'))
          }
        >
          <Icon name="paste" />
          {!compact && 'Paste'}
        </button>
        <button className="btn btn--volt m-p8 mf-paste__go" type="button" disabled={!text || busy} onClick={() => send(text)}>
          <Icon name={actionIcon} />
          {action}
        </button>
      </div>
      {problem && (
        <span className="status status--bad mf-paste__problem" role="alert">
          <Icon name="bad" />
          {problem}
        </span>
      )}
    </div>
  );
}

export function CopyCode({ text, className = 'btn btn--ink m-p8' }: { text: string; className?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      className={className}
      type="button"
      onClick={() =>
        void navigator.clipboard?.writeText(text).then(
          () => {
            setDone(true);
            window.setTimeout(() => setDone(false), 1600);
          },
          () => window.prompt('Copy this code:', text),
        )
      }
    >
      <Icon name={done ? 'check' : 'copy'} />
      {done ? (
        'Copied ✓'
      ) : (
        <span>
          Copy<span className="mf-copy__more"> as text</span>
        </span>
      )}
    </button>
  );
}

/** "Waiting for the host to scan it…": the spinner (still under Reduce motion: a dot) and the words. */
export function Waiting({ children, done = false }: { children: ReactNode; done?: boolean }) {
  return (
    <span className={`mf-wait${done ? ' is-done' : ''}`} role="status">
      {done ? <Icon name="ok" /> : <span className="spinner" aria-hidden="true"></span>}
      <span>{children}</span>
    </span>
  );
}

/** The guest's three steps (P4/P5): where they are, what's done. */
export function Stepper({ at }: { at: 1 | 2 | 3 }) {
  const steps = ['Scan', 'Reply', 'In'];
  return (
    <ol className="mf-steps" aria-label={`Step ${at} of 3`}>
      {steps.map((s, i) => (
        <li key={s} className={i + 1 === at ? 'is-on' : i + 1 < at ? 'is-done' : ''} aria-current={i + 1 === at ? 'step' : undefined}>
          {i + 1 < at ? <Icon name="check" size="sm" /> : <span className="num">{i + 1}</span>}
          {s}
        </li>
      ))}
    </ol>
  );
}

export type AddStatus = 'offer' | 'connecting' | 'joined' | 'error';

/** The host's side: a fresh code for one more player, and that player's reply taken in. */
export function useLanAdd() {
  const ctl = useCtl();
  const lan = ctl.host.lan ?? null;
  const [guest, setGuest] = useState<LanGuest | null>(null);
  const [status, setStatus] = useState<AddStatus>('offer');
  const [error, setError] = useState('');
  const [round, setRound] = useState(0);

  useEffect(() => {
    if (!lan) return undefined;
    let live = true;
    setStatus('offer');
    setGuest(null);
    setError('');
    void lan.newOffer().then((g) => {
      if (!live) return;
      setGuest(g);
      if (!g.offer) {
        setStatus('error');
        setError(sentence(g.error || 'could not make a code'));
      }
    });
    return () => {
      live = false;
    };
  }, [lan, round]);

  const take = useCallback(
    (reply: string) => {
      if (!guest || !lan) return;
      setStatus('connecting');
      lan.acceptAnswer(guest.id, reply).then(
        () => setStatus('joined'),
        (e: Error) => {
          setStatus('error');
          setError(sentence(e.message));
        },
      );
    },
    [guest, lan],
  );

  return { lan, offer: guest?.offer ?? '', status, error, take, again: () => setRound((r) => r + 1) };
}

export type JoinStatus = 'scan' | 'reply' | 'connecting' | 'error';

/** The guest's side: the host's code in, a reply out, then into the room once the host takes it. */
export function useLanJoin() {
  const ctl = useCtl();
  const [reply, setReply] = useState('');
  const [status, setStatus] = useState<JoinStatus>('scan');
  const [error, setError] = useState('');
  const peer = useRef<Peer | null>(null);
  const joined = useRef(false);
  const attempt = useRef(0);

  const drop = () => {
    if (peer.current && !joined.current) peer.current.pc.close();
    peer.current = null;
  };
  // left without joining: drop the half-made connection
  useEffect(() => drop, []);

  const take = useCallback(
    (offer: string) => {
      const mine = ++attempt.current;
      setStatus('reply');
      setError('');
      void import('../../lan/guest').then(async ({ answerFor }) => {
        try {
          const made = await answerFor(offer);
          if (mine !== attempt.current) return made.peer.pc.close();
          peer.current = made.peer;
          setReply(made.reply);
          const { channelsOpen } = await import('../../lan/peer');
          await channelsOpen(made.peer, 180_000);
          if (mine !== attempt.current) return;
          setStatus('connecting');
          joined.current = true;
          ctl.joinLocal('', made.peer);
        } catch (e) {
          if (mine !== attempt.current) return;
          setStatus('error');
          setError(sentence((e as Error).message));
        }
      });
    },
    [ctl],
  );

  const retry = () => {
    attempt.current++;
    drop();
    setReply('');
    setError('');
    setStatus('scan');
  };

  return { reply, status, error, take, retry };
}

function Frame({ title, eyebrow, name, children, note }: { title: string; eyebrow: string; name: string; children: ReactNode; note: string }) {
  const ctl = useCtl();
  return (
    <Screen name={name} kind="menu" label={title}>
      <Backdrop word="WI-FI" />
      <div className="menu">
        <header className="menu-top">
          <button className="btn btn--ghost btn--icon btn--sm m-p8" type="button" aria-label="Back" onClick={() => ctl.closeOverlay()}>
            <Icon name="back" />
          </button>
          <span className="eyebrow mf-lan__eyebrow">{eyebrow}</span>
          <span className="menu-top__spacer"></span>
          <span className="tag tag--ghost mf-lan__wifi">
            <Icon name="wifi" />
            Same Wi-Fi only
          </span>
        </header>
        <div className="menu-body mf-lan">
          <h1 className="display display--print mf-lan__title m-p1">{title}</h1>
          {children}
          <p className="join__note mf-lan__foot">
            <Icon name="info" />
            {note}
          </p>
        </div>
        <Hints>
          <Hint keys={<Cap>Esc</Cap>}>Back</Hint>
        </Hints>
      </div>
    </Screen>
  );
}

/** The arrow between the two steps. */
function Then() {
  return (
    <span className="mf-lan__then" aria-hidden="true">
      <Icon name="arrow-right" />
      <span className="label">Then</span>
    </span>
  );
}

/** The host: one more player, by codes (no internet needed). L2 on the Pen board. */
export function LanAddPlayer() {
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

  if (!lan)
    return (
      <Frame name="lan" title="Add a player" eyebrow="Local room" note="Both devices on the same Wi-Fi or phone hotspot.">
        <p className="status status--warn">
          <Icon name="warn" />
          Only the room's host can add players this way.
        </p>
      </Frame>
    );

  return (
    <Frame name="lan" title="Add a player" eyebrow="Local room · no internet needed" note="Both devices on the same Wi-Fi or phone hotspot. With internet, friends just type the room code.">
      <div className="mf-lan__steps" data-status={status}>
        <section className="ticket mf-lan__step mf-lan__step--paper m-p3" aria-labelledby="lan-add-1">
          <span className="label">1 · On their device</span>
          <h2 id="lan-add-1" className="display mf-lan__h">
            They scan this
          </h2>
          {offer ? (
            <UsedQr used={status === 'joined'}>
              <CodeQr text={offer} label="Connection code for the new player" />
            </UsedQr>
          ) : (
            <QrPending>{status === 'error' ? 'No code' : <Waiting>Making a code…</Waiting>}</QrPending>
          )}
          <p className="mf-lan__sub">{status === 'joined' ? 'This code is used up: Add another player makes a new one.' : "On their device: Join → No internet? → Scan the host's QR."}</p>
          {offer && status !== 'joined' && <CopyCode text={offer} />}
        </section>
        <Then />
        <section className="card mf-lan__step mf-lan__glass m-p3" aria-labelledby="lan-add-2">
          <span className="label">2 · On this device</span>
          <h2 id="lan-add-2" className="display mf-lan__h">
            Scan their reply
          </h2>
          {status === 'offer' && scan && (
            <>
              <Viewfinder live={scanning} prefix={REPLY_PREFIX} onCode={got}>
                {!scanning && (
                  <span className="mf-vf__hint">
                    <Icon name="qr" size="xl" />
                    Point the camera at their reply
                  </span>
                )}
              </Viewfinder>
              <button className={`btn btn--xl btn--block m-p8 ${scanning ? 'btn--ghost' : 'btn--volt'}`} type="button" disabled={!offer} onClick={() => setScanning(!scanning)}>
                <Icon name={scanning ? 'close' : 'qr'} />
                {scanning ? 'Stop the camera' : 'Scan their reply'}
              </button>
            </>
          )}
          {status === 'offer' && !scan && (
            <p className="mf-lan__noscan">
              <Icon name="info" />
              This browser can't read QR codes. Paste their reply instead: on their device, Copy as text, then send it over.
            </p>
          )}
          {status === 'offer' && (
            <>
              {scan && (
                <span className="mf-lan__or label" aria-hidden="true">
                  or paste their reply
                </span>
              )}
              <PasteRow want={REPLY_PREFIX} placeholder="L1.a… their reply code" action="Let them in" onCode={got} busy={!offer} />
            </>
          )}
          {status === 'connecting' && (
            <div className="mf-lan__result">
              <Waiting>Connecting over the Wi-Fi…</Waiting>
            </div>
          )}
          {status === 'joined' && (
            <div className="mf-lan__result">
              <span className="stamp stamp--ok stamp--lg m-p7">
                <Icon name="check" />
                They're in
              </span>
              <span className="mf-lan__acts">
                <button className="btn btn--volt btn--lg m-p8" type="button" onClick={again}>
                  <Icon name="users-plus" />
                  Add another player
                </button>
                <button className="btn btn--ghost btn--lg m-p8" type="button" onClick={() => ctl.closeOverlay()}>
                  <Icon name="back" />
                  Back to the lobby
                </button>
              </span>
            </div>
          )}
          {status === 'error' && (
            <div className="mf-lan__result">
              <span className="status status--bad" role="alert">
                <Icon name="bad" />
                {error}
              </span>
              <button className="btn btn--volt btn--lg m-p8" type="button" onClick={again}>
                <Icon name="refresh" />
                Try again with a new code
              </button>
            </div>
          )}
        </section>
      </div>
    </Frame>
  );
}

/** A guest with no internet: the host's code in, a reply out, then into the room. L3 on the Pen board. */
export function LanJoin() {
  const { reply, status, error, take, retry } = useLanJoin();
  const [scanning, setScanning] = useState(false);
  const scan = canScan();
  const got = useCallback(
    (offer: string) => {
      setScanning(false);
      take(offer);
    },
    [take],
  );
  const have = status === 'reply' || status === 'connecting';

  return (
    <Frame name="lan" title="Join a local room" eyebrow="No internet? Join by QR" note="Both devices on the same Wi-Fi or phone hotspot, with the game already open.">
      <div className="mf-lan__steps mf-lan__steps--join" data-status={status}>
        <section className="card mf-lan__step mf-lan__glass m-p3" aria-labelledby="lan-join-1">
          <span className="label">1 · The host's code</span>
          <h2 id="lan-join-1" className="display mf-lan__h">
            Scan the host's QR
          </h2>
          <p className="mf-lan__sub">The host opens Add a player by QR in their lobby.</p>
          {scan || have ? (
            <Viewfinder live={scanning && status === 'scan'} prefix={OFFER_PREFIX} onCode={got}>
              {have ? (
                <span className="stamp stamp--volt mf-lan__got m-p7">
                  <Icon name="check" />
                  Got the host's code
                </span>
              ) : (
                !scanning && (
                  <span className="mf-vf__hint">
                    <Icon name="qr" size="xl" />
                    Point the camera at the host's QR
                  </span>
                )
              )}
            </Viewfinder>
          ) : (
            status === 'scan' && (
              <p className="mf-lan__noscan">
                <Icon name="info" />
                This browser can't read QR codes. Paste the host's code instead: Copy as text on their device, then send it over.
              </p>
            )
          )}
          {status === 'scan' && (
            <>
              {scan && (
                <button className={`btn btn--xl btn--block m-p8 ${scanning ? 'btn--ghost' : 'btn--volt'}`} type="button" onClick={() => setScanning(!scanning)}>
                  <Icon name={scanning ? 'close' : 'qr'} />
                  {scanning ? 'Stop the camera' : "Scan the host's QR"}
                </button>
              )}
              {scan && (
                <span className="mf-lan__or label" aria-hidden="true">
                  or paste the host's code
                </span>
              )}
              <PasteRow want={OFFER_PREFIX} placeholder="L1.o… the host's code" action="Use code" onCode={got} busy={false} />
            </>
          )}
          {status === 'error' && (
            <div className="mf-lan__result">
              <span className="status status--bad" role="alert">
                <Icon name="bad" />
                {error}
              </span>
              <button className="btn btn--volt btn--lg m-p8" type="button" onClick={retry}>
                <Icon name="refresh" />
                Try again
              </button>
            </div>
          )}
        </section>
        <Then />
        <section className="ticket mf-lan__step mf-lan__step--paper mf-lan__reply m-p3" aria-labelledby="lan-join-2">
          <span className="label">2 · Your reply</span>
          <h2 id="lan-join-2" className="display mf-lan__h">
            The host scans this
          </h2>
          <div className="mf-lan__replyrow">
            {reply ? <CodeQr text={reply} label="Your reply code for the host" /> : <QrPending>Your reply appears here once you have the host's code</QrPending>}
            <div className="mf-lan__side">
              {status === 'reply' && reply && <Waiting>Waiting for the host to scan it…</Waiting>}
              {status === 'connecting' && <Waiting done>Connected: joining the room…</Waiting>}
              <p className="mf-lan__sub">{reply ? "Turn this screen to the host's camera, brightness up. You're in the moment they scan it." : "Step 1 first: the reply is made from the host's code."}</p>
              {reply && status === 'reply' && <CopyCode text={reply} />}
            </div>
          </div>
        </section>
      </div>
    </Frame>
  );
}
