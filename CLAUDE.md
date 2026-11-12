# Ainek — project brief for Claude Code

Ainek ("glass" in Kyrgyz) is a glass box for private AI agents on NEAR, built for the NEAR Hackathon
(build window Nov 1–14 2026; code since Oct 19 counts; submission deadline Nov 14 23:59 UTC).

Team: Dastan (Rust, crypto) builds the contract, the verifier daemon, the OutLayer policy job and the
contract-facing parts of the agent; Bektur (frontend/fullstack: Next.js, TypeScript) builds the client, proof card,
pages, `packages/proof` and the agent's Telegram/LLM side. Both work full-time on this until Nov 14 and both are new
to NEAR, so explain NEAR-specific decisions in plain comments and in docs/DEV-NOTES.md. Prefer official NEAR tooling
and examples over clever custom code. Every Rust component ships with unit tests plus a sandbox test (`near-sandbox` + `near-api`, as the official `cargo-near` template generates).

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
- **Tier 2 — Ainek Agent (ship if Tier 1 runs end-to-end by Nov 6 evening):** agent sub-account with
  a scoped function-call key, OutLayer policy job, `register_agent/propose_action/approve` in the
  contract, Telegram approval, stop button (`DeleteKey` + `pause_agent`).
- Do not start Tier 2 work before Tier 1 runs from a clean clone. If OutLayer does not work by
  Nov 3 evening, policy moves into the contract (public caps, salted-hash whitelist) and OutLayer
  goes to "next steps".

## Repository layout (monorepo, pnpm workspaces)

```
apps/web/            Next.js app: chat, proof card, /verify, /log, /auditor, /agent (web)
apps/demo/           Node 24 CLI: `pnpm demo` replay / `demo:tamper` on docs/samples, offline  (web)
services/verifier/   Node 24 daemon: attestation -> KeyEntry -> contract.log_key    (services)
services/agent/      Node 24 service: NL -> NEAR AI -> OutLayer -> contract         (services)
packages/proof/      Shared TS: proof schema, canonical bytes, hashing, verify fns  (shared)
packages/tier1-node/ Shared TS, Node only: the Tier-1 sequence for demo:live/attest/metrics and the agent   (shared)
contracts/ainek/     Rust near-sdk-rs contract                                       (services)
contracts/demo-token/ Plain NEP-141 token (near-contract-standards) for the Tier 2 demo and sandbox tests  (services)
jobs/policy/         Rust OutLayer WASI job: evaluate policy, sign decision          (services)
docs/                SPEC.md, ROADMAP.md, HACKATHON-RULES.md, CLAIMS.md, LINKS.md, prompts/
```

## Stack and versions (check npm/crates before pinning; pin exact versions in lockfiles)

- `@nearai/inference-sdk` 0.3.0 (published 2026-11-08; E2EE v3). Server code uses `@nearai/inference-sdk/node`
  on **Node 24+** and calls NVIDIA NRAS and Intel PCS (`api.trustedservices.intel.com`) directly; the browser uses the root
  entry, which reaches them through NEAR AI's own proxies. Our relay only forwards the four SDK paths.
- Model: `z-ai/glm-5.3-flash` (Private TEE tier). Always pass `signingAlgo: 'ed25519'` explicitly,
  header `x-no-aliasing: true`, `Accept-Encoding: identity` when hashing bytes yourself, `e2ee: true`
  and `X-Encrypt-All-Fields: true` (tool calls encrypted). Use `/v1/chat/completions`, never
  `/v1/responses` (no E2EE, best-effort signatures).
- NEAR: `near-api-js` 7.x or `near-kit` 0.20.x for the client and services; `near-cli-rs` for ops;
  contract on `near-sdk-rs` built with `cargo-near`, sandbox tests with `near-sandbox` + `near-api`. Testnet by default.
- OutLayer: Rust SDK crate `outlayer = "0.2"`, WASI-P1 is enough for the policy job (stdin JSON ->
  stdout JSON, no HTTP). Output must be <= 900 bytes.
- Telegram: grammY. Frontend: Next.js (App Router), TypeScript strict.

## Working rules

1. **Clean-clone rule.** Every merged change keeps `pnpm i && pnpm demo` (and `cargo near build non-reproducible-wasm` for
   the contract) working from a fresh clone. Judges' first reviewer is Claude Code running the README.
2. **No secrets in git.** `.env.example` lists every variable; real values only in `.env`.
   NEAR AI API keys are workspace keys with a spend limit.
3. **Testnet first.** The contract in `AINEK_CONTRACT` (`.env.example`, docs/DEPLOY.md), testnet NEP-141 demo token. Mainnet only for tiny
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

## Tooling (already in the repo — nothing to install)

NEAR agent skills are vendored in `.agents/skills/` (canonical, read by Codex; `skills-lock.json` pins them) with
symlinks in `.claude/skills/` for Claude Code. The NEAR docs MCP server is in `.mcp.json` (approve it once when
Claude Code asks). Only to refresh the skills: `npx skills update` (or `npx skills add near/agent-skills`).

```
# OutLayer skills, not vendored yet: https://github.com/out-layer/skills
```

Reference implementations to copy patterns from (not code wholesale; disclose anything copied):
- https://github.com/near-examples/nearai-cloud-verification-example
- https://github.com/nearai/nearai-cloud-verifier
- https://github.com/nearai/inference-sdk/blob/main/js/docs/verification-guide.md
- https://github.com/out-layer/private-dao-example (OutLayer job + TS frontend pattern)

## Commands (keep these working; wire them in root package.json)

```
pnpm i                                   install everything
pnpm demo                                offline replay of the Tier-1 checks on recorded evidence (no key, no network)
pnpm demo:live                           the same checks live against NEAR AI and testnet (needs NEARAI_API_KEY)
pnpm demo:reply-key                      negative control: a hop swaps the reply key in transit and must get no reply (needs NEARAI_API_KEY)
pnpm demo:attest                         demo:live up to the send: evidence verified, key looked up in the log (no key, needs network)
pnpm -F web dev                          Next.js dev server
pnpm -F verifier start                   verifier daemon
pnpm -F agent start                      agent service
cargo near build non-reproducible-wasm   build the contract (in contracts/ainek)
cargo test                               contract tests (unit + near-sandbox)
```

## Definition of done for the submission (Nov 14)

Public repo with LICENSE (MIT); README in the "do X -> see Y" format with: what/why, how NEAR fits,
reproduce steps from a clean clone, the "NEAR provides / Ainek adds" table, the trust-boundary table,
"What we do not claim", libraries and AI-generated-code disclosure, link to the diff between tags
`pre-hackathon` and `hackathon-submission`, metrics, next steps. Hosted demo alive through Nov 25.
X post with a 90-second video. Form submitted once (leave the `website` field empty — it is a spam trap).
