/**
 * Settings → Account: what the panel shows in each state (desktop and phone), the words for the
 * API's answers, the client's sign-in / sign-out with the guest kept on this device, the
 * controller's moves, and the emailed links in the address.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Api, ApiError, PARKED_GUEST_DAYS, type AccountInfo, type Me } from '../api';
import { ControllerContext } from '../context';
import { ShellController, accountLinkFrom, type GameHost } from '../controller';
import { TABS } from '../screens/Settings';
import { PHONE_TABS, PhoneSettings } from '../screens/phone/PhoneSettings';
import { createShellStore, type ShellState } from '../store';
import { AccountPanel, type AccountPreset } from './AccountPanel';
import { accountErrorText, passwordHint, passwordLooksOk, signInNotice, startMode } from './model';

const guestInfo = (over: Partial<AccountInfo> = {}): AccountInfo => ({ email: null, saved: false, hasProgress: false, resetByEmail: false, ...over });
const savedInfo = (over: Partial<AccountInfo> = {}): AccountInfo => ({ email: 'kemi@example.com', saved: true, hasProgress: true, resetByEmail: true, ...over });

function render(preset: AccountPreset, state: Partial<ShellState> = {}, variant: 'desktop' | 'phone' = 'desktop') {
  const store = createShellStore({ screen: { name: 'home' }, profile: { nickname: 'Kemi', changeableAt: null, offline: false }, ...state });
  const ctl = { store, api: {} } as unknown as ShellController;
  return renderToStaticMarkup(
    <ControllerContext.Provider value={ctl}>
      <AccountPanel store={store} variant={variant} preset={preset} />
    </ControllerContext.Provider>,
  );
}
/** The words a render reads (markup out, entities back to characters). */
const textOf = (html: string) =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');

describe('Settings → Account (the panel)', () => {
  it('is a tab on desktop and on the phone', () => {
    expect(TABS.map((t) => t.id)).toContain('account');
    expect(PHONE_TABS.map((t) => t.id)).toContain('account');
  });

  it('a guest: "Save your account" with why, and Sign in', () => {
    const t = textOf(render({ info: guestInfo() }));
    expect(t).toContain('Save your account');
    expect(t).toContain('Sign in on another phone or computer and keep your soldier.');
    expect(t).toContain('Have a saved account?');
    expect(t).toContain('Sign in');
  });

  it('the save form: an email field and a new-password field, with the length hint', () => {
    const html = render({ mode: 'save', info: guestInfo() });
    expect(html).toMatch(/<input[^>]*type="email"[^>]*autoComplete="email"|<input[^>]*autocomplete="email"[^>]*type="email"/i);
    expect(html).toMatch(/type="password"[^>]*autoComplete="new-password"|autocomplete="new-password"/i);
    expect(textOf(html)).toContain('At least 10 characters');
    expect(textOf(html)).toContain('Save account');
    // nothing typed yet: the button waits
    expect(html).toMatch(/<button type="submit"[^>]*disabled=""/);
  });

  it('sign-in over an unsaved soldier with progress says it is kept, and the button says "Use the saved account"', () => {
    const t = textOf(render({ mode: 'signin', info: guestInfo({ hasProgress: true }) }));
    expect(t).toContain("Kemi on this device isn't saved. Signing in switches to your saved account. Kemi stays on this device for 30 days, so you can switch back.");
    expect(t).toContain('Use the saved account');
    const plain = textOf(render({ mode: 'signin', info: guestInfo({ hasProgress: false }) }));
    expect(plain).not.toContain("isn't saved");
    expect(plain).toContain('Sign in');
  });

  it('"Forgot password?" only shows when the server can send email', () => {
    expect(textOf(render({ mode: 'signin', info: guestInfo(), resetByEmail: false }))).not.toContain('Forgot password?');
    expect(textOf(render({ mode: 'signin', info: guestInfo(), resetByEmail: true }))).toContain('Forgot password?');
  });

  it('a saved account: its email, Change password, Sign out and Sign out everywhere', () => {
    const t = textOf(render({ info: savedInfo() }));
    for (const s of ['Saved account', 'kemi@example.com', 'Change', 'Sign out', 'Sign out everywhere', 'Sign out all']) expect(t).toContain(s);
    expect(t).not.toContain('Save your account');
  });

  it('a soldier kept by the sign-in: signing out switches back to it', () => {
    const t = textOf(render({ info: savedInfo(), parked: { refreshToken: 'r', nickname: 'Tunde', level: 3, parkedAt: Date.now() } }));
    expect(t).toContain('Switches back to Tunde');
    expect(t).toContain('Switch to Tunde');
  });

  it('sign-in and sign-out wait while in a room', () => {
    const html = render({ info: savedInfo() }, { screen: { name: 'room', code: 'KMTXRA' } });
    expect(textOf(html)).toContain('Leave the room to sign out.');
    expect(html.match(/<button type="button" class="btn btn--ghost btn--sm" disabled=""/g)?.length).toBe(2);
  });

  it('a save waiting for its emailed link says where it went', () => {
    expect(textOf(render({ info: guestInfo(), sentTo: 'kemi@example.com' }))).toContain('We sent a link to kemi@example.com. Open it to finish saving your account.');
  });

  it('a signed-in player waits for the server before being offered anything', () => {
    const t = textOf(render({ info: null }));
    expect(t).toContain('Checking your account');
    expect(t).not.toContain('Save your account');
  });

  it('nobody signed in yet (the name screen): Sign in', () => {
    const t = textOf(render({ info: null }, { profile: null }));
    expect(t).toContain('Have a saved account?');
    expect(t).not.toContain('Save your account');
  });

  it('the emailed links open their forms', () => {
    expect(textOf(render({ mode: 'reset' }))).toContain('Choose a new password');
    expect(textOf(render({ mode: 'confirm' }))).toContain('Save my account');
    expect(textOf(render({ mode: 'password', info: savedInfo() }))).toContain('Current password');
  });

  it('uses the phone rows on a phone, the desktop rows on desktop', () => {
    expect(render({ info: guestInfo() }, {}, 'phone')).toContain('pm-set');
    expect(render({ info: guestInfo() }, {}, 'phone')).not.toContain('srow');
    expect(render({ info: guestInfo() })).toContain('srow');
  });

  it('the phone Settings screen shows the Account section without a Reset button', () => {
    const store = createShellStore({ screen: { name: 'home' }, settingsTab: 'account', profile: { nickname: 'Kemi', changeableAt: null, offline: false } });
    const ctl = { store, host: { online: null }, api: { ping: () => Promise.resolve(30) } } as unknown as ShellController;
    const html = renderToStaticMarkup(
      <ControllerContext.Provider value={ctl}>
        <PhoneSettings store={store} />
      </ControllerContext.Provider>,
    );
    expect(textOf(html)).toContain('Account');
    expect(textOf(html)).toContain('Checking your account'); // until GET /auth/account answers
    expect(textOf(html)).not.toContain('Reset Account');
  });
});

describe('account words', () => {
  it('says every API answer in plain words, never which emails exist', () => {
    const e = (code: string, extra: Record<string, unknown> = {}, status = 400) => accountErrorText(new ApiError(status, code, 'x', extra));
    expect(e('invalid_credentials', {}, 401)).toBe('The email or password is wrong.');
    expect(e('too_many_attempts', { retryAfter: 4 }, 429)).toBe('Too many tries. Try again in 4 seconds.');
    expect(e('too_many_attempts', { retryAfter: 900 }, 429)).toBe('Too many tries. Try again in 15 minutes.');
    expect(e('weak_password', { reason: 'common' })).toBe('That password is too common. A short sentence works well.');
    expect(e('link_expired')).toBe('This link has expired or was used already. Ask for a new one.');
    expect(accountErrorText(new ApiError(0, 'network', 'x'))).toContain("Can't reach the server");
  });

  it('hints at the password length while typing', () => {
    expect(passwordHint('')).toBe('At least 10 characters');
    expect(passwordHint('abcdefg')).toBe('3 more characters');
    expect(passwordHint('kemi@example.com', 'Kemi@example.com')).toBe("Don't use your email as the password");
    expect(passwordHint('a long enough one')).toBeNull();
    expect(passwordLooksOk('a long enough one')).toBe(true);
    expect(passwordLooksOk('short')).toBe(false);
  });

  it('warns only for an unsaved soldier with progress', () => {
    expect(signInNotice(guestInfo({ hasProgress: true }), 'Kemi')).toContain('Kemi stays on this device for 30 days');
    expect(signInNotice(guestInfo({ hasProgress: false }), 'Kemi')).toBeNull();
    expect(signInNotice(savedInfo(), 'Kemi')).toBeNull();
    expect(signInNotice(null, 'Kemi')).toBeNull();
    expect(startMode({ mode: 'reset', token: 't' })).toBe('reset');
    expect(startMode(null)).toBe('summary');
  });

  it('reads an emailed link from the #fragment only', () => {
    expect(accountLinkFrom('#reset=t_01abcdefghjkmnpqrstvwxyz0.SECRETsecret_-123')).toEqual({ mode: 'reset', token: 't_01abcdefghjkmnpqrstvwxyz0.SECRETsecret_-123' });
    expect(accountLinkFrom('#confirm=t_x.yyyyyyyyyy')).toEqual({ mode: 'confirm', token: 't_x.yyyyyyyyyy' });
    expect(accountLinkFrom('#about')).toBeNull();
    expect(accountLinkFrom('#reset=<script>')).toBeNull();
  });
});

describe('Api: sign in, sign out and the soldier kept on this device', () => {
  const store = new Map<string, string>();
  beforeEach(() => {
    store.clear();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  const user = (id: string, nickname: string, isGuest: boolean): Me => ({ id, nickname, isGuest, createdAt: '', nicknameChangeableAt: null, level: 2, xp: 10 });
  const session = (n: number, u: Me, extra: Record<string, unknown> = {}) => ({ accessToken: `access-${n}`, accessTokenExpiresAt: new Date(Date.now() + 900_000).toISOString(), refreshToken: `refresh-${n}`, user: u, ...extra });

  function fakeServer(previousGuest: 'kept' | 'discarded' | null) {
    const calls: { url: string; body: unknown; auth?: string }[] = [];
    const guest = user('u_guest', 'Tunde', true);
    const saved = user('u_saved', 'Kemi', false);
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      const headers = (init.headers ?? {}) as Record<string, string>;
      const body = init.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : undefined;
      calls.push({ url, body, auth: headers.authorization });
      if (url.endsWith('/auth/guest')) return new Response(JSON.stringify(session(1, guest)), { status: 201 });
      if (url.endsWith('/auth/login')) return new Response(JSON.stringify(session(2, saved, { previousGuest })), { status: 200 });
      if (url.endsWith('/auth/logout') || url.endsWith('/auth/logout-all')) return new Response(null, { status: 204 });
      if (url.endsWith('/auth/refresh')) return body?.refreshToken === 'refresh-1' ? new Response(JSON.stringify(session(3, guest)), { status: 200 }) : new Response(JSON.stringify({ error: { code: 'invalid_refresh_token', message: 'x' } }), { status: 401 });
      return new Response(JSON.stringify({ error: { code: 'not_found', message: 'x' } }), { status: 404 });
    });
    return { api: new Api('/api', fetchImpl as unknown as typeof fetch), calls };
  }

  it("sends this device's session with the sign-in, and keeps the guest aside when the server kept it", async () => {
    const { api, calls } = fakeServer('kept');
    await api.guest('Tunde');
    const signedIn = vi.fn();
    api.onSignIn(signedIn);
    const r = await api.signIn('kemi@example.com', 'jetpack-sunrise-42');
    expect(calls.at(-1)).toMatchObject({ url: '/api/auth/login', body: { email: 'kemi@example.com', password: 'jetpack-sunrise-42' }, auth: 'Bearer access-1' });
    expect(r.previousGuest).toBe('kept');
    expect(api.me?.id).toBe('u_saved');
    expect(signedIn).toHaveBeenCalledOnce(); // the loadout and friends follow the new player
    expect(store.get('session.refreshToken.v1')).toBe('refresh-2');
    expect(api.parkedGuest()).toMatchObject({ refreshToken: 'refresh-1', nickname: 'Tunde', level: 2 });

    // signing out switches back to it
    const back = await api.signOut();
    expect(calls.some((c) => c.url === '/api/auth/logout' && (c.body as { refreshToken: string }).refreshToken === 'refresh-2')).toBe(true);
    expect(back).toMatchObject({ id: 'u_guest', nickname: 'Tunde' });
    expect(api.parkedGuest()).toBeNull();
  });

  it('a discarded guest is not kept; signing out leaves nobody signed in', async () => {
    const { api, calls } = fakeServer('discarded');
    await api.guest();
    await api.signIn('kemi@example.com', 'jetpack-sunrise-42');
    expect(api.parkedGuest()).toBeNull();
    expect(await api.signOut(true)).toBeNull();
    expect(calls.at(-1)).toMatchObject({ url: '/api/auth/logout-all', auth: 'Bearer access-2' });
    expect(api.me).toBeNull();
    expect(store.has('session.refreshToken.v1')).toBe(false);
  });

  it(`a kept guest can be switched back to for ${PARKED_GUEST_DAYS} days, not after`, async () => {
    const { api } = fakeServer('kept');
    await api.guest();
    await api.signIn('kemi@example.com', 'jetpack-sunrise-42');
    vi.useFakeTimers({ now: Date.now() + PARKED_GUEST_DAYS * 86_400_000 + 1, toFake: ['Date'] });
    expect(api.parkedGuest()).toBeNull();
  });
});

describe('ShellController: account moves', () => {
  function setup(api: Partial<Api>, state: Partial<ShellState> = {}) {
    const host = { local: null, online: null, startTraining: vi.fn(), startOnline: vi.fn(), stop: vi.fn(), applySettings: vi.fn(), setInputBlocked: vi.fn() } as unknown as GameHost;
    const store = createShellStore(state);
    vi.stubGlobal('window', Object.assign(new EventTarget(), { setTimeout, clearTimeout }));
    vi.stubGlobal('location', { pathname: '/', search: '', hash: '', origin: 'https://play.example' });
    vi.stubGlobal('history', { pushState: vi.fn(), replaceState: vi.fn(), state: null });
    const ctl = new ShellController(store, host, api as Api);
    return { store, ctl, host };
  }
  afterEach(() => vi.unstubAllGlobals());
  const kemi: Me = { id: 'u_saved', nickname: 'Kemi', isGuest: false, createdAt: '', nicknameChangeableAt: null, level: 4, xp: 300 };

  it('signing in from the first-visit name screen carries on where it was going, as the saved player', async () => {
    const signIn = vi.fn(async () => ({ me: kemi, previousGuest: null }));
    const { store, ctl } = setup({ signIn }, { screen: { name: 'name', then: { to: 'home' } } });
    ctl.openAccount({ mode: 'signin' });
    expect(store.getState()).toMatchObject({ overlay: 'settings', settingsTab: 'account', accountIntent: { mode: 'signin' } });
    await ctl.signIn('kemi@example.com', 'jetpack-sunrise-42');
    expect(store.getState().profile?.nickname).toBe('Kemi');
    expect(store.getState().screen.name).toBe('home');
    expect(store.getState().overlay).toBeNull();
  });

  it('refuses to switch players in a room', async () => {
    const signIn = vi.fn();
    const { ctl } = setup({ signIn }, { screen: { name: 'room', code: 'KMTXRA' } });
    await expect(ctl.signIn('a@b.c', 'x')).rejects.toMatchObject({ code: 'in_room' });
    await expect(ctl.signOut()).rejects.toMatchObject({ code: 'in_room' });
    expect(signIn).not.toHaveBeenCalled();
  });

  it('signing out with no soldier kept here starts over at the name screen', async () => {
    const { store, ctl, host } = setup({ signOut: vi.fn(async () => null) }, { screen: { name: 'home' }, profile: { nickname: 'Kemi', changeableAt: null, offline: false } });
    ctl.openAccount();
    expect(await ctl.signOut()).toBeNull();
    expect(store.getState()).toMatchObject({ profile: null, overlay: null, screen: { name: 'name', then: { to: 'home' } } });
    expect(host.stop).toHaveBeenCalled();
  });

  it('signing out back to the kept soldier shows its name', async () => {
    const tunde: Me = { ...kemi, id: 'u_guest', nickname: 'Tunde', isGuest: true };
    const { store, ctl } = setup({ signOut: vi.fn(async () => tunde) }, { screen: { name: 'home' }, profile: { nickname: 'Kemi', changeableAt: null, offline: false } });
    await ctl.signOut();
    expect(store.getState().profile?.nickname).toBe('Tunde');
    expect(store.getState().screen.name).toBe('home');
  });
});
