# Ainek — project brief for Claude Code

Ainek ("glass" in Kyrgyz) is a glass box for private AI agents on NEAR, built for the NEAR Hackathon
(build window Nov 1–14 2026; code since Oct 19 counts; submission deadline Nov 14 23:59 UTC).

Team: Bektur builds everything with Claude Code (frontend/fullstack background: Next.js, TypeScript, Django;
no Rust and no prior blockchain work — explain Rust and NEAR decisions in plain comments and in
docs/DEV-NOTES.md). Dastan (Rust, crypto) reviews the parts Bektur cannot judge himself: contract design
and tests, the policy job's canonical bytes and signatures, key handling, and the final clean-clone run.
Both are new to NEAR. Prefer official NEAR tooling and examples over clever custom code. Every Rust
component must have `near-workspaces` / unit tests so a reviewer can trust it without reading every line.

## What we are building (one paragraph)

The user talks to an AI model that runs inside a TEE on NEAR AI Cloud. The request is end-to-end
encrypted to the model's attested key, the response comes back signed. Before sending anything, the
client checks the model's signing key against a **public, append-only key log in a NEAR contract**
written by independent verifiers, and refuses to send if the key is not logged (fail-closed).
Every response becomes a **proof** (signature + hashes we recompute locally), committed on-chain as a
salted hash only. An **agent** with a function-call key proposes money actions; the **policy** is
evaluated inside an attested OutLayer job (Rust, Intel TDX) that signs the decision with a key
generated in the TEE; the **contract** verifies that signature and executes or waits for human
approval. Publicly visible: provider keys and measurements, policy hash, decisions, salted commits.
Never on-chain: prompts, responses, policy contents.

Three questions the product answers: "Is this key real?", "Did this answer come from there?",
"Did the agent do only what it was allowed to?"

## Tiers and the checkpoint

- **Tier 1 — Ainek Verify (must ship):** contract key log + verifier daemon + fail-closed client +
  proof card with local hash recomputation + on-chain salted commit + re-verify page.
- **Tier 2 — Ainek Agent (ship if Tier 1 runs end-to-end by Nov 4 evening):** agent sub-account with
  a scoped function-call key, OutLayer policy job, `register_agent/propose_action/approve` in the
  contract, Telegram approval, stop button (`DeleteKey` + `pause_agent`).
- Do not start Tier 2 work before Tier 1 runs from a clean clone. If OutLayer does not work by
  Oct 31 evening, policy moves into the contract (public caps, salted-hash whitelist) and OutLayer
  goes to "next steps".

## Repository layout (monorepo, pnpm workspaces)

```
apps/web/            Next.js app: chat, proof card, /verify, /log, /auditor         (web)
services/verifier/   Node 24 daemon: attestation -> KeyEntry -> contract.log_key    (services)
services/agent/      Node 24 service: NL -> NEAR AI -> OutLayer -> contract         (services)
packages/proof/      Shared TS: proof schema, canonical bytes, hashing, verify fns  (shared)
contracts/ainek/     Rust near-sdk-rs contract                                       (services)
jobs/policy/         Rust OutLayer WASI job: evaluate policy, sign decision          (services)
docs/                SPEC.md, ROADMAP.md, HACKATHON-RULES.md, CLAIMS.md, LINKS.md, prompts/
```

## Stack and versions (check npm/crates before pinning; pin exact versions in lockfiles)

- `@nearai/inference-sdk` 0.2.1 (published 2026-10-29). Server code uses `@nearai/inference-sdk/node`
  on **Node 24+**; browser uses the root entry and needs a server proxy for the NVIDIA NRAS POST.
- Model: `z-ai/glm-5.3-flash` (Private TEE tier). Always pass `signingAlgo: 'ed25519'` explicitly,
  header `x-no-aliasing: true`, `Accept-Encoding: identity` when hashing bytes yourself, `e2ee: true`
  and `X-Encrypt-All-Fields: true` (tool calls encrypted). Use `/v1/chat/completions`, never
  `/v1/responses` (no E2EE, best-effort signatures).
- NEAR: `near-api-js` 7.x or `near-kit` 0.20.x for the client and services; `near-cli-rs` for ops;
  contract on `near-sdk-rs` built with `cargo-near`, tests with `near-workspaces`. Testnet by default.
- OutLayer: Rust SDK crate `outlayer = "0.2"`, WASI-P1 is enough for the policy job (stdin JSON ->
  stdout JSON, no HTTP). Output must be <= 900 bytes.
- Telegram: grammY. Frontend: Next.js (App Router), TypeScript strict.

## Working rules

1. **Clean-clone rule.** Every merged change keeps `pnpm i && pnpm demo` (and `cargo near build` for
   the contract) working from a fresh clone. Judges' first reviewer is Claude Code running the README.
2. **No secrets in git.** `.env.example` lists every variable; real values only in `.env`.
   NEAR AI API keys are workspace keys with a spend limit.
3. **Testnet first.** `ainek.testnet` contract, testnet NEP-141 demo token. Mainnet only for tiny
   optional Intents stretch, never required to run the demo.
4. **Honest claims.** Read `docs/CLAIMS.md` before writing any user-facing text. Say "attested
   deployment of model X", not "verified weights"; "our server cannot read", not "nobody can";
   "retention inside the enclave is not provable by attestation". Never write "compliant" or
   "certified".
5. **Proof naming.** Our artifacts are *proofs* (model proof, action proof). Do not call them
   "receipts" in user-facing text: NEAR Business uses "confidential receipts" for something else.
6. **Commit early, commit small, under your own GitHub account.** Commit history is evidence that
   the code was written inside the hackathon window.
7. **Conventional commits**, English. Code comments and identifiers in English; team docs may be
   in Russian.
8. **Interfaces are contracts between the two of us.** Changes to the contract ABI
   (`docs/SPEC.md` §4), the proof schema (§5) or the policy/decision schema (§6) require updating
   SPEC.md in the same PR.
9. When unsure about a NEAR API, look it up: `docs.near.org/llms.txt`, the NEAR docs MCP, and the
   installed agent skills. Do not guess method names or argument shapes.

## Tooling to install once

```
npx skills add near/agent-skills                      # near-ai-cloud, near-kit, near-api-js, near-dapp, near-smart-contracts, near-intents
claude mcp add near-docs --transport http https://docs.near.org/mcp
# OutLayer skills: https://github.com/out-layer/skills
```

Reference implementations to copy patterns from (not code wholesale; disclose anything copied):
- https://github.com/near-examples/nearai-cloud-verification-example
- https://github.com/nearai/nearai-cloud-verifier
- https://github.com/nearai/inference-sdk/blob/main/js/docs/verification-guide.md
- https://github.com/out-layer/private-dao-example (OutLayer job + TS frontend pattern)

## Commands (keep these working; wire them in root package.json)

```
pnpm i                     install everything
pnpm demo                  run Tier-1 demo end-to-end against testnet (web + verifier once)
pnpm -F web dev            Next.js dev server
pnpm -F verifier start     verifier daemon
pnpm -F agent start        agent service
cargo near build           build the contract (in contracts/ainek)
cargo test                 contract tests (near-workspaces sandbox)
```

## Definition of done for the submission (Nov 14)

Public repo with LICENSE (MIT); README in the "do X -> see Y" format with: what/why, how NEAR fits,
reproduce steps from a clean clone, the "NEAR provides / Ainek adds" table, the trust-boundary table,
"What we do not claim", libraries and AI-generated-code disclosure, link to the diff between tags
`pre-hackathon` and `hackathon-submission`, metrics, next steps. Hosted demo alive through Nov 25.
X post with a 90-second video. Form submitted once (leave the `website` field empty — it is a spam trap).
