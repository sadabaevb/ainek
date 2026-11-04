# CLAIMS.md — what we claim, what we do not (paste into README verbatim)

Judges on this panel have audited TEE products and read the two independent registries that rate
every private-inference provider at "stage 0". Overclaiming costs more than a missing feature.
Honest limitations won prizes at previous NEAR hackathons.

## We claim

- The model runs in an **attested deployment** on NEAR AI Cloud (Intel TDX + NVIDIA confidential GPU).
  The client verifies the TDX quote and the GPU attestation itself (browser SDK; the NVIDIA verdict is fetched through
  NEAR AI's proxy and checked against NVIDIA's keys) and checks the signing key against a **public, append-only log on
  NEAR** written by verifiers (today: one, ours; the log is designed for independent verifiers). If the key is not in the
  log, the client refuses to send.
- Requests are **end-to-end encrypted** to the model's attested key, including tool definitions and
  tool calls (`X-Encrypt-All-Fields`). Our relay and the NEAR AI gateway see ciphertext, size, timing, IP and the request's
  plaintext metadata (model id, message roles, token usage, completion ids), never the contents.
- Every response is **signed inside the enclave** over `sha256(request)` and `sha256(response)`. We keep the
  raw bytes locally and recompute both hashes — the step NEAR's own Verification Center says it cannot do.
- Only a **salted hash** of each proof goes on-chain (once `commit_proof` is deployed; until then the commit stays in the
  browser). Prompts, responses and policy contents never do.
- (Tier 2) The agent holds **only a function-call key** scoped to `propose_action`. Funds sit in the contract.
  Revoking the key (`DeleteKey`) or `pause_agent` stops the agent at the chain level.
- (Tier 2) The policy decision is **signed by a key generated inside an Intel TDX enclave** (OutLayer),
  bound to the job's `wasm_hash`; the contract verifies this signature before executing.
- (Tier 2) The policy job **cannot retain or exfiltrate its input by construction**: it is a WASI-P1 binary with no
  network and no storage interfaces, its build is reproducible (`Cargo.lock`, pinned toolchain), and the `wasm_hash`
  you get from building the repo equals the hash in the attestation. This is a proof of *inability to retain*, not a
  proof of deletion, and it applies to the policy job only — not to the model enclave, and not to the OutLayer worker
  around the job; the action input is public on-chain anyway.
- The card tells you when privacy is **only contractual**: a response signed by the gateway (`signature_kind: gateway`,
  NEAR AI's Incognito tier for Claude/GPT/Gemini) is shown red, not green.

## We do not claim

- **Verified model weights.** Attestation measures the deployment (container image digests, compose hash), not the
  weights. We say "attested deployment of model X".
- **No retention inside the model enclave.** Attestation cannot prove what NEAR AI's model enclave does with data after
  inference (its serving image is not open or reproducible). NEAR AI documents a no-store Responses API, but we use chat
  completions (needed for E2EE).
- **That nobody can read your data.** Our server cannot. The enclave can, by design, during inference.
- **Protection from the server that serves the page.** The browser code that verifies, encrypts and checks the log is served
  by the same server that relays. "Our server cannot read" holds for the code in this repo; on the hosted demo you trust that
  we serve it. `pnpm -F web dev` from a clean clone, or `pnpm demo:live`, removes that trust.
- **A measurement allowlist.** Our log is a *key* allowlist: the client sends only to a key a trusted verifier logged. The
  offline replay also compares the attested compose hash with the logged one; the browser and `demo:live` show it on the
  card but do not compare it yet (SPEC §7.1 asks for it; enforcing it is a pending team decision), and acceptable compose
  hashes are not governed yet (next steps).
- **Instant revocation.** The browser reuses a verification for up to 60 minutes and accepts a log entry up to 24 hours old;
  the log has no revoke entry yet.
- **Unlinkable usage.** Each commit is a transaction from your NEAR account: the chain shows who used Ainek, when and how often.
- **Hidden settlement.** On testnet the executed transfer (token, amount, receiver) is public; the conversation, the reasoning
  and the policy contents stay private. NEAR Confidential Intents could hide settlement; out of scope here.
- **A trust-minimized agent server.** (Tier 2) The agent service is ordinary code we run. Its blast radius is bounded on-chain
  (function-call key, contract checks, TEE-signed policy decisions), not eliminated.
- **Compliance or certification** of any kind.
- **Independence from hardware vendors.** The root of trust is Intel and NVIDIA. A compromised CPU/GPU breaks every
  guarantee here, as it does for every TEE product.
- **Side-channel protection.** Message size and timing are visible to our relay and to NEAR AI.
- **An audited contract.** The contract has unit tests and a `near-sandbox` integration test, no audit.
- **That the E2EE flag in a disclosed file is proven.** The signature covers the request and response bytes; whether those
  bytes were ciphertext is the sender's claim, and `/auditor` labels it as such.

## Known issues we inherited (say so)

- NEAR AI's E2EE route had a reply-key-substitution finding (NEAR issue 1061, Miller registry). We pin the model key from a
  verified report via `X-Model-Pub-Key`, which protects the request; the client's reply key travels as an unsigned header
  (`x-client-pub-key`), so a relay that swapped it could read one reply, and the client would only see the failure afterwards.
  Status of the upstream fix: <check before submission>.
- The Verification Center and the SDK do not ship a measurement allowlist; our log is only as good as the verifiers that
  write to it. Today the log is written by our own verifier; a verifier run by someone outside the team is planned
  (<by Nov 12: name/nick with consent, or the honest line "all verifiers in the demo are ours">).
