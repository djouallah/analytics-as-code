#!/usr/bin/env bash
# Stage the pages of the GitHub Pages site into <dir>, for scripts/deploy_pages.sh (build.yml,
# and import_data.yml when it ships the page with the data):
#   /      dashboard/github-dax: the page, one folder per layer, and the semantic model next
#          to its compiler (it is the repo's, semantic_model/, not this client's). The default.
#   /sql/  dashboard/github-sql: the same page, its own frontend/queries.js in SQL, no
#          semantic model. It reads the site's data/, one folder up.
# Then the build stamp (the Logs panel shows it) and ?v=<build> on every relative import, so a
# browser's cached modules never run with a new page; and the dbt docs, which are not stamped.
#
#   scripts/stage_pages.sh <dir> <build>
set -euo pipefail

DIR=$1
BUILD=$2
PAGE=dashboard/github-dax

mkdir -p "$DIR" "$DIR/sql"
cp "$PAGE/index.html" "$DIR/"
cp -r "$PAGE/frontend" "$PAGE/semantic" "$PAGE/storage" "$DIR/"
cp semantic_model/model.bim "$DIR/semantic/"

cp "$PAGE/index.html" "$DIR/sql/"
cp -r "$PAGE/frontend" "$PAGE/storage" "$DIR/sql/"
cp dashboard/github-sql/frontend/queries.js "$DIR/sql/frontend/"

node scripts/stamp_build.mjs "$DIR" "$BUILD"
cp -r "$PAGE/dag" "$DIR/"
