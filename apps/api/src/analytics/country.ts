/**
 * A coarse country for a request (docs/16 §6.1): the only thing play stats keep about where a
 * player is. The address is looked up and dropped; it is never stored or logged with an event.
 *
 * In order: Cloudflare's CF-IPCountry (only when TRUST_PROXY=cloudflare, so a client can't forge
 * it); an IP-range table if the owner installs one (ANALYTICS_GEOIP_CSV: `start,end,CC` lines, e.g.
 * DB-IP's free "IP to Country Lite" CSV, CC BY 4.0); the device's time zone (Africa/Lagos → NG);
 * else '??'. A European time zone without a table gives 'EU' (enough for the consent rules).
 */
import { readFileSync } from 'node:fs';
import { isIPv4, isIPv6 } from 'node:net';

/** EU and EEA states, the UK and Switzerland: analytics there is opt-in whatever the default, and ad counts need a yes (docs/14 §7.4). */
const EUROPE = new Set(
  'AT BE BG HR CY CZ DK EE FI FR DE GR HU IE IT LV LT LU MT NL PL PT RO SK SI ES SE IS LI NO GB CH EU'.split(' '),
);

export function inEurope(country: string): boolean {
  return EUROPE.has(country);
}

/** The zones our players are most likely in, and what they tell us. */
const ZONES: Record<string, string> = {
  'Africa/Lagos': 'NG',
  'Africa/Johannesburg': 'ZA',
  'Africa/Accra': 'GH',
  'Africa/Nairobi': 'KE',
  'Africa/Cairo': 'EG',
  'Africa/Casablanca': 'MA',
  'Africa/Abidjan': 'CI',
  'Africa/Dakar': 'SN',
  'Africa/Kampala': 'UG',
  'Africa/Dar_es_Salaam': 'TZ',
  'Africa/Kigali': 'RW',
  'Africa/Harare': 'ZW',
  'Africa/Lusaka': 'ZM',
  'Africa/Gaborone': 'BW',
  'Africa/Windhoek': 'NA',
  'Africa/Maputo': 'MZ',
  'Africa/Addis_Ababa': 'ET',
  'Africa/Douala': 'CM',
  'Africa/Kinshasa': 'CD',
  'Asia/Kolkata': 'IN',
  'Asia/Calcutta': 'IN',
  'Asia/Dubai': 'AE',
  'Asia/Karachi': 'PK',
  'Asia/Manila': 'PH',
  'Asia/Jakarta': 'ID',
  'America/Sao_Paulo': 'BR',
  'America/Mexico_City': 'MX',
  'America/Toronto': 'CA',
  'America/Vancouver': 'CA',
  'Australia/Sydney': 'AU',
  'Europe/London': 'GB',
  'Europe/Dublin': 'IE',
  'Europe/Berlin': 'DE',
  'Europe/Paris': 'FR',
  'Europe/Madrid': 'ES',
  'Europe/Rome': 'IT',
  'Europe/Amsterdam': 'NL',
  'Europe/Lisbon': 'PT',
  'Europe/Warsaw': 'PL',
  'Europe/Zurich': 'CH',
};

/** The country a time zone stands for; 'EU' for other European zones; '??' when it says too little (the US's zones span countries). */
export function countryFromZone(tz: string | undefined): string {
  if (!tz) return '??';
  const c = ZONES[tz];
  if (c) return c;
  if (tz.startsWith('Europe/') || tz === 'Atlantic/Reykjavik' || tz === 'Atlantic/Canary' || tz === 'Atlantic/Madeira' || tz === 'Atlantic/Azores') return 'EU';
  return '??';
}

interface Range {
  start: bigint;
  end: bigint;
  cc: string;
}

/** An IP-range → country table (sorted, searched by halves). IPv4 and IPv6 in one list: IPv4 as ::ffff:a.b.c.d. */
export class GeoIpTable {
  private constructor(private readonly ranges: Range[]) {}

  get size(): number {
    return this.ranges.length;
  }

  static parse(csv: string): GeoIpTable {
    const ranges: Range[] = [];
    for (const line of csv.split('\n')) {
      const [a, b, cc] = line.trim().replaceAll('"', '').split(',');
      if (!a || !b || !cc || !/^[A-Z]{2}$/.test(cc)) continue;
      const start = ipToBig(a);
      const end = ipToBig(b);
      if (start === null || end === null || end < start) continue;
      ranges.push({ start, end, cc });
    }
    ranges.sort((x, y) => (x.start < y.start ? -1 : x.start > y.start ? 1 : 0));
    return new GeoIpTable(ranges);
  }

  static load(file: string): GeoIpTable {
    return GeoIpTable.parse(readFileSync(file, 'utf8'));
  }

  lookup(ip: string): string | null {
    const n = ipToBig(ip);
    if (n === null) return null;
    let lo = 0;
    let hi = this.ranges.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const r = this.ranges[mid]!;
      if (n < r.start) hi = mid - 1;
      else if (n > r.end) lo = mid + 1;
      else return r.cc;
    }
    return null;
  }
}

const V4_MAPPED = 0xffff00000000n;

/** An address as a 128-bit number (IPv4 mapped into ::ffff:0:0/96), or null. */
export function ipToBig(ip: string): bigint | null {
  const s = ip.trim();
  if (isIPv4(s)) {
    const p = s.split('.').map(Number);
    return V4_MAPPED + BigInt(((p[0]! << 24) >>> 0) + (p[1]! << 16) + (p[2]! << 8) + p[3]!);
  }
  if (!isIPv6(s)) return null;
  const [head, tail] = s.includes('::') ? s.split('::') : [s, null];
  let groups = head ? head.split(':') : [];
  let back = tail !== null && tail ? tail.split(':') : [];
  // a trailing IPv4 part (::ffff:1.2.3.4)
  const last = (tail !== null ? back : groups).at(-1);
  if (last && isIPv4(last)) {
    const v4 = ipToBig(last)! - V4_MAPPED;
    const hex = [(v4 >> 16n).toString(16), (v4 & 0xffffn).toString(16)];
    if (tail !== null) back = [...back.slice(0, -1), ...hex];
    else groups = [...groups.slice(0, -1), ...hex];
  }
  const fill = tail !== null ? Array(8 - groups.length - back.length).fill('0') : [];
  const all = [...groups, ...fill, ...back];
  if (all.length !== 8) return null;
  let n = 0n;
  for (const g of all) n = (n << 16n) + BigInt(parseInt(g || '0', 16));
  return n;
}

export interface CountrySources {
  trustProxy: 'none' | 'cloudflare' | 'xff';
  /** CF-IPCountry, when present */
  cfCountry?: string | undefined;
  ip: string;
  tz?: string | undefined;
  geoip: GeoIpTable | null;
}

/** The request's country (ISO alpha-2), 'EU', or '??'. The address goes no further than this. */
export function resolveCountry(s: CountrySources): string {
  if (s.trustProxy === 'cloudflare' && s.cfCountry && /^[A-Z]{2}$/.test(s.cfCountry) && s.cfCountry !== 'XX' && s.cfCountry !== 'T1') return s.cfCountry;
  const fromTable = s.geoip?.lookup(s.ip);
  if (fromTable) return fromTable;
  return countryFromZone(s.tz);
}
