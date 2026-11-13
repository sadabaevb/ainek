// Wallet helpers shared by the chat and /log pages. Sign-in asks the wallet for a function-call key limited to
// `commit_proof` on the log contract (the wallet may widen it), so a commit does not pop the wallet up.
import type { NearContextValue } from 'near-connect-hooks';
import { nearToYocto, teraToGas } from 'near-api-js';
import { ContractMethodNotFoundError } from 'near-api-js/rpc-errors';
import { readProofCommit, readStorageBalance, type ModelProof } from '@ainek/proof';
import type { PublicConfig } from './config';
import type { Committer } from './flow';

/**
 * The wallet list at a fixed commit of hot-dao/near-selector instead of its main branch; what this does and does not pin is in the
 * "Who sees what" (docs/DETAILS.md). Linked, not copied: that repo has no licence. To refresh: diff repository/manifest.json against a newer
 * commit (check `executor` and `permissions`), open the new URL to see that it serves the list (a wrong hash gives an empty wallet
 * dialog, silently), then replace the hash.
 */
export const WALLET_MANIFEST_URL = 'https://raw.githubusercontent.com/hot-dao/near-selector/b57880c29ab142f777c4a851e3c3c23752292be8/repository/manifest.json';

const FC_KEY_ALLOWANCE = '250000000000000000000000'; // 0.25 NEAR of gas allowance for commit_proof calls
/**
 * Storage prepayment for commits (SPEC §4.2), topped up through the wallet dialog: a function-call key cannot carry a deposit.
 * A commit costs 130 + len(account) + len(kind) bytes at the storage price (161 bytes = 0.00161 NEAR measured on testnet,
 * 2026-11-05), so this covers 50 to 68 commits. The client never computes that cost: the contract decides and refuses.
 */
export const DEPOSIT_NEAR = '0.1';
const DEPOSIT_YOCTO = nearToYocto(DEPOSIT_NEAR);

/** What a click on the commit button is allowed to open: nothing, the sign-in dialog, or the sign-in and the deposit dialogs. */
export type Consent = 'none' | 'connect' | 'deposit';

export function fcKeyLogin(signIn: NearContextValue['signIn'], cfg: PublicConfig): Promise<void> {
  return signIn({
    addFunctionCallKey: { contractId: cfg.contract, allowMethods: { anyMethod: false, methodNames: ['commit_proof'] }, gasAllowance: { kind: 'limited', amount: FC_KEY_ALLOWANCE } },
  });
}

/** `approve` moves tokens through a cross-contract call and its callback: SPEC §4.3 asks for at least 60 TGas, the bot's command uses 100. */
const OWNER_CALL_GAS = teraToGas(100).toString();

/**
 * `approve(action_id)` or `reject(action_id)` with the 1 yoctoNEAR that makes the contract insist on a full-access key, so the wallet
 * always asks. Returns the transaction hash. The outcome only says the call was accepted: whether the token then paid is in `action(id).status`.
 */
export async function ownerDecide(callFunctionRaw: NearContextValue['callFunctionRaw'], cfg: Pick<PublicConfig, 'contract'>, method: 'approve' | 'reject', actionId: number): Promise<string> {
  const outcome = await callFunctionRaw({ contractId: cfg.contract, method, args: { action_id: actionId }, gas: OWNER_CALL_GAS, deposit: '1' });
  return txHashOf(outcome, method);
}

/** The local FC-key path throws on failure; the wallet-popup path resolves with the outcome and leaves the status to us. */
function assertSucceeded(outcome: { status: unknown }, method: string): void {
  const status = outcome.status;
  if (typeof status === 'object' && status !== null && 'Failure' in status) throw new Error(`${method} failed: ${safeString((status as { Failure: unknown }).Failure)}`);
}

/** The hash of a transaction that succeeded. */
function txHashOf(outcome: { status: unknown; transaction_outcome?: { id?: unknown } }, method: string): string {
  assertSucceeded(outcome, method);
  const hash = outcome.transaction_outcome?.id;
  if (typeof hash !== 'string') throw new Error(`${method}: no transaction hash in the outcome`);
  return hash;
}

/** Text of whatever a wallet threw: an Error, a plain string, or a structured-cloned object from its sandbox. */
export const errorText = (err: unknown): string => (err instanceof Error ? err.message : typeof err === 'string' ? err : safeString(err));

/** `commit_proof(commit, "model", log_index)` (SPEC §4.2) with the function-call key (default 30 TGas, no deposit); returns the transaction hash. */
export async function commitProofOnChain(callFunctionRaw: NearContextValue['callFunctionRaw'], cfg: PublicConfig, proof: ModelProof): Promise<string> {
  if (!proof.commit) throw new Error('proof has no commit');
  // A key the wallet added seconds ago may not be visible yet on the node that signs locally: that one error is retried briefly.
  for (let attempt = 1; ; attempt++) {
    try {
      const outcome = await callFunctionRaw({ contractId: cfg.contract, method: 'commit_proof', args: { commit: proof.commit, kind: 'model', log_index: proof.logIndex } });
      return txHashOf(outcome, 'commit_proof');
    } catch (err) {
      if (attempt >= 4 || !/AccessKeyDoesNotExist|access key .{0,80}does not exist/i.test(errorText(err))) throw err;
      await new Promise((r) => setTimeout(r, 1500 * attempt));
    }
  }
}

/** `deposit_storage()` with the attached amount; the key plugin signs locally only deposit-free calls to the methods we asked for, so this one goes through the wallet. */
async function depositStorage(callFunctionRaw: NearContextValue['callFunctionRaw'], cfg: PublicConfig): Promise<void> {
  assertSucceeded(await callFunctionRaw({ contractId: cfg.contract, method: 'deposit_storage', args: {}, deposit: DEPOSIT_YOCTO.toString() }), 'deposit_storage');
}

/** The contract's own refusal when the account's prepaid storage does not cover the commit (SPEC §4.2). */
export function isNoDeposit(err: unknown): boolean {
  return /not enough prepaid storage/i.test(errorText(err));
}

/** The contract is deployed but the method is not there yet (SPEC §4.2 lands after §4.1). Typed error on the FC-key path; text match for the wallet-popup path. */
export function isMethodNotFound(err: unknown): boolean {
  return err instanceof ContractMethodNotFoundError || /MethodNotFound|MethodResolveError|method is not found/i.test(errorText(err));
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
export function isDialogClosed(err: unknown): boolean {
  return /User rejected|User closed|Wallet closed/i.test(errorText(err));
}

/**
 * The committer for the wallet as it is now. The hook's `signedAccountId` is authoritative once set; only while the provider is
 * still restoring a session (`loading`) is the connector asked directly. `consent` says which dialogs this call may open: with
 * `connect` or `deposit`, a wallet that is not signed in is asked to sign in first (with the commit_proof key); a closed dialog
 * is "no account", so null; any other sign-in failure is thrown for the caller to report. Only with `deposit` does the
 * committer carry `deposit`, so the flow can never pay without the user's click. `callFunctionRaw` resolves the wallet through
 * the connector at call time, so the hook value from any render is fine here.
 */
export async function walletCommitter(wallet: NearContextValue, cfg: PublicConfig, consent: Consent): Promise<Committer | null> {
  const { connector, signIn, callFunctionRaw, signedAccountId, loading } = wallet;
  const committerFor = (account: string): Committer => ({
    account,
    storageBalance: () => readStorageBalance(cfg.rpcUrl, cfg.contract, account),
    lookup: (commit) => readProofCommit(cfg.rpcUrl, cfg.contract, account, commit),
    commit: (proof) => commitProofOnChain(callFunctionRaw, cfg, proof),
    ...(consent === 'deposit' ? { deposit: () => depositStorage(callFunctionRaw, cfg) } : {}),
  });
  if (signedAccountId) return committerFor(signedAccountId);
  const connectedAccount = () => withDeadline(connector.getConnectedWallet().then((c) => c.accounts[0]?.accountId ?? null, () => null), null);
  const restored = loading ? await connectedAccount() : null;
  if (restored) return committerFor(restored);
  if (consent === 'none') return null;
  try {
    await fcKeyLogin(signIn, cfg);
  } catch (err) {
    if (isDialogClosed(err)) return null;
    throw err;
  }
  const account = await connectedAccount();
  return account ? committerFor(account) : null;
}
