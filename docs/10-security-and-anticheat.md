# 10 — Security, Anti-Cheat & Abuse

> In the browser **the client is fully hostile**: DevTools, userscripts, WebSocket proxies and modified bundles are trivial. There is no kernel driver and no hardware ID. The defence is architecture first, detection second, deterrence third.

---

## 1. Threat model: what cheaters will try, and what stops it

Mod APKs of mobile genre classics were the cheats players knew best: unlimited nitro, unlimited ammo, one-hit kill, and similar. Our server authority makes most of them impossible by design.

| Cheat | How it's done | Our defence | Status |
|---|---|---|---|
| Unlimited jetpack fuel ("nitro hack") | edit client memory/JS | fuel is **simulated on the server** from inputs; the client value is cosmetic | ❌ impossible |
| Unlimited ammo / no reload | edit client state | ammo, reload timers and cooldowns are server-side | ❌ impossible |
| One-hit kill / damage multiplier | edit weapon data | damage computed on the server from server content data (hash-checked) | ❌ impossible |
| Speed hack / fly hack / teleport | edit position, speed up the clock | the server simulates movement from inputs; the input rate is capped at 60/s; ticks too far ahead are rejected | ❌ impossible |
| Rapid fire / macro | spam fire inputs | the server enforces fire rate per weapon. Extra inputs do nothing; excess rate earns strikes | ❌ impossible |
| God mode | ignore damage locally | the server owns HP | ❌ impossible |
| Wallhack / ESP (2D version: see beyond the screen) | render hidden entities | **AOI culling:** the server only sends entities inside your weapon's max zoom view rect + margin; out-of-view gunfire comes as coarse 4 m audio events | ✅ mitigated |
| Zoom hack | change the camera | same AOI. Nothing beyond your legit view exists on your client | ✅ mitigated |
| Aimbot / triggerbot | read the entities you're sent and compute aim | **cannot be prevented** in a browser. Detect statistically (§3) + report + replay review | ⚠️ detect |
| Fake lag / backtracking | delay or throttle packets to exploit lag comp | rewind capped at 300 ms (200 ms of latency on top of the 100 ms interpolation delay; low-bandwidth mode's wider 367 ms only after 1 s in that mode); input-arrival anomalies are flagged | ✅ bounded |
| Packet editing (invalid values) | modify inputs | strict decoders, range clamps, strikes → disconnect | ✅ |
| Spawning items / currency | call the API directly | all grants are server-side; purchases come only from verified webhooks; the ledger is append-only | ✅ |
| XP farming in custom rooms | AFK rooms with friends/bots | custom rooms give no ranked/missions credit and capped XP; AFK detection | ✅ |
| Win trading / teaming in solos | collusion | heuristics (08-battle-royale §12) + reports | ⚠️ detect |
| Multi-accounting / smurfing | new guest accounts | ranked gating (level 15 + 10 wins), fast MMR correction | ⚠️ mitigate |
| Bot farms (rewarded ads, sign-ups) | scripted clients | Cloudflare Turnstile on risky endpoints (built: saving an account, "Forgot password?", sign-in after 3 wrong passwords and problem reports, §6); reward grants are server-side with a nonce + daily caps | ✅ |
| Account takeover | credential stuffing, phishing | passkeys/OAuth preferred, breached-password check, new-device alerts, rate limits, session revoke-all | ✅ |
| DDoS on game servers | UDP/TCP floods | provider DDoS protection + per-IP connection limits + allocation behind tickets (server IPs aren't discoverable without one) | ✅ (see 09-infra) |

---

## 2. Architectural defences (non-negotiable)

1. **Inputs only.** Clients send buttons + aim + ticks. Never positions, hits, damage, or "I picked up X".
2. **Server-authoritative content.** The server loads its own `content.bin`. The client's `contentHash` must match to connect, but its data is never trusted.
3. **Validation on every message** (05-netcode §14): sizes, ranges, rates, tick windows.
4. **Least knowledge:** AOI culling, no enemy HP for out-of-view players, no "isBot" leakage, no other players' loadouts beyond cosmetics.
5. **Signed join tickets** (Ed25519, 30 s TTL, single-use `jti`). Game servers trust nothing else.
6. **API hardening:** authN on everything, per-user + per-IP rate limits (Redis token buckets), zod validation, idempotency keys on economy endpoints, append-only ledger, optimistic locking on wallets.
7. **Secrets:** no secrets in the client bundle; per-environment keys in a secret manager; key rotation runbook.

---

## 3. Detection (statistical, server-side, offline-friendly)

Each match produces per-player feature vectors (computed by the game server, written with the match results):

| Feature | Why |
|---|---|
| Angular velocity of aim in the 100 ms **before** each shot vs. after | aimbots "snap" then stop; humans overshoot and correct |
| Time from target becoming visible (entering view rect) → first hit | inhuman reaction times (< 120 ms, consistently) |
| Hit rate vs. distance and target velocity | distribution outliers per skill band |
| Headshot ratio by weapon | |
| Aim on targets at the **edge of the view rect** (just entered) | ESP-assisted pre-aiming |
| Tracking smoothness (jerk / second derivative of aim) | bots are too smooth or perfectly linear |
| Input timing entropy (fire-press intervals) | macros are too regular |
| Network: input arrival jitter vs. reported RTT | fake lag |

Pipeline:
1. A **per-match anomaly score** (z-scores vs. skill band) is written with the results.
2. A **rolling account score** over the last 20 matches (one weird match is luck; twenty is a pattern).
3. Thresholds lead to: `watch` → **auto-attach replays to a review queue** → human review in admin (watching the server replay with the overlays: view rect, aim trace, reaction markers).
4. Confirmed → sanction (§4). False-positive tuning uses a labelled set of confirmed cheaters + top legit players (pros will look "inhuman" too, so always require human review before a ban).

Never ban on a single heuristic event, and never reveal which signal triggered (that just feeds cheat developers).

---

## 4. Sanctions

| Level | Action |
|---|---|
| Warn | notification with reason |
| Chat mute | 1 h → 24 h → 7 d (automatic for toxicity escalation) |
| Matchmaking cooldown | for leavers/AFK: 5 min → 30 min → 24 h |
| **Shadow pool** | suspected cheaters only matchmake with other suspected cheaters. The cheat developer gets no clear feedback |
| Temporary ban | 3 d / 14 d |
| Permanent ban | account + linked identities + payment fingerprint token |
| Name reset | offensive nickname → random name + cooldown |

**Ban evasion on the web** (no HWID): a layered stack: account → linked OAuth identities → payment instrument token → IP/ASN (**careful**: carrier-grade NAT means thousands of players in India/Nigeria can share a mobile IP, so IP bans must be short and narrow) → a soft device fingerprint, used **only for security/fraud** and disclosed in the privacy policy, with a documented legitimate-interest assessment. Never used for ads or analytics.

**Appeals:** a form in the account page. Each sanction carries a stated reason (EU DSA Art. 17 "statement of reasons"), gets human review within a target SLA, and evidence is kept for the appeal window.

---

## 5. Deterrence & raising the cost (not a defence on its own)

- Production bundle: minified + mangled, no public source maps (uploaded privately to Sentry), and message IDs/field order **rotated per build**.
- Optional: compile the client-side sim/netcode to WASM (Rust or AssemblyScript) post-launch. It's harder to hook than JS.
- Light integrity checks (detecting a modified bundle, injected globals, overridden WebSocket prototypes) **only feed the risk score**. They are spoofable, so never trust them, never ban on them alone.
- Treat known cheat scripts like viruses: when one is found, reproduce it, add a detection, and **ban in waves** (delayed bans hurt cheat sellers more than instant ones).
- Ranked/competitive could later require a native wrapper (Tauri/Electron) with stronger integrity. The community reports Krunker is heading that way for ranked. Keep that door open, but don't plan on it.

---

## 6. Web & infrastructure security checklist

- [ ] HTTPS only, HSTS preload, TLS 1.2+ (1.3 preferred)
- [ ] CSP (strict `script-src` with hashes/nonces; `connect-src` limited to our API/game/social domains; `frame-ancestors` allowing the portals we ship to)
- [ ] COOP/COEP (planned for SharedArrayBuffer workers). Check compatibility with portal iframes before enabling
- [ ] Cookies: `Secure; HttpOnly; SameSite=Lax` (`None` only where portal iframes require it, plus CSRF tokens)
- [ ] CORS allow-list
- [ ] Dependency scanning (Dependabot/Renovate + `pnpm audit`), lockfile pinned, SBOM per release
- [ ] Container images: distroless, non-root, read-only FS, minimal capabilities
- [ ] Postgres: least-privilege roles per service, TLS, PITR backups, monthly restore drill
- [ ] Redis: private network only, AUTH, no `KEYS` in prod, `maxmemory-policy` reviewed
- [ ] Admin: SSO + 2FA, IP allow-list or Zero Trust (Cloudflare Access), every action audit-logged
- [ ] Secrets in a manager (Doppler/1Password/SOPS); rotation runbook; no secrets in CI logs
- [ ] Rate limits at the edge (Cloudflare) + in-app (Redis buckets)
- [x] Turnstile on account creation (saving an account, `POST /auth/save`) and password reset (`POST /auth/forgot`): `apps/api/src/auth/botCheck.ts`, on only when the API has `TURNSTILE_SECRET`; the web shows the widget when its build has `VITE_TURNSTILE_SITEKEY` (set both together; `apps/api/.env.example`). It fails closed (503 when Cloudflare can't be reached). Sign-in is asked only once that email or that address has 3 wrong passwords in the throttle's window (auth/throttle.ts; its backoff still covers guessing), and every problem report needs it (`POST /reports`, action `report`): the game's automatic reports get a token quietly or aren't sent (30 Oct)
- [ ] Turnstile on: account linking (OAuth), purchases with risk flags, rewarded-ad claims
- [ ] Webhook signature verification (Stripe/Paystack/Razorpay/Xsolla), idempotency by provider ref
- [ ] Security headers test in CI (e.g. Mozilla Observatory grade A)
- [ ] Incident response runbook: who's on call, how to put the game in maintenance mode, how to rotate keys, breach notification timelines (GDPR 72 h; India DPDP 72 h; NDPA 72 h)
- [ ] Pen test before monetisation launch
- [ ] Bug bounty (small, scoped) after launch

---

## 7. Privacy & children (overlaps with the compliance list in 13-master-checklist §V)

- **The game is 18+** (the owner, 28 Oct 2026). Minors may still try, so the defaults stay safe: quick-chat only, voice off, contextual (non-personalised) paid ads.
- [x] Neutral 18+ step: the birth year (a picker with no default that lists young years too) and "I am 18 or older", before a device's first online room (create, join, watch, a local room; training isn't asked) and on saving an account. The client keeps the answer on the device (`apps/web/src/shell/age.ts`), an under-18 answer included, so the step can't simply be retried; the API refuses a save without it (`age_required`) or with a minor's year (403 `underage`) and keeps only `users.adult_confirmed_at` + `users.birth_year` (migration 0006), never a full date of birth (NDPA data minimisation). A guest's answer stays on the device: the server only sees it when the account is saved.
- [ ] Ask the same before enabling text chat and on account linking (OAuth), when those ship.
- [x] Terms (`apps/web/terms.html`, a draft for the owner's lawyer) and official links (`apps/web/official.html`), linked from Settings → Privacy, the save form, the 18+ step and the privacy note.
- Data minimisation: no real names, no precise location (country from IP only), no contacts upload.
- Data rights: export + delete from the account page; guest data auto-expires.
- Fingerprinting and telemetry are disclosed; analytics consent where required (EU/UK).

---

## 8. Economy and impersonation safeguards (pre-launch, 28 Oct 2026)

Lessons from a viral browser game in our market: a money exploit, accounts taken over because sign-up never checked the email, bot traffic, copy sites and fake APKs selling fake "top-ups", an unofficial crypto token, game cash sold for real money, and an 18+ rule that existed only on paper.

- **The premium currency is closed-loop.** No cash-out, no player-to-player transfer, no trading for money (`terms.html` §3). Every grant goes through the append-only ledger (§2.6); we may reverse balances that bugs or fraud created.
- **Never compensate an outage or bug by minting currency into every account; grant targeted, capped make-goods through the ledger.** A make-good goes only to the accounts the problem touched (from the logs or match records), is capped per account, carries a reason and an idempotency key, and can be reversed like any other ledger entry. A blanket grant inflates the economy, rewards farm accounts, and is exactly the money-printing bug an exploiter looks for.
- **One official site, said loudly.** `official.html` lists the only site and accounts (the owner fills in the TODO(owner) rows), says there is no app-store app yet (every APK is fake), that we never sell on other sites, by DM or to a personal account, that there is no official token, and how to report a fake. It is in the sitemap so it outranks copy sites.
- **Accounts:** an emailed link confirms a saved account's email when email is on (auth/accountRoutes.ts), Argon2id, sign-in backoff, sign out everywhere, and the bot check above.
