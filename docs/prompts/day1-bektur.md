# Session 1a (Bektur, Nov 2-3): the NEAR AI SDK first-hand + the web skeleton

> Translated from Russian on Nov 14, 2026. The original is in this file's git history.

Open Claude Code in the repo root and paste this in full.

---

Read CLAUDE.md and docs/SPEC.md. I am Bektur, responsible for apps/web (Next.js), client-side verification, the proof
card, the pages /verify, /log, /auditor, /trust and the relay. I have no blockchain development experience; NEAR is new to me. The contract and the verifier are built by Dastan (docs/prompts/day1-rust-spikes.md, tier1-contract-and-verifier.md).
Explain what you do in short comments in the code and in docs/DEV-NOTES.md.

The task of the session is three steps, no production UI:

**Step 1: see the attestation and the signature.**
1. Install the skill `near-ai-cloud` (`npx skills add near/agent-skills --skill near-ai-cloud`) and read
   https://docs.near.ai/cloud/verification/index.md, …/cloud-api/response-signatures.md,
   …/guides/e2ee-chat-completions.md and https://github.com/nearai/inference-sdk/blob/main/js/docs/verification-guide.md.
2. Clone https://github.com/near-examples/nearai-cloud-verification-example into tmp/, run it on Node 24 with
   my `NEARAI_API_KEY` (in .env, not in the code). Show me: the attestation report (the fields `signing_address`, `app_compose`,
   `tcb_status`, whether `nvidia_payload` is present), the model's response and `GET /v1/signature/{id}` with `text` and `signature`.
   Save an anonymised example of the report to docs/samples/attestation-report.json (without keys).

**Step 2: the first E2EE request through the SDK.**
1. In `apps/web` create a Next.js app (App Router, TypeScript strict, pnpm). Add `@nearai/inference-sdk` 0.2.1.
2. An API route `app/api/relay/route.ts`: on the server (`@nearai/inference-sdk/node`) create an `InferenceClient` with
   `e2ee: true`, `signingAlgo: 'ed25519'`, model `z-ai/glm-5.3-flash`; `await client.verify(model)`; one
   `chat.completions.create`; `await client.verifyResponse(id)`; return `{ completionId, signedText,
   signature, signingAddress, signatureKind, verified: true/false }` in the response. Header `x-no-aliasing: true`.
3. A page `/` with one input field and the output of the response + the raw verification result. No design yet.
4. Write down in docs/DEV-NOTES.md: what exactly the SDK verified on the server, how long the verification took, which
   polyfills would be needed in the browser (read the verification-guide about the browser entry and the NRAS proxy).

**Step 3: NEAR quickstart.**
1. Go through https://docs.near.org/web3-apps/quickstart.md with the skill `near-dapp`: wallet login (testnet),
   one view call to any existing contract, one change call. In `apps/web`, a page `/log`
   with a "Connect wallet" button and the output of the view call. Dastan's contract is not ready yet: use
   `guest-book.testnet` or another example from the docs as a stand-in.
2. Explain to me in DEV-NOTES.md in three paragraphs: how the wallet adds a function-call key at login,
   how a view call differs from a change call, and what the transaction looks like on testnet.nearblocks.io.

Rules: commit in small commits; secrets only in .env; do not install dependencies without an exact version being specified.
