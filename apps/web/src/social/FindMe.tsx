/**
 * Settings → Privacy's "Let players find me by name" (31 Oct, with the friends panel's name search):
 * on by default; off keeps you out of name search (apps/api friends/service.ts search). Your exact
 * name and friend code still add you, and people you played with still see you under Played with
 * recently. Shown only where friends work (a signed-in, online player); the row's markup is
 * PrivacySettings' own (`phone` picks the phone's).
 */
import { useEffect } from 'react';
import { Switch } from '../ui/Screen';
import { useSocial } from './Squad';
import { useSel, type SocialController } from './social';

export const FIND_ME_LABEL = 'Let players find me by name';
export const FIND_ME_DESC = 'Players can find you by typing the start of your name in Friends. Off, they need your exact name or your friend code.';

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
  const control = <Switch on={on} onChange={(v) => void social.setFindable(v)} label={FIND_ME_LABEL} />;
  return phone ? (
    <div className="pm-set">
      <div className="pm-set__text">
        <b>{FIND_ME_LABEL}</b>
        <span>{FIND_ME_DESC}</span>
      </div>
      <div className="pm-set__ctl">{control}</div>
    </div>
  ) : (
    <div className="srow">
      <div className="srow__txt">
        <b>{FIND_ME_LABEL}</b>
        <span>{FIND_ME_DESC}</span>
      </div>
      <div className="srow__ctrl">{control}</div>
    </div>
  );
}
