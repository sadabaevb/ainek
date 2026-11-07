// The chain side (SPEC §4.3, §4.2): propose_action with the agent's function-call key, commit_proof for the proofs, and the
// view the policy input needs. near-api-js v7, like the verifier's log writer. `signAndSendTransaction` throws on a failed
// transaction by default, with the contract's panic text, but only on the top-level status: a failed sub-receipt (the transfer) has to be read here.
import { Account, JsonRpcProvider, KeyPairSigner, actions, teraToGas, type KeyPairString } from 'near-api-js';
import { withDeadline } from '@ainek/tier1-node';
import { ContractRefused, errorText } from './errors.ts';
import { AGENT_KEY_METHODS, isHex64, keyScopeProblem, readStorageBalance, viewFunction, withRetry, isAlreadyCommitted, isNetworkFailure, type Action, type Decision } from '@ainek/proof';

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
  /** `commit_proof(commit, kind, log_index)` (SPEC §4.2); returns the transaction hash, or undefined when the commit is on-chain but its hash was lost with a failed attempt (`commitWithRetry`). */
  commitProof(commit: string, kind: 'model' | 'action', logIndex: number): Promise<string | undefined>;
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

/** The token's short name for the card. It only labels an amount, so anything unusable falls back to the account id instead of failing, and it cannot carry a forged line into the card. */
export function tokenSymbolOf(metadata: unknown, tokenId: string): string {
  const symbol = (metadata as { symbol?: unknown } | null | undefined)?.symbol;
  return typeof symbol === 'string' && /^[\p{L}\p{N}._-]{1,16}$/u.test(symbol) ? symbol : tokenId;
}

/** `decimals` from the token's NEP-148 `ft_metadata`. */
export function tokenDecimalsOf(metadata: unknown): number {
  const decimals = (metadata as { decimals?: unknown } | null | undefined)?.decimals;
  if (typeof decimals !== 'number' || !Number.isInteger(decimals) || decimals < 0 || decimals > 24) throw new Error(`the token reports no usable decimals in ft_metadata (${String(decimals)})`);
  return decimals;
}

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
/** A commit normally lands in about 2 s; one attempt that hangs must not use up the whole budget. */
const COMMIT_ATTEMPT_MS = 30_000;
const COMMIT_ATTEMPTS = 3;

/**
 * No usable answer, or a stale nonce: nothing about the transaction itself. A refusal, a landed failure or a rejected key would only fail again,
 * spending gas and allowance. near-api-js throws a 429's body as the message, and a gateway's HTML page surfaces as a SyntaxError from res.json().
 */
export const isTransient = (err: unknown): boolean =>
  !(err instanceof ContractRefused) &&
  (isNetworkFailure(err) || err instanceof SyntaxError || (err as { cause?: unknown } | null)?.cause === 429 || /timeout|did not finish within|Bad Gateway|unavailable|Internal server error|Exceeded \d+ attempts|nonce/i.test(errorText(err)));

/**
 * near-api-js retries only the browser's wording of a network failure, so Node's "fetch failed" reaches us on the first hiccup (Nov 7: one hung
 * request lost action #3's commit). A commit's only output is its hash and the contract refuses a duplicate, so a failure that says nothing
 * about the transaction is sent again. A duplicate means an earlier send landed, since the salt makes the commit unique: it is on-chain and only its hash is gone. propose_action
 * is not retried like this: its action id and transfer outcome exist only in the outcome of the transaction that landed.
 */
export async function commitWithRetry(send: () => Promise<{ transaction: { hash: string } }>, pauseMs = 2000): Promise<string | undefined> {
  try {
    const sent = await withRetry(() => send().catch((err: unknown) => { throw refusalOf(err); }), { retryable: isTransient, attempts: COMMIT_ATTEMPTS, pauseMs });
    return sent.transaction.hash;
  } catch (err) {
    if (err instanceof ContractRefused && isAlreadyCommitted(err.message)) return undefined;
    throw err;
  }
}

export function nearActionChain(cfg: { rpcUrl: string; contract: string; agentId: string; agentKey: string; tokenId: string }): ActionChain & { assertKeyScope(): Promise<void>; tokenInfo(): Promise<{ tokenDecimals: number; tokenSymbol: string }> } {
  const provider = new JsonRpcProvider({ url: cfg.rpcUrl });
  const signer = KeyPairSigner.fromSecretKey(cfg.agentKey as KeyPairString);
  const account = new Account(cfg.agentId, provider, signer);
  // retries: 0, because after InvalidNonce the library would sign a second transaction. If the first had landed, the contract's refusal of the copy would read as "nothing was proposed" about a payment that went through; this way the error reads as "may have landed".
  const call = (method: string, args: Record<string, unknown>, tgas: number, timeoutMs = CHAIN_TIMEOUT_MS) => withDeadline(account.signAndSendTransaction({ receiverId: cfg.contract, actions: [actions.functionCall(method, args, teraToGas(tgas), 0n)], retries: 0 }), timeoutMs, method);
  return {
    assertKeyScope: async () => {
      const key = await provider.viewAccessKey({ accountId: cfg.agentId, publicKey: await signer.getPublicKey(), finalityQuery: { finality: 'final' } });
      const problem = keyScopeProblem(key.permission, cfg.contract);
      if (problem) throw new Error(`refusing to start: AGENT_FC_PRIVATE_KEY must be limited to ${AGENT_KEY_METHODS.join(' and ')} on ${cfg.contract}, but ${problem}`);
    },
    proposeAction: async ({ action, modelProofCommit, decision, teeSignature }) => {
      try {
        return parseProposed(await call('propose_action', { action, model_proof_commit: modelProofCommit, decision, tee_signature: teeSignature }, 100), cfg.contract);
      } catch (err) {
        throw refusalOf(err);
      }
    },
    // Measured 2.19 TGas (DEV-NOTES); attached gas ties up allowance until the refund, so it stays small.
    commitProof: (commit, kind, logIndex) => commitWithRetry(() => call('commit_proof', { commit, kind, log_index: logIndex }, 10, COMMIT_ATTEMPT_MS)),
    agentState: async () => agentStateOf(await viewFunction(cfg.rpcUrl, cfg.contract, 'agent', { agent_id: cfg.agentId }), cfg.tokenId),
    roomForAction: async () => (await readStorageBalance(cfg.rpcUrl, cfg.contract, cfg.agentId)) >= actionCost(cfg.agentId),
    // The chain's own answer, not a config value: on a wrong scale the card would still read "300" while the transfer and the policy caps were off by orders of magnitude.
    tokenInfo: async () => {
      const metadata = await viewFunction(cfg.rpcUrl, cfg.tokenId, 'ft_metadata', {});
      return { tokenDecimals: tokenDecimalsOf(metadata), tokenSymbol: tokenSymbolOf(metadata, cfg.tokenId) };
    },
  };
}
