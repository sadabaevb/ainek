# Session 4 (Dastan, Nov 7-9): Tier 2: policy job, contract v2, agent

> Translated from Russian on Nov 14, 2026. The original is in this file's git history.

Run only after the checkpoint of Nov 6 (Tier 1 runs from a clean clone) and the GO decision in docs/DECISIONS.md. The agent service in TS (Telegram, structured output, the OutLayer call) is built by Bektur in parallel: you give him the ABI v2 and the Decision format.

---

Read CLAUDE.md, docs/SPEC.md §3.5, §3.6, §4.3, §5.2, §6, §7.2 and docs/DECISIONS.md.

**`jobs/policy` (Rust, OutLayer WASI-P1):**
1. Input/output strictly per SPEC §6.2; the policy from the env `POLICY_JSON`, the key from `PROTECTED_ED25519`; `canonical_bytes(decision)`
   is the same function as in `packages/proof/canonical.ts`, the test vectors are shared.
2. The logic of §6.2; `nonce = sha256(action_commit || now)`; `expires_at = now + 10 min`. Output ≤ 900 bytes: check it with a test.
3. Unit tests for all branches (whitelist, per_action, per_day, needs_approval, deny_new_receivers). Determinism: one input, one output.
4. Deploy to OutLayer testnet; the secrets are locked by the rule "One build only" (an access rule, the owner can move it:
   SPEC §3.5). Record `wasm_hash` and `pubkey` in docs/DEPLOY.md; `register_agent` takes the `pubkey`.

**Contract v2 (`contracts/ainek`):**
1. The methods of SPEC §4.3. `ed25519_verify` from `near_sdk::env`. The checks in `propose_action` are all those of §4.3, each with a separate test.
2. A cross-contract `ft_transfer` to the demo token (`token.ainek.testnet`, NEP-141 through a factory or a ready FT contract from
   docs.near.org/primitives/ft); 1 yocto deposit; a callback updates the action's status; the receivers' `storage_deposit`
   is a script `scripts/register-receivers.ts`.
3. Events: `action_proposed`, `action_pending`, `action_executed`, `action_denied`, `agent_paused`: without the amount and the receiver.
4. Invariant tests: a repeated nonce → error; an expired decision → error; a signature by a foreign key → error;
   `policy_hash` does not match → error; the agent is paused → error; the agent's key is deleted → the transaction does not go through (a test at the key level).

**`services/agent` (Node 24, TS):**
1. A grammY bot: the owner writes text → NEAR AI through `runTier1` from `packages/tier1-node` (directly, a TLS pin to the gateway, E2EE;
   structured output through a function tool `tools` + `tool_choice`, not `response_format`, which the SDK does not encrypt; the call's arguments
   are parsed by the zod schema `Action`; system prompt "you are a treasurer, extract the action or refuse") → a model proof as in the client.
2. → the OutLayer HTTPS API (`X-Payment-Key`, input §6.2, `spent_today` from the contract's view) → `Decision` + `sig`.
3. → `propose_action` with the agent's FC key (`near-api-js`, the key only for `commit_proof` and `propose_action`, set the allowance; the model proof is committed before the proposal).
4. `NeedsApproval` → inline buttons "Approve / Reject" to the owner; Approve → an instruction to the owner to confirm in the wallet
   (or `near-cli` with a full key): the agent must not be able to approve by itself.
5. Assemble the `ActionProof` (SPEC §5.2), the commit, send the card as text + a link to the web card.
6. The stop button: `scripts/stop-agent.ts`: the owner's `DeleteKey` of the agent's key + `pause_agent`; then a demonstration of
   the refusal of the next attempt (an on-chain error).

Metrics for the README: the time from the message to `action_executed`, the share of false blocks on 50 test actions, the gas.

**Reproducible build (SPEC §3.5):** `rust-toolchain.toml` with an exact version, `Cargo.lock` in the repo, a release profile with
fixed flags, a script `scripts/wasm-hash.sh` (sha256 of the .wasm), a GitHub Action that builds and prints the hash.
Check that the hash from two machines matches and equals `wasm_hash` in the OutLayer attestation and in docs/DEPLOY.md. If OutLayer
adds something of its own to the image (a wrapper), document which exact hash is attested, and compare that one.
