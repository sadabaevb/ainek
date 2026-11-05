# Ainek — a glass box for private AI agents on NEAR

> **Status:** NEAR Hackathon submission (Nov 1–14, 2026). Tracks: Privacy & Private AI, AI Security & Defense,
> Open Innovation, Social Money. Testnet only. Not audited. See [What we do not claim](#what-we-do-not-claim).
>
> **Done (Nov 4):** Tier 1 client, proof package, offline replay, auditor page; key-log contract live on testnet with entry #0.
> **In progress:** `commit_proof`, the verifier daemon, Tier 2 (agent + policy in TDX).

Ainek is a chat with a private model plus a proof you can check yourself. Before anything is sent, the model's signing key is
checked against a **public, append-only key log in a NEAR contract** that verifiers write to (today: one verifier, ours); the
request is end-to-end encrypted to that key; the signed answer is re-verified in your browser, byte for byte. A salted hash of
the proof will be committed to NEAR (`commit_proof` lands next). Tier 2 (in progress) is meant to let an agent act on the
answer only within a policy evaluated inside Intel TDX (OutLayer); if OutLayer does not work in time, the policy moves into
the contract.

<!-- TODO before submission: 90-second video link, hosted demo link. -->

**The problem.** Every "private AI" today says "we run in a TEE, trust us". Hardware attestation is now
commodity; what is missing is proof a *user* can re-check, independently of the vendor, that *this*
answer came from *this* attested key under *this* policy — without leaking the user's data to a public chain.
NEAR's own Verification Center says it "cannot recompute request/response hashes" and "does not compare
measurements to an approved allowlist"; Brave, built on NEAR AI, wrote on Oct 15 2026 that there is
"no public log of TEE keys yet". Independent monitoring rates 0 of 95 provider checks "end-to-end verified".

**What Ainek does.** Three questions, each answered by something you can re-run:

- **Is this key real?** The client sends nothing unless the model's signing key is in the public log on NEAR (fail-closed).
  A verifier logs a key only after checking the Intel TDX quote and the NVIDIA GPU evidence, and the client re-verifies the
  evidence itself as well, so the log is a second opinion, not the only one. If two trusted verifiers disagree on a model,
  you see a split view, not an average. Today: one verifier, ours; entry #0 was logged by hand from a report our code
  verified with the SDK (its NVIDIA verdict hash was not recorded); the daemon is in progress.
- **Did this answer come from there?** The enclave signs `sha256(request)` and `sha256(response)`. Ainek keeps the exact
  bytes, recomputes both hashes and checks the signature against the logged key. A salted hash of the proof will be committed
  to NEAR (until `commit_proof` is deployed the commit stays in this browser). The salt and your copy of the exchange live
  only in this browser; disclosing to an auditor hands over one proof, its salt and the ciphertext bytes, never the plaintext.
- **Did the agent do only what it was allowed to?** (Tier 2, in progress; a cap-check spike of the job exists.) The policy
  (whitelist, caps, approval threshold) is meant to run in an OutLayer job on Intel TDX that signs the decision with a key
  generated there; the contract checks that signature, then pays or waits for a human. Public: the proposed action and the
  executed transfer (testnet has no hidden settlement), the decision and the policy hash; never the policy contents or the
  conversation.

## Three catches (what you will see)

1. **Swapped key → nothing is sent.** The key is not in the public log → the client refuses: "Result: REFUSED" (`pnpm demo:tamper`) or the red card "Key not in the public log. Message not sent." (`/?tamper=1`).
2. **"Private" that wasn't.** A request routed through a non-attested model (gateway-signed, NEAR AI Incognito tier) → red card.
3. **Agent over its mandate.** (Tier 2, planned) A prompt-injected "urgent transfer to a new vendor" → policy job says Deny inside TDX → contract refuses → `action_denied` with a signed reason.

| Proof card after a verified reply (`/`) | Swapped key: nothing is sent (`/?tamper=1`) |
| --- | --- |
| ![The proof card: model, hardware, key in the public log, hashes, E2EE, on NEAR](docs/screenshots/proof-card.png) | ![Red card: key not in the public log, message not sent](docs/screenshots/refused.png) |
| The public key log (`/log`) | A disclosure checked by an auditor (`/auditor`) |
| ![The public key log page](docs/screenshots/log.png) | ![The auditor verdict card](docs/screenshots/auditor.png) |

## How NEAR is used

| Layer | NEAR provides (shipped) | Ainek adds |
| --- | --- | --- |
| Inference in TEE, attestation, response signatures, E2EE, JS SDK | NEAR AI Cloud, `@nearai/inference-sdk` | used as-is, in the browser: the SDK's TDX + GPU checks (NVIDIA's verdict fetched through NEAR AI's proxy and checked against NVIDIA's keys) and `prepareE2eeChatRequest` |
| Verifying an answer | Verification Center (signature + fresh attestation; cannot recompute hashes; no allowlist) | local hash recomputation over the exact bytes; check against a **public log**, not the vendor's current answer; a card a non-technical user can read; `/verify` and `/auditor`; an offline replay (`pnpm demo`) that needs no key |
| Key & measurement log | none (TEE Receipts: owner-registered signer list) | append-only, hash-chained log in a NEAR contract designed for independent verifiers (today: one, ours; registration is owner-gated); fail-closed client with a configurable trust set and quorum; split-view detection |
| Agents in TEE | IronClaw runtime (no policies, limits or proofs); Shade Agents (deprecated Apr 2026) | (Tier 2) agent mandate + policy; decision signed inside TDX (OutLayer); contract executes; public proof without details; stop button |
| Private team payments | NEAR Business, Trezu (human signers, Confidential Intents) | an *agent* signer with a verifiable mandate — a layer on top, not a replacement |
| NEAR primitives | function-call keys, sub-accounts, NEP-141, NEP-297 events, `ed25519_verify` | sign-in asks the wallet for a function-call key limited to `commit_proof`, so once `commit_proof` is deployed commits are signed without a popup (the one-time storage deposit still needs the wallet) |

## Prior art in this hackathon (and what Ainek adds)

Other teams shipped adjacent pieces in the first days:

| Project | What it does | What Ainek adds |
| --- | --- | --- |
| [TEE Receipts](https://github.com/tmdry4530/tee-receipts) | NEAR AI Cloud answer → receipt anchored on NEAR; signer registry with key history (**registered by the contract owner**); on-chain signature check; local hash recomputation; replay fixtures | a key log designed for **independent verifiers** (one-command verifier image planned), not one owner's list; the client is **fail-closed before sending**, not "prove later"; E2EE incl. tool calls; non-TEE route detection; a **salted commit** on-chain instead of a bare `sha256(prompt)` (short prompts are brute-forceable from a bare hash) |
| [PrivatePay Agent](https://github.com/Nassami1/privatepay-agent) | invoice redacted locally → sanitized text to NEAR AI TEE (attestation + signature checked) → agent may only call `try_pay`; contract enforces public daily cap, whitelist, duplicate check | the policy stays **private** and its decision is **signed inside Intel TDX** (OutLayer) before the contract executes; E2EE instead of redaction (redaction loses data and the gateway still reads the rest); the proof carries no amount or receiver (the testnet transfer itself is public); approval flow + stop button; public key log |
| [AgentGuard](https://github.com/CodeMasterLabs/agentguard) | agent asks, on-chain vault decides paid / held / refused; a TEE "risk oracle" screens prompt injection | the **whole policy** runs in the enclave and the contract verifies its signature; the model route itself is verified and encrypted |
| [Black box](https://github.com/tenxagent/blackbox) | hash-chained decision log of an agent, anchored on NEAR | our action proofs are bound to a TDX-signed decision and to the model proof, not only to the agent's own log |
| ~25 "spending guard" entries (Veto, Leash, Tollgate, Claw Guard, Approval Moment, …) | limits + whitelist + function-call key, injection blocked | we are not another guard: the point is a verifiable route model → policy → chain, checked by someone other than the vendor |

## Try it (do X → see Y)

Requires Node 24+ and pnpm 10 (`corepack enable`); Rust via rustup only for `contracts/ainek`. The first block needs no key
or network; `demo:live` and the chat need `NEARAI_API_KEY` (cloud.near.ai → API Keys). Each step says what you should see.

```bash
git clone https://github.com/sadabaevb/ainek && cd ainek
cp .env.example .env             # optional: NEARAI_API_KEY only for demo:live and the chat
pnpm i
pnpm demo                        # offline replay, no key, no network (~1 s): SDK checks on recorded TDX + GPU evidence,
                                 #   fail-closed rule, two signed exchanges (plaintext, E2EE) → ✓/✗ per step, proof card,
                                 #   "Result: VERIFIED"
pnpm demo:tamper                 # same recording, the key the client sees is swapped → "Result: REFUSED", nothing is sent
pnpm test                        # packages/proof: canonical JSON, hashing, signatures, the fail-closed rule, the recorded
                                 #   samples end to end, the on-chain entry #0 hash reproduced byte for byte

pnpm demo:live                   # needs NEARAI_API_KEY: the same checks live from Node (chat request pinned to the attested
                                 #   gateway's TLS key), one E2EE request, proof card; --disclose <file> writes an auditor file
pnpm -F web dev                  # keeps running, use a second terminal: http://localhost:3000. The chat needs NEARAI_API_KEY
                                 #   (server-side only); /log, /verify, /auditor and /trust work without it. Send "hello" → the
                                 #   browser verifies the TEE evidence itself (up to ~40 s cold, then cached 60 min), encrypts to
                                 #   the attested model key, checks the signature and shows the proof card. Needs a log entry
                                 #   younger than 24 h (see step 1); otherwise the red "Key not in the public log" card is the
                                 #   expected result
```

With `pnpm -F web dev` running, at `http://localhost:3000`:

1. **See the log:** `/log` → the live log for `z-ai/glm-5.3-flash` and the trust set and quorum the client applies (today: entry #0 by `ainek-dev-dastan.testnet` on `ainek-log-dastan.testnet`). The client trusts entries no older than 24 h: when there is no fresh entry `/log` says so ("No entry younger than 24 hours"), and the chat then refuses by design. Until the verifier daemon runs, the log is refreshed by hand.
2. **See fail-closed:** `pnpm demo:tamper`, or tick "swap the key" in the chat (`/?tamper=1`) → "Key not in the public log. Message not sent."
3. **See the non-TEE route:** pick the Incognito model in the chat → red card "This answer went through a non-attested model" (gateway signature only; our server sees this route in plaintext, and the card says so).
4. **Re-verify a proof yourself:** "Re-verify yourself" on a card, or paste `docs/samples/disclosure.sample.json` (or a card's "Disclose to auditor" file) into `/verify` → Verify → hashes recomputed in your browser, signature checked, log entry re-read from the public log. "NEAR AI Verification Center" shows the same signature on NEAR AI's own page. Uncommitted proofs get a commit button on the card and on `/verify?id=…` (needs a testnet wallet; until `commit_proof` is deployed the click ends in "commit_proof is not in the contract yet").
5. **Audit a disclosure:** `/auditor` → "Use the sample file" → Check → the commit recomputed from salt + proof, the hashes from the disclosed bytes, the log entry re-read from the chain and compared with the file's; the "On NEAR" row says the sample was never committed, which is expected until `commit_proof` is live. The page says what the file does and does not prove. The sample embeds the chain's entry #0; after a contract redeploy it must be regenerated (`pnpm demo:live --disclose docs/samples/disclosure.sample.json`), or steps 4–5 end in "differs from the embedded entry".

**Tier 2 flow (not in the repo yet; only the cap-check spike under `jobs/policy`):** Telegram "pay aibek.testnet 300 for October" → `action_executed`; "pay newguy.testnet 5000" (new vendor) → Deny; "pay aibek.testnet 3000" (over the threshold) → `NeedsApproval` → Reject; stop button: `DeleteKey` + `pause_agent` → the next proposal fails on-chain.

## Who sees what

The trust boundary from `docs/SPEC.md` §8, also shown on `/trust`. We say "our server cannot read", not "nobody can".

| Party | Sees | Does not see | Guarantee |
| --- | --- | --- | --- |
| Relay (our server) | ciphertext, size, timing, IP, API key; model id, message count and roles, token usage, completion ids | prompt, response and tool-call contents | E2EE to the model key from the verified attestation report |
| Relay on the Incognito demo route (user-chosen) | the plaintext prompt and reply | — | none (no model key to encrypt to); the red card says so |
| NEAR AI gateway and proxy | ciphertext, token accounting; the browser's IP during collateral and NRAS calls | contents | E2EE; the gateway is attested; the proxy cannot forge the NVIDIA verdict (checked against NVIDIA's keys) |
| NVIDIA key server | the browser's IP and timing of each cold verification (the SDK fetches NVIDIA's public keys directly) | anything about the exchange | public keys only; the NRAS verdict itself goes through NEAR AI's proxy |
| Model enclave | plaintext for the duration of inference | — | TDX + GPU attestation; retention inside the enclave is not provable by attestation |
| NEAR blockchain | provider keys and measurements, salted commits with the committing account and time, executed transfers (testnet); (Tier 2) proposed actions, the OutLayer job input, decisions, the policy hash | the policy contents, the conversation, the proofs | salted commits; transfer details are hidden only with Confidential Intents (out of scope) |
| OutLayer policy job (Tier 2, planned) | the action and the policy, while computing | the conversation | TDX, decision key generated in the TEE; a WASI-P1 module with no network or disk and a reproducible build cannot retain its input (the model enclave can; this says nothing about the OutLayer worker, and the action input is public on-chain); what the OutLayer API gateway sees is still open |
| Auditor | one disclosed proof, its salt and the ciphertext bytes | the plaintext, the other exchanges | selective disclosure (`/auditor`) |

The "does not see" column holds for requests. For replies it holds only while no hop swapped the reply key: until the SDK
ships E2EE v3, a relay that did so could read the replies it diverted, and the card would only fail afterwards (see
"Known issues we inherited" below).

## What we do not claim

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

Known issues we inherited (and say so):

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

## Architecture

```
browser ── E2EE via our relay ──▶ NEAR AI gateway (TEE) ──▶ model enclave (TDX + GPU): signs sha256(request), sha256(response)
browser ── reads the key log; will commit a salted hash ──▶ NEAR contract (ainek-log-dastan.testnet)
verifier(s) ── attestation report → SDK checks → KeyEntry ── log_key ──▶ NEAR contract        (daemon in progress)
agent (function-call key) ──▶ OutLayer policy job (TDX) ── signed decision ──▶ contract: execute, or wait for Telegram approval
stop button: DeleteKey + pause_agent                                                           (Tier 2, planned)
```

- The browser does the verification itself with the NEAR AI SDK (Intel DCAP quote verification; the NVIDIA verdict fetched
  through NEAR AI's proxy and checked against NVIDIA's keys). On the attested route our relay forwards only ciphertext; on
  the user-chosen Incognito route, plaintext, and the card says so. The relay code logs no bodies; on the hosted demo that is
  taken on trust.
- The key log is a key allowlist: the client sends only to a key a trusted verifier logged (what the verifier checked is the
  verifier's claim, which is why the client re-verifies the evidence itself). The client decides whom to trust
  (`AINEK_TRUSTED_VERIFIERS`, `AINEK_QUORUM`).
- Every attested exchange becomes a proof (`packages/proof`, SPEC §5): signature, hashes, log index, salt, commit. The commit
  is `sha256(salt ‖ canonical_json(proof without salt/commit/commitTx))`, computed in the browser; the contract will store
  only the commit. The Rust contract uses the same canonical JSON for the log's `entry_hash` (shared test vectors in
  `docs/test-vectors`).
- Replay mode (`pnpm demo`) re-runs the SDK's own verification on recorded evidence: recorded Intel collateral, the recorded
  NVIDIA verdict checked against a recorded copy of NVIDIA's keys. Freshness is not replayed, and the demo says so.
- Tier 2 interfaces: SPEC §4.3 and §6.

## Metrics

<!-- TODO: table from the Nov 10–11 run: verification time, fail-closed outcomes (honest vs tampered key), false policy blocks, time-to-execute, gas per proof/action -->

## Repository

```
apps/web/            Next.js app: chat with the proof card, /verify, /log, /auditor, /trust; byte-exact relay to NEAR AI
apps/demo/           Node 24 CLI: pnpm demo (offline replay), demo:tamper, demo:live, record / check-contract scripts
packages/proof/      shared TS: proof schema, canonical JSON, hashing, signatures, fail-closed rule, chain checks, tests
contracts/ainek/     Rust near-sdk-rs contract: key log (log_key, latest_keys, entry, entries_since, head);
                     proof commits (SPEC §4.2) and Tier 2 (§4.3) next
jobs/policy/         Rust OutLayer WASI-P1 job: spike, cap check only, no signature yet (Tier 2)
services/verifier/   placeholder: the attestation → KeyEntry → log_key daemon is in progress
services/agent/      placeholder: NL → NEAR AI → OutLayer → contract (Tier 2, not started)
docs/                SPEC.md (interfaces), CLAIMS.md, DEV-NOTES.md, samples/ (recorded evidence), test-vectors/
```

Tests: `pnpm test` and `pnpm typecheck` (TypeScript, node:test); `cargo test` in `contracts/ainek` (unit tests + a
`near-sandbox` integration test); `pnpm -F demo check-contract` checks the deployed contract's ABI against SPEC §4.1.

## Disclosures

- Libraries: `@nearai/inference-sdk` 0.2.1 (attestation and signature verification, E2EE), `@hot-labs/near-connect` +
  `near-connect-hooks` (wallet), `near-api-js` 7 (RPC error types), `zod` (schemas), `tweetnacl` (ed25519), `ethers`
  (sha256, EIP-191 recovery for ecdsa signatures), `@phala/dcap-qvl` and `jose` (offline replay of Intel and NVIDIA
  evidence), Next.js 16 / React 19, the Inter font self-hosted under `apps/web/public/fonts` (SIL OFL 1.1, licence
  alongside); Rust: `near-sdk` 5, `cargo-near`, `near-sandbox` + `near-api` (tests), `serde`.
- Reference material followed (no code copied so far; a file that copies code will say so): the `@nearai/inference-sdk`
  verification guide, `near-examples/nearai-cloud-verification-example`, `nearai/nearai-cloud-verifier`,
  `out-layer/private-dao-example` (Tier 2).
- AI-generated code: substantial parts were written with Claude Code and reviewed by the team; the TypeScript branches went
  through `/simplify` and `/code-review` before merge; see the commit history and `docs/DEV-NOTES.md`.
- Hackathon window: all code after tag `pre-hackathon` (project kit: docs, spec, prompts, no code; Nov 2 2026). Diff:
  <!-- TODO link compare pre-hackathon...hackathon-submission -->
- Other projects by the same people in this hackathon: none.

## Next steps

- A verifier anyone can run in one command (`docker run` / `npx ainek-verify`) and open verifier registration with a storage
  deposit, so the log stops depending on us.
- A revoke entry in the log and a governed allowlist of compose hashes, so the card can compare measurements, not only show them.
- A second provider in the same log (Venice): one public log for the whole private-inference industry, not one vendor.
- Image provenance via Sigstore, so "attested deployment" also says which source built it.
- Hidden settlement with NEAR Confidential Intents; the relay itself inside an attested OutLayer job.
- Integrations: Sputnik DAO and Trezu as the human approver of agent actions.

## License

MIT — see [LICENSE](./LICENSE).
