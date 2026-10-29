/**
 * Settings → Privacy (docs/16-player-metrics.md §6): the play-data switch, what is always kept and
 * why, how long, the privacy note, the Terms and the official links, and Delete my data. The desktop's Settings and the phone's share
 * it (`phone` picks the phone's row style).
 */
import { useState, type ReactNode } from 'react';
import { OFFICIAL_URL, TERMS_URL } from '../shell/pages';
import { Switch } from '../ui/Screen';
import { analyticsOn } from './consent';
import { PRIVACY_URL, useConsent } from './ConsentCard';
import { metrics } from './index';
import './consent.css';

function Row({ phone, label, desc, children }: { phone: boolean; label: string; desc: ReactNode; children?: ReactNode }) {
  return phone ? (
    <div className="pm-set">
      <div className="pm-set__text">
        <b>{label}</b>
        <span>{desc}</span>
      </div>
      {children && <div className="pm-set__ctl">{children}</div>}
    </div>
  ) : (
    <div className="srow">
      <div className="srow__txt">
        <b>{label}</b>
        <span>{desc}</span>
      </div>
      {children && <div className="srow__ctrl">{children}</div>}
    </div>
  );
}

type Deleting = 'idle' | 'confirm' | 'busy' | 'done' | 'failed';

export function PrivacySettings({ phone = false }: { phone?: boolean }) {
  const s = useConsent();
  const m = metrics();
  const on = analyticsOn(s);
  const [del, setDel] = useState<Deleting>('idle');
  const [player, setPlayer] = useState(false);
  const run = async () => {
    if (!m) return;
    setDel('busy');
    try {
      await m.deleteMyData();
      if (player) {
        await m.deletePlayer();
        location.reload(); // a new start: the name screen again
        return;
      }
      setDel('done');
    } catch (e) {
      // the detail is for the console; the player gets a plain line
      console.warn('privacy: delete my data failed', e);
      setDel('failed');
    }
  };
  const body = (
    <>
      {!phone && <h2 className="display set__h">Privacy</h2>}
      <Row
        phone={phone}
        label="Share play data"
        desc={
          <>
            How you play: sessions and how long they last, the screens you reach, the features you use, and your device type (phone or computer, touch, keys or pad). We use it to improve the game and to pick the ads you see on the billboards, which today are all our own. Never your name, your messages or where you are beyond your country.
            {s.browserNo && !s.choice ? ' Your browser asks sites not to track you, so this is off unless you turn it on here.' : ''}
          </>
        }
      >
        <Switch on={on} onChange={(v) => m?.consent.set(v, 'settings')} label="Share play data" />
      </Row>
      <Row phone={phone} label="Always kept: match stats" desc="What happens in an online match: kills, deaths, the guns you used, how long you played and when you left, with your player id. The game needs them to run matches, keep your level and the leaderboards, and balance the weapons." />
      <Row phone={phone} label="Counted without any id" desc="Errors on this device, and which billboard ads were on screen, saved and visited: totals that can’t be tied to you. Off when your browser sends Global Privacy Control." />
      <Row phone={phone} label="How long" desc="Single events: 90 days. Your daily summary (days played, matches, device): 13 months. After that only totals with no player in them." />
      <Row
        phone={phone}
        label="The privacy note"
        desc="What we collect and why, who sees it, how long we keep it and your rights."
      >
        <a className="btn btn--ghost btn--sm" href={PRIVACY_URL} target="_blank" rel="noopener">
          Read it
        </a>
      </Row>
      <Row phone={phone} label="Terms" desc="The rules for playing: 18 and over, what the in-game currency is and isn't, account safety, and what gets an account banned.">
        <a className="btn btn--ghost btn--sm" href={TERMS_URL} target="_blank" rel="noopener">
          Read them
        </a>
      </Row>
      <Row phone={phone} label="Official links" desc="Our only website and accounts. There is no app-store app yet, and we never sell currency on other sites or by DM.">
        <a className="btn btn--ghost btn--sm" href={OFFICIAL_URL} target="_blank" rel="noopener">
          See them
        </a>
      </Row>
      <Row phone={phone} label="About the game" desc="What the game is, what you get, and answers to common questions.">
        <a className="btn btn--ghost btn--sm" href="#about">
          Read it
        </a>
      </Row>
      <Row phone={phone} label="Delete my data" desc="Deletes your play data from our servers and this device's event log, and turns sharing off. Your player and its match stats stay unless you also delete your player.">
        {del === 'idle' || del === 'done' || del === 'failed' ? (
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => setDel('confirm')} disabled={!m}>
            {del === 'done' ? 'Deleted' : 'Delete…'}
          </button>
        ) : null}
      </Row>
      {(del === 'confirm' || del === 'busy') && (
        <div className="mf-privacy__confirm" role="group" aria-label="Delete my data">
          <b>Delete your play data?</b>
          <label>
            <input type="checkbox" checked={player} onChange={(e) => setPlayer(e.target.checked)} />
            <span>Also delete my player: name, level, XP, friends, saved look, match history and account, with any Brass and items. They can't be refunded or brought back, so refund unspent Brass first. You start again as a new player.</span>
          </label>
          <div className="mf-privacy__row">
            <button type="button" className="btn btn--sm" onClick={() => setDel('idle')} disabled={del === 'busy'}>
              Cancel
            </button>
            <button type="button" className="btn btn--danger btn--sm" onClick={() => void run()} disabled={del === 'busy'}>
              {del === 'busy' ? 'Deleting…' : player ? 'Delete everything' : 'Delete my data'}
            </button>
          </div>
        </div>
      )}
      {del === 'done' && <p className="mf-privacy__note" role="status">Done: your play data is deleted (single events within minutes) and sharing is off.</p>}
      {del === 'failed' && (
        <p className="mf-privacy__note is-error" role="alert">
          Couldn’t delete just now. Check your connection and try again.
        </p>
      )}
    </>
  );
  return phone ? (
    body
  ) : (
    <div className="tabpanel mf-tabpanel" role="tabpanel" aria-label="Privacy">
      {body}
    </div>
  );
}
