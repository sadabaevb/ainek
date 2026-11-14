# Demo video script — 90 seconds, English

The video as made on Nov 14, 2026, built around the one idea of the README: the hardware vouches for a key and a
launcher, the code behind the key changes, and Ainek is the public log and the client that act on that.

It works without sound: every scene carries its message as text on screen, because the post on X plays muted. The voice
is an addition.

| Time | On screen | Voice-over |
| --- | --- | --- |
| 0:00–0:07 | **The gap.** A drawing: your message, encrypted to the key, enters an enclave that holds the signing key, a proxy and the model. A stamp "attested by hardware", the line "measured by the hardware: this key and the launcher", then the proxy turns red: "Deployed after boot. Which build is it today?" Headlines: "The hardware vouches for the enclave." / "It measures a launcher. What runs after boot can change behind the same key." | "Private AI runs in a sealed enclave. The hardware vouches for its key and its launcher, not for the code deployed after boot." |
| 0:07–0:18 | **What the record shows.** A time axis from Oct 21 to Nov 12: one bar for the signing key, unchanged, and under it five proxy images in turn (from Oct 21, Oct 24, Nov 6, Nov 8, Nov 12). Then "5 builds of the proxy", "1 signing key, unchanged", "3 weeks", and "Each build has signed provenance from NEAR AI's public repository. The key alone cannot tell you which one you are talking to." | "NEAR AI's own attested record shows it: in three weeks, five builds of the proxy that decrypts your prompt, behind one unchanged key. The key can't tell you which one answers." |
| 0:18–0:29 | **Ainek.** A drawing: three verifiers (two "ours", one "a friend's") write to a hash-chained log in a NEAR contract; entries #102 to #105 as they stood that day, three of them with a release mark; your browser asks the log before a message leaves; "logged → encrypted and sent", "not logged → nothing is sent". Headlines: "Ainek: a public log of each key and the release behind it, on NEAR." / "Your browser sends nothing to a key your verifiers did not log." | "Ainek borrows the idea of Certificate Transparency. Verifiers log each key, and the release behind it, in a NEAR contract. Your browser sends nothing to a key your verifiers did not log." |
| 0:29–0:39 | **Real run: a swapped key.** The hosted chat: "Swap the key before sending" → the progress strip → the red card "Key not in the public log. Message not sent.", then a closer view of the card. Beside it: "Refused in the browser. The prompt never left this page." | "A real run, on testnet. We hand the page a swapped key. It refuses in the browser, and the prompt never leaves." |
| 0:39–0:50 | **Real run: the release rule.** The hosted chat: tick "Stricter: send only when a verifier you trust has marked this state of the enclave", type a question, Send → the red card "No release mark in the log. Message not sent." Beside it: "For 31 hours the site's default verifier had written no release marks. That is the rule's cost, and why it is opt-in." | "Verifiers also mark each release. One switch: no mark from a verifier you trust, no message. Our default verifier had written none for a day, so it refused." |
| 0:50–0:58 | **The release, followed.** From `/log`, "Code behind the key": "release v0.0.593, deployed 2026-11-14 02:28 UTC; its proxy was built from nearai/inference-proxy@3f7e979827". Then the line "key log: the action log as it stands (280 actions) is marked by anas-verifier.testnet since 2026-11-14 06:56 UTC". Text: "A friend's verifier did mark this state… Add that verifier to the ones you trust, and this check passes. You choose which verifiers count." | "On request, your browser follows the release to a source commit. A friend's verifier did mark it. Trust that one, and the check passes." |
| 0:58–1:05 | **Real run: a proof for every answer.** The hosted chat again, with the same box still ticked. Send. The progress strip runs, then the model's answer and the card "Verified in this browser" appear. A closer view moves down the card. It shows the model, the hardware, the key in the public log (#106, logged by ainek-dev-dastan.testnet), the request and response, end-to-end encryption, and "Code behind the key": release v0.0.593, followed to nearai/inference-proxy@3f7e979827. Text beside it: "09:28 UTC: the default verifier's marks are back. The same box is ticked." / "✓ Sent and answered. Hardware, key in the log, signature, encryption: verified in your browser." / "Hand it to an auditor. On NEAR, if you commit it: a salted hash, never the text." | "Then the marks came back. Same switch, and the message goes. Every answer is a proof you can hand to an auditor." |
| 1:05–1:13 | **Agents that spend.** A drawing: the agent (its key can call `propose_action`) → a private policy inside Intel TDX that signs its verdict → the NEAR contract that checks the signature. A proposal "pay 5000 AINEK → newguy.testnet" travels to the policy, "verdict: DENY · signed in the TEE" to the contract: "Denied by policy v1. Nothing moved." "On chain: the attempt and the verdict. Off chain: the conversation and the policy." | "Agents can only propose a payment. A policy inside Intel TDX signs the verdict, and the NEAR contract checks the signature." |
| 1:13–1:18 | **The real record.** `/agent`, action #4 with its four checks, then the same record with the verdict edited to Allow: the signature check turns red. "And a stop button: it deletes the agent's key and pauses the agent." | "Five thousand to a new vendor: denied. Edit the record, and the signature fails." |
| 1:18–1:24 | **Check it yourself.** A terminal: `pnpm i && pnpm demo` → three lines of checks → "Result: VERIFIED"; `pnpm demo:controls` → three refusals → "Result: REFUSED. 15 of 15 changes were refused." Beside it: "Don't trust our page. Clone it." | "Don't trust our page: clone it. The checks replay offline, with no API key." |
| 1:24–1:30 | **End card.** The mark and the name, the one-line description, "What we do not claim" (testnet, not audited, we can still replace the contract; an attested deployment, not verified weights; two of the three verifiers are ours, the third is a friend's), "BUILT AT NEAR HACKATHON", the repository and the hosted demo. | "Ainek. Testnet, not audited. Built at NEAR Hackathon." |

## What is recorded and what is drawn

Each scene says where its picture comes from in a line at the bottom left.

- **Drawn:** the gap, the time axis (its dates are those of `docs/RELEASE.md`: the replica that answered us on Nov 12),
  the picture of the log (its entries and their marks are the log's own on Nov 14) and the flow of an agent's payment.
- **Recorded on Nov 14 from https://ainek.vercel.app:** the two refusals (about 07:40 UTC) and the answer (09:28 UTC),
  by a browser without a window. For the refusals, that browser dropped every chat completion, so nothing could reach
  the model and the key was not spent. For the answer, it let exactly one through. That was one message, sent with the
  human's yes, with the release rule on and the site's default trust set. The pointer is drawn over the recordings.
  The wait for the hardware check is sped up (8 seconds shown in 3.4, 5.4 in 2.1, 5.3 in 0.9); the source line says so.
- **The closer view of the proof card** is a picture of the same card, taken about a minute after the answer, after
  "Check the release" had been pressed. When the answer arrived, that row read "not checked". The page's fixed header
  covered part of each picture, so the view is put together from two. The source line says it is the card after the
  press.
- **Stills of Nov 14:** the release check on `/log`, action #4 on `/agent` and its edited copy.
- **The terminal:** lines of the real output of `pnpm demo` and `pnpm demo:controls` at commit `e78eed7`, shortened.

Not in the video: a commit signed by a wallet, the auditor's page, the Telegram bot, the stop button being pressed, the
Incognito model's red card. About the release rule with the friend's verifier trusted the video says "this check
passes", not "the message is sent": the one message sent with the rule on went with the default trust set, after its
verifier's marks were back. The video says "31 hours", counted to the recording at about 07:40 UTC; the whole gap was
almost 32 hours (`docs/RELEASE.md`).

## How it was reviewed

A reader who had not seen the project went through the first cut frame by frame, once as a judge watching without a
pause button and once against `docs/CLAIMS.md`. After it the log is introduced as "each key and the release behind
it", with the idea credited to Certificate Transparency; the refusal by the release rule says why it happened and calls
it the rule's cost; the record of five builds is presented as NEAR AI's own, public by design; and the limits moved to
the end card. The scene of the proof was made after that review: the reader saw a still of Nov 12 in its place.

## How it is made

One HTML page at 1920×1080 in the site's own type and colours, photographed frame by frame and joined with ffmpeg; the
recordings play inside it. The voice is the macOS system voice and can be replaced by a person's: its lines and start
times are in the table above. The page and the scripts are kept outside the repository.

## X posts

Each within 280 characters by X's count (a link counts as 23). The video is attached to the first.

- Post (278): "Ainek, built at NEAR HACKATHON. A TEE key can stay the same while the code behind it changes: 5 proxy builds in 3 weeks, by NEAR AI's public record. So: a public log of keys and releases on @NEARProtocol, and a client that refuses what your verifiers did not log. #NEARHackathon"
- Reply with the repo link (243 with the link): "Repo: https://github.com/sadabaevb/ainek. You choose which verifiers count; today two are ours and one is a friend's. Every proof re-checks in your browser, and `pnpm demo` replays the checks offline with no API key. What we do not claim is in the README."
