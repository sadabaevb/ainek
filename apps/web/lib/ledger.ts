// What /agent reads from the chain: SPEC §4.3 views and the agent account's access keys, over public RPC, with no key and no
// data from our server. The reads and the per-record checks live in @ainek/proof, shared with `pnpm -F demo check-agent`; this
// file puts them together for the page and decides what a re-read may keep.
import { agentKeysOf, readAction, readActions, readAgent, readAgentState, readOwner, readPendingIds, readTokenInfo, tokenAmountText, viewAccessKeys, type ActionRecord, type AgentState, type TokenInfo } from '@ainek/proof';
import type { PublicConfig } from './config';

export interface Ledger {
  owner: string;
  /** Oldest first, as the contract numbers them. */
  records: ActionRecord[];
  /** The contract holds more actions than were read. */
  more: boolean;
  /** Actions the contract counts and the node has not returned yet (two nodes a block apart): the list is short until the next read. */
  behind: number;
  /** The configured agent first, then any other agent that has proposed something. */
  agents: AgentState[];
  /** By token account. A token whose metadata cannot be read is left out, and its amounts are shown in minimal units. */
  tokens: Record<string, TokenInfo>;
}

type Chain = Pick<PublicConfig, 'rpcUrl' | 'contract' | 'agentAccount'>;

/** An action whose status can still change: it waits for the owner, or its transfer has not reported back. */
export const isUnsettled = (record: ActionRecord): boolean => record.status === 'Pending' || record.status === 'Executing';

/**
 * The whole ledger, or a re-read after `previous`. A settled action never changes and the ids have no gaps, so a re-read keeps
 * everything before the first action that could still move and asks the chain only from there; a token already described is not
 * asked again. The owner, the agents and their balances are always read fresh.
 */
export async function loadLedger(cfg: Chain, signal: AbortSignal, previous?: Ledger): Promise<Ledger> {
  const firstOpen = previous?.records.findIndex(isUnsettled) ?? -1;
  const kept = previous?.records.slice(0, firstOpen === -1 ? undefined : firstOpen) ?? [];
  const [owner, tail, shown] = await Promise.all([
    readOwner(cfg.rpcUrl, cfg.contract, signal),
    readActions(cfg.rpcUrl, cfg.contract, { from: kept.length, signal }),
    readAgentState(cfg.rpcUrl, cfg.contract, cfg.agentAccount, signal),
  ]);
  const read = [...kept, ...tail.records];
  // A node that is a block behind must not take an action off the page: what was shown past this read stays as it was.
  const records = previous && previous.records.length > read.length ? [...read, ...previous.records.slice(read.length)] : read;
  const behind = Math.max(0, tail.behind - (records.length - read.length));
  const otherIds = [...new Set(records.map((r) => r.agent_id))].filter((id) => id !== cfg.agentAccount);
  const agents = [shown, ...(await Promise.all(otherIds.map((id) => readAgentState(cfg.rpcUrl, cfg.contract, id, signal))))];
  const known = previous?.tokens ?? {};
  const tokenIds = [...new Set([...agents.flatMap((a) => (a.info ? [a.info.token_id] : [])), ...records.map((r) => r.action.token_id)])].filter((id) => !(id in known));
  const fresh = await Promise.all(tokenIds.map(async (id) => [id, await readTokenInfo(cfg.rpcUrl, id, signal).catch(() => null)] as const));
  return { owner, records, more: tail.more, behind, agents, tokens: { ...known, ...Object.fromEntries(fresh.flatMap(([id, info]) => (info ? [[id, info] as const] : []))) } };
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/**
 * A cheap look for news, so an open page follows the chain without reading the ledger again: a new action, a waiting action that
 * was decided or a transfer that reported back, and for every agent on the page a pause or a new policy, or a key added or deleted
 * (the stop button). True means "read the ledger again". Not watched, and so only as fresh as the last full read: the owner and
 * the token balances.
 */
export async function ledgerMoved(cfg: Chain, ledger: Ledger, signal: AbortSignal): Promise<boolean> {
  const { rpcUrl, contract } = cfg;
  const [next, reported, agents] = await Promise.all([
    ledger.more ? null : readAction(rpcUrl, contract, ledger.records.length, signal),
    Promise.all(ledger.records.filter((r) => r.status === 'Executing').map(async (r) => (await readAction(rpcUrl, contract, r.action_id, signal))?.status !== r.status)),
    Promise.all(
      ledger.agents.map(async (shown) => {
        const [info, keys, waiting] = await Promise.all([readAgent(rpcUrl, contract, shown.id, signal), viewAccessKeys(rpcUrl, shown.id, signal), shown.info ? readPendingIds(rpcUrl, contract, shown.id, signal) : []]);
        // One call answers for the whole queue. An id past what the page holds is a new action, which `next` reports (or which is beyond the cap).
        const shownWaiting = ledger.records.filter((r) => r.agent_id === shown.id && r.status === 'Pending').map((r) => r.action_id);
        return !same(info, shown.info) || !same(agentKeysOf(keys, contract), shown.keys) || !same(waiting.filter((id) => id < ledger.records.length), shownWaiting);
      }),
    ),
  ]);
  return next !== null || reported.includes(true) || agents.includes(true);
}

/** "400 AINEK"; minimal units and the token account when the token did not say how to scale them. */
export function amountText(units: string, tokenId: string, tokens: Ledger['tokens']): string {
  const token = tokens[tokenId];
  return token ? tokenAmountText(units, token) : `${units} (minimal units of ${tokenId})`;
}
