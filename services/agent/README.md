# agent

The Tier-2 agent (`docs/SPEC.md` §3.6, §7.2): the owner writes in Telegram, the attested model turns the text into an action
under E2EE, a policy job in an OutLayer TEE signs a decision, and the contract checks that decision before any token moves.
Every step leaves a proof.

**Status:** tested against fakes (`pnpm -F agent test`), with the model step and the stop command also run live. It has not run
end to end, because contract §4.3 and the deployed policy job do not exist yet. Open questions are in `docs/DEV-NOTES.md`.

```bash
pnpm -F agent start              # the Telegram bot; variables in .env.example, setup in docs/DEPLOY.md
pnpm -F agent once "pay vendor1.testnet 300 for hosting"   # one message without Telegram, the card goes to the terminal
pnpm demo:stop                   # the stop button: DeleteKey + pause_agent, on the owner's machine, keys from .env.owner
```

| File | What it does |
| --- | --- |
| `src/llm.ts` | owner text → `Action`, through function tools on `runTier1` from `@ainek/tier1-node` |
| `src/policy.ts` | HTTPS call to the OutLayer job (§6.2) |
| `src/chain.ts` | `propose_action`, `commit_proof`, `spent_today` with the function-call key |
| `src/proof.ts`, `src/store.ts` | the action proof (§5.2); proofs and salts on disk |
| `src/pipeline.ts` | one message end to end; everything behind interfaces |
| `src/card.ts`, `src/bot.ts` | the card the owner reads; the owner-only grammY bot |
| `src/stop.ts`, `src/stop-cli.ts` | the stop button |

What it cannot do on purpose: approve its own actions. `approve` and `reject` are commands the owner runs with their own key,
and the service refuses to start if it finds an owner key in its environment.
