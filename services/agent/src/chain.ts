// The chain side (SPEC §4.3, §4.2): propose_action with the agent's function-call key, commit_proof for the proofs, and the
// view the policy input needs. near-api-js v7, like the verifier's log writer. `signAndSendTransaction` throws on a failed
// transaction by default, with the contract's panic text, but only on the top-level status: a failed sub-receipt (the transfer) has to be read here.
import { Account, JsonRpcProvider, KeyPairSigner, actions, teraToGas, type KeyPairString } from 'near-api-js';
import { withDeadline } from '@ainek/tier1-node';
import { ContractRefused, errorText } from './errors.ts';
import { isHex64, readStorageBalance, viewFunction, type Action, type Decision } from '@ainek/proof';

export interface Proposed {
  /** Null when the transaction landed but named no action: never a reason to lose the hash. */
  actionId: number | null;
  txHash: string;
  /** From this transaction only; `action(id)` stays the authority, and an action waiting for approval moves in a later one. `refused`: the token said no, nothing moved, and the amount no longer counts toward the day's total. */
  transfer: 'executed' | 'refused' | 'none';
}
/** What the contract holds for this agent, read before each decision so that the chain, not a config value, says who may decide (it changes with `update_policy`). */
export interface AgentState {
  /** A U128 decimal string, for the policy's per-day cap. */
  spentToday: string;
  teePubkey: string;
  paused: boolean;
}
export interface ActionChain {
  proposeAction(args: { action: Action; modelProofCommit: string; decision: Decision; teeSignature: string }): Promise<Proposed>;
  /** `commit_proof(commit, kind, log_index)` (SPEC §4.2); returns the transaction hash. */
  commitProof(commit: string, kind: 'model' | 'action', logIndex: number): Promise<string>;
  agentState(): Promise<AgentState>;
  /** Whether the agent's prepaid storage covers everything one action charges it: both commits and the action record (SPEC §4.2, §4.3). */
  roomForAction(): Promise<boolean>;
}

/** The parts of a near-api-js outcome the agent reads. */
interface TxOutcome {
  status: unknown;
  transaction: { hash: string };
  receipts_outcome: Array<{ outcome: { executor_id?: string; logs: string[]; status?: unknown } }>;
}

/** NEP-297 events from the logs. A log line that does not parse is someone else's (a token, a callee), never a reason to lose a landed transaction. */
function eventsOf(outcome: TxOutcome, contract: string): Array<{ event?: unknown; data?: unknown }> {
  return outcome.receipts_outcome
    .filter((r) => r.outcome.executor_id === contract) // a token logs in the same transaction: its log must not be able to say what our contract did
    .flatMap((r) => r.outcome.logs)
    .filter((l) => l.startsWith('EVENT_JSON:'))
    .flatMap((l) => {
      try {
        return [JSON.parse(l.slice('EVENT_JSON:'.length)) as { event?: unknown; data?: unknown }];
      } catch {
        return [];
      }
    });
}
const asId = (value: unknown): number | null => {
  const id = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  return typeof id === 'number' && Number.isSafeInteger(id) && id >= 0 ? id : null;
};

/**
 * Never throws: this runs after the transaction landed, when losing the hash is the worst outcome. The id comes from the return value, or from
 * `action_proposed` when the contract returns its callback's value instead (a u64 as a number, a U64 as a decimal string).
 */
export function parseProposed(outcome: TxOutcome, contract: string): Proposed {
  const events = eventsOf(outcome, contract);
  const value = (outcome.status as { SuccessValue?: string }).SuccessValue;
  const returned = value === undefined ? '' : Buffer.from(value, 'base64').toString('utf8').replaceAll('"', '');
  const proposed = events.find((e) => e.event === 'action_proposed')?.data;
  const fromEvent = (Array.isArray(proposed) ? proposed[0] : proposed) as { action_id?: unknown } | undefined;
  const receiptFailed = outcome.receipts_outcome.some((r) => (r.outcome.status as { Failure?: unknown } | undefined)?.Failure !== undefined);
  return { actionId: asId(returned) ?? asId(fromEvent?.action_id), txHash: outcome.transaction.hash, transfer: events.some((e) => e.event === 'action_failed') ? 'refused' : !receiptFailed && events.some((e) => e.event === 'action_executed') ? 'executed' : 'none' };
}

/**
 * The agent's state from `agent(agent_id) -> AgentInfo` (SPEC §4.3). Fail-closed: a missing view, an unregistered agent or a missing
 * field stops the action. Falling back to "0" would let the policy check the per-day cap against nothing.
 */
export function agentStateOf(info: unknown, tokenId: string): AgentState {
  const i = (info ?? {}) as { spent_today?: unknown; tee_pubkey?: unknown; paused?: unknown; token_id?: unknown };
  if (typeof i.spent_today !== 'string' || !/^\d+$/.test(i.spent_today)) throw new Error('the contract did not report spent_today for this agent: the per-day cap cannot be checked, nothing proposed');
  if (typeof i.tee_pubkey !== 'string' || !isHex64(i.tee_pubkey)) throw new Error('the contract did not report a policy key for this agent: the decision cannot be checked, nothing proposed');
  if (typeof i.paused !== 'boolean') throw new Error('the contract did not say whether this agent is paused, nothing proposed');
  // Before anything is paid for: the contract would refuse only after the model, the job and a commit.
  if (i.token_id !== tokenId) throw new Error(`this agent is registered for token ${String(i.token_id)}, not for AINEK_TOKEN ${tokenId}: nothing proposed`);
  return { spentToday: i.spent_today, teePubkey: i.tee_pubkey, paused: i.paused };
}

/** `decimals` from the token's NEP-148 `ft_metadata`. */
export function tokenDecimalsOf(metadata: unknown): number {
  const decimals = (metadata as { decimals?: unknown } | null | undefined)?.decimals;
  if (typeof decimals !== 'number' || !Number.isInteger(decimals) || decimals < 0 || decimals > 24) throw new Error(`the token reports no usable decimals in ft_metadata (${String(decimals)})`);
  return decimals;
}

const KEY_METHODS = ['commit_proof', 'propose_action'];
/** NEAR's storage price, yoctoNEAR per byte. */
const STORAGE_BYTE_COST = 10n ** 19n;
/** What the contract charges for one commit (SPEC §4.2: 130 + account + kind bytes). */
export function commitCost(account: string, kind: 'model' | 'action'): bigint {
  return BigInt(130 + account.length + kind.length) * STORAGE_BYTE_COST;
}
/** near-api-js reports a landed transaction whose contract call failed as `Contract panicked: <message>`. */
export function refusalOf(err: unknown): unknown {
  const text = errorText(err);
  return /Contract panicked:|Smart contract panicked/.test(text) ? new ContractRefused(text) : err;
}

/** What one proposal adds to the contract's storage: measured 971 bytes for an `Allow` with 19-character account ids, rounded up for longer ids and for a pending entry. */
const ACTION_RECORD_BYTES = 1200n;
/** Everything one action charges the agent's prepaid storage. */
export function actionCost(account: string): bigint {
  return commitCost(account, 'model') + commitCost(account, 'action') + ACTION_RECORD_BYTES * STORAGE_BYTE_COST;
}
/** No chain call may stall the one-at-a-time queue; a timed-out propose_action reads as "may have landed" on the card. */
const CHAIN_TIMEOUT_MS = 120_000;

/** The claim "the agent holds only a function-call key" rests on the key's on-chain scope, not on what the variable is called. An empty method list means every method. */
export function keyScopeProblem(permission: unknown, contract: string): string | null {
  const scope = (permission as { FunctionCall?: { receiver_id: string; method_names: string[] } }).FunctionCall;
  if (!scope) return `it is not a function-call key (${JSON.stringify(permission).slice(0, 40)})`;
  if (scope.receiver_id !== contract) return `it is scoped to ${scope.receiver_id}, not to ${contract}`;
  const methods = [...scope.method_names].sort();
  if (methods.join() !== KEY_METHODS.join()) return `its methods are [${methods.join(', ') || 'any'}], not [${KEY_METHODS.join(', ')}]`;
  return null;
}

export function nearActionChain(cfg: { rpcUrl: string; contract: string; agentId: string; agentKey: string; tokenId: string }): ActionChain & { assertKeyScope(): Promise<void>; tokenDecimals(): Promise<number> } {
  const provider = new JsonRpcProvider({ url: cfg.rpcUrl });
  const signer = KeyPairSigner.fromSecretKey(cfg.agentKey as KeyPairString);
  const account = new Account(cfg.agentId, provider, signer);
  const call = (method: string, args: Record<string, unknown>, tgas: number) => withDeadline(account.signAndSendTransaction({ receiverId: cfg.contract, actions: [actions.functionCall(method, args, teraToGas(tgas), 0n)] }), CHAIN_TIMEOUT_MS, method);
  return {
    assertKeyScope: async () => {
      const key = await provider.viewAccessKey({ accountId: cfg.agentId, publicKey: await signer.getPublicKey(), finalityQuery: { finality: 'final' } });
      const problem = keyScopeProblem(key.permission, cfg.contract);
      if (problem) throw new Error(`refusing to start: AGENT_FC_PRIVATE_KEY must be limited to ${KEY_METHODS.join(' and ')} on ${cfg.contract}, but ${problem}`);
    },
    proposeAction: async ({ action, modelProofCommit, decision, teeSignature }) => {
      try {
        return parseProposed(await call('propose_action', { action, model_proof_commit: modelProofCommit, decision, tee_signature: teeSignature }, 100), cfg.contract);
      } catch (err) {
        throw refusalOf(err);
      }
    },
    // Measured 2.19 TGas (DEV-NOTES); attached gas ties up allowance until the refund, so it stays small.
    commitProof: async (commit, kind, logIndex) => (await call('commit_proof', { commit, kind, log_index: logIndex }, 10)).transaction.hash,
    agentState: async () => agentStateOf(await viewFunction(cfg.rpcUrl, cfg.contract, 'agent', { agent_id: cfg.agentId }), cfg.tokenId),
    roomForAction: async () => (await readStorageBalance(cfg.rpcUrl, cfg.contract, cfg.agentId)) >= actionCost(cfg.agentId),
    // The chain's own answer, not a config value: on a wrong scale the card would still read "300" while the transfer and the policy caps were off by orders of magnitude.
    tokenDecimals: async () => tokenDecimalsOf(await viewFunction(cfg.rpcUrl, cfg.tokenId, 'ft_metadata', {})),
  };
}
