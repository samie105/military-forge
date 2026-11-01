/**
 * Settings → Privacy's "Let players find me by name" (31 Oct, with the friends panel's name search):
 * on by default; off keeps you out of name search (apps/api friends/service.ts search). Your exact
 * name and friend code still add you, and people you played with still see you under Played with
 * recently. Shown only where friends work (a signed-in, online player); the row's markup is
 * PrivacySettings' own (`phone` picks the phone's).
 *
 * "Who can send me friend requests" (audit-2 L-09) sits under it: anyone (the default), people you
 * played with in the last 30 days, or only people you give your friend code to (a code always works:
 * it's handed out on purpose). You can still send requests yourself whatever you pick.
 */
import { useEffect } from 'react';
import { Switch } from '../ui/Screen';
import { useSocial } from './Squad';
import type { RequestsFrom } from './api';
import { useSel, type SocialController } from './social';

export const FIND_ME_LABEL = 'Let players find me by name';
export const FIND_ME_DESC = 'Players can find you by typing the start of your name in Friends. Off, they need your exact name or your friend code.';
export const REQUESTS_FROM_LABEL = 'Who can send you friend requests';
export const REQUESTS_FROM_DESC = 'Your friend code always works. You can still send requests yourself.';
export const REQUESTS_FROM_OPTIONS: readonly (readonly [RequestsFrom, string, string])[] = [
  ['anyone', 'Anyone', 'Anyone'],
  ['played', "People you've played with", 'Played with'],
  ['code', 'Only with your code', 'Code only'],
];

export function FindMeSetting({ phone = false }: { phone?: boolean }) {
  const social = useSocial();
  if (!social) return null;
  return <FindMeRow social={social} phone={phone} />;
}

function FindMeRow({ social, phone }: { social: SocialController; phone: boolean }) {
  const list = useSel(social.store, (s) => s.list);
  useEffect(() => {
    if (!social.store.getState().list) void social.refresh();
  }, [social]);
  const on = list?.findable ?? true;
  const from = list?.requestsFrom ?? 'anyone';
  const control = <Switch on={on} onChange={(v) => void social.setFindable(v)} label={FIND_ME_LABEL} />;
  const who = (
    <div className={`seg${phone ? ' pm-seg' : ''}`} role="radiogroup" aria-label={REQUESTS_FROM_LABEL}>
      {REQUESTS_FROM_OPTIONS.map(([id, text, short]) => (
        <button type="button" key={id} className="seg__opt" role="radio" aria-checked={from === id} onClick={() => void social.setRequestsFrom(id)}>
          {phone ? short : text}
        </button>
      ))}
    </div>
  );
  return phone ? (
    <>
      <div className="pm-set">
        <div className="pm-set__text">
          <b>{FIND_ME_LABEL}</b>
          <span>{FIND_ME_DESC}</span>
        </div>
        <div className="pm-set__ctl">{control}</div>
      </div>
      <div className="pm-set">
        <div className="pm-set__text">
          <b>{REQUESTS_FROM_LABEL}</b>
          <span>{REQUESTS_FROM_DESC}</span>
        </div>
        <div className="pm-set__ctl">{who}</div>
      </div>
    </>
  ) : (
    <>
      <div className="srow">
        <div className="srow__txt">
          <b>{FIND_ME_LABEL}</b>
          <span>{FIND_ME_DESC}</span>
        </div>
        <div className="srow__ctrl">{control}</div>
      </div>
      <div className="srow">
        <div className="srow__txt">
          <b>{REQUESTS_FROM_LABEL}</b>
          <span>{REQUESTS_FROM_DESC}</span>
        </div>
        <div className="srow__ctrl">{who}</div>
      </div>
    </>
  );
}
