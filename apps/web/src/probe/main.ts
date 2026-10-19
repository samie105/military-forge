/**
 * The ping probe (probe.html, served at /probe on each net-trial box; docs/net-trial.md): the tester
 * says where they are and on what, then the page pings every region's /echo WebSocket at once,
 * 300 times at 30 Hz (the game's snapshot rate), shows median, p95, jitter and loss per region, and
 * posts the run to the trial's results endpoint. Nothing else about the tester is sent: no name, no
 * user agent; the server keeps only the network's ASN (never the address). stats.ts has the logic.
 */
import {
  CONNECTIONS,
  DEVICES,
  GRACE_MS,
  NETWORKS,
  PING_HZ,
  PINGS,
  REFERENCES,
  REF_SAMPLES,
  REF_TIMEOUT_MS,
  REF_WARMUP,
  WARMUP,
  echoSeq,
  guessDevice,
  missingAnswer,
  parseConfig,
  pingFrame,
  refUrl,
  resultPayload,
  traceColo,
  summarize,
  verdict,
  type Answers,
  type ProbeConfig,
  type ProbeReference,
  type ProbeRegion,
  type RefRun,
  type RegionRun,
  type Summary,
} from './stats';

const CITIES = ['Lagos', 'Abuja', 'Port Harcourt', 'Ibadan', 'Kano', 'Benin City', 'Enugu', 'Kaduna', 'Jos', 'Owerri', 'Abeokuta', 'Ilorin', 'Uyo', 'Calabar', 'Warri', 'Onitsha', 'Akure', 'Asaba', 'Aba', 'Osogbo', 'Maiduguri', 'Sokoto', 'Zaria', 'Ota', 'Ile-Ife'];
const STORE_KEY = 'mf-probe-answers';
const root = document.getElementById('probe')!;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, ...children: (Node | string)[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  for (const c of children) e.append(c);
  return e;
}

function store(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function savedAnswers(): Partial<Answers> {
  try {
    return JSON.parse(store()?.getItem(STORE_KEY) ?? '{}') as Partial<Answers>;
  } catch {
    return {};
  }
}

function saveAnswers(a: Answers): void {
  try {
    store()?.setItem(STORE_KEY, JSON.stringify(a));
  } catch {
    /* the next run asks again */
  }
}

function newId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }
}

/** Cloudflare city codes testers are likely to get */
const COLO_CITY: Record<string, string> = { LOS: 'Lagos', ACC: 'Accra', JNB: 'Johannesburg', CPT: 'Cape Town', LHR: 'London', AMS: 'Amsterdam', FRA: 'Frankfurt', CDG: 'Paris', MRS: 'Marseille', MAD: 'Madrid', LIS: 'Lisbon' };

const fmt = (v: number | null, unit = ' ms') => (v === null ? '–' : `${Math.round(v)}${unit}`);

/** One region's pings: `onProgress(done, live summary)` as echoes arrive. */
function measure(region: ProbeRegion, onProgress: (done: number, s: Summary) => void): Promise<RegionRun> {
  return new Promise((resolve) => {
    const total = WARMUP + PINGS;
    const interval = 1000 / PING_HZ;
    const sentAt: number[] = [];
    const rtts: (number | null)[] = [];
    let connectMs: number | null = null;
    let error = '';
    let finished = false;
    let echoes = 0;
    let timer = 0;
    let ws: WebSocket;
    const t0 = performance.now();
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      clearTimeout(connectTimer);
      try {
        ws.close(1000);
      } catch {
        /* already closed */
      }
      // pings never sent (no connection, or a dropped one) count as lost too
      resolve({ connectMs, rtts: Array.from({ length: PINGS }, (_, i) => rtts[i] ?? null), error });
    };
    const connectTimer = window.setTimeout(() => {
      error = 'could not connect within 10 s';
      finish();
    }, 10_000);
    try {
      ws = new WebSocket(region.echo);
    } catch (e) {
      error = `could not open: ${(e as Error).message}`.slice(0, 120);
      finish();
      return;
    }
    ws.binaryType = 'arraybuffer';
    ws.onmessage = (e) => {
      const seq = echoSeq(e.data);
      const at = sentAt[seq ?? -1];
      if (seq === null || at === undefined) return;
      if (seq >= WARMUP && rtts[seq - WARMUP] === undefined) {
        rtts[seq - WARMUP] = performance.now() - at;
        echoes++;
        if (echoes % 6 === 0 || echoes === PINGS) onProgress(echoes, summarize(rtts.filter((x) => x !== undefined)));
      }
      if (echoes === PINGS) finish();
    };
    ws.onerror = () => {
      if (!error) error = connectMs === null ? 'could not connect' : 'connection dropped';
    };
    ws.onclose = () => {
      if (!finished && !error) error = 'connection closed early';
      finish();
    };
    ws.onopen = () => {
      connectMs = performance.now() - t0;
      clearTimeout(connectTimer);
      let start = performance.now();
      const send = () => {
        if (finished) return;
        const seq = sentAt.length;
        sentAt.push(performance.now());
        try {
          ws.send(pingFrame(seq));
        } catch {
          error = 'connection dropped';
          return finish();
        }
        if (sentAt.length >= total) {
          timer = window.setTimeout(finish, GRACE_MS);
          return;
        }
        const now = performance.now();
        // a throttled timer doesn't make up for lost time with a burst of pings: the schedule moves on
        if (now - (start + sentAt.length * interval) > 3 * interval) start = now - sentAt.length * interval;
        timer = window.setTimeout(send, Math.max(0, start + sentAt.length * interval - now));
      };
      send();
    };
  });
}

/**
 * One reference's round trips (stats.ts REFERENCES): REF_WARMUP requests open the connection, then
 * REF_SAMPLES timed ones, one at a time on the warm connection, each cache-busted.
 */
async function measureRef(ref: ProbeReference, onSample: (rtts: (number | null)[]) => void): Promise<RefRun> {
  const rtts: (number | null)[] = [];
  let colo = '';
  let error = '';
  for (let n = 0; n < REF_WARMUP + REF_SAMPLES; n++) {
    const t0 = performance.now();
    let rtt: number | null = null;
    try {
      const res = await fetch(refUrl(ref, n), {
        mode: ref.opaque ? 'no-cors' : 'cors',
        cache: 'no-store',
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        signal: AbortSignal.timeout(REF_TIMEOUT_MS),
      });
      rtt = performance.now() - t0; // the response's headers: one round trip on a warm connection
      const body = await res.text().catch(() => '');
      if (ref.id === 'cf-edge' && !colo) colo = traceColo(body);
    } catch (e) {
      error = (e as Error).name === 'TimeoutError' ? `no answer within ${REF_TIMEOUT_MS / 1000} s` : 'could not reach it';
    }
    if (n >= REF_WARMUP) {
      rtts.push(rtt);
      onSample(rtts);
    }
  }
  if (rtts.some((x) => x !== null)) error = '';
  return { rtts, colo, error };
}

/** The reference pings' table: each city's median and p95, and how it compares with our server. */
function refTable(): { section: HTMLElement; body: HTMLTableSectionElement } {
  const body = el('tbody');
  const section = el(
    'section',
    { class: 'probe__refs' },
    el('h2', {}, 'Other cities, for comparison'),
    el('p', { class: 'probe__refs-note' }, 'Round trips to public cloud endpoints (not game servers), timed the same moment from this device.'),
    el('table', {}, el('thead', {}, el('tr', {}, el('th', { scope: 'col' }, 'Where'), el('th', { scope: 'col' }, 'Median'), el('th', { scope: 'col' }, 'p95'))), body),
  );
  return { section, body };
}

function refRows(body: HTMLTableSectionElement, ours: { name: string; s: Summary }[], refs: Record<string, RefRun>): void {
  const rows = [
    ...ours.map((o) => ({ name: o.name, provider: 'our game server', s: o.s, ours: true, error: '' })),
    ...REFERENCES.filter((r) => refs[r.id]).map((r) => {
      const run = refs[r.id]!;
      const where = r.id === 'cf-edge' && run.colo ? `${r.name} (${COLO_CITY[run.colo] ?? run.colo})` : r.name;
      return { name: where, provider: r.provider, s: summarize(run.rtts), ours: false, error: run.error };
    }),
  ];
  rows.sort((a, b) => (a.s.median ?? Infinity) - (b.s.median ?? Infinity));
  body.replaceChildren(
    ...rows.map((r) =>
      el(
        'tr',
        r.ours ? { class: 'is-ours' } : {},
        el('th', { scope: 'row' }, r.name, el('small', {}, r.provider)),
        el('td', {}, r.error && r.s.median === null ? '–' : fmt(r.s.median)),
        el('td', {}, fmt(r.s.p95)),
      ),
    ),
  );
}

function select(name: string, label: string, options: readonly { id: string; label: string }[], value: string, placeholder: string): HTMLLabelElement {
  const s = el('select', { name, required: '' });
  s.append(el('option', { value: '' }, placeholder));
  for (const o of options) {
    const opt = el('option', { value: o.id }, o.label);
    if (o.id === value) opt.selected = true;
    s.append(opt);
  }
  return el('label', { class: 'probe__field' }, el('span', {}, label), s);
}

function regionCard(region: ProbeRegion): { card: HTMLElement; bar: HTMLElement; stats: HTMLElement } {
  const bar = el('div', { class: 'probe__bar' });
  const stats = el('dl', { class: 'probe__stats' });
  const card = el(
    'section',
    { class: 'probe__region', 'data-region': region.id },
    el('h2', {}, region.name, region.provider ? el('small', {}, region.provider) : ''),
    el('div', { class: 'probe__track', role: 'progressbar', 'aria-label': `${region.name} progress` }, bar),
    stats,
  );
  return { card, bar, stats };
}

function showStats(stats: HTMLElement, s: Summary, connectMs: number | null, err: string): void {
  const row = (k: string, v: string, hint = '') => [el('dt', hint ? { title: hint } : {}, k), el('dd', {}, v)];
  stats.replaceChildren(
    ...row('Median', fmt(s.median), 'the typical round trip'),
    ...row('p95', fmt(s.p95), '95% of pings were at least this fast'),
    ...row('Jitter', fmt(s.jitter), 'how much the round trip jumps from ping to ping'),
    ...row('Loss', `${s.loss}%`, `no echo within ${GRACE_MS / 1000} s`),
    ...row('Over 150 ms', s.over150 === null ? '–' : `${s.over150}%`),
    ...row('Connect', fmt(connectMs), 'opening the secure socket'),
  );
  if (err) stats.append(el('p', { class: 'probe__err' }, err));
}

async function post(config: ProbeConfig, body: unknown): Promise<{ ok: boolean; asName?: string; asn?: number | null }> {
  for (const url of config.results) {
    try {
      const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), mode: 'cors', credentials: 'omit' });
      if (res.ok) return { ok: true, ...((await res.json()) as { asName?: string; asn?: number | null }) };
    } catch {
      /* the next box */
    }
  }
  return { ok: false };
}

function render(config: ProbeConfig): void {
  const saved = savedAnswers();
  const city = el('input', { name: 'city', list: 'probe-cities', autocomplete: 'off', maxlength: '60', placeholder: 'e.g. Lagos', value: saved.city ?? '' });
  const cities = el('datalist', { id: 'probe-cities' }, ...CITIES.map((c) => el('option', { value: c })));
  const network = select('network', 'Network', NETWORKS, saved.network ?? '', 'Pick one');
  const ispInput = el('input', { name: 'isp', maxlength: '60', value: saved.isp ?? '' });
  const ispLabel = el('span', {}, 'Company name');
  const isp = el('label', { class: 'probe__field' }, ispLabel, ispInput);
  const connection = select('connection', 'Connected by', CONNECTIONS, saved.connection ?? '', 'Pick one (optional)');
  const device = select(
    'device',
    'Device',
    DEVICES.map((d) => ({ id: d, label: d })),
    saved.device ?? guessDevice(navigator.userAgent),
    'Pick one',
  );
  const note = el('input', { name: 'note', maxlength: '200', placeholder: 'e.g. indoors, 2 bars, evening', value: '' });
  const networkSel = network.querySelector('select')!;
  const syncIsp = () => {
    const v = networkSel.value;
    isp.hidden = v !== 'fibre' && v !== 'other';
    ispLabel.textContent = v === 'fibre' ? 'Fibre or broadband company (e.g. Spectranet, FiberOne, ipNX)' : 'Network name';
  };
  networkSel.addEventListener('change', syncIsp);
  syncIsp();

  const start = el('button', { type: 'submit', class: 'probe__go' }, 'Start the test');
  const status = el('p', { class: 'probe__status', role: 'status', 'aria-live': 'polite' });
  const form = el(
    'form',
    { class: 'probe__form' },
    el('label', { class: 'probe__field' }, el('span', {}, 'City or town'), city, cities),
    network,
    isp,
    connection,
    device,
    el('label', { class: 'probe__field' }, el('span', {}, 'Anything else? (optional, no names or numbers please)'), note),
    start,
    status,
  );
  const cards = config.regions.map((r) => ({ region: r, ...regionCard(r) }));
  const summary = el('p', { class: 'probe__verdict', 'aria-live': 'polite' });
  const refs = refTable();
  refs.section.hidden = true;
  root.replaceChildren(
    el(
      'header',
      { class: 'probe__head' },
      el('h1', {}, 'Ping test'),
      el(
        'p',
        {},
        `Measures your connection to ${config.regions.length === 1 ? 'our game server' : `our ${config.regions.length} test servers at once`}: ${PINGS} pings${config.regions.length === 1 ? '' : ' each'}, ${PING_HZ} a second, like the game, then to other cities for comparison. It takes under a minute. Keep this page open and on screen while it runs.`,
      ),
    ),
    form,
    el('div', { class: 'probe__regions' }, ...cards.map((c) => c.card)),
    summary,
    refs.section,
    el(
      'p',
      { class: 'probe__privacy' },
      'What we keep: what you type above and the timings. Not your name, not your IP address: the server notes only which network (ASN) the test came from. The comparison asks public sites (AWS, Cloudflare, IXPN, Nobus) for a tiny file, so they see a visit as any website would. Run it again at another time of day or on another network: every run helps.',
    ),
  );
  root.removeAttribute('aria-busy');

  let backgrounded = false;
  let running = false;
  document.addEventListener('visibilitychange', () => {
    if (running && document.hidden) backgrounded = true;
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (running) return;
    const answers: Answers = {
      city: city.value,
      network: networkSel.value as Answers['network'],
      isp: isp.hidden ? '' : ispInput.value,
      connection: connection.querySelector('select')!.value,
      device: device.querySelector('select')!.value,
      note: note.value,
    };
    const missing = missingAnswer(answers);
    if (missing) {
      status.textContent = missing;
      status.classList.add('is-error');
      return;
    }
    status.classList.remove('is-error');
    saveAnswers({ ...answers, note: '' });
    running = true;
    backgrounded = false;
    start.disabled = true;
    start.textContent = 'Testing…';
    summary.textContent = '';
    status.textContent = cards.length === 1 ? 'Pinging the server…' : 'Pinging the servers…';
    const runs: Record<string, RegionRun> = {};
    await Promise.all(
      cards.map(async ({ region, bar, stats }) => {
        bar.style.width = '0%';
        stats.replaceChildren();
        const run = await measure(region, (done, s) => {
          bar.style.width = `${Math.round((done / PINGS) * 100)}%`;
          showStats(stats, s, null, '');
        });
        bar.style.width = '100%';
        runs[region.id] = run;
        showStats(stats, summarize(run.rtts), run.connectMs, run.error);
      }),
    );
    // then the other cities, after our own pings so they don't share the link with them
    status.textContent = 'Comparing with other cities…';
    refs.section.hidden = false;
    const ours = cards.map((c) => ({ name: c.region.name, s: summarize(runs[c.region.id]!.rtts) }));
    const refRuns: Record<string, RefRun> = {};
    performance.clearResourceTimings?.();
    await Promise.all(
      REFERENCES.map(async (ref) => {
        refRuns[ref.id] = await measureRef(ref, (rtts) => {
          refRuns[ref.id] = { rtts, colo: refRuns[ref.id]?.colo ?? '', error: '' };
          refRows(refs.body, ours, refRuns);
        });
        refRows(refs.body, ours, refRuns);
      }),
    );
    running = false;
    const [a, b] = cards;
    const v = a && b ? verdict({ name: a.region.name, s: summarize(runs[a.region.id]!.rtts) }, { name: b.region.name, s: summarize(runs[b.region.id]!.rtts) }) : null;
    summary.textContent = v ? `${v.faster} was ${v.by} ms faster than ${v.slower} at the median.` : '';
    if (backgrounded) summary.textContent += ' (The page was in the background for part of the test, so these numbers may be off: run it again with the page on screen.)';
    status.textContent = 'Saving your result…';
    const body = resultPayload(newId(), config, answers, runs, { at: new Date().toISOString(), page: location.host, backgrounded, refs: refRuns });
    const saved = await post(config, body);
    status.textContent = saved.ok
      ? `Saved, thank you!${saved.asName ? ` (Your network as the server saw it: ${saved.asName}.)` : ''} Run it again any time.`
      : "Couldn't save the result: check your connection and run it again.";
    status.classList.toggle('is-error', !saved.ok);
    start.disabled = false;
    start.textContent = 'Run it again';
  });
}

async function boot(): Promise<void> {
  try {
    const res = await fetch('/probe-config.json', { cache: 'no-store' });
    const config = parseConfig(res.ok ? await res.json() : null);
    if (config) return render(config);
  } catch {
    /* below */
  }
  root.replaceChildren(el('div', { class: 'probe__head' }, el('h1', {}, 'Ping test'), el('p', {}, 'This server has no test set up right now.')));
  root.removeAttribute('aria-busy');
}

void boot();
