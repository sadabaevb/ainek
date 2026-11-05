// The chain side (SPEC §4.3, §4.2): propose_action with the agent's function-call key, commit_proof for the action proof,
// and the view the policy input needs. near-api-js v7, the same shape as the verifier's log writer.
import { Account, JsonRpcProvider, KeyPairSigner, actions, teraToGas, type KeyPairString } from 'near-api-js';
import { viewFunction, type Action, type Decision } from '@ainek/proof';

export interface Proposed {
  actionId: number;
  txHash: string;
  /** The `EVENT_JSON:` objects the contract emitted in this transaction (action_proposed, action_executed, action_denied, …). */
  events: unknown[];
}
export interface ActionChain {
  proposeAction(args: { action: Action; modelProofCommit: string; decision: Decision; teeSignature: string }): Promise<Proposed>;
  /** `commit_proof(commit, kind, log_index)` (SPEC §4.2); returns the transaction hash. */
  commitProof(commit: string, kind: 'model' | 'action', logIndex: number): Promise<string>;
  /** What this agent spent today, a U128 decimal string, for the policy's per-day cap. */
  spentToday(): Promise<string>;
}

/** The parts of a near-api-js outcome the agent reads. */
export interface TxOutcome {
  status: unknown;
  transaction: { hash: string };
  receipts_outcome?: Array<{ outcome: { logs: string[] } }>;
}

/** The action id from `propose_action`'s return value and the events from the receipts; a failed transaction is an error carrying the chain's message. */
export function parseProposed(outcome: TxOutcome): Proposed {
  const status = outcome.status as { SuccessValue?: string; Failure?: unknown };
  if (status.Failure !== undefined || status.SuccessValue === undefined) throw new Error(`propose_action failed: ${JSON.stringify(outcome.status).slice(0, 300)}`);
  const returned = Buffer.from(status.SuccessValue, 'base64').toString('utf8');
  const actionId = /^"?\d+"?$/.test(returned) ? Number(returned.replaceAll('"', '')) : NaN; // near-sdk returns a u64 as a number, a U64 as a decimal string
  if (!Number.isSafeInteger(actionId)) throw new Error('propose_action returned no action id');
  const events = (outcome.receipts_outcome ?? [])
    .flatMap((r) => r.outcome.logs)
    .filter((l) => l.startsWith('EVENT_JSON:'))
    .map((l) => JSON.parse(l.slice('EVENT_JSON:'.length)) as unknown);
  return { actionId, txHash: outcome.transaction.hash, events };
}

/** Whether the contract emitted `name` (NEP-297 `event` field): `action_executed` means the transfer went out in this transaction. */
export function eventNamed(events: unknown[], name: string): boolean {
  return events.some((e) => typeof e === 'object' && e !== null && (e as { event?: unknown }).event === name);
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

export function nearActionChain(cfg: { rpcUrl: string; contract: string; agentId: string; agentKey: string }): ActionChain {
  const provider = new JsonRpcProvider({ url: cfg.rpcUrl });
  const account = new Account(cfg.agentId, provider, KeyPairSigner.fromSecretKey(cfg.agentKey as KeyPairString));
  const call = async (method: string, args: Record<string, unknown>, tgas: number): Promise<TxOutcome> =>
    (await account.signAndSendTransaction({ receiverId: cfg.contract, actions: [actions.functionCall(method, args, teraToGas(tgas), 0n)] })) as unknown as TxOutcome;
  return {
    proposeAction: async ({ action, modelProofCommit, decision, teeSignature }) => parseProposed(await call('propose_action', { action, model_proof_commit: modelProofCommit, decision, tee_signature: teeSignature }, 100)),
    commitProof: async (commit, kind, logIndex) => {
      const outcome = await call('commit_proof', { commit, kind, log_index: logIndex }, 30);
      if ((outcome.status as { Failure?: unknown }).Failure !== undefined) throw new Error(`commit_proof failed: ${JSON.stringify(outcome.status).slice(0, 300)}`);
      return outcome.transaction.hash;
    },
    spentToday: async () => spentTodayOf(await viewFunction(cfg.rpcUrl, cfg.contract, 'agent', { agent_id: cfg.agentId })),
  };
}
