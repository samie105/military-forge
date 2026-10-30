/**
 * Send a report (Settings, the pause menu) and the one a failed room connection sends by itself:
 * the device's event log (log.ts), its last script errors, the tour's last steps, the device, the
 * browser and the build, to the API (POST /api/reports: kept 7 days, read on the owner's admin page).
 * The only personal things are the in-game name the player picked and the note they may write. WHAT_IS_SENT says so on screen.
 *
 * With the bot check on (the build has VITE_TURNSTILE_SITEKEY; apps/api reports/routes.ts), every
 * report carries a Turnstile token: Send a report's widget gives it; an automatic report asks for one
 * quietly (shell/account/turnstile.ts quietToken) and, when none comes in time, isn't sent (the event
 * log notes it; the player sees nothing).
 */
import { buildId } from 'virtual:title-info';
import { createStore } from 'zustand/vanilla';
import { diag, diagErrors, diagEvents } from './log';
import { metricsFeature } from '../metrics/hooks';
import { botCheckOn, quietToken } from '../shell/account/turnstile';

/** The words under every Send a report: what leaves the device. */
export const WHAT_IS_SENT =
  'What happened in the game on this device (its steps, connection states and errors), your device, browser and screen size, the game’s version, your in-game name and your note. Nothing else. Kept 7 days.';
/** the API's limit on the note (reports/routes.ts) */
export const MAX_NOTE = 500;
/** the API's body limit is 16 KB: a report is cut to fit under this */
export const MAX_REPORT_BYTES = 15_000;
/** a failed connection sends one by itself at most this often */
export const AUTO_EVERY_MS = 10 * 60_000;

export type ReportReason = 'manual' | 'auto';
export interface ReportState {
  /** the last report this page sent: its id (for the owner) and whether it went by itself */
  last: { id: string; at: number; reason: ReportReason } | null;
}
export const reportStore = createStore<ReportState>(() => ({ last: null }));

let nickname: () => string = () => '';
let tour: () => string[] = () => [];
/** Where the in-game name and the tour's last steps come from (main.ts). */
export function setReportSources(sources: { nickname?: () => string; tour?: () => string[] }): void {
  if (sources.nickname) nickname = sources.nickname;
  if (sources.tour) tour = sources.tour;
}

function device() {
  const nav = typeof navigator !== 'undefined' ? navigator : null;
  const standalone = typeof matchMedia === 'function' && (matchMedia('(display-mode: standalone)').matches || matchMedia('(display-mode: fullscreen)').matches);
  return {
    ua: (nav?.userAgent ?? '').slice(0, 400),
    w: typeof innerWidth === 'number' ? innerWidth : 0,
    h: typeof innerHeight === 'number' ? innerHeight : 0,
    dpr: typeof devicePixelRatio === 'number' ? devicePixelRatio : 1,
    standalone: standalone || (nav as (Navigator & { standalone?: boolean }) | null)?.standalone === true,
    touch: (nav?.maxTouchPoints ?? 0) > 0,
    ...(nav?.language ? { lang: nav.language.slice(0, 20) } : {}),
  };
}

/** The report's body, cut (the oldest events first) to fit MAX_REPORT_BYTES, the bot check's token included. */
export function buildReport(reason: ReportReason, context: string, note = '', turnstileToken?: string) {
  const body = {
    reason,
    context: context.slice(0, 80),
    ...(nickname() ? { nickname: nickname().slice(0, 32) } : {}),
    build: String(buildId).slice(0, 40),
    device: device(),
    events: [...diagEvents()],
    errors: [...diagErrors()],
    tour: tour().slice(-40).map((s) => s.slice(0, 160)),
    ...(note.trim() ? { note: note.trim().slice(0, MAX_NOTE) } : {}),
    ...(turnstileToken ? { turnstileToken } : {}),
  };
  while (body.events.length > 10 && new TextEncoder().encode(JSON.stringify(body)).length > MAX_REPORT_BYTES) body.events.splice(0, Math.ceil(body.events.length / 10));
  return body;
}

export type SendResult = { ok: true; id: string } | { ok: false; why: 'offline' | 'busy' | 'error' };

/** Sends a report now; `turnstileToken`: the bot check's, when it's on. */
export async function sendReport(reason: ReportReason, context: string, note = '', turnstileToken?: string): Promise<SendResult> {
  diag('report', `${reason}: ${context}`);
  try {
    const res = await fetch('/api/reports', { method: 'POST', credentials: 'omit', headers: { 'content-type': 'application/json' }, body: JSON.stringify(buildReport(reason, context, note, turnstileToken)) });
    if (res.status === 429) return { ok: false, why: 'busy' };
    if (!res.ok) return { ok: false, why: 'error' };
    const { id } = (await res.json()) as { id: string };
    reportStore.setState({ last: { id, at: Date.now(), reason } });
    if (reason === 'manual') metricsFeature('report-sent'); // play stats (docs/16): a player sent one
    return { ok: true, id };
  } catch {
    return { ok: false, why: 'offline' };
  }
}

let lastAuto = -Infinity;
/**
 * A connection that failed for good: a report goes by itself (at most one every 10 minutes). With the
 * bot check on it first asks for a token quietly; without one in time, nothing is sent. Resolves
 * once it's sent or given up (`sent`), for the tests.
 */
export function autoReport(context: string, now = Date.now(), sent?: (ok: boolean) => void): boolean {
  if (now - lastAuto < AUTO_EVERY_MS) return false;
  lastAuto = now;
  void (async () => {
    let token: string | undefined;
    if (botCheckOn) {
      token = (await quietToken('report').catch(() => null)) ?? undefined;
      if (!token) {
        diag('report', `auto: not sent, no bot check token (${context})`);
        sent?.(false);
        return;
      }
    }
    sent?.((await sendReport('auto', context, '', token)).ok);
  })();
  return true;
}
