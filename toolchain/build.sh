#!/usr/bin/env bash
# Build ngp from the Angular commit in versions.env: fetch sources, install a local
# Rust toolchain, compile the TS backend, then build the native, wasm and sidecar engines.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
"$here/fetch-angular.sh"
"$here/setup-rust.sh"
"$here/setup-tools.sh"
"$here/build-backend.sh"
"$here/build-engines.sh" "$@"
