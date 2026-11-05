# Ainek verifier

Re-attests NEAR AI models with a fresh nonce and appends their TEE signing keys to the public key log
contract (SPEC §3.2, §4.1). Anyone can run one; the client decides which verifiers it trusts
(`AINEK_TRUSTED_VERIFIERS`, `AINEK_QUORUM`). The more independent verifiers write the same keys, the less
the log depends on us.

What one round does, per model:

1. `GET /v1/attestation/report?model=…&nonce=<32 random bytes>` from NEAR AI Cloud (no API key needed). The exact bytes are kept.
2. The NEAR AI SDK verifies the evidence locally: Intel TDX quote (DCAP, live collateral), NVIDIA GPU verdict (NRAS),
   nonce and signing key bound in the report data, `app_compose` vs MRCONFIGID, RTMR3 replay. Policy: `AINEK_ACCEPTED_TCB` (default `UpToDate`), GPU evidence required.
3. `KeyEntryInput` is built from the verified fields (`packages/proof` `buildKeyEntryInput`, same code for every verifier).
4. If this verifier logged the same `signing_address` + `compose_hash` in the last 6 h, nothing is sent. Otherwise `log_key` under the verifier's account.
5. The report is written to `data/reports/<report_hash>.json`.

A model whose evidence does not verify is not logged. Nothing else happens: clients then refuse that key (fail-closed).

## Run a verifier in 5 minutes

You need a NEAR testnet account whose key you can export, and the contract owner must have called
`register_verifier(<your account>)` once (open registration is pending, see DECISIONS).

```sh
git clone https://github.com/sadabaevb/ainek && cd ainek && pnpm i
cp .env.example .env   # set VERIFIER_ACCOUNT_ID and VERIFIER_PRIVATE_KEY (ed25519:…); the rest has defaults
pnpm -F verifier once  # one round; `pnpm -F verifier start` loops every VERIFIER_INTERVAL_MIN minutes
```

Or with Docker (same variables through `-e`):

```sh
docker build -t ainek-verifier -f services/verifier/Dockerfile .
docker run --rm -e VERIFIER_ACCOUNT_ID=… -e VERIFIER_PRIVATE_KEY=… -v $PWD/data:/app/services/verifier/data ainek-verifier --once
```

Expected output of a round:

```
z-ai/glm-5.3-flash: attested in 9.8 s: key 5a02…caff, TCB UpToDate, GPU verified, compose 5f7e…, 4 image digest(s)
logged z-ai/glm-5.3-flash key 5a02…caff at index 3, tx 7Nd…
```

Variables (root `.env`, see `.env.example`): `VERIFIER_ACCOUNT_ID`, `VERIFIER_PRIVATE_KEY`, `VERIFIER_MODELS`
(comma-separated, default `z-ai/glm-5.3-flash`), `VERIFIER_INTERVAL_MIN` (15), `AINEK_CONTRACT`, `NEAR_RPC_URL`,
`NEARAI_BASE_URL`, `AINEK_ACCEPTED_TCB`, optional `VERIFIER_DATA_DIR`.

Tests: `pnpm -F verifier test` (offline, on the recorded report in `docs/samples`).

Not yet: `nras_result_hash` is logged as `""` because the SDK's GPU verifier does not expose the NRAS token;
`ita_jwt_hash` likewise. The split-view demo script (second instance with a deliberately different key) is not written.
