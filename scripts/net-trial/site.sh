#!/bin/bash
# The trial box's web front (cloud-init.sh sources it from the code, so a deploy brings its changes):
# Caddy's config, and the build's pages filled in for this address. It lives here, not in
# cloud-init.sh, which is at EC2's 16 KB user-data limit. Uses cloud-init.sh's settings and paths:
# HOST, TLS, ORIGIN_PORT, ORIGIN, ACME_EMAIL, WEB, PUB, DATA, and the environment's (docs/release.md):
# STG (set: staging), API_PORT, GAME_PORT, ADMIN_PORT. Unset, they are production's.
# One Caddy serves both: production owns /etc/caddy/Caddyfile (the global options, its site, and an
# import of $SITES); staging writes only $SITES/staging.caddy. Neither deploy rewrites the other's site.
# MF_OLD_HOSTS (production; deploy.sh): addresses the game has left. Each serves the moving page
# (scripts/net-trial/moved, copied to $MOVED) that carries the player's browser data to $ORIGIN.
# shellcheck disable=SC2154
SITES=${MF_CADDY_SITES:-/etc/caddy/mf-env}
OLD_HOSTS=${MF_OLD_HOSTS:-}
MOVED=${MF_MOVED_DIR:-$(dirname "$PUB")/moved}

# The Caddyfile (staging: its site alone), on stdout.
site_caddyfile() {
  local hp="$HOST${ORIGIN_PORT:+:$ORIGIN_PORT}" stg="${STG:-}" probe='reverse_proxy @probe 127.0.0.1:9300' robots=''
  # staging: no probe; nothing indexed
  [ -n "$stg" ] && probe='respond @probe 404' robots=$'\n\t\tX-Robots-Tag "noindex, nofollow"'
  # the build's own files (/assets/name-HASH.ext) never change under a name: a year. Everything else
  # (pages, the worker, art, models, sounds, the manifest) revalidates: a deploy shows at once, and the
  # service worker keeps a copy of each for offline play (apps/web/pwa.ts)
  local hashed='^/assets/[^/]+-[A-Za-z0-9_-]{8}\.[a-z0-9]+$'
  # no h3: UDP 443 is WebTransport's
  [ -n "$stg" ] || printf '{\n\tservers {\n\t\tprotocols h1 h2\n\t}\n%s}\n\n' "${ACME_EMAIL:+	email $ACME_EMAIL
}"
  printf '%s {\n' "$HOST"
  [ "$TLS" = internal ] && printf '\ttls internal\n'
  cat <<EOF
	# Caddy's own list, plus models, sound banks and the manifest (GLBs shrink by about half)
	encode zstd gzip {
		match {
			header Content-Type text/*
			header Content-Type application/json*
			header Content-Type application/javascript*
			header Content-Type application/xhtml+xml*
			header Content-Type application/xml*
			header Content-Type application/wasm*
			header Content-Type application/manifest+json*
			header Content-Type application/octet-stream*
			header Content-Type image/svg+xml*
			header Content-Type model/gltf-binary*
			header Content-Type model/gltf+json*
		}
	}
	# challenges.cloudflare.com: the bot check's script and its frame (Turnstile: apps/web
	# shell/account/BotCheck.tsx), loaded only by a build with VITE_TURNSTILE_SITEKEY
	header {
		Content-Security-Policy "default-src 'self'; script-src 'self' 'wasm-unsafe-eval' https://challenges.cloudflare.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' data: blob: https://$hp wss://$hp https://*.amazonaws.com https://speed.cloudflare.com https://ixpn.ng https://nobus.io https://challenges.cloudflare.com; frame-src 'self' https://challenges.cloudflare.com; worker-src 'self' blob:; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'"
		Strict-Transport-Security "max-age=31536000"
		Permissions-Policy "camera=(), microphone=(self), geolocation=(), payment=(), usb=()"
		X-Content-Type-Options nosniff
		Referrer-Policy same-origin$robots
	}
	@foreign {
		path /ws/* /echo
		header Origin *
		not header_regexp Origin ^https://${HOST//./\\.}(:[0-9]+)?$
	}
	@game path /ws/* /health
	@probe path /echo /probe-api/*
	@pub path /trial-status /trial-status/* /owner-* /probe-config.json
	@hashed path_regexp $hashed
	# the dye masks became .webp on 29 Oct; models a browser cached earlier (for up to 7 days) still
	# name the .png
	@oldmask path_regexp oldmask ^(/assets/.+_dye_mask)\.png$
	@fresh not path_regexp $hashed
	route {
		respond @foreign 403
		respond /api/internal/* 404
		handle_path /api/* {
			reverse_proxy 127.0.0.1:${API_PORT:-8787}
		}
		reverse_proxy @game 127.0.0.1:${GAME_PORT:-9001}
		reverse_proxy /admin/api/* 127.0.0.1:${ADMIN_PORT:-9002}
		$probe
		header @fresh Cache-Control no-cache
		header @hashed Cache-Control "public, max-age=31536000, immutable"
		header @pub Cache-Control no-store
		file_server @pub {
			root $PUB
		}
		header /manifest.webmanifest Content-Type application/manifest+json
		header /r/* X-Robots-Tag noindex
		rewrite @oldmask {re.oldmask.1}.webp
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
  [ -n "$stg" ] || site_old_hosts
  [ -n "$stg" ] || printf '\nimport %s/*.caddy\n' "$SITES"
}

# The old addresses' sites: the build's hashed files (a tab still open there), the moving page's
# script and its worker (it retires the game's, whose cache would keep the old pages up), and the
# moving page for every other path, so a room link (/r/CODE) arrives at the same room.
site_old_hosts() {
  local h
  for h in $OLD_HOSTS; do
    [ "$h" = "$HOST" ] && continue
    printf '\n%s {\n' "$h"
    [ "$TLS" = internal ] && printf '\ttls internal\n'
    cat <<EOF
	header {
		Content-Security-Policy "default-src 'self'; style-src 'unsafe-inline'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
		Strict-Transport-Security "max-age=31536000"
		X-Content-Type-Options nosniff
		X-Robots-Tag noindex
	}
	@moved path /moved.js /sw.js
	route {
		header Cache-Control no-cache
		file_server /assets/* {
			root $WEB
		}
		file_server @moved {
			root $MOVED
		}
		rewrite * /index.html
		file_server {
			root $MOVED
		}
	}
}
EOF
  done
}

# Writes /etc/caddy/Caddyfile and restarts Caddy, only when it changed (a restart drops every
# WebSocket). A config Caddy refuses is kept out: returns 1 with Caddy's reason.
site_caddy() {
  [ -z "${STG:-}" ] || { site_caddy_staging; return; }
  local new=/etc/caddy/Caddyfile.new
  site_caddyfile >"$new" || return 1
  if ! caddy validate --adapter caddyfile --config "$new" >/dev/null 2>"$DATA/caddy-validate.log"; then
    cat "$DATA/caddy-validate.log"
    rm -f "$new"
    return 1
  fi
  if cmp -s "$new" /etc/caddy/Caddyfile; then rm "$new"; else mv "$new" /etc/caddy/Caddyfile && systemctl restart caddy; fi
}

# Staging's site: $SITES/staging.caddy, and the import in production's Caddyfile when a production
# deploy from before 31 Oct 2026 left it out. Caddy reloads (not restarts) only when either changed;
# the whole config is validated first and the old files are put back if Caddy refuses it.
site_caddy_staging() {
  local f=$SITES/staging.caddy c=${MF_CADDYFILE:-/etc/caddy/Caddyfile} imp
  imp="import $SITES/*.caddy"
  grep -q "^[^[:space:]#][^[:space:]]* {\$" "$c" || { echo "no production site in $c: set production up first"; return 1; }
  mkdir -p "$SITES"
  site_caddyfile >"$f.new" || return 1
  if cmp -s "$f.new" "$f" && grep -qxF "$imp" "$c"; then rm "$f.new"; return 0; fi
  cp -p "$c" "$c.before-staging"
  [ -f "$f" ] && cp -p "$f" "$f.old"
  mv "$f.new" "$f"
  grep -qxF "$imp" "$c" || printf '\n%s\n' "$imp" >>"$c"
  if caddy validate --adapter caddyfile --config "$c" >/dev/null 2>"$DATA/caddy-validate.log"; then
    systemctl reload caddy
  else
    cat "$DATA/caddy-validate.log"
    cp -p "$c.before-staging" "$c"
    if [ -f "$f.old" ]; then mv "$f.old" "$f"; else rm -f "$f"; fi
    return 1
  fi
}

# The build's pages and crawl files for this address (%ORIGIN%: link previews and canonical links need
# it absolute), and the game page's flag for the host's tuning. A file the build lacks is skipped.
# Staging: every page says noindex and robots.txt turns crawlers away.
site_fill() {
  local f
  for f in index.html robots.txt sitemap.xml privacy.html terms.html official.html llms.txt; do
    [ -f "$WEB/$f" ] && sed -i "s#%ORIGIN%#$ORIGIN#g" "$WEB/$f"
  done
  sed -i 's#</head>#<meta name="mf-tune" content="host" /></head>#' "$WEB/index.html"
  [ -n "${STG:-}" ] || { site_moved; return 0; }
  for f in "$WEB"/*.html; do
    if grep -q '<meta name="robots"' "$f"; then sed -i 's#<meta name="robots" content="[^"]*"#<meta name="robots" content="noindex, nofollow"#g' "$f"
    else sed -i 's#</head>#<meta name="robots" content="noindex, nofollow" /></head>#' "$f"; fi
  done
  printf 'User-agent: *\nDisallow: /\n' >"$WEB/robots.txt"
}

# The moving page for the old addresses, filled in for this one, and the game page's list of them:
# boot.js takes a hand-over only from a page whose referrer is one of them.
site_moved() {
  [ -n "$OLD_HOSTS" ] || return 0
  local h f src=${MF_MOVED_SRC:-$SRC/scripts/net-trial/moved}
  mkdir -p "$MOVED"
  for f in index.html moved.js sw.js; do
    sed -e "s#%NEW_ORIGIN%#$ORIGIN#g" -e "s#%NEW_HOST%#$HOST#g" "$src/$f" >"$MOVED/$f.new" && mv "$MOVED/$f.new" "$MOVED/$f"
  done
  chmod 0755 "$MOVED"
  chmod 0644 "$MOVED"/*
  for h in $OLD_HOSTS; do
    [ "$h" = "$HOST" ] || sed -i "s#</head>#<meta name=\"mf-moved-from\" content=\"https://$h\" /></head>#" "$WEB/index.html"
  done
}
