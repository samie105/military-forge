#!/usr/bin/env bash
# Key art v3 (art/key-art/README.md): the title screen's and the landing's files from the generated sources.
#
#   bash art/pipeline/key_art_v3.sh        # needs ImageMagick 7 (magick), cwebp and avifenc
#
# Sources (art/key-art/): v3-desktop.jpg (2752×1536), v3-hero.webp (the hero cut out, same frame, alpha),
# v3-tall-9x16.jpg (1536×2752), v3-tall-4x5.jpg (1856×2304). Writes WebP (q80) and AVIF (q55) into
# apps/web/public/art/key-art/ and the About sheet's thumbnails into apps/web/public/art/landing/; the phone files
# step their quality down until each is under 400 KB. The share image and posters are apps/web/scripts/posters.mjs.
set -euo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
SRC="$REPO/art/key-art"
PUB="$REPO/apps/web/public/art/key-art"
LAND="$REPO/apps/web/public/art/landing"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# out <png> <stem dir/name> [limit KB]: WebP and AVIF of one prepared PNG
out() {
  local png="$1" stem="$2" limit="${3:-0}" q
  for q in 80 74 68 62 56 50; do
    cwebp -quiet -q "$q" -m 6 -alpha_q 90 "$png" -o "$stem.webp"
    [ "$limit" = 0 ] || [ "$(($(stat -f%z "$stem.webp") / 1024))" -le "$limit" ] && break
  done
  for q in 55 50 45 40 35; do
    avifenc -q "$q" -s 4 --yuv 420 "$png" "$stem.avif" >/dev/null
    [ "$limit" = 0 ] || [ "$(($(stat -f%z "$stem.avif") / 1024))" -le "$limit" ] && break
  done
  printf '%s: webp %s KB, avif %s KB\n' "$(basename "$stem")" "$(($(stat -f%z "$stem.webp") / 1024))" "$(($(stat -f%z "$stem.avif") / 1024))"
}

# desktop 16:9 (2560×1440): the source's middle 16:9, the hero layer cut the same way
magick "$SRC/v3-desktop.jpg" -gravity center -crop 2731x1536+0+0 +repage -resize 2560x1440! "$TMP/desk.png"
magick "$SRC/v3-hero.webp" -gravity center -crop 2731x1536+0+0 +repage -resize 2560x1440! "$TMP/desk-fg.png"
out "$TMP/desk.png" "$PUB/key-art-desktop"
out "$TMP/desk-fg.png" "$PUB/key-art-desktop-fg"

# phone 19.5:9 (2340×1080): a band of the same frame from y 120 (the hero's helmet stays in, the street's
# bottom edge goes). A phone shows no parallax layer (title.css), so there's no phone foreground.
magick "$SRC/v3-desktop.jpg" -crop 2752x1270+0+120 +repage -resize 2340x1080! "$TMP/phone.png"
out "$TMP/phone.png" "$PUB/key-art-phone" 400

# the About sheet's thumbnails: the key art 800×450, the 9:16 frame's middle 2:3 at 480×720
magick "$SRC/v3-desktop.jpg" -gravity center -crop 2731x1536+0+0 +repage -resize 800x450! "$TMP/thumb.png"
out "$TMP/thumb.png" "$LAND/keyart"
magick "$SRC/v3-tall-9x16.jpg" -crop 1536x2304+0+300 +repage -resize 480x720! "$TMP/poster.png"
out "$TMP/poster.png" "$LAND/poster"
