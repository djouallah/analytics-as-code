#!/usr/bin/env bash
# Publish the files under <dir> into NemTracker/nemtracker.github.io (branch main), keeping
# everything else already there (the equivalent of peaceiris keep_files: true).
#
#   NEMTRACKER_TOKEN=... scripts/deploy_pages.sh <dir> <commit message>
#
# DEPLOY_REMOVE, if set, is a list of paths (wildcards as git reads them) taken out of the
# deployed tree in the same commit: the one way a file leaves the site.
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
  # The clone has no blobs, and git fetches any missing one it wants on demand. Left alone
  # that pulled the whole repo (364 MB, ~140 s) on every attempt -- the write-tree inside
  # `git commit` checks that every blob in the index exists. So: plumbing only, each step
  # chosen not to look at old blobs -- add with autocrlf off (its safe-crlf check reads the
  # old blob), diff-index, write-tree --missing-ok + commit-tree, and a push that never
  # searches for delta bases (pack.window=0, --no-thin).
  git clone -q -c core.autocrlf=false --depth 1 --filter=blob:none --no-checkout --branch main "$REMOTE" "$work" || return 1
  cd "$work" || return 1
  git read-tree HEAD || return 1               # index = deployed tree; no blobs downloaded
  if [ -n "${DEPLOY_REMOVE:-}" ]; then
    # Unquoted on purpose: one pathspec per word. Nothing is checked out, so the shell has
    # no file to expand a wildcard to and git gets it as written.
    git ls-files -z -- $DEPLOY_REMOVE | xargs -0 -r git update-index --force-remove -- || return 1
  fi
  cp -r "$SRC"/. . || return 1
  (cd "$SRC" && find . -type f -print0) | xargs -0 git add -f -- || return 1
  # diff-index without rename detection compares hashes only.
  if git diff-index --cached --quiet --no-renames HEAD; then
    echo "Nothing changed; skipping commit."
    return 0
  fi
  git diff-index --cached --name-status --no-renames HEAD
  local tree commit
  tree=$(git write-tree --missing-ok) || return 1   # skips the existence check that fetched every blob
  commit=$(git commit-tree "$tree" -p HEAD -m "$MSG") || return 1
  git update-ref HEAD "$commit" || return 1
  git -c pack.window=0 push -q --no-thin origin HEAD:main
}

export GIT_AUTHOR_NAME=djouallah GIT_AUTHOR_EMAIL=djouallah@users.noreply.github.com
export GIT_COMMITTER_NAME=$GIT_AUTHOR_NAME GIT_COMMITTER_EMAIL=$GIT_AUTHOR_EMAIL

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
