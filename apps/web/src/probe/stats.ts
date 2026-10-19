/**
 * The ping probe's logic (probe.html, docs/net-trial.md), kept apart from the DOM so it is tested:
 * the summary of one region's pings, the ping frames, the page's config, the tester's answers and
 * the result it posts. scripts/net-trial/results.mjs pools the raw RTTs with the same definitions.
 */

/** Pings per region per run: 10 s at the game's snapshot rate. */
export const PINGS = 300;
export const PING_HZ = 30;
/** Pings sent first and not counted (TCP and TLS settling in). */
export const WARMUP = 10;
/** How long to wait for the last echoes before a ping counts as lost. */
export const GRACE_MS = 2000;
/** A ping is about the size of a game input message. */
export const PING_BYTES = 32;

export interface Summary {
  sent: number;
  received: number;
  /** ms, the middle of the received RTTs (mean of the two middle ones for an even count) */
  median: number | null;
  /** ms, nearest-rank 95th percentile */
  p95: number | null;
  /** ms, mean absolute difference between consecutive received RTTs (in send order) */
  jitter: number | null;
  /** % of pings with no echo within GRACE_MS */
  loss: number;
  min: number | null;
  max: number | null;
  /** % of received pings slower than 150 ms (where a shooter starts to feel it) */
  over150: number | null;
}

const round1 = (v: number) => Math.round(v * 10) / 10;

/** Nearest-rank percentile of an ascending list. */
export function percentile(sorted: readonly number[], p: number): number | null {
  if (!sorted.length) return null;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1]!;
}

export function median(sorted: readonly number[]): number | null {
  const n = sorted.length;
  if (!n) return null;
  return n % 2 ? sorted[(n - 1) / 2]! : (sorted[n / 2 - 1]! + sorted[n / 2]!) / 2;
}

/** One region's run: `rtts[i]` is ping i's round trip in ms, or null when it never came back. */
export function summarize(rtts: readonly (number | null)[]): Summary {
  const got = rtts.filter((x): x is number => x !== null);
  const sorted = [...got].sort((a, b) => a - b);
  let jitterSum = 0;
  for (let i = 1; i < got.length; i++) jitterSum += Math.abs(got[i]! - got[i - 1]!);
  const med = median(sorted);
  const p95 = percentile(sorted, 95);
  return {
    sent: rtts.length,
    received: got.length,
    median: med === null ? null : round1(med),
    p95: p95 === null ? null : round1(p95),
    jitter: got.length > 1 ? round1(jitterSum / (got.length - 1)) : null,
    loss: rtts.length ? round1(((rtts.length - got.length) / rtts.length) * 100) : 0,
    min: sorted.length ? round1(sorted[0]!) : null,
    max: sorted.length ? round1(sorted[sorted.length - 1]!) : null,
    over150: got.length ? round1((got.filter((x) => x > 150).length / got.length) * 100) : null,
  };
}

/** A ping: its sequence number, then padding to PING_BYTES. */
export function pingFrame(seq: number): ArrayBuffer {
  const buf = new ArrayBuffer(PING_BYTES);
  new DataView(buf).setUint32(0, seq);
  return buf;
}

/** The sequence number in an echo, or null when it isn't one of ours. */
export function echoSeq(data: unknown): number | null {
  if (!(data instanceof ArrayBuffer) || data.byteLength !== PING_BYTES) return null;
  return new DataView(data).getUint32(0);
}

// ---------- reference pings (no servers of ours) ----------

/**
 * Public endpoints in candidate cities, timed from the tester's device for comparison with our own
 * server (the owner's question, 19 Oct 2026: would Europe or Lagos beat Johannesburg for MTN?).
 * Each is a tiny HTTPS response; the page times repeated requests on a warm connection, so a
 * sample is about one round trip (plus the endpoint's few ms of work).
 *   - AWS regions: DynamoDB's health check (`/ping`, ~40 bytes, CORS open): what a game server in
 *     that region would see, give or take the provider. London stands in for Azure UK South,
 *     Spain for Azure Spain Central (blocked on the student plan).
 *   - Lagos: AWS's Lagos Local Zone has no public endpoint, and no big cloud has a Nigerian region.
 *     ixpn.ng is the Internet Exchange Point of Nigeria's own site (AS36940, Lagos), at the exchange
 *     MTN, Airtel and Glo peer at: the best stand-in for a box at a Lagos data centre. nobus.io is
 *     Nobus, a Nigerian cloud (AS328668, Lagos). Neither sends CORS headers, so they're timed as
 *     opaque (no-cors) fetches; their small favicons are fetched.
 *   - Cloudflare's nearest edge: names the city it answered from (LOS = Lagos), the floor of what
 *     this device can reach.
 */
export interface ProbeReference {
  id: string;
  name: string;
  provider: string;
  url: string;
  /** opaque fetch (the endpoint sends no CORS headers) */
  opaque?: boolean;
}

export const REFERENCES: readonly ProbeReference[] = [
  { id: 'lagos-ixpn', name: 'Lagos', provider: 'IXPN, the Nigerian exchange', url: 'https://ixpn.ng/favicon.ico', opaque: true },
  { id: 'lagos-nobus', name: 'Lagos', provider: 'Nobus cloud', url: 'https://nobus.io/favicon.ico', opaque: true },
  { id: 'cf-edge', name: 'Nearest edge', provider: 'Cloudflare', url: 'https://speed.cloudflare.com/cdn-cgi/trace' },
  { id: 'aws-af-south-1', name: 'Cape Town', provider: 'AWS af-south-1', url: 'https://dynamodb.af-south-1.amazonaws.com/ping' },
  { id: 'aws-eu-west-2', name: 'London', provider: 'AWS eu-west-2', url: 'https://dynamodb.eu-west-2.amazonaws.com/ping' },
  { id: 'aws-eu-west-1', name: 'Ireland', provider: 'AWS eu-west-1', url: 'https://dynamodb.eu-west-1.amazonaws.com/ping' },
  { id: 'aws-eu-south-2', name: 'Spain', provider: 'AWS eu-south-2', url: 'https://dynamodb.eu-south-2.amazonaws.com/ping' },
  { id: 'aws-eu-west-3', name: 'Paris', provider: 'AWS eu-west-3', url: 'https://dynamodb.eu-west-3.amazonaws.com/ping' },
  { id: 'aws-eu-central-1', name: 'Frankfurt', provider: 'AWS eu-central-1', url: 'https://dynamodb.eu-central-1.amazonaws.com/ping' },
  { id: 'aws-me-central-1', name: 'UAE', provider: 'AWS me-central-1', url: 'https://dynamodb.me-central-1.amazonaws.com/ping' },
];

/** Requests per reference: the first ones open the connection (DNS, TCP, TLS) and aren't counted. */
export const REF_WARMUP = 3;
export const REF_SAMPLES = 15;
/** A request slower than this counts as lost. */
export const REF_TIMEOUT_MS = 5000;

export interface RefRun {
  rtts: (number | null)[];
  /** the Cloudflare city code that answered (cf-edge only: `colo=` in its body), else '' */
  colo: string;
  error: string;
}

/** A cache-busted URL for one reference request. */
export function refUrl(ref: ProbeReference, n: number): string {
  return `${ref.url}${ref.url.includes('?') ? '&' : '?'}mf=${Date.now().toString(36)}${n}`;
}

/** The city code in a Cloudflare trace body (`colo=LOS`), or ''. */
export function traceColo(body: string): string {
  return /^colo=([A-Z]{3})$/m.exec(body)?.[1] ?? '';
}

/** The references' part of a result: raw round trips and their summary, per reference. */
export function refsPayload(runs: Record<string, RefRun>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [id, run] of Object.entries(runs)) {
    const rtts = run.rtts.map((x) => (x === null ? null : round1(x)));
    const s = summarize(rtts);
    out[id] = { sent: s.sent, rtts, median: s.median, p95: s.p95, min: s.min, loss: s.loss, colo: run.colo, error: run.error };
  }
  return out;
}

export interface ProbeRegion {
  id: string;
  name: string;
  provider: string;
  echo: string;
}
export interface ProbeConfig {
  trial: string;
  regions: ProbeRegion[];
  /** where results go, in order (the Lagos box first, Johannesburg as the fallback) */
  results: string[];
}

/** /probe-config.json (written on each box by the bootstrap), checked; null when unusable. */
export function parseConfig(raw: unknown): ProbeConfig | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const regions = Array.isArray(r.regions)
    ? r.regions.flatMap((x: unknown) => {
        const g = (x ?? {}) as Record<string, unknown>;
        return typeof g.id === 'string' && /^[a-z0-9-]{2,16}$/.test(g.id) && typeof g.echo === 'string' && /^wss?:\/\//.test(g.echo)
          ? [{ id: g.id, name: typeof g.name === 'string' ? g.name : g.id, provider: typeof g.provider === 'string' ? g.provider : '', echo: g.echo }]
          : [];
      })
    : [];
  const results = Array.isArray(r.results) ? r.results.filter((u): u is string => typeof u === 'string' && /^https?:\/\//.test(u)) : [];
  if (!regions.length) return null;
  return { trial: typeof r.trial === 'string' ? r.trial : '', regions, results };
}

export const NETWORKS = [
  { id: 'mtn', label: 'MTN' },
  { id: 'airtel', label: 'Airtel' },
  { id: 'glo', label: 'Glo' },
  { id: '9mobile', label: '9mobile' },
  { id: 'fibre', label: 'Fibre or home broadband' },
  { id: 'starlink', label: 'Starlink' },
  { id: 'other', label: 'Other' },
] as const;
export type NetworkId = (typeof NETWORKS)[number]['id'];

export const CONNECTIONS = [
  { id: 'mobile', label: 'Mobile data (3G/4G/5G)' },
  { id: 'wifi', label: 'Wi-Fi' },
  { id: 'ethernet', label: 'Cable (Ethernet)' },
] as const;

export const DEVICES = ['Android phone', 'iPhone', 'Android tablet', 'iPad', 'Windows PC or laptop', 'Mac', 'Chromebook', 'Linux PC', 'Other'] as const;

/** A first guess at the device from the user agent (only the guess is shown; the agent is never sent). */
export function guessDevice(ua: string): (typeof DEVICES)[number] | '' {
  if (/iPad/.test(ua)) return 'iPad';
  if (/iPhone|iPod/.test(ua)) return 'iPhone';
  if (/Android/.test(ua)) return /Mobile/.test(ua) ? 'Android phone' : 'Android tablet';
  if (/CrOS/.test(ua)) return 'Chromebook';
  if (/Windows/.test(ua)) return 'Windows PC or laptop';
  if (/Macintosh/.test(ua)) return 'Mac';
  if (/Linux/.test(ua)) return 'Linux PC';
  return '';
}

export interface Answers {
  city: string;
  network: NetworkId | '';
  /** the ISP's name for fibre, or the network's name for "other" */
  isp: string;
  connection: string;
  device: string;
  note: string;
}

/** What still needs answering before a run, or '' when the answers will do. */
export function missingAnswer(a: Answers): string {
  if (!a.city.trim()) return 'Which city are you in?';
  if (!a.network) return 'Which network are you on?';
  if ((a.network === 'fibre' || a.network === 'other') && !a.isp.trim()) return a.network === 'fibre' ? "What's the fibre or broadband company called?" : "What's the network called?";
  if (!a.device) return 'Which device is this?';
  return '';
}

export interface RegionRun {
  connectMs: number | null;
  rtts: (number | null)[];
  error: string;
}

/** The JSON posted to the results endpoint: the answers, and per region the raw RTTs and their summary. */
export function resultPayload(
  id: string,
  config: ProbeConfig,
  answers: Answers,
  runs: Record<string, RegionRun>,
  extra: { at: string; page: string; backgrounded: boolean; refs?: Record<string, RefRun> },
) {
  const regions: Record<string, unknown> = {};
  for (const [rid, run] of Object.entries(runs)) {
    // the summary from the RTTs as stored, so results.mjs gets the same numbers from them
    const rtts = run.rtts.map((x) => (x === null ? null : round1(x)));
    const s = summarize(rtts);
    regions[rid] = {
      connectMs: run.connectMs === null ? null : round1(run.connectMs),
      sent: s.sent,
      rtts,
      median: s.median,
      p95: s.p95,
      jitter: s.jitter,
      loss: s.loss,
      error: run.error,
    };
  }
  return {
    id,
    trial: config.trial,
    at: extra.at,
    city: answers.city.trim(),
    network: answers.network,
    isp: answers.isp.trim(),
    connection: answers.connection,
    device: answers.device,
    note: answers.note.trim(),
    page: extra.page,
    backgrounded: extra.backgrounded,
    regions,
    refs: refsPayload(extra.refs ?? {}),
  };
}

/** The region with the lower median and by how much, for the summary line; null if one is missing. */
export function verdict(a: { name: string; s: Summary }, b: { name: string; s: Summary }): { faster: string; slower: string; by: number } | null {
  if (a.s.median === null || b.s.median === null) return null;
  const [f, s] = a.s.median <= b.s.median ? [a, b] : [b, a];
  return { faster: f.name, slower: s.name, by: round1(s.s.median! - f.s.median!) };
}
