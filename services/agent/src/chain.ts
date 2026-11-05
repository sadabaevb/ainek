// The chain side (SPEC §4.3, §4.2): propose_action with the agent's function-call key, commit_proof for the proofs, and the
// view the policy input needs. near-api-js v7, like the verifier's log writer. `signAndSendTransaction` throws on a failed
// transaction by default, with the contract's panic text, so failures surface without a status check here.
import { Account, JsonRpcProvider, KeyPairSigner, actions, teraToGas, type KeyPairString } from 'near-api-js';
import { viewFunction, type Action, type Decision } from '@ainek/proof';

export interface Proposed {
  actionId: number;
  txHash: string;
  /** The contract emitted `action_executed` in this transaction: the transfer went out (Allow). */
  executed: boolean;
}
export interface ActionChain {
  proposeAction(args: { action: Action; modelProofCommit: string; decision: Decision; teeSignature: string }): Promise<Proposed>;
  /** `commit_proof(commit, kind, log_index)` (SPEC §4.2); returns the transaction hash. */
  commitProof(commit: string, kind: 'model' | 'action', logIndex: number): Promise<string>;
  /** What this agent spent today, a U128 decimal string, for the policy's per-day cap. */
  spentToday(): Promise<string>;
}

/** The parts of a near-api-js outcome the agent reads. */
interface TxOutcome {
  status: unknown;
  transaction: { hash: string };
  receipts_outcome: Array<{ outcome: { logs: string[] } }>;
}

/** The action id from `propose_action`'s return value and the execution from the NEP-297 events in the receipts. */
export function parseProposed(outcome: TxOutcome): Proposed {
  const value = (outcome.status as { SuccessValue?: string }).SuccessValue;
  const returned = value === undefined ? '' : Buffer.from(value, 'base64').toString('utf8');
  const actionId = /^"?\d+"?$/.test(returned) ? Number(returned.replaceAll('"', '')) : NaN; // near-sdk returns a u64 as a number, a U64 as a decimal string
  if (!Number.isSafeInteger(actionId)) throw new Error('propose_action returned no action id');
  const executed = outcome.receipts_outcome
    .flatMap((r) => r.outcome.logs)
    .filter((l) => l.startsWith('EVENT_JSON:'))
    .some((l) => (JSON.parse(l.slice('EVENT_JSON:'.length)) as { event?: unknown }).event === 'action_executed');
  return { actionId, txHash: outcome.transaction.hash, executed };
}

/**
 * `spent_today` from `agent(agent_id) -> AgentInfo` (SPEC §4.3). Fail-closed: a missing view, an unregistered agent or a missing
 * field stops the action. Falling back to "0" would let the policy check the per-day cap against nothing.
 */
export function spentTodayOf(info: unknown): string {
  const spent = (info as { spent_today?: unknown } | null | undefined)?.spent_today;
  if (typeof spent !== 'string' || !/^\d+$/.test(spent)) throw new Error('the contract did not report spent_today for this agent: the per-day cap cannot be checked, nothing proposed');
  return spent;
}

const KEY_METHODS = ['commit_proof', 'propose_action'];

/** The claim "the agent holds only a function-call key" rests on the key's on-chain scope, not on what the variable is called. An empty method list means every method. */
export function keyScopeProblem(permission: unknown, contract: string): string | null {
  const scope = (permission as { FunctionCall?: { receiver_id: string; method_names: string[] } }).FunctionCall;
  if (!scope) return `it is not a function-call key (${JSON.stringify(permission).slice(0, 40)})`;
  if (scope.receiver_id !== contract) return `it is scoped to ${scope.receiver_id}, not to ${contract}`;
  const methods = [...scope.method_names].sort();
  if (methods.join() !== KEY_METHODS.join()) return `its methods are [${methods.join(', ') || 'any'}], not [${KEY_METHODS.join(', ')}]`;
  return null;
}

export function nearActionChain(cfg: { rpcUrl: string; contract: string; agentId: string; agentKey: string }): ActionChain & { assertKeyScope(): Promise<void> } {
  const provider = new JsonRpcProvider({ url: cfg.rpcUrl });
  const signer = KeyPairSigner.fromSecretKey(cfg.agentKey as KeyPairString);
  const account = new Account(cfg.agentId, provider, signer);
  const call = (method: string, args: Record<string, unknown>, tgas: number) => account.signAndSendTransaction({ receiverId: cfg.contract, actions: [actions.functionCall(method, args, teraToGas(tgas), 0n)] });
  return {
    assertKeyScope: async () => {
      const key = await provider.viewAccessKey({ accountId: cfg.agentId, publicKey: await signer.getPublicKey(), finalityQuery: { finality: 'final' } });
      const problem = keyScopeProblem(key.permission, cfg.contract);
      if (problem) throw new Error(`refusing to start: AGENT_FC_PRIVATE_KEY must be limited to ${KEY_METHODS.join(' and ')} on ${cfg.contract}, but ${problem}`);
    },
    proposeAction: async ({ action, modelProofCommit, decision, teeSignature }) => parseProposed(await call('propose_action', { action, model_proof_commit: modelProofCommit, decision, tee_signature: teeSignature }, 100)),
    // Measured 2.19 TGas (DEV-NOTES); attached gas ties up allowance until the refund, so it stays small.
    commitProof: async (commit, kind, logIndex) => (await call('commit_proof', { commit, kind, log_index: logIndex }, 10)).transaction.hash,
    spentToday: async () => spentTodayOf(await viewFunction(cfg.rpcUrl, cfg.contract, 'agent', { agent_id: cfg.agentId })),
  };
}
