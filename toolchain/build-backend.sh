#!/usr/bin/env bash
# Compile ngp's TypeScript backend (and the golden-test helpers) with tsc.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
root="$(dirname "$here")"
src="$here/.cache/angular/packages/compiler-cli/preprocessor"
out="$here/out/preprocessor"

# Reapply local patches from a clean tree so reruns are idempotent.
git -C "$here/.cache/angular" checkout -q -- .
for p in "$here"/patches/*.patch; do
  git -C "$here/.cache/angular" apply "$p"
done

rm -rf "$out"
"$root/node_modules/.bin/tsc" -p "$here/tsconfig.backend.json"
# The package.json marks the output as ESM and carries the `ngp` bin entry.
cp "$src/package.json" "$out/package.json"
echo "backend built in $out"
