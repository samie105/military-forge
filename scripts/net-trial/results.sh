#!/usr/bin/env bash
# The ping trial's results table (docs/net-trial.md): downloads each box's probe results over HTTPS
# from its private export link (on the box's owner page) and prints city x network x region with
# median, p95, jitter and loss (results.mjs).
#
#   scripts/net-trial/results.sh 'https://<host>/probe-api/export/<token>' [more links…] [-- results.mjs options]
#   scripts/net-trial/results.sh --links-file ~/.military-forge/net-trial/links   # one link per line
#
# The links hold a secret: pass them in a file to keep them out of your shell history. Each download
# is kept in ~/.military-forge/net-trial/results/ (newest per box, plus timestamped copies).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
out="${MF_TRIAL_STATE_DIR:-$HOME/.military-forge/net-trial}/results"
links=()
pass=()
while [[ $# -gt 0 ]]; do
  case $1 in
    --links-file) while IFS= read -r l; do [[ -n ${l// /} && $l != \#* ]] && links+=("$l"); done <"${2:?}"; shift ;;
    --) shift; pass=("$@"); break ;;
    -h | --help) sed -n '2,11p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) links+=("$1") ;;
  esac
  shift
done
[[ ${#links[@]} -gt 0 ]] || { sed -n '2,11p' "$0" | sed 's/^# \{0,1\}//'; exit 2; }
mkdir -p "$out"
chmod 700 "$out"
files=()
stamp="$(date +%Y%m%d-%H%M%S)"
for link in "${links[@]}"; do
  [[ $link =~ ^https://([a-z0-9.-]+)(:[0-9]+)?/probe-api/export/[A-Za-z0-9_-]{16,}$ ]] || { echo "not an export link: ${link%/export/*}/export/…" >&2; exit 1; }
  host="${BASH_REMATCH[1]}"
  file="$out/$host.jsonl"
  # the link (with its token) goes to curl on stdin, not on its command line
  if printf 'url = "%s"\n' "$link" | curl -fsS --max-time 60 -K - -o "$file.part"; then
    mv "$file.part" "$file"
    cp "$file" "$out/$host-$stamp.jsonl"
    echo "$host: $(wc -l <"$file" | tr -d ' ') runs" >&2
    files+=("$file")
  else
    rm -f "$file.part"
    echo "$host: download failed (box down, or a wrong link)" >&2
  fi
done
[[ ${#files[@]} -gt 0 ]] || exit 1
echo >&2
node "$here/results.mjs" "${files[@]}" ${pass[@]+"${pass[@]}"}
