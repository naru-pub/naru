#!/usr/bin/env bash
# Builds the package and runs test/smoke.mjs over and over, stopping at the
# first failure, to shake out races (such as _naru/ being published while a
# file there is half written):
#
#   scripts/loop-smoke.sh [runs, default 20]
set -euo pipefail
cd "$(dirname "$0")/.."
node scripts/build.mjs >/dev/null
runs=${1:-20}
for ((i = 1; i <= runs; i++)); do
  if ! out=$(node test/smoke.mjs 2>&1); then
    printf '%s\n' "$out"
    echo "failed on run $i of $runs"
    exit 1
  fi
  echo "run $i of $runs passed"
done
