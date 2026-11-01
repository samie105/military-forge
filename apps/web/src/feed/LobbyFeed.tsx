/**
 * The Lobby on Home: its top-bar button (with the unread dot) and its panel, a Frost-glass drawer from
 * the right on desktop and a sheet on phones, made of the friends panel's pieces (social.css) plus
 * feed.css. In the panel, top to bottom: Fight night (pinned, with its countdown and Remind me), the
 * lines (cards with their one-tap replies and Join, players' quick chat with Report, Mute and Block),
 * the quiet line when nobody has spoken for an hour, then Quick chat. The quick chat sheet holds the
 * phrases and emotes. Free text has no box unless the API says it's on and this player may type.
 *
 * Keyboard and controller: everything is a button in reading order; the panel and the sheet are
 * dialogs that trap focus; Escape, a pad's B and the browser's Back close the sheet, then the panel
 * (SocialLayer puts the panel on the back stack as #/lobby). Screen readers hear new lines through
 * the list's polite live region.
 */
import { maps } from '@military-forge/content';
import { GAME_NAME, LANG_LABELS, LOBBY_FEED_TTL_MS, QUICK_CHAT, TAG_LABELS, quickChat, type LobbyChat, type LobbyEntry, type QuickChatId } from '@military-forge/shared';
import { useContext, useEffect, useRef, useState, useSyncExternalStore, type FormEvent, type ReactNode } from 'react';
import { ControllerContext } from '../shell/context';
import { usePhoneLayout } from '../shell/screens/phone/layout';
import { Icon } from '../ui/Icon';
import { useFocusTrap } from '../ui/focusTrap';
import { Avatar } from '../social/FriendsPanel';
import { foldName, socialAllowed, type SocialController } from '../social/social';
import { agoText, cardReplies, feedOf, phraseText, quietLine, spanText, useFeedSel, type FeedController } from './feed';
import './feed.css';

const never = () => () => {};

/** The shell's FeedController while the Lobby makes sense (a signed-in, online, adult player), else null. */
export function useFeed(): FeedController | null {
  const ctl = useContext(ControllerContext);
  const feed = ctl && ctl.store && typeof ctl.api?.authed === 'function' && typeof ctl.api?.onSignIn === 'function' ? feedOf(ctl) : null;
  // signed in, online and 18+ (an under-18 device sees nothing of the Lobby)
  const isOn = () => socialAllowed(feed?.shell.store.getState().profile ?? null);
  const on = useSyncExternalStore(feed ? feed.shell.store.subscribe : never, isOn, isOn);
  return on ? feed : null;
}

/** The top bar's Lobby button: opens the panel; a dot when something new came in. */
export function LobbyButton({ phone = false }: { phone?: boolean }) {
  const feed = useFeed();
  if (!feed) return null;
  return <LobbyButtonBody feed={feed} phone={phone} />;
}

function LobbyButtonBody({ feed, phone }: { feed: FeedController; phone: boolean }) {
  useEffect(() => feed.watchHead(), [feed]);
  const unread = useFeedSel(feed, (s) => s.unread && !s.hideChat);
  return (
    <button
      type="button"
      className={`btn btn--ghost btn--sm lf-btn m-p8${phone ? ' btn--icon lf-btn--phone' : ''}`}
      aria-label={unread ? 'Lobby, new messages' : 'Lobby: public chat'}
      onClick={() => feed.open()}
    >
      <Icon name="chat" />
      {!phone && <span className="lf-btn__word">Lobby</span>}
      {unread && <span className="lf-dot" aria-hidden="true"></span>}
    </button>
  );
}

/** The panel, when open (SocialLayer mounts it). */
export function LobbyPanel({ feed, social }: { feed: FeedController; social: SocialController }) {
  const open = useFeedSel(feed, (s) => s.open);
  const phone = usePhoneLayout();
  if (!open) return null;
  return <PanelBody feed={feed} social={social} phone={phone} />;
}

/** A map's name ("Street Market"), or its id. */
function mapName(id: string): string {
  return maps[id]?.name ?? id;
}

function PanelBody({ feed, social, phone }: { feed: FeedController; social: SocialController; phone: boolean }) {
  const drawer = useRef<HTMLDivElement>(null);
  const status = useFeedSel(feed, (s) => s.status);
  const error = useFeedSel(feed, (s) => s.error);
  const live = useFeedSel(feed, (s) => s.live);
  const picker = useFeedSel(feed, (s) => s.picker);
  useFocusTrap(drawer, !picker);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== 'Escape' && e.key !== 'Escape') return;
      // the player sheet (Report, Block) over the panel takes its own Esc
      if (social.store.getState().sheet) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (feed.store.getState().picker) feed.closePicker();
      else if (feed.store.getState().actionsFor) feed.toggleActions(null);
      else feed.close();
    };
    window.addEventListener('keydown', onKey, true);
    const opener = document.activeElement as HTMLElement | null;
    drawer.current?.focus({ preventScroll: true });
    return () => {
      window.removeEventListener('keydown', onKey, true);
      if (opener?.isConnected && opener !== document.body && !opener.closest('[inert]')) opener.focus({ preventScroll: true });
    };
  }, [feed, social]);

  return (
    <div className={`mf-fit ${phone ? 'mf-fit--phone ' : ''}mf-fit--modal kit-v2 mf-social`}>
      <section className={`screen screen--game sx-screen lf-screen${phone ? ' screen--phone sx-screen--phone' : ''}`} data-screen="lobby-feed" aria-label="Lobby">
        <button type="button" className="sx-scrim" aria-label="Close the Lobby" tabIndex={-1} onClick={() => feed.close()}></button>
        <div ref={drawer} className="sx-drawer lf-drawer m-p9 m-p9--right" role="dialog" aria-modal="true" aria-labelledby="lf-title" tabIndex={-1}>
          <header className="sx-drawer__head">
            <h2 id="lf-title" className="display sx-drawer__title">
              Lobby
            </h2>
            {status === 'ready' && live && (
              <span className="tag sx-tag sx-tag--ok">
                <span className="sx-live" aria-hidden="true"></span>
                Live
              </span>
            )}
            <span className="menu-top__spacer"></span>
            <button type="button" className="btn btn--ghost btn--icon btn--sm sx-close" aria-label="Close" onClick={() => feed.close()}>
              <Icon name="close" />
            </button>
          </header>
          {!phone && <p className="sx-note lf-sub">Everyone on {GAME_NAME} sees this. Pick a phrase to join in.</p>}

          <FightNight feed={feed} phone={phone} />

          {status === 'loading' && (
            <p className="status status--busy sx-note" role="status">
              Loading the Lobby…
            </p>
          )}
          {(status === 'error' || status === 'offline') && (
            <div className="sx-empty lf-trouble" role="alert">
              {status === 'offline' ? <Icon name="unplug" /> : <Icon name="warn" />}
              <span>
                <b>{error}</b>
                <br />
                {status === 'offline' ? 'The Lobby needs a connection. Training works without one.' : 'Try again in a moment.'}
              </span>
              <button type="button" className="btn btn--paper btn--sm sx-act" onClick={() => void feed.load()}>
                <Icon name="refresh" />
                Try again
              </button>
            </div>
          )}
          {status === 'ready' && <Lines feed={feed} social={social} />}
          {status === 'ready' && <Composer feed={feed} />}
          {status === 'ready' && <Controls feed={feed} />}
        </div>
        {picker && <QuickChatSheet feed={feed} phone={phone} />}
      </section>
    </div>
  );
}

/** Fight night, pinned: 20:00–22:00 WAT daily, with its countdown and a reminder. */
function FightNight({ feed, phone }: { feed: FeedController; phone: boolean }) {
  const fn = useFeedSel(feed, (s) => s.fightNight);
  const remindAt = useFeedSel(feed, (s) => s.remindAt);
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, []);
  if (!fn) return null;
  const now = feed.now();
  const live = now >= fn.startsAt && now < fn.endsAt;
  const when = live ? `On now · ends in ${spanText(fn.endsAt - now)}` : `Starts in ${spanText(fn.startsAt - now)}`;
  const set = remindAt === fn.startsAt;
  return (
    <section className={`lf-fight${live ? ' is-live' : ''}`} aria-label="Fight night">
      <span className="lf-fight__mark" aria-hidden="true">
        <Icon name="flame" />
      </span>
      <span className="lf-fight__text">
        <b className="display lf-fight__title">Fight night</b>
        <span className="lf-fight__line">
          Every day 20:00–22:00 WAT · <span className="num">{when}</span>
        </span>
      </span>
      {live ? (
        <span className="lf-fight__acts">
          {cardReplies('fight_night').map((id) => (
            <ReplyChip key={id} feed={feed} id={id} replyTo={null} />
          ))}
        </span>
      ) : (
        <button type="button" className={`btn btn--sm sx-act ${set ? 'btn--ghost' : 'btn--paper'}`} aria-pressed={set} onClick={() => (set ? feed.cancelReminder() : void feed.remind())}>
          <Icon name={set ? 'check' : 'clock'} />
          {set ? (phone ? 'Set' : 'Reminder set') : 'Remind me'}
        </button>
      )}
    </section>
  );
}

function ReplyChip({ feed, id, replyTo }: { feed: FeedController; id: QuickChatId; replyTo: string | null }) {
  const sending = useFeedSel(feed, (s) => s.sending);
  const muted = useFeedSel(feed, (s) => s.mute !== null);
  if (muted) return null;
  return (
    <button type="button" className="lf-chip m-p8" disabled={sending} onClick={() => void feed.send(id, replyTo)}>
      {phraseText(id)}
    </button>
  );
}

/** The lines, oldest at the top, newest at the bottom (kept in view). */
function Lines({ feed, social }: { feed: FeedController; social: SocialController }) {
  const entries = useFeedSel(feed, (s) => s.entries);
  const hideChat = useFeedSel(feed, (s) => s.hideChat);
  const muted = useFeedSel(feed, (s) => s.muted);
  const lastMatchAt = useFeedSel(feed, (s) => s.lastMatchAt);
  const canPost = useFeedSel(feed, (s) => s.mute === null && !s.hideChat);
  const list = useRef<HTMLOListElement>(null);
  const me = foldName(feed.shell.store.getState().profile?.nickname ?? '');
  const shown = entries.filter((e) => e.kind !== 'chat' || (!hideChat && !muted[e.from.id]));
  const lastId = shown.at(-1)?.id;
  useEffect(() => {
    const el = list.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lastId]);
  const now = feed.now();
  const quiet = quietLine(entries, lastMatchAt, now);
  return (
    <ol ref={list} className="sx-list lf-list" role="log" aria-live="polite" aria-relevant="additions" aria-label="Lobby messages" tabIndex={0}>
      {shown.length === 0 && (
        <li className="sx-empty lf-empty">
          <Icon name="chat" />
          <span>
            <b>Nothing here yet today.</b>
            {canPost ? ' Say hi with Quick chat, or check back at Fight night.' : ' Check back at Fight night.'}
          </span>
        </li>
      )}
      {shown.map((e) => (
        <li key={e.id} className="lf-item m-p3">
          {e.kind === 'chat' ? <Message feed={feed} social={social} entry={e} mine={foldName(e.from.name) === me} entries={entries} now={now} /> : <Card feed={feed} entry={e} now={now} />}
        </li>
      ))}
      {quiet && shown.length > 0 && (
        <li className="lf-quiet" aria-label={quiet}>
          <Icon name="clock" size="sm" />
          {quiet}
        </li>
      )}
    </ol>
  );
}

function Card({ feed, entry, now }: { feed: FeedController; entry: Exclude<LobbyEntry, LobbyChat>; now: number }) {
  let icon = 'info';
  let line: ReactNode = null;
  let sub = '';
  switch (entry.kind) {
    case 'room_posted':
      icon = 'users-plus';
      line = (
        <>
          <b>{entry.hostName}</b> opened a room
          {entry.tag ? ` · ${TAG_LABELS[entry.tag]}` : ''}
        </>
      );
      sub = [
        entry.map ? mapName(entry.map) : null,
        entry.mode === null ? null : entry.mode === 0 ? 'Free-for-all' : `${entry.mode} teams`,
        `${entry.people} ${entry.people === 1 ? 'player' : 'players'}${entry.bots ? `, ${entry.bots} ${entry.bots === 1 ? 'bot' : 'bots'}` : ''}`,
        entry.seats > 0 ? `${entry.seats} ${entry.seats === 1 ? 'seat' : 'seats'} free` : 'Full',
        entry.lang ? LANG_LABELS[entry.lang] : null,
        `room ${entry.code}`,
      ]
        .filter(Boolean)
        .join(' · ');
      break;
    case 'match_result':
      icon = 'trophy';
      line = entry.winnerName ? (
        <>
          <b>{entry.winnerName}</b> won on {mapName(entry.map)}
        </>
      ) : (
        <>A bot took {mapName(entry.map)}</>
      );
      sub = `${entry.people} ${entry.people === 1 ? 'player' : 'players'}${entry.bots ? `, ${entry.bots} ${entry.bots === 1 ? 'bot' : 'bots'}` : ''}`;
      break;
    case 'welcome':
      icon = 'sparkle';
      line = (
        <>
          <b>{entry.name}</b> joined · say welcome
        </>
      );
      sub = 'First match done';
      break;
    case 'level_up':
      icon = 'rank';
      line = (
        <>
          <b>{entry.name}</b> reached level {entry.level}
        </>
      );
      break;
  }
  return (
    <article className={`lf-card lf-card--${entry.kind}`}>
      <span className="lf-card__mark" aria-hidden="true">
        <Icon name={icon} />
      </span>
      <span className="lf-card__body">
        <span className="lf-card__line">{line}</span>
        <span className="lf-card__sub">
          {sub ? `${sub} · ` : ''}
          <time dateTime={entry.at}>{agoText(entry.at, now)}</time>
        </span>
        <span className="lf-card__acts">
          {entry.kind === 'room_posted' && entry.seats > 0 && now - Date.parse(entry.at) < LOBBY_FEED_TTL_MS && (
            <button type="button" className="btn btn--volt btn--sm sx-act" onClick={() => feed.join(entry.code)} aria-label={`Join ${entry.hostName}'s room ${entry.code}`}>
              <Icon name="arrow-right" />
              Join
            </button>
          )}
          {cardReplies(entry.kind).map((id) => (
            <ReplyChip key={id} feed={feed} id={id} replyTo={entry.id} />
          ))}
        </span>
      </span>
    </article>
  );
}

function Message({ feed, social, entry, mine, entries, now }: { feed: FeedController; social: SocialController; entry: LobbyChat; mine: boolean; entries: readonly LobbyEntry[]; now: number }) {
  const open = useFeedSel(feed, (s) => s.actionsFor === entry.id);
  const emote = entry.quick ? QUICK_CHAT.find((p) => p.id === entry.quick && 'emote' in p) : undefined;
  const to = entry.replyTo ? entries.find((e) => e.id === entry.replyTo) : undefined;
  const toText = to ? (to.kind === 'chat' ? `${to.from.name}: ${to.text}` : replyLabel(to)) : null;
  const target = { name: entry.from.name, id: entry.from.id, place: 'chat' as const, messageId: entry.id };
  return (
    <article className={`lf-msg${mine ? ' lf-msg--mine' : ''}`} aria-label={`${entry.from.name}${mine ? ' (you)' : ''}: ${emote && 'label' in emote ? emote.label : entry.text}`}>
      <Avatar name={entry.from.name} />
      <span className="lf-msg__body">
        <span className="lf-msg__head">
          <b className="lf-msg__who">{mine ? 'You' : entry.from.name}</b>
          <time className="lf-msg__time" dateTime={entry.at}>
            {agoText(entry.at, now)}
          </time>
        </span>
        {toText && (
          <span className="lf-msg__to">
            <Icon name="back" size="sm" />
            {toText}
          </span>
        )}
        <span className={`lf-msg__text${emote ? ' lf-msg__text--emote' : ''}`} aria-hidden="true">
          {entry.text}
        </span>
        {open && !mine && (
          <span className="lf-msg__acts" role="group" aria-label={`${entry.from.name}: report, mute or block`}>
            <button type="button" className="btn btn--ink btn--sm sx-act" onClick={() => social.openReport(target)}>
              <Icon name="sx-flag" />
              Report
            </button>
            <button type="button" className="btn btn--ink btn--sm sx-act" onClick={() => feed.mute(entry.from.id, entry.from.name)}>
              <Icon name="sx-vol-x" />
              Mute in Lobby
            </button>
            {!social.isBlocked(target) && (
              <button type="button" className="btn btn--ink btn--sm sx-act" onClick={() => social.openPlayer(target, 'block')}>
                <Icon name="sx-ban" />
                Block
              </button>
            )}
          </span>
        )}
      </span>
      {!mine && (
        <span className="lf-msg__side">
          <button type="button" className="btn btn--ghost btn--icon btn--sm sx-act" aria-expanded={open} aria-label={`Report, mute or block ${entry.from.name}`} onClick={() => feed.toggleActions(entry.id)}>
            <Icon name="sx-dots" />
          </button>
          <ReplyChip feed={feed} id="e_thumbs" replyTo={entry.id} />
        </span>
      )}
    </article>
  );
}

function replyLabel(e: Exclude<LobbyEntry, LobbyChat>): string {
  switch (e.kind) {
    case 'room_posted':
      return `${e.hostName}'s room`;
    case 'match_result':
      return e.winnerName ? `${e.winnerName}'s win` : 'the match';
    case 'welcome':
      return `${e.name} joining`;
    case 'level_up':
      return `${e.name}, level ${e.level}`;
  }
}

/** Saying something: Quick chat (and a few one-tap phrases), the mute notice, free text only when on. */
function Composer({ feed }: { feed: FeedController }) {
  const mute = useFeedSel(feed, (s) => s.mute);
  const notice = useFeedSel(feed, (s) => s.notice);
  const hideChat = useFeedSel(feed, (s) => s.hideChat);
  const freeText = useFeedSel(feed, (s) => s.freeText);
  if (hideChat) return null;
  if (mute) {
    const until = Date.parse(mute.until);
    return (
      <div className="lf-muted" role="status">
        <Icon name="sx-ban" />
        <span>
          <b>You can’t post in the Lobby for {spanText(until - feed.now())}.</b>
          <br />
          Reason: {mute.reason}. You can still read it and play.
        </span>
      </div>
    );
  }
  return (
    <div className="lf-compose">
      <div className="lf-compose__row">
        <button type="button" className="btn btn--volt sx-act lf-compose__open" data-pad-first onClick={() => feed.openPicker()}>
          <Icon name="chat" />
          Quick chat
        </button>
        <span className="lf-compose__chips">
          {(['how_far', 'whos_on', 'need_one', 'gg'] as const).map((id) => (
            <ReplyChip key={id} feed={feed} id={id} replyTo={null} />
          ))}
        </span>
      </div>
      {freeText.on && <FreeText feed={feed} />}
      {notice && (
        <p className="sx-note sx-tone--warn lf-notice" role="alert">
          {notice}
        </p>
      )}
    </div>
  );
}

/** Free text (only with CHAT_FREE_TEXT on): the rules once, then a 200-character line. */
function FreeText({ feed }: { feed: FeedController }) {
  const gate = useFeedSel(feed, (s) => s.freeText);
  const sending = useFeedSel(feed, (s) => s.sending);
  const [text, setText] = useState('');
  if (gate.needs.includes('rules')) {
    return (
      <div className="lf-rules">
        <p className="sx-note">Typing in the Lobby: be kind, no links, no phone numbers, nothing for under-18s. Breaking these gets you muted.</p>
        <button type="button" className="btn btn--paper btn--sm sx-act" onClick={() => void feed.acceptRules()}>
          I agree
        </button>
      </div>
    );
  }
  if (!gate.allowed) return <p className="sx-note">Typing opens after a day and 3 online matches, or once you save your account.</p>;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!text.trim()) return;
    void feed.sendText(text).then((ok) => ok && setText(''));
  };
  return (
    <form className="lf-type" onSubmit={submit}>
      <input id="lf-type" aria-label="Message" className="lf-type__input" value={text} maxLength={200} onChange={(e) => setText(e.target.value)} placeholder="Say something (200 characters)" autoComplete="off" />
      <button type="submit" className="btn btn--volt btn--icon sx-act" disabled={sending || !text.trim()} aria-label="Send">
        <Icon name="send" />
      </button>
    </form>
  );
}

/** Your own controls: hide the chat, the players you muted here. */
function Controls({ feed }: { feed: FeedController }) {
  const hideChat = useFeedSel(feed, (s) => s.hideChat);
  const muted = useFeedSel(feed, (s) => s.muted);
  const [showMuted, setShowMuted] = useState(false);
  const ids = Object.keys(muted);
  return (
    <div className="lf-controls">
      <button type="button" className="btn btn--ghost btn--sm sx-act" aria-pressed={hideChat} onClick={() => feed.setHideChat(!hideChat)}>
        <Icon name={hideChat ? 'eye' : 'sx-vol-x'} />
        {hideChat ? 'Show public chat' : 'Hide public chat'}
      </button>
      {ids.length > 0 && (
        <button type="button" className="btn btn--ghost btn--sm sx-act" aria-expanded={showMuted} onClick={() => setShowMuted(!showMuted)}>
          Muted here · {ids.length}
        </button>
      )}
      {showMuted && ids.length > 0 && (
        <ul className="lf-mutelist">
          {ids.map((id) => (
            <li key={id}>
              <span>{muted[id]}</span>
              <button type="button" className="btn btn--ghost btn--sm sx-act" onClick={() => feed.unmute(id)}>
                Unmute
              </button>
            </li>
          ))}
        </ul>
      )}
      {hideChat && <p className="sx-note lf-hidden-note">Public chat is hidden on this device. Cards and Fight night still show.</p>}
    </div>
  );
}

/** The quick chat sheet: the emotes, then the phrases. */
function QuickChatSheet({ feed, phone }: { feed: FeedController; phone: boolean }) {
  const card = useRef<HTMLDivElement>(null);
  const picker = useFeedSel(feed, (s) => s.picker);
  const sending = useFeedSel(feed, (s) => s.sending);
  const notice = useFeedSel(feed, (s) => s.notice);
  const entries = useFeedSel(feed, (s) => s.entries);
  useFocusTrap(card, true);
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    card.current?.querySelector<HTMLButtonElement>('.lf-phrases .lf-phrase')?.focus({ preventScroll: true });
    // back to what opened it (a reply chip, Quick chat), else Quick chat
    return () => {
      const back = opener?.isConnected && opener !== document.body ? opener : document.querySelector<HTMLElement>('.lf-compose__open');
      back?.focus({ preventScroll: true });
    };
  }, []);
  const to = picker?.replyTo ? entries.find((e) => e.id === picker.replyTo) : undefined;
  const phrases = QUICK_CHAT.filter((p) => !('emote' in p));
  const emotes = QUICK_CHAT.filter((p) => 'emote' in p);
  return (
    <div className="lf-sheet-wrap">
      <button type="button" className="sx-scrim" aria-label="Close Quick chat" tabIndex={-1} onClick={() => feed.closePicker()}></button>
      <div ref={card} className={`sx-picker lf-sheet m-p1${phone ? ' lf-sheet--phone' : ''}`} role="dialog" aria-modal="true" aria-labelledby="lf-sheet-t" tabIndex={-1}>
        <header className="sx-drawer__head">
          <h3 id="lf-sheet-t" className="display lf-sheet__title">
            Quick chat
          </h3>
          {to && <span className="sx-note lf-sheet__to">Answering {to.kind === 'chat' ? to.from.name : replyLabel(to)}</span>}
          <span className="menu-top__spacer"></span>
          <button type="button" className="btn btn--ghost btn--icon btn--sm sx-close" aria-label="Close" onClick={() => feed.closePicker()}>
            <Icon name="close" />
          </button>
        </header>
        <div className="lf-emotes" role="group" aria-label="Emotes">
          {emotes.map((p) => (
            <button key={p.id} type="button" className="lf-phrase lf-phrase--emote m-p8" disabled={sending} aria-label={quickChat(p.id)?.label ?? p.text} onClick={() => void feed.send(p.id, picker?.replyTo ?? null)}>
              <span aria-hidden="true">{p.text}</span>
            </button>
          ))}
        </div>
        <div className="lf-phrases" role="group" aria-label="Phrases">
          {phrases.map((p) => (
            <button key={p.id} type="button" className="lf-phrase m-p8" disabled={sending} onClick={() => void feed.send(p.id, picker?.replyTo ?? null)}>
              {p.text}
            </button>
          ))}
        </div>
        {notice && (
          <p className="sx-note sx-tone--warn" role="alert">
            {notice}
          </p>
        )}
      </div>
    </div>
  );
}
