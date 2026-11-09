// What /agent reads from the chain: SPEC §4.3 views and the agent account's access keys, over public RPC, with no key and nothing
// from our server. The reads and the per-record checks live in @ainek/proof, shared with `pnpm -F demo check-agent`; this file
// puts them together for the page and decides what a re-read may keep.
import { agentKeysOf, readAction, readActions, readAgent, readAgentState, readOwner, readTokenInfo, tokenAmountText, viewAccessKeys, type ActionRecord, type AgentState, type TokenInfo } from '@ainek/proof';
import type { PublicConfig } from './config';

export interface Ledger {
  owner: string;
  /** Oldest first, as the contract numbers them. */
  records: ActionRecord[];
  /** The contract holds more actions than were read. */
  more: boolean;
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
  const records = [...kept, ...tail.records];
  const otherIds = [...new Set(records.map((r) => r.agent_id))].filter((id) => id !== cfg.agentAccount);
  const agents = [shown, ...(await Promise.all(otherIds.map((id) => readAgentState(cfg.rpcUrl, cfg.contract, id, signal))))];
  const known = previous?.tokens ?? {};
  const tokenIds = [...new Set([...agents.flatMap((a) => (a.info ? [a.info.token_id] : [])), ...records.map((r) => r.action.token_id)])].filter((id) => !(id in known));
  const fresh = await Promise.all(tokenIds.map(async (id) => [id, await readTokenInfo(cfg.rpcUrl, id, signal).catch(() => null)] as const));
  return { owner, records, more: tail.more, agents, tokens: { ...known, ...Object.fromEntries(fresh.flatMap(([id, info]) => (info ? [[id, info] as const] : []))) } };
}

/**
 * A cheap look for news, so an open page follows the chain without reading the ledger again: a new action, an unsettled action
 * that moved on, a pause or a new policy, a key added or deleted (the stop button). True means "read the ledger again".
 */
export async function ledgerMoved(cfg: Chain, ledger: Ledger, signal: AbortSignal): Promise<boolean> {
  const shown = ledger.agents.find((a) => a.id === cfg.agentAccount);
  const [next, unsettled, info, keys] = await Promise.all([
    ledger.more ? null : readAction(cfg.rpcUrl, cfg.contract, ledger.records.length, signal),
    Promise.all(ledger.records.filter(isUnsettled).map(async (r) => (await readAction(cfg.rpcUrl, cfg.contract, r.action_id, signal))?.status !== r.status)),
    readAgent(cfg.rpcUrl, cfg.contract, cfg.agentAccount, signal),
    viewAccessKeys(cfg.rpcUrl, cfg.agentAccount, signal),
  ]);
  return next !== null || unsettled.includes(true) || JSON.stringify(info) !== JSON.stringify(shown?.info ?? null) || JSON.stringify(agentKeysOf(keys, cfg.contract)) !== JSON.stringify(shown?.keys);
}

/** "400 AINEK"; minimal units and the token account when the token did not say how to scale them. */
export function amountText(units: string, tokenId: string, tokens: Ledger['tokens']): string {
  const token = tokens[tokenId];
  return token ? tokenAmountText(units, token) : `${units} (minimal units of ${tokenId})`;
}
