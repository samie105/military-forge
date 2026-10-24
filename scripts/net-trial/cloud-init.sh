#!/bin/bash
# Military Forge trial server, Ubuntu 24.04: cloud-init user data (docs/net-trial.md).
# Re-run: sudo /usr/local/sbin/mf-trial-setup
# shellcheck disable=SC2015,SC2016,SC2019,SC2086,SC1091

# -- settings
REPO="${MF_REPO:-https://github.com/samie105/military-forge}"
REF="${MF_REF:-main}"
MAP="street-market"
BOTS="4"
BOT_LEVEL="normal"
PROBE_NAME="" # empty: where the box is
PROBE_PROVIDER=""
ACME_EMAIL=""
# local tests only
HOST="${MF_HOST:-}" TLS="${MF_TLS:-auto}" ORIGIN_PORT="${MF_ORIGIN_PORT:-}"
# --

set -uo pipefail
umask 022
LOG=/var/log/mf-trial.log
exec > >(tee -a "$LOG") 2>&1
SRC=/opt/military-forge/src WEB=/opt/military-forge/web ETC=/etc/military-forge DATA=/var/lib/military-forge
PUB=/opt/military-forge/public NODE_DIR=/opt/node
export DEBIAN_FRONTEND=noninteractive HOME=${HOME:-/root} PATH="$NODE_DIR/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
PHASE='starting' ROOM='' COMMIT='' PROBE=0

dl() { curl -fsSL --retry 6 --retry-all-errors --retry-delay 5 -m 300 "$@"; }
try() { for _ in 1 2 3; do "$@" && return 0; sleep 10; done; return 1; }
log() { printf '[mf-trial %s] %s\n' "$(date -u +%H:%M:%S)" "$*"; }
console() { for t in /dev/ttyS0 /dev/console; do [ -w "$t" ] && timeout 2 sh -c 'printf "%s\n" "$1" >"$2"' _ "$1" "$t" 2>/dev/null; done; true; }
esc() { sed 's/&/\&amp;/g; s/</\&lt;/g; s/>/\&gt;/g'; }
redact() { local t; for t in "${ADMIN_TOKEN:-}" "${EXPORT_TOKEN:-}" "${OWNER:-}"; do [ -n "$t" ] && set -- -e "s/$t/<hidden>/g" "$@"; done; [ $# -gt 0 ] && sed "$@" || cat; }

page() { # page <file> <title> <refresh?> <body html>
  mkdir -p "$(dirname "$1")"
  { printf '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">'
    [ "$3" = 1 ] && printf '<meta http-equiv="refresh" content="20">'
    printf '<title>%s</title><style>body{font:16px/1.5 system-ui;max-width:720px;margin:2em auto;padding:0 16px;background:#0e100b;color:#f2eedf}a{color:#d6ff3b;word-break:break-all}.k{color:#959a80}</style></head><body>%s</body></html>\n' "$2" "$4"
  } >"$1.tmp" && mv "$1.tmp" "$1"
}

status() { # the public page and its JSON; the owner's page once the secrets exist
  local ready=0 room_link='' probe_link='' h=''
  [ "$PHASE" = ready ] && ready=1
  [ -n "$ROOM" ] && room_link="$ORIGIN/r/$ROOM"
  [ "$PROBE" = 1 ] && probe_link="$ORIGIN/probe"
  h="<h1>Military Forge trial server</h1><p class=k>$(date -u '+%Y-%m-%d %H:%M UTC') · $HOST · ${COMMIT:-?}</p><p>Status: <b>$(printf '%s' "$PHASE" | esc)</b></p>"
  [ $ready = 1 ] || h="$h<p class=k>Setup takes ~15 min; this page refreshes.</p>"
  [ -n "$room_link" ] && h="$h<p>Game room ($BOTS-player bot fill, $MAP):<br><a href=\"$room_link\">$room_link</a></p><p class=k>Phones: hold sideways.</p>"
  [ -n "$probe_link" ] && h="$h<p>Ping test:<br><a href=\"$probe_link\">$probe_link</a></p>"
  case "$PHASE" in failed*) h="$h<p class=k>The end of the log:</p><pre>$(tail -n 25 "$LOG" | redact | esc)</pre>" ;; esac
  page "$PUB/trial-status/index.html" 'Trial status' "$((1 - ready))" "$h"
  [ -n "${OWNER:-}" ] || return 0
  h="<h1>Owner</h1><p>Private. Admin page:<br><a href=\"$ORIGIN/admin#t=$ADMIN_TOKEN\">$ORIGIN/admin#t=$ADMIN_TOKEN</a></p>"
  [ -n "$room_link" ] && h="$h<p>Room: <a href=\"$room_link\">$room_link</a></p>"
  [ "$PROBE" = 1 ] && h="$h<p>Probe results:<br><a href=\"$ORIGIN/probe-api/export/$EXPORT_TOKEN\">$ORIGIN/probe-api/export/$EXPORT_TOKEN</a></p>"
  page "$PUB/owner-$OWNER/index.html" 'Owner' 0 "$h<p class=k>Status: $(printf '%s' "$PHASE" | esc) · <a href=\"$ORIGIN/trial-status/\">public status page</a></p>"
}

phase() { PHASE="$1"; log "== $1"; status; }
fail() { phase "failed: $1"; console "MILITARY FORGE setup FAILED: $1 ($ORIGIN/trial-status/)"; exit 1; }

# -- the address
log "Military Forge trial setup ($REPO $REF)"
if [ -z "$HOST" ]; then
  ip=''
  t=$(curl -fsS -m 3 -X PUT -H 'X-aws-ec2-metadata-token-ttl-seconds: 300' http://169.254.169.254/latest/api/token 2>/dev/null) &&
    ip=$(curl -fsS -m 3 -H "X-aws-ec2-metadata-token: $t" http://169.254.169.254/latest/meta-data/public-ipv4 2>/dev/null)
  [ -n "$ip" ] || ip=$(curl -fsS -m 3 -H 'Metadata-Flavor: Google' http://169.254.169.254/computeMetadata/v1/instance/network-interfaces/0/access-configs/0/external-ip 2>/dev/null)
  [ -n "$ip" ] || ip=$(curl -fsS -m 10 https://checkip.amazonaws.com 2>/dev/null | tr -d '[:space:]')
  [[ $ip =~ ^[0-9.]+$ ]] || { log "no public IPv4 (turn on auto-assign public IP)"; exit 1; }
  HOST="${ip//./-}.sslip.io"
fi
ORIGIN="https://$HOST${ORIGIN_PORT:+:$ORIGIN_PORT}"
log "this box: $ORIGIN"
mkdir -p "$PUB/trial-status" "$WEB" "$DATA/probe"
ADMIN_TOKEN='' EXPORT_TOKEN='' OWNER=''
phase 'installing packages'

if ! systemd-detect-virt -cq && [ -z "$(swapon --noheadings)" ]; then
  g=$(df --output=avail -BG / | tail -1 | tr -dc 0-9); z=2; [ "$g" -ge 12 ] && z=4
  [ "$g" -ge 6 ] && fallocate -l ${z}G /swapfile && chmod 600 /swapfile && mkswap -q /swapfile && swapon /swapfile && echo '/swapfile none swap sw 0 0' >>/etc/fstab && log "swap ${z} GB"
fi

# -- packages
for _ in 1 2 3; do apt-get update -q >/dev/null && apt-get install -y -q --no-install-recommends caddy git curl ca-certificates jq openssl xz-utils postgresql-16 valkey-server >/dev/null && break; sleep 10; done
type -P caddy jq pg_dump valkey-server >/dev/null||fail 'apt-get install'
id mf >/dev/null 2>&1 || useradd --system --home-dir "$DATA" --shell /usr/sbin/nologin mf
install -d -o mf -g mf -m 0750 "$DATA" "$DATA/probe"
install -d -o mf -g mf -m 0755 "$SRC"
install -d -o root -g mf -m 0750 "$ETC"
chmod 0755 "$PUB" "$PUB/trial-status"
cp -f "$0" /usr/local/sbin/mf-trial-setup 2>/dev/null && chmod 0700 /usr/local/sbin/mf-trial-setup

# -- secrets (made once)
r() { openssl rand -hex "$1"; }
[ -s "$ETC/secrets" ] || (umask 077; printf 'ADMIN_TOKEN=%s\nEXPORT_TOKEN=%s\nOWNER=%s\n' "$(r 24)" "$(r 24)" "$(r 12)" >"$ETC/secrets")
. "$ETC/secrets"
for k in access ticket; do [ -s "$ETC/$k.key" ] || openssl genpkey -algorithm ed25519 -out "$ETC/$k.key"; chown root:mf "$ETC/$k.key"; chmod 0640 "$ETC/$k.key"; done

# -- Caddy first (status page during setup)
[ -f "$WEB/index.html" ] || page "$WEB/index.html" 'Setting up' 1 "<p>Setting up: <a href=\"/trial-status/\">status</a></p>"
{
  # no h3: UDP 443 is WebTransport's
  printf '{\n\tservers {\n\t\tprotocols h1 h2\n\t}\n%s}\n\n%s {\n' "${ACME_EMAIL:+	email $ACME_EMAIL
}" "$HOST"
  [ "$TLS" = internal ] && printf '\ttls internal\n'
  cat <<EOF
	encode zstd gzip
	header {
		Content-Security-Policy "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' data: blob: https://$HOST${ORIGIN_PORT:+:$ORIGIN_PORT} wss://$HOST${ORIGIN_PORT:+:$ORIGIN_PORT} https://*.amazonaws.com https://speed.cloudflare.com https://ixpn.ng https://nobus.io; worker-src 'self' blob:; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'"
		X-Content-Type-Options nosniff
		Referrer-Policy same-origin
	}
	@foreign {
		path /ws/* /echo
		header Origin *
		not header_regexp Origin ^https://${HOST//./\\.}(:[0-9]+)?$
	}
	@game path /ws/* /health
	@probe path /echo /probe-api/*
	@pub path /trial-status /trial-status/* /owner-* /probe-config.json
	route {
		respond @foreign 403
		respond /api/internal/* 404
		handle_path /api/* {
			reverse_proxy 127.0.0.1:8787
		}
		reverse_proxy @game 127.0.0.1:9001
		reverse_proxy /admin/api/* 127.0.0.1:9002
		reverse_proxy @probe 127.0.0.1:9300
		header @pub Cache-Control no-store
		file_server @pub {
			root $PUB
		}
		header /assets/* Cache-Control "public, max-age=604800"
		header /r/* X-Robots-Tag noindex
		rewrite / /index.html
		rewrite /r/* /index.html
		rewrite /admin /admin.html
		rewrite /probe /probe.html
		file_server {
			root $WEB
		}
	}
}
EOF
} >/etc/caddy/Caddyfile.new
caddy validate --adapter caddyfile --config /etc/caddy/Caddyfile.new >/dev/null 2>"$DATA/caddy-validate.log" || { cat "$DATA/caddy-validate.log"; fail 'the Caddy config'; }
# unchanged: no restart (it would drop every WebSocket)
cmp -s /etc/caddy/Caddyfile{.new,} && rm /etc/caddy/Caddyfile.new || { mv /etc/caddy/Caddyfile{.new,} && systemctl restart caddy || fail 'starting Caddy'; }
systemctl enable --quiet --now caddy || fail 'starting Caddy'
log "Caddy up (Let's Encrypt needs ports 80 and 443 open)"

# -- the code
phase 'downloading the game'
as_mf() { runuser -u mf -- env HOME="$DATA" PATH="$PATH" "$@"; }
if [ -d "$SRC/.git" ]; then
  try as_mf git -C "$SRC" fetch -q --depth 1 origin "$REF" && as_mf git -C "$SRC" reset -q --hard FETCH_HEAD || fail "git fetch $REF"
else
  try as_mf git clone -q --depth 1 --branch "$REF" "$REPO" "$SRC" || fail "git clone $REPO"
fi
COMMIT=$(as_mf git -C "$SRC" log -1 --format='%h %cs')
log "commit $COMMIT"
IFS='|' read -r PID pn pp < <(bash "$SRC/scripts/net-trial/where.sh" 2>/dev/null); PID=${PID:-box}
PROBE_NAME=${PROBE_NAME:-${pn:-this box}} PROBE_PROVIDER=${PROBE_PROVIDER:-$pp}

phase 'installing Node and pnpm'
major=$(jq -r '.engines.node // ""' "$SRC/package.json" | grep -o '[0-9]\+' | head -1)
pnpm_v=$(jq -r '.packageManager // ""' "$SRC/package.json" | sed -n 's/^pnpm@\([0-9.]*\).*/\1/p')
[ -n "$major" ] && [ -n "$pnpm_v" ] || fail 'reading engines/packageManager'
node_v=$(dl https://nodejs.org/dist/index.json | jq -r --arg m "v$major." '[.[] | select(.version | startswith($m))][0].version')
[[ $node_v =~ ^v[0-9.]+$ ]] || fail "finding Node $major"
if [ "$("$NODE_DIR/bin/node" -v 2>/dev/null)" != "$node_v" ]; then
  case $(dpkg --print-architecture) in amd64) arch=x64 ;; arm64) arch=arm64 ;; *) fail 'CPU type' ;; esac
  tb="node-$node_v-linux-$arch.tar.xz" tmp=$(mktemp -d)
  dl -o "$tmp/$tb" "https://nodejs.org/dist/$node_v/$tb" && dl -o "$tmp/sums" "https://nodejs.org/dist/$node_v/SHASUMS256.txt" || fail 'downloading Node'
  (cd "$tmp" && grep " $tb\$" sums | sha256sum -c --quiet -) || fail "Node's checksum"
  rm -rf "$NODE_DIR-$node_v" && mkdir -p "$NODE_DIR-$node_v" && tar -xJf "$tmp/$tb" -C "$NODE_DIR-$node_v" --strip-components=1 && ln -sfn "$NODE_DIR-$node_v" "$NODE_DIR"
  rm -rf "$tmp"
fi
[ "$(pnpm -v 2>/dev/null)" = "$pnpm_v" ] || try npm install -g --silent "pnpm@$pnpm_v" >/dev/null || fail "installing pnpm $pnpm_v"
log "node $(node -v), pnpm $(pnpm -v)"

phase 'installing dependencies'
(cd "$SRC" && try as_mf pnpm install --frozen-lockfile --config.strict-dep-builds=false --reporter=append-only --filter '@military-forge/web...' --filter '@military-forge/api...' --filter '@military-forge/game-server...') >"$DATA/pnpm-install.log" 2>&1 ||
  { tail -20 "$DATA/pnpm-install.log"; fail 'pnpm install'; }
(cd "$SRC" && as_mf node scripts/fetch-uws.mjs --quiet) || log "uWebSockets.js didn't download: the game server uses ws"

phase 'building the web app'
(cd "$SRC/apps/web" && as_mf env NODE_ENV=production NODE_OPTIONS=--max-old-space-size=2560 node_modules/.bin/vite build) >"$DATA/build.log" 2>&1 ||
  { tail -20 "$DATA/build.log"; fail 'the web build'; }
rm -rf "$WEB.new" && cp -a "$SRC/apps/web/dist" "$WEB.new" && rm -rf "$WEB" && mv "$WEB.new" "$WEB" || fail 'copying the build'
sed -i "s#%ORIGIN%#$ORIGIN#g; s#</head>#<meta name=\"mf-tune\" content=\"host\" /></head>#" "$WEB"/{index.html,robots.txt,sitemap.xml}
[ -f "$WEB/probe.html" ] && [ -f "$SRC/scripts/net-trial/probe-server/server.mjs" ] && PROBE=1

# -- services
. "$SRC/scripts/net-trial/data.sh" # Postgres and Valkey: sets DB_URL, KV_URL
phase 'starting the game'
pem() { awk '{printf "%s\\n", $0}'; }
envfile() { (umask 027; cat >"$ETC/$1"); chown root:mf "$ETC/$1"; }
ROOM=$(cat "$ETC/room-code" 2>/dev/null | tr -dc A-Z)
envfile api.env <<EOF
NODE_ENV='production'
API_HOST='127.0.0.1'
API_PORT='8787'
DATABASE_URL='$DB_URL'
REDIS_URL='$KV_URL'
ACCESS_TOKEN_PRIVATE_KEY='$(pem <"$ETC/access.key")'
JOIN_TICKET_PRIVATE_KEY='$(pem <"$ETC/ticket.key")'
CORS_ORIGINS='$ORIGIN'
COOKIE_SECURE='true'
TRUST_PROXY='xff'
LOG_LEVEL='warn'
KEEP_ROOMS='$ROOM'
ADMIN_TOKEN='$ADMIN_TOKEN'
EOF
envfile game.env <<EOF
NODE_ENV='production'
HOST='127.0.0.1'
PORT='9001'
DEFAULT_ROOM='0'
MAX_ROOMS='24'
JOIN_TICKET_PUBLIC_KEY='$(openssl pkey -in "$ETC/ticket.key" -pubout | pem)'
TRUST_PROXY='1'
MAP='$MAP'
BOTS='$BOTS'
BOT_LEVEL='$BOT_LEVEL'
HOST_TUNING='1'
ARMORY='1'
ADMIN_TOKEN='$ADMIN_TOKEN'
ADMIN_PORT='9002'
ADMIN_DEFAULTS='$DATA/admin-defaults.json'
EOF
envfile probe.env <<EOF
PORT='9300'
HOST='127.0.0.1'
PROBE_DATA_DIR='$DATA/probe'
PROBE_REGION='$PID'
PROBE_REGIONS='$PID'
PROBE_ORIGINS='$ORIGIN'
PROBE_EXPORT_TOKEN='$EXPORT_TOKEN'
TRUST_PROXY='1'
EOF
jq -n --arg n "$PROBE_NAME" --arg p "$PROBE_PROVIDER" --arg h "$HOST${ORIGIN_PORT:+:$ORIGIN_PORT}" \
  --arg i "$PID" '{trial: "mf-trial", regions: [{id: $i, name: $n, provider: $p, echo: "wss://\($h)/echo"}], results: ["https://\($h)/probe-api/results"]}' >"$PUB/probe-config.json"

unit() { # unit <name> <description> <dir> <command>
  cat >"/etc/systemd/system/$1.service" <<EOF
[Unit]
Description=$2
After=network-online.target postgresql.service valkey-server.service
[Service]
User=mf
Group=mf
WorkingDirectory=$3
EnvironmentFile=$ETC/${1#mf-}.env
Environment=PATH=$NODE_DIR/bin:/usr/bin:/bin
ExecStart=$4
Restart=always
RestartSec=2
LimitNOFILE=65536
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=yes
ReadWritePaths=$DATA
[Install]
WantedBy=multi-user.target
EOF
}
unit mf-api 'Military Forge API' "$SRC/apps/api" "$NODE_DIR/bin/node --import tsx $SRC/apps/api/src/index.ts"
unit mf-game 'Military Forge game server' "$SRC/apps/game-server" "$NODE_DIR/bin/node --max-semi-space-size=64 --import tsx $SRC/apps/game-server/src/index.ts"
unit mf-probe 'Military Forge ping probe' "$SRC" "$NODE_DIR/bin/node $SRC/scripts/net-trial/probe-server/server.mjs"

install -m 0755 "$SRC/scripts/net-trial/mf-room.sh" /usr/local/sbin/mf-room
printf '[Unit]\nDescription=Military Forge: keep the trial room open\nAfter=mf-api.service\n[Service]\nType=oneshot\nExecStart=/usr/local/sbin/mf-room\n' >/etc/systemd/system/mf-room.service
printf '[Unit]\nDescription=Military Forge: keep the trial room open\n[Timer]\nOnBootSec=5min\nOnUnitActiveSec=2h\n[Install]\nWantedBy=timers.target\n' >/etc/systemd/system/mf-room.timer

W="$SRC/scripts/net-trial/wt-setup.sh"
[ -f "$W" ] && bash "$W" env
systemctl daemon-reload
services='mf-api mf-game'
[ "$PROBE" = 1 ] && services="$services mf-probe"
systemctl enable --quiet $services mf-room.timer
bash "$SRC/scripts/net-trial/restart.sh" $services && systemctl start mf-room.timer || fail 'starting the services'
[ "$PROBE" = 1 ] || systemctl disable --now --quiet mf-probe 2>/dev/null
wait_up() { for _ in $(seq 300); do curl -fs -o /dev/null -m 3 "$2" && return 0; sleep 1; done; journalctl -u "$3" -n 20 --no-pager; fail "$1 did not start"; }
wait_up 'the API' http://127.0.0.1:8787/health mf-api
wait_up 'the game server' http://127.0.0.1:9001/health mf-game
[ "$PROBE" = 1 ] && wait_up 'the probe' http://127.0.0.1:9300/probe-api/health mf-probe
/usr/local/sbin/mf-room || fail 'making the room'
ROOM=$(tr -dc A-Z <"$ETC/room-code")
phase ready

b="
===== MILITARY FORGE TRIAL SERVER READY =====
Room:   $ORIGIN/r/$ROOM
Status: $ORIGIN/trial-status/
Probe:  $([ $PROBE = 1 ] && echo "$ORIGIN/probe" || echo 'not in this build')
Owner:  $ORIGIN/owner-$OWNER/ (private: admin link, results)
Admin:  $ORIGIN/admin#t=$ADMIN_TOKEN
============================================="
log "$b"
console "$b"
[ -f "$W" ] && MF_HOST=$HOST MF_ORIGIN_PORT=$ORIGIN_PORT bash "$W" gateway
exit 0
