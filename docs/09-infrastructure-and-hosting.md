# 09 — Infrastructure, Hosting, Machines & Costs

> Decision recap: **indie budget, scale later.** Start at about $50–100/mo during development and about $300–700/mo at soft launch, with an architecture that grows to 50k+ concurrent users (CCU) without a rewrite.
> Prices were researched on **16 Oct 2026**. Hosting prices moved a lot in 2026 (a DRAM-driven wave of increases; Hetzner cloud ≈ 2.5× from 15 Jun 2026). **Re-check everything before signing.** Players-per-core figures are engineering estimates to validate with our own load test (06-architecture §9).

---

## 1. The 2026 landscape (what changed and why it matters)

| Fact | Impact on us |
|---|---|
| **Hathora shut down game hosting (5 May 2026)**, after an acquisition by Fireworks AI | avoid single-vendor lock-in; ship game servers as **portable containers** with our own allocator |
| **Unity Multiplay deprecated (1 Apr 2026)** | not an option |
| **Rivet pivoted** to WebSocket "Actors" ($0.15/GB egress) | not for the 60 Hz loop |
| **AWS GameLift Servers made bandwidth free on gen-6+ instances (15 Jun 2026)** | the best *managed* economics at scale. It has no Node SDK (use the Game Server Wrapper or a Go sidecar), and the Lagos Local Zone is gen-5 only, so bandwidth there is still billed |
| **Hetzner raised cloud prices sharply** (CCX13 €15.99 → €42.99) | still fine in the EU (20 TB traffic included), but no longer the obvious cheapest |
| **AWS UAE/Bahrain facilities hit by drone strikes (Mar 2026)** | serve the Gulf from Marseille/Milan/Frankfurt at first |
| **WebTransport is in every major browser** (Safari 26.4, Mar 2026) | Phase-2 UDP transport. Needs UDP on the server, which rules out Cloudflare's WebSocket proxy for that traffic |
| **Cloudflare Durable Objects can't place in Africa / South America / Middle East**, and only speak WebSocket | fine for lobby/presence, **not** for authoritative game rooms for our audience |

---

## 2. Bandwidth is the bill (math)

From 05-netcode §12: rooms ≈ **8–12 KB/s down per player**, BR ≈ 12–20 KB/s.

| Avg down/player | GB per CCU-month (730 h) |
|---|---|
| 10 KB/s | ~26 GB |
| 15 KB/s | ~39 GB |
| 20 KB/s | ~53 GB |

At **15 KB/s blended**: 1k average CCU ≈ **39 TB/mo**, 10k ≈ 390 TB/mo, 50k ≈ 1.95 PB/mo.

| Pricing model | 1k CCU | 10k CCU | 50k CCU |
|---|---|---|---|
| $0.10/GB (Edgegap on-demand) | ~$3.9k | ~$39k | ~$195k |
| $0.01/GB after pooled allowance (Vultr, DigitalOcean) | ~$0.4k | ~$3.9k | ~$19k |
| $0.005/GB (Akamai/Linode overage) | ~$0.2k | ~$2k | ~$10k |
| **Unmetered 1 Gbps bare metal** (OVH, Hetzner dedicated) | 1 port/region | 3–6 ports | 15–25 ports |
| **GameLift gen-6+ / Gameye** | included | included | included |

A 1 Gbps port at 60% load carries ≈ **5,000 players at 15 KB/s**. That's why **every byte saved in the snapshot format is money** (05-netcode's bit-packing pays for itself).

---

## 3. Machine sizing

| Workload | Estimate (Node, our design) | Notes |
|---|---|---|
| 8-player room, 60 Hz sim / 30 Hz snapshots | **8–15 rooms per core** (64–120 players) | socket I/O + serialization dominate, not physics |
| 16-player room | 4–8 rooms per core | |
| 32–40 player BR, 60 Hz / 20 Hz + AOI | 2–4 matches per core | bots at 10 Hz, staggered |
| Same in Rust (later) | ~3–4× more | port `sim` + server loop only when the bill or tick p99 demands it |

**Instance guidance:**
- **Never burstable** (t3/t4g, shared vCPU, CPX "shared"): steal time breaks tick timing.
- Cloud: Hetzner CCX (dedicated vCPU), Vultr CPU-Optimized, AWS c7g/c7a/c8g, GCP c3d/c4d.
- Bare metal: high-clock Ryzen/EPYC, e.g. OVH Game range (DDoS protection included), Hetzner AX.
- Node process per vCPU. Keep event-loop utilisation < 0.6; alert on p99 `monitorEventLoopDelay` > 4 ms; `--max-semi-space-size=64` to reduce minor-GC pauses; no allocation per tick; never `await` I/O inside a tick.

---

## 4. Regions (where our players are)

The genre's core audience is India, Nigeria/West Africa, SE Asia, the Middle East and LATAM. Measured data-centre latencies (WonderNetwork, Oct 2026; mobile last-mile adds 30–80 ms):

| From Lagos | ms | | From Mumbai | ms |
|---|---|---|---|---|
| **Johannesburg** | **73–80** | | Delhi / Chennai | ~27 |
| Madrid | 87 | | Singapore | 58 |
| London | 104 | | Dubai | varies wildly (measure) |
| Frankfurt | 122 | | | |
| Cape Town | 240 ❌ (AWS af-south-1 is a bad pick for Nigeria) | | | |

**Region roadmap:**

| Phase | Regions | Serves |
|---|---|---|
| Dev / closed alpha | `fra` (or `lon`) | everyone (fine for playtests) |
| Soft launch | `fra`/`lon`, `bom` (Mumbai), `jnb` (Johannesburg) | EU + Nigeria (via JNB, with London as fallback) + India |
| Launch | + `sin` (Singapore), `iad` (US East) | SE Asia, Americas |
| Growth | + `gru` (São Paulo), `los` (Lagos bare metal via Zenlayer or Local Zone), `del`/`blr`, Gulf (re-evaluate) | |

### 4.1 Lagos versus Johannesburg for the trial (19 Oct 2026; advice only, nothing bought)

**What was measured.** Round trips from MTN Nigeria (AS29465, Port Harcourt), with the probe's reference pings (docs/net-trial.md §3) run from the dev Mac on that network, 20 warm requests each:

| Where | Median | p90 |
|---|---|---|
| Lagos: IXPN's own site (AS36940, at the exchange) | **66 ms** | 114 ms |
| Lagos: Nobus cloud (AS328668) | 68 ms | 157 ms |
| Cape Town (AWS af-south-1) | 124 ms | 220 ms |
| **Johannesburg: our Azure box** (`/health`; its WebSocket echo: 150 ms, p95 221) | **142 ms** | 202 ms |
| London (AWS) | 153 ms | 272 ms |
| Frankfurt, Paris, Ireland, Spain (AWS) | 182–216 ms | 208–261 ms |
| Cloudflare's nearest edge (answered from **Amsterdam**) | 192 ms | 471 ms |
| UAE (AWS) | 345 ms | 411 ms |

**What it says:**
- **Europe doesn't beat Johannesburg from MTN.** London is ~10 ms worse at the median and worse in the tail; the rest are worse still. The Azure student plan blocking UK South and Spain Central costs nothing.
- **A Lagos box would roughly halve the round trip:** ~66–70 ms against ~140–150 ms. MTN, Airtel and Glo all peer at IXPN in Lagos, so a box at a Lagos data centre on the exchange is one short hop for all three. Expect the same for the other networks; the probe's runs from Airtel and Glo phones will confirm it.
- **The owner's phone measured 513 ms median / 1347 ms p95** to the same box, on the same network in the same city. That is 3–4× the Mac's 150 / 221 ms. So most of the phone's number is its own last mile (indoor 4G, its upload queue filling: bufferbloat), not MTN's route to South Africa. **A Lagos box doesn't fix that part:** netfeel's "Lagos box, same spikes" row still loses control for a second per spike (NOTES §28). The probe's reference pings, run from the phone, tell which it is: if Lagos also shows ~450 ms from the phone, it's the radio.
- **Feel at those numbers** (netfeel, NOTES §28): a clean 90 ms path plays with ~2 corrections a minute and every shot compensated; the Johannesburg path at ~150 ms ±40 is close behind with today's fixes. The gap that matters is the phone's spikes, wherever the box is.

**Lagos options; all need a paid account (none has a free tier or student credit):**

| Option | What | Account | Notes |
|---|---|---|---|
| **AWS Lagos Local Zone** (`af-south-1-los-1`) | EC2 in Lagos, gen-5 instances (t3, c5, m5) | a **paid AWS account** with a card (the free tier and student credits don't cover Local Zones); opt in to Cape Town, then the zone | docs/net-trial.md is the click-by-click; ~$6–15 for a 3-day trial (its §6). Bandwidth billed (GameLift's free bandwidth is gen-6+ only) |
| **Nobus** (nobus.io, AS328668, Lagos) | Nigerian cloud VMs | a business account, paid in naira | VM prices are behind their calculator or sales. Their published egress is ₦6,000 per GB per month, so check bandwidth before committing (a 10-player evening is ~2 GB) |
| **Lineserve** (Lagos data centre) | Nigerian cloud VPS, billed per second | a paid account | listed from ~₦7,580/month; a 2 vCPU / 4 GB server around ₦27,400/month on a third-party comparison. Check that the box is really in Lagos (many "Nigerian" hosts are abroad): run `scripts/net-trial/where.sh` and the probe |
| **Colocation** (Rack Centre, MainOne/Equinix LG, Digital Realty Lekki: IXPN has a point of presence there) | your own server in a Lagos data centre | a contract | for later, at launch scale |
| **GCE africa-south1 / Azure South Africa North** | Johannesburg (what we have) | Azure for Students, $100 credit, no card | stay here until a Lagos box is paid for |

**Advice:** keep Johannesburg for now and turn on WebTransport there (docs/net-trial.md §1.1). Ask the testers to run `/probe` from their phones: the reference pings show, per network, whether Lagos would cut their round trip as it does for the Mac. If it does, a short paid trial in the AWS Lagos Local Zone (docs/net-trial.md, the same script) is the cheapest way to measure it for real.

Region choice is **data-driven**: the ping-beacon results (07-rooms §6.1) are logged per country/ASN, so we add a region when a population sits above 120 ms.

---

## 5. Recommended providers per role

| Role | MVP pick | Why | Later |
|---|---|---|---|
| Static client + assets | **Cloudflare (R2 + CDN)** | zero egress fees, PoPs in Lagos and India, free WAF/DDoS for HTTP | same |
| Control plane (API, social, matchmaker, worker) | **1 VM in Frankfurt** (Hetzner CCX23 or OVH), Docker Compose | central to EU/Africa/India/ME; not on the hot path | 2–3 VMs + load balancer, then managed K8s if needed |
| Postgres | **Neon** (Launch plan; scale-to-zero, branching for previews) | cheap at the start, Postgres-standard | Neon Scale / RDS / self-hosted Patroni |
| Redis/Valkey | self-host on the control-plane VM | free, low latency to the API | DigitalOcean/Aiven managed Valkey with HA |
| Game servers EU | **OVH** (unmetered EU traffic; Game range includes DDoS) or Hetzner CCX | flat bandwidth | bare metal (OVH Game / Hetzner AX) |
| Game servers Mumbai | **Vultr CPU-Optimized** (or OVH Mumbai, but watch APAC traffic quotas) | $0.01/GB after the pooled allowance | OVH/i3D bare metal |
| Game servers Johannesburg | **Vultr** | the best-latency cloud for Nigeria | + Zenlayer Lagos bare metal |
| Game servers Singapore / US / São Paulo | Vultr or Akamai ($0.005/GB) | | |
| Orchestration | **our own allocator** (fleet registry in Redis, 06-architecture §6) + systemd/Docker per node | simple, portable, no lock-in | Agones on k3s (bare metal) **or** GameLift (managed containers + Anywhere for Lagos) |
| Observability | Grafana Cloud free tier + Sentry free/Team | | self-hosted Prometheus/Loki |
| Auth | **Better Auth** (MIT; anonymous plugin + linking + OAuth), self-hosted in the API | guest-heavy F2P makes per-MAU auth pricing risky (e.g. Clerk) | same |
| Matchmaker / social | our own on Redis (07-rooms) | small and fully controllable | **alternative:** self-hosted Nakama for social/parties/leaderboards if the team wants it off-the-shelf |
| Email | Resend / Postmark | magic links, receipts | |
| Analytics | PostHog Cloud (free tier) | events + flags + A/B | self-host / ClickHouse |

---

## 6. DDoS & exposure

- **MVP (WebSocket only):** put the game-server WebSocket endpoints **behind the Cloudflare proxy** (`fra-01.gs.example.com` proxied). It hides origin IPs and absorbs L3/L4/L7 floods on any plan. It closes connections idle for ~100 s, and our 60 Hz inputs and heartbeats keep them alive. Measure the added latency; Cloudflare often improves routing for Africa and India.
- **Phase 2 (WebTransport/UDP):** traffic can't go through the free proxy. Use providers with game DDoS protection (OVH Game, Path.net, i3D). Only reveal server hostnames **after allocation** (in the join ticket), and firewall everything but 443/udp + 443/tcp.
- Per-IP connection limits on game servers (e.g. 4) and SYN cookies; the API sits behind Cloudflare WAF + rate limiting.

---

## 7. Costed staged plan

### Stage 0 — Development & closed playtests (now → first playable)
| Item | Spec | ~Monthly |
|---|---|---|
| Game + control plane on one box | Hetzner CCX23 (4 dedicated vCPU, 16 GB) **or** OVH VPS, Frankfurt | €45–90 |
| Postgres | Neon free → Launch | $0–20 |
| CDN/assets | Cloudflare free + R2 (few GB) | ~$0–2 |
| Errors/metrics | Sentry free, Grafana Cloud free | $0 |
| **Total** | | **≈ $50–110** |

### Stage 1 — Soft launch (≤ 1k peak CCU, 3 regions)
| Item | Spec | ~Monthly |
|---|---|---|
| Control plane | 1× CCX23-class in FRA (API, social, matchmaker, worker, Valkey) | ~$90 |
| Game servers FRA | 1–2× OVH/Hetzner, 4–8 dedicated vCPU | $90–180 |
| Game servers BOM | 1–2× Vultr CPU-Opt 4 vCPU | $80–160 |
| Game servers JNB | 1× Vultr CPU-Opt 4 vCPU | $80 |
| Bandwidth overage | mostly inside allowances | $0–200 |
| Neon Launch | | $20–50 |
| Beacons (tiny VMs per region) | or a process on the game nodes | $0–15 |
| Monitoring / Sentry Team | | $0–30 |
| **Total** | | **≈ $350–800** |

### Stage 2 — Growth (5–15k CCU)
Two routes. Choose based on team ops skills:
- **A. Managed:** GameLift managed containers on gen-6+ instances (bandwidth free) in FRA/LON/BOM/SIN/IAD/GRU, plus **GameLift Anywhere** for Lagos/JNB bare metal. Needs a Go sidecar for the GameLift server SDK. Compute ≈ $3–5k/mo.
- **B. Self-run:** **k3s + Agones** (CNCF, v1.60 Aug 2026) across bare metal: 2–3 Hetzner AX / OVH Game boxes in the EU, OVH in BOM/SIN, Zenlayer in Lagos, Vultr/Akamai elsewhere. ≈ $3–6k/mo + DevOps time.

In both cases: add WebTransport (Rust gateway), consider porting the server loop to Rust, add read replicas, and add a Gulf location once it's stable.

### Stage 3 — Scale (50k+ CCU) ≈ $12–25k/mo
Hybrid: reserved bare metal for ~70% of the baseline (25–40 servers with 1–10 Gbps ports, unmetered) + GameLift/Spot burst for peaks. Rust servers. Dedicated UDP DDoS protection. Negotiate with Gameye (bandwidth included) / i3D / Edgegap enterprise as alternatives. (For comparison, the same load on Edgegap's list price would be ~$200k+/mo.)

---

## 8. Deploy topology per game node

```
node (e.g. fra-gs-01, 8 vCPU)
├─ systemd: gs@1 … gs@7     (one Node process per vCPU, 1 vCPU left for OS + gateway)
├─ fleet-agent              (heartbeat → Redis: per-process capacity/rooms/players/cpu/ver/state)
├─ beacon                   (WebSocket echo on /ping for region latency probes)
├─ wt-gateway (phase 2)     (Rust quinn/web-transport, 443/udp: /wt/N → Unix socket → gs@N)
├─ node_exporter + promtail (metrics/logs)
└─ caddy/nginx (TLS for wss, wildcard cert *.gs.example.com) — or Cloudflare origin cert
```

**WebTransport gateway (phase 2).** One `wt-gateway` per node listens on 443/udp (`WT_ADDR=0.0.0.0:443`; the firewall already allows 443/udp) and routes by URL path: `WT_ROUTES=/wt/1=/run/military-forge/gs1.sock,…,/wt/7=/run/military-forge/gs7.sock`, with each gs@N started with `WT_SOCKET=/run/military-forge/gsN.sock`. Each game server advertises its own URL (`https://<node>/wt/<N>`, from `WT_PUBLIC_URL` + its path) in `/health`, so the join ticket only needs the WebSocket address. It uses the node's wildcard certificate (`WT_CERT`/`WT_KEY`; reloaded on SIGHUP or when the files change after renewal). systemd: `wt-gateway.service` runs as the gs@ user, shares `RuntimeDirectory=military-forge` (mode 0700; the sockets are 0600), `Restart=always`, `KillSignal=SIGTERM`, `TimeoutStopSec=10`: on SIGTERM it drains, closing sessions with 1001 so players resume (over WebSocket until it's back) and keep their match. A gs@N restart costs only its own sessions. Limits: 1000 sessions per node and 8 per IP (`WT_MAX_SESSIONS`, `WT_MAX_SESSIONS_PER_IP`). Each game server pings its gateway every second and stops advertising it after 3 s of silence.

**The trial box (19 Oct 2026; docs/net-trial.md §1.1)** runs the same pieces on one machine: one game server with `WT_SOCKET=/run/military-forge/gs1.sock`, one gateway on UDP 443 (`WT_PUBLIC_URL=https://<host>/wt`, no `WT_ROUTES`) using a copy of Caddy's Let's Encrypt certificate, and Caddy limited to HTTP/1.1 and HTTP/2 so UDP 443 is free. The firewall rule it needs is **UDP 443 inbound from anywhere**.

Images are built once in CI (`ghcr.io/…/game-server:{sha}`), pulled per node, and rolled with drain (06-architecture §5.4). Node bootstrap is scripted with Ansible or cloud-init, so adding a region is about one hour of work.

---

## 9. Observability: the dashboards to build first

1. **Fleet:** CCU by region/mode, rooms per process, capacity headroom, draining nodes, version mix.
2. **Tick health:** tick duration p50/p99 per process, overruns per minute, event-loop delay, GC pauses.
3. **Network quality:** RTT/jitter/loss per region and per country/ASN, transport type split (WS vs WT), snapshot size p95, corrections per minute.
4. **Matchmaking:** queue sizes, time-to-match p50/p95 per mode/region, bot fill ratio, failed allocations.
5. **Business:** DAU, D1/D7/D30, conversion, ARPDAU, ad impressions/revenue (by portal).
6. **Errors:** Sentry crash-free sessions, WebGL context-loss rate, room crashes.

**Alerts:** tick p99 > 12 ms for 5 min · region capacity < 20% · allocation failures > 1% · API p95 > 300 ms · Postgres connections > 80% · error spike after deploy (auto-rollback candidate).

---

## 10. Backups, DR, and runbooks

- Postgres PITR (Neon built-in) + a nightly logical dump to R2 in another region; a **restore drill** monthly.
- Redis is treated as cache/ephemeral: the system recovers from an empty Redis (parties reset, queues requeue, room registry rebuilt from fleet heartbeats within 10 s).
- Infrastructure as code (Terraform/Pulumi for cloud resources, Ansible for nodes) in `infra/`.
- Runbooks: region outage (mark the region unavailable in the API → matchmaker reroutes to the next-best region), DB failover, DDoS event, bad deploy rollback, maintenance mode (banner → drain → deploy → reopen), secret rotation.
