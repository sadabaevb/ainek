# Metrics: how they were measured

The measurements, with the method and the caveats in full. The text moved here from the README on Nov 10, 2026, and the two tables on Nov 14; the README quotes three of the numbers.

50 runs one after another on Nov 13, in about ten minutes ending 15:29 UTC, from one Mac at commit `079cacb` (the deployment check on), with
`z-ai/glm-5.3-flash` and the one-line prompt `Reply with the single word: ok.` A long answer takes longer. Every run's
timings are in [`docs/metrics.json`](metrics.json); medians and p90 are nearest rank over the 50 runs, all of which verified.
This shows the sequence holds, not how the services behave over days. With runs this close, connections and NEAR AI's
proxy caches may be warm, so a real first message can be slower.

None of the 50 runs was refused at the log check, so in these ten minutes every replica the gateway chose for them was
one the verifier had logged with the key. The slowest run took 35.3 s, 27.9 s of it waiting for the model; six of the
50 round trips took more than 10 s.

Timings move from day to day with NEAR AI, Intel and NVIDIA. The same command gave a median of 9.9 s on Nov 6 (commit
`6c596e4`, SDK 0.2.1, first run 22.7 s), 7.1 s on Nov 10 (commit `765708d`, 50 of 50 verified, p90 10.3 s), 8.9 s on
Nov 11 (commit `3941bde`, 49 of 50, p90 15.6 s) and 9.8 s on Nov 13. The difference is in the network steps: the
attestation median was 3.6 s on Nov 10 and 11 and 4.8 s on Nov 13, the round trip to the model 1.9, 3.8 and 3.3 s
(p90 4.1, 10.0 and 10.5 s); the local steps take about 20 ms on every day. Read the four days as a range.

One run of the 150 on Nov 10, 11 and 13 did not verify: run 41 of Nov 11. Its attestation step did not finish within 120 s, the runner's
limit for a step, so it ended as failed before anything was sent and before the log check. Which request hung is not
recorded.

What `pnpm demo:metrics` printed for these runs:

| Metric | Value (50 runs) |
| --- | --- |
| Verified, attestation to proof (the on-chain commit is measured once, below) | 50 of 50 |
| Log check refuses a swapped key (the chat's switch rule applied to each run's log read; nothing is sent) | 50 of 50 |
| Honest request refused at the log check (window empty, key unlogged or deployment unlogged) | 0 of 50 |
| Runs that needed an SDK retry | 0 of 50 |
| Attestation (gateway + model, re-fetched, in Node) | median 4.8 s, p90 7.0 s |
| Public log read (2 `latest_keys` views at once, rpc.testnet.fastnear.com) | median 0.4 s, p90 0.7 s |
| E2EE round trip to the model | median 3.3 s, p90 10.5 s |
| Signature fetch | median 0.7 s, p90 0.9 s |
| Whole run, evidence re-fetched (a real first message can be slower) | median 9.8 s, p90 19.5 s |
| Later message, attestation cached (not timed: each run's steps after attestation, added up) | median 4.5 s, p90 15.0 s |
| Request and response body (encrypted fields plus plain metadata) | median 293 B sent, 1002 B received |

Measured by `pnpm demo:metrics --runs N` (it overwrites `docs/metrics.json`; `--out` writes elsewhere): N runs of the Tier-1 sequence from Node 24, direct to NEAR AI (no relay), with
the evidence re-fetched and re-verified on every run (HTTP connections may be reused between runs), the public-log check with the honest and a swapped key, one E2EE exchange, the signature
and the proof. The two log views are the model's 24-hour window and the trusted verifier's own entries.

**Over the log's history.** "Honest request refused: 0 of 50" covers ten minutes. Over the whole log, as
`pnpm -F demo check-contract` printed it on Nov 13 at 15:40 UTC: 73 entries by the trusted verifier since Nov 3; an
honest client would have had no entry younger than 24 hours for 13.6 of 240 hours, all of it on Nov 4–5, before the
daemon ran on a server; none missing in the 203 hours since Nov 5, 04:44 UTC (the longest pause between entries 7.0 h). The count looks only at whether a trusted entry existed, not at its key or at a
quorum: it matches what the client decides only because the model's key did not change in that time and the quorum is 1.
So a refusal caused by a key the verifier has not logged yet has not been observed. Nor has one caused by a deployment it
has not logged yet: the deployment check has been on since Nov 11, and the 99 runs that reached it on Nov 11 and 13 are
all it has been measured on. The times are the verifier's own clock.

**Compose hashes behind the key** (the log on Nov 10): six since Nov 3, three of them in the last 24 hours. By their
image digests the six are two builds: four hashes share one set of images, two share the other, so most new hashes are
replicas of one build, not new code. `/log` shows the current list.

**In a browser.** The script does not measure it. It was timed once with Playwright in headless Chromium on the same
Mac, on the hosted demo (so through our relay), on Nov 10, 14:19–14:21 UTC, right after the 50 runs: from the message
appearing on the page to the green card, with the same prompt and no wallet (no commit). There is no script for it in
the repo; the steps are in `docs/DEV-NOTES.md` (Nov 10). Three first messages with nothing cached in the browser (Ainek's
IndexedDB cache cleared, page reloaded, runs more than 30 s apart because NEAR AI's collateral proxy lets the browser
cache for 29 s; the proxies' own caches may have been warm) took 6.3, 5.9 and 5.6 s; the page's own step timer showed
4.3, 3.9 and 3.3 s of that as attestation. One later message on the same page, attestation cached: 2.1 s. Four messages
are a spot check, not a distribution: on Nov 3 the same cold attestation took 13 s. A slow or retried collateral or
NVIDIA verdict fetch, both through NEAR AI's proxies in the browser, makes it longer.

**The on-chain commit** is measured once, not per run: `commit_proof` burnt 2.41 TGas
(0.00022 NEAR in fees) and 161 bytes of prepaid storage (0.00161 NEAR; 130 + account + kind bytes per SPEC §4.2, here a
26-character account) in
[8syaAPnB…](https://testnet.nearblocks.io/txns/8syaAPnB5FxZiC1qTjod9rfA5REThqyMFCz7jxZNPLpM). On Nov 5 the page signed
the same call in a browser connected through Meteor, with the function-call key added at sign-in and without a popup:
[FLHbBzAv…](https://testnet.nearblocks.io/txns/FLHbBzAvaBN6jkmAQ1fnuAXAaViPZkgLi1XoWnhSiDnR).

**Tier 2.** Not a benchmark. These are the twelve actions the agent has on testnet, all proposed by us (ten by Nov 7, two on Nov 11) and all
decided under the current key and policy, as `pnpm -F demo check-agent` re-read them from the chain on Nov 11. Seven
came from the agent service with a real model answer (action 2 from `pnpm -F agent once`; 3, 4, 8, 9, 10 and 11 through the
Telegram bot); the other five (0, 1, 5, 6, 7) from scripts with a placeholder model proof (`docs/DEPLOY.md`). Times from
message to transfer were not measured.

The tally by decision and status:

| Decision signed in the enclave | Actions | Status the contract recorded |
| --- | --- | --- |
| Allow | 5 | 4 Executed; 1 Failed (the token refused: the receiver is not registered on it) |
| NeedsApproval | 5 | 4 Executed after the owner's `approve`; 1 Rejected by the owner |
| Deny | 2 | Denied |
| Any whose status the signed decision does not allow (say, a Deny marked Executed) | 0 | each record's signature, the action hash in the decision and its status re-check |

The script reads the contract's records, not the token's transfers. The totals agree with them: the contract holds
8,394 AINEK, the 10,000 sent to it minus the 1,606 of the eight Executed actions. That does not rule out flows that
cancel out.

**A long conversation and long input** (Nov 13, on the code of that day). Neither is part of the script.

- In a browser, on a local server (`next dev`, so through the relay's own code), headless Chromium, one conversation:
  25 exchanges with one-line replies, every one verified, and at exchanges 6, 12, 18 and 24 the model named a word given
  in the first message, so the history reached it through the encryption. From pressing Enter to the card: 10.0 s for
  the first message, 1.4 to 11.4 s for the 24 after it, median 2.8 s. The script sent as fast as the page allowed and
  ran into the relay's limit of 30 requests a minute from one address at the 25th message, less than two minutes in; the card
  said to try again in a minute, and a minute later the next message went through.
- The 26th exchange did not go: the relay takes a request of at most 50 messages and 64 KB, and the page sent the whole
  conversation. Every later message failed the same way, with a card that did not say why. With answers of several
  hundred words the 64 KB come first: a 550-word answer was 4,054 characters, about 8 KB encrypted, so seven or so such
  exchanges fill a request. Fixed the same day: the page sends the latest exchanges that fit and says how many it left
  behind (SPEC §3.4).
- A message of the composer's full 4,000 characters, as a first message: verified in 22.9 s; a question about it
  after that, 5.9 s.
- From Node, direct to NEAR AI, one run each: a message of 7,526 tokens verified in about 10 s (3.8 s the round trip);
  one of 130,526 tokens in 34.2 s (23.5 s the round trip, a request of 1.2 MB). NEAR AI's metadata names a separate
  address for requests over 100,000 tokens; the reply to this one was signed by the same key the client had checked
  against the log.
- Long answers, the same evening, one run each unless said otherwise. The reply is not streamed, so the wait is the whole
  answer. From Node with encryption: one word 2.1 s, two sentences 9.5 s, 120 words 39.8 s (724 tokens written, 568 of
  them reasoning the reader never sees), 550 words no reply within the runner's 120 s, twice. In plaintext, direct:
  120 words 16.6 s, 300 words 63.5 and 40.2 s, and the question "What is a TEE and why would I run my AI inside one?"
  147.7 s for 524 words (3,655 tokens, 2,921 of them reasoning) and, asked again, 203.4 s. In the browser a request for 550 words was verified in
  66.3 s once; an earlier one was still waiting after more than four minutes, which is how the missing limit on the
  wait was found (180 s now, SPEC §3.4). The model wrote 10 to 25 tokens a second in the runs that completed. The
  ones that did not are read with the note on the connection below.
- Reasoning effort, the same evening, in plaintext, direct. NEAR AI takes `reasoning_effort` for this model, and the chat
  page sets it to `low` for the private model since Nov 13. Everything above was measured with the default: the Node
  runs, the table above among them, and the browser runs too (the conversation of 25 exchanges, the message of
  4,000 characters, the answer of 550 words), which were made before the page sent the field and were not repeated.

  | Task | default | `medium` | `low` |
  | --- | --- | --- | --- |
  | about 300 words | 63.5 s, 40.2 s | not run | 27.7 s, 36.5 s |
  | "What is a TEE and why would I run my AI inside one?" | 147.7 s, 203.4 s | no answer in 240 s, twice (see the connection, below) | 41.2 s, 24.6 s |
  | two arithmetic questions asked several times, answers right | 3 of 3 | 4 of 4 | 5 of 8 (six direct, two through the page) |

  The times of the answers that came are the model's: the default wrote 3,655 and 4,377 tokens for that question, most
  of them reasoning, and `low` 646 and 626. Asked as a stream with the default, the same question brought reasoning
  steadily for 135 s, four to five pieces a second with no gap over 1.7 s, and not a word of the answer. With `low` the
  model sometimes does not reason at all (one reasoning token), and two of the three wrong answers were of that kind:
  298 minutes where 191 was right, 310 som of change where 160 was; the third, 170 som, came in the chat page with a
  green card. Through the page with `low`, encrypted, one run: the question about a TEE verified in 46.2 s. Of the two
  runs of that question with the default, one was within the 180 s the page waits and one was not.

  **The connection these runs were made over was not steady,** and that limits what the failures say. It was a café's.
  A hundred small reads over two minutes had a median of 0.25 s and none over a second. A watch of four hosts over five
  and a half minutes then lost two reads of 600, one to NEAR AI and one to Cloudflare, each a single connection that
  stalled for more than 8 s. In the browser, three requests to NEAR AI's collateral proxy timed out together once (the
  hardware check took 135 s that time), and a read of the RPC was closed once, after which the client sent nothing, as
  it should. So a request that got no answer at all cannot be told from a connection that stalled: the two requests
  for 550 words that Node gave up on at 120 s, the browser request still waiting after four minutes, the stream that
  fell silent at 135 s and ended at 205, and both `medium` runs. What a stall does not explain is how long the answers
  that did come took, and how many tokens they were.
