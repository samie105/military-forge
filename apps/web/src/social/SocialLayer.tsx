/**
 * Everything social that floats over the app (App.tsx mounts it once, after the overlays): the
 * friends panel, the invite picker and the invite toast. It also opens the push channel while a
 * signed-in, online player is here. Nothing renders without one.
 */
import { useContext, useEffect } from 'react';
import { ControllerContext, type useCtl } from '../shell/context';
import { FriendsPanel } from './FriendsPanel';
import { InviteFriendsBlock, InvitePicker, InviteToast } from './Invites';
import { useSocial } from './Squad';
import { socialOf } from './social';
import { VoiceHud } from '../voice/VoiceHud';
import './social.css';
import '../voice/voice.css';

export function SocialLayer() {
  const social = useSocial();
  const ctl = useContext(ControllerContext);
  useEffect(() => {
    if (!social) return undefined;
    social.connect();
    void social.loadInvites();
    void social.loadParty();
    return () => social.disconnect();
  }, [social]);
  return (
    <>
      {/* voice chat works in any online room, local rooms with no account too */}
      {ctl?.store && <VoiceHud shell={ctl.store} />}
      {social && (
        <>
          <FriendsPanel social={social} />
          <InvitePicker social={social} />
          <InviteToast social={social} />
        </>
      )}
    </>
  );
}

/**
 * The pause menu's "Invite friends": the invite picker where friends work (it has the link and the
 * share sheet too), else `fallback` (the room link's share sheet).
 */
export function inviteFriends(ctl: ReturnType<typeof useCtl>, fallback: () => void): void {
  const p = ctl.store.getState().profile;
  if (p && !p.offline && ctl.store.getState().screen.name === 'room') socialOf(ctl).openPicker();
  else fallback();
}

/** The lobby's Invite friends block (desktop poster, phone share card); nothing without friends. */
export function LobbyInvite({ phone = false }: { phone?: boolean }) {
  const social = useSocial();
  const ctl = useContext(ControllerContext);
  if (!social || !ctl) return null;
  return <InviteFriendsBlock social={social} phone={phone} />;
}

export { FriendsButton, PhoneSquad, SquadCard } from './Squad';
