#!/usr/bin/env node
/**
 * The net trial's results table (docs/net-trial.md): reads the boxes' results.jsonl files (results.sh
 * fetches them), drops duplicate runs (a run saved on both boxes counts once), pools every run's raw
 * RTTs per city × network × region, and prints median, p95, jitter and loss, then the two regions
 * head to head, then which networks (ASNs) the testers were really on.
 *
 *   node scripts/net-trial/results.mjs <results.jsonl>… [--csv] [--include-backgrounded] [--by-connection]
 *
 * Reference pings (the page's round trips to public endpoints in other cities, stats.ts REFERENCES)
 * follow as their own table, next to our servers, and in the CSV as regions `ref:<id>`.
 *
 * Same definitions as the probe page (apps/web/src/probe/stats.ts): median = middle value (mean of the
 * two middle ones), p95 = nearest rank, jitter = mean |Δ| between consecutive received pings (per run,
 * then averaged over runs), loss = pings with no echo / pings sent.
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const NETWORK_LABELS = { mtn: 'MTN', airtel: 'Airtel', glo: 'Glo', '9mobile': '9mobile', fibre: 'Fibre', starlink: 'Starlink', other: 'Other' };
const REGION_ORDER = ['los', 'jnb'];

export function median(sorted) {
  const n = sorted.length;
  if (!n) return null;
  return n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
}

export function percentile(sorted, p) {
  if (!sorted.length) return null;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1];
}

/** "  port   harcourt " → "Port Harcourt" */
export function cityName(s) {
  return String(s ?? '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .replace(/(^|[\s-])\p{L}/gu, (m) => m.toUpperCase());
}

/** "Fibre: Spectranet", "MTN", … (the ISP's name for fibre and other, tidied) */
export function networkName(r) {
  const base = NETWORK_LABELS[r.network] ?? 'Other';
  const isp = String(r.isp ?? '').trim().replace(/\s+/g, ' ');
  return (r.network === 'fibre' || r.network === 'other') && isp ? `${base}: ${cityName(isp)}` : base;
}

/** Runs from JSON lines, newest copy per id; bad lines are counted, not fatal. */
export function readRuns(texts) {
  const byId = new Map();
  let bad = 0;
  for (const text of texts) {
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line);
        if (r && typeof r === 'object' && r.id && r.regions) byId.set(r.id, r);
        else bad++;
      } catch {
        bad++;
      }
    }
  }
  return { runs: [...byId.values()], bad };
}

/** Pooled numbers for a set of (run, region) measurements. */
export function pool(measurements) {
  const all = [];
  let sent = 0;
  let lost = 0;
  const jitters = [];
  for (const m of measurements) {
    const rtts = Array.isArray(m.rtts) ? m.rtts : [];
    sent += rtts.length;
    const got = rtts.filter((x) => typeof x === 'number');
    lost += rtts.length - got.length;
    all.push(...got);
    if (got.length > 1) {
      let sum = 0;
      for (let i = 1; i < got.length; i++) sum += Math.abs(got[i] - got[i - 1]);
      jitters.push(sum / (got.length - 1));
    }
  }
  all.sort((a, b) => a - b);
  return {
    runs: measurements.length,
    pings: sent,
    median: median(all),
    p95: percentile(all, 95),
    jitter: jitters.length ? jitters.reduce((a, b) => a + b, 0) / jitters.length : null,
    loss: sent ? (lost / sent) * 100 : null,
  };
}

/**
 * Rows of city × network (× connection) × region, sorted, with pooled numbers. `refs`: the
 * reference pings instead, as regions `ref:<id>`.
 */
export function table(runs, { byConnection = false, refs = false } = {}) {
  const groups = new Map();
  for (const r of runs) {
    const city = cityName(r.city) || '(no city)';
    const network = networkName(r) + (byConnection && r.connection ? ` (${r.connection})` : '');
    const source = refs ? Object.fromEntries(Object.entries(r.refs ?? {}).map(([id, m]) => [`ref:${id}`, m])) : (r.regions ?? {});
    for (const [region, m] of Object.entries(source)) {
      const key = JSON.stringify([city, network, region]);
      if (!groups.has(key)) groups.set(key, { city, network, region, ms: [] });
      groups.get(key).ms.push(m);
    }
  }
  const order = (r) => (REGION_ORDER.includes(r) ? REGION_ORDER.indexOf(r) : 99);
  return [...groups.values()]
    .map((g) => ({ city: g.city, network: g.network, region: g.region, ...pool(g.ms) }))
    .sort((a, b) => a.city.localeCompare(b.city) || a.network.localeCompare(b.network) || order(a.region) - order(b.region) || a.region.localeCompare(b.region));
}

/** Per city × network: each region's median side by side, and the faster one. */
export function headToHead(rows) {
  const by = new Map();
  for (const r of rows) {
    const key = `${r.city}\u0000${r.network}`;
    if (!by.has(key)) by.set(key, { city: r.city, network: r.network, regions: {} });
    by.get(key).regions[r.region] = r;
  }
  return [...by.values()].map((g) => {
    const ids = Object.keys(g.regions).filter((id) => g.regions[id].median !== null);
    ids.sort((a, b) => g.regions[a].median - g.regions[b].median);
    const faster = ids.length >= 2 ? ids[0] : null;
    const by = faster ? g.regions[ids[1]].median - g.regions[faster].median : null;
    return { ...g, faster, by };
  });
}

/** Which ASNs each typed network came from: catches "MTN" testers who were really on Wi-Fi elsewhere. */
export function asnsByNetwork(runs) {
  const by = new Map();
  for (const r of runs) {
    const label = networkName(r);
    const asn = r.net?.asn ? `AS${r.net.asn}${r.net.asName ? ` ${r.net.asName}` : ''}` : 'unknown';
    if (!by.has(label)) by.set(label, new Map());
    const m = by.get(label);
    m.set(asn, (m.get(asn) ?? 0) + 1);
  }
  return [...by.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([network, m]) => ({ network, asns: [...m.entries()].sort((a, b) => b[1] - a[1]) }));
}

const ms = (v) => (v === null ? '-' : v.toFixed(1));
const pct = (v) => (v === null ? '-' : `${v.toFixed(1)}%`);

function render(head, rows) {
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length)));
  const line = (cells) => cells.map((c, i) => (i < 3 ? String(c).padEnd(widths[i]) : String(c).padStart(widths[i]))).join('  ');
  return [line(head), widths.map((w) => '-'.repeat(w)).join('  '), ...rows.map(line)].join('\n');
}

function csvCell(v) {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function main(argv) {
  const files = argv.filter((a) => !a.startsWith('--'));
  const csv = argv.includes('--csv');
  const includeBackgrounded = argv.includes('--include-backgrounded');
  const byConnection = argv.includes('--by-connection');
  if (!files.length) {
    console.error('usage: results.mjs <results.jsonl>… [--csv] [--include-backgrounded] [--by-connection]');
    return 2;
  }
  const texts = [];
  for (const f of files) {
    try {
      texts.push(readFileSync(f, 'utf8'));
    } catch (e) {
      console.error(`skipping ${f}: ${e.message}`);
    }
  }
  const { runs: all, bad } = readRuns(texts);
  const runs = includeBackgrounded ? all : all.filter((r) => !r.backgrounded);
  const rows = table(runs, { byConnection });
  const refRows = table(runs, { byConnection, refs: true });
  if (csv) {
    console.log(['city', 'network', 'region', 'runs', 'pings', 'median_ms', 'p95_ms', 'jitter_ms', 'loss_pct'].join(','));
    for (const r of [...rows, ...refRows]) console.log([r.city, r.network, r.region, r.runs, r.pings, r.median?.toFixed(1), r.p95?.toFixed(1), r.jitter?.toFixed(1), r.loss?.toFixed(2)].map(csvCell).join(','));
    return 0;
  }
  const skipped = all.length - runs.length;
  console.log(`${runs.length} runs${skipped ? ` (${skipped} run in the background left out: --include-backgrounded)` : ''}${bad ? `, ${bad} unreadable lines` : ''}, from ${files.length} file${files.length === 1 ? '' : 's'}\n`);
  if (!rows.length) return 0;
  console.log(render(['City', 'Network', 'Region', 'Runs', 'Pings', 'Median', 'p95', 'Jitter', 'Loss'], rows.map((r) => [r.city, r.network, r.region, r.runs, r.pings, ms(r.median), ms(r.p95), ms(r.jitter), pct(r.loss)])));
  const h2h = headToHead(rows);
  const regions = [...new Set(rows.map((r) => r.region))].sort((a, b) => REGION_ORDER.indexOf(a) - REGION_ORDER.indexOf(b));
  if (regions.length >= 2) {
    console.log('\nHead to head (median ms; p95 in brackets)\n');
    console.log(
      render(
        ['City', 'Network', 'Faster', ...regions, 'By'],
        h2h.map((g) => [g.city, g.network, g.faster ?? '-', ...regions.map((id) => (g.regions[id] ? `${ms(g.regions[id].median)} (${ms(g.regions[id].p95)})` : '-')), g.by === null ? '-' : `${g.by.toFixed(1)} ms`]),
      ),
    );
    const wins = {};
    for (const g of h2h) if (g.faster) wins[g.faster] = (wins[g.faster] ?? 0) + 1;
    console.log(`\nFaster for: ${Object.entries(wins).map(([id, n]) => `${id} ${n}`).join(', ') || '-'} (of ${h2h.filter((g) => g.faster).length} city × network pairs with both regions)`);
    console.log('\nAll cities, per network\n');
    const perNetwork = table(runs.map((r) => ({ ...r, city: 'All' })), { byConnection });
    console.log(render(['', 'Network', 'Region', 'Runs', 'Pings', 'Median', 'p95', 'Jitter', 'Loss'], perNetwork.map((r) => [r.city, r.network, r.region, r.runs, r.pings, ms(r.median), ms(r.p95), ms(r.jitter), pct(r.loss)])));
  }
  if (refRows.length) {
    console.log('\nOther cities (reference pings: HTTPS round trips to public endpoints, not game servers), with our servers\n');
    const both = [...rows, ...refRows].sort((a, b) => a.city.localeCompare(b.city) || a.network.localeCompare(b.network) || (a.median ?? Infinity) - (b.median ?? Infinity));
    console.log(render(['City', 'Network', 'Where', 'Runs', 'Samples', 'Median', 'p95', 'Loss'], both.map((r) => [r.city, r.network, r.region, r.runs, r.pings, ms(r.median), ms(r.p95), pct(r.loss)])));
  }
  console.log('\nNetworks as typed vs as seen (ASN of the tester’s network)\n');
  for (const { network, asns } of asnsByNetwork(runs)) console.log(`  ${network}: ${asns.map(([a, n]) => `${a} ×${n}`).join(', ')}`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main(process.argv.slice(2));
