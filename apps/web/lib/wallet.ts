// Wallet helpers shared by the chat and /log pages. The wallet adds a function-call key limited to
// `commit_proof` on the log contract, so committing a proof hash never pops the wallet up again.
import type { NearContextValue } from 'near-connect-hooks';
import { ContractMethodNotFoundError } from 'near-api-js/rpc-errors';
import { isMethodNotFoundMessage } from '@ainek/proof';
import type { ModelProof } from '@ainek/proof';
import type { PublicConfig } from './config';

const FC_KEY_ALLOWANCE = '250000000000000000000000'; // 0.25 NEAR of gas allowance for commit_proof calls

export function fcKeyLogin(signIn: NearContextValue['signIn'], cfg: PublicConfig): Promise<void> {
  return signIn({
    addFunctionCallKey: { contractId: cfg.contract, allowMethods: { anyMethod: false, methodNames: ['commit_proof'] }, gasAllowance: { kind: 'limited', amount: FC_KEY_ALLOWANCE } },
  });
}

/** `commit_proof(commit, "model", log_index)` (SPEC §4.2) with the function-call key (default 30 TGas, no deposit); returns the transaction hash. */
export async function commitProofOnChain(callFunctionRaw: NearContextValue['callFunctionRaw'], cfg: PublicConfig, proof: ModelProof): Promise<string> {
  if (!proof.commit) throw new Error('proof has no commit');
  const outcome = await callFunctionRaw({ contractId: cfg.contract, method: 'commit_proof', args: { commit: proof.commit, kind: 'model', log_index: proof.logIndex } });
  // The local FC-key path throws on failure; the wallet-popup path resolves with the outcome and leaves the status to us.
  const status = outcome.status as unknown;
  if (typeof status === 'object' && status !== null && 'Failure' in status) throw new Error(`commit_proof failed: ${safeString((status as { Failure: unknown }).Failure)}`);
  const hash = outcome.transaction_outcome?.id;
  if (typeof hash !== 'string') throw new Error('commit_proof: no transaction hash in the outcome');
  return hash;
}

/** The contract is deployed but the method is not there yet (SPEC §4.2 lands after §4.1). Typed error on the FC-key path; text match for the wallet-popup path. */
export function isMethodNotFound(err: unknown): boolean {
  return err instanceof ContractMethodNotFoundError || isMethodNotFoundMessage(err instanceof Error ? err.message : safeString(err));
}

/** Wallet errors can be structured-cloned objects (BigInt fields included); never let the description itself throw. */
function safeString(value: unknown): string {
  try {
    return JSON.stringify(value, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v)) ?? String(value);
  } catch {
    return String(value);
  }
}
