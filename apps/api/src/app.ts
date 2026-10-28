/**
 * The API as a Hono app, built from its dependencies so tests run it in-process
 * (`app.request(...)`) against PGlite and the in-memory KV.
 *
 * Middleware order: request id → logger (one line per request, with `reqId`) → secure headers →
 * CORS (allow-list, credentials for the refresh cookie) → origin guard (CSRF) → body limit →
 * routes. Errors become the `{ error: { code, message } }` contract in one place (http/errors.ts).
 */
import { CONTENT_HASH, PROTOCOL_VERSION } from '@military-forge/protocol';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { cors } from 'hono/cors';
import { requestId } from 'hono/request-id';
import { secureHeaders } from 'hono/secure-headers';
import pkg from '../package.json' with { type: 'json' };
import type { SigningKey } from './auth/keys';
import { accountRoutes, safeError } from './auth/accountRoutes';
import { AccountService } from './auth/accounts';
import { createAudit } from './auth/audit';
import { botCheckFor, type BotCheck } from './auth/botCheck';
import { emailSenderFor, type EmailSender } from './auth/email';
import { PasswordHasher } from './auth/passwords';
import { analyticsRoutes, internalAnalyticsRoutes } from './analytics/routes';
import { AnalyticsService } from './analytics/service';
import { authRoutes } from './auth/routes';
import { Throttle } from './auth/throttle';
import { MemoryBus, type EventBus } from './events/bus';
import { eventRoutes } from './events/routes';
import { friendRoutes } from './friends/routes';
import { FriendsService } from './friends/service';
import { PartyService } from './invites/party';
import { inviteRoutes, partyRoutes } from './invites/routes';
import { InviteService } from './invites/service';
import { AuthService } from './auth/sessions';
import type { Config } from './config';
import type { Database } from './db/client';
import type { AppEnv } from './http/context';
import { ApiError, errorResponse } from './http/errors';
import type { Kv } from './kv/kv';
import type { Logger } from './log';
import { leaderboardRoutes, profileRoutes } from './leaderboards/routes';
import { Leaderboards } from './leaderboards/service';
import { loadoutRoutes } from './loadouts/routes';
import { matchRoutes } from './matches/routes';
import { resultsPublicKey } from './matches/report';
import { PresenceService, mePresenceRoutes, playerPresenceRoute } from './presence/presence';
import { ProfileService } from './me/profiles';
import { meRoutes } from './me/routes';
import { NicknamePolicy } from './nickname/rules';
import { nicknameRoutes } from './nickname/routes';
import { reportRoutes } from './reports/routes';
import { roomRoutes } from './rooms/routes';
import { createStore, type Store } from './store';
import { adminStoreRoutes, flutterwaveWebhook, storeRoutes } from './store/routes';

export interface AppDeps {
  config: Config;
  database: Database;
  kv: Kv;
  signingKey: SigningKey;
  /** signs join tickets for the game server (docs/06 §6); null = none (dev) */
  ticketKey?: SigningKey | null;
  log: Logger;
  /** the social push channel's fan-out (events/bus.ts): Valkey pub/sub in production, in memory otherwise */
  bus?: EventBus;
  /** injectable clock (ms) for tests */
  now?: () => number;
  /** account emails; undefined = from config (EMAIL_PROVIDER), null = off */
  email?: EmailSender | null;
  /** Argon2id with the production parameters unless a test passes cheaper ones */
  hasher?: PasswordHasher;
  /** the bot check on account saves and "Forgot password?"; undefined = from config (TURNSTILE_SECRET), null = off */
  botCheck?: BotCheck | null;
  /** work done after an answer has gone (account emails); default: run it, log a failure */
  defer?: (task: () => Promise<void>) => void;
  /** play stats (analytics/service.ts); index.ts makes one and starts its timers, tests make their own */
  analytics?: AnalyticsService;
  /** the store's wallet and payments (store/index.ts); index.ts makes them and runs the sweep, tests pass a fake Flutterwave */
  store?: Store;
}

const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;
const MAX_BODY_BYTES = 16 * 1024;
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function createApp(deps: AppDeps) {
  const { config, database, kv, log } = deps;
  const now = deps.now ?? Date.now;
  const db = database.db;
  const auth = new AuthService(db, deps.signingKey, config, now);
  const store = deps.store ?? createStore(config, db, now, log);
  // what an account owns: the store's inventory plus the owner's COSMETIC_GRANTS (store/wallet.ts)
  const profiles = new ProfileService(db, new NicknamePolicy(config.reservedNicknames), now, (userId) => store.wallet.owned(userId));

  const originAllowed = (origin: string) => (config.corsOrigins === 'localhost' ? LOCAL_ORIGIN.test(origin) : config.corsOrigins.includes(origin));
  const app = new Hono<AppEnv>();

  app.use(requestId());
  app.use(async (c, next) => {
    const started = performance.now();
    c.set('log', log.child({ reqId: c.get('requestId') }));
    c.set('auth', null);
    await next();
    const status = c.res.status;
    c.get('log')[status >= 500 ? 'error' : 'info'](
      { method: c.req.method, path: c.req.path, status, ms: Math.round((performance.now() - started) * 10) / 10 },
      'request',
    );
  });
  app.use(secureHeaders());
  app.use(
    cors({
      origin: (origin) => (originAllowed(origin) ? origin : null),
      credentials: true,
      allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowHeaders: ['Content-Type', 'Authorization', 'X-Request-Id'],
      exposeHeaders: ['X-Request-Id', 'Retry-After'],
      maxAge: 600,
    }),
  );
  // CSRF: browsers send Origin on cross-site POSTs, including HTML forms and "simple" fetches that
  // skip the CORS preflight. Refuse state changes from origins outside the allow-list, so the
  // refresh cookie is safe even with SameSite=None (portal iframes). Non-browser clients send no Origin.
  app.use(async (c, next) => {
    const origin = c.req.header('origin');
    if (origin !== undefined && !SAFE_METHODS.has(c.req.method) && !originAllowed(origin)) {
      return errorResponse(c, 403, 'origin_not_allowed', `Origin ${origin} may not call this API`);
    }
    await next();
  });
  app.use(
    bodyLimit({
      maxSize: MAX_BODY_BYTES,
      onError: (c) => errorResponse(c, 413, 'payload_too_large', `Request body is over ${MAX_BODY_BYTES} bytes`),
    }),
  );

  app.get('/health', async (c) => {
    const [dbUp, kvUp] = await Promise.all([database.ping(), kv.ping()]);
    const ok = dbUp && kvUp;
    return c.json({ ok, db: database.kind, kv: kv.kind, dbUp, kvUp }, ok ? 200 : 503);
  });

  // docs/07 §11. contentHash is the HELLO content hash this build was compiled with, so a client can
  // tell before connecting that its content (tuning) doesn't match the servers' (docs/10 §2.2).
  app.get('/version', (c) =>
    c.json({
      api: pkg.version,
      minClient: config.client.minVersion,
      latest: config.client.latestVersion,
      protocolVersion: PROTOCOL_VERSION,
      contentHash: CONTENT_HASH,
      maintenance: false,
      motd: null,
    }),
  );

  const audit = createAudit(log, config);
  app.route('/auth', authRoutes({ config, db, kv, auth, profiles, now, audit }));
  // saved accounts: email + password (auth/accountRoutes.ts)
  const hasher = deps.hasher ?? new PasswordHasher();
  void hasher.warm();
  const accounts = new AccountService(db, now);
  const defer =
    deps.defer ??
    ((task: () => Promise<void>) => {
      void task().catch((err: unknown) => log.error({ err: safeError(err) }, 'account email work failed'));
    });
  app.route(
    '/auth',
    accountRoutes({
      config,
      db,
      kv,
      auth,
      profiles,
      accounts,
      hasher,
      throttle: new Throttle(kv, now),
      email: deps.email !== undefined ? deps.email : emailSenderFor(config, log),
      audit,
      botCheck: deps.botCheck !== undefined ? deps.botCheck : botCheckFor(config, log),
      defer,
      now,
    }),
  );
  const presence = new PresenceService(kv, now);
  app.route('/me/loadout', loadoutRoutes({ db, kv, auth, now, grants: (userId) => profiles.ownedOf(userId) }));
  app.route('/me/presence', mePresenceRoutes({ auth, kv, presence }));
  const leaderboards = new Leaderboards(db, kv, now);
  app.route('/leaderboards', leaderboardRoutes({ auth, leaderboards }));
  app.route('/players', profileRoutes({ db, auth }));
  // the push channel (GET /events): friends' lists, presence changes, invites, the party
  const bus = deps.bus ?? new MemoryBus();
  const tell = (userIds: readonly string[], event: Parameters<EventBus['publish']>[1]) => {
    for (const id of userIds) void bus.publish(id, event).catch((err: unknown) => log.warn({ err }, 'event not published'));
  };
  const friends = new FriendsService(db, presence, now, (ids) => tell(ids, { type: 'friends' }));
  // a status or room change reaches the player's friends at once (presence stays friends-only)
  presence.onChange(async (userId, p) => tell(await friends.friendIds(userId), { type: 'presence', id: userId, status: p.status, room: p.room }));
  const party = new PartyService(db, kv, bus, now);
  const invites = new InviteService(db, kv, bus, friends, presence, party, now);
  app.route('/events', eventRoutes({ auth, kv, bus, now }));
  app.route('/friends', friendRoutes({ config, kv, auth, friends }));
  app.route('/invites', inviteRoutes({ kv, auth, invites, now }));
  app.route('/party', partyRoutes({ kv, auth, party }));
  app.route('/players', playerPresenceRoute({ auth, presence, areFriends: (a, b) => friends.areFriends(a, b) }));
  // the game server's match results: on only with its public key (RESULTS_PUBLIC_KEY)
  const analytics = deps.analytics ?? new AnalyticsService(db, kv, config.analytics, log, now);
  if (config.resultsPublicKeyPem) {
    const key = resultsPublicKey(config.resultsPublicKeyPem);
    app.route('/internal', matchRoutes({ db, key, leaderboards, now }));
    // the game server's per-match play stats (docs/16 §3.2), signed with the same key
    app.route('/internal/analytics', internalAnalyticsRoutes({ key, analytics, now }));
  }
  // play stats: the pages' batches, Delete my data, the segments and the owner's dashboard (docs/16)
  app.route('/analytics', analyticsRoutes({ config, kv, auth, analytics }));
  app.route('/me', meRoutes({ config, db, kv, auth, profiles }));
  app.route('/nicknames', nicknameRoutes({ config, kv, auth, profiles }));
  // problem reports (Send a report, and a failed connection's own): kept 7 days, read by the owner
  app.route('/reports', reportRoutes({ config, kv, now }));
  // the store (docs/17): off without Flutterwave's keys, but the owner's tools and ownership work either way
  const checkPassword = async (userId: string, password: string) => {
    const cred = await accounts.credentialOf(userId);
    return !!cred && (await hasher.verify(cred.passwordHash, password));
  };
  app.route('/store', storeRoutes({ config, db, kv, auth, wallet: store.wallet, payments: store.payments, flutterwave: store.flutterwave, claims: store.claims, checkPassword }));
  if (store.payments && store.flutterwave) app.route('/webhooks', flutterwaveWebhook({ payments: store.payments, flutterwave: store.flutterwave }));
  app.route('/admin/store', adminStoreRoutes({ config, db, wallet: store.wallet, payments: store.payments }));
  app.route('/rooms', roomRoutes({ config, db, kv, auth, profiles, presence, party, ticketKey: deps.ticketKey ?? null, now }));

  app.notFound((c) => errorResponse(c, 404, 'not_found', `No route for ${c.req.method} ${c.req.path}`));
  app.onError((err, c) => {
    if (err instanceof ApiError) {
      for (const [name, value] of Object.entries(err.headers)) c.header(name, value);
      return errorResponse(c, err.status, err.code, err.message, err.extra);
    }
    (c.get('log') ?? log).error({ err }, 'unhandled error');
    return errorResponse(c, 500, 'internal_error', 'Something went wrong', { requestId: c.get('requestId') });
  });

  return app;
}

export type App = ReturnType<typeof createApp>;
