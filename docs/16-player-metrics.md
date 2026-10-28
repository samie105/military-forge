# 16 — Player metrics: play stats, the owner's dashboard, consent

> The owner, 26 Oct 2026: "I want to keep metrics of users' behaviour so I can create patterns and data from it, like the top-tier games do, so it can also help our ad engine."

First-party, privacy-first, cheap on one 2-vCPU box. No analytics vendor, no third-party tracking, no fingerprinting, no selling data. This doc is the contract: the event vocabulary (§2), how events travel (§3), how they're stored and what that costs (§4), the dashboard (§5), consent and privacy (§6), the ad segments (§7) and the compliance notes (§8). The player-facing version is the privacy note, `apps/web/privacy.html` (`/privacy.html`); keep the two saying the same thing.

## 1. What is collected, in three tiers

| Tier | What | Who sends it | Consent |
|---|---|---|---|
| **Essential match stats** | per match: mode, map, length, end reason, people and bots; per player: kills, deaths, assists, damage, guns brought, kills and deaths by source, time played, average life, left early (when, phase, rage quit), ping band, reconnects, transport | the game server, signed, once per match | always on: needed to run matches, keep levels and leaderboards, balance weapons and maps |
| **Play stats** ("Help improve the game and personalise house ads") | sessions (device class, input, graphics tier, installed app, arrival, time zone offset), active time, where a session ended, the first-run funnel, features used, local and training matches, input changes | the web client, batched | **opt-in** (Europe always; elsewhere the owner's default, §6.3) |
| **Anonymous counts** | device errors (a route that failed to load, a missing code chunk, the page not starting, script errors, WebGL lost, failed connections), billboard ad delivery (viewable impressions and seconds, saves, visits) | the web client (and `public/boot.js` for a page that never started) | no id of any kind; not sent under Global Privacy Control / Do Not Track; ad counts from Europe only with a yes (docs/14 §7.4) |

Identifiers: the existing guest/account id (pseudonymous) for the first two tiers, and a random session id per page load held in memory only. No IP address is stored (§6.1), no free text is ever accepted, and ad rows never carry the player's id even with a yes.

## 2. The event vocabulary (version 1)

The single source is `packages/shared/src/analytics.ts`; the API validates every event against it (`apps/api/src/analytics/validate.ts`) and drops anything else. Strings are only ids from fixed lists or fixed patterns (`AD_ID`, `PLACE_ID`), never text a player typed.

**Versioning.** `ANALYTICS_VERSION = 1` travels on every batch and match report. Adding a kind or an optional field is compatible (same version). Changing a field's meaning or removing one bumps the version, and the API keeps accepting the old one until no client sends it.

### 2.1 Client events (`POST /analytics/batch`)

Every event carries `k` (kind) and `t` (device epoch ms; the API clamps it to the last 24 h).

| Kind | Fields | Tier |
|---|---|---|
| `session.start` | `n` (this device's session number), `days` (since its first), `input` touch·keyboard·pad, `form` phone·tablet·desktop, `tier` low·medium·high, `installed`, `arrival` direct·invite·app, `tzo` (minutes east of UTC) | play stats |
| `session.active` | `s`: foreground seconds since the last one (sent when the page hides and every 5 min) | play stats |
| `session.end` | `last`: the screen it ended on (landing, title, name, home, finding, lobby, match, results, training, route, settings, error) | play stats |
| `funnel` | `step`: landing → title → name → home → first-match → second-session (each once, in the session it happens) | play stats |
| `feature` | `f`: locker, armory, creator, outfit-saved, tour-finished/skipped/replayed, install-offered/accepted/dismissed, settings, spectate, local-room, room-created, room-joined, invite-opened, report-sent (once per session each) | play stats |
| `input` | `input`: the device changed mid-session | play stats |
| `match.client` | `mode` local·training, `finished`, `won`, `kills`, `deaths`, `s`, `bots` (the server never sees these matches) | play stats |
| `error` | `e` route-failed·chunk-missing·boot-failed·script·webgl-lost·connect-failed, `where` (a route or screen id) | anonymous |
| `ad.view` | `c` creative, `adv` advertiser, `ms` viewable time, `share` (most of the screen it took, ‰): once per creative per match, after one continuous viewable second | anonymous |
| `ad.save` | `c`, `adv`: tap-to-save (the "click") | anonymous |
| `ad.visit` | `c`, `adv`: the player opened the saved ad after the match (the "visit completed") | anonymous |

A batch: `{ v: 1, consent: 'analytics' | 'none', sid: string | null, tz?, build, events: [≤ 50] }`. `sid` is present only with a yes.

### 2.2 Server events (`POST /internal/analytics/match`)

One `MatchStatsReport` per match that reaches its end, from `apps/game-server/src/matchStats.ts`, signed with the game server's results key (the same Ed25519 key and token format as match results, docs/07 §12). The API stores it as one `match.end` row and one `match.player` row per player (bots included, with no id).

`match.end`: `mode` ffa·team2·team3·team4, `map`, `room` code·default, `startedAt`, `endedAt`, `durationS`, `reason`, `humans`, `bots`.
`match.player`: `uid` (null for bots and ticketless guests), `bot`, `placement`, `won` (1st, or on the winning team), `kills`, `deaths`, `assists`, `damage`, `damageTaken`, `headshots`, `bestStreak`, `guns` (the pair brought: saved, or the default), `killsBy` / `deathsBy` (weapon id or melee·grenade·mine·gas·world·self), `botKills`, `botDeaths`, `playedS`, `lifeS` (average seconds per life), `left`, `leftAtS`, `leftPhase`, `rage` (left within 15 s of dying), `ping` (lt60·60-120·120-200·200+·unknown, never the figure), `reconnects`, `transport`.

## 3. How events travel

### 3.1 The web client (`apps/web/src/metrics/`)

- `consent.ts`: the choice (`mf.consent.v1`), the API's per-country mode, the browser's GPC/DNT.
- `client.ts`: an in-memory queue; batches of ≤ 50 every 30 s or at 25 waiting, with `fetch(keepalive)` and the access token; when the page hides or closes, `navigator.sendBeacon` (no token; the API maps the session id to the player from an earlier batch, kept 24 h in Valkey). Before the player answers, play-stat events wait in memory (≤ 100) and go only on a yes. With a yes, normal sends wait for the session token so every event is the player's.
- `index.ts`: what it watches (the shell's store, the tour's facts, the install prompt, tap-to-save, errors, route failures via `metrics/hooks.ts`).
- `adViews.ts`: every 200 ms during a match, each lit board in view counts as viewable at ≥ 50 % in view, ≥ 1.5 % of the screen, page visible and focused, no menu over the game (docs/14 §4.6, simplified). **Heavy data is aggregated on the device**: one `ad.view` per creative per match, one `session.active` per 5 minutes.
- The render3d hook is one read-only method, `AdBoards.inView()` (`render3d/ads/boards.ts`).

### 3.2 The game server

`MatchStats` follows the room's match events (the same per-tick walk the results recorder already does) plus joins, leaves and reconnects, and builds the report at the match's end; `ResultsReporter.reportStats` posts it with the results' retries (1 s … 10 min). **Measured tick cost** (`apps/game-server/scripts/bench-match-stats.ts`, 6 rounds × 7,200 ticks, Street Market, 2 people + bots, 372 deaths through the stats): **0.065 µs per tick inside the stats, 0.19 % of a 35 µs tick**; the A/B of whole ticks (34.8 µs with, 35.2 µs without) is within noise. No protocol change.

### 3.3 The API (`apps/api/src/analytics/`)

Requests only validate and queue (`ingest.ts`); a 1 s timer writes queued rows in 500-row INSERTs, match rows first. **Back-pressure:** pressure = max(client queue fill, event-loop lag ÷ 250 ms). From 0.25 the sampled kinds (`SHED_FIRST`: ad views, active-time pings, feature counts) are dropped at random and the survivors weighted (`props.w = 1/share`) so totals stay unbiased; from 0.75 the other client kinds too; at 1 every client row. Match rows are never dropped: a full queue answers 503 and the game server retries. Drops are counted per kind (`ingest.dropped`, shown on the dashboard). Rate limit: 600 batches per IP per 10 min.

## 4. Storage (Postgres; PGlite in dev and tests)

### 4.1 Tables (`drizzle/0005_analytics.sql`, mirrored in `src/db/analytics.ts`)

| Table | Holds | Kept |
|---|---|---|
| `analytics_events` | raw events, append-only, **partitioned by UTC day** (`analytics_events_pYYYYMMDD`), one index (kind, at), no foreign keys | **90 days** (`ANALYTICS_RAW_DAYS`, 7–400): whole partitions are dropped, no vacuum debt |
| `analytics_hourly` | anonymous counts per hour (events by kind, errors, drops) | 35 days |
| `analytics_daily` | anonymous counts per day: every dashboard table (metric, dim, n, sum) | for good (no player in them) |
| `analytics_player_days` | one row per player per day played: consented, sessions, active seconds, matches, finished, left early, rage quits, input, form, tier, local hours played (bitmask), matches by mode, country | 400 days |
| `analytics_players` | first and last day seen (cohorts, new vs returning) | until 400 days inactive |
| `analytics_forget` | players to delete; filled by Delete my data and by a trigger on `users` (deleted, or marked deleted) | until processed |

Maintenance runs in the API process every minute (`service.ts`): make today's and the next two days' partitions, drop the expired ones, process the forget queue, recompute today's and yesterday's rollups every 10 minutes (idempotent: delete + insert per day in one transaction; a forgotten player is never rebuilt), and apply the retention windows once a day.

### 4.2 Measured cost (`apps/api/scripts/bench-analytics.ts`, Postgres 16 in a container capped at 2 CPUs and 1 GB)

- **Writes:** 200,013 events in 500-row batches: **67.7 µs per event, ≈ 14,800 events/s**.
- **Rollup** of that day: **2.8 s** (1,054 rollup rows); the 30-day dashboard query: **15 ms**.
- **Disk:** **≈ 426 bytes per event** (85 MB for the day; the index is 6.7 MB of it).
- **What that means:** 1,000 daily players at ~60 events each ≈ 60k events/day ≈ 4 s of writes and ≈ 26 MB a day; 90 days ≈ 2.3 GB. At 10k daily players, ≈ 23 GB at 90 days: shorten `ANALYTICS_RAW_DAYS` (the rollups keep the trends) or move raw events to a cheaper store.

## 5. The owner's dashboard (`/admin` → Players)

`apps/web/src/admin/analytics.ts`, under the admin token (`GET /analytics/admin/dashboard?days=7|30|90`, `GET /analytics/admin/export/<panel>.csv`, `POST /analytics/admin/rollup` for "Recount now"). Built from the rollups only.

Tiles: today's active players and new, WAU, MAU, D1 and D7 retention, average session, matches, players. Panels (each with CSV): active players per day (new and returning), retention cohorts (D1/D7), the first-run funnel, session length, matches per player, devices (input, size, graphics tier, installed, arrival), weapons (picks, wins, win rate, kills, deaths by), maps, modes, where players quit a match (by minute, rage quits), leaving by phase, last screen before closing, people and bots, ping and reconnects, countries, feature use, **billboard ads by creative** (impressions, viewable seconds, average, saves = CTR, visits after the match, visits ÷ saves), device errors, and the pipeline (stored, dropped). Every row is a count; nothing names a player.

Active players count anyone with a match (essential) or a consented session that day; the funnel, sessions, features and devices count consenting players only.

## 6. Consent and privacy

### 6.1 No addresses

The API resolves a coarse country per request and drops the address (`country.ts`): Cloudflare's `CF-IPCountry` when `TRUST_PROXY=cloudflare`; else an IP-range table if the owner installs one (`ANALYTICS_GEOIP_CSV`, e.g. DB-IP's free country CSV, CC BY 4.0); else the device's time zone (Africa/Lagos → NG; other European zones → "EU"); else `??`. Rate limits still use the address in Valkey with a TTL, as before.

### 6.2 The choice

- **Home, once:** a quiet card with two buttons of equal weight ("No thanks" / "Yes, share") and a Privacy link. Where the default is opt-out it says the stats are on and offers "Turn off" / "OK". On phones it takes the install toast's place for that visit. It never shows over a match, and never under GPC/DNT.
- **Settings → Privacy:** the switch, what is always kept and why, what is counted without an id, how long, the privacy note, and **Delete my data**.
- **Global Privacy Control / Do Not Track:** treated as a no (and they stop the anonymous counts too) unless the player turns the switch on themselves.

### 6.3 Opt-in or opt-out by country

`GET /analytics/config` tells the page: Europe (EU/EEA, UK, CH) is always opt-in; elsewhere `ANALYTICS_CONSENT` (default **opt-in**). Until the API answers, nothing but anonymous counts goes.

### 6.4 Delete my data

`DELETE /analytics/me` queues the player in `analytics_forget`, deletes their day rows at once and their raw events within minutes; the device's event log (`mf.log.v1`) and ad counts go too, and the choice becomes a no. "Also delete my player" calls `DELETE /me` (the account; its stats follow by trigger). Anonymous totals stay (they can't be tied to anyone). The onboarding facts (`mf.facts.v1`) stay on the device: they never leave it and keep the tour from starting over.

## 7. Segments for the house-ad rotation

Computed by the API from the player's **consented** day rows of the last 28 days (`segments.ts`), served at `GET /analytics/segments/me` only when `ANALYTICS_AD_SEGMENTS=1` (off by default):

| Segment | Values | Rule |
|---|---|---|
| `device` | touch · keyboard · pad | the input used most |
| `sessionBand` | short · medium · long | average active time per session: < 10 min, ≤ 30 min, longer |
| `timeOfDay` | morning · afternoon · evening · night | the local hours played most (5–11, 12–16, 17–21, 22–4) |
| `modePref` | ffa · team · local · training | the mode played most |
| `tenure` | new · returning | first seen within 7 days |

The client sets them as the ad context (`render3d/ads/audience.ts`, `setAdContext`) with a yes and the flag on, and clears them on a no. A house creative may list the audiences it suits (`HouseEntry.prefer`, e.g. `["device:touch", "time:evening"]`); each match gives it one extra turn per matching tag (at most 3) **within its advertiser's share**: the advertisers' shares, paid manifests and finance creatives are never weighted. Today no pool entry has `prefer`, so nothing changes until the ad-copy work tags creatives. A weighted rotation differs per viewer, so it isn't the shared beat the paid measurement relies on (docs/14 §4.4): it stays house art only.

## 8. Compliance notes (not legal advice: counsel to confirm the starred items)

**Roles.** The game's operator is the controller; there are no processors beyond the hosting provider (Azure, South Africa North). No data is shared or sold.

**Nigeria (NDPA 2023, GAID 2025).** Lawful bases: contract/legitimate interest for essential match stats and anonymous diagnostics; consent for play stats and personalised house ads (direct-marketing-adjacent). Children: parental consent for minors' data (*whether a game's opt-in toggle needs an age gate*). Registration with the NDPC as a data controller of major importance is likely once accounts grow (docs/14 §7.1). 72 h breach notice.

**South Africa (POPIA).** Conditions for lawful processing: minimality (no IP, no free text, banded ping), purpose specification (§1 table), retention limits (§4.1), openness (the privacy note, s.18), data-subject participation (Delete my data; access and correction on request). Children are under 18 and their personal information needs a competent person's consent (ss.34–35): play stats stay off by default and the note asks under-18s to ask a parent (*an age question may be needed before a yes counts*). Cross-border: data stays in South Africa North.

**EU/UK (GDPR, ePrivacy Art. 5(3), UK GDPR/PECR).** Opt-in always (§6.3); reject as easy as accept (equal buttons, no pre-ticked box); withdrawal in Settings. Children: consent age 13–16 by country (Art. 8). Anonymous ad counts from Europe only with a yes (docs/14 §7.4). Article 13 information is in the privacy note.

**Minors everywhere.** Assume they play (docs/10 §7). No profiling for paid ads (docs/14 rule 6 is unchanged for paid ads); the segments weight house art only, only with a yes, behind a flag.

**Still to do (owner):** a privacy contact email (`PRIVACY_CONTACT` at build time fills the note; until then it points to the in-game report), a record of processing and a short legitimate-interest assessment for the essential tier, counsel on NDPA registration and children's consent (*), and the GeoIP table's licence credit if one is installed.

**Adults only (28 Oct 2026).** The owner made the game 18+. The age question is the 18+ step before a device's first online room and on saving an account (docs/10 §7; apps/web `shell/age.ts`, apps/api `auth/accountRoutes.ts`): the birth year and when, never a date of birth. The privacy note says so and no longer asks under-18s to ask a parent.

## 9. Operating it

- **Env (all optional):** `ANALYTICS_RAW_DAYS=90`, `ANALYTICS_CONSENT=opt-in`, `ANALYTICS_AD_SEGMENTS=false`, `ANALYTICS_GEOIP_CSV=`; `PRIVACY_CONTACT=` at web build time. The live box needs no new env lines: the stats ride the results key the box already has (`scripts/net-trial/data.sh`).
- **Migration:** `0005_analytics` is hand-written (Drizzle can't declare partitions) and kept out of drizzle-kit's schema. Merge order with other migrations matters: Drizzle applies a journal entry only if its `when` is later than the last applied one, so keep the journal's `when` values increasing in merge order.
- **Benches:** `apps/api/scripts/bench-analytics.ts` (write cost, against a throwaway Postgres) and `apps/game-server/scripts/bench-match-stats.ts` (tick cost).
