# Ainek — a public log of private-AI keys on NEAR, and agents that spend under a signed policy

> NEAR Hackathon submission (Nov 1–14, 2026). Tracks: Privacy & Private AI, AI Security & Defense, Open Innovation.

A private model on NEAR AI Cloud answers from inside a TEE, a sealed environment the hardware vouches for, and signs
with a key bound to it. The hardware proves that the enclave is genuine. It does not say that you are shown the one
everyone else is shown, nor which code runs in it: on the replica that answered us, its own record holds **five builds
of the proxy that decrypts prompts, behind one unchanged signing key, in three weeks**.

**Ainek is a public, append-only log of those keys in a NEAR contract, and a client that sends nothing to a key the
verifiers you chose did not log.** A verifier checks the hardware evidence and writes down the key and the launcher
behind it (the boot configuration the hardware measures). A key or a launcher nobody you trust has logged is refused,
before a message leaves. Verifiers also record the release that serves the model, down to a source commit; refusing a
release nobody recorded is off by default, and one switch in the chat turns it on for you. The idea is borrowed from
Certificate Transparency for web certificates. Unlike there, the writers here are not independent yet.

**For agents that spend:** the agent's key can propose a payment, not make one. A private policy (a whitelist, caps,
a threshold above which a person decides) runs inside Intel TDX, on OutLayer, and signs its decision. The contract
checks that signature, then pays, refuses or waits for the owner, and a stop button deletes the agent's key.

| The key is in the log: an answer with a proof you can re-check | The key is not: nothing is sent |
| --- | --- |
| ![The proof card: model, hardware, key in the public log, hashes, E2EE, on NEAR](docs/screenshots/proof-card.png) | ![Red card: key not in the public log, message not sent](docs/screenshots/refused.png) |

**Checked, not asserted.** 15 changes to recorded evidence are each refused for their own reason
(`pnpm demo:controls`). 50 of 50 live runs verified on Nov 13. In the 76 repositories read for our survey of this
hackathon's field we did not find, as far as the readings go, an append-only key log for several verifiers with the
choice of whom to trust left to the viewer ([docs/PRIOR-ART.md](docs/PRIOR-ART.md)).

**Limits, up front.** Testnet, not audited, and the contract account has a full-access key. Two of the three verifiers
are ours. The third we do not operate: a friend of ours runs it, with his own key, from his own GitHub account. More
under [Limits](#limits).

<!-- TODO before submission: 90-second video link. -->

## Run it (do X → see Y)

**In a browser**, at https://ainek.vercel.app (testnet). No key, no wallet.

| Do | See |
| --- | --- |
| Open [`/?tamper=1`](https://ainek.vercel.app/?tamper=1) and send any message | The client is shown a swapped key and refuses: the red card "Key not in the public log. Message not sent." |
| Open [`/log`](https://ainek.vercel.app/log), "Who you trust" | The public key log, read from the NEAR contract, and your own choice of which verifiers count: untick the trusted one and the page says "Nobody is selected, so the chat refuses every message." |
| In the [chat](https://ainek.vercel.app) tick "Stricter: send only when a verifier you trust has marked this state of the enclave", send any message | As the log stood on Nov 14: a red card, "Message not sent.", because the verifier the site trusts has written no mark for the release that runs now. On `/log` tick `anas-verifier.testnet` (the list shows when each verifier last wrote a release mark) and the same message passes that check |
| Open [`/agent`](https://ainek.vercel.app/agent), then action #4 | A real denial from testnet (5000 AINEK to a new vendor, nothing moved), re-checked in your browser. Click "Demo: change the verdict and re-check" and the signature check turns red |
| Open [`/auditor`](https://ainek.vercel.app/auditor) → "Use the sample file" → Check | "This disclosure checks out": one disclosed proof checked against its commit on NEAR, without the plaintext |

More in a browser: `/?tamper=deployment` keeps the real key and shows a launcher nobody logged → "Unknown deployment.
Message not sent."; the Incognito model in the chat → the red card "This answer went through a non-attested model";
"Re-verify yourself" on a proof card, or a disclosure file pasted into `/verify`, re-checks a proof in your browser.
Every step with all it shows: [docs/DETAILS.md](docs/DETAILS.md#in-a-browser-step-by-step).

**From a clean clone.** Node 24 or newer and pnpm 10 (`corepack enable`; `nvm use` reads the repo's `.nvmrc`; the
commands say so themselves when Node is older).

```bash
git clone https://github.com/sadabaevb/ainek && cd ainek && pnpm i

# offline, no key, a few seconds each
pnpm demo            # recorded TDX + GPU evidence and two signed exchanges, re-verified → "Result: VERIFIED"
pnpm demo:tamper     # the same recording with the key swapped → "Result: REFUSED", nothing is sent
pnpm demo:controls   # 15 changes to that evidence → "Result: REFUSED. 15 of 15 changes were refused, each for its own reason."
pnpm demo:policy     # recorded runs of the agent's policy in Intel TDX, re-checked → "Result: VERIFIED"
pnpm test            # the proof package, the recorded samples end to end, the on-chain entry #0 hash reproduced

# the network, no key
pnpm demo:attest     # 10 to 15 s: the model's evidence fetched now and verified here, its key and launcher looked up
                     #   in the log → "Result: WOULD SEND"; then the release behind the key, down to a source commit.
                     #   Nothing is sent. If Intel's service does not answer it ends "NOT CHECKED": run it again
pnpm demo:log        # about 2 s: every hash of the log's chain recomputed and compared with places of the log recorded
                     #   in this repository → "Result: the chain holds from #0 to #…, and all 3 places seen earlier
                     #   are still in it."
pnpm -F verifier dry-run  # up to 40 s: the entry a registered verifier would append; sends nothing. Ends in
                     #   `quote.collateral_unavailable` when Intel's service does not answer: run it again

# with NEARAI_API_KEY in .env (cp .env.example .env; cloud.near.ai → API Keys)
pnpm demo:live       # the same checks live from Node, one encrypted request, the proof card
pnpm demo:reply-key  # a negative control: a hop swaps the reply key in transit and must get no reply
pnpm -F web dev      # http://localhost:3000; everything before a message works without the key
```

Every command with its flags and what it needs: [docs/DETAILS.md](docs/DETAILS.md#the-commands-in-full). The hosted
chat runs on our NEAR AI key, which has a spend limit and a rate limit; if it stops answering, run it locally with
yours. Rust is needed only for `contracts/ainek` and `jobs/policy`.

**Reviewing this?** Every claim, the code behind it and a command that shows it: [docs/REVIEW.md](docs/REVIEW.md).

## What it checks

Three questions, each answered by something you can run. The first two are Tier 1 in this repository's terms, the
third is Tier 2.

1. **Is this key real?** The model's key and its launcher must be in the log, written by a verifier you trust; the
   client checks the same Intel TDX and NVIDIA evidence itself. If they are not there, nothing is sent. Which verifiers
   count, and how many must agree, is your choice on `/log`. `pnpm demo:tamper`, `pnpm demo:attest`, `pnpm demo:log`.
2. **Did this answer come from there?** The message is encrypted to that key. The signed answer is checked in the
   browser against the exact bytes, and a salted hash of the proof can be committed to NEAR. Prompts and answers never
   go on chain. `pnpm demo`, `/verify`, `/auditor`.
3. **Did the agent do only what it was allowed to?** This is the half for AI Security & Defense. The policy is private:
   the chain shows its hash, the proposed action and the signed decision, never its contents. The decision key is
   generated inside the enclave. The contract checks which key signed, not which build of the policy ran.
   `pnpm demo:policy`, `/agent`; what ran on testnet and what has not is in
   [docs/DETAILS.md](docs/DETAILS.md#the-agent-half-tier-2).

The finding on the first screen, its method and how the log records a release: [docs/RELEASE.md](docs/RELEASE.md).
Each question at full length, with screenshots: [docs/DETAILS.md](docs/DETAILS.md).

## Limits

What to know before trusting any of this. There are 26 in all, each with its reason, in
[docs/CLAIMS.md](docs/CLAIMS.md#we-do-not-claim); these five matter most.

- **Testnet, not audited, and we can replace the contract.** The contract account still has a full-access key.
- **The verifiers are not independent.** Two of the three are ours. The third is run by a friend of ours from his own
  GitHub account ([docs/DEPLOY.md](docs/DEPLOY.md)). The site trusts one of ours by default; you can change that on `/log`.
- **A log entry is not a review.** A verifier writes down what attests. Its mark for a release says "followed to
  public sources", not "approved".
- **The client does not refuse on the release by default.** The finding on the first screen is recorded in the log and
  acted on only for a visitor who turns the rule on in the chat. On Nov 13 the first mark for a new release came five
  and a half hours after it went live, and from a verifier outside the site's default trust set; the one the site trusts
  wrote none. With the rule on for everyone, the hosted chat would have refused all that time and longer
  ([docs/RELEASE.md](docs/RELEASE.md)).
- **The deployment is attested, the model is not verified.** Weights are not checked, what the enclave keeps cannot be
  proven, and the page is served by our server.

## Status

As of Nov 14, 2026.

- **The key log and the client run end to end** on testnet and on the hosted demo: the contract
  `ainek-log-dastan.testnet`, the chat with its proof card, `/verify`, `/log`, `/auditor`. Three verifiers write to the
  log, and the entries of the one we do not operate name the same key and launchers for the model as ours do.
- **The agent is on testnet:** twelve actions, all proposed by us. Seven came from the agent service with a real model
  answer, six of them through a Telegram bot on Nov 7 and 11
  ([docs/DETAILS.md](docs/DETAILS.md#the-agent-half-tier-2)).
- **Not there:** a verifier run by someone we do not know; a verifier in the site's default trust set that marks the
  current release; mainnet. What comes next: [docs/DETAILS.md](docs/DETAILS.md#next-steps).

## How NEAR is used

- **NEAR AI Cloud** serves the private model, its attestation, its signatures and the end-to-end encryption. The SDK is
  used as it is, in the browser.
- **A NEAR contract** holds the key log (hash-chained, `log_key` only appends), the salted commits of proofs, and the
  agent's actions with their signed decisions.
- **NEAR accounts and function-call keys** keep each writer narrow: a verifier needs only a key for `log_key`, the
  agent's key can only propose an action and commit a proof hash, and the browser asks the wallet for one limited to
  `commit_proof`.
- **OutLayer**, which runs jobs inside Intel TDX for NEAR contracts, runs the agent's policy and signs the decision
  with a key generated there.

What NEAR provides and what Ainek adds, layer by layer: [docs/DETAILS.md](docs/DETAILS.md#how-near-is-used). Who can see
what: [docs/DETAILS.md](docs/DETAILS.md#who-sees-what), also on `/trust`.

## Where to read more

- [docs/DETAILS.md](docs/DETAILS.md): the long version. Why, what you will see, how NEAR is used, every command, the
  agent half, who sees what, the architecture, next steps.
- [docs/CLAIMS.md](docs/CLAIMS.md): what we claim and what we do not.
- [docs/REVIEW.md](docs/REVIEW.md): every claim, the code behind it and a command that shows it.
- [docs/RELEASE.md](docs/RELEASE.md): the code behind a key, the method and what we measured.
- [docs/METRICS.md](docs/METRICS.md): 50 live runs on Nov 13 (a median of 9.8 s for a whole run), long conversations,
  long input, slow answers.
- [docs/PRIOR-ART.md](docs/PRIOR-ART.md): the neighbours in this hackathon and outside it, and where they are ahead.
- [docs/SPEC.md](docs/SPEC.md) (interfaces, in Russian), [docs/DEPLOY.md](docs/DEPLOY.md) (what is deployed where),
  [docs/ASSESSMENT.md](docs/ASSESSMENT.md) (the client against the six obligations of Private Inference Beat, an
  independent registry of private-inference providers).

## Repository

```
apps/web/            Next.js app: chat with the proof card, /verify, /log, /auditor, /agent, /trust; byte-exact relay to NEAR AI
apps/demo/           Node 24 CLI: pnpm demo (offline replay), demo:tamper, demo:controls, demo:attest, demo:log, demo:live, demo:reply-key, demo:metrics, record / check-contract scripts
packages/proof/      shared TS: proof schema, canonical JSON, hashing, signatures, fail-closed rule, chain checks, tests
packages/tier1-node/ shared TS for Node: the Tier-1 sequence (attest, log check, E2EE request, signature, proof) used by
                     demo:live, demo:metrics and the Tier 2 agent service, and up to the send, with no key, by demo:attest;
                     mirrors apps/web/lib/flow.ts
contracts/ainek/     Rust near-sdk-rs contract: the key log, the proof commits, the agent's actions and decisions
                     (the methods are in docs/SPEC.md §4)
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
  [`pre-hackathon...hackathon-submission`](https://github.com/sadabaevb/ainek/compare/pre-hackathon...hackathon-submission).
- Other projects by the same people in this hackathon: Ainek is the one we build together. Each of us also submits one
  project of his own, built apart from this one: [NearBy](https://github.com/dastansam/nearby) (Dastan) and ushak (Bektur).
  <!-- TODO before submission: the link for ushak; check that both links open without a login; drop any not submitted -->

## License

MIT — see [LICENSE](./LICENSE).
