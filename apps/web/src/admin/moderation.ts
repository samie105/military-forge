/**
 * The admin page's Player reports (audit-2 L-04; the API's /admin/moderation, the same token): what
 * players reported about each other from the game's Report sheet, newest first, with who, about whom,
 * when, where and why. A report opens to the account's standing and the owner's actions on it, each
 * with a reason (kept in the moderation log): Rename (a generated name), Suspend 24 hours or 7 days,
 * Ban, Unban, Dismiss, Clear the under-18 mark, Close the account; for the Lobby feed, Mute in the Lobby
 * 24 hours or 7 days (the player sees the reason and the end), Unmute, and Delete a reported message
 * (its words stay in the report's snapshot and the log). Kept apart from Reports (the
 * devices' automatic connection logs). A find box acts on an account nobody reported (an under-18
 * account a parent wrote about).
 */

export interface ModerationTarget {
  id: string;
  /** the name it had when reported */
  name: string;
  /** its name now (null: the account is gone) */
  nickname: string | null;
  standing: 'active' | 'suspended' | 'banned' | 'deleted';
  until: string | null;
  minor: boolean;
  /** its open reports, all reporters */
  open: number;
}

export interface ModerationReport {
  id: number;
  at: string;
  reason: string;
  note: string | null;
  room: string | null;
  place: string | null;
  handledAt: string | null;
  action: string | null;
  reporter: { id: string; nickname: string | null };
  target: ModerationTarget;
  /** a Lobby message (place chat): its id and the copy kept with the report */
  message?: { id: string; snapshot: { text?: string; at?: string } | null } | null;
}

export interface ModerationHistory {
  player: { id: string; nickname: string; standing: string; bannedUntil: string | null; minor: boolean; createdAt: string; lastSeenAt: string; level: number; chatMute?: { until: string; reason: string } | null } | null;
  reports: ModerationReport[];
  reportsBy: number;
  audit: { id: number; at: string; actor: string; action: string; reason: string; detail: Record<string, unknown> }[];
}

export type ModerationAction = 'rename' | 'suspend' | 'ban' | 'unban' | 'dismiss' | 'clear_minor' | 'close' | 'chat_mute' | 'chat_unmute' | 'delete_message';

/** The reasons as the game's sheet words them. */
export const REASON_LABELS: Readonly<Record<string, string>> = {
  name: 'Offensive name',
  voice: 'Abusive voice',
  cheating: 'Cheating',
  spam: 'Spamming (requests, invites or the Lobby)',
  underage: 'Under 18',
  other: 'Something else',
};

/** One /api/admin/moderation call. */
export async function moderationCall<T>(token: string, method: 'GET' | 'POST', path: string, body?: unknown, fetcher: typeof fetch = fetch): Promise<T> {
  const res = await fetcher(`/api/admin/moderation${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    cache: 'no-store',
  });
  const data = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
  if (!res.ok) throw new Error(res.status === 401 ? 'the API does not know this token' : (data?.error?.message ?? `HTTP ${res.status}`));
  return data as T;
}

/** "Suspended until 3 Nov, 14:00" / "Banned" / "Active" / "Closed". */
export function standingText(t: Pick<ModerationTarget, 'standing' | 'until'>): string {
  if (t.standing === 'suspended') return t.until ? `Suspended until ${new Date(t.until).toLocaleString()}` : 'Suspended';
  if (t.standing === 'banned') return 'Banned';
  if (t.standing === 'deleted') return 'Closed';
  return 'Active';
}

/** A report in one line: when, why, about whom, by whom, where. */
export function reportLine(r: ModerationReport): string {
  const where = [r.place, r.room ? `room ${r.room}` : ''].filter(Boolean).join(' · ');
  const renamed = r.target.nickname && r.target.nickname !== r.target.name ? ` (now ${r.target.nickname})` : '';
  const said = r.message?.snapshot?.text ? ` · said “${r.message.snapshot.text}”` : '';
  return `${new Date(r.at).toLocaleString()} · ${REASON_LABELS[r.reason] ?? r.reason} · ${r.target.name}${renamed} · by ${r.reporter.nickname ?? 'a closed account'}${where ? ` · ${where}` : ''}${said}`;
}

type El = <K extends keyof HTMLElementTagNameMap>(tag: K, attrs?: Record<string, string>, ...children: (Node | string)[]) => HTMLElementTagNameMap[K];

/** The Player reports group (a <details>), loaded when opened and on Refresh. */
export function moderationGroup(token: string, el: El): HTMLElement {
  const count = el('span', { class: 'admin__count' });
  const status = el('p', { class: 'admin__note' });
  const list = el('div', { class: 'admin__reports' });
  const refresh = el('button', { type: 'button', class: 'admin__btn' }, 'Refresh');
  const all = el('input', { type: 'checkbox', 'aria-label': 'Show handled reports too' });
  const find = el('input', { type: 'search', class: 'admin__search', placeholder: 'Find a player: id or name', 'aria-label': 'Find a player' });
  const found = el('div', { class: 'admin__store-results' });
  const panel = el('div', { class: 'admin__mod-player' });

  /** One account: its standing, the reports about it, the actions taken, and the buttons. */
  const openPlayer = async (id: string) => {
    panel.replaceChildren(el('p', { class: 'admin__note' }, 'Loading…'));
    try {
      showPlayer(await moderationCall<ModerationHistory>(token, 'GET', `/players/${encodeURIComponent(id)}`), id);
    } catch (e) {
      panel.replaceChildren(el('p', { class: 'admin__note is-error' }, `Couldn't load that account: ${(e as Error).message}`));
    }
  };

  const showPlayer = (h: ModerationHistory, id: string) => {
    const p = h.player;
    const say = el('p', { class: 'admin__note' });
    const reason = el('input', { type: 'text', placeholder: 'Reason (kept in the moderation log)', 'aria-label': 'Reason', maxlength: '200' });
    const act = (action: ModerationAction, label: string, extra: Record<string, unknown> = {}, danger = false) => {
      const b = el('button', { type: 'button', class: danger ? 'admin__btn admin__btn--danger' : 'admin__btn' }, label);
      b.addEventListener('click', () => {
        const why = reason.value.trim();
        if (!why) {
          say.textContent = 'Every action needs a reason.';
          say.className = 'admin__note is-error';
          return;
        }
        if (action === 'close' && !window.confirm(`Close ${p?.nickname ?? 'this account'} for good? Its name, friends and progress are deleted. Its reports and this log stay.`)) return;
        b.setAttribute('disabled', '');
        moderationCall<ModerationHistory>(token, 'POST', `/players/${encodeURIComponent(id)}`, { action, reason: why, ...extra }).then(
          (next) => {
            showPlayer(next, id);
            void load();
          },
          (e: Error) => {
            b.removeAttribute('disabled');
            say.textContent = `Didn't work: ${e.message}`;
            say.className = 'admin__note is-error';
          },
        );
      });
      return b;
    };
    const standing = p ? standingText({ standing: p.standing as ModerationTarget['standing'], until: p.bannedUntil }) : 'Closed';
    const head = el(
      'p',
      {},
      el('b', {}, p?.nickname ?? '(closed account)'),
      ` · ${standing}${p?.minor ? ' · under 18' : ''}${p?.chatMute ? ` · muted in the Lobby until ${new Date(p.chatMute.until).toLocaleString()}` : ''}${p ? ` · level ${p.level} · since ${new Date(p.createdAt).toLocaleDateString()} · last seen ${new Date(p.lastSeenAt).toLocaleString()}` : ''} · ${id}`,
    );
    const buttons = p
      ? el(
          'div',
          { class: 'admin__store-action' },
          reason,
          act('rename', 'Rename'),
          act('suspend', 'Suspend 24 h', { hours: 24 }),
          act('suspend', 'Suspend 7 days', { hours: 168 }),
          ...(p.standing === 'active' ? [act('ban', 'Ban', {}, true)] : [act('unban', 'Unban')]),
          act('dismiss', 'Dismiss reports'),
          ...(p.minor ? [act('clear_minor', 'Clear under 18')] : []),
          ...(p.chatMute ? [act('chat_unmute', 'Unmute in Lobby')] : [act('chat_mute', 'Mute in Lobby 24 h', { hours: 24 }), act('chat_mute', 'Mute in Lobby 7 days', { hours: 168 })]),
          act('close', 'Close account', {}, true),
        )
      : el('p', { class: 'admin__note' }, 'This account was closed. Its reports and the log stay.');
    const reports = h.reports.length
      ? el(
          'ul',
          { class: 'admin__mod-list' },
          ...h.reports.map((r) =>
            el(
              'li',
              {},
              `${reportLine(r)}${r.note ? ` · “${r.note}”` : ''}${r.handledAt ? ` · ${r.action ?? 'handled'}` : ' · open'}`,
              // a Lobby message: delete it for everyone (the report keeps its copy)
              ...(p && r.message ? [' ', act('delete_message', 'Delete message', { message: r.message.id }, true)] : []),
            ),
          ),
        )
      : el('p', { class: 'admin__note' }, 'No reports about this account.');
    const log = h.audit.length
      ? el('ul', { class: 'admin__mod-list' }, ...h.audit.map((a) => el('li', {}, `${new Date(a.at).toLocaleString()} · ${a.action} · ${a.reason}${a.detail.nickname ? ` · now ${String(a.detail.nickname)}` : ''}${a.detail.until ? ` · until ${new Date(String(a.detail.until)).toLocaleString()}` : ''}`)))
      : el('p', { class: 'admin__note' }, 'Nothing done yet.');
    panel.replaceChildren(head, buttons, say, el('h4', {}, `Reports about them · ${h.reports.length}`), reports, el('p', { class: 'admin__note' }, `They reported ${h.reportsBy} ${h.reportsBy === 1 ? 'player' : 'players'}.`), el('h4', {}, 'Actions'), log);
    panel.scrollIntoView({ block: 'nearest' });
  };

  const load = async () => {
    list.replaceChildren(el('p', { class: 'admin__note' }, 'Loading…'));
    try {
      const r = await moderationCall<{ open: number; last24h: number; reports: ModerationReport[] }>(token, 'GET', all.checked ? '/reports' : '/reports?open=1');
      count.textContent = r.open ? String(r.open) : '';
      status.textContent = `${r.last24h} new in the last 24 hours · ${r.open} open. Reports are kept 180 days.`;
      if (!r.reports.length) {
        list.replaceChildren(el('p', { class: 'admin__note' }, all.checked ? 'No player reports yet.' : 'No open reports. Players report from the scoreboard menu, the lobby, results, Friends and the toasts.'));
        return;
      }
      list.replaceChildren(
        ...r.reports.map((rep) => {
          const b = el(
            'button',
            { type: 'button', class: 'admin__mod-row' },
            el('span', { class: 'admin__report-when' }, new Date(rep.at).toLocaleString()),
            el('span', { class: `admin__report-why${rep.handledAt ? '' : ' is-auto'}` }, rep.handledAt ? (rep.action ?? 'handled') : 'open'),
            el('b', {}, rep.target.nickname ?? rep.target.name),
            el('span', {}, `${REASON_LABELS[rep.reason] ?? rep.reason} · by ${rep.reporter.nickname ?? 'a closed account'}${rep.place ? ` · ${rep.place}` : ''}${rep.room ? ` · room ${rep.room}` : ''}`),
            el('span', { class: 'admin__report-problem' }, `${standingText(rep.target)}${rep.target.open > 1 ? ` · ${rep.target.open} open reports` : ''}${rep.note ? ` · “${rep.note}”` : ''}`),
          );
          b.addEventListener('click', () => void openPlayer(rep.target.id));
          return b;
        }),
      );
    } catch (e) {
      list.replaceChildren(el('p', { class: 'admin__note is-error' }, `Couldn't load the player reports: ${(e as Error).message}`));
    }
  };

  let findTimer = 0;
  find.addEventListener('input', () => {
    window.clearTimeout(findTimer);
    findTimer = window.setTimeout(() => {
      const q = find.value.trim();
      if (q.length < 2) {
        found.replaceChildren();
        return;
      }
      moderationCall<{ players: { id: string; nickname: string; level: number; status: string }[] }>(token, 'GET', `/players?q=${encodeURIComponent(q)}`).then(
        ({ players }) =>
          found.replaceChildren(
            ...(players.length
              ? players.map((p) => {
                  const b = el('button', { type: 'button', class: 'admin__btn' }, `${p.nickname} · level ${p.level}${p.status !== 'active' ? ` · ${p.status}` : ''}`);
                  b.addEventListener('click', () => void openPlayer(p.id));
                  return b;
                })
              : [el('span', { class: 'admin__note' }, 'Nobody by that name or id.')]),
          ),
        (e: Error) => found.replaceChildren(el('span', { class: 'admin__note is-error' }, e.message)),
      );
    }, 300);
  });

  refresh.addEventListener('click', () => void load());
  all.addEventListener('change', () => void load());
  const group = el(
    'details',
    { class: 'admin__group admin__group--reports' },
    el('summary', {}, 'Player reports', count),
    el(
      'div',
      { class: 'admin__sections admin__store' },
      el('p', { class: 'admin__note' }, 'What players reported about each other, newest first. Open one to act: every action needs a reason and is logged. ', refresh, ' ', el('label', {}, all, ' show handled')),
      status,
      list,
      el('div', { class: 'admin__store-find' }, find),
      found,
      panel,
    ),
  );
  group.addEventListener('toggle', () => {
    if ((group as HTMLDetailsElement).open) void load();
  });
  // the daily count shows on the group's title without opening it
  void moderationCall<{ open: number }>(token, 'GET', '/reports?open=1').then(
    (r) => (count.textContent = r.open ? String(r.open) : ''),
    () => {},
  );
  return group;
}
