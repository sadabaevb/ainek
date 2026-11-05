// Wallet helpers shared by the chat and /log pages. The wallet adds a function-call key limited to
// `commit_proof` on the log contract, so committing a proof hash never pops the wallet up again.
import type { NearContextValue } from 'near-connect-hooks';
import { ContractMethodNotFoundError } from 'near-api-js/rpc-errors';
import type { ModelProof } from '@ainek/proof';
import type { PublicConfig } from './config';
import type { Committer } from './flow';

const FC_KEY_ALLOWANCE = '250000000000000000000000'; // 0.25 NEAR of gas allowance for commit_proof calls

export function fcKeyLogin(signIn: NearContextValue['signIn'], cfg: PublicConfig): Promise<void> {
  return signIn({
    addFunctionCallKey: { contractId: cfg.contract, allowMethods: { anyMethod: false, methodNames: ['commit_proof'] }, gasAllowance: { kind: 'limited', amount: FC_KEY_ALLOWANCE } },
  });
}

/** `commit_proof(commit, "model", log_index)` (SPEC §4.2) with the function-call key (default 30 TGas, no deposit); returns the transaction hash. */
export async function commitProofOnChain(callFunctionRaw: NearContextValue['callFunctionRaw'], cfg: PublicConfig, proof: ModelProof): Promise<string> {
  if (!proof.commit) throw new Error('proof has no commit');
  // A key the wallet added seconds ago may not be visible yet on the node that signs locally: that one error is retried briefly.
  for (let attempt = 1; ; attempt++) {
    try {
      const outcome = await callFunctionRaw({ contractId: cfg.contract, method: 'commit_proof', args: { commit: proof.commit, kind: 'model', log_index: proof.logIndex } });
      // The local FC-key path throws on failure; the wallet-popup path resolves with the outcome and leaves the status to us.
      const status = outcome.status as unknown;
      if (typeof status === 'object' && status !== null && 'Failure' in status) throw new Error(`commit_proof failed: ${safeString((status as { Failure: unknown }).Failure)}`);
      const hash = outcome.transaction_outcome?.id;
      if (typeof hash !== 'string') throw new Error('commit_proof: no transaction hash in the outcome');
      return hash;
    } catch (err) {
      if (attempt >= 4 || !/AccessKeyDoesNotExist|access key .{0,80}does not exist/i.test(err instanceof Error ? err.message : safeString(err))) throw err;
      await new Promise((r) => setTimeout(r, 1500 * attempt));
    }
  }
}

/** The contract is deployed but the method is not there yet (SPEC §4.2 lands after §4.1). Typed error on the FC-key path; text match for the wallet-popup path. */
export function isMethodNotFound(err: unknown): boolean {
  return err instanceof ContractMethodNotFoundError || /MethodNotFound|MethodResolveError|method is not found/i.test(err instanceof Error ? err.message : safeString(err));
}

/** Wallet errors can be structured-cloned objects (BigInt fields included); never let the description itself throw. */
function safeString(value: unknown): string {
  try {
    return JSON.stringify(value, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v)) ?? String(value);
  } catch {
    return String(value);
  }
}

const CONNECTOR_DEADLINE_MS = 10_000;
/** Connector round trips (manifest fetch, wallet iframe) have no timeout of their own; a stalled one must not leave a card in "committing…" forever. */
function withDeadline<T>(p: Promise<T>, fallback: T): Promise<T> {
  return Promise.race([p, new Promise<T>((resolve) => setTimeout(() => resolve(fallback), CONNECTOR_DEADLINE_MS))]);
}

/** The user closed the wallet dialog (or the wallet window) without signing in: not an error, just no account. */
function isDialogClosed(err: unknown): boolean {
  return /User rejected|Wallet closed/i.test(err instanceof Error ? err.message : safeString(err));
}

/**
 * The committer for the wallet as it is now. The hook's `signedAccountId` is authoritative once set; only while the provider is
 * still restoring a session (`loading`) is the connector asked directly. With `connect`, a wallet that is not signed in is asked
 * to sign in first (with the commit_proof key): a closed dialog is "no account", so null; any other sign-in failure is thrown for
 * the caller to report. `callFunctionRaw` resolves the wallet through the connector at call time, so the hook value from any
 * render is fine here.
 */
export async function walletCommitter(wallet: NearContextValue, cfg: PublicConfig, connect: boolean): Promise<Committer | null> {
  const { connector, signIn, callFunctionRaw, signedAccountId, loading } = wallet;
  const committer: Committer = (proof) => commitProofOnChain(callFunctionRaw, cfg, proof);
  if (signedAccountId) return committer;
  const connectedAccount = () => withDeadline(connector.getConnectedWallet().then((c) => c.accounts[0]?.accountId ?? null, () => null), null);
  if (loading && (await connectedAccount())) return committer;
  if (!connect) return null;
  try {
    await fcKeyLogin(signIn, cfg);
  } catch (err) {
    if (isDialogClosed(err)) return null;
    throw err;
  }
  return (await connectedAccount()) ? committer : null;
}
