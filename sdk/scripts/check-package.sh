#!/usr/bin/env bash
# Packs the package as npm would publish it (prepack builds it), installs the
# tarball in an empty folder outside the repository, runs test/smoke.mjs
# there, and checks that its files are the ones Naru serves for its version:
#
#   scripts/check-package.sh <folder for the tarball>
#
# CI runs it on each push (main.yml) and before publishing (publish-sdk.yml).
set -euo pipefail
here=$(cd "$(dirname "$0")/.." && pwd)
out=$(mkdir -p "$1" && cd "$1" && pwd)
tarball="$out/$(cd "$here" && npm pack --silent --pack-destination "$out" | tail -1)"
app=$(mktemp -d "${TMPDIR:-/tmp}/naru-sdk-check-XXXXXX")
trap 'rm -rf "$app"' EXIT
cp -R "$here/test" "$app/test"
cd "$app"
npm init --yes >/dev/null
npm install --no-audit --no-fund "$tarball"
node test/smoke.mjs
version=$(node -p "require('@naru-pub/sdk/package.json').version")
served="$here/../control-plane/public/sdk/${version%%-*}"
for file in "$served"/*; do
  cmp "$file" "node_modules/@naru-pub/sdk/dist/$(basename "$file")"
done
tar -tzf "$tarball"
echo "checked $tarball"
