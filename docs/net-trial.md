# Net trial: a hosted game server in Lagos

> One AWS EC2 box in the **Lagos Local Zone** (`af-south-1-los-1`), launched by clicking through the AWS web console. It runs the game for friends on phones and laptops, plus a ping-test page at `/probe`. No AWS keys, no SSH and no CLI are needed: everything happens in the console and the browser.
>
> The box runs [`scripts/net-trial/cloud-init.sh`](../scripts/net-trial/cloud-init.sh), pasted into the launch wizard's **User data** box. Later steps, both optional, are a second region (Johannesburg on Google Cloud `africa-south1`, using the same script as a GCE startup script) and a probe inside `pnpm playtest`.

## 0. Before launch: publish

The box clones the **public** repo, `https://github.com/samie105/military-forge`, at `main`, so it only gets what has been published. Merge this PR, then publish main as a snapshot (see the repo notes). Without the published probe page and probe service, the box still serves the game and says "Probe: not in this build".

## 1. What the box does (about 15 minutes after launch)

| Step | What |
|---|---|
| Address | Reads its public IPv4 from the instance metadata and serves `https://<ip-with-dashes>.sslip.io`. For example, `102.89.10.20` becomes `102-89-10-20.sslip.io`. |
| Caddy first | Caddy starts early with a Let's Encrypt certificate, so `https://<host>/trial-status/` shows progress while the rest installs. The page refreshes itself. |
| Swap | Adds 4 GB of swap (2 GB on a small disk), so the web build fits in a t3.medium's 4 GB. |
| Code | Runs `git clone --depth 1` of the public repo. No credentials are needed. |
| Node, pnpm | Installs the newest Node in the major that `package.json` `engines` names, checked against nodejs.org's SHA-256 list. Installs pnpm at the version in `packageManager`. |
| Build | Installs the web, API and game-server dependencies with `pnpm install --frozen-lockfile`, runs the production `vite build`, and fetches uWebSockets.js. |
| Services | Runs systemd units as an unprivileged `mf` user, each bound to 127.0.0.1:<br>• `mf-api` (port 8787): guests and room codes, on Postgres and Valkey (next row).<br>• `mf-game` (port 9001): Street Market with bots filling to 4 players, the test armory, and room-host tuning (the playtest's defaults). The admin API is on port 9002.<br>• `mf-probe` (port 9300): the ping test's echo and results service. |
| Data | `scripts/net-trial/data.sh` (sourced by the script, which can't grow past 16 KB) sets up **Postgres 16** and **Valkey** from Ubuntu's packages:<br>• Both listen on localhost only and need a password. The passwords are generated once and kept in `/etc/military-forge/db` (0600, root); the API's env file holds its `DATABASE_URL` and `REDIS_URL`, and the API runs with `NODE_ENV=production`, so it won't start without them.<br>• Valkey writes an append-only file and never evicts keys, so room codes and rate limits survive a restart.<br>• A deploy restarts Postgres or Valkey only when its settings changed, so it doesn't drop the API's connections. If Valkey does restart, the API logs one line when it goes away and one when it's back.<br>• `mf-backup.timer` dumps the database at 02:30 UTC each night into `/var/backups/military-forge/mf-YYYY-MM-DD.dump` and keeps the newest 7.<br>• A box that ran on the older embedded database (PGlite) has its rows copied into Postgres on the first run; the old directory stays as `/var/lib/military-forge/pglite.imported-<time>`. Guests keep their names and stay signed in. |
| Room | Mints one room through the API, as `pnpm playtest` does, and keeps it open. The code is held in `KEEP_ROOMS`, and the `mf-room.timer` joins the room every 2 h, so its 6 h expiry keeps sliding. |
| Links | Public: `https://<host>/trial-status/` shows the room link and the probe link.<br>Private: `https://<host>/owner-<random>/` shows the admin link (`/admin#t=<token>`) and the probe results export.<br>The private links appear only in the log (`/var/log/mf-trial.log`) and on the **serial console**. |

Caddy routes `/` and `/r/<code>` to the game. `/api/*` goes to the API, `/ws/*` and `/health` to the game server, `/admin` to the admin page (`/admin/api/*` needs the token), `/probe` to the ping test, and `/echo` and `/probe-api/*` to the probe service. Game and echo sockets from pages on other sites get 403. Caddy keeps no access log.

### 1.1 WebTransport (UDP 443)

Since 19 Oct 2026 the box also runs the WebTransport gateway (`apps/wt-gateway`, docs/05 §2.3), so browsers that can play over QUIC datagrams do, and the rest stay on WebSocket. On a lossy mobile path a lost datagram costs only itself; on TCP it holds up everything behind it for a round trip (NOTES §16, and `pnpm --filter @military-forge/game-server netfeel`). [`scripts/net-trial/wt-setup.sh`](../scripts/net-trial/wt-setup.sh) does it in two steps, called by `cloud-init.sh`:

- **`env`, before the services start:** a systemd drop-in gives `mf-game` `WT_SOCKET=/run/military-forge/gs1.sock` in a private directory shared with the gateway, and UDP buffers sized for QUIC (sysctl `net.core.rmem_max`/`wmem_max` = 2.5 MB).
- **`gateway`, after the box is ready** (the game already works over WebSocket meanwhile):
  - **The binary:** built on the box. Rust comes from rustup (its SHA-256 checked), and the toolchain is the one `apps/wt-gateway/rust-toolchain.toml` pins. Both live in `/opt/rust`, with the build cache in `/var/cache/mf-wt-target`.
    - The first build takes a few minutes on 2 vCPUs. A re-run rebuilds only what changed, so it takes seconds when the gateway didn't change.
    - A prebuilt linux x86_64 binary can be used instead: set `MF_WT_URL` and `MF_WT_SHA256`. Building on the box was chosen because the repo's Actions are off and a release asset would need its own publishing step.
  - **The certificate:** Caddy's Let's Encrypt certificate for the box's name, copied to `/etc/military-forge/wt/` (root:mf, 0640). The `mf-wt-cert.timer` copies it again daily after a renewal and sends the gateway SIGHUP.
  - **The service:** `mf-wt.service` runs as `mf` with only `CAP_NET_BIND_SERVICE`, on UDP 443 (`WT_ADDR=0.0.0.0:443`, `WT_PUBLIC_URL=https://<host>/wt`).
    - Caddy no longer serves HTTP/3 (`protocols h1 h2`), so UDP 443 is the gateway's.
    - The game server advertises the gateway in `/health` (`webtransport: {url, certHashes: [], rooms: true}`), which is how the page finds it: no client setting.
  - **Self-test:** `/health` must advertise the gateway. Then `mf-wt-probe` opens a real QUIC session to `https://127.0.0.1/wt` (the certificate pinned by hash) and waits for its stream (`READY`). The result is in `/var/log/mf-trial.log`.
  - **If any step fails**, the log says why and the game stays on WebSocket.
  - **Re-running just the gateway** (after a fix, or to see the self-test again): `sudo bash /opt/military-forge/src/scripts/net-trial/wt-setup.sh gateway`. It needs no settings (the box's name comes from Caddy's site). With no argument the script prints its usage. A full `sudo /usr/local/sbin/mf-trial-setup` runs it too.
  - **The self-test said "no WebTransport session" on the live box (19 Oct) while browsers connected fine.** The cause was the check itself: under `pipefail`, `grep -q` stopping at READY made the probe's pipe fail. It now reads the probe's whole output. It connects to 127.0.0.1 (Azure doesn't hairpin to the VM's own public address) with the certificate pinned by hash, and prints the probe's last lines when it does fail.
- **Firewall:** allow **UDP 443 inbound from anywhere** (Azure: an inbound rule in the VM's network security group, protocol UDP, destination port 443, source Any; AWS: the security group rule above), next to TCP 80 and 443. Ubuntu's own firewall is off.
- **Checking it from a phone:** the HUD's net readout says WT or WS. `https://<host>/health` shows the advertised gateway.
- **Caching (Caddy):**
  - Vite's hashed files right under `/assets/` (`name-xxxxxxxx.ext`) are kept a year, immutable.
  - Everything else under `/assets/` (public/: maps, kits, billboard pools and art) keeps its name when it changes, so it revalidates (`no-cache`, ETag). On 24 Oct a week-old cached `house.json` kept deleted billboard art on screen.
  - The pages, `sw.js` and the manifest are `no-cache` too (26 Oct). With no header, a browser kept an old page, and that page asked for the previous build's files.
  - Each deploy also carries the last 14 days of hashed `.js`/`.css` into the new build, never over its own files. An open tab or installed app from before the deploy still finds the Locker's or the Armory's code instead of showing a blank screen.

## 2. AWS console: exact clicks

You need an AWS account with billing set up. Pick the region from the region menu at the top right.

1. **Turn on the Cape Town region** (Lagos hangs off it). Click the account menu (top right) → **Account** → **AWS Regions** → **Africa (Cape Town) af-south-1** → **Enable**. It takes a few minutes. Then switch the console to **Africa (Cape Town)**.
2. **Turn on the Lagos Local Zone.** Go to **EC2** → **Settings** (bottom of the left menu) → **Zones** → **Manage**. Set **af-south-1-los-1 (Nigeria / Lagos)** to **Enabled** and save. This is free.
3. **Make a subnet in Lagos.** Go to **VPC** → **Subnets** → **Create subnet**. Then:
   - VPC: the **default VPC** (`172.31.0.0/16`).
   - Availability Zone: **af-south-1-los-1a** (Lagos).
   - IPv4 subnet CIDR: **`172.31.200.0/24`**. Any free /24 in the VPC will do; the default subnets sit at `172.31.0.0`, `.16.0` and `.32.0`.
   - Click **Create subnet**.
   - Select the new subnet → **Actions** → **Edit subnet settings** → tick **Enable auto-assign public IPv4 address** → **Save**.
   - The default VPC's main route table already sends traffic to its internet gateway, so routing needs nothing else.
4. **Launch the instance.** Go to **EC2** → **Instances** → **Launch instances**.
   - **Name:** `mf-trial-lagos`.
   - **Application and OS image:** **Ubuntu** → **Ubuntu Server 24.04 LTS (HVM), SSD Volume Type**, architecture **64-bit (x86)**.
   - **Instance type:** **t3.medium** (2 vCPU, 4 GB). If the Lagos zone doesn't list it, pick the smallest type it offers, for example t3.xlarge.
   - **Key pair:** **Proceed without a key pair**. SSH isn't needed. If you want SSH as a fallback, create one here and see the SSH bullet below.
   - **Network settings** → **Edit**:
     - VPC: default. Subnet: the **Lagos subnet** from step 3. Auto-assign public IP: **Enable**.
     - Firewall: **Create security group**, named `mf-trial-lagos`. Rules:
       - **HTTP**, TCP 80, source `0.0.0.0/0` (for Let's Encrypt and the redirect to https).
       - **HTTPS**, TCP 443, source `0.0.0.0/0` (the game, websockets and the probe).
       - **Custom UDP**, port 443, source `0.0.0.0/0` (WebTransport, §1.1).
     - **Remove the SSH (22) rule.** It isn't needed. If you keep SSH, set its source to **My IP** only.
   - **Configure storage:** **20 GiB**, volume type **gp2**. Local Zones don't all offer gp3, and 8 GiB is too small for Node, the build and swap.
   - **Advanced details:**
     - **Credit specification:** **Unlimited**, so a t3 is never throttled mid-match.
     - **User data:** paste the **whole** of `scripts/net-trial/cloud-init.sh`. On GitHub, open the file → **Raw** → select all → copy. It is under the 16 KB limit, and a test keeps it there. Leave "User data has already been base64 encoded" **unticked**.
   - Click **Launch instance**.
5. **Wait about 15 minutes.** Open the instance and copy its **Public IPv4 address**, for example `102.89.10.20`. Then open **`https://102-89-10-20.sslip.io/trial-status/`**.
   - At first the browser may not reach it. Caddy gets its certificate within a minute or two of boot.
   - The page shows each step (installing packages, downloading the game, installing Node and pnpm, installing dependencies, building, starting) and then **ready**, with the room link.
   - If a step fails, the page shows the end of the log, with the secrets hidden.
6. **Read the private links without SSH.** Select the instance → **Actions** → **Monitor and troubleshoot** → **Get system log**. Scroll to the end, or search for **`MILITARY FORGE TRIAL SERVER READY`**. The box looks like this:

   ```
   ===== MILITARY FORGE TRIAL SERVER READY =====
   Room:   https://102-89-10-20.sslip.io/r/KQXMZP
   Status: https://102-89-10-20.sslip.io/trial-status/
   Probe:  https://102-89-10-20.sslip.io/probe
   Owner:  https://102-89-10-20.sslip.io/owner-<random>/ (private: admin link, results)
   Admin:  https://102-89-10-20.sslip.io/admin#t=<token>
   =============================================
   ```

   - The system log can lag the box by a few minutes, so press **Refresh**.
   - Bookmark the **Owner** page: it repeats the admin link and the results link from then on.
   - SSH alternative: `sudo grep -A6 'READY' /var/log/mf-trial.log`.

## 3. Share

- **Game:** send the **Room** link.
  - Phones play held sideways. Desktop browsers play with a keyboard and mouse.
  - Bots keep each room with a person in it at 4 players.
  - The room's host can tune the game from the in-match menu.
  - "Play with friends" on the home page makes more rooms.
- **Admin:** the **Admin** link changes every gameplay number live, for every room, as in the playtest. Keep it private.
- **Ping test:** send `https://<host>/probe`.
  - The tester types a city, network (MTN, Airtel, Glo, 9mobile, fibre with the ISP's name, Starlink, other), connection and device.
  - The page sends 300 pings at 30 Hz (the snapshot rate) over a secure WebSocket.
  - It shows the median, p95, jitter and loss.
  - Then it compares other cities with **reference pings** (below), and saves the run on the box.
  - Ask people to run it more than once: at different times of day, and on mobile data as well as Wi-Fi.

**Reference pings: other cities, with no servers of ours** (added 19 Oct 2026, to answer "would Europe or Lagos beat Johannesburg for MTN?" while the Azure student plan blocks the European regions). After its own pings the page times small HTTPS requests to public endpoints in other cities, from the same device at the same moment: 3 requests open the connection (DNS, TCP, TLS) and aren't counted, then 15 more go one at a time on the warm connection, each cache-busted, so each sample is about one round trip. The list is `REFERENCES` in `apps/web/src/probe/stats.ts`:

| City | Endpoint | Why this one |
|---|---|---|
| Lagos | `https://ixpn.ng/favicon.ico` | the Internet Exchange Point of Nigeria's own site (AS36940, Lagos), at the exchange MTN, Airtel and Glo peer at: the best stand-in for a box in a Lagos data centre. No CORS, so timed as an opaque fetch |
| Lagos | `https://nobus.io/favicon.ico` | Nobus, a Nigerian cloud (AS328668, Lagos). Opaque fetch |
| Nearest Cloudflare edge | `https://speed.cloudflare.com/cdn-cgi/trace` | the city it answered from (`colo`), the floor of what the device reaches. MTN Port Harcourt got AMS (Amsterdam) |
| Cape Town, London, Ireland, Spain, Paris, Frankfurt, UAE | `https://dynamodb.<region>.amazonaws.com/ping` | AWS's own health check (~40 bytes, CORS open) in af-south-1, eu-west-2, eu-west-1, eu-south-2, eu-west-3, eu-central-1, me-central-1. London stands in for Azure UK South, Spain for Azure Spain Central |

AWS's Lagos Local Zone has no public endpoint, and no big cloud has a Nigerian region, so Lagos is the two Nigerian sites above. The results table puts each reference next to our server (as `ref:<id>`). The page's privacy line says that these public sites see a visit, as any website would; nothing more about the tester is stored than before. The box's Content-Security-Policy lists these hosts (`apps/web/test/probe.test.ts` checks that).

The probe's own region is named from where the box is (`scripts/net-trial/where.sh`, from the cloud's metadata: Azure `southafricanorth` → `jnb`, Johannesburg; the AWS Lagos zone → `los`; anything else → its zone name). `PROBE_NAME` and `PROBE_PROVIDER` at the top of `cloud-init.sh` override it.

What the probe stores, in `/var/lib/military-forge/probe/results.jsonl`:

- What the tester typed, and the raw round-trip times (the reference pings' too, by reference id).
- The network's ASN, looked up for the /24 (or IPv6 /48) the tester came from.
- A salted hash of that prefix, used to rate-limit and to count networks.

It never stores the IP address, a name or the browser's user agent.

## 4. Results

The owner page's **Probe results** link downloads every run as JSON lines; it holds a secret. To print the city × network table on the Mac:

```sh
echo 'https://102-89-10-20.sslip.io/probe-api/export/<token>' > ~/.military-forge/net-trial/links   # once
scripts/net-trial/results.sh --links-file ~/.military-forge/net-trial/links
```

- The table shows median, p95, jitter and loss per city × network × region.
- Runs that were in a background tab are left out; add `-- --include-backgrounded` to count them.
- `-- --csv` prints CSV instead, and `-- --by-connection` splits mobile data from Wi-Fi.
- The last section lists the ASNs behind each network the testers typed, which catches mislabelled runs.
- Each download is kept in `~/.military-forge/net-trial/results/`.

### 4.1 Snapshot gaps in a live room

`apps/game-server/scripts/live-gaps.ts` joins a fresh room by code as a headless player over WebTransport, and the server's bots fill the room. It logs every snapshot's arrival, its seq and its server tick, then leaves the room. It needs `wt-probe` built (`cargo build --release --bin wt-probe` in `apps/wt-gateway`).

```sh
pnpm --filter @military-forge/game-server exec tsx scripts/live-gaps.ts https://<host> <path/to/wt-probe> 5 out.json
```

It lists every gap of 250 ms or more, with how many snapshots were lost in it and how late it arrived beyond the server ticks it spans:
- **Lost snapshots** are the path.
- **Nothing lost but late** is a delay on the path, or a server stall. The box's room log tells which: `journalctl -u mf-game` prints a line every 10 s with the tick count (600 is on time), `max` tick ms, `dropped` ticks, and `nav builds … between ticks` while bots' graphs build.

Measured on 23 Oct 2026 (NOTES §43): no gap lined up with a server stall.

## 5. Update, stop, delete

- **New code:** user data runs only on the first boot.
  - With SSH: `sudo /usr/local/sbin/mf-trial-setup` pulls `main` again, rebuilds and restarts. The room, the admin link, the keys, the database and the probe results stay.
  - `mf-trial-setup` is the copy of the script the box first ran. To run a newer `cloud-init.sh` (for example the one that added Postgres and Valkey), pull the code, then run the new script from it; it replaces `mf-trial-setup` with itself:
    ```sh
    cd /opt/military-forge/src && sudo -u mf git fetch -q --depth 1 origin main && sudo -u mf git reset -q --hard FETCH_HEAD
    sudo bash scripts/net-trial/cloud-init.sh
    ```
- **Deploys keep live matches** (23 Oct 2026; `scripts/net-trial/restart.sh`):
  - **Web-only changes** leave the game server running. It restarts only when `apps/game-server`, `packages/`, the lockfile or the root `package.json` changed; the deployed tree's hash is kept in `/var/lib/military-forge/game-tree`.
  - **The gateway** (`mf-wt`) restarts only when its binary or service changed, and **Caddy** only when its config did. Either restart drops every connection through it.
  - **When the game server must restart, it drains first** (SIGUSR2):
    - no new rooms open, and their players are told to try again in a moment (close 1012);
    - running rooms play on and still take joiners;
    - once no match is counting down, being played or showing its scoreboard, everyone is told "the server updated" (1012) and the server stops;
    - systemd starts the new code, and pages rejoin the same room with a fresh ticket ("The server updated. Rejoining…"), never "ticket expired".
    - The cap is 10 minutes (`DRAIN_MAX_MS` in `game.env`). `mf-trial-setup` waits for it, so a deploy can take that long; it says so while it waits.
  - **A plain stop** (`systemctl restart mf-game`, a reboot) also tells everyone the server updated first.
- **Database:**
  - Look inside: `sudo -u postgres psql mf`, and `sudo bash -c '. /etc/military-forge/db; REDISCLI_AUTH=$KV_PASS valkey-cli'`.
  - A backup now: `sudo -u postgres mf-backup`.
  - Restore one: `sudo systemctl stop mf-api && sudo -u postgres pg_restore --clean --if-exists -d mf /var/backups/military-forge/mf-<date>.dump && sudo systemctl start mf-api`.
  - Copy the backups off the box before deleting it; they live on its disk.
  - Without SSH: launch a new instance and terminate the old one. The address changes, so the room link does too.
- **Reboot:** everything comes back by itself (systemd and swap).
- **Delete (stops the bill):**
  1. **Download the results first** (§4).
  2. **EC2 → Instances →** select the instance **→ Instance state → Terminate**. This deletes its disk.
  3. Then delete the `mf-trial-lagos` security group and the Lagos subnet.
  4. The region and zone opt-ins cost nothing and can stay.

### 5.1 Account emails ("Forgot password?")

Saved accounts (email + password, Settings → Account) work without this. Until it is set up, "Forgot password?" is hidden and "Save your account" links the email at once. With it, a forgotten password can be reset by an emailed link, and a new email is confirmed by a link before it is saved.

What the owner sets up (nothing here is created for you):
1. **An email-sending account** with a Resend-style HTTP API. With [Resend](https://resend.com): sign up, **Domains → Add domain** (a domain you own), add the DNS records it shows (SPF and DKIM) at your DNS provider, and wait until it says *Verified*.
2. **An API key:** Resend **API Keys → Create**, permission *Sending access*, limited to that domain. It starts with `re_`. Keep it secret.
3. **On the box**, put the three values in `/etc/military-forge/email.env` (read only by root and the `mf` group):
   ```sh
   sudo install -m 0640 -o root -g mf /dev/null /etc/military-forge/email.env
   sudo nano /etc/military-forge/email.env
   ```
   ```sh
   EMAIL_PROVIDER='resend'
   EMAIL_API_KEY='re_...'
   EMAIL_FROM='Military Forge <no-reply@your-domain.com>'
   ```
   Optional: `EMAIL_API_URL` for another provider with the same API (default `https://api.resend.com/emails`), and `APP_URL` if the links should open an address other than the box's own (`CORS_ORIGINS`).
4. **Restart the API:** `sudo systemctl daemon-reload && sudo systemctl restart mf-api`. The setup script (`scripts/net-trial/data.sh`) adds the drop-in that reads the file at the next deploy; it is not in `cloud-init.sh`, which is at EC2's 16 KB limit.
5. **Check:** `curl -s https://<your address>/api/auth/options` says `{"resetByEmail":true}`, and Settings → Account → Sign in shows "Forgot password?". A bad setting stops the API at start with the reason in `journalctl -u mf-api`.

### 5.2 The store (the launch gift and Flutterwave)

The store (docs/17, `apps/api` store/) is off until `/etc/military-forge/store.env` exists. Like `email.env`, a drop-in reads it (`scripts/net-trial/data.sh`) and a deploy never rewrites it.
```sh
sudo install -m 0640 -o root -g mf /dev/null /etc/military-forge/store.env
sudo nano /etc/military-forge/store.env
```
```sh
# the launch gift: items anyone 18+ can claim free, once per account; optional end date
STORE_CLAIMABLE='skin_k47_galaxy_relic_fx'
# STORE_CLAIM_UNTIL='2026-12-31'
# payments (test keys first; never in the repo): Flutterwave → Settings → API Keys and Webhooks
# FLUTTERWAVE_SECRET_KEY='FLWSECK_TEST-...'
# FLUTTERWAVE_PUBLIC_KEY='FLWPUBK_TEST-...'
# FLUTTERWAVE_WEBHOOK_HASH='a long random string, the same as the dashboard's secret hash'
```
Then `sudo systemctl daemon-reload && sudo systemctl restart mf-api`. **Check:** `curl -s https://<your address>/api/store` says `"enabled":true`; a bad value stops the API at start with the reason in `journalctl -u mf-api`. The Flutterwave dashboard's webhook URL is `https://<your address>/api/webhooks/flutterwave`.

## 6. Expected costs (Oct 2026; check the EC2 pricing page's Local Zones tab)

| Item | Rate | 3 days |
|---|---|---|
| t3.medium in Lagos (Local Zone prices sit above Cape Town's ~$0.054/h) | ~$0.06–0.08/h | ~$4.50–6 |
| t3 Unlimited surplus credits (only when busy for long; bots run only while a person is in a room) | $0.05 per vCPU-hour above the 20% baseline | ~$0–5 |
| Public IPv4 address | $0.005/h | ~$0.40 |
| 20 GB gp2 disk | ~$0.12–0.15 per GB-month | ~$0.30 |
| Data out (about 15 KB/s per player; 10 players × 3 h × 3 days ≈ 5 GB, plus ~5 MB per first page load) | ~$0.15/GB | ~$1–2 |
| **Total** | | **≈ $6–15** |

A t3.xlarge, if Lagos doesn't offer the medium, costs about 4× the instance line.

## 7. How it was tested

- `node --test 'scripts/net-trial/**/*.test.mjs'` covers several things:
  - The probe service: the echo through Node's own WebSocket client, the results checks, that no address is stored, the export token, CORS and the rate limit.
  - The results table.
  - `cloud-init.sh`: under 16 KB, `bash -n`, shellcheck, the defaults, and no secrets on the public page.
- `apps/web/test/probe.test.ts` covers the page's statistics and its payload.
- `scripts/net-trial/test/docker-test.sh` runs the whole script in a local Ubuntu 24.04 container with systemd, twice, to check it can be re-run. It uses the committed branch, Caddy's internal CA, and `https://127-0-0-1.sslip.io:8443`. `docker-check.mjs` then checks every route through Caddy:
  - The status and owner pages.
  - The game, the API and a game-socket handshake.
  - The admin API, with and without the token.
  - The probe page, its echo, a saved result and the export.
  - The origin refusals, and that every service is active.
  - The data stores: Postgres and Valkey listen on localhost only and refuse without their passwords, the passwords file is 0600, the API reports both up, the room code is a Valkey key, and a backup run writes a private, restorable dump and prunes to 7.
- `FROM=<ref> scripts/net-trial/test/docker-test.sh` first sets the box up with an older ref's script (e.g. a PGlite-era `main`), makes a named guest, then upgrades. The checks then confirm the guest's row and name are in Postgres and their refresh token still signs them in.

## 8. Later (optional)

- **Johannesburg:** a Google Cloud VM in `africa-south1`, Ubuntu 24.04, with the same script as its **startup script** (Metadata → `startup-script`). The script reads GCE's external IP. GCE runs startup scripts on every boot, and the script is safe to re-run. Then point both probe pages at each other.
- **Probe in `pnpm playtest`:** serve `/probe`, `/echo` and `/probe-api` from the playtest proxy, to measure from the Mac.
