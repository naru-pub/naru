#!/usr/bin/env bash
# Packs the package as npm would publish it (prepack builds it), installs the
# tarball in an empty folder outside the repository, and runs test/smoke.mjs
# there, with nothing of this checkout on its module path:
#
#   scripts/check-package.sh <folder for the tarball>
#   scripts/check-package.sh <absolute path of a tarball already packed>
#
# CI runs it on each push (main.yml) and before publishing (publish-naru-dev.yml).
set -euo pipefail
here=$(cd "$(dirname "$0")/.." && pwd)
if [[ "$1" == *.tgz ]]; then
  tarball=$1
else
  out=$(mkdir -p "$1" && cd "$1" && pwd)
  tarball="$out/$(cd "$here" && npm pack --silent --pack-destination "$out" | tail -1)"
fi
app=$(mktemp -d "${TMPDIR:-/tmp}/naru-dev-check-XXXXXX")
trap 'rm -rf "$app"' EXIT
cp -R "$here/test" "$app/test"
cd "$app"
npm init --yes >/dev/null
npm install --no-audit --no-fund "$tarball"
node node_modules/@naru-pub/dev/dist/cli.mjs --version
node test/smoke.mjs
du -sh "$tarball" node_modules
echo "checked $tarball"
