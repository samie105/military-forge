/**
 * The account audit trail: one log line per sign-in, failed sign-in, save, password change,
 * reset and "sign out everywhere", with `audit: <event>`, the request id and the IP's coarse
 * prefix. Never a password, a token or an email (an email appears only as its hash, the same one
 * the guessing limits key on), so the lines are safe to ship anywhere logs go.
 *
 * Logged at info even when the API's level is higher (the trial box runs at warn), so the trail
 * is always there; `silent` (tests) stays silent.
 */
import type { Context } from 'hono';
import type { Config } from '../config';
import { clientIp, ipPrefix } from '../http/clientIp';
import type { AppEnv } from '../http/context';
import type { Logger } from '../log';

export type AuditEvent =
  | 'login'
  | 'login_failed'
  | 'login_locked'
  | 'login_disabled'
  | 'account_saved'
  | 'save_requested'
  | 'save_refused'
  | 'password_changed'
  | 'password_change_failed'
  | 'reset_requested'
  | 'reset_sent'
  | 'password_reset'
  | 'link_rejected'
  | 'logout_everywhere'
  | 'guest_discarded';

export interface AuditFields {
  userId?: string;
  /** emailSubject() of the email (auth/throttle.ts), never the email itself */
  emailHash?: string;
  [key: string]: string | number | boolean | null | undefined;
}

export type Audit = (c: Context<AppEnv>, event: AuditEvent, fields?: AuditFields) => void;

/** Keys that must never reach the trail, whatever a caller passes. */
const FORBIDDEN = /pass|token|secret|^email$|hash$/i;

export function createAudit(log: Logger, config: Pick<Config, 'trustProxy' | 'trustProxyHops'>): Audit {
  const trail = log.child({ kind: 'audit' }, { level: log.level === 'silent' ? 'silent' : 'info' });
  return (c, event, fields = {}) => {
    const safe: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(fields)) if (v !== undefined && (k === 'emailHash' || !FORBIDDEN.test(k))) safe[k] = v;
    trail.info({ audit: event, reqId: c.get('requestId'), ip: ipPrefix(clientIp(c, config)), ...safe }, `auth ${event}`);
  };
}
