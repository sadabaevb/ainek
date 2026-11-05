// Proofs on disk. The salts exist only here: without its salt a commit on-chain can never be opened, and with it anyone
// holding the file can link the commit to the exchange, so the files are readable by this user only and never leave
// the machine on their own (the disclosure file is what an auditor gets, on the owner's decision).
import { randomBytes } from 'node:crypto';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { toDisclosure, type CommittedActionProof, type DisclosedExchange } from '@ainek/proof';

export interface ProofKeeper {
  /** The model exchange as a disclosure file (SPEC §5.4): proof, salt, exact ciphertext bytes, log entry. */
  model(exchange: DisclosedExchange): Promise<void>;
  action(proof: CommittedActionProof): Promise<void>;
}

/** Files are named by the commit (64 hex chars, schema-checked): not by an id the gateway chose, and not by an action id a redeployed contract would reuse. */
export function fileKeeper(dir: string): ProofKeeper {
  const write = async (name: string, value: unknown): Promise<void> => {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    // Temp file and rename: the second save of a proof must not be able to truncate the only copy of its salt.
    const file = path.join(dir, name);
    const temp = `${file}.${randomBytes(4).toString('hex')}.tmp`;
    await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await rename(temp, file);
  };
  return {
    model: (x) => write(`model-${x.proof.commit}.json`, toDisclosure(x)),
    action: (proof) => write(`action-${proof.commit}.json`, proof),
  };
}
