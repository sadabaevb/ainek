# Ainek — a public log for the keys of private AI, on NEAR

> NEAR Hackathon submission (Nov 1–14, 2026). Tracks: Privacy & Private AI, AI Security & Defense, Open Innovation.

A private model on NEAR AI Cloud answers from inside a TEE, a sealed environment the hardware vouches for, and signs
with a key bound to it. The key does not say which code runs behind it. In NEAR AI's own public evidence we watched
**five builds of the code run behind one signing key in three weeks**, and releases go live a median of 12 minutes
after their commit. The key did not change once.

**Ainek is a public, append-only log of those keys in a NEAR contract, and a client that sends nothing when the key is
not in it.** Verifiers check the hardware evidence and write down what they saw: the key, the launcher behind it (the
boot configuration the hardware measures) and, when they can follow it, the release that serves the model, down to a
source commit. It is to private AI what Certificate Transparency is to web certificates.

**Why a log, when the client checks the hardware itself?** The hardware proves that a genuine enclave holds the key.
It does not say that this is the enclave everyone else is shown, or that anyone has looked at what runs in it, and
NEAR AI publishes no list of measurements to compare with. The log is the public record of which keys and launchers
verifiers saw, and when. A client can then require that someone it trusts saw exactly this one: an enclave shown to
you alone is refused.

| The key is in the log: an answer with a proof you can re-check | The key is not: nothing is sent |
| --- | --- |
| ![The proof card: model, hardware, key in the public log, hashes, E2EE, on NEAR](docs/screenshots/proof-card.png) | ![Red card: key not in the public log, message not sent](docs/screenshots/refused.png) |

**The limits, up front:** testnet and not audited; two of the three verifiers are ours and the third is a friend's; the
contract account has a full-access key; the rule that refuses an unchecked release is written and off by default.
Each is spelled out under [Limits](#limits).

<!-- TODO before submission: 90-second video link. -->

## See it in a minute

No key, no wallet, nothing to set up.

**In a browser**, at https://ainek.vercel.app (testnet):

| Do | See |
| --- | --- |
| Open [`/?tamper=1`](https://ainek.vercel.app/?tamper=1) and send any message | The client is shown a swapped key and refuses: the red card "Key not in the public log. Message not sent." |
| Open [`/log`](https://ainek.vercel.app/log), "Who you trust" | The public key log, read from the NEAR contract, and your own choice of which verifiers count: untick the trusted one and the page says "Nobody is selected, so the chat refuses every message." |
| Open [`/agent`](https://ainek.vercel.app/agent), then action #4 | A real denial from testnet (5000 AINEK to a new vendor, nothing moved), re-checked in your browser. Click "Demo: change the verdict and re-check" and the signature check turns red |
| Open [`/auditor`](https://ainek.vercel.app/auditor) → "Use the sample file" → Check | "This disclosure checks out": one disclosed proof checked against its commit on NEAR, without the plaintext |

**From a clean clone** (Node 24+ and pnpm 10: `corepack enable`, or `npm i -g pnpm@10` where Node ships without corepack; `nvm use` reads the repo's `.nvmrc`, and the root `pnpm demo…`, `pnpm test` and `pnpm typecheck` commands say so when
Node is older). The three commands are offline, about a second each:

```bash
git clone https://github.com/sadabaevb/ainek && cd ainek && pnpm i
pnpm demo            # recorded TDX + GPU evidence and two signed exchanges, re-verified → "Result: VERIFIED"
pnpm demo:tamper     # the same recording with the key swapped → "Result: REFUSED", nothing is sent
pnpm demo:policy     # recorded policy runs on OutLayer, the agent's seven live actions among them: Intel's quote, the
                     #   published build, the decision → "Result: VERIFIED"
```

Two more, live and still with no key (they need the network; 10 to 15 seconds and about 2):

```bash
pnpm demo:attest     # the model's evidence fetched now and verified here (Intel TDX, NVIDIA GPU), its key and launcher
                     #   looked up in the log on NEAR → "Result: WOULD SEND", or "WOULD REFUSE" when the log does not have
                     #   them; then the code behind the key, from the enclave's own action log to a source commit on
                     #   GitHub. It stops before a message exists: nothing is encrypted, sent or signed
pnpm demo:log        # the whole key log read from the contract and every hash of its chain recomputed here, then
                     #   compared with the places of the log recorded in this repository → "Result: the chain holds
                     #   from #0 to #86, and all 3 places seen earlier are still in it." (the first number grows with the log)
```

The hosted chat runs on our NEAR AI key, which has a spend limit and a rate limit. If it stops answering, run it locally
with your own key: [Try it](#try-it-do-x--see-y).

**Reviewing this?** Every claim, the code behind it and a command that shows it: [docs/REVIEW.md](docs/REVIEW.md).
What must be refused, and is: `pnpm demo:controls` (offline, no key) changes the recorded evidence in 15 ways and each one
has to fail; [docs/ASSESSMENT.md](docs/ASSESSMENT.md) puts the client through the six obligations of Private Inference Beat.

## What it checks

Three questions, each answered by something you can run.

1. **Is this key real?** The model's key and its launcher must be in the log, written by a verifier you trust; the
   client checks the same Intel TDX and NVIDIA evidence itself. If they are not there, nothing is sent. Which verifiers
   count, and how many must agree, is your choice on `/log`. `pnpm demo:tamper`, `pnpm demo:attest`, `pnpm demo:log`.
2. **Did this answer come from there?** The message is encrypted to that key. The signed answer is checked in the
   browser against the exact bytes, and a salted hash of the proof can be committed to NEAR. Prompts and answers never
   go on chain. `pnpm demo`, `/verify`, `/auditor`.
3. **Did the agent do only what it was allowed to?** This is the half for AI Security & Defense. The agent's key can
   propose a payment, not make one. A private policy is evaluated inside Intel TDX, on OutLayer, and the decision is
   signed there; the contract checks that signature, then pays, refuses or waits for a person, and a stop button
   deletes the key. The contract checks which key signed, not which build of the policy ran. `pnpm demo:policy`,
   `/agent`; what ran on testnet and what has not is in [docs/DETAILS.md](docs/DETAILS.md#the-agent-half-tier-2).

The release behind a key, the finding above and how the log records it: [docs/RELEASE.md](docs/RELEASE.md). Each
question at full length, with screenshots: [docs/DETAILS.md](docs/DETAILS.md).

## Limits

What to know before trusting any of this. There are 26 in all, each with its reason, in
[docs/CLAIMS.md](docs/CLAIMS.md#we-do-not-claim); these five matter most.

- **Testnet, not audited, and we can replace the contract.** The contract account still has a full-access key.
- **The verifiers are not independent.** Two of the three are ours. The third is run by a friend of ours, from his own
  GitHub account ([docs/DEPLOY.md](docs/DEPLOY.md)). The site trusts one of ours by default; you can change that on `/log`.
- **A log entry is not a review.** A verifier writes down what attests. Its mark for a release says "followed to
  public sources", not "approved".
- **The rule that refuses an unchecked release is off by default.** On Nov 13 a mark came five and a half hours after a
  release went live, and with the rule on the chat would have refused all that time ([docs/RELEASE.md](docs/RELEASE.md)).
- **The deployment is attested, the model is not verified.** Weights are not checked, what the enclave keeps cannot be
  proven, and the page is served by our server.

## Status

As of Nov 14, 2026.

- **The key log and the client run end to end** on testnet and on the hosted demo: the contract
  `ainek-log-dastan.testnet`, three verifiers writing to it, the chat with its proof card, `/verify`, `/log`, `/auditor`.
- **The agent is on testnet:** twelve actions, all proposed by us, seven of them by the agent service with a real model
  answer, through a Telegram bot on Nov 7 and 11 ([docs/DETAILS.md](docs/DETAILS.md#the-agent-half-tier-2)).
- **Releases:** verifiers mark the release they followed, and the client shows it and can refuse on it.
- **Not there:** a verifier run by someone we do not know; the contract lock; mainnet. What comes next:
  [docs/DETAILS.md](docs/DETAILS.md#next-steps).

## How NEAR is used

- **NEAR AI Cloud** serves the private model, its attestation, its signatures and the end-to-end encryption. The SDK is
  used as it is, in the browser.
- **A NEAR contract** holds the key log (hash-chained, `log_key` only appends), the salted commits of proofs, and the
  agent's actions with their signed decisions.
- **NEAR accounts and function-call keys** keep each writer narrow: a verifier needs only a key for `log_key`, the
  agent's key can only propose an action and commit a proof hash, and the browser asks the wallet for one limited to
  `commit_proof`.
- **OutLayer** runs the agent's policy inside Intel TDX and signs the decision with a key generated there.

What NEAR provides and what Ainek adds, layer by layer: [docs/DETAILS.md](docs/DETAILS.md#how-near-is-used). Who can see
what: [docs/DETAILS.md](docs/DETAILS.md#who-sees-what), also on `/trust`.

## Try it (do X → see Y)

Clone and install as in [See it in a minute](#see-it-in-a-minute). Rust is needed only for `contracts/ainek` and
`jobs/policy`, Docker only for the reproducible builds ([docs/REVIEW.md](docs/REVIEW.md)).

```bash
# offline, no key
pnpm test                # the proof package, the recorded samples end to end, the on-chain entry #0 hash reproduced
pnpm demo:controls       # 15 changes to the recorded evidence, each must be refused for its own reason
                         #   → "Result: REFUSED. 15 of 15 changes were refused, each for its own reason."

# network, no key
pnpm demo:attest         # 10 to 15 s → "Result: WOULD SEND"; --history adds every release in the enclave's log.
                         #   If Intel's service does not answer it ends "NOT CHECKED": run it again
pnpm demo:log            # about 2 s; --seen <index>:<entry hash> compares the log with a place you kept
pnpm -F verifier dry-run # up to 40 s: the entry a registered verifier would append; sends nothing

# with NEARAI_API_KEY in .env (cp .env.example .env; cloud.near.ai → API Keys)
pnpm demo:live           # the same checks live from Node, one encrypted request, the proof card
pnpm demo:reply-key      # a negative control: a hop swaps the reply key in transit and must get no reply
pnpm -F web dev          # http://localhost:3000; everything before a message works without the key
```

In a browser, at https://ainek.vercel.app or on the local server:

1. **See the log:** `/log` → the live log and the trust set the client applies.
2. **Decide who you trust:** `/log`, "Who you trust" → untick the verifier → the chat refuses: "Key logged only outside
   the trust set. Message not sent."
3. **See fail-closed:** `/?tamper=1` swaps the key; `/?tamper=deployment` keeps the key and shows a launcher nobody
   logged → "Unknown deployment. Message not sent."
4. **See the non-TEE route:** pick the Incognito model → red card "This answer went through a non-attested model".
5. **Re-verify a proof:** "Re-verify yourself" on a card, or paste a disclosure file into `/verify`.
6. **Audit a disclosure:** `/auditor` → "Use the sample file" → Check → "This disclosure checks out".
7. **Re-check an agent's action:** `/agent` → action #4 → a real denial from testnet, re-checked in your browser.

Each step with everything it shows: [docs/DETAILS.md](docs/DETAILS.md#in-a-browser-step-by-step).

## Where to read more

- [docs/DETAILS.md](docs/DETAILS.md): the long version. Why, what you will see, how NEAR is used, the agent half, who
  sees what, the architecture, next steps.
- [docs/CLAIMS.md](docs/CLAIMS.md): what we claim and what we do not.
- [docs/REVIEW.md](docs/REVIEW.md): every claim, the code behind it and a command that shows it.
- [docs/RELEASE.md](docs/RELEASE.md): the code behind a key, the method and what we measured.
- [docs/METRICS.md](docs/METRICS.md): 50 live runs on Nov 13 (50 of 50 verified, a median of 9.8 s for a whole run),
  long conversations, long input, slow answers.
- [docs/PRIOR-ART.md](docs/PRIOR-ART.md): the neighbours in this hackathon and outside it, and where they are ahead.
- [docs/SPEC.md](docs/SPEC.md) (interfaces, in Russian), [docs/DEPLOY.md](docs/DEPLOY.md) (what is deployed where),
  [docs/ASSESSMENT.md](docs/ASSESSMENT.md) (the client against the six obligations of Private Inference Beat).

## Repository

```
apps/web/            Next.js app: chat with the proof card, /verify, /log, /auditor, /agent, /trust; byte-exact relay to NEAR AI
apps/demo/           Node 24 CLI: pnpm demo (offline replay), demo:tamper, demo:controls, demo:attest, demo:log, demo:live, demo:reply-key, demo:metrics, record / check-contract scripts
packages/proof/      shared TS: proof schema, canonical JSON, hashing, signatures, fail-closed rule, chain checks, tests
packages/tier1-node/ shared TS for Node: the Tier-1 sequence (attest, log check, E2EE request, signature, proof) used by
                     demo:live, demo:metrics and the Tier 2 agent service, and up to the send, with no key, by demo:attest;
                     mirrors apps/web/lib/flow.ts
contracts/ainek/     Rust near-sdk-rs contract: key log (log_key, latest_keys, entry, entries_since, head), proof commits
                     (commit_proof, proof_commit, deposit_storage, storage_balance_of; SPEC §4.2), agents and policy
                     decisions (register_agent, propose_action, approve, reject, pause_agent; SPEC §4.3)
contracts/demo-token/ plain NEP-141 token (near-contract-standards) for the Tier 2 demo and the sandbox test
jobs/policy/         Rust OutLayer WASI-P1 job: evaluates the owner's policy, signs the decision (SPEC §6; Tier 2)
services/verifier/   daemon: attestation report → SDK checks → KeyEntry → log_key (`pnpm -F verifier start`, Dockerfile)
services/agent/      NL → NEAR AI → OutLayer → contract, Telegram bot, stop command (Tier 2): tested against fakes,
                     run on testnet through the bot on Nov 7 (docs/DETAILS.md, "The agent half")
docs/                see "Where to read more" above; samples/ (recorded evidence), test-vectors/
```

Tests:

- `pnpm test`, `pnpm typecheck`: TypeScript (node:test) in `packages/proof`, `packages/tier1-node`, `services/verifier`, `services/agent`, `apps/web`
- `contracts/ainek`: `cargo near build non-reproducible-wasm` builds it; `cargo test` runs unit tests and a `near-sandbox` integration test
- `jobs/policy`: `cargo test`
- `pnpm -F demo check-contract`: the deployed contract's ABI against SPEC §4.1, the hash of every entry included
- `pnpm -F demo check-agent`: the agent's keys, funds and recorded decisions on chain

## Disclosures

- Libraries: `@nearai/inference-sdk` 0.3.0 (attestation and signature verification, E2EE), `@hot-labs/near-connect` +
  `near-connect-hooks` (wallet), `near-api-js` 7 (RPC error types), `zod` (schemas), `tweetnacl` (ed25519), `ethers`
  (sha256, EIP-191 recovery for ecdsa signatures), `@phala/dcap-qvl` (checks the TDX quote of a policy run; with `jose`, offline replay of Intel and NVIDIA
  evidence), Next.js 16 / React 19, the IBM Plex fonts (Sans, Serif, Mono) self-hosted under `apps/web/public/fonts`, copied from
  `@fontsource/ibm-plex-*` 5.3.0 (SIL OFL 1.1, licences alongside); Rust: `near-sdk` 5, `near-contract-standards` 5 (the demo token), `cargo-near`, `near-sandbox` + `near-api` (tests), `serde`.
- Copied pattern: `contracts/demo-token/src/lib.rs` wires up `near-contract-standards` the way the official
  `near-examples/FT` example does (the token logic itself is that library).
- Read at run time, with no code copied: Countersign's feed contract on NEAR testnet, Quill Cloud's policy file and
  teemoon's review pages on GitHub ("Who else has looked at exactly this" in `docs/RELEASE.md`). Two feed entries, two pins and the first lines
  of one review page are recorded under `docs/samples/outside` for the tests.
- Reference material followed (no other code copied so far; a file that copies code will say so): the `@nearai/inference-sdk`
  verification guide, `near-examples/nearai-cloud-verification-example`, `nearai/nearai-cloud-verifier`,
  `out-layer/private-dao-example` (Tier 2).
- AI-generated code: substantial parts were written with Claude Code and reviewed by the team; the TypeScript branches went
  through `/simplify` and `/code-review` before merge; see the commit history and `docs/DEV-NOTES.md`.
- Hackathon window: all code after tag `pre-hackathon` (project kit: docs, spec, prompts, no code; Nov 2 2026). Diff:
  <!-- TODO link compare pre-hackathon...hackathon-submission -->
- Other projects by the same people in this hackathon: Ainek is the one we build together. Each of us also submits one
  project of his own, built apart from this one: nearby (Dastan) and ushak (Bektur).
  <!-- TODO before submission: links and exact spelling of both names; drop any not submitted -->

## License

MIT — see [LICENSE](./LICENSE).
