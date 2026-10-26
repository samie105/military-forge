/**
 * Settings → Account (desktop and phone): save this soldier with an email and password, sign in on
 * another phone or computer, sign out, change the password, sign out on every device, and the
 * forms an emailed link opens (a new password; finishing a save).
 *
 * The rule for a device that already has an unsaved soldier (apps/api auth/accountRoutes.ts): one
 * with nothing to lose is replaced; one with progress is kept on this device for 30 days, and
 * signing out of the saved account switches back to it. Nothing is ever merged.
 */
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { useStore } from 'zustand';
import { Icon } from '../../ui/Icon';
import { blurAfter } from '../../ui/Screen';
import type { AccountInfo, ParkedGuest } from '../api';
import { useCtl } from '../context';
import type { ShellStore } from '../store';
import { accountErrorText, parkedUntil, passwordHint, passwordLooksOk, signInNotice, startMode, type AccountMode } from './model';
import './account.css';

export type AccountVariant = 'desktop' | 'phone';

/** Starting state, for tests and the static renders (the live panel asks the API). */
export interface AccountPreset {
  mode?: AccountMode;
  info?: AccountInfo | null;
  resetByEmail?: boolean;
  parked?: ParkedGuest | null;
  /** a save waiting for its emailed link */
  sentTo?: string | null;
  done?: string | null;
}

function Row({ variant, label, desc, children, block }: { variant: AccountVariant; label: string; desc?: ReactNode; children?: ReactNode; block?: boolean }) {
  if (variant === 'phone') {
    return (
      <div className={`pm-set${block ? ' pm-set--block' : ''}`}>
        <span className="pm-set__text">
          <b>{label}</b>
          {desc && <span>{desc}</span>}
        </span>
        {children && <div className="pm-set__ctl">{children}</div>}
      </div>
    );
  }
  return (
    <div className={`srow${block ? ' mf-srow--block' : ''}`}>
      <div className="srow__txt">
        <b>{label}</b>
        {desc && <span>{desc}</span>}
      </div>
      {children && <div className="srow__ctrl">{children}</div>}
    </div>
  );
}

function PasswordField({ label, value, onChange, autoComplete, hint, id }: { label: string; value: string; onChange: (v: string) => void; autoComplete: 'current-password' | 'new-password'; hint?: string | null; id: string }) {
  const [shown, setShown] = useState(false);
  return (
    <div className="acct-field">
      <label htmlFor={id}>{label}</label>
      <div className="acct-field__row">
        <input id={id} type={shown ? 'text' : 'password'} value={value} onChange={(e) => onChange(e.target.value)} autoComplete={autoComplete} autoCapitalize="none" autoCorrect="off" spellCheck={false} maxLength={128} required />
        <button type="button" className="btn btn--ghost btn--sm btn--icon" aria-label={shown ? 'Hide password' : 'Show password'} aria-pressed={shown} onClick={() => setShown(!shown)}>
          <Icon name="eye" />
        </button>
      </div>
      {hint && (
        <span className="acct-field__hint" aria-live="polite">
          {hint}
        </span>
      )}
    </div>
  );
}

function EmailField({ value, onChange, id }: { value: string; onChange: (v: string) => void; id: string }) {
  return (
    <div className="acct-field">
      <label htmlFor={id}>Email</label>
      <input id={id} type="email" inputMode="email" value={value} onChange={(e) => onChange(e.target.value)} autoComplete="email" autoCapitalize="none" autoCorrect="off" spellCheck={false} maxLength={254} required />
    </div>
  );
}

export function AccountPanel({ store, variant, preset }: { store: ShellStore; variant: AccountVariant; preset?: AccountPreset }) {
  const ctl = useCtl();
  const profile = useStore(store, (s) => s.profile);
  const screen = useStore(store, (s) => s.screen.name);
  const blocked = screen === 'room' || screen === 'finding';
  const [intent] = useState(() => store.getState().accountIntent);
  const [mode, setMode] = useState<AccountMode>(preset?.mode ?? startMode(intent));
  const token = intent && intent.mode !== 'signin' ? intent.token : '';
  const [info, setInfo] = useState<AccountInfo | null>(preset?.info ?? null);
  const [resetByEmail, setResetByEmail] = useState(preset?.resetByEmail ?? preset?.info?.resetByEmail ?? false);
  const [parked, setParked] = useState<ParkedGuest | null>(preset?.parked ?? null);
  const [sentTo, setSentTo] = useState<string | null>(preset?.sentTo ?? null);
  const [done, setDone] = useState<string | null>(preset?.done ?? null);
  const [error, setError] = useState<string | null>(null);
  /** GET /auth/account failed: the summary can't say whether this account is saved */
  const [unreachable, setUnreachable] = useState(false);
  const [busy, setBusy] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [next, setNext] = useState('');

  // what the server says about this account (and whether it can send email)
  const signedIn = profile !== null && !profile.offline;
  useEffect(() => {
    if (preset) return;
    if (intent) store.setState({ accountIntent: null });
    let gone = false;
    setParked(ctl.api.parkedGuest());
    if (signedIn) {
      setUnreachable(false);
      ctl.api.account().then(
        (a) => {
          if (gone) return;
          setInfo(a);
          setResetByEmail(a.resetByEmail);
        },
        () => !gone && setUnreachable(true),
      );
    } else void ctl.api.resetByEmail().then((r) => !gone && setResetByEmail(r));
    return () => {
      gone = true;
    };
    // one load per player signed in; switching forms needs no reload
  }, [signedIn, profile?.nickname]);

  const go = (m: AccountMode) => {
    setMode(m);
    setError(null);
    setPassword('');
    setNext('');
  };

  /** Runs an account call: busy while it's out, its failure in words. */
  const run = (task: () => Promise<void>) => async (e?: FormEvent) => {
    e?.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await task();
    } catch (err) {
      setError(accountErrorText(err));
    } finally {
      setBusy(false);
    }
  };

  const refreshInfo = async () => {
    try {
      setInfo(await ctl.api.account());
    } catch {
      /* the summary keeps what it had */
    }
  };

  const errorLine = error && (
    <p className="acct-msg acct-msg--bad" role="alert">
      <Icon name="warn" size="sm" />
      {error}
    </p>
  );
  const doneLine = done && (
    <p className="acct-msg acct-msg--ok" role="status">
      <Icon name="ok" size="sm" />
      {done}
    </p>
  );
  const cancel = (
    <button type="button" className="btn btn--ghost btn--sm" onClick={blurAfter(() => go('summary'))} disabled={busy}>
      Cancel
    </button>
  );
  const id = (k: string) => `acct-${variant}-${k}`;
  const name = profile?.nickname ?? null;

  let body: ReactNode;
  switch (mode) {
    case 'save':
      body = (
        <form className="acct-form" onSubmit={run(async () => {
          const r = await ctl.saveAccount(email, password);
          if (r === 'check_email') setSentTo(email.trim());
          else setDone('Saved. Sign in with this email on any phone or computer.');
          await refreshInfo();
          go('summary');
        })} noValidate>
          <Row variant={variant} label="Save your account" desc="Sign in on another phone or computer and keep your soldier." block />
          <EmailField id={id('email')} value={email} onChange={setEmail} />
          <PasswordField id={id('pw')} label="Password" value={password} onChange={setPassword} autoComplete="new-password" hint={passwordHint(password, email)} />
          {errorLine}
          <div className="acct-actions">
            <button type="submit" className="btn btn--volt btn--sm" disabled={busy || !email.trim() || !passwordLooksOk(password, email)}>
              <Icon name="lock" />
              Save account
            </button>
            {cancel}
          </div>
        </form>
      );
      break;

    case 'signin': {
      const notice = signInNotice(info, name);
      body = (
        <form className="acct-form" onSubmit={run(async () => {
          const r = await ctl.signIn(email, password);
          setParked(ctl.api.parkedGuest());
          setDone(r.previousGuest === 'kept' && name ? `Signed in as ${r.me.nickname}. ${name} is kept on this device: sign out to switch back.` : `Signed in as ${r.me.nickname}.`);
          await refreshInfo();
          go('summary');
        })} noValidate>
          <Row variant={variant} label="Sign in" desc="With the email and password your account is saved with." block />
          {notice && (
            <p className="acct-msg acct-msg--warn" role="note">
              <Icon name="info" size="sm" />
              {notice}
            </p>
          )}
          <EmailField id={id('email')} value={email} onChange={setEmail} />
          <PasswordField id={id('pw')} label="Password" value={password} onChange={setPassword} autoComplete="current-password" />
          {resetByEmail && (
            <button type="button" className="acct-link" onClick={blurAfter(() => go('forgot'))} disabled={busy}>
              Forgot password?
            </button>
          )}
          {errorLine}
          <div className="acct-actions">
            <button type="submit" className="btn btn--volt btn--sm" disabled={busy || blocked || !email.trim() || !password}>
              <Icon name="user" />
              {notice ? 'Use the saved account' : 'Sign in'}
            </button>
            {cancel}
          </div>
          {blocked && <p className="acct-note">Leave the room first.</p>}
        </form>
      );
      break;
    }

    case 'forgot':
      body = (
        <form className="acct-form" onSubmit={run(async () => {
          await ctl.api.forgotPassword(email);
          setDone(`If ${email.trim()} has a saved account, we've sent it a link. It works for 30 minutes.`);
          go('summary');
        })} noValidate>
          <Row variant={variant} label="Forgot password?" desc="We'll email you a link to choose a new one." block />
          <EmailField id={id('email')} value={email} onChange={setEmail} />
          {errorLine}
          <div className="acct-actions">
            <button type="submit" className="btn btn--volt btn--sm" disabled={busy || !email.trim()}>
              <Icon name="send" />
              Send link
            </button>
            {cancel}
          </div>
        </form>
      );
      break;

    case 'reset':
      body = (
        <form className="acct-form" onSubmit={run(async () => {
          await ctl.api.resetPassword(token, password);
          setDone('Password changed, and every device is signed out. Sign in with the new password.');
          go(signedIn && info?.saved ? 'summary' : 'signin');
        })} noValidate>
          <Row variant={variant} label="Choose a new password" desc="Every device signed in to this account will be signed out." block />
          <PasswordField id={id('pw')} label="New password" value={password} onChange={setPassword} autoComplete="new-password" hint={passwordHint(password)} />
          {errorLine}
          <div className="acct-actions">
            <button type="submit" className="btn btn--volt btn--sm" disabled={busy || !token || !passwordLooksOk(password)}>
              <Icon name="lock" />
              Set new password
            </button>
            {cancel}
          </div>
        </form>
      );
      break;

    case 'confirm':
      body = (
        <form className="acct-form" onSubmit={run(async () => {
          await ctl.api.confirmSave(token);
          setDone('Your account is saved. Sign in with this email on any phone or computer.');
          setSentTo(null);
          await refreshInfo();
          go('summary');
        })} noValidate>
          <Row variant={variant} label="Finish saving your account" desc="This confirms the email you saved your soldier with." block />
          {errorLine}
          <div className="acct-actions">
            <button type="submit" className="btn btn--volt btn--sm" disabled={busy || !token}>
              <Icon name="check" />
              Save my account
            </button>
            {cancel}
          </div>
        </form>
      );
      break;

    case 'password':
      body = (
        <form className="acct-form" onSubmit={run(async () => {
          await ctl.changePassword(password, next);
          setDone('Password changed. Your other devices are signed out.');
          go('summary');
        })} noValidate>
          <Row variant={variant} label="Change password" desc="Your other devices will be signed out." block />
          <PasswordField id={id('cur')} label="Current password" value={password} onChange={setPassword} autoComplete="current-password" />
          <PasswordField id={id('new')} label="New password" value={next} onChange={setNext} autoComplete="new-password" hint={passwordHint(next, info?.email ?? '')} />
          {errorLine}
          <div className="acct-actions">
            <button type="submit" className="btn btn--volt btn--sm" disabled={busy || !password || !passwordLooksOk(next, info?.email ?? '')}>
              <Icon name="lock" />
              Change password
            </button>
            {cancel}
          </div>
        </form>
      );
      break;

    case 'summary':
    default:
      if (!signedIn) {
        body = (
          <>
            <Row variant={variant} label="Have a saved account?" desc="Sign in to get your name, soldier, loadouts, friends and stats on this device.">
              <button type="button" className="btn btn--volt btn--sm" onClick={blurAfter(() => go('signin'))}>
                <Icon name="user" />
                Sign in
              </button>
            </Row>
          </>
        );
      } else if (!info) {
        body = <Row variant={variant} label="Account" desc={unreachable ? "Can't reach the server. Check your connection, then open Account again." : 'Checking your account…'} />;
      } else if (info.saved) {
        body = (
          <>
            <Row variant={variant} label="Saved account" desc={<>Signed in as <b className="acct-email">{info.email}</b>. Sign in with it on any phone or computer.</>} />
            <Row variant={variant} label="Password" desc="Change it here. Your other devices will be signed out.">
              <button type="button" className="btn btn--ghost btn--sm" onClick={blurAfter(() => go('password'))}>
                <Icon name="lock" />
                Change
              </button>
            </Row>
            <Row
              variant={variant}
              label="Sign out"
              desc={parked ? `Switches back to ${parked.nickname}, the unsaved soldier kept on this device until ${parkedUntil(parked).toLocaleDateString()}.` : 'This device only. Your account stays saved.'}
            >
              <button type="button" className="btn btn--ghost btn--sm" disabled={busy || blocked} onClick={blurAfter(run(async () => void (await ctl.signOut(false))))}>
                <Icon name="door-out" />
                {parked ? `Switch to ${parked.nickname}` : 'Sign out'}
              </button>
            </Row>
            <Row variant={variant} label="Sign out everywhere" desc="Every phone and computer signed in to this account, this one too.">
              <button type="button" className="btn btn--ghost btn--sm" disabled={busy || blocked} onClick={blurAfter(run(async () => void (await ctl.signOut(true))))}>
                <Icon name="door-out" />
                Sign out all
              </button>
            </Row>
            {blocked && <p className="acct-note">Leave the room to sign out.</p>}
          </>
        );
      } else {
        body = (
          <>
            {sentTo ? (
              <Row variant={variant} label="Check your email" desc={`We sent a link to ${sentTo}. Open it to finish saving your account. It works for 24 hours.`} />
            ) : (
              <Row variant={variant} label="Save your account" desc="Sign in on another phone or computer and keep your soldier.">
                <button type="button" className="btn btn--volt btn--sm" onClick={blurAfter(() => go('save'))}>
                  <Icon name="lock" />
                  Save
                </button>
              </Row>
            )}
            <Row variant={variant} label="Have a saved account?" desc={info?.hasProgress && name ? `Sign in to use it here. ${name} is kept on this device for 30 days.` : 'Sign in to use it on this device.'}>
              <button type="button" className="btn btn--ghost btn--sm" disabled={blocked} onClick={blurAfter(() => go('signin'))}>
                <Icon name="user" />
                Sign in
              </button>
            </Row>
          </>
        );
      }
  }

  return (
    <div className={`acct acct--${variant}`} data-mode={mode}>
      {mode === 'summary' && doneLine}
      {mode === 'summary' && errorLine}
      {mode !== 'summary' && done && mode === 'signin' && doneLine}
      {body}
    </div>
  );
}
