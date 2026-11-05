// The contract side of the verifier: decide whether an entry is new, append it with `log_key`, and read back
// what this verifier already logged. near-api-js v7 (`Account` + `KeyPairSigner`); the view calls reuse the shared
// JSON-RPC reader so the ABI shapes stay in one place (packages/proof/src/near-view.ts).
import { Account, JsonRpcProvider, KeyPairSigner, actions, teraToGas, type KeyPairString } from 'near-api-js';
import { keyLogReader, type KeyEntry, type KeyEntryInput } from '@ainek/proof';

export interface LoggedKey {
  index: number;
  txHash: string;
}

export interface KeyLogWriter {
  /** Entries for `model` this verifier logged inside the dedup window, newest first. */
  recentByMe(model: string, windowNs: string): Promise<KeyEntry[]>;
  logKey(entry: KeyEntryInput): Promise<LoggedKey>;
}

/**
 * The same key from the same deployment, already logged by this verifier recently: logging it again adds nothing
 * for clients (they match on `signing_address`, optionally `compose_hash`) and costs gas and storage. Different key
 * or different compose hash means something changed on the provider side, which is exactly what the log must record.
 */
export function alreadyLogged(entry: KeyEntryInput, recent: readonly KeyEntry[]): KeyEntry | undefined {
  return recent.find((e) => e.signing_address === entry.signing_address && e.compose_hash === entry.compose_hash);
}

/** `log_key` returns the new index as a JSON number in the receipt's SuccessValue (base64). */
export function parseLoggedIndex(successValueB64: string): number {
  const text = Buffer.from(successValueB64, 'base64').toString('utf8');
  let index: unknown;
  try {
    index = JSON.parse(text);
  } catch {
    throw new Error(`log_key returned no index (got ${JSON.stringify(text.slice(0, 40))})`);
  }
  if (typeof index !== 'number' || !Number.isInteger(index) || index < 0) throw new Error(`log_key returned no index (got ${JSON.stringify(text.slice(0, 40))})`);
  return index;
}

export function keyLogWriter(cfg: { rpcUrl: string; contract: string; accountId: string; privateKey: string }): KeyLogWriter {
  const provider = new JsonRpcProvider({ url: cfg.rpcUrl });
  const account = new Account(cfg.accountId, provider, KeyPairSigner.fromSecretKey(cfg.privateKey as KeyPairString));
  const reader = keyLogReader(cfg.rpcUrl, cfg.contract);
  return {
    recentByMe: async (model, windowNs) => (await reader.latestKeys(model, windowNs)).filter((e) => e.verifier === cfg.accountId),
    logKey: async (entry) => {
      const outcome = await account.signAndSendTransaction({
        receiverId: cfg.contract,
        actions: [actions.functionCall('log_key', { entry }, teraToGas('30'), 0n)],
      });
      const status = outcome.status as { SuccessValue?: string; Failure?: unknown };
      if (status.Failure !== undefined || status.SuccessValue === undefined) {
        throw new Error(`log_key failed: ${JSON.stringify(outcome.status).slice(0, 300)}`);
      }
      return { index: parseLoggedIndex(status.SuccessValue), txHash: outcome.transaction.hash as string };
    },
  };
}
