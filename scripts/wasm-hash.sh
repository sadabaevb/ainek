#!/usr/bin/env bash
# Builds the policy job and prints the sha256 of ainek-policy.wasm (SPEC §3.5).
#
# This hash is the identity of the policy code: OutLayer attests it, the job's secrets are locked to it, and it is
# published in docs/DEPLOY.md. Anyone can run this script on a clean clone and compare. The toolchain is pinned in
# jobs/policy/rust-toolchain.toml and the dependencies in Cargo.lock (--locked), so the bytes do not depend on the
# machine; --remap-path-prefix keeps the checkout path and the cargo home out of the binary.
set -euo pipefail
cd "$(dirname "$0")/../jobs/policy"

# Physical paths (pwd -P): cargo hands rustc resolved paths, so a symlinked checkout would otherwise miss the remap.
# CARGO_ENCODED_RUSTFLAGS (flags separated by 0x1f) instead of RUSTFLAGS: a path with a space must stay one flag.
here=$(pwd -P)
cargo_home=$(cd "${CARGO_HOME:-$HOME/.cargo}" && pwd -P)
CARGO_ENCODED_RUSTFLAGS=$(printf '%s\037%s' "--remap-path-prefix=$here=/ainek-policy" "--remap-path-prefix=$cargo_home=/cargo")
export CARGO_ENCODED_RUSTFLAGS
unset RUSTFLAGS
cargo build --release --locked --target wasm32-wasip1 >&2

wasm=target/wasm32-wasip1/release/ainek-policy.wasm
if command -v sha256sum >/dev/null; then sha256sum "$wasm"; else shasum -a 256 "$wasm"; fi
