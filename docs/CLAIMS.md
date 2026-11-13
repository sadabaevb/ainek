# CLAIMS.md — what we claim, what we do not (the README lists the titles of the second part and points here)

Judges on this panel have audited TEE products and read the two independent registries that rate
every private-inference provider at "stage 0". Overclaiming costs more than a missing feature.
Honest limitations won prizes at previous NEAR hackathons.

## We claim

- The model runs in an **attested deployment** on NEAR AI Cloud (Intel TDX + NVIDIA confidential GPU).
  The client verifies the TDX quote and the GPU attestation itself (browser SDK; the NVIDIA verdict is fetched through
  NEAR AI's proxy and checked against NVIDIA's keys) and checks the signing key against a **public, append-only log on
  NEAR** written by verifiers (today: three, two of them ours and one run by a friend of ours since Nov 13; the log is designed for independent verifiers). If the key is not in the
  log, or (since Nov 11) is not logged together with the compose hash the client attested (the hash of the enclave's launcher: see "We do not claim"), the client refuses to send. Which verifiers count, and how many must agree, is the viewer's choice on `/log`; the site
  only sets the default.
- Among the 26 hackathon entries whose code we read on Nov 6, 2026 (`docs/FIELD.md`), none combines a public log of TEE keys, a
  refusal before sending and E2EE to the attested key. We do not claim this for entries we read only from their README, or for later ones. None
  of them has independent verifiers writing to a public log of AI model keys, and neither do we: of the three verifiers that write to our log two are ours and the third is run by a friend of ours.
  On Nov 10 we also read two later entries (posts, READMEs, parts of the code; `docs/PRIOR-ART.md`). CIPHERWORK refuses before sending and encrypts to the attested model key, with no public key log: it trusts one verifier key of its own. Provable AI Compliance refuses and encrypts at another layer, to an attested OutLayer enclave that then reaches the model over TLS; it has no key log, and when the model's evidence fails a check it records that and still delivers the answer. It binds its gateway's code, input, output and caller into one Intel quote per run, where our Tier 2 has two artifacts joined by hashes.
  On Nov 13 the gallery held 820 entries. We read the text of 779 of their posts, searched GitHub for code that reads NEAR AI's evidence, and read the repositories of 23 more entries with Claude Code: Countersign directly, 22 through delegated agents. For Shade, Neslos, DNA Confidential and Oathline we then checked against the source what is said about them here and in `docs/PRIOR-ART.md`; the other 18 we know only as the agents reported them. The sentence about the 26 does not describe this later field. Countersign keeps a signed, hash-chained feed of reviewed NEAR AI machines in a NEAR contract and refuses before sending; its reviewer is its author, as two of our three verifiers are ours and the third is a friend's. It is ahead of us on the contract (no access keys; ours has one), on boot measurements recomputed from the OS image and on published evidence. By its own method page it does not check response signatures, follow an image to its source or compare the release per request, and its encryption is version 2. Shade has a key registry that watchers fill by a quorum the contract enforces, a refusal before sending and receipts on chain; by its README the gateway in its demo is a mock and nothing is on testnet. We looked for three things in other people's code: an append-only, hash-chained key log for several verifiers with the trust set and the quorum at the viewer; release marks in such a log with a client rule on them; a policy kept private whose decision is signed inside an OutLayer job and verified by the contract. The first two we did not find in any of 76 repositories: the 51 entries' repositories read by that morning, and 25 more that a wider code search turned up later that day (383 repositories found; not all 25 are in the gallery). The 25 were read by a delegated agent, and we checked its report only for the two named next. The nearest to the first, by that report, is drouter, on another chain and for other enclaves: a registry of measurements that several listed checkers write to, each result replacing the one before. The third we did not find among the 51. Charter, Neslos and a policy gate by the author of Provable AI Compliance each do part of it; they and the other near neighbours are in `docs/PRIOR-ART.md`. Among the 25, Aegis does it as worded here and Bouncer comes close, and those two we read ourselves: in Aegis the contract verifies a decision signed in an OutLayer job over a policy stored on chain as ciphertext; in Bouncer it verifies the verdicts an OutLayer guard signs over a private ledger. What Ainek has that we did not find there, in the paths we read: against Aegis, a decision key generated inside the enclave (there the job reads it from an ordinary OutLayer secret, the kind an owner sets); against both, an action held until a person approves it (in Aegis a keeper account executes; in Bouncer the winner claims the payout after a lock). Bouncer's guard signs with a key OutLayer holds for the project, so on the key we claim no difference there. Ours has a limit of its own, listed with what we do not claim: the owner of our OutLayer project can move that key to another build. All of this is a statement about 76 repositories as far as those readings go, not about 820 entries. Another 17 projects outside the hackathon were read the same day for one question, who else reads the enclave's action log; they are in a section of their own in `docs/PRIOR-ART.md`.
- (`pnpm demo:attest` with no key; in the browser on request, from the proof card and `/log`) The **release behind the
  key is followed to a source commit.** The action log the
  model's enclave attests, which the SDK authenticates against a TDX quote of its own, names the latest `compose_up` for the
  model's service. The file at that commit in `nearai/cvm-compose-files` is fetched and hashes to the sha256 the enclave
  recorded, and the repository's tag of the recorded name points at that commit (a commit id alone could be a fork's:
  GitHub serves those under the parent's name; a recorded tag the repository does not have fails the check). The proxy image the file pins by digest has a signed build provenance
  (Sigstore, GitHub Actions) naming its repository, branch and commit, and so does the Compose Manager image the log says
  it started as; that image is also compared with the one the measured compose starts the manager as. The quote behind
  the log and the quote behind the signing key name one CVM instance id, which rules out a mix-up between replicas, not
  a host that runs two CVMs under one id. This is signed provenance, not a reproducible build. It follows what was
  recorded, not which containers run at this moment (the SDK's own note on the verified log: "This does not establish a
  unique CVM identity or successful/current execution"). The log is a record and not a measurement: see "We do not
  claim". The engine image and the weights are printed as the file of the engine's own latest release names them and are
  not checked. A check that could not be made (GitHub or Sigstore not answering, no build policy for an image) is
  reported as not made, and the summary gets a check mark only when every check of the release was made and held. "Public for N minutes
  before it ran" uses GitHub's commit time and Compose Manager's clock, neither a trusted timestamp, and comes from the
  one CVM that answered: the gateway picks a replica per connection.
- (in the verifier and in both clients since Nov 12; the rule is off by default) A **verifier can log what it checked
  behind a key, and the client can refuse an enclave whose action log no trusted verifier logged** (SPEC §7.5). After a
  key verifies, the verifier follows the release behind it with the chain above. Only when every check holds does its
  entry carry two marks next to the launcher's image digests: the enclave's action log as it stood (instance, number of
  actions, hash) and the release of the model's service. The contract is unchanged: the field takes text. With
  `AINEK_REQUIRE_RELEASE=1` the client sends only when the action log it was attested is exactly one that a quorum of the
  viewer's verifiers marked, and it refuses a log that does not begin with what a verifier saw from the same instance. The
  rule compares one record with another and reads no action, so it needs no network; in the browser it attests again for
  every message, because a verification kept for an hour says nothing about that hour. A client may also wait
  (`AINEK_RELEASE_WAIT_MIN`): it then sends only when the log has been marked as it stands for that many minutes by a
  quorum, so anything added to the log starts the wait again. `pnpm -F verifier dry-run` prints
  the entry a verifier would log, and `pnpm demo:attest` says where the log stands for the replica that answers; `/log`
  shows the same line in the browser, without refusing on it. Both our
  verifiers have written marks since Nov 12, 17:10 UTC (entries #73 and #74 were the first). On Nov 13 the log did not
  keep up with a release: one went live at 00:56 UTC, and the mark for the replica that answered us came at 06:24 UTC,
  5 hours 28 minutes later, from the second verifier; the first, the only one in the site's default trust set, had
  written none by 06:30 UTC. What a mark does not say is under "We do not claim".
- (`pnpm demo:attest`, and the release check in the browser) **What three parties outside the team published about the
  same state is read and shown**: Countersign's signed feed in a NEAR testnet contract, by the signing key and the
  launcher; Quill Cloud's policy file, by the launcher and the hash of the action log; teemoon's review pages, by the
  hash of the release file. A feed entry is read only if its ES256 signature verifies under the feed's two public keys,
  pinned in the client (the ones its contract returns and its repository publishes). Each reading is marked "seen", "not
  seen" or "not known", in words and not with the check mark of our own checks: "seen" says the party has published
  something about exactly this, and its conclusion is quoted next to it. On Nov 13, after release v0.0.581: the key and
  launcher were in Countersign's feed with the verdict "warning" and the release before this one; Quill Cloud pinned
  the state before this one; teemoon had no page for the file.
- Requests are **end-to-end encrypted** to the model's attested key, including tool definitions and
  tool calls (`X-Encrypt-All-Fields`). Our relay and the NEAR AI gateway see ciphertext, size, timing, IP and the request's
  plaintext metadata (model id, message roles, the reasoning-effort setting, token usage, completion ids), never the contents. For replies this rests on
  E2EE v3 and on NEAR AI's proxy refusing a swapped reply key, which we tested once, on Nov 12, with a request of our own: see the first item under "Known issues we inherited".
- Every response is **signed inside the enclave** over `sha256(request)` and `sha256(response)`. We keep the
  raw bytes locally and recompute both hashes — the step NEAR's own Verification Center says it cannot do.
- Only a **salted hash** of each proof goes on-chain (`commit_proof`, paid from storage the committing account prepays and
  cannot withdraw). Prompts, responses and policy contents never do.
- (Tier 2) The agent holds **only a function-call key** scoped to `commit_proof` and `propose_action`, and refuses to start with any other. Funds sit in the contract.
  Revoking the key (`DeleteKey`) or `pause_agent` stops the agent at the chain level.
- (Tier 2) The policy decision is **signed by a key generated inside an Intel TDX enclave** (OutLayer); the contract
  verifies this signature before executing. The signature shows which key signed, not which code ran: that is in the
  run's attestation (`wasm_hash`). The contract does not check it. `pnpm demo:policy` shows the whole check on a recorded run: the quote is signed by Intel and commits to
  the published build, the input and the decision. It then checks the runs behind the agent service's seven live actions the same way, to the build and the decision only: those runs do not publish the job's input. The agent service runs the same check before it proposes anything; that has run on one live payment (Nov 6, `pnpm -F agent once`). `/verify` runs it in the browser for an action proof, without the job's input, which a proof does not carry.
- (Tier 2) The policy job **cannot retain or exfiltrate its input by construction**: it is a WASI-P1 binary with no
  network and no storage interfaces, its build is reproducible (`Cargo.lock`, pinned toolchain), and the `wasm_hash`
  you get from building the repo equals the hash in the attestation. This is a proof of *inability to retain*, not a
  proof of deletion, and it applies to the policy job only — not to the model enclave, and not to the OutLayer worker
  around the job; the action input is public on-chain anyway.
- The card tells you when privacy is **only contractual**: a response signed by the gateway (`signature_kind: gateway`,
  NEAR AI's Incognito tier for Claude/GPT/Gemini) is shown red, not green.

## We do not claim

- **That the decision key is tied to one build of the policy job.** OutLayer's "one build only" lock is an access
  rule: per OutLayer's docs the owner of the OutLayer project (in the demo: us) can move it to another build or
  remove it, the key stays the same and the contract would not notice.
- **Verified model weights.** Attestation measures the enclave's launcher (compose hash, container image digests) and,
  through the action log, which images were deployed, not the weights. We say "attested deployment of model X". The
  compose file of a release names a Hugging Face repository and snapshot for the weights, and `pnpm demo:attest` prints
  it; nothing hashes the files the engine loads.
- **No retention inside the model enclave.** Attestation cannot prove what NEAR AI's model enclave does with data after
  inference. The proxy that decrypts the prompt is open source (`nearai/inference-proxy`) and its image has signed build
  provenance, which says which source was built, not what it does with data; we have not audited it, and no build is
  reproducible. NEAR AI documents a no-store Responses API, but we use chat completions (needed for E2EE).
- **That nobody can read your data.** Our server cannot. The enclave can, by design, during inference.
- **Protection from the server that serves the page.** The browser code that verifies, encrypts and checks the log is served
  by the same server that relays. "Our server cannot read" holds for the code in this repo; on the hosted demo you trust that
  we serve it. `pnpm -F web dev` from a clean clone, or `pnpm demo:live`, removes that trust.
- **That the deployment check sees the code that serves the model.** It sees the launcher. On NEAR AI Cloud the compose
  hash an enclave measures covers a telemetry sidecar, certbot, Compose Manager and its launcher. The containers that serve
  the model (the proxy that decrypts the prompt and signs the answer, the engine) are started afterwards by Compose Manager
  from a file in the public repository `nearai/cvm-compose-files`, and a new release of them changes neither the signing
  key nor that hash. Compose Manager records each such action in a log the enclave attests with a TDX quote of its own. On
  the CVM that answered us on Nov 12, 2026 that log held 21 releases of the model's compose file since Oct 21, and the image
  of the proxy for `z-ai/glm-5.3-flash` had changed four times (five images in all), twice after our log first held that
  CVM's compose hash: the client would have refused neither. Since Nov 12 `pnpm demo:attest` reads this log and follows the release to a source
  commit, and the browser does the same when the visitor asks (the proof card, `/log`). By default that is a reading, not a
  rule: the client refuses on what an enclave deployed only when `AINEK_REQUIRE_RELEASE` is on, which works only against
  verifiers that write release marks (below), and a proof says which key signed and which launcher was attested, not which
  release answered.
- **That the action log is a measurement.** A release leaves the enclave's measurements as they were. The log is Compose
  Manager's own record, and the TDX quote behind it says the log came from inside that CVM, not from which container. The
  serving containers the log describes run privileged and hold the same quote socket, so a dishonest release could present
  another log; so could a manager replaced after boot, which the measured launcher is configured to do for images signed
  by a workflow of `nearai/compose-manager` (we read that configuration, not the launcher's code). `pnpm demo:attest`
  shows that the record agrees with public sources at every link. It cannot show that the record is complete, or that the
  containers it names are the ones running.
- **That a logged release is an approved one, or that the release rule closes this gap.** A release mark in the log says
  that, at one state of an enclave's action log, a verifier followed the release that serves the model to public
  sources: the latest release of the model's service in the compose file the log most recently deployed for it, the
  signed build of its proxy, and Compose Manager's. Nobody read that code. A rollback is marked like any other release.
  A client may wait (`AINEK_RELEASE_WAIT_MIN`, no wait by default): it then sends only when the action log has been
  marked as it stands for that many minutes, by as many verifiers as its quorum. That time counts from the verifiers'
  marks, not from when the code became public; it is read off the verifiers' clocks and the client's (at a quorum of 1,
  off the earliest mark of any trusted verifier, so one of them that dates its mark back shortens the wait), and off the
  day of the log the client reads, so after a verifier has been away, or just after marks are turned on, a state that is
  days old waits again. The verifier does not follow the engine image, or anything else that log brought up. The log
  does not record the Compose project of a deployment, so it does not show which earlier services a later one replaced,
  and in one of our recordings nine compose files in a single log define a service for this model. The rule
  (`AINEK_REQUIRE_RELEASE`, off by default) holds an enclave to its own record: the action log it attests must be
  exactly one a trusted verifier marked. That does not make the record a measurement. A log shorter than one a verifier
  saw is refused, and it is called rewritten only when its beginning differs from what was seen: lengths alone cannot
  tell a log that was cut from an attestation older than the verifier's entry. A log cut back to the last state a
  verifier marked passes when the longer state got no mark: a verifier that meets a state it cannot follow to public
  sources writes nothing about it, so the key log keeps no trace that the longer log existed. Compose Manager itself
  starts from an empty log when its file is missing or unreadable. The rule speaks for the moment of attestation, which
  is why the browser attests again for every message while the rule is on. It checks the replica that attested, and the
  gateway picks the replica per connection. Its cost is refusals: after every action in an enclave, until a verifier has
  seen that replica again. On the two logs we hold that is about two windows a day for each replica. Live we have one
  run that would send and one window that would refuse. Entries #73 and #74 (Nov 12, 17:10 and 17:30 UTC) were the first
  with marks, one from each verifier, and with the rule on `pnpm demo:attest` reported that it would send, for the one
  replica that answered. On Nov 13 a replica stayed unmarked for about five and a half hours after a release, and a client
  routed there would have refused all that time. How often the rule refuses over a day we have not measured.
- **A measurement allowlist.** The log records what verifiers saw, not what should run: which compose hashes are
  acceptable is not governed (next steps). Instances of a model share one signing key, so the signature alone does not say
  which deployment answered. Since Nov 11 the client narrows this (SPEC §7.1, `AINEK_REQUIRE_DEPLOYMENT=1`): the key must be
  logged together with the compose hash the client attested, by a trusted verifier in the last 24 hours, otherwise
  "Unknown deployment. Message not sent." It narrows and does not close: the client attests one instance, the gateway picks
  the instance per request, and a verification is reused for 60 minutes, so another instance behind the same key may answer.
  The cost: a replica that appears, or returns after more than a day away, refuses the honest users routed to it until
  the verifier logs it. The verifier takes five reports every 15 minutes over fresh connections, so we expect minutes; we
  have not measured that window (`docs/DEV-NOTES.md`, Nov 11, has what the log shows). The chat's demo switch shows the refusal.
- **A trustless read of the log.** The client reads `latest_keys` through one JSON-RPC endpoint (FastNear by default,
  `NEAR_RPC_URL`) with no light-client proof, so "checked against the public log" means "checked against what that endpoint
  says the log holds". A lying endpoint can pass an unlogged key or refuse a logged one; it cannot route you to an unattested
  key, because attestation is checked locally. The endpoint also sees the browser's IP and the timing of every message's
  log read. The signed commit transaction goes to a second endpoint: the wallet connector broadcasts it through its own
  FastNear endpoint (the "Who sees what" table).
- **An immutable log.** "Append-only" describes the code deployed today: `log_key` only appends, and each entry hashes the
  previous one. The contract account still has a full-access key, so whoever holds it (today: us) can replace the code. A
  rewrite would show only to someone who kept an earlier `head`. `pnpm demo:log` is that reader: it recomputes every hash
  from the first entry and compares the log with the places recorded in this repository (entry #0 as read on Nov 8, and
  the heads #80 and #86 as read on Nov 13, the second after the first entries of the verifier outside the team), so a
  clone of the repository holds an earlier head, and it prints the head of the day to keep for a later run. A place
  covers the entries up to its own index from the day it was read, and nothing else: entry #0 since Nov 8, entries #1 to
  #86 since Nov 13, later entries not until another place is kept. It reads one RPC node:
  that another node gives another reader the same log is not shown. `pnpm -F demo check-agent` prints how many such keys
  the account has.
- **Instant revocation.** The browser reuses a verification for up to 60 minutes and accepts a log entry up to 24 hours
  old; the log has no revoke entry yet, and nothing unregisters a verifier. An entry's time is the one its verifier
  wrote: the contract does not compare it with the block's. Since Nov 13 the client applies its own clock as well, with
  ten minutes of slack: an entry dated ahead of it is dropped from every read of the contract's window, is not shown,
  and confirms no proof on `/verify` or `/auditor`; one older than the window does not count. So an entry dated years
  ahead no longer confirms a key for good. What this does not settle: such an entry is dropped without a word, so a
  trusted verifier whose clock runs far ahead looks silent, its disagreement with another verifier included, and a
  client whose own clock is far off refuses with "not in the public log". The contract returns the newest 100 entries
  before the client filters, so a registered verifier that writes a hundred entries dated ahead crowds the general read;
  each trusted verifier is still read on its own. A trusted verifier's key that leaks still lets its holder log a key of
  their choice, a day at a time.
- **That an outside reading is a verifier of ours, or an endorsement.** The three readings are shown and never applied:
  they take no part in the decision to send, and none of the parties is in a trust set or writes to our log. They
  publish for their own users, not for us. "Seen" is "has looked", not "approves": Countersign's verdict on the machine
  we use is "warning", for two checks our client does not make (Intel's early collateral rates the platform out of
  date; the report declares four NVSwitches and carries no evidence for them). Its entries are signed by one person, by
  hand, and expire after three days. Which of its entries is the latest is the word of a public RPC: an older entry that has
  not expired can be served as the current one. The feed's two keys are pinned as we compared them once, on Nov 13; a
  key the feed retires after that is still accepted here. Quill Cloud's file and teemoon's pages come over HTTPS from
  GitHub and are not signed: whoever can write to those repositories, or GitHub, decides what the reading says. The
  formats are theirs and may change without notice; then the reading says it could not be made.
- **A log that can grow without end.** `latest_keys` reads a model's whole history before it filters by verifier and
  age. Measured in near-sdk's unit-test environment, not on a node, that costs about 0.15 Tgas an entry, which reaches
  the 300 Tgas of a view call near 2,000 entries for one model; the log held 79 on Nov 13. Past that point every read
  fails and the client refuses everything until the contract is replaced. A verifier writes an entry for every
  attestation a report carries, with no cap for a round.
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
  bytes were ciphertext is the sender's claim, and `/auditor` labels it as such. A proof does not record the E2EE version
  either, and nothing in the signed bytes shows it.
- **A streamed answer, or a long conversation sent whole.** The reply is not streamed: nothing arrives until the model
  has written all of it, and the proof is made over the whole reply. The page waits 180 seconds and then says no reply
  came; by then the request may have reached the model and been answered. On the evening of Nov 13 an answer of 120
  words took 17 to 40 seconds, and one open question took 148 seconds and, asked again, 203, which is longer than the
  page waits. A message is at most 4,000 characters. A conversation goes to the model as far as it fits one request to our relay
  (50 messages, 64 KB): past that the earliest exchanges are no longer sent, the model does not see them, and the page
  says how many the next message will leave behind. Since Nov 13 the chat page asks the private model to reason little
  before it answers (`reasoning_effort: "low"`, a field in the clear beside the encrypted messages). The same open
  question then took 25, 41 and 46 seconds. It costs correctness: two arithmetic questions, asked eight times in all
  with that setting, got three wrong answers, one of them in the chat with a card that says "verified"; with the
  default the same two got none wrong in three. The card says where an answer came from, not that it is right.

## Known issues we inherited (say so)

- NEAR AI's E2EE route has a reply-key-substitution finding ([nearai/cloud-api#1061](https://github.com/nearai/cloud-api/issues/1061),
  cited by the Miller registry), still open upstream (checked 2026-11-10). We pin the model key from a verified report via
  `X-Model-Pub-Key`, which protects the request. The reply key travels in a header (`x-client-pub-key`) that E2EE v1/v2
  did not bind, so a hop that swapped it could read the reply it diverted. The card would fail for that reply, or stay
  green if the hop also sent the same request again with the real key: a proof made under v2 does not rule out that a hop
  read a reply to that prompt. E2EE v3 ([inference-proxy#312](https://github.com/nearai/inference-proxy/issues/312)) binds
  the reply key and the field label into the AEAD associated data of every encrypted request field, so the proxy rejects a
  swapped key before inference. Gateway and proxy merged it on Oct 28 2026
  ([cloud-api#1296](https://github.com/nearai/cloud-api/pull/1296),
  [inference-proxy#321](https://github.com/nearai/inference-proxy/pull/321)), the SDK shipped it on Nov 8 in 0.3.0
  ([inference-sdk#127](https://github.com/nearai/inference-sdk/pull/127)). This repo has used 0.3.0 since Nov 10: the SDK
  sends `X-Encryption-Version: 3` with no fallback, the client refuses to send an encrypted request not marked v3, and our
  relay refuses one to the attested model. Live exchanges passed on Nov 10 from Node (`pnpm demo:live`, straight to NEAR AI)
  and from the hosted chat through our relay, so production accepts v3. On Nov 12 we sent the control
  (`pnpm demo:reply-key`, recorded in `docs/samples/reply-key-control.json`): the exchange verified as usual; the same
  client behind a hop that swapped the reply key in transit got HTTP 400 `Decryption failed` where a reply would have been,
  and so did the swap with the version header rewritten from 3 to 2. That is one model on one day with SDK 0.3.0, not a
  promise about other routes or later builds of the proxy. The gateway still accepts v1/v2 from
  other clients. The recording behind the offline replay, and every proof this client made on SDK 0.2.1, is v2.
- The model CVMs report the OS image `dstack-nvidia-0.5.12`. Before dstack 0.6.0 a container holding the dstack socket
  can append events to the RTMR3 log (`EmitEvent`, removed in 0.6.0: "runtime RTMR3 events are system-owned and cannot be
  extended by apps"), and the SDK reports the last `compose-hash` event. A container could in that way show a compose
  hash the CVM did not boot from, and until Nov 12 our deployment check compared that value. Since Nov 12 the compose hash
  is taken from the app compose text, which the SDK checks against MRCONFIGID. In every report we have seen the two agree,
  so no log entry changes.
- The Verification Center and the SDK do not ship a measurement allowlist; our log is only as good as the verifiers that
  write to it. Two of the three verifiers in the demo are ours: one on a server since Nov 6, trusted by the site's
  default, and a second account that wrote its first entry on Nov 10 and is not in the default. The third,
  `anas-verifier.testnet`, wrote its first entries on Nov 13 (#84 to #86): Anas, a friend of both of us, runs it on his
  own machine with a key we have not seen, and we set it up together. That is a verifier outside the team and not an
  independent one, and it is not in the default either (checked 2026-11-13). Nobody we do not know runs one yet.