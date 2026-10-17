/**
 * The client's IP, for rate limits and the session's coarse `ip_prefix`. Proxy headers are only
 * believed when `TRUST_PROXY` says a proxy sets them; otherwise anyone could pick their own IP.
 */
import { getConnInfo } from '@hono/node-server/conninfo';
import type { Context } from 'hono';
import { isIPv4, isIPv6 } from 'node:net';
import type { Config } from '../config';

/**
 * - `cloudflare`: `CF-Connecting-IP`, which Cloudflare overwrites.
 * - `xff`: `X-Forwarded-For` as appended by `hops` trusted proxies (nginx `$proxy_add_x_forwarded_for`,
 *   most load balancers). Only the entry the outermost trusted proxy appended is believed, counted
 *   from the right; everything left of it came from the client and could say anything.
 */
export function clientIp(c: Context, config: Pick<Config, 'trustProxy' | 'trustProxyHops'>): string {
  if (config.trustProxy === 'cloudflare') {
    const ip = c.req.header('cf-connecting-ip')?.trim();
    if (ip) return ip;
  } else if (config.trustProxy === 'xff') {
    const hops = (c.req.header('x-forwarded-for') ?? '')
      .split(',')
      .map((h) => h.trim())
      .filter(Boolean);
    const ip = hops[hops.length - config.trustProxyHops];
    if (ip) return ip;
  }
  try {
    return getConnInfo(c).remote.address ?? 'unknown';
  } catch {
    return 'unknown'; // no socket (in-process test requests)
  }
}

/** The address as 8 hextets, or null when it isn't IPv6. Handles `::`, an embedded IPv4 tail and a `%zone`. */
function ipv6Hextets(ip: string): number[] | null {
  const addr = ip.split('%')[0]!;
  if (!isIPv6(addr)) return null;
  let text = addr;
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (v4) {
    const [a = 0, b = 0, c = 0, d = 0] = v4[1]!.split('.').map(Number);
    text = `${text.slice(0, v4.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head = '', tail = ''] = text.split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const groups = text.includes('::') ? [...left, ...Array<string>(8 - left.length - right.length).fill('0'), ...right] : left;
  return groups.map((h) => parseInt(h, 16));
}

/** IPv4-mapped IPv6 (`::ffff:1.2.3.4`) as plain IPv4, anything else unchanged. */
function unmapV4(ip: string): string {
  return ip.startsWith('::ffff:') && isIPv4(ip.slice(7)) ? ip.slice(7) : ip;
}

/**
 * IPv4 → /24, IPv6 → /48: enough to show "a new device from a different network", without
 * storing the address (docs/10 §7 data minimisation). Carrier-grade NAT makes it coarse anyway.
 */
export function ipPrefix(ip: string): string | null {
  const v4 = unmapV4(ip);
  if (isIPv4(v4)) return `${v4.split('.').slice(0, 3).join('.')}.0/24`;
  const hextets = ipv6Hextets(ip);
  return hextets ? `${hextets.slice(0, 3).map((h) => h.toString(16)).join(':')}::/48` : null;
}

/**
 * The key an IP is rate-limited under. IPv4 is limited per address. IPv6 is limited per /64,
 * the smallest block a host is normally given: one host can use any address inside it, so a
 * per-address limit would not limit it at all.
 */
export function rateLimitSubject(ip: string): string {
  const v4 = unmapV4(ip);
  if (isIPv4(v4)) return v4;
  const hextets = ipv6Hextets(ip);
  return hextets ? `${hextets.slice(0, 4).map((h) => h.toString(16)).join(':')}::/64` : ip;
}

/** {@link rateLimitSubject} of the request's {@link clientIp}. */
export function clientRateLimitKey(c: Context, config: Pick<Config, 'trustProxy' | 'trustProxyHops'>): string {
  return rateLimitSubject(clientIp(c, config));
}
