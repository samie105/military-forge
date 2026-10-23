#!/bin/bash
# Keeps the trial room open (cloud-init.sh installs it as /usr/local/sbin/mf-room; a timer runs it every 2 h).
# shellcheck disable=SC2034,SC2019,SC2086
API=http://127.0.0.1:8787 ETC=/etc/military-forge
up() { for i in $(seq 120); do curl -fs -o /dev/null -m 3 $API/health && return 0; sleep 1; done; return 1; }
call() { printf 'header = "Authorization: Bearer %s"\n' "$3" | curl -sS -K - -X "$1" -H 'content-type: application/json' -d '{}' -o /tmp/mf-room.json -w '%{http_code}' -m 10 "$API$2"; }
guest() { curl -fsS -X POST -H 'content-type: application/json' -d '{}' -m 10 $API/auth/guest | jq -r .accessToken; }
up || exit 1
code=$(tr -dc A-Z 2>/dev/null <$ETC/room-code)
if [ -n "$code" ]; then
  [ "$(call POST /rooms/$code/join "$(guest)")" = 200 ] && exit 0
  systemctl restart mf-api; up
  [ "$(call POST /rooms/$code/join "$(guest)")" = 200 ]; exit
fi
[ "$(call POST /rooms "$(guest)")" = 201 ] || exit 1
code=$(jq -r .code /tmp/mf-room.json)
[[ $code =~ ^[A-Z]{6}$ ]] || exit 1
echo "$code" >$ETC/room-code
sed -i "s/^KEEP_ROOMS=.*/KEEP_ROOMS='$code'/" $ETC/api.env
echo "made room $code"
