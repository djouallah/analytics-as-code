#!/usr/bin/env bash
# Publish the files under <dir> into NemTracker/nemtracker.github.io (branch main), keeping
# everything else already there (the equivalent of peaceiris keep_files: true).
#
#   NEMTRACKER_TOKEN=... scripts/deploy_pages.sh <dir> <commit message>
#
# Replaces peaceiris/actions-gh-pages, which broke this deploy three ways:
#   * it cloned the deploy repo's full history (~900 MB of .duckdb binaries, ~2.5 min),
#     leaving a window wide enough for build.yml and import_data.yml to race, and the
#     loser failed with "rejected (fetch first)" -- no retry;
#   * it staged with `git add --all`, which silently skips any NEW file matching the deploy
#     repo's .gitignore: energy_data_2026_h2.duckdb was never published that way;
#   * nothing showed which files actually landed.
# Here: a blobless, depth-1, no-checkout clone (trees only, seconds), the published paths
# added explicitly with -f, and the whole publish retried if the push loses a race.
set -euo pipefail

SRC=$(cd "$1" && pwd)
MSG=$2
: "${NEMTRACKER_TOKEN:?NEMTRACKER_TOKEN is not set}"
REMOTE=${DEPLOY_REMOTE:-"https://x-access-token:${NEMTRACKER_TOKEN}@github.com/NemTracker/nemtracker.github.io.git"}

# One publish attempt. Every step is checked explicitly: `set -e` does not apply inside a
# function called as an `if` condition.
publish_once() {
  local work=$1
  git clone -q --depth 1 --filter=blob:none --no-checkout --branch main "$REMOTE" "$work" || return 1
  cd "$work" || return 1
  git read-tree HEAD || return 1               # index = deployed tree; no blobs downloaded
  cp -r "$SRC"/. . || return 1
  (cd "$SRC" && find . -type f -print0) | xargs -0 git add -f -- || return 1
  if git diff --cached --quiet; then
    echo "Nothing changed; skipping commit."
    return 0
  fi
  git diff --cached --name-status              # hashes only: --stat would fetch old blobs
  git -c user.name=djouallah -c user.email=djouallah@users.noreply.github.com     commit -q -m "$MSG" || return 1
  git push -q origin HEAD:main
}

for attempt in 1 2 3 4 5; do
  WORK=$(mktemp -d)
  if (publish_once "$WORK"); then
    rm -rf "$WORK"
    echo "Published $SRC (attempt $attempt)."
    exit 0
  fi
  rm -rf "$WORK"
  echo "Publish attempt $attempt failed (most likely a concurrent deploy); retrying."
  sleep $((attempt * 15))
done
echo "Publish failed after 5 attempts." >&2
exit 1
