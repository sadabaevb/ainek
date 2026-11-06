# Deploying Ainek

Four things get deployed: the web demo (this section, Bektur), the verifier daemon, the Tier 2 policy job on OutLayer
and the Tier 2 accounts on testnet (the sections after it, Dastan). ROADMAP and the Tier 2 prompt point here.

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

## Verifier daemon on a server (Dastan)

The daemon (`services/verifier`) has to run all the time: the client refuses a key that no trusted verifier logged in
the last 24 hours. It runs in Docker on a Linux VPS (x86_64, clock synchronized) under the verifier account
`ainek-dev-dastan.testnet`.

On the server everything lives in `/opt/ainek-verifier`: `src/` is the tracked files of `main` (no `.env`), and
`verifier.env` (mode 600, root only) holds `VERIFIER_ACCOUNT_ID` and `VERIFIER_PRIVATE_KEY` and nothing else. The
contract, the RPC and the model come from the defaults in the code.

The key on the server should be a function-call key that can only call `log_key` on the contract, not the account's
full-access key: the daemon needs nothing else, and whoever reads the file can then only write log entries under the
verifier's name (the client's quorum and the owner's `register_verifier` are the answer to that), not take the account.

```
near account add-key <verifier> grant-function-call-access --allowance '1 NEAR' --contract-account-id <contract> \
  --function-names log_key autogenerate-new-keypair print-to-terminal network-config testnet sign-with-keychain send
```

The secret key it prints goes into `verifier.env` on the server and nowhere else. (Or generate the pair on the server
and add only its public key with `use-manually-provided-public-key`, so the secret never leaves the server.)

```
# from the repo root on your machine; <server> is the ssh target
git fetch origin && git archive --format=tar origin/main | ssh <server> \
  'rm -rf /opt/ainek-verifier/src && mkdir -p /opt/ainek-verifier/src && tar -x -C /opt/ainek-verifier/src'
ssh <server> "cd /opt/ainek-verifier/src && docker build -f services/verifier/Dockerfile \
  -t ainek-verifier:latest -t ainek-verifier:$(git rev-parse --short origin/main) ."    # the tag says what is deployed
ssh <server> 'docker run -d --name ainek-verifier --restart unless-stopped --memory 512m \
  --log-opt max-size=10m --log-opt max-file=3 --env-file /opt/ainek-verifier/verifier.env \
  -v ainek-verifier-data:/app/services/verifier/data ainek-verifier:latest'
ssh <server> 'docker logs --tail 20 ainek-verifier'       # what the last rounds did
```

To update: repeat the first two commands (the first one replaces `src/`, so files deleted in git do not linger in the
image; `verifier.env` is outside it), then `docker stop ainek-verifier && docker rm ainek-verifier` (stop lets a round
in progress finish) and the `docker run` again. The reports stay in
the `ainek-verifier-data` volume. `--restart unless-stopped` restarts the daemon after a crash, and after a reboot
because the Docker service is enabled at boot on this server (`systemctl is-enabled docker`); the reboot itself has not
been tried. Run one daemon per verifier account: two with the same key race and can write the same entry twice.

## Policy job on OutLayer (Tier 2, Dastan)

The job is `jobs/policy` (SPEC §3.5, §6): a WASI P1 binary that reads the action from stdin, the policy and the
signing key from OutLayer secrets, and prints a signed decision.

### 1. Build and hash

```
scripts/wasm-hash.sh        # needs Docker; prints: <sha256>  target/repro/wasm32-wasip1/release/ainek-policy.wasm
```

The script builds inside a pinned linux/amd64 container with the pinned toolchain and `Cargo.lock`, so the hash is the
same on every machine. A plain `cargo build` on your own machine gives a working wasm with a **different** hash (why:
the script's header), so always deploy and compare the file this script produced. The
`policy-wasm` GitHub Action runs the same script on every push that touches the job and keeps the wasm as an
artifact. If your number differs from the one in the table below, you are not looking at the deployed code.

### 2. Upload and deploy (OutLayer testnet)

```
outlayer upload jobs/policy/target/repro/wasm32-wasip1/release/ainek-policy.wasm
outlayer deploy policy <url printed by upload> --target wasm32-wasip1
```

### 3. Secrets, locked to this build

```
outlayer secrets set --project <owner>/policy --build <sha256 from step 1> \
  --generate PROTECTED_ED25519:ed25519 \
  '{"POLICY_JSON": "<the policy of SPEC §6.1 as one JSON string>", "WASM_HASH": "<sha256 from step 1>"}'
```

- Who may run the job with these secrets is the row's reader list. Ours admits only the project owner's account, so a
  service that calls the job with another account's payment key gets no secrets until that account is added:
  `outlayer secrets access --project <owner>/policy --access whitelist:<owner>,<other account> --build <sha256>`
  (from the CLI help; not run yet).
- `PROTECTED_ED25519` is generated inside the TEE; we never see it. The job prints only its public key (`pubkey`).
- `POLICY_JSON` is the owner's policy. It is never on-chain and never in git; only `policy_hash` is public, and the
  policy's `salt` (`openssl rand -hex 32`) keeps that hash from confirming guesses about the policy.
- `WASM_HASH` is the hash from step 1: the job cannot hash itself, so it reports this value in `wasm_hash`.
- `--build` locks all three to this exact wasm ("one build only"): another build of the job cannot read the key or
  the policy. This is an access rule the project owner can move, not a property of the key, so the contract will not
  notice a move (what follows from that: SPEC §3.5, CLAIMS). For a new build:
  `outlayer secrets access --project <owner>/policy --build <new sha256>`, then
  `outlayer secrets update --project <owner>/policy '{"WASM_HASH": "<new sha256>"}'` (`update` keeps `PROTECTED_*`;
  do **not** repeat the `secrets set --generate` above, it overwrites the row and makes a new key), then update the
  table below. The public key and `policy_hash` stay the same, so no `update_policy`. This is from the CLI help and
  OutLayer's docs; we have not moved a lock live yet.

### 4. First run: get the public key

```
outlayer run <owner>/policy '<input of SPEC §6.2 as JSON>' --target wasm32-wasip1 \
  --secrets-account <owner> --secrets-profile default
```

`pubkey` in the output is `tee_pubkey` (`POLICY_TEE_PUBKEY` in `.env`) for `register_agent`; `decision.policy_hash` is
`policy_hash`. Check the run's attestation
(`GET https://testnet-api.outlayer.ai/attestations/by-request/<request_id>`; `request_id` is in the
`execution_requested` event of the run's transaction): its `wasm_hash` must equal the hash from step 1, its
`output_hash` is the sha256 of the job's output, and its `input_hash` is the sha256 of the input as OutLayer passes it
to the job, which is the JSON with sorted keys and no spaces, not the bytes you typed. That address is for runs made
through the contract, like this one; a call through the HTTPS API returns its own `attestation_url`
(`/attestations/by-call/<call_id>`, SPEC §5.2).

### Deployed values

| What | Value |
|---|---|
| OutLayer project (testnet) | `ainek-dev-dastan.testnet/policy` |
| `wasm_hash` of the deployed build | `8041305f57d4f5668ee5d40f0f461b3df3fd22145f3e90c704a0204625f2d2eb` (upload tx `6qEdLZfnDdbgn7PZyKrcgR19SVFVNTteDhv5JMZko5Ap`; the same hash from the `policy-wasm` Action on Linux and from a Mac) |
| policy public key (`tee_pubkey`) | `4c0761e240ee9d6837327f7dfc73728a8b62e7941f1c5457f6cd15e552f44740` |
| `policy_hash` (policy version 1) | `ae503840a7a1c05eb3950e315a9cc6c4ad8b154194451194fabb21326a6c2051` |
| first runs | request 10084 (tx `29KjawfJxXWg14vFWLtKnnCNwypFmriesN5w8WQLCce3`; the CLI timed out waiting for it) and request 10085 (tx `B6wfuy1Demw96Q211JS69BYeaHL3KxSFgLKbFEb5pt2B`), the same test action. Checked on 10085: `https://testnet-api.outlayer.ai/attestations/by-request/10085` (`wasm_hash` and `executed_wasm_sha256` equal the build above, `secrets_ref` `ainek-dev-dastan.testnet/default`) |
| registered in the contract | not yet: `register_agent` waits for the contract upgrade (next section) |

## Tier 2 accounts on testnet (Dastan)

What the agent flow of SPEC §4.3 needs on chain, in order. `<owner>` is the account that owns the Ainek contract,
`<contract>` the contract (`AINEK_CONTRACT`), `<token>` and `<agent>` are sub-accounts of `<owner>`. Every command ends
with `network-config testnet sign-with-keychain send`, written `…` below. Not run on testnet yet; the same sequence
runs against a local node in `contracts/ainek/tests/test_agent.rs`.

### 1. The demo token

`contracts/demo-token` is a plain NEP-141 token (NEAR's `near-contract-standards`, 6 decimals, no minting after `new`, worth
nothing). Its code takes about 1.5 NEAR of storage, hence the 2.5 NEAR.

```
near account create-account fund-myself <token> '2.5 NEAR' autogenerate-new-keypair save-to-keychain sign-as <owner> …
cd contracts/demo-token
cargo near deploy build-non-reproducible-wasm <token> with-init-call new \
  json-args '{"owner_id":"<owner>","total_supply":"1000000000000"}' prepaid-gas '30 Tgas' attached-deposit '0 NEAR' …
```

An account must be registered on a token before it can hold it (NEP-145), so register the contract and every receiver
in the policy's whitelist, then give the contract tokens to pay from (`ft_transfer` takes exactly 1 yoctoNEAR):

```
near contract call-function as-transaction <token> storage_deposit json-args '{"account_id":"<contract>"}' \
  prepaid-gas '30 Tgas' attached-deposit '0.00125 NEAR' sign-as <owner> …        # once per account
near contract call-function as-transaction <token> ft_transfer json-args '{"receiver_id":"<contract>","amount":"10000000000"}' \
  prepaid-gas '30 Tgas' attached-deposit '1 yoctoNEAR' sign-as <owner> …
```

A whitelisted receiver that is left unregistered is the demo of a `Failed` action: the policy allows it, the token
refuses, the contract records that and the daily total gets the amount back.

### 2. The contract with agents

```
cd contracts/ainek
cargo near deploy build-non-reproducible-wasm <contract> with-init-call migrate \
  json-args '{}' prepaid-gas '100 Tgas' attached-deposit '0 NEAR' …
```

`migrate` moves the stored state to the new layout; the key log, the proof commits and the storage credits stay
(rehearsed in a local sandbox against the wasm that was live on testnet on Nov 6).

### 3. The agent account and its key

```
near account create-account fund-myself <agent> '0.5 NEAR' autogenerate-new-keypair save-to-keychain sign-as <owner> …
near contract call-function as-transaction <contract> deposit_storage json-args '{}' \
  prepaid-gas '30 Tgas' attached-deposit '0.1 NEAR' sign-as <agent> …
near account add-key <agent> grant-function-call-access --allowance '0.25 NEAR' --contract-account-id <contract> \
  --function-names 'commit_proof, propose_action' autogenerate-new-keypair print-to-terminal …
```

The last command prints the new key pair once: the secret key goes into `.env` as `AGENT_FC_PRIVATE_KEY` and nowhere
else. That key can call `commit_proof` and `propose_action` on the contract and nothing more (the agent service
refuses to start with any other scope, and the contract takes an action only after the agent committed its model proof): it cannot attach NEAR (hence the storage prepaid with the full-access key one
line above), cannot approve, cannot move the account's own balance. The allowance is the most gas the key can ever
burn, kept below what the account holds so that a leaked or looping key runs into the allowance, not into an empty
account. Check what
is really on the account before the demo, a wallet once gave us a key for all methods (DEV-NOTES):
`near account list-keys <agent> network-config testnet now`.

### 4. Register the agent

With `pubkey` and `decision.policy_hash` from the first run of the policy job (previous section, step 4):

```
near contract call-function as-transaction <contract> register_agent \
  json-args '{"agent_id":"<agent>","policy_hash":"<policy_hash>","policy_version":1,"tee_pubkey":"<pubkey>","token_id":"<token>"}' \
  prepaid-gas '30 Tgas' attached-deposit '1 yoctoNEAR' sign-as <owner> …
```

The 1 yoctoNEAR is required on every owner method except `pause_agent` (`register_agent`, `update_policy`,
`unpause_agent`, `approve`, `reject`, `register_verifier`): a function-call key cannot attach it, so the call must be
signed with the owner's full-access key (SPEC §4.3). Approving or rejecting a waiting action, on the UTC day it was
proposed:

```
near contract call-function as-transaction <contract> approve json-args '{"action_id":<id>}' \
  prepaid-gas '100 Tgas' attached-deposit '1 yoctoNEAR' sign-as <owner> …
```

The stop button is the owner's `pause_agent` (the contract refuses the agent from then on) plus deleting the
function-call key from the agent account.
