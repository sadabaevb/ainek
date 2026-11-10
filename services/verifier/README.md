# Ainek verifier

Re-attests NEAR AI models with a fresh nonce and appends their TEE signing keys to the public key log
contract (SPEC §3.2, §4.1). Anyone can run one; the client decides which verifiers it trusts
(`AINEK_TRUSTED_VERIFIERS`, `AINEK_QUORUM`). The more independent verifiers write the same keys, the less
the log depends on us.

What one round does, per model:

1. `GET /v1/attestation/report?model=…&nonce=<32 random bytes>` from NEAR AI Cloud with `x-no-aliasing: true` (no API key needed),
   `VERIFIER_REPORTS_PER_ROUND` times (default 5): each request is answered by one replica behind the gateway's balancer, and the
   replicas differ in compose hash. The exact bytes of every report are kept.
2. The NEAR AI SDK verifies the evidence locally: Intel TDX quote (DCAP, live collateral), NVIDIA GPU verdict (NRAS),
   nonce and signing key bound in the report data, `app_compose` vs MRCONFIGID, RTMR3 replay. Policy: `AINEK_ACCEPTED_TCB` (default `UpToDate`), GPU evidence required.
3. Every attestation the report carries for the model (replicas, rolling deployments) is verified separately; one `KeyEntryInput` per verified key (`packages/proof` `buildKeyEntryInput`, same code for every verifier).
4. A key+compose pair this verifier logged in the last 6 h, or already sent in this round, is not sent again. Otherwise `log_key` under the verifier's account.
5. Each report is written to `data/reports/<report_hash>.json`.

A key whose evidence does not verify is not logged, the other keys of the report still are. Nothing else happens: clients then refuse the unlogged key (fail-closed).

## Try it without an account

```sh
pnpm -F verifier dry-run   # live re-attestation with a fresh nonce (up to ~40 s), prints the KeyEntryInput; sends nothing
```

No NEAR account, no API key: it shows exactly what a registered verifier would append to the log.

## Run a verifier in 5 minutes

You need a NEAR testnet account, and the contract owner must have called `register_verifier(<your account>)` once,
with 1 yoctoNEAR attached (it must be signed with the owner's full-access key; registration stays with the owner, see
DECISIONS). Tell us the account name and we register it.

Do not give the verifier your account's full-access key. It only ever calls `log_key`, so make it a key that can do
nothing else (the command prints the new key pair once and does not store it: save the secret key, it is
`VERIFIER_PRIVATE_KEY`):

```sh
near account add-key <your-account> grant-function-call-access --allowance '1 NEAR' \
  --contract-account-id ainek-log-dastan.testnet --function-names log_key \
  autogenerate-new-keypair print-to-terminal network-config testnet sign-with-keychain send
```

```sh
git clone https://github.com/sadabaevb/ainek && cd ainek && pnpm i
cp .env.example .env   # set VERIFIER_ACCOUNT_ID and VERIFIER_PRIVATE_KEY (ed25519:…); the rest has defaults
pnpm -F verifier once  # one round; `pnpm -F verifier start` loops every VERIFIER_INTERVAL_MIN minutes (or put `once` in cron)
```

Or with Docker (same variables through `-e`):

```sh
docker build -t ainek-verifier -f services/verifier/Dockerfile .
docker run --rm -e VERIFIER_ACCOUNT_ID=… -e VERIFIER_PRIVATE_KEY=… -v ainek-reports:/app/services/verifier/data ainek-verifier --once
```

The `verifier-image` GitHub Action builds this image when the verifier changes and, from `main`, pushes it to
`ghcr.io/sadabaevb/ainek-verifier` (`:latest` and the commit's 7-character hash). The package is not public yet; until
it is, build the image yourself with the line above. Without `--once` the container loops; `--dry-run` needs no
account at all.

Expected output of a round:

```
z-ai/glm-5.3-flash: 5 report(s) with 5 attestation(s) checked in 21.4 s
z-ai/glm-5.3-flash: key 5a02…caff verified: TCB UpToDate, GPU verified, compose a0e3…8c5f, 4 image digest(s)
logged z-ai/glm-5.3-flash key 5a02…caff at index 3, tx 7Nd…
z-ai/glm-5.3-flash: key 5a02…caff verified: TCB UpToDate, GPU verified, compose e841…729d, 4 image digest(s)
logged z-ai/glm-5.3-flash key 5a02…caff at index 4, tx 9Qa…
z-ai/glm-5.3-flash: key 5a02…caff verified: TCB UpToDate, GPU verified, compose a0e3…8c5f, 4 image digest(s)
z-ai/glm-5.3-flash: key 5a02…caff with this compose already sent by us in this round, not logging again
…
```

Variables (root `.env`, see `.env.example`): `VERIFIER_ACCOUNT_ID`, `VERIFIER_PRIVATE_KEY`, `VERIFIER_MODELS`
(comma-separated, default `z-ai/glm-5.3-flash`), `VERIFIER_INTERVAL_MIN` (15), `VERIFIER_REPORTS_PER_ROUND` (5; 1 in a dry run), `AINEK_CONTRACT`, `NEAR_RPC_URL`,
`NEARAI_BASE_URL`, `AINEK_ACCEPTED_TCB`, optional `VERIFIER_DATA_DIR`.

Tests: `pnpm -F verifier test` (offline, on the recorded report in `docs/samples`).

Not yet: `nras_result_hash` is logged as `""` because the SDK's GPU verifier does not expose the NRAS token;
`ita_jwt_hash` likewise. The split-view demo script (second instance with a deliberately different key) is not written.
