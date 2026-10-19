# shellcheck shell=bash disable=SC1091,SC2015,SC2034,SC2154
# The trial box's data stores: Postgres 16 and Valkey on this machine, bound to localhost, for the API.
# cloud-init.sh sources this as root once the code and its dependencies are in place, so it uses that
# script's helpers (phase, fail, r, as_mf) and paths ($ETC, $DATA, $SRC), and sets DB_URL and KV_URL
# for the API's environment. It lives in the repo because cloud-init.sh must stay under EC2's 16 KB.
# Safe to re-run.
#   - Passwords: made once, kept in $ETC/db (0600, root).
#   - Backups: a nightly pg_dump into /var/backups/military-forge (mf-YYYY-MM-DD.dump), newest 7 kept.
#   - A box that ran on PGlite: its rows move into Postgres once; the old directory stays as
#     $DATA/pglite.imported-<time>.

phase 'setting up Postgres and Valkey'
[ -s "$ETC/db" ] || (umask 077 && printf 'PG_PASS=%s\nKV_PASS=%s\n' "$(r 24)" "$(r 24)" >"$ETC/db")
chown root:root "$ETC/db" && chmod 0600 "$ETC/db"
. "$ETC/db"
DB_URL="postgres://mf:$PG_PASS@127.0.0.1:5432/mf"
KV_URL="redis://:$KV_PASS@127.0.0.1:6379"

# Ubuntu's cluster 16/main already listens on localhost only and asks for a password over TCP (scram);
# saying so here keeps it that way. Valkey: localhost, a password, and every write in the append-only
# file so room codes and rate limits survive a restart; never evict keys silently.
printf "listen_addresses = 'localhost'\n" >/etc/postgresql/16/main/conf.d/military-forge.conf
(umask 027 && printf 'bind 127.0.0.1 -::1\nprotected-mode yes\nport 6379\nrequirepass %s\nappendonly yes\nmaxmemory-policy noeviction\n' "$KV_PASS" >/etc/valkey/military-forge.conf)
chown valkey:valkey /etc/valkey/military-forge.conf
grep -qx 'include /etc/valkey/military-forge.conf' /etc/valkey/valkey.conf || echo 'include /etc/valkey/military-forge.conf' >>/etc/valkey/valkey.conf
systemctl enable --quiet postgresql valkey-server && systemctl restart postgresql valkey-server || fail 'starting Postgres and Valkey'
for _ in $(seq 60); do pg_isready -q -h /var/run/postgresql && break; sleep 1; done

# the API's role and database (the password goes in on stdin, not the command line)
(cd / && runuser -u postgres -- psql -qX -v ON_ERROR_STOP=1 >/dev/null) <<EOF || fail 'the Postgres role'
SELECT 'CREATE ROLE mf LOGIN' WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'mf')\gexec
ALTER ROLE mf PASSWORD '$PG_PASS';
SELECT 'CREATE DATABASE mf OWNER mf' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'mf')\gexec
EOF

# nightly backups
install -d -o postgres -g postgres -m 0700 /var/backups/military-forge
cat >/usr/local/sbin/mf-backup <<'EOF'
#!/bin/bash
# Dumps the game database to /var/backups/military-forge/mf-YYYY-MM-DD.dump and keeps the newest 7.
# Runs as postgres (mf-backup.timer, nightly). By hand: sudo -u postgres mf-backup
# Restore (stop the API first): sudo -u postgres pg_restore --clean --if-exists -d mf <file>
set -euo pipefail
d=/var/backups/military-forge
f="$d/mf-$(date -u +%F).dump"
pg_dump -Fc -f "$f.tmp" mf
mv "$f.tmp" "$f"
ls -1 "$d"/mf-*.dump | head -n -7 | xargs -r rm -f --
EOF
chmod 0755 /usr/local/sbin/mf-backup
printf '[Unit]\nDescription=Military Forge: back up the database\nAfter=postgresql.service\n[Service]\nType=oneshot\nUser=postgres\nUMask=0077\nExecStart=/usr/local/sbin/mf-backup\n' >/etc/systemd/system/mf-backup.service
printf '[Unit]\nDescription=Military Forge: back up the database nightly\n[Timer]\nOnCalendar=*-*-* 02:30:00 UTC\nPersistent=true\n[Install]\nWantedBy=timers.target\n' >/etc/systemd/system/mf-backup.timer
systemctl daemon-reload && systemctl enable --now --quiet mf-backup.timer || fail 'the backup timer'

# once: PGlite's rows into Postgres. The API stops first (PGlite has one writer); cloud-init.sh starts it again.
if [ -f "$DATA/pglite/PG_VERSION" ]; then
  phase 'moving the PGlite data into Postgres'
  systemctl stop mf-api 2>/dev/null
  (cd "$SRC/apps/api" && DATABASE_URL="$DB_URL" as_mf node --import tsx scripts/import-pglite.ts "$DATA/pglite") || fail 'moving the PGlite data into Postgres'
  mv "$DATA/pglite" "$DATA/pglite.imported-$(date -u +%Y%m%d-%H%M%S)"
fi
