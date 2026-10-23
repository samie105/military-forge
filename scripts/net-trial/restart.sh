#!/bin/bash
# Restarts the box's services after a deploy without dropping live matches (docs/net-trial.md §5).
# cloud-init.sh (mf-trial-setup) runs it with the services to (re)start:
#   restart.sh mf-api mf-game [mf-probe]
# - mf-game restarts only when its code changed: apps/game-server, packages/, the lockfile or the root
#   package.json (a web-only deploy leaves every match alone). Its tree hash is kept in
#   $DATA/game-tree.
# - When it must restart, it drains first (SIGUSR2): no new rooms; running matches finish (DRAIN_MAX_MS
#   in the game server, 10 min by default); then every player is told the server updated (close 1012)
#   and rejoins the same room on the new code once systemd has started it again.
# - Anything else restarts as before.
# Needs root. MF_SRC: the checkout (default /opt/military-forge/src).
set -uo pipefail
SRC=${MF_SRC:-/opt/military-forge/src}
DATA=${MF_DATA:-/var/lib/military-forge}
log() { printf '[mf-restart %s] %s\n' "$(date -u +%H:%M:%S)" "$*"; }
health() { curl -fs -o /dev/null -m 3 http://127.0.0.1:9001/health; }

game_tree() { git -C "$SRC" rev-parse HEAD:apps/game-server HEAD:packages HEAD:pnpm-lock.yaml HEAD:package.json 2>/dev/null | sha256sum | cut -c1-16; }

restart_game() {
  local new old pid
  new=$(game_tree)
  old=$(cat "$DATA/game-tree" 2>/dev/null)
  if ! systemctl is-active -q mf-game; then
    systemctl restart mf-game || return 1
  elif [ -n "$old" ] && [ "$new" = "$old" ]; then
    log 'the game server is unchanged: not restarted (its matches play on)'
    return 0
  else
    pid=$(systemctl show -p MainPID --value mf-game)
    log 'the game server changed: draining it (new rooms wait; running matches finish, 10 min at most)'
    systemctl kill -s USR2 mf-game || return 1
    # systemd starts the new code when the old one stops; the cap's own 10 min plus a margin
    for _ in $(seq 690); do
      [ "$(systemctl show -p MainPID --value mf-game)" != "$pid" ] && break
      sleep 1
    done
    if [ "$(systemctl show -p MainPID --value mf-game)" = "$pid" ]; then
      log 'it did not stop by itself: restarting it'
      systemctl restart mf-game || return 1
    fi
  fi
  for _ in $(seq 120); do health && break; sleep 1; done
  health || return 1
  echo "$new" >"$DATA/game-tree"
  log 'the game server runs the new code'
}

status=0
for s in "$@"; do
  case $s in
  mf-game) restart_game || status=1 ;;
  *) systemctl restart "$s" || status=1 ;;
  esac
done
exit $status
