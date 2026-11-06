// One owner message, end to end (SPEC §7.2): model → policy → contract → action proof. Every dependency is an interface so
// the whole path runs in tests with fakes; main.ts wires the real ones. Nothing is proposed unless the decision passes the
// local checks, and nothing is sent to the model unless the key log confirms the attested key (inside extract). Nothing
// after propose_action can throw out of here: by then the money may have moved, and the owner must get the action id.
import { buildActionProof, checkPolicyOutput, type Check, type CommittedActionProof, type ModelProof, type PolicyInput, type PolicyOutput } from '@ainek/proof';
import type { ActionChain, Proposed } from './chain.ts';
import { ContractRefused, errorText } from './errors.ts';
import type { Extraction } from './llm.ts';
import type { PolicyEvaluator } from './policy.ts';
import type { ProofKeeper } from './store.ts';

export interface Deps {
  extract: (text: string) => Promise<Extraction>;
  policy: PolicyEvaluator;
  chain: ActionChain;
  keep: ProofKeeper;
  /** From config: the build the deployed job should report. */
  wasmHash: string;
  /** Which code made the decision, from the run's attestation (`outLayerRunCheck`). */
  checkRun: (attestationUrl: string, input: PolicyInput, output: PolicyOutput) => Promise<Check[]>;
  now?: () => number;
}

export type Result =
  | {
      kind: 'proposed';
      /** Verdict, action id and transactions are in here. What happened to the action afterwards is the chain's to say (`action(id)`). */
      proof: CommittedActionProof;
      transfer: Proposed['transfer'];
      /** Call once the owner has been told: until then a restart must warn about this payment. */
      settle: () => Promise<void>;
      /** What the payment is for, for the card only: never on-chain. */
      purpose: string;
      /** Carries `commitTx`: its commit landed before the action was proposed. */
      modelProof: ModelProof;
      /** Why the action proof has no commit; the action itself already happened. */
      commitError: string | null;
      /** The commit landed, but the file on disk does not record its transaction. The salt is saved. */
      saveError: string | null;
    }
  | { kind: 'declined' | 'bad-call'; reason: string; modelProof: ModelProof }
  | { kind: 'not-sent'; step: string; reason: string }
  /** The policy answered, but the answer is not one this agent may act on: nothing proposed, no gas spent. */
  | { kind: 'decision-rejected'; checks: Check[]; modelProof: ModelProof }
  /** `after-propose`: the action is on-chain and the reason names it. `chain`: a transaction may have landed. Every other stage ended with nothing moved. */
  | { kind: 'failed'; stage: 'model' | 'store' | 'policy' | 'commit' | 'contract' | 'chain' | 'after-propose'; reason: string; settle?: () => Promise<void> };

const PAUSED = 'this agent is paused on the contract: the owner has to lift the pause first';

export async function handleOwnerText(deps: Deps, text: string): Promise<Result> {
  const now = deps.now ?? Date.now;

  // 0. Paused, or no room for the whole action? Stop before the paid model and policy calls, not after a transfer that could then never be proven.
  try {
    const [state, room] = await Promise.all([deps.chain.agentState(), deps.chain.roomForAction()]);
    if (state.paused) return { kind: 'failed', stage: 'policy', reason: PAUSED };
    if (!room) return { kind: 'failed', stage: 'commit', reason: 'the agent has no prepaid storage left for one more action: call deposit_storage' };
  } catch (err) {
    return { kind: 'failed', stage: 'policy', reason: errorText(err) };
  }

  // 1. The model, under E2EE, with the fail-closed log check: an Action or a reason there is none, plus the model proof.
  const x = await deps.extract(text);
  if (x.kind === 'not-sent') return { kind: 'not-sent', step: x.step, reason: x.reason };
  if (x.kind === 'failed') return { kind: 'failed', stage: 'model', reason: `${x.step}: ${x.reason}` };
  const proven = x.outcome.proof;
  if (x.kind === 'declined' || x.kind === 'bad-call') return { kind: x.kind, reason: x.reason, modelProof: proven };
  const modelProofCommit = proven.commit;
  if (!modelProofCommit) return { kind: 'failed', stage: 'model', reason: 'the model proof carries no commit' };
  // The salt goes to disk before the commit can reach anyone: a commit nobody can open proves nothing.
  try {
    await deps.keep.model(x.outcome);
  } catch (err) {
    return { kind: 'failed', stage: 'store', reason: errorText(err) };
  }

  // 2. The policy, inside its TEE; then the local checks on what came back.
  let evaluated;
  let registered;
  let input: PolicyInput;
  try {
    registered = await deps.chain.agentState(); // read again: the model took seconds, and the contract rejects a decision made for a stale daily total
    if (registered.paused) return { kind: 'failed', stage: 'policy', reason: PAUSED };
    input = { action: x.action, model_proof_commit: modelProofCommit, spent_today: registered.spentToday, now: now() };
    evaluated = await deps.policy.evaluate(input);
  } catch (err) {
    return { kind: 'failed', stage: 'policy', reason: errorText(err) };
  }
  const { output, attestationUrl } = evaluated;
  const checks = checkPolicyOutput(output, { action: x.action, modelProofCommit, teePubkey: registered.teePubkey, wasmHash: deps.wasmHash, now: now() });
  if (checks.some((c) => c.status === 'fail')) return { kind: 'decision-rejected', checks, modelProof: proven };
  // Money moves on this: a check that could not run counts as failed.
  let runChecks;
  try {
    runChecks = await deps.checkRun(attestationUrl, input, output);
  } catch (err) {
    return { kind: 'failed', stage: 'policy', reason: `the policy run's attestation could not be checked: ${errorText(err)}` };
  }
  const unproven = runChecks.filter((c) => c.status !== 'ok').map((c) => ({ ...c, status: 'fail' as const }));
  if (unproven.length > 0) return { kind: 'decision-rejected', checks: unproven, modelProof: proven };

  // 3. The model proof's commit, before any money can move. The contract refuses a proposal whose model proof this agent has not committed.
  let modelProof: ModelProof;
  try {
    modelProof = { ...proven, commitTx: await deps.chain.commitProof(modelProofCommit, 'model', proven.logIndex) };
  } catch (err) {
    return { kind: 'failed', stage: 'commit', reason: errorText(err) };
  }
  // The intent goes to disk last before the money: a crash from here until the action proof is saved leaves it, and the restart warns the owner, who could otherwise resend and pay twice.
  try {
    await deps.keep.model({ ...x.outcome, proof: modelProof });
    await deps.keep.intent({ modelProofCommit, action: x.action, decision: output.decision, teeSignature: output.sig, at: new Date(now()).toISOString() });
  } catch (err) {
    return { kind: 'failed', stage: 'store', reason: errorText(err) };
  }

  // 4. The contract: it repeats the checks it can, then executes, parks or denies.
  let proposed;
  try {
    proposed = await deps.chain.proposeAction({ action: x.action, modelProofCommit, decision: output.decision, teeSignature: output.sig });
  } catch (err) {
    if (!(err instanceof ContractRefused)) return { kind: 'failed', stage: 'chain', reason: errorText(err) }; // the intent stays: a transaction may have landed
    // Refused on-chain, so no resend can pay twice and the intent is done with. If removing it fails, the next start warns about a payment that did not happen: the safe side.
    await deps.keep.settled(modelProofCommit).catch(() => undefined);
    return { kind: 'failed', stage: 'contract', reason: err.message };
  }
  const settle = () => deps.keep.settled(modelProofCommit);

  // 5. The action proof and its salted commit, salt saved first. The action already happened, so nothing from here on may throw or read as "nothing happened".
  if (proposed.actionId === null) return { kind: 'failed', stage: 'after-propose', reason: `transaction ${proposed.txHash} landed, but the contract named no action: check it on the explorer before retrying`, settle };
  let proof: CommittedActionProof;
  try {
    proof = buildActionProof({ actionId: proposed.actionId, action: x.action, modelProofCommit, decision: output.decision, teeSignature: output.sig, teePubkey: output.pubkey, wasmHash: output.wasm_hash, attestationUrl, proposeTx: proposed.txHash });
  } catch (err) {
    return { kind: 'failed', stage: 'after-propose', reason: `action #${proposed.actionId} is on-chain (transaction ${proposed.txHash}), but its proof could not be built: ${errorText(err)}`, settle };
  }
  let commitError: string | null = null;
  let saveError: string | null = null;
  try {
    await deps.keep.action(proof);
    proof = { ...proof, commitTx: await deps.chain.commitProof(proof.commit, 'action', proven.logIndex) };
  } catch (err) {
    commitError = errorText(err);
  }
  if (proof.commitTx) {
    try {
      await deps.keep.action(proof);
    } catch (err) {
      saveError = errorText(err);
    }
  }
  return { kind: 'proposed', proof, purpose: x.purpose, modelProof, commitError, saveError, transfer: proposed.transfer, settle };
}
