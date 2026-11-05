#!/usr/bin/env bash
# Builds the policy job and prints the sha256 of ainek-policy.wasm (SPEC §3.5).
#
# This hash is the identity of the policy code: OutLayer attests it, the job's secrets are locked to it, and it is
# published in docs/DEPLOY.md. Anyone can run this script on a clean clone and compare.
#
# The build runs in a pinned linux/amd64 container (needs Docker). A plain `cargo build` on your own machine gives a
# working but different wasm: cargo mixes the host platform into its symbol hashes, so macOS and Linux lay the code
# out differently even with the same toolchain and Cargo.lock. Inside the container the host, the toolchain
# (jobs/policy/rust-toolchain.toml), the dependencies (--locked) and every path are the same for everyone.
set -euo pipefail
cd "$(dirname "$0")/../jobs/policy"

command -v docker >/dev/null || { echo "wasm-hash.sh needs Docker (see docs/DEPLOY.md)" >&2; exit 1; }

# rust:1.93.0-slim, pinned by digest: a tag can be moved, a digest cannot. Keep in step with rust-toolchain.toml.
image='rust@sha256:760ad1d638d70ebbd0c61e06210e1289cbe45ff6425e3ea6e01241de3e14d08e'

# Its own target directory: artifacts built by the container must not mix with a native build's.
# --user: on Linux the files in target/ would otherwise belong to root. --init: Ctrl-C stops the build.
docker run --rm --init --platform linux/amd64 --user "$(id -u):$(id -g)" -v "$(pwd -P)":/ainek-policy -w /ainek-policy "$image" \
  cargo build --release --locked --target wasm32-wasip1 --target-dir target/repro >&2

wasm=target/repro/wasm32-wasip1/release/ainek-policy.wasm
if command -v sha256sum >/dev/null; then sha256sum "$wasm"; else shasum -a 256 "$wasm"; fi
