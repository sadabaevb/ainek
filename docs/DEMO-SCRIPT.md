# Demo video script — 90 seconds, English

The video as it was made on Nov 14, 2026. It is built around the one idea of the README: the hardware vouches for a key
and a launcher, the code behind the key changes, and Ainek is the public log and the client that act on that. It
replaces the script of Nov 11 ("three catches": a swapped key, a model without hardware proof, an agent talked into a
payment), which is in this file's history.

It works without sound: every scene carries its message as text on screen, because the post on X plays muted. The voice
is an addition.

| Time | On screen | Voice-over |
| --- | --- | --- |
| 0:00–0:07 | **The gap.** A drawing: your message, encrypted to the key, enters an enclave that holds the signing key, a proxy and the model. A stamp "attested by hardware", the line "measured by the hardware: this key and the launcher", then the proxy turns red: "Deployed after boot. Which build is it today?" Headlines: "The hardware vouches for the enclave." / "It measures a launcher. What runs after boot can change behind the same key." | "Private AI runs in a sealed enclave. The hardware vouches for its key and its launcher, not for the code deployed after boot." |
| 0:07–0:18 | **What the record shows.** A time axis from Oct 21 to Nov 12: one bar for the signing key, unchanged, and under it five proxy images in turn (from Oct 21, Oct 24, Nov 6, Nov 8, Nov 12). Then "5 builds of the proxy", "1 signing key, unchanged", "3 weeks", and "Each build has signed provenance from NEAR AI's public repository. The key alone cannot tell you which one you are talking to." | "NEAR AI's own attested record shows it: in three weeks, five builds of the proxy that decrypts your prompt, behind one unchanged key. The key can't tell you which one answers." |
| 0:18–0:29 | **Ainek.** A drawing: three verifiers (two "ours", one "a friend's") write to a hash-chained log in a NEAR contract; entries #102 to #105 as they stood that day, three of them with a release mark; your browser asks the log before a message leaves; "logged → encrypted and sent", "not logged → nothing is sent". Headlines: "Ainek: a public log of each key and the release behind it, on NEAR." / "Your browser sends nothing to a key your verifiers did not log." | "Ainek borrows the idea of Certificate Transparency. Verifiers log each key, and the release behind it, in a NEAR contract. Your browser sends nothing to a key your verifiers did not log." |
| 0:29–0:39 | **Real run: a swapped key.** The hosted chat: "Swap the key before sending" → the progress strip → the red card "Key not in the public log. Message not sent.", then a closer view of the card. Beside it: "Refused in the browser. The prompt never left this page." | "A real run, on testnet. We hand the page a swapped key. It refuses in the browser, and the prompt never leaves." |
| 0:39–0:50 | **Real run: the release rule.** The hosted chat: tick "Stricter: send only when a verifier you trust has marked this state of the enclave", type a question, Send → the red card "No release mark in the log. Message not sent." Beside it: "Today the site's default verifier wrote no release marks. That is the rule's cost, and why it is opt-in." | "Verifiers also mark each release. One switch: no mark from a verifier you trust, no message. Today our default verifier wrote none, so it refused." |
| 0:50–0:58 | **The release, followed.** From `/log`, "Code behind the key": "release v0.0.593, deployed 2026-11-14 02:28 UTC; its proxy was built from nearai/inference-proxy@3f7e979827", then the line "key log: the action log as it stands (280 actions) is marked by anas-verifier.testnet since 2026-11-14 06:56 UTC". Text: "A friend's verifier did mark this state… Add that verifier to the ones you trust, and this check passes. You choose which verifiers count." | "On request, your browser follows the release to a source commit. A friend's verifier did mark it. Trust that one, and the check passes." |
| 0:58–1:05 | **A proof for every answer.** The proof card of a real answer, its rows framed one after another; a list beside it (hardware checked in your browser, key in the public log, signed in the enclave and hashes recomputed, end-to-end encryption, "On NEAR, if you commit it: a salted hash, never the text"); the stamp "This disclosure checks out" from `/auditor`. | "When it checks out, every answer becomes a proof you can hand to an auditor. On NEAR: only a salted hash." |
| 1:05–1:13 | **Agents that spend.** A drawing: the agent (its key can call `propose_action`) → a private policy inside Intel TDX that signs its verdict → the NEAR contract that checks the signature. A proposal "pay 5000 AINEK → newguy.testnet" travels to the policy, "verdict: DENY · signed in the TEE" to the contract: "Denied by policy v1. Nothing moved." "On chain: the attempt and the verdict. Off chain: the conversation and the policy." | "Agents can only propose a payment. A policy inside Intel TDX signs the verdict, and the NEAR contract checks the signature." |
| 1:13–1:18 | **The real record.** `/agent`, action #4 with its four checks, then the same record with the verdict edited to Allow: the signature check turns red. "And a stop button: it deletes the agent's key and pauses the agent." | "Five thousand to a new vendor: denied. Edit the record, and the signature fails." |
| 1:18–1:24 | **Check it yourself.** A terminal: `pnpm i && pnpm demo` → three lines of checks → "Result: VERIFIED"; `pnpm demo:controls` → three refusals → "Result: REFUSED. 15 of 15 changes were refused." Beside it: "Don't trust our page. Clone it." | "Don't trust our page: clone it. The checks replay offline, with no API key." |
| 1:24–1:30 | **End card.** The mark and the name, the one-line description, "What we do not claim" (testnet, not audited, we can still replace the contract; an attested deployment, not verified weights; two of the three verifiers are ours, the third is a friend's), "BUILT AT NEAR HACKATHON", the repository and the hosted demo. | "Ainek. Testnet, not audited. Built at NEAR Hackathon." |

## What is recorded and what is drawn

Each scene says where its picture comes from in a line at the bottom left.

- **Drawn:** the gap, the time axis (its dates are those of `docs/RELEASE.md`: the replica that answered us on Nov 12),
  the picture of the log (its entries and their marks are the log's own on Nov 14) and the flow of an agent's payment.
- **Recorded on Nov 14 from https://ainek.vercel.app:** the two refusals, frame by frame as the screen changed, by a
  browser without a window. Both end before a send, and that browser was also set to drop any chat completion, so
  nothing could reach the model and the key was not spent. The pointer is drawn over the recording. The wait for the
  hardware check runs faster than it did: 8 seconds shown in 3.4, and 5.4 in 2.1. The source line says so.
- **Stills of Nov 14:** the release check on `/log` (with the default trust set, and with the rule on and
  `anas-verifier.testnet` trusted), action #4 on `/agent` and its edited copy, the stamp on `/auditor`.
- **A still of Nov 12:** the proof card, the one in `docs/screenshots/proof-card.png`.
- **The terminal:** lines of the real output of `pnpm demo` and `pnpm demo:controls` at commit `e78eed7`, shortened.

Not in the video: an answer arriving live, a commit signed by a wallet, the Telegram bot, the stop button being pressed,
the Incognito model's red card. The video says "this check passes" about the release rule with the friend's verifier
trusted and not "the message is sent": a message with the rule on has not been sent end to end yet.

## How it was reviewed

A reader who had not seen the project went through the first cut frame by frame, once as a judge watching without a
pause button and once against `docs/CLAIMS.md`. What changed after it:

- The log is introduced as "each key and the release behind it", with the idea credited to Certificate Transparency.
  Before, a scene about code changing behind one key was followed by "a log of keys", which did not answer it.
- The refusal by the release rule says why it happened that day (the site's default verifier wrote no release marks) and
  calls it the rule's cost. The first cut said "like today's" and read as if a release had been caught.
- The record of five builds is presented as NEAR AI's own, public by design, with each build's provenance named.
- "Six releases since Nov 4" (another replica, another day, another unit than the five builds) is gone.
- "Without us" became "themselves"; "private: the conversation and the policy" became "off chain"; the limits moved to
  the end card and now say that we can still replace the contract; the source lines are larger.

## How it is made

One HTML page, 1920×1080, in the site's own type and colours, with every animation on a single clock. A script sets the
clock to each of the 2,700 frames and photographs the page; ffmpeg joins the frames (H.264, 30 frames a second). The
recordings play inside it as numbered frames. The voice is the macOS system voice and can be replaced by a person's:
the lines and their start times are in the table above. A second file has the same picture with no voice. The page and
the scripts are kept outside the repository.

## X posts

Each within 280 characters by X's count (a link counts as 23). The video is attached to the first.

- Post (278): "Ainek, built at NEAR HACKATHON. A TEE key can stay the same while the code behind it changes: 5 proxy builds in 3 weeks, by NEAR AI's public record. So: a public log of keys and releases on @NEARProtocol, and a client that refuses what your verifiers did not log. #NEARHackathon"
- Reply with the repo link (243 with the link): "Repo: https://github.com/sadabaevb/ainek. You choose which verifiers count; today two are ours and one is a friend's. Every proof re-checks in your browser, and `pnpm demo` replays the checks offline with no API key. What we do not claim is in the README."
