# Metrics: how they were measured

The numbers the README quotes, with the method and the caveats in full. Moved here from the README on Nov 10, 2026, with pointers adjusted; the two tables stay in the README.

50 runs one after another on Nov 11, in about eleven minutes ending 16:17 UTC, from one Mac at commit `3941bde` (the deployment check on), with
`z-ai/glm-5.3-flash` and the one-line prompt `Reply with the single word: ok.` A long answer takes longer. Every run's
timings are in [`docs/metrics.json`](metrics.json); medians and p90 are nearest rank over the 49 runs that verified.
This shows the sequence holds, not how the services behave over days. With runs this close, connections and NEAR AI's
proxy caches may be warm, so a real first message can be slower.

One run of the 50 (run 41) did not verify: its attestation step did not finish within 120 s, the runner's limit for a
step, so it ended as failed before anything was sent and before the log check. Which request hung is not recorded. None
of the 49 runs that reached the log check was refused there (the table's "0 of 50" is the script's count over all runs),
so in these eleven minutes every replica the gateway chose for them was one the verifier had logged with the key.

Timings move from day to day with NEAR AI, Intel and NVIDIA. The same command gave a median of 9.9 s on Nov 6 (commit
`6c596e4`, SDK 0.2.1, first run 22.7 s), 7.1 s on Nov 10 (commit `765708d`, 50 of 50 verified, p90 10.3 s) and 8.9 s on
Nov 11. The difference is in the network steps: on Nov 11 attestation was as fast as the day before (median 3.6 s) and
the model was slower (round trip median 1.9 → 3.8 s, p90 4.1 → 10.0 s); the local steps take about 20 ms on all three
days. Read the three days as a range.

The table is in the [README](../README.md#metrics); it is what `pnpm demo:metrics` printed for these runs.

Measured by `pnpm demo:metrics --runs N` (it overwrites `docs/metrics.json`; `--out` writes elsewhere): N runs of the Tier-1 sequence from Node 24, direct to NEAR AI (no relay), with
the evidence re-fetched and re-verified on every run (HTTP connections may be reused between runs), the public-log check with the honest and a swapped key, one E2EE exchange, the signature
and the proof. The two log views are the model's 24-hour window and the trusted verifier's own entries.

**Over the log's history.** "Honest request refused: 0 of 50" covers eleven minutes. Over the whole log, as
`pnpm -F demo check-contract` printed it on Nov 10 at 14:26 UTC: 46 entries by the trusted verifier since Nov 3; an
honest client would have had no entry younger than 24 hours for 13.6 of 167 hours, all of it on Nov 4–5, before the
daemon ran on a server; none missing in the 130 hours since Nov 5, 04:44 UTC. The count looks only at whether a trusted entry existed, not at its key or at a
quorum: it matches what the client decides only because the model's key did not change in that time and the quorum is 1.
So a refusal caused by a key the verifier has not logged yet has not been observed. The times are the verifier's own
clock.

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

The tally by decision and status is in the [README](../README.md#metrics).

The script reads the contract's records, not the token's transfers. The totals agree with them: the contract holds
8,394 AINEK, the 10,000 sent to it minus the 1,606 of the eight Executed actions. That does not rule out flows that
cancel out.
