# Deploying Ainek

Two things get deployed: the web demo (this section, Bektur) and the Tier 2 policy job on OutLayer (the last section,
Dastan). ROADMAP and the Tier 2 prompt point here for both.

## Web demo on Vercel

The web app is a plain Next.js 16 app; `pnpm -F web build` passes from a clean clone. The demo must stay up through
Nov 25.

1. Vercel → Add New Project → import `sadabaevb/ainek`. Framework preset: Next.js (detected).
2. **Root Directory:** `apps/web`. Keep "Include source files outside of the Root Directory" on: the app imports
   `packages/proof` (workspace package) and `docs/samples/disclosure.sample.json`.
3. **Node.js version:** 24 (Project Settings → General; check the dashboard offers it). Install command stays the
   default (`pnpm install` at the workspace root, detected from `pnpm-lock.yaml`).
4. **Environment variables** (Production and Preview), values from the root `.env`:
   `NEARAI_API_KEY` (a workspace key with a spend limit), `NEARAI_BASE_URL`, `NEARAI_MODEL`, `NEARAI_INCOGNITO_MODEL`,
   `NEAR_NETWORK=testnet`, `AINEK_CONTRACT`, `AINEK_LOG_SOURCE=contract`, `AINEK_TRUSTED_VERIFIERS`,
   `AINEK_QUORUM`, `AINEK_ACCEPTED_TCB`; `NEAR_RPC_URL` only to override the FastNear default (delete it from the project if an earlier `.env` put it there). Nothing else: the web app never reads the verifier, agent, Telegram or
   OutLayer secrets. The tamper switch is a client-side demo control (`?tamper=1` or the checkbox) and stays
   available on the hosted demo on purpose: it is the demo of the refusal.
5. Deploy, then check: `/log` shows the live log; the chat verifies (or refuses, if the 24-hour log window is empty:
   that is the fail-closed rule, see `/log`); `/auditor` → "Use the sample file" → Check → "checks out".
6. Put the URL into the README (the "hosted demo link" TODO) and into the submission form.

Settings names and defaults above are Vercel's as of Nov 2026; confirm them in the dashboard when creating the project.

## What runs where

- The browser does the verification, the encryption and the hashing; the server only relays the four NEAR AI paths
  (`apps/web/app/api/nearai/[...path]/route.ts`), as a serverless route handler. No database, no cron.
- `instrumentation-node.ts` loads the root `.env` only when the file exists; on Vercel the variables come from the
  dashboard and the loader does nothing.
- Spend: every chat message is one NEAR AI completion on the workspace key. Set the limit in the NEAR AI console
  before publishing the link.

## Local production check of the web app

`pnpm -F web build && pnpm -F web start` serves the production build on http://localhost:3000 with the same root `.env`.

## Policy job on OutLayer (Tier 2, Dastan)

Recorded here once the job is deployed, because `register_agent` and the README need them: the project name on
OutLayer testnet, the `wasm_hash` of the reproducible build, the policy public key (`POLICY_TEE_PUBKEY`, derived from
the `PROTECTED_SIGNING_KEY:ed25519` secret inside the TEE) and the command that reproduces the hash from the repo.
Until then see `docs/spike-outlayer/` and the spike B section of `docs/DEV-NOTES.md`.
