# apps/api

The control-plane API (docs/06 §6, docs/07 §11): Hono on Node, Drizzle ORM on Postgres, Redis/Valkey for rate limits (and, in Milestone B, the room registry and fleet heartbeats), zod validation, pino logs with request ids.

**Built so far (W3 Milestone A):** guest-first accounts (docs/07 §3), refresh-token sessions, `/me`, nickname rules. Rooms by code, `/r/CODE` links, join tickets and the multi-room game server come in Milestone B.

## Run it

```bash
pnpm dev                                  # from the repo root: web + game-server + api (http://localhost:8787)
pnpm --filter @military-forge/api dev        # just the API
```

No Docker needed: without `DATABASE_URL` the API runs **PGlite** (Postgres 18 compiled to WASM, data in `apps/api/.data/pglite`), and without `REDIS_URL` an **in-memory KV**. Delete `.data/` to start from an empty database.

Production-like, with real Postgres + Valkey from the repo root's `docker-compose.yml`:

```bash
docker compose up -d     # Postgres on localhost:55432, Valkey on localhost:56379
cp apps/api/.env.example apps/api/.env   # then uncomment DATABASE_URL and REDIS_URL
pnpm --filter @military-forge/api dev
```

Migrations run on start (an advisory lock keeps several instances from racing). Every variable is listed in [`.env.example`](.env.example); `NODE_ENV=production` refuses to start without `DATABASE_URL`, `REDIS_URL`, `ACCESS_TOKEN_PRIVATE_KEY` and `CORS_ORIGINS`.

| Command | What |
|---|---|
| `pnpm --filter @military-forge/api start` | run without watch (what a container runs) |
| `pnpm --filter @military-forge/api keygen` | print a new `ACCESS_TOKEN_PRIVATE_KEY` line |
| `pnpm --filter @military-forge/api db:generate` | after editing `src/db/schema.ts`: write the next SQL migration into `drizzle/` |
| `pnpm --filter @military-forge/api db:migrate` | apply migrations without starting the server |
| `DATABASE_URL=postgres://… pnpm --filter @military-forge/api exec tsx scripts/import-pglite.ts <dir>` | copy a PGlite directory's rows into Postgres (both migrated first; rows already there are skipped). The trial box does this once when it moves to Postgres; stop the API first |
| `pnpm --filter @military-forge/api test` | in-process route tests on PGlite + memory KV |
| `TEST_DATABASE_URL=postgres://game:game@localhost:55432/game TEST_REDIS_URL=redis://localhost:56379 pnpm --filter @military-forge/api test --no-file-parallelism` | the same suite on the docker-compose services (**empties the `users` table first**; one file at a time, since they share the database). Each test API gets its own Valkey key prefix, and the steps that fast-forward a TTL run only on the in-memory KV |

## Routes

| Route | Auth | Returns |
|---|---|---|
| `GET /health` | – | `{ ok, db, kv }` (503 when a backend is down) |
| `GET /version` | – | `{ api, minClient, latest, protocolVersion, contentHash, maintenance, motd }` |
| `POST /auth/guest {nickname?}` | – | 201 `Session` + refresh cookie |
| `POST /auth/refresh {refreshToken?}` | refresh cookie or body | `Session` (the refresh token rotates) |
| `POST /auth/logout {refreshToken?}` | cookie, body or Bearer | 204 |
| `POST /auth/logout-all` | Bearer | 204: every session of the user |
| `GET /me` · `PATCH /me {nickname}` · `DELETE /me` | Bearer | `Me` · `Me` · 204 |
| `GET /me/loadout/:slot` · `PUT /me/loadout/:slot {look, guns}` (slots 0–2; the game uses 0) | Bearer | `{ slot, look, guns, updatedAt }` (GET: 404 `no_loadout` when nothing is saved). PUT checks every id against `@military-forge/content`: the item exists, is worn in that slot and is unlocked (starter items, or level items at that level), and the guns are two different non-melee weapons, by id. Otherwise 400 `invalid_loadout` with `issues: [{path, message}]`. 60 saves per 10 min per player |
| `GET /players/:id/profile` (`me` = yourself) | Bearer | `{ id, nickname, xp, level, xpIntoLevel, xpForNextLevel, stats, killsBy, recent }` (docs/07 §12) |
| `GET /leaderboards/:board?period=all\|week&limit=` (boards `xp`, `kills`, `wins`) | Bearer | `{ board, period, periodId, entries: [{rank, userId, nickname, level, score}], me }`, from Valkey `lb:{board}:{period}`, rebuilt from Postgres when empty |
| `POST /internal/matches` | `GameServer <token>` (signed with the game server's results key) | 201 `{ recorded: true, players: [{userId, xpGained, xp, level}] }` · 200 `{ recorded: false }` for a match already recorded · on only with `RESULTS_PUBLIC_KEY` (docs/07 §12) |
| `PUT /me/presence {room?}` · `DELETE /me/presence` · `GET /players/:id/presence` | Bearer | the caller's `{ status, room, lastSeenAt }` · 204 · `{ status: offline\|online\|in_room, room, lastSeenAt }` for yourself and your **friends only** (anyone else: 403 `not_friends`). Valkey `presence:{userId}`, 60 s TTL, 12 beats a minute |
| `GET /friends` | Bearer | `{ code, friends: [{id, nickname, status, room, lastSeenAt, since}], incoming, outgoing, blocked, max }`: your friend code (`7KQ4-M9XP`), friends with their presence (in a match first, then online, offline), requests both ways and your blocks (docs/07 §13). 60 a minute |
| `POST /friends/requests {name} \| {code}` | Bearer | `{ status: 'requested', user }` or `{ status: 'friends', friend }` (they had asked you). 404 `player_not_found`, 400 `cannot_add_self`, 409 `blocked_by_you` / `too_many_requests` (50 waiting) / `friends_full` (200). Lookups by name or code: 20 per 10 min per player, 60 per IP, hits and misses alike |
| `POST /friends/requests/:id/accept` · `POST …/:id/decline` · `DELETE /friends/requests/:id` · `DELETE /friends/:id` | Bearer | `{ friend }` (404 `no_request`) · 204 · 204 (take back yours) · 204 (unfriend, both sides) |
| `POST /friends/blocks {id}` · `DELETE /friends/blocks/:id` · `POST /friends/code` | Bearer | 204 (ends friendship and requests; never told) · 204 · `{ code }` (a new friend code; the old one stops working). Writes: 120 per 10 min |
| `GET /events` | Bearer (header) | Server-Sent Events, the social push channel: `hello`, then `friends`, `presence`, `invite`, `invite_gone`, `invite_answered`, `party` (JSON). Ends with the access token; `: ping` every 20 s; `Cache-Control: no-cache, no-transform`. 4 streams per player, 30 connects a minute |
| `GET /invites` · `POST /invites {to, room?}` · `POST /invites/:id/accept` · `POST /invites/:id/decline` | Bearer | `{ incoming, sent, now }` · 201 `{ invite }` (friends only, 403 `not_friends`; 404 `room_not_found`; 409 `already_in_room`; the same invite again after 5 s) · `{ invite, room, party }` (404 `invite_not_found` once it's run out, after 2 min) · 204 |
| `GET /party` · `POST /party/leave` | Bearer | `{ party: { id, members, max } \| null }` · 204. Accepting an invite joins the inviter's party; the join ticket carries `party` |
| `GET /store` | optional Bearer | `{ enabled: false }` without Flutterwave's keys; else `{ enabled, mode: test\|live, currency, bundles: [{id, brass, bonusPct, price: {NGN, USD}}], items: [{itemId, name, tier, price, fullPrice, upgrade, money, owned}], account: {canBuy, reason: guest\|age\|null, balance: {paid, earned, total}, owned, limits} \| null }`. Prices and balances come only from here (docs/17) |
| `POST /store/claim {itemId, birthYear?, adult?}` | Bearer (guests too) | the launch gift (`STORE_CLAIMABLE`, until `STORE_CLAIM_UNTIL`): `{ owned, already }`, once per account, works with the store's payments off. The device's 18+ answer (`birthYear`, `adult: true`) when the account has none yet: 400 `age_required` / `invalid_birth_year`, 403 `underage`; 404 `not_claimable`, 410 `claim_ended`. An `inventory` row (`promo`) and a `store_audit` line, never currency |
| `POST /store/checkout {bundleId, currency: NGN\|USD}` | Bearer, saved 18+ account | 201 `{ txRef, link }`: Flutterwave's hosted page. 403 `save_account_first` / `adult_required`, 409 `spending_limit` / `wallet_full`, 429 `cool_off`, 502 `provider_error` (nothing charged) |
| `POST /store/checkout/:txRef/confirm {transactionId?}` | Bearer | `{ status: created\|paid\|…, brass, balance }`: the way back from the page (`/?store=return&tx_ref=…&transaction_id=…`); credits only on a server-side verify that matches |
| `POST /store/buy {itemId, expectedPrice}` + `Idempotency-Key` | Bearer, saved 18+ | `{ balance, owned, replay }`. 409 `price_changed` (with `price`), `not_enough_brass`, `already_owned` |
| `GET /store/history` · `POST /store/payments/:txRef/refund` | Bearer | `{ ledger, payments: [{…, refundable}] }` · `{ status: refunded, balance }` (unspent paid currency, 14 days; 409 `brass_spent` / `refund_window`, 502 `refund_failed`: reversed) |
| `GET /store/limits` · `PUT /store/limits {monthlyCapCents, password?}` | Bearer | the monthly limit ($100 default): lower at once; higher (≤ $500) needs the password and waits 72 h |
| `POST /webhooks/flutterwave` | `verif-hash` header = `FLUTTERWAVE_WEBHOOK_HASH` | 200 (401 without the hash). `charge.completed` settles its payment through a verify call |
| `/admin/store/…` (accounts?q=, accounts/:id, grant, adjust, clear-flag, payments/:txRef/refund, flags, reconcile) | `Bearer ADMIN_TOKEN` | the owner's store tools (the admin page's Store); every write needs a `reason` and lands in `store_audit` |
| `GET /nicknames/check?nickname=` | optional Bearer | `{ nickname, valid, available, reason?, suggestions? }` |

`Session = { accessToken, accessTokenExpiresAt, refreshToken, refreshTokenExpiresAt, user: Me }`, `Me = { id, nickname, isGuest, createdAt, nicknameChangeableAt, level, xp }`. Errors are always `{ error: { code, message, ...extra } }`; the codes and the client flow are in the W3 notes file (`w3-api.md`).

## How auth works

- **Access token:** an Ed25519-signed JWT (`alg: EdDSA`, `{sub, sid}`, 15 min), sent as `Authorization: Bearer`. Each request also checks that the session is live, so logout, logout-all, deletion and bans apply at once.
- **Refresh token:** `<sessionId>.<secret>`, single use, stored only as sha256 hashes. It is set as an httpOnly `refresh_token` cookie (Path=/auth, SameSite=Lax, Secure in production) **and** returned in the body for the `localStorage` fallback inside portal iframes. Presenting an already-rotated token more than 30 s after its rotation is treated as theft: the session is revoked. Inside those 30 s it is treated as two tabs racing: nothing rotates and the caller gets the same token the first tab got (the next secret is an HMAC of the presented one, so the server can say it again without storing it). Clients keep the token in storage shared by their tabs and re-read it before refreshing.
- **Client IP for rate limits:** the socket address, or with `TRUST_PROXY=cloudflare` CF-Connecting-IP, or with `TRUST_PROXY=xff` the X-Forwarded-For entry `TRUST_PROXY_HOPS` (default 1) from the right. IPv4 is limited per address, IPv6 per /64.
- **CSRF:** a browser request that changes state (POST/PATCH/DELETE) from an `Origin` outside the CORS allow-list gets 403 `origin_not_allowed`, so the cookie stays safe even with `SameSite=None` for portals. Clients without an `Origin` (curl, servers, tests) are unaffected.
- **Why not Better Auth (docs/09 §5):** its anonymous plugin uses its own `user/session/account` schema and cookie sessions. Our data model (docs/06 §7: `users`, `identities`, `profiles` with `nickname_norm`, `sessions`), the body-token fallback for portals and the Ed25519 key that Milestone B's join tickets reuse fit a small implementation better (≈ 300 lines in `src/auth/`). Revisit when OAuth linking lands: Better Auth's OAuth providers could sit behind `/auth/link/{provider}` and write `identities` rows.

## The store (`src/store/`, docs/17)

- **Ledger** (`wallet.ts`): every currency movement is `ledger` rows (append-only: a trigger refuses UPDATE and DELETE, bar an account's deletion cascading) plus the cached `wallets` balance, written together under the wallet row's lock. A pool never goes below zero; its rows sum to its balance (`reconcile()`, the admin page's Reconcile). `(kind, pool, ref)` is unique, so a replay moves nothing. Spending takes earned currency first, then paid. A credit over 5,000 at once (not a purchase) or 12,000 in 24 h flags the wallet (`alarm: 'mint'` in the log).
- **Ownership**: the `inventory` table plus `COSMETIC_GRANTS`: a bought item unlocks exactly like a granted one (the Locker, `/me` `grants`, the loadout check, the join ticket).
- **Payments** (`payments.ts`, `flutterwave.ts`): the server makes the `tx_ref` (the `payments` row's id) and the price; a payment is credited only after `GET /v3/transactions/:id/verify` (or `verify_by_reference`) says `successful` with our tx_ref, currency and at least the amount. The redirect, the webhook and a 5-minute sweep (`index.ts`) all go through the same `created → paid` step. Refunds: the currency comes off, then `POST /v3/transactions/:id/refund`; a refusal reverses it.
- **Limits**: $100 a month by default (USD-tier cents over the last 30 days), 5 purchases a day then a 1 h pause, a 20,000 wallet cap, 18+ saved accounts only.
- **The launch gift** (`claims.ts`): `STORE_CLAIMABLE` items claimed free once per account (guests on their device's 18+ answer, kept on the account; saving the account keeps the item); `GET /store` serves the catalogue for it even with payments off (`payments: false`).
- **Prices** are in `catalog.ts` (docs/17 §2.3, §3.1); the naira tier is a placeholder until docs/17 Q3.

## Nicknames (`src/nickname/`)

3–16 graphemes (≤ 48 UTF-8 bytes); letters of one script (Latin may mix with one non-lookalike script; never with Cyrillic, Greek or Armenian; Latin letters limited to a–z, accented letters and a short list of real-language extras such as ɓ ɗ ƙ ƴ ɛ ɔ ŋ, so small capitals and IPA lookalikes are rejected), ASCII digits, single spaces and `_ - .`. Uniqueness is on a confusable **skeleton** (case, accents, lookalike letters, `0/o`, `1/l/I`, `rn/m`, separators). A profanity + impersonation filter runs on a leetspeak-folded form with word-, edge- and anywhere-matching to avoid Scunthorpe-style false positives (`Nigeria`, `Assassin`, `Kshitij`, `Badminton`, `Dev` all pass). The word lists in `blocklist.ts` are a starter set and need native-speaker review before launch. Generated guest names look like `SwiftFalcon482`; the first change away from one is free, then one change per 7 days.

## Layout

```
src/index.ts          process entry: config → logger → db + kv → HTTP server
src/app.ts            the Hono app (middleware, routes, error contract); tests call app.request()
src/config.ts         env parsing + validation (zod)
src/db/               Drizzle schema, PGlite/Postgres client, migrations in ../drizzle
src/kv/               Kv interface, in-memory + Redis/Valkey implementations
src/auth/             Ed25519 JWT, keys, sessions/refresh rotation, cookie, middleware, /auth routes
src/me/               profiles service + /me routes
src/nickname/         normal forms, word lists, rules, /nicknames routes
src/http/             request context, errors, client IP, rate limits
```
