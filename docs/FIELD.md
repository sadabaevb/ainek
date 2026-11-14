# The hackathon field: who is near us (snapshot of Nov 6 2026)

> Translated from Russian on Nov 14, 2026. The original is in this file's git history.

Source: `https://nearhackathon.com/#projects` (API `/api/projects?page=N`: name, tracks, link to the demo post), posts in X and authors' threads,
READMEs and code of the repositories, a look at the contracts on chain. On Nov 2 there were 58 entries, on Nov 6 184; the snapshots of Nov 10 (463 entries, gallery only) and Nov 13 (820 entries, post texts and code search) are at the end of the file.

**How we read.** 175 entries: the post, facts about the repository and the start of the README. The 26 nearest and strongest: by code and on chain (TEE Receipts, Measure, Veridom Pay, Throughput Treasury, Black box, Vouch, FlashFirm, PrivatePay Agent, AgentGuard, Charter, Judge on NEAR, Sealed Exploit, Redline, KeyLease, Jurat, NEAR Books, Skarbnik, Warrant, Claw Guard, Lifeguard, Writ, Release Passport, Tidepool, Quittance, NOVA Copy-Trading, Arkhe Guard). We ran nothing from other people's
repositories, did not watch the videos, did not open the demos.

## What is visible at once

- **59 of 175 entries build limits on an agent's spending** (Security: 100 entries, Agents: 93). The source is the same as on Nov 2: [the official track prompt](https://github.com/nearai/near-hackathon-prompt-examples/blob/main/tracks/06-security.md). Any
  project that sells itself as "limits + whitelist for an agent" is one of many.
- **Privacy: 27 entries, Open: 29** (as of Nov 6; on Nov 10 82 and 91, the snapshot is at the end of the file). There were far fewer people there then, and the hints of the Privacy track (Private AI, TEE, NEAR AI Cloud) match our topic.
- **Few use TEE:** 126 entries have none at all, 14 only mention it, 19 simply call NEAR AI, 11 run their own code in a TEE, 5 check the attestation themselves (an estimate from the README, corrected for those checked by code).
- **There is no direct analogue.** A public log of AI keys, refusal before the prompt is sent, and encryption to an attested key together were not done by anyone among those checked by code.
  The parts exist in different teams. Nobody has independent verifiers that write to a public log of AI keys, including us.
- **A private policy is only ours** (Tier 2: the job already works, the agent as a whole not yet). In all eight checked projects with their own code in a TEE (AgentGuard, Charter, Judge, Sealed Exploit, Redline, KeyLease, Jurat, NEAR Books) the decision logic is open, only the inputs are hidden.
- **44 entries have sections for judges.** Claude Code on the judges' side reads them first, this is already the norm.

## Nearest projects

| Project | What is done (by code and chain) | Where it is stronger than us | What they lack |
| --- | --- | --- | --- |
| [TEE Receipts](https://github.com/tmdry4530/tee-receipts) | Receipts for NEAR AI answers; a registry of signers with history; the contract itself checks the answer's signature; testnet | Raw evidence in the repository; signature check in the contract | The registry is kept only by the owner (for us registration is also with the owner so far), no hash chain; the log is not read before sending; no encryption; hashes without salt |
| [Vouch](https://github.com/Oduwal/Vouch) | The AI stakes a deposit on its answer, a jury settles disputes; testnet, 215 transactions | The deepest TEE check: DCAP, RTMR0-3, compose, NVIDIA signature, gateway; evidence in transactions, anyone can recheck it with a script | No key log; no encryption |
| [Charter](https://github.com/Spagero763/charter) | An AI fund with a mandate; a guard in OutLayer signs deals; mainnet | The key is derived from the build hash (`signing_keys`, `bind: "wasm"`); a strong story with a forged order on mainnet | The model check comes down to matching a nonce; the mandate logic is open |
| [AgentGuard](https://github.com/CodeMasterLabs/agentguard) | A vault pays, holds or refuses; a TEE risk oracle; testnet, 217 transactions | Works, MCP, Intents | The oracle is optional, the agent itself picks the context for it; the policy is open |
| [Judge on NEAR](https://github.com/vijaygopalbalasa/judge-near) | A judge in TDX and escrow | The browser checks the quote and the wasm hash of every run; the contract has no keys | No spending policy and no model |
| [Jurat](https://github.com/nftkingiii/jurat) | A threshold proof of balance; mainnet | The browser checks the whole run | No actions with money |
| [Black box](https://github.com/tenxagent/blackbox) | A hash chain of the agent's decisions; mainnet; actively pushing on Nov 6 | The contract has no keys, immutability is provable | No TEE; a log of decisions, not of keys |
| [Measure](https://github.com/dreyyyy1/measure) | Checks the TDX quotes of NEAR MPC nodes | A real third-party auditor | A snapshot, writes nothing and blocks nothing |
| [Veridom Pay](https://github.com/khrisdidukh/veridom-pay) | The contract matches the prompt and the NEAR AI signature, the verdict releases the money | The money is already tied to the model's signature | The TEE check is thin; the requests are open in transactions |
| [PrivatePay Agent](https://github.com/Nassami1/privatepay-agent) | The invoice is redacted locally, the agent pays through a contract with open limits; the most visible of the early posts | Works on testnet, wide reach | By its README the quote check is not implemented yet; the policy is open |

## Strong, outside our topic

[Skarbnik](https://github.com/pgreyy/skarbnik) (the contract itself checks a RISC Zero Groth16, bounty patches on a secret input),
[Warrant](https://github.com/emmanuelist/warrant) (options inside `intents.near`, mainnet, a contract without keys, a one-command check),
[Tidepool](https://github.com/Watchmeecryt/tidepool) (a NEAR Intents sandbox, other teams seem to use it),
[NEAR Books](https://github.com/IhorMuliar/nearbooks) (a TDX worker on mainnet, a contract without keys, a reproducible build),
[Sealed Exploit](https://github.com/edycutjong/sealed) (a bug bounty with the verdict in a TEE, payouts on chain),
[Lifeguard](https://github.com/Timidan/lifeguard) (an agent can repay a loan but not borrow: the contract builds the transaction).

## Where the field got ahead of us

| What | Who has it | What we have |
| --- | --- | --- |
| The contract cannot be swapped | Black box, NEAR Books, Judge, Warrant: 0 keys, the hash matches the build | The log contract has one full-access key, the owner is the contract itself |
| Which code made the decision | Judge, Jurat check every run; Charter derives the key from the build hash | The claims are corrected, the check of the run's attestation is in progress |
| Raw attestation reports are open | Vouch, Measure, TEE Receipts | At the verifier locally, the hash on chain |
| Code in a TEE works together with a contract on chain | All eight projects with their own code in a TEE | The job runs on OutLayer testnet; contract v3, the token and the agent on testnet are not set up yet |
| A path for the reviewer | Warrant: one command with no install | `pnpm demo` exists, no link between the claims and the code |

## What this changes in the plan

1. **An outside verifier matters most.** Nobody else has this. While one verifier makes all the entries, our log differs from an owner's registry only
   in intent. The goal: by Nov 10 the log has entries by a person outside the team.
2. **We decided not to do open registration of verifiers** (`docs/DECISIONS.md`), so everything rests on item 1. The choice of whom to trust is already with the visitor (`/log`).
3. **We do not sell ourselves as a spend guard.** First in the README, the post and the video: the answer came from an attested enclave, and the key can be checked against a public log. The agent and the limits follow from this.
4. **Claims no stronger than the code.** The check by code showed that for several projects the README promises more than is done. The reviewers will do the same to us.
5. **TEE Receipts could catch up with us in substance within a few days** if it returns to the project (no pushes since Nov 1). We say "the only ones where someone other than the provider checks" only when it becomes true.

## Snapshot of Nov 10: gallery only

Source: the same gallery API (`/api/projects?page=N`), all pages, Nov 10 at about 15:55 UTC. This time we read only
the name, the tracks and the link to the demo post. Posts in X do not open without a login, we did not look at the code and contracts of the new entries.
Everything below is by name and tracks.

| | Nov 2 | Nov 6 | Nov 8 | Nov 10 |
| --- | --- | --- | --- | --- |
| Entries in the gallery | 58 | 184 | 310 | 463 |
| AI Security & Defense | | 100 | 156 | 217 |
| Agents | | 93 | 149 | 212 |
| Open Innovation | | 29 | 49 | 91 |
| Privacy & Private AI | | 27 | 51 | 82 |

- **Entries are being added faster and faster:** +126 over Nov 6-8, +153 over Nov 8-10. Privacy grew from 51 to 82 (1.6 times against
  1.5 for the whole gallery), Open from 49 to 91 (1.9 times). Of 463 records there are 436 unique names: "AgentGuard" is recorded
  seven times, "Leash" six. These are different records; whether they are different projects is not visible from the name and tracks.
- **It is tightest in Security and Agents:** 217 entries in Security (47% of the gallery), 140 in Security and Agents at once. For
  our half about the agent and the policy this is the crowded side, as on Nov 6.
- **Privacy has many "all tracks" entries.** Of 82 entries 38 are filed in four tracks or more (46% against 15% in the
  gallery), and only 23 in one or two. 8 filed only in Privacy, three of them we know from Nov 6-8 (Sealed Ledger, Sealed
  Dossier, PredicTEE). We are in three tracks.
- **Privacy, Security and Open together are listed for 15 records**, but exactly this triple, like ours, was declared by one (Provable AI
  Compliance); the other 14 have from four to nine tracks. Among them are records named AgentGuard, Charter, Sealed
  Exploit and Veto.
- **Ainek is not in the gallery**: the form is not submitted yet, this is as planned.
- **Whom to open by hand before the submission.** A name says little, so this is "unknown, worth checking", not
  "nearest". On the topic of checking AI and proofs: Provable AI Compliance, VeilProof (Privacy), Key proof, Agent-Receipt
  (Security). On the topic "the agent signs only by policy": presign-guard for NEAR, near-threshold-guardian,
  Mandate (two records), Approval Moment. Less clear by name: RedactGate, Hushmark,
  Morrowseal, SealedBounty, SealedSwarm, cipherwork, Antibody, TAINT. Of those whose code we read on Nov 6, in the
  gallery in place are TEE Receipts, Judge on NEAR, Jurat, Measure, Black box, PrivatePay Agent, Claw Guard, Redline; of those seen on Nov 8:
  PredicTEE, Sealed Dossier, Sealed Ledger, Glassbox.
- **What this changes.** By names nothing is confirmed or refuted: the conclusion of Nov 6 ("public key log + refusal before
  sending" together was not done by anyone among those read by code) is not revised and stays with that date. That
  the key log is not visible by names does not mean that nobody has one. There are more entries, so on Nov 10 we
  made the judge's path take a minute and shortened the README; how exactly judges read, we do not know. If an
  hour is left on Nov 12-13, it is worth spending on the first two groups of names above: open the posts by hand and correct `docs/PRIOR-ART.md`,
  if any of them builds a key log.

### The same names, opened in the browser (Nov 10, evening)

17 posts from the list above were read in X from Bektur's account. For the two nearest, the README and part of the code were read, and every
claim about them below was checked against their repository in a separate pass; the others only by the post. We ran nothing.

| Entry | What it is | How close to us |
| --- | --- | --- |
| [Provable AI Compliance](https://github.com/zavodil/near-attested-ai) | A compliance gateway for a company's requests to AI: open rule packs in a NEAR registry, the rules are applied in TDX on OutLayer, the NEAR AI model call is made from there; a signed mark on every request | **Close to Tier 2.** Stronger than us: one Intel quote per run binds the gateway code, the input, the output and the caller; a registry with no edit and delete methods; one command with no key rechecks the recorded day (10 runs, 6 refusals, one forgery). Weaker than us: no key log; plain TLS up to the model, not E2EE; if the model's proofs fail the check, the answer is still issued with the mark `model_attested: true`; by default the rule questions are decided by a model outside the TEE (their README admits this); it moves no money |
| [CIPHERWORK](https://github.com/wadadawadada/cipherwork) | Private inference paid by proof: the client checks TDX (GPU if there is one) before sending, encrypts to the attested key, checks the signature; escrow pays by the verifier's signature. Two commits, both Nov 9 | **Close to Tier 1.** Refusal before sending and E2EE are there; it checks every model attestation the gateway returned. No key log: one key, the project's own verifier; it also accepts an `OutOfDate` TCB |
| SealedBounty | A bug bounty judge in the NEAR AI TEE, the contract checks the signature before the payout | A neighbour of TEE Receipts and Sealed Exploit; we did not find the repository |
| Key proof | Matches a human-written policy of the agent against its real access keys on chain, read-only | Overlaps with the agent card on `/agent` ("what its key can do"); no TEE |
| RedactGate | Cuts personal data out before a chat with AI; writes the heads of the log's hash chain into a NEAR contract | The same idea "the log cannot be rewritten", but the log is about redaction, not about keys |
| Hushmark | Checks a PR for hidden instructions to AI agents; disputed places are looked at by a model in the NEAR AI TEE | Uses a private model; the post has no key check before sending |
| TAINT | The contract checks who defined each value of a payment | A spend guard against injections |
| presign-guard, near-threshold-guardian, Mandate (two different entries), Approval Moment, Agent-Receipt | A transaction check before signing, limits, human approval | Spend guards, as on Nov 6 |
| VeilProof, Antibody, SealedSwarm, Morrowseal | An agent's solvency without revealing the wallet, a bug bounty with auto-run, sealed GPU auctions, a digital inheritance | A different topic |

**What this changes.**

1. **Refusal before sending and encryption are no longer only ours.** CIPHERWORK has it for the model, Provable AI Compliance
   for the OutLayer enclave. The phrase "the key log + refusal before sending + E2EE together nobody among the 26 has" is true with the date
   Nov 6; the README, CLAIMS and `docs/PRIOR-ART.md` now speak about these two as well. The difference of Ainek is **a public log that
   verifiers write to, and the visitor's choice of which of them to believe**. On the morning of Nov 13 both verifiers were ours; in the evening a third appeared, run by our friend (`docs/DEPLOY.md`).
2. **In Tier 2 each has its own.** Provable AI Compliance binds the gateway run with one quote and lets you recheck
   ten runs at once; our `pnpm demo:policy` since Nov 11 does such a check for six: the original and five live actions of the agent (for five without the task's input). On the other hand we are stricter about the
   model itself: the key must be in the log, encryption goes to its key, and a failed check stops the send. For
   us the policy is closed, and money moves by its decision; for them the rule packs are open, and no money moves.
3. **The submission.** The first screen of the README and the video script led with refusal before sending, that is with the common ground. Now the second line
   of the "judge's path" is the choice of trusted verifiers on `/log`, the intro names it directly, and in the script "Nobody lets you
   check" is replaced with "Few let you check": the absolute "nobody" is refuted by the neighbours.
4. **What we took from the neighbours.** Rechecking all live runs of the agent with one command was done on Nov 11 (`pnpm
   demo:policy`). Not done: checking every attestation the gateway returned, not just one.

**What happened to the plan of Nov 6** (the section "What this changes in the plan" above): there was no outside verifier by Nov 10, there will be none before
the repository opens on the 13th, and the README, CLAIMS and the header said so ("both verifiers that write to the log
are ours") until the evening of Nov 13, when a third appeared, run by our friend. The other items are done: we do not sell ourselves as a spend guard, every claim is tied to code in
`docs/REVIEW.md`, "the only ones" is written nowhere.

## Snapshot of Nov 13: the texts of all posts and a code search

Source: the same gallery API, all 103 pages, Nov 13 at about 04:00 UTC. The snapshot of Nov 12 (658 entries) was not saved,
so the comparison is with Nov 10.

**How we read.** This time not only the names:

- **The text of the demo post** for 779 of 820 entries, without logging in to X: through an open endpoint that X serves posts from
  for embedding on other people's pages (`cdn.syndication.twimg.com/tweet-result`). It serves long posts truncated
  to about 280 characters (there are 233 of them), 15 posts were deleted by their authors, for 26 entries the link leads not to a post. A link to
  GitHub is in the text of 205 posts.
- **GitHub code search** (`gh search code`) for what is only in code that NEAR AI itself checks:
  `compose_manager_attestation`, `cvm-compose-files`, `X-Encrypt-All-Fields`, `x-no-aliasing`, the package
  `@nearai/inference-sdk` in `package.json`. This found repositories that are not in the gallery yet, and projects outside the hackathon.
- **The code** of the nearest repositories; what exactly was read and by whom is said for each. We ran nothing.

| | Nov 2 | Nov 6 | Nov 8 | Nov 10 | Nov 13 |
| --- | --- | --- | --- | --- | --- |
| Entries in the gallery | 58 | 184 | 310 | 463 | 820 |
| AI Security & Defense | | 100 | 156 | 217 | 375 |
| Agents | | 93 | 149 | 212 | 354 |
| Open Innovation | | 29 | 49 | 91 | 176 |
| Privacy & Private AI | | 27 | 51 | 82 | 160 |

- **In three days the gallery grew 1.8 times**: Privacy and Open almost twofold (1.95 and 1.93 times), Security and Agents 1.7
  times. There are 772 unique names out of 820: "AgentGuard" is recorded 12 times, "Leash" 7, "Tripwire" 5.
- **Agent spending limits are still the most crowded topic.** 232 entries are filed in Security and Agents at once; words
  about limits, allowlists and injections are in 216 of the 779 posts with text (an estimate by words, not by code).
- **TEE, attestation or NEAR AI Cloud are named by 78 posts**, 47 of them in the Privacy track. Most use the enclave
  as a ready source of trust: "the answer is signed in the TEE", "the contract checked the signature".
- **Privacy has 160 entries**, of them 67 filed in four tracks or more, 45 in one or two, 15 only in Privacy. Exactly
  our triple of tracks (Privacy, Security, Open) was declared by five: Provable AI Compliance, Airlock, Shade, Asylia, whoami.
- **On Nov 13 Ainek is not in the gallery**: the form is not submitted yet.

### Countersign: the nearest neighbour

[greenlima/sealed-review](https://github.com/greenlima/sealed-review), the project is called Countersign. Found by code
search, it is not in the gallery on Nov 13; its README calls it a hackathon entry in the Privacy and Security tracks. The repository was created
on Nov 7, 12 commits, the last on Nov 12. We read the README, `METHOD.md`, parts of `watcher/` (launcher, drift, e2ee) and
`mirror/`; the contract and the GitHub Actions run logs were looked at on Nov 13. We ran nothing.

**What it is.** An independent check of NEAR AI machines before a request is sent, for the same model as ours (GLM 5.3 Flash,
directly and through the gateway). The program `watcher` (Rust) checks every machine it reached; a person signs the
result with a key on a YubiKey; the signed feed with a hash chain is mirrored into a NEAR testnet contract; the client
(`watcher gate`, `watcher ask`) reads the current verdict and sends the request only to a checked machine.

**Where it is stronger than us** (by code and chain):

- **The contract cannot be swapped.** `sealed-review-feed.testnet` has zero access keys (checked over RPC on Nov 13), and
  `contract_source_metadata` names the commit it was built from. The contract itself checks the signature of every entry and
  the chain. Our contract has one full-access key.
- **A deeper hardware check.** MRTD and RTMR0-2 are recomputed from the published OS image, not only matched against
  the event log; there are checks of the TD attributes, of a second source of Intel collateral and of NVIDIA tokens against pinned
  keys. We take the SDK's checks as they are.
- **The request does not reach an unchecked machine.** The TLS key is matched during the handshake; for us this is only from Node, in the
  browser it is impossible.
- **The evidence for every entry is published** (releases `feed-000001` ... `feed-000008` on GitHub), and the check can be
  repeated. Our reports are at the verifier, on chain there is their hash.
- **The mirror is read at two RPC providers** at the same block height; we read at one.
- **A change of code behind the key is caught publicly and every day.** `watcher drift` compares what runs on the machine with
  what the verdict recorded. The scheduled run on Nov 12 ended with the error "2 reviewed machine(s) run another
  workload than their verdict recorded". This is the same observation as ours in "code behind the key", made independently.

**What it lacks** (by its own `METHOD.md` and code):

- **Who built the image and from which source is not checked** ("Image provenance: not checked yet"). The action log is
  read, the release file, its SHA-256, the tag and the commit are recorded; they are not matched against the public repository and the build signature. We take a release down to the proxy's source commit.
- **The client does not compare the release per request** ("The gate itself does not yet compare workloads per request"). Our
  rule `AINEK_REQUIRE_RELEASE` does this, but it is off by default.
- **The response signature is not checked** ("Response signatures are not checked yet"), there is no proof per answer. We
  recompute the signature and both hashes on every answer, and the proof's salted hash goes on chain.
- **Encryption version 2** (`watcher/src/e2ee.rs`); we have version 3, where the reply key is bound to the request, and there is a live
  negative test of swapping this key.
- **One checker.** Both feed keys belong to one person, entries appear after a manual signature (eight
  entries in six days, a verdict lives three days). For us the log is designed for several verifiers, the choice and the quorum are
  with the visitor, and the entries are written by programs with no human involved. In substance the position is the same: both there and with us
  the project's author checks, and nobody has an outside person.
- **Command line only.** It needs Rust and a build of about six minutes; there is no chat, no page and no agent.
- **Both current verdicts are `warning`** (the contract's `hosts` method, Nov 13), so without the flag `--accept warning` its
  client refuses on both routes. For the route through the gateway this is a decision of the method: the client does not see which machine the gateway
  passed the request to.

### Other new neighbours

22 repositories were read on Nov 13 by reader agents (Claude) with one task: where in the code the quote is checked, in what
order the calls go, which encryption headers are set. For the four top rows of the table we then checked the key claims
ourselves against the sources; the other rows are from the readers' words. We did not look at the chain and the hosted demos, we ran nothing.

| Entry | What it is (by code) | How close to us |
| --- | --- | --- |
| [Shade](https://github.com/tookerrjobs/shade) | A registry of model signing keys in a NEAR contract: a key becomes active when `threshold` watchers approved the same measurements; before sending, the client takes three fresh reports, checks the quote (dcap-qvl, `UpToDate` only) and refuses if the key is not in the registry; the contract itself checks the answer's signature (`ecrecover`) and stores a receipt of two hashes; the reveal is checked by a static page | **The same idea as our Tier 1, and the same three tracks.** They have and we lack: the watchers' quorum is held by the contract, the answer's signature is checked on chain, a watcher itself revokes a key that changed, TLS is pinned. What they lack: encryption to the model's key (plain TLS is used) and a GPU check; the release behind the key is not traced (their `DESIGN.md` admits this), the registry is not appended to but rewritten. By their README: the gateway in the demo is fake, there is nothing on testnet, not one live NEAR AI answer was received; one commit in the repository |
| [Neslos](https://github.com/Agozie180/Neslos) | An agent's vault: the decision is made in its own TDX enclave (Phala), signed, the contract checks the signature and pays; the NEAR AI model is called through SDK 0.3.0 with E2EE | **Closest to "code behind the key".** `src/core/inference-provenance.ts` reads the action log, takes the file from `nearai/cvm-compose-files` by commit, matches its SHA-256 and checks the images' provenance with SDK functions; the accepted state is pinned in a file (commit, file, action log hash). This is a static list of the approved, not a log: there is no public key log |
| [DNA Confidential](https://github.com/indaga-ai/private-dna-reading) | The browser itself checks the model's attestation (Intel, NVIDIA, the action log bound to the quote), encrypts the summary with E2EE v3 to the model's key, checks the answer's signature; the send button opens only after the check | **The same client path as ours, without a chain.** No key log; the first attestation for a model is checked, not every one; the latest release from the action log is shown, but not traced to a repository |
| [Oathline](https://github.com/Anshv784/oathline) | The contract accepts a model key only after a quote check **on chain** (a call to `tee-verifier.testnet`), with a nonce from the contract itself; the question goes to the model through a pinned OutLayer program; the answer's signature is checked on chain | A key registry with an Intel check on chain and no owner-gatekeeper: anyone whose proofs passed can register. Entries are overwritten, no hash chain; no encryption; the answer is stored on chain |
| [TITAN EXCUBAT](https://github.com/alnitak34/titan-excubat) | A plugin that does not release the model's answer until the SDK check returned `provider_tee` | By the reader's report: a client rule "only one checked proxy commit" through the SDK's provenance functions. Everything is tested on a fake SDK, their README says so |
| [SafeRedline](https://github.com/oocoder/saferedline), [CodeCloak](https://github.com/PinnacleCryptNG/CodeCloak), [Recourse](https://github.com/devprashant19/Recourse) | A strict server-side check before sending: the gateway and **every** model attestation, for the first two also the NVIDIA token against NVIDIA keys | By the reader's report: refusal before sending is there, they check every candidate (we check the report that came back). No log (Recourse has a signer registry from the owner, only in a sandbox), no encryption, they accept `OutOfDate` too |
| [Forseti](https://github.com/whatislove666/forseti), [Psephex](https://github.com/UnityNodes/psephex), [Sealed Bench](https://github.com/jazulay/sealed-bench) | A prediction market judge, a court of three models, a sealed benchmark: the contract checks the model's signature | The signature on chain, the owner adds the keys. By the reader's report nothing is checked before sending, and in Psephex he found no attestation check code (the README says "attested with a fresh nonce"); we did not check it ourselves |
| [Blindsight](https://github.com/Prosperlinho/Blindsight), [Hindsight](https://github.com/Nnadijoshuac/hindsight), [Bursar](https://github.com/DCSteve96/Bursar), [Caesura](https://github.com/mitchuski/caesura), scrim, cloak | Apps on NEAR AI where the check does not stop the send | If the check fails the request goes anyway (Blindsight in plain text), attestation errors are swallowed, or the check runs after the answer. By the reader's report the README of Blindsight, Hindsight, Bursar and Caesura says more about checking than the code does; we did not check these six ourselves |
| [Proving Ground](https://github.com/sambitsargam/proving-ground), [Probarion](https://github.com/probarion/probarion) | Spend guards: a checker in OutLayer; vaults without keys on mainnet | By the reader's report: Proving Ground is closest in form to Tier 2, but the contract trusts the OutLayer result with no signature on the decision; Probarion has contracts without keys and without an update method |

The table has 19 repositories of the 22. Three more are NEAR AI clients without a chain, all by the reader's report:
[PipTradeDex Private Intent](https://github.com/codedforum/piptradedex) encrypts itself, with version 2, and before sending matches
only the key's binding to the report, with no quote check; [SentinelReview](https://github.com/chokri29/SentinelReview) and
[near-private-preflight](https://github.com/elsoul/near-private-preflight) check and encrypt through SDK 0.3.0.

**What others have and we lack** (after all the snapshots; the Nov 13 entries, except the four we checked, are by the reader's report):

- **A contract without keys**: Black box, NEAR Books, Judge, Warrant (snapshot of Nov 6), Countersign, Caesura, Psephex (the oracle),
  Bursar, Probarion.
- **The model's signature is checked on chain**: TEE Receipts, Veridom Pay (snapshot of Nov 6), Shade, Oathline, Forseti, Psephex,
  Sealed Bench, Recourse.
- **An Intel quote check on chain**: Oathline.
- **A quorum held by the contract**: Shade, Psephex.
- **Every attestation the gateway returned is checked**: CIPHERWORK (snapshot of Nov 10), SafeRedline, CodeCloak, Recourse,
  Neslos, Countersign.
- **Raw evidence is published**: Vouch, Measure, TEE Receipts (snapshot of Nov 6), Countersign.
- **Boot measurements are pinned or recomputed**: Countersign, Neslos.

**What we did not find in any of those read:** an appendable key log with a hash chain that several
verifiers write to, with the choice and the quorum at the visitor; release marks in such a log and a client rule on them; a closed
policy whose decision is signed in an OutLayer job and checked by the contract (Charter signs in OutLayer with an
open mandate; Neslos signs in its own enclave, and its vault checks the signature). This is said about the 23
repositories of this snapshot and the 28 read earlier, not about all 820 entries. The third item was narrowed later: see "25 more
repositories" below (Aegis, Bouncer).

### 25 more repositories: the code search to the end (Nov 13, daytime)

In the morning the search (the queries in the list above) took the first hundred results per query. In the daytime the set of queries was different and went
to the end, up to a thousand results per query. Thirteen in all:

- by code that reads the NEAR AI attestation: `compose_manager_attestation`, `model_attestations`,
  `gateway_attestation`, `"attestation/report" near`, `X-Encryption-Version`, `x-no-aliasing`,
  `"@nearai/inference-sdk"`;
- by contracts on near-sdk: `compose_hash`, `signing_address`, `register_signer`, `ed25519_verify attestation`,
  `ecrecover attestation`, `request_execution outlayer`.

Together they gave 383 repositories, 86 of them created on Oct 19 or later. The 25 we had not read yet were read by a
reader agent (Claude) from clones, with the same task as in the morning. We ran nothing. We did not check its report against the sources,
except two rows, Aegis and Bouncer: we opened those ourselves afterwards, because a README correction relies on them. Not all
25 are in the gallery: drouter was submitted to another hackathon, recordless-mobile and near-ai-vscode do not mention a hackathon.

| Repository | What it is (by the report) | How close to us |
| --- | --- | --- |
| [nymiralabs/nymira](https://github.com/nymiralabs/nymira) | Prepaid NEAR AI credits as ZK notes in a vault on NEAR; the chat is encrypted to the model's attested key | Closest by client: the TDX quote is checked in the browser (dcap-qvl in WASM), on failure nothing is encrypted and nothing is sent, encryption version 2. No log on chain: the trust anchor is one policy file with measurements and compose hashes (not keys), signed by the team's key; a watcher re-signs it every 10 minutes. The release is not traced |
| [iamdflame/priced-in](https://github.com/iamdflame/priced-in) | Prediction markets on mainnet, three jurors on NEAR AI | The model key is recorded in the contract (`register_model`: written by the owner, one key per model, overwritten). The contract itself builds the request and checks the NEAR AI signature over it. The contract reads the registry at the verdict, not the client before sending |
| [thisisjoshford/recordless-mobile](https://github.com/thisisjoshford/recordless-mobile) | A meeting notes app for iOS, the core in Rust | The only one of the 25 that goes by the action log: checks the manager's second quote, replays the log, takes files from `nearai/cvm-compose-files` at the recorded commit and accepts only with the sha256 that the enclave signed; then on to the weights revision and the image digests. It does not go to the tag, the build signature and the source commit. No chain, no E2EE encryption (binding to the TLS key) |
| [dcablorh/Aegis](https://github.com/dcablorh/Aegis) (checked by us, commit `41e9c6a`) | A vault that saves a Burrow loan from liquidation | Closest on the agent side. The policy is kept in the contract as a commitment and a ciphertext; the contract itself calls an OutLayer job and checks the Ed25519 signature on the decision (`rescue.rs`). The job reads the signing key from an OutLayer secret (`AEGIS_SIGNING_KEY_HEX`), and the "attestation" the contract matches is a string that the job reports about itself, `unattested-local` by default. There is no human approval: the keeper account executes |
| [AduAkorful/bouncer](https://github.com/AduAkorful/bouncer) (checked by us, commit `6cdf602`) | A guard in an OutLayer enclave matches an invoice against a closed ledger and signs a verdict | The contract checks the guard's signature against a key recorded for each vault (`verdict.rs`). The guard signs with a key held by the OutLayer platform (`outlayer::signing_keys::sign` in `guard/src/main.rs`) and does not read it itself: on the key we claim no difference from us. The payout is taken by the winner with their own signature after a delay (`claim`); there is no human approval before execution |
| [plavutskyi/mask-wars](https://github.com/plavutskyi/mask-wars), [zakyirsyaad/foundling](https://github.com/zakyirsyaad/foundling) | Closed material in OutLayer: a judge's test set, strategy parameters | The contract calls OutLayer and trusts the answer: it does not check the signature |
| [leomanza/delibera.xyz](https://github.com/leomanza/delibera.xyz) | A jury of several agents for a DAO | OutLayer as the agent's wallet: OutLayer itself applies the policy, the contract does not check the signature. The NEAR AI attestation is checked after the answer |
| [thepigdestroyer/drouter](https://github.com/thepigdestroyer/drouter) | A router to Tinfoil enclaves on the Arc test network (EVM); submitted to another hackathon | A registry of node measurements that several checkers from the owner's list write to; a checker's new result replaces the previous one, the events remain; the browser reads the registry before sending. An unavailable registry gives "skipped", not a refusal; the quorum is called a simulation in the code: all keys are on the demo server |
| [dhairya-pandya/sieve](https://github.com/dhairya-pandya/sieve), [Techkeyy/secondeyes](https://github.com/Techkeyy/secondeyes), [dev-doji/beeline-relay](https://github.com/dev-doji/beeline-relay), [HuRiKh4n/robinhoot-kingdom](https://github.com/HuRiKh4n/robinhoot-kingdom) | The contract checks the signature of a reviewer or judge model | The owner writes the key in the contract: one key or a list without history (in sieve keys accumulate, each with an expiry). The contract reads it, not the client |
| [EndPx/proofbill](https://github.com/EndPx/proofbill), [apexweb-adam/leash](https://github.com/apexweb-adam/leash) | Buying an AI result; a page judge | The attestation check before the request, on the server, with no log and no E2EE. ProofBill has salted commitments on chain and payment after human approval |
| [Mramaran/termwork](https://github.com/Mramaran/termwork), [VitalPointAI/near-ai-vscode](https://github.com/VitalPointAI/near-ai-vscode), [ryan-tobin/blindfold](https://github.com/ryan-tobin/blindfold), [dylantlwu/baitnet](https://github.com/dylantlwu/baitnet), [Victork19/swarm-for-hire](https://github.com/Victork19/swarm-for-hire), [nisargpatel7042lva/vouch](https://github.com/nisargpatel7042lva/vouch), [topmember-build/plumbline](https://github.com/topmember-build/plumbline) | Various | A check after the answer, a binding only with no quote, or only the presence of fields. This vouch is not the Vouch from the table of the nearest |
| [Pradeeppilotdev/countersign](https://github.com/Pradeeppilotdev/countersign), [hey-research-lab/proof-of-ship-near](https://github.com/hey-research-lab/proof-of-ship-near), [jcarbonnell/nova](https://github.com/jcarbonnell/nova) | Sellers' invoices; escrow; its own vault in a TEE | No overlap. This countersign is not the Countersign from the section above |

What follows from this:

1. **A log like ours, by the report, nobody among the 25 has.** A model key in a contract is held by five: priced-in, sieve,
   secondeyes, beeline-relay, robinhoot-kingdom. Closest to the log itself is drouter, and it is not about NEAR.
2. **The third "not found" item is narrowed.** A decision signed in an OutLayer job with a closed policy and checked by the
   contract is in Aegis; Bouncer is close to this. What we have beyond Aegis: the decision key is born inside the enclave; there it
   is set by the owner as an ordinary secret. In neither does the action wait for human approval. The first two items are true
   for all 76 repositories, as far as they were read; the third only for the first 51.
3. **To those who go by the action log** (Neslos from the table above and the projects of the "Outside the hackathon" section below), recordless-mobile is added.
   It reaches the weights revision, we reach the proxy's source commit.
4. **What is stronger at the neighbours and is not being done before the submission:** a quote check right in the browser, without the NEAR AI proxy (nymira);
   an answer signature checked by the contract over a request it built itself (priced-in).

### Earlier rows: what changed since Nov 6 and 10

A reader agent checked against the code, as of Nov 13, every claim of ours about four old neighbours. All remained true.

- **TEE Receipts:** no commits since Nov 1. The registry is written only by the owner, no hash chain, the log is not read before
  sending, no encryption and no salt.
- **CIPHERWORK:** the same two commits of Nov 9. A clarification: its encryption is version 2 (SDK 0.1.0 in the lock file).
- **Provable AI Compliance:** 12 commits over Nov 11-12, all in the README, the browser checker and the report pages;
  the module in the enclave and the registry did not change. Still: no key log, TLS up to the model, a failed check of the
  model's proofs does not stop the answer with the mark `model_attested: true`, the rule questions are by default decided
  by a model outside the TEE. Its README now names the second entry by the same author.
- **Vouch:** no commits after Nov 6.
- **Attested Arena** ([zavodil/attested-arena](https://github.com/zavodil/attested-arena), the second entry by the author of Provable
  AI Compliance, seven commits on Nov 12): a competition of models on closed tasks, the judge in OutLayer. No key log
  and no encryption; the tasks go to the model before its proofs are checked (`judge/src/main.rs`), on failure the result
  is simply not signed.
- **Next to Tier 2, outside the gallery:** [zavodil/offchain-smart-contract](https://github.com/zavodil/offchain-smart-contract)
  by the same author (created Nov 11). The contract calls a judge in OutLayer pinned by the build hash, checks the
  verdict's signature on chain (`ed25519_verify`) and pays, refuses or hands over to people. This is the form of our Tier 2.
  The difference by its README: the rules there are open (packs in a public registry), the input is closed; for us the policy is closed and
  the action's arguments are open.

### Outside the hackathon: the NEAR AI action log is already being read

On Nov 12 we wrote that the deployment check does not see the release behind the key, and started reading the enclave's action log. A code
search showed that several projects have been doing this since September-October and refuse by it. Read by a reader agent;
the Brave README, the attestation check in its gateway and the Quill review of Nov 12 we opened ourselves.

| Project | What it does with the action log | Who decides what is approved |
| --- | --- | --- |
| [Brave near-verifier](https://github.com/brave/near-verifier) and the Leo gateway | Every file from the log is taken from `nearai/cvm-compose-files` by commit and matched by SHA-256; NEAR images are checked by the build signature **and by a rebuild from source**; the Brave gateway lets a model through only if each of its signing keys is registered, and with the setting `VERIFY_NEAR_COMPOSE_SEQUENCE` also if after the last approved state of the log there is no release without a mark (whether the setting is on at their side is not visible) | Brave. The marks are in its S3 storage; the README calls them "an access gate, not a log" |
| [Quill Cloud](https://github.com/Lore-Hex/quill-cloud-proxy) (TrustedRouter) | Pins the hash of the whole action history; any added action closes the route until a new human review. The review of Nov 12 approved the replica `19aea169…` with the launcher `c900dc73…`, the release file `2d10ba2c…` (v0.0.567) and the history `e196ae72…` of 271 actions. The same three values stand in the marks of our entries #73 and #74 of Nov 12: two readings of one log matched down to the hash | Quill, in a public repository: a policy file and dated reviews |
| [AnonRouter](https://github.com/anonrouter/confidential-content-plane) | Every log file must be in a published commit of the NEAR repository with the same SHA-256; it does not check the images' provenance | Nobody: any release that NEAR published is accepted |
| [Hermes confidential mode](https://github.com/ainsleys/hermes-confidential-mode) | The whole service map of the replica, files matched by commit and SHA-256; a changed build gets a refusal | The user, in a local list |
| [teemoon audits](https://github.com/teemoonai/audits) | Source reviews for each image, release file and OS image, with a verdict; the app shows a link to the review only if exactly the reviewed build is running | The reviews' authors, in a public repository |
| [teep](https://github.com/13rac1/teep), [Morse](https://github.com/trymorse/morse-enclave), Trace Commons, Salomon | The log is parsed or bound to the quote; not taken to the sources | Lists built into the program, or local ones |

- **A refusal on a code change behind the same key is not our find.** Brave, Quill and Hermes do it before us. The Quill review
  of Nov 12 notes the same as our log: under the model's name a shared machine of small models also answers
  (launcher `e8416a02…`), and NEAR rolled out releases four times that day.
- **For each of them the approval is the list of one operator or one user.** A public log that several verifiers
  write to and by which the client itself chooses whom to believe, the reader agent found in nobody;
  nor waits before trusting a new state.
- **A registry by which providers are judged** (Private Inference Beat): by the scores file the agent read, the score
  of the NEAR AI route "E2EE through gateway" has not changed since Oct 14, and there is one entry of the "gap" level in it: the session,
  swapping the reply key (#1061).

### Proxies already exist

- [Yaasha/near-e2ee-proxy](https://github.com/Yaasha/near-e2ee-proxy): a local proxy with an OpenAI interface, the
  SDK check before sending, encryption version 2. 20 commits until Nov 1, quiet after that.
- [teep](https://github.com/13rac1/teep): the same for several providers, with built-in lists of measurements; active.
- NEAR has its own local proxy (`nearai/ironwire`), without encryption and with a check after the answer.

None of them matches against a public log. A local proxy "check, encrypt, refuse" would not be new; only
the log as a source for such proxies would be new.

**Encryption versions in the clients read.** Version 3, where the reply key is bound to the request: Ainek, DNA Confidential,
Neslos, SentinelReview, near-private-preflight. Version 2: Countersign, CIPHERWORK, teep, near-e2ee-proxy, Hermes, Morse.

### What this changes

1. **Say not "we found that the code behind the key changes", but "where the approval lives".** A change of code behind the key is seen by Brave,
   Quill, the Hermes plugin, Countersign. Ours is a public log that several verifiers write to, the choice and the quorum at the visitor, and
   release marks in this log. The README and CLAIMS now say exactly this.
2. **A person from outside with a verifier remains the main thing.** At Countersign, Shade and with us the authors themselves check.
   We found entries by an outside verifier in none of the 51 repositories read.
3. **The key on the contract's account became more noticeable.** The nearest neighbour has a contract without keys, and four more entries.
   The decision of Nov 8 (not to lock before the submission) was made by Dastan; whether to revisit it is for him to decide.
4. **We do not make a proxy for novelty:** two already exist.
5. **The release rule stays off**, now with a measurement: on Nov 13 the mark for a replica came 5 hours 28
   minutes after the release, and only from the second verifier (`docs/DEV-NOTES.md`).

Links to the list of entries and the track prompts: `docs/LINKS.md`.
