# Session 2 (Dastan, Nov 4-5): contract v1 + verifier

> Translated from Russian on Nov 14, 2026. The original is in this file's git history.

---

Read CLAUDE.md, docs/SPEC.md §3.1, §3.2, §4.1, §4.2, §5 and docs/DEV-NOTES.md. We implement Tier 1.

**Contract `contracts/ainek` (near-sdk-rs):**
1. State: `owner`, `verifiers: UnorderedSet<AccountId>`, `entries: Vector<KeyEntry>`, the index
   `by_model: LookupMap<String, Vector<u64>>`, `commits: LookupMap<(AccountId, String), CommitInfo>`.
2. The methods from SPEC §4.1-4.2 with the exact signatures. `entry_hash = sha256(prev_hash || canonical_json(input) || verifier)`;
   `canonical_json`: keys sorted, no whitespace (the same function will appear in `packages/proof/canonical.ts`;
   write out 5 test vectors into `docs/test-vectors/canonical.json`).
3. NEP-297 events (`standard: "ainek"`, `version: "1.0.0"`): `key_logged`, `proof_committed`.
4. `near-workspaces` tests: only a verifier can `log_key`; the hash chain is unbroken; `latest_keys`
   filters by model and age; `commit_proof` works with a function-call key (create the key in the test);
   storage deposit: `commit_proof` fails without prepaid storage and works after a `storage_deposit`-like
   top-up by the owner (implement `deposit_storage()` payable).
5. Deploy to `ainek.testnet`, `register_verifier` for `v1`/`v2`. The commands go in docs/DEV-NOTES.md.

**Verifier `services/verifier` (Node 24, TS):**
1. Config: a list of models (`z-ai/glm-5.3-flash`, `deepseek-ai/DeepSeek-V4.1-Flash-1017`), an interval (15 min),
   the verifier account and key from .env, testnet RPC.
2. The loop: nonce → `client.verify(model)` with `gatewayVerification/modelVerification.policy.acceptedTcbStatuses: ['UpToDate']`
   and a `deploymentPolicy` that logs the compose hash → `KeyEntryInput` per SPEC §4.1 (the report hashes are sha256 of the
   exact bytes of the JSON) → `log_key` through near-api-js → save the full report to `data/reports/<report_hash>.json`.
3. Idempotency: if `signing_address + compose_hash` is already in `latest_keys` from this verifier within the
   last 6 hours, do not write again (we save gas), but update the local `last_seen`.
4. A `--once` mode for `pnpm demo`; logs to stdout are human-readable ("logged z-ai/glm-5.3-flash key …a3f1 at index 42, tx …").
5. A script `scripts/split-view-demo.ts`: a second instance writes an entry with a deliberately different `signing_address`,
   to demonstrate split-view detection on the client. Mark it in the README as a demo.

After that update docs/SPEC.md if the ABI changed, and write in DEV-NOTES.md what Bektur should check on the client (the contract address, the names of the view methods, the format of the events).

**Additionally (docs/FIELD.md, SPEC §3.2 and §4.1):**
- The verifier must be runnable by other people's hands: a Dockerfile (multi-stage, Node 24), the image `ghcr.io/sadabaevb/ainek-verifier`
  through a GitHub Action, and `npx ainek-verify` (a bin in `services/verifier/package.json`). The config is env only:
  `VERIFIER_ACCOUNT_ID`, `VERIFIER_PRIVATE_KEY`, `AINEK_CONTRACT`, `NEARAI_API_KEY`, `MODELS`. A README section
  "Run a verifier in 5 minutes" with three commands. Check it yourself from a clean machine/container.
- If open registration was accepted at the sync: `register_verifier` `#[payable]` with a storage deposit, `pause_verifier` for the owner,
  the event `verifier_registered` / `verifier_paused`; the view `verifiers()`; a test in near-workspaces: a foreign account registers
  and writes to the log, a client with `TRUSTED_VERIFIERS` does not count its entries.
