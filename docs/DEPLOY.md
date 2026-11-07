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

## Agent service (Tier 2)

Runs next to the verifier (Hetzner), one process, from a clean clone: `pnpm i && pnpm -F agent start`. Variables are in
`.env.example`, block "Agent service". Before the first message:

1. The agent account exists, with a function-call key scoped to the contract and to exactly `propose_action` and
   `commit_proof`. The service reads the key's scope from the chain at start and refuses anything else. The allowance cannot be raised later
   without a new key: the deployed key has 0.25 NEAR, and five calls used 0.0018 NEAR (DEV-NOTES), so that covers hundreds of actions.
2. The account prepaid its storage: `deposit_storage` with a full-access key. One action takes about 0.013 NEAR (two commits, SPEC §4.2, and the action record, SPEC §4.3), so 0.1 NEAR covers about 7 actions; the service stops before the model call when less than one action is left.
3. `register_agent` ran with the policy hash, the job's public key and the token.
4. `AGENT_DATA_DIR` is on a disk that is backed up: without its salt a commit can never be opened, and this is the only copy.
5. `OUTLAYER_PAYMENT_KEY` is funded ("Payment key for the job" below).
6. The bot exists. Create it with @BotFather (`/newbot`) and put its token in `TELEGRAM_BOT_TOKEN`. Send it `/start`, open
   `https://api.telegram.org/bot<token>/getUpdates` in a browser while the service is not running, and put `message.chat.id`
   in `TELEGRAM_OWNER_CHAT_ID`: the service answers only in that private chat. Once it runs, `/start` checks the setup and spends
   nothing; any other text runs the model and can move money.

Give the agent its own env file. The owner's keys never go on this server: `pnpm demo:stop` runs on the owner's machine from
`.env.owner`, and the service refuses to start if `OWNER_PRIVATE_KEY` or `AGENT_ADMIN_PRIVATE_KEY` is in its environment. Other
`*_PRIVATE_KEY` variables, such as the verifier's on a shared `.env`, only produce a warning. Run one instance: updates are
handled one at a time, and pending ones are dropped at start, so a message sent while it is down has to be sent again. If the
service stopped in the middle of a payment, it tells the owner when it is back. The token's decimals are read from its
`ft_metadata` at start, so the token must exist first.

### Payment key for the job (testnet)

The service pays for each call of the job with an OutLayer payment key (`OUTLAYER_PAYMENT_KEY`, `owner:nonce:secret`). Use a key of the project's owner: the attestation check accepts only runs called by the owner. In our one such record the caller is the key's owner.
Ours belongs to the OutLayer project owner (`<owner>` below), who may read the job's secrets; a key of another account
was not tried. The `outlayer` CLI is the one from the next section. On testnet the key is
funded with a test token anyone can mint (which token: `get_payment_token_contract` on `outlayer.testnet`; on Nov 6 it
was `usdc.fakes.testnet`, 6 decimals):

```
outlayer keys create                                   # prints the nonce
near contract call-function as-transaction usdc.fakes.testnet storage_deposit json-args '{"account_id":"<owner>"}' \
  prepaid-gas '30 Tgas' attached-deposit '0.00125 NEAR' sign-as <owner> network-config testnet sign-with-keychain send
near contract call-function as-transaction usdc.fakes.testnet mint json-args '{"account_id":"<owner>","amount":"20000000"}' \
  prepaid-gas '30 Tgas' attached-deposit '0 NEAR' sign-as <owner> network-config testnet sign-with-keychain send
outlayer keys topup <nonce> --usd 5
printf 'OUTLAYER_PAYMENT_KEY=%s\n' "$(outlayer keys show <nonce>)" >> .env   # the key is a secret: straight into .env, not onto the screen
```

One call of the job costs about a tenth of a cent (`compute_cost` 1005, in millionths of a dollar as far as we can
tell), so 5 test dollars is thousands of calls. `outlayer keys list` shows what is left.

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

`pubkey` in the output is `tee_pubkey` for `register_agent` (the agent service reads it back from the contract); `decision.policy_hash` is
`policy_hash`. Check the run's attestation
(`GET https://testnet-api.outlayer.ai/attestations/by-request/<request_id>`; `request_id` is in the
`execution_requested` event of the run's transaction): its `wasm_hash` must equal the hash from step 1, its
`output_hash` is the sha256 of the job's output, and its `input_hash` is the sha256 of the input as OutLayer passes it
to the job, which is the JSON with sorted keys and no spaces, not the bytes you typed. That address is for runs made
through the contract, like this one; a call through the HTTPS API returns its own `attestation_url`
(`/attestations/by-call/<call_id>`, SPEC §5.2). That record differs in two ways: its `input_hash` covers the input
exactly as it was sent, key order included (so the agent sends canonical JSON), and it has no `block_height`, which is
then left out of the hash the quote commits to.

### Deployed values

| What | Value |
|---|---|
| OutLayer project (testnet) | `ainek-dev-dastan.testnet/policy` |
| `wasm_hash` of the deployed build | `8041305f57d4f5668ee5d40f0f461b3df3fd22145f3e90c704a0204625f2d2eb` (upload tx `6qEdLZfnDdbgn7PZyKrcgR19SVFVNTteDhv5JMZko5Ap`; the same hash from the `policy-wasm` Action on Linux and from a Mac) |
| policy public key (`tee_pubkey`) | `4c0761e240ee9d6837327f7dfc73728a8b62e7941f1c5457f6cd15e552f44740` |
| `policy_hash` (policy version 1) | `ae503840a7a1c05eb3950e315a9cc6c4ad8b154194451194fabb21326a6c2051` |
| first runs | request 10084 (tx `29KjawfJxXWg14vFWLtKnnCNwypFmriesN5w8WQLCce3`; the CLI timed out waiting for it) and request 10085 (tx `B6wfuy1Demw96Q211JS69BYeaHL3KxSFgLKbFEb5pt2B`), the same test action. Checked on 10085: `https://testnet-api.outlayer.ai/attestations/by-request/10085` (`wasm_hash` and `executed_wasm_sha256` equal the build above, `secrets_ref` `ainek-dev-dastan.testnet/default`) |
| registered in the contract | yes, Nov 6: `register_agent` tx `96fo9HFvukSfA7U39CRfkdQi1LuV8oQZt4fkVuQ1PkUw` (next section) |

## Tier 2 accounts on testnet (Dastan)

What the agent flow of SPEC §4.3 needs on chain, in order. `<owner>` is the account that owns the Ainek contract,
`<contract>` the contract (`AINEK_CONTRACT`), `<token>` and `<agent>` are sub-accounts of `<owner>`. Every command ends
with `network-config testnet sign-with-keychain send`, written `…` below. Run on testnet on Nov 6, with
the differences noted under "Deployed Tier 2 accounts" below; the same sequence runs against a local node in
`contracts/ainek/tests/test_agent.rs`.

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
(rehearsed in a local sandbox against the wasm that was live on testnet, then run on testnet on Nov 6: every stored
key and value except the contract's root record was byte-for-byte the same before and after).

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

### Deployed Tier 2 accounts

| What | Value |
|---|---|
| contract with agents | `ainek-log-dastan.testnet`, upgraded with `migrate` in tx `EKTgWzARoPNoqhSE8Wb2k32wYMWUKqEG4WyeFLRW3UBM` (code hash on chain `GsUogroonduMzsAtwe7vYLLFoCKDrw6ULSfQTZnV85ey`, a non-reproducible build of `main` at `79e8fcf`). The contract is its own owner, so owner calls are signed as `ainek-log-dastan.testnet` |
| demo token | `token.ainek-dev-dastan.testnet` (deploy tx `6PjJPBANBCQqhUy2uYcgvnvUdy7ejBpz6RkaeLER2zG7`); 1,000,000 AINEK minted to `ainek-dev-dastan.testnet`, 10,000 of them sent to the contract |
| agent | `agent.ainek-dev-dastan.testnet`, created with 0.5 NEAR, of which 0.1 NEAR is prepaid as storage on the contract |
| agent's function-call key | `ed25519:CeUWgrZ9N4CQe7NG6S9oJJYgWEx4xky1fzUB2tMmGx1E` since Nov 7 (the first was deleted when the stop button ran; to replace it, generate the pair where the bot runs and add only the public key, so the secret never travels): `commit_proof` and `propose_action` on the contract, allowance 0.25 NEAR (less than the 1 NEAR that "Agent service" above asks for; five calls used 0.0018 NEAR, the two texts are not reconciled yet). The account also has the full-access key it was created with (in Dastan's keychain) |
| receivers registered on the token | the contract and one of the policy's two whitelisted receivers; the other is left unregistered on purpose (the `Failed` demo) |
| first actions | action 0: `Allow`, 1 AINEK, `Executed` in the proposing tx `2Hpjzuq3BXdb1zGsPc1fpBcS4azoxDEH3ymLLS3kdMBd`. Action 1: `NeedsApproval`, 400 AINEK, proposed in `5LXLQQob287RaTkDph5RyTZfEvsuMSSwArTB2L9Gi8mc`, approved by the owner in `J68M3NSGuxTB4uR1ZSFauian46nftUAR9Gch9rVPtQaP`, `Executed` |

On testnet the token and the agent are sub-accounts of `ainek-dev-dastan.testnet` (the names were fixed in the policy
before the accounts existed), so `<owner>` in steps 1 and 3 was that account and in steps 2 and 4 the contract itself.
The agent's key pair was generated locally and only its public key was added (`use-manually-provided-public-key`), so
the secret was never printed.

The two first actions were sent by a script standing in for the agent service: it signed with the agent's function-call
key through `services/agent/src/chain.ts` and ran the policy job with `outlayer run`, but the model proof commit behind
each action is a random placeholder, not a model answer (three such `model` commits by the agent are on the contract,
one of them unused).

The service itself then made one real payment with `pnpm -F agent once` (no Telegram): action 2, `Allow`, 2 AINEK,
`Executed` in tx `DfLBYkaTW6FZEViWXd1KM79279ikGJR3XM33gyLpWb4X`, with a real model answer, both proofs committed and the
run's attestation checked (`https://testnet-api.outlayer.ai/attestations/by-call/48c62234-033e-4441-b684-0dae271d7375`).
On Nov 7 the Telegram bot ran live from a laptop:

- action 3, `Allow`, 2 AINEK, `Executed` in tx `4AbtQwRPU3MNUEjP8G5DWQSsZkyqmFD6x9qtuViM82t3`. Its action proof was not
  committed: that call hung for a minute or two and ended in `fetch failed` (DEV-NOTES), and the commit has not been re-sent;
- action 4, `Deny`, 5000 AINEK to `newguy.testnet`, in tx `5DEx9kHKEDJMuaeVzwZ32CujcoXnaQ3nHEQywszLqYYn`: event
  `action_denied`, nothing moved, action proof committed in tx `G8zhBT3whKitL2Smx47xBdVrN3jy8pAfvAVgfkxqewM4`.

Later on Nov 7, from a script with a placeholder model proof, not through the bot:

- action 5, `NeedsApproval`, 400 AINEK, `reject` in tx `HX2AqnVwmwZf9HTtQB54dT14rrbhrvv8DpLQdGqMKTei`: event `action_rejected`,
  nothing moved;
- action 6, `NeedsApproval`, 400 AINEK, `approve` in tx `92NADxX1DkGVuJLyFHKYCQQJw7yj7rfh6YA5oEREMbAS`: events `action_approved`,
  `action_executed`;
- the stop button's two transactions against this agent: `DeleteKey` in tx `HSHmRTjdYVaJNzf2Mpypoo4u5J9ow9KjJJHjCujQU2J8`, `pause_agent`
  in tx `EcCyCzpWBucGYJey6Kucr87SKPk6m6mBrpczd3zdZzt1`. A proposal with the deleted key failed with "Access key … does not exist": a
  rejected transaction leaves nothing on chain, so that part is as reported by whoever ran it;
- back in service: `unpause_agent` in tx `HFRqhNq5Vzi8tCHYum5MC88nBSAUsUmwjeCR4ij8gdzb`, a new function-call key (table above), action
  7, `Allow`, 1 AINEK, `Executed` in tx `C7VEhjW6UZggM5Pq6JLKhY6AMASscBEZ8HxUvFR7bvUx`.

The agent's storage credit after these was 0.0189 NEAR, so `deposit_storage` added 0.1 NEAR (full-access key) in tx
`Dyi1aCVvoCbNKvSscRW1vNce4ZFVFXbxUtFUzAAvPZTj`. Then through the bot again:

- action 8, `Allow`, 2 AINEK to `vendor1.ainek-dev-dastan.testnet` (whitelisted, not registered on the token), `Failed` in tx
  `4CcpGMfA1eiifo4xrdYSb72a6LKFieX26sJfaHPt94XG`: events `action_proposed`, `action_failed`, the token panicked with "is not
  registered", nothing moved and the day's total gave the 2 AINEK back. Action proof committed in tx
  `6M4kfPfov6B1xvF6G6mCqj3sWaQ6rGTrgXdiCjEsTnop`;
- action 9, `NeedsApproval`, 400 AINEK, proposed in tx `AsaFxVazAnE4MWuRYQ6hhTbEwhYhfsKNwVfe4YokAVdJ`, action proof committed in tx
  `6bTVZuznQdUqw1PRiqPU3kfuVsgqG5bTeLL8NTMEDoe1`. The card's "How to approve" button gave the commands, and the owner signed
  `approve` with their own key in tx `HBdadwY6J9bndBq79oXfxDELsCsDZQnPcZ9jgahNJV44`: events `action_approved`, `ft_transfer`,
  `action_executed`.

The agent's storage credit is now 0.0966 NEAR. The service wants 0.0153 NEAR free before each action and an action takes 0.011 to
0.013, so that is about 7 more actions; top it up with `deposit_storage` before recording if retakes will use them up. Not run live
yet: a rejection through the bot, a forwarded injection message (Catch 3), a commit failure recovered by the retry.

## Locking the contract (Dastan; not done yet)

Today `ainek-log-dastan.testnet` owns itself and has one full-access key, so "append-only" rests on trusting whoever
holds that key: they could deploy other code or rewrite the state. The lock removes that. It is the last step before
submission, because after it nobody can fix a bug in the contract either.

Before starting:

- The repository is public. A reproducible build is only "rebuildable by anyone" then. The build itself already works
  with the private repo; whether the deploy step insists on a public remote has not been tried.
- `cargo near build reproducible-wasm` in `contracts/ainek` gives the same sha256 on a second machine. Tried on Nov 6
  on one machine (an Apple-silicon Mac, the amd64 image under emulation): two builds of commit `c4a7752` both gave
  `dbb7c5c041c2549d788e81ccfaba9975a824f2e0452eb8796b170077ffa99cc9`. The container compiles with Rust 1.96.0, the
  version in the image tag, and ignores `rust-toolchain.toml` (1.93), which only governs local builds and tests. The
  commit is written into the wasm (`contract_source_metadata`), so every commit has its own hash: the hash to publish
  is the one of the exact commit that gets deployed.
- Everything that changes the contract is decided and merged. After the lock nothing can be revoked or re-allowed:
  not a verifier, not a compose. Decided on Nov 7 (`docs/DECISIONS.md`): verifier registration stays with the owner, also
  after the lock, and `set_owner` stays one-step. Open before the lock:
  - reading the log per verifier (`latest_keys` returns the newest 100 entries of all verifiers together, see below);
  - size limits on `log_key`'s input;
  - a live run of the final build on testnet before the keys go.

Then, with every command ending in `network-config testnet sign-with-keychain send`:

1. Deploy the final code as a reproducible build:
   `cargo near deploy build-reproducible-wasm <contract> without-init-call …` from a clean, pushed commit (needs
   Docker). No `migrate`: `set_owner` did not change the stored layout.
2. Check the deploy before anything irreversible: the account's `code_hash` equals the hash of the local reproducible
   wasm, and `contract_source_metadata` names the commit.
3. Hand the owner role to a fresh account that keeps a full-access key (the owner still registers verifiers and
   agents and approves actions). Not `ainek-dev-dastan.testnet`: its full-access key sat on the server for three
   hours on Nov 6 and was not rotated. `set_owner` with `{"new_owner":"<owner>"}`, 1 yoctoNEAR, signed as the contract.
   Update `OWNER_ACCOUNT_ID` wherever it is set (`.env`, `.env.owner`, the agent's env: the bot prints
   `sign-as <owner>` in its approve commands) and the "contract with agents" row above.
4. Check the hand-over: `owner` returns `<owner>`, and `<owner>` can call a method that needs the full-access proof,
   for example `unpause_agent` on the registered agent with 1 yoctoNEAR (`pause_agent` proves nothing, it takes no
   deposit). A mistyped account can still be repaired here, by deploying code with a one-off method that rewrites
   `owner`. After step 5 it cannot.
5. Delete every key of the contract account: `near account list-keys <contract> network-config testnet now`, then
   `near account delete-keys <contract> public-keys <key>,<key> …`.
6. Publish in the README: the code hash, the commit it was built from, and the fact that `list-keys` is empty.

What the lock makes final: the code, the existing log entries and the existing proof commits (the code has no way to
change or remove them). What it does not change:

- The owner still adds verifiers and agents, approves actions, and can hand the role on with `set_owner`, which is
  then irreversible: a wrong account loses the role for good. Whoever owns the contract can also move every token it
  holds, by registering an agent with a decision key of their own.
- A registered verifier can still write entries, and there is no way to remove a verifier: a leaked verifier key can
  append forever. Clients choose which verifiers they trust, but that does not contain it: `latest_keys` returns the
  newest 100 entries for a model from all verifiers together, so a flood of entries pushes the trusted verifiers' entries
  out of what the client sees (read in the code, not tried).
- The contract account pays for the storage of log entries. If its balance runs low, every write fails, `log_key`,
  `commit_proof` and `propose_action` alike, until someone sends the account NEAR; a plain transfer works and needs
  no key. NEAR on the account cannot be taken out again.

The hand-over, the key deletion and the owner's and verifiers' calls after it run against a local node in
`contracts/ainek/tests/test_basics.rs` (there the owner is a separate account from the start, and the build is not
the reproducible one). `tests/test_agent.rs` runs the whole agent flow, transfers and callbacks included, on a
contract account that has no key.
