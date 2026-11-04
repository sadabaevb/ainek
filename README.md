# Ainek — a glass box for private AI agents on NEAR

> **Status:** NEAR Hackathon submission (Nov 1–14, 2026). Tracks: Privacy & Private AI, AI Security & Defense,
> Open Innovation, Social Money. Testnet only. Not audited. See [What we do not claim](#what-we-do-not-claim).
>
> **Where we are (Nov 4):** Tier 1 client, proof package, offline replay and the auditor page are in; the key-log contract is
> live on testnet with its first entry; `commit_proof`, the verifier daemon and Tier 2 (agent + policy in TDX) are in progress.

Ainek is a chat with a private model plus a proof you can check yourself. Before anything is sent, the model's signing key is
checked against a **public, append-only key log in a NEAR contract** written by independent verifiers; the request is
end-to-end encrypted to that key; the signed answer is re-verified in your browser, byte for byte; only a salted hash of the
proof goes on-chain. An agent (Tier 2) can act on the answer only within a policy evaluated inside an Intel TDX enclave.

<!-- TODO before submission: 90-second video link, hosted demo link. -->

**The problem.** Every "private AI" today says "we run in a TEE, trust us". Hardware attestation is now
commodity; what nobody ships is proof a *user* can re-check, independently of the vendor, that *this*
answer came from *this* attested key under *this* policy — without leaking the user's data to a public chain.
NEAR's own Verification Center says it "cannot recompute request/response hashes" and "does not compare
measurements to an approved allowlist"; Brave, built on NEAR AI, wrote on Oct 15 2026 that there is
"no public log of TEE keys yet". Independent monitoring rates 0 of 95 provider checks "end-to-end verified".

**What Ainek does.** Three questions, each answered by something you can re-run:

- **Is this key real?** The model's signing key must be in the public log on NEAR, written by a verifier that checked the
  Intel TDX quote and the NVIDIA GPU evidence itself. The client checks the log *before* sending and refuses otherwise
  (fail-closed). Two trusted verifiers disagreeing on one model is shown as a split view, not averaged away.
- **Did this answer come from there?** The response is signed inside the enclave over `sha256(request)` and
  `sha256(response)`. Ainek keeps the exact bytes, recomputes both hashes locally and checks the signature against the logged
  key — the step NEAR's Verification Center says it cannot do. A salted hash of the proof is committed to NEAR; the prompt,
  the answer and the salt never leave your device unless you disclose one exchange to an auditor.
- **Did the agent do only what it was allowed to?** (Tier 2, in progress) The policy — whitelist, caps, approval
  threshold — is evaluated inside an OutLayer job on Intel TDX and the decision is signed by a key generated there; the
  contract verifies that signature before moving money or waits for a human. Publicly: the decision and the policy hash,
  never the amount, the receiver or the conversation.

## Three catches (what you will see)

1. **Swapped key → nothing is sent.** `pnpm demo:tamper`: the model's signing key is not in the public log → full-screen stop.
2. **"Private" that wasn't.** A request routed through a non-attested model (gateway-signed, NEAR AI Incognito tier) → red card.
3. **Agent over its mandate.** (Tier 2) A prompt-injected "urgent transfer to a new vendor" → policy job says Deny inside TDX → contract refuses → `action_denied` with a signed reason.

## How NEAR is used

| Layer | NEAR provides (shipped) | Ainek adds |
| --- | --- | --- |
| Inference in TEE, attestation, response signatures, E2EE, JS SDK | NEAR AI Cloud, `@nearai/inference-sdk` | used as-is: the SDK's own TDX and GPU verification runs in the browser (NRAS through NEAR AI's proxy), the chat request is encrypted with `prepareE2eeChatRequest` |
| Verifying an answer | Verification Center (signature + fresh attestation; cannot recompute hashes; no allowlist) | local hash recomputation over the exact bytes; check against a **public log**, not the vendor's current answer; a card a non-technical user can read; `/verify` and `/auditor` pages; an offline replay (`pnpm demo`) that needs no key |
| Key & measurement log | none (TEE Receipts: owner-registered signer list) | append-only, hash-chained log in a NEAR contract written by **independent verifiers** (a one-command verifier image for outsiders is planned); fail-closed client with a configurable trust set and quorum; split-view detection |
| Agents in TEE | IronClaw runtime (no policies, limits or proofs); Shade Agents (deprecated Apr 2026) | (Tier 2) agent mandate + policy; decision signed inside TDX (OutLayer); contract executes; public proof without details; stop button |
| Private team payments | NEAR Business, Trezu (human signers, Confidential Intents) | an *agent* signer with a verifiable mandate — a layer on top, not a replacement |
| NEAR primitives | function-call keys, sub-accounts, NEP-141, NEP-297 events, `ed25519_verify` | the wallet adds a function-call key limited to `commit_proof`, so committing a proof never pops the wallet up again |

## Prior art in this hackathon (and what Ainek adds)

Other teams shipped adjacent pieces in the first days — we think naming them is fairer than pretending they don't exist.

| Project | What it does | What Ainek adds |
| --- | --- | --- |
| [TEE Receipts](https://github.com/tmdry4530/tee-receipts) | NEAR AI Cloud answer → receipt anchored on NEAR; signer registry with key history (**registered by the contract owner**); on-chain signature check; local hash recomputation; replay fixtures | the key log is written by **independent verifiers** anyone can run, not by one owner; the client is **fail-closed before sending**, not "prove later"; E2EE incl. tool calls; non-TEE route detection; a **salted commit** on-chain instead of a bare `sha256(prompt)` (short prompts are brute-forceable from a bare hash) |
| [PrivatePay Agent](https://github.com/Nassami1/privatepay-agent) | invoice redacted locally → sanitized text to NEAR AI TEE (attestation + signature checked) → agent may only call `try_pay`; contract enforces public daily cap, whitelist, duplicate check | the policy stays **private** and its decision is **signed inside Intel TDX** (OutLayer) before the contract executes; E2EE instead of redaction (redaction loses data and the gateway still reads the rest); proof without amount or receiver; approval flow + kill switch; public key log |
| [AgentGuard](https://github.com/CodeMasterLabs/agentguard) | agent asks, on-chain vault decides paid / held / refused; a TEE "risk oracle" screens prompt injection | the **whole policy** runs in the enclave and the contract verifies its signature; the model route itself is verified and encrypted |
| [Black box](https://github.com/tenxagent/blackbox) | hash-chained decision log of an agent, anchored on NEAR | our action proofs are bound to a TDX-signed decision and to the model proof, not only to the agent's own log |
| ~25 "spending guard" entries (Veto, Leash, Tollgate, Claw Guard, Approval Moment, …) | limits + whitelist + function-call key, injection blocked | we are not another guard: the point is a verifiable route model → policy → chain, checked by someone other than the vendor |

## Try it (do X → see Y)

Everything below runs from a clean clone. The judges' first reviewer is an AI agent following these steps, so each one says
what you should see.

```bash
git clone https://github.com/sadabaevb/ainek && cd ainek
cp .env.example .env            # fill NEARAI_API_KEY (cloud.near.ai → API Keys) — testnet needs nothing else
pnpm i
pnpm demo                        # replay mode, no API key, no network (~1 s): re-verifies the recorded attestation with the
                                 #   NEAR AI SDK's own checks (Intel TDX quote + recorded collateral, NVIDIA NRAS verdict,
                                 #   compose measurements), applies the fail-closed log rule, re-checks the two recorded signed
                                 #   exchanges (plaintext and E2EE), prints ✓/✗ per step and the proof card → "Result: VERIFIED"
pnpm demo:tamper                 # same recording, the key the client sees is swapped → "Result: REFUSED", nothing is sent
pnpm demo:live                   # needs NEARAI_API_KEY: live verification from Node (chat request pinned to the attested gateway's TLS key),
                                 #   fail-closed check against the public log, one E2EE request, signature, proof card;
                                 #   add --record to refresh the E2EE sample in docs/samples, --disclose <file> to write the auditor file of the run
pnpm -F web dev                  # needs NEARAI_API_KEY (server-side only): open http://localhost:3000, send "hello" →
                                 #   the browser verifies the TEE evidence itself (~15–30 s cold, then cached 60 min), encrypts to the
                                 #   attested model key, checks the signature and shows the proof card with ✓ rows
pnpm test                        # 73 tests in packages/proof: canonical JSON, hashing, signatures, the fail-closed rule, the
                                 #   recorded samples end to end, the on-chain entry #0 hash reproduced byte for byte
```

1. **See the log:** open `/log` → the entries the verifiers wrote for `z-ai/glm-5.3-flash`, read live from the contract (today: entry #0 by `ainek-dev-dastan.testnet` on `ainek-log-dastan.testnet`), with the trust set and quorum the client applies.
2. **See fail-closed:** `pnpm demo:tamper`, or tick "swap the key" on the chat page (or open `/?tamper=1`) → the client refuses to send: "Key not in the public log. Message not sent."
   **See the non-TEE route:** pick the Incognito model in the chat → red card "This answer went through a non-attested model" (gateway signature only; on this route your message passes through our server in plaintext, and the card says so).
3. **Re-verify a proof yourself:** "Re-verify yourself" on a card, or paste the proof / the "Disclose to auditor" file into `/verify` → hashes recomputed in your browser, signature checked, log entry re-read from the public log. "Open in Verification Center" shows the same signature on NEAR AI's own page. A proof that was not committed (no wallet at the time, or the commit failed) has a "Connect wallet and commit" (or "Retry the commit") button on its card, and `/verify?id=…` offers "Commit on NEAR" for any exchange this browser kept.
4. **Audit a disclosure:** open `/auditor` → "Use the sample file" (or a file someone sent you from "Disclose to auditor") → the commit is recomputed from salt + proof, the hashes from the disclosed ciphertext bytes, the log entry is re-read from the chain and compared with the one in the file, and the commit is looked up on NEAR once `commit_proof` is live. The page says what the file proves and what it does not.
5. **(Tier 2, not in this repo yet) Watch the agent:** `pnpm -F agent start` → in Telegram send "pay aibek.testnet 300 for October"
   → `action_executed` on nearblocks; send "pay newguy.testnet 5000" → `NeedsApproval` → tap Reject.
6. **(Tier 2) Stop button:** `pnpm demo:stop` → `DeleteKey` for the agent key → next proposal fails on-chain.

## Who sees what

The trust boundary, as stated in `docs/SPEC.md` §8 and shown on `/trust`. We say "our server cannot read", not "nobody can".

| Party | Sees | Does not see | Guarantee |
| --- | --- | --- | --- |
| Relay (our server) | ciphertext, size, timing, IP, API key | prompt, response and tool-call contents | E2EE to the model key from the verified attestation report |
| Relay on the Incognito demo route (user-chosen) | the plaintext prompt and reply | — | none: no model key exists to encrypt to; the red card says so. This route exists to show what a non-attested model looks like |
| NEAR AI gateway | ciphertext, token accounting | contents | E2EE; the gateway is attested |
| Model enclave | plaintext for the duration of inference | — | TDX + GPU attestation; retention inside the enclave is not provable by attestation |
| OutLayer job (Tier 2) | the action and the policy | the conversation | TDX; decision key generated in the TEE; what the OutLayer API gateway sees is being clarified |
| NEAR blockchain | provider keys and measurements, policy hash, decisions, salted commits, executed transfers (testnet) | the policy, the conversation, the proofs | salted commits; transfer details are hidden only with Confidential Intents (not in scope) |
| Policy job in TEE (Tier 2) | the action and the policy while computing | the conversation | WASI-P1 without network or disk, reproducible build: retention impossible by construction (does not apply to the model) |
| Auditor | one disclosed proof + its salt | the others | selective disclosure (`/auditor`) |
| Not solved | — | — | size/timing side channels; identity of the weights (the deployment is attested); operator code inside the enclave (partly: provenance via Sigstore, next steps) |

## What we do not claim

- **Verified model weights.** Attestation measures the deployment (container image digests, compose hash), not the
  weights. We say "attested deployment of model X".
- **No retention inside the model enclave.** Attestation cannot prove what NEAR AI's model enclave does with data after
  inference (its serving image is not open or reproducible). NEAR AI documents a no-store Responses API, but we use chat
  completions (needed for E2EE).
- **That nobody can read your data.** Our server cannot. The enclave can, by design, during inference.
- **Hidden settlement.** On the public testnet the executed transfer (token, amount, receiver) is visible in the
  transaction. What stays private is the conversation, the reasoning and the policy contents. Hiding settlement is possible
  with NEAR Confidential Intents and is out of scope for this submission.
- **A trust-minimized agent server.** The agent service is ordinary code we run. Its blast radius is bounded on-chain
  (function-call key, contract checks, TEE-signed policy decisions), not eliminated.
- **Compliance or certification** of any kind. We cite EU AI Act Art. 50 / GDPR Art. 22 as design targets
  ("designed for"), never as compliance.
- **Independence from hardware vendors.** The root of trust is Intel and NVIDIA. A compromised CPU/GPU breaks every
  guarantee here, as it does for every TEE product.
- **Side-channel protection.** Message size and timing are visible to our relay and to NEAR AI.
- **An audited contract.** The contract is tested with unit tests and `near-sandbox` invariants but not audited.
- **That the E2EE flag in a disclosed file is proven.** The signature covers the request and response bytes; whether those
  bytes were ciphertext is the sender's claim, and `/auditor` labels it as such.

Known issues we inherited (and say so):

- NEAR AI's E2EE route had a reply-key-substitution finding (NEAR issue 1061, Miller registry). We pin the model key from a
  verified report via `X-Model-Pub-Key`; status of the fix: <!-- TODO check before submission -->.
- The Verification Center and the SDK do not ship a measurement allowlist; our log *is* the allowlist, and it is only as
  good as the verifiers that write to it. Today the log is written by our own verifier; a verifier run by someone outside
  the team is planned (<!-- TODO by Nov 12: name/nick with consent, or the honest line "all verifiers in the demo are ours" -->).

## Architecture

```
  you (browser)                       NEAR AI Cloud                              NEAR testnet
  ┌────────────────────────┐          ┌───────────────┐    ┌──────────────────┐   ┌──────────────────────────┐
  │ verify TDX + GPU       │ E2EE     │ gateway (TEE) │    │ model enclave    │   │ contract: key log        │
  │ check key in the log ──┼──────────┼──────────────▶│───▶│ TDX + GPU, signs │   │ (hash-chained entries),  │
  │ recompute hashes       │ via our  │ attested, TLS │    │ sha256(req|resp) │   │ proof commits (salted)   │
  │ commit salted hash ────┼─ relay ─ │ pinned (Node) │    └──────────────────┘   └──────────▲───────────────┘
  └────────────────────────┘          └───────────────┘                                     │ log_key
                                                                      verifier daemon(s): attestation report →
                                                                      SDK verification → KeyEntry → contract
  Tier 2: agent (function-call key) ── OutLayer policy job (Intel TDX, WASI-P1) ── signed decision ──▶ contract executes
          or waits for a human (Telegram approval); stop button = DeleteKey + pause_agent
```

- The browser does the verification itself with the NEAR AI SDK (Intel DCAP quote verification, NVIDIA NRAS through NEAR AI's
  proxy); our relay only forwards ciphertext to the gateway with the server-side API key and never logs bodies.
- The key log is the allowlist: a key is trusted only if a trusted verifier logged it after checking the evidence; the client
  decides whom to trust (`AINEK_TRUSTED_VERIFIERS`, `AINEK_QUORUM`).
- Every exchange becomes a proof (`packages/proof`, SPEC §5): signature, hashes, log index, salt, commit. The commit is
  `sha256(salt ‖ canonical_json(proof))`; the same canonical bytes are reproduced by the Rust contract (test vectors in
  `docs/test-vectors`).
- Replay mode (`pnpm demo`) re-runs the SDK's own verification on recorded evidence with recorded Intel collateral and the
  recorded NVIDIA verdict, so a reviewer with no key sees the same checks.
- Tier 2 adds the agent and the policy job; the contract verifies the TDX-signed decision before executing (SPEC §4.3, §6).

## Metrics

<!-- TODO: table from the Nov 10–11 run: verification time, fail-closed outcomes (honest vs tampered key), false policy blocks, time-to-execute, gas per proof/action -->

## Repository

```
apps/web/            Next.js app: chat with the proof card, /verify, /log, /auditor, /trust; byte-exact relay to NEAR AI
apps/demo/           Node 24 CLI: pnpm demo (offline replay), demo:tamper, demo:live, record / check-contract scripts
packages/proof/      shared TS: proof schema, canonical JSON, hashing, signatures, fail-closed rule, chain checks, tests
contracts/ainek/     Rust near-sdk-rs contract: key log (log_key, latest_keys, entry, head), proof commits, Tier 2 ABI
jobs/policy/         Rust OutLayer WASI-P1 job: evaluate the policy, sign the decision (Tier 2)
services/verifier/   Node 24 daemon: attestation → KeyEntry → contract.log_key (in progress)
services/agent/      Node 24 service: NL → NEAR AI → OutLayer → contract (Tier 2)
docs/                SPEC.md (interfaces), CLAIMS.md, DEV-NOTES.md, samples/ (recorded evidence), test-vectors/
```

Tests: `pnpm test` (TypeScript, node:test), `pnpm typecheck`; `cargo test` in `contracts/ainek` (unit + `near-sandbox`);
`pnpm -F demo check-contract` checks the deployed contract's ABI against SPEC §4.1.

## Disclosures

- Libraries: `@nearai/inference-sdk` 0.2.1 (attestation and signature verification, E2EE), `@hot-labs/near-connect` +
  `near-connect-hooks` (wallet), `near-api-js` 7 (RPC error types), `zod` (schemas), `tweetnacl` (ed25519), `ethers`
  (sha256, EIP-191 recovery for ecdsa signatures), `@phala/dcap-qvl` and `jose` (offline replay of Intel and NVIDIA
  evidence), Next.js 16 / React 19; Rust: `near-sdk` 5, `cargo-near`, `near-sandbox` + `near-api` (tests), `serde`.
- Reference code adapted (with attribution): `near-examples/nearai-cloud-verification-example`, `nearai/nearai-cloud-verifier`
  (verification flow), `out-layer/private-dao-example` (OutLayer job + frontend pattern, Tier 2).
- AI-generated code: substantial parts were written with Claude Code and reviewed by the team; every branch went through
  `/simplify` and `/code-review` before merge; see the commit history and `docs/DEV-NOTES.md`.
- Hackathon window: all code after tag `pre-hackathon` (empty skeleton, Oct 30 2026). Diff: <!-- TODO link compare pre-hackathon...hackathon-submission -->.
- Other projects by the same people in this hackathon: none.

## Next steps

- A verifier anyone can run in one command (`docker run` / `npx ainek-verify`) and open verifier registration with a storage
  deposit, so the log stops depending on us.
- A second provider in the same log (Venice): one public log for the whole private-inference industry, not one vendor.
- Measurement allowlist governance: who decides which compose hashes are acceptable, and how a bad one is revoked.
- Image provenance via Sigstore, so "attested deployment" also says which source built it.
- Hidden settlement with NEAR Confidential Intents; the relay itself inside an attested OutLayer job.
- Integrations: Sputnik DAO and Trezu as the human approver of agent actions.

## License

MIT — see [LICENSE](./LICENSE).
