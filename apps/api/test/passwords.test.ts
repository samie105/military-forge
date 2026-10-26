/** Saved accounts' building blocks: the password rules, Argon2id, the guessing backoff, the email sender and its config. */
import { describe, expect, it } from 'vitest';
import { HttpEmailSender, EMAILS, confirmLink, resetLink } from '../src/auth/email';
import { ARGON2_PARAMS, PASSWORD_MAX, PasswordHasher, normalizeEmail, parseEmail, passwordProblem } from '../src/auth/passwords';
import { BACKOFF, emailSubject, lockMsFor } from '../src/auth/throttle';
import { ConfigError, loadConfig } from '../src/config';

describe('password rules', () => {
  it('needs 10 to 128 characters, counted as the player sees them', () => {
    expect(passwordProblem('short pw1')).toBe('too_short');
    expect(passwordProblem('ten chars!')).toBeNull();
    expect(passwordProblem('x'.repeat(PASSWORD_MAX - 1) + 'y')).toBeNull();
    expect(passwordProblem('xy'.repeat(65))).toBe('too_long');
    // 10 emoji are 10 characters (20 UTF-16 units)
    expect(passwordProblem('🙂🎮🔫🚀🪂💥🧨🎯🏆')).toBe('too_short');
    expect(passwordProblem('🙂🎮🔫🚀🪂💥🧨🎯🏆🔥')).toBeNull();
  });

  it('refuses common passwords, whatever the case', () => {
    for (const pw of ['1234567890', 'Password123', 'QWERTYUIOP', 'iloveyou12', 'MilitaryForge']) expect(passwordProblem(pw)).toBe('common');
  });

  it('refuses one short run repeated', () => {
    for (const pw of ['aaaaaaaaaa', '1212121212', 'abcabcabcab', 'XYZxyzxyzx']) expect(passwordProblem(pw)).toBe('repeats');
    expect(passwordProblem('abcdabcdab')).toBeNull(); // a 4-character run is allowed (and rare)
  });

  it('refuses the email itself', () => {
    expect(passwordProblem('Kemi@Example.com', 'kemi@example.com')).toBe('same_as_email');
    expect(passwordProblem('kemi@example.com!', 'kemi@example.com')).toBeNull();
  });
});

describe('emails', () => {
  it('are trimmed and lowercased, one form for storing, looking up and limiting', () => {
    expect(normalizeEmail('  Kemi.Ade@Example.COM \n')).toBe('kemi.ade@example.com');
    expect(parseEmail(' Kemi@Example.com ')).toBe('kemi@example.com');
    expect(parseEmail('not an email')).toBeNull();
    expect(parseEmail(`${'a'.repeat(250)}@x.io`)).toBeNull();
    expect(emailSubject('kemi@example.com')).toBe(emailSubject(normalizeEmail(' KEMI@example.com')));
    expect(emailSubject('kemi@example.com')).not.toContain('kemi');
  });
});

describe('PasswordHasher (Argon2id)', () => {
  const hasher = new PasswordHasher();

  it('stores an Argon2id PHC string with the production parameters and its own salt', async () => {
    const a = await hasher.hash('correct horse battery');
    const b = await hasher.hash('correct horse battery');
    expect(a).toMatch(new RegExp(`^\\$argon2id\\$v=19\\$m=${ARGON2_PARAMS.memoryCost},t=${ARGON2_PARAMS.timeCost},p=${ARGON2_PARAMS.parallelism}\\$`));
    expect(a).not.toBe(b);
    expect(a).not.toContain('correct horse');
    expect(await hasher.verify(a, 'correct horse battery')).toBe(true);
    expect(await hasher.verify(a, 'correct horse batterY')).toBe(false);
    expect(hasher.needsRehash(a)).toBe(false);
  });

  it('never throws on a hash it cannot read, and the dummy check is always false', async () => {
    expect(await hasher.verify('not a hash', 'whatever123')).toBe(false);
    expect(await hasher.verifyDummy('whatever123')).toBe(false);
  });

  it('says when a stored hash used other parameters', async () => {
    const cheap = await new PasswordHasher({ memoryCost: 8192, timeCost: 1, parallelism: 1 }).hash('correct horse battery');
    expect(hasher.needsRehash(cheap)).toBe(true);
    expect(await hasher.verify(cheap, 'correct horse battery')).toBe(true);
  });
});

describe('guessing backoff', () => {
  it('is free for a few misses, then doubles from 1 s up to 15 minutes', () => {
    const r = BACKOFF.account;
    expect([1, 5].map((n) => lockMsFor(r, n))).toEqual([0, 0]);
    expect([6, 7, 8, 9].map((n) => lockMsFor(r, n))).toEqual([1000, 2000, 4000, 8000]);
    expect(lockMsFor(r, 100)).toBe(15 * 60_000);
    expect(lockMsFor(BACKOFF.ip, 20)).toBe(0);
    expect(lockMsFor(BACKOFF.ip, 21)).toBe(1000);
  });
});

describe('HttpEmailSender', () => {
  it('posts a Resend-style request with the key as a bearer token', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const sender = new HttpEmailSender({ apiUrl: 'https://mail.example/emails', apiKey: 're_test_key', from: 'Military Forge <no-reply@example.com>' }, async (url, init) => {
      calls.push({ url: String(url), init: init! });
      return new Response('{"id":"x"}', { status: 200 });
    });
    await sender.send(EMAILS.reset('kemi@example.com', resetLink('https://play.example', 't_x.y')));
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://mail.example/emails');
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe('Bearer re_test_key');
    const body = JSON.parse(String(calls[0]!.init.body)) as Record<string, unknown>;
    expect(body).toMatchObject({ from: 'Military Forge <no-reply@example.com>', to: ['kemi@example.com'], subject: 'Reset your Military Forge password' });
    expect(String(body.text)).toContain('https://play.example/#reset=t_x.y');
  });

  it("fails with the status only (the provider's answer may echo the address)", async () => {
    const sender = new HttpEmailSender({ apiUrl: 'https://mail.example/emails', apiKey: 're_test_key', from: 'a@b.c' }, async () => new Response('bad address kemi@example.com', { status: 422 }));
    await expect(sender.send(EMAILS.confirm('kemi@example.com', confirmLink('https://play.example', 't')))).rejects.toThrow(/^email provider answered 422$/);
  });

  it('escapes the link in the HTML part', () => {
    const m = EMAILS.reset('a@b.c', 'https://x.example/#reset="><script>');
    expect(m.html).not.toContain('<script>');
  });
});

describe('email config', () => {
  it('is off without EMAIL_PROVIDER, and the app URL defaults to the first CORS origin', () => {
    expect(loadConfig({ NODE_ENV: 'test' }).email).toBeNull();
    expect(loadConfig({ NODE_ENV: 'test' }).appUrl).toBe('http://localhost:5173');
    expect(loadConfig({ NODE_ENV: 'test', CORS_ORIGINS: 'https://play.example,https://b.example' }).appUrl).toBe('https://play.example');
    expect(loadConfig({ NODE_ENV: 'test', APP_URL: 'https://game.example/' }).appUrl).toBe('https://game.example');
  });

  it('resend needs a key and a sender address; the API URL defaults to Resend', () => {
    expect(() => loadConfig({ NODE_ENV: 'test', EMAIL_PROVIDER: 'resend' })).toThrow(ConfigError);
    const c = loadConfig({ NODE_ENV: 'test', EMAIL_PROVIDER: 'resend', EMAIL_API_KEY: 're_12345678', EMAIL_FROM: 'Military Forge <no-reply@example.com>' });
    expect(c.email).toEqual({ provider: 'resend', apiUrl: 'https://api.resend.com/emails', apiKey: 're_12345678', from: 'Military Forge <no-reply@example.com>' });
  });

  it('refuses the log provider and plain-http links in production', () => {
    const prod = {
      NODE_ENV: 'production',
      DATABASE_URL: 'postgres://a:b@localhost/db',
      REDIS_URL: 'redis://localhost:6379',
      ACCESS_TOKEN_PRIVATE_KEY: 'x',
      JOIN_TICKET_PRIVATE_KEY: 'x',
      CORS_ORIGINS: 'http://play.example',
    };
    expect(() => loadConfig({ ...prod, EMAIL_PROVIDER: 'log' })).toThrow(/EMAIL_PROVIDER/);
    expect(() => loadConfig({ ...prod, EMAIL_PROVIDER: 'resend', EMAIL_API_KEY: 're_12345678', EMAIL_FROM: 'a@b.c' })).toThrow(/APP_URL/);
    expect(loadConfig({ ...prod, EMAIL_PROVIDER: 'resend', EMAIL_API_KEY: 're_12345678', EMAIL_FROM: 'a@b.c', APP_URL: 'https://play.example' }).email?.provider).toBe('resend');
  });
});
