/**
 * The invite picker's "Looking for a match" part (Online now, 1 Nov 2026): people who turned it on,
 * whom anyone they haven't blocked may invite, under the same limits as a friend's invite. Asked once
 * as the picker opens; nothing shows when nobody is looking (or the API can't say).
 */
import { LFG_MODE_LABELS } from '@military-forge/shared';
import { useEffect, useMemo, useState } from 'react';
import { Avatar } from '../social/FriendsPanel';
import { InviteButton } from '../social/Invites';
import type { SocialController } from '../social/social';
import type { OnlinePlayer } from './api';
import { roomsApi } from './data';

export function LookingInvites({ social, room }: { social: SocialController; room: string }) {
  // the social layer's own session (shell/api.ts authed): the picker draws without a shell controller in tests
  const api = useMemo(() => roomsApi(social.shell.api), [social.shell.api]);
  const [players, setPlayers] = useState<OnlinePlayer[]>([]);
  useEffect(() => {
    let live = true;
    api.looking().then(
      (p) => live && setPlayers(p.filter((x) => !x.friend && x.room !== room)),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [api, room]);
  if (!players.length) return null;
  return (
    <>
      <div className="sx-divider">
        <span className="label label--volt">Looking for a match</span>
        <i aria-hidden="true"></i>
      </div>
      {players.map((p) => (
        <div key={p.id} className="sx-row sx-row--online">
          <Avatar name={p.nickname} look={p.look} status="online" />
          <span className="sx-row__who">
            <b>{p.nickname}</b>
            <span className="sx-row__line sx-tone--ok">
              Level {p.level} · wants {LFG_MODE_LABELS[p.mode ?? 'any']}
            </span>
          </span>
          <InviteButton social={social} friend={{ id: p.id, nickname: p.nickname, status: 'online', room: null, lastSeenAt: null, since: '', look: p.look }} />
        </div>
      ))}
    </>
  );
}
