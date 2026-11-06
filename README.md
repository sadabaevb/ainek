# Ainek — a glass box for private AI agents on NEAR

> **Status:** NEAR Hackathon submission (Nov 1–14, 2026). Tracks: Privacy & Private AI, AI Security & Defense,
> Open Innovation, Social Money. Testnet only. Not audited. See [What we do not claim](#what-we-do-not-claim).
>
> **Done:** Tier 1 client, proof package, offline replay, auditor page; key-log contract on testnet with `commit_proof`; the verifier daemon on a server since Nov 6 (docs/DEPLOY.md). Tier 2 on testnet since Nov 6: contract v3 with agents, the policy job on OutLayer, the demo token, the agent account.
> **In progress:** the agent service made one real payment through them without Telegram; the bot itself has not run.
>
> **Reviewing this?** Every claim, the code behind it and a command that shows it: [docs/REVIEW.md](docs/REVIEW.md).

Ainek is a chat with a private model plus a proof you can check yourself. Before anything is sent, the model's signing key is
checked against a **public, append-only key log in a NEAR contract** that verifiers write to (today: one verifier, ours); the
request is end-to-end encrypted to that key; the signed answer is re-verified in your browser, byte for byte. A salted hash of
the proof is committed to NEAR (`commit_proof`, paid from storage the account prepays). Tier 2 is built to let an agent act on the answer
only within a policy evaluated inside Intel TDX (OutLayer); status under "Tier 2 flow".

<!-- TODO before submission: 90-second video link, hosted demo link. -->

**The problem.** Every "private AI" today says "we run in a TEE, trust us". Hardware attestation is now
commodity; what is missing is proof a *user* can re-check, independently of the vendor, that *this*
answer came from *this* attested key under *this* policy — without leaking the user's data to a public chain.
NEAR's own Verification Center says it "cannot recompute request/response hashes" and "does not compare
measurements to an approved allowlist"; Brave, built on NEAR AI, wrote on Oct 15 2026 that there is
"no public log of TEE keys yet". Independent monitoring rates 0 of 95 provider checks "end-to-end verified".

**What Ainek does.** Three questions, each answered by something you can re-run:

- **Is this key real?** The client sends nothing unless the model's signing key is in the public log on NEAR (fail-closed).
  A verifier logs a key only after checking the Intel TDX quote and the NVIDIA GPU evidence, and the client re-verifies the
  evidence itself as well, so the log is a second opinion, not the only one. If two trusted verifiers disagree on a model,
  you see a split view, not an average. Today: one verifier, ours. Entry #0 was logged by hand from a report our code
  verified with the SDK; entries #1 and #2 are re-logs of that same recording by a stopgap script, since removed (same nonce
  and report hash, fresh `observed_at`), so they confirm nothing new; entries from #3 on come from the verifier and a fresh
  attestation each. No entry records the NVIDIA verdict hash yet (the SDK's GPU verifier does not return it).
- **Did this answer come from there?** The enclave signs `sha256(request)` and `sha256(response)`. Ainek keeps the exact
  bytes, recomputes both hashes and checks the signature against the logged key. A salted hash of the proof is committed
  to NEAR by your wallet (`commit_proof`, from storage your account prepays); until you connect one it stays in this browser. The salt and your copy of the exchange live
  only in this browser; disclosing to an auditor hands over one proof, its salt and the ciphertext bytes, never the plaintext.
- **Did the agent do only what it was allowed to?** (Tier 2; status under "Tier 2 flow".) The policy
  (whitelist, caps, approval threshold) runs in an OutLayer job on Intel TDX that signs the decision with a key
  generated there; the contract checks that signature, then pays or waits for a human. Public: the proposed action and the
  executed transfer (testnet has no hidden settlement), the decision and the policy hash; never the policy contents or the
  conversation.

## Three catches (what you will see)

1. **Swapped key → nothing is sent.** The key is not in the public log → the client refuses: "Result: REFUSED" (`pnpm demo:tamper`) or the red card "Key not in the public log. Message not sent." (`/?tamper=1`).
2. **"Private" that wasn't.** A request routed through a non-attested model (gateway-signed, NEAR AI Incognito tier) → red card.
3. **Agent over its mandate.** (Tier 2, not shown live yet) A prompt-injected "urgent transfer to a new vendor" → policy job says Deny inside TDX → the contract records it and moves nothing → `action_denied`, with the signed decision and the policy hash. So far the contract's part has run in `contracts/ainek/tests/test_agent.rs` with a test key, and the job's Deny in `cd jobs/policy && cargo test`.

| Proof card after a verified reply (`/`) | Swapped key: nothing is sent (`/?tamper=1`) |
| --- | --- |
| ![The proof card: model, hardware, key in the public log, hashes, E2EE, on NEAR](docs/screenshots/proof-card.png) | ![Red card: key not in the public log, message not sent](docs/screenshots/refused.png) |
| The public key log (`/log`) | A disclosure checked by an auditor (`/auditor`) |
| ![The public key log page](docs/screenshots/log.png) | ![The auditor verdict card](docs/screenshots/auditor.png) |

The card's compose hash comes from the attestation checked before sending, and its log entry is the newest one with that
key and that compose; if the log window has none, it is the newest for the key and the card says so. See "What we do not
claim".

## How NEAR is used

| Layer | NEAR provides (shipped) | Ainek adds |
| --- | --- | --- |
| Inference in TEE, attestation, response signatures, E2EE, JS SDK | NEAR AI Cloud, `@nearai/inference-sdk` | used as-is, in the browser: the SDK's TDX + GPU checks (NVIDIA's verdict fetched through NEAR AI's proxy and checked against NVIDIA's keys) and `prepareE2eeChatRequest` |
| Verifying an answer | Verification Center (signature + fresh attestation; cannot recompute hashes; no allowlist) | local hash recomputation over the exact bytes; check against a **public log**, not the vendor's current answer; a card a non-technical user can read; `/verify` and `/auditor`; an offline replay (`pnpm demo`) that needs no key |
| Key & measurement log | none (TEE Receipts: owner-registered signer list) | append-only, hash-chained log in a NEAR contract designed for independent verifiers (today: one, ours; registration is owner-gated); fail-closed client with a configurable trust set and quorum; split-view detection |
| Agents in TEE | IronClaw runtime (no policies, limits or proofs); Shade Agents (deprecated Apr 2026) | (Tier 2) agent mandate + policy; decision signed inside TDX (OutLayer); contract executes; public proof without details; stop button |
| Private team payments | NEAR Business, Trezu (human signers, Confidential Intents) | an *agent* signer with a verifiable mandate — a layer on top, not a replacement |
| NEAR primitives | function-call keys, sub-accounts, NEP-141, NEP-297 events, `ed25519_verify` | sign-in asks the wallet for a function-call key limited to `commit_proof` (the wallet may widen it, see [What we do not claim](#what-we-do-not-claim)), so commits are signed without a popup; only the storage prepayment (`deposit_storage`, 0.1 NEAR for 50 to 68 commits depending on the account name, topped up when it runs out) goes through the wallet dialog |

## Prior art in this hackathon (and what Ainek adds)

We read the code of the nearest entries and looked at their contracts on chain on Nov 6, 2026. We did not run them or open their demos, and they may have moved on since. Rows marked (Tier 2) describe a part of Ainek of which one `Allow` payment has run end to end (Nov 6, without Telegram); see "Tier 2 flow" below.

| Project | What it does | Where it is ahead of Ainek | What Ainek adds |
| --- | --- | --- | --- |
| [TEE Receipts](https://github.com/tmdry4530/tee-receipts) | Receipts for NEAR AI answers; signer registry with key history, registered by the contract owner; on-chain signature check | Raw evidence in the repo; the contract checks the answer's signature itself | A hash-chained log designed for independent verifiers (our registration is owner-gated today too); the client refuses **before sending**, not after; E2EE to the attested key; salted commits |
| [Vouch](https://github.com/Oduwal/Vouch) | An AI posts a bond on its answer; disputes go to a staked jury | The deepest attestation check we saw (DCAP, RTMR0-3 replay, compose, NVIDIA signature, gateway), with raw evidence in transactions that anyone can re-check | A public key log; the check happens before a prompt leaves the browser; E2EE |
| [Charter](https://github.com/Spagero763/charter) | An AI fund with a mandate; an OutLayer guardian signs trades; on mainnet | Live on mainnet; the guardian's key derives from the wasm hash, so a new build gets a new key | The model route is verified against a public log and encrypted; (Tier 2) the policy stays private |
| [AgentGuard](https://github.com/CodeMasterLabs/agentguard) | The agent asks, an on-chain vault pays, holds or refuses; an optional TEE risk oracle | Deployed and in use, with MCP and Intents | (Tier 2) Every action needs a decision signed in the enclave, and the policy stays private; the model route is verified and encrypted |
| [Judge on NEAR](https://github.com/vijaygopalbalasa/judge-near) | A TDX judge and escrow between agents | The browser checks each run's quote and wasm hash; the contract has no keys | Private AI for people, not a verdict between agents; a public key log |
| [Black box](https://github.com/tenxagent/blackbox) | A hash-chained decision log of an agent, anchored on mainnet | The registry has no keys, so its immutability is provable | The log covers TEE keys and where an answer came from; (Tier 2) action proofs bound to a signed decision and a model proof |
| [Measure](https://github.com/dreyyyy1/measure) | Independently checks TDX quotes of NEAR's MPC nodes | A third party re-checks Intel's signature itself, without trusting the network | It covers MPC nodes and blocks nothing; we log AI model keys, and the client acts on the log |
| [PrivatePay Agent](https://github.com/Nassami1/privatepay-agent) | An invoice is redacted locally, then an agent pays through a contract with public caps | Deployed, with a large audience | The client verifies TDX and GPU evidence itself (its README lists quote verification as not implemented yet); E2EE instead of redaction; (Tier 2) a private policy |
| Dozens of spending guards (Veto, Leash, Tollgate, Claw Guard, Approval Moment, …) | Limits, a whitelist and a function-call key; an injection gets blocked | Several run on mainnet or have stronger contracts, for example a contract that builds the transaction itself | We are not another guard: (Tier 2) the point is a verifiable route from model to policy to chain, built so that someone other than the vendor can check it |

Among the 26 hackathon entries whose code we read on Nov 6, 2026, none combines a public log of TEE keys, a refusal before sending and E2EE to the attested key. We do not claim this for entries we read only from their README, or for later ones. None of them has independent verifiers writing to a public log of AI model keys, and neither do we: today only one verifier writes to our log.

## Try it (do X → see Y)

Requires Node 24+ and pnpm 10 (`corepack enable`); Rust via rustup only for `contracts/ainek`. The first block needs no key
or network; `demo:live` and the chat need `NEARAI_API_KEY` (cloud.near.ai → API Keys). Each step says what you should see.

```bash
git clone https://github.com/sadabaevb/ainek && cd ainek
cp .env.example .env             # optional: NEARAI_API_KEY only for demo:live and the chat
pnpm i
pnpm demo                        # offline replay, no key, no network (~1 s): SDK checks on recorded TDX + GPU evidence,
                                 #   fail-closed rule, two signed exchanges (plaintext, E2EE) → ✓/✗ per step, proof card,
                                 #   "Result: VERIFIED"
pnpm demo:tamper                 # same recording, the key the client sees is swapped → "Result: REFUSED", nothing is sent
pnpm demo:policy                 # offline: which code made a policy decision? A real run on OutLayer testnet is re-checked:
                                 #   Intel signed the quote, and the quote commits to the published build and to the decision
                                 #   → ✓ per check, "Result: VERIFIED". `--tamper` → "Result: REFUSED". `--live` fetches it all again
pnpm test                        # packages/proof: canonical JSON, hashing, signatures, the fail-closed rule, the recorded
                                 #   samples end to end, the on-chain entry #0 hash reproduced byte for byte

pnpm -F verifier dry-run         # no key, needs network (up to ~40 s): re-attests the model with a fresh nonce, verifies the TDX + GPU
                                 #   evidence and prints the key-log entry a registered verifier would append; sends nothing

pnpm demo:live                   # needs NEARAI_API_KEY: the same checks live from Node (chat request pinned to the attested
                                 #   gateway's TLS key), one E2EE request, proof card; --disclose <file> writes an auditor file
pnpm -F web dev                  # keeps running, use a second terminal: http://localhost:3000. The chat needs NEARAI_API_KEY
                                 #   (server-side only); /log, /verify, /auditor and /trust work without it. Send "hello" → the
                                 #   browser verifies the TEE evidence itself (a few seconds cold, longer when the attestation
                                 #   services are slow, see "Metrics"; then cached 60 min), encrypts to the attested model key,
                                 #   checks the signature and shows the proof card. Needs a log entry younger than 24 h (see
                                 #   step 1); otherwise the red "Key not in the public log" card is the expected result
```

With `pnpm -F web dev` running, at `http://localhost:3000`:

1. **See the log:** `/log` → the live log for `z-ai/glm-5.3-flash` and the trust set and quorum the client applies (today: entries by `ainek-dev-dastan.testnet` on `ainek-log-dastan.testnet`). The client trusts entries no older than 24 h: when there is no fresh entry `/log` says so ("No entry younger than 24 hours"), and the chat then refuses by design. The verifier daemon refreshes the log (entry #3 was its first run); since Nov 6 it runs on a server (docs/DEPLOY.md).
2. **Decide who you trust:** `/log`, "Who you trust" → untick the verifier and the preview says the chat would refuse; send a chat message → "Key logged only outside the trust set. Message not sent." ("See who you trust" opens the panel in a new tab, so the thread stays; "Back to the site default" undoes it). The choice stays in your browser and applies from the next message.
3. **See fail-closed:** `pnpm demo:tamper`, or tick "swap the key" in the chat (`/?tamper=1`) → "Key not in the public log. Message not sent."
4. **See the non-TEE route:** pick the Incognito model in the chat → red card "This answer went through a non-attested model" (gateway signature only; our server sees this route in plaintext, and the card says so).
5. **Re-verify a proof yourself:** "Re-verify yourself" on a card, or paste `docs/samples/disclosure.sample.json` (or a card's "Disclose to auditor" file) into `/verify` → Verify → hashes recomputed in your browser, signature checked, log entry re-read from the public log. "NEAR AI Verification Center" shows the same signature on NEAR AI's own page. Uncommitted proofs get a commit button on the card and on `/verify?id=…` (needs a testnet wallet). Connecting adds the function-call key; an account that never prepaid storage then gets a "Prepay 0.1 NEAR for storage and commit" button (one wallet dialog, 50 to 68 commits, not withdrawable); after that the key commits without a dialog, and the row shows the transaction.
6. **Audit a disclosure:** `/auditor` → "Use the sample file" → Check → the commit recomputed from salt + proof, the hashes from the disclosed bytes, the log entry re-read from the chain and compared with the file's; the "On NEAR" row asks for the account that committed, because the chain decides, not the file; enter it to look a disclosure up on-chain (the sample was never committed, it was recorded before the contract accepted commits, so any account shows that). The page says what the file does and does not prove. The sample embeds the chain's entry #0; after a contract redeploy it must be regenerated (`pnpm demo:live --disclose docs/samples/disclosure.sample.json`), or steps 5–6 end in "differs from the embedded entry".
7. **Re-check an agent's action:** `/verify` → "Use a real action proof" → Verify → a real payment from testnet, checked in your browser: the decision's signature under the key the contract recorded, the same action and status on chain, and the run's attestation (Intel's signature, the published build, this decision). The job's input and the proof's own commit show as "—": this copy has no salt, and a proof does not carry the input.

**Tier 2 flow (the agent is in `services/agent`; the contract, the policy job, the demo token and the agent account have been on testnet since Nov 6, `docs/DEPLOY.md`; one real payment went through the whole chain on Nov 6 with `pnpm -F agent once` (the model, the policy job over HTTPS with its attestation checked, the contract, the token); the Telegram bot, an approval or a denial through the service, a token refusal, and the stop button against this agent (it ran against a throwaway account on Nov 5) have not run live, so the scenes below are the plan, not a record):** Telegram "pay aibek.testnet 300 for October" → `action_executed`; "pay newguy.testnet 5000" (new vendor) → Deny; "pay aibek.testnet 3000" (over the threshold) → `NeedsApproval` → Reject; stop button (`pnpm demo:stop`): `DeleteKey` + `pause_agent` → the next proposal is refused by the network, the key no longer exists.

## Who sees what

The trust boundary from `docs/SPEC.md` §8, also shown on `/trust`. We say "our server cannot read", not "nobody can".

| Party | Sees | Does not see | Guarantee |
| --- | --- | --- | --- |
| Relay (our server) | ciphertext, size, timing, IP, API key; model id, message count and roles, token usage, completion ids | prompt, response and tool-call contents | E2EE to the model key from the verified attestation report |
| Relay on the Incognito demo route (user-chosen) | the plaintext prompt and reply | — | none (no model key to encrypt to); the red card says so |
| NEAR AI gateway and proxy | ciphertext, token accounting; the browser's IP during collateral and NRAS calls | contents | E2EE; the gateway is attested; the proxy cannot forge the NVIDIA verdict (checked against NVIDIA's keys) |
| NVIDIA key server | the browser's IP and timing of each cold verification (the SDK fetches NVIDIA's public keys directly) | anything about the exchange | public keys only; the NRAS verdict itself goes through NEAR AI's proxy |
| NEAR RPC endpoint (FastNear by default, `NEAR_RPC_URL`) | the browser's IP and the time of every log read (one per message), the model id; on a commit, `/verify` and `/auditor` also the NEAR account and the commit looked up; the signed `commit_proof` transaction, which the wallet connector broadcasts through its own FastNear endpoint (the storage deposit goes through the wallet's) | contents | none for privacy; the log read is a plain JSON-RPC view with no light-client proof, so the client trusts what the endpoint answers: a lying endpoint can pass an unlogged key or refuse a logged one, not swap in an unattested key (attestation is checked locally) |
| Model enclave | plaintext for the duration of inference | — | TDX + GPU attestation; retention inside the enclave is not provable by attestation |
| NEAR blockchain | provider keys and measurements, salted commits with the committing account and time, executed transfers (testnet); (Tier 2) proposed actions, the OutLayer job input, decisions, the policy hash | the policy contents, the conversation, the proofs | salted commits; transfer details are hidden only with Confidential Intents (out of scope) |
| OutLayer policy job (Tier 2) | the action and the policy, while computing | the conversation | TDX, decision key generated in the TEE; a WASI-P1 module with no network or disk and a reproducible build cannot retain its input (the model enclave can; this says nothing about the OutLayer worker, and the action input is public on-chain); what the OutLayer API gateway sees is still open; checking an action proof on `/verify` shows that API the browser's IP and which run |
| Agent service and Telegram (Tier 2) | the owner's messages and the agent's replies in plaintext; the service also holds the proofs and their salts | the policy contents, the owner's keys | none for privacy: ordinary server code and a messenger; what the agent can do is bounded on-chain (function-call key, TEE-signed decisions, contract checks, stop button), not eliminated |
| Auditor | one disclosed proof, its salt and the ciphertext bytes | the plaintext, the other exchanges | selective disclosure (`/auditor`) |

The "does not see" column holds for requests. For replies it holds only while no hop swapped the reply key: until the SDK
ships E2EE v3, a relay that did so could read the replies it diverted, and the card would only fail afterwards (see
"Known issues we inherited" below).

## What we do not claim

- **Verified model weights.** Attestation measures the deployment (container image digests, compose hash), not the
  weights. We say "attested deployment of model X".
- **No retention inside the model enclave.** Attestation cannot prove what NEAR AI's model enclave does with data after
  inference (its serving image is not open or reproducible). NEAR AI documents a no-store Responses API, but we use chat
  completions (needed for E2EE).
- **That nobody can read your data.** Our server cannot. The enclave can, by design, during inference.
- **Protection from the server that serves the page.** The browser code that verifies, encrypts and checks the log is served
  by the same server that relays. "Our server cannot read" holds for the code in this repo; on the hosted demo you trust that
  we serve it. `pnpm -F web dev` from a clean clone, or `pnpm demo:live`, removes that trust.
- **A measurement allowlist.** Our log is a *key* allowlist: the client sends only to a key a trusted verifier logged. The
  offline replay also compares the attested compose hash with the logged one; the browser and `demo:live` show it on the
  card and point the proof at a log entry with that compose when there is one, but still send when there is none, and the
  card says so (SPEC §7.1 asks for a refusal; enforcing it is a pending team decision), and acceptable compose hashes are not
  governed yet (next steps). Instances of a model share one signing key, so the signature alone does not say which deployment
  answered.
- **An immutable log.** "Append-only" describes the code deployed today: `log_key` only appends, and each entry hashes the
  previous one. The contract account still has a full-access key, so whoever holds it (today: us) can replace the code. A
  rewrite would show only to someone who kept an earlier `head`. `pnpm -F demo check-agent` prints how many such keys the
  account has.
- **Instant revocation.** The browser reuses a verification for up to 60 minutes and accepts a log entry up to 24 hours old;
  the log has no revoke entry yet.
- **A browser key limited to `commit_proof`.** Sign-in asks for that limit; the wallet decides what it grants. Meteor allowed
  every method of the contract, with a 0.25 NEAR gas allowance, in our Nov 5 testnet run. A function-call key still cannot attach a deposit or call
  another contract, and for an ordinary account the other methods either reject it or only read. The page keeps the key in localStorage, so a script on
  the page could use it, and Disconnect removes only that copy, not the key on the account. A contract owner or verifier account should not connect here,
  because the owner and verifier methods would accept this key.
- **Unlinkable usage.** Each commit is a transaction from your NEAR account: the chain shows who used Ainek, when and how often.
- **Hidden settlement.** On testnet the executed transfer (token, amount, receiver) is public; the conversation, the reasoning
  and the policy contents stay private. NEAR Confidential Intents could hide settlement; out of scope here.
- **A trust-minimized agent server.** (Tier 2) The agent service is ordinary code we run. It and Telegram read the owner's
  messages in plaintext; E2EE covers the hop from the service to the model, not the hop from the owner to the service. Its
  blast radius is bounded on-chain (function-call key, contract checks, TEE-signed policy decisions), not eliminated. The server
  supplies `spent_today` to the policy job, but the contract recomputes the decision's nonce from its own daily total and refuses
  a decision made for a false one. A compromised server can still leave a denied attempt out, and neither the job nor the contract
  opens the model proof: the contract checks only that this agent committed that hash, which the server supplied.
- **That the model resists prompt injection.** (Tier 2) It may or may not propose what an injected message asks. The limits
  are enforced by the policy and the contract, not by the model.
- **A policy nobody can infer.** (Tier 2) Its contents stay off-chain, but public actions and verdicts show over time who is on
  the whitelist and roughly where the thresholds sit.
- **Compliance or certification** of any kind.
- **Independence from hardware vendors.** The root of trust is Intel and NVIDIA. A compromised CPU/GPU breaks every
  guarantee here, as it does for every TEE product.
- **Side-channel protection.** Message size and timing are visible to our relay and to NEAR AI.
- **An audited contract.** The contract has unit tests and a `near-sandbox` integration test, no audit.
- **That the E2EE flag in a disclosed file is proven.** The signature covers the request and response bytes; whether those
  bytes were ciphertext is the sender's claim, and `/auditor` labels it as such.

Known issues we inherited (and say so):

- NEAR AI's E2EE route has an open reply-key-substitution finding ([nearai/cloud-api#1061](https://github.com/nearai/cloud-api/issues/1061),
  cited by the Miller registry). We pin the model key from a verified report via `X-Model-Pub-Key`, which protects the request.
  The reply key travels as an unsigned header (`x-client-pub-key`), so any hop that swapped it could read each reply it
  diverted, and the card would only fail afterwards. Upstream status, checked 2026-11-04: NEAR AI's fix is "E2EE v3" (design:
  [inference-proxy#312](https://github.com/nearai/inference-proxy/issues/312)), which binds the reply key and the field label
  into the AEAD associated data of every encrypted request field, so the proxy rejects a swapped key before inference. The
  gateway and proxy sides were merged on Oct 28 2026 ([cloud-api#1296](https://github.com/nearai/cloud-api/pull/1296),
  [inference-proxy#321](https://github.com/nearai/inference-proxy/pull/321)); v1/v2 requests keep their old, unauthenticated
  format for compatibility, and we have not checked whether production runs the new code. The SDK side
  ([inference-sdk#127](https://github.com/nearai/inference-sdk/pull/127)) is still open: SDK 0.2.1, which we use, sends
  `X-Encryption-Version: 2` (with ed25519, which we always request), so the exposure above stands for us. We will move to v3
  when the SDK ships it; if that happens before Nov 14 and a live chat shows the gateway accepting v3, the demo moves to v3.
  <!-- TODO Nov 12: re-check inference-sdk#127, the SDK version and the issue state; update the date above -->
- The Verification Center and the SDK do not ship a measurement allowlist; our log is only as good as the verifiers that
  write to it. Today the log is written by our own verifier; a verifier run by someone outside the team is planned.
  <!-- TODO by Nov 12: name/nick with consent, or the honest line "all verifiers in the demo are ours" -->

## Architecture

```
browser ── E2EE via our relay ──▶ NEAR AI gateway (TEE) ──▶ model enclave (TDX + GPU): signs sha256(request), sha256(response)
browser ── reads the key log; commits a salted hash (prepaid storage) ──▶ NEAR contract (ainek-log-dastan.testnet)
verifier(s) ── attestation report → SDK checks → KeyEntry ── log_key ──▶ NEAR contract        (daemon: services/verifier)
agent (function-call key) ──▶ OutLayer policy job (TDX) ── signed decision ──▶ contract: execute, or wait for Telegram approval
stop button: DeleteKey + pause_agent                                                                    (Tier 2)
```

- The browser does the verification itself with the NEAR AI SDK (Intel DCAP quote verification; the NVIDIA verdict fetched
  through NEAR AI's proxy and checked against NVIDIA's keys). On the attested route our relay forwards only ciphertext; on
  the user-chosen Incognito route, plaintext, and the card says so. The relay code logs no bodies; on the hosted demo that is
  taken on trust.
- The key log is a key allowlist: the client sends only to a key a trusted verifier logged (what the verifier checked is the
  verifier's claim, which is why the client re-verifies the evidence itself). The client decides whom to trust:
  `AINEK_TRUSTED_VERIFIERS` and `AINEK_QUORUM` set what the site offers, and a visitor can replace them on `/log`.
- Every attested exchange becomes a proof (`packages/proof`, SPEC §5): signature, hashes, log index, salt, commit. The commit
  is `sha256(salt ‖ canonical_json(proof without salt/commit/commitTx))`, computed in the browser; the contract stores
  only the commit. The Rust contract uses the same canonical JSON for the log's `entry_hash` (shared test vectors in
  `docs/test-vectors`).
- Replay mode (`pnpm demo`) re-runs the SDK's own verification on recorded evidence: recorded Intel collateral, the recorded
  NVIDIA verdict checked against a recorded copy of NVIDIA's keys. Freshness is not replayed, and the demo says so.
- Tier 2 interfaces: SPEC §4.3 and §6.

## Metrics

<!-- TODO by Nov 12: add the policy-block and time-to-execute rows from the Tier 2 run if it ships; re-time the browser (3 runs, Ainek's IndexedDB cache cleared, runs > 30 s apart because of the collateral proxy's cache header) and update the browser sentence below, keeping it next to the table; re-run `pnpm demo:metrics --runs 50` if the Tier 1 sequence changes before submission -->

50 runs in one sitting on Nov 6, 20:08–20:17 UTC, from one Mac with `z-ai/glm-5.3-flash`; every run's timings are in
[`docs/metrics.json`](docs/metrics.json). Nine minutes on one machine shows that the sequence holds, not how the services
behave over days.

| Metric | Value (50 runs) |
| --- | --- |
| Verified end to end | 50 of 50 |
| Swapped key refused before sending (the chat's switch, against each run's log read) | 50 of 50 |
| Honest key refused (log window empty or key unlogged) | 0 of 50 |
| Runs that needed an SDK retry | 0 of 50 |
| Attestation (gateway + model, cold, in Node) | median 5.0 s, p90 9.1 s |
| Public log read (latest_keys view on rpc.testnet.fastnear.com) | median 0.3 s, p90 0.3 s |
| E2EE round trip to the model | median 2.5 s, p90 6.3 s |
| Signature fetch | median 0.6 s, p90 1.6 s |
| First message of the hour, whole run | median 9.9 s, p90 15.0 s |
| Later message, attestation cached (derived from the same runs) | median 3.7 s, p90 7.9 s |
| Ciphertext per exchange | 293 B sent, 1103 B received |

Measured by `pnpm demo:metrics --runs N`: N runs of the Tier-1 sequence from Node 24, direct to NEAR AI (no relay), with
the evidence re-fetched and re-verified on every run (HTTP connections may be reused between runs), the public-log check with the honest and a swapped key, one E2EE exchange, the signature
and the proof. The browser is not measured by the script. In two runs on Nov 5 with nothing cached in this browser
(Ainek's IndexedDB cache cleared, page reloaded, runs more than 30 s apart because NEAR AI's collateral proxy lets the
browser cache for 29 s; the proxies' own caches may have been warm) its attestation took 3.4–3.6 s (13 s on Nov 3 with
the same cold path) and the whole first message about 9 s; a slow or retried collateral or NVIDIA verdict fetch, both
through NEAR AI's proxies in the browser, makes it longer. The browser then keeps the attestation for 60 minutes, so its
usual case is the "later message" row. The on-chain commit is measured once, not per run: `commit_proof` burnt 2.41 TGas
(0.00022 NEAR in fees) and 161 bytes of prepaid storage (0.00161 NEAR; 130 + account + kind bytes per SPEC §4.2, here a
26-character account) in
[8syaAPnB…](https://testnet.nearblocks.io/txns/8syaAPnB5FxZiC1qTjod9rfA5REThqyMFCz7jxZNPLpM). On Nov 5 the page signed
the same call in a browser connected through Meteor, with the function-call key added at sign-in and without a popup:
[FLHbBzAv…](https://testnet.nearblocks.io/txns/FLHbBzAvaBN6jkmAQ1fnuAXAaViPZkgLi1XoWnhSiDnR).

## Repository

```
apps/web/            Next.js app: chat with the proof card, /verify, /log, /auditor, /trust; byte-exact relay to NEAR AI
apps/demo/           Node 24 CLI: pnpm demo (offline replay), demo:tamper, demo:live, demo:metrics, record / check-contract scripts
packages/proof/      shared TS: proof schema, canonical JSON, hashing, signatures, fail-closed rule, chain checks, tests
packages/tier1-node/ shared TS for Node: the Tier-1 sequence (attest, log check, E2EE request, signature, proof) used by
                     demo:live, demo:metrics and the Tier 2 agent service; mirrors apps/web/lib/flow.ts
contracts/ainek/     Rust near-sdk-rs contract: key log (log_key, latest_keys, entry, entries_since, head), proof commits
                     (commit_proof, proof_commit, deposit_storage, storage_balance_of; SPEC §4.2), agents and policy
                     decisions (register_agent, propose_action, approve, reject, pause_agent; SPEC §4.3)
contracts/demo-token/ plain NEP-141 token (near-contract-standards) for the Tier 2 demo and the sandbox test
jobs/policy/         Rust OutLayer WASI-P1 job: evaluates the owner's policy, signs the decision (SPEC §6; Tier 2)
services/verifier/   daemon: attestation report → SDK checks → KeyEntry → log_key (`pnpm -F verifier start`, Dockerfile)
services/agent/      NL → NEAR AI → OutLayer → contract, Telegram bot, stop command (Tier 2): tested against fakes; one real
                     payment on testnet without Telegram (Nov 6), the bot has not run live
docs/                SPEC.md (interfaces), CLAIMS.md, DEV-NOTES.md, samples/ (recorded evidence), test-vectors/
```

Tests: `pnpm test` and `pnpm typecheck` (TypeScript, node:test: `packages/proof`, `packages/tier1-node`, `services/verifier` and `services/agent`); `cargo test` in
`contracts/ainek` (unit tests + a `near-sandbox` integration test); `pnpm -F demo check-contract` checks the deployed contract's ABI against SPEC §4.1; `pnpm -F demo check-agent` re-checks the agent's keys, funds and recorded decisions on chain.

## Disclosures

- Libraries: `@nearai/inference-sdk` 0.2.1 (attestation and signature verification, E2EE), `@hot-labs/near-connect` +
  `near-connect-hooks` (wallet), `near-api-js` 7 (RPC error types), `zod` (schemas), `tweetnacl` (ed25519), `ethers`
  (sha256, EIP-191 recovery for ecdsa signatures), `@phala/dcap-qvl` (checks the TDX quote of a policy run; with `jose`, offline replay of Intel and NVIDIA
  evidence), Next.js 16 / React 19, the Inter font self-hosted under `apps/web/public/fonts` (SIL OFL 1.1, licence
  alongside); Rust: `near-sdk` 5, `near-contract-standards` 5 (the demo token), `cargo-near`, `near-sandbox` + `near-api` (tests), `serde`.
- Copied pattern: `contracts/demo-token/src/lib.rs` wires up `near-contract-standards` the way the official
  `near-examples/FT` example does (the token logic itself is that library).
- Reference material followed (no other code copied so far; a file that copies code will say so): the `@nearai/inference-sdk`
  verification guide, `near-examples/nearai-cloud-verification-example`, `nearai/nearai-cloud-verifier`,
  `out-layer/private-dao-example` (Tier 2).
- AI-generated code: substantial parts were written with Claude Code and reviewed by the team; the TypeScript branches went
  through `/simplify` and `/code-review` before merge; see the commit history and `docs/DEV-NOTES.md`.
- Hackathon window: all code after tag `pre-hackathon` (project kit: docs, spec, prompts, no code; Nov 2 2026). Diff:
  <!-- TODO link compare pre-hackathon...hackathon-submission -->
- Other projects by the same people in this hackathon: none.

## Next steps

- A verifier anyone can run in one command (`docker run` / `npx ainek-verify`) and open verifier registration with a storage
  deposit, so the log stops depending on us.
- A revoke entry in the log and a governed allowlist of compose hashes, so the card can compare measurements, not only show them.
- A second provider in the same log (Venice): one public log for the whole private-inference industry, not one vendor.
- Image provenance via Sigstore, so "attested deployment" also says which source built it.
- Hidden settlement with NEAR Confidential Intents; the relay itself inside an attested OutLayer job.
- Integrations: Sputnik DAO and Trezu as the human approver of agent actions.

## License

MIT — see [LICENSE](./LICENSE).
