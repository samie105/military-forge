/**
 * The bot check in the forms when the build has a site key (bot check, 30 Oct): Sign in shows it once
 * the server asked for it and keeps it; Send a report always shows it. Turnstile itself is faked (its
 * script never loads in the tests). Without a site key nothing shows: account.test.tsx and
 * age.test.tsx render the forms that way.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('./turnstile', () => ({
  SITEKEY: '1x00000000000000000000AA',
  botCheckOn: true,
  loadTurnstile: () => new Promise(() => {}),
  quietToken: vi.fn(async () => null),
  QUIET_TOKEN_WAIT_MS: 10_000,
}));

const { Api, ApiError } = await import('../api');
const { ControllerContext } = await import('../context');
const { createShellStore } = await import('../store');
const { AccountPanel } = await import('./AccountPanel');
const { asksForBotCheck } = await import('./model');
const { botCheckOn } = await import('./BotCheck');
type Preset = import('./AccountPanel').AccountPreset;
type Ctl = import('../controller').ShellController;

function render(preset: Preset) {
  const store = createShellStore({ screen: { name: 'home' }, profile: { nickname: 'Kemi', changeableAt: null, offline: false } });
  const ctl = { store, api: {} } as unknown as Ctl;
  return renderToStaticMarkup(
    <ControllerContext.Provider value={ctl}>
      <AccountPanel store={store} variant="desktop" preset={preset} />
    </ControllerContext.Provider>,
  );
}
const info = { email: null, saved: false, hasProgress: false, resetByEmail: true };

describe('Sign in, with the bot check on', () => {
  it('the first tries show no check', () => {
    expect(botCheckOn).toBe(true);
    const html = render({ mode: 'signin', info });
    expect(html).not.toContain('acct-bot');
  });

  it('once the server asks for it, the check shows and Sign in waits for it', () => {
    const html = render({ mode: 'signin', info, signInBot: true });
    expect(html).toContain('acct-bot');
    expect(html).toMatch(/<button type="submit"[^>]*disabled=""/);
  });

  it("the server's asking is bot_check_required, or a check that didn't pass", () => {
    expect(asksForBotCheck(new ApiError(400, 'bot_check_required', 'x'))).toBe(true);
    expect(asksForBotCheck(new ApiError(403, 'bot_check_failed', 'x'))).toBe(true);
    expect(asksForBotCheck(new ApiError(401, 'invalid_credentials', 'x'))).toBe(false);
    expect(asksForBotCheck(new ApiError(503, 'bot_check_unavailable', 'x'))).toBe(false);
    expect(asksForBotCheck(new Error('x'))).toBe(false);
  });

  it('the sign-in call carries the token only when there is one', async () => {
    const bodies: Record<string, unknown>[] = [];
    const me = { id: 'u_1', nickname: 'Kemi', isGuest: false, createdAt: '', nicknameChangeableAt: null, level: 1, xp: 0 };
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(init.body as string) as Record<string, unknown>);
      return new Response(JSON.stringify({ accessToken: 'a1', accessTokenExpiresAt: new Date(Date.now() + 900_000).toISOString(), refreshToken: 'r1', user: me, previousGuest: null }), { status: 200 });
    });
    const api = new Api('/api', fetchImpl as unknown as typeof fetch);
    await api.signIn('kemi@example.com', 'jetpack-sunrise-42');
    await api.signIn('kemi@example.com', 'jetpack-sunrise-42', 'tok');
    expect(bodies).toEqual([
      { email: 'kemi@example.com', password: 'jetpack-sunrise-42' },
      { email: 'kemi@example.com', password: 'jetpack-sunrise-42', turnstileToken: 'tok' },
    ]);
  });

  it('save and Forgot password show it from the start, as before', () => {
    expect(render({ mode: 'save', info })).toContain('acct-bot');
    expect(render({ mode: 'forgot', info })).toContain('acct-bot');
  });
});
