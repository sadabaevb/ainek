// The agent as the chain shows it to anyone (SPEC §4.3 views, no key): its registration, its keys, and every action it proposed with
// the decision the contract accepted. Shared by `pnpm -F demo check-agent` and the /agent page, so the CLI and the page re-check a
// record the same way. The contract checked each decision when it mattered; these checks repeat what an outsider can repeat.
import { actionStatusCheck, modelCommitCheck } from './action-on-chain.ts';
import { keyScopeProblem, viewFunction, type AccessKey, type ProofCommitLookup } from './near-view.ts';
import { actionCommitCheck, decisionSignatureCheck } from './policy.ts';
import { ActionRecord, AgentInfo } from './schema.ts';
import type { Check } from './verify.ts';

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
const MAX_ACTIONS = 512;

/**
 * Every action the contract holds, oldest first. The contract has no count and no list view, only `action(id)` with ids from 0 with no
 * gaps, so the ids are asked `chunk` at a time until one is missing. `more` is true when `max` was reached first: the list is then a
 * prefix, and a caller must say so instead of showing it as the whole record.
 */
export async function readActions(rpcUrl: string, contract: string, { chunk = CHUNK, max = MAX_ACTIONS, signal }: { chunk?: number; max?: number; signal?: AbortSignal } = {}): Promise<{ records: ActionRecord[]; more: boolean }> {
  const records: ActionRecord[] = [];
  while (records.length < max) {
    const from = records.length;
    const size = Math.min(chunk, max - from);
    const batch = await Promise.all(Array.from({ length: size }, (_, i) => readAction(rpcUrl, contract, from + i, signal)));
    const end = batch.indexOf(null);
    records.push(...(batch.slice(0, end === -1 ? size : end) as ActionRecord[]));
    if (end !== -1) return { records, more: false };
  }
  return { records, more: true };
}

/**
 * What an outsider can re-check about one recorded action: the decision is signed by the key recorded with it, it covers exactly this
 * action, the status is one that verdict may end in (a signed Deny that paid must not pass), and the agent had committed a model proof
 * first. Not checked, because the chain does not hold it: which code holds that key (the run's attestation, /verify with the action
 * proof) and what is behind the model proof commit (a salted hash).
 */
export function checkActionRecord(record: ActionRecord, modelCommit: ProofCommitLookup): Check[] {
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

export interface AgentKeys {
  /** The keys that are not full-access. `problem` is null when the key may call exactly the agent's two methods on this contract. */
  functionCall: Array<{ publicKey: string; methods: string[]; problem: string | null }>;
  /** The stop button needs one for DeleteKey; the chain cannot show who holds it. */
  fullAccess: number;
}

/** What the agent account can sign, from its access keys. No function-call key means it cannot propose anything: stopped, or never set up. */
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
