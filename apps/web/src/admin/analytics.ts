/**
 * The admin page's Players group (the owner, 26 Oct: "keep metrics of users' behaviour … so it can
 * also help our ad engine"; docs/16-player-metrics.md §5): the API's dashboard under the same token
 * (/api/analytics/admin/*). Headline tiles, active players per day as columns, the funnel as bars,
 * and every other panel as a table with its numbers' magnitude drawn in the cell; each panel
 * downloads as CSV. Every number is a count: nothing here names a player.
 *
 * Charts: one series each, in the kit's volt on ink (no legend needed; the title names it), thin
 * marks, a hover tooltip per column, and the table under every chart (the same numbers as text).
 */

export type Cell = string | number | null;
export interface Table {
  title: string;
  note: string;
  columns: string[];
  rows: Cell[][];
}
export interface DashboardView {
  range: { from: string; to: string; days: number };
  generatedAt: string;
  kpis: { dau: number; wau: number; mau: number; newToday: number; players: number; matches: number; avgSessionS: number | null; d1: number | null; d7: number | null };
  tables: Record<string, Table>;
  ingest?: { queuedClient: number; queuedServer: number; written: number; dropped: number; pressure: number };
}

type El = <K extends keyof HTMLElementTagNameMap>(tag: K, attrs?: Record<string, string>, ...children: (Node | string)[]) => HTMLElementTagNameMap[K];

const SVG = 'http://www.w3.org/2000/svg';
const RANGES = [7, 30, 90] as const;

async function call(token: string, method: 'GET' | 'POST', path: string): Promise<Response> {
  const res = await fetch(`/api/analytics/admin${path}`, { method, headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' });
  if (!res.ok) throw new Error(res.status === 401 ? 'the API does not know this token (an older playtest?)' : `HTTP ${res.status}`);
  return res;
}

/** "12 m 05 s", "45 s", "–" */
export function duration(s: number | null): string {
  if (s === null) return '–';
  const m = Math.floor(s / 60);
  return m ? `${m} m ${String(Math.round(s % 60)).padStart(2, '0')} s` : `${Math.round(s)} s`;
}

export function fmt(v: Cell, column = ''): string {
  if (v === null) return '–';
  if (typeof v === 'number') {
    const s = Number.isInteger(v) ? v.toLocaleString('en-GB') : v.toLocaleString('en-GB', { maximumFractionDigits: 1 });
    return column.includes('%') ? `${s}%` : s;
  }
  return v;
}

/** The column a table's inline bars follow: the first numeric column that isn't a percentage. */
export function barColumn(t: Table): number {
  return t.columns.findIndex((c, i) => i > 0 && !c.includes('%') && t.rows.some((r) => typeof r[i] === 'number'));
}

/** The panels in the order the page shows them, with what each is for. */
export const LAYOUT: readonly { id: string; chart?: 'columns' | 'bars' }[] = [
  { id: 'active', chart: 'columns' },
  { id: 'retention' },
  { id: 'funnel', chart: 'bars' },
  { id: 'sessions', chart: 'bars' },
  { id: 'matches-per-player', chart: 'bars' },
  { id: 'devices' },
  { id: 'weapons' },
  { id: 'maps' },
  { id: 'modes' },
  { id: 'quits', chart: 'bars' },
  { id: 'quit-phase' },
  { id: 'last-screen' },
  { id: 'vs-bots' },
  { id: 'network' },
  { id: 'countries' },
  { id: 'features' },
  { id: 'ads' },
  { id: 'errors' },
  { id: 'ingest' },
];

function tableEl(el: El, t: Table): HTMLElement {
  const bar = barColumn(t);
  const max = bar < 0 ? 0 : Math.max(0, ...t.rows.map((r) => (typeof r[bar] === 'number' ? (r[bar] as number) : 0)));
  const head = el('tr', {}, ...t.columns.map((c, i) => el('th', { scope: 'col', ...(i > 0 ? { class: 'is-num' } : {}) }, c)));
  const body = t.rows.map((r) =>
    el(
      'tr',
      {},
      ...r.map((v, i) => {
        const cell = el(i === 0 ? 'th' : 'td', { ...(i === 0 ? { scope: 'row' } : { class: typeof v === 'number' || v === null ? 'is-num' : '' }) }, fmt(v, t.columns[i]));
        if (i === bar && typeof v === 'number' && max > 0) {
          cell.classList.add('has-bar');
          cell.style.setProperty('--bar', String(Math.max(0.01, v / max)));
        }
        return cell;
      }),
    ),
  );
  return el('div', { class: 'stats__scroll' }, el('table', { class: 'stats__table' }, el('caption', { class: 'stats__sr' }, t.title), el('thead', {}, head), el('tbody', {}, ...(body.length ? body : [el('tr', {}, el('td', { colspan: String(t.columns.length), class: 'stats__empty' }, 'Nothing yet in this range'))]))));
}

/** Columns over days (active players): one series; a tooltip per column on hover and focus. */
function columnsEl(el: El, t: Table, tip: HTMLElement): HTMLElement | null {
  if (t.rows.length < 2) return null;
  const W = 720;
  const H = 180;
  const pad = { l: 36, r: 8, t: 10, b: 22 };
  const values = t.rows.map((r) => Number(r[1] ?? 0));
  const top = Math.max(1, ...values);
  const step = (W - pad.l - pad.r) / values.length;
  const bw = Math.max(2, Math.min(28, step - 2));
  const y = (v: number) => pad.t + (H - pad.t - pad.b) * (1 - v / top);
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('class', 'stats__chart');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', `${t.title}: ${values.length} days, the most ${top}`);
  const add = (tag: string, attrs: Record<string, string | number>) => {
    const e = document.createElementNS(SVG, tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
    svg.append(e);
    return e;
  };
  // a recessive grid: the baseline and the top
  for (const v of [0, top]) {
    add('line', { x1: pad.l, x2: W - pad.r, y1: y(v), y2: y(v), class: 'stats__grid' });
    add('text', { x: pad.l - 6, y: y(v) + 4, class: 'stats__axis', 'text-anchor': 'end' }).textContent = String(v);
  }
  values.forEach((v, i) => {
    const x = pad.l + i * step + (step - bw) / 2;
    const h = Math.max(0, y(0) - y(v));
    // rounded data end, square at the baseline
    const r = Math.min(4, bw / 2, h);
    const path = `M${x},${y(0)} V${y(0) - h + r} Q${x},${y(0) - h} ${x + r},${y(0) - h} H${x + bw - r} Q${x + bw},${y(0) - h} ${x + bw},${y(0) - h + r} V${y(0)} Z`;
    add('path', { d: path, class: 'stats__mark' });
    // the hit target: the whole column's height and step
    const hit = add('rect', { x: pad.l + i * step, y: pad.t, width: step, height: H - pad.t - pad.b, class: 'stats__hit', tabindex: 0 });
    const row = t.rows[i]!;
    const show = () => {
      tip.textContent = t.columns.map((c, k) => `${c}: ${fmt(row[k] ?? null, c)}`).join(' · ');
      tip.hidden = false;
    };
    hit.addEventListener('pointerenter', show);
    hit.addEventListener('focus', show);
    hit.addEventListener('pointerleave', () => (tip.hidden = true));
    hit.addEventListener('blur', () => (tip.hidden = true));
  });
  // first and last day under the axis
  add('text', { x: pad.l, y: H - 6, class: 'stats__axis' }).textContent = String(t.rows[0]![0]).slice(5);
  add('text', { x: W - pad.r, y: H - 6, class: 'stats__axis', 'text-anchor': 'end' }).textContent = String(t.rows.at(-1)![0]).slice(5);
  return el('div', { class: 'stats__plot' }, svg as unknown as Node);
}

/** Horizontal bars (the funnel, lengths, quits): one series, the label and value beside each bar. */
function barsEl(el: El, t: Table): HTMLElement | null {
  const col = barColumn(t);
  if (col < 0 || !t.rows.length) return null;
  const max = Math.max(1, ...t.rows.map((r) => Number(r[col] ?? 0)));
  return el(
    'div',
    { class: 'stats__bars', role: 'img', 'aria-label': `${t.title}, as bars (the table below has the numbers)` },
    ...t.rows.map((r) => {
      const v = Number(r[col] ?? 0);
      // a zero draws nothing (no stub that reads as "a little")
      const b = el('span', { class: v > 0 ? 'stats__bar' : 'stats__bar is-zero' });
      b.style.setProperty('--bar', String(v / max));
      return el('div', { class: 'stats__bar-row', title: `${r[0]}: ${fmt(v)}` }, el('span', { class: 'stats__bar-label' }, String(r[0])), el('span', { class: 'stats__bar-track' }, b), el('span', { class: 'stats__bar-value' }, fmt(v)));
    }),
  );
}

function tiles(el: El, d: DashboardView): HTMLElement {
  const k = d.kpis;
  const tile = (label: string, value: string, sub = '') => el('div', { class: 'stats__tile' }, el('span', { class: 'stats__tile-label' }, label), el('b', { class: 'stats__tile-value' }, value), ...(sub ? [el('span', { class: 'stats__tile-sub' }, sub)] : []));
  return el(
    'div',
    { class: 'stats__tiles' },
    tile('Today', fmt(k.dau), `${fmt(k.newToday)} new`),
    tile('Last 7 days', fmt(k.wau), 'active players'),
    tile('Last 30 days', fmt(k.mau), 'active players'),
    tile('D1 retention', k.d1 === null ? '–' : `${k.d1}%`, 'back the next day'),
    tile('D7 retention', k.d7 === null ? '–' : `${k.d7}%`, 'back a week later'),
    tile('Avg session', duration(k.avgSessionS), 'consenting players'),
    tile('Matches', fmt(k.matches), `${d.range.days} days`),
    tile('Players', fmt(k.players), `${d.range.days} days`),
  );
}

async function download(token: string, id: string, days: number): Promise<void> {
  const res = await call(token, 'GET', `/export/${id}.csv?days=${days}`);
  const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? `${id}.csv`;
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** The Players group (a <details>, open first), filled when opened, on a range change and on Refresh. */
export function analyticsGroup(token: string, el: El): HTMLElement {
  let days = 30;
  const body = el('div', { class: 'stats' });
  const status = el('span', { class: 'admin__count' });
  const tip = el('div', { class: 'stats__tip', role: 'status', 'aria-live': 'polite' });
  tip.hidden = true;
  const rangeBtns = RANGES.map((n) => {
    const b = el('button', { type: 'button', class: 'admin__btn', 'aria-pressed': String(n === days) }, `${n} days`);
    b.addEventListener('click', () => {
      days = n;
      for (const x of rangeBtns) x.setAttribute('aria-pressed', String(x === b));
      void load();
    });
    return b;
  });
  const refresh = el('button', { type: 'button', class: 'admin__btn', title: 'Write what is queued and recount today now (otherwise every 10 minutes)' }, 'Recount now');
  refresh.addEventListener('click', () => void load(true));

  const render = (d: DashboardView) => {
    const panels = LAYOUT.flatMap(({ id, chart }) => {
      const t = d.tables[id];
      if (!t) return [];
      const csv = el('button', { type: 'button', class: 'admin__btn stats__csv', title: `${t.title} as CSV` }, 'CSV');
      csv.addEventListener('click', () => void download(token, id, days).catch((e: Error) => (status.textContent = `CSV failed: ${e.message}`)));
      const plot = chart === 'columns' ? columnsEl(el, t, tip) : chart === 'bars' ? barsEl(el, t) : null;
      // under a chart the same numbers fold away as a table (open it to read them, or for a screen reader)
      const table = plot ? el('details', { class: 'stats__numbers' }, el('summary', {}, 'Table'), tableEl(el, t)) : tableEl(el, t);
      return [el('section', { class: `stats__panel stats__panel--${id}`, 'aria-label': t.title }, el('header', { class: 'stats__head' }, el('h2', {}, t.title), csv), el('p', { class: 'admin__note' }, t.note), ...(plot ? [plot] : []), table)];
    });
    const ing = d.ingest;
    status.textContent = `${d.range.from} to ${d.range.to}${ing ? ` · queue ${ing.queuedClient + ing.queuedServer} · dropped ${ing.dropped}` : ''}`;
    body.replaceChildren(tiles(el, d), tip, el('div', { class: 'stats__grid-panels' }, ...panels));
  };

  const load = async (recount = false) => {
    body.setAttribute('aria-busy', 'true');
    if (!body.childElementCount) body.replaceChildren(el('p', { class: 'admin__note' }, 'Loading…'));
    try {
      if (recount) await call(token, 'POST', '/rollup');
      render((await (await call(token, 'GET', `/dashboard?days=${days}`)).json()) as DashboardView);
    } catch (e) {
      body.replaceChildren(el('p', { class: 'admin__note is-error' }, `Couldn't load the stats: ${(e as Error).message}`));
    } finally {
      body.removeAttribute('aria-busy');
    }
  };

  const group = el(
    'details',
    { class: 'admin__group admin__group--stats', open: '' },
    el('summary', {}, 'Players', status),
    el('div', { class: 'admin__sections' }, el('div', { class: 'stats__bar-top' }, el('p', { class: 'admin__note' }, 'How people play: counts only, never a name. Rollups refresh every 10 minutes; raw events are kept 90 days.'), el('div', { class: 'stats__tools', role: 'group', 'aria-label': 'Range' }, ...rangeBtns, refresh)), body),
  );
  group.addEventListener('toggle', () => {
    if ((group as HTMLDetailsElement).open && !body.childElementCount) void load();
  });
  void load();
  return group;
}
