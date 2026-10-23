#!/bin/bash
# WebTransport (QUIC, UDP 443) on the trial box: the Rust gateway (apps/wt-gateway) in front of the
# game server, with Caddy's Let's Encrypt certificate. cloud-init.sh runs it twice (docs/net-trial.md):
#   wt-setup.sh env       before the services start: the game server opens the gateway's socket
#   wt-setup.sh gateway   after the box is ready: build (or download) the gateway, its certificate
#                         copy, and its service; a failure leaves the game on WebSocket
# Needs root. Environment: MF_HOST (the box's name, e.g. 40-123-240-224.sslip.io), MF_ORIGIN_PORT
# (local tests), MF_SRC (the checkout, default /opt/military-forge/src). A prebuilt gateway instead of
# a build: MF_WT_URL (a linux x86_64 binary) and MF_WT_SHA256 (its SHA-256).
# Firewall: UDP 443 inbound, from anywhere (TCP 80/443 as before).
# shellcheck disable=SC2015
set -uo pipefail
SRC=${MF_SRC:-/opt/military-forge/src}
ETC=/etc/military-forge
RUN=/run/military-forge
SOCK=$RUN/gs1.sock
BIN=/usr/local/bin/mf-wt-gateway
PROBE=/usr/local/bin/mf-wt-probe
RUST=/opt/rust
TARGET=/var/cache/mf-wt-target
TOOLCHAIN=$(sed -n 's/^channel *= *"\(.*\)"/\1/p' "$SRC/apps/wt-gateway/rust-toolchain.toml" 2>/dev/null)
log() { printf '[mf-wt %s] %s\n' "$(date -u +%H:%M:%S)" "$*"; }

# ---------- env: the game server's side ----------
if [ "${1:-}" = env ]; then
  # the gateway connects to the game server's Unix socket, in a private directory both services share
  # (RuntimeDirectory, kept across restarts of either); mode 0700, owned by the mf user
  mkdir -p /etc/systemd/system/mf-game.service.d
  cat >/etc/systemd/system/mf-game.service.d/wt.conf <<EOF
[Service]
Environment=WT_SOCKET=$SOCK
RuntimeDirectory=military-forge
RuntimeDirectoryMode=0700
RuntimeDirectoryPreserve=yes
EOF
  # QUIC wants bigger UDP buffers than Ubuntu's default (quinn warns below ~2 MB)
  printf 'net.core.rmem_max=2500000\nnet.core.wmem_max=2500000\n' >/etc/sysctl.d/60-mf-wt.conf
  sysctl -q -p /etc/sysctl.d/60-mf-wt.conf || true
  log "game server will open $SOCK"
  exit 0
fi
[ "${1:-}" = gateway ] || {
  echo "usage: sudo bash wt-setup.sh gateway   (re-runs the gateway setup: build, certificate, service, self-test)" >&2
  echo "       sudo bash wt-setup.sh env       (the game server's side; cloud-init.sh runs both)" >&2
  exit 2
}

# the box's name: MF_HOST, or the site Caddy serves (a re-run by hand needs no settings)
HOST=${MF_HOST:-$(sed -n 's/^\([^[:space:]{][^[:space:]]*\) {$/\1/p' /etc/caddy/Caddyfile 2>/dev/null | head -1)}
[ -n "$HOST" ] || {
  log "no MF_HOST, and no site in /etc/caddy/Caddyfile"
  exit 2
}
PUBLIC="https://$HOST${MF_ORIGIN_PORT:+:$MF_ORIGIN_PORT}/wt"
dl() { curl -fsSL --retry 6 --retry-all-errors --retry-delay 5 -m 600 "$@"; }

# ---------- the gateway binary: download a prebuilt one, or build it here ----------
# A deploy restarts the gateway only when its binary or service changed: a restart drops every
# WebTransport session (players come back over a fresh one, but mid-match)
changed=0
put() { cmp -s "$1" "$2" && rm -f "$1" || { mv "$1" "$2" && changed=1; }; }
if [ -n "${MF_WT_URL:-}" ]; then
  tmp=$(mktemp -d)
  dl -o "$tmp/gw" "$MF_WT_URL" && echo "${MF_WT_SHA256:-none}  $tmp/gw" | sha256sum -c --quiet - &&
    install -m 0755 "$tmp/gw" "$BIN.new" && put "$BIN.new" "$BIN" || {
    log "the prebuilt gateway didn't download or match MF_WT_SHA256: WebSocket only"
    rm -rf "$tmp"
    exit 1
  }
  rm -rf "$tmp"
else
  # Rust, pinned by apps/wt-gateway/rust-toolchain.toml, in /opt/rust (kept: a re-run builds only
  # what changed, from the target directory in /var/cache). First build on 2 vCPUs: a few minutes.
  [ -n "$TOOLCHAIN" ] || {
    log "no rust-toolchain.toml in $SRC/apps/wt-gateway: WebSocket only"
    exit 1
  }
  export RUSTUP_HOME=$RUST/rustup CARGO_HOME=$RUST/cargo PATH="$RUST/cargo/bin:$PATH"
  for _ in 1 2 3; do apt-get install -y -q --no-install-recommends gcc libc6-dev >/dev/null && break; sleep 10; done
  if ! command -v rustup >/dev/null; then
    case $(dpkg --print-architecture) in amd64) triple=x86_64-unknown-linux-gnu ;; arm64) triple=aarch64-unknown-linux-gnu ;; *) exit 1 ;; esac
    tmp=$(mktemp -d)
    u="https://static.rust-lang.org/rustup/dist/$triple/rustup-init"
    dl -o "$tmp/rustup-init" "$u" && dl -o "$tmp/sum" "$u.sha256" &&
      (cd "$tmp" && echo "$(cut -d' ' -f1 sum)  rustup-init" | sha256sum -c --quiet -) || {
      log "rustup didn't download or verify: WebSocket only"
      exit 1
    }
    chmod +x "$tmp/rustup-init"
    "$tmp/rustup-init" -y -q --profile minimal --default-toolchain none --no-modify-path >/dev/null || exit 1
    rm -rf "$tmp"
  fi
  # the toolchain alone (not the file's clippy/rustfmt: nothing here lints)
  for _ in 1 2 3; do rustup toolchain install "$TOOLCHAIN" --profile minimal >/dev/null 2>&1 && break; sleep 10; done
  log "building the gateway with Rust $TOOLCHAIN (a few minutes the first time)"
  t0=$(date +%s)
  (cd "$SRC/apps/wt-gateway" && RUSTUP_TOOLCHAIN=$TOOLCHAIN CARGO_TARGET_DIR=$TARGET cargo build -q --release --locked) >/var/log/mf-wt-build.log 2>&1 || {
    tail -20 /var/log/mf-wt-build.log
    log "the gateway didn't build: WebSocket only"
    exit 1
  }
  log "built in $(($(date +%s) - t0)) s"
  install -m 0755 "$TARGET/release/wt-gateway" "$BIN.new" && put "$BIN.new" "$BIN"
  install -m 0755 "$TARGET/release/wt-probe" "$PROBE" 2>/dev/null || true
fi

# ---------- the certificate: Caddy's, copied where the mf user can read it ----------
# Caddy keeps it in its own data directory (0600, caddy's). A daily timer copies it again after a
# renewal; the gateway reloads a changed file by itself (within 10 minutes) or at once on SIGHUP.
cat >/usr/local/sbin/mf-wt-cert <<EOF
#!/bin/bash
c=\$(find /var/lib/caddy/.local/share/caddy/certificates -name '$HOST.crt' 2>/dev/null | head -1)
[ -n "\$c" ] || exit 1
k=\${c%.crt}.key
install -d -o root -g mf -m 0750 $ETC/wt
cmp -s "\$c" $ETC/wt/cert.pem && cmp -s "\$k" $ETC/wt/key.pem && exit 0
install -o root -g mf -m 0640 "\$c" $ETC/wt/cert.pem
install -o root -g mf -m 0640 "\$k" $ETC/wt/key.pem
systemctl kill -s HUP mf-wt.service 2>/dev/null
exit 0
EOF
chmod 0755 /usr/local/sbin/mf-wt-cert
printf '[Unit]\nDescription=Military Forge: copy the TLS certificate for WebTransport\n[Service]\nType=oneshot\nExecStart=/usr/local/sbin/mf-wt-cert\n' >/etc/systemd/system/mf-wt-cert.service
printf '[Unit]\nDescription=Military Forge: copy the TLS certificate for WebTransport\n[Timer]\nOnBootSec=2min\nOnCalendar=daily\n[Install]\nWantedBy=timers.target\n' >/etc/systemd/system/mf-wt-cert.timer
got=0
for _ in $(seq 60); do /usr/local/sbin/mf-wt-cert && got=1 && break; sleep 5; done
[ $got = 1 ] || {
  log "no certificate from Caddy for $HOST yet (ports 80/443 open?): WebSocket only"
  exit 1
}

# ---------- the service ----------
cat >/etc/systemd/system/mf-wt.service.new <<EOF
[Unit]
Description=Military Forge WebTransport gateway (UDP 443)
After=network-online.target mf-game.service
[Service]
User=mf
Group=mf
Environment=WT_ADDR=0.0.0.0:443
Environment=WT_PUBLIC_URL=$PUBLIC
Environment=WT_SOCKET=$SOCK
Environment=WT_CERT=$ETC/wt/cert.pem
Environment=WT_KEY=$ETC/wt/key.pem
ExecStart=$BIN
Restart=always
RestartSec=2
KillSignal=SIGTERM
TimeoutStopSec=10
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
NoNewPrivileges=yes
RuntimeDirectory=military-forge
RuntimeDirectoryMode=0700
RuntimeDirectoryPreserve=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=yes
LimitNOFILE=65536
[Install]
WantedBy=multi-user.target
EOF
put /etc/systemd/system/mf-wt.service{.new,}
systemctl daemon-reload
systemctl enable --quiet mf-wt.service mf-wt-cert.timer
if [ $changed = 0 ] && systemctl is-active -q mf-wt.service; then
  log "the gateway is unchanged: not restarted (its sessions carry on)"
  start=(start)
else
  start=(restart)
fi
systemctl "${start[@]}" mf-wt.service && systemctl start mf-wt-cert.timer || {
  journalctl -u mf-wt -n 20 --no-pager
  log "the gateway didn't start: WebSocket only"
  exit 1
}

# ---------- check: the game server advertises it, and a real session gets through ----------
ok=0
for _ in $(seq 30); do
  curl -fsS -m 3 http://127.0.0.1:9001/health 2>/dev/null | grep -q '"webtransport":{' && ok=1 && break
  sleep 1
done
[ $ok = 1 ] || {
  journalctl -u mf-wt -n 20 --no-pager
  log "the game server doesn't advertise the gateway: WebSocket only"
  exit 1
}
if [ -x "$PROBE" ]; then
  hash=$(openssl x509 -in $ETC/wt/cert.pem -outform der | sha256sum | cut -d' ' -f1)
  # A real QUIC session through the gateway to the game server's bridge, on the box itself
  # (127.0.0.1: Azure doesn't hairpin to the VM's own public address), the certificate pinned by
  # hash: READY once its stream is open. The output is read whole: piped into `grep -q` under
  # pipefail, the probe's SIGPIPE after READY made a working gateway look broken (19 Oct, live box).
  out=$(printf 'QUIT\n' | timeout 10 "$PROBE" "https://127.0.0.1:443/wt" "$hash" 2>&1)
  if printf '%s\n' "$out" | grep -q '^READY'; then
    log "self-test: a WebTransport session opened through the gateway"
  else
    log "self-test: no WebTransport session: $(printf '%s' "$out" | tail -2 | tr '\n' ' ') (the gateway's log: journalctl -u mf-wt)"
  fi
fi
log "WebTransport on $PUBLIC (UDP 443)"
exit 0
