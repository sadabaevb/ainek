// Proofs on disk. The salts exist only here: without its salt a commit on-chain can never be opened, and with it anyone
// holding the file can link the commit to the exchange, so the files are readable by this user only and never leave
// the machine on their own (the disclosure file is what an auditor gets, on the owner's decision).
import { randomBytes } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { toDisclosure, type Action, type CommittedActionProof, type Decision, type DisclosedExchange } from '@ainek/proof';

/** Written before propose_action and removed once the action proof is saved. One still here after a restart means a transaction may have landed that nobody recorded. */
export interface Intent {
  modelProofCommit: string;
  action: Action;
  decision: Decision;
  teeSignature: string;
  at: string;
}

export interface ProofKeeper {
  /** The model exchange as a disclosure file (SPEC §5.4): proof, salt, exact ciphertext bytes, log entry. */
  model(exchange: DisclosedExchange): Promise<void>;
  intent(intent: Intent): Promise<void>;
  settled(modelProofCommit: string): Promise<void>;
  unsettled(): Promise<Intent[]>;
  action(proof: CommittedActionProof): Promise<void>;
}

/** Files are named by the commit (64 hex chars, schema-checked): not by an id the gateway chose, and not by an action id a redeployed contract would reuse. */
export function fileKeeper(dir: string): ProofKeeper {
  const write = async (name: string, value: unknown): Promise<void> => {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, name);
    const temp = `${file}.${randomBytes(4).toString('hex')}.tmp`;
    try {
      // Temp file, fsync, rename, fsync the directory: "saved before the commit" must survive a power cut, and a second save must not be able to truncate the only copy of a salt.
      const handle = await open(temp, 'w', 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temp, file);
      const folder = await open(dir, 'r');
      try {
        await folder.sync();
      } finally {
        await folder.close();
      }
    } catch (err) {
      await rm(temp, { force: true }); // it may hold a salt
      throw err;
    }
  };
  const intentFile = (commit: string): string => `intent-${commit}.json`;
  return {
    model: (x) => write(`model-${x.proof.commit}.json`, toDisclosure(x)),
    intent: (x) => write(intentFile(x.modelProofCommit), x),
    settled: (commit) => rm(path.join(dir, intentFile(commit)), { force: true }),
    unsettled: async () => {
      const names = await readdir(dir).catch(() => [] as string[]);
      return Promise.all(names.filter((n) => n.startsWith('intent-') && n.endsWith('.json')).map(async (n) => JSON.parse(await readFile(path.join(dir, n), 'utf8')) as Intent));
    },
    action: (proof) => write(`action-${proof.commit}.json`, proof),
  };
}
