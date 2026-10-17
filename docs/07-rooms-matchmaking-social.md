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
| Voice | post-MVP | party/team channels via **LiveKit** (open-source SFU), push-to-talk default, per-player volume, off for minors. Optional proximity voice in custom rooms (Web Audio `PannerNode`) |

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
GET    /me/inventory  ·  PUT /me/loadout/{slot}
GET    /regions                       → [{id, beaconUrl}]
POST   /mm/tickets  ·  DELETE /mm/tickets/{id}
POST   /rooms                         → create custom room → {code, gsHost, roomId, ticket}
POST   /rooms/{code}/join  {password?}→ {gsHost, roomId, ticket}
GET    /rooms?region=&mode=           → public browser list
POST   /parties  ·  POST /parties/{id}/invite  ·  POST /parties/join/{token}  ·  POST /parties/{id}/kick|leave|promote|ready
GET    /friends  ·  POST /friends/request  ·  POST /friends/{id}/accept|decline|remove|block
GET    /players/{id}/profile  ·  GET /players/{id}/matches
GET    /leaderboards/{board}?period=&scope=global|region|friends
POST   /reports
GET    /store  ·  POST /store/purchase  ·  POST /webhooks/{provider}   (idempotent)
GET    /battlepass  ·  POST /missions/{id}/reroll
GET    /version                       → {minClient, latest, protocolVersion, contentHash, motd, maintenance?}
```

**Social WS events** (JSON; low rate, readability beats bytes here):
`presence.update`, `party.state`, `party.invite`, `friend.request`, `friend.accepted`, `chat.message`, `mm.update {position, eta}`, `mm.found`, `mm.cancelled`, `notify {kind, payload}`, `maintenance {at}`.
