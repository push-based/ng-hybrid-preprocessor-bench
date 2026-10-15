#!/usr/bin/env bash
# Install a project-local Rust toolchain with the wasm32 target.
# Homebrew's Rust has no wasm32 standard library, so the wasm engine needs rustup.
# Everything lands in toolchain/.cache/rust; nothing outside the repo changes.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
source "$here/versions.env"
export RUSTUP_HOME="$here/.cache/rust/rustup"
export CARGO_HOME="$here/.cache/rust/cargo"
export PATH="$CARGO_HOME/bin:$PATH"

if ! command -v rustup >/dev/null || [[ "$(command -v rustup)" != "$CARGO_HOME/bin/rustup" ]]; then
  case "$(uname -s)-$(uname -m)" in
    Darwin-arm64) triple=aarch64-apple-darwin ;;
    Darwin-x86_64) triple=x86_64-apple-darwin ;;
    Linux-x86_64) triple=x86_64-unknown-linux-gnu ;;
    Linux-aarch64) triple=aarch64-unknown-linux-gnu ;;
    *) echo "unsupported host $(uname -sm)" >&2; exit 1 ;;
  esac
  mkdir -p "$here/.cache/rust"
  curl --proto '=https' --tlsv1.2 -sSf -o "$here/.cache/rust/rustup-init" \
    "https://static.rust-lang.org/rustup/dist/$triple/rustup-init"
  chmod +x "$here/.cache/rust/rustup-init"
  "$here/.cache/rust/rustup-init" -y -q --no-modify-path --profile minimal \
    --default-toolchain "$RUST_TOOLCHAIN"
fi

rustup toolchain install "$RUST_TOOLCHAIN" --profile minimal --target wasm32-unknown-unknown
rustup default "$RUST_TOOLCHAIN"

if [[ "$(wasm-bindgen --version 2>/dev/null || true)" != "wasm-bindgen $WASM_BINDGEN_VERSION" ]]; then
  cargo install -q --locked wasm-bindgen-cli --version "$WASM_BINDGEN_VERSION"
fi

rustc --version
wasm-bindgen --version
