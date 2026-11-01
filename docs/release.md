# Releases: local, staging, production

Three places run the game. Code moves one way: **local → dev `main` → staging → production**.

| | Where | Runs | Data |
|---|---|---|---|
| **Local** | your machine: `pnpm dev`, `pnpm playtest --local` | your working tree | in memory / PGlite, thrown away |
| **Staging** | https://staging.40-123-240-224.sslip.io | public repo `main` | its own database and Valkey, test data |
| **Production** | https://40-123-240-224.sslip.io | public repo `production` | the players' |

Staging and production share one Azure VM (2 vCPU, 4 GB) and cost nothing extra. Staging is the same
build with a small "Staging" tag at the top of the screen, `noindex` on every page and response, and
no ping probe or WebTransport (games there run over WebSocket).

## The branches

- **Dev repo** (`samie105/max-militia`, remote `origin`): all work and history. Agents' branches merge into `main`.
- **Public repo** (`samie105/military-forge`, remote `public`): snapshots only, one commit per publish,
  authored by the owner's GitHub noreply address. No dev history ever goes there.
  - `main`: what staging runs. Every publish lands here.
  - `production`: what production runs. It only ever points at a commit already on public `main`,
    so production only gets what staging has had.

## The commands

Run from the dev checkout (any worktree; they need the `public` remote and `~/.ssh/mf-azure`).

```sh
scripts/release/publish.sh "What changed, in a line"   # dev origin/main -> public main
scripts/release/deploy.sh staging                      # public main -> staging
scripts/release/promote.sh <public commit>             # public production -> that commit (on public main)
scripts/release/deploy.sh production                   # public production -> production
```

A normal release: merge into dev `main` and push, `publish.sh`, `deploy.sh staging`, play it on
staging, then `promote.sh` the commit `publish.sh` printed and `deploy.sh production`.

- `publish.sh` refuses without a message, when local `main` has commits `origin` hasn't (push
  first), and when there is nothing new.
- `promote.sh` refuses a commit that isn't on public `main`. It moves `production` forward (a
  release) or back (a rollback). It does not deploy.
- `deploy.sh` copies that branch's own setup script (`scripts/net-trial/cloud-init.sh` at that
  commit) to the box and runs it as root with `MF_ENV` and `MF_REF`. Only one deploy runs at a time.
  It prints the exit code, the setup's last phases (the last is `== ready`) and the HTTP codes of
  `/`, `/api/health` and `/health`. The full log stays on the box in `/tmp/mf-deploy-<env>.log`
  (mode 0600). It contains the admin token, so read it there and don't paste it anywhere.
- A production deploy keeps live matches: the game server drains first when its code changed
  (`docs/net-trial.md` §5), so a deploy can take up to 10 minutes.

## Rolling production back

```sh
git fetch public && git log --oneline public/main     # find the last good commit
scripts/release/promote.sh <that commit>             # says "rollback: …"
scripts/release/deploy.sh production
```

The database is not rolled back. Before rolling back past a commit that changed the database
(`apps/api` migrations), check the older code still runs on the newer schema on staging first. The
nightly dumps are in `/var/backups/military-forge` if data itself needs restoring.

## On the box

| | Production | Staging |
|---|---|---|
| Setup script | `/usr/local/sbin/mf-trial-setup` | `/usr/local/sbin/mf-staging-setup` |
| Code, build, pages | `/opt/military-forge/{src,web,public}` | `/opt/military-forge-staging/{src,web,public}` |
| Node | `/opt/node` | `/opt/military-forge-staging/node` |
| Data, logs | `/var/lib/military-forge`, `/var/log/mf-trial.log` | `/var/lib/military-forge-staging`, `/var/log/mf-trial-staging.log` |
| Secrets and settings | `/etc/military-forge/` | `/etc/military-forge-staging/` |
| Units | `mf-api` (8787), `mf-game` (9001, admin 9002), `mf-probe` (9300), `mf-wt` (UDP 443) | `mf-stg-api` (8887), `mf-stg-game` (9101, admin 9102) |
| Unix user | `mf` | `mf-staging` |
| Postgres | database and role `mf` | database and role `mf_staging` (same server) |
| Valkey | `valkey-server`, port 6379 | `valkey-server@staging`, port 6380, 64 MB |
| Caddy | `/etc/caddy/Caddyfile` (global options, its site, `import /etc/caddy/mf-env/*.caddy`) | `/etc/caddy/mf-env/staging.caddy` |

Each environment's `/etc` directory holds its own secrets, made on the box the first time and never
copied between them: `secrets` (admin token, owner page), `db` (Postgres and Valkey passwords),
`access.key`, `ticket.key`, `results.key`. Settings the owner adds by hand go in the same directory:

- `store.env`: Flutterwave keys. Staging takes only test keys (`FLWSECK_TEST-…`); with a live key
  there, staging's store stays off.
- `email.env`: account emails. Staging has none, so it sends no email until one is written there.

Each deploy writes only its own Caddy site; Caddy reloads only when that site changed. Staging's
units are capped (700 MB each, a low CPU weight), so production comes first when both are busy.
The owner page and admin link for staging are in `/etc/military-forge-staging/secrets` (`OWNER`,
`ADMIN_TOKEN`), the same way as production's.
