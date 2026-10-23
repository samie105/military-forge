# 07 — Rooms, Groups, Matchmaking & Social

> How players find each other: guest identity, parties ("groups"), quick play, custom rooms with codes, the room browser, skill ratings, friends, chat and safety.
> Related: 06-architecture (services, Redis keys) · 08-battle-royale (Drop Zone queue) · 10-security-and-anticheat (abuse).

---

## 1. Vocabulary (use these words everywhere: code, UI, analytics)

| Term | Meaning |
|---|---|
| **Player** | an account (guest or linked) |
| **Party** (UI: "Group") | up to 4 players who stick together *between* matches and queue together. Lives in Redis + social gateway |
| **Room** | one game-server instance running a match (or a lobby waiting for one). Has a mode, map, settings and players |
| **Custom room** | a room created by a player (the host), joinable by **code** / link / browser |
| **Ticket** | a matchmaking request for a player or party |
| **Region** | a game-server location (e.g. `fra`, `bom`, `jnb`, `sin`, `iad`) |

---

## 2. Home screen entry points (desktop first)

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  [Logo]                                   [Coins][Gems]  [Profile ▾] [⚙]    │
│                                                                              │
│   ▶ QUICK PLAY        Deathmatch ▾       (region: Frankfurt 48 ms ▾)         │
│   ▶ DROP ZONE         Solo | Duos | Squads                                   │
│   ▶ CUSTOM ROOMS      Create · Join by code · Browse                         │
│   ▶ TRAINING          Bots · Firing range · Tutorial                         │
│                                                                              │
│  [Character preview, rotating, with equipped cosmetics]   [Customize]        │
│                                                                              │
│  GROUP: [you][+][+][+]   Invite link 🔗   Ready ✓       FRIENDS (3 online) ▸ │
└──────────────────────────────────────────────────────────────────────────────┘
```

Portal rule (CrazyGames/Poki): a first-time visitor must reach gameplay quickly. So the first visit skips this screen and goes **tutorial-lite → bot match → home**.

---

## 3. Identity

- **Guest by default.** On first visit the API creates `users` + `identities(provider='guest')` and returns a refresh token (httpOnly cookie on our domain; `localStorage` fallback inside portal iframes where third-party cookies are blocked).
- **Upgrade, don't migrate:** linking Google/Discord/Apple/email-magic-link/passkey adds an `identities` row to the **same** user id. If the credential already belongs to another account, show a merge flow: pick which progress to keep. Never silently merge purchases.
- **Portal identity adapters:** CrazyGames/Poki user tokens are verified server-side and linked as `identities(provider='crazygames')`. Portals require that guests can play and reject games that force their own login.
- Guest accounts with no progress are cleaned up after 30 days of inactivity. Guests with purchases are prompted to link (and never auto-deleted).
- **Nicknames:** 3–16 chars, Unicode letters allowed but confusables normalised (`nickname_norm`), profanity + impersonation filter ("admin", "mod", staff names), 7-day change cooldown, and a `#1234` discriminator only if duplicates are allowed.

---

## 4. Parties ("groups")

| Rule | Value |
|---|---|
| Max size | 4 (BR squads). Custom rooms can host more people than one party |
| Leader | creator. Transfers on leave to the longest-present member |
| Join | invite from friends list, **invite link** `/g/{token}` (expires in 1 h), or 6-char party code |
| Ready check | the leader starts the queue only when all members are ready (or leader can force after 10 s) |
| Queue | the party queues as **one ticket**. Never split. Mode must fit party size (party of 3 can't queue Duos) |
| Persistence | the party survives matches. Everyone returns to the same party after "Play again" |
| Chat | party text chat + quick chat. Voice: post-MVP (LiveKit SFU, see §9) |

State lives in Redis (`party:{id}`). The social gateway pushes changes to members over WebSocket. Leader actions are validated server-side.

---

## 5. Custom rooms

### 5.1 Codes & links
- Format: **6 characters** from the 23-character unambiguous alphabet `ABCDEFGHJKMNPQRSTUVWXYZ` (no 0/O, 1/I/L) → 23⁶ ≈ 148 M codes. Brute-forcing is pointless with rate limits (5 failed joins/min/IP, 30/h/account).
- Share link: `https://game.example/r/KQ7MZP` (Web Share API on supported browsers + copy button).
- Optional **password** (Argon2id hash in the room registry). Even private rooms keep the code secret (it's not listed in the browser).

### 5.2 Host settings

| Setting | Options |
|---|---|
| Mode | Deathmatch · Team Deathmatch · Capture the Flag · Drop Zone (custom BR) · Gun Game · One-shot (sniper only) · Melee-only · Infection (post-MVP) |
| Map | any map that supports the chosen mode, or "rotation" |
| Players | 2–16 (BR custom: 8–32) |
| Time limit / Kill limit | 3–20 min / 10–100 kills (or off) |
| Teams | 2 teams · auto-balance on/off · host can drag players between teams · shuffle |
| Weapons | All · Pistols only · Snipers only · No explosives · Custom allow-list |
| Gameplay | friendly fire, infinite fuel, low gravity, health regen on/off, respawn delay 0–10 s, spawn protection 0–3 s, headshot-only |
| Bots | 0–N, difficulty easy/normal/hard |
| Visibility | Private (code only) · Public (in browser) · Friends-only |
| Spectators | 0–4 slots |

### 5.3 Host controls
Kick (with optional 10-minute room ban), lock room, transfer host, start match, return everyone to the lobby, change settings between rounds, mute a player in room chat.
**Host migration:** if the host disconnects, host rights transfer automatically. The *server* is authoritative, so the match continues without interruption (no peer-to-peer hosting, ever).

### 5.4 Room lifecycle (custom)
`WAITING` (lobby, settings, ready-up, warm-up yard) → `COUNTDOWN` → `IN_PROGRESS` → `ENDING` → back to `WAITING` with the same players (rematch is one click). A room closes after 10 min idle with no players, or 2 h hard limit (configurable for streamers).

### 5.5 Room browser
- Lists public rooms in your region(s): name, mode, map, players/max, ping, password 🔒, host, "joinable mid-round".
- Filters: mode, map, not full, has friends, language.
- Joining mid-round: you spawn at the next respawn. Drop Zone custom rooms let you join as a spectator only.
- **Custom rooms don't count** toward ranked, missions or leaderboards (prevents XP farming). They do give a small XP for time played, capped per day.

---

## 6. Quick play matchmaking

### 6.1 Region selection
1. On boot, the client pings each region's **beacon** (a tiny WebSocket echo service per region; 5 samples each, take the median; cached for 10 min).
2. Pick the lowest-latency region automatically, show it ("Frankfurt 48 ms"), and allow manual override.
3. Regions above 250 ms are excluded from automatic selection.
4. Tickets carry the whole latency vector, so the matchmaker can expand to the 2nd-best region if the 1st is thin (e.g. a Lagos player falls back from `los`/`jnb` to `fra`).

### 6.2 Ticket flow

```
POST /mm/tickets {mode, partyId?, regions:[{fra:48},{jnb:142}], clientVer}
  → API validates (ver, bans, party leader, mode fits party) → Redis ZADD mm:queue:{mode}:{region}
  ← {ticketId} ; client listens on the social WS for `mm.update` / `mm.found`

Matchmaker loop (every 1 s, leader-elected per region):
  1. BACKFILL first: running rooms of {mode} with free slots and > 3 min remaining → place tickets (DM/TDM only)
  2. Form new matches from oldest tickets: MMR window = ±150 → widens +50 every 10 s → any MMR after 40 s
  3. Pick team splits that keep parties together and balance the mean MMR (greedy + 1 swap pass)
  4. Allocate a room: fleet registry → least-loaded process in region with protocol == clientVer (atomic Lua reserve)
  5. Mint join tickets (JWT) → push `mm.found {gsHost, roomId, ticket}` to every member
  6. Unconfirmed after 10 s → re-queue the others at the front, drop the no-show (2-min penalty after 3 no-shows)
```

- **Never** create matches with 1 human. Under low population, fill with bots instead (labelled in results).
- Late joiners (backfill) don't lose rating for a match already being lost.
- An estimated wait time is shown (rolling average per mode/region), with a **cancel** button always available.

### 6.3 Skill rating
- **OpenSkill (Plackett–Luce)** per queue (`dm`, `tdm`, `br_solo`, `br_duo`, `br_squad`): handles multi-team placement and free-for-all, is MIT-licensed, and is fast.
- **Hidden MMR** (`mu − 3σ` for matchmaking, `mu` for balancing) is separate from the **visible rank** (Bronze → Silver → Gold → Platinum → Diamond → Champion → Legend, with divisions), which moves with wins and placement and has season soft-resets.
- **Ranked queue** unlocks at account level 15 + 10 wins (anti-smurf). New accounts that outperform get fast σ-driven correction.
- Party MMR = a weighted blend leaning toward the highest member (`0.7·max + 0.3·mean`), to stop boosting.
- Leavers: abandoning ranked counts as a loss + escalating queue cooldown (5 min → 30 min → 24 h).

---

## 7. Friends & presence

> **Built (23 Oct 2026), first cut:** §13 below. It differs from this plan in three places: friends add each other by exact name or a short friend code (there's no `#tag`); presence is `offline | online | in_room(code)`; invites last 2 minutes and arrive over the API's push channel (no Web Push yet).

- Add by nickname#tag, by profile link, from "recent players" (last 20 matches), or from a QR code on the profile.
- Requests → accept/decline. Block removes the friendship and prevents invites, chat and same-party.
- **Presence** (`presence:{userId}` in Redis, TTL 60 s, refreshed by the social WS): `offline | online | in_menu | in_queue(mode) | in_match(mode, joinable?) | in_custom_room(code?)`. "Appear offline" and "friends-only invites" privacy options.
- **Join friend:** if they're in a joinable room (custom, or quick-play DM with backfill), one click requests a ticket for that room.
- Invites: in-app toast + a **Web Push** notification (opt-in; on iOS only after Add to Home Screen). Invites expire in 5 min.

---

## 8. Clans (post-launch)
Create (level 10+, cost soft currency), tag `[ABC]` shown before names, roles leader/officer/member (max 50), clan chat, clan XP and weekly leaderboard, clan-only custom rooms. Clan names and tags go through the same moderation as nicknames. Clan wars are a later feature.

---

## 9. Communication

| Channel | MVP | Notes |
|---|---|---|
| Quick chat | ✅ | 24 preset, localised phrases ("Nice shot!", "Cover me", "Enemy above!", "Need health") + emotes. Safe for every age, free to localise |
| Contextual pings | ✅ (BR) | middle-click/`Z`: enemy, loot, go-here, danger. Shows on the minimap strip + in world. Cooldown 1 s, burst 3 |
| Emotes / stickers | ✅ | 6 equippable slots. Soft cooldown 2 s, hard 6 s after a burst. Mute blocks a player's emotes too |
| Text chat | ✅ | lobby, team, all, party, DM (friends only). **Off by default** for under-13 / unknown age and wherever the portal asks to disable chat |
| Voice | ✅ (built, v18) | **Built 23 Oct 2026 without an SFU:** the game server relays Opus frames on the game's own connection (docs/05 §17). Proximity (opponents too, last words), party and team radio; push-to-talk default; per-player mute and Mute all opponents. Off for minors when ages exist |

**Chat safety pipeline:**
1. Normalise: NFKC, confusables, leetspeak (`1→i, 3→e, @→a`), repeated characters.
2. Check a multi-language blocklist + allowlist (place names!) → mask the matched words.
3. Rate-limit and block repeated-message spam.
4. Async AI moderation vendor (e.g. Community Sift / Lasso). Toxicity score → auto-mute escalation.
5. Personal mute/block always overrides everything.
6. All chat logged with a 30-day retention for reports.

---

## 10. Reports & player safety
- Report from scoreboard, kill feed, chat line, profile, or post-match screen. Reasons: cheating, abusive chat, offensive name, griefing/teaming, AFK/leaving, other.
- Evidence attached automatically: matchId, tick range, chat log, **server input replay** (05-netcode §15). Reviewers watch the exact match.
- Feedback loop: "Thanks, action was taken against a player you reported" notification (builds trust and is a DSA best practice).
- Report-abuse detection: players whose reports are consistently rejected get their reports down-weighted.

---

## 11. API surface (first cut)

```
POST   /auth/guest                    → {accessToken, refreshToken, user}
POST   /auth/link/{provider}          → link identity to current user
POST   /auth/refresh  ·  POST /auth/logout  ·  POST /auth/logout-all
GET    /me  ·  PATCH /me (nickname, settings, privacy)  ·  DELETE /me (GDPR/DPDP deletion)
GET    /me/inventory  ·  GET|PUT /me/loadout/{slot}   (built: slots 0–2, look + two guns)
GET    /regions                       → [{id, beaconUrl}]
POST   /mm/tickets  ·  DELETE /mm/tickets/{id}
POST   /rooms                         → create custom room → {code, gsHost, roomId, ticket}
POST   /rooms/{code}/join  {password?}→ {gsHost, roomId, ticket}
GET    /rooms?region=&mode=           → public browser list
POST   /parties  ·  POST /parties/{id}/invite  ·  POST /parties/join/{token}  ·  POST /parties/{id}/kick|leave|promote|ready
GET    /friends  ·  POST /friends/requests  ·  POST /friends/requests/{id}/accept|decline  ·  DELETE /friends/{id}  ·  POST /friends/blocks   (built: §13)
GET    /players/{id}/profile  ·  GET /players/{id}/matches   (profile built: §12; `me` for yourself)
GET    /leaderboards/{board}?period=&scope=global|region|friends   (built: xp|kills|wins × all|week, global)
POST   /internal/matches               (game server → API, signed: §12)
POST   /reports
GET    /store  ·  POST /store/purchase  ·  POST /webhooks/{provider}   (idempotent)
GET    /battlepass  ·  POST /missions/{id}/reroll
GET    /version                       → {minClient, latest, protocolVersion, contentHash, motd, maintenance?}
```

**Social WS events** (JSON; low rate, readability beats bytes here):
`presence.update`, `party.state`, `party.invite`, `friend.request`, `friend.accepted`, `chat.message`, `mm.update {position, eta}`, `mm.found`, `mm.cancelled`, `notify {kind, payload}`, `maintenance {at}`.

## 12. Match results, XP and leaderboards (built, first cut)

**The flow.** When a match ends, the game server sends a report to the API's `POST /internal/matches` (apps/game-server/src/results.ts → apps/api/src/matches).
- **Who's in it.** The report lists only people who came in with an API join ticket; the ticket's `sub` is their account. Bots never get a row, and neither do guests on a dev server without tickets.
- **Signing.** The report is signed the way join tickets are, the other way round. The game server holds an Ed25519 key of its own (`RESULTS_PRIVATE_KEY`); the API holds only the public half (`RESULTS_PUBLIC_KEY`). The token uses the API's JWT format with issuer `game-server` and audience `api-results`. It lives one minute, names the match (`sub`) and carries the body's SHA-256, so it can't vouch for another report.
- **Written once.** Each match is written once, keyed by the game server's match id. A retry or a replay changes nothing.
- **Retries.** The game server retries for about 13 minutes (1 s, 5 s, 30 s, 2 min, 10 min) while the API is down. Reports waiting in memory are lost if the game server itself restarts.
- **On the box.** `scripts/net-trial/data.sh` makes the key once and hands the private half to the game server and the public half to the API. Caddy answers `/api/internal/*` with 404, so the route isn't reachable from outside at all.

**Tables** (docs/06 §7):
- `matches`: one row per match. It keeps the whole report as sent, including the bot counts.
- `match_players`: one line per person per match, with XP gained.
- `stats_lifetime`: a `*` row with each player's totals (matches, wins, kills, deaths, assists, damage, headshots, best streak, playtime), plus one row per kill source with its kills. A kill source is a weapon id, or `melee`, `grenade`, `mine`, `gas` or `world`.

**XP** (`@military-forge/shared` progression.ts, the only copy of the rule):

| For | XP |
|---|---|
| Playing a match to the end | +100 |
| Each kill | +10 |
| Each assist | +5 |
| 1st place (played to the end) | +50 |
| 2nd or 3rd place (played to the end) | +25 |
| Cap per match | 1000 |

A player who leaves early keeps only the kill and assist XP.

**Levels.** Reaching level L takes 50 × L × (L − 1) XP in all. Level 2 is at 100, level 3 at 300, level 4 at 600 and level 10 at 4,500; the cap is level 100. `profiles.xp` and `profiles.level` are updated in the same transaction as the match. A **win** is 1st place in a match played to the end.

**Profile.** `GET /players/{id|me}/profile` returns:
- Level, XP, and progress inside the level (`xpIntoLevel`, `xpForNextLevel`).
- Lifetime stats.
- Kills by weapon.
- The last 10 matches.

**Leaderboards.** `GET /leaderboards/{xp|kills|wins}?period=all|week&limit=` returns the top entries and the asking player's own rank.
- **Storage.** Each board is a Valkey sorted set `lb:{board}:{all|YYYY-Www}`. The week is the ISO week in UTC, and weekly sets expire after 15 days.
- **Scores.** A score is always an absolute total read from Postgres, never an increment, so writing it twice is harmless.
- **Rebuilds.** A board that's empty in Valkey (a flush, a new box, a restarted dev API) is rebuilt from Postgres on the next read.
- **Deleted accounts.** An account that's deleted or banned is dropped from what's shown, and from the set.

**For now every match counts**, including custom rooms. §5 keeps custom rooms out of leaderboards to stop XP farming, but quick play doesn't exist yet, so the playtest's rooms are the only matches there are. When quick play lands, filter on `matches.room` and give custom rooms the capped time XP §5 describes.

## 13. Friends and presence (built, 23 Oct 2026)

The owner's 23 Oct ask: "adding audio support, friends list and invites". This is the friends half; invites and voice follow in the same section as they land.

**Identity.** Every player is a guest today: a stable user id that lives as long as its session (§3). Friendships hang on that id. A guest who clears their browser starts a new account without friends; account linking (later) keeps them. A deleted account's friendships, requests and blocks go with it (database cascades).

**Adding someone.**
- **By exact name:** the nickname's confusable skeleton (§3), so `KEMI_0PS` finds `Kemi_Ops` and nobody else; there's no search or partial match.
- **By friend code:** 8 symbols from an alphabet without lookalikes (no 0/O, 1/I/L, U), shown `7KQ4-M9XP`, made the first time it's needed (`profiles.friend_code`). `POST /friends/code` makes a new one; the old one stops working.
- **Rate limits:** a lookup by name or code counts against 20 per 10 minutes per player and 60 per IP, whether it finds anyone or not, so nobody can sweep the player list.

**Requests.** A request waits until it's answered: accept, decline, or the sender takes it back. Asking someone who already asked you makes you friends at once. Limits: 50 requests waiting per player, 200 friends.

**Blocking.** A block ends the friendship and every request between the two. The blocked player is never told: their new requests are stored but never shown, and are dropped when the block is lifted. A blocked player can't see your presence.

**Presence is private.** Only you and your friends see it (`GET /players/{id}/presence` answers anyone else 403 `not_friends`). Friends see the room's code too, since a code is an invitation and friends are who you'd invite. The friends list reads every friend's presence in one Valkey round trip (`MGET`). An offline friend shows when their account last signed in.

**Tables** (migration `0003_friends`): `friendships(user_id, friend_id, created_at)`, stored both ways; `friend_requests(from_id, to_id, created_at)`; `blocks(user_id, blocked_id, created_at)`; and `profiles.friend_code` (unique). Every table cascades on account deletion and refuses a row that names the same player twice.

**Web** (`apps/web/src/social/`):
- The friends panel: a Frost drawer on desktop, a sheet on phones. It shows your code, Add a friend, and three tabs (Friends, Requests, Blocked). Friends are grouped In a match / Online / Offline, with Join and a menu to remove or block (each asked once more).
- Home: a Friends button with a badge, and the Squad card (a strip on phones).
- Actions apply at once and roll back with a notice if the API refuses.
- Design: the board "SOCIAL · friends, invites, voice" in the owner's Pen file.

### 13.1 Invites, parties and the push channel (built, 23 Oct 2026)

**Invites.** You can invite a friend to the room you're in from three places: the friends panel (Invite on a friend's row), the lobby (Invite friends) and the pause menu (Invite friends). The pause and lobby buttons open the invite picker.
- **Only friends:** a block ends the friendship, so it stops invites too.
- **Which room:** the one you're in (`POST /invites {to, room?}`), and it must exist.
- **Two minutes:** an invite lasts 2 minutes. Inviting the same friend to the same room again sends it again with fresh time, no sooner than 5 s after the last.
- **The toast:** the friend gets Join, Decline and Later (×), wherever they are. Mid-match it sits top left, clear of the HUD's middle; in the menus, top centre. It also has a greyed Watch, the hook for spectating, which is planned separately.
- **Badge:** unseen invites count in the Friends badge with requests.
- **Joining:** Join is the usual room flow (`/r/CODE`, a fresh join ticket). Mid-match it first leaves the current room for good (the Leave CMD), so nobody waits out a reconnect grace.
- **Storage:** invites live in Valkey only (`inv:{id}`, `inv:to:{userId}`, `inv:from:{userId}`), with the answer kept for the sender.
- **The countdown:** it runs on the server's clock. `GET /invites` returns `now`, so a phone with a wrong clock still shows the right time left.

**Not friends yet?** The picker also has Copy invite link, Share… (the phone's own share sheet) and WhatsApp: the room's `/r/CODE` link.

**Parties.**
- **Joining:** accepting an invite puts you in the inviter's party, a new one for the two of you if they had none. Accepting someone else's invite moves you to theirs.
- **Life and size:** a party lives 6 hours after its last use (`party:{id}`, `partyof:{userId}` in Valkey) and holds at most 8. A party of one ends by itself.
- **Leaving:** Leave on Home's squad card.
- **Voice:** the join ticket carries the party id (`party`), so party voice can reach party mates anywhere in a room (§13.2).
- **Privacy:** party mates who aren't friends see each other's names, never their presence.

**The push channel (`GET /events`, Server-Sent Events from the API).** Invites, requests, friends' status changes, answers to your invites and party changes arrive within a second.
- **Why SSE from the API, not the game socket:** it works in the menus (no game connection there). The API already owns friends, rooms and presence. And it's one long response on the API's own Caddy route (`/api/*`): no new port, process or service.
- **Through Caddy:** it carries `Cache-Control: no-cache, no-transform`, so Caddy's site-wide `encode` leaves it alone, and Caddy's `reverse_proxy` flushes `text/event-stream` at once.
- **Staying open:** a comment every 20 s keeps phones' carrier NATs open.
- **Auth:** the web client reads it with `fetch` so the token goes in a header, not a URL.
- **Ending and reconnecting:** the stream ends with the access token (15 min), and the client opens a new one at once. After a failure it backs off from 1 s to 30 s.
- **Limits:** at most 4 streams per player per API process, and 30 connects a minute.
- **Fan-out:** with `REDIS_URL` the events go through Valkey pub/sub (`ev:{userId}`), so any API process can hold the stream.
- **Catching up:** while the stream is down, the friends list's own refresh (every 30–60 s) keeps it roughly right. When it reconnects, the client reloads invites, the party and the list.

### 13.2 Voice chat (built, 23 Oct 2026)

The design and the wire are in docs/05 §17. The social parts:
- **Party voice:** reaches party mates (§13.1) anywhere in a room, through the join ticket's `party` claim.
- **Privacy:** your mutes are yours. The server stops sending a muted player to you, and they're never told. Mute all opponents (the pause menu) and Hear opponents (Settings) are the same switch.
- **Safety:**
  - per-player mute in the pause menu's comms card;
  - Mute all opponents;
  - push-to-talk by default;
  - a greyed Report (`data-hook="report"`) waits for reporting (§10).
