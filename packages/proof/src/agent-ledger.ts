// The agent as the chain shows it to anyone (SPEC §4.3 views, no key): its registration, its keys, its funds, and every action it
// proposed with the decision the contract accepted. Shared by `pnpm -F demo check-agent`, the /agent page and /verify, so each
// reads and re-checks a record the same way. The contract checked every decision when it mattered; these checks repeat what an
// outsider can repeat.
import { ContractMethodNotFound, checkProofCommit, keyScopeProblem, readProofCommit, viewAccessKeys, viewFunction, type AccessKey, type ProofCommitLookup } from './near-view.ts';
import { actionCommitCheck, check, decisionSignatureCheck } from './policy.ts';
import { ActionRecord, AgentInfo } from './schema.ts';
import { readTokenBalance } from './token.ts';
import type { Check } from './verify.ts';

// ---- reads ------------------------------------------------------------------------------------------

/** `agent(agent_id)`; null when the contract has no such agent. */
export async function readAgent(rpcUrl: string, contract: string, agentId: string, signal?: AbortSignal): Promise<AgentInfo | null> {
  const raw = await viewFunction(rpcUrl, contract, 'agent', { agent_id: agentId }, signal);
  return raw == null ? null : AgentInfo.parse(raw);
}

/** `owner()`: the account whose full-access signature approves, rejects and registers. */
export async function readOwner(rpcUrl: string, contract: string, signal?: AbortSignal): Promise<string> {
  const raw = await viewFunction(rpcUrl, contract, 'owner', {}, signal);
  if (typeof raw !== 'string' || raw === '') throw new Error(`${contract}.owner: no owner in the answer`);
  return raw;
}

/** `action(id)`; null past the last action. */
export async function readAction(rpcUrl: string, contract: string, actionId: number, signal?: AbortSignal): Promise<ActionRecord | null> {
  const raw = await viewFunction(rpcUrl, contract, 'action', { action_id: actionId }, signal);
  return raw == null ? null : ActionRecord.parse(raw);
}

const CHUNK = 16;
/** Without a count, a re-read from a known id usually finds one or two new actions: a narrow first window, then full chunks. */
const FOLLOW_UP = 4;
const MAX_ACTIONS = 512;

/** `action_count()`: the ids are `0..count-1`. Null only when the contract has no such view (an older build): the caller then finds the end by asking. */
export async function readActionCount(rpcUrl: string, contract: string, signal?: AbortSignal): Promise<number | null> {
  let raw: unknown;
  try {
    raw = await viewFunction(rpcUrl, contract, 'action_count', {}, signal);
  } catch (err) {
    if (err instanceof ContractMethodNotFound) return null;
    throw err;
  }
  // An answer that is not a count is a broken node or a changed contract: an error, like a record that is not what SPEC §4.3 describes.
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < 0) throw new Error(`${contract}.action_count: not a count: ${JSON.stringify(raw)}`);
  return raw;
}

export interface ActionList {
  records: ActionRecord[];
  /** The contract holds actions past the ones read (the cap). */
  more: boolean;
  /**
   * How many actions the contract counts that this read did not return, the cap aside: the count and an action can come from
   * two nodes a block apart. Above 0 the list is short, and a caller must say so or ask again.
   */
  behind: number;
  /** What `action_count()` said; null when the contract has no such view. */
  count: number | null;
}
type ListOptions = { from: number; chunk: number; max: number; signal?: AbortSignal | undefined };

/** `n` actions from id `from`, read together; the list stops at the first id the node does not have. */
async function readRun(rpcUrl: string, contract: string, from: number, n: number, signal?: AbortSignal): Promise<{ found: ActionRecord[]; ended: boolean }> {
  const batch = await Promise.all(Array.from({ length: n }, (_, i) => readAction(rpcUrl, contract, from + i, signal)));
  const end = batch.indexOf(null);
  return { found: (end === -1 ? batch : batch.slice(0, end)) as ActionRecord[], ended: end !== -1 };
}

/**
 * The actions the contract holds from id `from` on, oldest first. Ids start at 0 and have no gaps. `action_count()` says how
 * many to read; the read then asks one id past the count, because the count may be a block behind the node that serves the
 * actions, and goes on while that node has more. A contract without the view is read by asking alone. Ids from `max` on are not
 * read; `more` says whether the contract holds any: the list is then a prefix, and a caller must say so instead of showing
 * it as the whole record.
 */
export async function readActions(rpcUrl: string, contract: string, { from = 0, chunk = CHUNK, max = MAX_ACTIONS, signal }: Partial<ListOptions> = {}): Promise<ActionList> {
  const count = await readActionCount(rpcUrl, contract, signal);
  if (count === null) return { ...(await probeActions(rpcUrl, contract, { from, chunk, max, signal }, from === 0 ? chunk : FOLLOW_UP)), behind: 0, count };
  const records: ActionRecord[] = [];
  const end = Math.min(count, max);
  for (let next = from; next < end; next += chunk) {
    const { found, ended } = await readRun(rpcUrl, contract, next, Math.min(chunk, end - next), signal);
    records.push(...found);
    // The node does not have an id the count promises yet: the list is short by what is left up to the count (or the cap).
    if (ended) return { records, more: count > max, behind: end - (from + records.length), count };
  }
  if (count > max) return { records, more: true, behind: 0, count };
  // Everything the count promised is here. One id past it tells a count that is behind from the real end.
  const past = await probeActions(rpcUrl, contract, { from: Math.max(from, end), chunk, max, signal }, 1);
  return { records: [...records, ...past.records], more: count > max || past.more, behind: 0, count };
}

/** Finds the end by asking: `first` ids, then a chunk at a time, until one is missing, and one id past the cap. */
async function probeActions(rpcUrl: string, contract: string, { from, chunk, max, signal }: ListOptions, first: number): Promise<{ records: ActionRecord[]; more: boolean }> {
  const records: ActionRecord[] = [];
  let width = Math.min(chunk, first);
  for (let next = from; next < max; next = from + records.length) {
    const { found, ended } = await readRun(rpcUrl, contract, next, Math.min(width, max - next), signal);
    records.push(...found);
    if (ended) return { records, more: false };
    width = chunk;
  }
  return { records, more: (await readAction(rpcUrl, contract, max, signal)) !== null };
}

/** `pending_actions(agent_id)`: the ids that wait for the owner, oldest first, in one call (the contract keeps at most 20 per agent). */
export async function readPendingIds(rpcUrl: string, contract: string, agentId: string, signal?: AbortSignal): Promise<number[]> {
  return ActionRecord.array().parse((await viewFunction(rpcUrl, contract, 'pending_actions', { agent_id: agentId }, signal)) ?? []).map((r) => r.action_id);
}

export interface AgentKeys {
  /** The keys that are not full-access. `problem` is null when the key may call exactly the agent's two methods on this contract. */
  functionCall: Array<{ publicKey: string; methods: string[]; problem: string | null }>;
  /** The stop button needs one for DeleteKey; the chain cannot show who holds it. */
  fullAccess: number;
}

/** What an account can sign, from its access keys. For the agent, no function-call key means it cannot propose anything: stopped, or never set up. */
export function agentKeysOf(keys: AccessKey[], contract: string): AgentKeys {
  const scoped = keys.filter((k) => k.access_key.permission !== 'FullAccess');
  return {
    functionCall: scoped.map((k) => ({
      publicKey: k.public_key,
      methods: (k.access_key.permission as { FunctionCall?: { method_names?: string[] } } | null)?.FunctionCall?.method_names ?? [],
      problem: keyScopeProblem(k.access_key.permission, contract),
    })),
    fullAccess: keys.length - scoped.length,
  };
}

export interface AgentState {
  id: string;
  /** Null: the contract has no agent under this name. */
  info: AgentInfo | null;
  keys: AgentKeys;
  /** In the agent's token, minimal units: what the contract holds and what the agent account holds. Null when the agent is not registered: there is no token to ask. */
  funds: { inContract: string; onAgent: string } | null;
}

/** Everything the chain says about one agent account: the registration, what its keys may do, and where its token sits. */
export async function readAgentState(rpcUrl: string, contract: string, agentId: string, signal?: AbortSignal): Promise<AgentState> {
  const [info, keys] = await Promise.all([readAgent(rpcUrl, contract, agentId, signal), viewAccessKeys(rpcUrl, agentId, signal)]);
  const state = { id: agentId, info, keys: agentKeysOf(keys, contract) };
  if (!info) return { ...state, funds: null };
  const [inContract, onAgent] = await Promise.all([readTokenBalance(rpcUrl, info.token_id, contract, signal), readTokenBalance(rpcUrl, info.token_id, agentId, signal)]);
  return { ...state, funds: { inContract, onAgent } };
}

// ---- checks -----------------------------------------------------------------------------------------

/** What each verdict may end as (`ActionStatus` in contracts/ainek/src/agent.rs). A signed Deny that paid must not pass. */
const STATUSES_OF: Record<string, readonly string[]> = {
  Allow: ['Executing', 'Executed', 'Failed'],
  NeedsApproval: ['Pending', 'Executing', 'Executed', 'Failed', 'Rejected'],
  Deny: ['Denied'],
};

export function actionStatusProblem(verdict: string, status: string): string | null {
  return STATUSES_OF[verdict]?.includes(status) ? null : `${verdict} cannot end as ${status}`;
}

export function actionStatusCheck(verdict: string, status: string): Check {
  const problem = actionStatusProblem(verdict, status);
  return check('action-status', problem === null, `${verdict}, and on chain the action is ${status}`, problem ?? '');
}

/** The `proof_commit` record of the model proof an action names, or why it could not be read: "could not check" is not a pass and not a forgery. */
export type ModelCommitLookup = ProofCommitLookup | { status: 'failed'; detail: string };

const LOOKUPS_AT_ONCE = 16;

/**
 * `proof_commit` for the model proof each record names, in the records' order, a few lookups at a time so that a long ledger does
 * not open a hundred requests to a public endpoint at once. A read that fails is that record's answer, not an exception: one bad
 * lookup must not hide the others. `onBatch` hands each batch over as it lands; `signal` ends the work between batches.
 */
export async function readModelCommits(rpcUrl: string, contract: string, records: ActionRecord[], { signal, onBatch }: { signal?: AbortSignal; onBatch?: (found: Array<[ActionRecord, ModelCommitLookup]>) => void } = {}): Promise<ModelCommitLookup[]> {
  const lookups: ModelCommitLookup[] = [];
  for (let i = 0; i < records.length && !signal?.aborted; i += LOOKUPS_AT_ONCE) {
    const found = await Promise.all(
      records.slice(i, i + LOOKUPS_AT_ONCE).map(async (record): Promise<[ActionRecord, ModelCommitLookup]> => [
        record,
        await readProofCommit(rpcUrl, contract, record.agent_id, record.decision.model_proof_commit, signal).catch((err: unknown): ModelCommitLookup => ({ status: 'failed', detail: err instanceof Error ? err.message : String(err) })),
      ]),
    );
    lookups.push(...found.map(([, lookup]) => lookup));
    onBatch?.(found);
  }
  return lookups;
}

/** The agent commits its model proof before it proposes, and the contract refuses the action otherwise: the record must be there, under the agent's name, as a model proof. */
export function modelCommitCheck(lookup: ModelCommitLookup, agent: string): Check {
  const id = 'model-commit-on-chain';
  if (lookup.status === 'failed') return { id, status: 'skipped', detail: `the commit could not be looked up: ${lookup.detail}` };
  return { ...checkProofCommit({ kind: 'model' }, lookup, agent), id };
}

/**
 * What an outsider can re-check about one recorded action: the decision is signed by the key recorded with it, it covers exactly this
 * action, the status is one that verdict may end in, and the agent had committed a model proof first. Not checked, because the chain
 * does not hold it: which code holds that key (the run's attestation, /verify with the action proof) and what is behind the model
 * proof commit (a salted hash).
 */
export function checkActionRecord(record: ActionRecord, modelCommit: ModelCommitLookup): Check[] {
  return [
    decisionSignatureCheck(record.decision, record.tee_signature, record.tee_pubkey, 'the contract recorded with the action'),
    actionCommitCheck(record.action, [record.decision.action_commit]),
    actionStatusCheck(record.decision.verdict, record.status),
    modelCommitCheck(modelCommit, record.agent_id),
  ];
}

/** `update_policy` can replace the key and the policy while old records stay as they were, so a difference is a fact about the record, not a failure. */
export function decidedUnderCurrentPolicy(record: ActionRecord, agent: AgentInfo): boolean {
  return record.tee_pubkey === agent.tee_pubkey && record.decision.policy_hash === agent.policy_hash && record.decision.policy_version === agent.policy_version;
}

const DAY_MS = 86_400_000;

/**
 * Why the contract would refuse `approve` for a waiting action, in the order `approve` checks (contracts/ainek/src/agent.rs): the agent
 * is paused, the policy or key was replaced since the decision, or the action was proposed on an earlier UTC day (the daily cap is
 * counted per day, so it can only be rejected and proposed again). Null when none applies. The contract decides; this saves the owner
 * a refused transaction, and `nowMs` stands in for block time.
 */
export function approveBlocker(record: ActionRecord, agent: AgentInfo, nowMs: number): 'paused' | 'replaced' | 'earlierDay' | null {
  if (agent.paused) return 'paused';
  if (!decidedUnderCurrentPolicy(record, agent)) return 'replaced';
  if (record.day !== Math.floor(nowMs / DAY_MS)) return 'earlierDay';
  return null;
}
