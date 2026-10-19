#!/usr/bin/env bash
# Runs cloud-init.sh in a local Ubuntu 24.04 container with systemd, the way a fresh VM would, against a
# branch of this repo (it must be committed): Caddy uses its own CA (no Let's Encrypt), the host name is
# 127-0-0-1.sslip.io and https is on localhost:8443. Then checks the pages, the API, a game socket, the
# probe's echo and results, the owner's links, and the data stores (Postgres, Valkey, backups). Heavy
# (pnpm install + vite build in the container): it runs under the shared lock.
#
#   scripts/net-trial/test/docker-test.sh [branch]      # default: the current branch
#   FROM=<ref> …                                        # first set the box up with <ref>'s script and code
#                                                       # (e.g. a PGlite-era main), make a guest, then upgrade
#   KEEP=1 …                                            # leave the container running afterwards
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(git -C "$here" rev-parse --show-toplevel)"
branch="${1:-$(git -C "$repo" rev-parse --abbrev-ref HEAD)}"
name=mf-trial-test
# under $HOME: Colima shares only the home directory with its VM
work="$HOME/.military-forge/net-trial/docker-test"
rm -rf "$work" && mkdir -p "$work"
git clone -q --bare --branch "$branch" "$(git -C "$repo" rev-parse --git-common-dir)" "$work/repo.git"
if [[ -n ${FROM:-} ]]; then
  git -C "$repo" push -q "$work/repo.git" "$(git -C "$repo" rev-parse "$FROM^{commit}"):refs/heads/mf-from"
  git -C "$repo" show "${FROM}:scripts/net-trial/cloud-init.sh" >"$work/from-cloud-init.sh"
fi
docker build -q -t mf-trial-vm "$here" >/dev/null
docker rm -f "$name" >/dev/null 2>&1 || true
docker run -d --name "$name" --privileged --cgroupns=host -v /sys/fs/cgroup:/sys/fs/cgroup:rw --tmpfs /run --tmpfs /run/lock \
  -v "$work:/work:ro" -v "$here/../cloud-init.sh:/cloud-init.sh:ro" -p 127.0.0.1:8443:443 mf-trial-vm >/dev/null
cleanup() { [[ ${KEEP:-0} == 1 ]] || docker rm -f "$name" >/dev/null 2>&1 || true; }
trap cleanup EXIT
sleep 3
# the bare repo belongs to this Mac's user, not the box's mf user
trust=(-e GIT_CONFIG_COUNT=1 -e GIT_CONFIG_KEY_0=safe.directory -e GIT_CONFIG_VALUE_0='*')
box=(-e MF_REPO=file:///work/repo.git -e MF_HOST=127-0-0-1.sslip.io -e MF_TLS=internal -e MF_ORIGIN_PORT=8443)
if [[ -n ${FROM:-} ]]; then
  echo "== $FROM's cloud-init.sh first (the box before the upgrade)"
  lockf -k /tmp/military-forge-heavy.lock docker exec "${trust[@]}" "${box[@]}" -e MF_REF=mf-from "$name" bash /work/from-cloud-init.sh | tail -8 | sed 's/^/  | /'
  # a guest with a name, made before the upgrade: docker-check.mjs checks it survives
  docker exec "$name" sh -c "curl -fsS -X POST -H 'content-type: application/json' -d '{\"nickname\":\"Kemi Before\"}' http://127.0.0.1:8787/auth/guest >/root/mf-before.json"
fi
echo "== cloud-init.sh in the container (branch $branch)"
lockf -k /tmp/military-forge-heavy.lock docker exec "${trust[@]}" "${box[@]}" -e MF_REF="$branch" "$name" bash /cloud-init.sh | sed 's/^/  | /'
echo "== a second run (idempotent)"
lockf -k /tmp/military-forge-heavy.lock docker exec "${trust[@]}" "${box[@]}" -e MF_REF="$branch" "$name" bash /usr/local/sbin/mf-trial-setup | tail -8 | sed 's/^/  | /'
echo "== checks"
node "$here/docker-check.mjs" "$name"
