/**
 * Settings → Account, the parts without React: the words for each answer the API can give, the
 * password hint shown while typing, and which form opens first. The API enforces every rule
 * (apps/api auth/passwords.ts); the hint here only saves a round trip for the obvious ones.
 */
import { ApiError, PARKED_GUEST_DAYS, type AccountInfo, type ParkedGuest } from '../api';
import { OFFLINE_TITLE, STILL_WORKS } from '../offline';
import type { AccountIntent } from '../store';

export type AccountMode = 'summary' | 'save' | 'signin' | 'forgot' | 'reset' | 'confirm' | 'password';

export const PASSWORD_MIN = 10;

/** Why a reason the API gives for a weak password, in plain words. */
const PASSWORD_REASONS: Record<string, string> = {
  too_short: `Use at least ${PASSWORD_MIN} characters`,
  too_long: 'Use at most 128 characters',
  common: 'That password is too common. A short sentence works well.',
  repeats: 'That password just repeats itself',
  same_as_email: "Don't use your email as the password",
};

/** What to tell the player when an account call fails. */
export function accountErrorText(e: unknown): string {
  if (!(e instanceof ApiError)) return 'Something went wrong. Try again.';
  // a 503 of its own: the server is up, Cloudflare's check isn't
  if (e.code === 'bot_check_unavailable') return "Couldn't check you're not a bot just now. Try again in a moment.";
  if (e.offline) return `${OFFLINE_TITLE}. Check your connection and try again. ${STILL_WORKS}`;
  switch (e.code) {
    case 'invalid_credentials':
      return 'The email or password is wrong.';
    case 'too_many_attempts': {
      const s = Number(e.extra.retryAfter) || 1;
      return `Too many tries. Try again in ${s < 90 ? `${s} seconds` : `${Math.ceil(s / 60)} minutes`}.`;
    }
    case 'rate_limited':
      return 'Too many tries. Try again a bit later.';
    case 'weak_password':
      return PASSWORD_REASONS[String(e.extra.reason)] ?? e.message;
    case 'invalid_email':
      return "That doesn't look like an email address.";
    case 'email_unavailable':
      return "That email can't be used. If it's yours, sign in with it instead.";
    case 'already_saved':
      return 'This account is saved already.';
    case 'wrong_password':
      return "That isn't your current password.";
    case 'link_expired':
      return 'This link has expired or was used already. Ask for a new one.';
    case 'account_disabled':
      return 'This account is disabled.';
    case 'in_room':
      return 'Leave the room first.';
    case 'not_available':
      return 'Password reset by email is not available yet.';
    case 'age_required':
      return 'Confirm you are 18 or older, with the year you were born.';
    case 'invalid_birth_year':
      return "That year doesn't look right.";
    case 'underage':
      return 'Military Forge is for players 18 and over, so this account can’t be saved.';
    case 'bot_check_required':
      return "Finish the check that you're not a bot, then try again.";
    case 'bot_check_failed':
      return "The check that you're not a bot didn't pass. Try it again.";
    default:
      return e.message || 'Something went wrong. Try again.';
  }
}

/** The line under a new-password field while typing (null: nothing to say). */
export function passwordHint(password: string, email = ''): string | null {
  if (!password) return `At least ${PASSWORD_MIN} characters`;
  if ([...password].length < PASSWORD_MIN) return `${PASSWORD_MIN - [...password].length} more characters`;
  if (email && password.trim().toLowerCase() === email.trim().toLowerCase()) return PASSWORD_REASONS.same_as_email!;
  return null;
}

/** A new password the hint has no objection to (the API may still refuse a common one). */
export const passwordLooksOk = (password: string, email = '') => [...password].length >= PASSWORD_MIN && passwordHint(password, email) === null;

/** The form Account opens on: an emailed link's, the name screen's sign-in, or the summary. */
export function startMode(intent: AccountIntent | null): AccountMode {
  return intent ? intent.mode : 'summary';
}

/** "Kemi (level 3)" kept on this device: until when it can still be switched back to. */
export function parkedUntil(p: ParkedGuest): Date {
  return new Date(p.parkedAt + PARKED_GUEST_DAYS * 86_400_000);
}

/**
 * The sign-in form's warning when this device has an unsaved soldier with progress: signing in
 * keeps it aside (never merged, never dropped), and the button says what happens.
 */
export function signInNotice(info: AccountInfo | null, nickname: string | null): string | null {
  if (!info || info.saved || !info.hasProgress || !nickname) return null;
  return `${nickname} on this device isn't saved. Signing in switches to your saved account. ${nickname} stays on this device for ${PARKED_GUEST_DAYS} days, so you can switch back.`;
}
