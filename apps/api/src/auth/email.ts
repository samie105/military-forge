/**
 * Sending the account emails (forgot password, confirm the email of a saved account), and their words.
 *
 * Off unless `EMAIL_PROVIDER` is set: then "Forgot password?" is hidden and saving an account
 * links the email at once. Providers:
 * - `resend`: Resend's HTTP API, or any service with the same request (`EMAIL_API_URL`):
 *   `POST {from, to, subject, text, html}` with `Authorization: Bearer EMAIL_API_KEY`.
 * - `log` (development only): writes the email, link included, to the API's log.
 */
import type { Config } from '../config';
import type { Logger } from '../log';

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export interface EmailSender {
  send(message: EmailMessage): Promise<void>;
}

const SEND_TIMEOUT_MS = 10_000;

export class HttpEmailSender implements EmailSender {
  constructor(
    private readonly opts: { apiUrl: string; apiKey: string; from: string },
    private readonly fetchImpl: typeof fetch = (...args) => fetch(...args),
  ) {}

  async send(m: EmailMessage): Promise<void> {
    const res = await this.fetchImpl(this.opts.apiUrl, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.opts.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from: this.opts.from, to: [m.to], subject: m.subject, text: m.text, html: m.html }),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    // the provider's answer body may echo the address; only the status goes in the error
    if (!res.ok) throw new Error(`email provider answered ${res.status}`);
  }
}

/** Development: the email goes to the log instead (config refuses this provider in production). */
export class LogEmailSender implements EmailSender {
  constructor(private readonly log: Logger) {}

  async send(m: EmailMessage): Promise<void> {
    this.log.warn({ to: m.to, subject: m.subject }, `email (EMAIL_PROVIDER=log, not sent):\n${m.text}`);
  }
}

export function emailSenderFor(config: Config, log: Logger): EmailSender | null {
  const e = config.email;
  if (!e) return null;
  if (e.provider === 'log') return new LogEmailSender(log);
  return new HttpEmailSender({ apiUrl: e.apiUrl, apiKey: e.apiKey, from: e.from });
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

function message(to: string, subject: string, lines: string[], link?: { url: string; label: string }): EmailMessage {
  const text = [...lines, ...(link ? ['', `${link.label}: ${link.url}`] : []), '', '— Military Forge'].join('\n');
  const html = [
    ...lines.map((l) => `<p>${escapeHtml(l)}</p>`),
    ...(link ? [`<p><a href="${escapeHtml(link.url)}">${escapeHtml(link.label)}</a></p>`] : []),
    '<p>— Military Forge</p>',
  ].join('\n');
  return { to, subject, text, html };
}

/** The links open the game at its address with the token in the #fragment (never sent to a server). */
export const resetLink = (appUrl: string, token: string) => `${appUrl}/#reset=${token}`;
export const confirmLink = (appUrl: string, token: string) => `${appUrl}/#confirm=${token}`;

export const EMAILS = {
  reset: (to: string, url: string) =>
    message(
      to,
      'Reset your Military Forge password',
      ['Someone asked to reset the password of the Military Forge account saved with this email.', 'The link works once, for 30 minutes. If it wasn’t you, ignore this email: your password stays as it is.'],
      { url, label: 'Choose a new password' },
    ),
  confirm: (to: string, url: string) =>
    message(
      to,
      'Confirm your email for Military Forge',
      ['Open this link to finish saving your soldier with this email. Then you can sign in on any phone or computer.', 'The link works once, for 24 hours. If it wasn’t you, ignore this email.'],
      { url, label: 'Save my account' },
    ),
  /** someone tried to save a soldier with an email that already has an account */
  alreadySaved: (to: string, appUrl: string) =>
    message(
      to,
      'You already have a Military Forge account',
      [
        'Someone tried to save a soldier with this email, but it already has a Military Forge account.',
        'If it was you, sign in with this email instead (Settings, Account). If you forgot the password, use “Forgot password?” there. If it wasn’t you, ignore this email.',
      ],
      { url: appUrl, label: 'Open Military Forge' },
    ),
};
