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
| Services | Runs systemd units as an unprivileged `mf` user, each bound to 127.0.0.1:<br>• `mf-api` (port 8787): guests and room codes, with an embedded database in `/var/lib/military-forge`.<br>• `mf-game` (port 9001): Street Market with bots filling to 4 players, the test armory, and room-host tuning (the playtest's defaults). The admin API is on port 9002.<br>• `mf-probe` (port 9300): the ping test's echo and results service. |
| Room | Mints one room through the API, as `pnpm playtest` does, and keeps it open. The code is held in `KEEP_ROOMS`, and the `mf-room.timer` joins the room every 2 h, so its 6 h expiry keeps sliding. |
| Links | Public: `https://<host>/trial-status/` shows the room link and the probe link.<br>Private: `https://<host>/owner-<random>/` shows the admin link (`/admin#t=<token>`) and the probe results export.<br>The private links appear only in the log (`/var/log/mf-trial.log`) and on the **serial console**. |

Caddy routes `/` and `/r/<code>` to the game. `/api/*` goes to the API, `/ws/*` and `/health` to the game server, `/admin` to the admin page (`/admin/api/*` needs the token), `/probe` to the ping test, and `/echo` and `/probe-api/*` to the probe service. Game and echo sockets from pages on other sites get 403. Caddy keeps no access log.

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
       - **Custom UDP**, port 443, source `0.0.0.0/0` (WebTransport later; harmless now).
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
  - It shows the median, p95, jitter and loss, then saves the run on the box.
  - Ask people to run it more than once: at different times of day, and on mobile data as well as Wi-Fi.

What the probe stores, in `/var/lib/military-forge/probe/results.jsonl`:

- What the tester typed, and the raw round-trip times.
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

## 5. Update, stop, delete

- **New code:** user data runs only on the first boot.
  - With SSH: `sudo /usr/local/sbin/mf-trial-setup` pulls `main` again, rebuilds and restarts. The room, the admin link, the keys and the probe results stay.
  - Without SSH: launch a new instance and terminate the old one. The address changes, so the room link does too.
- **Reboot:** everything comes back by itself (systemd and swap).
- **Delete (stops the bill):**
  1. **Download the results first** (§4).
  2. **EC2 → Instances →** select the instance **→ Instance state → Terminate**. This deletes its disk.
  3. Then delete the `mf-trial-lagos` security group and the Lagos subnet.
  4. The region and zone opt-ins cost nothing and can stay.

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

## 8. Later (optional)

- **Johannesburg:** a Google Cloud VM in `africa-south1`, Ubuntu 24.04, with the same script as its **startup script** (Metadata → `startup-script`). The script reads GCE's external IP. GCE runs startup scripts on every boot, and the script is safe to re-run. Then point both probe pages at each other.
- **Probe in `pnpm playtest`:** serve `/probe`, `/echo` and `/probe-api` from the playtest proxy, to measure from the Mac.
