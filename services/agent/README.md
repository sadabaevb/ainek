# agent

The Tier-2 agent (`docs/SPEC.md` §3.6, §7.2): the owner writes in Telegram, the attested model turns the text into an action
under E2EE, a policy job in an OutLayer TEE signs a decision, and the contract checks that decision before any token moves. A
proposed action leaves two salted commits and the files to open them; a message that proposes nothing leaves no proof.

**Status:** tested against fakes (`pnpm -F agent test`), with the model step, the key-scope check and the stop command also run
live. The contract, the policy job, the demo token and the agent account are on testnet since Nov 6 (`docs/DEPLOY.md`, "Deployed Tier 2
accounts"), and on Nov 7 a payment, a denial, a token refusal and an approval went through the Telegram bot and the whole chain (the model, the policy job over HTTPS with its attestation checked, the contract, the token). The owner signed the approval with their own key. A rejection, an approval and the stop button ran on chain the same day from a script with a placeholder model proof. What has not run live is in `docs/DETAILS.md`, "The agent half (Tier 2)". Open questions are in `docs/DEV-NOTES.md`.

```bash
pnpm -F agent start              # the Telegram bot; variables in .env.example, setup in docs/DEPLOY.md
pnpm -F agent once "pay aibek.ainek-dev-dastan.testnet 2 AINEK for October"   # one message without Telegram, the card goes to the terminal
pnpm demo:stop                   # the stop button: DeleteKey + pause_agent, on the owner's machine, keys from .env.owner
```

| File | What it does |
| --- | --- |
| `src/llm.ts` | owner text → `Action`, through function tools on `runTier1` from `@ainek/tier1-node` (amounts are converted in `packages/proof/src/token.ts`) |
| `src/policy.ts` | HTTPS call to the OutLayer job (§6.2), under a deadline |
| `src/chain.ts` | `propose_action`, `commit_proof`, `spent_today`, and the check of the key's on-chain scope |
| `src/store.ts` | proofs, salts and unfinished intents on disk, written durably |
| `src/pipeline.ts` | one message end to end; everything behind interfaces |
| `src/card.ts`, `src/bot.ts` | the card the owner reads; the owner-only grammY bot |
| `src/stop.ts`, `src/stop-cli.ts` | the stop button |

What it cannot do on purpose: approve its own actions. `approve` and `reject` are commands the owner runs with their own key,
the service refuses to start if `OWNER_PRIVATE_KEY` or `AGENT_ADMIN_PRIVATE_KEY` is in its environment, and it refuses a
signing key whose on-chain scope is wider than `propose_action` and `commit_proof`.

To audit an exchange, give `/auditor` the `model-<commit>.json` file from `AGENT_DATA_DIR` and the agent's account: it is the
agent that committed, not the owner. An action proof is checked with `verifyActionProof` from `@ainek/proof`, against the policy key and
build registered on-chain; `/verify` does the same in a browser.
