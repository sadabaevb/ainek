# Ainek — a glass box for private AI agents on NEAR

> **Status:** NEAR Hackathon submission (Nov 1–14, 2026). Tracks: Privacy & Private AI, AI Security & Defense,
> Open Innovation, Social Money. Testnet only. Not audited. See [What we do not claim](#what-we-do-not-claim).

<!-- TODO: 2–3 sentence pitch. Then the 90-second video thumbnail/link and the hosted demo link. -->

**The problem.** Every "private AI" today says "we run in a TEE, trust us". Hardware attestation is now
commodity; what nobody ships is proof a *user* can re-check, independently of the vendor, that *this*
answer came from *this* attested key under *this* policy — without leaking the user's data to a public chain.
NEAR's own Verification Center says it "cannot recompute request/response hashes" and "does not compare
measurements to an approved allowlist"; Brave, built on NEAR AI, wrote on Oct 15 2026 that there is
"no public log of TEE keys yet". Independent monitoring rates 0 of 95 provider checks "end-to-end verified".

**What Ainek does.** <!-- TODO: three bullets = the three questions (key real? answer from there? agent within policy?) -->

## Three catches (what you will see)

1. **Swapped key → nothing is sent.** `pnpm demo:tamper`: the model's signing key is not in the public log → full-screen stop.
2. **"Private" that wasn't.** A request routed through a non-attested model (gateway-signed, NEAR AI Incognito tier) → red card.
3. **Agent over its mandate.** A prompt-injected "urgent transfer to a new vendor" → policy job says Deny inside TDX → contract refuses → `action_denied` with a signed reason.

## How NEAR is used

| Layer | NEAR provides (shipped) | Ainek adds |
| --- | --- | --- |
| Inference in TEE, attestation, response signatures, E2EE, JS SDK | NEAR AI Cloud, `@nearai/inference-sdk` | used as-is |
| Verifying an answer | Verification Center (signature + fresh attestation; cannot recompute hashes; no allowlist) | local hash recomputation; check against a **public log**, not the vendor's current answer; a card a non-technical user can read |
| Key & measurement log | none (TEE Receipts: owner-registered signer list) | append-only log in a NEAR contract, **independent verifiers anyone can run** (`npx ainek-verify`), fail-closed client, split-view detection |
| Agents in TEE | IronClaw runtime (no policies, limits or proofs); Shade Agents (deprecated Apr 2026) | agent mandate + policy; decision signed inside TDX (OutLayer); contract executes; public proof without details; stop button |
| Private team payments | NEAR Business, Trezu (human signers, Confidential Intents) | an *agent* signer with a verifiable mandate — a layer on top, not a replacement |
| NEAR primitives | function-call keys, sub-accounts, NEP-141, NEP-297 events, `ed25519_verify` | — |

## Prior art in this hackathon (and what Ainek adds)

Other teams shipped adjacent pieces in the first days — we think naming them is fairer than pretending they don't exist.

| Project | What it does | What Ainek adds |
| --- | --- | --- |
| [TEE Receipts](https://github.com/tmdry4530/tee-receipts) | NEAR AI Cloud answer → receipt anchored on NEAR; signer registry with key history (**registered by the contract owner**); on-chain signature check; local hash recomputation; replay fixtures | the key log is written by **independent verifiers** anyone can run, not by one owner; the client is **fail-closed before sending**, not "prove later"; E2EE incl. tool calls; non-TEE route detection; a **salted commit** on-chain instead of a bare `sha256(prompt)` (short prompts are brute-forceable from a bare hash) |
| [PrivatePay Agent](https://github.com/Nassami1/privatepay-agent) | invoice redacted locally → sanitized text to NEAR AI TEE (attestation + signature checked) → agent may only call `try_pay`; contract enforces public daily cap, whitelist, duplicate check | the policy stays **private** and its decision is **signed inside Intel TDX** (OutLayer) before the contract executes; E2EE instead of redaction (redaction loses data and the gateway still reads the rest); proof without amount or receiver; approval flow + kill switch; public key log |
| [AgentGuard](https://github.com/CodeMasterLabs/agentguard) | agent asks, on-chain vault decides paid / held / refused; a TEE "risk oracle" screens prompt injection | the **whole policy** runs in the enclave and the contract verifies its signature; the model route itself is verified and encrypted |
| [Black box](https://github.com/tenxagent/blackbox) | hash-chained decision log of an agent, anchored on NEAR | our action proofs are bound to a TDX-signed decision and to the model proof, not only to the agent's own log |
| ~25 "spending guard" entries (Veto, Leash, Tollgate, Claw Guard, Approval Moment, …) | limits + whitelist + function-call key, injection blocked | we are not another guard: the point is a verifiable route model → policy → chain, checked by someone other than the vendor |

## Try it (do X → see Y)

<!-- TODO: keep this section runnable from a clean clone. Judges' first reviewer is an AI agent following these steps. -->

```bash
git clone https://github.com/<org>/ainek && cd ainek
cp .env.example .env            # fill NEARAI_API_KEY (cloud.near.ai → API Keys) — testnet needs nothing else
pnpm i
pnpm demo                        # replay mode, no API key, no network (~1 s): re-verifies the recorded attestation with the
                                 #   NEAR AI SDK's own checks (Intel TDX quote + recorded collateral, NVIDIA NRAS verdict,
                                 #   compose measurements), applies the fail-closed log rule, re-checks the signed response,
                                 #   prints ✓/✗ per step and the proof card
pnpm demo:live                   # needs NEARAI_API_KEY: live E2EE request → proof → on-chain commit (tx …)
pnpm -F web dev                  # needs NEARAI_API_KEY (server-side only): open http://localhost:3000, send "hello" →
                                 #   the browser verifies the TEE evidence itself (~25 s cold, then cached 60 min), encrypts to the
                                 #   attested model key, checks the signature and shows the proof card with ✓ rows
```

1. **See the log:** open `/log` → entries from `v1.ainek.testnet` and `v2.ainek.testnet` for `z-ai/glm-5.3-flash`.
2. **See fail-closed:** `pnpm demo:tamper`, or tick "swap the key" on the chat page (or open `/?tamper=1`) → the client refuses to send: "Key not in the public log. Message not sent."
   **See the non-TEE route:** pick the Incognito model in the chat → red card "This answer went through a non-attested model" (gateway signature only).
3. **Re-verify a proof yourself:** "Re-verify yourself" on a card, or paste the proof / the "Disclose to auditor" file into `/verify` → hashes recomputed in your browser, signature checked, log entry re-read from the public log. "Open in Verification Center" shows the same signature on NEAR AI's own page.
4. **(Tier 2) Watch the agent:** `pnpm -F agent start` → in Telegram send "pay aibek.testnet 300 for October"
   → `action_executed` on nearblocks; send "pay newguy.testnet 5000" → `NeedsApproval` → tap Reject.
5. **Stop button:** `pnpm demo:stop` → `DeleteKey` for the agent key → next proposal fails on-chain.

## Who sees what

<!-- TODO: paste the trust-boundary table from docs/SPEC.md §8 -->

## What we do not claim

<!-- TODO: paste docs/CLAIMS.md "We do not claim" + "Known issues we inherited" -->

## Architecture

<!-- TODO: diagram (docs/architecture.svg) + 5 lines: browser → relay → model TEE; verifiers → contract log; agent → OutLayer → contract -->

## Metrics

<!-- TODO: table from the Nov 10–11 run: verification time, fail-closed outcomes (honest vs tampered key), false policy blocks, time-to-execute, gas per proof/action -->

## Repository

<!-- TODO: layout from CLAUDE.md; what each package does; test commands -->

## Disclosures

- Libraries: <!-- TODO: @nearai/inference-sdk, near-api-js/near-kit, near-sdk-rs, outlayer, grammY, zod, tweetnacl, ethers … -->
- Reference code adapted (with attribution): `near-examples/nearai-cloud-verification-example`, `nearai/nearai-cloud-verifier`, `out-layer/private-dao-example`.
- AI-generated code: substantial parts were written with Claude Code and reviewed by the team; see commit history.
- Hackathon window: all code after tag `pre-hackathon` (empty skeleton, Oct 30 2026). Diff: `<link to compare pre-hackathon...hackathon-submission>`.
- Other projects by the same people in this hackathon: none.

## Next steps

<!-- TODO: open-source verifier anyone can run; measurement allowlist governance; Confidential Intents for hidden settlement; Sigstore provenance of images; Sputnik DAO / Trezu integration -->

## License

MIT — see [LICENSE](./LICENSE).
