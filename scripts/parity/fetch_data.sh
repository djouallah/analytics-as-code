#!/usr/bin/env bash
# What the dashboard has deployed, for the checks of scripts/parity to run over: the
# dimensions, the newest days, the aggregates and the latest two half-years, from GitHub
# Pages (no catalog, no capacity).
#   scripts/parity/fetch_data.sh <dir>
set -euo pipefail
data="$1" && mkdir -p "$data"
site=https://nemtracker.github.io/data
curl -fsS -o "$data/mart_manifest.json" "$site/mart_manifest.json"
periods=$(node -e "console.log(JSON.parse(require('fs').readFileSync(process.argv[1])).periods.slice(-2).map(p => 'mart_' + p).join(' '))" "$data/mart_manifest.json")
for f in mart_dim mart_today mart_agg $periods; do
  curl -fsS -o "$data/$f.duckdb" "$site/$f.duckdb"
done
