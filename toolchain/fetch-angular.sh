#!/usr/bin/env bash
# Fetch the preprocessor sources from angular/angular at ANGULAR_SHA.
# A sparse, blobless fetch: about 1,500 files instead of the whole monorepo.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
source "$here/versions.env"
dest="$here/.cache/angular"

if [[ -d "$dest/.git" ]] && [[ "$(git -C "$dest" rev-parse HEAD)" == "$ANGULAR_SHA" ]]; then
  echo "angular already at $ANGULAR_SHA"
  exit 0
fi

rm -rf "$dest"
mkdir -p "$dest"
git -C "$dest" init -q
git -C "$dest" remote add origin https://github.com/angular/angular.git
git -C "$dest" sparse-checkout set --no-cone \
  '/Cargo.toml' \
  '/Cargo.lock' \
  '/packages/compiler-cli/preprocessor/'
git -C "$dest" fetch -q --depth 1 --filter=blob:none origin "$ANGULAR_SHA"
git -C "$dest" -c advice.detachedHead=false checkout -q FETCH_HEAD
echo "angular checked out at $(git -C "$dest" rev-parse HEAD)"
