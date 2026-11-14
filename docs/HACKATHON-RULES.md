# NEAR Hackathon: the rules that affect us

> Translated from Russian on Nov 14, 2026. The original is in this file's git history.

Source of truth: https://nearhackathon.com/HACKATHON.md: re-read it before submitting, the dates and rules may change.

## Dates (UTC)
- Code counts from the announcement on **Oct 19, 2026**; commits before that date are the baseline.
- Build: Nov 1 00:00 to **Nov 14 23:59**. Judging Nov 16–18, results by Nov 18 23:59.
- Payout: in one payment in NEAR to the named mainnet account, within 30 days, no vesting.

## Prizes
$250K: grand prize $55K; in each of the 13 tracks $10K / $3K / $2K. One project can enter several tracks.
One person can have up to 2 independent projects (each discloses the other in its README).

## What to submit
1. **A public repository** with a LICENSE (any, MIT is fine); it stays public until the end of judging.
2. **README** for a machine and for a human: what it is, what problem it solves, how NEAR is built in; steps "do X, see Y";
   disclosure of libraries, templates and AI-generated code; if the repo is old, tags `pre-hackathon` /
   `hackathon-submission` and a link to the diff.
3. **A post on X**: "built at NEAR HACKATHON", the tags **@NEARProtocol** and **#NEARHackathon** are required (optionally @NearLegion,
   @NearBuilders) + a demo video or screenshots (for a local demo, a video is required). There is no limit on the video length;
   90 seconds is our choice. A person publishes it, the link to the post = `demoUrl`.
4. **The form** https://nearhackathon.com/#apply or `POST https://nearhackathon.com/api/applications`: once per project.
   Fields: projectName, leadName, email (≤ 2 submissions per email), size (`1 | 2 - 4 | 4 - 6 | 6 - 8 | 8+`), tracks[] (ids:
   `privacy`, `security`, `open`, `social`, `realworld`, `agents`, …), nearAddress (mainnet), projectUrl, demoUrl,
   idea (20–2000 characters), consent=true. **`website` is a spam trap: any value = refusal.** `requestId` is a UUID,
   generated once and reused on retries. Codes: 201 saved; 400 → fix the fields, same requestId;
   403 → the window is closed or cross-site, do not repeat; 409 → duplicate repo or email limit, **do not get around it** by changing the link/email;
   413 → shorten; 503 → wait, same requestId. **A submission cannot be edited**: one chance. `consent: true` only
   after the person has read the contact notice text verbatim. Do **not commit** a payload with personal data;
   the agent prints the full JSON and waits for an explicit "yes".

## Screening
Claude Code and Codex clone the repo, check reproducibility and that the features work as in the README, and give a
preliminary score. People decide; a low AI score alone does not eliminate. HACKATHON.md has no numeric criteria or weights, only
"judged on" notes per track (Real-World Money: "something a normal company could use tomorrow"; Privacy and Security have no notes).
Criteria of past hackathons: technical implementation, design, impact, originality, sustainability.
All 13 track ids: `defi`, `thesis`, `privacy`, `business`, `swarms`, `security`, `agents`, `realworld`, `games`,
`nfts`, `memecoins`, `social`, `open`.

## Technical
- Testnet projects are allowed. NEAR Intents has no testnet: only mainnet with pennies, dry-run quotes;
  without a partner JWT the fee is +0.2–0.25%. Mainnet spending is not reimbursed.
- A local demo is allowed if the repo is reproducible and there is a video; hosting is a plus; keep it up until Nov 18, better until Nov 25.
- Secrets only in environment variables. Deploy to mainnet, signing transactions, spending tokens, publishing the repo, a post on X,
  push/force-push, committing secrets, sending the form: only with the human's explicit confirmation (HACKATHON.md requires this
  from AI agents).
- IP stays with the team; the organizers get non-exclusive promo rights.

## Submission checklist (Nov 14)
- [x] `git clone` → README → everything runs on someone else's machine: a fresh clone of `main` on Nov 14 (install, 434 tests, `pnpm demo`, `demo:controls`, `demo:log`), on our own machine
- [x] LICENSE in the root (MIT)
- [x] README: what it is, steps "do X, see Y", limits, disclosures, diff link; the "NEAR provides / Ainek adds" and trust tables, metrics and next steps since Nov 14 are in `docs/DETAILS.md` and `docs/METRICS.md`, the README links to them
- [x] No secrets in the history (`gitleaks` or a manual check): Nov 12, all branches and PR heads, DEV-NOTES; repeat before the tag
- [ ] Tag `hackathon-submission`
- [x] Video uploaded, the post on X published, the link copied: https://x.com/kingleard_/status/2121621128829681958 (Nov 14, 15:07 UTC, Dastan's account)
- [ ] A mainnet NEAR account for the prize exists and is under the team's control
- [ ] Form: the website field is empty; the 201 response is saved
