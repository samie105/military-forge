/**
 * The admin page's Reports (the owner, 24 Oct: "check the logs"): the problem reports players sent
 * (Send a report, or a failed room connection's own), newest first, kept 7 days by the API
 * (/api/reports, the same token). A row opens the whole report: the device's event log, its
 * script errors, the tour's last steps and the device.
 */
export interface ReportSummary {
  id: string;
  at: number;
  reason: 'manual' | 'auto';
  context: string;
  nickname: string;
  build: string;
  ua: string;
  events: number;
  errors: number;
  problem: string;
}

export interface FullReport extends Omit<ReportSummary, 'ua' | 'events' | 'errors' | 'problem'> {
  device: { ua: string; w: number; h: number; dpr: number; standalone: boolean; touch: boolean; lang?: string };
  events: { t: number; k: string; m: string }[];
  errors: string[];
  tour?: string[];
  note?: string;
}

async function api<T>(token: string, path: string): Promise<T> {
  const res = await fetch(`/api/reports${path}`, { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' });
  if (!res.ok) throw new Error(res.status === 401 ? 'the API does not know this token (an older playtest?)' : `HTTP ${res.status}`);
  return (await res.json()) as T;
}

/** A browser and device in a few words, from the user agent. */
export function shortDevice(ua: string): string {
  const os = /iPhone|iPad/.test(ua) ? (/iPad/.test(ua) ? 'iPad' : 'iPhone') : /Android/.test(ua) ? (/SM-[A-Z0-9]+/.exec(ua)?.[0] ?? 'Android') : /Mac OS X/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : '?';
  const browser = /SamsungBrowser/.test(ua) ? 'Samsung Internet' : /CriOS|Chrome\//.test(ua) && !/Edg\//.test(ua) ? 'Chrome' : /Edg\//.test(ua) ? 'Edge' : /FxiOS|Firefox/.test(ua) ? 'Firefox' : /Safari/.test(ua) ? 'Safari' : '?';
  return `${os} · ${browser}`;
}

/** The whole report as text, one line per event (for reading, and Copy). */
export function reportText(r: FullReport): string {
  const d = r.device;
  const lines = [
    `Report ${r.id} · ${new Date(r.at).toLocaleString()} · ${r.reason === 'auto' ? 'sent by itself' : 'sent by the player'} · ${r.context}`,
    `${r.nickname || '(no name)'} · build ${r.build} · ${shortDevice(d.ua)} · ${d.w}×${d.h} @${d.dpr}x · ${d.standalone ? 'installed app' : 'in the browser'} · ${d.touch ? 'touch' : 'no touch'}${d.lang ? ` · ${d.lang}` : ''}`,
    d.ua,
    ...(r.note ? ['', `Note: ${r.note}`] : []),
    '',
    `Events (${r.events.length}):`,
    ...r.events.map((e) => `${(e.t / 1000).toFixed(1).padStart(7)} s  ${e.k.padEnd(6)} ${e.m}`),
    ...(r.errors.length ? ['', `Script errors (${r.errors.length}):`, ...r.errors] : []),
    ...(r.tour?.length ? ['', 'Tour (last steps):', ...r.tour] : []),
  ];
  return lines.join('\n');
}

type El = <K extends keyof HTMLElementTagNameMap>(tag: K, attrs?: Record<string, string>, ...children: (Node | string)[]) => HTMLElementTagNameMap[K];

/** The Reports group (a <details>), filled when opened and on Refresh. */
export function reportsGroup(token: string, el: El): HTMLElement {
  const list = el('div', { class: 'admin__reports' });
  const count = el('span', { class: 'admin__count' });
  const refresh = el('button', { type: 'button', class: 'admin__btn' }, 'Refresh');
  const load = async () => {
    list.replaceChildren(el('p', { class: 'admin__note' }, 'Loading…'));
    try {
      const { reports } = await api<{ reports: ReportSummary[] }>(token, '');
      count.textContent = reports.length ? `${reports.length}` : '';
      if (!reports.length) {
        list.replaceChildren(el('p', { class: 'admin__note' }, 'No reports in the last 7 days. Players send them from Settings or the pause menu; a failed room connection sends one by itself.'));
        return;
      }
      list.replaceChildren(
        ...reports.map((r) => {
          const body = el('pre', { class: 'admin__report-text' });
          const item = el(
            'details',
            { class: 'admin__report' },
            el(
              'summary',
              {},
              el('span', { class: 'admin__report-when' }, new Date(r.at).toLocaleString()),
              el('span', { class: `admin__report-why${r.reason === 'auto' ? ' is-auto' : ''}` }, r.reason === 'auto' ? 'auto' : 'sent'),
              el('b', {}, r.nickname || '(no name)'),
              el('span', {}, `${shortDevice(r.ua)} · ${r.context}`),
              el('span', { class: 'admin__report-problem' }, r.problem || `${r.events} events`),
            ),
            body,
          );
          item.addEventListener('toggle', () => {
            if (!(item as HTMLDetailsElement).open || body.textContent) return;
            body.textContent = 'Loading…';
            api<FullReport>(token, `/${r.id}`).then(
              (full) => (body.textContent = reportText(full)),
              (e: Error) => (body.textContent = `Couldn't load it: ${e.message}`),
            );
          });
          return item;
        }),
      );
    } catch (e) {
      list.replaceChildren(el('p', { class: 'admin__note is-error' }, `Couldn't load the reports: ${(e as Error).message}`));
    }
  };
  refresh.addEventListener('click', () => void load());
  const group = el('details', { class: 'admin__group admin__group--reports' }, el('summary', {}, 'Reports', count), el('div', { class: 'admin__sections' }, el('p', { class: 'admin__note' }, 'What happened on players’ devices: local room steps, connection states, errors. Kept 7 days. ', refresh), list));
  group.addEventListener('toggle', () => {
    if ((group as HTMLDetailsElement).open) void load();
  });
  return group;
}
