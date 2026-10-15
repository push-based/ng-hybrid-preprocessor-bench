#!/usr/bin/env bash
# Install benchmark tools pinned in versions.env into toolchain/.cache/tools/bin,
# using the project-local Rust from setup-rust.sh.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
source "$here/versions.env"
export RUSTUP_HOME="$here/.cache/rust/rustup"
export CARGO_HOME="$here/.cache/rust/cargo"
export PATH="$CARGO_HOME/bin:$PATH"
tools="$here/.cache/tools"

if [[ "$("$tools/bin/hyperfine" --version 2>/dev/null || true)" != "hyperfine $HYPERFINE_VERSION" ]]; then
  cargo install -q --locked hyperfine --version "$HYPERFINE_VERSION" --root "$tools"
fi
"$tools/bin/hyperfine" --version
