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

## How NEAR is used

| Layer | NEAR provides (shipped) | Ainek adds |
| --- | --- | --- |
| Inference in TEE, attestation, response signatures, E2EE, JS SDK | NEAR AI Cloud, `@nearai/inference-sdk` | used as-is |
| Verifying an answer | Verification Center (signature + fresh attestation; cannot recompute hashes; no allowlist) | local hash recomputation; check against a **public log**, not the vendor's current answer; a card a non-technical user can read |
| Key & measurement log | none | append-only log in a NEAR contract, independent verifiers, fail-closed client, split-view detection |
| Agents in TEE | IronClaw runtime (no policies, limits or proofs); Shade Agents (deprecated Apr 2026) | agent mandate + policy; decision signed inside TDX (OutLayer); contract executes; public proof without details; stop button |
| Private team payments | NEAR Business, Trezu (human signers, Confidential Intents) | an *agent* signer with a verifiable mandate — a layer on top, not a replacement |
| NEAR primitives | function-call keys, sub-accounts, NEP-141, NEP-297 events, `ed25519_verify` | — |

## Try it (do X → see Y)

<!-- TODO: keep this section runnable from a clean clone. Judges' first reviewer is an AI agent following these steps. -->

```bash
git clone https://github.com/<org>/ainek && cd ainek
cp .env.example .env            # fill NEARAI_API_KEY (cloud.near.ai → API Keys) — testnet needs nothing else
pnpm i
pnpm demo                        # → prints: key logged at index N, model verified, proof committed (tx …), re-verified OK
pnpm -F web dev                  # → open http://localhost:3000, send "hello" → proof card with ✓ rows and a nearblocks link
```

1. **See the log:** open `/log` → entries from `v1.ainek.testnet` and `v2.ainek.testnet` for `z-ai/glm-5.3-flash`.
2. **See fail-closed:** `pnpm demo:tamper` → the client refuses to send ("key …a3f1 not in log").
3. **Re-verify a proof yourself:** paste the proof JSON into `/verify` → hashes recomputed, signature checked, log entry matched.
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
