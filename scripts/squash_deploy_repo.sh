#!/usr/bin/env bash
# Replace the history of NemTracker/nemtracker.github.io (branch main) with a single commit of
# its current tree. The published site is byte-for-byte the same; only old versions go.
#
#   NEMTRACKER_TOKEN=... scripts/squash_deploy_repo.sh
#
# Why: energy_today.duckdb (~8 MB) is redeployed every 30 minutes and git keeps every copy,
# so the repo had grown to ~16 GB by 2026-10-01 with only the current tree being served.
#
# How, without downloading any of it: a blobless depth-1 clone gives the current commit and
# its tree; `commit-tree` makes a parentless commit pointing at that same tree, so pushing it
# sends one commit object (the tree and blobs are already on GitHub). --force-with-lease
# makes the push fail if a deploy landed meanwhile, and the loop then retries on the new tip.
# GitHub reclaims the unreachable objects on its own schedule, so the reported repo size
# drops some time after the push, not immediately.
set -euo pipefail

: "${NEMTRACKER_TOKEN:?NEMTRACKER_TOKEN is not set}"
REMOTE=${DEPLOY_REMOTE:-"https://x-access-token:${NEMTRACKER_TOKEN}@github.com/NemTracker/nemtracker.github.io.git"}
export GIT_AUTHOR_NAME=djouallah GIT_AUTHOR_EMAIL=djouallah@users.noreply.github.com
export GIT_COMMITTER_NAME=$GIT_AUTHOR_NAME GIT_COMMITTER_EMAIL=$GIT_AUTHOR_EMAIL

squash_once() {
  local work=$1 old tree new
  git clone -q -c core.autocrlf=false --depth 1 --filter=blob:none --no-checkout --branch main "$REMOTE" "$work" || return 1
  cd "$work" || return 1
  old=$(git rev-parse HEAD) || return 1
  tree=$(git rev-parse 'HEAD^{tree}') || return 1
  new=$(git commit-tree "$tree" -m "Deployed site as of $(date -u +%Y-%m-%dT%H:%MZ) (history squashed weekly by analytics-as-code)") || return 1
  echo "Squashing main: $old -> $new (tree $tree)"
  git -c pack.window=0 push -q --no-thin --force-with-lease="main:$old" origin "$new:refs/heads/main"
}

for attempt in 1 2 3 4 5; do
  WORK=$(mktemp -d)
  if (squash_once "$WORK"); then
    rm -rf "$WORK"
    echo "Squashed (attempt $attempt)."
    exit 0
  fi
  rm -rf "$WORK"
  echo "Attempt $attempt failed (most likely a deploy landed meanwhile); retrying."
  sleep $((attempt * 20))
done
echo "Squash failed after 5 attempts." >&2
exit 1
