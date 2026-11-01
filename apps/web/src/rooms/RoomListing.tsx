/**
 * The room's listing in its lobby (the Rooms list, 1 Nov 2026): the host picks who finds it (Private,
 * Friends, Public), a preset tag and a language, and may Post to Lobby (once every 5 minutes; a private
 * room goes public) or share it to WhatsApp. Guests see what the host chose. A Play now room is Open
 * and stays so. Desktop: a block in the share poster; phone: a chip that opens a sheet.
 */
import { LANG_LABELS, ROOM_LANGS, ROOM_TAGS, ROOM_VISIBILITIES, TAG_LABELS, VISIBILITY_HINTS, VISIBILITY_LABELS, type RoomLang, type RoomTag, type RoomVisibility } from '@military-forge/shared';
import { useContext, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from '../ui/Icon';
import { blurAfter } from '../ui/Screen';
import { ControllerContext, useCtl } from '../shell/context';
import { Sheet } from '../shell/screens/phone/parts';
import { ApiError } from '../shell/api';
import { whatsAppLink } from '../shell/controller';
import type { RoomSettings } from './api';
import { roomsApi, roomsErrorText } from './data';
import { clock } from './format';
import './rooms.css';

const VIS_ICON: Record<RoomVisibility, string> = { private: 'lock', friends: 'users-plus', public: 'globe' };

/** The listing's one line: "Public · Chill · English", "Open · Play now room". */
export function listingLine(s: Pick<RoomSettings, 'visibility' | 'tag' | 'lang' | 'quick'>): string {
  return [s.quick ? 'Open · Play now room' : VISIBILITY_LABELS[s.visibility], s.tag ? TAG_LABELS[s.tag] : null, s.lang ? LANG_LABELS[s.lang] : null].filter(Boolean).join(' · ');
}

/** The room's listing, kept in step with the API (a change shows at once and goes back if refused). */
function useListing(code: string) {
  const ctl = useCtl();
  const api = useMemo(() => roomsApi(ctl.api), [ctl.api]);
  const [s, setS] = useState<RoomSettings | null>(null);
  const [failed, setFailed] = useState(false);
  const [posting, setPosting] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    let live = true;
    const load = () =>
      api.settings(code).then(
        (r) => live && (setS(r), setFailed(false)),
        () => live && setFailed(true),
      );
    void load();
    // the host can change (the game hands it on): look again now and then
    const id = window.setInterval(() => void load(), 30_000);
    return () => {
      live = false;
      window.clearInterval(id);
    };
  }, [api, code]);
  const waiting = s?.nextPostAt ? Math.max(0, Math.ceil((Date.parse(s.nextPostAt) - now) / 1000)) : 0;
  useEffect(() => {
    if (!waiting) return undefined;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [waiting]);
  const change = async (c: Partial<Pick<RoomSettings, 'visibility' | 'tag' | 'lang'>>) => {
    if (!s) return;
    const before = s;
    setS({ ...s, ...c });
    try {
      setS(await api.update(code, c));
    } catch (e) {
      setS(before);
      ctl.notify(roomsErrorText(e));
    }
  };
  const post = async () => {
    if (!s || posting) return;
    setPosting(true);
    try {
      const r = await api.post(code);
      setS(r);
      setNow(Date.now());
      ctl.notify(before(s.visibility) ? 'Posted to the Lobby. Your room is public now' : 'Posted to the Lobby');
    } catch (e) {
      if (e instanceof ApiError && e.code === 'rate_limited') ctl.notify('Posted already: once every 5 minutes');
      else ctl.notify(roomsErrorText(e));
    }
    setPosting(false);
  };
  return { s, failed, posting, waiting, change, post };
}

const before = (v: RoomVisibility) => v === 'private';

export function RoomListing({ code, phone = false }: { code: string; phone?: boolean }) {
  // a lobby drawn without a whole shell (screen tests' stand-ins): no listing to ask for
  const ctl = useContext(ControllerContext);
  if (!ctl?.api || typeof ctl.api.authed !== 'function') return null;
  return <Listing code={code} phone={phone} />;
}

function Listing({ code, phone }: { code: string; phone: boolean }) {
  const l = useListing(code);
  const [open, setOpen] = useState(false);
  // the sheet belongs to the screen, not the share card (the card is tilted and clips what's inside it)
  const chip = useRef<HTMLButtonElement>(null);
  const [screen, setScreen] = useState<Element | null>(null);
  useEffect(() => setScreen(chip.current?.closest('.screen') ?? null), [l.s !== null]);
  // still asking, or an API without listings: the lobby shows as it always did
  if (!l.s) return null;
  const s = l.s;
  if (phone)
    return (
      <>
        <button ref={chip} type="button" className="rm-lchip m-p8" onClick={blurAfter(() => setOpen(true))} aria-label={`Room listing: ${listingLine(s)}${s.host ? '. Change' : ''}`}>
          <Icon name={s.quick ? 'globe' : VIS_ICON[s.visibility]} size="sm" />
          <span>
            {s.quick ? 'Open room' : `${VISIBILITY_LABELS[s.visibility]} room`}
            {s.host ? ' · Post or change' : ''}
          </span>
          <Icon name="chev-right" size="sm" />
        </button>
        {screen &&
          createPortal(
            <Sheet open={open} onClose={() => setOpen(false)} label="Room listing">
              <ListingBody l={l} code={code} phone />
            </Sheet>,
            screen,
          )}
      </>
    );
  return (
    <div className="rm-listing" role="group" aria-label="Room listing">
      <ListingBody l={l} code={code} />
    </div>
  );
}

function ListingBody({ l, code, phone = false }: { l: ReturnType<typeof useListing>; code: string; phone?: boolean }) {
  const s = l.s!;
  if (!s.host)
    return (
      <p className="rm-listing__guest">
        <Icon name={s.quick ? 'globe' : VIS_ICON[s.visibility]} size="sm" />
        {listingLine(s)}
      </p>
    );
  return (
    <>
      <div className="rm-listing__row">
        <span className="label">Who finds it</span>
        {s.quick ? (
          <span className="tag tag--ghost">
            <Icon name="globe" />
            Open · Play now room
          </span>
        ) : (
          <div className={phone ? 'seg rm-seg' : 'seg seg--paper rm-seg'} role="radiogroup" aria-label="Who finds this room">
            {ROOM_VISIBILITIES.map((v) => (
              <button key={v} type="button" role="radio" className="seg__opt" aria-checked={s.visibility === v} onClick={blurAfter(() => void l.change({ visibility: v }))}>
                <Icon name={VIS_ICON[v]} />
                {VISIBILITY_LABELS[v]}
              </button>
            ))}
          </div>
        )}
      </div>
      {!s.quick && <p className="rm-listing__hint">{VISIBILITY_HINTS[s.visibility]}</p>}
      <div className="rm-listing__row">
        <span className="label">Tag</span>
        <div className={phone ? 'seg rm-seg rm-seg--wrap' : 'seg seg--paper rm-seg rm-seg--wrap'} role="radiogroup" aria-label="Tag">
          <button type="button" role="radio" className="seg__opt" aria-checked={s.tag === null} onClick={blurAfter(() => void l.change({ tag: null }))}>
            None
          </button>
          {ROOM_TAGS.map((t: RoomTag) => (
            <button key={t} type="button" role="radio" className="seg__opt" aria-checked={s.tag === t} onClick={blurAfter(() => void l.change({ tag: t }))}>
              {TAG_LABELS[t]}
            </button>
          ))}
        </div>
      </div>
      <div className="rm-listing__row">
        <label className="label" htmlFor={`rm-lang-${code}`}>
          Language
        </label>
        <span className={phone ? 'rm-lang' : 'rm-lang rm-lang--paper'}>
          <select id={`rm-lang-${code}`} value={s.lang ?? ''} onChange={(e) => void l.change({ lang: (e.target.value || null) as RoomLang | null })}>
            <option value="">Any language</option>
            {ROOM_LANGS.map((g) => (
              <option key={g} value={g} lang={g}>
                {LANG_LABELS[g]}
              </option>
            ))}
          </select>
        </span>
      </div>
      <div className={`rm-listing__acts${phone ? ' rm-listing__acts--phone' : ''}`}>
        <button type="button" className="btn btn--ink btn--sm m-p8" disabled={l.posting || l.waiting > 0} onClick={blurAfter(() => void l.post())}>
          <Icon name="send" />
          {l.waiting > 0 ? `Posted · again in ${clock(l.waiting)}` : l.posting ? 'Posting…' : 'Post to Lobby'}
        </button>
        {/* the desktop lobby has WhatsApp beside Copy link already */}
        {phone && (
          <a className="btn btn--paper btn--sm m-p8 rm-wa" href={whatsAppLink(code)} target="_blank" rel="noopener noreferrer">
            <Icon name="chat" />
            Share to WhatsApp
          </a>
        )}
      </div>
      {s.visibility === 'private' && !s.quick && <p className="rm-listing__hint">Post to Lobby makes the room public.</p>}
    </>
  );
}
