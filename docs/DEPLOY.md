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

The job is `jobs/policy` (SPEC §3.5, §6): a WASI P1 binary that reads the action from stdin, the policy and the
signing key from OutLayer secrets, and prints a signed decision.

### 1. Build and hash

```
scripts/wasm-hash.sh        # prints: <sha256>  target/wasm32-wasip1/release/ainek-policy.wasm
```

The toolchain and `Cargo.lock` are pinned and build paths are remapped, so the hash does not depend on where the repo
is checked out. The `policy-wasm` GitHub Action prints the same number for every push that touches the job. If your
number differs from the one in the table below, you are not looking at the deployed code.

### 2. Upload and deploy (OutLayer testnet)

```
outlayer upload jobs/policy/target/wasm32-wasip1/release/ainek-policy.wasm
outlayer deploy policy <url printed by upload> --target wasm32-wasip1
```

### 3. Secrets, locked to this build

```
outlayer secrets set --project <owner>/policy --build <sha256 from step 1> \
  --generate PROTECTED_ED25519:ed25519 \
  '{"POLICY_JSON": "<the policy of SPEC §6.1 as one JSON string>", "WASM_HASH": "<sha256 from step 1>"}'
```

- `PROTECTED_ED25519` is generated inside the TEE; we never see it. The job prints only its public key (`pubkey`).
- `POLICY_JSON` is the owner's policy. It is never on-chain and never in git; only `policy_hash` is public.
- `WASM_HASH` is the hash from step 1: the job cannot hash itself, so it reports this value in `wasm_hash`.
- `--build` locks all three to this exact wasm ("one build only"): another build of the job cannot read the key or
  the policy. A new build therefore means new secrets, a **new public key** and `update_policy` on the contract.

### 4. First run: get the public key

```
outlayer run <owner>/policy '<input of SPEC §6.2 as JSON>' --target wasm32-wasip1 \
  --secrets-account <owner> --secrets-profile default
```

`pubkey` in the output is `tee_pubkey` (`POLICY_TEE_PUBKEY` in `.env`) for `register_agent`; `decision.policy_hash` is
`policy_hash`. Check the run's attestation (`GET https://testnet-api.outlayer.ai/attestations/<job_id>`): its
`wasm_hash` must equal the hash from step 1.

### Deployed values

| What | Value |
|---|---|
| OutLayer project (testnet) | `ainek-dev-dastan.testnet/policy` |
| `wasm_hash` of the deployed build | not deployed yet; the spike build `882c5c5a…1c5f` is still the active one |
| policy public key (`tee_pubkey`) | not generated yet |
| `policy_hash` | not registered yet |
