# Ainek: plan (Nov 2–14, 2026), two people full time

> Translated from Russian on Nov 14, 2026. The original is in this file's git history.

Dastan: everything on the chain and in the TEE (contract, verifier, policy job, agent service). Bektur: everything a
person sees (client with E2EE and verification, proof card, pages, the video) + `packages/proof` (shared code).
The join is two interfaces from SPEC.md: the contract ABI (§4) and the proof schema (§5); they change only with an edit to SPEC.

Rules: we do not start Tier 2 until Tier 1 runs from a clean clone (checkpoint: Nov 6, evening).
Feature freeze: Nov 12, evening, hard. Intents, Chain Signatures, passkeys: we do not do them. The only allowed stretch is
an adapter for a second provider (Venice) in the verifier on Nov 10–11, only if everything else is green.
Every day at 10:00, a 10-minute sync: what was done, what blocks, what changed in SPEC.

Order of dropping features when time runs short: Telegram approval (a button in the UI) → auditor page (CLI) →
OutLayer policy (into the contract) → the whole agent. Never drop: the contract log + fail-closed + proof.

## Nov 2 (evening): preparation

Both
- [ ] Repo: Dastan accepted the invite and cloned it; both read CLAUDE.md, SPEC.md, HACKATHON-RULES.md
- [ ] cloud.near.ai account (one per team), $20 credits, two workspace API keys with a spend limit (one per person)
- [ ] `npx skills add near/agent-skills`, the docs MCP in Claude Code for both

Dastan
- [ ] Rust toolchain, target `wasm32-unknown-unknown`, `cargo-near`, `near-cli-rs`; OutLayer skills (`out-layer/skills`)
- [ ] NEAR testnet accounts via near-cli-rs: `owner`, `ainek`, `v1`, `v2`, `agent`, `token` (faucet); keys go to a password manager, not to the repo

Bektur
- [ ] Session 1a (`docs/prompts/day1-bektur.md`): the attestation report and the signature with our own eyes, the `apps/web` skeleton, the first E2EE request

## Nov 3: spikes and interfaces

- [ ] 10:00 sync (30 min): fix SPEC §4 (ABI) and §5 (proof), after this they are frozen until the checkpoint; decide item 2 from docs/FIELD.md (open verifier registration) and write it in DECISIONS.md
- Dastan: session 1b (`day1-rust-spikes.md`): hello contract deployed and called; OutLayer spike with `attestation_url`,
  the secret and `PROTECTED_ED25519`, what the gateway sees → **GO / NO-GO in DECISIONS.md by the evening**
- Bektur: NEAR quickstart (wallet login, view/change call); `packages/proof`: schemas, `canonicalJson`, test vectors;
  a relay that does not log bodies

## Nov 4–5: Tier 1

- Dastan: session 2 (`tier1-contract-and-verifier.md`): contract v1 (`log_key` with a hash chain, `commit_proof`, view methods,
  NEP-297, `near-workspaces` tests), deploy to `ainek.testnet`, `register_verifier` for `v1`/`v2`; verifier daemon,
  two instances, saving the reports, `--once`, `split-view-demo`
- Bektur: session 3 (`tier1-client.md`): verification in the browser (dcap-qvl + NRAS through a proxy; if the polyfills eat
  more than half a day, verification on the server through the Node SDK, in the browser the signature + the log, honestly in the README), fail-closed
  check against the log, E2EE through the relay, storing the raw bytes, proof + `commit_proof` with the FC key; **detector of a non-TEE route**
  (`signature_kind`, red card); **replay mode** `pnpm demo` on recorded reports without keys (SPEC §3.8–3.9)

## Nov 6: checkpoint

- [ ] Morning: integration client ↔ contract ↔ verifier on the real testnet
- [ ] Evening: `git clone && pnpm i && pnpm demo` on a clean machine following the README without hints: the verifier writes the key,
  the client verifies, sends, gets a proof, commits, the re-check works
- [ ] Decision in DECISIONS.md: Tier 2, yes / no. If no, Nov 7–11 go to polishing Tier 1 and the submission to Privacy + Open

## Nov 7–9: Tier 2

- Dastan: session 4 (`tier2-policy-agent.md`): policy job (Rust, WASI-P1, canonical bytes, signing the decision, tests, deploy,
  `wasm_hash` + `pubkey` in DEPLOY.md) → contract v2 (`register_agent / propose_action / approve / reject / pause_agent`,
  `ed25519_verify`, cross-contract `ft_transfer`, invariants) → NEP-141 demo token + registration of recipients;
  **reproducible build of the policy job** (`rust-toolchain.toml`, `Cargo.lock`, CI prints `wasm_hash`; matches the
  attestation): the basis of the line "retention is impossible by construction" (SPEC §3.5)
- Dastan (in the same session, before the policy job): the verifier packaged for other people's hands: `docker run ghcr.io/sadabaevb/ainek-verifier`
  and/or `npx ainek-verify --account v3.ainek.testnet`, the README section "Run a verifier in 5 minutes"; we do not
  do open registration (DECISIONS, Nov 7)
- Both: find a person from outside the team who will run `v3` (an acquaintance developer, a member of the hackathon Discord); the goal is
  that by Nov 10 the log has their entries (docs/FIELD.md item 1)
- Bektur: proof card for a non-technical person, `/verify` with local recomputation + a link to the Verification Center, `/log`
  with a split-view indicator, `/trust` (the SPEC §8 table), `/auditor`; then the agent service in TS: structured output
  from NEAR AI, calling OutLayer over HTTPS, a grammY bot with Approve/Reject buttons (the contract and ABI come from Dastan);
  the injection scenario "urgently transfer 5000 to a new supplier" → Deny / NeedsApproval (SPEC §7.3)

## Nov 10–11: integration, metrics, run

- [ ] Agent end-to-end: text → model → policy → `propose_action` → execution / approval / refusal; action proof + commit
- [ ] Stop button: `DeleteKey` + `pause_agent`, the next attempt fails on-chain: a screenshot for the README
- [ ] 50 test requests: verification time, fail-closed refusals (honest / swapped key), false blocks by the policy
  (Tier 1 is done, see docs/METRICS.md; false blocks by the policy have not been counted yet)
- [ ] Split-view demo: a screenshot
- [ ] The log has entries from `v3`, run by someone other than us: a screenshot + name/nickname in the README (with their consent); if it did not work out,
  an honest line in CLAIMS ("all verifiers in the demo are ours")
- [ ] A run from a clean clone by a person from outside the team, following the README, in replay mode, without keys
- [ ] Stretch, only on a green status (not started as of Nov 10; proposed to move to "next steps", waiting for
  Dastan's confirmation, DECISIONS Nov 10): Dastan: the Venice adapter in the verifier (a second provider in the log);
  Bektur: `@ainek/proof` as a publishable package + an embed link to the card for other people's apps

## Nov 12–13: freeze and packaging

- [ ] Freeze on the evening of the 12th. Hosting: Vercel (web, since Nov 8), Hetzner (verifier); the agent runs only for the time of the demo (DEPLOY); the demo lives until Nov 25
- [ ] README by the skeleton: "do X, see Y", the "NEAR provides / Ainek adds" table, the trust table, CLAIMS, disclosures,
  metrics, the diff link `pre-hackathon...hackathon-submission`
- [ ] A 90-second video in English (docs/DEMO-SCRIPT.md): recorded by whoever has the better English; a post on X
- [ ] Tag `hackathon-submission`; check the history for secrets

## Nov 14: submission (by 23:59 UTC = 05:59 on Nov 15 Bishkek time)

- [ ] Repo public; form: tracks privacy, security, open (social and realworld were dropped on Nov 10; DECISIONS), size "2 - 4", `website` empty,
  keep the `requestId`; response 201: a screenshot in docs/
