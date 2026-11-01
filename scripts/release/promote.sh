#!/bin/bash
# Points the public repo's production branch (what production runs) at a commit of public main.
# Forward is a release; an older commit is a rollback. Nothing deploys until deploy.sh production.
# docs/release.md
#   scripts/release/promote.sh <commit on public main>
# Refuses: a commit that isn't on public main, or a production branch that moved since the fetch.
# shellcheck disable=SC1091
. "$(dirname "$0")/lib.sh"
[ $# = 1 ] || die 'usage: promote.sh <commit on public main>'
fetch "$PUB"
c=$(git rev-parse --verify -q "$1^{commit}") || die "no commit '$1' here (is it on $PUB main? run git fetch $PUB)"
git merge-base --is-ancestor "$c" "$PUB/main" || die "${c:0:7} is not on $PUB main: only what staging has had goes to production"
old=$(git rev-parse --verify -q "$PUB/production^{commit}") || old=''
if [ "$c" = "$old" ]; then
  echo "production is already at ${c:0:7}"
  exit 0
fi
what='release'
[ -n "$old" ] && git merge-base --is-ancestor "$c" "$old" && what='rollback'
# the lease: refused if production moved since the fetch (a rollback moves it backwards, so it can't be a plain push)
git push --no-verify -q --force-with-lease="refs/heads/production:$old" "$PUB" "$c:refs/heads/production"
echo "$what: $PUB production ${old:0:7} -> ${c:0:7} ($(git log -1 --format=%s "$c"))"
echo "next: scripts/release/deploy.sh production"
