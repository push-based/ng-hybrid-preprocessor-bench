#!/usr/bin/env bash
# Build ngp's Rust analyzer three ways, all from the same Cargo.lock:
#   native   N-API addon (Cargo feature `napi`), loaded in-process
#   wasm     wasm-bindgen build for Node, single-threaded
#   sidecar  standalone binary speaking JSON-RPC over stdio
# Usage: build-engines.sh [native|wasm|sidecar ...]   (default: all three)
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
source "$here/versions.env"
export RUSTUP_HOME="$here/.cache/rust/rustup"
export CARGO_HOME="$here/.cache/rust/cargo"
export PATH="$CARGO_HOME/bin:$PATH"
export CARGO_TARGET_DIR="$here/.cache/target"
manifest="$here/.cache/angular/Cargo.toml"
out="$here/out/engines"

engines=("$@")
[[ ${#engines[@]} -eq 0 ]] && engines=(native wasm sidecar)

case "$(uname -s)" in
  Darwin) dylib=libng_analyze.dylib ;;
  Linux) dylib=libng_analyze.so ;;
  *) echo "unsupported OS $(uname -s)" >&2; exit 1 ;;
esac

# The wasm build's JS glue is CommonJS; the native addon is loaded with require().
write_cjs_marker() { printf '{"type": "commonjs"}\n' > "$1/package.json"; }

for engine in "${engines[@]}"; do
  echo "== $engine"
  rm -rf "${out:?}/$engine"
  mkdir -p "$out/$engine"
  case "$engine" in
    native)
      cargo build --manifest-path "$manifest" --locked --release -p ng-analyze --lib --features napi
      cp "$CARGO_TARGET_DIR/release/$dylib" "$out/native/ng_analyze.node"
      write_cjs_marker "$out/native"
      ;;
    wasm)
      cargo build --manifest-path "$manifest" --locked --release -p ng-analyze --lib \
        --target wasm32-unknown-unknown
      wasm-bindgen --target nodejs --out-dir "$out/wasm" --out-name ng_analyze \
        "$CARGO_TARGET_DIR/wasm32-unknown-unknown/release/ng_analyze.wasm"
      write_cjs_marker "$out/wasm"
      ;;
    sidecar)
      cargo build --manifest-path "$manifest" --locked --release -p ng-analyze --bin ng-analyze
      cp "$CARGO_TARGET_DIR/release/ng-analyze" "$out/sidecar/ng_analyze_bin"
      ;;
    *) echo "unknown engine $engine" >&2; exit 1 ;;
  esac
done
ls -la "$out"/*
