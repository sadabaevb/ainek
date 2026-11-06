# CLAIMS.md — what we claim, what we do not (paste into README verbatim)

Judges on this panel have audited TEE products and read the two independent registries that rate
every private-inference provider at "stage 0". Overclaiming costs more than a missing feature.
Honest limitations won prizes at previous NEAR hackathons.

## We claim

- The model runs in an **attested deployment** on NEAR AI Cloud (Intel TDX + NVIDIA confidential GPU).
  The client verifies the TDX quote and the GPU attestation itself (browser SDK; the NVIDIA verdict is fetched through
  NEAR AI's proxy and checked against NVIDIA's keys) and checks the signing key against a **public, append-only log on
  NEAR** written by verifiers (today: one, ours; the log is designed for independent verifiers). If the key is not in the
  log, the client refuses to send. Which verifiers count, and how many must agree, is the viewer's choice on `/log`; the site
  only sets the default.
- Requests are **end-to-end encrypted** to the model's attested key, including tool definitions and
  tool calls (`X-Encrypt-All-Fields`). Our relay and the NEAR AI gateway see ciphertext, size, timing, IP and the request's
  plaintext metadata (model id, message roles, token usage, completion ids), never the contents. For replies this holds while
  no hop swapped the reply key: see the first item under "Known issues we inherited".
- Every response is **signed inside the enclave** over `sha256(request)` and `sha256(response)`. We keep the
  raw bytes locally and recompute both hashes — the step NEAR's own Verification Center says it cannot do.
- Only a **salted hash** of each proof goes on-chain (`commit_proof`, paid from storage the committing account prepays and
  cannot withdraw). Prompts, responses and policy contents never do.
- (Tier 2) The agent holds **only a function-call key** scoped to `commit_proof` and `propose_action`, and refuses to start with any other. Funds sit in the contract.
  Revoking the key (`DeleteKey`) or `pause_agent` stops the agent at the chain level.
- (Tier 2) The policy decision is **signed by a key generated inside an Intel TDX enclave** (OutLayer); the contract
  verifies this signature before executing. The signature shows which key signed, not which code ran: that is in the
  run's attestation (`wasm_hash`), which the contract does not check.
- (Tier 2) The policy job **cannot retain or exfiltrate its input by construction**: it is a WASI-P1 binary with no
  network and no storage interfaces, its build is reproducible (`Cargo.lock`, pinned toolchain), and the `wasm_hash`
  you get from building the repo equals the hash in the attestation. This is a proof of *inability to retain*, not a
  proof of deletion, and it applies to the policy job only — not to the model enclave, and not to the OutLayer worker
  around the job; the action input is public on-chain anyway.
- The card tells you when privacy is **only contractual**: a response signed by the gateway (`signature_kind: gateway`,
  NEAR AI's Incognito tier for Claude/GPT/Gemini) is shown red, not green.

## We do not claim

- **That the decision key is tied to one build of the policy job.** OutLayer's "one build only" lock is an access
  rule: per OutLayer's docs the owner of the OutLayer project (in the demo: us) can move it to another build or
  remove it, the key stays the same and the contract would not notice.
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
  card and point the proof at a log entry with that compose when there is one, but still send when there is none, and the
  card says so (SPEC §7.1 asks for a refusal; enforcing it is a pending team decision), and acceptable compose hashes are not
  governed yet (next steps). Instances of a model share one signing key, so the signature alone does not say which deployment
  answered.
- **A trustless read of the log.** The client reads `latest_keys` through one JSON-RPC endpoint (FastNear by default,
  `NEAR_RPC_URL`) with no light-client proof, so "checked against the public log" means "checked against what that endpoint
  says the log holds". A lying endpoint can pass an unlogged key or refuse a logged one; it cannot route you to an unattested
  key, because attestation is checked locally. The endpoint also sees the browser's IP and the timing of every message's
  log read, and the signed commit transaction, which the wallet connector broadcasts through its own FastNear endpoint
  (README "Who sees what").
- **Instant revocation.** The browser reuses a verification for up to 60 minutes and accepts a log entry up to 24 hours old;
  the log has no revoke entry yet.
- **A browser key limited to `commit_proof`.** Sign-in asks for that limit; the wallet decides what it grants. Meteor allowed
  every method of the contract, with a 0.25 NEAR gas allowance, in our Nov 5 testnet run. A function-call key still cannot attach a deposit or call
  another contract, and for an ordinary account the other methods either reject it or only read. The page keeps the key in localStorage, so a script on
  the page could use it, and Disconnect removes only that copy, not the key on the account. A contract owner or verifier account should not connect here,
  because the owner and verifier methods would accept this key.
- **Unlinkable usage.** Each commit is a transaction from your NEAR account: the chain shows who used Ainek, when and how often.
- **Hidden settlement.** On testnet the executed transfer (token, amount, receiver) is public; the conversation, the reasoning
  and the policy contents stay private. NEAR Confidential Intents could hide settlement; out of scope here.
- **A trust-minimized agent server.** (Tier 2) The agent service is ordinary code we run. It and Telegram read the owner's
  messages in plaintext; E2EE covers the hop from the service to the model, not the hop from the owner to the service. Its
  blast radius is bounded on-chain (function-call key, contract checks, TEE-signed policy decisions), not eliminated. The server
  supplies `spent_today` to the policy job, but the contract recomputes the decision's nonce from its own daily total and refuses
  a decision made for a false one. A compromised server can still leave a denied attempt out, and neither the job nor the contract
  opens the model proof: the contract checks only that this agent committed that hash, which the server supplied.
- **That the model resists prompt injection.** (Tier 2) It may or may not propose what an injected message asks. The limits
  are enforced by the policy and the contract, not by the model.
- **A policy nobody can infer.** (Tier 2) Its contents stay off-chain, but public actions and verdicts show over time who is on
  the whitelist and roughly where the thresholds sit.
- **Compliance or certification** of any kind.
- **Independence from hardware vendors.** The root of trust is Intel and NVIDIA. A compromised CPU/GPU breaks every
  guarantee here, as it does for every TEE product.
- **Side-channel protection.** Message size and timing are visible to our relay and to NEAR AI.
- **An audited contract.** The contract has unit tests and a `near-sandbox` integration test, no audit.
- **That the E2EE flag in a disclosed file is proven.** The signature covers the request and response bytes; whether those
  bytes were ciphertext is the sender's claim, and `/auditor` labels it as such.

## Known issues we inherited (say so)

- NEAR AI's E2EE route has an open reply-key-substitution finding ([nearai/cloud-api#1061](https://github.com/nearai/cloud-api/issues/1061),
  cited by the Miller registry). We pin the model key from a verified report via `X-Model-Pub-Key`, which protects the request.
  The reply key travels as an unsigned header (`x-client-pub-key`), so any hop that swapped it could read each reply it
  diverted, and the card would only fail afterwards. Upstream status, checked 2026-11-04: NEAR AI's fix is "E2EE v3" (design:
  [inference-proxy#312](https://github.com/nearai/inference-proxy/issues/312)), which binds the reply key and the field label
  into the AEAD associated data of every encrypted request field, so the proxy rejects a swapped key before inference. The
  gateway and proxy sides were merged on Oct 28 2026 ([cloud-api#1296](https://github.com/nearai/cloud-api/pull/1296),
  [inference-proxy#321](https://github.com/nearai/inference-proxy/pull/321)); v1/v2 requests keep their old, unauthenticated
  format for compatibility, and we have not checked whether production runs the new code. The SDK side
  ([inference-sdk#127](https://github.com/nearai/inference-sdk/pull/127)) is still open: SDK 0.2.1, which we use, sends
  `X-Encryption-Version: 2` (with ed25519, which we always request), so the exposure above stands for us. We will move to v3
  when the SDK ships it; if that happens before Nov 14 and a live chat shows the gateway accepting v3, the demo moves to v3.
  <!-- TODO Nov 12: re-check inference-sdk#127, the SDK version and the issue state; update the date above -->
- The Verification Center and the SDK do not ship a measurement allowlist; our log is only as good as the verifiers that
  write to it. Today the log is written by our own verifier; a verifier run by someone outside the team is planned.
  <!-- TODO by Nov 12: name/nick with consent, or the honest line "all verifiers in the demo are ours" -->
