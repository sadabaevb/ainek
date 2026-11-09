// What /agent reads from the chain: SPEC §4.3 views and the agent account's access keys, over public RPC, with no key and nothing
// from our server. The reads and the per-record checks live in @ainek/proof, shared with `pnpm -F demo check-agent`.
import { agentKeysOf, fromMinimalUnits, readAction, readActions, readAgent, readOwner, readTokenBalance, readTokenInfo, viewAccessKeys, type ActionRecord, type AgentInfo, type AgentKeys, type TokenInfo } from '@ainek/proof';
import type { PublicConfig } from './config';

export interface AgentState {
  id: string;
  /** Null: the contract has no agent under this name. */
  info: AgentInfo | null;
  keys: AgentKeys;
  /** In the agent's token, minimal units. Null when the agent is not registered: there is no token to ask. */
  funds: { inContract: string; onAgent: string } | null;
}

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

async function agentState(cfg: Chain, id: string, signal: AbortSignal): Promise<AgentState> {
  const [info, keys] = await Promise.all([readAgent(cfg.rpcUrl, cfg.contract, id, signal), viewAccessKeys(cfg.rpcUrl, id, signal)]);
  const funds = info ? await Promise.all([cfg.contract, id].map((account) => readTokenBalance(cfg.rpcUrl, info.token_id, account))) : null;
  return { id, info, keys: agentKeysOf(keys, cfg.contract), funds: funds && { inContract: funds[0] ?? '0', onAgent: funds[1] ?? '0' } };
}

export async function loadLedger(cfg: Chain, signal: AbortSignal): Promise<Ledger> {
  const [owner, { records, more }] = await Promise.all([readOwner(cfg.rpcUrl, cfg.contract, signal), readActions(cfg.rpcUrl, cfg.contract, { signal })]);
  const agents = await Promise.all([...new Set([cfg.agentAccount, ...records.map((r) => r.agent_id)])].map((id) => agentState(cfg, id, signal)));
  const tokenIds = [...new Set([...agents.flatMap((a) => (a.info ? [a.info.token_id] : [])), ...records.map((r) => r.action.token_id)])];
  const infos = await Promise.all(tokenIds.map((id) => readTokenInfo(cfg.rpcUrl, id).catch(() => null)));
  return { owner, records, more, agents, tokens: Object.fromEntries(tokenIds.flatMap((id, i) => (infos[i] ? [[id, infos[i]]] : []))) };
}

/** An action whose status can still change: it waits for the owner, or its transfer has not reported back. */
export const isUnsettled = (record: ActionRecord): boolean => record.status === 'Pending' || record.status === 'Executing';

/**
 * A cheap look for news, so an open page follows the chain without reading the whole ledger again: a new action, an unsettled action
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
  return token ? `${fromMinimalUnits(units, token.decimals)} ${token.symbol}` : `${units} (minimal units of ${tokenId})`;
}
