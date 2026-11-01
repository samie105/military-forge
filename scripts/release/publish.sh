#!/bin/bash
# Publishes the dev repo's main (origin/main) to the public repo's main, which is what staging runs:
# one snapshot commit of its tree on top of public/main, authored by the owner's noreply address.
# The dev history never leaves the dev repo. docs/release.md
#   scripts/release/publish.sh "What changed, in a line"
# Refuses: no message, a local main with commits origin doesn't have (push first), or nothing new.
# shellcheck disable=SC1091
. "$(dirname "$0")/lib.sh"
msg=${1:-}
[ -n "$msg" ] || die 'usage: publish.sh "what changed, in a line"'
fetch "$DEV"
fetch "$PUB"
src=$(git rev-parse --verify -q "$DEV/main^{commit}") || die "no $DEV/main"
if local_main=$(git rev-parse --verify -q "refs/heads/main^{commit}"); then
  [ -z "$(git rev-list -1 "$local_main" "^$src")" ] || die "local main has commits $DEV/main hasn't: push them first (or publish only what's on $DEV)"
fi
parent=$(git rev-parse --verify -q "$PUB/main^{commit}") || die "no $PUB/main"
tree=$(git rev-parse "$src^{tree}")
[ "$tree" != "$(git rev-parse "$parent^{tree}")" ] || die "nothing to publish: $PUB/main already has $DEV/main's tree"
c=$(GIT_AUTHOR_NAME=$PUB_NAME GIT_AUTHOR_EMAIL=$PUB_EMAIL GIT_COMMITTER_NAME=$PUB_NAME GIT_COMMITTER_EMAIL=$PUB_EMAIL \
  git commit-tree "$tree" -p "$parent" -m "$msg")
# not forced: if public main moved since the fetch, this fails and nothing changes
git push --no-verify -q "$PUB" "$c:refs/heads/main"
echo "published ${c:0:7} on $PUB main ($DEV/main ${src:0:7}): $msg"
echo "next: scripts/release/deploy.sh staging"
