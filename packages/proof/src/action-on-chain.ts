// An action proof against the chain and against the run's attestation: what /verify shows (SPEC §5.2). The proof alone cannot vouch
// for itself, so the key it must verify under, and what happened to the action, come from the contract's own record.
import { z } from 'zod';
import { canonicalJson } from './canonical.ts';
import { checkProofCommit, readProofCommit, viewFunction } from './near-view.ts';
import { check, verifyActionProof, type ActionReport } from './policy.ts';
import { PolicyRun, verifyPolicyRun, type QuoteVerifier } from './policy-run.ts';
import { Action, ActionProof, Decision } from './schema.ts';
import { withChecks, type Check } from './verify.ts';

/** `action(id)` on the contract (SPEC §4.3). */
const ActionRecord = z.looseObject({ agent_id: z.string(), action: Action, decision: Decision, tee_signature: z.string(), tee_pubkey: z.string(), status: z.string() });

/** What each verdict may end as (`ActionStatus` in contracts/ainek/src/agent.rs). A signed Deny that paid must not pass. */
const STATUSES_OF: Record<string, readonly string[]> = {
  Allow: ['Executing', 'Executed', 'Failed'],
  NeedsApproval: ['Pending', 'Executing', 'Executed', 'Failed', 'Rejected'],
  Deny: ['Denied'],
};

export function actionStatusProblem(verdict: string, status: string): string | null {
  return STATUSES_OF[verdict]?.includes(status) ? null : `${verdict} cannot end as ${status}`;
}

export async function verifyActionProofOnChain(value: unknown, x: { rpcUrl: string; contract: string; wasmHash: string }): Promise<ActionReport> {
  const parsed = ActionProof.safeParse(value);
  if (!parsed.success) return verifyActionProof(value, { teePubkey: '', wasmHash: x.wasmHash });
  const proof = parsed.data;
  const raw: unknown = await viewFunction(x.rpcUrl, x.contract, 'action', { action_id: proof.actionId });
  if (raw === undefined || raw === null) return withChecks({ ok: true, checks: [], proof }, { id: 'action-record', status: 'fail', detail: `${x.contract} has no action #${proof.actionId}` });
  const record = ActionRecord.parse(raw);
  const agent = record.agent_id;
  const offChain = verifyActionProof(proof, { teePubkey: record.tee_pubkey, wasmHash: x.wasmHash });
  // Only a commit that reproduces from the salt is this proof's own: without that, a file could name any commit of this agent.
  const ownCommit = offChain.checks.some((c) => c.id === 'commit' && c.status === 'ok') ? proof.commit : undefined;
  const [own, model] = await Promise.all([
    ownCommit === undefined ? null : readProofCommit(x.rpcUrl, x.contract, agent, ownCommit),
    readProofCommit(x.rpcUrl, x.contract, agent, proof.modelProofCommit),
  ]);
  const sameAsChain = canonicalJson({ a: proof.action, d: proof.decision, s: proof.teeSignature }) === canonicalJson({ a: record.action, d: record.decision, s: record.tee_signature });
  const problem = actionStatusProblem(proof.decision.verdict, record.status);
  return withChecks(
    offChain,
    check('action-record', sameAsChain, `action #${proof.actionId} of ${agent} on ${x.contract} says the same: ${proof.action.amount} of ${proof.action.token_id} to ${proof.action.receiver_id}`, `action #${proof.actionId} on ${x.contract} differs from this proof`),
    check('action-status', problem === null, `${proof.decision.verdict}, and on chain the action is ${record.status}`, problem ?? ''),
    // The agent commits after the payment and tolerates a failure there, so a missing commit is not a forgery. A wrong kind is.
    own === null || own.status === 'none'
      ? { id: 'on-chain-commit', status: 'skipped', detail: own ? `${agent} has not committed this proof` : 'no salted commit in this copy of the proof' }
      : checkProofCommit({ kind: 'action' }, own, agent),
    { ...checkProofCommit({ kind: 'model' }, model, agent), id: 'model-commit-on-chain' },
  );
}

const RUN_CHECK_TIMEOUT_MS = 60_000;

/**
 * Which code made this decision, from the run's attestation (`verifyPolicyRun`). The decision is rebuilt from the proof into the output the job printed. The
 * proof does not carry the job's input, so that line is skipped; the contract recomputed the daily total itself. A file names the URL, so only the API we
 * already use is asked: a pasted proof must not make this browser call a server of its choosing.
 */
export async function actionRunChecks(proof: ActionProof, x: { apiUrl: string; project: string; wasmHash: string; rpcUrl: string; network: 'testnet' | 'mainnet'; loadQuoteVerifier: () => Promise<QuoteVerifier>; fetch?: typeof fetch }): Promise<Check[]> {
  const skipped = (detail: string): Check[] => [{ id: 'run-binding', status: 'skipped', detail }];
  const { fetch: f = fetch, loadQuoteVerifier, ...rest } = x;
  const describe = (err: unknown): string => (err instanceof Error ? err.message : String(err));
  try {
    const { origin } = new URL(proof.attestationUrl);
    if (origin !== new URL(x.apiUrl).origin) return skipped(`the attestation is on ${origin}, not on the OutLayer API this page uses, so it was not fetched`);
    const signal = AbortSignal.timeout(RUN_CHECK_TIMEOUT_MS);
    const res = await f(proof.attestationUrl, { redirect: 'error', signal });
    if (!res.ok) return skipped(`the attestation could not be fetched: HTTP ${res.status}`);
    const run = PolicyRun.parse(await res.json());
    const output = canonicalJson({ decision: proof.decision, pubkey: proof.teePubkey, sig: proof.teeSignature, wasm_hash: proof.wasmHash });
    return await verifyPolicyRun({ ...rest, verifyQuote: await loadQuoteVerifier(), fetch: f, signal, run, input: null, output });
  } catch (err) {
    return skipped(`the attestation could not be checked: ${describe(err)}`);
  }
}

/** `unchecked`: nothing failed, but the attestation could not be read, so which code ran is not known. It must not read as verified. */
export type ActionVerdict = 'verified' | 'failed' | 'unchecked';

/**
 * The whole check of an action proof, as /verify shows it. Intel is asked only about a proof that passed on the chain. The DCAP library is large,
 * so the caller hands in a loader, not the library.
 */
export async function checkActionProof(value: unknown, x: { rpcUrl: string; contract: string; apiUrl: string; project: string; wasmHash: string; network: 'testnet' | 'mainnet'; loadQuoteVerifier: () => Promise<QuoteVerifier>; fetch?: typeof fetch }): Promise<ActionReport & { verdict: ActionVerdict }> {
  const onChain = await verifyActionProofOnChain(value, x);
  if (!onChain.proof || !onChain.ok) return { ...onChain, verdict: 'failed' };
  const report = withChecks(onChain, ...(await actionRunChecks(onChain.proof, x)));
  const runChecked = report.checks.some((c) => c.id === 'run-binding' && c.status === 'ok');
  return { ...report, verdict: !report.ok ? 'failed' : runChecked ? 'verified' : 'unchecked' };
}
