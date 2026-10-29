#!/bin/bash
# The trial box's web front (cloud-init.sh sources it from the code, so a deploy brings its changes):
# Caddy's config, and the build's pages filled in for this address. It lives here, not in
# cloud-init.sh, which is at EC2's 16 KB user-data limit. Uses cloud-init.sh's settings and paths:
# HOST, TLS, ORIGIN_PORT, ORIGIN, ACME_EMAIL, WEB, PUB, DATA.
# shellcheck disable=SC2154

# The Caddyfile, on stdout.
site_caddyfile() {
  local hp="$HOST${ORIGIN_PORT:+:$ORIGIN_PORT}"
  # the build's own files (/assets/name-HASH.ext) never change under a name: a year. Everything else
  # (pages, the worker, art, models, sounds, the manifest) revalidates: a deploy shows at once, and the
  # service worker keeps a copy of each for offline play (apps/web/pwa.ts)
  local hashed='^/assets/[^/]+-[A-Za-z0-9_-]{8}\.[a-z0-9]+$'
  # no h3: UDP 443 is WebTransport's
  printf '{\n\tservers {\n\t\tprotocols h1 h2\n\t}\n%s}\n\n%s {\n' "${ACME_EMAIL:+	email $ACME_EMAIL
}" "$HOST"
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
	header {
		Content-Security-Policy "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' data: blob: https://$hp wss://$hp https://*.amazonaws.com https://speed.cloudflare.com https://ixpn.ng https://nobus.io; worker-src 'self' blob:; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'"
		Strict-Transport-Security "max-age=31536000"
		Permissions-Policy "camera=(), microphone=(self), geolocation=(), payment=(), usb=()"
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
	@hashed path_regexp $hashed
	# the dye masks became .webp on 29 Oct; models a browser cached earlier (for up to 7 days) still
	# name the .png
	@oldmask path_regexp oldmask ^(/assets/.+_dye_mask)\.png$
	@fresh not path_regexp $hashed
	route {
		respond @foreign 403
		respond /api/internal/* 404
		handle_path /api/* {
			reverse_proxy 127.0.0.1:8787
		}
		reverse_proxy @game 127.0.0.1:9001
		reverse_proxy /admin/api/* 127.0.0.1:9002
		reverse_proxy @probe 127.0.0.1:9300
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
}

# Writes /etc/caddy/Caddyfile and restarts Caddy, only when it changed (a restart drops every
# WebSocket). A config Caddy refuses is kept out: returns 1 with Caddy's reason.
site_caddy() {
  local new=/etc/caddy/Caddyfile.new
  site_caddyfile >"$new" || return 1
  if ! caddy validate --adapter caddyfile --config "$new" >/dev/null 2>"$DATA/caddy-validate.log"; then
    cat "$DATA/caddy-validate.log"
    rm -f "$new"
    return 1
  fi
  if cmp -s "$new" /etc/caddy/Caddyfile; then rm "$new"; else mv "$new" /etc/caddy/Caddyfile && systemctl restart caddy; fi
}

# The build's pages and crawl files for this address (%ORIGIN%: link previews and canonical links need
# it absolute), and the game page's flag for the host's tuning. A file the build lacks is skipped.
site_fill() {
  local f
  for f in index.html robots.txt sitemap.xml privacy.html terms.html official.html llms.txt; do
    [ -f "$WEB/$f" ] && sed -i "s#%ORIGIN%#$ORIGIN#g" "$WEB/$f"
  done
  sed -i 's#</head>#<meta name="mf-tune" content="host" /></head>#' "$WEB/index.html"
}
