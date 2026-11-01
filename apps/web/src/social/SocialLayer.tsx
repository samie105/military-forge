/**
 * Everything social that floats over the app (App.tsx mounts it once, after the overlays): the
 * friends panel, the invite picker, the invite toast, the friend request toast and the player sheet
 * (report, block, mute, remove: ReportSheet.tsx) and the Lobby feed's panel (feed/). It also opens the push channel while a signed-in,
 * online, adult player is here. Nothing renders without one (an under-18 device trains only: audit-2
 * L-03), and voice chat mutes everyone the player blocked, in every room (L-10).
 */
import { useContext, useEffect } from 'react';
import { ControllerContext, type useCtl } from '../shell/context';
import { FriendsPanel } from './FriendsPanel';
import { InviteFriendsBlock, InvitePicker, InviteToast } from './Invites';
import { PlayerSheet } from './ReportSheet';
import { RequestToast } from './RequestToast';
import { useSocial } from './Squad';
import { socialAllowed, socialOf } from './social';
import { voiceChat } from '../voice/index';
import { LobbyPanel, useFeed } from '../feed/LobbyFeed';
import { VoiceHud } from '../voice/VoiceHud';
import './social.css';
import '../voice/voice.css';

export function SocialLayer() {
  const social = useSocial();
  const feed = useFeed();
  const ctl = useContext(ControllerContext);
  useEffect(() => {
    if (!social) return undefined;
    social.connect();
    void social.loadInvites();
    void social.loadParty();
    // the blocked list reaches voice chat: never heard in any room, proximity too
    const sync = () => voiceChat.setBlockedNames(social.blockedNameList());
    sync();
    const off = social.store.subscribe((s, was) => {
      if (s.list?.blocked !== was.list?.blocked || s.blockedNames !== was.blockedNames) sync();
    });
    return () => {
      off();
      social.disconnect();
    };
  }, [social]);
  // the Friends panel and the invite picker are layers of the back stack (shell/history.ts, audit N-18):
  // one browser entry each, closed by Back, Escape and a pad's B; #/friends opens the panel on load
  useEffect(() => {
    if (!social || !ctl || typeof ctl.openLayer !== 'function') return undefined;
    const layers = [
      { key: 'friends', hash: '#/friends', open: () => social.store.getState().panel.open, close: () => social.closePanel() },
      { key: 'invite', hash: '', open: () => social.store.getState().picker, close: () => social.closePicker() },
      // the Lobby feed (feed/): its own store
      ...(feed
        ? [
            { key: 'lobby', hash: '#/lobby', open: () => feed.store.getState().open, close: () => feed.close() },
            // its quick chat sheet: Back closes the sheet first
            { key: 'lobby-chat', hash: '', open: () => feed.store.getState().picker !== null, close: () => feed.closePicker() },
          ]
        : []),
    ];
    const was = new Map(layers.map((l) => [l.key, false]));
    const sync = () => {
      for (const l of layers) {
        const open = l.open();
        if (open === was.get(l.key)) continue;
        was.set(l.key, open);
        if (open) ctl.openLayer(l.key, l.hash, l.close);
        else ctl.closedLayer(l.key);
      }
    };
    if (ctl.takeDeepLink('friends')) social.openPanel();
    if (feed && ctl.takeDeepLink('lobby')) feed.open();
    sync();
    const offFeed = feed?.store.subscribe(sync);
    const offSocial = social.store.subscribe(sync);
    return () => {
      offSocial();
      offFeed?.();
    };
  }, [social, feed, ctl]);
  return (
    <>
      {/* voice chat works in any online room, local rooms with no account too */}
      {ctl?.store && <VoiceHud shell={ctl.store} />}
      {social && (
        <>
          <FriendsPanel social={social} />
          {feed && <LobbyPanel feed={feed} social={social} />}
          <InvitePicker social={social} />
          <InviteToast social={social} />
          <RequestToast social={social} />
          <PlayerSheet social={social} />
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
  if (socialAllowed(p) && ctl.store.getState().screen.name === 'room') socialOf(ctl).openPicker();
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
export { LobbyButton } from '../feed/LobbyFeed';
