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
4. For every verified key the release behind it is followed to public sources (`packages/proof` `releaseMarksFor`): the enclave's
   action log, which the SDK authenticated in step 2, NEAR AI's public compose repository on GitHub, and the signed builds of the
   proxy and of Compose Manager. When every check holds, the entry carries two release marks after its image digests: the action
   log as it stood, and the release of the model's service (SPEC §7.5). When one does not hold, or GitHub does not answer within
   60 s, the entry is the one a verifier always logged and the round says why. `VERIFIER_RELEASE_MARKS=0` skips this step.
   What is followed is the latest release of the model's service in the compose file the log most recently deployed for it.
   The engine image and the other deployments in the same log are not followed, and a mark does not say they were.
5. A key+compose pair this verifier logged in the last 6 h, or already sent in this round, is not sent again, unless the entry
   carries release marks that no such entry has: the enclave's action log moved, and a client that asks for a logged release
   waits for exactly that entry. Otherwise `log_key` under the verifier's account.
6. Each report is written to `data/reports/<report_hash>.json`.

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

### From your own GitHub account

No server, and no laptop left on: for a public repository GitHub runs one round an hour, free. Our second verifier runs
this way, and so does the one a friend of ours runs ([AnasKg/ainek-verifier](https://github.com/AnasKg/ainek-verifier)).

1. Make a public repository of your own, with a README so that it has a branch. Any name.
2. In it, Settings → Secrets and variables → Actions → New repository secret: `VERIFIER_PRIVATE_KEY`, the function-call
   key from above. It is a secret of your repository; we never see it.
3. Add the file `.github/workflows/verifier.yml` with the contents of
   [`github-workflow.example.yml`](github-workflow.example.yml), and put your account's name in `VERIFIER_ACCOUNT_ID`.
4. Actions → verifier → Run workflow. The log of the run shows the lines below; from then on it runs by the schedule.

The workflow checks this repository out at one commit, named in the file: what you run changes when you change that
line, not when we push. GitHub starts scheduled runs late, by hours at times (ours ran with gaps of six to nine hours on
Nov 12 and 13). One round a day is enough to stay inside the 24 hours a client looks back over.

Expected output of a round:

```
z-ai/glm-5.3-flash: 5 report(s) with 5 attestation(s) checked in 21.4 s
z-ai/glm-5.3-flash: key 5a02…caff verified: TCB UpToDate, GPU verified, compose a0e3…8c5f, 4 image digest(s); release checked, action log of 271 actions marked
logged z-ai/glm-5.3-flash key 5a02…caff at index 3, tx 7Nd…
z-ai/glm-5.3-flash: key 5a02…caff verified: TCB UpToDate, GPU verified, compose e841…729d, 4 image digest(s); release checked, action log of 156 actions marked
logged z-ai/glm-5.3-flash key 5a02…caff at index 4, tx 9Qa…
z-ai/glm-5.3-flash: key 5a02…caff verified: TCB UpToDate, GPU verified, compose a0e3…8c5f, 4 image digest(s); release checked, action log of 271 actions marked
z-ai/glm-5.3-flash: key 5a02…caff with this compose already sent by us in this round, not logging again
…
```

A release that could not be followed reads `release not marked: <why>` on that line, and the key is logged all the same.

Variables (root `.env`, see `.env.example`): `VERIFIER_ACCOUNT_ID`, `VERIFIER_PRIVATE_KEY`, `VERIFIER_MODELS`
(comma-separated, default `z-ai/glm-5.3-flash`), `VERIFIER_INTERVAL_MIN` (15), `VERIFIER_REPORTS_PER_ROUND` (5; 1 in a dry run), `AINEK_CONTRACT`, `NEAR_RPC_URL`,
`NEARAI_BASE_URL`, `AINEK_ACCEPTED_TCB`, optional `VERIFIER_DATA_DIR`, `VERIFIER_RELEASE_MARKS` (on; `0` logs keys without
release marks) and optional `GITHUB_TOKEN`. The release check reads public repositories on GitHub: a few requests for a
release it has not read yet, then one in ten minutes for each release it sees (where the release's tag points). GitHub
allows 60 anonymous requests an hour from one address; a token with no scopes raises that, and it is sent to
api.github.com only. Set one for a daemon: a read that fails is not remembered, so every report of a round asks again, and
a daemon that has hit the limit stays over it. Ours ran without a token and wrote no release mark for almost 32 hours
on Nov 13 and 14. `--env-file` is read when the container is created: after a change to `verifier.env`, `docker rm` and
`docker run` again, not `docker restart`.

Tests: `pnpm -F verifier test` (offline, on the recorded report in `docs/samples`).

Not yet: `nras_result_hash` is logged as `""` because the SDK's GPU verifier does not expose the NRAS token;
`ita_jwt_hash` likewise. The split-view demo script (second instance with a deliberately different key) is not written.
