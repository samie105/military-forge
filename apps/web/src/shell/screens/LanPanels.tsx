/**
 * Local rooms with no internet (lan/; the owner's request, 20 Oct 2026): the two devices swap
 * connection codes, shown as QR codes or copied as text.
 *
 * - LanAddPlayer (the host, from its lobby): its code for one more player, then that player's
 *   reply, scanned or pasted, and the player is in. Online, players just type the room code instead.
 * - LanJoin (a guest, from Join or Home): scan or paste the host's code, show the reply, wait for
 *   the host to take it, then into the room.
 *
 * Scanning uses the camera through the browser's BarcodeDetector where there is one (Chrome on
 * Android and macOS); everywhere else, the text codes are pasted.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { LanGuest } from '../../lan/host';
import type { Peer } from '../../lan/peer';
import { Icon } from '../../ui/Icon';
import { Cap } from '../../ui/Kbd';
import { Screen } from '../../ui/Screen';
import { useCtl } from '../context';
import { encodeQr, qrSvgPath } from '../qr';
import { Backdrop, Hint, Hints } from './frame';

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

/** A connection code drawn as a QR code (byte mode; ~200 characters is a version 9–10 code). */
function CodeQr({ text, label }: { text: string; label: string }) {
  const qr = useMemo(() => qrSvgPath(encodeQr(text), 2), [text]);
  return (
    <span className="qr mf-lan__qr" role="img" aria-label={label} data-code={text}>
      <svg viewBox={qr.viewBox} shapeRendering="crispEdges" aria-hidden="true">
        <path fill="var(--c-qr-dark)" d={qr.path} />
      </svg>
    </span>
  );
}

/** The camera, reading QR codes until one starts with `prefix` (L1.o / L1.a). */
function Scanner({ prefix, onCode, onClose }: { prefix: string; onCode: (text: string) => void; onClose: () => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState('');
  useEffect(() => {
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
        setError("The camera isn't available: paste the code instead.");
      }
    })();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [prefix, onCode]);
  return (
    <div className="card card--print mf-lan__scan">
      {/* the camera's picture only: nothing is recorded or sent */}
      <video ref={video} className="mf-lan__video" muted playsInline aria-label="Camera" />
      {error && (
        <p className="status status--warn">
          <Icon name="warn" />
          {error}
        </p>
      )}
      <button className="btn btn--paper btn--sm m-p8" type="button" onClick={onClose}>
        <Icon name="close" />
        Stop the camera
      </button>
    </div>
  );
}

/** A text box for a pasted code, with Paste and the action. */
function PasteCode({ placeholder, action, onCode, busy }: { placeholder: string; action: string; onCode: (text: string) => void; busy: boolean }) {
  const [text, setText] = useState('');
  return (
    <div className="mf-lan__paste">
      <textarea
        className="mf-lan__text"
        rows={3}
        spellCheck={false}
        autoCapitalize="off"
        autoComplete="off"
        placeholder={placeholder}
        value={text}
        onChange={(e) => setText(e.target.value.trim())}
      />
      <div className="mf-lan__acts">
        <button
          className="btn btn--paper btn--sm m-p8"
          type="button"
          onClick={() =>
            void navigator.clipboard
              ?.readText()
              .then((t) => setText(t.trim()))
              .catch(() => {})
          }
        >
          <Icon name="paste" />
          Paste
        </button>
        <button className="btn btn--volt btn--sm m-p8" type="button" disabled={!text || busy} onClick={() => onCode(text)}>
          <Icon name="check" />
          {action}
        </button>
      </div>
    </div>
  );
}

function CopyCode({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      className="btn btn--paper btn--sm m-p8"
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
      {done ? 'Copied ✓' : 'Copy as text'}
    </button>
  );
}

function Frame({ title, eyebrow, children }: { title: string; eyebrow: string; children: React.ReactNode }) {
  const ctl = useCtl();
  return (
    <Screen name="lan" kind="menu" label={title}>
      <Backdrop word="WI-FI" />
      <div className="menu">
        <header className="menu-top">
          <button className="btn btn--ghost btn--icon btn--sm m-p8" type="button" aria-label="Back" onClick={() => ctl.closeOverlay()}>
            <Icon name="back" />
          </button>
          <span className="label">{eyebrow}</span>
          <span className="menu-top__spacer"></span>
          <span className="tag">
            <Icon name="wifi" />
            Same Wi-Fi only
          </span>
        </header>
        <div className="menu-body mf-lan">
          <h1 className="display display--print mf-lan__title m-p1">{title}</h1>
          {children}
        </div>
        <Hints>
          <Hint keys={<Cap>Esc</Cap>}>Back</Hint>
        </Hints>
      </div>
    </Screen>
  );
}

/** The host: one more player, by codes (no internet needed). */
export function LanAddPlayer() {
  const ctl = useCtl();
  const lan = ctl.host.lan ?? null;
  const [guest, setGuest] = useState<LanGuest | null>(null);
  const [status, setStatus] = useState<'offer' | 'connecting' | 'joined' | 'error'>('offer');
  const [error, setError] = useState('');
  const [scanning, setScanning] = useState(false);
  const [round, setRound] = useState(0);

  useEffect(() => {
    if (!lan) return;
    let live = true;
    setStatus('offer');
    setGuest(null);
    void lan.newOffer().then((g) => {
      if (!live) return;
      setGuest(g);
      if (!g.offer) {
        setStatus('error');
        setError(g.error || 'could not make a code');
      }
    });
    return () => {
      live = false;
    };
  }, [lan, round]);

  if (!lan)
    return (
      <Frame title="Add a player" eyebrow="Local room">
        <p className="status status--warn">
          <Icon name="warn" />
          Only the room's host can add players this way.
        </p>
      </Frame>
    );

  const take = (reply: string) => {
    if (!guest) return;
    setScanning(false);
    setStatus('connecting');
    lan.acceptAnswer(guest.id, reply).then(
      () => setStatus('joined'),
      (e: Error) => {
        setStatus('error');
        setError(e.message);
      },
    );
  };

  return (
    <Frame title="Add a player" eyebrow="Local room · no internet needed">
      <div className="mf-lan__steps">
        <section className="ticket mf-lan__step">
          <span className="label">1 · On their device</span>
          <b className="display">They scan this</b>
          <p className="mf-lan__sub">On their device: Join with code → No internet? Join a local room with the host's QR. Or copy the code to them.</p>
          {guest?.offer ? <CodeQr text={guest.offer} label="Connection code for the new player" /> : <span className="status status--busy">Making a code…</span>}
          {guest?.offer && <CopyCode text={guest.offer} />}
        </section>
        <section className="ticket mf-lan__step">
          <span className="label">2 · On this device</span>
          <b className="display">Scan their reply</b>
          {status === 'offer' && (
            <>
              {scanning ? (
                <Scanner prefix="L1.a." onCode={take} onClose={() => setScanning(false)} />
              ) : (
                canScan() && (
                  <button className="btn btn--volt btn--lg m-p8" type="button" disabled={!guest?.offer} onClick={() => setScanning(true)}>
                    <Icon name="qr" />
                    Scan their reply
                  </button>
                )
              )}
              <PasteCode placeholder="…or paste their reply code (L1.a.…)" action="Let them in" onCode={take} busy={!guest?.offer} />
            </>
          )}
          {status === 'connecting' && (
            <p className="status status--busy" role="status">
              <Icon name="wifi" />
              Connecting over the Wi-Fi…
            </p>
          )}
          {status === 'joined' && (
            <>
              <p className="status status--ok" role="status">
                <Icon name="ok" />
                They're in.
              </p>
              <button className="btn btn--paper btn--sm m-p8" type="button" onClick={() => setRound((r) => r + 1)}>
                <Icon name="users-plus" />
                Add another
              </button>
            </>
          )}
          {status === 'error' && (
            <>
              <p className="status status--bad" role="status">
                <Icon name="bad" />
                {error}
              </p>
              <button className="btn btn--paper btn--sm m-p8" type="button" onClick={() => setRound((r) => r + 1)}>
                <Icon name="refresh" />
                Try again
              </button>
            </>
          )}
        </section>
      </div>
      <p className="join__note">
        <Icon name="info" />
        Both devices must be on the same Wi-Fi or phone hotspot. With internet, players can just type the room code.
      </p>
    </Frame>
  );
}

/** A guest with no internet: the host's code in, a reply out, then into the room. */
export function LanJoin() {
  const ctl = useCtl();
  const [scanning, setScanning] = useState(false);
  const [reply, setReply] = useState('');
  const [status, setStatus] = useState<'scan' | 'reply' | 'connecting' | 'error'>('scan');
  const [error, setError] = useState('');
  const peer = useRef<Peer | null>(null);
  const joined = useRef(false);

  // left without joining: drop the half-made connection
  useEffect(
    () => () => {
      if (peer.current && !joined.current) peer.current.pc.close();
    },
    [],
  );

  const take = (offer: string) => {
    setScanning(false);
    setStatus('reply');
    void import('../../lan/guest').then(async ({ answerFor }) => {
      try {
        const made = await answerFor(offer);
        peer.current = made.peer;
        setReply(made.reply);
        const { channelsOpen } = await import('../../lan/peer');
        await channelsOpen(made.peer, 180_000);
        setStatus('connecting');
        joined.current = true;
        ctl.joinLocal('', made.peer);
      } catch (e) {
        setStatus('error');
        setError((e as Error).message);
      }
    });
  };

  return (
    <Frame title="Join a local room" eyebrow="No internet needed">
      <div className="mf-lan__steps">
        <section className="ticket mf-lan__step">
          <span className="label">1 · The host's code</span>
          <b className="display">Scan the host's QR</b>
          <p className="mf-lan__sub">The host opens Add a player in their lobby.</p>
          {status === 'scan' && (
            <>
              {scanning ? (
                <Scanner prefix="L1.o." onCode={take} onClose={() => setScanning(false)} />
              ) : (
                canScan() && (
                  <button className="btn btn--volt btn--lg m-p8" type="button" onClick={() => setScanning(true)}>
                    <Icon name="qr" />
                    Scan the host's QR
                  </button>
                )
              )}
              <PasteCode placeholder="…or paste the host's code (L1.o.…)" action="Use this code" onCode={take} busy={false} />
            </>
          )}
          {status !== 'scan' && status !== 'error' && (
            <p className="status status--ok">
              <Icon name="ok" />
              Got the host's code.
            </p>
          )}
          {status === 'error' && (
            <>
              <p className="status status--bad" role="status">
                <Icon name="bad" />
                {error}
              </p>
              <button className="btn btn--paper btn--sm m-p8" type="button" onClick={() => setStatus('scan')}>
                <Icon name="refresh" />
                Try again
              </button>
            </>
          )}
        </section>
        <section className="ticket mf-lan__step">
          <span className="label">2 · Your reply</span>
          <b className="display">The host scans this</b>
          {reply ? (
            <>
              <CodeQr text={reply} label="Your reply code for the host" />
              <CopyCode text={reply} />
              <p className="status status--busy" role="status">
                <Icon name="wifi" />
                Waiting for the host to scan it…
              </p>
            </>
          ) : (
            <p className="mf-lan__sub">It appears here once you have the host's code.</p>
          )}
        </section>
      </div>
      <p className="join__note">
        <Icon name="info" />
        Both devices must be on the same Wi-Fi or phone hotspot, with the game already open.
      </p>
    </Frame>
  );
}
