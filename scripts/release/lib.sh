# shellcheck shell=bash disable=SC2034
# Shared by publish.sh, promote.sh and deploy.sh (docs/release.md). Environment, for tests and other
# setups: MF_REPO_DIR (the dev checkout), MF_DEV_REMOTE (origin), MF_PUBLIC_REMOTE (public),
# MF_BOX (mf@40.123.240.224), MF_BOX_KEY (~/.ssh/mf-azure).
set -euo pipefail
cd "${MF_REPO_DIR:-$(dirname "${BASH_SOURCE[0]}")/../..}"
DEV=${MF_DEV_REMOTE:-origin}
PUB=${MF_PUBLIC_REMOTE:-public}
BOX=${MF_BOX:-mf@40.123.240.224}
BOX_KEY=${MF_BOX_KEY:-$HOME/.ssh/mf-azure}
# the public repo's author: the owner's GitHub noreply address, never a personal one
PUB_NAME=samie105
PUB_EMAIL=42389790+samie105@users.noreply.github.com

die() {
  echo "release: $*" >&2
  exit 1
}
remote_ok() { git remote get-url "$1" >/dev/null 2>&1 || die "no git remote '$1' in $(pwd)"; }
fetch() {
  remote_ok "$1"
  git fetch -q "$1" || die "git fetch $1 failed"
}
