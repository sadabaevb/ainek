# Session 1b (Dastan, Nov 3): Rust spikes: a hello contract + OutLayer

> Translated from Russian on Nov 14, 2026. The original is in this file's git history.

Open Claude Code in the repo root and paste this in full.

---

Read CLAUDE.md and docs/SPEC.md. I am Dastan, responsible for the contract, the verifier, the OutLayer policy job and the contract-facing part of the agent. I know Rust, I do not know NEAR, so
explain NEAR-specific decisions in comments and in docs/DEV-NOTES.md. We work on testnet. We deploy nothing to mainnet.

The task of this session is two spikes, no production code:

**Spike A: a hello contract on NEAR.**
1. Use the skill `near-smart-contracts` and the docs MCP (`search_near_docs`): do not guess the near-sdk-rs API.
2. Set up the toolchain: rustup target `wasm32-unknown-unknown`, `cargo-near`, `near-cli-rs`. Create the testnet accounts
   `ainek-dev-dastan.testnet` through near-cli-rs (the faucet for test NEAR).
3. In `contracts/ainek` create a minimal contract with one change method `log_key(entry: String) -> u64`
   (append to a `Vector<String>`, emit the NEP-297 event `ainek.key_logged`) and a view `head()`. A test on `near-workspaces`.
4. `cargo near build`, deploy to testnet, call `log_key` and `head()` from the CLI. Show me the tx hash and the link to
   testnet.nearblocks.io. Write the exact commands into docs/DEV-NOTES.md.

**Spike B: OutLayer (decides whether the policy will be in a TEE).**
1. Read https://app.outlayer.ai/docs/getting-started, /docs/wasi, /docs/https-api, /docs/secrets,
   /docs/tee-attestation, /docs/sdk and the repo https://github.com/out-layer/skills (it has Claude skills: install them).
2. In `jobs/policy` make a WASI-P1 job in Rust (`outlayer = "0.2"`): it reads JSON from stdin
   `{"action":{"amount":"300"},"cap":"500"}` and writes `{"verdict":"Allow"}` or `Deny` to stdout. No HTTP.
3. Deploy it to testnet-api.outlayer.ai, call it through the HTTPS API, get a `call_id` and an `attestation_url`; wait until
   a quote appears at the `attestation_url`. Save the raw response in docs/spike-outlayer/.
4. Check in the docs: (a) how to create the secrets `POLICY_JSON` and `PROTECTED_ED25519` (generated in the TEE) and read
   them in the job as env; (b) the real limit of the output size (≤ 900 bytes?); (c) what exactly the OutLayer API gateway sees:
   the input in the clear or not (if the docs have no answer, write that down as it is); (d) whether the output can be signed with the key
   `PROTECTED_ED25519` inside the job (ed25519-dalek).
5. The result is docs/DECISIONS.md: "Policy in a TEE through OutLayer: GO / NO-GO", with the facts from items 3-4 and
   an estimate of how many days the full job from SPEC §6 would take. If NO-GO, describe the fallback "policy in the contract"
   from SPEC §4.3.

Rules: commit in small commits as you go; secrets only in .env (add the variable names to .env.example);
before any spending of more than 1 test NEAR or any mainnet action, ask me.
