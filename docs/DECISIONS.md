# Decisions log

| Date | Decision | Why | Who |
| --- | --- | --- | --- |
| 2026-10-30 | Two tiers; Tier 2 only after Tier 1 runs from a clean clone by Nov 3 evening | execution risk: both new to NEAR, SDK released Oct 29 | both |
| 2026-10-30 | Demo framing = AI treasurer with a verifiable mandate, not "private payroll" | NEAR Business (Oct 21) ships private payroll with human signers | both |
| 2026-10-30 | Our artifacts are called "proofs", not "receipts" | NEAR Business uses "confidential receipts" for settlement | both |
| 2026-10-31 | Policy in TEE via OutLayer: GO / NO-GO — <fill after spike> | <facts from docs/spike-outlayer/> | Dastan |
| 2026-10-31 | Bektur builds the whole project with Claude Code; Dastan reviews at 5 checkpoints (ROADMAP.md); Rust plan unchanged | Dastan does his own separate submission | both |
| 2026-10-31 | Checkpoint moved to Nov 4 evening (sequential, not parallel work) | one builder | Bektur |
| 2026-11-02 | Both work full-time Nov 3–14 as one team; Dastan: chain + TEE, Bektur: client + proof + agent TS side; checkpoint Nov 6, freeze Nov 12; no stretch features | 12 days × 2 people makes both tiers feasible; stretch would eat polish days | both |
| 2026-11-02 | Demo and README framed as "three catches" (swapped key, false privacy, agent over mandate), not as green badges | trust products are remembered by what they catch | both |
| 2026-11-02 | Replay mode `pnpm demo` without API keys is mandatory in Tier 1 | the first reviewer is Claude Code without our keys | both |
| 2026-11-02 | Claim "retention impossible by construction" only for the WASI-P1 policy job with reproducible build; never for the model | proof of inability to retain ≠ proof of deletion | both |
| 2026-11-02 | Second provider (Venice) in the key log is the only allowed stretch, Nov 10–11, green status required | turns "our log" into "CT for the industry" | both |
| 2026-11-02 | Field scan (58 entries): TEE Receipts ≈ our Tier 1 with owner-only registry; PrivatePay Agent ≈ our Tier 2 with public caps; ~25 spending guards. Direction unchanged; positioning = "verified by someone other than the vendor", never "a guard" | docs/FIELD.md | both |
| 2026-11-02 | An external verifier (`v3`, run by someone outside the team) is mandatory, not a stretch; verifier ships as one-command image | without it our log differs from an owner registry only in words | both |
| 2026-11-03 | Open verifier registration (storage deposit, client-side trust set + quorum): <decide at sync> | SPEC §4.1 proposal | Dastan |
| 2026-11-03 | OutLayer GO / NO-GO deferred to Nov 4 morning: job built, uploaded and deployed on testnet, but both runs failed with `wasm_url could not be fetched` — FastFS testnet gateway returns 502 for everything. Facts so far favour GO: secrets and TEE-generated ed25519 keys reach a WASI-P1 job as env vars, output ≤ 900 B, NEAR-mode payment works without a payment key; job input is public on-chain (policy must stay in secrets) | docs/DEV-NOTES.md 2026-11-03, docs/spike-outlayer/ | Dastan |
| 2026-11-04 | **OutLayer: GO.** Policy job (WASI P1, 134 KB) прошёл на testnet в режиме NEAR: Allow и Deny, ~0.001 NEAR за прогон, 192 мс. Аттестация доступна через `GET testnet-api.outlayer.ai/attestations/<job_id>`; мы независимо сверили `input_hash`, `output_hash`, `wasm_hash` и Task Hash с REPORTDATA TDX-квоты. Политика живёт только в секретах (вход публичен в `execution_requested`). `PROTECTED_*:ed25519` приходит в env как `ed25519:<base58 seed>`, job подписал, подпись проверена офлайн, `secrets_ref` входит в Task Hash квоты. Все четыре вопроса спайка закрыты | docs/DEV-NOTES.md 2026-11-04, docs/spike-outlayer/run{3,4}-* | Dastan |
