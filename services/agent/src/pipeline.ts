// One owner message, end to end (SPEC §7.2): model → policy → contract → action proof. Every dependency is an interface so
// the whole path runs in tests with fakes; main.ts wires the real ones. Nothing is proposed unless the decision passes the
// local checks, and nothing is sent to the model unless the key log confirms the attested key (inside extract).
import { checkPolicyOutput, type Check, type ModelProof, type Verdict } from '@ainek/proof';
import { eventNamed, type ActionChain } from './chain.ts';
import type { Extraction } from './llm.ts';
import type { ProofKeeper } from './store.ts';
import type { PolicyEvaluator } from './policy.ts';
import { buildActionProof, type CommittedActionProof } from './proof.ts';

export interface Deps {
  extract: (text: string) => Promise<Extraction>;
  policy: PolicyEvaluator;
  chain: ActionChain;
  keep: ProofKeeper;
  /** From config: what `register_agent` put on-chain. */
  teePubkey: string;
  wasmHash: string;
  now?: () => number;
}

export type Result =
  | {
      kind: 'proposed';
      verdict: Verdict;
      actionId: number;
      proposeTx: string;
      /** The contract executed the transfer in the same transaction (Allow). */
      executed: boolean;
      proof: CommittedActionProof;
      commitTx: string | null;
      modelCommitTx: string | null;
      /** Why a commit is missing; the action itself already happened. */
      commitError: string | null;
      modelProof: ModelProof;
      checks: Check[];
    }
  | { kind: 'declined'; reason: string; modelProof: ModelProof }
  | { kind: 'bad-call'; reason: string; modelProof: ModelProof }
  | { kind: 'not-sent'; step: string; reason: string }
  /** The policy answered, but the answer is not one this agent may act on: nothing proposed, no gas spent. */
  | { kind: 'decision-rejected'; checks: Check[]; modelProof: ModelProof }
  | { kind: 'failed'; stage: 'model' | 'store' | 'policy' | 'chain'; reason: string };

const describe = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export async function handleOwnerText(deps: Deps, text: string): Promise<Result> {
  const now = deps.now ?? Date.now;

  // 1. The model, under E2EE, with the fail-closed log check: an Action or a reason there is none, plus the model proof.
  const x = await deps.extract(text);
  if (x.kind === 'not-sent') return { kind: 'not-sent', step: x.step, reason: x.reason };
  if (x.kind === 'failed') return { kind: 'failed', stage: 'model', reason: `${x.step}: ${x.reason}` };
  const modelProof = x.outcome.proof;
  if (x.kind === 'declined') return { kind: 'declined', reason: x.reason, modelProof };
  if (x.kind === 'bad-call') return { kind: 'bad-call', reason: x.reason, modelProof };
  const modelProofCommit = modelProof.commit;
  if (!modelProofCommit) return { kind: 'failed', stage: 'model', reason: 'the model proof carries no commit' };
  // The model proof's commit reaches the chain inside propose_action, so its salt is saved first: a commit nobody can open proves nothing.
  try {
    await deps.keep.model(x.outcome);
  } catch (err) {
    return { kind: 'failed', stage: 'store', reason: describe(err) };
  }

  // 2. The policy, inside its TEE; then the local checks on what came back.
  let evaluated;
  try {
    const spentToday = await deps.chain.spentToday();
    evaluated = await deps.policy.evaluate({ action: x.action, model_proof_commit: modelProofCommit, spent_today: spentToday, now: now() });
  } catch (err) {
    return { kind: 'failed', stage: 'policy', reason: describe(err) };
  }
  const checks = checkPolicyOutput(evaluated.output, { action: x.action, modelProofCommit, teePubkey: deps.teePubkey, wasmHash: deps.wasmHash, now: now() });
  if (checks.some((c) => c.status === 'fail')) return { kind: 'decision-rejected', checks, modelProof };
  if (!evaluated.attestationUrl) return { kind: 'failed', stage: 'policy', reason: 'OutLayer returned no attestation_url for this run' };

  // 3. The contract: it repeats the checks, then executes, parks or denies.
  let proposed;
  try {
    proposed = await deps.chain.proposeAction({ action: x.action, modelProofCommit, decision: evaluated.output.decision, teeSignature: evaluated.output.sig });
  } catch (err) {
    return { kind: 'failed', stage: 'chain', reason: describe(err) };
  }
  const executed = eventNamed(proposed.events, 'action_executed');
  const proof = buildActionProof({
    actionId: proposed.actionId,
    action: x.action,
    modelProofCommit,
    decision: evaluated.output.decision,
    teeSignature: evaluated.output.sig,
    teePubkey: evaluated.output.pubkey,
    wasmHash: evaluated.output.wasm_hash,
    attestationUrl: evaluated.attestationUrl,
    proposeTx: proposed.txHash,
    executeTx: executed ? proposed.txHash : null,
    approver: null,
  });

  // 4. Two salted commits, both bound to the log entry the model proof points at (SPEC §4.2, §7.2). The action's salt is saved first. The model proof's commit is what /auditor
  // looks up for a disclosed exchange. The action already happened on-chain, so a failure here is reported on the card, not a failed run, and one failing does not stop the other.
  const errors: string[] = [];
  let commitTx: string | null = null;
  try {
    await deps.keep.action(proof);
    commitTx = await deps.chain.commitProof(proof.commit, 'action', modelProof.logIndex);
    await deps.keep.action({ ...proof, commitTx });
  } catch (err) {
    errors.push(describe(err));
  }
  let modelCommitTx: string | null = null;
  try {
    modelCommitTx = await deps.chain.commitProof(modelProofCommit, 'model', modelProof.logIndex);
  } catch (err) {
    errors.push(`model proof: ${describe(err)}`);
  }
  return { kind: 'proposed', verdict: evaluated.output.decision.verdict, actionId: proposed.actionId, proposeTx: proposed.txHash, executed, proof: commitTx ? { ...proof, commitTx } : proof, commitTx, modelCommitTx, commitError: errors.length > 0 ? errors.join('; ') : null, modelProof, checks };
}
