// Proofs on disk. The salts exist only here: without its salt a commit on-chain can never be opened, and with it anyone
// holding the file can link the commit to the exchange, so the files are readable by this user only and never leave
// the machine on their own (the disclosure file is what an auditor gets, on the owner's decision).
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { toDisclosure } from '@ainek/proof';
import type { Verified } from '@ainek/tier1-node';
import type { CommittedActionProof } from './proof.ts';

export interface ProofKeeper {
  /** The model exchange as a disclosure file (SPEC §5.4): proof, salt, exact ciphertext bytes, log entry. */
  model(outcome: Pick<Verified, 'proof' | 'logEntry' | 'requestBody' | 'responseBody'>): Promise<void>;
  action(proof: CommittedActionProof): Promise<void>;
}

export function fileKeeper(dir: string): ProofKeeper {
  const write = async (name: string, value: unknown): Promise<void> => {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeFile(path.join(dir, name), `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  };
  return {
    // Named by the commit (64 hex chars, schema-checked), not by an id the gateway chose.
    model: (o) => write(`model-${o.proof.commit}.json`, toDisclosure({ proof: o.proof, logEntry: o.logEntry, requestBody: o.requestBody, responseBody: o.responseBody })),
    action: (proof) => write(`action-${proof.actionId}.json`, proof),
  };
}
