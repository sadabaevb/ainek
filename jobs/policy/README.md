# jobs/policy

The Ainek policy job for OutLayer (SPEC §3.5, §6): decides whether the agent's action fits the owner's policy and signs
the decision with a key that exists only inside the TEE. WASI P1: stdin JSON in, stdout JSON out, no network and no
filesystem, so the code has nowhere to send or store what it reads.

```
cargo test                    # every branch of the policy, the signature, the shared test vectors
../../scripts/wasm-hash.sh    # reproducible release build in a pinned container (needs Docker) + sha256 of the wasm
```

- Input, output and the decision rules: `docs/SPEC.md` §6.2. Reference outputs: `docs/test-vectors/policy-decision.json`.
- Canonical JSON (`src/canonical.rs`) is the twin of `packages/proof/src/canonical.ts`; both are tested against
  `docs/test-vectors/canonical.json`.
- Secrets (`POLICY_JSON`, `PROTECTED_ED25519`, `WASM_HASH`) and deployment: `docs/DEPLOY.md`.

To try it locally (`cargo build --release --locked --target wasm32-wasip1`) with [wasmtime](https://wasmtime.dev),
using the published **test** key from the vectors file (never a real key):

```
wasmtime run \
  --env 'POLICY_JSON={"version":3,"principal":"owner.ainek.testnet","agent":"agent.ainek.testnet","token_id":"token.ainek.testnet","whitelist":["aibek.testnet"],"caps":{"per_action":"500000000","per_day":"2000000000"},"needs_approval_above":"300000000","deny_new_receivers":true,"salt":"5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a"}' \
  --env PROTECTED_ED25519=ed25519:US517G5965aydkZ46HS38QLi7UQiSojurfbQfKCELFx \
  --env WASM_HASH=abababababababababababababababababababababababababababababababab \
  target/wasm32-wasip1/release/ainek-policy.wasm \
  <<< '{"action":{"kind":"ft_transfer","token_id":"token.ainek.testnet","receiver_id":"aibek.testnet","amount":"300000000","memo":"October"},"model_proof_commit":"cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd","spent_today":"0","now":1762200000000}'
```
