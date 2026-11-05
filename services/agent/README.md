# agent

The Tier-2 agent (`docs/SPEC.md` §3.6, §7.2): the owner writes in Telegram, the attested model turns the text into an action
under E2EE, a policy job in an OutLayer TEE signs a decision, and the contract checks that decision before any token moves. A
proposed action leaves two salted commits and the files to open them; a message that proposes nothing leaves no proof.

**Status:** tested against fakes (`pnpm -F agent test`), with the model step, the key-scope check and the stop command also run
live. It has not run end to end, because contract §4.3 and the deployed policy job do not exist yet. Open questions are in
`docs/DEV-NOTES.md`.

```bash
pnpm -F agent start              # the Telegram bot; variables in .env.example, setup in docs/DEPLOY.md
pnpm -F agent once "pay vendor1.testnet 300 for hosting"   # one message without Telegram, the card goes to the terminal
pnpm demo:stop                   # the stop button: DeleteKey + pause_agent, on the owner's machine, keys from .env.owner
```

| File | What it does |
| --- | --- |
| `src/llm.ts`, `src/units.ts` | owner text → `Action`, through function tools on `runTier1` from `@ainek/tier1-node` |
| `src/policy.ts` | HTTPS call to the OutLayer job (§6.2), under a deadline |
| `src/chain.ts` | `propose_action`, `commit_proof`, `spent_today`, and the check of the key's on-chain scope |
| `src/store.ts` | proofs and salts on disk, written atomically |
| `src/pipeline.ts` | one message end to end; everything behind interfaces |
| `src/card.ts`, `src/bot.ts` | the card the owner reads; the owner-only grammY bot |
| `src/stop.ts`, `src/stop-cli.ts` | the stop button |

What it cannot do on purpose: approve its own actions. `approve` and `reject` are commands the owner runs with their own key,
the service refuses to start if `OWNER_PRIVATE_KEY` or `AGENT_ADMIN_PRIVATE_KEY` is in its environment, and it refuses a
signing key whose on-chain scope is wider than `propose_action` and `commit_proof`.

To audit an exchange, give `/auditor` the `model-<commit>.json` file from `AGENT_DATA_DIR` and the agent's account: it is the
agent that committed, not the owner. An action proof is checked with `verifyActionProof` from `@ainek/proof`; the web page for it
does not exist yet.
