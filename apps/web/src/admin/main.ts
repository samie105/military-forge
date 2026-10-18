/**
 * The owner's admin page (/admin on pnpm playtest): every gameplay number the server lets the admin
 * change, grouped and searchable, each with a slider, a number box, its default and a reset.
 * Changes go to the game server as they're made (debounced) and reach every room and every player
 * at once; presets, "Copy JSON" and "Save as defaults" sit in the bar. model.ts has the logic.
 */
import { AdminApiError, adminCall, clampValue, formatValue, grouped, matches, readToken, withValue, type AdminFieldView, type AdminStateView } from './model';

const root = document.getElementById('admin')!;
function sessionStore(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null; // blocked storage: the token lives in the link only
  }
}
const token = readToken(location.hash, sessionStore());
// the token stays in this tab, not in the address bar
if (location.hash) history.replaceState(null, '', location.pathname);

let state: AdminStateView | null = null;
let values: Record<string, number> = {};
const rows = new Map<string, { row: HTMLElement; range: HTMLInputElement; num: HTMLInputElement; reset: HTMLButtonElement; field: AdminFieldView }>();
const counts = new Map<string, HTMLElement>();
let status: HTMLElement;
let saveTimer = 0;
let inFlight: Promise<void> | null = null;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, ...children: (Node | string)[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  for (const c of children) e.append(c);
  return e;
}

function gate(title: string, text: string): void {
  root.replaceChildren(el('div', { class: 'admin__gate' }, el('h1', {}, title), el('p', {}, text)));
  root.removeAttribute('aria-busy');
}

function setStatus(text: string, error = false): void {
  status.textContent = text;
  status.classList.toggle('is-error', error);
}

function changedCount(): number {
  return Object.keys(values).length;
}

function summary(): string {
  const n = changedCount();
  return n === 0 ? 'Classic: the shipped game' : `${n} change${n === 1 ? '' : 's'} live on every room`;
}

/** Puts `values` into the rows (the server's answer, clamped), without touching a box being typed in. */
function showValues(): void {
  for (const { row, range, num, reset, field } of rows.values()) {
    const v = values[field.key] ?? field.def;
    range.value = String(v);
    if (document.activeElement !== num) num.value = formatValue(field, v);
    const changed = field.key in values;
    row.classList.toggle('is-changed', changed);
    reset.disabled = !changed;
  }
  for (const [group, label] of counts) {
    const n = state!.fields.filter((f) => f.group === group && f.key in values).length;
    label.textContent = n ? `${n} changed` : '';
  }
}

/** Sends the values (after a short pause, so a slider drag is one call). */
function scheduleSave(): void {
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => void push(), 180);
  setStatus('Applying…');
}

async function push(): Promise<void> {
  if (inFlight) await inFlight;
  const sent = values;
  inFlight = (async () => {
    try {
      const next = await adminCall<AdminStateView>(token, 'PUT', '/values', sent);
      state = next;
      // a change made while this was on its way wins; otherwise take the server's (clamped) values
      if (values === sent) values = next.values;
      showValues();
      setStatus(summary());
    } catch (e) {
      onError(e);
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

function onError(e: unknown): void {
  if (e instanceof AdminApiError && e.status === 401) {
    gate('This admin link has expired', 'Use the admin link printed in the terminal running pnpm playtest (a new one each run).');
    return;
  }
  setStatus(`Not applied: ${(e as Error).message}`, true);
}

function row(f: AdminFieldView): HTMLElement {
  const id = `f-${f.key.replace(/[^a-z0-9]/gi, '-')}`;
  const range = el('input', { type: 'range', min: String(f.min), max: String(f.max), step: String(f.step), 'aria-label': `${f.section}: ${f.label}` });
  const num = el('input', { type: 'number', id, min: String(f.min), max: String(f.max), step: String(f.step), inputmode: 'decimal' });
  const reset = el('button', { type: 'button', class: 'admin__reset', title: 'Back to the default', 'aria-label': `Reset ${f.label}` }, '↺');
  const r = el('div', { class: 'admin__row', 'data-key': f.key }, el('label', { for: id }, f.label, el('small', {}, `default ${formatValue(f, f.def)}`)), range, num, reset);
  const set = (v: number) => {
    values = withValue(values, f, clampValue(f, v));
    showValues();
    scheduleSave();
  };
  range.addEventListener('input', () => set(Number(range.value)));
  num.addEventListener('change', () => {
    const v = Number(num.value);
    if (Number.isFinite(v)) set(v);
    num.value = formatValue(f, values[f.key] ?? f.def);
  });
  reset.addEventListener('click', () => set(f.def));
  rows.set(f.key, { row: r, range, num, reset, field: f });
  return r;
}

function filter(query: string): void {
  for (const group of root.querySelectorAll<HTMLDetailsElement>('.admin__group')) {
    let any = false;
    for (const section of group.querySelectorAll<HTMLElement>('.admin__section')) {
      let shown = 0;
      for (const r of section.querySelectorAll<HTMLElement>('.admin__row')) {
        const ok = matches(rows.get(r.dataset.key!)!.field, query);
        r.hidden = !ok;
        if (ok) shown++;
      }
      section.hidden = shown === 0;
      if (shown) any = true;
    }
    group.hidden = !any;
    if (query && any) group.open = true;
  }
}

async function copyJson(): Promise<void> {
  const text = `${JSON.stringify(values, null, 2)}\n`;
  try {
    await navigator.clipboard.writeText(text);
    setStatus(`Copied ${changedCount()} values as JSON`);
  } catch {
    // no clipboard (an http page on a phone): show it to copy by hand
    const area = el('textarea', { rows: '8', style: 'width:100%', readonly: '' });
    area.value = text;
    status.replaceChildren(area);
    area.select();
  }
}

async function preset(name: string): Promise<void> {
  try {
    window.clearTimeout(saveTimer);
    if (inFlight) await inFlight;
    state = await adminCall<AdminStateView>(token, 'POST', `/preset/${name}`, {});
    values = state.values;
    showValues();
    setStatus(`${name[0]!.toUpperCase()}${name.slice(1)}: ${summary()}`);
  } catch (e) {
    onError(e);
  }
}

async function saveDefaults(): Promise<void> {
  try {
    window.clearTimeout(saveTimer);
    await push();
    const r = await adminCall<{ file: string }>(token, 'POST', '/save', {});
    setStatus(`Saved as the defaults: the next playtest starts with them (${r.file})`);
  } catch (e) {
    onError(e);
  }
}

function render(s: AdminStateView): void {
  status = el('span', { class: 'admin__status', role: 'status', 'aria-live': 'polite' }, summary());
  const search = el('input', { type: 'search', class: 'admin__search', placeholder: 'Search: gravity, K-47, fuse, crate…', 'aria-label': 'Search the settings' });
  search.addEventListener('input', () => filter(search.value));
  const button = (label: string, cls: string, onClick: () => void, title = '') => {
    const b = el('button', { type: 'button', class: `admin__btn ${cls}`.trim(), ...(title ? { title } : {}) }, label);
    b.addEventListener('click', onClick);
    return b;
  };
  const presets = el('div', { class: 'admin__presets', role: 'group', 'aria-label': 'Presets' });
  for (const name of s.presets) presets.append(button(name === 'classic' ? 'Classic' : name[0]!.toUpperCase() + name.slice(1), '', () => void preset(name), name === 'classic' ? 'The shipped game (every value at its default)' : ''));
  const bar = el(
    'header',
    { class: 'admin__bar' },
    el('div', { class: 'admin__head' }, el('h1', { class: 'admin__title' }, 'Admin', el('small', {}, 'live on every room')), status),
    el(
      'div',
      { class: 'admin__tools' },
      search,
      presets,
      button('Copy JSON', '', () => void copyJson(), 'The changed values, to bake into the code'),
      ...(s.defaultsFile ? [button('Save as defaults', 'admin__btn--primary', () => void saveDefaults(), `The next playtest starts with these (${s.defaultsFile})`)] : []),
      button('Reset all', 'admin__btn--danger', () => void preset('classic')),
    ),
  );
  const groups: HTMLElement[] = [];
  for (const [group, sections] of grouped(s.fields)) {
    const count = el('span', { class: 'admin__count' });
    counts.set(group, count);
    const body = el('div', { class: 'admin__sections' });
    for (const [section, fields] of sections) body.append(el('section', { class: 'admin__section' }, el('h3', {}, section), ...fields.map(row)));
    groups.push(el('details', { class: 'admin__group', ...(groups.length === 0 ? { open: '' } : {}) }, el('summary', {}, group, count), body));
  }
  root.replaceChildren(bar, ...groups);
  root.removeAttribute('aria-busy');
  showValues();
}

async function start(): Promise<void> {
  if (!token) {
    gate('Admin', 'Open the admin link printed in the terminal running pnpm playtest: it carries this run’s key.');
    return;
  }
  try {
    state = await adminCall<AdminStateView>(token, 'GET', '/state');
    values = state.values;
    render(state);
  } catch (e) {
    if (e instanceof AdminApiError && e.status === 401) onError(e);
    else gate('The game server is not answering', `Is pnpm playtest still running? (${(e as Error).message})`);
  }
}

void start();
