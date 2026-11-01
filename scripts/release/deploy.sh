#!/bin/bash
# Deploys an environment on the box: its public branch's own setup script (scripts/net-trial/
# cloud-init.sh at that commit), run as root with MF_ENV and MF_REF. Prints the exit code, the
# phases and the ready line, then checks the site answers. The full log stays on the box
# (/tmp/mf-deploy-<env>.log, 0600): it holds the admin token, so it is never printed here.
# docs/release.md
#   scripts/release/deploy.sh staging       # public main       -> https://staging.<box>.sslip.io
#   scripts/release/deploy.sh production    # public production -> https://$PROD_HOST (lib.sh); the
#                                           # box's own <box>.sslip.io then moves players there
# shellcheck disable=SC1091
. "$(dirname "$0")/lib.sh"
env=${1:-}
case $env in
staging) branch=main ;;
production) branch=production ;;
*) die 'usage: deploy.sh staging|production' ;;
esac
fetch "$PUB"
c=$(git rev-parse --verify -q "$PUB/$branch^{commit}") || die "no $PUB/$branch"
setup="${PUB}/${branch}:scripts/net-trial/cloud-init.sh"
git cat-file -e "$setup" 2>/dev/null || die "no scripts/net-trial/cloud-init.sh on $PUB/$branch"
# a setup from before staging existed ignores MF_ENV and would deploy main over production
if [ "$env" = staging ] && ! git show "$setup" | grep -q 'MF_ENV'; then
  die "$PUB/main's setup predates staging (no MF_ENV): publish a main with docs/release.md first"
fi
if [ "$env" = production ] && ! git show "${PUB}/${branch}:scripts/net-trial/site.sh" 2>/dev/null | grep -q 'mf-env'; then
  echo "note: this production commit's Caddy config predates staging: the staging site is dropped until deploy.sh staging runs again"
fi
ip=${BOX#*@}
host=${ip//./-}.sslip.io
[ "$env" = staging ] && host=staging.$host
hosts=''
if [ "$env" = production ] && [ -n "$PROD_HOST" ]; then
  # Caddy can't get a certificate for a name that doesn't lead here yet: the site would go dark
  resolved=$(dig +short A "$PROD_HOST" @1.1.1.1 2>/dev/null | tail -1)
  [ "$resolved" = "$ip" ] || die "$PROD_HOST leads to '${resolved:-nothing}', not $ip: add its A record at the DNS host first"
  hosts=" MF_HOST=$PROD_HOST MF_OLD_HOSTS=$host"
  host=$PROD_HOST
fi
site=${MF_SITE:-https://$host}
echo "deploying $env: $PUB/$branch ${c:0:7} ($(git log -1 --format=%s "$c")) on $BOX"
ssh=(ssh -o BatchMode=yes -o ConnectTimeout=20 -i "$BOX_KEY" "$BOX")
git show "$setup" | "${ssh[@]}" "sudo sh -c 'umask 077 && cat >/root/mf-setup-$env.sh'"
# one deploy at a time on the box (both share apt, Caddy and Postgres)
out=$("${ssh[@]}" "umask 077; sudo flock -w 1800 /run/mf-deploy.lock env MF_ENV=$env MF_REF=$branch$hosts bash /root/mf-setup-$env.sh >/tmp/mf-deploy-$env.log 2>&1; echo rc=\$?; grep -aE '^\[mf-trial [0-9:]+\] (commit |== )' /tmp/mf-deploy-$env.log | tail -4")
# the phase lines carry no secrets; the redaction is a second guard
printf '%s\n' "$out" | sed -E 's/(#t=|token[=:/]|TOKEN=)[^ ]*/\1<hidden>/g'
rc=$(printf '%s\n' "$out" | sed -n 's/^rc=\([0-9]*\)$/\1/p' | head -1)
[ "${rc:-1}" = 0 ] || die "$env setup failed (rc=${rc:-?}): ssh $BOX 'sudo tail -40 /tmp/mf-deploy-$env.log' shows why (it holds the admin token: don't paste it)"
fail=0
for p in / /api/health /health; do
  code=$(curl -s -o /dev/null -m 20 -w '%{http_code}' "$site$p") || true
  echo "$site$p $code"
  [ "$code" = 200 ] || fail=1
done
[ $fail = 0 ] || die "$env is up but not every page answered 200"
echo "$env ok: $site runs ${c:0:7}"
