# 05 — Netcode & Wire Protocol

> The model, the transports, every message, the bit layouts, prediction, interpolation, lag compensation, interest management and the debugging tools.
> Research basis (Oct 2026): Valve Source networking, Gambetta, Gaffer on Games, Overwatch GDC 2017, Riot's VALORANT netcode posts, Colyseus 0.18 docs, MDN/WebKit WebTransport notes. Versions and dates are as reported in research. **Re-check before pinning.**

---

## 1. Decisions

| Topic | Decision | Reason |
|---|---|---|
| Model | **Authoritative server**, client-side prediction + reconciliation for the local player, snapshot interpolation for everyone else, server-side rewind for hitscan | Industry standard (Quake/Source/Overwatch) for 8–100 players. Rollback/lockstep don't fit this player count or the browser |
| Sim rate | **60 Hz** client + server | jetpack movement is fast; 2D sim is cheap |
| Snapshot rate | **30 Hz** rooms, **20 Hz** BR (+ AOI tiers) | ~8–12 KB/s down per player |
| Input rate | **60 Hz**, each packet carries the last **3–4 inputs** (redundancy) | survives 1–3 lost packets without a server-side input miss |
| Interp delay | adaptive, **50–200 ms** (1 snapshot interval + the late tail of arrivals + an interval per snapshot lost in a row; §10) | ~60 ms on a clean path, ~130–170 ms at 150 ms ±40 jitter with loss |
| Lag comp cap | **450 ms** total rewind (27 ticks): 250 ms of latency on top of the most the interpolation delay can be (200 ms; one tick more in low-bandwidth mode). A server sets its own latency (`LAG_COMP_LATENCY_MS`), and the admin page's `net.lagCompMs` changes it live. **Cover rule:** a rewind over 150 ms doesn't count against a target behind solid cover now (§7.1) | up to ~250 ms RTT every shot lands where it was aimed; beyond that, players lead their shots; also limits fake-lag "backtrack" abuse. The trial box ran 900 ms for 500 ms phones, and players were hit up to 0.9 s after reaching cover (QA, 23 Oct 2026; NOTES §39) |
| Transport (MVP) | **WebSocket over TLS on 443** (uWebSockets.js) | reaches ~100% of networks; simplest |
| Transport (Phase 2) | **WebTransport datagrams** as an upgrade, WS fallback | Baseline since Safari 26.4 (Mar 2026); ~30–50% less jitter on lossy/mobile networks (reported) |
| WebRTC DataChannel | **Not planned** | signalling + ICE + TURN complexity. Only needed for UDP on iOS < 26.4 / iPhone XS–XR, which matters little with desktop first |
| Serialization | **Hand-rolled bit-packer** (pre-allocated `Uint8Array` + `DataView`) for game traffic; **msgpackr** for low-frequency control messages | smallest packets, zero allocations |
| Framework | **Own netcode** in `packages/netcode` + `packages/protocol`. *Fast-path alternative: Colyseus 0.18* (§16) | the netcode *is* the product for a shooter; our sim is designed around quantize-at-tick-end + seeded spread, which a generic schema can't exploit |

---

## 2. Transport abstraction

```ts
interface GameTransport {
  readonly kind: 'ws' | 'wt';
  readonly supportsUnreliable: boolean;
  connect(url: string, ticket: string, signal: AbortSignal): Promise<void>;
  sendUnreliable(buf: Uint8Array): void;     // WT: datagram ; WS: binary frame (it's reliable anyway)
  sendReliable(buf: Uint8Array): void;       // WT: bidi stream (u16 length-prefixed) ; WS: binary frame
  onUnreliable: (buf: Uint8Array) => void;
  onReliable:   (buf: Uint8Array) => void;
  bufferedBytes(): number;                   // WS: bufferedAmount ; WT: writer backlog estimate
  close(code: CloseCode, reason?: string): void;
}
```

**The protocol is written as if every "unreliable" message can be lost, duplicated or reordered,** even when the WebSocket transport happens to be reliable. The same code then runs on both transports, and the WS path gracefully degrades instead of piling up latency.

### 2.1 Connection selection (Phase 2+)

```
1. if ('WebTransport' in window):
     t = new WebTransport(`https://${gsHost}:443/wt`, { requireUnreliable: true })
     race(t.ready, timeout(2000))
     if ready && t.reliability === 'supports-unreliable' → use WT          // Safari can silently fall back to HTTP/2 → no datagrams
2. else / on failure → wss://${gsHost}/ws
3. Remember the outcome per network (localStorage key by connection type) to skip a doomed WT attempt next time.
```

### 2.2 WebSocket specifics
- `permessage-deflate` **off**: payloads are already bit-packed, and compression adds CPU and latency.
- TCP_NODELAY on (uWS default).
- **Backpressure:** if `bufferedAmount > 16 KB` for a client, **skip** that client's snapshot this round rather than queueing it (it gets the next delta against an older acked baseline). On WS, stale snapshots are worse than missing ones.
- When per-packet framing overhead dominates on slow links (WS frame + TLS record + TCP/IP ≈ 70 B), the client batches 2 input ticks per packet at 30 Hz ("low-bandwidth mode"; costs ~8 ms average input latency).

### 2.3 WebTransport specifics (known quirks to handle)
- **Datagram budget ≤ 1000 bytes** (Chrome caps `maxDatagramSize` at 1024). Never fragment: when a snapshot would exceed it, the priority accumulator (§9) defers lower-priority entities to the next one.
- Server must send `WT_MAX_SESSIONS` and the initial flow-control settings, or Safari's `ready` can hang. Keep our own connect timeout.
- Both Chrome and Safari still send the legacy `:protocol = webtransport`. The server must accept it as well as `webtransport-h3`.
- Safari flow-control credit leak (WebKit bug): use **one long-lived bidi stream** for reliable messages, never one stream per message.
- Server options: Node binding `@fails-components/webtransport` (single maintainer: risk), or **preferred**: a small **Rust WT gateway** (quinn + web-transport-quinn) on each game node that terminates QUIC and forwards frames to the Node room process over a Unix socket. It's isolated, fast, and swappable.
- Certificates: real TLS via a wildcard cert on per-node subdomains (`fra-03.gs.example.com`). `serverCertificateHashes` (≤ 14-day ECDSA certs) is an option for ephemeral fleets on bare IPs.

### 2.4 Local rooms: same Wi-Fi, peer to peer (built, 20 Oct 2026; apps/web/src/lan)

The owner wanted to play with people on the same Wi-Fi or phone hotspot at LAN ping, even with the internet slow or down. Phones and browsers can't listen on a port, so the host's browser runs the room and the guests connect to it over WebRTC.

- **Host-authoritative in the host's page:**
  - It is the game server's own `Room` (apps/game-server/src/room.ts, made browser-safe: Web Crypto, no Node imports), run in a **worker** (`lan/roomWorker.ts`). A hidden tab's timers slow to 1 Hz; a worker's keep 60 Hz. With the room on the page's own timers, a guest measured 5 ticks a second while the host's tab was in the background; in the worker, 60.
  - Every byte from a guest goes through `Room.receive`: the same decoders, strikes, rate limits, input lead limit and host-only commands as on the server. On top of that, the page drops non-binary frames and anything over 4 KB, closing that guest. A guest's state is never taken from it.
  - The host plays through a link inside the page, as one more client.
- **No results:** a local room has no results sink, so no account, XP or leaderboard ever hears of it.
- **Transport:** two negotiated data channels per guest, like WebTransport: `u` (unordered, no retransmits) for INPUT, PING, PONG and SNAPSHOT, and `r` (reliable) for the rest.
  - A **0xFF** frame on `r` is a close frame (u16 code, reason), the channel's stand-in for a WebSocket close. 0xFF is reserved in the protocol registry.
  - The HUD readout says **LAN**.
- **ICE:** no ICE servers offline, so only the devices' own addresses are used; browsers show them as mDNS `.local` names. Online, one public STUN server adds the network's public address, for networks where mDNS doesn't pass. ICE prefers host candidates, so traffic stays on the Wi-Fi.
- **Descriptions are packed** (`lan/sdp.ts`): ICE credentials, the DTLS fingerprint and role, and UDP candidates, in ~130–200 characters. `unpackSdp` rebuilds a minimal SDP and treats a code as untrusted input.
- **Joining online:** through the game server's relay (`/ws/lan/host`, `/ws/lan/join/<CODE>`; apps/game-server/src/lanSignal.ts). It passes one offer and one answer, then nothing.
  - Limits: 2 KB per description, 10 messages a second, 4 rooms per address, 15 guests per room.
  - A reconnect re-signals with the same code and the room gives the player back (its session token).
- **Joining offline:** the host's offer and the guest's reply as QR codes or pasted text (`LanHost.newOffer` / `acceptAnswer`, `answerFor`). A dropped offline link needs new codes.
- **The host leaving** closes every guest's channels: guests end with 4006 ("the host closed the local room") within about 2 s, measured. There is no hand-over: the authoritative state lives in the host's page.
- **Measured on this Mac**, two browser tabs, host tab hidden: RTT 1.5 ms, jitter 0.4 ms, 0 % loss, 60 ticks a second, interpolation at its 50 ms floor, 0 corrections. That is loopback; real same-Wi-Fi is typically 2–10 ms.
- **Simulated** (netsim), 5 ms ±3 with 0.5 % loss: 0 corrections and 0 missed inputs a minute.

---

## 3. Connection handshake

```
Client                                   API                               Game server
  │ POST /mm/queue or /rooms/:code/join ─▶│                                    │
  │◀── {gsHost, roomId, ticket(JWT,30s)} ─│                                    │
  │ connect transport (WT→WS fallback) ───────────────────────────────────────▶│
  │ HELLO {protocolVer, contentHash, ticket, clientBuild, caps} ──────────────▶│ verify sig, exp, jti, room
  │◀────────────────────────────────── WELCOME {playerId, entityId, roomSeed,  │
  │                                     serverTick, tickRate, mapId, mode,     │
  │                                     settings, sessionToken(resume, 60s)}   │
  │ PING ×5 (clock sync burst, 50 ms apart) ──────────────────────────────────▶│
  │◀──────────────────────────────────────────────────────────── PONG ×5      │
  │ LOADED {mapHash} (after assets ready) ────────────────────────────────────▶│
  │◀────────────────────────────── FULL_SNAPSHOT (baseline) + MATCH_STATE      │
  │ INPUT stream begins (60 Hz) ──────────────────────────────────────────────▶│
```

Rejections are typed `CloseCode`s: `VERSION_MISMATCH`, `TICKET_INVALID`, `ROOM_FULL`, `ROOM_CLOSED`, `BANNED`, `DUPLICATE_SESSION`, `RATE_LIMITED`, `SERVER_DRAINING`, `KICKED`, `IDLE`.

---

## 4. Clock sync & tick alignment

Goal: the client runs **ahead** of the server so each input arrives just before the server needs it.

1. **Offset estimation (NTP-style):** keep the last 16 PING/PONG samples; use the sample with the **lowest RTT** for offset (`serverTime ≈ pong.serverTime + rtt/2`), and the median RTT for display. Re-ping every 1 s (piggybacked on inputs once stable).
2. **Client tick target:**
   `clientTick = estServerTick + ceil((RTT/2 + targetBuffer) / DT)`, where `targetBuffer = 1.5 ticks + 2 × jitterStdDev`.
3. **Input buffer health feedback:** every snapshot carries `i8 inputBufferHealth` = how many ticks early this client's newest input arrived. The client nudges `timeScale`:
   - health < 1 → `timeScale = 1.03` (run faster, get further ahead)
   - health > 4 → `timeScale = 0.97`
   - else → ease back to 1.0
   This is Overwatch's "time dilation" trick. The player never notices ±3%.
4. **Hard resync** if the drift exceeds 8 ticks **for 5 s** (a clock that really moved), or at once beyond 120 ticks behind (a tab that slept) or 30 ahead (the server holds 48): jump the tick, flush prediction history, and request a full snapshot. A phone's upload queue filling up (a latency spike: +1 s for a couple of seconds) pushes the health far down and then gives it back. Jumping through one gains nothing, since the inputs sent after the jump wait in the same queue, and it costs a lurch, then a freeze when the queue drains. So the client rides spikes out (19 Oct 2026; was: a jump at 8 ticks off, 116 jumps in 6 minutes on the MTN profile, now 1).
5. **Cushion** (as built: the `targetBuffer` jitter term): when inputs arrive late, the band moves up by how late they were (peak-hold, at most 6 ticks, shrinking 0.5 tick a second). The next dip of the same size is absorbed instead of repeated. Over WebSocket at 150 ms ±40 jitter it cut corrections from 19 to 3 a minute. A hard resync clears it (a sleeping tab says nothing about the path).

---

## 5. Message catalogue

| ID | Name | Dir | Channel | Rate | Purpose |
|---|---|---|---|---|---|
| 0x01 | HELLO | C→S | reliable | once | auth + version |
| 0x02 | WELCOME | S→C | reliable | once | ids, seed, settings |
| 0x03 | PING / 0x04 PONG | both | unreliable | 1 Hz (5× at start) | clock + RTT |
| 0x05 | LOADED | C→S | reliable | once | ready to receive state |
| 0x10 | INPUT | C→S | unreliable | 60 Hz | inputs (redundant) + acks |
| 0x11 | CMD | C→S | reliable | on demand | non-tick commands: emote, ready, team switch, vote, spectate target, loadout change in lobby |
| 0x12 | CHAT | C→S | reliable | ≤ 1/s | text / quick-chat id |
| 0x20 | SNAPSHOT | S→C | unreliable | 30/20 Hz | delta state + local player + unreliable events |
| 0x21 | FULL_SNAPSHOT | S→C | reliable | join/resync | complete baseline |
| 0x22 | EVENT_R | S→C | reliable | on demand | kills, deaths, score, pickups taken, weapon spawns, match state, round end, chat, system messages |
| 0x23 | MATCH_STATE | S→C | reliable | on change | lobby/countdown/in-progress/ending, timers, scores |
| 0x24 | STORM | S→C | reliable | on phase | BR zone schedule (clients simulate the shrink locally from it) |
| 0x29 | VOICE_UP | C→S | unreliable | ≤ 50/s while talking | a voice frame (Opus or the fallback), its channel and level (v18, §17) |
| 0x2A | VOICE_DOWN | S→C | unreliable | per speaker heard | the frame, its speaker, how it reached you, last words (v18) |
| 0x2B | VOICE_STATE | S→C | reliable | on change | who has voice and a mic, your party, your mutes, the dead (v18) |
| 0x30 | DEBUG | S→C | unreliable | dev only | server hitboxes, rewind visualisation, AI state |
| 0x3F | KICK | S→C | reliable | — | reason code then close |

---

## 6. Bit layouts

All multi-bit fields are little-endian bit-packed via `BitWriter` / `BitReader` over pre-allocated buffers. **Ticks are sent as 16-bit wrapping values** and reconstructed against the known full tick (valid while |Δ| < 32 768 ticks ≈ 9 min, so resync is always far earlier).

### 6.1 INPUT (C→S) — 13–31 bytes (1–4 inputs), protocol v7

```
u8   type = 0x10
u16  newestTick
u16  ackSnapshotSeq          // newest snapshot fully decoded → server's delta baseline
u16  renderTick              // tick at which remote entities are currently rendered (for lag comp)
u8   renderFrac              // 0..255 fraction between renderTick and renderTick+1
u2   count-1                 // 1..4 inputs, newest first
repeat count:
  u16 buttons
  u16 aim                    // 0..65535 ↔ 0..2π
  u3  weaponSelect           // 0 = no change, 1..7 slot
  u3  throwStrength          // grenade (0..7)
  u3  dashStrength           // dash (0..7, 7 = full; v14: touch scales it by the stick's push and flick)
  u8  renderLag              // not on inputs[0]: ticks before renderTick that the frame sampling
                             // this input was drawn, in 1/16 tick (0–15.94); lag comp rewinds each
                             // input to its own view (batched inputs, redundant copies after a loss)
```
Nothing may follow the last input except the final byte's padding: longer packets are refused.

`buttons` bits:

| bit | meaning | bit | meaning |
|---|---|---|---|
| 0 | move left | 8 | grenade (hold = cook/aim, release = throw) |
| 1 | move right | 9 | melee |
| 2 | jet (up) | 10 | interact / pick up / swap with ground weapon |
| 3 | down (crouch / drop-through) | 11 | dual-wield toggle |
| 4 | fire primary | 12 | cycle grenade type |
| 5 | fire secondary / zoom toggle | 13 | dash (v8, 02-physics §21) |
| 6 | reload | 14 | riot shield: raise / sling (toggle, v9) |
| 7 | swap weapon | 15 | `isRepeat` (client marks a filler/idle input) |

Edge-triggered actions (reload, swap, melee, interact) are derived **in the sim** from button transitions between consecutive ticks, so they replay correctly during reconciliation.

### 6.2 SNAPSHOT (S→C) — ~250–450 bytes in a 16-player room

```
u8   type = 0x20
u16  snapshotSeq
u16  baselineSeq             // 0xFFFF = not a delta (full)
u16  serverTick
u16  lastProcessedInputTick  // for reconciliation
i8   inputBufferHealth
u16  localStateHash          // low 16 bits of server-side hash of local player state (desync telemetry)

── Local player (always present; exact quantized state for reconciliation) ──
i20 x  i20 y  i20 vx  i20 vy            // 1/1024 m, 1/1024 m/s (Phase 0 sends 24-bit positions)
u8  fuel  u8 fuelRegenDelayTicks  u8 jetTicks
u8  hp    u8 armor    u4 moveState  u8 flags(grounded,crouched,jetting,dual,zoom,reloading,spawnProt,onOneWay)
per weapon slot (2 + melee): u6 weaponId  u8 mag  u10 reserve  u8 cooldownTicks  u8 reloadTicks  u4 bloomQ
u3 fragCount u3 proxCount u3 gasCount  u2 selectedGrenade  u8 grenadeCookTicks
(as built, v10: u3 frags in the combat group; after the shield group, a grenade group (48–53) u3 selected ·
 u3 count × 5 other types and a status group (54–57) u8 blindTicks · u7 blindFade · u6 gasTicks · u8 jetDisabledTicks;
 packages/protocol localState.ts. ~67 bytes in full (join, after loss); deltas send the groups that changed)
≈ 32 bytes

── Entities (delta vs baseline) ──
varint changedCount
repeat:
  u8/varint entityId (u7 in rooms, varint in BR)
  u8  changeMask
    b0 POS       : u20 x, u20 y        (or b0+b7 SMALL: i11 dx, i11 dy in 1/1024 m when |Δ| < 1 m)
    b1 AIM       : u10                 (0.35° — remotes don't need more)
    b2 STATE     : u4 moveState, u4 animFlags (firing, reloading, jetting, crouch)
    b3 WEAPON    : u6 weaponId, u1 dual, u6 offhandId?
    b4 HP        : u7 hpPercent, u1 armored
    b5 VEL       : i12 vx, i12 vy     (1/64 m/s on purpose: remotes only use it for extrapolation + animation, never reconciliation)
    b6 SPAWN/DESPAWN : u2 kind (spawn-full-record | despawn | out-of-AOI)
    b7 SMALLPOS flag
A changed remote player costs ~4–8 bytes; an unchanged one costs 0.

── Clouds (as built, v10: after the pickups section) ──
u5 count · { u5 id · u3 grenade type · i24 x · i24 y · u10 age ticks }   smoke and gas in view, full every snapshot;
radius and density follow from type + age (sim cloudRadius / cloudDensity). Grenade records carry u3 type · u2 mine
state (v10) and EXPLOSION a trailing u3 grenade type (what went off: a blast, a flashbang, an EMP).

── Projectiles ──
Projectiles are simulated client-side from their spawn parameters, using the same sim code. The server only sends:
  NEW   : u10 projId, u6 type, u7 ownerEnt, u16 spawnTick, u20 x, u20 y, i16 vx, i16 vy, u8 seed   // 1/1024 m, 1/1024 m/s (±32 m/s)
  FIX   : u10 projId, u20 x, u20 y, i16 vx, i16 vy     (only after a bounce or when divergence is likely)
  END   : u10 projId, u2 how (explode/hit/expire/stick), u20 x, u20 y
Repeated in the next 3 snapshots (dedupe by projId+kind) so loss doesn't drop a rocket.

── Unreliable cosmetic events (redundant ×3, deduped by u10 eventId) ──
  IMPACT (pos, normal, material), TRACER (shooterEnt, endPos), SOUND (type, coarsePos 4 m grid), HIT_CONFIRM(local only: dmg, zone)

── Map events (protocol v8; tag 6 of the 3-bit event tag, sent to every client, never culled) ──
  MAP_EVENT : u5 event (index into the map's event defs), u2 phase (0 warning, 1 start, 2 end),
              u16 occurrence (low bits), u8 zone (the picked event zone, 255 = all), u1 flip (wind),
              u16 ticks left in the phase that began  // 51 bits; tag 7 is the last free tag: make it an escape
```

As built (Phase 0, `packages/protocol/src/snapshot.ts`), the event tags are 0 shot, 1 explosion, 2 death, 3 hit, 4 spawn, 5 sound, **6 map event (v8)**, **7 extended (v8)**: a u4 kind follows, then its fields, so the 3-bit tag never runs out. Extended kind 0 is **DASH** (u5 player, i24 x, i24 y, u3 direction, u3 chain since v14; 02-physics §21), sent to clients that can see the dasher, never to the dasher (it draws its own from prediction). **Extended events carry no length prefix:** a client can't skip a kind it doesn't know, so every new ext kind still needs a PROTOCOL_VERSION bump, and its number is claimed in the protocol registry before use. A MAP_EVENT announces; it doesn't carry state anyone needs to stay in sync, so a lost snapshot only loses a banner cue: the HUD reads the same event from the client's own copy of the schedule (§8).

v8 also appends a **dash group** to the local-player block (dashTicks u6, dashDir u3, normalised to 0 outside a burst, dashCooldown u8, airDashUsed u1: 18 bits, sent only when it changes) and widens the remote-player flags to 8 bits with `dashing`.

**v14 (the owner's fluid dash; NOTES §28):** INPUT gains a trailing u3 `dashStrength` per input. The dash group keeps its indices with new meanings: 43 `dashGap` u6 (the re-trigger gap, was dashCooldown u8) and 44 `dashChain` u3 (the link in a chain, was airDashUsed u1). A new group after the burn group, 63–64: `dashChainTicks` u7 (the chain window left) and `dashPower` u3 (the current dash's strength, normalised to 0 outside a burst); 15 delta groups. The DASH ext event gains a trailing u3 `chain`.

**Riot shield and pickups (built, protocol v9; `packages/protocol/src/{localState,snapshot}.ts`; allocations from the protocol registry):**
- **INPUT:** `buttons` bit 14 = `Btn.Shield` (raise / sling, edge-triggered in the sim). The web client binds it to **X**.
- **Local block:** a shield group after the dash group, at 45–47: `shieldHp` u19 (1/1024), `shieldStowed` u1, `shieldTicks` u5 (25 bits). The last two are skipped without a shield. With it the block has 10 delta groups, so the group mask is 10 bits.
- **Remote flags:** 10 bits. Bits 8–9 (256 and 512) are a 2-bit shield state: 0 none, 1 slung (guarding the back), 2 raising (guarding neither side, 0.25 s), 3 up (guarding the front).
- **Items on the map:** after the grenades, `u1 changed · [u6 n · { u5 id · u4 def · i24 x · i24 y }]` (v11: `u6 id · u6 def`, below). It's sent only when the list differs from the acked baseline. Items are culled by view like grenades: one that vanished or appeared out of view would give away a hidden player taking it or dying with it.
- **Events:** extended kinds **1 RICOCHET** (shooter, owner, weapon, bounce point, u8 normal angle, end point, what it hit), **2 SHIELD_BREAK** (owner, attacker, point), **3 PICKUP** (player, item, point).
- **Shots:** a SHOT's `hit` may be 3 = struck a riot shield (`target` = its owner).
- **AOI:**
  - A ricochet is sent when its bounce point is in view, including to the shooter (clients can't predict other players' shields). It is clipped like a tracer when it leaves the view or ends on a culled player.
  - A ricochet from a culled shooter is the spark only: point and normal, with no line, and with what it hit blanked unless it hit you. Un-reflected, two lines would cross at the hidden shooter. The shooter is named only to the shooter, the shield's owner, the target, and clients that can see the shooter.
  - A shield break is sent when its owner is in view (or is you), with a hidden attacker blanked as in HIT; a pickup when the item is in view or the taker is you.
  - A shot into a culled player's shield (hit 3) is treated like a hit on its body: clipped, sent as a miss, no target.

**Grenade variety (built, protocol v10, arsenal B):** the two local-block groups and the clouds section above; grenade records + u3 type · u2 state; EXPLOSION + u3 grenade type. No new event tags, ext kinds, remote flags or INPUT bits (CycleGrenade is bit 12). Map pickups gain six grenade-pair items (u4 defs 1–6) with no wire change.

**More guns, weapon crates, test armory (built, protocol v11; owner's playtest, docs/03 §5, §12):**
- **Local block:** a fire-mode group after the status group, at 58–61: `spin0` u8 · `burst0` u2 · `spin1` u8 · `burst1` u2 (the Shredder's spin-up, 0–240, and the rounds left in a Trident burst, per slot). The block has 13 delta groups. Weapon ids are already u6 (14 guns, 0–13).
- **Items on the map:** `u6 id · u6 def` (were u5 · u4): up to 48 items (`MAX_PICKUPS`, the test armory's rack of 14 plus the map's), defs 0–63 (21 used: the shield, six grenade pairs, 14 guns at 7 + weapon index). A dropped or crate gun's ammo isn't sent: the taker's own local block carries it after the swap.
- **Events:** PICKUP's item u6.
- **INPUT:** taking a gun is `Btn.Interact` (bit 10, already there; the web client binds it to **E**, and a touch button).
- **The test armory** is a server option (`--armory` / `ARMORY=1`, `GameOptions.armory`): nothing on the wire beyond the items it puts out.

**The admin page's overrides (built, protocol v13; NOTES §26):** OVERRIDES (0x28, S→C): a u16-length JSON of the admin's changed values (`{ key: number }`, content `admin.ts`), the whole set, sent to every client of every room when the owner changes them; WELCOME carries the same as a trailing u16-length `overridesJson` (`{}` when none) for late joiners and reconnects. Each client puts the content numbers (weapons, grenades, projectiles) into its own copy, so prediction runs on the server's; tuning keys still ride TUNING. Changes apply between ticks on the server and on receipt on a client: prediction may correct once around the change, then not at all (game-server `admin.test.ts`, netsim).

**The room's bots (built, protocol v17, claimed as v15; the owner's "sometimes I don't want bots"):** MATCH_STATE's rules gain `bots` (u5: the players bots keep the room at, 0 = none) and `botLevel` (u2: easy, normal, hard), right after `onNoRematch`. The host sets them with the MatchSettings CMD's JSON (`{ bots?, botLevel? }`, in any phase: the server adds or removes bots on its next tick, mid-match too). The host's choice outranks the server's `--bots` and the admin page's bots for that room, for as long as the room lives; guests read it from MATCH_STATE. It was claimed as v15 and renumbered to v17 when the dash (v14) and remote melee (v16) landed first.

**Looks on the wire (built, protocol v19; the owner's 23 Oct "everyone must see everyone's chosen character"; docs/04 §5):** every client knows every player's look (body, build, outfit parts, hair, colourways). Looks travel at join and on change, never per snapshot.
- **A look on the wire:** `u5 count` + `count × u16` cosmetic wire ids, in content's `cosmeticLoadoutWireIds` order (the 11 first slots, the 3 dyes, then later slots: 15 ids today, ≤ 31). Count 0 = no look known (an older page): clients draw a placeholder. Wire ids are stable and never reused, and an id a client doesn't know draws that slot's default, so a look needs no content hash. Clients cache by `cosmeticLoadoutHash`.
- **ROSTER (0x25):** after the entries, a looks section: `u8 n` (the entry count) and one look per entry, in order. A v17/v18 decoder stops after the entries, so one ROSTER serves every client; the new decoder reads the section only when ≥ 8 bits remain (an older server's padding is < 8). It goes out on join, leave, resume and map change as before, and on a look change (at most one look-driven ROSTER per room per 30 ticks).
- **HELLO:** a trailing optional look after the join ticket (the ticket string is then always written, `''` when none).
- **CMD kind 12 `SetLook`:** a JSON array of the look's wire ids, in any phase (a Locker or creator save while in a room).
- **The server's check (content `admitLook`):** unknown ids, wrong slots and parts made for another body fall back to the slot default; then every item must be unlocked at the player's level (`cosmeticUnlocked`, the API's own rule) or be in the look the API vouched for in the join ticket. The ticket (`look`, `lvl`) is minted from the account's saved slot-0 look, re-checked; the room wears it until the page sends its own. No ticket (dev and local rooms): starter items only.
- **Bots:** each wears `botLook(lookSeed(roomSeed, name))`: both bodies, earnable items, curated colourways; the same in training.
- **Old pages:** `MIN_PROTOCOL_VERSION = 17`; a v17/v18 page still plays, never sends a look (the others see the look from its ticket, else a placeholder) and never reads ROSTER's tail.

**Launchers and the flamethrower (built, protocol v12; docs/03 §11):**
- **Projectiles ride the grenade records:** `type` u3 → **u4** (0–5 grenades, 6–7 free, 8–12 rocket, shell, blade, orb, flame), `fuse` u8 → **u9** (a blade lives 300 ticks). Culled like grenades (view rect, smoke). The shooter's own aren't predicted: the predictor drops the ones its shots launch (the `launch` sim event, not on the wire), as it does throws.
- **EXPLOSION:** the grenade type u3 → **u4** (a launcher's blast names its projectile; the Pulse's burst is an EMP).
- **Local block 62:** `burnTicks` u7 (14 delta groups): prediction takes a burn's damage pulses exactly.
- **Remote flags 12 bits:** 1024 burning; 2048 winding up (the gun in hand spinning up or charging: a minigun, a Ripper, a Pulse; the #99 review's tell).

**Remote melee swings (built, protocol v16; NOTES §32):** remote flags widen to **13 bits** with **4096 swinging** (meleeTicks > 0); while it's set, the remote record's state group carries a trailing **u6 `meleeTicks`** (1 = the swing started, up to its length, ≤ 1 s by the admin's cap), and the group is re-sent while it changes. The client (`NetClient.remotePose` → `swingAt`) takes the swing's progress at the render tick from the two snapshots around it, so another player's swing plays smoothly and **a miss shows too** (before, a remote swing only showed when it landed a hit). v15 was ui-playtest's claim for the room bots, which landed later as v17.
- **Items in smoke (no wire change, the #99 review's M2):** an item a client can't see (inside smoke it's outside of, behind it, or in its full white: the players' mask) stays as the client last had it, present or not, until the spot can be seen; a full snapshot leaves such items out, and the PICKUP event isn't sent. **Blasts** at a spot smoke hides from the client arrive as SOUND only (a rocket blowing up on a hidden body would mark it).

### 6.3 Reliable EVENT_R examples (msgpackr-encoded, rare)

```ts
{ e: 'kill',   killer: 12, victim: 7, weapon: 'm93ba', zone: 'head', assist: [3], streak: 3, flags: ['wallbang'] }
{ e: 'pickup', ent: 12, item: 'medkit', spawnerId: 4, respawnAt: 18450 }
{ e: 'score',  teams: [41, 37], players: [[12, 9, 3, 2400]] }
{ e: 'round',  phase: 'ending', winner: 1, mvp: 12 }
{ e: 'sys',    code: 'PLAYER_JOINED', nick: 'Ade', ent: 19 }
```

---

## 7. Lag compensation

### 7.1 Hitscan (server)
```
onFire(shooter, inputTick, renderTick, renderFrac):
  t = renderTick + renderFrac/256
  t = clamp(t, now − 27 ticks, now)                  // 450 ms cap (250 ms latency + up to 200 ms interp delay)
  for each other player p: pose = lerp(history[p] at the snapshot ticks around t, as the client interpolated)   // hitboxes only
    if now − t > 9 ticks and p is behind solid cover now (head, torso and legs, from the shot's origin): pose = p now   // the cover rule
  ray-test world (CURRENT geometry) + rewound hitboxes
  apply damage NOW (no rewinding health)
```
- The shooter is **not** rewound (they shoot from where they are).
- Breakable geometry uses current state (simpler, and fair: you can't shoot through glass that broke a moment ago on your screen).
- **Favour-the-shooter side effects:** a victim can die ~100–300 ms "after" reaching cover on their own screen. Mitigations: the cap, the cover rule, a clear hit-direction indicator, and killcams that show the shooter's view.
- **The cover rule** (`sim/rewind.ts` `REWIND_COVER_TICKS`, 23 Oct 2026): a rewind longer than 150 ms is turned down when the target is behind solid cover at the server's present time, from the shot's origin to its head, torso and legs alike. The shot is then tested against where the target is, so the wall takes it. A shorter rewind (a LAN's is ~120–130 ms), or a target still partly in the open, is rewound as usual. Measured on a cover range (NOTES §39), hits on a target already behind cover went from 21–38% of all hits to 0–4%. They fell at every ping from the trial box's 110 ms to MTN's 500 ms, and no other hits were lost.

### 7.2 Hit confirmation
The client shows **predicted** impact sparks and tracers instantly, but the **hit marker and damage number** only appear on the server's `HIT_CONFIRM`. Wrong hit markers feel worse than late ones.

### 7.3 Projectiles
- The client spawns a predicted projectile immediately (temp id = `inputTick << 4 | shotIndex`).
- The server spawns at fire time and **fast-forwards** it by `min(shooterRTT/2, 100 ms)` of sim steps (collision included), so it roughly matches the shooter's view without favouring them too much.
- On `NEW` from the server with a matching `(owner, spawnTick, shotIndex)`, the client **adopts** the server id and blends any position error over 100 ms.
- **As built (19 Oct 2026, `packages/netcode/src/ownProjectiles.ts`):** own grenades and projectiles fly from the throw in a world of their own (the map, the seed, the tuning, no players), stepped tick for tick with the prediction. The first own grenade of the same type that a snapshot shows after the throw is matched to it. While matched, the server's copy is hidden; ours settles where it lands and hands over when the server's reaches that spot, or goes when the server's is gone. If they are > 1.5 m apart at the same tick, the server's is drawn from then on. A throw no snapshot ever shows goes after 75 ticks. Before this an own grenade appeared a round trip after the throw: 244 ms at 150 ms ±40, 576 ms (p50) on the MTN profile. The 2D view and `NetClient.grenadeViews()` have it. The 3D view draws snapshot grenades on its own timeline: `net.ownGrenadeViews()` and `net.predictsGrenade(id)` are its hooks.
- No rewind for projectile-vs-player collision (current positions). Rockets are slow enough that this reads fairly.

---

## 8. Prediction & reconciliation (client)

```ts
// After each local sim step:
predHistory[tick % 128] = { tick, state: quantizedLocalState(), input };

onSnapshot(s) {
  const ack = s.lastProcessedInputTick;
  if (ack <= lastAck) return;  lastAck = ack;
  const mine = predHistory[ack % 128];
  if (mine.tick === ack && statesEqual(mine.state, s.local)) return;   // ✅ common case: exact match

  // ❌ mismatch → rewind & replay
  const before = renderPosOfLocal();
  sim.setLocal(s.local);
  for (let t = ack + 1; t < currentTick; t++) { sim.stepLocal(predHistory[t % 128].input); predHistory[t % 128].state = quantizedLocalState(); }
  const after = renderPosOfLocal();
  const err = sub(before, after);
  if (length(err) > 3) visualOffset = ZERO;          // teleport/respawn: snap
  else visualOffset = add(visualOffset, err);        // decays: visualOffset *= exp(-frameDt / 0.08)
  // as built (23 Oct 2026): the decay moves the drawn player at most 8 m/s (CORRECTION_PULL_MAX), and an
  // offset past 2 m (one error or several in a row: CORRECTION_SNAP) is one jump instead (NOTES §40)
  stats.corrections++;
}
```

**What is predicted:** own movement, jetpack, fuel, crouch, dash (its burst, cooldown and air dash are in the local block), own weapon fire timing/ammo/reload, own projectiles' flight, muzzle flash, recoil, own grenade arc and throw. (As built: own grenades and projectiles fly from the throw since 19 Oct 2026, §7.3.)
**Map mechanics (02-physics §20) are predicted with nothing on the wire.** Map rules and zones come from the `MapDef` (CONTENT_HASH refuses mismatched builds, and covers the zone and event kinds' defaults), and the map-event schedule is a pure function of the map, the room seed (WELCOME) and the tick. The predictor's Game has all three and steps the same tick numbers as the server, so a gravity surge, an EMP storm or a jump pad hits the predicted player on exactly the tick it hits the server's, also when reconciliation re-simulates old ticks. `apps/game-server/test/mapMechanics.test.ts` walks a client through every zone and a whole event loop of the mechanics-test map: no mispredictions on a clean LAN, and < 1 correction/min at 150 ms / 2 % loss. A client stripped of the map's mechanics mispredicts dozens of times in 30 s, so the test has teeth. **If a mechanic ever needs per-match state** (an event a host triggers, a schedule that restarts at GO), that state must reach clients before the ticks it affects: a reliable message, or the local block.
**What is NOT predicted:** damage to others, deaths, pickups (shown optimistically with a 150 ms "pending" state, then confirmed or reverted), score.
**Collisions with other players:** players don't body-block each other (a genre convention), which removes the biggest source of mispredictions in shooters.

---

## 9. Interest management (AOI) & priority

Rooms (≤ 16 players) send all players every snapshot, but still apply **visibility culling** for anti-cheat:

- Each client has a **view rect** = camera bounds at the **maximum zoom their current weapon allows** + 6 m margin + velocity look-ahead.
- Entities outside the view rect are **not sent** (`out-of-AOI` despawn). This kills zoom hacks and off-screen ESP, the real "wallhack" of a 2D shooter.
- Gunfire/explosions outside the view rect are sent as `SOUND` events with **4 m-coarse positions** (enough for directional audio, useless for aimbots).
- A culled player's shots are **only** a `SOUND`, even when the tracer crosses the view: a clipped tracer still locates its shooter to centimetres (two cross at the muzzle). Tracers from visible shooters are clipped to the view; one ending on a culled player stops a body's reach (1.5 m) short of the edge and names no target. A shot at a culled player always reads as a miss with no target. A HIT names a culled attacker only to the attacker and the victim, and to others carries whole-HP damage: with linear falloff that still gives the shooter's distance to ~1 m (the victim's whole-HP health does too). A grenade or blast names its thrower only to clients that can see it.
- **Smoke** (arsenal B; sim `SmokeSight`, once per snapshot: usually 0–3 opaque cores, a few circle–segment tests per pair, a raycast only for a core a wall cuts through). A player smoke hides from a client is culled for it, so a wallhack can't see into or through smoke:
  - **inside:** all of it is in an opaque core the client's eyes are outside of;
  - **behind, or across a cloud:** every sight line from the client's eyes to it (top of the head, chest, feet) runs through ≥ 1 m of an opaque core, or ≥ 1.5 m of a core both are in: inside a cloud you see who's next to you, not across it, and from deep inside one you can't see out. Smoke a wall separates from the sight line doesn't count.
  - **One-way at the rim:** eyes within about a metre of a core's edge see out, while a body all inside the core is hidden from everyone outside it. Accepted: the edge is where you look out from.
  - Everything keyed on "can this client see that player" follows: its gunfire is only a `SOUND`; others' hits on it aren't sent; a HIT where either side is hidden from the client (a hidden attacker, or a target in smoke) goes in whole HP; a grenade it throws comes without its owner; a ricochet off its shield isn't sent; an item it takes comes without its name.
  - **Tracers** (and ricochet legs) vanish where they first enter an opaque core the client is outside of (however little they cross), or in its own cloud where they leave its near sight; they read as a miss with no target, whatever they hit in there, so a cut tracer doesn't tell a hit from a miss. A shot into a player smoke hides that never touches the smoke (behind it, fired from the far side) goes on past the body to the first wall in the weapon's range, so its end doesn't mark the body.
  - **Grenades** in smoke the client can't see into (in a core it's outside of, behind smoke, across its own cloud) aren't sent; its own always are. Residue: once one comes out of the smoke, its exact arc and fuse still work back to where it was thrown, as for a thrower off the view.
  - Local mode applies the same to the players, tracers and grenades it draws, so offline play looks like online.
- **Flashbang** (arsenal B): while a client is in a flashbang's full white (sim blindIntensity 1), it is sent no other player, their gunfire only as `SOUND`, and no grenade but its own, so dropping the white-out client-side shows nothing. The fade is the client's to draw.
- The camera never shows more than the view rect: it is at most 4:3 tall, and taller screens are **letterboxed** (the full view width, bars above and below), never cropped at the sides.

BR (≤ 40–50 players, big map):
- Spatial hash (16 m cells). Tier A = in the view rect, every snapshot. Tier B = within 80 m, every 3rd snapshot, coarse position (for audio + the minimap ping system only). Beyond = nothing.
- **Priority accumulator** (Gaffer/Replication Graph): each entity gains `priority × Δt` per snapshot and is sent when the budget allows, highest first. This keeps every datagram under 1000 B.

---

## 10. Interpolation of remote entities

```
renderServerTime = estServerTime − interpDelay
interpDelay = clamp(max(2 × snapshotInterval, snapshotInterval + 2 × jitterStd), 50 ms, 200 ms)  // smoothed
// as built (19 Oct 2026, NetClient.adaptInterpDelay): interval × (1 + the 2nd-longest run of lost
// snapshots in 10 s, ≤ 3) + p95 of how late arrivals were vs the quickest (last ~3 s) + 10 ms;
// up 60 ms/s, down 10 ms/s. Low-bandwidth mode: at least 150 ms. A fixed delay, for tests: options.interpDelayMs
for each remote:
  find snapshots A ≤ renderServerTime < B → lerp position, shortest-arc lerp aim, discrete fields from A (B when alpha > 0.5)
  no B yet → extrapolate with last velocity up to 100 ms, then hold. Reconverge over 100 ms when data arrives
  // as built (23 Oct 2026, interpolation.ts extrapolationTicks, NetClient.remotePose): the snapshot's
  // velocity in full for 50 ms, then slowing evenly to a stop at 150 ms (100 ms of motion at most), held
  // after; never into a wall, floor or ceiling of the map; not when dead. No reconvergence pass: the
  // carried-on pose is close enough that the next snapshot's pose takes over (NOTES §40)
  spawn → appear at first snapshot (with spawn VFX); despawn → fade 150 ms
```
Store 1 s of snapshots per entity in a ring buffer. Animation is driven by interpolated velocity + state flags, so remote characters never "moonwalk".

---

## 11. Delta compression & baselines

- The server keeps the **last 32 snapshots** it sent to each client (per-client because of AOI).
- `baseline = the newest snapshot the client acked` (from `INPUT.ackSnapshotSeq`). If the acked baseline is older than 32 snapshots or unknown, send a full snapshot (still unreliable; the client acks it).
- Entities that didn't change vs the baseline cost 0 bytes. Quantization at tick end (02-physics §15) means "changed" is an exact integer compare, not an epsilon.
- Reliable events never depend on baselines.

---

## 12. Bandwidth budget (targets)

| Scenario | Down / player | Up / player | Server egress |
|---|---|---|---|
| 8-player room, 30 Hz | 5–8 KB/s | 2–4 KB/s (WS overhead incl.) | ~0.5 Mbps / room |
| 16-player room, 30 Hz | 8–12 KB/s | 2–4 KB/s | ~1.2–1.5 Mbps / room |
| BR 40 players, 20 Hz + AOI | 12–20 KB/s | 2–4 KB/s | ~5–6 Mbps / match |
| Per player-hour | ~30–45 MB | | ≈ $0.003 at $0.10/GB egress; ≈ $0 on flat-bandwidth hosts |

CI alarm: if the p95 snapshot size grows > 20% between builds, fail the perf check.

---

## 13. Packet loss, jitter, disconnects

| Condition | Behaviour |
|---|---|
| Lost input packets | covered by 3–4× redundancy; if a tick's input is still missing, the server repeats the last input and flags it `predicted`. A late real input is discarded (never rewrite the past), **except its presses**: an action button the client pressed on a tick that came too late (fire, dash, grenade, reload, swap, melee, shield, …: `LATCHED_BUTTONS`), and the sim didn't have down, is applied on the next tick, once, up to 45 ticks late (`InputBuffer.forSim`). On the MTN profile this cut lost dashes from 24 to 11, lost throws from 22 to 3 and lost shots from 101 to 35 in 6 minutes |
| Lost snapshots | next snapshot deltas from the last acked baseline; interpolation buffer absorbs ≤ 2 losses |
| Jitter spike | interpDelay grows (smoothed) and shrinks back slowly (hysteresis) |
| Connection stall (WebSocket) | the socket stays open and queues what it can't send, then hands it all over at once. While the server has been silent for 500 ms, or `bufferedAmount` is over 1 KB, the client sends 4 INPUTs a second instead of 60 (each carries the newest inputs; the rest would arrive too late to use). The server drops whatever is still over its INPUT allowance (§14). WebTransport datagrams don't queue, so they're never held back |
| Silent connection (a dark path: no close, nothing arrives; the audit of 19 Oct 2026) | The client's watchdog runs on a 500 ms timer, so it also runs behind the lobby and in a hidden tab. After 4 s of silence on WebSocket (3 s on WebTransport, 8 s waiting for WELCOME) it drops the connection, shows the reconnect banner, and tries fresh connections, each given 6 s to open, until one gets through. A 15 s stall (the server paused) was caught at 4.4 s and resumed the moment the server answered; before, nothing showed, and TCP's backed-off retransmits took ~15 s more. The server repeats a silent client's last input for 0.5 s (`MAX_REPEAT_TICKS`), then the player lets go of the keys and keeps its aim, so a held key no longer walks it off a ledge |
| Loss > 10% for 5 s | HUD shows a warning icon; the client offers "low-bandwidth mode" |
| Disconnect | entity stays in the world **20 s** (standing idle, vulnerable). Reconnect with `sessionToken` → FULL_SNAPSHOT → resume. BR: 60 s, then removed and loot drops |
| Server crash/room error | clients get `ROOM_CLOSED(error)` → back to lobby; the match is voided for stats/MMR |
| Tab hidden | the input heartbeat continues via timers; rendering pauses; idle kick after mode timeout (rooms 90 s, BR never mid-fall) |

---

## 14. Wire security

- TLS everywhere (WSS / QUIC). No plaintext endpoints, even in staging.
- Strict decoders: length checks and range checks on every field; unknown message type → +1 strike, 3 strikes → disconnect.
- Max inbound message size: INPUT 64 B, CMD 256 B, CHAT 512 B, anything else 1 KB.
- Token buckets per connection: INPUT ≤ 70/s (60 + slack), CMD ≤ 20/s, CHAT ≤ 1/s (burst 5), PING ≤ 5/s.
  - INPUT: up to 3 s of unused allowance carries over. INPUTs over it are dropped, not a kick: a stalled stream's backlog arrives all at once (§13). The newest one over the limit is applied at the next tick. A client that's over the limit for 10 s in a row is flooding and is kicked (`RATE_LIMITED`).
  - Every other message: 200/s, with 3 s carried over, then a kick (`RATE_LIMITED`). CMDs over their own bucket are dropped.
- Inputs whose `newestTick` is too far ahead of server time (≥ 48 ticks; was 32) are rejected. That's speedhack by clock manipulation. A phone's upload queue draining after a spike can hand over inputs ~40 ticks ahead for a moment.
- Rotate message-type IDs and field order per build (cheap obfuscation; deters casual packet-editing scripts).
- See 10-security-anticheat for behavioural detection.

---

## 15. Netcode debugging tools (build these early, they pay for themselves)

1. **Net graph overlay (F3):** RTT, jitter, loss % in/out, KB/s in/out, snapshot size, interp delay, input buffer health, corrections/s, server tick ms, transport type.
2. **Network conditioner:** client-side (wraps the transport) and server-side flags: latency, jitter, loss, duplication, reorder, bandwidth cap, separately per direction.
3. **Server hitbox overlay:** draws the server's hitboxes (debug channel) next to the interpolated client model. On fire it also shows the rewound pose used for the hit test.
4. **Packet recorder:** saves raw in/out packets with timestamps to a file. The replay tool re-decodes and steps through them.
5. **Input replay:** every match's input log on the server (10–50 KB/min/match, gzip) = deterministic replays for bug repro, killcams, moderation and anti-cheat review.
6. **Desync heatmap:** where on maps prediction mismatches happen (usually collision corners), sent to telemetry.

---

## 16. Alternative fast path: Colyseus 0.18

If time-to-first-playable matters more than control, Colyseus 0.18 (Aug 2026, MIT, TS) provides: `room.input()` with sanitize/clamp, a `predict.reconciler`, remote interpolation, predicted projectile spawns, lag-compensation rewind (`allowRewindState`), fixed timestep, Schema 5 with `t.quantized()` floats, `StateView` per-client filtering (AOI), `QueueRoom` matchmaking, auto-reconnect, rate limiting, and a uWS transport (WebTransport transport still experimental).

**Trade-offs:** a generic schema delta is larger than our bit-packed snapshots; there's a 63-field-per-schema limit; and the netcode features are brand new (shipped Aug 2026), so they're less battle-tested.

**Recommendation:** build our own netcode on uWebSockets.js (§1). Treat Colyseus 0.18's implementation as **reference reading**, and use it only if the team is 1–2 people racing to a demo. In that case keep `packages/sim` framework-agnostic so we can leave later.


## 17. Voice chat (built, protocol v18)

The owner's "audio support" (23 Oct 2026): team and party voice in rooms of up to about 8, plus (owner, later that day) proximity voice that opponents can hear and "last words".

**The design: Opus frames over the game's own connection, relayed by the game server.**
- **The relay** (`apps/game-server/src/voice.ts`) reads only a 4-byte header and forwards the client's bytes. It never decodes audio.
- **The path:** on WebTransport the frames are datagrams (`isUnreliableMessage`), so a lost one costs only itself. On WebSocket they share the stream.
  - **Sender:** the client skips frames while its socket is backed up (> 32 KB).
  - **Server:** it skips a listener whose connection is backed up (> 16 KB), the line snapshots use.
- **Nothing new to run:** no SFU, no TURN, no port, no service, nothing per minute.
- **Why not WebRTC:**
  - Peer-to-peer meshes fail behind the carrier-grade NAT most Nigerian 4G phones sit behind, so they'd need a TURN relay. That's a new UDP port range on the box and its bandwidth bill.
  - An SFU is another process to run.
  - Neither could decide proximity from sim positions the way the game server can.

**Wire** (`packages/protocol/src/voice.ts`):
- **VOICE_UP** = u8 type · u16 seq · u8 (codec 2 bits · channel 2 bits · level 4 bits) · u8 (frame 20/40/60 ms · redundant flag) · [u8 n · the previous frame] · the frame.
- **VOICE_DOWN** = u8 type · u8 speaker · u8 route (+ bit 7 last words) · VOICE_UP's bytes from the seq on.
- **VOICE_STATE** = u8 type · u8 flags (bit 0: the room uses the fallback codec) · u8 n · n × (u8 id · u8 PEER_* flags).
- **CMD kind 11 (Voice)** carries the whole voice state as JSON: `{ on, mic, opus, proximity, hearOpponents, mute }`.
- **Old clients:** the server admits v17 and v18 (`MIN_PROTOCOL_VERSION`). A v17 client never receives a voice message.

**Who hears a frame** (server-side, so a modded client can't hear far-away enemies):

| Channel the speaker picks | Phase | Who hears it | Played as |
|---|---|---|---|
| Near (V / the phone's mic) | in play | anyone whose soldier is within `VOICE.radius` (24 m) of the speaker's, opponents included, unless they turned off Proximity or Hear opponents | 3D at the speaker's soldier: full volume to `VOICE.falloffStart` (4 m), fading to nothing at the radius; walls muffle (the map's acoustics); HRTF with Headphones on |
| Near, a speaker who just died | in play | the same, from the death spot, for `VOICE.lastWords` (6 s): **last words** | 3D, brass "last words" tag |
| Near, a speaker dead past last words | in play | other dead players only, any distance | flat, quieter |
| Near | lobby, results | everyone in the room | flat |
| Party (B) | any | party mates (the join ticket's `party`), anywhere | flat |
| Team radio | team modes | teammates anywhere (free-for-all has no teams yet: `teamOf` is null) | radio filter |

- **Mutes:** a listener's mutes and "Hear opponents" off stop the frames at the server, which saves the download.
- **Cap:** each listener gets at most `VOICE.maxSpeakers` (4) voices at once. Party and team come first, then the nearest.
- **Budget and errors:** each speaker may send 60 frames a second. A malformed frame is dropped, never a kick.
- **Tuning:** radius, falloff start, last words and the cap are admin-page numbers (group "Voice chat"; content `VOICE`). They reach clients with OVERRIDES like the rest.

**Codecs and quality (every network, 4G the floor):**

| Tier | Opus | Frames | When |
|---|---|---|---|
| saver | 16 kbps | 60 ms | Data saver, `saveData`, 2G/3G, RTT ≥ 250 ms or loss ≥ 5 % |
| normal | 24 kbps | 40 ms | otherwise |
| high | 40 kbps | 20 ms | RTT < 90 ms, under 1 % loss, ≥ 5 Mbps where the browser says (Wi-Fi, 5G) |

- **Loss:** under loss (≥ 3 %) each packet also carries the previous frame, and the receiver fills a gap with it.
- **The jitter buffer** (`apps/web/src/voice/playout.ts`):
  - It holds 60–250 ms and grows when frames come late.
  - A missing frame is covered once by the last one, quieter.
  - A backlog is skipped rather than played late.
- **Opus** runs through WebCodecs: Chrome and Edge 94+, Android Chrome, Samsung Internet, Firefox 130+ desktop, and Safari 26+ (iOS 26).
- **Fallback where a browser has no Opus encoder or decoder** (Safari before 26, Firefox on Android):
  - The codec is IMA ADPCM at 6 kHz, about 24 kbps, in plain JavaScript with no download.
  - Every frame carries its own predictor, so a lost frame costs only itself.
  - A room where anyone can't decode Opus switches everyone to it (VOICE_STATE's flag), so everyone hears everyone.
- **Microphone capture:** an AudioWorklet (`public/audio/voice-capture.js`, same origin, so the site's CSP allows it), or a ScriptProcessor where there's none.
- **Browser processing:** echo cancellation, noise suppression and auto gain stay on.
- **No mic:** if the mic is refused, the player is listen-only: they hear everyone and send nothing, and the UI says so.

**Controls:**
- **Keyboard:** push to talk by default on V (melee moved to C; saved settings rev 3 moves a saved V too). B talks to the party. Both are rebindable in Settings › Controls.
- **Controller:** the touchpad (PlayStation) is the default talk button; rebindable.
- **Phone:** the mic button above the move dial. Hold it, or slide it up to lock it on.
- **Open mic:** a noise gate, with its threshold and a live meter in Settings.
- **Settings › Audio › Voice chat:** on/off, the mic (permission, Test mic), how you talk, the gate, mic volume, voice volume, Proximity, Hear opponents, and Voice quality (Auto / Data saver).
- **The pause menu's comms card:** mute any player, Mute all opponents, and a greyed Report (soon).
- **Speaking rings:** on the speaking tags over soldiers, the who's-talking strip, the scoreboard rows and the pause card.

**Testing:**
- Unit tests: `packages/protocol/test/voice.test.ts` (the wire), `apps/game-server/test/voice.test.ts` (routing, last words, the cap, the budget, v17 clients) and `apps/web/src/voice/voice.test.ts` (tiers, the jitter buffer, ADPCM, push to talk).
- End to end: `apps/web/scripts/voice-e2e.mjs` runs headless Chrome with its fake microphone. Two players talk in the lobby and mid-match, a phone joins, and it takes the screenshots in `docs/screenshots/social/voice/`. With `ADMIN_URL` and `ADMIN_TOKEN` it widens "Voices carry" so they're within earshot on Flux Lab.
- Headless Chrome is no judge of timing: with no sound card its audio clock crawls (0.04 s in 2 s of wall time under load) and a busy page gets its frames in bursts. So the jitter buffer's skip counts there mean nothing; check the sound by ear on real devices.
