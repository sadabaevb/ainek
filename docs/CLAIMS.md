# CLAIMS.md — what we claim, what we do not (paste into README verbatim)

Judges on this panel have audited TEE products and read the two independent registries that rate
every private-inference provider at "stage 0". Overclaiming costs more than a missing feature.
Honest limitations won prizes at previous NEAR hackathons.

## We claim

- The model runs in an **attested deployment** on NEAR AI Cloud (Intel TDX + NVIDIA confidential GPU).
  The client verifies the TDX quote and the GPU attestation itself (browser SDK; NRAS POST goes through
  our proxy because of CORS) and checks the signing key against a **public, append-only log on NEAR**
  written by independent verifiers. If the key is not in the log, the client refuses to send.
- Requests are **end-to-end encrypted** to the model's attested key, including tool definitions and
  tool calls (`X-Encrypt-All-Fields`). Our relay and the NEAR AI gateway see ciphertext, size, timing and IP.
- Every response is **signed inside the enclave** over `sha256(request)` and `sha256(response)`. We keep the
  raw bytes locally and recompute both hashes — the step NEAR's own Verification Center says it cannot do.
- Only a **salted hash** of each proof goes on-chain. Prompts, responses and policy contents never do.
- The agent holds **only a function-call key** scoped to `propose_action`. Funds sit in the contract.
  Revoking the key (`DeleteKey`) or `pause_agent` stops the agent at the chain level.
- (Tier 2) The policy decision is **signed by a key generated inside an Intel TDX enclave** (OutLayer),
  bound to the job's `wasm_hash`; the contract verifies this signature before executing.
- (Tier 2) The policy job **cannot retain or exfiltrate its input by construction**: it is a WASI-P1 binary with no
  network and no storage interfaces, its build is reproducible (`Cargo.lock`, pinned toolchain), and the `wasm_hash`
  you get from building the repo equals the hash in the attestation. This is a proof of *inability to retain*, not a
  proof of deletion, and it applies to the policy job only — not to the model enclave.
- The card tells you when privacy is **only contractual**: a response signed by the gateway (`signature_kind: gateway`,
  NEAR AI's Incognito tier for Claude/GPT/Gemini) is shown red, not green.

## We do not claim

- **Verified model weights.** Attestation measures the deployment (container image digests, compose
  hash), not the weights. We say "attested deployment of model X".
- **No retention inside the model enclave.** Attestation cannot prove what NEAR AI's model enclave does with data
  after inference (its serving image is not open or reproducible). NEAR AI documents a no-store Responses API, but we use chat completions (needed for E2EE).
- **That nobody can read your data.** Our server cannot. The enclave can, by design, during inference.
- **Hidden settlement.** On the public testnet the executed transfer (token, amount, receiver) is visible
  in the transaction. What stays private is the conversation, the reasoning and the policy contents.
  Hiding settlement is possible with NEAR Confidential Intents and is out of scope for this submission.
- **A trust-minimized agent server.** The agent service is ordinary code we run. Its blast radius is
  bounded on-chain (function-call key, contract checks, TEE-signed policy decisions), not eliminated.
- **Compliance or certification** of any kind. We cite EU AI Act Art. 50 / GDPR Art. 22 as design
  targets ("designed for"), never as compliance.
- **Independence from hardware vendors.** The root of trust is Intel and NVIDIA. A compromised CPU/GPU
  breaks every guarantee here, as it does for every TEE product.
- **Side-channel protection.** Message size and timing are visible to our relay and to NEAR AI.
- **An audited contract.** The contract is tested with `near-workspaces` invariants but not audited.

## Known issues we inherited (say so)

- NEAR AI's E2EE route had a reply-key-substitution finding (NEAR issue 1061, Miller registry). We pin the
  model key from a verified report via `X-Model-Pub-Key`; status of the fix: <check before submission>.
- The Verification Center and the SDK do not ship a measurement allowlist; our log *is* the allowlist,
  and it is only as good as the verifiers that write to it. In the demo both verifiers are ours.
