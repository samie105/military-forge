#!/bin/bash
# Keeps the trial room open (cloud-init.sh installs it as /usr/local/sbin/mf-room; a timer runs it every 2 h).
# It plays as ONE guest, kept in $ETC/room-guest (its refresh token, rotated on each run), instead of a new guest
# every run (audit P-12: 233 of the first 267 "players" were this script). A lost or rejected token makes one more.
# shellcheck disable=SC2034,SC2019,SC2086
API=${MF_ROOM_API:-http://127.0.0.1:8787} ETC=${MF_ETC:-/etc/military-forge}
up() { for i in $(seq 120); do curl -fs -o /dev/null -m 3 $API/health && return 0; sleep 1; done; return 1; }
call() { printf 'header = "Authorization: Bearer %s"\n' "$3" | curl -sS -K - -X "$1" -H 'content-type: application/json' -d '{}' -o /tmp/mf-room.json -w '%{http_code}' -m 10 "$API$2"; }
# the session's access token on stdout; the new refresh token saved (owner-only) for the next run
keep() { local r=$1; (umask 077 && jq -er .refreshToken <<<"$r" >"$ETC/room-guest.new") && mv "$ETC/room-guest.new" "$ETC/room-guest"; jq -er .accessToken <<<"$r"; }
guest() {
  local r saved
  saved=$(tr -dc 'A-Za-z0-9._~+/=-' 2>/dev/null <"$ETC/room-guest")
  if [ -n "$saved" ] && r=$(jq -nc --arg t "$saved" '{refreshToken:$t}' | curl -fsS -X POST -H 'content-type: application/json' -d @- -m 10 $API/auth/refresh); then
    keep "$r" && return 0
  fi
  r=$(curl -fsS -X POST -H 'content-type: application/json' -d '{}' -m 10 $API/auth/guest) || return 1
  keep "$r"
}
up || exit 1
token=$(guest) || exit 1
code=$(tr -dc A-Z 2>/dev/null <$ETC/room-code)
if [ -n "$code" ]; then
  [ "$(call POST /rooms/$code/join "$token")" = 200 ] && exit 0
  systemctl restart mf-api; up
  [ "$(call POST /rooms/$code/join "$token")" = 200 ]; exit
fi
[ "$(call POST /rooms "$token")" = 201 ] || exit 1
code=$(jq -r .code /tmp/mf-room.json)
[[ $code =~ ^[A-Z]{6}$ ]] || exit 1
echo "$code" >$ETC/room-code
sed -i "s/^KEEP_ROOMS=.*/KEEP_ROOMS='$code'/" $ETC/api.env
echo "made room $code"
