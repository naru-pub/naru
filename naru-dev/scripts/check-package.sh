#!/usr/bin/env bash
# Packs the package as npm would publish it (prepack builds it), installs the
# tarball in an empty folder outside the repository, and runs test/smoke.mjs
# there, with nothing of this checkout on its module path:
#
#   scripts/check-package.sh <folder for the tarball>
#
# CI runs it on each push (main.yml) and before publishing (publish-naru-dev.yml).
# NARU_DEV_SMOKE_NODE runs the installed package on another node binary.
set -euo pipefail
here=$(cd "$(dirname "$0")/.." && pwd)
out=$(mkdir -p "$1" && cd "$1" && pwd)
tarball="$out/$(cd "$here" && npm pack --silent --pack-destination "$out" | tail -1)"
app=$(mktemp -d "${TMPDIR:-/tmp}/naru-dev-check-XXXXXX")
trap 'rm -rf "$app"' EXIT
cp -R "$here/test" "$app/test"
cd "$app"
npm init --yes >/dev/null
npm install --no-audit --no-fund "$tarball"
node=${NARU_DEV_SMOKE_NODE:-node}
"$node" node_modules/@naru-pub/dev/dist/cli.mjs --version
"$node" test/smoke.mjs
du -sh "$tarball" node_modules
echo "checked $tarball"
