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
# Needs root. MF_SRC: the checkout (default /opt/military-forge/src); MF_DATA, MF_GAME_UNIT and
# MF_GAME_PORT: staging's (docs/release.md; production's by default).
set -uo pipefail
SRC=${MF_SRC:-/opt/military-forge/src}
DATA=${MF_DATA:-/var/lib/military-forge}
GAME=${MF_GAME_UNIT:-mf-game}
PORT=${MF_GAME_PORT:-9001}
log() { printf '[mf-restart %s] %s\n' "$(date -u +%H:%M:%S)" "$*"; }
health() { curl -fs -o /dev/null -m 3 "http://127.0.0.1:$PORT/health"; }

# staging's checkout belongs to its own user, and root's git refuses a tree it doesn't own unless told
# it's safe. A tree it can't read prints nothing, and nothing never matches: the game restarts.
game_tree() {
  local ids
  ids=$(git -c safe.directory="$SRC" -C "$SRC" rev-parse HEAD:apps/game-server HEAD:packages HEAD:pnpm-lock.yaml HEAD:package.json 2>/dev/null) || ids=''
  [ -n "$ids" ] && printf '%s\n' "$ids" | sha256sum | cut -c1-16
}

restart_game() {
  local new old pid
  new=$(game_tree)
  old=$(cat "$DATA/game-tree" 2>/dev/null)
  if ! systemctl is-active -q "$GAME"; then
    systemctl restart "$GAME" || return 1
  elif [ -n "$new" ] && [ "$new" = "$old" ]; then
    log 'the game server is unchanged: not restarted (its matches play on)'
    return 0
  else
    pid=$(systemctl show -p MainPID --value "$GAME")
    log 'the game server changed: draining it (new rooms wait; running matches finish, 10 min at most)'
    systemctl kill -s USR2 "$GAME" || return 1
    # systemd starts the new code when the old one stops; the cap's own 10 min plus a margin
    for _ in $(seq 690); do
      [ "$(systemctl show -p MainPID --value "$GAME")" != "$pid" ] && break
      sleep 1
    done
    if [ "$(systemctl show -p MainPID --value "$GAME")" = "$pid" ]; then
      log 'it did not stop by itself: restarting it'
      systemctl restart "$GAME" || return 1
    fi
  fi
  for _ in $(seq 120); do health && break; sleep 1; done
  health || return 1
  if [ -n "$new" ]; then echo "$new" >"$DATA/game-tree"; else rm -f "$DATA/game-tree"; fi
  log 'the game server runs the new code'
}

status=0
for s in "$@"; do
  case $s in
  "$GAME") restart_game || status=1 ;;
  *) systemctl restart "$s" || status=1 ;;
  esac
done
exit $status
